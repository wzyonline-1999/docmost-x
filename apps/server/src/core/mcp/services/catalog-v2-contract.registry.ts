import { BadRequestException, Injectable } from '@nestjs/common';
import type { JsonObject } from '@docmost/db/types/db';
import { isAlias, parseDocument, visit } from 'yaml';
import type {
  CatalogEdge,
  CatalogPage,
  CatalogPageManifestItem,
  CatalogRootSelector,
  CatalogRootSelectorOutput,
  CatalogRootResult,
} from '../types/mcp-catalog.types';
import {
  CATALOG_BUNDLE_V2_SCHEMA_VERSION,
  CATALOG_REFERENCE_EXTRACTOR_VERSION,
  CatalogClosureStatusV2,
  CatalogEdgeV2,
  CatalogKnownRootCauseCandidateV2,
  CatalogPageV2,
  CatalogUnresolvedReferenceV2,
} from '../types/mcp-catalog-v2.types';
import { CatalogContractRegistry } from './catalog-contract.registry';

const CATALOG_SCHEMA_BY_DOCUMENT_TYPE = new Map<string, Set<string>>([
  ['service_profile', new Set(['service-profile.v2'])],
  ['infrastructure_profile', new Set(['infrastructure-profile.v2'])],
  ['gateway_route', new Set(['gateway-route.v1'])],
  ['fact_source_profile', new Set(['fact-source-profile.v2'])],
  ['query_profile_set', new Set(['query-profile-set.v1'])],
  ['known_root_cause', new Set(['known-root-cause.v1'])],
]);

const REFERENCE_FIELDS_BY_SCHEMA = new Map<string, readonly string[]>([
  [
    'service_profile\0service-profile.v2',
    [
      'fact_sources',
      'query_profile_refs',
      'environments.{environment}.gateway_routes',
    ],
  ],
  [
    'infrastructure_profile\0infrastructure-profile.v2',
    [
      'fact_sources',
      'query_profile_refs',
      'gateway_observability.*.query_profile_id',
    ],
  ],
  [
    'gateway_route\0gateway-route.v1',
    [
      'fact_sources',
      'gateway_observability.gateway_profile',
      'gateway_observability.*.query_profile_id',
      'backend_services (reverse validation)',
    ],
  ],
  [
    'fact_source_profile\0fact-source-profile.v2',
    [
      'fact_sources',
      'default_query_profile_refs',
      'query_profile_set_refs (reverse validation)',
    ],
  ],
  [
    'query_profile_set\0query-profile-set.v1',
    ['fact_sources', 'fact_source', 'query_profiles'],
  ],
  [
    'known_root_cause\0known-root-cause.v1',
    ['affected_entities (reverse candidate discovery)'],
  ],
]);

const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,511}$/;
const YAML_FENCE_PATTERN = /^ {0,3}```yaml[ \t]*$/i;
const FENCE_CLOSE_PATTERN = /^ {0,3}```[ \t]*$/;

export type CatalogV2Graph = {
  roots: CatalogRootResult[];
  knownRootCauseCandidates: CatalogKnownRootCauseCandidateV2[];
  pages: CatalogPageV2[];
  edges: CatalogEdgeV2[];
  unresolvedReferences: CatalogUnresolvedReferenceV2[];
  closureStatus: CatalogClosureStatusV2;
  closureComplete: boolean;
};

@Injectable()
export class CatalogV2ContractRegistry {
  constructor(private readonly legacyRegistry: CatalogContractRegistry) {}

  parseFirstYamlBlock(markdown: string): JsonObject | null {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const openingIndex = lines.findIndex((line) =>
      YAML_FENCE_PATTERN.test(line),
    );
    if (openingIndex < 0) return null;
    const closingOffset = lines
      .slice(openingIndex + 1)
      .findIndex((line) => FENCE_CLOSE_PATTERN.test(line));
    if (closingOffset < 0) {
      throw new BadRequestException(
        'Catalog page YAML block is missing its closing fence',
      );
    }
    const closingIndex = openingIndex + closingOffset + 1;
    return this.parseYaml(
      lines.slice(openingIndex + 1, closingIndex).join('\n'),
    );
  }

  hasYamlFence(markdown: string): boolean {
    return markdown
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .some((line) => YAML_FENCE_PATTERN.test(line));
  }

