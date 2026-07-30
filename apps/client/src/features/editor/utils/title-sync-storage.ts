const TITLE_SYNC_STORAGE_KEY = "docmost.pending-page-titles.v2";
const LEGACY_TITLE_SYNC_STORAGE_KEY = "docmost.pending-page-titles.v1";
const LEGACY_TITLE_SYNC_QUARANTINE_KEY =
  "docmost.pending-page-titles.legacy.v1";

export const TITLE_SYNC_REQUEST_EVENT = "docmost:title-sync-request";

const MAX_PENDING_TITLES = 100;
const MAX_RETRY_DELAY_MS = 60_000;

export interface TitleSyncScope {
  accountId: string;
  workspaceId: string;
}

export type PendingTitleStatus = "pending" | "blocked";

export interface PendingTitleUpdate extends TitleSyncScope {
  pageId: string;
  title: string;
  updatedAt: number;
  status: PendingTitleStatus;
  retryCount: number;
  nextRetryAt: number;
  lastHttpStatus?: number;
}

type PendingTitleStore = Record<string, PendingTitleUpdate>;

let memoryStore: PendingTitleStore = {};
let useMemoryFallback = false;

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function getEntryKey(scope: TitleSyncScope, pageId: string): string {
  return `${scope.accountId}:${scope.workspaceId}:${pageId}`;
}

function matchesScope(
  update: PendingTitleUpdate,
  scope: TitleSyncScope,
): boolean {
  return (
    update.accountId === scope.accountId &&
    update.workspaceId === scope.workspaceId
  );
}

function quarantineLegacyQueue(storage: Storage): void {
  try {
    const legacyQueue = storage.getItem(LEGACY_TITLE_SYNC_STORAGE_KEY);
    if (legacyQueue === null) return;

    if (storage.getItem(LEGACY_TITLE_SYNC_QUARANTINE_KEY) === null) {
      storage.setItem(
        LEGACY_TITLE_SYNC_QUARANTINE_KEY,
        JSON.stringify({
          quarantinedAt: Date.now(),
          entries: JSON.parse(legacyQueue),
        }),
      );
    }
    storage.removeItem(LEGACY_TITLE_SYNC_STORAGE_KEY);
  } catch {
    // A malformed or inaccessible legacy queue must never block v2 syncing.
    try {
      storage.removeItem(LEGACY_TITLE_SYNC_STORAGE_KEY);
    } catch {
      // Storage is unavailable; the in-memory v2 queue still remains usable.
    }
  }
}

function isPendingTitleUpdate(
  entryKey: string,
  value: unknown,
): value is PendingTitleUpdate {
  if (!value || typeof value !== "object") return false;

  const entry = value as Partial<PendingTitleUpdate>;
  return (
    entryKey ===
      getEntryKey(
        {
          accountId: entry.accountId ?? "",
          workspaceId: entry.workspaceId ?? "",
        },
        entry.pageId ?? "",
      ) &&
    typeof entry.accountId === "string" &&
    entry.accountId.length > 0 &&
    typeof entry.workspaceId === "string" &&
    entry.workspaceId.length > 0 &&
    typeof entry.pageId === "string" &&
    entry.pageId.length > 0 &&
    typeof entry.title === "string" &&
    Number.isFinite(entry.updatedAt) &&
    (entry.status === "pending" || entry.status === "blocked") &&
    Number.isInteger(entry.retryCount) &&
    (entry.retryCount ?? -1) >= 0 &&
    Number.isFinite(entry.nextRetryAt) &&
    (entry.lastHttpStatus === undefined ||
      Number.isInteger(entry.lastHttpStatus))
  );
}

