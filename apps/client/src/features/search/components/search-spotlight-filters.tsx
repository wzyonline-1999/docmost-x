import React, { useState, useEffect } from "react";
import {
  Button,
  Menu,
  Text,
  Badge,
  Group,
  Switch,
  SegmentedControl,
  getDefaultZIndex,
  Popover,
  TextInput,
  Loader,
  ScrollArea,
  Divider,
} from "@mantine/core";
import {
  IconChevronDown,
  IconBuilding,
  IconFileDescription,
  IconCheck,
  IconFolderSearch,
  IconFolders,
  IconCurrentLocation,
  IconSearch,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useDebouncedValue } from "@mantine/hooks";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { SpaceFilterMenu } from "@/features/space/components/space-filter-menu";
import { RadioMenuItem } from "@/components/ui/radio-menu-item";
import { useHasFeature } from "@/oss/hooks/use-feature";
import { Feature } from "@/oss/features";
import classes from "./search-spotlight-filters.module.css";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { SearchMode } from "@/features/search/types/search.types.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query.ts";

interface SearchSpotlightFiltersProps {
  onFiltersChange?: (filters: any) => void;
  onAskClick?: () => void;
  spaceId?: string;
  currentPage?: IPage;
  isAiMode?: boolean;
}

export function SearchSpotlightFilters({
  onFiltersChange,
  onAskClick,
  spaceId,
  currentPage,
  isAiMode = false,
}: SearchSpotlightFiltersProps) {
  const { t } = useTranslation();
  const hasAttachmentIndexing = useHasFeature(Feature.ATTACHMENT_INDEXING);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(
    spaceId || null,
  );
  const [contentType, setContentType] = useState<string | null>("page");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [rootPageId, setRootPageId] = useState<string>();
  const [rootPageTitle, setRootPageTitle] = useState<string>();
  const [scopeOpened, setScopeOpened] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [debouncedDirectoryQuery] = useDebouncedValue(directoryQuery, 250);
  const [workspace] = useAtom(workspaceAtom);

  const {
    data: spacesData,
    isFetching: isSpacesFetching,
    isLoading: isSpacesLoading,
  } = useGetSpacesQuery({ limit: 100 });
  const selectedSpaceData = selectedSpaceId
    ? spacesData?.items.find((space) => space.id === selectedSpaceId)
    : null;
  const { data: directoryResults, isFetching: isDirectorySearchFetching } =
    useSearchSuggestionsQuery({
      query:
        debouncedDirectoryQuery.trim().length >= 2
          ? debouncedDirectoryQuery.trim()
          : "",
      includePages: true,
      limit: 20,
    });
  const directoryPages = (directoryResults?.pages ?? []).filter(
    (page): page is IPage => Boolean(page?.id),
  );

  useEffect(() => {
    if (onFiltersChange) {
      onFiltersChange({
        spaceId: selectedSpaceId,
        contentType,
        searchMode,
        rootPageId,
        rootPageTitle,
      });
    }
  }, []);

  const contentTypeOptions = [
    { value: "page", label: t("Pages") },
    {
      value: "attachment",
      label: t("Attachments"),
      disabled: !hasAttachmentIndexing,
    },
  ];

  const handleSpaceSelect = (spaceId: string | null) => {
    setSelectedSpaceId(spaceId);
    setRootPageId(undefined);
    setRootPageTitle(undefined);

    if (onFiltersChange) {
      onFiltersChange({
        spaceId: spaceId,
        contentType,
        searchMode,
        rootPageId: undefined,
        rootPageTitle: undefined,
      });
    }
  };

  const handleFilterChange = (filterType: string, value: any) => {
    let newSelectedSpaceId = selectedSpaceId;
    let newContentType = contentType;
    let newSearchMode = searchMode;

    switch (filterType) {
      case "spaceId":
        newSelectedSpaceId = value;
        setSelectedSpaceId(value);
        break;
      case "contentType":
        newContentType = value;
        setContentType(value);
        break;
      case "searchMode":
        newSearchMode = value;
        setSearchMode(value);
        break;
    }

    if (onFiltersChange) {
      onFiltersChange({
        spaceId: newSelectedSpaceId,
        contentType: newContentType,
        searchMode: newSearchMode,
        rootPageId,
        rootPageTitle,
      });
    }
  };

  const handleScopeSelect = (page?: Partial<IPage>) => {
    const nextRootPageId = page?.id;
    const nextRootPageTitle = page?.title || undefined;
    const nextSpaceId = page?.spaceId ?? page?.space?.id ?? selectedSpaceId;

    setRootPageId(nextRootPageId);
    setRootPageTitle(nextRootPageTitle);
    if (nextRootPageId && nextSpaceId) {
      setSelectedSpaceId(nextSpaceId);
    }
    setScopeOpened(false);
    setDirectoryQuery("");

    onFiltersChange?.({
      spaceId: nextRootPageId ? nextSpaceId : selectedSpaceId,
      contentType,
      searchMode,
      rootPageId: nextRootPageId,
      rootPageTitle: nextRootPageTitle,
    });
  };

  return (
    <div className={classes.filtersContainer}>
      {workspace?.settings?.ai?.search === true && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "32px",
            paddingLeft: "8px",
            paddingRight: "8px",
          }}
        >
          <Switch
            checked={isAiMode}
            onChange={(event) => onAskClick()}
            label={t("AI Answers")}
            size="sm"
            color="blue"
            labelPosition="left"
            styles={{
              root: { display: "flex", alignItems: "center" },
              label: { paddingRight: "8px", fontSize: "13px", fontWeight: 500 },
            }}
          />
        </div>
      )}

      <SpaceFilterMenu
        value={selectedSpaceId}
        onChange={handleSpaceSelect}
        position="bottom-start"
        width={250}
        zIndex={getDefaultZIndex("max")}
      >
        <Button
          variant="subtle"
          color="gray"
          size="sm"
          rightSection={<IconChevronDown size={14} />}
          leftSection={<IconBuilding size={16} />}
          className={classes.filterButton}
          fw={500}
        >
          {selectedSpaceId
            ? `${t("Space")}: ${
                selectedSpaceData?.name ||
                (isSpacesLoading || isSpacesFetching
                  ? t("Current space")
                  : t("Unknown"))
              }`
            : `${t("Space")}: ${t("All spaces")}`}
        </Button>
      </SpaceFilterMenu>

      <Popover
        opened={scopeOpened}
        onChange={setScopeOpened}
        position="bottom-start"
        width={340}
        shadow="md"
        trapFocus
        zIndex={getDefaultZIndex("max")}
      >
        <Popover.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconFolderSearch size={16} />}
            className={classes.filterButton}
            fw={500}
            onClick={() => setScopeOpened((opened) => !opened)}
          >
            {rootPageId
              ? `${t("Directory")}: ${rootPageTitle || t("Untitled")}`
              : `${t("Scope")}: ${t("Entire knowledge base")}`}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Button
            variant={!rootPageId ? "light" : "subtle"}
            color="gray"
            fullWidth
            justify="flex-start"
            leftSection={<IconFolders size={16} />}
            onClick={() => handleScopeSelect()}
          >
            {t("Entire knowledge base")}
          </Button>
          <Button
            mt={4}
            variant={rootPageId === currentPage?.id ? "light" : "subtle"}
            color="gray"
            fullWidth
            justify="flex-start"
            leftSection={<IconCurrentLocation size={16} />}
            disabled={!currentPage?.id}
            onClick={() => handleScopeSelect(currentPage)}
          >
            {t("Current directory")}
          </Button>

          <Divider my="sm" label={t("Choose directory")} />
          <TextInput
            value={directoryQuery}
            onChange={(event) => setDirectoryQuery(event.currentTarget.value)}
            placeholder={t("Search pages...")}
            aria-label={t("Choose directory")}
            leftSection={<IconSearch size={15} />}
            rightSection={
              isDirectorySearchFetching ? <Loader size={14} /> : undefined
            }
          />
          {directoryQuery.trim().length >= 2 && (
            <ScrollArea.Autosize mah={220} mt="xs" offsetScrollbars>
              {directoryPages.length > 0
                ? directoryPages.map((page) => (
                    <Button
                      key={page.id}
                      variant="subtle"
                      color="gray"
                      fullWidth
                      justify="flex-start"
                      leftSection={<IconFileDescription size={15} />}
                      onClick={() => handleScopeSelect(page)}
                    >
                      <div style={{ minWidth: 0, textAlign: "left" }}>
                        <Text size="sm" truncate>
                          {page.title || t("Untitled")}
                        </Text>
                        {page.space?.name && (
                          <Text size="xs" c="dimmed" truncate>
                            {page.space.name}
                          </Text>
                        )}
                      </div>
                    </Button>
                  ))
                : !isDirectorySearchFetching && (
                    <Text size="sm" c="dimmed" py="sm" ta="center">
                      {t("No pages found")}
                    </Text>
                  )}
            </ScrollArea.Autosize>
          )}
        </Popover.Dropdown>
      </Popover>

      <Menu
        shadow="md"
        width={220}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconFileDescription size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {contentType
              ? `${t("Type")}: ${contentTypeOptions.find((opt) => opt.value === contentType)?.label || t(contentType === "page" ? "Pages" : "Attachments")}`
              : t("Type")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {contentTypeOptions.map((option) => (
            <Menu.Item
              key={option.value}
              component={RadioMenuItem}
              aria-checked={contentType === option.value}
              onClick={() =>
                !option.disabled &&
                contentType !== option.value &&
                handleFilterChange("contentType", option.value)
              }
              disabled={
                option.disabled || (isAiMode && option.value === "attachment")
              }
            >
              <Group flex="1" gap="xs">
                <div>
                  <Text size="sm">{option.label}</Text>
                  {option.disabled && (
                    <Badge size="xs" mt={4}>
                      {t("Unavailable")}
                    </Badge>
                  )}
                  {!option.disabled &&
                    isAiMode &&
                    option.value === "attachment" && (
                      <Text size="xs" mt={4}>
                        {t("AI Answers not available for attachments")}
                      </Text>
                    )}
                </div>
                {contentType === option.value && (
                  <IconCheck size={20} aria-hidden />
                )}
              </Group>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      {contentType === "page" && !isAiMode && (
        <SegmentedControl
          size="xs"
          value={searchMode}
          onChange={(value) =>
            handleFilterChange("searchMode", value as SearchMode)
          }
          aria-label={t("Search mode")}
          className={classes.searchMode}
          data={[
            { value: "hybrid", label: t("Hybrid") },
            { value: "keyword", label: t("Keyword") },
            { value: "semantic", label: t("Semantic") },
          ]}
        />
      )}
    </div>
  );
}