  isSupportedDocument(frontMatter: JsonObject): boolean {
    const documentType = this.canonicalString(frontMatter.document_type);
    const schemaVersion = this.canonicalString(frontMatter.schema_version);
    const entityId = this.canonicalString(frontMatter.entity_id);
    return Boolean(
      documentType &&
      schemaVersion &&
      entityId &&
      ENTITY_ID_PATTERN.test(entityId) &&
      CATALOG_SCHEMA_BY_DOCUMENT_TYPE.get(documentType)?.has(schemaVersion) &&
      REFERENCE_FIELDS_BY_SCHEMA.has(
        this.schemaKey(documentType, schemaVersion),
      ),
    );
  }

  referenceFieldsFor(
    documentType: string,
    schemaVersion: string,
  ): readonly string[] | undefined {
    return REFERENCE_FIELDS_BY_SCHEMA.get(
      this.schemaKey(documentType, schemaVersion),
    );
  }

  buildGraph(opts: {
    pages: CatalogPageV2[];
    roots: CatalogRootSelector[];
    environment: string;
    malformedPageIds?: ReadonlySet<string>;
    invalidYamlPageIds?: ReadonlySet<string>;
  }): CatalogV2Graph {
    const malformedPageIds = new Set(opts.malformedPageIds ?? []);
    const invalidYamlPageIds = new Set(opts.invalidYamlPageIds ?? []);
    // The v1 graph walker remains useful for traversal, but v2 owns document
    // identity. Mask unsupported identities before handing pages to the v1
    // walker so a category page or template can never become a v2 root.
    const legacyPages = opts.pages.map(
      ({ fetched_at: _fetchedAt, ...page }) => {
        if (this.isSupportedDocument(page.front_matter)) {
          return page as CatalogPage;
        }
        return {
          ...page,
          front_matter: {
            document_type: page.front_matter.document_type,
            schema_version: '__unsupported_by_catalog_v2__',
            entity_id: page.front_matter.entity_id,
          },
        } as CatalogPage;
      },
    );
    const legacyGraph = this.legacyRegistry.buildBundleGraph({
      pages: legacyPages,
      roots: opts.roots,
      environment: opts.environment,
      malformedPageIds,
    });
    const pageById = new Map(opts.pages.map((page) => [page.page_id, page]));
    const unsupportedIdentityKeys = new Set(
      opts.pages
        .filter((page) => !this.isSupportedDocument(page.front_matter))
        .map((page) => this.identityFrom(page.front_matter))
        .filter(
          (identity): identity is { documentType: string; entityId: string } =>
            Boolean(identity),
        )
        .map((identity) => this.identityKey(identity)),
    );
    const unresolvedReferences = legacyGraph.unresolvedReferences.map(
      (reference): CatalogUnresolvedReferenceV2 => {
        const targetKey =
          reference.target.document_type && reference.target.entity_id
            ? this.identityKey({
                documentType: reference.target.document_type,
                entityId: reference.target.entity_id,
              })
            : undefined;
        return {
          ...reference,
          reason:
            reference.reason === 'missing_or_not_accessible' &&
            targetKey &&
            unsupportedIdentityKeys.has(targetKey)
              ? 'unsupported_catalog_document'
              : reference.reason,
        };
      },
    );

    const rootTargets = new Map<string, { pageId: string; entityId: string }>();
    for (const root of legacyGraph.roots) {
      if (root.status !== 'resolved') continue;
      rootTargets.set(root.entity_id, {
        pageId: root.page_id,
        entityId: root.entity_id,
      });
    }
    const candidates = this.discoverKnownRootCauses(
      opts.pages,
      rootTargets,
      opts.environment,
    );
    const closurePages = new Map<string, CatalogPageV2>();
    for (const page of legacyGraph.pages) {
      const fullPage = pageById.get(page.page_id);
      if (fullPage) closurePages.set(fullPage.page_id, fullPage);
    }
    for (const candidate of candidates) {
      const page = pageById.get(candidate.page_id);
      if (page) closurePages.set(page.page_id, page);
    }

    const edges = new Map<string, CatalogEdgeV2>();
    for (const edge of legacyGraph.edges) {
      edges.set(this.canonicalJson(edge), edge as CatalogEdgeV2);
    }
    for (const candidate of candidates) {
      for (const affectedEntity of candidate.affected_entities) {
        const target = rootTargets.get(affectedEntity);
        if (!target) continue;
        const edge: CatalogEdgeV2 = {
          from_page_id: candidate.page_id,
          to_page_id: target.pageId,
          relation: 'known_root_cause.affected_entities',
          target: {
            document_type: this.rootDocumentType(
              legacyGraph.roots,
              target.pageId,
            ),
            entity_id: affectedEntity,
          },
        };
        edges.set(this.canonicalJson(edge), edge);
      }
    }

    const pages = [...closurePages.values()].sort((left, right) =>
      this.compare(left.page_id, right.page_id),
    );
    const sortedEdges = this.sortCanonical([...edges.values()]);
    const sortedUnresolved = this.sortCanonical(unresolvedReferences);
    const referenceFieldsScanned = pages.every((page) => {
      const documentType = this.canonicalString(
        page.front_matter.document_type,
      );
      const schemaVersion = this.canonicalString(
        page.front_matter.schema_version,
      );
      return Boolean(
        documentType &&
        schemaVersion &&
        this.referenceFieldsFor(documentType, schemaVersion),
      );
    });
    const closureStatus: CatalogClosureStatusV2 = {
      roots_resolved: legacyGraph.roots.every(
        (root) => root.status === 'resolved',
      ),
      reference_fields_scanned: referenceFieldsScanned,
      required_targets_resolved: sortedUnresolved.length === 0,
      unresolved_references_empty: sortedUnresolved.length === 0,
      known_root_cause_discovery_complete: invalidYamlPageIds.size === 0,
    };
    const closureComplete = Object.values(closureStatus).every(Boolean);

    return {
      roots: this.sortCanonical(legacyGraph.roots),
      knownRootCauseCandidates: candidates,
      pages,
      edges: sortedEdges,
      unresolvedReferences: sortedUnresolved,
      closureStatus,
      closureComplete,
    };
  }

