import { ForbiddenException } from '@nestjs/common';
import type { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import type { User } from '@docmost/db/types/entity.types';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { McpEffectivePermissionService } from './mcp-effective-permission.service';

describe('McpEffectivePermissionService', () => {
  const actor = {
    id: 'actor-1',
    workspaceId: 'workspace-1',
    deactivatedAt: null,
    deletedAt: null,
  } as unknown as User;
  const client = {
    actorUserId: actor.id,
    workspaceId: actor.workspaceId,
  };
  const userQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
  };
  const db = {
    selectFrom: jest.fn(() => userQuery),
  };
  const spaceMemberRepo = {
    getUserRolesForSpaces: jest.fn(),
  };

  let service: McpEffectivePermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    userQuery.executeTakeFirst.mockResolvedValue(actor);
    spaceMemberRepo.getUserRolesForSpaces.mockResolvedValue([]);
    service = new McpEffectivePermissionService(
      db as unknown as KyselyDB,
      spaceMemberRepo as unknown as SpaceMemberRepo,
    );
  });

  it('fails closed for unmapped, missing, and disabled actors', async () => {
    await expect(
      service.getClientSpaceCeilings(
        { actorUserId: null, workspaceId: actor.workspaceId },
        ['space-1'],
      ),
    ).resolves.toMatchObject({
      actorAvailable: false,
      actorReason: 'actor_unmapped',
      spaces: [
        {
          spaceId: 'space-1',
          actorRole: null,
          reason: 'actor_unmapped',
        },
      ],
    });
    expect(db.selectFrom).not.toHaveBeenCalled();

    userQuery.executeTakeFirst.mockResolvedValueOnce(undefined);
    await expect(service.requireActor(client)).rejects.toThrow(
      'MCP actor user is unavailable',
    );

    userQuery.executeTakeFirst.mockResolvedValueOnce({
      ...actor,
      deactivatedAt: new Date(),
    });
    await expect(service.requireActor(client)).rejects.toThrow(
      'MCP actor user is unavailable',
    );
  });

  it('loads the actor only from the client workspace', async () => {
    await expect(service.requireActor(client)).resolves.toBe(actor);
    expect(userQuery.where).toHaveBeenCalledWith('id', '=', actor.id);
    expect(userQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      actor.workspaceId,
    );
    expect(userQuery.where).toHaveBeenCalledWith('deletedAt', 'is', null);
  });

  it('uses the highest direct or group role for each requested space', async () => {
    spaceMemberRepo.getUserRolesForSpaces.mockResolvedValueOnce([
      { spaceId: 'space-reader', role: 'reader' },
      { spaceId: 'space-writer', role: 'reader' },
      { spaceId: 'space-writer', role: 'writer' },
      { spaceId: 'space-admin', role: 'writer' },
      { spaceId: 'space-admin', role: 'admin' },
    ]);

    const result = await service.getActorSpaceCeilings(actor, [
      'space-reader',
      'space-writer',
      'space-admin',
      'space-none',
      'space-reader',
    ]);

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({
      actorRole: 'reader',
      reason: 'read_only',
      permissions: {
        canSearch: true,
        canSemanticSearch: true,
        canRead: true,
        canCreate: false,
        canIndex: true,
      },
    });
    expect(result[1]).toMatchObject({
      actorRole: 'writer',
      reason: null,
      permissions: {
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      },
    });
    expect(result[2]).toMatchObject({
      actorRole: 'admin',
      reason: null,
      permissions: {
        canCreate: true,
        canRestore: true,
      },
    });
    expect(result[3]).toMatchObject({
      actorRole: null,
      reason: 'no_space_access',
      permissions: {
        canSearch: false,
        canRead: false,
        canIndex: false,
      },
    });
  });

  it('applies role changes immediately when filtering runtime spaces', async () => {
    spaceMemberRepo.getUserRolesForSpaces.mockResolvedValueOnce([
      { spaceId: 'space-reader', role: 'reader' },
      { spaceId: 'space-writer', role: 'writer' },
    ]);

    await expect(
      service.filterClientSpaceIds(client, 'create', [
        'space-reader',
        'space-writer',
        'space-removed',
      ]),
    ).resolves.toEqual(['space-writer']);
  });

  it('rejects only newly enabled permissions above the native ceiling', () => {
    const readerCeiling = {
      ...service.emptyPermissions(),
      canSearch: true,
      canRead: true,
      canIndex: true,
    };

    expect(() =>
      service.assertPermissionPatchAllowed(readerCeiling, {
        canCreate: true,
      }),
    ).toThrow(ForbiddenException);

    expect(() =>
      service.assertPermissionPatchAllowed(
        readerCeiling,
        { canCreate: true, canRead: false },
        { canCreate: true, canRead: true },
      ),
    ).not.toThrow();

    expect(() =>
      service.assertPermissionPatchAllowed(
        readerCeiling,
        { canCreate: false },
        { canCreate: true },
      ),
    ).not.toThrow();
  });

  it('reports configured permissions separately from effective permissions', () => {
    const configured = {
      canSearch: true,
      canSemanticSearch: true,
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canAppend: false,
      canDelete: false,
      canRestore: false,
      canIndex: true,
    };
    const readerCeiling = {
      ...service.emptyPermissions(),
      canSearch: true,
      canSemanticSearch: true,
      canRead: true,
      canIndex: true,
    };

    expect(service.intersectPermissions(configured, readerCeiling)).toEqual({
      canSearch: true,
      canSemanticSearch: true,
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canAppend: false,
      canDelete: false,
      canRestore: false,
      canIndex: true,
    });
  });
});
