import { atom } from "jotai";

export type EntitlementState = {
  tier: string;
  features: string[];
};

export const entitlementAtom = atom<EntitlementState>({
  tier: "free",
  features: [],
});
