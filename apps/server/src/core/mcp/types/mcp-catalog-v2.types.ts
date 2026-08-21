import type { JsonObject } from '@docmost/db/types/db';
import type {
  CatalogPageManifestItem,
  CatalogRootSelector,
  CatalogRootSelectorOutput,
  CatalogRootResult,
} from './mcp-catalog.types';

export const CATALOG_BUNDLE_V2_TOOL = 'resolve_catalog_bundle_v2';
export const CATALOG_DELTA_V2_TOOL = 'resolve_catalog_delta_v2';
export const CATALOG_BUNDLE_V2_SCHEMA_VERSION = 'catalog-bundle.v2';
export const CATALOG_DELTA_V2_SCHEMA_VERSION = 'catalog-delta.v2';
export const CATALOG_FRESHNESS_V2_SCHEMA_VERSION = 'catalog-freshness-proof.v2';
export const CATALOG_REFERENCE_EXTRACTOR_VERSION =
  'qts-fact-catalog-extractor.v2.0.0';
export const CATALOG_SIGNATURE_ALGORITHM = 'ed25519';
export const CATALOG_PUBLIC_KEY_FORMAT = 'spki-der-base64url';

export type CatalogBundleV2Input = {
  contract: 'qts-fact-catalog.v1';
  catalogRootPageId: string;
  environment: string;
  roots: CatalogRootSelector[];
  challenge: string;
};

export type CatalogPageV2 = {
  page_id: string;
  title: string | null;
  parent_page_id: string | null;
  space_id: string;
  updated_at: string;
  content_sha256: string;
  fetched_at: string;
  front_matter: JsonObject;
  markdown: string;
};

export type CatalogKnownRootCauseCandidateV2 = {
  page_id: string;
  document_type: 'known_root_cause';
  entity_id: string;
  affected_entities: string[];
  environment_scope: string[];
  selection_reason: string;
};

export type CatalogEdgeV2 = {
  from_page_id: string;
  to_page_id: string;
  relation: string;
  target: {
    document_type: string;
    entity_id?: string;
    query_profile_id?: string;
  };
};

export type CatalogUnresolvedReferenceV2 = {
  from_page_id: string;
  relation: string;
  target: {
    document_type?: string;
    entity_id?: string;
    query_profile_id?: string;
  };
  reason:
    | 'missing_or_not_accessible'
    | 'ambiguous_identity'
    | 'malformed_catalog_page'
    | 'unsupported_catalog_document'
    | 'invalid_reference'
    | 'reverse_validation_failed';
};

export type CatalogClosureStatusV2 = {
  roots_resolved: boolean;
  reference_fields_scanned: boolean;
  required_targets_resolved: boolean;
  unresolved_references_empty: boolean;
  known_root_cause_discovery_complete: boolean;
};

export type CatalogFreshnessProofV2Unsigned = {
  schema_version: typeof CATALOG_FRESHNESS_V2_SCHEMA_VERSION;
  signature_algorithm: typeof CATALOG_SIGNATURE_ALGORITHM;
  public_key_format: typeof CATALOG_PUBLIC_KEY_FORMAT;
  public_key: string;
  key_id: string;
  challenge: string;
  resolution_started_at: string;
  verified_at: string;
  resolution_elapsed_ms: number;
  catalog_root_page_id: string;
  environment: string;
  authorization_context_sha256: string;
  requested_roots: CatalogRootSelectorOutput[];
  isolation: 'repeatable_read';
  read_only: true;
  page_manifest: CatalogPageManifestItem[];
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_VERSION;
  bundle_fingerprint: string;
};

export type CatalogFreshnessProofV2 = CatalogFreshnessProofV2Unsigned & {
  signature: string;
};

export type CatalogBundleV2 = {
  schema_version: typeof CATALOG_BUNDLE_V2_SCHEMA_VERSION;
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
  pages: CatalogPageV2[];
  edges: CatalogEdgeV2[];
  unresolved_references: CatalogUnresolvedReferenceV2[];
  closure_status: CatalogClosureStatusV2;
  closure_complete: boolean;
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_VERSION;
  bundle_fingerprint: string;
  freshness_proof: CatalogFreshnessProofV2;
};

export type CatalogDeltaV2Input = CatalogBundleV2Input & {
  previous: {
    bundleFingerprint: string;
    pages: Array<{
      pageId: string;
      updatedAt: string;
      contentSha256: string;
    }>;
    freshnessProof: CatalogFreshnessProofV2;
  };
};

export type CatalogDeltaV2 = {
  schema_version: typeof CATALOG_DELTA_V2_SCHEMA_VERSION;
  contract: 'qts-fact-catalog.v1';
  previous_bundle_fingerprint: string;
  bundle_fingerprint: string;
  changed: boolean;
  catalog_root: CatalogBundleV2['catalog_root'];
  environment: string;
  roots: CatalogRootResult[];
  known_root_cause_candidates: CatalogKnownRootCauseCandidateV2[];
  current_page_manifest: CatalogPageManifestItem[];
  edges: CatalogEdgeV2[];
  unresolved_references: CatalogUnresolvedReferenceV2[];
  closure_status: CatalogClosureStatusV2;
  closure_complete: boolean;
  reference_extractor_version: typeof CATALOG_REFERENCE_EXTRACTOR_VERSION;
  changes: {
    added: CatalogPageV2[];
    updated: Array<{
      previous: CatalogPageManifestItem;
      current: CatalogPageV2;
    }>;
    removed: CatalogPageManifestItem[];
    unchanged: CatalogPageManifestItem[];
  };
  freshness_proof: CatalogFreshnessProofV2;
};
