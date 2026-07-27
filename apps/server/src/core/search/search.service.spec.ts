import { SearchService } from './search.service';
import { SearchResponseDto } from './dto/search-response.dto';

describe('SearchService', () => {
  let service: SearchService;
  const dependency = {} as never;
  const environmentService = {
    isVectorSearchEnabled: jest.fn(() => true),
    getVectorHybridKeywordWeight: jest.fn(() => 0.25),
    getVectorHybridSemanticWeight: jest.fn(() => 0.65),
    getVectorHybridRecencyWeight: jest.fn(() => 0.1),
  } as never;
  const pageTreeScopeService = {
    resolveReadableSubtree: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (environmentService as any).isVectorSearchEnabled.mockReturnValue(true);
    (environmentService as any).getVectorHybridKeywordWeight.mockReturnValue(
      0.25,
    );
    (environmentService as any).getVectorHybridSemanticWeight.mockReturnValue(
      0.65,
    );
    (environmentService as any).getVectorHybridRecencyWeight.mockReturnValue(
      0.1,
    );
    service = new SearchService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      environmentService,
      dependency,
      pageTreeScopeService as never,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(SearchService);
  });

  it('falls back to keyword results when vectors are disabled', async () => {
    (environmentService as any).isVectorSearchEnabled.mockReturnValue(false);
    jest.spyOn(service, 'searchPage').mockResolvedValue({
      items: [searchResult('keyword-page', 0.7)],
    });

    const result = await service.searchAdvanced(
      { query: 'runbook', mode: 'hybrid' },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    expect(result.fallback).toBe('keyword');
    expect(result.semanticAvailable).toBe(false);
    expect(result.items[0].source).toBe('keyword');
  });

  it('deduplicates hybrid results and keeps semantic-only matches', () => {
    const keyword = [searchResult('shared-page', 0.8)];
    const semantic = [
      searchResult('shared-page', 0.9, 'semantic'),
      searchResult('semantic-page', 0.7, 'semantic'),
    ];

    const result = (service as any).mergeSearchResults(
      keyword,
      semantic,
      25,
    ) as SearchResponseDto[];

    expect(result.map((item) => item.id).sort()).toEqual([
      'semantic-page',
      'shared-page',
    ]);
    expect(result.find((item) => item.id === 'shared-page')?.source).toBe(
      'hybrid',
    );
    expect(result.find((item) => item.id === 'semantic-page')?.source).toBe(
      'semantic',
    );
  });

  it('keeps earlier hybrid pages stable when the candidate prefix grows', () => {
    const keyword = ['J', 'I', 'K', 'C', 'L', 'G'].map((id, index) =>
      searchResult(id, 1 - index / 10),
    );
    const semantic = ['F', 'G', 'H', 'B', 'A', 'C'].map((id, index) =>
      searchResult(id, 1 - index / 10, 'semantic'),
    );

    const firstPage = (service as any).mergeSearchResults(
      keyword.slice(0, 3),
      semantic.slice(0, 3),
      3,
    ) as SearchResponseDto[];
    const firstTwoPages = (service as any).mergeSearchResults(
      keyword,
      semantic,
      6,
    ) as SearchResponseDto[];
    const secondPage = firstTwoPages.slice(3, 6);

    expect(firstTwoPages.slice(0, 3).map((item) => item.id)).toEqual(
      firstPage.map((item) => item.id),
    );
    const firstPageIds = new Set(firstPage.map((item) => item.id));
    expect(secondPage.some((item) => firstPageIds.has(item.id))).toBe(false);
  });

  it('keeps the configured recency component in stable hybrid ranking', () => {
    (environmentService as any).getVectorHybridKeywordWeight.mockReturnValue(0);
    (environmentService as any).getVectorHybridSemanticWeight.mockReturnValue(
      0,
    );
    (environmentService as any).getVectorHybridRecencyWeight.mockReturnValue(1);
    const oldPage = searchResult('old-page', 1);
    oldPage.updatedAt = new Date('2020-01-01T00:00:00Z');
    const recentPage = searchResult('recent-page', 0.5);
    recentPage.updatedAt = new Date();

    const result = (service as any).mergeSearchResults(
      [oldPage, recentPage],
      [],
      2,
    ) as SearchResponseDto[];

    expect(result.map((item) => item.id)).toEqual(['recent-page', 'old-page']);
    expect(result[0].scores?.final).toBeGreaterThan(
      result[1].scores?.final ?? 0,
    );
  });

  it('uses one readable directory scope for keyword and semantic search', async () => {
    const rootPageId = '11111111-1111-4111-8111-111111111111';
    const scopedPageIds = [rootPageId, '22222222-2222-4222-8222-222222222222'];
    (
      pageTreeScopeService.resolveReadableSubtree as jest.Mock
    ).mockResolvedValue({
      spaceId: 'space-id',
      pageIds: scopedPageIds,
    });
    const keywordSearch = jest.spyOn(service, 'searchPage').mockResolvedValue({
      items: [searchResult(rootPageId, 0.7)],
    });
    const semanticSearch = jest
      .spyOn(service as never, 'semanticSearchPage' as never)
      .mockResolvedValue([searchResult(rootPageId, 0.8, 'semantic')] as never);

    await service.searchAdvanced(
      {
        query: 'runbook',
        mode: 'hybrid',
        rootPageId,
        spaceId: '33333333-3333-4333-8333-333333333333',
      },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    expect(pageTreeScopeService.resolveReadableSubtree).toHaveBeenCalledTimes(
      1,
    );
    expect(keywordSearch).toHaveBeenCalledWith(
      expect.objectContaining({ rootPageId }),
      expect.objectContaining({ scopedPageIds }),
    );
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ rootPageId }),
      expect.objectContaining({ scopedPageIds }),
    );
  });

  it('logs semantic failures before falling back to keyword results', async () => {
    const logger = (service as any).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    jest.spyOn(service, 'searchPage').mockResolvedValue({
      items: [searchResult('keyword-page', 0.7)],
    });
    jest
      .spyOn(service as never, 'semanticSearchPage' as never)
      .mockRejectedValue(new Error('embedding provider unavailable') as never);

    const result = await service.searchAdvanced(
      { query: 'runbook', mode: 'hybrid' },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    expect(result.fallback).toBe('keyword');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'search.semantic_fallback',
        errorType: 'Error',
      }),
    );
  });

  it('applies page permissions before keyword pagination', async () => {
    const query = createQueryBuilder([]);
    const permissionPredicate = { permission: 'readable' };
    const db = { selectFrom: jest.fn(() => query) };
    const pageRepo = { withSpace: jest.fn() };
    const pagePermissionRepo = {
      getAccessiblePagePredicate: jest.fn(() => permissionPredicate),
      filterAccessiblePageIds: jest.fn(),
    };
    const scopedService = new SearchService(
      db as never,
      pageRepo as never,
      dependency,
      dependency,
      pagePermissionRepo as never,
      environmentService,
      dependency,
      pageTreeScopeService as never,
    );

    await scopedService.searchPage(
      {
        query: 'permission boundary',
        spaceId: 'space-id',
        limit: 5,
        offset: 2,
      },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    const permissionCallIndex = query.where.mock.calls.findIndex(
      ([value]) => value === permissionPredicate,
    );
    expect(permissionCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      query.where.mock.invocationCallOrder[permissionCallIndex],
    ).toBeLessThan(query.limit.mock.invocationCallOrder[0]);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('uses exact scoped vector search with creator and offset filters', async () => {
    const bestChunks = { alias: 'bestChunks' };
    const chunkThresholdQuery = createQueryBuilder();
    chunkThresholdQuery.executeTakeFirst.mockResolvedValue(undefined);
    const exactQuery = createQueryBuilder([]);
    exactQuery.as.mockReturnValue(bestChunks);
    const outerQuery = createQueryBuilder([semanticRow('page-1', 0.91)]);
    let chunkQueryCount = 0;
    const db = {
      selectFrom: jest.fn((source) => {
        if (source === bestChunks) return outerQuery;
        if (source === 'docmostMcpChunks as chunks') {
          chunkQueryCount += 1;
          return chunkQueryCount === 1 ? chunkThresholdQuery : exactQuery;
        }
        return exactQuery;
      }),
    };
    const permissionPredicate = { permission: 'readable' };
    const pagePermissionRepo = {
      getAccessiblePagePredicate: jest.fn(() => permissionPredicate),
    };
    const semanticEnvironment = {
      isVectorSearchEnabled: jest.fn(() => true),
      getVectorHybridKeywordWeight: jest.fn(() => 0.25),
      getVectorHybridSemanticWeight: jest.fn(() => 0.65),
      getVectorHybridRecencyWeight: jest.fn(() => 0.1),
      getEmbeddingModel: jest.fn(() => 'embedding-model'),
      getVectorExactChunkThreshold: jest.fn(() => 4000),
    };
    const embeddingService = {
      createEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    const scopeService = {
      resolveReadableSubtree: jest.fn().mockResolvedValue({
        spaceId: 'space-id',
        pageIds: ['page-1', 'page-2'],
      }),
    };
    const exactService = new SearchService(
      db as never,
      { withSpace: jest.fn() } as never,
      dependency,
      dependency,
      pagePermissionRepo as never,
      semanticEnvironment as never,
      embeddingService as never,
      scopeService as never,
    );

    const result = await (exactService as any).semanticSearchPage(
      {
        query: 'scoped runbook',
        spaceId: 'space-id',
        rootPageId: '11111111-1111-4111-8111-111111111111',
        creatorId: 'creator-id',
        limit: 2,
        offset: 3,
      },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    expect(exactQuery.distinctOn).toHaveBeenCalledWith('chunks.pageId');
    expect(exactQuery.where).toHaveBeenCalledWith(
      'pages.creatorId',
      '=',
      'creator-id',
    );
    expect(exactQuery.where).toHaveBeenCalledWith(permissionPredicate);
    expect(chunkThresholdQuery.where).toHaveBeenCalledWith(
      'chunks.embeddingModel',
      '=',
      'embedding-model',
    );
    expect(chunkThresholdQuery.offset).toHaveBeenCalledWith(4000);
    expect(outerQuery.limit).toHaveBeenCalledWith(2);
    expect(outerQuery.offset).toHaveBeenCalledWith(3);
    expect(result).toHaveLength(1);
  });

  it.each([
    [4000, true],
    [4001, false],
  ])(
    'selects exact vector search by active chunk count (%i => %s)',
    async (chunkCount, expected) => {
      const thresholdQuery = createQueryBuilder();
      thresholdQuery.executeTakeFirst.mockResolvedValue(
        chunkCount > 4000 ? { id: 'overflow-chunk' } : undefined,
      );
      const db = { selectFrom: jest.fn(() => thresholdQuery) };
      const chunkService = new SearchService(
        db as never,
        dependency,
        dependency,
        dependency,
        dependency,
        {
          getEmbeddingModel: jest.fn(() => 'embedding-model'),
          getVectorExactChunkThreshold: jest.fn(() => 4000),
        } as never,
        dependency,
        pageTreeScopeService as never,
      );

      await expect(
        (chunkService as any).shouldUseExactVectorSearch('workspace-id', [
          '11111111-1111-4111-8111-111111111111',
        ]),
      ).resolves.toBe(expected);
      expect(thresholdQuery.where).toHaveBeenCalledWith(
        'chunks.workspaceId',
        '=',
        'workspace-id',
      );
      expect(thresholdQuery.where).toHaveBeenCalledWith(
        'chunks.deletedAt',
        'is',
        null,
      );
      expect(thresholdQuery.limit).toHaveBeenCalledWith(1);
      expect(thresholdQuery.offset).toHaveBeenCalledWith(4000);
    },
  );

  it('expands ANN candidates until enough unique pages are recalled', async () => {
    const firstCandidates = Array.from({ length: 200 }, () =>
      semanticRow('page-1', 0.9),
    );
    const secondCandidates = [
      semanticRow('page-1', 0.9),
      semanticRow('page-2', 0.8),
    ];
    const annQuery = createQueryBuilder();
    annQuery.execute
      .mockResolvedValueOnce(firstCandidates)
      .mockResolvedValueOnce(secondCandidates);
    const db = { selectFrom: jest.fn(() => annQuery) };
    const semanticEnvironment = {
      isVectorSearchEnabled: jest.fn(() => true),
      getVectorHybridKeywordWeight: jest.fn(() => 0.25),
      getVectorHybridSemanticWeight: jest.fn(() => 0.65),
      getVectorHybridRecencyWeight: jest.fn(() => 0.1),
      getEmbeddingModel: jest.fn(() => 'embedding-model'),
      getVectorExactChunkThreshold: jest.fn(() => 4000),
      getVectorAnnCandidateMultiplier: jest.fn(() => 2),
      getVectorAnnMaxCandidates: jest.fn(() => 400),
    };
    const annService = new SearchService(
      db as never,
      { withSpace: jest.fn() } as never,
      dependency,
      dependency,
      {
        getAccessiblePagePredicate: jest.fn(() => ({
          permission: 'readable',
        })),
      } as never,
      semanticEnvironment as never,
      {
        createEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      } as never,
      pageTreeScopeService as never,
    );
    jest
      .spyOn(annService as never, 'withHnswIterativeScan' as never)
      .mockImplementation((async (
        callback: (trx: unknown) => Promise<unknown>,
      ) => callback(db)) as never);

    const result = await (annService as any).semanticSearchPage(
      {
        query: 'global runbook',
        spaceId: 'space-id',
        limit: 2,
      },
      { userId: 'user-id', workspaceId: 'workspace-id' },
    );

    expect(annQuery.distinctOn).not.toHaveBeenCalled();
    expect((annService as any).withHnswIterativeScan).toHaveBeenCalledTimes(1);
    expect(annQuery.limit).toHaveBeenNthCalledWith(1, 200);
    expect(annQuery.limit).toHaveBeenNthCalledWith(2, 400);
    expect(result.map((item: SearchResponseDto) => item.id)).toEqual([
      'page-1',
      'page-2',
    ]);
  });
});

function createQueryBuilder(rows: unknown[] = []) {
  const query = {
    select: jest.fn(),
    selectAll: jest.fn(),
    innerJoin: jest.fn(),
    distinctOn: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    as: jest.fn(),
    $if: jest.fn(),
    execute: jest.fn().mockResolvedValue(rows),
    executeTakeFirst: jest.fn().mockResolvedValue(rows[0]),
  };

  for (const method of [
    'select',
    'selectAll',
    'innerJoin',
    'distinctOn',
    'where',
    'orderBy',
    'limit',
    'offset',
    'as',
  ] as const) {
    query[method].mockReturnValue(query);
  }
  query.$if.mockImplementation(
    (condition: boolean, callback: (builder: typeof query) => typeof query) =>
      condition ? callback(query) : query,
  );

  return query;
}

function semanticRow(id: string, rank: number) {
  return {
    id,
    slugId: id,
    title: id,
    icon: '',
    parentPageId: null,
    creatorId: 'creator-id',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    rank,
    highlight: `${id} content`,
    breadcrumbs: [],
    space: { id: 'space-id' },
  };
}

function searchResult(
  id: string,
  rank: number,
  source: SearchResponseDto['source'] = 'keyword',
): SearchResponseDto {
  return {
    id,
    title: id,
    icon: '',
    parentPageId: null,
    creatorId: 'user-id',
    rank,
    highlight: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    space: { id: 'space-id' },
    breadcrumbs: [],
    source,
  };
}
