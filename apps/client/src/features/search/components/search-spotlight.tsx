import { Spotlight } from "@mantine/spotlight";
import {
  IconClock,
  IconInfoCircle,
  IconSearch,
  IconSparkles,
} from "@tabler/icons-react";
import {
  Group,
  Button,
  Center,
  Skeleton,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import React, { useState, useMemo, useEffect } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { searchSpotlightStore } from "../constants.ts";
import { SearchSpotlightFilters } from "./search-spotlight-filters.tsx";
import { useUnifiedSearch } from "../hooks/use-unified-search.ts";
import { useAiSearch } from "@/oss/ai/hooks/use-ai-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";
import { AiSearchResult } from "@/oss/ai/components/ai-search-result.tsx";
import { useHasFeature } from "@/oss/hooks/use-feature";
import { Feature } from "@/oss/features";
import { useRecentChangesQuery } from "@/features/page/queries/page-query.ts";
import { buildPageUrl, getPageTitle } from "@/features/page/page.utils.ts";
import { getPageIcon } from "@/lib";
import { Link } from "react-router-dom";
import classes from "./search-spotlight.module.css";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import {
  getRecentlyOpenedPages,
  READING_CONTINUITY_EVENT,
  RecentPageRecord,
} from "@/features/page/utils/reading-continuity.ts";
import { SearchMode } from "@/features/search/types/search.types.ts";
import { IPage } from "@/features/page/types/page.types.ts";

interface SearchSpotlightProps {
  spaceId?: string;
  currentPage?: IPage;
}
export function SearchSpotlight({
  spaceId,
  currentPage,
}: SearchSpotlightProps) {
  const { t } = useTranslation();
  const hasAiFeature = useHasFeature(Feature.AI);
  const hasAttachmentIndexing = useHasFeature(Feature.ATTACHMENT_INDEXING);
  const workspace = useAtomValue(workspaceAtom);
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<{
    spaceId?: string | null;
    contentType?: string;
    searchMode?: SearchMode;
    rootPageId?: string;
    rootPageTitle?: string;
  }>({
    contentType: "page",
    searchMode: "hybrid",
  });
  const [isAiMode, setIsAiMode] = useState(false);
  const [recentlyOpenedPages, setRecentlyOpenedPages] = useState<
    RecentPageRecord[]
  >([]);

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "page", // Only used for frontend routing
      mode: filters.searchMode ?? "hybrid",
    };

    // Handle space filtering - only pass spaceId if a specific space is selected
    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }
    if (!isAiMode && filters.contentType === "page" && filters.rootPageId) {
      params.rootPageId = filters.rootPageId;
    }

    return params;
  }, [debouncedSearchQuery, filters, isAiMode]);

  const {
    data: searchData,
    isLoading,
    isFetching,
    isError,
  } = useUnifiedSearch(
    searchParams,
    !isAiMode, // Disable regular search when in AI mode
  );
  const searchResults = searchData?.items ?? [];
  const {
    //@ts-ignore
    data: aiSearchResult,
    //@ts-ignore
    isPending: isAiLoading,
    //@ts-ignore
    mutate: triggerAiSearchMutation,
    //@ts-ignore
    reset: resetAiMutation,
    //@ts-ignore
    error: aiSearchError,
    streamingAnswer,
    streamingSources,
    clearStreaming,
  } = useAiSearch();

  // Clear streaming state and mutation data when query changes (user is typing a new query)
  useEffect(() => {
    clearStreaming();
    resetAiMutation();
  }, [query, clearStreaming, resetAiMutation]);

  // Show error notification when AI search fails
  useEffect(() => {
    if (aiSearchError) {
      notifications.show({
        message:
          aiSearchError.message || t("AI search failed. Please try again."),
        color: "red",
        position: "top-center",
      });
    }
  }, [aiSearchError, t]);

  // Determine result type for rendering
  const isAttachmentSearch =
    filters.contentType === "attachment" && hasAttachmentIndexing;
  const { data: recentPagesData, isLoading: isRecentPagesLoading } =
    useRecentChangesQuery(filters.spaceId ?? undefined);
  const recentPages =
    recentPagesData?.pages.flatMap((page) => page.items).slice(0, 6) ?? [];
  useEffect(() => {
    const refreshRecentlyOpened = () => {
      setRecentlyOpenedPages(
        workspace?.id
          ? getRecentlyOpenedPages(
              workspace.id,
              filters.spaceId ?? undefined,
              6,
            )
          : [],
      );
    };

    refreshRecentlyOpened();
    window.addEventListener(READING_CONTINUITY_EVENT, refreshRecentlyOpened);
    window.addEventListener("storage", refreshRecentlyOpened);
    return () => {
      window.removeEventListener(
        READING_CONTINUITY_EVENT,
        refreshRecentlyOpened,
      );
      window.removeEventListener("storage", refreshRecentlyOpened);
    };
  }, [filters.spaceId, workspace?.id]);
  const recentDisplayPages =
    recentlyOpenedPages.length > 0 ? recentlyOpenedPages : recentPages;

  const isDebouncing =
    query.trim().length > 0 && query !== debouncedSearchQuery;
  const isSearchPending =
    !isAiMode && query.trim().length > 0 && (isDebouncing || isFetching);

  const resultItems = searchResults.map((result, index) => (
    <SearchResultItem
      key={result.id}
      result={result}
      isAttachmentResult={isAttachmentSearch}
      showSpace={!filters.spaceId}
      animationIndex={index}
      isRefreshing={isSearchPending}
    />
  ));

  const handleFiltersChange = (newFilters: any) => {
    setFilters(newFilters);
  };

  const handleAskClick = () => {
    setIsAiMode(!isAiMode);
  };

  const handleAiSearchTrigger = () => {
    if (query.trim() && isAiMode) {
      triggerAiSearchMutation(searchParams);
    }
  };

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        store={searchSpotlightStore}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.42,
          blur: 2,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={isAiMode ? t("Ask a question...") : t("Search...")}
            aria-label={isAiMode ? t("Ask a question...") : t("Search")}
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                isAiMode &&
                query.trim() &&
                !isAiLoading
              ) {
                e.preventDefault();
                handleAiSearchTrigger();
              }
            }}
          />
          {isAiMode && hasAiFeature && (
            <Button
              size="xs"
              leftSection={<IconSparkles size={16} />}
              onClick={handleAiSearchTrigger}
              disabled={!query.trim()}
              loading={isAiLoading}
            >
              Ask
            </Button>
          )}
        </Group>

        <div
          style={{
            padding: "4px 16px",
          }}
        >
          <SearchSpotlightFilters
            onFiltersChange={handleFiltersChange}
            onAskClick={handleAskClick}
            spaceId={spaceId}
            currentPage={currentPage}
            isAiMode={isAiMode}
          />
        </div>

        <VisuallyHidden role="status" aria-live="polite">
          {isAiMode
            ? query.length > 0 && !isAiLoading && !aiSearchResult
              ? t("No answer available")
              : ""
            : isSearchPending
              ? t("Searching...")
              : query.length > 0 && !isLoading
                ? resultItems.length === 0
                  ? t("No results found")
                  : t("{{count}} results found", { count: resultItems.length })
                : ""}
        </VisuallyHidden>

        {!isAiMode &&
          query.length > 0 &&
          searchData?.fallback === "keyword" && (
            <div className={classes.searchFallback} role="status">
              <IconInfoCircle size={14} />
              <Text size="xs">
                {t(
                  "Semantic search is temporarily unavailable. Showing keyword results.",
                )}
              </Text>
            </div>
          )}

        <Spotlight.ActionsList aria-busy={!isAiMode && isSearchPending}>
          {isAiMode ? (
            <>
              {query.length === 0 && (
                <Spotlight.Empty>{t("Ask a question...")}</Spotlight.Empty>
              )}
              {query.length > 0 &&
                (isAiLoading || aiSearchResult || streamingAnswer) && (
                  <AiSearchResult
                    result={aiSearchResult}
                    isLoading={isAiLoading}
                    streamingAnswer={streamingAnswer}
                    streamingSources={streamingSources}
                  />
                )}
              {query.length > 0 && !isAiLoading && !aiSearchResult && (
                <Spotlight.Empty>{t("No answer available")}</Spotlight.Empty>
              )}
            </>
          ) : (
            <>
              {query.length === 0 &&
                filters.contentType === "page" &&
                resultItems.length === 0 && (
                  <RecentPages
                    pages={recentDisplayPages}
                    isLoading={isRecentPagesLoading}
                    isRecentlyOpened={recentlyOpenedPages.length > 0}
                  />
                )}

              {query.length === 0 &&
                filters.contentType !== "page" &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>
                    {t("Start typing to search...")}
                  </Spotlight.Empty>
                )}

              {query.length > 0 && isError && !isSearchPending && (
                <Spotlight.Empty>
                  {t("Search is temporarily unavailable. Please try again.")}
                </Spotlight.Empty>
              )}

              {!isError && isSearchPending && resultItems.length === 0 && (
                <SearchLoadingRows label={t("Searching...")} />
              )}

              {!isError &&
                query.length > 0 &&
                !isSearchPending &&
                !isLoading &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
                )}

              {resultItems.length > 0 && <>{resultItems}</>}
            </>
          )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}

