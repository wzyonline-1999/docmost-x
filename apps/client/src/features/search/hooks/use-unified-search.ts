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
  const {
    contentType: _contentType,
    mode,
    rootPageId,
    ...backendParams
  } = params;
  const attachmentParams = backendParams;
  const pageParams = {
    ...backendParams,
    ...(rootPageId === undefined ? {} : { rootPageId }),
    mode: mode ?? "hybrid",
  };
  const queryParams = isAttachmentSearch ? attachmentParams : pageParams;

  return useQuery({
    queryKey: ["unified-search", searchType, queryParams],
    queryFn: async () => {
      if (isAttachmentSearch) {
        return {
          items: await searchAttachments(attachmentParams),
        };
      } else {
        return (await searchPagesAdvanced(
          pageParams,
        )) satisfies IAdvancedPageSearchResponse;
      }
    },
    enabled: !!params.query && enabled,
  });
}
