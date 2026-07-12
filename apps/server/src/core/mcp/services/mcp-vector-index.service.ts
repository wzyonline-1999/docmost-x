import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type { Json } from '@docmost/db/types/db';
import type { DocmostMcpIndexJob } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { McpEmbeddingService } from './mcp-embedding.service';
import {
  McpVectorTextService,
  VectorAttachmentTextSource,
} from './mcp-vector-text.service';
import { McpVectorEligibilityService } from './mcp-vector-eligibility.service';
import { AttachmentType } from '../../attachment/attachment.constants';
import {
  McpVectorBatchIndexInput,
  McpVectorBatchIndexResult,
  McpVectorIndexJobType,
  McpVectorIndexResult,
  McpVectorIndexStats,
  McpVectorPageInput,
  McpVectorQueueJobData,
  McpVectorQueuedJob,
  McpVectorTextChunk,
} from '../types/vector.types';
import { formatPgVector } from '../utils/mcp-vector-sql.util';
import {
  getMcpErrorType,
  getMcpSafeErrorMessage,
} from '../utils/mcp-error.util';

type PageForVectorIndex = {
  id: string;
  workspaceId: string;
  spaceId: string;
  title: string | null;
  content: Json | null;
  textContent: string | null;
  deletedAt: Date | null;
};

type ExistingVectorChunk = {
  id: string;
  chunkIndex: number;
  contentHash: string;
  embeddingDimensions: number;
};

type PageAttachmentForVectorIndex = VectorAttachmentTextSource & {
  updatedAt: Date;
};

type EnqueuePageOptions = {
  jobType?: Extract<McpVectorIndexJobType, 'page' | 'delete' | 'restore'>;
  autoRun?: boolean;
  delayMs?: number;
  stats?: Json;
};

export const AUTO_INDEX_DELAY_MS = 1000;
const MAX_BATCH_INDEX_LIMIT = 1000;

export function buildEmbeddingDimensionContractQuery(db: KyselyDB) {
  return db
    .selectFrom(
      sql<{ declaredType: string | null }>`(
        SELECT format_type(attribute.atttypid, attribute.atttypmod) AS declared_type
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = to_regclass('docmost_mcp_chunks')
          AND attribute.attname = 'embedding'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )`.as('vectorDimensionContract'),
    )
    .select('declaredType');
}

