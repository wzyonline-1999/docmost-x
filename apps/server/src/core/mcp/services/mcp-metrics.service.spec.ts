import { Logger } from '@nestjs/common';
import { McpMetricsService } from './mcp-metrics.service';

describe('McpMetricsService', () => {
  const jobQuery = {
    select: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const idempotencyQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const db = {
    selectFrom: jest.fn((table: string) =>
      table === 'docmostMcpIndexJobs' ? jobQuery : idempotencyQuery,
    ),
  };
  const distributedTaskService = {
    runOncePerWindow: jest.fn(),
  };
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
  };
  const redisService = {
    getOrThrow: jest.fn(() => redis),
  };

  let service: McpMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jobQuery.execute.mockResolvedValue([
      {
        status: 'queued',
        count: 2,
        oldestCreatedAt: new Date(Date.now() - 30_000),
      },
    ]);
    idempotencyQuery.execute.mockResolvedValue([
      { status: 'needs_reconciliation', count: 1 },
    ]);
    distributedTaskService.runOncePerWindow.mockImplementation(
      async (_name: string, _ttlMs: number, task: () => Promise<unknown>) => ({
        acquired: true,
        value: await task(),
      }),
    );
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    service = new McpMetricsService(
      db as never,
      distributedTaskService as never,
      redisService as never,
    );
  });

  it('exports request, mutation, denial, audit, and embedding metrics', async () => {
    service.observeRequest({
      method: 'tools/call',
      tool: 'update_page',
      outcome: 'success',
      durationSeconds: 0.25,
    });
    service.recordMutation('update_page', 'success');
    service.recordPermissionDenied('delete_page', 'delete');
    service.recordAuditFailure('mcp.page.update');
    service.observeEmbedding('success', 0.5, 3);

    const metrics = await service.metrics();

    expect(metrics).toContain(
      'docmost_mcp_requests_total{method="tools/call",tool="update_page",outcome="success"} 1',
    );
    expect(metrics).toContain(
      'docmost_mcp_permission_denials_total{tool="delete_page",action="delete"} 1',
    );
    expect(metrics).toContain(
      'docmost_mcp_embedding_inputs_total{outcome="success"} 3',
    );
  });

  it('refreshes queue and reconciliation gauges from durable state', async () => {
    await service.refreshPersistentGauges();

    const metrics = await service.metrics();
    expect(metrics).toContain('docmost_mcp_index_jobs{status="queued"} 2');
    expect(metrics).toContain(
      'docmost_mcp_idempotency_records{status="needs_reconciliation"} 1',
    );
    expect(metrics).toMatch(
      /docmost_mcp_index_oldest_job_age_seconds\{status="queued"\} 3\d(?:\.\d+)?/,
    );
    expect(metrics).toContain('docmost_mcp_persistent_snapshot_available 1');
    expect(redis.set).toHaveBeenCalledWith(
      'docmost:mcp:metrics:persistent-gauge-snapshot',
      expect.any(String),
      'PX',
      60_000,
    );
  });

  it('reuses the shared snapshot without scanning durable tables', async () => {
    distributedTaskService.runOncePerWindow.mockResolvedValueOnce({
      acquired: false,
    });
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        generatedAt: Date.now() / 1_000,
        jobs: [
          {
            status: 'running',
            count: 3,
            oldestCreatedAt: new Date(Date.now() - 10_000).toISOString(),
          },
        ],
        idempotency: [{ status: 'completed', count: 5 }],
      }),
    );

    await service.refreshPersistentGauges();

    expect(db.selectFrom).not.toHaveBeenCalled();
    const metrics = await service.metrics();
    expect(metrics).toContain('docmost_mcp_index_jobs{status="running"} 3');
    expect(metrics).toContain(
      'docmost_mcp_idempotency_records{status="completed"} 5',
    );
  });

  it('does not expose database error messages when gauge refresh fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jobQuery.execute.mockRejectedValueOnce(
      new Error('postgres://user:secret-token@database'),
    );

    await expect(service.refreshPersistentGauges()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith({
      event: 'mcp.metrics.refresh_failed',
      errorType: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
  });
});
