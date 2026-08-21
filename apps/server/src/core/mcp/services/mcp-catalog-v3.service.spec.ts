jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: (content: unknown) => String(content ?? ''),
}));

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { McpToolContext } from '../types/mcp-tool.types';
import type {
  CatalogBundleV3,
  CatalogResolutionTicket,
} from '../types/mcp-catalog-v3.types';
import { CatalogContractRegistry } from './catalog-contract.registry';
import { CatalogV2ContractRegistry } from './catalog-v2-contract.registry';
import { McpCatalogProofService } from './mcp-catalog-proof.service';
import { McpCatalogV3Service } from './mcp-catalog-v3.service';

const CATALOG_ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const SET_ID = '33333333-3333-4333-8333-333333333333';
const KRC_ID = '44444444-4444-4444-8444-444444444444';
const INFRA_ID = '55555555-5555-4555-8555-555555555555';
const SPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPDATED_AT = '2026-08-21T00:00:00.000Z';

const readSchema = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, '..', 'schemas', name), 'utf8'),
  ) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of [
  'catalog-resolution-ticket.v1.schema.json',
  'catalog-freshness-proof.v3.schema.json',
  'catalog-bundle.v3.schema.json',
  'catalog-delta.v3.schema.json',
]) {
  ajv.addSchema(readSchema(schema));
}
const validateTicket = ajv.getSchema(
  'catalog-resolution-ticket.v1.schema.json',
)!;
const validateBundle = ajv.getSchema('catalog-bundle.v3.schema.json')!;
const validateDelta = ajv.getSchema('catalog-delta.v3.schema.json')!;

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

function pages(serviceBody = '# Service body', missingSource = false) {
  const values = [
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
    capturedPage(
      INFRA_ID,
      fenced(`
document_type: infrastructure_profile
schema_version: infrastructure-profile.v2
entity_id: infrastructure/shared
fact_sources:
  - fact-source/tencent-tke
`),
    ),
  ];
  if (!missingSource) {
    values.push(
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
    );
  }
  return values;
}

function snapshot(snapshotPages = pages()) {
  const snapshotAt = new Date();
  return {
    catalogRoot: {
      id: CATALOG_ROOT_ID,
      title: 'Fact Catalog',
      spaceId: SPACE_ID,
      updatedAt: new Date(UPDATED_AT),
    },
    snapshotAt,
    pages: snapshotPages,
    scannedPageCount: snapshotPages.length,
    scannedContentBytes: snapshotPages.reduce(
      (total, page) => total + Buffer.byteLength(page.content, 'utf8'),
      0,
    ),
  };
}

function createHarness(initialPages = pages()) {
  const redisValues = new Map<string, string>();
  const redis = {
    set: jest.fn(async (key: string, value: string) => {
      if (redisValues.has(key)) return null;
      redisValues.set(key, value);
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const value = redisValues.get(key) ?? null;
      redisValues.delete(key);
      return value;
    }),
  };
  const environment = {
    getMcpCatalogSigningSecret: jest.fn(
      () => 'catalog-signing-secret-with-more-than-32-bytes',
    ),
    getMcpCatalogSigningKeyId: jest.fn(() => undefined),
    getMcpCatalogPreviousPublicKeys: jest.fn(() => undefined),
    getMcpCatalogChallengeTtlSeconds: jest.fn(() => 86400),
    getMcpCatalogTicketTtlSeconds: jest.fn(() => 120),
    getMcpCatalogMaxResolutionWindowMs: jest.fn(() => 120_000),
  };
  const proofService = new McpCatalogProofService(
    environment as never,
    {
      getOrThrow: () => redis,
    } as never,
  );
  const snapshotService = {
    capture: jest.fn().mockImplementation(async () => snapshot(initialPages)),
  };
  const registry = new CatalogV2ContractRegistry(new CatalogContractRegistry());
  const service = new McpCatalogV3Service(
    registry,
    proofService,
    snapshotService as never,
    environment as never,
  );
  return {
    service,
    registry,
    proofService,
    snapshotService,
    environment,
    redis,
  };
}

function startArgs(challenge = 'diagnosis-v3-unique-0001') {
  return {
    contract: 'qts-fact-catalog.v1',
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: 'prod',
    challenge,
  };
}

