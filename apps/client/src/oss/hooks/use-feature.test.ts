import { describe, expect, it } from "vitest";
import { Feature } from "@/oss/features";
import { useHasFeature } from "./use-feature";

describe("community feature availability", () => {
  it("exposes the implemented attachment indexing search", () => {
    expect(useHasFeature(Feature.ATTACHMENT_INDEXING)).toBe(true);
  });

  it("keeps unavailable commercial features disabled", () => {
    expect(useHasFeature(Feature.AUDIT_LOGS)).toBe(false);
  });
});
