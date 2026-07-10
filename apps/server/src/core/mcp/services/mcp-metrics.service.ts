import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { getMcpErrorType } from '../utils/mcp-error.util';

const PERSISTENT_GAUGE_REFRESH_MS = 15_000;

@Injectable()
export class McpMetricsService {
  private readonly logger = new Logger(McpMetricsService.name);
  private readonly registry = new Registry();
  private readonly requests = new Counter({
    name: 'docmost_mcp_requests_total',
    help: 'MCP JSON-RPC requests by method, tool, and outcome.',
    labelNames: ['method', 'tool', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly requestDuration = new Histogram({
    name: 'docmost_mcp_request_duration_seconds',
    help: 'MCP JSON-RPC request latency.',
    labelNames: ['method', 'tool', 'outcome'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly permissionDenials = new Counter({
    name: 'docmost_mcp_permission_denials_total',
    help: 'MCP permission denials by tool and action.',
    labelNames: ['tool', 'action'] as const,
    registers: [this.registry],
  });
  private readonly mutations = new Counter({
    name: 'docmost_mcp_mutations_total',
    help: 'MCP write operations by tool and outcome.',
    labelNames: ['tool', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly auditFailures = new Counter({
    name: 'docmost_mcp_audit_failures_total',
    help: 'MCP audit persistence failures by event.',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });
  private readonly embeddingRequests = new Counter({
    name: 'docmost_mcp_embedding_requests_total',
    help: 'Embedding provider calls by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly embeddingInputs = new Counter({
    name: 'docmost_mcp_embedding_inputs_total',
    help: 'Number of texts submitted to the embedding provider.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly embeddingDuration = new Histogram({
    name: 'docmost_mcp_embedding_duration_seconds',
    help: 'End-to-end embedding provider latency.',
    labelNames: ['outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  private readonly indexJobs = new Gauge({
    name: 'docmost_mcp_index_jobs',
    help: 'Persisted MCP vector jobs by status.',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  private readonly oldestIndexJobAge = new Gauge({
    name: 'docmost_mcp_index_oldest_job_age_seconds',
    help: 'Age of the oldest MCP vector job by status.',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  private readonly idempotencyRecords = new Gauge({
    name: 'docmost_mcp_idempotency_records',
    help: 'Active MCP idempotency records by status.',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    collectDefaultMetrics({ prefix: 'docmost_', register: this.registry });
  }

  observeRequest(input: {
    method: string;
    tool: string;
    outcome: string;
    durationSeconds: number;
  }): void {
    const labels = {
      method: this.normalizeLabel(input.method),
      tool: this.normalizeLabel(input.tool),
      outcome: this.normalizeLabel(input.outcome),
    };
    this.requests.inc(labels);
    this.requestDuration.observe(labels, input.durationSeconds);
  }

  recordPermissionDenied(tool: string, action: string): void {
    this.permissionDenials.inc({
      tool: this.normalizeLabel(tool),
      action: this.normalizeLabel(action),
    });
  }

  recordMutation(tool: string, outcome: string): void {
    this.mutations.inc({
      tool: this.normalizeLabel(tool),
      outcome: this.normalizeLabel(outcome),
    });
  }

  recordAuditFailure(event: string): void {
    this.auditFailures.inc({ event: this.normalizeLabel(event) });
  }

  observeEmbedding(
    outcome: string,
    durationSeconds: number,
    inputCount: number,
  ): void {
    const labels = { outcome: this.normalizeLabel(outcome) };
    this.embeddingRequests.inc(labels);
    this.embeddingInputs.inc(labels, inputCount);
    this.embeddingDuration.observe(labels, durationSeconds);
  }

  @Interval(PERSISTENT_GAUGE_REFRESH_MS)
  async refreshPersistentGauges(): Promise<void> {
    try {
      const [jobs, idempotency] = await Promise.all([
        this.db
          .selectFrom('docmostMcpIndexJobs')
          .select([
            'status',
            sql<number>`count(*)::int`.as('count'),
            sql<Date>`min(created_at)`.as('oldestCreatedAt'),
          ])
          .groupBy('status')
          .execute(),
        this.db
          .selectFrom('mcpIdempotencyKeys')
          .select(['status', sql<number>`count(*)::int`.as('count')])
          .where('deletedAt', 'is', null)
          .groupBy('status')
          .execute(),
      ]);

      this.indexJobs.reset();
      this.oldestIndexJobAge.reset();
      for (const row of jobs) {
        this.indexJobs.set({ status: row.status }, Number(row.count));
        const oldest = row.oldestCreatedAt
          ? new Date(row.oldestCreatedAt).getTime()
          : Date.now();
        this.oldestIndexJobAge.set(
          { status: row.status },
          Math.max(0, (Date.now() - oldest) / 1000),
        );
      }

      this.idempotencyRecords.reset();
      for (const row of idempotency) {
        this.idempotencyRecords.set({ status: row.status }, Number(row.count));
      }
    } catch (err) {
      this.logger.warn({
        event: 'mcp.metrics.refresh_failed',
        errorType: getMcpErrorType(err),
      });
    }
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  private normalizeLabel(value: string): string {
    const normalized = value.trim();
    return normalized && normalized.length <= 80 ? normalized : 'unknown';
  }
}
