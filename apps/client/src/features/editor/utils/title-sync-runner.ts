import { IPage } from "@/features/page/types/page.types";
import {
  blockPendingTitleIfMatch,
  clearPendingTitleIfMatch,
  deferPendingTitleIfMatch,
  PendingTitleUpdate,
  TitleSyncScope,
} from "./title-sync-storage";

export interface TitleSyncBatchResult {
  synced: PendingTitleUpdate[];
  blocked: PendingTitleUpdate[];
  deferred: PendingTitleUpdate[];
  unauthorized: boolean;
}

interface SyncPendingTitleBatchOptions {
  scope: TitleSyncScope;
  updates: PendingTitleUpdate[];
  updateTitle: (update: PendingTitleUpdate) => Promise<IPage>;
  onSynced: (page: IPage) => void;
  now?: () => number;
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { response?: { status?: unknown } }).response
    ?.status;
  return typeof status === "number" ? status : undefined;
}

export async function syncPendingTitleBatch({
  scope,
  updates,
  updateTitle,
  onSynced,
  now = Date.now,
}: SyncPendingTitleBatchOptions): Promise<TitleSyncBatchResult> {
  const result: TitleSyncBatchResult = {
    synced: [],
    blocked: [],
    deferred: [],
    unauthorized: false,
  };

  for (const pending of updates) {
    try {
      const page = await updateTitle(pending);
      onSynced(page);
      clearPendingTitleIfMatch(scope, pending.pageId, pending.title);
      result.synced.push(pending);
    } catch (error) {
      const httpStatus = getHttpStatus(error);

      if (httpStatus === 403 || httpStatus === 404) {
        blockPendingTitleIfMatch(
          scope,
          pending.pageId,
          pending.title,
          httpStatus,
        );
        result.blocked.push(pending);
        continue;
      }

      deferPendingTitleIfMatch(
        scope,
        pending.pageId,
        pending.title,
        httpStatus,
        now(),
      );
      result.deferred.push(pending);

      if (httpStatus === 401) {
        result.unauthorized = true;
        break;
      }
    }
  }

  return result;
}
