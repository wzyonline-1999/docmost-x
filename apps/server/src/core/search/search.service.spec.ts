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
});

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
