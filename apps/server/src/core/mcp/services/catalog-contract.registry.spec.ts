import { BadRequestException } from '@nestjs/common';
import type { JsonObject } from '@docmost/db/types/db';
import type {
  CatalogEdge,
  CatalogPage,
  CatalogRootResult,
  CatalogUnresolvedReference,
} from '../types/mcp-catalog.types';
import { CatalogContractRegistry } from './catalog-contract.registry';

describe('CatalogContractRegistry', () => {
  const registry = new CatalogContractRegistry();
  const updatedAt = '2026-08-20T00:00:00.000Z';
  const page = (
    id: string,
    frontMatter: JsonObject,
    markdown = `page:${id}`,
  ): CatalogPage => ({
    page_id: id,
    title: id,
    parent_page_id: null,
    space_id: 'space-1',
    updated_at: updatedAt,
    content_sha256: registry.sha256(markdown),
    front_matter: frontMatter,
    markdown,
  });

  it('strictly parses object YAML front matter', () => {
    expect(
      registry.parseFrontMatter(
        [
          '---',
          'document_type: service_profile',
          'schema_version: service-profile.v2',
          'entity_id: service/example',
          '---',
          '# Example',
        ].join('\n'),
      ),
    ).toMatchObject({
      document_type: 'service_profile',
      schema_version: 'service-profile.v2',
      entity_id: 'service/example',
    });
    expect(registry.parseFrontMatter('# no front matter')).toBeNull();
  });

  it.each([
    ['duplicate keys', '---\na: 1\na: 2\n---'],
    ['aliases', '---\na: &value 1\nb: *value\n---'],
    ['custom tags', '---\na: !unsafe value\n---'],
    ['non-object values', '---\n- a\n- b\n---'],
  ])('rejects %s', (_name, markdown) => {
    expect(() => registry.parseFrontMatter(markdown)).toThrow(
      BadRequestException,
    );
  });

  it('resolves the complete allowlisted reference closure with cycles', () => {
    const service = page('service-page', {
      document_type: 'service_profile',
      schema_version: 'service-profile.v2',
      entity_id: 'service/example',
      fact_sources: ['fact-source/prometheus'],
      environments: {
        prod: { gateway_routes: ['gateway-route/example'] },
      },
      query_profile_refs: [
        {
          fact_source: 'fact-source/prometheus',
          query_profile_id: 'prometheus.service.example.v1',
        },
      ],
    });
    const route = page('route-page', {
      document_type: 'gateway_route',
      schema_version: 'gateway-route.v1',
      entity_id: 'gateway-route/example',
      backend_services: ['service/example'],
      fact_sources: ['fact-source/prometheus'],
      gateway_observability: {
        gateway_profile: 'infrastructure/apisix-prod',
        prometheus: {
          query_profile_id: 'prometheus.service.example.v1',
        },
      },
    });
    const infrastructure = page('infrastructure-page', {
      document_type: 'infrastructure_profile',
      schema_version: 'infrastructure-profile.v2',
      entity_id: 'infrastructure/apisix-prod',
      fact_sources: ['fact-source/prometheus'],
    });
    const source = page('source-page', {
      document_type: 'fact_source_profile',
      schema_version: 'fact-source-profile.v2',
      entity_id: 'fact-source/prometheus',
      query_profile_set_refs: [
        {
          entity_id: 'query-profile-set/prometheus-service',
          query_profile_ids: ['prometheus.service.example.v1'],
        },
        {
          entity_id: 'query-profile-set/prometheus-unused',
          query_profile_ids: ['prometheus.service.unused.v1'],
        },
      ],
      default_query_profile_refs: {
        service_profile: ['prometheus.service.example.v1'],
      },
    });
    const profileSet = page('set-page', {
      document_type: 'query_profile_set',
      schema_version: 'query-profile-set.v1',
      entity_id: 'query-profile-set/prometheus-service',
      fact_source: 'fact-source/prometheus',
      query_profiles: [{ query_profile_id: 'prometheus.service.example.v1' }],
    });
    const unusedProfileSet = page('unused-set-page', {
      document_type: 'query_profile_set',
      schema_version: 'query-profile-set.v1',
      entity_id: 'query-profile-set/prometheus-unused',
      fact_source: 'fact-source/prometheus',
      query_profiles: [{ query_profile_id: 'prometheus.service.unused.v1' }],
    });

    const graph = registry.buildBundleGraph({
      pages: [
        profileSet,
        unusedProfileSet,
        route,
        source,
        service,
        infrastructure,
      ],
      roots: [{ documentType: 'service_profile', entityId: 'service/example' }],
      environment: 'prod',
    });

    expect(graph.pages.map((item) => item.page_id)).toEqual([
      'infrastructure-page',
      'route-page',
      'service-page',
      'set-page',
      'source-page',
    ]);
    expect(graph.pages.every((item) => !('identity' in item))).toBe(true);
    expect(graph.unresolvedReferences).toEqual([]);
    expect(graph.pages.map((item) => item.page_id)).not.toContain(
      'unused-set-page',
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_page_id: 'service-page',
          to_page_id: 'route-page',
          relation: 'environments.prod.gateway_routes',
        }),
        expect.objectContaining({
          from_page_id: 'route-page',
          to_page_id: 'service-page',
          relation: 'gateway_route.backend_services',
        }),
        expect.objectContaining({
          from_page_id: 'set-page',
          to_page_id: 'source-page',
          relation: 'query_profile_set.fact_source',
        }),
      ]),
    );
  });

  it('reports missing, ambiguous, malformed, unsupported, and reverse-invalid references', () => {
    const duplicateA = page('duplicate-a', {
      document_type: 'fact_source_profile',
      schema_version: 'fact-source-profile.v2',
      entity_id: 'fact-source/duplicate',
    });
    const duplicateB = page('duplicate-b', {
      document_type: 'fact_source_profile',
      schema_version: 'fact-source-profile.v2',
      entity_id: 'fact-source/duplicate',
    });
    const service = page('service-page', {
      document_type: 'service_profile',
      schema_version: 'service-profile.v2',
      entity_id: 'service/example',
      fact_sources: ['fact-source/duplicate', 'fact-source/missing'],
      environments: {
        prod: { gateway_routes: ['gateway-route/example'] },
      },
    });
    const route = page('route-page', {
      document_type: 'gateway_route',
      schema_version: 'gateway-route.v1',
      entity_id: 'gateway-route/example',
      backend_services: ['service/other'],
    });
    const malformed = page('malformed-page', {});
    const unsupported = page('unsupported-page', {
      document_type: 'service_profile',
      schema_version: 'service-profile.v99',
      entity_id: 'service/future',
    });

    const graph = registry.buildBundleGraph({
      pages: [duplicateA, service, route, malformed, unsupported, duplicateB],
      roots: [
        { pageId: 'service-page' },
        { pageId: 'malformed-page' },
        { pageId: 'unsupported-page' },
        { documentType: 'service_profile', entityId: 'service/future' },
      ],
      environment: 'prod',
      malformedPageIds: new Set(['malformed-page']),
    });

    expect(graph.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: { page_id: 'malformed-page' },
          status: 'unresolved',
          reason: 'malformed_catalog_page',
        }),
        expect.objectContaining({
          selector: { page_id: 'unsupported-page' },
          status: 'unresolved',
          reason: 'unsupported_catalog_document',
        }),
        expect.objectContaining({
          selector: {
            document_type: 'service_profile',
            entity_id: 'service/future',
          },
          status: 'unresolved',
          reason: 'unsupported_catalog_document',
        }),
      ]),
    );
    expect(graph.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'ambiguous_identity' }),
        expect.objectContaining({ reason: 'missing_or_not_accessible' }),
        expect.objectContaining({ reason: 'reverse_validation_failed' }),
      ]),
    );
  });

  it('produces the same fingerprint for differently ordered replicas', () => {
    const roots: CatalogRootResult[] = [
      {
        selector: {
          document_type: 'service_profile',
          entity_id: 'service/example',
        },
        status: 'resolved',
        page_id: 'page-a',
        document_type: 'service_profile',
        entity_id: 'service/example',
      },
    ];
    const pages = [
      {
        page_id: 'page-b',
        updated_at: updatedAt,
        content_sha256: 'b'.repeat(64),
      },
      {
        page_id: 'page-a',
        updated_at: updatedAt,
        content_sha256: 'a'.repeat(64),
      },
    ];
    const edges: CatalogEdge[] = [
      {
        from_page_id: 'page-a',
        to_page_id: 'page-b',
        relation: 'fact_sources',
        target: {
          document_type: 'fact_source_profile',
          entity_id: 'fact-source/example',
        },
      },
    ];
    const unresolved: CatalogUnresolvedReference[] = [];
    const first = registry.computeBundleFingerprint({
      catalogRootPageId: 'root',
      environment: 'prod',
      roots,
      pages,
      edges,
      unresolvedReferences: unresolved,
    });
    const second = registry.computeBundleFingerprint({
      catalogRootPageId: 'root',
      environment: 'prod',
      roots: [...roots].reverse(),
      pages: [...pages].reverse(),
      edges: [...edges].reverse(),
      unresolvedReferences: [...unresolved].reverse(),
    });

    expect(first).toBe(second);
  });

  it('marks a query profile set without its fact source as incomplete', () => {
    const profileSet = page('set-page', {
      document_type: 'query_profile_set',
      schema_version: 'query-profile-set.v1',
      entity_id: 'query-profile-set/prometheus-service',
      query_profiles: [{ query_profile_id: 'prometheus.service.v1' }],
    });

    const graph = registry.buildBundleGraph({
      pages: [profileSet],
      roots: [{ pageId: profileSet.page_id }],
      environment: 'prod',
    });

    expect(graph.unresolvedReferences).toEqual([
      expect.objectContaining({
        from_page_id: profileSet.page_id,
        relation: 'query_profile_set.fact_source',
        reason: 'invalid_reference',
      }),
    ]);
  });
});