  computeBundleFingerprint(input: {
    catalogRootPageId: string;
    environment: string;
    roots: CatalogRootResult[];
    knownRootCauseCandidates: CatalogKnownRootCauseCandidateV2[];
    pages: CatalogPageManifestItem[];
    edges: CatalogEdgeV2[];
    unresolvedReferences: CatalogUnresolvedReferenceV2[];
    closureStatus: CatalogClosureStatusV2;
  }): string {
    return this.sha256(
      this.canonicalJson({
        contract: 'qts-fact-catalog.v1',
        schema_version: CATALOG_BUNDLE_V2_SCHEMA_VERSION,
        catalog_root_page_id: input.catalogRootPageId,
        environment: input.environment,
        roots: this.sortCanonical(input.roots),
        known_root_cause_candidates: this.sortCanonical(
          input.knownRootCauseCandidates,
        ),
        page_manifest: this.sortCanonical(input.pages),
        edges: this.sortCanonical(input.edges),
        unresolved_references: this.sortCanonical(input.unresolvedReferences),
        closure_status: input.closureStatus,
        reference_extractor_version: CATALOG_REFERENCE_EXTRACTOR_VERSION,
      }),
    );
  }

  pageManifest(pages: CatalogPageV2[]): CatalogPageManifestItem[] {
    return pages
      .map((page) => ({
        page_id: page.page_id,
        updated_at: page.updated_at,
        content_sha256: page.content_sha256,
      }))
      .sort((left, right) => this.compare(left.page_id, right.page_id));
  }

  canonicalRequestedRoots(
    roots: CatalogRootSelector[],
  ): CatalogRootSelectorOutput[] {
    const unique = new Map<string, CatalogRootSelectorOutput>();
    for (const root of roots) {
      const output: CatalogRootSelectorOutput =
        'pageId' in root
          ? { page_id: root.pageId }
          : {
              document_type: root.documentType,
              entity_id: root.entityId,
            };
      unique.set(this.canonicalJson(output), output);
    }
    return this.sortCanonical([...unique.values()]);
  }

  sha256(value: string): string {
    return this.legacyRegistry.sha256(value);
  }

  canonicalJson(value: unknown): string {
    return this.legacyRegistry.stableStringify(value);
  }

  private parseYaml(source: string): JsonObject {
    const document = parseDocument(source, {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      customTags: [],
    });
    let containsAlias = false;
    visit(document, (_key, node) => {
      if (isAlias(node)) {
        containsAlias = true;
        return visit.BREAK;
      }
      return undefined;
    });
    if (
      containsAlias ||
      document.errors.length > 0 ||
      document.warnings.length > 0
    ) {
      throw new BadRequestException('Catalog page YAML block is invalid');
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    } catch {
      throw new BadRequestException('Catalog page YAML block is invalid');
    }
    if (!this.isJsonObject(value)) {
      throw new BadRequestException(
        'Catalog page YAML block must contain an object',
      );
    }
    this.assertJsonValue(value);
    return value;
  }

