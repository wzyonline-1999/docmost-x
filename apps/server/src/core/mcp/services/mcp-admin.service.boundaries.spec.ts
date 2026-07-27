import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { ListMcpAuditLogsDto, ListMcpClientsDto } from '../dto/mcp-admin.dto';
import type { McpAuditService } from './mcp-audit.service';
import { McpAdminService } from './mcp-admin.service';
import type { McpEffectivePermissionService } from './mcp-effective-permission.service';
import type { McpTokenService } from './mcp-token.service';
import type { McpVectorIndexService } from './mcp-vector-index.service';

describe('McpAdminService admin boundaries', () => {
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
    tokenHash: 'secret-token-hash',
    tokenLastFour: 'last',
    globalScopes: {},
    actorUserId: 'admin-1',
    createdById: 'admin-1',
    ownerUserId: 'admin-1',
    scope: 'personal',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    deletedAt: null,
  };
  const permission = {
    id: 'permission-1',
    clientId: client.id,
    workspaceId,
    spaceId: 'space-1',
    canSearch: true,
    canSemanticSearch: false,
    canRead: true,
    canCreate: false,
    canUpdate: false,
    canAppend: false,
    canDelete: false,
    canRestore: false,
    canIndex: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    deletedAt: null,
  };
  const auditLog = {
    id: 'audit-1',
    workspaceId,
    clientId: client.id,
    actorUserId: 'actor-1',
    event: 'mcp.page.update',
    resourceType: 'page',
    resourceId: 'page-1',
    spaceId: permission.spaceId,
    toolName: 'update_page',
    requestId: 'request-1',
    before: { title: 'Before' },
    after: { title: 'After' },
    metadata: { outcome: 'completed' },
    ipAddress: '127.0.0.1',
    createdAt: new Date('2026-07-03T00:00:00.000Z'),
  };
  const clientQuery = {
    select: jest.fn().mockReturnThis(),
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const permissionQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const userQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const spaceQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const auditQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const selectFrom = jest.fn((table: string) => {
    if (table === 'mcpClients') return clientQuery;
    if (table === 'mcpClientSpacePermissions') return permissionQuery;
    if (table === 'users') return userQuery;
    if (table === 'spaces') return spaceQuery;
    return auditQuery;
  });
  const db = {
    selectFrom,
    transaction: jest.fn(),
  };
  const tokenService = {
    generateToken: jest.fn(),
    hashToken: jest.fn(),
    getTokenLastFour: jest.fn(),
  };
  const auditService = {
    log: jest.fn(),
  };
  const vectorIndexService = {
    reconcileSpaceEligibility: jest.fn(),
  };
  const allPermissions = {
    canSearch: true,
    canSemanticSearch: true,
    canRead: true,
    canCreate: true,
    canUpdate: true,
    canAppend: true,
    canDelete: true,
    canRestore: true,
    canIndex: true,
  };
  const effectivePermissionService = {
    getClientSpaceCeilings: jest.fn(),
    assertPermissionPatchAllowed: jest.fn(),
    emptyPermissions: jest.fn(() => ({
      canSearch: false,
      canSemanticSearch: false,
      canRead: false,
      canCreate: false,
      canUpdate: false,
      canAppend: false,
      canDelete: false,
      canRestore: false,
      canIndex: false,
    })),
    intersectPermissions: jest.fn(),
  };
  let service: McpAdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.execute.mockResolvedValue([client]);
    clientQuery.executeTakeFirst.mockResolvedValue(client);
    permissionQuery.execute.mockResolvedValue([permission]);
    userQuery.executeTakeFirst.mockResolvedValue({
      id: 'admin-1',
      workspaceId,
      deactivatedAt: null,
      deletedAt: null,
    });
    userQuery.execute.mockResolvedValue([{ id: 'admin-1', name: 'Admin One' }]);
    spaceQuery.execute.mockResolvedValue([{ id: permission.spaceId }]);
    auditQuery.execute.mockResolvedValue([auditLog]);
    effectivePermissionService.getClientSpaceCeilings.mockImplementation(
      async (_client: unknown, spaceIds: string[]) => ({
        actorAvailable: true,
        actorReason: null,
        spaces: spaceIds.map((spaceId) => ({
          spaceId,
          actorRole: 'admin',
          reason: null,
          permissions: { ...allPermissions },
        })),
      }),
    );
    service = new McpAdminService(
      db as unknown as KyselyDB,
      tokenService as unknown as McpTokenService,
      auditService as unknown as McpAuditService,
      vectorIndexService as unknown as McpVectorIndexService,
      effectivePermissionService as unknown as McpEffectivePermissionService,
    );
  });

  it('rejects duplicate create permissions before any database mutation', async () => {
    await expect(
      service.createClient(workspaceId, principal, {
        name: 'Codex',
        permissions: [
          { spaceId: permission.spaceId, canRead: true },
          { spaceId: permission.spaceId, canSearch: true },
        ],
      }),
    ).rejects.toThrow('Duplicate MCP space permissions');

    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tokenService.generateToken).not.toHaveBeenCalled();
  });

  it('prevents regular admins from creating workspace-owned clients', async () => {
    await expect(
      service.createClient(workspaceId, principal, {
        name: 'Shared client',
        scope: 'workspace',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('prevents personal clients from impersonating another user', async () => {
    await expect(
      service.createClient(workspaceId, principal, {
        name: 'Impersonating client',
        actorUserId: 'actor-1',
      }),
    ).rejects.toThrow('Personal MCP clients must act as their owner');

    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('hides another administrator personal client from regular admins', async () => {
    clientQuery.executeTakeFirst.mockResolvedValueOnce({
      ...client,
      createdById: 'admin-2',
      ownerUserId: 'admin-2',
      actorUserId: 'admin-2',
    });

    await expect(
      service.getClient(workspaceId, principal, client.id),
    ).rejects.toThrow(NotFoundException);
    expect(permissionQuery.execute).not.toHaveBeenCalled();
  });

  it('lets the workspace owner inspect but not take over personal clients', async () => {
    const result = await service.getClient(
      workspaceId,
      ownerPrincipal,
      client.id,
    );

    expect(result.client.capabilities).toEqual({
      canEdit: false,
      canRotateToken: false,
      canDisable: true,
      canDelete: true,
      canManagePermissions: false,
    });

    await expect(
      service.rotateClientToken(workspaceId, ownerPrincipal, client.id),
    ).rejects.toThrow(ForbiddenException);
    expect(tokenService.generateToken).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        id: 'actor-2',
        workspaceId: 'workspace-2',
        deactivatedAt: null,
        deletedAt: null,
      },
    ],
    [
      {
        id: 'actor-1',
        workspaceId,
        deactivatedAt: new Date(),
        deletedAt: null,
      },
    ],
    [
      {
        id: 'actor-1',
        workspaceId,
        deactivatedAt: null,
        deletedAt: new Date(),
      },
    ],
    [undefined],
  ])('rejects an unavailable or cross-workspace actor %p', async (actor) => {
    userQuery.executeTakeFirst.mockResolvedValueOnce(actor);

    await expect(
      service.createClient(workspaceId, ownerPrincipal, {
        name: 'Codex',
        scope: 'workspace',
        actorUserId: 'actor-1',
      }),
    ).rejects.toThrow('Invalid MCP actor user');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-workspace actor on client update before mutation', async () => {
    userQuery.executeTakeFirst.mockResolvedValueOnce({
      id: 'actor-2',
      workspaceId: 'workspace-2',
      deactivatedAt: null,
      deletedAt: null,
    });

    clientQuery.executeTakeFirst.mockResolvedValueOnce({
      ...client,
      scope: 'workspace',
      ownerUserId: null,
    });

    await expect(
      service.updateClient(workspaceId, ownerPrincipal, {
        clientId: client.id,
        actorUserId: 'actor-2',
      }),
    ).rejects.toThrow('Invalid MCP actor user');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-date', 'valid date'],
    ['2020-01-01T00:00:00.000Z', 'in the future'],
  ])('rejects an invalid expiration %s', async (expiresAt, message) => {
    await expect(
      service.createClient(workspaceId, principal, {
        name: 'Codex',
        expiresAt,
      }),
    ).rejects.toThrow(message);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('lists scoped clients and never exposes token hashes', async () => {
    const dto = Object.assign(new ListMcpClientsDto(), {
      limit: 500,
      status: 'active',
      query: 'code',
    });
    const result = await service.listClients(workspaceId, principal, dto);

    expect(clientQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      workspaceId,
    );
    expect(clientQuery.where).toHaveBeenCalledWith('deletedAt', 'is', null);
    expect(clientQuery.where).toHaveBeenCalledWith('scope', '=', 'personal');
    expect(clientQuery.where).toHaveBeenCalledWith(
      'ownerUserId',
      '=',
      principal.userId,
    );
    expect(clientQuery.where).toHaveBeenCalledWith('status', '=', 'active');
    expect(clientQuery.where).toHaveBeenCalledWith('name', 'ilike', '%code%');
    expect(clientQuery.limit).toHaveBeenCalledWith(101);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: client.id,
        tokenLastFour: client.tokenLastFour,
        actorUserName: 'Admin One',
        ownerUserName: 'Admin One',
        permissions: [expect.objectContaining({ id: permission.id })],
      }),
    );
    expect(result.meta).toEqual({
      limit: 100,
      hasNextPage: false,
      hasPrevPage: false,
      nextCursor: null,
      prevCursor: null,
    });
    expect(JSON.stringify(result)).not.toContain(client.tokenHash);
  });

  it('combines audit filters inside the authenticated workspace', async () => {
    const dto = Object.assign(new ListMcpAuditLogsDto(), {
      clientId: client.id,
      spaceId: permission.spaceId,
      event: auditLog.event,
      toolName: auditLog.toolName,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-04T00:00:00.000Z',
      query: 'request',
      limit: 50,
    });
    const result = await service.listAuditLogs(workspaceId, principal, dto);

    expect(auditQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      workspaceId,
    );
    expect(auditQuery.where).toHaveBeenCalledWith('clientId', 'in', [
      client.id,
    ]);
    expect(auditQuery.where).toHaveBeenCalledWith('clientId', '=', client.id);
    expect(auditQuery.where).toHaveBeenCalledWith(
      'spaceId',
      '=',
      permission.spaceId,
    );
    expect(auditQuery.where).toHaveBeenCalledWith('event', '=', auditLog.event);
    expect(auditQuery.where).toHaveBeenCalledWith(
      'toolName',
      '=',
      auditLog.toolName,
    );
    expect(auditQuery.where).toHaveBeenCalledWith(
      'resourceType',
      '=',
      auditLog.resourceType,
    );
    expect(auditQuery.where).toHaveBeenCalledWith(
      'resourceId',
      '=',
      auditLog.resourceId,
    );
    expect(auditQuery.where).toHaveBeenCalledWith(
      'createdAt',
      '>=',
      new Date('2026-07-01T00:00:00.000Z'),
    );
    expect(auditQuery.where).toHaveBeenCalledWith(
      'createdAt',
      '<=',
      new Date('2026-07-04T00:00:00.000Z'),
    );
    const searchPredicate = auditQuery.where.mock.calls.find(
      ([predicate]) => typeof predicate === 'function',
    )?.[0];
    expect(searchPredicate).toEqual(expect.any(Function));

    const castExpression = Symbol('resource-id-as-text');
    const expressionBuilder = Object.assign(
      jest.fn((left, operator, right) => ({ left, operator, right })),
      {
        cast: jest.fn(() => castExpression),
        or: jest.fn((conditions) => conditions),
      },
    );
    searchPredicate(expressionBuilder);

    expect(expressionBuilder.cast).toHaveBeenCalledWith('resourceId', 'text');
    expect(expressionBuilder).toHaveBeenCalledWith(
      castExpression,
      'ilike',
      '%request%',
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        id: auditLog.id,
        workspaceId,
        requestId: auditLog.requestId,
      }),
    ]);
    expect(auditQuery.limit).toHaveBeenCalledWith(51);
    expect(result.meta).toEqual({
      limit: 50,
      hasNextPage: false,
      hasPrevPage: false,
      nextCursor: null,
      prevCursor: null,
    });
  });

  it('rejects inverted audit date ranges before querying logs', async () => {
    await expect(
      service.listAuditLogs(
        workspaceId,
        principal,
        Object.assign(new ListMcpAuditLogsDto(), {
          from: '2026-07-05T00:00:00.000Z',
          to: '2026-07-04T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(auditQuery.execute).not.toHaveBeenCalled();
  });
});
