import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { validate as isValidUuid } from 'uuid';

export type ReadablePageTreeScope = {
  spaceId: string;
  pageIds: string[];
};

@Injectable()
export class PageTreeScopeService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async resolveReadableSubtree(opts: {
    rootPageId: string;
    workspaceId: string;
    userId: string;
    allowedSpaceIds: string[];
  }): Promise<ReadablePageTreeScope> {
    if (!isValidUuid(opts.rootPageId)) {
      throw new BadRequestException('rootPageId must be a valid UUID');
    }

    const rootPage = await this.pageRepo.findById(opts.rootPageId);
    const allowedSpaceIds = new Set(opts.allowedSpaceIds);

    if (
      !rootPage ||
      rootPage.deletedAt ||
      rootPage.workspaceId !== opts.workspaceId ||
      !allowedSpaceIds.has(rootPage.spaceId)
    ) {
      throw new NotFoundException('Search root page not found');
    }

    const subtree = await this.pageRepo.getPageAndDescendants(opts.rootPageId, {
      includeContent: false,
    });
    const pageIds = subtree
      .filter(
        (page) =>
          page.workspaceId === opts.workspaceId &&
          page.spaceId === rootPage.spaceId,
      )
      .map((page) => page.id);
    const readablePageIds =
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds,
        userId: opts.userId,
        spaceId: rootPage.spaceId,
      });

    if (!readablePageIds.includes(rootPage.id)) {
      throw new NotFoundException('Search root page not found');
    }

    return {
      spaceId: rootPage.spaceId,
      pageIds: readablePageIds,
    };
  }
}
