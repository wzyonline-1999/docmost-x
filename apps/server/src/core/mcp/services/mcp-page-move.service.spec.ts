import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { generateNJitteredKeysBetween } from 'fractional-indexing-jittered';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpPageMoveService } from './mcp-page-move.service';
import { McpToolInputValidator } from './mcp-tool-input-validator';

describe('McpPageMoveService', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const spaceId = '22222222-2222-4222-8222-222222222222';
  const actor = { id: 'user-1', workspaceId };
  const ids = {
    a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    c: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    parent: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    child: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  };
  const positions = generateNJitteredKeysBetween(null, null, 10);
  const hashIds = (pageIds: string[]) =>
    createHash('sha256').update(JSON.stringify(pageIds)).digest('hex');
  const context = {
    client: {
      id: 'client-1',
      workspaceId,
      actorUserId: actor.id,
      status: 'active',
    },
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
  } as unknown as McpToolContext;

  const page = (
    id: string,
    position: string,
    parentPageId: string | null = null,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    slugId: `slug-${id.slice(0, 4)}`,
    title: id.slice(0, 4),
    icon: null,
    position,
    parentPageId,
    spaceId,
    workspaceId,
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    deletedAt: null,
    isLocked: false,
    isBase: false,
    contributorIds: [actor.id],
    ...overrides,
  });

  const createHarness = () => {
    const trx = {};
    const transaction = {
      execute: jest.fn(async (callback) => callback(trx)),
    };
    const db = {
      transaction: jest.fn(() => transaction),
    };
    const eventEmitter = {
      emit: jest.fn(),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanReadSpace: jest.fn().mockResolvedValue(undefined),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
      assertCanViewPage: jest.fn().mockResolvedValue(undefined),
      assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
      filterReadablePageIds: jest.fn(async (_actor, pageIds) => pageIds),
    };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const environmentService = {
      getMcpTokenHashSecret: jest.fn(() => 'move-plan-test-secret'),
      getMcpTokenHashPreviousSecret: jest.fn(() => undefined),
      getMcpMaxBatchSize: jest.fn(() => 20),
    };
    const idempotencyService = {
      run: jest.fn(async (input) =>
        input.run({
          checkpoint: jest.fn().mockResolvedValue(undefined),
          checkpointResourceId: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    const pageRepo = {
      findById: jest.fn(),
      findManyByIds: jest.fn(),
      getPageAndDescendantIds: jest.fn(),
      updatePage: jest.fn(),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue(undefined),
    };
    const service = new McpPageMoveService(
      db as never,
      eventEmitter as never,
      actorAccessService as never,
      auditService as never,
      environmentService as never,
      idempotencyService as never,
      pageRepo as never,
      permissionService as never,
    );

    return {
      service,
      db,
      eventEmitter,
      trx,
      transaction,
      actorAccessService,
      auditService,
      environmentService,
      idempotencyService,
      pageRepo,
      permissionService,
    };
  };

  const payload = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    nonce: 'nonce-1',
    clientId: context.client.id,
    workspaceId,
    actorUserId: actor.id,
    spaceId,
    pageId: ids.a,
    targetParentPageId: ids.parent,
    placement: 'last',
    referencePageId: null,
    sourceParentPageId: null,
    sourcePosition: positions[0],
    sourcePathHash: hashIds([ids.a]),
    sourceSubtreeHash: hashIds([ids.a]),
    targetParentPathHash: hashIds([ids.parent]),
    expectedUpdatedAt: '2026-08-02T00:00:00.000Z',
    subtreeCount: 1,
    permissionInheritanceMayChange: false,
    requiresConfirmation: false,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1_000,
    ...overrides,
  });

  it('advertises tree, preview, single move, and atomic batch tools', () => {
    const { service } = createHarness();
    const definitions = new Map(
      service.listTools().map((definition) => [definition.name, definition]),
    );

    expect([...definitions.keys()]).toEqual([
      'get_page_tree',
      'preview_page_move',
      'move_page',
      'move_pages',
    ]);
    expect(definitions.get('preview_page_move')?.inputSchema.required).toEqual([
      'pageId',
      'targetParentPageId',
      'placement',
    ]);
    expect(definitions.get('move_pages')?.description).toContain('Atomically');
  });

  it('hardens move mutations and nested batch inputs', () => {
    const { service } = createHarness();
    const validator = new McpToolInputValidator();
    const definitions = new Map(
      service
        .listTools()
        .map((definition) => validator.hardenDefinition(definition))
        .map((definition) => [definition.name, definition]),
    );
    const movePage = definitions.get('move_page');
    const movePages = definitions.get('move_pages');

    expect(movePage?.inputSchema.required).toEqual(
      expect.arrayContaining([
        'movePlanToken',
        'expectedUpdatedAt',
        'idempotencyKey',
      ]),
    );
    expect(movePages?.inputSchema.required).toEqual(
      expect.arrayContaining(['moves', 'confirm', 'idempotencyKey']),
    );
    expect(() =>
      validator.validate(movePages!, {
        moves: [
          {
            movePlanToken: 'plan',
            expectedUpdatedAt: 'not-a-date',
          },
        ],
        confirm: true,
        idempotencyKey: 'batch-1',
      }),
    ).toThrow(BadRequestException);
  });

  it('returns an ordered readable tree with bounded depth', async () => {
    const { service, permissionService, actorAccessService } = createHarness();
    const rows = [
      page(ids.b, positions[1]),
      page(ids.a, positions[0]),
      page(ids.child, positions[2], ids.b),
    ];
    jest.spyOn(service as any, 'loadTreeRows').mockResolvedValue(rows);

    const result = (await service.callTool(
      'get_page_tree',
      { spaceId, maxDepth: 1, limit: 10 },
      context,
    )) as any;

    expect(permissionService.assertSpacePermission).toHaveBeenCalledWith(
      context.client,
      'read',
      spaceId,
    );
    expect(actorAccessService.assertCanReadSpace).toHaveBeenCalledWith(
      actor,
      spaceId,
    );
    expect(result.items.map((item) => item.id)).toEqual([
      ids.a,
      ids.b,
      ids.child,
    ]);
    expect(result.items.map((item) => item.depth)).toEqual([0, 0, 1]);
    expect(result.items.map((item) => item.siblingIndex)).toEqual([0, 1, 0]);
    expect(result.truncated).toBe(false);
  });

  it('previews path and returns a verifiable short-lived plan', async () => {
    const { service, pageRepo } = createHarness();
    const source = page(ids.a, positions[0]);
    const parent = page(ids.parent, positions[1]);
    pageRepo.findById.mockResolvedValue(source);
    jest.spyOn(service as any, 'authorizeAndPlanMoves').mockResolvedValue({
      actor,
      pages: [source, parent],
      plans: [
        {
          pageId: ids.a,
          beforeParentPageId: null,
          beforePosition: positions[0],
          targetParentPageId: ids.parent,
          targetPosition: positions[2],
          placement: 'last',
          referencePageId: null,
          changed: true,
        },
      ],
    });
    jest
      .spyOn(service as any, 'permissionInheritanceMayChange')
      .mockResolvedValue(false);

    const result = (await service.callTool(
      'preview_page_move',
      {
        pageId: ids.a,
        targetParentPageId: ids.parent,
        placement: 'last',
      },
      context,
    )) as any;
    const decoded = (service as any).verifyMovePlan(
      result.movePlanToken,
      context,
    );

    expect(result.move.beforePath.map((item) => item.id)).toEqual([ids.a]);
    expect(result.move.afterPath.map((item) => item.id)).toEqual([
      ids.parent,
      ids.a,
    ]);
    expect(result.impact.requiresConfirmation).toBe(false);
    expect(decoded.expectedUpdatedAt).toBe(source.updatedAt.toISOString());
  });

  it('checks actor edit access on both source and target anchors', async () => {
    const { service, actorAccessService } = createHarness();
    const source = page(ids.a, positions[0]);
    const parent = page(ids.parent, positions[1]);
    const reference = page(ids.child, positions[2], ids.parent);
    jest
      .spyOn(service as any, 'loadActiveSpacePages')
      .mockResolvedValue([source, parent, reference]);

    await (service as any).authorizeAndPlanMoves(context, spaceId, [
      {
        pageId: ids.a,
        targetParentPageId: ids.parent,
        placement: 'after',
        referencePageId: ids.child,
      },
    ]);

    expect(actorAccessService.assertCanEditPage).toHaveBeenCalledWith(
      actor,
      source,
    );
    expect(actorAccessService.assertCanEditPage).toHaveBeenCalledWith(
      actor,
      parent,
    );
    expect(actorAccessService.assertCanViewPage).toHaveBeenCalledWith(
      actor,
      reference,
    );
  });

  it('computes a server-owned position after the requested reference', () => {
    const { service } = createHarness();
    const pages = [
      page(ids.a, positions[0]),
      page(ids.b, positions[1]),
      page(ids.c, positions[2]),
    ];

    const [plan] = (service as any).planMoves(pages, [
      {
        pageId: ids.a,
        targetParentPageId: null,
        placement: 'after',
        referencePageId: ids.c,
      },
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.targetPosition > positions[2]).toBe(true);
  });

  it('supports a moved reference when it appears earlier in a batch', () => {
    const { service } = createHarness();
    const pages = [
      page(ids.a, positions[0]),
      page(ids.b, positions[1]),
      page(ids.parent, positions[2]),
      page(ids.child, positions[3], ids.parent),
    ];

    const plans = (service as any).planMoves(pages, [
      {
        pageId: ids.a,
        targetParentPageId: ids.parent,
        placement: 'last',
        referencePageId: null,
      },
      {
        pageId: ids.b,
        targetParentPageId: ids.parent,
        placement: 'after',
        referencePageId: ids.a,
      },
    ]);

    expect(plans.map((plan) => plan.targetParentPageId)).toEqual([
      ids.parent,
      ids.parent,
    ]);
    expect(plans[0].targetPosition < plans[1].targetPosition).toBe(true);
  });

  it('rejects moving a page under its own descendant', () => {
    const { service } = createHarness();
    const pages = [
      page(ids.parent, positions[0]),
      page(ids.child, positions[1], ids.parent),
    ];

    expect(() =>
      (service as any).planMoves(pages, [
        {
          pageId: ids.parent,
          targetParentPageId: ids.child,
          placement: 'last',
          referencePageId: null,
        },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects a cycle created only by the final batch graph', () => {
    const { service } = createHarness();
    const pages = [page(ids.a, positions[0]), page(ids.b, positions[1])];

    expect(() =>
      (service as any).planMoves(pages, [
        {
          pageId: ids.a,
          targetParentPageId: ids.b,
          placement: 'last',
          referencePageId: null,
        },
        {
          pageId: ids.b,
          targetParentPageId: ids.a,
          placement: 'last',
          referencePageId: null,
        },
      ]),
    ).toThrow(BadRequestException);
  });

  it('binds signed move plans to the MCP client and rejects tampering', () => {
    const { service } = createHarness();
    const token = (service as any).signMovePlan(payload());
    const decoded = (service as any).verifyMovePlan(token, context);

    expect(decoded.pageId).toBe(ids.a);
    const [body, signature] = token.split('.');
    expect(() =>
      (service as any).verifyMovePlan(`${body}x.${signature}`, context),
    ).toThrow(BadRequestException);
    expect(() =>
      (service as any).verifyMovePlan(token, {
        ...context,
        client: { ...context.client, id: 'different-client' },
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an expired move plan', () => {
    const { service } = createHarness();
    const token = (service as any).signMovePlan(
      payload({ issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 1 }),
    );

    expect(() => (service as any).verifyMovePlan(token, context)).toThrow(
      ConflictException,
    );
  });

  it('requires explicit confirmation for a subtree move', async () => {
    const { service, idempotencyService } = createHarness();
    const movePayload = payload({
      subtreeCount: 2,
      requiresConfirmation: true,
    });
    const token = (service as any).signMovePlan(movePayload);
    jest.spyOn(service as any, 'authorizeAndPlanMoves').mockResolvedValue({
      actor,
      pages: [
        page(ids.a, positions[0]),
        page(ids.parent, positions[1]),
        page(ids.child, positions[2], ids.a),
      ],
      plans: [
        {
          pageId: ids.a,
          beforeParentPageId: null,
          beforePosition: positions[0],
          targetParentPageId: ids.parent,
          targetPosition: positions[3],
          placement: 'last',
          referencePageId: null,
          changed: true,
        },
      ],
    });
    jest
      .spyOn(service as any, 'permissionInheritanceMayChange')
      .mockResolvedValue(false);

    await expect(
      service.callTool(
        'move_page',
        {
          movePlanToken: token,
          expectedUpdatedAt: movePayload.expectedUpdatedAt,
          idempotencyKey: 'move-subtree-1',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(idempotencyService.run).not.toHaveBeenCalled();
  });

  it('detects stale expectedUpdatedAt before any page update', async () => {
    const { service, pageRepo } = createHarness();
    const current = page(ids.a, positions[0], null, {
      updatedAt: new Date('2026-08-03T00:00:00.000Z'),
    });
    jest.spyOn(service as any, 'lockSpace').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'loadStableMovePages')
      .mockResolvedValue([current, page(ids.parent, positions[1])]);

    await expect(
      (service as any).executeMoves(
        [payload()],
        ['2026-08-02T00:00:00.000Z'],
        actor,
        context,
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('rejects a changed source path or subtree before any page update', async () => {
    const { service } = createHarness();
    const pages = [
      page(ids.a, positions[0]),
      page(ids.child, positions[1], ids.a),
      page(ids.parent, positions[2]),
    ];
    jest.spyOn(service as any, 'lockSpace').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadStableMovePages').mockResolvedValue(pages);
    const updatePageWithinTransaction = jest.spyOn(
      service as any,
      'updatePageWithinTransaction',
    );

    await expect(
      (service as any).executeMoves(
        [payload()],
        ['2026-08-02T00:00:00.000Z'],
        actor,
        context,
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updatePageWithinTransaction).not.toHaveBeenCalled();
  });

  it('re-reads and locks newly discovered move rows until the lock set is stable', async () => {
    const { service } = createHarness();
    const firstSnapshot = [
      page(ids.a, positions[0]),
      page(ids.parent, positions[1]),
    ];
    const stableSnapshot = [
      ...firstSnapshot,
      page(ids.child, positions[2], ids.a),
    ];
    jest
      .spyOn(service as any, 'loadActiveSpacePages')
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(stableSnapshot)
      .mockResolvedValueOnce(stableSnapshot);

    const lockQueries: Array<Record<string, jest.Mock>> = [];
    const trx = {
      selectFrom: jest.fn(() => {
        const query: Record<string, jest.Mock> = {};
        for (const method of ['select', 'where', 'orderBy', 'forUpdate']) {
          query[method] = jest.fn(() => query);
        }
        query.execute = jest.fn().mockResolvedValue([]);
        lockQueries.push(query);
        return query;
      }),
    };

    const result = await (service as any).loadStableMovePages(
      trx,
      workspaceId,
      spaceId,
      [
        {
          pageId: ids.a,
          targetParentPageId: ids.parent,
          placement: 'last',
          referencePageId: null,
        },
      ],
    );

    expect(result).toBe(stableSnapshot);
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries[0].orderBy).toHaveBeenCalledWith('id');
    expect(lockQueries[1].where).toHaveBeenCalledWith('id', 'in', [ids.child]);
  });

  it('throws from one transaction when a later batch update conflicts', async () => {
    const { service, transaction, eventEmitter } = createHarness();
    const pages = [
      page(ids.a, positions[0]),
      page(ids.b, positions[1]),
      page(ids.parent, positions[2]),
    ];
    jest.spyOn(service as any, 'lockSpace').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadStableMovePages').mockResolvedValue(pages);
    const updatePageWithinTransaction = jest
      .spyOn(service as any, 'updatePageWithinTransaction')
      .mockResolvedValueOnce({
        ...pages[0],
        parentPageId: ids.parent,
        position: positions[3],
        updatedAt: new Date('2026-08-02T00:01:00.000Z'),
      })
      .mockRejectedValueOnce(new ConflictException('Concurrent batch update'));
    const payloads = [
      payload(),
      payload({
        nonce: 'nonce-2',
        pageId: ids.b,
        sourcePosition: positions[1],
        sourcePathHash: hashIds([ids.b]),
        sourceSubtreeHash: hashIds([ids.b]),
      }),
    ];

    await expect(
      (service as any).executeMoves(
        payloads,
        ['2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'],
        actor,
        context,
        jest.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(updatePageWithinTransaction).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('emits one page update event only after a successful commit', async () => {
    const { service, transaction, eventEmitter } = createHarness();
    const pages = [page(ids.a, positions[0]), page(ids.parent, positions[1])];
    jest.spyOn(service as any, 'lockSpace').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadStableMovePages').mockResolvedValue(pages);
    jest
      .spyOn(service as any, 'updatePageWithinTransaction')
      .mockResolvedValue({
        ...pages[0],
        parentPageId: ids.parent,
        position: positions[2],
        updatedAt: new Date('2026-08-02T00:01:00.000Z'),
      });

    const result = await (service as any).executeMoves(
      [payload()],
      ['2026-08-02T00:00:00.000Z'],
      actor,
      context,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(result[0].changed).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalledWith('page.updated', {
      pageIds: [ids.a],
      workspaceId,
    });
    expect(transaction.execute.mock.invocationCallOrder[0]).toBeLessThan(
      eventEmitter.emit.mock.invocationCallOrder[0],
    );
  });

  it('does not write or emit an update for a no-op move', async () => {
    const { service, eventEmitter } = createHarness();
    const pages = [page(ids.a, positions[0]), page(ids.parent, positions[1])];
    jest.spyOn(service as any, 'lockSpace').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadStableMovePages').mockResolvedValue(pages);
    const updatePageWithinTransaction = jest.spyOn(
      service as any,
      'updatePageWithinTransaction',
    );

    const result = await (service as any).executeMoves(
      [
        payload({
          targetParentPageId: null,
          placement: 'first',
          targetParentPathHash: hashIds([]),
        }),
      ],
      ['2026-08-02T00:00:00.000Z'],
      actor,
      context,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(result[0].changed).toBe(false);
    expect(updatePageWithinTransaction).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('reconciles only an all-before or all-target atomic batch state', async () => {
    const { service, pageRepo } = createHarness();
    const beforeState = {
      moves: [
        { pageId: ids.a, parentPageId: null, position: positions[0] },
        { pageId: ids.b, parentPageId: null, position: positions[1] },
      ],
    };
    const targetState = {
      moves: [
        {
          pageId: ids.a,
          parentPageId: ids.parent,
          position: positions[3],
        },
        {
          pageId: ids.b,
          parentPageId: ids.parent,
          position: positions[4],
        },
      ],
    };
    const record = {
      action: 'move_pages',
      resourceType: 'page_batch',
      resourceId: ids.a,
      operationStage: 'moves_planned',
      beforeState,
      targetState,
    };
    pageRepo.findManyByIds.mockResolvedValue([
      page(ids.a, positions[3], ids.parent),
      page(ids.b, positions[4], ids.parent),
    ]);

    const completed = await (service as any).reconcileMoves(record, context);
    expect(completed.outcome).toBe('completed');
    expect(completed.response.movedCount).toBe(2);

    pageRepo.findManyByIds.mockResolvedValue([
      page(ids.a, positions[3], ids.parent),
      page(ids.b, positions[1], null),
    ]);
    const mixed = await (service as any).reconcileMoves(record, context);
    expect(mixed).toEqual({ outcome: 'repair_required' });
  });
});
