import { describe, expect, it } from "vitest";
import { buildMcpAuditDiff } from "./mcp-audit-utils";

describe("MCP audit utilities", () => {
  it("returns nested field changes in a stable order", () => {
    expect(
      buildMcpAuditDiff(
        { name: "Before", permissions: { canRead: true, canUpdate: false } },
        { name: "After", permissions: { canRead: true, canUpdate: true } },
      ),
    ).toEqual([
      { path: "name", before: "Before", after: "After" },
      {
        path: "permissions.canUpdate",
        before: false,
        after: true,
      },
    ]);
  });

  it("describes added and removed fields", () => {
    expect(buildMcpAuditDiff({ removed: 1 }, { added: 2 })).toEqual([
      { path: "added", before: undefined, after: 2 },
      { path: "removed", before: 1, after: undefined },
    ]);
  });

  it("treats arrays as readable leaf values", () => {
    expect(
      buildMcpAuditDiff({ roles: ["reader"] }, { roles: ["admin"] }),
    ).toEqual([
      {
        path: "roles",
        before: ["reader"],
        after: ["admin"],
      },
    ]);
  });

  it("returns no rows when values are equivalent", () => {
    expect(buildMcpAuditDiff({ active: true }, { active: true })).toEqual([]);
  });
});
