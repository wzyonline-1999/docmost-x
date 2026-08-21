import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { JsonObject } from '@docmost/db/types/db';
import { isAlias, parseDocument, visit } from 'yaml';
import {
  CatalogEdge,
  CatalogPage,
  CatalogPageManifestItem,
  CatalogRootResult,
  CatalogUnresolvedReference,
  QTS_FACT_CATALOG_CONTRACT,
} from '../types/mcp-catalog.types';

type CatalogIdentity = {
  documentType: string;
  entityId: string;
};

type CatalogReference = {
  relation: string;
  targetDocumentType?: string;
  targetEntityId?: string;
  queryProfileId?: string;
  invalid?: boolean;
};

type ParsedCatalogPage = CatalogPage & {
  identity: CatalogIdentity;
};

type CatalogIndexes = {
  byPageId: Map<string, ParsedCatalogPage>;
  byIdentity: Map<string, ParsedCatalogPage[]>;
  queryProfileOwners: Map<string, ParsedCatalogPage[]>;
};

const CATALOG_SCHEMA_BY_DOCUMENT_TYPE = new Map<string, Set<string>>([
  ['service_profile', new Set(['service-profile.v2'])],
  ['infrastructure_profile', new Set(['infrastructure-profile.v2'])],
  ['gateway_route', new Set(['gateway-route.v1'])],
  ['fact_source_profile', new Set(['fact-source-profile.v2'])],
  ['query_profile_set', new Set(['query-profile-set.v1'])],
  ['known_root_cause', new Set(['known-root-cause.v1'])],
]);

@Injectable()
export class CatalogContractRegistry {
  parseFrontMatter(markdown: string): JsonObject | null {
    const normalized = markdown.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (lines[0] !== '---') {
      return null;
    }

    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && line === '---',
    );
    if (closingIndex < 0) {
      throw new BadRequestException(
        'Catalog page front matter is missing its closing delimiter',
      );
    }

