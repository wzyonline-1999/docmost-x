import React from "react";
import {
  Group,
  Center,
  Text,
  ActionIcon,
  Tooltip,
  getDefaultZIndex,
} from "@mantine/core";
import { Spotlight } from "@mantine/spotlight";
import { Link } from "react-router-dom";
import { IconFile, IconDownload } from "@tabler/icons-react";
import { buildPageUrl, getPageTitle } from "@/features/page/page.utils";
import { getPageIcon } from "@/lib";
import {
  IAttachmentSearch,
  IPageSearch,
} from "@/features/search/types/search.types";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import { buildPageSearchPath } from "@/features/search/utils/search-result-utils";
import classes from "./search-spotlight.module.css";

interface SearchResultItemProps {
  result: IPageSearch | IAttachmentSearch;
  isAttachmentResult: boolean;
  showSpace?: boolean;
  animationIndex?: number;
  isRefreshing?: boolean;
}

export function SearchResultItem({
  result,
  isAttachmentResult,
  showSpace,
  animationIndex = 0,
  isRefreshing = false,
}: SearchResultItemProps) {
  const { t } = useTranslation();
  const motionStyle = {
    userSelect: "none",
    "--search-result-index": Math.min(animationIndex, 8),
  } as React.CSSProperties;

  if (isAttachmentResult) {
    const attachmentResult = result as IAttachmentSearch;

    const handleDownload = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const downloadUrl = `/api/files/${attachmentResult.id}/${attachmentResult.fileName}`;
      window.open(downloadUrl, "_blank");
    };

    return (
      <Spotlight.Action
        component={Link}
        //@ts-ignore
        to={buildPageUrl(
          attachmentResult.space.slug,
          attachmentResult.page.slugId,
          attachmentResult.page.title,
        )}
        className={classes.resultItem}
        data-refreshing={isRefreshing || undefined}
        style={motionStyle}
      >
        <Group wrap="nowrap" w="100%">
          <Center>
            <IconFile size={16} />
          </Center>

          <div className={classes.resultContent}>
            <Text className={classes.resultTitle} lineClamp={1}>
              {attachmentResult.fileName}
            </Text>
            <Text size="xs" c="dimmed" className={classes.resultPath}>
              {attachmentResult.space.name} • {attachmentResult.page.title}
            </Text>

            {attachmentResult?.highlight && (
              <Text
                c="dimmed"
                size="xs"
                className={classes.resultSnippet}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(attachmentResult.highlight, {
                    ALLOWED_TAGS: ["mark", "em", "strong", "b"],
                    ALLOWED_ATTR: [],
                  }),
                }}
              />
            )}
          </div>

          <Tooltip
            label={t("Download attachment")}
            zIndex={getDefaultZIndex("max")}
            withArrow
          >
            <ActionIcon variant="subtle" color="gray" onClick={handleDownload}>
              <IconDownload size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Spotlight.Action>
    );
  } else {
    const pageResult = result as IPageSearch;
    const path = buildPageSearchPath(
      pageResult,
      Boolean(showSpace),
      (title, isBase) => getPageTitle(title, isBase, t),
    );

    return (
      <Spotlight.Action
        component={Link}
        //@ts-ignore
        to={buildPageUrl(
          pageResult.space.slug,
          pageResult.slugId,
          pageResult.title,
        )}
        className={classes.resultItem}
        data-refreshing={isRefreshing || undefined}
        style={motionStyle}
      >
        <Group wrap="nowrap" w="100%">
          <Center>{getPageIcon(pageResult?.icon)}</Center>

          <div className={classes.resultContent}>
            <Text className={classes.resultTitle} lineClamp={1}>
              {getPageTitle(pageResult.title, false, t)}
            </Text>

            {path.length > 0 && (
              <Text size="xs" c="dimmed" className={classes.resultPath}>
                {path.join(" / ")}
              </Text>
            )}

            {pageResult?.highlight && (
              <Text
                c="dimmed"
                size="xs"
                className={classes.resultSnippet}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(pageResult.highlight, {
                    ALLOWED_TAGS: ["mark", "em", "strong", "b"],
                    ALLOWED_ATTR: [],
                  }),
                }}
              />
            )}
          </div>
        </Group>
      </Spotlight.Action>
    );
  }
}
