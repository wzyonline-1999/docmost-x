import { describe, expect, it } from "vitest";
import { buildPageSearchPath } from "./search-result-utils";

const result = {
  space: { name: "Engineering" },
  breadcrumbs: [
    { id: "root", slugId: "root", title: "", isBase: true },
    { id: "parent", slugId: "parent", title: "Runbooks", isBase: false },
  ],
};

const formatTitle = (title: string, isBase: boolean) =>
  title || (isBase ? "Untitled base" : "Untitled");

describe("buildPageSearchPath", () => {
  it("keeps the space and ancestors in root-to-parent order", () => {
    expect(buildPageSearchPath(result, true, formatTitle)).toEqual([
      "Engineering",
      "Untitled base",
      "Runbooks",
    ]);
  });

  it("omits the space name for searches scoped to one space", () => {
    expect(buildPageSearchPath(result, false, formatTitle)).toEqual([
      "Untitled base",
      "Runbooks",
    ]);
  });

  it("handles a root page without breadcrumb data", () => {
    expect(
      buildPageSearchPath(
        { space: { name: "Product" }, breadcrumbs: [] },
        true,
        formatTitle,
      ),
    ).toEqual(["Product"]);
  });
});
