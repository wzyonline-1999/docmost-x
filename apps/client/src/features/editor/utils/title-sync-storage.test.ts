import { beforeEach, describe, expect, it } from "vitest";
import {
  blockPendingTitleIfMatch,
  clearPendingTitleIfMatch,
  deferPendingTitleIfMatch,
  getPendingTitle,
  getPendingTitleUpdates,
  getRetryablePendingTitleUpdates,
  persistPendingTitle,
  retryPendingTitles,
  TitleSyncScope,
} from "./title-sync-storage";

const scopeA: TitleSyncScope = {
  accountId: "account-a",
  workspaceId: "workspace-a",
};
const scopeB: TitleSyncScope = {
  accountId: "account-b",
  workspaceId: "workspace-b",
};

describe("title sync storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("isolates pending titles by account and workspace", () => {
    persistPendingTitle(scopeA, "page-a", "Workspace A", 10);
    persistPendingTitle(scopeB, "page-a", "Workspace B", 20);

    expect(getPendingTitle(scopeA, "page-a")?.title).toBe("Workspace A");
    expect(getPendingTitle(scopeB, "page-a")?.title).toBe("Workspace B");
    expect(getPendingTitleUpdates(scopeA)).toHaveLength(1);
    expect(getPendingTitleUpdates(scopeB)).toHaveLength(1);
  });

  it("only clears the exact scoped title acknowledged by the server", () => {
    persistPendingTitle(scopeA, "page-a", "Draft one", 10);
    persistPendingTitle(scopeA, "page-a", "Draft two", 20);

    expect(clearPendingTitleIfMatch(scopeA, "page-a", "Draft one")).toBe(false);
    expect(getPendingTitle(scopeA, "page-a")?.title).toBe("Draft two");

    expect(clearPendingTitleIfMatch(scopeA, "page-a", "Draft two")).toBe(true);
    expect(getPendingTitle(scopeA, "page-a")).toBeNull();
  });

  it("blocks permanent failures without keeping them in the retry queue", () => {
    persistPendingTitle(scopeA, "page-a", "Forbidden", 10);

    expect(blockPendingTitleIfMatch(scopeA, "page-a", "Forbidden", 403)).toBe(
      true,
    );
    expect(getPendingTitle(scopeA, "page-a")).toMatchObject({
      status: "blocked",
      lastHttpStatus: 403,
    });
    expect(getRetryablePendingTitleUpdates(scopeA, 100)).toEqual([]);

    expect(retryPendingTitles(scopeA, "page-a", 200)).toBe(1);
    expect(getRetryablePendingTitleUpdates(scopeA, 200)).toHaveLength(1);
  });

  it("defers transient failures with bounded exponential backoff", () => {
    persistPendingTitle(scopeA, "page-a", "Retry later", 10);

    expect(
      deferPendingTitleIfMatch(scopeA, "page-a", "Retry later", 503, 100),
    ).toBe(true);
    expect(getPendingTitle(scopeA, "page-a")).toMatchObject({
      retryCount: 1,
      nextRetryAt: 2_100,
      lastHttpStatus: 503,
    });
    expect(getRetryablePendingTitleUpdates(scopeA, 2_099)).toEqual([]);
    expect(getRetryablePendingTitleUpdates(scopeA, 2_100)).toHaveLength(1);
  });

  it("quarantines the unscoped v1 queue instead of replaying it", () => {
    localStorage.setItem(
      "docmost.pending-page-titles.v1",
      JSON.stringify({
        "old-page": {
          pageId: "old-page",
          title: "Old title",
          updatedAt: 1,
        },
      }),
    );

    expect(getPendingTitleUpdates(scopeA)).toEqual([]);
    expect(localStorage.getItem("docmost.pending-page-titles.v1")).toBeNull();
    expect(
      localStorage.getItem("docmost.pending-page-titles.legacy.v1"),
    ).toContain("Old title");
  });

  it("keeps only the latest one hundred pending pages across scopes", () => {
    for (let index = 0; index < 105; index += 1) {
      persistPendingTitle(
        index % 2 === 0 ? scopeA : scopeB,
        `page-${index}`,
        `Title ${index}`,
        index,
      );
    }

    expect(
      getPendingTitleUpdates(scopeA).length +
        getPendingTitleUpdates(scopeB).length,
    ).toBe(100);
    expect(getPendingTitle(scopeA, "page-0")).toBeNull();
    expect(getPendingTitle(scopeA, "page-104")?.title).toBe("Title 104");
  });
});