function readStore(): PendingTitleStore {
  const storage = getStorage();
  if (!storage || useMemoryFallback) return { ...memoryStore };

  quarantineLegacyQueue(storage);

  try {
    const parsed = JSON.parse(
      storage.getItem(TITLE_SYNC_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;

    const nextStore: PendingTitleStore = {};
    for (const [entryKey, entry] of Object.entries(parsed)) {
      if (isPendingTitleUpdate(entryKey, entry)) {
        nextStore[entryKey] = entry;
      }
    }
    memoryStore = nextStore;
    return { ...memoryStore };
  } catch {
    memoryStore = {};
    try {
      storage.removeItem(TITLE_SYNC_STORAGE_KEY);
    } catch {
      useMemoryFallback = true;
    }
    return {};
  }
}

function writeStore(store: PendingTitleStore): void {
  memoryStore = { ...store };
  const storage = getStorage();
  if (!storage) return;

  quarantineLegacyQueue(storage);

  try {
    if (Object.keys(store).length === 0) {
      storage.removeItem(TITLE_SYNC_STORAGE_KEY);
      useMemoryFallback = false;
      return;
    }
    storage.setItem(TITLE_SYNC_STORAGE_KEY, JSON.stringify(store));
    useMemoryFallback = false;
  } catch {
    useMemoryFallback = true;
  }
}

export function getPendingTitle(
  scope: TitleSyncScope,
  pageId: string,
): PendingTitleUpdate | null {
  return readStore()[getEntryKey(scope, pageId)] ?? null;
}

export function getPendingTitleUpdates(
  scope: TitleSyncScope,
): PendingTitleUpdate[] {
  return Object.values(readStore())
    .filter((entry) => matchesScope(entry, scope))
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

export function getRetryablePendingTitleUpdates(
  scope: TitleSyncScope,
  now = Date.now(),
): PendingTitleUpdate[] {
  return getPendingTitleUpdates(scope).filter(
    (entry) => entry.status === "pending" && entry.nextRetryAt <= now,
  );
}

export function getNextPendingTitleRetryAt(
  scope: TitleSyncScope,
): number | null {
  const retryTimes = getPendingTitleUpdates(scope)
    .filter((entry) => entry.status === "pending")
    .map((entry) => entry.nextRetryAt);

  return retryTimes.length > 0 ? Math.min(...retryTimes) : null;
}

export function persistPendingTitle(
  scope: TitleSyncScope,
  pageId: string,
  title: string,
  updatedAt = Date.now(),
): PendingTitleUpdate {
  const store = readStore();
  const update: PendingTitleUpdate = {
    ...scope,
    pageId,
    title,
    updatedAt,
    status: "pending",
    retryCount: 0,
    nextRetryAt: updatedAt,
  };
  store[getEntryKey(scope, pageId)] = update;

  const entries = Object.values(store).sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  writeStore(
    Object.fromEntries(
      entries
        .slice(0, MAX_PENDING_TITLES)
        .map((entry) => [getEntryKey(entry, entry.pageId), entry]),
    ),
  );

  return update;
}

export function clearPendingTitleIfMatch(
  scope: TitleSyncScope,
  pageId: string,
  title: string,
): boolean {
  const store = readStore();
  const entryKey = getEntryKey(scope, pageId);
  if (store[entryKey]?.title !== title) return false;

  delete store[entryKey];
  writeStore(store);
  return true;
}

export function blockPendingTitleIfMatch(
  scope: TitleSyncScope,
  pageId: string,
  title: string,
  httpStatus?: number,
): boolean {
  const store = readStore();
  const entryKey = getEntryKey(scope, pageId);
  const entry = store[entryKey];
  if (entry?.title !== title) return false;

  store[entryKey] = {
    ...entry,
    status: "blocked",
    nextRetryAt: 0,
    lastHttpStatus: httpStatus,
  };
  writeStore(store);
  return true;
}

export function deferPendingTitleIfMatch(
  scope: TitleSyncScope,
  pageId: string,
  title: string,
  httpStatus?: number,
  now = Date.now(),
): boolean {
  const store = readStore();
  const entryKey = getEntryKey(scope, pageId);
  const entry = store[entryKey];
  if (entry?.title !== title) return false;

  const retryCount = entry.retryCount + 1;
  const retryDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    1_000 * 2 ** Math.min(retryCount, 6),
  );

  store[entryKey] = {
    ...entry,
    status: "pending",
    retryCount,
    nextRetryAt: now + retryDelay,
    lastHttpStatus: httpStatus,
  };
  writeStore(store);
  return true;
}

export function retryPendingTitles(
  scope: TitleSyncScope,
  pageId?: string,
  now = Date.now(),
): number {
  const store = readStore();
  let resetCount = 0;

  for (const [entryKey, entry] of Object.entries(store)) {
    if (!matchesScope(entry, scope)) continue;
    if (pageId && entry.pageId !== pageId) continue;

    store[entryKey] = {
      ...entry,
      status: "pending",
      retryCount: 0,
      nextRetryAt: now,
      lastHttpStatus: undefined,
    };
    resetCount += 1;
  }

  if (resetCount > 0) writeStore(store);
  return resetCount;
}

export function requestPendingTitleSync(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TITLE_SYNC_REQUEST_EVENT));
}

export function isTitleSyncStorageEvent(event: StorageEvent): boolean {
  return event.key === TITLE_SYNC_STORAGE_KEY;
}
