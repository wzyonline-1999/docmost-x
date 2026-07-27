import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpDistributedTaskService } from './mcp-distributed-task.service';
import { getMcpErrorType } from '../utils/mcp-error.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const VECTOR_RETENTION_MS = 7 * DAY_MS;
const JOB_RETENTION_MS = 30 * DAY_MS;
const AUDIT_RETENTION_MS = 180 * DAY_MS;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETENTION_LOCK_MS = 30 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1000;
const MAX_BATCHES_PER_RUN = 20;

export type McpRetentionResult = {
  vectorChunks: number;
  indexJobs: number;
  auditLogs: number;
};

@Injectable()
export class McpRetentionService {
  private readonly logger = new Logger(McpRetentionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly distributedTaskService: McpDistributedTaskService,
  ) {}

  @Interval(RETENTION_INTERVAL_MS)
  async maintainRetention(): Promise<McpRetentionResult> {
    const result = await this.distributedTaskService.runWithLock(
      'mcp-retention',
      RETENTION_LOCK_MS,
      () => this.runRetention(),
    );
    return result.acquired
      ? result.value
      : { vectorChunks: 0, indexJobs: 0, auditLogs: 0 };
  }

  async runRetention(now = new Date()): Promise<McpRetentionResult> {
    const vectorCutoff = new Date(now.getTime() - VECTOR_RETENTION_MS);
    const jobCutoff = new Date(now.getTime() - JOB_RETENTION_MS);
    const auditCutoff = new Date(now.getTime() - AUDIT_RETENTION_MS);

    try {
      const vectorChunks = await this.deleteInBatches(() =>
        this.deleteVectorChunkBatch(vectorCutoff),
      );
      const indexJobs = await this.deleteInBatches(() =>
        this.deleteIndexJobBatch(jobCutoff),
      );
      const auditLogs = await this.deleteInBatches(() =>
        this.deleteAuditLogBatch(auditCutoff),
      );
      return { vectorChunks, indexJobs, auditLogs };
    } catch (err) {
      this.logger.warn({
        event: 'mcp.retention.failed',
        errorType: getMcpErrorType(err),
      });
      throw err;
    }
  }

  private async deleteVectorChunkBatch(cutoff: Date): Promise<number> {
    const activeModel = this.environmentService.getEmbeddingModel();
    const result = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT id
        FROM docmost_mcp_chunks
        WHERE updated_at < ${cutoff}
          AND (
            deleted_at IS NOT NULL
            OR embedding_model <> ${activeModel}
          )
        ORDER BY updated_at ASC
        LIMIT ${RETENTION_BATCH_SIZE}
      ),
      deleted AS (
        DELETE FROM docmost_mcp_chunks AS chunk
        USING victims
        WHERE chunk.id = victims.id
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted
    `.execute(this.db);
    return result.rows[0]?.deleted ?? 0;
  }

  private async deleteIndexJobBatch(cutoff: Date): Promise<number> {
    const result = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT job.id
        FROM docmost_mcp_index_jobs AS job
        WHERE job.status IN ('succeeded', 'failed', 'cancelled')
          AND COALESCE(job.finished_at, job.updated_at) < ${cutoff}
          AND NOT EXISTS (
            SELECT 1
            FROM docmost_mcp_index_jobs AS child
            WHERE child.parent_job_id = job.id
              AND child.status IN ('queued', 'running', 'waiting', 'paused')
          )
        ORDER BY COALESCE(job.finished_at, job.updated_at) ASC
        LIMIT ${RETENTION_BATCH_SIZE}
      ),
      deleted AS (
        DELETE FROM docmost_mcp_index_jobs AS job
        USING victims
        WHERE job.id = victims.id
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted
    `.execute(this.db);
    return result.rows[0]?.deleted ?? 0;
  }

  private async deleteAuditLogBatch(cutoff: Date): Promise<number> {
    const result = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT id
        FROM mcp_audit_logs
        WHERE created_at < ${cutoff}
        ORDER BY created_at ASC
        LIMIT ${RETENTION_BATCH_SIZE}
      ),
      deleted AS (
        DELETE FROM mcp_audit_logs AS audit
        USING victims
        WHERE audit.id = victims.id
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted
    `.execute(this.db);
    return result.rows[0]?.deleted ?? 0;
  }

  private async deleteInBatches(
    deleteBatch: () => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const deleted = await deleteBatch();
      total += deleted;
      if (deleted < RETENTION_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }
}
