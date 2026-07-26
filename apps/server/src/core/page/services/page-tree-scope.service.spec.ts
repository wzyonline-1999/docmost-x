import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PageTreeScopeService } from './page-tree-scope.service';

describe('PageTreeScopeService', () => {
  const rootPageId = '11111111-1111-4111-8111-111111111111';
  const childPageId = '22222222-2222-4222-8222-222222222222';
  const restrictedPageId = '33333333-3333-4333-8333-333333333333';
  const spaceId = '44444444-4444-4444-8444-444444444444';
  const workspaceId = '55555555-5555-4555-8555-555555555555';
  const userId = '66666666-6666-4666-8666-666666666666';

  const pageRepo = {
    findById: jest.fn(),
    getPageAndDescendants: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(),
  };
  let service: PageTreeScopeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PageTreeScopeService(
      pageRepo as never,
      pagePermissionRepo as never,
    );
    pageRepo.findById.mockResolvedValue({
      id: rootPageId,
      spaceId,
      workspaceId,
      deletedAt: null,
    });
    pageRepo.getPageAndDescendants.mockResolvedValue([
      { id: rootPageId, spaceId, workspaceId },
      { id: childPageId, spaceId, workspaceId },
      { id: restrictedPageId, spaceId, workspaceId },
    ]);
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      rootPageId,
      childPageId,
    ]);
  });

  it('returns the readable root and descendants only', async () => {
    const result = await service.resolveReadableSubtree({
      rootPageId,
      workspaceId,
      userId,
      allowedSpaceIds: [spaceId],
    });

    expect(result).toEqual({
      spaceId,
      pageIds: [rootPageId, childPageId],
    });
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: [rootPageId, childPageId, restrictedPageId],
      userId,
      spaceId,
    });
  });

  it('does not cross workspace or space boundaries in a malformed tree', async () => {
    pageRepo.getPageAndDescendants.mockResolvedValue([
      { id: rootPageId, spaceId, workspaceId },
      {
        id: childPageId,
        spaceId: '77777777-7777-4777-8777-777777777777',
        workspaceId,
      },
      {
        id: restrictedPageId,
        spaceId,
        workspaceId: '88888888-8888-4888-8888-888888888888',
      },
    ]);
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([rootPageId]);

    await service.resolveReadableSubtree({
      rootPageId,
      workspaceId,
      userId,
      allowedSpaceIds: [spaceId],
    });

    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: [rootPageId],
      userId,
      spaceId,
    });
  });

  it('rejects a root outside the allowed space set without traversing it', async () => {
    await expect(
      service.resolveReadableSubtree({
        rootPageId,
        workspaceId,
        userId,
        allowedSpaceIds: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(pageRepo.getPageAndDescendants).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'deleted',
      root: {
        id: rootPageId,
        spaceId,
        workspaceId,
        deletedAt: new Date(),
      },
    },
    {
      name: 'from another workspace',
      root: {
        id: rootPageId,
        spaceId,
        workspaceId: '99999999-9999-4999-8999-999999999999',
        deletedAt: null,
      },
    },
  ])('rejects a $name root without traversing it', async ({ root }) => {
    pageRepo.findById.mockResolvedValue(root);

    await expect(
      service.resolveReadableSubtree({
        rootPageId,
        workspaceId,
        userId,
        allowedSpaceIds: [spaceId],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(pageRepo.getPageAndDescendants).not.toHaveBeenCalled();
  });

  it('rejects a root that is not readable by the actor', async () => {
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([childPageId]);

    await expect(
      service.resolveReadableSubtree({
        rootPageId,
        workspaceId,
        userId,
        allowedSpaceIds: [spaceId],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects invalid root page IDs before querying the database', async () => {
    await expect(
      service.resolveReadableSubtree({
        rootPageId: 'not-a-page-id',
        workspaceId,
        userId,
        allowedSpaceIds: [spaceId],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('handles a large readable subtree without changing its membership', async () => {
    const pages = Array.from({ length: 1_501 }, (_, index) => ({
      id:
        index === 0
          ? rootPageId
          : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      spaceId,
      workspaceId,
    }));
    pageRepo.getPageAndDescendants.mockResolvedValue(pages);
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue(
      pages.map((page) => page.id),
    );

    const result = await service.resolveReadableSubtree({
      rootPageId,
      workspaceId,
      userId,
      allowedSpaceIds: [spaceId],
    });

    expect(result.pageIds).toHaveLength(1_501);
  });
});
