import { describe, expect, it } from "vitest";
import { SpaceRole } from "@/lib/types";
import { canManageTemplate } from "./template-permission";

describe("canManageTemplate", () => {
  it("allows workspace administrators to manage every template scope", () => {
    expect(
      canManageTemplate({
        isAdmin: true,
        allowMemberTemplates: false,
        spaceId: null,
      }),
    ).toBe(true);
  });

  it.each([SpaceRole.ADMIN, SpaceRole.WRITER])(
    "allows a %s when member templates are enabled",
    (spaceRole) => {
      expect(
        canManageTemplate({
          isAdmin: false,
          allowMemberTemplates: true,
          spaceId: "space-1",
          spaceRole,
        }),
      ).toBe(true);
    },
  );

  it("denies readers and members without the workspace feature", () => {
    expect(
      canManageTemplate({
        isAdmin: false,
        allowMemberTemplates: true,
        spaceId: "space-1",
        spaceRole: SpaceRole.READER,
      }),
    ).toBe(false);
    expect(
      canManageTemplate({
        isAdmin: false,
        allowMemberTemplates: false,
        spaceId: "space-1",
        spaceRole: SpaceRole.ADMIN,
      }),
    ).toBe(false);
  });

  it("keeps global templates administrator-only", () => {
    expect(
      canManageTemplate({
        isAdmin: false,
        allowMemberTemplates: true,
        spaceId: null,
        spaceRole: SpaceRole.ADMIN,
      }),
    ).toBe(false);
  });
});