@Injectable()
export class McpVectorIndexService implements OnModuleInit {
  private readonly logger = new Logger(McpVectorIndexService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.MCP_VECTOR_QUEUE)
    private readonly vectorQueue: Queue<McpVectorQueueJobData>,
    private readonly environmentService: EnvironmentService,
    private readonly embeddingService: McpEmbeddingService,
    private readonly vectorTextService: McpVectorTextService,
    private readonly eligibilityService: McpVectorEligibilityService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      !this.environmentService.isMcpEnabled() ||
      !this.environmentService.isVectorSearchEnabled()
    ) {
      return;
    }

    await this.assertEmbeddingDimensionContract();
    await this.recoverPendingJobs().catch((err) =>
      this.logger.warn({
        event: 'mcp.vector.recovery_failed',
        errorType: getMcpErrorType(err),
      }),
    );
  }

  async indexPage(input: McpVectorPageInput): Promise<McpVectorQueuedJob> {
    return this.enqueuePage(input, { autoRun: true });
  }

  async enqueuePage(
    input: McpVectorPageInput,
    opts: EnqueuePageOptions = {},
  ): Promise<McpVectorQueuedJob> {
    this.assertVectorSearchEnabled();

    const jobType = opts.jobType ?? 'page';
    const dedupeKey = await this.buildPageDedupeKey(input, jobType);
    const job = await this.createQueuedJob({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId ?? null,
      pageId: input.pageId,
      jobType,
      requestedByClientId: input.requestedByClientId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      dedupeKey,
      stats: opts.stats ?? {},
    });

    if (opts.autoRun) {
      await this.enqueuePersistedJob(job, { delayMs: opts.delayMs ?? 0 });
    }

    return {
      jobId: job.id,
      jobType,
      pageId: input.pageId,
      spaceId: input.spaceId ?? null,
      workspaceId: input.workspaceId,
      status: 'queued',
    };
  }

  async enqueuePageIds(input: {
    pageIds: string[];
    workspaceId?: string | null;
    jobType?: Extract<McpVectorIndexJobType, 'page' | 'delete' | 'restore'>;
    requestedByClientId?: string | null;
    requestedByUserId?: string | null;
    delayMs?: number;
  }): Promise<McpVectorQueuedJob[]> {
    if (input.pageIds.length === 0) {
      return [];
    }

    this.assertVectorSearchEnabled();

    let query = this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', 'spaceId'])
      .where('id', 'in', [...new Set(input.pageIds)]);

    if (input.workspaceId) {
      query = query.where('workspaceId', '=', input.workspaceId);
    }

    let pages = await query.execute();
    if ((input.jobType ?? 'page') !== 'delete') {
      pages = await this.keepEligiblePages(pages);
    }
    const jobs: McpVectorQueuedJob[] = [];

    for (const page of pages) {
      jobs.push(
        await this.enqueuePage(
          {
            pageId: page.id,
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            requestedByClientId: input.requestedByClientId ?? null,
            requestedByUserId: input.requestedByUserId ?? null,
          },
          {
            jobType: input.jobType ?? 'page',
            autoRun: true,
            delayMs: input.delayMs ?? 0,
            stats: { trigger: 'page_event' },
          },
        ),
      );
    }

    return jobs;
  }

  async enqueueSpace(
    input: McpVectorBatchIndexInput & { spaceId: string },
  ): Promise<McpVectorQueuedJob> {
    this.assertVectorSearchEnabled();
    const job = await this.createQueuedJob({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      pageId: null,
      jobType: 'space',
      requestedByClientId: input.requestedByClientId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      dedupeKey: this.hashDedupeKey([
        'space',
        input.workspaceId,
        input.spaceId,
        this.environmentService.getEmbeddingModel(),
      ]),
      stats: { limit: input.limit ?? MAX_BATCH_INDEX_LIMIT },
    });

    await this.enqueuePersistedJob(job);
    return this.toQueuedJob(job);
  }

  async enqueueWorkspace(
    input: McpVectorBatchIndexInput,
  ): Promise<McpVectorQueuedJob> {
    this.assertVectorSearchEnabled();
    const job = await this.createQueuedJob({
      workspaceId: input.workspaceId,
      spaceId: null,
      pageId: null,
      jobType: 'workspace',
      requestedByClientId: input.requestedByClientId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      dedupeKey: this.hashDedupeKey([
        'workspace',
        input.workspaceId,
        [...(input.spaceIds ?? [])].sort(),
        this.environmentService.getEmbeddingModel(),
      ]),
      stats: {
        spaceIds: input.spaceIds ?? [],
        limit: input.limit ?? MAX_BATCH_INDEX_LIMIT,
      },
    });

    await this.enqueuePersistedJob(job);
    return this.toQueuedJob(job);
  }

  async reconcileSpaceEligibility(input: {
    workspaceId: string;
    spaceId: string;
    enqueueEligible?: boolean;
  }): Promise<{
    eligiblePageCount: number;
    ineligiblePageCount: number;
    queuedJobIds: string[];
  }> {
    const pages = await this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', 'spaceId'])
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('deletedAt', 'is', null)
      .execute();
    const eligibility = await this.eligibilityService.evaluatePageIds({
      workspaceId: input.workspaceId,
      pageIds: pages.map((page) => page.id),
    });

    for (const pageId of eligibility.ineligiblePageIds) {
      await this.softDeletePageChunks(input.workspaceId, pageId);
    }

    const queuedJobIds: string[] = [];
    if (
      input.enqueueEligible &&
      this.environmentService.isVectorSearchEnabled()
    ) {
      for (const pageId of eligibility.eligiblePageIds) {
        const queued = await this.enqueuePage(
          {
            workspaceId: input.workspaceId,
            spaceId: input.spaceId,
            pageId,
          },
          {
            autoRun: true,
            stats: { trigger: 'permission_reconcile' },
          },
        );
        queuedJobIds.push(queued.jobId);
      }
    }

    return {
      eligiblePageCount: eligibility.eligiblePageIds.length,
      ineligiblePageCount: eligibility.ineligiblePageIds.length,
      queuedJobIds,
    };
  }

  async retryJob(
    jobId: string,
    batchOpts: { spaceIds?: string[]; limit?: number } = {},
  ): Promise<McpVectorQueuedJob> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }
    if (!['failed', 'queued'].includes(job.status)) {
      throw new BadRequestException(
        'Only failed or queued MCP vector jobs can be retried',
      );
    }

    const stats = {
      ...this.asStatsObject(job.stats),
      ...(batchOpts.spaceIds ? { spaceIds: batchOpts.spaceIds } : {}),
      ...(batchOpts.limit ? { limit: batchOpts.limit } : {}),
    } as Json;
    const queuedJob = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'queued',
        stats,
        lastError: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', job.id)
      .where('status', 'in', ['failed', 'queued'])
      .returningAll()
      .executeTakeFirst();

    if (!queuedJob) {
      throw new ConflictException('MCP vector job state changed before retry');
    }

    await this.enqueuePersistedJob(queuedJob, {
      manualRetry: job.status === 'failed',
    });
    return this.toQueuedJob(queuedJob);
  }

  async pauseJob(jobId: string): Promise<{ jobId: string; status: 'paused' }> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }
    if (job.jobType !== 'space' && job.jobType !== 'workspace') {
      throw new BadRequestException('Only batch index jobs can be paused');
    }
    if (job.status === 'paused') {
      return { jobId, status: 'paused' };
    }
    if (!['queued', 'running'].includes(job.status)) {
      throw new BadRequestException(
        'Only queued or running MCP vector jobs can be paused',
      );
    }

    const paused = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({ status: 'paused', updatedAt: new Date() })
      .where('id', '=', job.id)
      .where('status', 'in', ['queued', 'running'])
      .returningAll()
      .executeTakeFirst();
    if (!paused) {
      throw new ConflictException('MCP vector job state changed before pause');
    }

    await this.removeInactiveBullJob(paused);
    return { jobId, status: 'paused' };
  }

  async resumeJob(
    jobId: string,
    batchOpts: { spaceIds?: string[] } = {},
  ): Promise<McpVectorQueuedJob> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }
    if (job.status !== 'paused') {
      throw new BadRequestException(
        'Only paused MCP vector jobs can be resumed',
      );
    }

    const bullJob = await this.vectorQueue.getJob(this.getBullJobId(job));
    if (bullJob) {
      const state = await bullJob.getState();
      if (state === 'active') {
        throw new ConflictException(
          'MCP vector job is still reaching its pause boundary',
        );
      }
      await bullJob.remove();
    }

    const queued = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'queued',
        stats: {
          ...this.asStatsObject(job.stats),
          ...(batchOpts.spaceIds ? { spaceIds: batchOpts.spaceIds } : {}),
        },
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', job.id)
      .where('status', '=', 'paused')
      .returningAll()
      .executeTakeFirst();
    if (!queued) {
      throw new ConflictException('MCP vector job state changed before resume');
    }

    await this.enqueuePersistedJob(queued, { manualRetry: true });
    return this.toQueuedJob(queued);
  }

  async cancelJob(
    jobId: string,
  ): Promise<{ jobId: string; status: 'cancelled'; childJobCount: number }> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }
    if (job.status === 'cancelled') {
      return { jobId, status: 'cancelled', childJobCount: 0 };
    }
    if (!['queued', 'running', 'paused'].includes(job.status)) {
      throw new BadRequestException(
        'Only active MCP vector jobs can be cancelled',
      );
    }

    const cancelled = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', job.id)
      .where('status', 'in', ['queued', 'running', 'paused'])
      .returningAll()
      .executeTakeFirst();
    if (!cancelled) {
      throw new ConflictException('MCP vector job state changed before cancel');
    }

    await this.removeInactiveBullJob(cancelled);
    const childJobCount = await this.cancelQueuedChildJobs(cancelled);
    return { jobId, status: 'cancelled', childJobCount };
  }

  async runQueuedJob(
    jobId: string,
    batchOpts: { spaceIds?: string[]; limit?: number } = {},
  ): Promise<McpVectorIndexResult | McpVectorBatchIndexResult> {
    this.assertVectorSearchEnabled();

    const job = await this.getJob(jobId);
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }

    if (job.status === 'cancelled') {
      throw new BadRequestException('MCP vector index job is cancelled');
    }

    if (job.jobType === 'space' || job.jobType === 'workspace') {
      return this.runBatchJob(job, this.resolveBatchOptions(job, batchOpts));
    }

    return this.runPageJob(job);
  }

  async softDeletePageChunks(
    workspaceId: string,
    pageId: string,
  ): Promise<void> {
    await this.db
      .updateTable('docmostMcpChunks')
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', workspaceId)
      .where('pageId', '=', pageId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async runPageJob(
    job: DocmostMcpIndexJob,
  ): Promise<McpVectorIndexResult> {
    if (!job.pageId) {
      throw new BadRequestException('MCP vector page job is missing pageId');
    }

    const runningJob = await this.markJobRunning(job.id);

    try {
      const page = await this.getPage(runningJob.workspaceId, job.pageId);
      if (!page) {
        throw new NotFoundException('Page not found');
      }

      if (page.deletedAt || runningJob.jobType === 'delete') {
        await this.softDeletePageChunks(page.workspaceId, page.id);
        await this.markJobSucceeded(runningJob.id, {
          chunkCount: 0,
          embeddedCount: 0,
          deleted: true,
        });

        return {
          jobId: runningJob.id,
          jobType: runningJob.jobType as McpVectorIndexJobType,
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          status: 'succeeded',
          chunkCount: 0,
          embeddedCount: 0,
          deleted: true,
        };
      }

      if (
        !(await this.eligibilityService.isPageEligible(
          page.workspaceId,
          page.id,
        ))
      ) {
        await this.softDeletePageChunks(page.workspaceId, page.id);
        await this.markJobSucceeded(runningJob.id, {
          chunkCount: 0,
          embeddedCount: 0,
          deleted: true,
          skipped: true,
          skippedReason: 'permission',
        });

        return {
          jobId: runningJob.id,
          jobType: runningJob.jobType as McpVectorIndexJobType,
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          status: 'succeeded',
          chunkCount: 0,
          embeddedCount: 0,
          deleted: true,
          skipped: true,
          skippedReason: 'permission',
        };
      }

      const attachments = await this.getPageAttachments(page);
      const chunks = this.vectorTextService.buildDocumentChunks(
        page,
        attachments,
      );
      const existingChunks = await this.getActivePageChunks(page);
      const existingByIndex = new Map(
        existingChunks.map((chunk) => [chunk.chunkIndex, chunk]),
      );
      const dimensions = this.environmentService.getEmbeddingDimensions();
      const changedChunks = chunks.filter((chunk) => {
        const existing = existingByIndex.get(chunk.chunkIndex);
        return (
          !existing ||
          existing.contentHash !== chunk.contentHash ||
          existing.embeddingDimensions !== dimensions
        );
      });
      const changedEmbeddings = await this.embeddingService.createEmbeddings(
        changedChunks.map((chunk) => chunk.content),
      );
      const embeddingsByIndex = new Map<number, number[]>();
      changedChunks.forEach((chunk, index) => {
        const embedding = changedEmbeddings[index];
        if (embedding) {
          embeddingsByIndex.set(chunk.chunkIndex, embedding);
        }
      });

      await this.writePageChunks(
        page,
        chunks,
        embeddingsByIndex,
        existingByIndex,
      );

      const stats: McpVectorIndexStats = {
        chunkCount: chunks.length,
        embeddedCount: changedEmbeddings.length,
        reusedCount: chunks.length - changedChunks.length,
        model: this.environmentService.getEmbeddingModel(),
        dimensions: this.environmentService.getEmbeddingDimensions(),
        contentLength: chunks.reduce(
          (total, chunk) => total + chunk.charLength,
          0,
        ),
        attachmentCount: attachments.length,
        attachmentChunkCount: chunks.filter(
          (chunk) => chunk.sourceType === 'attachment',
        ).length,
        deleted: false,
      };
      await this.markJobSucceeded(runningJob.id, stats);

      return {
        jobId: runningJob.id,
        jobType: runningJob.jobType as McpVectorIndexJobType,
        pageId: page.id,
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        status: 'succeeded',
        chunkCount: chunks.length,
        embeddedCount: changedEmbeddings.length,
        deleted: false,
      };
    } catch (err) {
      await this.markJobFailed(runningJob.id, err).catch((jobErr) =>
        this.logger.warn({
          event: 'mcp.vector.mark_failed_failed',
          jobId: runningJob.id,
          errorType: getMcpErrorType(jobErr),
        }),
      );
      throw err;
    }
  }

  private async runBatchJob(
    job: DocmostMcpIndexJob,
    opts: { spaceIds?: string[]; limit?: number },
  ): Promise<McpVectorBatchIndexResult> {
    const runningJob = await this.markJobRunning(job.id);

    try {
      const persistedStats = this.asStatsObject(runningJob.stats);
      const pageJobIds = Array.isArray(persistedStats.pageJobIds)
        ? persistedStats.pageJobIds.filter(
            (pageJobId): pageJobId is string => typeof pageJobId === 'string',
          )
        : [];
      let cursor =
        typeof persistedStats.lastCursor === 'string'
          ? persistedStats.lastCursor
          : undefined;
      let scannedPageCount =
        typeof persistedStats.scannedPageCount === 'number'
          ? persistedStats.scannedPageCount
          : 0;
      let batchCount =
        typeof persistedStats.batchCount === 'number'
          ? persistedStats.batchCount
          : 0;

      while (true) {
        const controlStatus = await this.getBatchControlStatus(runningJob.id);
        if (controlStatus === 'paused' || controlStatus === 'cancelled') {
          return this.toControlledBatchResult(
            runningJob,
            controlStatus,
            pageJobIds,
            scannedPageCount,
            batchCount,
          );
        }

        const batch = await this.getBatchPageBatch(runningJob, opts, cursor);
        scannedPageCount += batch.scannedPageCount;
        batchCount += batch.scannedPageCount > 0 ? 1 : 0;

        for (const page of batch.pages) {
          const queued = await this.enqueuePage(
            {
              workspaceId: page.workspaceId,
              spaceId: page.spaceId,
              pageId: page.id,
              requestedByClientId: runningJob.requestedByClientId,
              requestedByUserId: runningJob.requestedByUserId,
            },
            {
              autoRun: true,
              stats: {
                parentJobId: runningJob.id,
                parentJobType: runningJob.jobType,
              },
            },
          );
          pageJobIds.push(queued.jobId);
        }

        cursor = batch.nextCursor;
        await this.persistBatchProgress(runningJob.id, {
          ...persistedStats,
          queuedPageCount: pageJobIds.length,
          scannedPageCount,
          batchCount,
          lastCursor: cursor ?? null,
          pageJobIds,
        });

        const statusAfterBatch = await this.getBatchControlStatus(
          runningJob.id,
        );
        if (statusAfterBatch === 'paused' || statusAfterBatch === 'cancelled') {
          return this.toControlledBatchResult(
            runningJob,
            statusAfterBatch,
            pageJobIds,
            scannedPageCount,
            batchCount,
          );
        }
        if (!batch.hasMore) {
          break;
        }
      }

      const succeeded = await this.markJobSucceeded(runningJob.id, {
        queuedPageCount: pageJobIds.length,
        scannedPageCount,
        batchCount,
        lastCursor: cursor ?? null,
        pageJobIds,
      });
      if (!succeeded) {
        const finalStatus = await this.getBatchControlStatus(runningJob.id);
        if (finalStatus === 'paused' || finalStatus === 'cancelled') {
          return this.toControlledBatchResult(
            runningJob,
            finalStatus,
            pageJobIds,
            scannedPageCount,
            batchCount,
          );
        }
        throw new ConflictException(
          'MCP vector batch job state changed before completion',
        );
      }

      return {
        jobId: runningJob.id,
        jobType: runningJob.jobType as 'space' | 'workspace',
        workspaceId: runningJob.workspaceId,
        spaceId: runningJob.spaceId,
        status: 'succeeded',
        queuedPageCount: pageJobIds.length,
        scannedPageCount,
        batchCount,
        pageJobIds,
      };
    } catch (err) {
      await this.markJobFailed(runningJob.id, err).catch((jobErr) =>
        this.logger.warn({
          event: 'mcp.vector.mark_batch_failed_failed',
          jobId: runningJob.id,
          errorType: getMcpErrorType(jobErr),
        }),
      );
      throw err;
    }
  }

  private async getBatchPageBatch(
    job: DocmostMcpIndexJob,
    opts: { spaceIds?: string[]; limit?: number },
    cursor?: string,
  ): Promise<{
    pages: Array<Pick<PageForVectorIndex, 'id' | 'workspaceId' | 'spaceId'>>;
    scannedPageCount: number;
    nextCursor?: string;
    hasMore: boolean;
  }> {
    const batchSize = Math.min(
      opts.limit ?? MAX_BATCH_INDEX_LIMIT,
      MAX_BATCH_INDEX_LIMIT,
    );
    let query = this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', 'spaceId'])
      .where('workspaceId', '=', job.workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('id', 'asc')
      .limit(batchSize);

    if (cursor) {
      query = query.where('id', '>', cursor);
    }

    if (job.jobType === 'space') {
      if (!job.spaceId) {
        throw new BadRequestException(
          'MCP vector space job is missing spaceId',
        );
      }
      query = query.where('spaceId', '=', job.spaceId);
    }

    if (job.jobType === 'workspace' && opts.spaceIds?.length) {
      query = query.where('spaceId', 'in', opts.spaceIds);
    }

    const scannedPages = await query.execute();
    return {
      pages: await this.keepEligiblePages(scannedPages),
      scannedPageCount: scannedPages.length,
      nextCursor: scannedPages[scannedPages.length - 1]?.id,
      hasMore: scannedPages.length === batchSize,
    };
  }

  private async keepEligiblePages<
    T extends Pick<PageForVectorIndex, 'id' | 'workspaceId' | 'spaceId'>,
  >(pages: T[]): Promise<T[]> {
    if (pages.length === 0) {
      return [];
    }

    const eligiblePageIds = new Set<string>();
    const pagesByWorkspace = new Map<string, T[]>();
    for (const page of pages) {
      const workspacePages = pagesByWorkspace.get(page.workspaceId) ?? [];
      workspacePages.push(page);
      pagesByWorkspace.set(page.workspaceId, workspacePages);
    }

    for (const [workspaceId, workspacePages] of pagesByWorkspace) {
      const result = await this.eligibilityService.evaluatePageIds({
        workspaceId,
        pageIds: workspacePages.map((page) => page.id),
      });
      for (const pageId of result.eligiblePageIds) {
        eligiblePageIds.add(pageId);
      }
      for (const pageId of result.ineligiblePageIds) {
        await this.softDeletePageChunks(workspaceId, pageId);
      }
    }

    return pages.filter((page) => eligiblePageIds.has(page.id));
  }

  private async getPage(
    workspaceId: string,
    pageId: string,
  ): Promise<PageForVectorIndex | undefined> {
    return this.db
      .selectFrom('pages')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'title',
        'content',
        'textContent',
        'deletedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', pageId)
      .executeTakeFirst();
  }

  private async getPageAttachments(
    page: Pick<PageForVectorIndex, 'id' | 'workspaceId'>,
  ): Promise<PageAttachmentForVectorIndex[]> {
    return this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'textContent', 'updatedAt'])
      .where('workspaceId', '=', page.workspaceId)
      .where('pageId', '=', page.id)
      .where('type', '=', AttachmentType.File)
      .where('textContent', 'is not', null)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  private toChunkMetadata(chunk: McpVectorTextChunk): Json {
    return {
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      charLength: chunk.charLength,
      sourceType: chunk.sourceType ?? 'page',
      ...(chunk.attachmentId ? { attachmentId: chunk.attachmentId } : {}),
      ...(chunk.attachmentFileName
        ? { attachmentFileName: chunk.attachmentFileName }
        : {}),
    } as Json;
  }

  private async getActivePageChunks(
    page: Pick<PageForVectorIndex, 'id' | 'workspaceId'>,
  ): Promise<ExistingVectorChunk[]> {
    return this.db
      .selectFrom('docmostMcpChunks')
      .select(['id', 'chunkIndex', 'contentHash', 'embeddingDimensions'])
      .where('workspaceId', '=', page.workspaceId)
      .where('pageId', '=', page.id)
      .where('embeddingModel', '=', this.environmentService.getEmbeddingModel())
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async getJob(jobId: string): Promise<DocmostMcpIndexJob | undefined> {
    return this.db
      .selectFrom('docmostMcpIndexJobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst();
  }

  private async createQueuedJob(input: {
    workspaceId: string;
    spaceId?: string | null;
    pageId?: string | null;
    jobType: McpVectorIndexJobType;
    requestedByClientId?: string | null;
    requestedByUserId?: string | null;
    dedupeKey?: string | null;
    stats: Json;
  }) {
    const inserted = await this.db
      .insertInto('docmostMcpIndexJobs')
      .values({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId ?? null,
        pageId: input.pageId ?? null,
        jobType: input.jobType,
        status: 'queued',
        requestedByClientId: input.requestedByClientId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        attemptCount: 0,
        stats: input.stats,
      })
      .onConflict((oc) =>
        oc
          .column('dedupeKey')
          .where(sql<boolean>`status IN ('queued', 'running', 'paused')`)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return inserted;
    }

    if (input.dedupeKey) {
      const existing = await this.db
        .selectFrom('docmostMcpIndexJobs')
        .selectAll()
        .where('dedupeKey', '=', input.dedupeKey)
        .where('status', 'in', ['queued', 'running', 'paused'])
        .executeTakeFirst();
      if (existing) {
        return existing;
      }
    }

    throw new ConflictException('MCP vector job deduplication state changed');
  }

  private async buildPageDedupeKey(
    input: McpVectorPageInput,
    jobType: Extract<McpVectorIndexJobType, 'page' | 'delete' | 'restore'>,
  ): Promise<string> {
    const page = await this.getPage(input.workspaceId, input.pageId);
    const attachments = page ? await this.getPageAttachments(page) : [];
    return this.hashDedupeKey([
      jobType,
      input.workspaceId,
      input.pageId,
      this.environmentService.getEmbeddingModel(),
      this.environmentService.getEmbeddingDimensions(),
      page
        ? {
            title: page.title,
            content: page.content,
            textContent: page.textContent,
            deletedAt: page.deletedAt,
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              fileName: attachment.fileName,
              textContentHash: createHash('sha256')
                .update(attachment.textContent ?? '')
                .digest('hex'),
              updatedAt: attachment.updatedAt,
            })),
          }
        : 'missing',
    ]);
  }

  private hashDedupeKey(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  private async markJobRunning(jobId: string): Promise<DocmostMcpIndexJob> {
    const job = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'running',
        attemptCount: sql<number>`attempt_count + 1`,
        lastError: null,
        startedAt: new Date(),
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', jobId)
      .where('status', 'in', ['queued', 'failed'])
      .returningAll()
      .executeTakeFirst();

    if (!job) {
      throw new ConflictException(
        'MCP vector job is already running or finished',
      );
    }

    return job;
  }

  private async writePageChunks(
    page: PageForVectorIndex,
    chunks: McpVectorTextChunk[],
    embeddingsByIndex: Map<number, number[]>,
    existingByIndex: Map<number, ExistingVectorChunk>,
  ): Promise<void> {
    const model = this.environmentService.getEmbeddingModel();
    const dimensions = this.environmentService.getEmbeddingDimensions();
    const indexedAt = new Date();

    await this.db.transaction().execute(async (trx) => {
      for (const chunk of chunks) {
        const existing = existingByIndex.get(chunk.chunkIndex);
        const metadata = this.toChunkMetadata(chunk);
        if (
          existing &&
          existing.contentHash === chunk.contentHash &&
          existing.embeddingDimensions === dimensions
        ) {
          await trx
            .updateTable('docmostMcpChunks')
            .set({
              spaceId: page.spaceId,
              metadata,
              indexedAt,
              updatedAt: indexedAt,
            })
            .where('id', '=', existing.id)
            .execute();
          continue;
        }

        const embedding = embeddingsByIndex.get(chunk.chunkIndex);
        if (!embedding) {
          throw new BadRequestException(
            `Missing embedding for chunk ${chunk.chunkIndex}`,
          );
        }

        const values = {
          spaceId: page.spaceId,
          title: page.title ?? null,
          content: chunk.content,
          contentHash: chunk.contentHash,
          embedding: sql<number[]>`${formatPgVector(embedding)}::vector`,
          embeddingModel: model,
          embeddingDimensions: dimensions,
          metadata,
          indexedAt,
          updatedAt: indexedAt,
        };

        if (existing) {
          await trx
            .updateTable('docmostMcpChunks')
            .set(values)
            .where('id', '=', existing.id)
            .execute();
        } else {
          await trx
            .insertInto('docmostMcpChunks')
            .values({
              ...values,
              workspaceId: page.workspaceId,
              pageId: page.id,
              chunkIndex: chunk.chunkIndex,
            })
            .execute();
        }
      }

      await trx
        .updateTable('docmostMcpChunks')
        .set({
          deletedAt: indexedAt,
          updatedAt: indexedAt,
        })
        .where('workspaceId', '=', page.workspaceId)
        .where('pageId', '=', page.id)
        .where('embeddingModel', '=', model)
        .where('chunkIndex', '>=', chunks.length)
        .where('deletedAt', 'is', null)
        .execute();
    });
  }

  private async markJobSucceeded(
    jobId: string,
    stats: McpVectorIndexStats,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'succeeded',
        stats,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', jobId)
      .where('status', '=', 'running')
      .returning(['id'])
      .executeTakeFirst();
    return Boolean(result);
  }

  private async markJobFailed(jobId: string, err: unknown): Promise<void> {
    await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'failed',
        lastError: this.getSafeErrorMessage(err),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', jobId)
      .where('status', '=', 'running')
      .execute();
  }

  private async persistBatchProgress(
    jobId: string,
    stats: McpVectorIndexStats,
  ): Promise<void> {
    await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({ stats, updatedAt: new Date() })
      .where('id', '=', jobId)
      .where('status', 'in', ['running', 'paused', 'cancelled'])
      .execute();
  }

  private async getBatchControlStatus(jobId: string): Promise<string> {
    const row = await this.db
      .selectFrom('docmostMcpIndexJobs')
      .select(['status'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException('MCP vector index job not found');
    }
    return row.status;
  }

  private toControlledBatchResult(
    job: DocmostMcpIndexJob,
    status: 'paused' | 'cancelled',
    pageJobIds: string[],
    scannedPageCount: number,
    batchCount: number,
  ): McpVectorBatchIndexResult {
    return {
      jobId: job.id,
      jobType: job.jobType as 'space' | 'workspace',
      workspaceId: job.workspaceId,
      spaceId: job.spaceId,
      status,
      queuedPageCount: pageJobIds.length,
      scannedPageCount,
      batchCount,
      pageJobIds,
    };
  }

  private async removeInactiveBullJob(
    job: Pick<DocmostMcpIndexJob, 'id' | 'attemptCount' | 'status'>,
  ): Promise<void> {
    const bullJob = await this.vectorQueue.getJob(this.getBullJobId(job));
    if (!bullJob || (await bullJob.getState()) === 'active') {
      return;
    }
    await bullJob.remove();
  }

  private async cancelQueuedChildJobs(
    parentJob: DocmostMcpIndexJob,
  ): Promise<number> {
    const stats = this.asStatsObject(parentJob.stats);
    const pageJobIds = Array.isArray(stats.pageJobIds)
      ? stats.pageJobIds.filter(
          (pageJobId): pageJobId is string => typeof pageJobId === 'string',
        )
      : [];
    if (pageJobIds.length === 0) {
      return 0;
    }

    const children = await this.db
      .updateTable('docmostMcpIndexJobs')
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', 'in', pageJobIds)
      .where('status', 'in', ['queued', 'paused'])
      .returningAll()
      .execute();
    for (const child of children) {
      await this.removeInactiveBullJob(child);
    }
    return children.length;
  }

  private async recoverPendingJobs(): Promise<void> {
    const jobs = await this.db
      .selectFrom('docmostMcpIndexJobs')
      .selectAll()
      .where('status', 'in', ['queued', 'running'])
      .orderBy('createdAt', 'asc')
      .execute();

    for (const job of jobs) {
      const bullJobId = this.getBullJobId(job);
      const existing = await this.vectorQueue.getJob(bullJobId);
      if (existing) {
        continue;
      }

      let recoverableJob = job;
      if (job.status === 'running') {
        recoverableJob = await this.db
          .updateTable('docmostMcpIndexJobs')
          .set({
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            updatedAt: new Date(),
          })
          .where('id', '=', job.id)
          .where('status', '=', 'running')
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      await this.enqueuePersistedJob(recoverableJob);
    }
  }

  private async assertEmbeddingDimensionContract(): Promise<void> {
    const configuredDimensions =
      this.environmentService.getEmbeddingDimensions();
    if (configuredDimensions !== 1536) {
      throw new Error(
        `EMBEDDING_DIMENSIONS=${configuredDimensions} is unsupported; this release requires 1536. Changing dimensions requires a database migration and full vector reindex.`,
      );
    }

    const contract = await buildEmbeddingDimensionContractQuery(
      this.db,
    ).executeTakeFirst();
    if (contract?.declaredType !== 'vector(1536)') {
      throw new Error(
        `docmost_mcp_chunks.embedding must be vector(1536), found ${contract?.declaredType ?? 'missing'}. Apply the matching database migration before enabling vector search.`,
      );
    }
  }

  private async enqueuePersistedJob(
    job: Pick<DocmostMcpIndexJob, 'id' | 'attemptCount' | 'status'>,
    opts: { delayMs?: number; manualRetry?: boolean } = {},
  ): Promise<void> {
    await this.vectorQueue.add(
      QueueJob.MCP_VECTOR_RUN_JOB,
      { indexJobId: job.id },
      {
        jobId: this.getBullJobId(job, opts.manualRetry),
        delay: opts.delayMs ?? 0,
      },
    );
  }

  private getBullJobId(
    job: Pick<DocmostMcpIndexJob, 'id' | 'attemptCount' | 'status'>,
    manualRetry = false,
  ): string {
    const attemptSlot =
      manualRetry || job.status === 'queued'
        ? job.attemptCount + 1
        : Math.max(1, job.attemptCount);
    return `${job.id}-${attemptSlot}`;
  }

  private toQueuedJob(
    job: Pick<
      DocmostMcpIndexJob,
      'id' | 'jobType' | 'pageId' | 'spaceId' | 'workspaceId'
    >,
  ): McpVectorQueuedJob {
    return {
      jobId: job.id,
      jobType: job.jobType as McpVectorIndexJobType,
      pageId: job.pageId,
      spaceId: job.spaceId,
      workspaceId: job.workspaceId,
      status: 'queued',
    };
  }

  private resolveBatchOptions(
    job: DocmostMcpIndexJob,
    override: { spaceIds?: string[]; limit?: number },
  ): { spaceIds?: string[]; limit?: number } {
    const stats = this.asStatsObject(job.stats);
    const persistedSpaceIds = Array.isArray(stats.spaceIds)
      ? stats.spaceIds.filter(
          (spaceId): spaceId is string => typeof spaceId === 'string',
        )
      : undefined;
    return {
      spaceIds: override.spaceIds ?? persistedSpaceIds,
      limit:
        override.limit ??
        (typeof stats.limit === 'number' ? stats.limit : undefined),
    };
  }

  private asStatsObject(stats: Json): Record<string, Json> {
    return stats && typeof stats === 'object' && !Array.isArray(stats)
      ? (stats as Record<string, Json>)
      : {};
  }

  private assertVectorSearchEnabled(): void {
    if (!this.environmentService.isVectorSearchEnabled()) {
      throw new BadRequestException('Vector search is disabled');
    }
  }

  private getSafeErrorMessage(err: unknown): string {
    return getMcpSafeErrorMessage(err, 'MCP vector index job failed');
  }
}
