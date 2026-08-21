import { BadRequestException } from '@nestjs/common';
import type { JsonObject } from '@docmost/db/types/db';
import type { CatalogPageV2 } from '../types/mcp-catalog-v2.types';
import { CatalogContractRegistry } from './catalog-contract.registry';
import { CatalogV2ContractRegistry } from './catalog-v2-contract.registry';

const FETCHED_AT = '2026-08-21T00:00:01.000Z';
const UPDATED_AT = '2026-08-21T00:00:00.000Z';
const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const SET_ID = '33333333-3333-4333-8333-333333333333';
const KRC_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';

function fenced(frontMatter: string, body = '# Body'): string {
  return [`# Title`, '', '```yaml', frontMatter.trim(), '```', '', body].join(
    '\n',
  );
}

function page(id: string, markdown: string): CatalogPageV2 {
  const legacy = new CatalogContractRegistry();
  const registry = new CatalogV2ContractRegistry(legacy);
  let frontMatter: JsonObject = {};
  try {
    frontMatter = registry.parseFirstYamlBlock(markdown) ?? {};
  } catch {
    frontMatter = {};
  }
  return {
    page_id: id,
    title: id,
    parent_page_id: null,
    space_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    updated_at: UPDATED_AT,
    fetched_at: FETCHED_AT,
    content_sha256: registry.sha256(markdown),
    front_matter: frontMatter,
    markdown,
  };
}

function catalogPages(): CatalogPageV2[] {
  return [
    page(
      SERVICE_ID,
      fenced(`
document_type: service_profile
schema_version: service-profile.v2
entity_id: service/neptune
fact_sources:
  - fact-source/tencent-tke
query_profile_refs:
  - query_profile_id: tke.workloads.v1
`),
    ),
    page(
      SOURCE_ID,
      fenced(`
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/tencent-tke
query_profile_set_refs:
  - entity_id: query-profile-set/tencent-tke
    query_profile_ids:
      - tke.workloads.v1
default_query_profile_refs:
  service:
    - tke.workloads.v1
`),
    ),
    page(
      SET_ID,
      fenced(`
document_type: query_profile_set
schema_version: query-profile-set.v1
entity_id: query-profile-set/tencent-tke
fact_source: fact-source/tencent-tke
query_profiles:
  - query_profile_id: tke.workloads.v1
`),
    ),
    page(
      KRC_ID,
      fenced(`
document_type: known_root_cause
schema_version: known-root-cause.v1
entity_id: known-root-cause/neptune-tke-timeout
status: active
affected_entities:
  - service/neptune
environment_scope:
  - prod
verification:
  status: confirmed
`),
    ),
    page(
      CATEGORY_ID,
      [
        '# 07 已知事实',
        '',
        '这是分类页，不是具体 Catalog document。',
        '',
        '```yaml',
        'document_type: known_root_cause',
        'schema_version: known-root-cause.v1',
        'entity_id: <known-root-cause-id>',
        'status: active',
        '```',
      ].join('\n'),
    ),
  ];
}

