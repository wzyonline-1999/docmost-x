import { Injectable } from '@nestjs/common';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { Page, PageHistory } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { CursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { isDeepStrictEqual } from 'node:util';

@Injectable()
export class PageHistoryService {
  constructor(private pageHistoryRepo: PageHistoryRepo) {}

  async findById(historyId: string): Promise<PageHistory> {
    return await this.pageHistoryRepo.findById(historyId, {
      includeContent: true,
    });
  }

  async findHistoryByPageId(
    pageId: string,
    paginationOptions: PaginationOptions,
  ): Promise<CursorPaginationResult<PageHistory>> {
    return this.pageHistoryRepo.findPageHistoryByPageId(
      pageId,
      paginationOptions,
    );
  }

  async saveSnapshotIfChanged(
    page: Page,
    contributorIds: string[] = [],
  ): Promise<boolean> {
    const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
      page.id,
      { includeContent: true },
    );

    if (
      lastHistory &&
      lastHistory.title === page.title &&
      lastHistory.icon === page.icon &&
      lastHistory.coverPhoto === page.coverPhoto &&
      isDeepStrictEqual(lastHistory.content, page.content)
    ) {
      return false;
    }

    await this.pageHistoryRepo.saveHistory(page, { contributorIds });
    return true;
  }
}
