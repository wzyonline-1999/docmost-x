import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { Queue } from 'bullmq';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { McpEmbeddingService } from './mcp-embedding.service';
import type { McpVectorEligibilityService } from './mcp-vector-eligibility.service';
import { McpVectorIndexService } from './mcp-vector-index.service';
import type { McpVectorTextService } from './mcp-vector-text.service';

describe('McpVectorIndexService permission eligibility', () => {
  const job = {
    id: 'job-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    pageId: 'page-1',
    jobType: 'page',
    status: 'queued',
    requestedByClientId: null,
    requestedByUserId: null,
    attemptCount: 0,
    lastError: null,
    stats: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
  };
  const page = {
    id: 'page-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    title: 'Restricted page',
    content: null,
    textContent: 'must not reach provider',
    deletedAt: null,
  };
  const jobSelectQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const pageSelectQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const dimensionQuery = {
    select: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
  };
  const updateQuery = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
    executeTakeFirstOrThrow: jest.fn(),
  };
  const insertQuery = {
    values: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
    executeTakeFirstOrThrow: jest.fn(),
  };
  const trx = {
    updateTable: jest.fn(() => updateQuery),
    insertInto: jest.fn(() => insertQuery),
  };
  const transactionExecute = jest.fn(
    async (callback: (transaction: typeof trx) => Promise<unknown>) =>
      callback(trx),
  );
  const db = {
    selectFrom: jest.fn((table: string | object) => {
      if (typeof table !== 'string') return dimensionQuery;
      return table === 'docmostMcpIndexJobs' ? jobSelectQuery : pageSelectQuery;
    }),
    updateTable: jest.fn(() => updateQuery),
    insertInto: jest.fn(() => insertQuery),
    transaction: jest.fn(() => ({ execute: transactionExecute })),
  };
  const environmentService = {
    isMcpEnabled: jest.fn(() => true),
    isVectorSearchEnabled: jest.fn(() => true),
    getEmbeddingModel: jest.fn(() => 'test-model'),
    getEmbeddingDimensions: jest.fn(() => 1536),
  };
  const vectorQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };
  const embeddingService = {
    createEmbeddings: jest.fn(),
  };
  const vectorTextService = {
    buildPageText: jest.fn(),
    chunkPageText: jest.fn(),
  };
  const eligibilityService = {
    evaluatePageIds: jest.fn(),
    isPageEligible: jest.fn(),
  };

  let service: McpVectorIndexService;

  beforeEach(() => {
    jest.clearAllMocks();
    jobSelectQuery.executeTakeFirst.mockResolvedValue(job);
    jobSelectQuery.execute.mockResolvedValue([]);
    pageSelectQuery.execute.mockResolvedValue([
      { id: page.id, workspaceId: page.workspaceId, spaceId: page.spaceId },
    ]);
    pageSelectQuery.executeTakeFirst.mockResolvedValue(page);
    dimensionQuery.executeTakeFirst.mockResolvedValue({
      declaredType: 'vector(1536)',
    });
    updateQuery.execute.mockResolvedValue(undefined);
    insertQuery.execute.mockResolvedValue(undefined);
    updateQuery.executeTakeFirst.mockResolvedValue({
      ...job,
      status: 'running',
      attemptCount: 1,
    });
    updateQuery.executeTakeFirstOrThrow.mockResolvedValue({
      ...job,
      status: 'running',
      attemptCount: 1,
    });
    eligibilityService.evaluatePageIds.mockResolvedValue({
      eligiblePageIds: [],
      ineligiblePageIds: [page.id],
    });
    eligibilityService.isPageEligible.mockResolvedValue(false);
    service = new McpVectorIndexService(
      db as unknown as KyselyDB,
      vectorQueue as unknown as Queue,
      environmentService as unknown as EnvironmentService,
      embeddingService as unknown as McpEmbeddingService,
      vectorTextService as unknown as McpVectorTextService,
      eligibilityService as unknown as McpVectorEligibilityService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists a job before adding it to the durable queue', async () => {
    insertQuery.executeTakeFirst.mockResolvedValueOnce(job);
    vectorQueue.add.mockResolvedValueOnce(undefined);

    await expect(
      service.enqueuePage(
        {
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
        },
        { autoRun: true, delayMs: 1000 },
      ),
    ).resolves.toEqual(
      expect.objectContaining({ jobId: job.id, status: 'queued' }),
    );

    expect(insertQuery.executeTakeFirst).toHaveBeenCalled();
    expect(insertQuery.values).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(vectorQueue.add).toHaveBeenCalledWith(
      'mcp-vector-run-job',
      { indexJobId: job.id },
      { delay: 1000, jobId: `${job.id}-1` },
    );
  });

  it('recovers a persisted queued job that is missing from BullMQ', async () => {
    jobSelectQuery.execute.mockResolvedValueOnce([job]);
    vectorQueue.getJob.mockResolvedValueOnce(undefined);
    vectorQueue.add.mockResolvedValueOnce(undefined);

    await service.onModuleInit();

    expect(vectorQueue.getJob).toHaveBeenCalledWith(`${job.id}-1`);
    expect(vectorQueue.add).toHaveBeenCalledWith(
      'mcp-vector-run-job',
      { indexJobId: job.id },
      { delay: 0, jobId: `${job.id}-1` },
    );
  });

  it('rejects a database vector column with a mismatched typmod at startup', async () => {
    dimensionQuery.executeTakeFirst.mockResolvedValueOnce({
      declaredType: 'vector(3072)',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'must be vector(1536)',
    );
    expect(vectorQueue.add).not.toHaveBeenCalled();
  });

  it('rejects unsupported configured dimensions before querying jobs', async () => {
    environmentService.getEmbeddingDimensions.mockReturnValueOnce(3072);

    await expect(service.onModuleInit()).rejects.toThrow(
      'this release requires 1536',
    );
    expect(jobSelectQuery.execute).not.toHaveBeenCalled();
  });

  it('uses a stable cursor and bases continuation on the scanned batch', async () => {
    const scannedPages = [
      { id: 'page-2', workspaceId: page.workspaceId, spaceId: page.spaceId },
      { id: 'page-3', workspaceId: page.workspaceId, spaceId: page.spaceId },
    ];
    pageSelectQuery.execute.mockResolvedValueOnce(scannedPages);
    eligibilityService.evaluatePageIds.mockResolvedValueOnce({
      eligiblePageIds: ['page-3'],
      ineligiblePageIds: ['page-2'],
    });

    const result = await (
      service as unknown as {
        getBatchPageBatch: (
          batchJob: typeof job,
          opts: { limit: number },
          cursor: string,
        ) => Promise<{
          pages: typeof scannedPages;
          scannedPageCount: number;
          nextCursor?: string;
          hasMore: boolean;
        }>;
      }
    ).getBatchPageBatch(
      { ...job, pageId: null, jobType: 'space' },
      { limit: 2 },
      'page-1',
    );

    expect(pageSelectQuery.where).toHaveBeenCalledWith('id', '>', 'page-1');
    expect(pageSelectQuery.orderBy).toHaveBeenCalledWith('id', 'asc');
    expect(result).toEqual({
      pages: [scannedPages[1]],
      scannedPageCount: 2,
      nextCursor: 'page-3',
      hasMore: true,
    });
  });

  it('does not enqueue automatic jobs for pages without index eligibility', async () => {
    await expect(
      service.enqueuePageIds({
        workspaceId: page.workspaceId,
        pageIds: [page.id],
      }),
    ).resolves.toEqual([]);

    expect(eligibilityService.evaluatePageIds).toHaveBeenCalledWith({
      workspaceId: page.workspaceId,
      pageIds: [page.id],
    });
    expect(db.insertInto).not.toHaveBeenCalled();
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('rechecks eligibility before execution and never sends restricted text', async () => {
    await expect(service.runQueuedJob(job.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'succeeded',
        skipped: true,
        skippedReason: 'permission',
        embeddedCount: 0,
      }),
    );

    expect(eligibilityService.isPageEligible).toHaveBeenCalledWith(
      page.workspaceId,
      page.id,
    );
    expect(vectorTextService.buildPageText).not.toHaveBeenCalled();
    expect(embeddingService.createEmbeddings).not.toHaveBeenCalled();
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({
          skipped: true,
          skippedReason: 'permission',
        }),
      }),
    );
  });

  it('soft deletes active chunks when a delete job runs', async () => {
    const deleteJob = { ...job, jobType: 'delete' };
    jobSelectQuery.executeTakeFirst.mockResolvedValueOnce(deleteJob);
    updateQuery.executeTakeFirst.mockResolvedValueOnce({
      ...deleteJob,
      status: 'running',
      attemptCount: 1,
    });

    await expect(service.runQueuedJob(deleteJob.id)).resolves.toMatchObject({
      jobType: 'delete',
      status: 'succeeded',
      deleted: true,
      chunkCount: 0,
    });

    expect(db.updateTable).toHaveBeenCalledWith('docmostMcpChunks');
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );
    expect(embeddingService.createEmbeddings).not.toHaveBeenCalled();
  });

  it('reindexes an eligible restored page', async () => {
    const restoreJob = { ...job, jobType: 'restore' };
    const chunks = [
      {
        chunkIndex: 0,
        content: 'restored content',
        contentHash: 'restored-hash',
        startOffset: 0,
        endOffset: 16,
        charLength: 16,
      },
    ];
    jobSelectQuery.executeTakeFirst.mockResolvedValueOnce(restoreJob);
    updateQuery.executeTakeFirst.mockResolvedValueOnce({
      ...restoreJob,
      status: 'running',
      attemptCount: 1,
    });
    eligibilityService.isPageEligible.mockResolvedValueOnce(true);
    vectorTextService.buildPageText.mockReturnValueOnce('restored content');
    vectorTextService.chunkPageText.mockReturnValueOnce(chunks);
    embeddingService.createEmbeddings.mockResolvedValueOnce([
      new Array(1536).fill(0.1),
    ]);
    const privateService = service as unknown as {
      getActivePageChunks: () => Promise<unknown[]>;
      writePageChunks: () => Promise<void>;
    };
    jest.spyOn(privateService, 'getActivePageChunks').mockResolvedValueOnce([]);
    const writePageChunks = jest
      .spyOn(privateService, 'writePageChunks')
      .mockResolvedValueOnce(undefined);

    await expect(service.runQueuedJob(restoreJob.id)).resolves.toMatchObject({
      jobType: 'restore',
      status: 'succeeded',
      deleted: false,
      chunkCount: 1,
    });

    expect(embeddingService.createEmbeddings).toHaveBeenCalledWith([
      'restored content',
    ]);
    expect(writePageChunks).toHaveBeenCalledTimes(1);
  });

  it('persists only a classified error when an index job fails', async () => {
    eligibilityService.isPageEligible.mockResolvedValueOnce(true);
    vectorTextService.buildPageText.mockImplementationOnce(() => {
      throw new Error('secret-token and restricted page content');
    });

    await expect(service.runQueuedJob(job.id)).rejects.toThrow('secret-token');

    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        lastError: 'MCP vector index job failed (Error)',
      }),
    );
    expect(JSON.stringify(updateQuery.set.mock.calls)).not.toContain(
      'restricted page content',
    );
  });

  it('does not write chunks when the embedding provider rejects a batch', async () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'first chunk',
        contentHash: 'first-hash',
        startOffset: 0,
        endOffset: 11,
        charLength: 11,
      },
      {
        chunkIndex: 1,
        content: 'second chunk',
        contentHash: 'second-hash',
        startOffset: 11,
        endOffset: 23,
        charLength: 12,
      },
    ];
    eligibilityService.isPageEligible.mockResolvedValueOnce(true);
    vectorTextService.buildPageText.mockReturnValueOnce('two chunks');
    vectorTextService.chunkPageText.mockReturnValueOnce(chunks);
    embeddingService.createEmbeddings.mockRejectedValueOnce(
      new Error('provider returned the wrong vector count'),
    );
    const privateService = service as unknown as {
      getActivePageChunks: () => Promise<unknown[]>;
      writePageChunks: () => Promise<void>;
    };
    jest.spyOn(privateService, 'getActivePageChunks').mockResolvedValueOnce([]);
    const writePageChunks = jest.spyOn(privateService, 'writePageChunks');

    await expect(service.runQueuedJob(job.id)).rejects.toThrow(
      'wrong vector count',
    );

    expect(writePageChunks).not.toHaveBeenCalled();
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        lastError: 'MCP vector index job failed (Error)',
      }),
    );
  });

  it('embeds only chunks whose content hash changed', async () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'unchanged',
        contentHash: 'same-hash',
        startOffset: 0,
        endOffset: 9,
        charLength: 9,
      },
      {
        chunkIndex: 1,
        content: 'changed',
        contentHash: 'new-hash',
        startOffset: 9,
        endOffset: 16,
        charLength: 7,
      },
    ];
    eligibilityService.isPageEligible.mockResolvedValueOnce(true);
    vectorTextService.buildPageText.mockReturnValueOnce('page text');
    vectorTextService.chunkPageText.mockReturnValueOnce(chunks);
    embeddingService.createEmbeddings.mockResolvedValueOnce([
      new Array(1536).fill(0.1),
    ]);
    const privateService = service as unknown as {
      getActivePageChunks: () => Promise<unknown>;
      writePageChunks: () => Promise<void>;
    };
    jest.spyOn(privateService, 'getActivePageChunks').mockResolvedValueOnce([
      {
        id: 'chunk-1',
        chunkIndex: 0,
        contentHash: 'same-hash',
        embeddingDimensions: 1536,
      },
    ]);
    const writePageChunks = jest
      .spyOn(privateService, 'writePageChunks')
      .mockResolvedValueOnce(undefined);

    await expect(service.runQueuedJob(job.id)).resolves.toEqual(
      expect.objectContaining({ embeddedCount: 1 }),
    );

    expect(embeddingService.createEmbeddings).toHaveBeenCalledWith(['changed']);
    expect(writePageChunks).toHaveBeenCalledWith(
      page,
      chunks,
      new Map([[1, expect.any(Array)]]),
      new Map([
        [
          0,
          expect.objectContaining({
            contentHash: 'same-hash',
          }),
        ],
      ]),
    );
  });

  it('soft deletes stale trailing chunks when a page becomes shorter', async () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'short',
        contentHash: 'same-hash',
        startOffset: 0,
        endOffset: 5,
        charLength: 5,
      },
    ];
    const privateService = service as unknown as {
      writePageChunks: (
        targetPage: typeof page,
        targetChunks: typeof chunks,
        embeddingsByIndex: Map<number, number[]>,
        existingByIndex: Map<
          number,
          {
            id: string;
            chunkIndex: number;
            contentHash: string;
            embeddingDimensions: number;
          }
        >,
      ) => Promise<void>;
    };

    await privateService.writePageChunks(
      page,
      chunks,
      new Map(),
      new Map([
        [
          0,
          {
            id: 'chunk-0',
            chunkIndex: 0,
            contentHash: 'same-hash',
            embeddingDimensions: 1536,
          },
        ],
        [
          1,
          {
            id: 'chunk-1',
            chunkIndex: 1,
            contentHash: 'old-extra-hash',
            embeddingDimensions: 1536,
          },
        ],
      ]),
    );

    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(trx.updateTable).toHaveBeenCalledTimes(2);
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: page.spaceId,
        indexedAt: expect.any(Date),
      }),
    );
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );
    expect(updateQuery.where).toHaveBeenCalledWith(
      'chunkIndex',
      '>=',
      chunks.length,
    );
    expect(updateQuery.where).toHaveBeenCalledWith('deletedAt', 'is', null);
  });

  it('pauses a queued batch job and removes its waiting BullMQ job', async () => {
    const batchJob = {
      ...job,
      pageId: null,
      jobType: 'space',
      status: 'queued',
    };
    const remove = jest.fn().mockResolvedValue(undefined);
    const bullJob = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove,
    };
    jobSelectQuery.executeTakeFirst.mockResolvedValueOnce(batchJob);
    updateQuery.executeTakeFirst.mockResolvedValueOnce({
      ...batchJob,
      status: 'paused',
    });
    vectorQueue.getJob.mockResolvedValueOnce(bullJob);

    await expect(service.pauseJob(batchJob.id)).resolves.toEqual({
      jobId: batchJob.id,
      status: 'paused',
    });
    expect(vectorQueue.getJob).toHaveBeenCalledWith(`${batchJob.id}-1`);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('resumes from a drained pause using the next persisted attempt slot', async () => {
    const pausedJob = {
      ...job,
      pageId: null,
      jobType: 'workspace',
      status: 'paused',
      attemptCount: 1,
      stats: { lastCursor: 'page-100', spaceIds: ['space-1'] },
    };
    const remove = jest.fn().mockResolvedValue(undefined);
    vectorQueue.getJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('completed'),
      remove,
    });
    vectorQueue.add.mockResolvedValueOnce(undefined);
    jobSelectQuery.executeTakeFirst.mockResolvedValueOnce(pausedJob);
    updateQuery.executeTakeFirst.mockResolvedValueOnce({
      ...pausedJob,
      status: 'queued',
      stats: { ...pausedJob.stats, spaceIds: ['space-2'] },
    });

    await expect(
      service.resumeJob(pausedJob.id, { spaceIds: ['space-2'] }),
    ).resolves.toEqual(
      expect.objectContaining({ jobId: pausedJob.id, status: 'queued' }),
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued',
        stats: expect.objectContaining({
          lastCursor: 'page-100',
          spaceIds: ['space-2'],
        }),
      }),
    );
    expect(vectorQueue.add).toHaveBeenCalledWith(
      'mcp-vector-run-job',
      { indexJobId: pausedJob.id },
      { delay: 0, jobId: `${pausedJob.id}-2` },
    );
  });

  it('cancels an active batch job without overwriting it as succeeded', async () => {
    const batchJob = {
      ...job,
      pageId: null,
      jobType: 'space',
      status: 'running',
      attemptCount: 1,
      stats: {},
    };
    jobSelectQuery.executeTakeFirst.mockResolvedValueOnce(batchJob);
    updateQuery.executeTakeFirst.mockResolvedValueOnce({
      ...batchJob,
      status: 'cancelled',
    });
    vectorQueue.getJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    });

    await expect(service.cancelJob(batchJob.id)).resolves.toEqual({
      jobId: batchJob.id,
      status: 'cancelled',
      childJobCount: 0,
    });
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });
});
