import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { McpDistributedTaskService } from './mcp-distributed-task.service';
import { McpRetentionService } from './mcp-retention.service';

describe('McpRetentionService', () => {
  const environmentService = {
    getEmbeddingModel: jest.fn(() => 'active-model'),
  };
  const distributedTaskService = {
    runWithLock: jest.fn(),
  };
  let service: McpRetentionService;

  beforeEach(() => {
    jest.clearAllMocks();
    distributedTaskService.runWithLock.mockImplementation(
      async (_name: string, _ttl: number, task: () => Promise<unknown>) => ({
        acquired: true,
        value: await task(),
      }),
    );
    service = new McpRetentionService(
      {} as KyselyDB,
      environmentService as unknown as EnvironmentService,
      distributedTaskService as unknown as McpDistributedTaskService,
    );
  });

  it('uses one leader for retention across all application replicas', async () => {
    jest.spyOn(service, 'runRetention').mockResolvedValue({
      vectorChunks: 2,
      indexJobs: 3,
      auditLogs: 4,
    });

    await expect(service.maintainRetention()).resolves.toEqual({
      vectorChunks: 2,
      indexJobs: 3,
      auditLogs: 4,
    });
    expect(distributedTaskService.runWithLock).toHaveBeenCalledWith(
      'mcp-retention',
      1_800_000,
      expect.any(Function),
    );
  });

  it('applies the 7, 30, and 180 day retention cutoffs', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    const vector = jest
      .spyOn(service as any, 'deleteVectorChunkBatch')
      .mockResolvedValue(0);
    const jobs = jest
      .spyOn(service as any, 'deleteIndexJobBatch')
      .mockResolvedValue(0);
    const audits = jest
      .spyOn(service as any, 'deleteAuditLogBatch')
      .mockResolvedValue(0);

    await service.runRetention(now);

    expect(vector).toHaveBeenCalledWith(new Date('2026-07-20T00:00:00.000Z'));
    expect(jobs).toHaveBeenCalledWith(new Date('2026-06-27T00:00:00.000Z'));
    expect(audits).toHaveBeenCalledWith(new Date('2026-01-28T00:00:00.000Z'));
  });

  it('bounds one maintenance run even when every batch is full', async () => {
    const deleteBatch = jest.fn().mockResolvedValue(1000);

    await expect((service as any).deleteInBatches(deleteBatch)).resolves.toBe(
      20_000,
    );
    expect(deleteBatch).toHaveBeenCalledTimes(20);
  });
});
