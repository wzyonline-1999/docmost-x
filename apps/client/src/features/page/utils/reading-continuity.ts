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

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecentPageRecord(value: unknown): value is RecentPageRecord {
  if (!value || typeof value !== "object") return false;

  const page = value as Partial<RecentPageRecord>;
  const space = page.space;
  return (
    typeof page.id === "string" &&
    Boolean(page.id) &&
    typeof page.slugId === "string" &&
    Boolean(page.slugId) &&
    typeof page.title === "string" &&
    typeof page.icon === "string" &&
    typeof page.isBase === "boolean" &&
    typeof page.openedAt === "number" &&
    Number.isFinite(page.openedAt) &&
    typeof page.scrollY === "number" &&
    Number.isFinite(page.scrollY) &&
    Boolean(space) &&
    typeof space === "object" &&
    isOptionalString(space.id) &&
    isOptionalString(space.name) &&
    isOptionalString(space.slug)
  );
}

function readStore(workspaceId: string): ReadingContinuityStore {
  const storage = getStorage();
  if (!storage || !workspaceId) return emptyStore();

  try {
    const parsed = JSON.parse(
      storage.getItem(storageKey(workspaceId)) ?? "{}",
    ) as Partial<ReadingContinuityStore>;
    const rawPages =
      parsed.pages && typeof parsed.pages === "object" ? parsed.pages : {};
    const pages = Object.fromEntries(
      Object.entries(rawPages).filter(
        ([pageId, page]) => isRecentPageRecord(page) && page.id === pageId,
      ),
    );
    const recentPageIds = Array.isArray(parsed.recentPageIds)
      ? [
          ...new Set(
            parsed.recentPageIds.filter(
              (pageId): pageId is string =>
                typeof pageId === "string" && Boolean(pages[pageId]),
            ),
          ),
        ].slice(0, MAX_RECENT_PAGES)
      : [];

    return { pages, recentPageIds };
  } catch {
    return emptyStore();
  }
}

function writeStore(
  workspaceId: string,
  store: ReadingContinuityStore,
): boolean {
  const storage = getStorage();
  if (!storage || !workspaceId) return false;

  try {
    storage.setItem(storageKey(workspaceId), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function recordRecentlyOpenedPage(page: IPage): void {
  if (!page.id || !page.slugId || !page.workspaceId) return;

  const store = readStore(page.workspaceId);
  const recentPageIds = [
    page.id,
    ...store.recentPageIds.filter((pageId) => pageId !== page.id),
  ].slice(0, MAX_RECENT_PAGES);
  const retainedPageIds = new Set(recentPageIds);
  const pages = Object.fromEntries(
    Object.entries(store.pages).filter(([pageId]) =>
      retainedPageIds.has(pageId),
    ),
  );

  pages[page.id] = {
    id: page.id,
    slugId: page.slugId,
    title: typeof page.title === "string" ? page.title : "",
    icon: typeof page.icon === "string" ? page.icon : "",
    isBase: Boolean(page.isBase),
    openedAt: Date.now(),
    scrollY:
      typeof window !== "undefined" && Number.isFinite(window.scrollY)
        ? window.scrollY
        : 0,
    space: {
      id: page.space?.id ?? page.spaceId,
      name: page.space?.name,
      slug: page.space?.slug,
    },
  };

  if (writeStore(page.workspaceId, { pages, recentPageIds })) {
    window.dispatchEvent(new Event(READING_CONTINUITY_EVENT));
  }
}

export function getRecentlyOpenedPages(
  workspaceId: string,
  spaceId?: string | null,
  limit = 6,
): RecentPageRecord[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 6;
  const store = readStore(workspaceId);
  return store.recentPageIds
    .map((pageId) => store.pages[pageId])
    .filter(
      (page): page is RecentPageRecord =>
        Boolean(page) && (!spaceId || page.space.id === spaceId),
    )
    .slice(0, normalizedLimit);
}
