jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToHtml: (content: unknown) => `html:${JSON.stringify(content)}`,
  jsonToMarkdown: (content: unknown) => `markdown:${JSON.stringify(content)}`,
}));

jest.mock('../../page/services/page.service', () => ({
  PageService: class PageService {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpPageHistoryService } from './mcp-page-history.service';

describe('McpPageHistoryService', () => {
  const actor = { id: 'user-1', workspaceId: 'workspace-1' };
  const page = {
    id: '11111111-1111-4111-8111-111111111111',
    slugId: 'page-slug',
    title: 'Current title',
    icon: null,
    parentPageId: null,
    spaceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'workspace-1',
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    contributorIds: [actor.id],
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    deletedAt: null,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  };
  const history = {
    id: '33333333-3333-4333-8333-333333333333',
    pageId: page.id,
    slugId: page.slugId,
    title: 'Saved title',
    icon: null,
    coverPhoto: null,
    lastUpdatedById: actor.id,
    contributorIds: [actor.id],
    contributors: [{ id: actor.id, name: 'Actor', avatarUrl: null }],
    spaceId: page.spaceId,
    workspaceId: page.workspaceId,
    createdAt: new Date('2026-07-10T12:00:00.000Z'),
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: {} }] },
  };
  const context = {
    client: {
      id: 'client-1',
      workspaceId: page.workspaceId,
      actorUserId: actor.id,
      status: 'active',
    },
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
  } as unknown as McpToolContext;

  const createHarness = () => {
    const pageHistoryService = {
      findById: jest.fn().mockResolvedValue(history),
      saveSnapshotIfChanged: jest.fn().mockResolvedValue(true),
      findHistoryByPageId: jest.fn().mockResolvedValue({
        items: [history],
        meta: {
          limit: 25,
          hasNextPage: false,
          hasPrevPage: false,
          nextCursor: null,
          prevCursor: null,
        },
      }),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const pageService = {
      update: jest.fn().mockResolvedValue({
        ...page,
        title: history.title,
        content: history.content,
        updatedAt: new Date('2026-07-11T01:00:00.000Z'),
      }),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue(undefined),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanViewPage: jest.fn().mockResolvedValue(undefined),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const idempotencyService = {
      run: jest.fn(async (input) =>
        input.run({
          checkpoint: jest.fn().mockResolvedValue(undefined),
          checkpointResourceId: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    const service = new McpPageHistoryService(
      pageHistoryService as never,
      pageRepo as never,
      pageService as never,
      permissionService as never,
      actorAccessService as never,
      auditService as never,
      idempotencyService as never,
    );

    return {
      service,
      pageHistoryService,
      pageRepo,
      pageService,
      permissionService,
      actorAccessService,
      auditService,
      idempotencyService,
    };
  };

  it('lists metadata only after MCP and actor read checks', async () => {
    const harness = createHarness();

    const result = await harness.service.listPageVersions(
      { pageId: page.id, limit: 25 },
      context,
    );

    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenCalledWith(context.client, 'read', page.spaceId);
    expect(harness.actorAccessService.assertCanViewPage).toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({
        id: history.id,
        pageId: page.id,
        title: history.title,
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty('content');
  });

  it('formats one readable saved version without leaking another workspace', async () => {
    const harness = createHarness();
    const result = await harness.service.getPageVersion(
      { historyId: history.id, format: 'markdown' },
      context,
    );

    expect(result.content).toContain('markdown:');

    harness.pageHistoryService.findById.mockResolvedValue({
      ...history,
      workspaceId: 'workspace-2',
    });
    await expect(
      harness.service.getPageVersion(
        { historyId: history.id, format: 'json' },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('supports HTML and JSON history representations', async () => {
    const harness = createHarness();

    const html = await harness.service.getPageVersion(
      { historyId: history.id, format: 'html' },
      context,
    );
    const json = await harness.service.getPageVersion(
      { historyId: history.id, format: 'json' },
      context,
    );

    expect(html.content).toContain('html:');
    expect(json.content).toEqual(history.content);
  });

  it('diffs a saved version against the current page', async () => {
    const harness = createHarness();

    const result = await harness.service.diffPageVersions(
      { pageId: page.id, fromHistoryId: history.id },
      context,
    );

    expect(result.from).toEqual(
      expect.objectContaining({ id: history.id, kind: 'history' }),
    );
    expect(result.to).toEqual(
      expect.objectContaining({ id: page.id, kind: 'current' }),
    );
    expect(result.diff).toContain('history:');
    expect(result.diff).toContain('current:');
    expect(result.truncated).toBe(false);
  });

  it('diffs two saved versions and truncates oversized output', async () => {
    const harness = createHarness();
    const secondHistory = {
      ...history,
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Second saved title',
      content: {
        type: 'doc',
        content: [{ type: 'text', text: 'x'.repeat(210_000) }],
      },
    };
    harness.pageHistoryService.findById.mockImplementation((id) =>
      Promise.resolve(id === secondHistory.id ? secondHistory : history),
    );

    const result = await harness.service.diffPageVersions(
      {
        pageId: page.id,
        fromHistoryId: history.id,
        toHistoryId: secondHistory.id,
      },
      context,
    );

    expect(result.to).toEqual(
      expect.objectContaining({ id: secondHistory.id, kind: 'history' }),
    );
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('diff truncated');
  });

  it('restores through the existing page update path with concurrency and audit', async () => {
    const harness = createHarness();

    const result = await harness.service.restorePageVersion(
      {
        pageId: page.id,
        historyId: history.id,
        expectedUpdatedAt: page.updatedAt.toISOString(),
        idempotencyKey: 'restore-1',
        confirm: true,
      },
      context,
    );

    expect(harness.pageService.update).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        pageId: page.id,
        title: history.title,
        content: history.content,
        operation: 'replace',
        format: 'json',
      }),
      actor,
      expect.objectContaining({
        expectedUpdatedAt: page.updatedAt,
        preparedContent: history.content,
      }),
    );
    expect(
      harness.pageHistoryService.saveSnapshotIfChanged,
    ).toHaveBeenCalledWith(page, [actor.id]);
    expect(harness.auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.page.version.restore',
        resourceId: page.id,
        metadata: expect.objectContaining({ historyId: history.id }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ restoredHistoryId: history.id, warnings: [] }),
    );
  });

  it('returns a warning and still restores when the pre-restore snapshot fails', async () => {
    const harness = createHarness();
    harness.pageHistoryService.saveSnapshotIfChanged.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: page.updatedAt.toISOString(),
          confirm: true,
        },
        context,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        restoredHistoryId: history.id,
        warnings: [
          'MCP operation succeeded, but its page history snapshot could not be persisted',
        ],
      }),
    );
  });

  it('does not create another snapshot when idempotency returns a cached restore', async () => {
    const harness = createHarness();
    const cached = {
      page: { id: page.id },
      restoredHistoryId: history.id,
      warnings: [],
    };
    harness.idempotencyService.run.mockResolvedValue(cached);

    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: page.updatedAt.toISOString(),
          idempotencyKey: 'restore-cached',
          confirm: true,
        },
        context,
      ),
    ).resolves.toEqual(cached);

    expect(
      harness.pageHistoryService.saveSnapshotIfChanged,
    ).not.toHaveBeenCalled();
    expect(harness.pageService.update).not.toHaveBeenCalled();
  });

  it('returns an audit warning and rejects an invalid concurrency timestamp', async () => {
    const harness = createHarness();
    harness.auditService.tryLog.mockResolvedValue(false);

    const result = await harness.service.restorePageVersion(
      {
        pageId: page.id,
        historyId: history.id,
        expectedUpdatedAt: page.updatedAt.toISOString(),
        confirm: true,
      },
      context,
    );
    expect(result.warnings).toContain(
      'MCP operation succeeded, but its audit log could not be persisted',
    );

    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: 'not-a-date',
          confirm: true,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reconciles a completed restore and flags a divergent page for repair', async () => {
    const harness = createHarness();
    await harness.service.restorePageVersion(
      {
        pageId: page.id,
        historyId: history.id,
        expectedUpdatedAt: page.updatedAt.toISOString(),
        idempotencyKey: 'restore-reconcile',
        confirm: true,
      },
      context,
    );
    const input = harness.idempotencyService.run.mock.calls[0][0];
    harness.pageRepo.findById.mockResolvedValue({
      ...page,
      title: history.title,
      content: history.content,
    });
    await expect(
      input.reconcile({
        resourceId: page.id,
        targetState: input.targetState,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'completed',
        response: expect.objectContaining({
          restoredHistoryId: history.id,
        }),
      }),
    );

    harness.pageRepo.findById.mockResolvedValue(page);
    await expect(
      input.reconcile({
        resourceId: page.id,
        targetState: input.targetState,
      }),
    ).resolves.toEqual({ outcome: 'repair_required' });
  });

  it('requires explicit confirmation and rejects a history from another page', async () => {
    const harness = createHarness();
    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: page.updatedAt.toISOString(),
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    harness.pageHistoryService.findById.mockResolvedValue({
      ...history,
      pageId: '44444444-4444-4444-8444-444444444444',
    });
    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: page.updatedAt.toISOString(),
          confirm: true,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.pageService.update).not.toHaveBeenCalled();
  });

  it('rejects a version whose stored content is unavailable', async () => {
    const harness = createHarness();
    harness.pageHistoryService.findById.mockResolvedValue({
      ...history,
      content: null,
    });

    await expect(
      harness.service.restorePageVersion(
        {
          pageId: page.id,
          historyId: history.id,
          expectedUpdatedAt: page.updatedAt.toISOString(),
          confirm: true,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
