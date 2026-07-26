import { useQuery, UseQueryResult } from "@tanstack/react-query";
import {
  searchPagesAdvanced,
  searchAttachments,
} from "@/features/search/services/search-service";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchParams,
  IAdvancedPageSearchResponse,
  SearchMode,
} from "@/features/search/types/search.types";
import { useHasFeature } from "@/oss/hooks/use-feature";
import { Feature } from "@/oss/features";

export type UnifiedSearchResult = IPageSearch | IAttachmentSearch;

export interface UseUnifiedSearchParams extends IPageSearchParams {
  contentType?: string;
  mode?: SearchMode;
}

export interface UnifiedSearchData {
  items: UnifiedSearchResult[];
  mode?: SearchMode;
  semanticAvailable?: boolean;
  fallback?: "keyword";
}

export function useUnifiedSearch(
  params: UseUnifiedSearchParams,
  enabled: boolean = true,
): UseQueryResult<UnifiedSearchData, Error> {
  const hasAttachmentIndexing = useHasFeature(Feature.ATTACHMENT_INDEXING);

  const isAttachmentSearch =
    params.contentType === "attachment" && hasAttachmentIndexing;
  const searchType = isAttachmentSearch ? "attachment" : "page";

  return useQuery({
    queryKey: ["unified-search", searchType, params],
    queryFn: async () => {
      // Remove contentType from backend params since it's only used for frontend routing
      const { contentType: _contentType, mode, ...backendParams } = params;

      if (isAttachmentSearch) {
        return {
          items: await searchAttachments(backendParams),
        };
      } else {
        return (await searchPagesAdvanced({
          ...backendParams,
          mode: mode ?? "hybrid",
        })) satisfies IAdvancedPageSearchResponse;
      }
    },
    enabled: !!params.query && enabled,
  });
}
