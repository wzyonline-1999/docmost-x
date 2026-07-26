import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPage } from "@/features/page/types/page.types";
import {
  getRecentlyOpenedPages,
  READING_CONTINUITY_EVENT,
  recordRecentlyOpenedPage,
} from "./reading-continuity";

const WORKSPACE_ID = "workspace-1";
const STORAGE_KEY = `docmost.reading-continuity.v1.${WORKSPACE_ID}`;

describe("reading continuity", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("records pages once in most-recently-opened order", () => {
    const updated = vi.fn();
    window.addEventListener(READING_CONTINUITY_EVENT, updated);
    const now = vi.spyOn(Date, "now").mockReturnValue(100);

    recordRecentlyOpenedPage(page("page-1", "space-1"));
    now.mockReturnValue(200);
    recordRecentlyOpenedPage(page("page-2", "space-1"));
    now.mockReturnValue(300);
    recordRecentlyOpenedPage(page("page-1", "space-1"));

    expect(
      getRecentlyOpenedPages(WORKSPACE_ID).map((entry) => entry.id),
    ).toEqual(["page-1", "page-2"]);
    expect(getRecentlyOpenedPages(WORKSPACE_ID)[0].openedAt).toBe(300);
    expect(updated).toHaveBeenCalledTimes(3);
    window.removeEventListener(READING_CONTINUITY_EVENT, updated);
  });

  it("filters by space and keeps workspace histories isolated", () => {
    recordRecentlyOpenedPage(page("page-1", "space-1"));
    recordRecentlyOpenedPage(page("page-2", "space-2"));
    recordRecentlyOpenedPage({
      ...page("page-3", "space-1"),
      workspaceId: "workspace-2",
    });

    expect(
      getRecentlyOpenedPages(WORKSPACE_ID, "space-1").map((entry) => entry.id),
    ).toEqual(["page-1"]);
    expect(
      getRecentlyOpenedPages("workspace-2").map((entry) => entry.id),
    ).toEqual(["page-3"]);
  });

  it("ignores malformed persisted records without throwing", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pages: {
          valid: {
            id: "valid",
            slugId: "valid",
            title: "Valid",
            icon: "",
            isBase: false,
            openedAt: 100,
            scrollY: 0,
            space: { id: "space-1", slug: "space" },
          },
          broken: {
            id: "broken",
            slugId: null,
            openedAt: "yesterday",
          },
        },
        recentPageIds: ["broken", "valid", "valid", 42],
      }),
    );

    expect(getRecentlyOpenedPages(WORKSPACE_ID)).toEqual([
      expect.objectContaining({ id: "valid" }),
    ]);
  });
});

function page(id: string, spaceId: string): IPage {
  return {
    id,
    slugId: id,
    title: id,
    content: "",
    icon: "",
    coverPhoto: "",
    parentPageId: "",
    creatorId: "user-1",
    spaceId,
    workspaceId: WORKSPACE_ID,
    isLocked: false,
    isBase: false,
    lastUpdatedById: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as never,
    position: "a0",
    hasChildren: false,
    creator: { id: "user-1", name: "User", avatarUrl: "" },
    lastUpdatedBy: { id: "user-1", name: "User", avatarUrl: "" },
    deletedBy: { id: "user-1", name: "User", avatarUrl: "" },
    space: {
      id: spaceId,
      name: spaceId,
      slug: spaceId,
    },
  };
}
