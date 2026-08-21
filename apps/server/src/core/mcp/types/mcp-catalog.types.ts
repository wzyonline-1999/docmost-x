import type { JsonObject } from '@docmost/db/types/db';

export const QTS_FACT_CATALOG_CONTRACT = 'qts-fact-catalog.v1';
export const CATALOG_BUNDLE_SCHEMA_VERSION = 'catalog-bundle.v1';
export const CATALOG_DELTA_SCHEMA_VERSION = 'catalog-delta.v1';
export const CATALOG_FRESHNESS_SCHEMA_VERSION = 'catalog-freshness-proof.v1';

export const CATALOG_LIMITS = Object.freeze({
  maxRoots: 32,
  maxScannedPages: 2_000,
  maxClosurePages: 512,
  maxEdges: 4_096,
  maxPageMarkdownBytes: 1024 * 1024,
  maxScannedContentBytes: 32 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  minChallengeBytes: 16,
  maxChallengeBytes: 128,
});

export type CatalogRootSelector =
  | { pageId: string }
  | { documentType: string; entityId: string };

export type CatalogRootSelectorOutput =
  | { page_id: string }
  | { document_type: string; entity_id: string };

export type CatalogBundleInput = {
  contract: typeof QTS_FACT_CATALOG_CONTRACT;
  catalogRootPageId: string;
  environment: string;
  roots: CatalogRootSelector[];
  challenge: string;
};

export type CatalogPreviousPage = {
  pageId: string;
  updatedAt: string;
  contentSha256: string;
};

export type CatalogDeltaInput = CatalogBundleInput & {
  previous: {
    bundleFingerprint: string;
    pages: CatalogPreviousPage[];
  };
};

export type CatalogCapturedPage = {
  id: string;
  title: string | null;
  parentPageId: string | null;
  spaceId: string;
  updatedAt: Date;
  content: unknown;
};

export type CatalogSnapshot = {
  catalogRoot: {
    id: string;
    title: string | null;
    spaceId: string;
    updatedAt: Date;
  };
  snapshotAt: Date;
  pages: CatalogCapturedPage[];
  scannedPageCount: number;
  scannedContentBytes: number;
};

export type CatalogPage = {
  page_id: string;
  title: string | null;
  parent_page_id: string | null;
  space_id: string;
  updated_at: string;
  content_sha256: string;
  front_matter: JsonObject;
  markdown: string;
};

export type CatalogPageManifestItem = Pick<
  CatalogPage,
  'page_id' | 'updated_at' | 'content_sha256'
>;

export type CatalogResolvedRoot = {
  selector: CatalogRootSelectorOutput;
  status: 'resolved';
  page_id: string;
  document_type: string;
  entity_id: string;
};

export type CatalogUnresolvedRoot = {
  selector: CatalogRootSelectorOutput;
  status: 'unresolved';
  reason:
    | 'missing_or_not_accessible'
    | 'ambiguous_identity'
    | 'malformed_catalog_page'
    | 'unsupported_catalog_document';
};

export type CatalogRootResult = CatalogResolvedRoot | CatalogUnresolvedRoot;

export type CatalogEdge = {
  from_page_id: string;
  to_page_id: string;
  relation: string;
  target: {
    document_type: string;
    entity_id?: string;
    query_profile_id?: string;
  };
};

export type CatalogUnresolvedReference = {
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
    | 'invalid_reference'
    | 'reverse_validation_failed';
};

export type CatalogFreshnessProof = {
  schema_version: typeof CATALOG_FRESHNESS_SCHEMA_VERSION;
  challenge: string;
  verified_at: string;
  isolation: 'repeatable_read';
  read_only: true;
  page_manifest: CatalogPageManifestItem[];
  bundle_fingerprint: string;
};

export type CatalogBundle = {
  schema_version: typeof CATALOG_BUNDLE_SCHEMA_VERSION;
  contract: typeof QTS_FACT_CATALOG_CONTRACT;
  catalog_root: {
    page_id: string;
    title: string | null;
    space_id: string;
    updated_at: string;
  };
  environment: string;
  roots: CatalogRootResult[];
  pages: CatalogPage[];
  edges: CatalogEdge[];
  unresolved_references: CatalogUnresolvedReference[];
  closure_complete: boolean;
  bundle_fingerprint: string;
  freshness_proof: CatalogFreshnessProof;
};

export type CatalogDelta = {
  schema_version: typeof CATALOG_DELTA_SCHEMA_VERSION;
  contract: typeof QTS_FACT_CATALOG_CONTRACT;
  previous_bundle_fingerprint: string;
  bundle_fingerprint: string;
  changed: boolean;
  catalog_root: CatalogBundle['catalog_root'];
  environment: string;
  roots: CatalogRootResult[];
  current_page_manifest: CatalogPageManifestItem[];
  edges: CatalogEdge[];
  unresolved_references: CatalogUnresolvedReference[];
  closure_complete: boolean;
  changes: {
    added: CatalogPage[];
    updated: Array<{
      previous: CatalogPageManifestItem;
      current: CatalogPage;
    }>;
    removed: CatalogPageManifestItem[];
    unchanged: CatalogPageManifestItem[];
  };
  freshness_proof: CatalogFreshnessProof;
};
