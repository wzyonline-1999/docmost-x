jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToHtml: (content: unknown) => JSON.stringify(content),
  jsonToMarkdown: (content: unknown) => JSON.stringify(content),
}));

jest.mock('../../page/services/page.service', () => ({
  PageService: class PageService {},
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpToolService } from './mcp-tool.service';
import type { McpToolContext } from '../types/mcp-tool.types';

describe('McpToolService', () => {
  const actor = {
    id: 'user-1',
    workspaceId: 'workspace-1',
  };
  const page = {
    id: '11111111-1111-4111-8111-111111111111',
    slugId: 'actor-guard-page',
    title: 'Actor guard page',
    icon: null,
    parentPageId: null,
    spaceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'workspace-1',
    creatorId: 'user-1',
    lastUpdatedById: 'user-1',
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    deletedAt: null,
    content: { type: 'doc', content: [] },
    textContent: '',
  };
  const context = {
    client: {
      id: 'client-1',
      workspaceId: 'workspace-1',
      actorUserId: actor.id,
      status: 'active',
    },
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
  } as unknown as McpToolContext;

  const createService = (
    overrides: {
      db?: unknown;
      auditService?: unknown;
      attachmentMcpService?: unknown;
      embeddingService?: unknown;
      environmentService?: unknown;
      idempotencyService?: unknown;
      pageRepo?: unknown;
      pageService?: unknown;
      pageHistoryMcpService?: unknown;
      permissionService?: unknown;
      vectorIndexService?: unknown;
      actorAccessService?: unknown;
    } = {},
  ) =>
    new McpToolService(
      (overrides.db ?? null) as never,
      (overrides.auditService ?? {
        tryLog: jest.fn().mockResolvedValue(true),
        logPermissionDenied: jest.fn().mockResolvedValue(true),
      }) as never,
      (overrides.attachmentMcpService ?? null) as never,
      (overrides.embeddingService ?? null) as never,
      (overrides.environmentService ?? null) as never,
      (overrides.idempotencyService ?? null) as never,
      (overrides.pageRepo ?? null) as never,
      (overrides.pageService ?? null) as never,
      (overrides.pageHistoryMcpService ?? {
        capturePageSnapshot: jest.fn().mockResolvedValue([]),
      }) as never,
      (overrides.permissionService ?? null) as never,
      (overrides.vectorIndexService ?? null) as never,
      (overrides.actorAccessService ?? null) as never,
    );

  const createPageReadHarness = () => {
    const pageQuery = {
      select: jest.fn().mockReturnThis(),
      $if: jest
        .fn()
        .mockImplementation((condition, callback) =>
          condition ? callback(pageQuery) : pageQuery,
        ),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(page),
    };
    const db = {
      selectFrom: jest.fn(() => pageQuery),
    };
    const environmentService = {
      getMcpReadAuditSampleRate: jest.fn(() => 0),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue({ canRead: true }),
      getEffectiveSpacePermission: jest
        .fn()
        .mockResolvedValue({ canRead: true }),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanViewPage: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService({
      db,
      environmentService,
      permissionService,
      actorAccessService,
    });
    const getIndexStatusForPage = jest
      .spyOn(
        service as unknown as {
          getIndexStatusForPage: () => Promise<unknown>;
        },
        'getIndexStatusForPage',
      )
      .mockResolvedValue({ chunkCount: 0 });

    return {
      service,
      db,
      pageQuery,
      environmentService,
      permissionService,
      actorAccessService,
      getIndexStatusForPage,
    };
  };

  it('registers read, search, indexing, and write tools', () => {
    const service = createService();

    expect(service.listTools().map((tool) => tool.name)).toEqual([
      'list_spaces',
      'list_pages',
      'get_page',
      'list_page_versions',
      'get_page_version',
      'diff_page_versions',
      'restore_page_version',
      'list_attachments',
      'get_attachment',
      'upload_attachment',
      'delete_attachment',
      'search_docs',
      'semantic_search_docs',
      'create_page',
      'update_page',
      'append_page',
      'delete_page',
      'restore_page',
      'reindex_page',
      'reindex_space',
      'reindex_workspace',
      'get_index_status',
      'list_index_jobs',
      'retry_index_job',
      'pause_index_job',
      'resume_index_job',
      'cancel_index_job',
    ]);
  });

  it('reports only effective permissions when listing spaces', async () => {
    const configuredRows = [
      {
        id: 'space-1',
        name: 'Writable space',
        slug: 'writable-space',
        description: null,
        visibility: 'private',
        isPersonal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        canSearch: true,
        canSemanticSearch: false,
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canAppend: false,
        canDelete: false,
        canRestore: false,
        canIndex: true,
      },
      {
        id: 'space-2',
        name: 'Stale space',
        slug: 'stale-space',
        description: null,
        visibility: 'private',
        isPersonal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        canSearch: false,
        canSemanticSearch: false,
        canRead: false,
        canCreate: false,
        canUpdate: true,
        canAppend: false,
        canDelete: false,
        canRestore: false,
        canIndex: false,
      },
    ];
    const spaceQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(configuredRows),
    };
    const permissionService = {
      resolveEffectivePermissions: jest.fn().mockResolvedValue([
        {
          spaceId: 'space-1',
          permissions: {
            canSearch: true,
            canSemanticSearch: false,
            canRead: true,
            canCreate: false,
            canUpdate: false,
            canAppend: false,
            canDelete: false,
            canRestore: false,
            canIndex: true,
          },
        },
        {
          spaceId: 'space-2',
          permissions: {
            canSearch: false,
            canSemanticSearch: false,
            canRead: false,
            canCreate: false,
            canUpdate: false,
            canAppend: false,
            canDelete: false,
            canRestore: false,
            canIndex: false,
          },
        },
      ]),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      filterReadableSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-2']),
    };
    const service = createService({
      db: { selectFrom: jest.fn(() => spaceQuery) },
      permissionService,
      actorAccessService,
    });

    const result = await service.callTool(
      { name: 'list_spaces', arguments: {} },
      context,
    );

    expect(result.structuredContent).toEqual({
      items: [
        expect.objectContaining({
          id: 'space-1',
          permissions: expect.objectContaining({
            canRead: true,
            canCreate: false,
            canUpdate: false,
          }),
        }),
      ],
    });
  });

  it('keeps the highest-scoring semantic chunk for each page', () => {
    const service = createService();
    const dedupe = (
      service as unknown as {
        dedupeBestSemanticItems: (items: unknown[]) => Array<{
          pageId: string;
          snippet: string;
          scores: { semantic: number };
        }>;
      }
    ).dedupeBestSemanticItems.bind(service);
    const items = [
      {
        pageId: 'page-1',
        spaceId: 'space-1',
        title: 'Page',
        snippet: 'best chunk',
        scores: { semantic: 0.92, final: 0.92 },
        source: 'semantic',
      },
      {
        pageId: 'page-1',
        spaceId: 'space-1',
        title: 'Page',
        snippet: 'lower chunk',
        scores: { semantic: 0.41, final: 0.41 },
        source: 'semantic',
      },
    ];

    expect(dedupe(items)).toEqual([
      expect.objectContaining({
        pageId: 'page-1',
        snippet: 'best chunk',
        scores: expect.objectContaining({ semantic: 0.92 }),
      }),
    ]);
  });

  it('normalizes hybrid components, adds recency, and returns one row per page', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    try {
      const environmentService = {
        getVectorHybridSemanticWeight: jest.fn(() => 0.65),
        getVectorHybridKeywordWeight: jest.fn(() => 0.25),
        getVectorHybridRecencyWeight: jest.fn(() => 0.1),
      };
      const service = createService({ environmentService });
      const merge = (
        service as unknown as {
          mergeSearchItems: (
            keyword: unknown[],
            semantic: unknown[],
            limit: number,
          ) => Array<{
            pageId: string;
            source: string;
            snippet: string;
            scores: Record<string, number>;
          }>;
        }
      ).mergeSearchItems.bind(service);
      const updatedAt = new Date('2026-07-10T00:00:00.000Z');
      const keyword = [
        {
          pageId: 'page-a',
          spaceId: 'space-1',
          title: 'A',
          snippet: 'keyword A',
          updatedAt,
          scores: { keyword: 10, final: 10 },
          source: 'keyword',
        },
        {
          pageId: 'page-b',
          spaceId: 'space-1',
          title: 'B',
          snippet: 'keyword B',
          updatedAt,
          scores: { keyword: 5, final: 5 },
          source: 'keyword',
        },
      ];
      const semantic = [
        {
          pageId: 'page-a',
          spaceId: 'space-1',
          title: 'A',
          snippet: 'semantic A best',
          updatedAt,
          scores: { semantic: 0.8, final: 0.8 },
          source: 'semantic',
        },
        {
          pageId: 'page-a',
          spaceId: 'space-1',
          title: 'A',
          snippet: 'semantic A lower',
          updatedAt,
          scores: { semantic: 0.2, final: 0.2 },
          source: 'semantic',
        },
        {
          pageId: 'page-c',
          spaceId: 'space-1',
          title: 'C',
          snippet: 'semantic C',
          updatedAt,
          scores: { semantic: 0.9, final: 0.9 },
          source: 'semantic',
        },
      ];

      const result = merge(keyword, semantic, 10);

      expect(result.map((item) => item.pageId).sort()).toEqual([
        'page-a',
        'page-b',
        'page-c',
      ]);
      expect(new Set(result.map((item) => item.pageId)).size).toBe(
        result.length,
      );
      const pageA = result.find((item) => item.pageId === 'page-a');
      expect(pageA).toMatchObject({
        source: 'hybrid',
        snippet: 'keyword A',
        scores: {
          keyword: 1,
          semantic: 0,
          recency: 1,
          final: 0.35,
        },
      });
      expect(
        result.find((item) => item.pageId === 'page-c')?.scores.final,
      ).toBeCloseTo(0.75);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires explicit confirmation before high-risk tools run', async () => {
    const service = createService();

    await expect(
      service.callTool(
        { name: 'delete_page', arguments: { pageId: 'page-1' } },
        context,
      ),
    ).rejects.toThrow('delete_page requires confirm=true');
  });

  it('preserves page reads for an actor with native access', async () => {
    const { service, permissionService, actorAccessService } =
      createPageReadHarness();

    const result = await service.callTool(
      {
        name: 'get_page',
        arguments: { pageId: page.id, format: 'markdown' },
      },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      page: { id: page.id, spaceId: page.spaceId },
      content: JSON.stringify(page.content),
      format: 'markdown',
    });
    expect(permissionService.assertSpacePermission).toHaveBeenCalledWith(
      context.client,
      'read',
      page.spaceId,
    );
    expect(permissionService.getEffectiveSpacePermission).toHaveBeenCalledWith(
      context.client,
      page.spaceId,
    );
    expect(actorAccessService.assertCanViewPage).toHaveBeenCalledWith(
      actor,
      page,
    );
  });

  it('reads a page by slug id', async () => {
    const { service, pageQuery } = createPageReadHarness();

    const result = await service.callTool(
      {
        name: 'get_page',
        arguments: { slugId: page.slugId },
      },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      page: { id: page.id, slugId: page.slugId },
    });
    expect(pageQuery.where).toHaveBeenCalledWith('slugId', '=', page.slugId);
  });

  it('deterministically prefers pageId when both page selectors are present', async () => {
    const { service, pageQuery } = createPageReadHarness();

    await service.callTool(
      {
        name: 'get_page',
        arguments: {
          pageId: page.id,
          slugId: 'different-page',
        },
      },
      context,
    );

    expect(pageQuery.where).toHaveBeenCalledWith('id', '=', page.id);
    expect(pageQuery.where).not.toHaveBeenCalledWith(
      'slugId',
      '=',
      'different-page',
    );
  });

  it('rejects a missing page selector before querying pages', async () => {
    const { service, db } = createPageReadHarness();

    await expect(
      service.callTool({ name: 'get_page', arguments: {} }, context),
    ).rejects.toThrow('pageId or slugId is required');
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['markdown', JSON.stringify(page.content)],
    ['html', JSON.stringify(page.content)],
    ['json', page.content],
  ])('returns page content in %s format', async (format, expectedContent) => {
    const { service } = createPageReadHarness();

    const result = await service.callTool(
      {
        name: 'get_page',
        arguments: { pageId: page.id, format },
      },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      content: expectedContent,
      format,
    });
  });

  it('rejects invalid page content formats before auditing the read', async () => {
    const { service } = createPageReadHarness();

    await expect(
      service.callTool(
        {
          name: 'get_page',
          arguments: { pageId: page.id, format: 'xml' },
        },
        context,
      ),
    ).rejects.toThrow('format must be markdown, html, or json');
  });

  it('masks deleted pages as not found without returning content', async () => {
    const { service, pageQuery, actorAccessService } = createPageReadHarness();
    pageQuery.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(
      service.callTool(
        { name: 'get_page', arguments: { pageId: page.id } },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(actorAccessService.assertCanViewPage).not.toHaveBeenCalled();
  });

  it('rejects page reads when the MCP client has no actor mapping', async () => {
    const { service, actorAccessService } = createPageReadHarness();
    actorAccessService.requireActor.mockRejectedValueOnce(
      new ForbiddenException('MCP page tools require an actor user mapping'),
    );

    await expect(
      service.callTool(
        {
          name: 'get_page',
          arguments: { pageId: page.id, format: 'markdown' },
        },
        {
          ...context,
          client: { ...context.client, actorUserId: null },
        } as McpToolContext,
      ),
    ).rejects.toThrow('actor user mapping');
  });

  it('masks native page denials through the public tool boundary', async () => {
    const { service, actorAccessService, getIndexStatusForPage } =
      createPageReadHarness();
    actorAccessService.assertCanViewPage.mockRejectedValueOnce(
      new NotFoundException('Page not found'),
    );

    await expect(
      service.callTool(
        {
          name: 'get_page',
          arguments: { pageId: page.id, format: 'markdown' },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getIndexStatusForPage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'update_page',
      arguments: { pageId: page.id, title: 'Blocked update' },
    },
    {
      name: 'append_page',
      arguments: { pageId: page.id, content: 'Blocked append' },
    },
    {
      name: 'delete_page',
      arguments: { pageId: page.id, confirm: true },
    },
    {
      name: 'restore_page',
      arguments: { pageId: page.id, confirm: true },
    },
  ])(
    'checks MCP $name permission before resolving the actor',
    async (params) => {
      const auditService = {
        logPermissionDenied: jest.fn().mockResolvedValue(true),
      };
      const permissionService = {
        assertPagePermission: jest
          .fn()
          .mockRejectedValue(new ForbiddenException('MCP permission denied')),
      };
      const actorAccessService = {
        requireActor: jest.fn().mockResolvedValue(actor),
      };
      const service = createService({
        auditService,
        permissionService,
        actorAccessService,
      });

      await expect(service.callTool(params, context)).rejects.toThrow(
        'MCP permission denied',
      );
      expect(actorAccessService.requireActor).not.toHaveBeenCalled();
      expect(auditService.logPermissionDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: context.client.actorUserId,
          toolName: params.name,
          action: params.name,
          resourceType: 'page',
          resourceId: page.id,
          requestId: context.requestId,
        }),
      );
    },
  );

  it.each([
    {
      name: 'update_page',
      arguments: { pageId: page.id, title: 'Denied update' },
    },
    {
      name: 'delete_page',
      arguments: { pageId: page.id, confirm: true },
    },
  ])('blocks $name when the actor lacks native edit access', async (params) => {
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      update: jest.fn(),
      removePage: jest.fn(),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Page not found')),
    };
    const idempotencyService = { run: jest.fn() };
    const service = createService({
      permissionService,
      pageRepo,
      pageService,
      actorAccessService,
      idempotencyService,
    });

    await expect(service.callTool(params, context)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(pageService.update).not.toHaveBeenCalled();
    expect(pageService.removePage).not.toHaveBeenCalled();
    expect(idempotencyService.run).not.toHaveBeenCalled();
  });

  it('uses atomic optimistic locking and reports a post-write audit failure', async () => {
    const expectedUpdatedAt = page.updatedAt.toISOString();
    const updatedPage = {
      ...page,
      title: 'Atomic update',
      updatedAt: new Date(page.updatedAt.getTime() + 1),
    };
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      update: jest.fn().mockResolvedValue(updatedPage),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest.fn().mockImplementation(({ run }) =>
        run({
          checkpointResourceId: jest.fn().mockResolvedValue(undefined),
          checkpoint: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    const environmentService = {
      isVectorSearchEnabled: jest.fn(() => false),
    };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(false),
    };
    const pageHistoryMcpService = {
      capturePageSnapshot: jest.fn().mockResolvedValue([]),
    };
    const service = createService({
      auditService,
      environmentService,
      idempotencyService,
      pageRepo,
      pageService,
      pageHistoryMcpService,
      permissionService,
      actorAccessService,
    });

    const result = await service.callTool(
      {
        name: 'update_page',
        arguments: {
          pageId: page.id,
          title: 'Atomic update',
          expectedUpdatedAt,
          idempotencyKey: 'atomic-update-1',
        },
      },
      context,
    );

    expect(pageService.update).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        pageId: page.id,
        title: 'Atomic update',
      }),
      actor,
      { expectedUpdatedAt: new Date(expectedUpdatedAt) },
    );
    expect(pageHistoryMcpService.capturePageSnapshot).toHaveBeenCalledWith(
      page,
      actor.id,
    );
    expect(result.structuredContent).toMatchObject({
      page: { id: page.id, title: 'Atomic update' },
      warnings: [
        'MCP operation succeeded, but its audit log could not be persisted',
      ],
    });
    expect(auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.page.update',
        resourceId: page.id,
      }),
    );
  });

  it('audits page creation without persisting raw content', async () => {
    const transaction = {
      execute: jest.fn(
        async (callback: (trx: Record<string, never>) => Promise<unknown>) =>
          callback({}),
      ),
    };
    const db = { transaction: jest.fn(() => transaction) };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue({ canCreate: true }),
    };
    const pageService = {
      create: jest.fn().mockResolvedValue(page),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest
        .fn()
        .mockImplementation(({ run }) =>
          run({ checkpoint: jest.fn().mockResolvedValue(undefined) }),
        ),
    };
    const pageHistoryMcpService = {
      capturePageSnapshot: jest.fn().mockResolvedValue([]),
    };
    const service = createService({
      auditService,
      actorAccessService,
      db,
      environmentService: {
        getMcpMaxWriteContentLength: jest.fn(() => 1_000),
      },
      idempotencyService,
      pageHistoryMcpService,
      pageService,
      permissionService,
    });
    jest
      .spyOn(
        service as unknown as {
          assertActiveSpace: () => Promise<void>;
        },
        'assertActiveSpace',
      )
      .mockResolvedValue(undefined);
    jest
      .spyOn(
        service as unknown as {
          tryIndexPage: () => Promise<{
            index: null;
            warnings: string[];
          }>;
        },
        'tryIndexPage',
      )
      .mockResolvedValue({ index: null, warnings: [] });

    await service.callTool(
      {
        name: 'create_page',
        arguments: {
          spaceId: page.spaceId,
          title: page.title,
          content: 'content-that-must-not-enter-audit',
        },
      },
      context,
    );

    expect(auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: context.client.workspaceId,
        clientId: context.client.id,
        actorUserId: actor.id,
        event: 'mcp.page.create',
        resourceType: 'page',
        resourceId: page.id,
        spaceId: page.spaceId,
        toolName: 'create_page',
        requestId: context.requestId,
        after: expect.objectContaining({ title: page.title }),
        metadata: {
          contentHash: expect.any(String),
        },
        ipAddress: context.ipAddress,
      }),
    );
    expect(pageHistoryMcpService.capturePageSnapshot).toHaveBeenCalledWith(
      page,
      actor.id,
    );
    expect(JSON.stringify(auditService.tryLog.mock.calls)).not.toContain(
      'content-that-must-not-enter-audit',
    );
  });

  it('audits page append with a hash and length instead of raw content', async () => {
    const appendedPage = {
      ...page,
      updatedAt: new Date(page.updatedAt.getTime() + 1),
    };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      prepareProsemirrorContent: jest.fn().mockResolvedValue({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      }),
      update: jest.fn().mockResolvedValue(appendedPage),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest
        .fn()
        .mockImplementation(({ run }) =>
          run({ checkpoint: jest.fn().mockResolvedValue(undefined) }),
        ),
    };
    const pageHistoryMcpService = {
      capturePageSnapshot: jest.fn().mockResolvedValue([]),
    };
    const service = createService({
      auditService,
      actorAccessService,
      environmentService: {
        getMcpMaxWriteContentLength: jest.fn(() => 1_000),
      },
      idempotencyService,
      pageHistoryMcpService,
      pageRepo,
      pageService,
      permissionService,
    });
    jest
      .spyOn(
        service as unknown as {
          tryIndexPage: () => Promise<{
            index: null;
            warnings: string[];
          }>;
        },
        'tryIndexPage',
      )
      .mockResolvedValue({ index: null, warnings: [] });

    await service.callTool(
      {
        name: 'append_page',
        arguments: {
          pageId: page.id,
          heading: 'Audit notes',
          content: 'append-secret-body',
        },
      },
      context,
    );

    expect(auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.page.append',
        resourceId: page.id,
        toolName: 'append_page',
        requestId: context.requestId,
        metadata: {
          heading: 'Audit notes',
          contentHash: expect.any(String),
          contentLength: 'append-secret-body'.length,
        },
      }),
    );
    expect(pageHistoryMcpService.capturePageSnapshot).toHaveBeenCalledWith(
      page,
      actor.id,
    );
    expect(JSON.stringify(auditService.tryLog.mock.calls)).not.toContain(
      'append-secret-body',
    );
  });

  it('routes deletion through a delete index job and records strict audit data', async () => {
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      removePage: jest.fn().mockResolvedValue(undefined),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest
        .fn()
        .mockImplementation(({ run }) =>
          run({ checkpoint: jest.fn().mockResolvedValue(undefined) }),
        ),
    };
    const pageHistoryMcpService = {
      capturePageSnapshot: jest.fn().mockResolvedValue([]),
    };
    const service = createService({
      auditService,
      actorAccessService,
      idempotencyService,
      pageHistoryMcpService,
      pageRepo,
      pageService,
      permissionService,
    });
    const tryIndexPage = jest
      .spyOn(
        service as unknown as {
          tryIndexPage: () => Promise<{
            index: { jobType: string };
            warnings: string[];
          }>;
        },
        'tryIndexPage',
      )
      .mockResolvedValue({ index: { jobType: 'delete' }, warnings: [] });

    await service.callTool(
      {
        name: 'delete_page',
        arguments: {
          pageId: page.id,
          confirm: true,
          reason: 'test cleanup',
        },
      },
      context,
    );

    expect(tryIndexPage).toHaveBeenCalledWith(context, page.id, 'delete');
    expect(pageHistoryMcpService.capturePageSnapshot).toHaveBeenCalledWith(
      page,
      actor.id,
    );
    expect(auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.page.delete',
        resourceId: page.id,
        toolName: 'delete_page',
        requestId: context.requestId,
        before: expect.objectContaining({ title: page.title }),
        metadata: { reason: 'test cleanup' },
      }),
    );
  });

  it('routes restoration through a restore index job and records strict audit data', async () => {
    const deletedPage = {
      ...page,
      deletedAt: new Date('2026-07-10T01:00:00.000Z'),
    };
    const restoredPage = { ...page, deletedAt: null };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(deletedPage),
    };
    const pageRepo = {
      findById: jest
        .fn()
        .mockResolvedValueOnce(deletedPage)
        .mockResolvedValueOnce(restoredPage),
      restorePage: jest.fn().mockResolvedValue(undefined),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest
        .fn()
        .mockImplementation(({ run }) =>
          run({ checkpoint: jest.fn().mockResolvedValue(undefined) }),
        ),
    };
    const service = createService({
      auditService,
      actorAccessService,
      idempotencyService,
      pageRepo,
      permissionService,
    });
    const tryIndexPage = jest
      .spyOn(
        service as unknown as {
          tryIndexPage: () => Promise<{
            index: { jobType: string };
            warnings: string[];
          }>;
        },
        'tryIndexPage',
      )
      .mockResolvedValue({ index: { jobType: 'restore' }, warnings: [] });

    await service.callTool(
      {
        name: 'restore_page',
        arguments: {
          pageId: page.id,
          confirm: true,
          reason: 'undo test cleanup',
        },
      },
      context,
    );

    expect(pageRepo.restorePage).toHaveBeenCalledWith(
      page.id,
      context.client.workspaceId,
    );
    expect(tryIndexPage).toHaveBeenCalledWith(context, page.id, 'restore');
    expect(auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.page.restore',
        resourceId: page.id,
        toolName: 'restore_page',
        requestId: context.requestId,
        after: expect.objectContaining({ title: page.title }),
        metadata: { reason: 'undo test cleanup' },
      }),
    );
  });

  it('rejects an invalid optimistic-lock timestamp before idempotent execution', async () => {
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = { run: jest.fn() };
    const service = createService({
      idempotencyService,
      pageRepo,
      permissionService,
      actorAccessService,
    });

    await expect(
      service.callTool(
        {
          name: 'update_page',
          arguments: {
            pageId: page.id,
            title: 'Blocked update',
            expectedUpdatedAt: 'not-a-date',
          },
        },
        context,
      ),
    ).rejects.toThrow('expectedUpdatedAt must be a valid date');
    expect(idempotencyService.run).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'content must be a string or object'],
    [[], 'content must be a string or object'],
    ['too-long', 'content is too long'],
  ])(
    'rejects invalid create content %p before idempotent execution',
    async (content, message) => {
      const spaceQuery = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        executeTakeFirst: jest.fn().mockResolvedValue({ id: page.spaceId }),
      };
      const db = { selectFrom: jest.fn(() => spaceQuery) };
      const permissionService = {
        assertSpacePermission: jest.fn().mockResolvedValue({ canCreate: true }),
      };
      const actorAccessService = {
        requireActor: jest.fn().mockResolvedValue(actor),
        assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
      };
      const environmentService = {
        getMcpMaxWriteContentLength: jest.fn(() => 4),
      };
      const idempotencyService = { run: jest.fn() };
      const service = createService({
        db,
        environmentService,
        idempotencyService,
        permissionService,
        actorAccessService,
      });

      await expect(
        service.callTool(
          {
            name: 'create_page',
            arguments: {
              spaceId: page.spaceId,
              title: 'Invalid content',
              content,
            },
          },
          context,
        ),
      ).rejects.toThrow(message);
      expect(idempotencyService.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ content: null }, 'content must be a string or object'],
    [{ content: [] }, 'content must be a string or object'],
    [
      { content: 'valid', format: 'xml' },
      'format must be markdown, html, or json',
    ],
  ])(
    'rejects invalid update input %p before idempotent execution',
    async (patch, message) => {
      const permissionService = {
        assertPagePermission: jest.fn().mockResolvedValue(page),
      };
      const pageRepo = {
        findById: jest.fn().mockResolvedValue(page),
      };
      const actorAccessService = {
        requireActor: jest.fn().mockResolvedValue(actor),
        assertCanEditPage: jest.fn().mockResolvedValue(undefined),
      };
      const idempotencyService = { run: jest.fn() };
      const pageService = { prepareProsemirrorContent: jest.fn() };
      const service = createService({
        actorAccessService,
        environmentService: {
          getMcpMaxWriteContentLength: jest.fn(() => 1000),
        },
        idempotencyService,
        pageRepo,
        pageService,
        permissionService,
      });

      await expect(
        service.callTool(
          {
            name: 'update_page',
            arguments: { pageId: page.id, ...patch },
          },
          context,
        ),
      ).rejects.toThrow(message);
      expect(idempotencyService.run).not.toHaveBeenCalled();
      expect(pageService.prepareProsemirrorContent).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid write format before idempotent execution', async () => {
    const spaceQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue({ id: page.spaceId }),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue({ canCreate: true }),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = { run: jest.fn() };
    const service = createService({
      db: { selectFrom: jest.fn(() => spaceQuery) },
      environmentService: {
        getMcpMaxWriteContentLength: jest.fn(() => 1000),
      },
      idempotencyService,
      permissionService,
      actorAccessService,
    });

    await expect(
      service.callTool(
        {
          name: 'create_page',
          arguments: {
            spaceId: page.spaceId,
            title: 'Invalid format',
            content: 'content',
            format: 'xml',
          },
        },
        context,
      ),
    ).rejects.toThrow('format must be markdown, html, or json');
    expect(idempotencyService.run).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...page, spaceId: 'different-space' }, 'Parent page not found'],
    [{ ...page, deletedAt: new Date() }, 'Parent page not found'],
    [undefined, 'Parent page not found'],
  ])(
    'rejects an invalid parent page %p before creating a child',
    async (parentPage, message) => {
      const spaceQuery = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        executeTakeFirst: jest.fn().mockResolvedValue({ id: page.spaceId }),
      };
      const permissionService = {
        assertSpacePermission: jest.fn().mockResolvedValue({ canCreate: true }),
      };
      const pageRepo = {
        findById: jest.fn().mockResolvedValue(parentPage),
      };
      const actorAccessService = {
        requireActor: jest.fn().mockResolvedValue(actor),
        assertCanEditPage: jest.fn(),
      };
      const idempotencyService = { run: jest.fn() };
      const service = createService({
        db: { selectFrom: jest.fn(() => spaceQuery) },
        environmentService: {
          getMcpMaxWriteContentLength: jest.fn(() => 1000),
        },
        idempotencyService,
        pageRepo,
        permissionService,
        actorAccessService,
      });

      await expect(
        service.callTool(
          {
            name: 'create_page',
            arguments: {
              spaceId: page.spaceId,
              parentPageId: 'parent-page',
              title: 'Child',
            },
          },
          context,
        ),
      ).rejects.toThrow(message);
      expect(actorAccessService.assertCanEditPage).not.toHaveBeenCalled();
      expect(idempotencyService.run).not.toHaveBeenCalled();
    },
  );

  it('allows an idempotent delete replay after the page is already deleted', async () => {
    const deletedPage = {
      ...page,
      deletedAt: new Date('2026-07-10T02:00:00.000Z'),
    };
    const storedResponse = {
      page: deletedPage,
      index: null,
      deleted: true,
      warnings: [],
    };
    const permissionService = {
      assertPagePermission: jest.fn().mockResolvedValue(deletedPage),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(deletedPage),
    };
    const pageService = {
      removePage: jest.fn(),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = {
      run: jest.fn().mockResolvedValue(storedResponse),
    };
    const service = createService({
      idempotencyService,
      pageRepo,
      pageService,
      permissionService,
      actorAccessService,
    });

    const result = await service.callTool(
      {
        name: 'delete_page',
        arguments: {
          pageId: page.id,
          confirm: true,
          idempotencyKey: 'delete-page-1',
        },
      },
      context,
    );

    expect(permissionService.assertPagePermission).toHaveBeenCalledWith(
      context.client,
      'delete',
      page.id,
      {
        includeDeleted: true,
        maskPermissionDeniedAsNotFound: true,
      },
    );
    expect(result.structuredContent).toEqual(storedResponse);
    expect(pageService.removePage).not.toHaveBeenCalled();
  });

  it('joins semantic chunks to live pages and filters native page denials', async () => {
    const join = {
      onRef: jest.fn().mockReturnThis(),
    };
    const semanticQuery = {
      innerJoin: jest.fn().mockImplementation((_table, callback) => {
        callback(join);
        return semanticQuery;
      }),
      select: jest.fn().mockReturnThis(),
      selectAll: jest.fn().mockReturnThis(),
      distinctOn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      as: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          pageId: 'allowed-page',
          spaceId: page.spaceId,
          title: 'Allowed result',
          content: 'Allowed content',
          chunkIndex: 0,
          score: 0.9,
          metadata: {
            sourceType: 'attachment',
            attachmentId: 'attachment-1',
            attachmentFileName: 'report.pdf',
          },
        },
        {
          pageId: 'denied-page',
          spaceId: page.spaceId,
          title: 'Denied result',
          content: 'Denied content',
          chunkIndex: 0,
          score: 0.8,
          metadata: { sourceType: 'page' },
        },
      ]),
    };
    const db = {
      selectFrom: jest.fn(() => semanticQuery),
    };
    const environmentService = {
      isVectorSearchEnabled: jest.fn(() => true),
      getMcpMaxQueryLength: jest.fn(() => 1000),
      getEmbeddingModel: jest.fn(() => 'test-embedding'),
    };
    const embeddingService = {
      createEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
    const permissionService = {
      getAllowedSpaceIds: jest.fn().mockResolvedValue([page.spaceId]),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      filterReadableSpaceIds: jest.fn().mockResolvedValue([page.spaceId]),
      filterReadablePageIds: jest.fn().mockResolvedValue(['allowed-page']),
    };
    const service = createService({
      db,
      environmentService,
      embeddingService,
      permissionService,
      actorAccessService,
    });

    const result = await service.callTool(
      {
        name: 'semantic_search_docs',
        arguments: { query: 'permission boundary' },
      },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      items: [
        {
          pageId: 'allowed-page',
          title: 'Allowed result',
          contentSource: {
            type: 'attachment',
            attachmentId: 'attachment-1',
            fileName: 'report.pdf',
          },
        },
      ],
    });
    expect(semanticQuery.innerJoin).toHaveBeenCalledWith(
      'pages',
      expect.any(Function),
    );
    expect(join.onRef).toHaveBeenCalledWith('pages.id', '=', 'chunks.pageId');
    expect(join.onRef).toHaveBeenCalledWith(
      'pages.workspaceId',
      '=',
      'chunks.workspaceId',
    );
    expect(semanticQuery.where).toHaveBeenCalledWith('pages.spaceId', 'in', [
      page.spaceId,
    ]);
    expect(semanticQuery.where).toHaveBeenCalledWith(
      'pages.deletedAt',
      'is',
      null,
    );
    expect(actorAccessService.filterReadablePageIds).toHaveBeenCalledWith(
      actor,
      ['allowed-page', 'denied-page'],
    );
  });

  it.each([
    { name: 'list_spaces', arguments: {} },
    { name: 'search_docs', arguments: { query: 'actor boundary' } },
  ])(
    'fails closed for $name when the actor mapping is missing',
    async (params) => {
      const listSpacesQuery = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue([]),
      };
      const db = {
        selectFrom: jest.fn(() => listSpacesQuery),
      };
      const environmentService = {
        getMcpMaxQueryLength: jest.fn(() => 1000),
      };
      const permissionService = {
        getAllowedSpaceIds: jest.fn().mockResolvedValue([]),
      };
      const actorAccessService = {
        requireActor: jest
          .fn()
          .mockRejectedValue(
            new ForbiddenException(
              'MCP page tools require an actor user mapping',
            ),
          ),
      };
      const service = createService({
        db,
        environmentService,
        permissionService,
        actorAccessService,
      });

      await expect(service.callTool(params, context)).rejects.toThrow(
        'actor user mapping',
      );
    },
  );

  it('filters mixed search scopes and safely accepts special-character queries', async () => {
    const permissionService = {
      getAllowedSpaceIds: jest.fn().mockResolvedValue(['space-allowed']),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-allowed']),
      filterReadablePageIds: jest.fn().mockResolvedValue(['allowed-page']),
    };
    const environmentService = {
      getMcpMaxQueryLength: jest.fn(() => 500),
    };
    const service = createService({
      environmentService,
      permissionService,
      actorAccessService,
    });
    const keywordSearch = jest
      .spyOn(
        service as unknown as {
          keywordSearch: (
            workspaceId: string,
            spaceIds: string[],
            query: string,
            limit: number,
          ) => Promise<unknown[]>;
        },
        'keywordSearch',
      )
      .mockResolvedValue([
        {
          pageId: 'allowed-page',
          spaceId: 'space-allowed',
          title: 'Allowed result',
          snippet: 'Allowed content',
          updatedAt: new Date(),
          scores: { keyword: 1, final: 1 },
          source: 'keyword',
        },
        {
          pageId: 'denied-page',
          spaceId: 'space-denied',
          title: 'Workspace B secret title',
          snippet: 'Workspace B secret content',
          updatedAt: new Date(),
          scores: { keyword: 0.9, final: 0.9 },
          source: 'keyword',
        },
      ]);
    const query = '"alpha beta" OR -secret 中文 & !';

    const result = await service.callTool(
      {
        name: 'search_docs',
        arguments: {
          mode: 'keyword',
          query,
          spaceIds: ['space-allowed', 'space-denied'],
        },
      },
      context,
    );

    expect(permissionService.getAllowedSpaceIds).toHaveBeenCalledWith(
      context.client,
      'search',
      ['space-allowed', 'space-denied'],
    );
    expect(keywordSearch).toHaveBeenCalledWith(
      context.client.workspaceId,
      ['space-allowed'],
      query,
      10,
    );
    expect(result.structuredContent).toMatchObject({
      items: [{ pageId: 'allowed-page', title: 'Allowed result' }],
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain('Workspace B secret');
  });

  it.each(['semantic_search_docs', 'search_docs'])(
    'does not call the embedding provider when semantic scope is denied through %s',
    async (name) => {
      const permissionService = {
        getAllowedSpaceIds: jest.fn().mockResolvedValue([]),
      };
      const actorAccessService = {
        requireActor: jest.fn().mockResolvedValue(actor),
        filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
      };
      const embeddingService = { createEmbeddings: jest.fn() };
      const environmentService = {
        getMcpMaxQueryLength: jest.fn(() => 500),
      };
      const service = createService({
        actorAccessService,
        embeddingService,
        environmentService,
        permissionService,
      });

      const result = await service.callTool(
        {
          name,
          arguments: {
            query: 'restricted content',
            ...(name === 'search_docs' ? { mode: 'semantic' } : {}),
          },
        },
        context,
      );

      expect(result.structuredContent).toEqual({ items: [], warnings: [] });
      expect(embeddingService.createEmbeddings).not.toHaveBeenCalled();
    },
  );

  it('contains provider failures when hybrid search falls back to keyword results', async () => {
    const permissionService = {
      getAllowedSpaceIds: jest.fn().mockResolvedValue([page.spaceId]),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      filterReadableSpaceIds: jest.fn().mockResolvedValue([page.spaceId]),
      filterReadablePageIds: jest.fn().mockResolvedValue([]),
    };
    const embeddingService = {
      createEmbeddings: jest
        .fn()
        .mockRejectedValue(new Error('secret-token and request content')),
    };
    const environmentService = {
      getMcpMaxQueryLength: jest.fn(() => 500),
      isVectorSearchEnabled: jest.fn(() => true),
      getVectorHybridSemanticWeight: jest.fn(() => 0.65),
      getVectorHybridKeywordWeight: jest.fn(() => 0.25),
      getVectorHybridRecencyWeight: jest.fn(() => 0.1),
    };
    const service = createService({
      actorAccessService,
      embeddingService,
      environmentService,
      permissionService,
    });
    jest
      .spyOn(
        service as unknown as {
          keywordSearch: () => Promise<unknown[]>;
        },
        'keywordSearch',
      )
      .mockResolvedValue([]);

    const result = await service.callTool(
      {
        name: 'search_docs',
        arguments: { query: 'fallback query', mode: 'hybrid' },
      },
      context,
    );

    expect(result.structuredContent).toEqual({
      items: [],
      warnings: ['Semantic search is temporarily unavailable (Error)'],
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('request content');
  });

  it('scopes index-job lookup to the token workspace', async () => {
    const jobQuery = {
      selectAll: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(undefined),
    };
    const vectorIndexService = { retryJob: jest.fn() };
    const service = createService({
      db: { selectFrom: jest.fn(() => jobQuery) },
      vectorIndexService,
    });

    await expect(
      service.callTool(
        {
          name: 'retry_index_job',
          arguments: { jobId: 'workspace-b-job', confirm: true },
        },
        context,
      ),
    ).rejects.toThrow('MCP vector index job not found');

    expect(jobQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      context.client.workspaceId,
    );
    expect(vectorIndexService.retryJob).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'reindex_page', arguments: { pageId: 'workspace-b-page' } },
    { name: 'get_index_status', arguments: { pageId: 'workspace-b-page' } },
    { name: 'list_index_jobs', arguments: { pageId: 'workspace-b-page' } },
  ])('masks cross-workspace targets for $name', async (params) => {
    const permissionService = {
      assertPagePermission: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Page not found')),
      resolvePageTarget: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Page not found')),
    };
    const vectorIndexService = {
      indexPage: jest.fn(),
    };
    const service = createService({ permissionService, vectorIndexService });

    await expect(service.callTool(params, context)).rejects.toThrow(
      'Page not found',
    );
    expect(vectorIndexService.indexPage).not.toHaveBeenCalled();
  });

  it('does not retry an index job after its space permission is denied', async () => {
    const job = {
      id: 'job-1',
      workspaceId: context.client.workspaceId,
      spaceId: 'space-denied',
      pageId: null,
      jobType: 'space',
      status: 'failed',
    };
    const jobQuery = {
      selectAll: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(job),
    };
    const permissionService = {
      assertSpacePermission: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('MCP permission denied')),
    };
    const auditService = {
      logPermissionDenied: jest.fn().mockResolvedValue(true),
    };
    const vectorIndexService = { retryJob: jest.fn() };
    const service = createService({
      auditService,
      db: { selectFrom: jest.fn(() => jobQuery) },
      permissionService,
      vectorIndexService,
    });

    await expect(
      service.callTool(
        {
          name: 'retry_index_job',
          arguments: { jobId: job.id, confirm: true },
        },
        context,
      ),
    ).rejects.toThrow('MCP permission denied');
    expect(vectorIndexService.retryJob).not.toHaveBeenCalled();
  });

  it('denies workspace reindex when no indexable spaces remain', async () => {
    const permissionService = {
      getAllowedSpaceIds: jest.fn().mockResolvedValue([]),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
    };
    const auditService = {
      logPermissionDenied: jest.fn().mockResolvedValue(true),
    };
    const vectorIndexService = { enqueueWorkspace: jest.fn() };
    const service = createService({
      actorAccessService,
      auditService,
      permissionService,
      vectorIndexService,
    });

    await expect(
      service.callTool(
        {
          name: 'reindex_workspace',
          arguments: { confirm: true },
        },
        context,
      ),
    ).rejects.toThrow('MCP permission denied');
    expect(vectorIndexService.enqueueWorkspace).not.toHaveBeenCalled();
  });

  it('denies space reindex before creating a job', async () => {
    const permissionService = {
      assertSpacePermission: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('MCP permission denied')),
    };
    const auditService = {
      logPermissionDenied: jest.fn().mockResolvedValue(true),
    };
    const vectorIndexService = { enqueueSpace: jest.fn() };
    const service = createService({
      auditService,
      permissionService,
      vectorIndexService,
    });

    await expect(
      service.callTool(
        {
          name: 'reindex_space',
          arguments: { spaceId: 'space-denied', confirm: true },
        },
        context,
      ),
    ).rejects.toThrow('MCP permission denied');
    expect(vectorIndexService.enqueueSpace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'create_page',
      arguments: { spaceId: page.spaceId, title: 'Blocked create' },
    },
    {
      name: 'update_page',
      arguments: { pageId: page.id, title: 'Blocked update' },
    },
    {
      name: 'append_page',
      arguments: { pageId: page.id, content: 'Blocked append' },
    },
    {
      name: 'delete_page',
      arguments: { pageId: page.id, confirm: true },
    },
    {
      name: 'restore_page',
      arguments: { pageId: page.id, confirm: true },
    },
  ])('blocks $name when the actor is unavailable', async (params) => {
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue({}),
      assertPagePermission: jest.fn().mockResolvedValue(page),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
      restorePage: jest.fn(),
    };
    const pageService = {
      update: jest.fn(),
      removePage: jest.fn(),
    };
    const actorAccessService = {
      requireActor: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('MCP actor unavailable')),
    };
    const idempotencyService = { run: jest.fn() };
    const service = createService({
      actorAccessService,
      idempotencyService,
      pageRepo,
      pageService,
      permissionService,
    });
    jest
      .spyOn(
        service as unknown as {
          assertActiveSpace: () => Promise<void>;
        },
        'assertActiveSpace',
      )
      .mockResolvedValue(undefined);

    await expect(service.callTool(params, context)).rejects.toThrow(
      'MCP actor unavailable',
    );
    expect(idempotencyService.run).not.toHaveBeenCalled();
    expect(pageService.update).not.toHaveBeenCalled();
    expect(pageService.removePage).not.toHaveBeenCalled();
    expect(pageRepo.restorePage).not.toHaveBeenCalled();
  });

  it.each([
    [{ query: 'anything', mode: 'invalid' }, 'mode must be hybrid'],
    [{ query: '   ', mode: 'keyword' }, 'query is required'],
    [{ query: 'too-long', mode: 'keyword' }, 'query is too long'],
  ])(
    'rejects invalid search arguments %p before permission or provider calls',
    async (argumentsValue, message) => {
      const permissionService = {
        getAllowedSpaceIds: jest.fn(),
      };
      const embeddingService = {
        createEmbeddings: jest.fn(),
      };
      const service = createService({
        environmentService: {
          getMcpMaxQueryLength: jest.fn(() => 4),
        },
        embeddingService,
        permissionService,
      });

      await expect(
        service.callTool(
          { name: 'search_docs', arguments: argumentsValue },
          context,
        ),
      ).rejects.toThrow(message);
      expect(permissionService.getAllowedSpaceIds).not.toHaveBeenCalled();
      expect(embeddingService.createEmbeddings).not.toHaveBeenCalled();
    },
  );

  it.each([[], 'invalid'])(
    'rejects non-object tool arguments %p',
    async (argumentsValue) => {
      const service = createService();
      await expect(
        service.callTool(
          { name: 'list_spaces', arguments: argumentsValue },
          context,
        ),
      ).rejects.toThrow('MCP tool arguments must be an object');
    },
  );

  it('rejects unknown and missing tool names', async () => {
    const service = createService();

    await expect(
      service.callTool({ name: 'unknown_tool', arguments: {} }, context),
    ).rejects.toThrow('Unknown MCP tool');
    await expect(
      service.callTool({ name: '', arguments: {} }, context),
    ).rejects.toThrow('MCP tool name is required');
  });
});
