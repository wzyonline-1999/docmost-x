import { Feature } from "@/oss/features";

export function useHasFeature(feature?: string) {
  return feature === Feature.ATTACHMENT_INDEXING;
}
