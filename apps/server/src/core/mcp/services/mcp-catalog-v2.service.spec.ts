jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: (content: unknown) => String(content ?? ''),
}));

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { McpToolContext } from '../types/mcp-tool.types';
import type { CatalogBundleV2 } from '../types/mcp-catalog-v2.types';
import { CATALOG_LIMITS } from '../types/mcp-catalog.types';
import { CatalogContractRegistry } from './catalog-contract.registry';
import { CatalogV2ContractRegistry } from './catalog-v2-contract.registry';
import { McpCatalogProofService } from './mcp-catalog-proof.service';
import { McpCatalogV2Service } from './mcp-catalog-v2.service';

const CATALOG_ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const SET_ID = '33333333-3333-4333-8333-333333333333';
const KRC_ID = '44444444-4444-4444-8444-444444444444';
const ADDED_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPDATED_AT = '2026-08-21T00:00:00.000Z';
const SNAPSHOT_AT = '2026-08-21T00:00:01.000Z';
const readSchema = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, '..', 'schemas', name), 'utf8'),
  ) as object;
const freshnessSchema = readSchema('catalog-freshness-proof.v2.schema.json');
const bundleSchema = readSchema('catalog-bundle.v2.schema.json');
const deltaSchema = readSchema('catalog-delta.v2.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(freshnessSchema);
ajv.addSchema(bundleSchema);
ajv.addSchema(deltaSchema);
const validateBundleSchema = ajv.getSchema('catalog-bundle.v2.schema.json')!;
const validateDeltaSchema = ajv.getSchema('catalog-delta.v2.schema.json')!;

const context = {
  client: {
    id: 'client-1',
    workspaceId: 'workspace-1',
    actorUserId: 'user-1',
    status: 'active',
  },
} as unknown as McpToolContext;

function fenced(frontMatter: string, body = '# Body'): string {
  return [
    '# Catalog document',
    '',
    '```yaml',
    frontMatter.trim(),
    '```',
    '',
    body,
  ].join('\n');
}

function capturedPage(
  id: string,
  content: string,
  updatedAt = UPDATED_AT,
  parentPageId: string | null = CATALOG_ROOT_ID,
) {
  return {
    id,
    title: id,
    parentPageId,
    spaceId: SPACE_ID,
    updatedAt: new Date(updatedAt),
    content,
  };
}

function pages(serviceBody = '# Service body') {
  return [
    capturedPage(CATALOG_ROOT_ID, '# Fact Catalog', UPDATED_AT, null),
    capturedPage(
      SERVICE_ID,
      fenced(
        `
document_type: service_profile
schema_version: service-profile.v2
entity_id: service/neptune
fact_sources:
  - fact-source/tencent-tke
query_profile_refs:
  - query_profile_id: tke.workloads.v1
`,
        serviceBody,
      ),
    ),
    capturedPage(
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
    capturedPage(
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
    capturedPage(
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
  ];
}

function snapshot(snapshotPages = pages(), snapshotAt = SNAPSHOT_AT) {
  return {
    catalogRoot: {
      id: CATALOG_ROOT_ID,
      title: 'Fact Catalog',
      spaceId: SPACE_ID,
      updatedAt: new Date(UPDATED_AT),
    },
    snapshotAt: new Date(snapshotAt),
    pages: snapshotPages,
    scannedPageCount: snapshotPages.length,
    scannedContentBytes: snapshotPages.reduce(
      (total, page) => total + Buffer.byteLength(page.content, 'utf8'),
      0,
    ),
  };
}

function createHarness(initialPages = pages()) {
  const seenChallenges = new Set<string>();
  const redis = {
    set: jest.fn(async (key: string) => {
      if (seenChallenges.has(key)) return null;
      seenChallenges.add(key);
      return 'OK';
    }),
  };
  const environment = {
    getMcpCatalogSigningSecret: jest.fn(
      () => 'catalog-signing-secret-with-more-than-32-bytes',
    ),
    getMcpCatalogSigningKeyId: jest.fn(() => undefined),
    getMcpCatalogPreviousPublicKeys: jest.fn(() => undefined),
    getMcpCatalogChallengeTtlSeconds: jest.fn(() => 86400),
  };
  const proofService = new McpCatalogProofService(
    environment as never,
    {
      getOrThrow: () => redis,
    } as never,
  );
  const snapshotService = {
    capture: jest.fn().mockResolvedValue(snapshot(initialPages)),
  };
  const registry = new CatalogV2ContractRegistry(new CatalogContractRegistry());
  const service = new McpCatalogV2Service(
    registry,
    proofService,
    snapshotService as never,
  );
  return { service, registry, proofService, snapshotService, redis };
}

function bundleArgs(challenge = 'diagnosis-unique-0001') {
  return {
    contract: 'qts-fact-catalog.v1',
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: 'prod',
    roots: [{ pageId: SERVICE_ID }],
    challenge,
  };
}

function previousFrom(bundle: CatalogBundleV2) {
  return {
    bundleFingerprint: bundle.bundle_fingerprint,
    pages: bundle.pages.map((page) => ({
      pageId: page.page_id,
      updatedAt: page.updated_at,
      contentSha256: page.content_sha256,
    })),
    freshnessProof: bundle.freshness_proof,
  };
}

describe('McpCatalogV2Service', () => {
  it('advertises separate immutable v2 tools while retaining the v1 contract selector', () => {
    const definitions = createHarness().service.listTools();

    expect(definitions.map((definition) => definition.name)).toEqual([
      'resolve_catalog_bundle_v2',
      'resolve_catalog_delta_v2',
    ]);
    for (const definition of definitions) {
      expect(definition.inputSchema).toMatchObject({
        properties: {
          contract: { const: 'qts-fact-catalog.v1' },
          catalogRootPageId: { format: 'uuid' },
          challenge: { minLength: 16, maxLength: 128 },
        },
      });
    }
  });

  it('returns a complete fenced-YAML bundle with exact hashes and a signed proof', async () => {
    const { service, registry, proofService, snapshotService } =
      createHarness();

    const result = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs(),
      context,
    );

    expect(result.schema_version).toBe('catalog-bundle.v2');
    if (result.schema_version !== 'catalog-bundle.v2') {
      throw new Error('expected bundle v2');
    }
    expect(snapshotService.capture).toHaveBeenCalledTimes(1);
    expect(result.pages).toHaveLength(4);
    expect(result.edges.length).toBeGreaterThanOrEqual(4);
    expect(result.known_root_cause_candidates).toHaveLength(1);
    expect(result.closure_complete).toBe(true);
    expect(result.reference_extractor_version).toBe(
      'qts-fact-catalog-extractor.v2.0.0',
    );
    expect(result.pages.every((page) => page.fetched_at === SNAPSHOT_AT)).toBe(
      true,
    );
    for (const page of result.pages) {
      expect(page.content_sha256).toBe(registry.sha256(page.markdown));
    }
    expect(result.freshness_proof).toMatchObject({
      challenge: 'diagnosis-unique-0001',
      catalog_root_page_id: CATALOG_ROOT_ID,
      environment: 'prod',
      isolation: 'repeatable_read',
      read_only: true,
      bundle_fingerprint: result.bundle_fingerprint,
      reference_extractor_version: result.reference_extractor_version,
      signature_algorithm: 'ed25519',
    });
    expect(proofService.verifyProof(result.freshness_proof)).toBe(true);
    expect(validateBundleSchema(result)).toBe(true);
    expect(validateBundleSchema.errors).toBeNull();
  });

  it('resolves page ID and identity selectors to the same document closure', async () => {
    const { service } = createHarness();
    const byPage = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs('diagnosis-selector-page'),
      context,
    );
    const byIdentity = await service.callTool(
      'resolve_catalog_bundle_v2',
      {
        ...bundleArgs('diagnosis-selector-identity'),
        roots: [
          { documentType: 'service_profile', entityId: 'service/neptune' },
        ],
      },
      context,
    );
    if (
      byPage.schema_version !== 'catalog-bundle.v2' ||
      byIdentity.schema_version !== 'catalog-bundle.v2'
    ) {
      throw new Error('expected bundle v2');
    }

    expect(byIdentity.roots[0]).toMatchObject({
      status: 'resolved',
      page_id: SERVICE_ID,
      entity_id: 'service/neptune',
    });
    expect(byIdentity.pages.map((page) => page.page_id)).toEqual(
      byPage.pages.map((page) => page.page_id),
    );
    expect(byIdentity.edges).toEqual(byPage.edges);
  });

  it('rejects challenge replay before a second Catalog snapshot', async () => {
    const { service, snapshotService } = createHarness();
    await service.callTool('resolve_catalog_bundle_v2', bundleArgs(), context);

    await expect(
      service.callTool('resolve_catalog_bundle_v2', bundleArgs(), context),
    ).rejects.toThrow('challenge has already been used');
    expect(snapshotService.capture).toHaveBeenCalledTimes(1);
  });

  it('returns an unchanged Delta only after validating the previous proof and taking a fresh snapshot', async () => {
    const { service, snapshotService, proofService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== 'catalog-bundle.v2') {
      throw new Error('expected bundle v2');
    }

    const delta = await service.callTool(
      'resolve_catalog_delta_v2',
      {
        ...bundleArgs('diagnosis-unique-0002'),
        previous: previousFrom(first),
      },
      context,
    );

    expect(delta.schema_version).toBe('catalog-delta.v2');
    if (delta.schema_version !== 'catalog-delta.v2') {
      throw new Error('expected delta v2');
    }
    expect(snapshotService.capture).toHaveBeenCalledTimes(2);
    expect(delta.changed).toBe(false);
    expect(delta.changes.added).toEqual([]);
    expect(delta.changes.updated).toEqual([]);
    expect(delta.changes.removed).toEqual([]);
    expect(delta.changes.unchanged).toHaveLength(first.pages.length);
    expect(delta.bundle_fingerprint).toBe(first.bundle_fingerprint);
    expect(delta.freshness_proof.challenge).toBe('diagnosis-unique-0002');
    expect(delta.freshness_proof.signature).not.toBe(
      first.freshness_proof.signature,
    );
    expect(proofService.verifyProof(delta.freshness_proof)).toBe(true);
    expect(validateDeltaSchema(delta)).toBe(true);
    expect(validateDeltaSchema.errors).toBeNull();
  });

  it('classifies same-timestamp Markdown changes as updated', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== 'catalog-bundle.v2') {
      throw new Error('expected bundle v2');
    }
    snapshotService.capture.mockResolvedValueOnce(
      snapshot(
        pages('# changed while updated_at stayed the same'),
        '2026-08-21T00:02:00.000Z',
      ),
    );

    const delta = await service.callTool(
      'resolve_catalog_delta_v2',
      {
        ...bundleArgs('diagnosis-unique-0003'),
        previous: previousFrom(first),
      },
      context,
    );
    if (delta.schema_version !== 'catalog-delta.v2') {
      throw new Error('expected delta v2');
    }

    expect(delta.changed).toBe(true);
    expect(delta.changes.updated).toEqual([
      expect.objectContaining({
        previous: expect.objectContaining({ page_id: SERVICE_ID }),
        current: expect.objectContaining({
          page_id: SERVICE_ID,
          updated_at: UPDATED_AT,
        }),
      }),
    ]);
  });

  it('returns mutually exclusive mixed added, updated, removed, and unchanged partitions', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== 'catalog-bundle.v2') {
      throw new Error('expected bundle v2');
    }

    const nextPages = pages().filter((page) => page.id !== SOURCE_ID);
    const serviceIndex = nextPages.findIndex((page) => page.id === SERVICE_ID);
    nextPages[serviceIndex] = capturedPage(
      SERVICE_ID,
      fenced(`
document_type: service_profile
schema_version: service-profile.v2
entity_id: service/neptune
fact_sources:
  - fact-source/tencent-current
query_profile_refs:
  - query_profile_id: tke.workloads.v1
`),
    );
    nextPages.push(
      capturedPage(
        ADDED_ID,
        fenced(`
document_type: fact_source_profile
schema_version: fact-source-profile.v2
entity_id: fact-source/tencent-current
`),
      ),
    );
    snapshotService.capture.mockResolvedValueOnce(
      snapshot(nextPages, '2026-08-21T00:03:00.000Z'),
    );

    const delta = await service.callTool(
      'resolve_catalog_delta_v2',
      {
        ...bundleArgs('diagnosis-unique-mixed'),
        previous: previousFrom(first),
      },
      context,
    );
    if (delta.schema_version !== 'catalog-delta.v2') {
      throw new Error('expected delta v2');
    }

    expect(delta.changes.added.map((page) => page.page_id)).toEqual([ADDED_ID]);
    expect(delta.changes.updated.map((item) => item.current.page_id)).toEqual([
      SERVICE_ID,
    ]);
    expect(delta.changes.removed.map((page) => page.page_id)).toEqual([
      SOURCE_ID,
    ]);
    expect(delta.changes.unchanged.map((page) => page.page_id)).toEqual([
      SET_ID,
      KRC_ID,
    ]);
    const allIds = [
      ...delta.changes.added.map((page) => page.page_id),
      ...delta.changes.updated.map((item) => item.current.page_id),
      ...delta.changes.removed.map((page) => page.page_id),
      ...delta.changes.unchanged.map((page) => page.page_id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(validateDeltaSchema(delta)).toBe(true);
  });

  it('rejects root, closure-page, and edge limit overflows explicitly', async () => {
    const rootsHarness = createHarness();
    await expect(
      rootsHarness.service.callTool(
        'resolve_catalog_bundle_v2',
        {
          ...bundleArgs('diagnosis-root-overflow'),
          roots: Array.from({ length: CATALOG_LIMITS.maxRoots + 1 }, () => ({
            pageId: SERVICE_ID,
          })),
        },
        context,
      ),
    ).rejects.toThrow(`at most ${CATALOG_LIMITS.maxRoots}`);
    expect(rootsHarness.snapshotService.capture).not.toHaveBeenCalled();

    const pagesHarness = createHarness();
    jest.spyOn(pagesHarness.registry, 'buildGraph').mockReturnValue({
      roots: [],
      knownRootCauseCandidates: [],
      pages: Array.from(
        { length: CATALOG_LIMITS.maxClosurePages + 1 },
        () => ({}),
      ),
      edges: [],
      unresolvedReferences: [],
      closureStatus: {
        roots_resolved: false,
        reference_fields_scanned: false,
        required_targets_resolved: false,
        unresolved_references_empty: true,
        known_root_cause_discovery_complete: false,
      },
      closureComplete: false,
    } as never);
    await expect(
      pagesHarness.service.callTool(
        'resolve_catalog_bundle_v2',
        bundleArgs('diagnosis-page-overflow'),
        context,
      ),
    ).rejects.toThrow(`${CATALOG_LIMITS.maxClosurePages} pages`);

    const edgesHarness = createHarness();
    jest.spyOn(edgesHarness.registry, 'buildGraph').mockReturnValue({
      roots: [],
      knownRootCauseCandidates: [],
      pages: [],
      edges: Array.from({ length: CATALOG_LIMITS.maxEdges + 1 }, () => ({})),
      unresolvedReferences: [],
      closureStatus: {
        roots_resolved: false,
        reference_fields_scanned: false,
        required_targets_resolved: false,
        unresolved_references_empty: true,
        known_root_cause_discovery_complete: false,
      },
      closureComplete: false,
    } as never);
    await expect(
      edgesHarness.service.callTool(
        'resolve_catalog_bundle_v2',
        bundleArgs('diagnosis-edge-overflow'),
        context,
      ),
    ).rejects.toThrow(`${CATALOG_LIMITS.maxEdges} edges`);
  });

  it('fails closed when trusted server resolution exceeds its time budget', async () => {
    const { service, proofService } = createHarness();
    jest
      .spyOn(proofService, 'elapsedMilliseconds')
      .mockReturnValue(CATALOG_LIMITS.maxExecutionMs + 1);

    await expect(
      service.callTool(
        'resolve_catalog_bundle_v2',
        bundleArgs('diagnosis-time-overflow'),
        context,
      ),
    ).rejects.toThrow(`${CATALOG_LIMITS.maxExecutionMs} ms`);
  });

  it.each(['signature', 'bundleFingerprint', 'manifest', 'authorization'])(
    'hard-fails Delta when previous %s is invalid',
    async (tamper) => {
      const { service, snapshotService } = createHarness();
      const first = await service.callTool(
        'resolve_catalog_bundle_v2',
        bundleArgs(),
        context,
      );
      if (first.schema_version !== 'catalog-bundle.v2') {
        throw new Error('expected bundle v2');
      }
      const previous = previousFrom(first);
      if (tamper === 'signature') {
        previous.freshnessProof = {
          ...previous.freshnessProof,
          signature: 'A'.repeat(previous.freshnessProof.signature.length),
        };
      } else if (tamper === 'bundleFingerprint') {
        previous.bundleFingerprint = 'f'.repeat(64);
      } else if (tamper === 'manifest') {
        previous.pages = previous.pages.slice(1);
      } else {
        previous.freshnessProof = {
          ...previous.freshnessProof,
          authorization_context_sha256: 'e'.repeat(64),
        };
      }

      await expect(
        service.callTool(
          'resolve_catalog_delta_v2',
          {
            ...bundleArgs(`diagnosis-invalid-${tamper}`),
            previous,
          },
          context,
        ),
      ).rejects.toThrow();
      expect(snapshotService.capture).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a Delta that reuses the previous signed challenge', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle_v2',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== 'catalog-bundle.v2') {
      throw new Error('expected bundle v2');
    }

    await expect(
      service.callTool(
        'resolve_catalog_delta_v2',
        { ...bundleArgs(), previous: previousFrom(first) },
        context,
      ),
    ).rejects.toThrow('must differ');
    expect(snapshotService.capture).toHaveBeenCalledTimes(1);
  });
});