function RecentPages({
  pages,
  isLoading,
  isRecentlyOpened,
}: {
  pages: Array<{
    id: string;
    slugId: string;
    title: string;
    icon: string;
    isBase: boolean;
    space: { slug?: string; name?: string };
  }>;
  isLoading: boolean;
  isRecentlyOpened: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading && pages.length === 0) {
    return <SearchLoadingRows label={t("Loading recent pages...")} />;
  }

  if (pages.length === 0) {
    return (
      <div className={classes.emptyState}>
        <IconClock size={22} stroke={1.6} />
        <Text size="sm" fw={600}>
          {t("No recently updated pages")}
        </Text>
      </div>
    );
  }

  return (
    <section className={classes.recentSection} aria-labelledby="recent-pages">
      <Text
        id="recent-pages"
        className={classes.sectionLabel}
        size="xs"
        fw={600}
        c="dimmed"
      >
        {isRecentlyOpened ? t("Recently opened") : t("Recently updated")}
      </Text>
      {pages.map((page, index) => (
        <Spotlight.Action
          key={page.id}
          component={Link}
          //@ts-ignore
          to={buildPageUrl(page.space.slug, page.slugId, page.title)}
          className={classes.resultItem}
          style={
            {
              "--search-result-index": Math.min(index, 8),
            } as React.CSSProperties
          }
        >
          <Group wrap="nowrap" w="100%">
            <Center>{getPageIcon(page.icon)}</Center>
            <div className={classes.resultContent}>
              <Text className={classes.resultTitle} lineClamp={1}>
                {getPageTitle(page.title, page.isBase, t)}
              </Text>
              {page.space.name && (
                <Text size="xs" c="dimmed" className={classes.resultPath}>
                  {page.space.name}
                </Text>
              )}
            </div>
          </Group>
        </Spotlight.Action>
      ))}
    </section>
  );
}

function SearchLoadingRows({ label }: { label: string }) {
  return (
    <div className={classes.loadingRows} aria-label={label} aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div className={classes.loadingRow} key={row}>
          <Skeleton circle height={24} />
          <div className={classes.loadingText}>
            <Skeleton height={12} width={`${72 - row * 8}%`} radius="sm" />
            <Skeleton height={9} width={`${46 + row * 6}%`} radius="sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