function catalogScopeArgs() {
  return {
    contract: 'qts-fact-catalog.v1' as const,
    catalogRootPageId: CATALOG_ROOT_ID,
    environment: 'prod',
  };
}

async function issueTicket(
  service: McpCatalogV3Service,
  challenge = 'diagnosis-v3-unique-0001',
) {
  return service.callTool(
    'begin_catalog_resolution',
    startArgs(challenge),
    context,
  ) as Promise<CatalogResolutionTicket>;
}

async function resolveBundle(
  service: McpCatalogV3Service,
  roots = [{ pageId: SERVICE_ID }],
  challenge = 'diagnosis-v3-unique-0001',
) {
  const ticket = await issueTicket(service, challenge);
  return service.callTool(
    'resolve_catalog_bundle_v3',
    { ...catalogScopeArgs(), roots, ticket },
    context,
  ) as Promise<CatalogBundleV3>;
}

function previousFrom(bundle: CatalogBundleV3) {
  return {
    bundleFingerprint: bundle.bundle_fingerprint,
    pages: bundle.pages.map((page) => ({
      pageId: page.page_id,
      updatedAt: page.updated_at,
      contentSha256: page.content_sha256,
      frontMatterSha256: page.front_matter_sha256,
    })),
    freshnessProof: bundle.freshness_proof,
  };
}

