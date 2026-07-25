import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import type { User } from '@docmost/db/types/entity.types';
import type { PageAccessService } from '../../page/page-access/page-access.service';
import { McpActorAccessService } from './mcp-actor-access.service';
import type { McpEffectivePermissionService } from './mcp-effective-permission.service';

describe('McpActorAccessService', () => {
  const actor = {
    id: 'user-1',
    workspaceId: 'workspace-1',
    deactivatedAt: null,
    deletedAt: null,
  } as unknown as User;
  const pageAccessService = {
    validateCanView: jest.fn(),
    validateCanEdit: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(),
  };
  const effectivePermissionService = {
    requireActor: jest.fn(),
    assertActorAction: jest.fn(),
    filterActorSpaceIds: jest.fn(),
  };

  let service: McpActorAccessService;

  beforeEach(() => {
    jest.clearAllMocks();
    effectivePermissionService.requireActor.mockResolvedValue(actor);
    effectivePermissionService.assertActorAction.mockResolvedValue(undefined);
    effectivePermissionService.filterActorSpaceIds.mockResolvedValue([
      'space-1',
    ]);
    pageAccessService.validateCanView.mockResolvedValue(undefined);
    pageAccessService.validateCanEdit.mockResolvedValue({
      hasRestriction: false,
    });
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue(['page-1']);
    service = new McpActorAccessService(
      pageAccessService as unknown as PageAccessService,
      pagePermissionRepo as unknown as PagePermissionRepo,
      effectivePermissionService as unknown as McpEffectivePermissionService,
    );
  });

  it('fails closed when the MCP client has no actor mapping', async () => {
    effectivePermissionService.requireActor.mockRejectedValueOnce(
      new ForbiddenException('MCP page tools require an actor user mapping'),
    );

    await expect(
      service.requireActor({
        actorUserId: null,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(effectivePermissionService.requireActor).toHaveBeenCalledWith({
      actorUserId: null,
    });
  });

  it('delegates actor resolution to the effective permission service', async () => {
    const client = {
      actorUserId: actor.id,
      workspaceId: actor.workspaceId,
    } as never;

    await expect(service.requireActor(client)).resolves.toBe(actor);
    expect(effectivePermissionService.requireActor).toHaveBeenCalledWith(
      client,
    );
  });

  it('rejects an unavailable actor', async () => {
    effectivePermissionService.requireActor.mockRejectedValueOnce(
      new ForbiddenException('MCP actor user is unavailable'),
    );

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
      effectivePermissionService.assertActorAction.mockRejectedValueOnce(
        new ForbiddenException('MCP actor lacks Docmost space access'),
      );

      await expect(check()).rejects.toThrow('MCP actor lacks Docmost');
    },
  );

  it('masks missing native space membership as a permission denial', async () => {
    effectivePermissionService.assertActorAction.mockRejectedValueOnce(
      new ForbiddenException('MCP actor lacks Docmost space access'),
    );

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
    expect(effectivePermissionService.filterActorSpaceIds).toHaveBeenCalledWith(
      actor,
      'read',
      ['space-1', 'space-2'],
    );
  });

  it('short-circuits an empty MCP space set', async () => {
    await expect(service.filterReadableSpaceIds(actor, [])).resolves.toEqual(
      [],
    );
    expect(
      effectivePermissionService.filterActorSpaceIds,
    ).not.toHaveBeenCalled();
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
