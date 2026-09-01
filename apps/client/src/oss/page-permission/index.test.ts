import { describe, expect, it, vi } from "vitest";

const { shareModal } = vi.hoisted(() => ({
  shareModal: () => null,
}));

vi.mock("@/features/share/components/share-modal", () => ({
  default: shareModal,
}));

import { PageShareModal } from "./index";

describe("community page sharing", () => {
  it("exposes the implemented public sharing modal in the page header", () => {
    expect(PageShareModal).toBe(shareModal);
  });
});
