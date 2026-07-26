import type { IPage } from "@/features/page/types/page.types";

export const READING_CONTINUITY_EVENT = "docmost:reading-continuity-updated";
const STORAGE_PREFIX = "docmost.reading-continuity.v1";
const MAX_RECENT_PAGES = 50;

export interface RecentPageRecord {
  id: string;
  slugId: string;
  title: string;
  icon: string;
  isBase: boolean;
  openedAt: number;
  scrollY: number;
  space: {
    id?: string;
    name?: string;
    slug?: string;
  };
}

interface ReadingContinuityStore {
  pages: Record<string, RecentPageRecord>;
  recentPageIds: string[];
}

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}.${workspaceId}`;
}

function emptyStore(): ReadingContinuityStore {
  return { pages: {}, recentPageIds: [] };
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStore(workspaceId: string): ReadingContinuityStore {
  const storage = getStorage();
  if (!storage || !workspaceId) return emptyStore();

  try {
    const parsed = JSON.parse(
      storage.getItem(storageKey(workspaceId)) ?? "{}",
    ) as Partial<ReadingContinuityStore>;
    const pages =
      parsed.pages && typeof parsed.pages === "object" ? parsed.pages : {};
    const recentPageIds = Array.isArray(parsed.recentPageIds)
      ? parsed.recentPageIds.filter(
          (pageId): pageId is string =>
            typeof pageId === "string" && Boolean(pages[pageId]),
        )
      : [];

    return { pages, recentPageIds };
  } catch {
    return emptyStore();
  }
}

export function getRecentlyOpenedPages(
  workspaceId: string,
  spaceId?: string | null,
  limit = 6,
): RecentPageRecord[] {
  const store = readStore(workspaceId);
  return store.recentPageIds
    .map((pageId) => store.pages[pageId])
    .filter(
      (page): page is RecentPageRecord =>
        Boolean(page) && (!spaceId || page.space.id === spaceId),
    )
    .slice(0, limit);
}
