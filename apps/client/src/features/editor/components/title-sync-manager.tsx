import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { updatePageData } from "@/features/page/queries/page-query";
import { updatePage } from "@/features/page/services/page-service";
import { titleSyncFeedbackAtom } from "@/features/editor/atoms/editor-atoms";
import {
  getNextPendingTitleRetryAt,
  getPendingTitleUpdates,
  getRetryablePendingTitleUpdates,
  isTitleSyncStorageEvent,
  requestPendingTitleSync,
  TITLE_SYNC_REQUEST_EVENT,
  TitleSyncScope,
} from "@/features/editor/utils/title-sync-storage";
import { syncPendingTitleBatch } from "@/features/editor/utils/title-sync-runner";
import { useQueryEmit } from "@/features/websocket/use-query-emit";
import { UpdateEvent } from "@/features/websocket/types";
import localEmitter from "@/lib/local-emitter";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

const MAX_BATCH_SIZE = 20;

function isSameScope(
  left: TitleSyncScope | null,
  right: TitleSyncScope,
): boolean {
  return (
    left?.accountId === right.accountId &&
    left.workspaceId === right.workspaceId
  );
}

async function withTitleSyncLock(
  scope: TitleSyncScope,
  callback: () => Promise<void>,
): Promise<void> {
  if (!navigator.locks) {
    await callback();
    return;
  }

  const lockName = [
    "docmost",
    "title-sync",
    scope.accountId,
    scope.workspaceId,
  ].join(":");
  await navigator.locks.request(lockName, callback);
}

export function TitleSyncManager() {
  const currentUser = useAtomValue(currentUserAtom);
  const setTitleSyncFeedback = useSetAtom(titleSyncFeedbackAtom);
  const emit = useQueryEmit();
  const isFlushingRef = useRef(false);
  const flushRequestedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const accountId = currentUser?.user.id;
  const workspaceId = currentUser?.workspace.id;
  const scope = useMemo<TitleSyncScope | null>(() => {
    if (!accountId || !workspaceId) return null;
    return {
      accountId,
      workspaceId,
    };
  }, [accountId, workspaceId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const clearRetryTimer = useCallback(() => {
    if (!retryTimerRef.current) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
  }, []);

  const scheduleRetry = useCallback(
    (activeScope: TitleSyncScope) => {
      clearRetryTimer();
      const nextRetryAt = getNextPendingTitleRetryAt(activeScope);
      if (nextRetryAt === null) return;

      const delay = Math.max(0, nextRetryAt - Date.now());
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = undefined;
        requestPendingTitleSync();
      }, delay);
    },
    [clearRetryTimer],
  );

  const emitPageUpdate = useCallback(
    (page: Awaited<ReturnType<typeof updatePage>>) => {
      const event: UpdateEvent = {
        operation: "updateOne",
        spaceId: page.spaceId,
        entity: ["pages"],
        id: page.id,
        payload: {
          title: page.title,
          slugId: page.slugId,
          parentPageId: page.parentPageId,
          icon: page.icon,
        },
      };

      updatePageData(page);
      localEmitter.emit("message", event);
      emit(event);
    },
    [emit],
  );

  const flushPendingTitles = useCallback(() => {
    const activeScope = scopeRef.current;
    if (!activeScope) return;

    flushRequestedRef.current = true;
    if (isFlushingRef.current) return;

    void (async () => {
      isFlushingRef.current = true;

      try {
        await withTitleSyncLock(activeScope, async () => {
          if (!isSameScope(scopeRef.current, activeScope)) return;

          while (flushRequestedRef.current) {
            flushRequestedRef.current = false;

            if (!navigator.onLine) {
              const pending = getPendingTitleUpdates(activeScope)[0];
              if (pending) {
                setTitleSyncFeedback({
                  status: "offline",
                  pageId: pending.pageId,
                });
              }
              break;
            }

            const updates = getRetryablePendingTitleUpdates(activeScope).slice(
              0,
              MAX_BATCH_SIZE,
            );
            if (updates.length === 0) break;

            setTitleSyncFeedback({
              status: "syncing",
              pageId: updates[0].pageId,
            });

            const result = await syncPendingTitleBatch({
              scope: activeScope,
              updates,
              updateTitle: (pending) =>
                updatePage({
                  pageId: pending.pageId,
                  title: pending.title,
                }),
              onSynced: (page) => {
                if (isSameScope(scopeRef.current, activeScope)) {
                  emitPageUpdate(page);
                }
              },
            });

            if (!isSameScope(scopeRef.current, activeScope)) break;

            const failed = result.blocked.at(-1) ?? result.deferred.at(-1);
            if (failed) {
              setTitleSyncFeedback({
                status: navigator.onLine ? "failed" : "offline",
                pageId: failed.pageId,
              });
            } else if (result.synced.length > 0) {
              setTitleSyncFeedback({
                status: "synced",
                pageId: result.synced.at(-1)?.pageId,
              });
            }

            if (result.unauthorized) break;

            if (
              getRetryablePendingTitleUpdates(activeScope).length > 0 ||
              flushRequestedRef.current
            ) {
              flushRequestedRef.current = true;
            }
          }
        });

        if (isSameScope(scopeRef.current, activeScope)) {
          scheduleRetry(activeScope);
        }
      } finally {
        isFlushingRef.current = false;
        if (flushRequestedRef.current) {
          queueMicrotask(requestPendingTitleSync);
        }
      }
    })();
  }, [emitPageUpdate, scheduleRetry, setTitleSyncFeedback]);

  useEffect(() => {
    if (!scope) return;

    const handleOnline = () => flushPendingTitles();
    const handleOffline = () => {
      const pending = getPendingTitleUpdates(scope)[0];
      if (pending) {
        setTitleSyncFeedback({
          status: "offline",
          pageId: pending.pageId,
        });
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (isTitleSyncStorageEvent(event)) flushPendingTitles();
    };

    window.addEventListener(TITLE_SYNC_REQUEST_EVENT, flushPendingTitles);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);

    if (getPendingTitleUpdates(scope).length > 0) {
      requestPendingTitleSync();
    }

    return () => {
      window.removeEventListener(TITLE_SYNC_REQUEST_EVENT, flushPendingTitles);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      clearRetryTimer();
    };
  }, [clearRetryTimer, flushPendingTitles, scope, setTitleSyncFeedback]);

  return null;
}
