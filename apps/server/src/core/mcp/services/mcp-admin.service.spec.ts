import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { McpAuditService } from './mcp-audit.service';
import { McpAdminService } from './mcp-admin.service';
import type { McpTokenService } from './mcp-token.service';
import type { McpVectorIndexService } from './mcp-vector-index.service';

describe('McpAdminService vector eligibility reconciliation', () => {
  const workspaceId = 'workspace-1';
  const principal = {
    userId: 'admin-1',
    isWorkspaceOwner: false,
  };
  const ownerPrincipal = {
    userId: 'owner-1',
    isWorkspaceOwner: true,
  };
  const client = {
    id: 'client-1',
    workspaceId,
    name: 'Codex',
    status: 'active',
    tokenHash: 'hash',
    tokenLastFour: 'last',
    globalScopes: {},
    actorUserId: 'admin-1',
    createdById: 'admin-1',
    ownerUserId: 'admin-1',
    scope: 'personal',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const existingPermission = {
    id: 'permission-1',
    clientId: client.id,
    workspaceId,
    spaceId: 'space-1',
    canSearch: true,
    canSemanticSearch: true,
    canRead: true,
    canCreate: false,
    canUpdate: false,
    canAppend: false,
    canDelete: false,
    canRestore: false,
    canIndex: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  const clientQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
  };
  const spaceQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const permissionQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const updateQuery = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirstOrThrow: jest.fn(),
  };
  const insertQuery = {
    values: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    executeTakeFirstOrThrow: jest.fn(),
  };
  const selectFrom = jest.fn((table: string) => {
    if (table === 'mcpClients') return clientQuery;
    if (table === 'spaces') return spaceQuery;
    return permissionQuery;
  });
  const updateTable = jest.fn(() => updateQuery);
  const trx = {
    selectFrom,
    updateTable,
    insertInto: jest.fn(() => insertQuery),
  };
  const transactionExecute = jest.fn(
    async (callback: (transaction: typeof trx) => Promise<unknown>) =>
      callback(trx),
  );
  const db = {
    selectFrom,
    updateTable,
    transaction: jest.fn(() => ({ execute: transactionExecute })),
  };
  const tokenService = {
    generateToken: jest.fn(() => 'dm_mcp_new-token'),
    hashToken: jest.fn(() => 'new-hash'),
    getTokenLastFour: jest.fn(() => 'oken'),
  };
  const auditService = {
    log: jest.fn(),
  };
  const vectorIndexService = {
    reconcileSpaceEligibility: jest.fn(),
  };

  let service: McpAdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.executeTakeFirst.mockResolvedValue(client);
    spaceQuery.execute.mockResolvedValue([{ id: existingPermission.spaceId }]);
    permissionQuery.executeTakeFirst.mockResolvedValue(existingPermission);
    permissionQuery.execute.mockResolvedValue([existingPermission]);
    updateQuery.executeTakeFirstOrThrow.mockResolvedValue({
      ...existingPermission,
      canIndex: false,
      updatedAt: new Date(),
    });
    updateQuery.execute.mockResolvedValue(undefined);
    insertQuery.executeTakeFirstOrThrow.mockResolvedValue(existingPermission);
    auditService.log.mockResolvedValue(undefined);
    vectorIndexService.reconcileSpaceEligibility.mockResolvedValue({
      eligiblePageCount: 0,
      ineligiblePageCount: 1,
      queuedJobIds: [],
    });
    service = new McpAdminService(
      db as unknown as KyselyDB,
      tokenService as unknown as McpTokenService,
      auditService as unknown as McpAuditService,
      vectorIndexService as unknown as McpVectorIndexService,
    );
  });

  it('reconciles the space after index permission is revoked', async () => {
    await service.upsertSpacePermission(workspaceId, principal, {
      clientId: client.id,
      spaceId: existingPermission.spaceId,
      canIndex: false,
    });

    expect(vectorIndexService.reconcileSpaceEligibility).toHaveBeenCalledWith({
      workspaceId,
      spaceId: existingPermission.spaceId,
      enqueueEligible: false,
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.permission.upsert',
        resourceId: existingPermission.id,
      }),
      trx,
    );
  });

  it('inserts a new permission and audits null before state', async () => {
    permissionQuery.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      service.upsertSpacePermission(workspaceId, principal, {
        clientId: client.id,
        spaceId: existingPermission.spaceId,
        canRead: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: existingPermission.id,
        canRead: true,
      }),
    );

    expect(insertQuery.values).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: client.id,
        workspaceId,
        spaceId: existingPermission.spaceId,
        canRead: true,
        canIndex: false,
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.permission.upsert',
        before: null,
      }),
      trx,
    );
  });

  it('inserts then updates one active permission without a duplicate insert', async () => {
    const updatedPermission = {
      ...existingPermission,
      canRead: false,
      updatedAt: new Date(),
    };
    permissionQuery.executeTakeFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(existingPermission);
    updateQuery.executeTakeFirstOrThrow.mockResolvedValueOnce(
      updatedPermission,
    );

    await service.upsertSpacePermission(workspaceId, principal, {
      clientId: client.id,
      spaceId: existingPermission.spaceId,
      canRead: true,
    });
    await expect(
      service.upsertSpacePermission(workspaceId, principal, {
        clientId: client.id,
        spaceId: existingPermission.spaceId,
        canRead: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ canRead: false }));

    expect(insertQuery.executeTakeFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(updateQuery.executeTakeFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledTimes(2);
  });

  it('soft deletes a permission transactionally before reconciling vectors', async () => {
    await service.deleteSpacePermission(workspaceId, principal, {
      clientId: client.id,
      spaceId: existingPermission.spaceId,
    });

    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.permission.delete',
        before: expect.objectContaining({ id: existingPermission.id }),
      }),
      trx,
    );
    expect(vectorIndexService.reconcileSpaceEligibility).toHaveBeenCalledWith({
      workspaceId,
      spaceId: existingPermission.spaceId,
      enqueueEligible: false,
    });
  });

  it('does not reconcile vector eligibility when permission audit fails', async () => {
    auditService.log.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
      service.upsertSpacePermission(workspaceId, principal, {
        clientId: client.id,
        spaceId: existingPermission.spaceId,
        canIndex: false,
      }),
    ).rejects.toThrow('audit insert failed');

    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(vectorIndexService.reconcileSpaceEligibility).not.toHaveBeenCalled();
  });

  it('rotates a token once without exposing either token hash', async () => {
    const rotatedClient = {
      ...client,
      tokenHash: 'new-hash',
      tokenLastFour: 'oken',
      updatedAt: new Date(),
    };
    updateQuery.executeTakeFirstOrThrow.mockResolvedValueOnce(rotatedClient);

    const result = await service.rotateClientToken(
      workspaceId,
      principal,
      client.id,
    );

    expect(result).toMatchObject({
      token: 'dm_mcp_new-token',
      client: {
        id: client.id,
        tokenLastFour: 'oken',
      },
    });
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: 'new-hash',
        tokenLastFour: 'oken',
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.client.rotate_token',
        before: expect.objectContaining({ tokenLastFour: 'last' }),
        after: expect.objectContaining({ tokenLastFour: 'oken' }),
      }),
      trx,
    );
    expect(JSON.stringify(result.client)).not.toContain(client.tokenHash);
    expect(JSON.stringify(result.client)).not.toContain(
      rotatedClient.tokenHash,
    );
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
      client.tokenHash,
    );
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
      rotatedClient.tokenHash,
    );
  });

  it('does not return a rotated token when its audit insert fails', async () => {
    const rotatedClient = {
      ...client,
      tokenHash: 'new-hash',
      tokenLastFour: 'oken',
      updatedAt: new Date(),
    };
    updateQuery.executeTakeFirstOrThrow.mockResolvedValueOnce(rotatedClient);
    auditService.log.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
      service.rotateClientToken(workspaceId, principal, client.id),
    ).rejects.toThrow('audit insert failed');

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.client.rotate_token',
        before: expect.objectContaining({ tokenLastFour: 'last' }),
        after: expect.objectContaining({ tokenLastFour: 'oken' }),
      }),
      trx,
    );
    expect(client.tokenHash).toBe('hash');
  });

  it('allows the workspace owner to disable but not take over a personal client', async () => {
    const disabledClient = {
      ...client,
      status: 'disabled',
      updatedAt: new Date(),
    };
    updateQuery.executeTakeFirstOrThrow.mockResolvedValueOnce(disabledClient);

    const result = await service.disableClient(
      workspaceId,
      ownerPrincipal,
      client.id,
    );

    expect(result.client).toEqual(
      expect.objectContaining({
        id: client.id,
        status: 'disabled',
        capabilities: expect.objectContaining({
          canEdit: false,
          canRotateToken: false,
          canDisable: true,
          canDelete: true,
        }),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ownerPrincipal.userId,
        event: 'mcp.client.update',
      }),
      trx,
    );
  });

  it('allows the workspace owner to rotate a workspace client', async () => {
    const workspaceClient = {
      ...client,
      scope: 'workspace',
      ownerUserId: null,
    };
    const rotatedClient = {
      ...workspaceClient,
      tokenHash: 'new-hash',
      tokenLastFour: 'oken',
      updatedAt: new Date(),
    };
    clientQuery.executeTakeFirst.mockResolvedValueOnce(workspaceClient);
    updateQuery.executeTakeFirstOrThrow.mockResolvedValueOnce(rotatedClient);

    const result = await service.rotateClientToken(
      workspaceId,
      ownerPrincipal,
      workspaceClient.id,
    );

    expect(result.client.capabilities).toEqual({
      canEdit: true,
      canRotateToken: true,
      canDisable: true,
      canDelete: true,
      canManagePermissions: true,
    });
    expect(result.token).toBe('dm_mcp_new-token');
  });
});
