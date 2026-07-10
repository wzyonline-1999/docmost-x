import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type {
  McpAuthenticatedClient,
  McpPermissionAction,
} from '../types/mcp.types';
import { McpPermissionService } from './mcp-permission.service';

describe('McpPermissionService', () => {
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    status: 'active',
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
  let service: McpPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    query.execute.mockResolvedValue([{ spaceId: permission.spaceId }]);
    query.executeTakeFirst.mockResolvedValue(permission);
    service = new McpPermissionService(db as unknown as KyselyDB);
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

  it('returns the permission row when the requested action is allowed', async () => {
    await expect(
      service.assertSpacePermission(client, 'read', permission.spaceId),
    ).resolves.toBe(permission);
  });

  it('intersects requested spaces with active action permissions', async () => {
    await expect(
      service.getAllowedSpaceIds(client, 'search', ['space-1', 'space-2']),
    ).resolves.toEqual(['space-1']);

    expect(query.where).toHaveBeenCalledWith('canSearch', '=', true);
    expect(query.where).toHaveBeenCalledWith('spaceId', 'in', [
      'space-1',
      'space-2',
    ]);
  });

  it('does not add an empty requested-space filter', async () => {
    await service.getAllowedSpaceIds(client, 'index', []);

    expect(query.where).toHaveBeenCalledWith('canIndex', '=', true);
    expect(query.where).not.toHaveBeenCalledWith('spaceId', 'in', []);
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
