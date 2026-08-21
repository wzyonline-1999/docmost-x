import type { JsonObject } from '@docmost/db/types/db';
import type {
  CatalogRootSelector,
  CatalogRootSelectorOutput,
  CatalogRootResult,
} from './mcp-catalog.types';
import type {
  CatalogClosureStatusV2,
  CatalogEdgeV2,
  CatalogKnownRootCauseCandidateV2,
  CatalogUnresolvedReferenceV2,
} from './mcp-catalog-v2.types';

export const BEGIN_CATALOG_RESOLUTION_TOOL = 'begin_catalog_resolution';
export const CATALOG_BUNDLE_V3_TOOL = 'resolve_catalog_bundle_v3';
export const CATALOG_DELTA_V3_TOOL = 'resolve_catalog_delta_v3';
export const CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION =
  'catalog-resolution-ticket.v1';
export const CATALOG_BUNDLE_V3_SCHEMA_VERSION = 'catalog-bundle.v3';
export const CATALOG_DELTA_V3_SCHEMA_VERSION = 'catalog-delta.v3';
export const CATALOG_FRESHNESS_V3_SCHEMA_VERSION = 'catalog-freshness-proof.v3';
export const CATALOG_REFERENCE_EXTRACTOR_V3_VERSION =
  'qts-fact-catalog-extractor.v3.0.0';

export type CatalogResolutionTicketInput = {
  contract: 'qts-fact-catalog.v1';
  catalogRootPageId: string;
  environment: string;
  challenge: string;
};

export type CatalogResolutionTicketUnsigned = {
  schema_version: typeof CATALOG_RESOLUTION_TICKET_SCHEMA_VERSION;
  signature_algorithm: 'ed25519';
  public_key_format: 'spki-der-base64url';
  public_key: string;
  key_id: string;
  ticket_id: string;
  issued_at: string;
  expires_at: string;
  challenge: string;
  catalog_root_page_id: string;
  environment: string;
  authorization_context_sha256: string;
};

export type CatalogResolutionTicket = CatalogResolutionTicketUnsigned & {
  signature: string;
};

export type CatalogBundleV3Input = {
  contract: 'qts-fact-catalog.v1';
  catalogRootPageId: string;
  environment: string;
  roots: CatalogRootSelector[];
  ticket: CatalogResolutionTicket;
};

export type CatalogPageManifestItemV3 = {
  page_id: string;
  updated_at: string;
  content_sha256: string;
  front_matter_sha256: string;
};

export type CatalogPageV3 = {
  page_id: string;
  title: string | null;
  parent_page_id: string | null;
  space_id: string;
  updated_at: string;
  content_sha256: string;
  front_matter_sha256: string;
  fetched_at: string;
  front_matter: JsonObject;
  markdown: string;
};

export type CatalogFreshnessProofV3Unsigned = {
  schema_version: typeof CATALOG_FRESHNESS_V3_SCHEMA_VERSION;
  signature_algorithm: 'ed25519';
  public_key_format: 'spki-der-base64url';
  public_key: string;
  key_id: string;
  resolution_ticket_id: string;
  challenge: string;
  resolution_started_at: string;
  verified_at: string;
  resolution_elapsed_ms: number;
  snapshot_fetched_at: string;
  catalog_root_page_id: string;
  environment: string;
  authorization_context_sha256: string;
  requested_roots: CatalogRootSelectorOutput[];
  isolation: 'repeatable_read';
  read_only: true;
  page_manifest: CatalogPageManifestItemV3[];
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_V3_VERSION;
  bundle_fingerprint: string;
};

export type CatalogFreshnessProofV3 = CatalogFreshnessProofV3Unsigned & {
  signature: string;
};

export type CatalogBundleV3 = {
  schema_version: typeof CATALOG_BUNDLE_V3_SCHEMA_VERSION;
  contract: 'qts-fact-catalog.v1';
  catalog_root: {
    page_id: string;
    title: string | null;
    space_id: string;
    updated_at: string;
  };
  environment: string;
  roots: CatalogRootResult[];
  known_root_cause_candidates: CatalogKnownRootCauseCandidateV2[];
  pages: CatalogPageV3[];
  edges: CatalogEdgeV2[];
  unresolved_references: CatalogUnresolvedReferenceV2[];
  closure_status: CatalogClosureStatusV2;
  closure_complete: boolean;
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_V3_VERSION;
  bundle_fingerprint: string;
  freshness_proof: CatalogFreshnessProofV3;
};

export type CatalogDeltaV3Input = CatalogBundleV3Input & {
  previous: {
    bundleFingerprint: string;
    pages: Array<{
      pageId: string;
      updatedAt: string;
      contentSha256: string;
      frontMatterSha256: string;
    }>;
    freshnessProof: CatalogFreshnessProofV3;
  };
};

export type CatalogRootChangesV3 = {
  added: CatalogRootSelectorOutput[];
  removed: CatalogRootSelectorOutput[];
  unchanged: CatalogRootSelectorOutput[];
};

export type CatalogDeltaV3 = {
  schema_version: typeof CATALOG_DELTA_V3_SCHEMA_VERSION;
  contract: 'qts-fact-catalog.v1';
  previous_bundle_fingerprint: string;
  bundle_fingerprint: string;
  changed: boolean;
  catalog_root: CatalogBundleV3['catalog_root'];
  environment: string;
  roots: CatalogRootResult[];
  root_changes: CatalogRootChangesV3;
  known_root_cause_candidates: CatalogKnownRootCauseCandidateV2[];
  current_page_manifest: CatalogPageManifestItemV3[];
  edges: CatalogEdgeV2[];
  unresolved_references: CatalogUnresolvedReferenceV2[];
  closure_status: CatalogClosureStatusV2;
  closure_complete: boolean;
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_V3_VERSION;
  changes: {
    added: CatalogPageV3[];
    updated: Array<{
      previous: CatalogPageManifestItemV3;
      current: CatalogPageV3;
    }>;
    removed: CatalogPageManifestItemV3[];
    unchanged: CatalogPageManifestItemV3[];
  };
  freshness_proof: CatalogFreshnessProofV3;
};
