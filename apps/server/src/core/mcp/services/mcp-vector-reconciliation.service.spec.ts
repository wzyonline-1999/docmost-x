import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { McpDistributedTaskService } from './mcp-distributed-task.service';
import type { McpVectorIndexService } from './mcp-vector-index.service';
import { McpVectorReconciliationService } from './mcp-vector-reconciliation.service';

describe('McpVectorReconciliationService', () => {
  const environmentService = {
    isVectorSearchEnabled: jest.fn(),
  };
  const distributedTaskService = {
    runWithLock: jest.fn(),
  };
  const vectorIndexService = {
    reconcileSpaceEligibility: jest.fn(),
  };
  const db = {};

  let service: McpVectorReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    environmentService.isVectorSearchEnabled.mockReturnValue(true);
    distributedTaskService.runWithLock.mockImplementation(
      async (_name: string, _ttl: number, task: () => Promise<unknown>) => ({
        acquired: true,
        value: await task(),
      }),
    );
    vectorIndexService.reconcileSpaceEligibility.mockResolvedValue({
      eligiblePageCount: 1,
      ineligiblePageCount: 0,
      queuedJobIds: ['job-1'],
    });
    service = new McpVectorReconciliationService(
      db as KyselyDB,
      environmentService as unknown as EnvironmentService,
      distributedTaskService as unknown as McpDistributedTaskService,
      vectorIndexService as unknown as McpVectorIndexService,
    );
  });

  it('does not contend for the leader lock while vector search is disabled', async () => {
    environmentService.isVectorSearchEnabled.mockReturnValue(false);

    await service.reconcilePendingWithLock();

    expect(distributedTaskService.runWithLock).not.toHaveBeenCalled();
  });

  it('expires elapsed clients and processes leases while holding one distributed lock', async () => {
    const expire = jest
      .spyOn(service as any, 'expireElapsedClients')
      .mockResolvedValue(undefined);
    const process = jest
      .spyOn(service as any, 'processPendingReconciliations')
      .mockResolvedValue(undefined);

    await service.reconcilePendingWithLock();

    expect(distributedTaskService.runWithLock).toHaveBeenCalledWith(
      'vector-eligibility-reconciliation',
      55_000,
      expect.any(Function),
    );
    expect(expire).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(
      process.mock.invocationCallOrder[0],
    );
  });

  it('reconciles each claimed space and acknowledges the exact request version', async () => {
    const lease = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      requestedAt: new Date('2026-07-27T00:00:00.000Z'),
    };
    jest
      .spyOn(service as any, 'claimPendingReconciliations')
      .mockResolvedValue([lease]);
    const complete = jest
      .spyOn(service as any, 'completeLease')
      .mockResolvedValue(undefined);
    const release = jest
      .spyOn(service as any, 'releaseFailedLease')
      .mockResolvedValue(undefined);

    await (service as any).processPendingReconciliations();

    expect(vectorIndexService.reconcileSpaceEligibility).toHaveBeenCalledWith({
      workspaceId: lease.workspaceId,
      spaceId: lease.spaceId,
      enqueueEligible: true,
    });
    expect(complete).toHaveBeenCalledWith(lease);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a failed lease for a later replica-safe retry', async () => {
    const lease = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      requestedAt: new Date('2026-07-27T00:00:00.000Z'),
    };
    const error = new Error('temporary queue failure');
    jest
      .spyOn(service as any, 'claimPendingReconciliations')
      .mockResolvedValue([lease]);
    vectorIndexService.reconcileSpaceEligibility.mockRejectedValueOnce(error);
    const complete = jest
      .spyOn(service as any, 'completeLease')
      .mockResolvedValue(undefined);
    const release = jest
      .spyOn(service as any, 'releaseFailedLease')
      .mockResolvedValue(undefined);

    await (service as any).processPendingReconciliations();

    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(lease, error);
  });
});
