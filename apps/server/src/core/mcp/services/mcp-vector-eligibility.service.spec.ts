import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import type { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { McpVectorEligibilityService } from './mcp-vector-eligibility.service';

describe('McpVectorEligibilityService', () => {
  const pageExecute = jest.fn();
  const candidateExecute = jest.fn();
  const pageQuery = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: pageExecute,
  };
  const candidateQuery = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: candidateExecute,
  };
  const db = {
    selectFrom: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(),
  };
  const spaceMemberRepo = {
    getUserSpaceIds: jest.fn(),
  };

  let service: McpVectorEligibilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    db.selectFrom
      .mockReturnValueOnce(pageQuery)
      .mockReturnValueOnce(candidateQuery);
    pageExecute.mockResolvedValue([
      { id: 'page-1', spaceId: 'space-1' },
      { id: 'page-2', spaceId: 'space-1' },
    ]);
    candidateExecute.mockResolvedValue([
      { actorUserId: 'actor-1', spaceId: 'space-1' },
    ]);
    spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue(['page-1']);
    service = new McpVectorEligibilityService(
      db as unknown as KyselyDB,
      pagePermissionRepo as unknown as PagePermissionRepo,
      spaceMemberRepo as unknown as SpaceMemberRepo,
    );
  });

  it('short-circuits an empty page set', async () => {
    await expect(
      service.evaluatePageIds({ workspaceId: 'workspace-1', pageIds: [] }),
    ).resolves.toEqual({ eligiblePageIds: [], ineligiblePageIds: [] });
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('requires both an active index policy and native page access', async () => {
    await expect(
      service.evaluatePageIds({
        workspaceId: 'workspace-1',
        pageIds: ['page-1', 'page-2', 'page-1'],
      }),
    ).resolves.toEqual({
      eligiblePageIds: ['page-1'],
      ineligiblePageIds: ['page-2'],
    });

    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith('actor-1');
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-1', 'page-2'],
      userId: 'actor-1',
      spaceId: 'space-1',
    });
    expect(candidateQuery.where).toHaveBeenCalledWith(
      'permissions.canIndex',
      '=',
      true,
    );
    expect(candidateQuery.where).toHaveBeenCalledWith(
      'clients.status',
      '=',
      'active',
    );
    expect(candidateQuery.where).toHaveBeenCalledWith(
      'actors.deactivatedAt',
      'is',
      null,
    );
  });

  it('rejects actors that are no longer members of the target space', async () => {
    spaceMemberRepo.getUserSpaceIds.mockResolvedValueOnce([]);

    await expect(
      service.evaluatePageIds({
        workspaceId: 'workspace-1',
        pageIds: ['page-1', 'page-2'],
      }),
    ).resolves.toEqual({
      eligiblePageIds: [],
      ineligiblePageIds: ['page-1', 'page-2'],
    });
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('accepts a page when any eligible actor can read it', async () => {
    candidateExecute.mockResolvedValueOnce([
      { actorUserId: 'actor-1', spaceId: 'space-1' },
      { actorUserId: 'actor-2', spaceId: 'space-1' },
    ]);
    spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    pagePermissionRepo.filterAccessiblePageIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['page-2']);

    await expect(
      service.evaluatePageIds({
        workspaceId: 'workspace-1',
        pageIds: ['page-1', 'page-2'],
      }),
    ).resolves.toEqual({
      eligiblePageIds: ['page-2'],
      ineligiblePageIds: ['page-1'],
    });
  });

  it('treats missing or deleted pages as ineligible', async () => {
    pageExecute.mockResolvedValueOnce([]);

    await expect(
      service.isPageEligible('workspace-1', 'missing-page'),
    ).resolves.toBe(false);
    expect(candidateExecute).not.toHaveBeenCalled();
  });
});