describe('CatalogV2ContractRegistry', () => {
  let registry: CatalogV2ContractRegistry;

  beforeEach(() => {
    registry = new CatalogV2ContractRegistry(new CatalogContractRegistry());
  });

  it('parses only the first complete fenced YAML block after Markdown headings', () => {
    const markdown = [
      '# Service',
      '',
      '```yaml',
      'document_type: service_profile',
      'schema_version: service-profile.v2',
      'entity_id: service/neptune',
      '```',
      '',
      '```yaml',
      'document_type: known_root_cause',
      'schema_version: known-root-cause.v1',
      'entity_id: known-root-cause/example',
      '```',
    ].join('\n');

    expect(registry.parseFirstYamlBlock(markdown)).toEqual({
      document_type: 'service_profile',
      schema_version: 'service-profile.v2',
      entity_id: 'service/neptune',
    });
  });

  it('does not accept legacy front matter as a v2 Catalog document', () => {
    expect(
      registry.parseFirstYamlBlock(
        '---\ndocument_type: service_profile\nschema_version: service-profile.v2\nentity_id: service/neptune\n---',
      ),
    ).toBeNull();
  });

  it('binds every supported schema version to an explicit reference field set', () => {
    expect(
      registry.referenceFieldsFor('service_profile', 'service-profile.v2'),
    ).toEqual([
      'fact_sources',
      'query_profile_refs',
      'environments.{environment}.gateway_routes',
    ]);
    expect(
      registry.referenceFieldsFor('known_root_cause', 'known-root-cause.v1'),
    ).toEqual(['affected_entities (reverse candidate discovery)']);
    expect(
      registry.referenceFieldsFor('service_profile', 'service-profile.v99'),
    ).toBeUndefined();
  });

  it.each([
    '# Title\n```yaml\ndocument_type: service_profile',
    '# Title\n```yaml\na: 1\na: 2\n```',
    '# Title\n```yaml\na: *alias\n```',
  ])('rejects malformed or unsafe YAML blocks', (markdown) => {
    expect(() => registry.parseFirstYamlBlock(markdown)).toThrow(
      BadRequestException,
    );
  });

  it('resolves a multi-hop closure and discovers only confirmed matching KRC documents', () => {
    const graph = registry.buildGraph({
      pages: catalogPages(),
      roots: [{ pageId: SERVICE_ID }],
      environment: 'prod',
    });

    expect(graph.roots).toEqual([
      expect.objectContaining({
        status: 'resolved',
        page_id: SERVICE_ID,
        entity_id: 'service/neptune',
      }),
    ]);
    expect(graph.pages.map((item) => item.page_id)).toEqual([
      SERVICE_ID,
      SOURCE_ID,
      SET_ID,
      KRC_ID,
    ]);
    expect(graph.knownRootCauseCandidates).toEqual([
      expect.objectContaining({
        page_id: KRC_ID,
        entity_id: 'known-root-cause/neptune-tke-timeout',
      }),
    ]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_page_id: SERVICE_ID,
          to_page_id: SOURCE_ID,
        }),
        expect.objectContaining({
          from_page_id: SERVICE_ID,
          to_page_id: SET_ID,
        }),
        expect.objectContaining({
          from_page_id: KRC_ID,
          to_page_id: SERVICE_ID,
          relation: 'known_root_cause.affected_entities',
        }),
      ]),
    );
    expect(graph.unresolvedReferences).toEqual([]);
    expect(graph.closureComplete).toBe(true);
    expect(graph.closureStatus).toEqual({
      roots_resolved: true,
      reference_fields_scanned: true,
      required_targets_resolved: true,
      unresolved_references_empty: true,
      known_root_cause_discovery_complete: true,
    });
    expect(graph.pages.some((item) => item.page_id === CATEGORY_ID)).toBe(
      false,
    );
  });

  it('never resolves the classification/template page as a concrete v2 document', () => {
    const graph = registry.buildGraph({
      pages: catalogPages(),
      roots: [{ pageId: CATEGORY_ID }],
      environment: 'prod',
    });

    expect(graph.roots).toEqual([
      {
        selector: { page_id: CATEGORY_ID },
        status: 'unresolved',
        reason: 'unsupported_catalog_document',
      },
    ]);
    expect(graph.pages).toEqual([]);
    expect(graph.closureComplete).toBe(false);
  });

  it('reports unsupported schemas and ambiguous identities explicitly', () => {
    const unsupportedId = '66666666-6666-4666-8666-666666666666';
    const duplicateId = '77777777-7777-4777-8777-777777777777';
    const pages = [
      ...catalogPages(),
      page(
        unsupportedId,
        fenced(`
document_type: service_profile
schema_version: service-profile.v99
entity_id: service/unsupported
`),
      ),
      page(
        duplicateId,
        fenced(`
document_type: service_profile
schema_version: service-profile.v2
entity_id: service/neptune
`),
      ),
    ];

    const graph = registry.buildGraph({
      pages,
      roots: [
        { pageId: unsupportedId },
        { documentType: 'service_profile', entityId: 'service/neptune' },
      ],
      environment: 'prod',
    });

    expect(graph.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: { page_id: unsupportedId },
          status: 'unresolved',
          reason: 'unsupported_catalog_document',
        }),
        expect.objectContaining({
          selector: {
            document_type: 'service_profile',
            entity_id: 'service/neptune',
          },
          status: 'unresolved',
          reason: 'ambiguous_identity',
        }),
      ]),
    );
    expect(graph.closureComplete).toBe(false);
  });

  it('returns an unresolved reference and incomplete closure for a missing target', () => {
    const graph = registry.buildGraph({
      pages: catalogPages().filter((item) => item.page_id !== SOURCE_ID),
      roots: [{ pageId: SERVICE_ID }],
      environment: 'prod',
    });

    expect(graph.unresolvedReferences).toContainEqual(
      expect.objectContaining({
        from_page_id: SERVICE_ID,
        relation: 'fact_sources',
        reason: 'missing_or_not_accessible',
      }),
    );
    expect(graph.closureStatus.required_targets_resolved).toBe(false);
    expect(graph.closureComplete).toBe(false);
  });

  it.each([
    ['draft', 'confirmed', ['prod']],
    ['active', 'pending', ['prod']],
    ['active', 'confirmed', ['test']],
  ])(
    'filters KRC pages with status=%s verification=%s environments=%j',
    (status, verification, environments) => {
      const pages = catalogPages().map((item) =>
        item.page_id === KRC_ID
          ? page(
              KRC_ID,
              fenced(`
document_type: known_root_cause
schema_version: known-root-cause.v1
entity_id: known-root-cause/not-applicable
status: ${status}
affected_entities:
  - service/neptune
environment_scope:
${environments.map((value) => `  - ${value}`).join('\n')}
verification:
  status: ${verification}
`),
            )
          : item,
      );

      const graph = registry.buildGraph({
        pages,
        roots: [
          { documentType: 'service_profile', entityId: 'service/neptune' },
        ],
        environment: 'prod',
      });

      expect(graph.knownRootCauseCandidates).toEqual([]);
      expect(graph.pages.some((item) => item.page_id === KRC_ID)).toBe(false);
    },
  );

  it('marks closure incomplete when a fenced YAML page cannot be inspected', () => {
    const graph = registry.buildGraph({
      pages: catalogPages(),
      roots: [{ pageId: SERVICE_ID }],
      environment: 'prod',
      malformedPageIds: new Set(['66666666-6666-4666-8666-666666666666']),
      invalidYamlPageIds: new Set(['66666666-6666-4666-8666-666666666666']),
    });

    expect(graph.closureComplete).toBe(false);
    expect(graph.closureStatus.known_root_cause_discovery_complete).toBe(false);
  });

  it('changes the fingerprint when candidates, closure status, or extractor input changes', () => {
    const graph = registry.buildGraph({
      pages: catalogPages(),
      roots: [{ pageId: SERVICE_ID }],
      environment: 'prod',
    });
    const base = {
      catalogRootPageId: CATEGORY_ID,
      environment: 'prod',
      roots: graph.roots,
      knownRootCauseCandidates: graph.knownRootCauseCandidates,
      pages: registry.pageManifest(graph.pages),
      edges: graph.edges,
      unresolvedReferences: graph.unresolvedReferences,
      closureStatus: graph.closureStatus,
    };
    const fingerprint = registry.computeBundleFingerprint(base);

    expect(
      registry.computeBundleFingerprint({
        ...base,
        knownRootCauseCandidates: [],
      }),
    ).not.toBe(fingerprint);
    expect(
      registry.computeBundleFingerprint({
        ...base,
        closureStatus: {
          ...base.closureStatus,
          known_root_cause_discovery_complete: false,
        },
      }),
    ).not.toBe(fingerprint);
  });
});
