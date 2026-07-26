import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type {
  McpAuthenticatedClient,
  McpPermissionAction,
} from '../types/mcp.types';
import type { McpEffectivePermissionService } from './mcp-effective-permission.service';
import { McpPermissionService } from './mcp-permission.service';

describe('McpPermissionService', () => {
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    status: 'active',
    actorUserId: 'actor-1',
  } as McpAuthenticatedClient;
  const permission = {
    id: 'permission-1',
    clientId: client.id,
    workspaceId: client.workspaceId,
    spaceId: 'space-1',
    canSearch: true,
    canSemanticSearch: true,
    canRead: true,
    canCreate: true,
    canUpdate: false,
    canAppend: false,
    canDelete: false,
    canRestore: false,
    canIndex: true,
    deletedAt: null,
  };
  const page = {
    id: 'page-1',
    workspaceId: client.workspaceId,
    spaceId: permission.spaceId,
    deletedAt: null,
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(),
  };
  const db = {
    selectFrom: jest.fn(() => query),
  };
  const effectivePermissionService = {
    isClientActionAllowed: jest.fn(),
    filterClientSpaceIds: jest.fn(),
    getClientSpaceCeilings: jest.fn(),
    intersectPermissions: jest.fn(),
    emptyPermissions: jest.fn(),
  };
  let service: McpPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    query.execute.mockResolvedValue([{ spaceId: permission.spaceId }]);
    query.executeTakeFirst.mockResolvedValue(permission);
    effectivePermissionService.isClientActionAllowed.mockResolvedValue(true);
    effectivePermissionService.filterClientSpaceIds.mockImplementation(
      async (
        _client: McpAuthenticatedClient,
        _action: McpPermissionAction,
        spaceIds: string[],
      ) => spaceIds,
    );
    effectivePermissionService.getClientSpaceCeilings.mockImplementation(
      async (_client: McpAuthenticatedClient, spaceIds: string[]) => ({
        actorAvailable: true,
        actorReason: null,
        spaces: spaceIds.map((spaceId) => ({
          spaceId,
          actorRole: 'admin',
          reason: null,
          permissions: {
            canSearch: true,
            canSemanticSearch: true,
            canRead: true,
            canCreate: true,
            canUpdate: true,
            canAppend: true,
            canDelete: true,
            canRestore: true,
            canIndex: true,
          },
        })),
      }),
    );
    effectivePermissionService.intersectPermissions.mockImplementation(
      (configured: Record<string, boolean>, ceiling: Record<string, boolean>) =>
        Object.fromEntries(
          Object.keys(ceiling).map((field) => [
            field,
            configured[field] === true && ceiling[field] === true,
          ]),
        ),
    );
    effectivePermissionService.emptyPermissions.mockReturnValue({
      canSearch: false,
      canSemanticSearch: false,
      canRead: false,
      canCreate: false,
      canUpdate: false,
      canAppend: false,
      canDelete: false,
      canRestore: false,
      canIndex: false,
    });
    service = new McpPermissionService(
      db as unknown as KyselyDB,
      effectivePermissionService as unknown as McpEffectivePermissionService,
    );
  });

  it('scopes permission lookup to client, workspace, space, and active rows', async () => {
    await expect(
      service.getSpacePermission(client, permission.spaceId),
    ).resolves.toBe(permission);

    expect(query.where).toHaveBeenCalledWith('clientId', '=', client.id);
    expect(query.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      client.workspaceId,
    );
    expect(query.where).toHaveBeenCalledWith(
      'spaceId',
      '=',
      permission.spaceId,
    );
    expect(query.where).toHaveBeenCalledWith('deletedAt', 'is', null);
  });

  it.each([
    ['search', true],
    ['semanticSearch', true],
    ['read', true],
    ['create', true],
    ['update', false],
    ['append', false],
    ['delete', false],
    ['restore', false],
    ['index', true],
  ] as Array<[McpPermissionAction, boolean]>)(
    'maps the %s action to its explicit permission column',
    async (action, expected) => {
      await expect(
        service.hasSpacePermission(client, action, permission.spaceId),
      ).resolves.toBe(expected);
    },
  );

  it('fails closed when an active permission row is missing or denied', async () => {
    query.executeTakeFirst.mockResolvedValueOnce(undefined);
    await expect(
      service.hasSpacePermission(client, 'read', permission.spaceId),
    ).resolves.toBe(false);

    query.executeTakeFirst.mockResolvedValueOnce(permission);
    await expect(
      service.assertSpacePermission(client, 'update', permission.spaceId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('fails closed when configured permission exceeds current native access', async () => {
    effectivePermissionService.isClientActionAllowed.mockResolvedValueOnce(
      false,
    );

    await expect(
      service.hasSpacePermission(client, 'read', permission.spaceId),
    ).resolves.toBe(false);

    effectivePermissionService.isClientActionAllowed.mockResolvedValueOnce(
      false,
    );
    await expect(
      service.assertSpacePermission(client, 'read', permission.spaceId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns the permission row when the requested action is allowed', async () => {
    await expect(
      service.assertSpacePermission(client, 'read', permission.spaceId),
    ).resolves.toBe(permission);
  });

  it('intersects requested spaces with active action permissions', async () => {
    effectivePermissionService.filterClientSpaceIds.mockResolvedValueOnce([
      'space-1',
    ]);

    await expect(
      service.getAllowedSpaceIds(client, 'search', ['space-1', 'space-2']),
    ).resolves.toEqual(['space-1']);

    expect(query.where).toHaveBeenCalledWith('canSearch', '=', true);
    expect(query.where).toHaveBeenCalledWith('spaceId', 'in', [
      'space-1',
      'space-2',
    ]);
    expect(
      effectivePermissionService.filterClientSpaceIds,
    ).toHaveBeenCalledWith(client, 'search', ['space-1']);
  });

  it('removes configured spaces that the actor can no longer access', async () => {
    query.execute.mockResolvedValueOnce([
      { spaceId: 'space-1' },
      { spaceId: 'space-2' },
    ]);
    effectivePermissionService.filterClientSpaceIds.mockResolvedValueOnce([
      'space-2',
    ]);

    await expect(service.getAllowedSpaceIds(client, 'read')).resolves.toEqual([
      'space-2',
    ]);
  });

  it('treats an explicitly empty requested-space list as an empty scope', async () => {
    await expect(
      service.getAllowedSpaceIds(client, 'index', []),
    ).resolves.toEqual([]);

    expect(query.where).not.toHaveBeenCalled();
    expect(query.where).not.toHaveBeenCalledWith('spaceId', 'in', []);
    expect(
      effectivePermissionService.filterClientSpaceIds,
    ).not.toHaveBeenCalled();
  });

  it('returns effective permission metadata instead of stale configured values', async () => {
    effectivePermissionService.getClientSpaceCeilings.mockResolvedValueOnce({
      actorAvailable: true,
      actorReason: null,
      spaces: [
        {
          spaceId: permission.spaceId,
          actorRole: 'reader',
          reason: 'read_only',
          permissions: {
            canSearch: true,
            canSemanticSearch: true,
            canRead: true,
            canCreate: false,
            canUpdate: false,
            canAppend: false,
            canDelete: false,
            canRestore: false,
            canIndex: true,
          },
        },
      ],
    });

    await expect(
      service.getEffectiveSpacePermission(client, permission.spaceId),
    ).resolves.toMatchObject({
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canIndex: true,
    });
  });

  it('returns no effective metadata when no configured permission exists', async () => {
    query.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      service.getEffectiveSpacePermission(client, 'space-missing'),
    ).resolves.toBeUndefined();
    expect(
      effectivePermissionService.getClientSpaceCeilings,
    ).not.toHaveBeenCalled();
  });

  it('masks missing, cross-workspace, and normally deleted pages', async () => {
    query.executeTakeFirst.mockResolvedValueOnce(undefined);
    await expect(service.resolvePageTarget(client, page.id)).rejects.toThrow(
      NotFoundException,
    );

    query.executeTakeFirst.mockResolvedValueOnce({
      ...page,
      workspaceId: 'workspace-2',
    });
    await expect(service.resolvePageTarget(client, page.id)).rejects.toThrow(
      NotFoundException,
    );

    query.executeTakeFirst.mockResolvedValueOnce({
      ...page,
      deletedAt: new Date(),
    });
    await expect(service.resolvePageTarget(client, page.id)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('allows explicitly requested soft-deleted page resolution', async () => {
    const deletedPage = { ...page, deletedAt: new Date() };
    query.executeTakeFirst.mockResolvedValueOnce(deletedPage);

    await expect(
      service.resolvePageTarget(client, page.id, { includeDeleted: true }),
    ).resolves.toBe(deletedPage);
  });

  it('can mask page permission denial as not found without leaking scope', async () => {
    query.executeTakeFirst
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(permission);

    await expect(
      service.assertPagePermission(client, 'update', page.id, {
        maskPermissionDeniedAsNotFound: true,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns an allowed page and preserves unmasked permission errors', async () => {
    query.executeTakeFirst
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(permission);
    await expect(
      service.assertPagePermission(client, 'read', page.id),
    ).resolves.toBe(page);

    query.executeTakeFirst
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(permission);
    await expect(
      service.assertPagePermission(client, 'update', page.id),
    ).rejects.toThrow(ForbiddenException);
  });
});