describe('McpCatalogV3Service', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('advertises a ticket start plus immutable v3 Bundle and Delta tools', () => {
    expect(
      createHarness()
        .service.listTools()
        .map((tool) => tool.name),
    ).toEqual([
      'begin_catalog_resolution',
      'resolve_catalog_bundle_v3',
      'resolve_catalog_delta_v3',
    ]);
  });

  it('rejects caller-supplied timestamps and unversioned field aliases', async () => {
    const { service } = createHarness();
    await expect(
      service.callTool(
        'begin_catalog_resolution',
        {
          ...startArgs(),
          started_at: '2026-08-21T00:00:00.000Z',
        },
        context,
      ),
    ).rejects.toThrow('unsupported or missing fields');

    const ticket = await issueTicket(service);
    await expect(
      service.callTool(
        'resolve_catalog_bundle_v3',
        {
          ...catalogScopeArgs(),
          roots: [{ pageId: SERVICE_ID }],
          ticket,
          challenge: ticket.challenge,
        },
        context,
      ),
    ).rejects.toThrow('unsupported or missing fields');

    const bundle = await service.callTool(
      'resolve_catalog_bundle_v3',
      {
        ...catalogScopeArgs(),
        roots: [{ pageId: SERVICE_ID }],
        ticket,
      },
      context,
    );
    if (bundle.schema_version !== 'catalog-bundle.v3') {
      throw new Error('bundle');
    }
    const deltaTicket = await issueTicket(
      service,
      'diagnosis-strict-fields-0002',
    );
    await expect(
      service.callTool(
        'resolve_catalog_delta_v3',
        {
          ...catalogScopeArgs(),
          roots: [{ pageId: SERVICE_ID }],
          ticket: deltaTicket,
          previous: {
            ...previousFrom(bundle),
            started_at: bundle.freshness_proof.resolution_started_at,
          },
        },
        context,
      ),
    ).rejects.toThrow('unsupported or missing fields');
  });

  it('returns a signed ticket and a front-matter-bound complete Bundle', async () => {
    const { service, proofService, registry } = createHarness();
    const ticket = await issueTicket(service);
    expect(validateTicket(ticket)).toBe(true);
    expect(proofService.verifyResolutionTicket(ticket)).toBe(true);

    const bundle = (await service.callTool(
      'resolve_catalog_bundle_v3',
      { ...catalogScopeArgs(), roots: [{ pageId: SERVICE_ID }], ticket },
      context,
    )) as CatalogBundleV3;
    expect(validateBundle(bundle)).toBe(true);
    expect(bundle.closure_complete).toBe(true);
    expect(bundle.known_root_cause_candidates).toHaveLength(1);
    expect(bundle.pages).toHaveLength(4);
    for (const page of bundle.pages) {
      expect(page.front_matter_sha256).toBe(
        registry.sha256(registry.canonicalJson(page.front_matter)),
      );
    }
    expect(bundle.freshness_proof.resolution_ticket_id).toBe(ticket.ticket_id);
    expect(bundle.freshness_proof.snapshot_fetched_at).toBe(
      bundle.pages[0].fetched_at,
    );
    expect(proofService.verifyProofV3(bundle.freshness_proof)).toBe(true);
  });

  it('consumes tickets once across replicas sharing Redis state', async () => {
    const { service, registry, snapshotService, environment, redis } =
      createHarness();
    const secondProofService = new McpCatalogProofService(
      environment as never,
      { getOrThrow: () => redis } as never,
    );
    const secondService = new McpCatalogV3Service(
      registry,
      secondProofService,
      snapshotService as never,
      environment as never,
    );
    const ticket = await issueTicket(service);
    const args = {
      ...catalogScopeArgs(),
      roots: [{ pageId: SERVICE_ID }],
      ticket,
    };
    await secondService.callTool('resolve_catalog_bundle_v3', args, context);
    await expect(
      service.callTool('resolve_catalog_bundle_v3', args, context),
    ).rejects.toThrow('already used');
    expect(snapshotService.capture).toHaveBeenCalledTimes(1);
  });

  it('rejects a ticket when the current execution identity changed', async () => {
    const { service, snapshotService } = createHarness();
    const ticket = await issueTicket(service);
    const changedContext = {
      client: { ...context.client, actorUserId: 'user-2' },
    } as McpToolContext;

    await expect(
      service.callTool(
        'resolve_catalog_bundle_v3',
        { ...catalogScopeArgs(), roots: [{ pageId: SERVICE_ID }], ticket },
        changedContext,
      ),
    ).rejects.toThrow('does not match the requested scope');
    expect(snapshotService.capture).not.toHaveBeenCalled();
  });

  it('rejects duplicate roots before consuming the ticket', async () => {
    const { service, snapshotService } = createHarness();
    const ticket = await issueTicket(service);
    await expect(
      service.callTool(
        'resolve_catalog_bundle_v3',
        {
          ...catalogScopeArgs(),
          roots: [{ pageId: SERVICE_ID }, { pageId: SERVICE_ID }],
          ticket,
        },
        context,
      ),
    ).rejects.toThrow('duplicate selectors');
    expect(snapshotService.capture).not.toHaveBeenCalled();
  });

  it('rejects snapshots outside the ticket-bound resolution window', async () => {
    const now = new Date('2026-08-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const { service, snapshotService } = createHarness();
    const ticket = await issueTicket(service);
    snapshotService.capture.mockResolvedValueOnce({
      ...snapshot(),
      snapshotAt: new Date(now.getTime() - 1),
    });

    await expect(
      service.callTool(
        'resolve_catalog_bundle_v3',
        { ...catalogScopeArgs(), roots: [{ pageId: SERVICE_ID }], ticket },
        context,
      ),
    ).rejects.toThrow('outside the signed resolution window');
  });

  it('rejects completion beyond the configured maximum resolution window', async () => {
    const now = new Date('2026-08-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const { service, snapshotService, environment } = createHarness();
    environment.getMcpCatalogMaxResolutionWindowMs.mockReturnValue(1_000);
    const ticket = await issueTicket(service);
    snapshotService.capture.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 1_001));
      return snapshot();
    });

    await expect(
      service.callTool(
        'resolve_catalog_bundle_v3',
        { ...catalogScopeArgs(), roots: [{ pageId: SERVICE_ID }], ticket },
        context,
      ),
    ).rejects.toThrow('configured trusted window');
  });

  it('returns a complete unchanged partition for identical roots', async () => {
    const { service } = createHarness();
    const bundle = await resolveBundle(service);
    const ticket = await issueTicket(service, 'diagnosis-v3-unique-0002');
    const delta = await service.callTool(
      'resolve_catalog_delta_v3',
      {
        ...catalogScopeArgs(),
        roots: [{ pageId: SERVICE_ID }],
        ticket,
        previous: previousFrom(bundle),
      },
      context,
    );
    expect(validateDelta(delta)).toBe(true);
    if (delta.schema_version !== 'catalog-delta.v3') throw new Error('delta');
    expect(delta.changed).toBe(false);
    expect(delta.root_changes).toEqual({
      added: [],
      removed: [],
      unchanged: [{ page_id: SERVICE_ID }],
    });
    expect(delta.changes.unchanged).toHaveLength(bundle.pages.length);
  });

  it('supports roots expansion and rebuilds the complete current closure', async () => {
    const { service } = createHarness();
    const bundle = await resolveBundle(service);
    const ticket = await issueTicket(service, 'diagnosis-v3-expand-0002');
    const delta = await service.callTool(
      'resolve_catalog_delta_v3',
      {
        ...catalogScopeArgs(),
        roots: [{ pageId: SERVICE_ID }, { pageId: INFRA_ID }],
        ticket,
        previous: previousFrom(bundle),
      },
      context,
    );
    if (delta.schema_version !== 'catalog-delta.v3') throw new Error('delta');
    expect(delta.root_changes.added).toEqual([{ page_id: INFRA_ID }]);
    expect(delta.root_changes.removed).toEqual([]);
    expect(delta.changes.added.map((page) => page.page_id)).toEqual([INFRA_ID]);
    expect(delta.current_page_manifest).toHaveLength(bundle.pages.length + 1);
    expect(delta.closure_complete).toBe(true);
  });

  it('classifies same-timestamp hash changes as updated', async () => {
    const harness = createHarness();
    const bundle = await resolveBundle(harness.service);
    harness.snapshotService.capture.mockImplementationOnce(async () =>
      snapshot(pages('# changed without timestamp change')),
    );
    const ticket = await issueTicket(
      harness.service,
      'diagnosis-v3-hash-change',
    );
    const delta = await harness.service.callTool(
      'resolve_catalog_delta_v3',
      {
        ...catalogScopeArgs(),
        roots: [{ pageId: SERVICE_ID }],
        ticket,
        previous: previousFrom(bundle),
      },
      context,
    );
    if (delta.schema_version !== 'catalog-delta.v3') throw new Error('delta');
    expect(delta.changes.updated.map((item) => item.current.page_id)).toEqual([
      SERVICE_ID,
    ]);
    expect(delta.changes.updated[0].previous.updated_at).toBe(
      delta.changes.updated[0].current.updated_at,
    );
  });

  it('rejects roots removal, previous proof tampering, and ticket replay', async () => {
    const { service, snapshotService } = createHarness();
    const expanded = await resolveBundle(
      service,
      [{ pageId: SERVICE_ID }, { pageId: INFRA_ID }],
      'diagnosis-v3-expanded-base',
    );
    const ticket = await issueTicket(service, 'diagnosis-v3-remove-root');
    await expect(
      service.callTool(
        'resolve_catalog_delta_v3',
        {
          ...catalogScopeArgs(),
          roots: [{ pageId: SERVICE_ID }],
          ticket,
          previous: previousFrom(expanded),
        },
        context,
      ),
    ).rejects.toThrow('subset');
    expect(snapshotService.capture).toHaveBeenCalledTimes(1);

    const base = await resolveBundle(
      service,
      [{ pageId: SERVICE_ID }],
      'diagnosis-v3-tamper-base',
    );
    const forged = previousFrom(base);
    forged.freshnessProof = {
      ...forged.freshnessProof,
      signature: 'A'.repeat(forged.freshnessProof.signature.length),
    };
    const forgedTicket = await issueTicket(
      service,
      'diagnosis-v3-forged-proof',
    );
    await expect(
      service.callTool(
        'resolve_catalog_delta_v3',
        {
          ...catalogScopeArgs(),
          roots: [{ pageId: SERVICE_ID }],
          ticket: forgedTicket,
          previous: forged,
        },
        context,
      ),
    ).rejects.toThrow('previous freshness proof is invalid');
  });

  it('preserves partial closure and accurately discloses unresolved references', async () => {
    const { service } = createHarness(pages('# Service body', true));
    const bundle = await resolveBundle(service);
    expect(bundle.closure_complete).toBe(false);
    expect(bundle.unresolved_references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'fact_sources',
          reason: 'missing_or_not_accessible',
        }),
      ]),
    );
  });
});
