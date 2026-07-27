import { ConflictException } from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { McpAuditService } from './mcp-audit.service';
import { McpAdminService } from './mcp-admin.service';
import type { McpEffectivePermissionService } from './mcp-effective-permission.service';
import type { McpTokenService } from './mcp-token.service';
import type { McpVectorIndexService } from './mcp-vector-index.service';

describe('McpAdminService repair records', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const principal = {
    userId: '22222222-2222-4222-8222-222222222222',
    isWorkspaceOwner: false,
  };
  const updatedAt = new Date('2026-07-27T08:00:00.000Z');
  const client = {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId,
    name: 'Personal client',
    status: 'active',
    tokenHash: 'hash',
    tokenLastFour: 'last',
    globalScopes: {},
    actorUserId: principal.userId,
    createdById: principal.userId,
    ownerUserId: principal.userId,
    scope: 'personal',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  };
  const repairRecord = {
    id: '44444444-4444-4444-8444-444444444444',
    clientId: client.id,
    workspaceId,
    idempotencyKey: 'request-with-private-details',
    action: 'update_page',
    requestHash: 'hash',
    response: null,
    status: 'repair_required',
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: null,
    expiresAt: null,
    resourceType: 'page',
    resourceId: '55555555-5555-4555-8555-555555555555',
    operationStage: 'page_mutated',
    beforeState: null,
    targetState: null,
    lastError: 'uncertain write',
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  };

  const clientQuery = {
    select: jest.fn().mockReturnThis(),
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const repairQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const updateQuery = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
  };
  const auditService = {
    log: jest.fn(),
  };
  const selectFrom = jest.fn((table: string) =>
    table === 'mcpClients' ? clientQuery : repairQuery,
  );
  const trx = {
    updateTable: jest.fn(() => updateQuery),
  };
  const db = {
    selectFrom,
    transaction: jest.fn(() => ({
      execute: jest.fn(
        async (callback: (transaction: typeof trx) => Promise<unknown>) =>
          callback(trx),
      ),
    })),
  };
  const service = new McpAdminService(
    db as unknown as KyselyDB,
    {} as McpTokenService,
    auditService as unknown as McpAuditService,
    {} as McpVectorIndexService,
    {} as McpEffectivePermissionService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.execute.mockResolvedValue([{ id: client.id }]);
    clientQuery.executeTakeFirst.mockResolvedValue(client);
    repairQuery.execute.mockResolvedValue([repairRecord]);
    repairQuery.executeTakeFirst.mockResolvedValue(repairRecord);
    updateQuery.executeTakeFirst.mockResolvedValue({
      ...repairRecord,
      status: 'needs_reconciliation',
      lastError: null,
      updatedAt: new Date('2026-07-27T08:01:00.000Z'),
    });
    auditService.log.mockResolvedValue(undefined);
  });

  it('lists only repair states and redacts the full idempotency key', async () => {
    const result = await service.listRepairRecords(workspaceId, principal, {
      limit: 20,
    } as never);

    expect(repairQuery.where).toHaveBeenCalledWith('status', 'in', [
      'needs_reconciliation',
      'repair_required',
    ]);
    expect(repairQuery.where).toHaveBeenCalledWith('clientId', 'in', [
      client.id,
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: repairRecord.id,
        idempotencyKeySuffix: '-details',
        status: 'repair_required',
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty('idempotencyKey');
  });

  it('reopens a repair record for reconciliation with optimistic locking', async () => {
    await expect(
      service.retryRepairRecord(workspaceId, principal, {
        recordId: repairRecord.id,
        expectedUpdatedAt: updatedAt.toISOString(),
      }),
    ).resolves.toMatchObject({
      id: repairRecord.id,
      status: 'needs_reconciliation',
      lastError: null,
    });

    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'needs_reconciliation',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      }),
    );
    expect(updateQuery.where).toHaveBeenCalledWith('updatedAt', '=', updatedAt);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.idempotency.retry_requested',
        clientId: client.id,
      }),
      trx,
    );
  });

  it('fails a stale repair action instead of overwriting another admin', async () => {
    updateQuery.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      service.retryRepairRecord(workspaceId, principal, {
        recordId: repairRecord.id,
        expectedUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toThrow(ConflictException);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('soft-deletes a confirmed repair record and audits the decision', async () => {
    updateQuery.executeTakeFirst.mockResolvedValueOnce({ id: repairRecord.id });

    await service.discardRepairRecord(workspaceId, principal, {
      recordId: repairRecord.id,
      expectedUpdatedAt: updatedAt.toISOString(),
      confirm: true,
    });

    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.idempotency.discarded',
        before: expect.objectContaining({ id: repairRecord.id }),
      }),
      trx,
    );
  });
});