  private discoverKnownRootCauses(
    pages: CatalogPageV2[],
    rootTargets: ReadonlyMap<string, { pageId: string; entityId: string }>,
    environment: string,
  ): CatalogKnownRootCauseCandidateV2[] {
    const candidates: CatalogKnownRootCauseCandidateV2[] = [];
    for (const page of pages) {
      const matter = page.front_matter;
      if (
        matter.document_type !== 'known_root_cause' ||
        matter.schema_version !== 'known-root-cause.v1' ||
        matter.status !== 'active' ||
        !this.isJsonObject(matter.verification) ||
        matter.verification.status !== 'confirmed'
      ) {
        continue;
      }
      const identity = this.identityFrom(matter);
      const affectedEntities = this.affectedEntities(matter.affected_entities);
      const environmentScope = this.environmentScope(matter.environment_scope);
      if (!identity || !affectedEntities || !environmentScope) continue;
      if (
        !environmentScope.includes(environment) &&
        !environmentScope.includes('*') &&
        !environmentScope.includes('all')
      ) {
        continue;
      }
      const matched = affectedEntities.filter((entityId) =>
        rootTargets.has(entityId),
      );
      if (matched.length === 0) continue;
      candidates.push({
        page_id: page.page_id,
        document_type: 'known_root_cause',
        entity_id: identity.entityId,
        affected_entities: affectedEntities,
        environment_scope: environmentScope,
        selection_reason: `active confirmed candidate for ${matched.join(', ')} in ${environment}`,
      });
    }
    return this.sortCanonical(candidates);
  }

  private affectedEntities(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const entities = value.map((item) =>
      typeof item === 'string'
        ? this.canonicalString(item)
        : this.isJsonObject(item)
          ? this.canonicalString(item.entity_id)
          : undefined,
    );
    if (entities.some((entity) => !entity)) return null;
    return [...new Set(entities as string[])].sort((left, right) =>
      this.compare(left, right),
    );
  }

  private environmentScope(value: unknown): string[] | null {
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values)) return null;
    const environments = values.map((item) => this.canonicalString(item));
    if (environments.some((item) => !item)) return null;
    return [...new Set(environments as string[])].sort((left, right) =>
      this.compare(left, right),
    );
  }

  private identityFrom(
    frontMatter: JsonObject,
  ): { documentType: string; entityId: string } | null {
    const documentType = this.canonicalString(frontMatter.document_type);
    const entityId = this.canonicalString(frontMatter.entity_id);
    return documentType && entityId && ENTITY_ID_PATTERN.test(entityId)
      ? { documentType, entityId }
      : null;
  }

  private rootDocumentType(roots: CatalogRootResult[], pageId: string): string {
    return (
      (
        roots.find(
          (root) => root.status === 'resolved' && root.page_id === pageId,
        ) as Extract<CatalogRootResult, { status: 'resolved' }> | undefined
      )?.document_type ?? 'unknown'
    );
  }

  private identityKey(identity: {
    documentType: string;
    entityId: string;
  }): string {
    return `${identity.documentType}\u0000${identity.entityId}`;
  }

  private schemaKey(documentType: string, schemaVersion: string): string {
    return `${documentType}\u0000${schemaVersion}`;
  }

  private canonicalString(value: unknown): string | undefined {
    return typeof value === 'string' &&
      value.length > 0 &&
      value === value.trim()
      ? value
      : undefined;
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private assertJsonValue(value: unknown, depth = 0): void {
    if (depth > 100) {
      throw new BadRequestException('Catalog page YAML block is too deep');
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.assertJsonValue(item, depth + 1));
      return;
    }
    if (this.isJsonObject(value)) {
      Object.values(value).forEach((item) =>
        this.assertJsonValue(item, depth + 1),
      );
      return;
    }
    throw new BadRequestException(
      'Catalog page YAML block contains a non-JSON value',
    );
  }

  private sortCanonical<T>(items: T[]): T[] {
    return [...items].sort((left, right) =>
      this.compare(this.canonicalJson(left), this.canonicalJson(right)),
    );
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
