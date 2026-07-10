import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import type { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import type { User } from '@docmost/db/types/entity.types';
import type SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import type { PageAccessService } from '../../page/page-access/page-access.service';
import { McpActorAccessService } from './mcp-actor-access.service';

describe('McpActorAccessService', () => {
  const actor = {
    id: 'user-1',
    workspaceId: 'workspace-1',
    deactivatedAt: null,
    deletedAt: null,
  } as unknown as User;
  const executeTakeFirst = jest.fn();
  const userQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst,
  };
  const db = {
    selectFrom: jest.fn(() => userQuery),
  };
  const pageAccessService = {
    validateCanView: jest.fn(),
    validateCanEdit: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(),
  };
  const spaceAbility = {
    createForUser: jest.fn(),
  };
  const spaceMemberRepo = {
    getUserSpaceIds: jest.fn(),
  };

  let service: McpActorAccessService;

  beforeEach(() => {
    jest.clearAllMocks();
    executeTakeFirst.mockResolvedValue(actor);
    pageAccessService.validateCanView.mockResolvedValue(undefined);
    pageAccessService.validateCanEdit.mockResolvedValue({
      hasRestriction: false,
    });
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue(['page-1']);
    spaceAbility.createForUser.mockResolvedValue({
      cannot: jest.fn(() => false),
    });
    spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    service = new McpActorAccessService(
      db as unknown as KyselyDB,
      pageAccessService as unknown as PageAccessService,
      pagePermissionRepo as unknown as PagePermissionRepo,
      spaceAbility as unknown as SpaceAbilityFactory,
      spaceMemberRepo as unknown as SpaceMemberRepo,
    );
  });

  it('fails closed when the MCP client has no actor mapping', async () => {
    await expect(
      service.requireActor({
        actorUserId: null,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('loads only an active actor from the token workspace', async () => {
    await expect(
      service.requireActor({
        actorUserId: actor.id,
        workspaceId: actor.workspaceId,
      } as never),
    ).resolves.toBe(actor);
    expect(userQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      actor.workspaceId,
    );
    expect(userQuery.where).toHaveBeenCalledWith('deletedAt', 'is', null);
  });

  it('rejects an unavailable actor', async () => {
    executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      service.requireActor({
        actorUserId: actor.id,
        workspaceId: actor.workspaceId,
      } as never),
    ).rejects.toThrow('MCP actor user is unavailable');
  });

  it.each([
    { ...actor, deactivatedAt: new Date() },
    { ...actor, deletedAt: new Date() },
  ])('rejects a disabled actor row %p', async (unavailableActor) => {
    executeTakeFirst.mockResolvedValueOnce(unavailableActor);

    await expect(
      service.requireActor({
        actorUserId: actor.id,
        workspaceId: actor.workspaceId,
      } as never),
    ).rejects.toThrow('MCP actor user is unavailable');
  });

  it.each([
    ['read', () => service.assertCanReadSpace(actor, 'space-1')],
    ['create', () => service.assertCanCreateInSpace(actor, 'space-1')],
  ])(
    'enforces native %s permission in the target space',
    async (_action, check) => {
      spaceAbility.createForUser.mockResolvedValueOnce({
        cannot: jest.fn(() => true),
      });

      await expect(check()).rejects.toThrow('MCP actor lacks Docmost');
    },
  );

  it('masks missing native space membership as a permission denial', async () => {
    spaceAbility.createForUser.mockRejectedValueOnce(new NotFoundException());

    await expect(
      service.assertCanReadSpace(actor, 'space-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates allowed page view and edit checks to native access', async () => {
    const target = { id: 'page-1', spaceId: 'space-1' };

    await expect(
      service.assertCanViewPage(actor, target),
    ).resolves.toBeUndefined();
    await expect(
      service.assertCanEditPage(actor, target),
    ).resolves.toBeUndefined();
    expect(pageAccessService.validateCanView).toHaveBeenCalledWith(
      target,
      actor,
    );
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      target,
      actor,
    );
  });

  it('masks native page denials as not found', async () => {
    pageAccessService.validateCanView.mockRejectedValueOnce(
      new ForbiddenException(),
    );

    await expect(
      service.assertCanViewPage(actor, {
        id: 'page-1',
        spaceId: 'space-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('masks native edit denials as not found', async () => {
    pageAccessService.validateCanEdit.mockRejectedValueOnce(
      new ForbiddenException(),
    );

    await expect(
      service.assertCanEditPage(actor, {
        id: 'page-1',
        spaceId: 'space-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('intersects MCP spaces with the actor memberships', async () => {
    await expect(
      service.filterReadableSpaceIds(actor, ['space-1', 'space-2', 'space-1']),
    ).resolves.toEqual(['space-1']);
  });

  it('short-circuits an empty MCP space set', async () => {
    await expect(service.filterReadableSpaceIds(actor, [])).resolves.toEqual(
      [],
    );
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('delegates page restriction filtering to the native repository', async () => {
    await expect(
      service.filterReadablePageIds(
        actor,
        ['page-1', 'page-2', 'page-1'],
        'space-1',
      ),
    ).resolves.toEqual(['page-1']);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-1', 'page-2'],
      userId: actor.id,
      spaceId: 'space-1',
    });
  });
});