    const source = lines.slice(1, closingIndex).join('\n');
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
      throw new BadRequestException('Catalog page front matter is invalid');
    }

    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    } catch {
      throw new BadRequestException('Catalog page front matter is invalid');
    }

    if (!this.isJsonObject(value)) {
      throw new BadRequestException(
        'Catalog page front matter must contain an object',
      );
    }
    this.assertJsonValue(value);
    return value;
  }

  isSupportedFrontMatter(frontMatter: JsonObject): boolean {
    const documentType = this.canonicalString(frontMatter.document_type);
    const schemaVersion = this.canonicalString(frontMatter.schema_version);
    const entityId = this.canonicalString(frontMatter.entity_id);
    return Boolean(
      documentType &&
      schemaVersion &&
      entityId &&
      CATALOG_SCHEMA_BY_DOCUMENT_TYPE.get(documentType)?.has(schemaVersion),
    );
  }

  buildBundleGraph(opts: {
    pages: CatalogPage[];
    roots: Array<
      { pageId: string } | { documentType: string; entityId: string }
    >;
    environment: string;
    malformedPageIds?: ReadonlySet<string>;
  }): {
    roots: CatalogRootResult[];
    pages: CatalogPage[];
    edges: CatalogEdge[];
    unresolvedReferences: CatalogUnresolvedReference[];
  } {
    const parsedPages = opts.pages
      .filter((page) => this.isSupportedFrontMatter(page.front_matter))
      .map((page) => ({
        ...page,
        identity: {
          documentType: String(page.front_matter.document_type),
          entityId: String(page.front_matter.entity_id),
        },
      }));
    const indexes = this.buildIndexes(parsedPages);
    const malformedPageIds = new Set(opts.malformedPageIds ?? []);
    const unsupportedPages = opts.pages.filter(
      (page) =>
        !this.isSupportedFrontMatter(page.front_matter) &&
        !malformedPageIds.has(page.page_id),
    );
    const unsupportedPageIds = new Set(
      unsupportedPages.map((page) => page.page_id),
    );
    const unsupportedIdentityKeys = new Set(
      unsupportedPages
        .map((page) => {
          const documentType = this.canonicalString(
            page.front_matter.document_type,
          );
          const entityId = this.canonicalString(page.front_matter.entity_id);
          return documentType && entityId
            ? this.identityKey({ documentType, entityId })
            : undefined;
        })
        .filter((key): key is string => Boolean(key)),
    );
    const roots = this.resolveRoots(
      opts.roots,
      indexes,
      malformedPageIds,
      unsupportedPageIds,
      unsupportedIdentityKeys,
    );
    const closure = new Map<string, ParsedCatalogPage>();
    const queue = roots
      .filter(
        (root): root is Extract<CatalogRootResult, { status: 'resolved' }> =>
          root.status === 'resolved',
      )
      .map((root) => indexes.byPageId.get(root.page_id))
      .filter((page): page is ParsedCatalogPage => Boolean(page));
    const edges = new Map<string, CatalogEdge>();
    const unresolved = new Map<string, CatalogUnresolvedReference>();

    while (queue.length > 0) {
      const page = queue.shift();
      if (!page || closure.has(page.page_id)) continue;
      closure.set(page.page_id, page);

      for (const reference of this.extractReferences(
        page.front_matter,
        opts.environment,
      )) {
        const resolved = this.resolveReference(reference, indexes);
        if (reference.invalid) {
          this.addUnresolved(unresolved, {
            from_page_id: page.page_id,
            relation: reference.relation,
            target: this.referenceTarget(reference),
            reason: 'invalid_reference',
          });
          continue;
        }
        if (resolved.length === 0) {
          this.addUnresolved(unresolved, {
            from_page_id: page.page_id,
            relation: reference.relation,
            target: this.referenceTarget(reference),
            reason: 'missing_or_not_accessible',
          });
          continue;
        }
        if (resolved.length > 1) {
          this.addUnresolved(unresolved, {
            from_page_id: page.page_id,
            relation: reference.relation,
            target: this.referenceTarget(reference),
            reason: 'ambiguous_identity',
          });
          continue;
        }

        const target = resolved[0];
        this.addEdge(edges, {
          from_page_id: page.page_id,
          to_page_id: target.page_id,
          relation: reference.relation,
          target: this.referenceTarget(reference),
        });
        if (!closure.has(target.page_id)) queue.push(target);
      }
    }

    this.addReverseValidationEdges(closure, indexes, edges, unresolved);

    return {
      roots: this.sortCanonical(roots),
      pages: [...closure.values()]
        .map(({ identity: _identity, ...page }) => page)
        .sort((a, b) =>
          a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0,
        ),
      edges: this.sortCanonical([...edges.values()]),
      unresolvedReferences: this.sortCanonical([...unresolved.values()]),
    };
  }

  computeBundleFingerprint(input: {
    catalogRootPageId: string;
    environment: string;
    roots: CatalogRootResult[];
    pages: CatalogPageManifestItem[];
    edges: CatalogEdge[];
    unresolvedReferences: CatalogUnresolvedReference[];
  }): string {
    return this.sha256(
      this.stableStringify({
        contract: QTS_FACT_CATALOG_CONTRACT,
        catalog_root_page_id: input.catalogRootPageId,
        environment: input.environment,
        roots: this.sortCanonical(input.roots),
        pages: this.sortCanonical(input.pages),
        edges: this.sortCanonical(input.edges),
        unresolved_references: this.sortCanonical(input.unresolvedReferences),
      }),
    );
  }

  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.stableStringify(objectValue[key])}`,
      )
      .join(',')}}`;
  }

  private buildIndexes(pages: ParsedCatalogPage[]): CatalogIndexes {
    const byPageId = new Map<string, ParsedCatalogPage>();
    const byIdentity = new Map<string, ParsedCatalogPage[]>();
    const queryProfileOwners = new Map<string, ParsedCatalogPage[]>();

    for (const page of pages) {
      byPageId.set(page.page_id, page);
      const identityKey = this.identityKey(page.identity);
      const identityPages = byIdentity.get(identityKey) ?? [];
      identityPages.push(page);
      byIdentity.set(identityKey, identityPages);

      if (page.identity.documentType !== 'query_profile_set') continue;
      const profiles = page.front_matter.query_profiles;
      if (!Array.isArray(profiles)) continue;
      for (const profile of profiles) {
        if (!this.isJsonObject(profile)) continue;
        const profileId = this.canonicalString(profile.query_profile_id);
        if (!profileId) continue;
        const owners = queryProfileOwners.get(profileId) ?? [];
        owners.push(page);
        queryProfileOwners.set(profileId, owners);
      }
    }

    return { byPageId, byIdentity, queryProfileOwners };
  }

  private resolveRoots(
    selectors: Array<
      { pageId: string } | { documentType: string; entityId: string }
    >,
    indexes: CatalogIndexes,
    malformedPageIds: Set<string>,
    unsupportedPageIds: Set<string>,
    unsupportedIdentityKeys: Set<string>,
  ): CatalogRootResult[] {
    const deduplicated = new Map<string, (typeof selectors)[number]>();
    for (const selector of selectors) {
      deduplicated.set(this.stableStringify(selector), selector);
    }

    return [...deduplicated.values()].map((selector) => {
      if ('pageId' in selector) {
        const outputSelector = { page_id: selector.pageId } as const;
        const page = indexes.byPageId.get(selector.pageId);
        if (page) return this.resolvedRoot(outputSelector, page);
        return {
          selector: outputSelector,
          status: 'unresolved',
          reason: malformedPageIds.has(selector.pageId)
            ? 'malformed_catalog_page'
            : unsupportedPageIds.has(selector.pageId)
              ? 'unsupported_catalog_document'
              : 'missing_or_not_accessible',
        };
      }

      const outputSelector = {
        document_type: selector.documentType,
        entity_id: selector.entityId,
      } as const;
      const matches =
        indexes.byIdentity.get(
          this.identityKey({
            documentType: selector.documentType,
            entityId: selector.entityId,
          }),
        ) ?? [];
      const identityKey = this.identityKey({
        documentType: selector.documentType,
        entityId: selector.entityId,
      });
      if (matches.length === 1) {
        return this.resolvedRoot(outputSelector, matches[0]);
      }
      return {
        selector: outputSelector,
        status: 'unresolved',
        reason:
          matches.length > 1
            ? 'ambiguous_identity'
            : unsupportedIdentityKeys.has(identityKey)
              ? 'unsupported_catalog_document'
              : CATALOG_SCHEMA_BY_DOCUMENT_TYPE.has(selector.documentType)
                ? 'missing_or_not_accessible'
                : 'unsupported_catalog_document',
      };
    });
  }

  private resolvedRoot(
    selector: CatalogRootResult['selector'],
    page: ParsedCatalogPage,
  ): CatalogRootResult {
    return {
      selector,
      status: 'resolved',
      page_id: page.page_id,
      document_type: page.identity.documentType,
      entity_id: page.identity.entityId,
    };
  }

  private extractReferences(
    frontMatter: JsonObject,
    environment: string,
  ): CatalogReference[] {
    const references: CatalogReference[] = [];
    this.pushIdentityArrayReferences(
      references,
      frontMatter.fact_sources,
      'fact_sources',
      'fact_source_profile',
    );

    const documentType = this.canonicalString(frontMatter.document_type);
    if (documentType === 'service_profile') {
      const environments = frontMatter.environments;
      if (this.isJsonObject(environments)) {
        const environmentConfig = environments[environment];
        if (this.isJsonObject(environmentConfig)) {
          this.pushIdentityArrayReferences(
            references,
            environmentConfig.gateway_routes,
            `environments.${environment}.gateway_routes`,
            'gateway_route',
          );
        }
      }
    }

    if (
      documentType === 'service_profile' ||
      documentType === 'infrastructure_profile'
    ) {
      this.pushQueryProfileReferences(
        references,
        frontMatter.query_profile_refs,
        'query_profile_refs',
      );
    }

    if (documentType === 'fact_source_profile') {
      // query_profile_set_refs is an index; actual profile IDs select the set.
      this.pushDefaultQueryProfileReferences(
        references,
        frontMatter.default_query_profile_refs,
      );
    }

    if (documentType === 'query_profile_set') {
      if (frontMatter.fact_source === undefined) {
        references.push({
          relation: 'query_profile_set.fact_source',
          targetDocumentType: 'fact_source_profile',
          invalid: true,
        });
      } else {
        this.pushSingleIdentityReference(
          references,
          frontMatter.fact_source,
          'query_profile_set.fact_source',
          'fact_source_profile',
        );
      }
    }

    if (
      documentType === 'gateway_route' ||
      documentType === 'infrastructure_profile'
    ) {
      const gatewayObservability = frontMatter.gateway_observability;
      if (this.isJsonObject(gatewayObservability)) {
        if (documentType === 'gateway_route') {
          this.pushSingleIdentityReference(
            references,
            gatewayObservability.gateway_profile,
            'gateway_observability.gateway_profile',
            'infrastructure_profile',
          );
        }
        this.collectGatewayQueryProfileReferences(
          references,
          gatewayObservability,
          'gateway_observability',
        );
      }
    }

    return references;
  }

  private addReverseValidationEdges(
    closure: Map<string, ParsedCatalogPage>,
    indexes: CatalogIndexes,
    edges: Map<string, CatalogEdge>,
    unresolved: Map<string, CatalogUnresolvedReference>,
  ): void {
    for (const edge of [...edges.values()]) {
      if (
        !edge.relation.startsWith('environments.') ||
        !edge.relation.endsWith('.gateway_routes')
      ) {
        continue;
      }
      const service = closure.get(edge.from_page_id);
      const route = closure.get(edge.to_page_id);
      if (!service || !route) continue;
      const backendServices = this.canonicalStringArray(
        route.front_matter.backend_services,
      );
      if (!backendServices?.includes(service.identity.entityId)) {
        this.addUnresolved(unresolved, {
          from_page_id: route.page_id,
          relation: 'gateway_route.backend_services',
          target: {
            document_type: 'service_profile',
            entity_id: service.identity.entityId,
          },
          reason: 'reverse_validation_failed',
        });
        continue;
      }
      this.addEdge(edges, {
        from_page_id: route.page_id,
        to_page_id: service.page_id,
        relation: 'gateway_route.backend_services',
        target: {
          document_type: 'service_profile',
          entity_id: service.identity.entityId,
        },
      });
    }

    for (const page of closure.values()) {
      if (page.identity.documentType !== 'query_profile_set') continue;
      const factSourceId = this.canonicalString(page.front_matter.fact_source);
      if (!factSourceId) continue;
      const sources =
        indexes.byIdentity.get(
          this.identityKey({
            documentType: 'fact_source_profile',
            entityId: factSourceId,
          }),
        ) ?? [];
      if (sources.length !== 1 || !closure.has(sources[0].page_id)) {
        continue;
      }
      const source = sources[0];
      const setRefs = source.front_matter.query_profile_set_refs;
      const matchingRef = Array.isArray(setRefs)
        ? setRefs.find(
            (item) =>
              this.isJsonObject(item) &&
              item.entity_id === page.identity.entityId,
          )
        : undefined;
      if (!this.isJsonObject(matchingRef)) {
        this.addUnresolved(unresolved, {
          from_page_id: page.page_id,
          relation: 'query_profile_set.fact_source',
          target: {
            document_type: 'fact_source_profile',
            entity_id: factSourceId,
          },
          reason: 'reverse_validation_failed',
        });
        continue;
      }
      const indexedProfileIds = this.canonicalStringArray(
        matchingRef.query_profile_ids,
      );
      const profileIds = Array.isArray(page.front_matter.query_profiles)
        ? page.front_matter.query_profiles
            .filter((item): item is JsonObject => this.isJsonObject(item))
            .map((item) => this.canonicalString(item.query_profile_id))
            .filter((item): item is string => Boolean(item))
        : null;
      if (
        !indexedProfileIds ||
        !profileIds ||
        this.stableStringify([...indexedProfileIds].sort()) !==
          this.stableStringify([...profileIds].sort())
      ) {
        this.addUnresolved(unresolved, {
          from_page_id: source.page_id,
          relation: 'query_profile_set_refs.query_profile_ids',
          target: {
            document_type: 'query_profile_set',
            entity_id: page.identity.entityId,
          },
          reason: 'reverse_validation_failed',
        });
      }
    }
  }

  private pushIdentityArrayReferences(
    references: CatalogReference[],
    value: unknown,
    relation: string,
    targetDocumentType: string,
  ): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      references.push({ relation, targetDocumentType, invalid: true });
      return;
    }
    for (const item of value) {
      const entityId =
        this.canonicalString(item) ??
        (this.isJsonObject(item)
          ? this.canonicalString(item.entity_id)
          : undefined);
      references.push({
        relation,
        targetDocumentType,
        targetEntityId: entityId,
        invalid: !entityId,
      });
    }
  }

  private pushSingleIdentityReference(
    references: CatalogReference[],
    value: unknown,
    relation: string,
    targetDocumentType: string,
  ): void {
    if (value === undefined) return;
    const entityId =
      this.canonicalString(value) ??
      (this.isJsonObject(value)
        ? this.canonicalString(value.entity_id)
        : undefined);
    references.push({
      relation,
      targetDocumentType,
      targetEntityId: entityId,
      invalid: !entityId,
    });
  }

  private pushQueryProfileReferences(
    references: CatalogReference[],
    value: unknown,
    relation: string,
  ): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      references.push({
        relation,
        targetDocumentType: 'query_profile_set',
        invalid: true,
      });
      return;
    }
    for (const item of value) {
      const profileId = this.isJsonObject(item)
        ? this.canonicalString(item.query_profile_id)
        : this.canonicalString(item);
      references.push({
        relation,
        targetDocumentType: 'query_profile_set',
        queryProfileId: profileId,
        invalid: !profileId,
      });
    }
  }

  private pushDefaultQueryProfileReferences(
    references: CatalogReference[],
    value: unknown,
  ): void {
    if (value === undefined) return;
    if (!this.isJsonObject(value)) {
      references.push({
        relation: 'default_query_profile_refs',
        targetDocumentType: 'query_profile_set',
        invalid: true,
      });
      return;
    }
    for (const [ownerType, profileIds] of Object.entries(value)) {
      if (!Array.isArray(profileIds)) {
        references.push({
          relation: `default_query_profile_refs.${ownerType}`,
          targetDocumentType: 'query_profile_set',
          invalid: true,
        });
        continue;
      }
      for (const profileIdValue of profileIds) {
        const profileId = this.canonicalString(profileIdValue);
        references.push({
          relation: `default_query_profile_refs.${ownerType}`,
          targetDocumentType: 'query_profile_set',
          queryProfileId: profileId,
          invalid: !profileId,
        });
      }
    }
  }

  private collectGatewayQueryProfileReferences(
    references: CatalogReference[],
    value: JsonObject,
    path: string,
  ): void {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === 'query_profile_id') {
        const profileId = this.canonicalString(child);
        references.push({
          relation: childPath,
          targetDocumentType: 'query_profile_set',
          queryProfileId: profileId,
          invalid: !profileId,
        });
      } else if (this.isJsonObject(child)) {
        this.collectGatewayQueryProfileReferences(references, child, childPath);
      } else if (Array.isArray(child)) {
        child.forEach((item, index) => {
          if (this.isJsonObject(item)) {
            this.collectGatewayQueryProfileReferences(
              references,
              item,
              `${childPath}[${index}]`,
            );
          }
        });
      }
    }
  }

  private resolveReference(
    reference: CatalogReference,
    indexes: CatalogIndexes,
  ): ParsedCatalogPage[] {
    if (reference.invalid) return [];
    if (reference.queryProfileId) {
      return indexes.queryProfileOwners.get(reference.queryProfileId) ?? [];
    }
    if (reference.targetDocumentType && reference.targetEntityId) {
      return (
        indexes.byIdentity.get(
          this.identityKey({
            documentType: reference.targetDocumentType,
            entityId: reference.targetEntityId,
          }),
        ) ?? []
      );
    }
    return [];
  }

  private referenceTarget(reference: CatalogReference): CatalogEdge['target'] {
    if (!reference.targetDocumentType) {
      throw new BadRequestException(
        'Catalog reference target document type is missing',
      );
    }
    return {
      document_type: reference.targetDocumentType,
      ...(reference.targetEntityId
        ? { entity_id: reference.targetEntityId }
        : {}),
      ...(reference.queryProfileId
        ? { query_profile_id: reference.queryProfileId }
        : {}),
    };
  }

  private addEdge(edges: Map<string, CatalogEdge>, edge: CatalogEdge): void {
    edges.set(this.stableStringify(edge), edge);
  }

  private addUnresolved(
    unresolved: Map<string, CatalogUnresolvedReference>,
    reference: CatalogUnresolvedReference,
  ): void {
    unresolved.set(this.stableStringify(reference), reference);
  }

  private identityKey(identity: CatalogIdentity): string {
    return `${identity.documentType}\u0000${identity.entityId}`;
  }

  private canonicalString(value: unknown): string | undefined {
    return typeof value === 'string' &&
      value.length > 0 &&
      value.trim() === value
      ? value
      : undefined;
  }

  private canonicalStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const values = value.map((item) => this.canonicalString(item));
    if (values.some((item) => !item)) return null;
    return values as string[];
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private assertJsonValue(value: unknown, depth = 0): void {
    if (depth > 100) {
      throw new BadRequestException('Catalog page front matter is too deep');
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
      'Catalog page front matter contains a non-JSON value',
    );
  }

  private sortCanonical<T>(items: T[]): T[] {
    return [...items].sort((left, right) => {
      const leftValue = this.stableStringify(left);
      const rightValue = this.stableStringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  }
}
