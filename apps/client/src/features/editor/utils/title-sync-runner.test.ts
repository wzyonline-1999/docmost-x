import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPage } from "@/features/page/types/page.types";
import {
  getPendingTitle,
  persistPendingTitle,
  TitleSyncScope,
} from "./title-sync-storage";
import { syncPendingTitleBatch } from "./title-sync-runner";

const scope: TitleSyncScope = {
  accountId: "account-a",
  workspaceId: "workspace-a",
};

describe("title sync runner", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("continues syncing later titles after a permanent 403", async () => {
    const forbidden = persistPendingTitle(
      scope,
      "page-forbidden",
      "Forbidden",
      10,
    );
    const allowed = persistPendingTitle(scope, "page-allowed", "Allowed", 20);
    const updateTitle = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockResolvedValueOnce({
        id: "page-allowed",
        title: "Allowed",
      } as IPage);
    const onSynced = vi.fn();

    const result = await syncPendingTitleBatch({
      scope,
      updates: [forbidden, allowed],
      updateTitle,
      onSynced,
      now: () => 100,
    });

    expect(updateTitle).toHaveBeenCalledTimes(2);
    expect(result.blocked).toEqual([forbidden]);
    expect(result.synced).toEqual([allowed]);
    expect(getPendingTitle(scope, "page-forbidden")?.status).toBe("blocked");
    expect(getPendingTitle(scope, "page-allowed")).toBeNull();
    expect(onSynced).toHaveBeenCalledOnce();
  });

  it("stops the batch after 401 because the whole session is unauthorized", async () => {
    const first = persistPendingTitle(scope, "page-a", "First", 10);
    const second = persistPendingTitle(scope, "page-b", "Second", 20);
    const updateTitle = vi
      .fn()
      .mockRejectedValue({ response: { status: 401 } });

    const result = await syncPendingTitleBatch({
      scope,
      updates: [first, second],
      updateTitle,
      onSynced: vi.fn(),
      now: () => 100,
    });

    expect(updateTitle).toHaveBeenCalledOnce();
    expect(result.unauthorized).toBe(true);
    expect(getPendingTitle(scope, "page-a")?.status).toBe("pending");
    expect(getPendingTitle(scope, "page-b")?.retryCount).toBe(0);
  });

  it("preserves a newer title queued while an older request is in flight", async () => {
    const oldUpdate = persistPendingTitle(scope, "page-a", "Old title", 10);
    const updateTitle = vi.fn().mockImplementation(async () => {
      persistPendingTitle(scope, "page-a", "New title", 20);
      return {
        id: "page-a",
        title: "Old title",
      } as IPage;
    });

    await syncPendingTitleBatch({
      scope,
      updates: [oldUpdate],
      updateTitle,
      onSynced: vi.fn(),
    });

    expect(getPendingTitle(scope, "page-a")).toMatchObject({
      title: "New title",
      status: "pending",
    });
  });

  it("continues syncing later titles after a transient server failure", async () => {
    const deferred = persistPendingTitle(scope, "page-a", "Retry", 10);
    const allowed = persistPendingTitle(scope, "page-b", "Allowed", 20);
    const updateTitle = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({
        id: "page-b",
        title: "Allowed",
      } as IPage);

    const result = await syncPendingTitleBatch({
      scope,
      updates: [deferred, allowed],
      updateTitle,
      onSynced: vi.fn(),
      now: () => 100,
    });

    expect(updateTitle).toHaveBeenCalledTimes(2);
    expect(result.deferred).toEqual([deferred]);
    expect(result.synced).toEqual([allowed]);
    expect(getPendingTitle(scope, "page-a")).toMatchObject({
      status: "pending",
      retryCount: 1,
      nextRetryAt: 2_100,
    });
    expect(getPendingTitle(scope, "page-b")).toBeNull();
  });
});
