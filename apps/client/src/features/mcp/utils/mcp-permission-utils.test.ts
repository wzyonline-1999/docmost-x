import { describe, expect, it } from "vitest";
import {
  buildPermissionUpdates,
  getPermissionSelectionState,
  getPermissionValues,
} from "./mcp-permission-utils";

describe("MCP permission utilities", () => {
  it("defaults missing permissions to false", () => {
    expect(getPermissionValues()).toEqual({
      canSearch: false,
      canSemanticSearch: false,
      canRead: false,
      canCreate: false,
      canUpdate: false,
      canAppend: false,
      canDelete: false,
      canRestore: false,
      canIndex: false,
    });
  });

  it.each([
    [[], { checked: false, indeterminate: false }],
    [[false, false], { checked: false, indeterminate: false }],
    [[true, true], { checked: true, indeterminate: false }],
    [[true, false], { checked: false, indeterminate: true }],
  ])("derives selection state for %j", (values, expected) => {
    expect(getPermissionSelectionState(values)).toEqual(expected);
  });

  it("updates only changed spaces and preserves other permission fields", () => {
    const updates = buildPermissionUpdates(
      "client-1",
      [
        {
          id: "space-1",
          permission: { canSearch: true, canRead: true },
        },
        {
          id: "space-2",
          permission: { canSearch: false, canRead: true },
        },
      ],
      { canSearch: true },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      clientId: "client-1",
      spaceId: "space-2",
      canSearch: true,
      canRead: true,
      canCreate: false,
    });
  });

  it("can apply all permission fields in one update per space", () => {
    const changes = getPermissionValues({
      canSearch: true,
      canSemanticSearch: true,
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canAppend: true,
      canDelete: true,
      canRestore: true,
      canIndex: true,
    });

    const updates = buildPermissionUpdates(
      "client-1",
      [{ id: "space-1" }, { id: "space-2" }],
      changes,
    );

    expect(updates).toHaveLength(2);
    expect(updates.every((update) => update.canIndex)).toBe(true);
  });

  it("applies bulk changes only to fields allowed by each native ceiling", () => {
    const ceiling = getPermissionValues({
      canSearch: true,
      canRead: true,
    });
    const updates = buildPermissionUpdates(
      "client-1",
      [
        {
          id: "space-1",
          permission: { canSearch: false, canCreate: false },
          ceiling,
        },
      ],
      {
        canSearch: true,
        canCreate: true,
      },
    );

    expect(updates).toEqual([
      expect.objectContaining({
        clientId: "client-1",
        spaceId: "space-1",
        canSearch: true,
        canCreate: false,
      }),
    ]);
  });

  it("preserves stale configured values while updating eligible fields", () => {
    const ceiling = getPermissionValues({ canRead: true });
    const updates = buildPermissionUpdates(
      "client-1",
      [
        {
          id: "space-1",
          permission: { canRead: false, canUpdate: true },
          ceiling,
        },
      ],
      { canRead: true, canUpdate: false },
    );

    expect(updates[0]).toMatchObject({
      canRead: true,
      canUpdate: true,
    });
  });
});
