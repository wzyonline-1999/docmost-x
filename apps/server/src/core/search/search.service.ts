import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AdvancedSearchDTO,
  SearchDTO,
  SearchMode,
  SearchSuggestionDTO,
} from './dto/search.dto';
import {
  AdvancedSearchResponseDto,
  SearchBreadcrumbDto,
  SearchResponseDto,
} from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { McpEmbeddingService } from '../mcp/services/mcp-embedding.service';
import { formatPgVector } from '../mcp/utils/mcp-vector-sql.util';
import { PageTreeScopeService } from '../page/services/page-tree-scope.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

type SearchOptions = {
  userId?: string;
  workspaceId: string;
  scopedPageIds?: string[];
};

function searchBreadcrumbsSelection() {
  return sql<SearchBreadcrumbDto[]>`
    COALESCE(
      (
        WITH RECURSIVE search_ancestors AS (
          SELECT
            parent.id,
            parent.slug_id,
            parent.title,
            parent.is_base,
            parent.parent_page_id,
            1 AS depth
          FROM pages AS parent
          WHERE parent.id = pages.parent_page_id
            AND parent.deleted_at IS NULL

          UNION ALL

          SELECT
            parent.id,
            parent.slug_id,
            parent.title,
            parent.is_base,
            parent.parent_page_id,
            search_ancestors.depth + 1
          FROM pages AS parent
          INNER JOIN search_ancestors
            ON search_ancestors.parent_page_id = parent.id
          WHERE parent.deleted_at IS NULL
        )
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', id,
            'slugId', slug_id,
            'title', title,
            'isBase', is_base
          )
          ORDER BY depth DESC
        )
        FROM search_ancestors
      ),
      '[]'::jsonb
    )
  `.as('breadcrumbs');
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private environmentService: EnvironmentService,
    private embeddingService: McpEmbeddingService,
    private pageTreeScopeService: PageTreeScopeService,
  ) {}

  async searchPage(
    searchParams: SearchDTO,
    opts: SearchOptions,
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;

    if (query.length < 1) {
      return { items: [] };
    }
    const searchQuery = tsquery(query.trim() + '*');
    const scopedPageIds =
      opts.scopedPageIds ??
      (await this.resolveScopedPageIds(searchParams, opts));

    if (scopedPageIds?.length === 0) {
      return { items: [] };
    }

    let queryResults = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
          'rank',
        ),
        sql<string>`ts_headline('english', text_content, to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        ),
        searchBreadcrumbsSelection(),
      ])
      .where(
        'tsv',
        '@@',
        sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .$if(scopedPageIds !== undefined, (qb) =>
        qb.where(sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`),
      )
      .$if(Boolean(opts.userId), (qb) =>
        qb.where(
          this.pagePermissionRepo.getAccessiblePagePredicate(
            opts.userId as string,
            'pages.id',
          ),
        ),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .limit(searchParams.limit || 25)
      .offset(searchParams.offset || 0);

    if (!searchParams.shareId) {
      queryResults = queryResults.select((eb) => this.pageRepo.withSpace(eb));
    }

    if (searchParams.spaceId) {
      // search by spaceId
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.userId && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.userId) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [] };
      }

      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) {
        return { items: [] };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList =
          await this.pageRepo.getPageAndDescendantsExcludingRestricted(
            share.pageId,
            {
              includeContent: false,
            },
          );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    //@ts-ignore
    let results: any[] = await queryResults.execute();

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && scopedPageIds === undefined && results.length > 0) {
      const pageIds = results.map((r: any) => r.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      results = results.filter((r: any) => accessibleSet.has(r.id));
    }

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      if (result.highlight) {
        result.highlight = result.highlight
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result;
    });

    return { items: searchResults };
  }

  async searchAdvanced(
    searchParams: AdvancedSearchDTO,
    opts: {
      userId: string;
      workspaceId: string;
    },
  ): Promise<AdvancedSearchResponseDto> {
    const mode: SearchMode = searchParams.mode ?? 'hybrid';
    const semanticAvailable = this.environmentService.isVectorSearchEnabled();
    const scopedPageIds = await this.resolveScopedPageIds(searchParams, opts);
    const scopedOptions = { ...opts, scopedPageIds };
    const requestedLimit = Math.min(Math.max(searchParams.limit ?? 25, 1), 100);
    const requestedOffset = Math.max(searchParams.offset ?? 0, 0);

    if (mode === 'keyword') {
      const keyword = await this.searchPage(searchParams, scopedOptions);
      return {
        items: keyword.items.map((item) => ({
          ...item,
          source: 'keyword',
        })),
        mode,
        semanticAvailable,
      };
    }

    if (mode === 'semantic') {
      if (!semanticAvailable) {
        throw new ServiceUnavailableException('Semantic search is disabled');
      }

      return {
        items: await this.semanticSearchPage(searchParams, scopedOptions),
        mode,
        semanticAvailable: true,
      };
    }

    const hybridParams: AdvancedSearchDTO = {
      ...searchParams,
      limit: requestedLimit + requestedOffset,
      offset: 0,
    };
    const keywordPromise = this.searchPage(hybridParams, scopedOptions);
    if (!semanticAvailable) {
      const keyword = await keywordPromise;
      return {
        items: keyword.items
          .slice(requestedOffset, requestedOffset + requestedLimit)
          .map((item) => ({
            ...item,
            source: 'keyword',
          })),
        mode,
        semanticAvailable: false,
        fallback: 'keyword',
      };
    }

    const [keyword, semanticResult] = await Promise.all([
      keywordPromise,
      this.semanticSearchPage(hybridParams, scopedOptions)
        .then((items) => ({ items }))
        .catch((err) => {
          this.logger.warn({
            event: 'search.semantic_fallback',
            errorType: err instanceof Error ? err.name : typeof err,
          });
          return null;
        }),
    ]);

    if (semanticResult) {
      return {
        items: this.mergeSearchResults(
          keyword.items,
          semanticResult.items,
          requestedLimit + requestedOffset,
        ).slice(requestedOffset, requestedOffset + requestedLimit),
        mode,
        semanticAvailable: true,
      };
    }

    return {
      items: keyword.items
        .slice(requestedOffset, requestedOffset + requestedLimit)
        .map((item) => ({
          ...item,
          source: 'keyword',
        })),
      mode,
      semanticAvailable: false,
      fallback: 'keyword',
    };
  }

  private async semanticSearchPage(
    searchParams: AdvancedSearchDTO,
    opts: SearchOptions & { userId: string },
  ): Promise<SearchResponseDto[]> {
    const query = searchParams.query.trim();
    if (!query) return [];

    const scopedPageIds =
      opts.scopedPageIds ??
      (await this.resolveScopedPageIds(searchParams, opts));
    if (scopedPageIds?.length === 0) return [];

    const spaceIds = searchParams.spaceId
      ? [searchParams.spaceId]
      : await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
    if (spaceIds.length === 0) return [];

    const [embedding] = await this.embeddingService.createEmbeddings([query]);
    const vector = formatPgVector(embedding);
    const distance = sql<number>`chunks.embedding <=> ${vector}::vector`;
    const limit = Math.min(Math.max(searchParams.limit ?? 25, 1), 1000);
    const offset = Math.max(searchParams.offset ?? 0, 0);
    const mapRows = (
      rows: Array<{
        id: string;
        slugId: string;
        title: string | null;
        icon: string | null;
        parentPageId: string | null;
        creatorId: string | null;
        createdAt: Date;
        updatedAt: Date;
        rank: number;
        highlight: string | null;
        breadcrumbs: SearchBreadcrumbDto[];
        space: SearchResponseDto['space'];
      }>,
    ): SearchResponseDto[] =>
      rows.map((row) => {
        const semanticScore = Number(row.rank);
        return {
          ...row,
          title: row.title ?? '',
          icon: row.icon ?? '',
          highlight: this.normalizeSemanticHighlight(row.highlight),
          source: 'semantic' as const,
          scores: {
            semantic: semanticScore,
            final: semanticScore,
          },
        };
      });

    if (this.shouldUseExactVectorSearch(scopedPageIds)) {
      const bestChunks = this.db
        .selectFrom('docmostMcpChunks as chunks')
        .innerJoin('pages', (join) =>
          join
            .onRef('pages.id', '=', 'chunks.pageId')
            .onRef('pages.workspaceId', '=', 'chunks.workspaceId'),
        )
        .select([
          'chunks.pageId',
          'chunks.content',
          sql<number>`1 - (${distance})`.as('score'),
        ])
        .distinctOn('chunks.pageId')
        .where('chunks.workspaceId', '=', opts.workspaceId)
        .where('pages.workspaceId', '=', opts.workspaceId)
        .where('pages.spaceId', 'in', spaceIds)
        .$if(Boolean(searchParams.creatorId), (qb) =>
          qb.where('pages.creatorId', '=', searchParams.creatorId),
        )
        .$if(scopedPageIds !== undefined, (qb) =>
          qb.where(sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`),
        )
        .where(
          this.pagePermissionRepo.getAccessiblePagePredicate(
            opts.userId,
            'pages.id',
          ),
        )
        .where('pages.deletedAt', 'is', null)
        .where(
          'chunks.embeddingModel',
          '=',
          this.environmentService.getEmbeddingModel(),
        )
        .where('chunks.deletedAt', 'is', null)
        .orderBy('chunks.pageId', 'asc')
        .orderBy(distance, 'asc')
        .orderBy('chunks.chunkIndex', 'asc')
        .as('bestChunks');

      const rows = await this.db
        .selectFrom(bestChunks)
        .innerJoin('pages', 'pages.id', 'bestChunks.pageId')
        .select([
          'pages.id',
          'pages.slugId',
          'pages.title',
          'pages.icon',
          'pages.parentPageId',
          'pages.creatorId',
          'pages.createdAt',
          'pages.updatedAt',
          'bestChunks.score as rank',
          'bestChunks.content as highlight',
          searchBreadcrumbsSelection(),
        ])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where('pages.workspaceId', '=', opts.workspaceId)
        .where('pages.spaceId', 'in', spaceIds)
        .where('pages.deletedAt', 'is', null)
        .orderBy('bestChunks.score', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      return mapRows(rows);
    }

    const targetCount = limit + offset;
    const maxCandidates = Math.max(
      targetCount,
      this.getVectorAnnMaxCandidates(),
    );
    let candidateLimit = this.getVectorAnnCandidateLimit(targetCount);
    let dedupedRows: Parameters<typeof mapRows>[0] = [];

    while (true) {
      const rows = await this.db
        .selectFrom('docmostMcpChunks as chunks')
        .innerJoin('pages', (join) =>
          join
            .onRef('pages.id', '=', 'chunks.pageId')
            .onRef('pages.workspaceId', '=', 'chunks.workspaceId'),
        )
        .select([
          'pages.id',
          'pages.slugId',
          'pages.title',
          'pages.icon',
          'pages.parentPageId',
          'pages.creatorId',
          'pages.createdAt',
          'pages.updatedAt',
          'chunks.content as highlight',
          sql<number>`1 - (${distance})`.as('rank'),
          searchBreadcrumbsSelection(),
        ])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where('chunks.workspaceId', '=', opts.workspaceId)
        .where('pages.workspaceId', '=', opts.workspaceId)
        .where('pages.spaceId', 'in', spaceIds)
        .$if(Boolean(searchParams.creatorId), (qb) =>
          qb.where('pages.creatorId', '=', searchParams.creatorId),
        )
        .$if(scopedPageIds !== undefined, (qb) =>
          qb.where(sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`),
        )
        .where(
          this.pagePermissionRepo.getAccessiblePagePredicate(
            opts.userId,
            'pages.id',
          ),
        )
        .where('pages.deletedAt', 'is', null)
        .where(
          'chunks.embeddingModel',
          '=',
          this.environmentService.getEmbeddingModel(),
        )
        .where('chunks.deletedAt', 'is', null)
        .orderBy(distance, 'asc')
        .limit(candidateLimit)
        .execute();

      const byPageId = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!byPageId.has(row.id)) {
          byPageId.set(row.id, row);
        }
      }
      dedupedRows = [...byPageId.values()].sort(
        (left, right) => Number(right.rank) - Number(left.rank),
      );

      if (
        dedupedRows.length >= targetCount ||
        rows.length < candidateLimit ||
        candidateLimit >= maxCandidates
      ) {
        break;
      }
      candidateLimit = Math.min(maxCandidates, candidateLimit * 2);
    }

    return mapRows(dedupedRows.slice(offset, offset + limit));
  }

  private async resolveScopedPageIds(
    searchParams: SearchDTO,
    opts: SearchOptions,
  ): Promise<string[] | undefined> {
    if (!searchParams.rootPageId || !opts.userId || searchParams.shareId) {
      return undefined;
    }

    const allowedSpaceIds = searchParams.spaceId
      ? [searchParams.spaceId]
      : await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
    const scope = await this.pageTreeScopeService.resolveReadableSubtree({
      rootPageId: searchParams.rootPageId,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      allowedSpaceIds,
    });

    return scope.pageIds;
  }

  private shouldUseExactVectorSearch(scopedPageIds?: string[]): boolean {
    const threshold = Math.max(
      1,
      this.environmentService.getVectorExactPageThreshold?.() ?? 400,
    );
    return scopedPageIds !== undefined && scopedPageIds.length <= threshold;
  }

  private getVectorAnnMaxCandidates(): number {
    return Math.max(
      100,
      this.environmentService.getVectorAnnMaxCandidates?.() ?? 5000,
    );
  }

  private getVectorAnnCandidateLimit(resultCount: number): number {
    const multiplier = Math.max(
      2,
      this.environmentService.getVectorAnnCandidateMultiplier?.() ?? 24,
    );
    return Math.min(
      Math.max(resultCount, this.getVectorAnnMaxCandidates()),
      Math.max(200, resultCount * multiplier),
    );
  }

  private normalizeSemanticHighlight(content: string | null): string {
    return (content ?? '')
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 420);
  }

  private mergeSearchResults(
    keywordItems: SearchResponseDto[],
    semanticItems: SearchResponseDto[],
    requestedLimit: number,
  ): SearchResponseDto[] {
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
    const normalizedKeyword = this.normalizeScores(keywordItems);
    const normalizedSemantic = this.normalizeScores(semanticItems);
    const keywordIds = new Set(keywordItems.map((item) => item.id));
    const semanticIds = new Set(semanticItems.map((item) => item.id));
    const byPageId = new Map<string, SearchResponseDto>();

    for (const item of keywordItems) {
      byPageId.set(item.id, { ...item, source: 'keyword' });
    }
    for (const item of semanticItems) {
      const existing = byPageId.get(item.id);
      if (existing) {
        existing.source = 'hybrid';
        existing.scores = {
          ...existing.scores,
          semantic: Number(item.rank),
          final: 0,
        };
      } else {
        byPageId.set(item.id, { ...item, source: 'semantic' });
      }
    }

    const weights = this.getHybridWeights();
    for (const item of byPageId.values()) {
      const keywordScore = normalizedKeyword.get(item.id) ?? 0;
      const semanticScore = normalizedSemantic.get(item.id) ?? 0;
      const recencyScore = this.getRecencyScore(item.updatedAt);
      const final =
        keywordScore * weights.keyword +
        semanticScore * weights.semantic +
        recencyScore * weights.recency;
      item.source =
        keywordIds.has(item.id) && semanticIds.has(item.id)
          ? 'hybrid'
          : semanticIds.has(item.id)
            ? 'semantic'
            : 'keyword';
      item.scores = {
        keyword: keywordScore,
        semantic: semanticScore,
        recency: recencyScore,
        final,
      };
      item.rank = final;
    }

    return [...byPageId.values()]
      .sort((left, right) => Number(right.rank) - Number(left.rank))
      .slice(0, limit);
  }

  private normalizeScores(items: SearchResponseDto[]): Map<string, number> {
    const finiteScores = items
      .map((item) => Number(item.rank))
      .filter(Number.isFinite);
    if (finiteScores.length === 0) return new Map();

    const minimum = Math.min(...finiteScores);
    const maximum = Math.max(...finiteScores);
    return new Map(
      items.flatMap((item) => {
        const score = Number(item.rank);
        if (!Number.isFinite(score)) return [];
        return [
          [
            item.id,
            maximum === minimum ? 1 : (score - minimum) / (maximum - minimum),
          ],
        ];
      }),
    );
  }

  private getHybridWeights(): {
    keyword: number;
    semantic: number;
    recency: number;
  } {
    const configured = {
      keyword: Math.max(
        0,
        this.environmentService.getVectorHybridKeywordWeight(),
      ),
      semantic: Math.max(
        0,
        this.environmentService.getVectorHybridSemanticWeight(),
      ),
      recency: Math.max(
        0,
        this.environmentService.getVectorHybridRecencyWeight(),
      ),
    };
    const total = configured.keyword + configured.semantic + configured.recency;
    if (!Number.isFinite(total) || total <= 0) {
      return { keyword: 0.25, semantic: 0.65, recency: 0.1 };
    }
    return {
      keyword: configured.keyword / total,
      semantic: configured.semantic / total,
      recency: configured.recency / total,
    };
  }

  private getRecencyScore(updatedAt: Date): number {
    const timestamp = new Date(updatedAt).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    const ageInDays = Math.max(0, Date.now() - timestamp) / 86_400_000;
    return Math.exp(-ageInDays / 90);
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .where(
          this.pagePermissionRepo.getAccessiblePagePredicate(
            userId,
            'pages.id',
          ),
        )
        .limit(limit);

      // search all spaces the user has access to, prioritizing the current space
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      // Filter by page-level permissions
      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
