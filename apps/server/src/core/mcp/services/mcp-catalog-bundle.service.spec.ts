jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: (content: unknown) => String(content ?? ''),
}));

import type { McpToolContext } from '../types/mcp-tool.types';
import {
  CATALOG_BUNDLE_SCHEMA_VERSION,
  CATALOG_DELTA_SCHEMA_VERSION,
  CATALOG_LIMITS,
  CatalogBundle,
  QTS_FACT_CATALOG_CONTRACT,
} from '../types/mcp-catalog.types';
import { CatalogContractRegistry } from './catalog-contract.registry';
import { McpCatalogBundleService } from './mcp-catalog-bundle.service';

describe('McpCatalogBundleService', () => {
  const rootPageId = '11111111-1111-4111-8111-111111111111';
  const sourcePageId = '22222222-2222-4222-8222-222222222222';
  const secondSourcePageId = '33333333-3333-4333-8333-333333333333';
  const thirdSourcePageId = '44444444-4444-4444-8444-444444444444';
  const context = {
    client: {
      id: 'client-1',
      workspaceId: 'workspace-1',
      actorUserId: 'user-1',
      status: 'active',
    },
  } as unknown as McpToolContext;
  const markdown = (
    body: string,
    factSources: string[] = ['fact-source/example'],
  ) =>
    [
      '---',
      'document_type: service_profile',
      'schema_version: service-profile.v2',
      'entity_id: service/example',
      'fact_sources:',
      ...factSources.map((source) => `  - ${source}`),
      '---',
      body,
    ].join('\n');
  const sourceMarkdown = (entityId = 'fact-source/example') =>
    [
      '---',
      'document_type: fact_source_profile',
      'schema_version: fact-source-profile.v2',
      `entity_id: ${entityId}`,
      '---',
      '# source',
    ].join('\n');

  const capturedPage = (input: {
    id: string;
    content: string;
    title?: string;
    parentPageId?: string | null;
    updatedAt?: string;
  }) => ({
    id: input.id,
    title: input.title ?? input.id,
    parentPageId: input.parentPageId ?? null,
    spaceId: 'space-1',
    updatedAt: new Date(input.updatedAt ?? '2026-08-20T00:00:00.000Z'),
    content: input.content,
  });

  const snapshot = (
    pages: ReturnType<typeof capturedPage>[],
    snapshotAt = '2026-08-20T00:00:01.000Z',
  ) => ({
    catalogRoot: {
      id: rootPageId,
      title: 'Catalog',
      spaceId: 'space-1',
      updatedAt:
        pages.find((page) => page.id === rootPageId)?.updatedAt ??
        new Date('2026-08-20T00:00:00.000Z'),
    },
    snapshotAt: new Date(snapshotAt),
    scannedPageCount: pages.length,
    scannedContentBytes: pages.reduce(
      (total, page) => total + Buffer.byteLength(page.content, 'utf8'),
      0,
    ),
    pages,
  });

  const basePages = () => [
    capturedPage({
      id: rootPageId,
      title: 'Example',
      content: markdown('# first'),
    }),
    capturedPage({
      id: sourcePageId,
      title: 'Source',
      parentPageId: rootPageId,
      content: sourceMarkdown(),
    }),
  ];

  const createHarness = (pages = basePages()) => {
    const snapshotService = {
      capture: jest.fn().mockResolvedValue(snapshot(pages)),
    };
    const registry = new CatalogContractRegistry();
    const service = new McpCatalogBundleService(
      registry,
      snapshotService as never,
    );
    return { service, snapshotService, registry };
  };

  const bundleArgs = () => ({
    contract: QTS_FACT_CATALOG_CONTRACT,
    catalogRootPageId: rootPageId,
    environment: 'prod',
    roots: [{ pageId: rootPageId }],
    challenge: 'diagnosis-unique-0001',
  });

  const previousFrom = (bundle: CatalogBundle) => ({
    bundleFingerprint: bundle.bundle_fingerprint,
    pages: bundle.pages.map((page) => ({
      pageId: page.page_id,
      updatedAt: page.updated_at,
      contentSha256: page.content_sha256,
    })),
  });

  it('advertises UUID and timestamp formats for Catalog identities', () => {
    const { service } = createHarness();
    const definitions = new Map(
      service.listTools().map((definition) => [definition.name, definition]),
    );
    const bundleProperties = definitions.get('resolve_catalog_bundle')
      ?.inputSchema.properties as Record<string, unknown>;
    const deltaProperties = definitions.get('resolve_catalog_delta')
      ?.inputSchema.properties as {
      previous: {
        properties: {
          pages: { items: { properties: Record<string, unknown> } };
        };
      };
    };

    expect(bundleProperties.catalogRootPageId).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    expect(
      deltaProperties.previous.properties.pages.items.properties,
    ).toMatchObject({
      pageId: { type: 'string', format: 'uuid' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
  });

  it('returns a deterministic live bundle and echoes the challenge', async () => {
    const { service, registry } = createHarness();

    const result = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );

    expect(result.schema_version).toBe(CATALOG_BUNDLE_SCHEMA_VERSION);
    if (result.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }
    expect(result.pages).toHaveLength(2);
    expect(result.closure_complete).toBe(true);
    expect(result.freshness_proof).toMatchObject({
      challenge: 'diagnosis-unique-0001',
      isolation: 'repeatable_read',
      read_only: true,
      bundle_fingerprint: result.bundle_fingerprint,
    });
    expect(result.pages[0].content_sha256).toBe(
      registry.sha256(result.pages[0].markdown),
    );
  });

  it('fully recomputes delta and detects a same-timestamp content change', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }
    snapshotService.capture.mockResolvedValueOnce({
      catalogRoot: {
        id: rootPageId,
        title: 'Catalog',
        spaceId: 'space-1',
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
      snapshotAt: new Date('2026-08-20T00:01:00.000Z'),
      scannedPageCount: 2,
      scannedContentBytes: 100,
      pages: [
        {
          id: rootPageId,
          title: 'Example',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: new Date('2026-08-20T00:00:00.000Z'),
          content: markdown('# changed without timestamp change'),
        },
        {
          id: sourcePageId,
          title: 'Source',
          parentPageId: rootPageId,
          spaceId: 'space-1',
          updatedAt: new Date('2026-08-20T00:00:00.000Z'),
          content: sourceMarkdown(),
        },
      ],
    });

    const delta = await service.callTool(
      'resolve_catalog_delta',
      {
        ...bundleArgs(),
        challenge: 'diagnosis-unique-0002',
        previous: {
          bundleFingerprint: first.bundle_fingerprint,
          pages: first.pages.map((page) => ({
            pageId: page.page_id,
            updatedAt: page.updated_at,
            contentSha256: page.content_sha256,
          })),
        },
      },
      context,
    );

    expect(delta.schema_version).toBe(CATALOG_DELTA_SCHEMA_VERSION);
    if (delta.schema_version !== CATALOG_DELTA_SCHEMA_VERSION) {
      throw new Error('expected delta');
    }
    expect(delta.changed).toBe(true);
    expect(delta.changes.updated).toHaveLength(1);
    expect(delta.changes.updated[0].current.page_id).toBe(rootPageId);
    expect(delta.freshness_proof.challenge).toBe('diagnosis-unique-0002');
  });

  it('returns an unchanged Delta only after a fresh live capture', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }

    const delta = await service.callTool(
      'resolve_catalog_delta',
      {
        ...bundleArgs(),
        challenge: 'diagnosis-unique-0003',
        previous: previousFrom(first),
      },
      context,
    );

    expect(snapshotService.capture).toHaveBeenCalledTimes(2);
    expect(delta.schema_version).toBe(CATALOG_DELTA_SCHEMA_VERSION);
    if (delta.schema_version !== CATALOG_DELTA_SCHEMA_VERSION) {
      throw new Error('expected delta');
    }
    expect(delta.changed).toBe(false);
    expect(delta.bundle_fingerprint).toBe(first.bundle_fingerprint);
    expect(delta.changes).toMatchObject({
      added: [],
      updated: [],
      removed: [],
    });
    expect(delta.changes.unchanged).toHaveLength(2);
    expect(delta.freshness_proof.challenge).toBe('diagnosis-unique-0003');
  });

  it('classifies added, removed, and moved pages in one live Delta', async () => {
    const initialPages = [
      capturedPage({
        id: rootPageId,
        content: markdown('# first', ['fact-source/a', 'fact-source/b']),
      }),
      capturedPage({
        id: sourcePageId,
        parentPageId: rootPageId,
        content: sourceMarkdown('fact-source/a'),
      }),
      capturedPage({
        id: secondSourcePageId,
        parentPageId: rootPageId,
        content: sourceMarkdown('fact-source/b'),
      }),
    ];
    const { service, snapshotService } = createHarness(initialPages);
    const first = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }
    snapshotService.capture.mockResolvedValueOnce(
      snapshot(
        [
          capturedPage({
            id: rootPageId,
            content: markdown('# changed', ['fact-source/b', 'fact-source/c']),
            updatedAt: '2026-08-20T00:01:00.000Z',
          }),
          capturedPage({
            id: secondSourcePageId,
            parentPageId: null,
            content: sourceMarkdown('fact-source/b'),
            updatedAt: '2026-08-20T00:01:00.000Z',
          }),
          capturedPage({
            id: thirdSourcePageId,
            parentPageId: rootPageId,
            content: sourceMarkdown('fact-source/c'),
            updatedAt: '2026-08-20T00:01:00.000Z',
          }),
        ],
        '2026-08-20T00:01:01.000Z',
      ),
    );

    const delta = await service.callTool(
      'resolve_catalog_delta',
      {
        ...bundleArgs(),
        challenge: 'diagnosis-unique-0004',
        previous: previousFrom(first),
      },
      context,
    );
    if (delta.schema_version !== CATALOG_DELTA_SCHEMA_VERSION) {
      throw new Error('expected delta');
    }

    expect(delta.changes.added.map((page) => page.page_id)).toEqual([
      thirdSourcePageId,
    ]);
    expect(delta.changes.removed.map((page) => page.page_id)).toEqual([
      sourcePageId,
    ]);
    expect(delta.changes.updated.map((item) => item.current.page_id)).toEqual([
      rootPageId,
      secondSourcePageId,
    ]);
    expect(
      delta.changes.updated.find(
        (item) => item.current.page_id === secondSourcePageId,
      )?.current.parent_page_id,
    ).toBeNull();
  });

  it('turns a newly inaccessible referenced page into a removal and data gap', async () => {
    const { service, snapshotService } = createHarness();
    const first = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );
    if (first.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }
    snapshotService.capture.mockResolvedValueOnce(
      snapshot([basePages()[0]], '2026-08-20T00:02:00.000Z'),
    );

    const delta = await service.callTool(
      'resolve_catalog_delta',
      {
        ...bundleArgs(),
        challenge: 'diagnosis-unique-0005',
        previous: previousFrom(first),
      },
      context,
    );
    if (delta.schema_version !== CATALOG_DELTA_SCHEMA_VERSION) {
      throw new Error('expected delta');
    }

    expect(delta.changed).toBe(true);
    expect(delta.closure_complete).toBe(false);
    expect(delta.changes.removed).toEqual([
      expect.objectContaining({ page_id: sourcePageId }),
    ]);
    expect(delta.unresolved_references).toEqual([
      expect.objectContaining({ reason: 'missing_or_not_accessible' }),
    ]);
  });

  it.each([
    {
      content: '---\na: 1\na: 2\n---\n# broken',
      reason: 'malformed_catalog_page',
    },
    {
      content: [
        '---',
        'document_type: service_profile',
        'schema_version: service-profile.v99',
        'entity_id: service/example',
        '---',
      ].join('\n'),
      reason: 'unsupported_catalog_document',
    },
  ])('classifies an explicit invalid root as $reason', async (testCase) => {
    const { service } = createHarness([
      capturedPage({ id: rootPageId, content: testCase.content }),
    ]);

    const result = await service.callTool(
      'resolve_catalog_bundle',
      bundleArgs(),
      context,
    );
    if (result.schema_version !== CATALOG_BUNDLE_SCHEMA_VERSION) {
      throw new Error('expected bundle');
    }

    expect(result.roots).toEqual([
      expect.objectContaining({
        status: 'unresolved',
        reason: testCase.reason,
      }),
    ]);
  });

  it('rejects root, closure, and edge capacity overflows', async () => {
    const { service, registry } = createHarness();
    await expect(
      service.callTool(
        'resolve_catalog_bundle',
        {
          ...bundleArgs(),
          roots: Array.from({ length: CATALOG_LIMITS.maxRoots + 1 }, () => ({
            pageId: rootPageId,
          })),
        },
        context,
      ),
    ).rejects.toThrow(`at most ${CATALOG_LIMITS.maxRoots}`);

    const manySources = Array.from(
      { length: CATALOG_LIMITS.maxClosurePages },
      (_, index) => `fact-source/${index}`,
    );
    const manyPages = [
      capturedPage({
        id: rootPageId,
        content: markdown('# large closure', manySources),
      }),
      ...manySources.map((entityId, index) =>
        capturedPage({
          id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
          content: sourceMarkdown(entityId),
        }),
      ),
    ];
    const closureHarness = createHarness(manyPages);
    await expect(
      closureHarness.service.callTool(
        'resolve_catalog_bundle',
        bundleArgs(),
        context,
      ),
    ).rejects.toThrow(`exceeds ${CATALOG_LIMITS.maxClosurePages} pages`);

    jest.spyOn(registry, 'buildBundleGraph').mockReturnValueOnce({
      roots: [],
      pages: [],
      edges: Array.from(
        { length: CATALOG_LIMITS.maxEdges + 1 },
        (_, index) => ({
          from_page_id: rootPageId,
          to_page_id: sourcePageId,
          relation: `relation.${index}`,
          target: {
            document_type: 'fact_source_profile',
            entity_id: `fact-source/${index}`,
          },
        }),
      ),
      unresolvedReferences: [],
    });
    await expect(
      service.callTool('resolve_catalog_bundle', bundleArgs(), context),
    ).rejects.toThrow(`exceeds ${CATALOG_LIMITS.maxEdges} edges`);
  });
});
