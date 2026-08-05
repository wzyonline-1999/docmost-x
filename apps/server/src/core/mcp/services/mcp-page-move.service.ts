import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { generateNJitteredKeysBetween } from 'fractional-indexing-jittered';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectKysely } from 'nestjs-kysely';
import { validate as isValidUuid } from 'uuid';
import type { JsonObject } from '@docmost/db/types/db';
import type { Page, User } from '@docmost/db/types/entity.types';
import type {
  KyselyDB,
  KyselyTransaction,
} from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { EventName } from '../../../common/events/event.contants';
import type {
  McpToolContext,
  McpToolDefinition,
} from '../types/mcp-tool.types';
import { McpActorAccessService } from './mcp-actor-access.service';
import { McpAuditService } from './mcp-audit.service';
import {
  McpIdempotencyReconciliation,
  McpIdempotencyReconciliationRecord,
  McpIdempotencyService,
} from './mcp-idempotency.service';
import { McpPermissionService } from './mcp-permission.service';

const MAX_PAGE_TREE_LIMIT = 1_000;
const MAX_PAGE_TREE_DEPTH = 50;
const MAX_PAGE_TREE_SCAN = 10_000;
const MAX_MOVE_BATCH_SIZE = 50;
const MOVE_PLAN_TTL_MS = 10 * 60 * 1_000;
const MOVE_PLAN_VERSION = 1;
const MOVE_PLAN_TOKEN_MAX_LENGTH = 8_192;
const AUDIT_WARNING =
  'MCP operation succeeded, but its audit log could not be persisted';
const RECOVERY_WARNING =
  'Recovered an interrupted idempotent page move from persisted state';

type PagePlacement = 'first' | 'last' | 'before' | 'after';

type MovePageRow = Pick<
  Page,
  | 'id'
  | 'slugId'
  | 'title'
  | 'icon'
  | 'position'
  | 'parentPageId'
  | 'spaceId'
  | 'workspaceId'
  | 'creatorId'
  | 'lastUpdatedById'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'isLocked'
  | 'isBase'
  | 'contributorIds'
>;

type MoveInstruction = {
  pageId: string;
  targetParentPageId: string | null;
  placement: PagePlacement;
  referencePageId: string | null;
};

type PlannedMove = MoveInstruction & {
  beforeParentPageId: string | null;
  beforePosition: string | null;
  targetPosition: string | null;
  changed: boolean;
};

type MovePlanTokenPayload = MoveInstruction & {
  version: number;
  nonce: string;
  clientId: string;
  workspaceId: string;
  actorUserId: string | null;
  spaceId: string;
  sourceParentPageId: string | null;
  sourcePosition: string | null;
  sourcePathHash: string;
  sourceSubtreeHash: string;
  targetParentPathHash: string;
  expectedUpdatedAt: string;
  subtreeCount: number;
  permissionInheritanceMayChange: boolean;
  requiresConfirmation: boolean;
  issuedAt: number;
  expiresAt: number;
};

type PersistedMoveState = {
  moves: Array<{
    pageId: string;
    parentPageId: string | null;
    position: string | null;
  }>;
};

type ExecutedMove = PlannedMove & {
  page: MovePageRow;
};

@Injectable()
export class McpPageMoveService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly eventEmitter: EventEmitter2,
    private readonly actorAccessService: McpActorAccessService,
    private readonly auditService: McpAuditService,
    private readonly environmentService: EnvironmentService,
    private readonly idempotencyService: McpIdempotencyService,
    private readonly pageRepo: PageRepo,
    private readonly permissionService: McpPermissionService,
  ) {}

  listTools(): McpToolDefinition[] {
    const maxMoveBatchSize = this.getMaxMoveBatchSize();
    return [
      {
        name: 'get_page_tree',
        description:
          'Read a bounded, ordered page tree in one allowed Docmost space. Use the returned page IDs as safe anchors for preview_page_move.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string' },
            rootPageId: {
              type: 'string',
              description:
                'Optional root page UUID. The root itself is returned at depth 0.',
            },
            maxDepth: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_PAGE_TREE_DEPTH,
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_PAGE_TREE_LIMIT,
            },
          },
          required: ['spaceId'],
          additionalProperties: false,
        },
      },
      {
        name: 'preview_page_move',
        description:
          'Validate a same-space page or directory move and return its path change, risk, concurrency version, and a short-lived signed movePlanToken. Call this immediately before move_page or move_pages.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            targetParentPageId: {
              type: ['string', 'null'],
              description: 'Target parent UUID, or null for the space root.',
            },
            placement: {
              type: 'string',
              enum: ['first', 'last', 'before', 'after'],
            },
            referencePageId: {
              type: 'string',
              description:
                'Required for before/after and forbidden for first/last. It must be a child of targetParentPageId.',
            },
          },
          required: ['pageId', 'targetParentPageId', 'placement'],
          additionalProperties: false,
        },
      },
      {
        name: 'move_page',
        description:
          'Execute one previously previewed same-space page move. The signed plan, expectedUpdatedAt, current permissions, and tree safety are revalidated before writing.',
        inputSchema: {
          type: 'object',
          properties: {
            movePlanToken: {
              type: 'string',
              minLength: 1,
              maxLength: MOVE_PLAN_TOKEN_MAX_LENGTH,
            },
            expectedUpdatedAt: { type: 'string', format: 'date-time' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['movePlanToken', 'expectedUpdatedAt'],
          additionalProperties: false,
        },
      },
      {
        name: 'move_pages',
        description:
          'Atomically execute multiple previewed same-space moves. Moves are applied in array order; a moved before/after reference must appear earlier in the batch. The entire batch fails when any move is invalid or stale.',
        inputSchema: {
          type: 'object',
          properties: {
            moves: {
              type: 'array',
              minItems: 1,
              maxItems: maxMoveBatchSize,
              items: {
                type: 'object',
                properties: {
                  movePlanToken: {
                    type: 'string',
                    minLength: 1,
                    maxLength: MOVE_PLAN_TOKEN_MAX_LENGTH,
                  },
                  expectedUpdatedAt: {
                    type: 'string',
                    format: 'date-time',
                  },
                },
                required: ['movePlanToken', 'expectedUpdatedAt'],
                additionalProperties: false,
              },
            },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['moves', 'confirm'],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    switch (name) {
      case 'get_page_tree':
        return this.getPageTree(args, context);
      case 'preview_page_move':
        return this.previewPageMove(args, context);
      case 'move_page':
        return this.movePage(args, context);
      case 'move_pages':
        return this.movePages(args, context);
      default:
        throw new NotFoundException(`Unknown page move tool: ${name}`);
    }
  }

  private async getPageTree(args: JsonObject, context: McpToolContext) {
    const spaceId = this.requireString(args, 'spaceId');
    const rootPageId = this.optionalString(args, 'rootPageId');
    const maxDepth =
      this.optionalInteger(args, 'maxDepth', 0, MAX_PAGE_TREE_DEPTH) ?? 10;
    const limit =
      this.optionalInteger(args, 'limit', 1, MAX_PAGE_TREE_LIMIT) ?? 200;

    await this.permissionService.assertSpacePermission(
      context.client,
      'read',
      spaceId,
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanReadSpace(actor, spaceId);

    let candidateIds: string[] | undefined;
    if (rootPageId) {
      const root = await this.pageRepo.findById(rootPageId);
      if (
        !root ||
        root.deletedAt ||
        root.workspaceId !== context.client.workspaceId ||
        root.spaceId !== spaceId
      ) {
        throw new NotFoundException('Page tree root not found');
      }
      await this.actorAccessService.assertCanViewPage(actor, root);
      const descendants = await this.pageRepo.getPageAndDescendantIds(root.id, {
        limit: MAX_PAGE_TREE_SCAN + 1,
      });
      if (descendants.length > MAX_PAGE_TREE_SCAN) {
        throw new PayloadTooLargeException(
          `Page tree scope exceeds ${MAX_PAGE_TREE_SCAN} pages; choose a narrower rootPageId`,
        );
      }
      candidateIds = descendants.map((item) => item.id);
    }

    const rows = await this.loadTreeRows(
      context.client.workspaceId,
      spaceId,
      candidateIds,
    );
    if (!candidateIds && rows.length > MAX_PAGE_TREE_SCAN) {
      throw new PayloadTooLargeException(
        `Space exceeds ${MAX_PAGE_TREE_SCAN} pages; provide rootPageId`,
      );
    }

    const readableIds = new Set(
      await this.actorAccessService.filterReadablePageIds(
        actor,
        rows.map((row) => row.id),
        spaceId,
      ),
    );
    const readableRows = rows.filter((row) => readableIds.has(row.id));
    const rowById = new Map(readableRows.map((row) => [row.id, row]));
    const children = this.buildChildrenMap(readableRows);
    const roots = rootPageId
      ? rowById.has(rootPageId)
        ? [rowById.get(rootPageId) as MovePageRow]
        : []
      : (children.get(null) ?? []);

    const pending = roots
      .slice()
      .reverse()
      .map((page) => ({ page, depth: 0 }));
    const items: Array<Record<string, unknown>> = [];
    let depthLimited = false;

    while (pending.length > 0 && items.length < limit) {
      const current = pending.pop();
      if (!current) break;
      const childRows = children.get(current.page.id) ?? [];
      const siblings = children.get(current.page.parentPageId) ?? [];
      items.push({
        id: current.page.id,
        slugId: current.page.slugId,
        title: current.page.title,
        icon: current.page.icon,
        parentPageId: current.page.parentPageId,
        depth: current.depth,
        siblingIndex: siblings.findIndex(
          (sibling) => sibling.id === current.page.id,
        ),
        hasChildren: childRows.length > 0,
        updatedAt: current.page.updatedAt,
      });

      if (current.depth >= maxDepth) {
        depthLimited ||= childRows.length > 0;
        continue;
      }
      for (let index = childRows.length - 1; index >= 0; index -= 1) {
        pending.push({ page: childRows[index], depth: current.depth + 1 });
      }
    }

    return {
      spaceId,
      rootPageId: rootPageId ?? null,
      items,
      limit,
      maxDepth,
      truncated: pending.length > 0 || depthLimited,
    };
  }

  private async previewPageMove(args: JsonObject, context: McpToolContext) {
    const instruction = this.parseMoveInstruction(args);
    const source = await this.pageRepo.findById(instruction.pageId);
    if (
      !source ||
      source.deletedAt ||
      source.workspaceId !== context.client.workspaceId
    ) {
      throw new NotFoundException('Page not found');
    }

    const prepared = await this.authorizeAndPlanMoves(context, source.spaceId, [
      instruction,
    ]);
    const currentSource = prepared.pages.find(
      (page) => page.id === instruction.pageId,
    ) as MovePageRow;
    const planned = prepared.plans[0];
    const subtreeCount = this.countSubtreePages(
      instruction.pageId,
      prepared.pages,
    );
    const permissionInheritanceMayChange =
      await this.permissionInheritanceMayChange(
        currentSource.parentPageId,
        instruction.targetParentPageId,
        prepared.pages,
      );
    const requiresConfirmation =
      subtreeCount > 1 || permissionInheritanceMayChange;
    const beforePath = this.buildPagePath(
      currentSource.id,
      prepared.pages,
      new Map(),
    );
    const afterPath = this.buildPagePath(
      currentSource.id,
      prepared.pages,
      new Map([[source.id, instruction.targetParentPageId]]),
    );
    const now = Date.now();
    const payload: MovePlanTokenPayload = {
      version: MOVE_PLAN_VERSION,
      nonce: randomUUID(),
      clientId: context.client.id,
      workspaceId: context.client.workspaceId,
      actorUserId: context.client.actorUserId ?? null,
      spaceId: source.spaceId,
      ...instruction,
      sourceParentPageId: currentSource.parentPageId,
      sourcePosition: currentSource.position,
      sourcePathHash: this.getPagePathHash(currentSource.id, prepared.pages),
      sourceSubtreeHash: this.getPageSubtreeHash(
        currentSource.id,
        prepared.pages,
      ),
      targetParentPathHash: this.getPagePathHash(
        instruction.targetParentPageId,
        prepared.pages,
      ),
      expectedUpdatedAt: currentSource.updatedAt.toISOString(),
      subtreeCount,
      permissionInheritanceMayChange,
      requiresConfirmation,
      issuedAt: now,
      expiresAt: now + MOVE_PLAN_TTL_MS,
    };

    return {
      page: this.toPageSummary(currentSource),
      move: {
        targetParentPageId: instruction.targetParentPageId,
        placement: instruction.placement,
        referencePageId: instruction.referencePageId,
        wouldChange: planned.changed,
        beforePath,
        afterPath,
      },
      impact: {
        subtreeCount,
        descendantCount: Math.max(0, subtreeCount - 1),
        permissionInheritanceMayChange,
        requiresConfirmation,
      },
      expectedUpdatedAt: payload.expectedUpdatedAt,
      movePlanToken: this.signMovePlan(payload),
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  private async movePage(args: JsonObject, context: McpToolContext) {
    const movePlanToken = this.requireString(args, 'movePlanToken');
    const expectedUpdatedAt = this.requireString(args, 'expectedUpdatedAt');
    const payload = this.verifyMovePlan(movePlanToken, context);
    this.assertExpectedUpdatedAt(payload, expectedUpdatedAt);

    const prepared = await this.authorizeAndPlanMoves(
      context,
      payload.spaceId,
      [this.toInstruction(payload)],
    );
    const currentRisk =
      this.countSubtreePages(payload.pageId, prepared.pages) > 1 ||
      (await this.permissionInheritanceMayChange(
        prepared.plans[0].beforeParentPageId,
        payload.targetParentPageId,
        prepared.pages,
      ));
    if (
      (payload.requiresConfirmation || currentRisk) &&
      args.confirm !== true
    ) {
      throw new BadRequestException(
        'move_page requires confirm=true for a non-empty subtree or inherited-permission change',
      );
    }

    const idempotencyKey = this.requireString(args, 'idempotencyKey');
    const beforeState: PersistedMoveState = {
      moves: [
        {
          pageId: payload.pageId,
          parentPageId: payload.sourceParentPageId,
          position: payload.sourcePosition,
        },
      ],
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'move_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      resourceId: payload.pageId,
      operationStage: 'validated',
      beforeState,
      targetState: {
        moves: [
          {
            pageId: payload.pageId,
            parentPageId: payload.targetParentPageId,
            position: null,
          },
        ],
      } satisfies PersistedMoveState,
      reconcile: (record) => this.reconcileMoves(record, context),
      run: async (execution) => {
        const executed = await this.executeMoves(
          [payload],
          [expectedUpdatedAt],
          prepared.actor,
          context,
          async (runtimeBeforeState, runtimeTargetState) => {
            await execution.checkpoint({
              stage: 'moves_planned',
              resourceId: payload.pageId,
              beforeState: runtimeBeforeState,
              targetState: runtimeTargetState,
            });
          },
        );
        const warnings = await this.auditMoves(
          executed,
          context,
          prepared.actor,
          'move_page',
        );
        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: payload.pageId,
        });
        return this.buildMoveResponse(executed[0], warnings);
      },
    });
  }

  private async movePages(args: JsonObject, context: McpToolContext) {
    if (args.confirm !== true) {
      throw new BadRequestException('move_pages requires confirm=true');
    }
    const inputs = this.parseBatchInputs(args);
    const payloads = inputs.map((input) => {
      const payload = this.verifyMovePlan(input.movePlanToken, context);
      this.assertExpectedUpdatedAt(payload, input.expectedUpdatedAt);
      return payload;
    });
    const duplicateIds = this.findDuplicateIds(
      payloads.map((payload) => payload.pageId),
    );
    if (duplicateIds.length > 0) {
      throw new BadRequestException(
        `move_pages contains duplicate page IDs: ${duplicateIds.join(', ')}`,
      );
    }
    const spaceIds = new Set(payloads.map((payload) => payload.spaceId));
    if (spaceIds.size !== 1) {
      throw new BadRequestException(
        'move_pages supports one space per atomic batch',
      );
    }

    const spaceId = payloads[0].spaceId;
    const prepared = await this.authorizeAndPlanMoves(
      context,
      spaceId,
      payloads.map((payload) => this.toInstruction(payload)),
    );
    const idempotencyKey = this.requireString(args, 'idempotencyKey');
    const beforeState: PersistedMoveState = {
      moves: payloads.map((payload) => ({
        pageId: payload.pageId,
        parentPageId: payload.sourceParentPageId,
        position: payload.sourcePosition,
      })),
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'move_pages',
      idempotencyKey,
      request: args,
      resourceType: 'page_batch',
      resourceId: payloads[0].pageId,
      operationStage: 'validated',
      beforeState,
      targetState: {
        moves: payloads.map((payload) => ({
          pageId: payload.pageId,
          parentPageId: payload.targetParentPageId,
          position: null,
        })),
      } satisfies PersistedMoveState,
      reconcile: (record) => this.reconcileMoves(record, context),
      run: async (execution) => {
        const executed = await this.executeMoves(
          payloads,
          inputs.map((input) => input.expectedUpdatedAt),
          prepared.actor,
          context,
          async (runtimeBeforeState, runtimeTargetState) => {
            await execution.checkpoint({
              stage: 'moves_planned',
              resourceId: payloads[0].pageId,
              beforeState: runtimeBeforeState,
              targetState: runtimeTargetState,
            });
          },
        );
        const warnings = await this.auditMoves(
          executed,
          context,
          prepared.actor,
          'move_pages',
        );
        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: payloads[0].pageId,
        });
        return {
          items: executed.map((item) => this.buildMoveItem(item)),
          movedCount: executed.filter((item) => item.changed).length,
          totalCount: executed.length,
          atomic: true,
          searchScopeUpdated: executed.some((item) => item.changed),
          warnings,
        };
      },
    });
  }

  private async authorizeAndPlanMoves(
    context: McpToolContext,
    spaceId: string,
    instructions: MoveInstruction[],
  ): Promise<{
    actor: User;
    pages: MovePageRow[];
    plans: PlannedMove[];
  }> {
    await this.permissionService.assertSpacePermission(
      context.client,
      'update',
      spaceId,
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    const pages = await this.loadActiveSpacePages(
      context.client.workspaceId,
      spaceId,
    );
    const pageById = new Map(pages.map((page) => [page.id, page]));

    let requiresRootWrite = false;
    const checkedTargets = new Set<string>();
    const checkedReferences = new Set<string>();
    for (const instruction of instructions) {
      const source = pageById.get(instruction.pageId);
      if (!source) {
        throw new NotFoundException('Page not found');
      }
      await this.actorAccessService.assertCanEditPage(actor, source);

      if (instruction.targetParentPageId) {
        const target = pageById.get(instruction.targetParentPageId);
        if (!target) {
          throw new NotFoundException('Target parent page not found');
        }
        if (!checkedTargets.has(target.id)) {
          await this.actorAccessService.assertCanEditPage(actor, target);
          checkedTargets.add(target.id);
        }
      } else {
        requiresRootWrite = true;
      }

      if (instruction.referencePageId) {
        const reference = pageById.get(instruction.referencePageId);
        if (!reference) {
          throw new NotFoundException('Reference page not found');
        }
        if (!checkedReferences.has(reference.id)) {
          await this.actorAccessService.assertCanViewPage(actor, reference);
          checkedReferences.add(reference.id);
        }
      }
    }
    if (requiresRootWrite) {
      await this.actorAccessService.assertCanCreateInSpace(actor, spaceId);
    }

    return {
      actor,
      pages,
      plans: this.planMoves(pages, instructions),
    };
  }

  private async executeMoves(
    payloads: MovePlanTokenPayload[],
    expectedUpdatedAtValues: string[],
    actor: User,
    context: McpToolContext,
    checkpoint: (
      beforeState: PersistedMoveState,
      targetState: PersistedMoveState,
    ) => Promise<void>,
  ): Promise<ExecutedMove[]> {
    const executed = await this.db.transaction().execute(async (trx) => {
      await this.lockSpace(
        trx,
        context.client.workspaceId,
        payloads[0].spaceId,
      );
      const instructions = payloads.map((payload) =>
        this.toInstruction(payload),
      );
      const pages = await this.loadStableMovePages(
        trx,
        context.client.workspaceId,
        payloads[0].spaceId,
        instructions,
      );
      const pageById = new Map(pages.map((page) => [page.id, page]));

      for (let index = 0; index < payloads.length; index += 1) {
        const payload = payloads[index];
        const current = pageById.get(payload.pageId);
        if (!current) {
          throw new NotFoundException('Page not found');
        }
        const expectedUpdatedAt = this.parseDateTime(
          expectedUpdatedAtValues[index],
          'expectedUpdatedAt',
        );
        if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw new ConflictException(
            `Page ${payload.pageId} changed after preview; preview the move again`,
          );
        }
        if (
          current.parentPageId !== payload.sourceParentPageId ||
          current.position !== payload.sourcePosition
        ) {
          throw new ConflictException(
            `Page ${payload.pageId} hierarchy changed after preview; preview the move again`,
          );
        }
        if (
          this.getPagePathHash(payload.pageId, pages) !==
            payload.sourcePathHash ||
          this.getPageSubtreeHash(payload.pageId, pages) !==
            payload.sourceSubtreeHash ||
          this.getPagePathHash(payload.targetParentPageId, pages) !==
            payload.targetParentPathHash
        ) {
          throw new ConflictException(
            `Page ${payload.pageId} source subtree or target path changed after preview; preview the move again`,
          );
        }
      }

      const plans = this.planMoves(pages, instructions);
      const beforeState: PersistedMoveState = {
        moves: plans.map((plan) => ({
          pageId: plan.pageId,
          parentPageId: plan.beforeParentPageId,
          position: plan.beforePosition,
        })),
      };
      const targetState: PersistedMoveState = {
        moves: plans.map((plan) => ({
          pageId: plan.pageId,
          parentPageId: plan.targetParentPageId,
          position: plan.targetPosition,
        })),
      };
      await checkpoint(beforeState, targetState);

      const executed: ExecutedMove[] = [];
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        const current = pageById.get(plan.pageId) as MovePageRow;
        let page = current;
        if (plan.changed) {
          const expectedUpdatedAt = this.parseDateTime(
            expectedUpdatedAtValues[index],
            'expectedUpdatedAt',
          );
          page = await this.updatePageWithinTransaction(
            trx,
            plan,
            expectedUpdatedAt,
            actor.id,
            context.client.workspaceId,
          );
        }
        executed.push({ ...plan, page });
      }
      return executed;
    });
    const changedPageIds = executed
      .filter((item) => item.changed)
      .map((item) => item.pageId);
    if (changedPageIds.length > 0) {
      this.eventEmitter.emit(EventName.PAGE_UPDATED, {
        pageIds: changedPageIds,
        workspaceId: context.client.workspaceId,
      });
    }
    return executed;
  }

  private async updatePageWithinTransaction(
    trx: KyselyTransaction,
    plan: PlannedMove,
    expectedUpdatedAt: Date,
    actorUserId: string,
    workspaceId: string,
  ): Promise<MovePageRow> {
    const result = await trx
      .updateTable('pages')
      .set({
        parentPageId: plan.targetParentPageId,
        position: plan.targetPosition,
        lastUpdatedById: actorUserId,
        updatedAt: new Date(),
      })
      .where('id', '=', plan.pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('updatedAt', '>=', expectedUpdatedAt)
      .where('updatedAt', '<', new Date(expectedUpdatedAt.getTime() + 1))
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new ConflictException(
        `Page ${plan.pageId} changed while applying the move; the batch was rolled back`,
      );
    }
    const page = (await this.pageRepo.findById(plan.pageId, {
      trx,
    })) as MovePageRow;
    if (!page) {
      throw new ConflictException(
        `Page ${plan.pageId} could not be read after moving`,
      );
    }
    return page;
  }

  private planMoves(
    pages: MovePageRow[],
    instructions: MoveInstruction[],
  ): PlannedMove[] {
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const movedIds = new Set(instructions.map((item) => item.pageId));
    const finalParentById = new Map(
      pages.map((page) => [page.id, page.parentPageId]),
    );
    const originalChildren = this.buildChildrenMap(pages);
    const finalChildren = new Map<string | null, MovePageRow[]>();
    for (const [parentId, children] of originalChildren) {
      finalChildren.set(
        parentId,
        children.filter((child) => !movedIds.has(child.id)),
      );
    }

    for (const instruction of instructions) {
      const page = pageById.get(instruction.pageId);
      if (!page) throw new NotFoundException('Page not found');
      if (
        instruction.targetParentPageId &&
        !pageById.has(instruction.targetParentPageId)
      ) {
        throw new NotFoundException('Target parent page not found');
      }
      this.assertPlacementReference(instruction, pageById);

      const targetSiblings =
        finalChildren.get(instruction.targetParentPageId) ?? [];
      let insertionIndex: number;
      if (instruction.placement === 'first') {
        insertionIndex = 0;
      } else if (instruction.placement === 'last') {
        insertionIndex = targetSiblings.length;
      } else {
        const referenceIndex = targetSiblings.findIndex(
          (sibling) => sibling.id === instruction.referencePageId,
        );
        if (referenceIndex < 0) {
          throw new BadRequestException(
            'A moved reference page must appear earlier in move_pages and already be placed under the target parent',
          );
        }
        insertionIndex =
          instruction.placement === 'before'
            ? referenceIndex
            : referenceIndex + 1;
      }
      targetSiblings.splice(insertionIndex, 0, page);
      finalChildren.set(instruction.targetParentPageId, targetSiblings);
      finalParentById.set(page.id, instruction.targetParentPageId);
    }

    this.assertNoFinalCycles(finalParentById, movedIds);
    const needsPosition = new Set<string>();
    for (const instruction of instructions) {
      const page = pageById.get(instruction.pageId) as MovePageRow;
      const originalSiblings = originalChildren.get(page.parentPageId) ?? [];
      const targetSiblings =
        finalChildren.get(instruction.targetParentPageId) ?? [];
      const originalIndex = originalSiblings.findIndex(
        (sibling) => sibling.id === page.id,
      );
      const targetIndex = targetSiblings.findIndex(
        (sibling) => sibling.id === page.id,
      );
      const originalNeighbors = [
        originalSiblings[originalIndex - 1]?.id ?? null,
        originalSiblings[originalIndex + 1]?.id ?? null,
      ];
      const targetNeighbors = [
        targetSiblings[targetIndex - 1]?.id ?? null,
        targetSiblings[targetIndex + 1]?.id ?? null,
      ];
      if (
        page.parentPageId !== instruction.targetParentPageId ||
        originalNeighbors[0] !== targetNeighbors[0] ||
        originalNeighbors[1] !== targetNeighbors[1]
      ) {
        needsPosition.add(page.id);
      }
    }

    const targetPositionById = new Map<string, string | null>();
    for (const siblings of finalChildren.values()) {
      let index = 0;
      while (index < siblings.length) {
        if (!needsPosition.has(siblings[index].id)) {
          index += 1;
          continue;
        }
        const start = index;
        while (
          index < siblings.length &&
          needsPosition.has(siblings[index].id)
        ) {
          index += 1;
        }
        const lower = start > 0 ? siblings[start - 1].position : null;
        const upper = index < siblings.length ? siblings[index].position : null;
        if (
          (start > 0 && lower == null) ||
          (index < siblings.length && upper == null)
        ) {
          throw new ConflictException(
            'Sibling ordering is incomplete; reorder the target directory in Docmost and retry',
          );
        }
        let generated: string[];
        try {
          generated = generateNJitteredKeysBetween(lower, upper, index - start);
        } catch {
          throw new ConflictException(
            'Sibling ordering is too dense or invalid; reorder the target directory and retry',
          );
        }
        generated.forEach((position, offset) => {
          targetPositionById.set(siblings[start + offset].id, position);
        });
      }
    }

    return instructions.map((instruction) => {
      const page = pageById.get(instruction.pageId) as MovePageRow;
      const changed = needsPosition.has(page.id);
      return {
        ...instruction,
        beforeParentPageId: page.parentPageId,
        beforePosition: page.position,
        targetPosition: changed
          ? (targetPositionById.get(page.id) ?? null)
          : page.position,
        changed,
      };
    });
  }

  private assertPlacementReference(
    instruction: MoveInstruction,
    pageById: Map<string, MovePageRow>,
  ): void {
    if (
      (instruction.placement === 'before' ||
        instruction.placement === 'after') &&
      !instruction.referencePageId
    ) {
      throw new BadRequestException(
        'referencePageId is required for before or after placement',
      );
    }
    if (
      (instruction.placement === 'first' || instruction.placement === 'last') &&
      instruction.referencePageId
    ) {
      throw new BadRequestException(
        'referencePageId is not allowed for first or last placement',
      );
    }
    if (!instruction.referencePageId) return;
    if (instruction.referencePageId === instruction.pageId) {
      throw new BadRequestException('A page cannot be its own move reference');
    }
    if (!pageById.has(instruction.referencePageId)) {
      throw new NotFoundException('Reference page not found');
    }
  }

  private assertNoFinalCycles(
    parentById: Map<string, string | null>,
    movedIds: Set<string>,
  ): void {
    for (const pageId of movedIds) {
      const visited = new Set<string>();
      let cursor: string | null = pageId;
      while (cursor) {
        if (visited.has(cursor)) {
          throw new BadRequestException(
            `Move would create a page hierarchy cycle involving ${pageId}`,
          );
        }
        visited.add(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
    }
  }

  private async reconcileMoves(
    record: McpIdempotencyReconciliationRecord,
    context: McpToolContext,
  ): Promise<McpIdempotencyReconciliation<unknown>> {
    const beforeState = this.parsePersistedMoveState(record.beforeState);
    const targetState = this.parsePersistedMoveState(record.targetState);
    if (!beforeState || !targetState || beforeState.moves.length === 0) {
      return { outcome: 'repair_required' };
    }
    if (record.operationStage === 'validated') {
      return { outcome: 'retry' };
    }

    const pageIds = beforeState.moves.map((move) => move.pageId);
    const pages = await this.pageRepo.findManyByIds(pageIds, {
      workspaceId: context.client.workspaceId,
    });
    if (pages.length !== pageIds.length) {
      return { outcome: 'repair_required' };
    }
    const currentById = new Map(pages.map((page) => [page.id, page]));
    const matches = (state: PersistedMoveState) =>
      state.moves.every((move) => {
        const page = currentById.get(move.pageId);
        return (
          page?.parentPageId === move.parentPageId &&
          page?.position === move.position
        );
      });

    if (matches(targetState)) {
      const auditPersisted = await this.auditService.tryLog({
        workspaceId: context.client.workspaceId,
        clientId: context.client.id,
        actorUserId: context.client.actorUserId,
        event: 'mcp.idempotency.reconciled',
        resourceType: record.resourceType ?? 'page',
        resourceId: record.resourceId,
        spaceId: pages[0].spaceId,
        toolName: record.action,
        requestId: context.requestId,
        metadata: {
          operationStage: record.operationStage,
          pageIds,
          outcome: 'completed',
        },
        ipAddress: context.ipAddress,
      });
      const warnings = [
        RECOVERY_WARNING,
        ...(auditPersisted ? [] : [AUDIT_WARNING]),
      ];
      const items = targetState.moves.map((target, index) => {
        const before = beforeState.moves[index];
        const page = currentById.get(target.pageId) as MovePageRow;
        const moved =
          before.parentPageId !== target.parentPageId ||
          before.position !== target.position;
        return {
          page: this.toPageSummary(page),
          moved,
          from: {
            parentPageId: before.parentPageId,
            position: before.position,
          },
          to: {
            parentPageId: target.parentPageId,
            position: target.position,
          },
        };
      });
      return {
        outcome: 'completed',
        response:
          items.length === 1
            ? {
                ...items[0],
                searchScopeUpdated: items[0].moved,
                warnings,
              }
            : {
                items,
                movedCount: items.filter((item) => item.moved).length,
                totalCount: items.length,
                atomic: true,
                searchScopeUpdated: items.some((item) => item.moved),
                warnings,
              },
      };
    }
    if (matches(beforeState)) return { outcome: 'retry' };
    return { outcome: 'repair_required' };
  }

  private async auditMoves(
    executed: ExecutedMove[],
    context: McpToolContext,
    actor: User,
    toolName: 'move_page' | 'move_pages',
  ): Promise<string[]> {
    const results = await Promise.all(
      executed.map((item) =>
        this.auditService.tryLog({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.page.move',
          resourceType: 'page',
          resourceId: item.pageId,
          spaceId: item.page.spaceId,
          toolName,
          requestId: context.requestId,
          before: {
            parentPageId: item.beforeParentPageId,
            position: item.beforePosition,
          },
          after: {
            parentPageId: item.targetParentPageId,
            position: item.targetPosition,
          },
          metadata: {
            placement: item.placement,
            referencePageId: item.referencePageId,
            changed: item.changed,
            batchSize: executed.length,
          },
          ipAddress: context.ipAddress,
        }),
      ),
    );
    return results.every(Boolean) ? [] : [AUDIT_WARNING];
  }

  private buildMoveResponse(item: ExecutedMove, warnings: string[]) {
    return {
      ...this.buildMoveItem(item),
      searchScopeUpdated: item.changed,
      warnings,
    };
  }

  private buildMoveItem(item: ExecutedMove) {
    return {
      page: this.toPageSummary(item.page),
      moved: item.changed,
      placement: item.placement,
      referencePageId: item.referencePageId,
      from: {
        parentPageId: item.beforeParentPageId,
        position: item.beforePosition,
      },
      to: {
        parentPageId: item.targetParentPageId,
        position: item.targetPosition,
      },
    };
  }

  private async permissionInheritanceMayChange(
    currentParentPageId: string | null,
    targetParentPageId: string | null,
    pages: MovePageRow[],
  ): Promise<boolean> {
    if (currentParentPageId === targetParentPageId) return false;
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const currentAncestors = this.collectAncestorIds(
      currentParentPageId,
      pageById,
    );
    const targetAncestors = this.collectAncestorIds(
      targetParentPageId,
      pageById,
    );
    const candidateIds = [
      ...new Set([...currentAncestors, ...targetAncestors]),
    ];
    if (candidateIds.length === 0) return false;
    const restrictedRows = await this.db
      .selectFrom('pageAccess')
      .select(['pageId'])
      .where('pageId', 'in', candidateIds)
      .execute();
    const restrictedIds = new Set(restrictedRows.map((row) => row.pageId));
    const currentRestrictions = new Set(
      currentAncestors.filter((id) => restrictedIds.has(id)),
    );
    const targetRestrictions = new Set(
      targetAncestors.filter((id) => restrictedIds.has(id)),
    );
    return !this.setsEqual(currentRestrictions, targetRestrictions);
  }

  private collectAncestorIds(
    pageId: string | null,
    pageById: Map<string, MovePageRow>,
  ): string[] {
    const ids: string[] = [];
    const visited = new Set<string>();
    let cursor = pageId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new ConflictException('Existing page hierarchy contains a cycle');
      }
      visited.add(cursor);
      const page = pageById.get(cursor);
      if (!page) break;
      ids.push(page.id);
      cursor = page.parentPageId;
    }
    return ids;
  }

  private countSubtreePages(pageId: string, pages: MovePageRow[]): number {
    return this.collectSubtreeIds(pageId, pages).length;
  }

  private collectSubtreeIds(pageId: string, pages: MovePageRow[]): string[] {
    const pageById = new Map(pages.map((page) => [page.id, page]));
    if (!pageById.has(pageId)) throw new NotFoundException('Page not found');
    const children = this.buildChildrenMap(pages);
    const pending = [pageId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of children.get(current) ?? []) pending.push(child.id);
    }
    return [...visited];
  }

  private getPagePathHash(pageId: string | null, pages: MovePageRow[]): string {
    if (!pageId) return this.hashPageIds([]);
    const pageById = new Map(pages.map((page) => [page.id, page]));
    if (!pageById.has(pageId)) throw new NotFoundException('Page not found');
    return this.hashPageIds(
      this.collectAncestorIds(pageId, pageById).reverse(),
    );
  }

  private getPageSubtreeHash(pageId: string, pages: MovePageRow[]): string {
    return this.hashPageIds(
      this.collectSubtreeIds(pageId, pages).slice().sort(),
    );
  }

  private hashPageIds(pageIds: string[]): string {
    return createHash('sha256').update(JSON.stringify(pageIds)).digest('hex');
  }

  private buildPagePath(
    pageId: string,
    pages: MovePageRow[],
    parentOverrides: Map<string, string | null>,
  ): Array<{ id: string; title: string | null }> {
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const path: Array<{ id: string; title: string | null }> = [];
    const visited = new Set<string>();
    let cursor: string | null = pageId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new ConflictException('Existing page hierarchy contains a cycle');
      }
      visited.add(cursor);
      const page = pageById.get(cursor);
      if (!page) break;
      path.push({ id: page.id, title: page.title });
      cursor = parentOverrides.has(page.id)
        ? (parentOverrides.get(page.id) ?? null)
        : page.parentPageId;
    }
    return path.reverse();
  }

  private buildChildrenMap(
    pages: MovePageRow[],
  ): Map<string | null, MovePageRow[]> {
    const children = new Map<string | null, MovePageRow[]>();
    for (const page of pages) {
      const siblings = children.get(page.parentPageId) ?? [];
      siblings.push(page);
      children.set(page.parentPageId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => this.comparePages(left, right));
    }
    return children;
  }

  private comparePages(left: MovePageRow, right: MovePageRow): number {
    const leftPosition = left.position ?? '';
    const rightPosition = right.position ?? '';
    if (leftPosition < rightPosition) return -1;
    if (leftPosition > rightPosition) return 1;
    return left.id.localeCompare(right.id);
  }

  private async loadTreeRows(
    workspaceId: string,
    spaceId: string,
    candidateIds?: string[],
  ): Promise<MovePageRow[]> {
    if (candidateIds && candidateIds.length === 0) return [];
    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'position',
        'parentPageId',
        'spaceId',
        'workspaceId',
        'creatorId',
        'lastUpdatedById',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'isLocked',
        'isBase',
        'contributorIds',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null);
    if (candidateIds) query = query.where('id', 'in', candidateIds);
    else query = query.limit(MAX_PAGE_TREE_SCAN + 1);
    return query.execute();
  }

  private async loadActiveSpacePages(
    workspaceId: string,
    spaceId: string,
    trx?: KyselyTransaction,
  ): Promise<MovePageRow[]> {
    const db = trx ?? this.db;
    return db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'position',
        'parentPageId',
        'spaceId',
        'workspaceId',
        'creatorId',
        'lastUpdatedById',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'isLocked',
        'isBase',
        'contributorIds',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async loadStableMovePages(
    trx: KyselyTransaction,
    workspaceId: string,
    spaceId: string,
    instructions: MoveInstruction[],
  ): Promise<MovePageRow[]> {
    const lockedIds = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pages = await this.loadActiveSpacePages(workspaceId, spaceId, trx);
      const requiredIds = this.collectMoveLockIds(pages, instructions);
      const unlockedIds = [...requiredIds].filter((id) => !lockedIds.has(id));
      if (unlockedIds.length === 0) return pages;

      await trx
        .selectFrom('pages')
        .select(['id'])
        .where('workspaceId', '=', workspaceId)
        .where('spaceId', '=', spaceId)
        .where('deletedAt', 'is', null)
        .where('id', 'in', unlockedIds)
        .orderBy('id')
        .forUpdate()
        .execute();
      unlockedIds.forEach((id) => lockedIds.add(id));
    }
    throw new ConflictException(
      'Page hierarchy kept changing while acquiring move locks; preview and retry',
    );
  }

  private collectMoveLockIds(
    pages: MovePageRow[],
    instructions: MoveInstruction[],
  ): Set<string> {
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const children = this.buildChildrenMap(pages);
    const ids = new Set<string>();
    for (const instruction of instructions) {
      if (!pageById.has(instruction.pageId)) {
        throw new NotFoundException('Page not found');
      }
      this.collectSubtreeIds(instruction.pageId, pages).forEach((id) =>
        ids.add(id),
      );
      this.collectAncestorIds(instruction.pageId, pageById).forEach((id) =>
        ids.add(id),
      );

      if (instruction.targetParentPageId) {
        if (!pageById.has(instruction.targetParentPageId)) {
          throw new NotFoundException('Target parent page not found');
        }
        this.collectAncestorIds(
          instruction.targetParentPageId,
          pageById,
        ).forEach((id) => ids.add(id));
      }
      for (const sibling of children.get(instruction.targetParentPageId) ??
        []) {
        ids.add(sibling.id);
      }

      if (instruction.referencePageId) {
        if (!pageById.has(instruction.referencePageId)) {
          throw new NotFoundException('Reference page not found');
        }
        ids.add(instruction.referencePageId);
      }
    }
    return ids;
  }

  private async lockSpace(
    trx: KyselyTransaction,
    workspaceId: string,
    spaceId: string,
  ): Promise<void> {
    const row = await trx
      .selectFrom('spaces')
      .select(['id'])
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Space not found');
  }

  private signMovePlan(payload: MovePlanTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(encoded, this.getSigningSecret());
    return `${encoded}.${signature}`;
  }

  private verifyMovePlan(
    token: string,
    context: McpToolContext,
  ): MovePlanTokenPayload {
    if (token.length > MOVE_PLAN_TOKEN_MAX_LENGTH) {
      throw new BadRequestException('Invalid movePlanToken');
    }
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new BadRequestException('Invalid movePlanToken');
    }
    const [encoded, suppliedSignature] = parts;
    const secrets = [
      this.getSigningSecret(),
      this.environmentService.getMcpTokenHashPreviousSecret(),
    ].filter((secret): secret is string => Boolean(secret));
    const signatureValid = secrets.some((secret) =>
      this.safeSignatureEqual(suppliedSignature, this.sign(encoded, secret)),
    );
    if (!signatureValid) {
      throw new BadRequestException('Invalid movePlanToken signature');
    }

    let payload: MovePlanTokenPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as MovePlanTokenPayload;
    } catch {
      throw new BadRequestException('Invalid movePlanToken payload');
    }
    this.validateMovePlanPayload(payload);
    if (
      payload.clientId !== context.client.id ||
      payload.workspaceId !== context.client.workspaceId ||
      payload.actorUserId !== (context.client.actorUserId ?? null)
    ) {
      throw new BadRequestException(
        'movePlanToken belongs to a different MCP client or actor',
      );
    }
    if (payload.expiresAt <= Date.now()) {
      throw new ConflictException(
        'movePlanToken expired; preview the move again',
      );
    }
    return payload;
  }

  private validateMovePlanPayload(payload: MovePlanTokenPayload): void {
    const valid =
      payload?.version === MOVE_PLAN_VERSION &&
      typeof payload.nonce === 'string' &&
      typeof payload.clientId === 'string' &&
      typeof payload.workspaceId === 'string' &&
      (typeof payload.actorUserId === 'string' ||
        payload.actorUserId === null) &&
      isValidUuid(payload.spaceId) &&
      isValidUuid(payload.pageId) &&
      (payload.targetParentPageId === null ||
        isValidUuid(payload.targetParentPageId)) &&
      (payload.referencePageId === null ||
        isValidUuid(payload.referencePageId)) &&
      ['first', 'last', 'before', 'after'].includes(payload.placement) &&
      (payload.sourceParentPageId === null ||
        isValidUuid(payload.sourceParentPageId)) &&
      (payload.sourcePosition === null ||
        typeof payload.sourcePosition === 'string') &&
      this.isSha256Hash(payload.sourcePathHash) &&
      this.isSha256Hash(payload.sourceSubtreeHash) &&
      this.isSha256Hash(payload.targetParentPathHash) &&
      !Number.isNaN(Date.parse(payload.expectedUpdatedAt)) &&
      Number.isInteger(payload.subtreeCount) &&
      payload.subtreeCount >= 1 &&
      typeof payload.permissionInheritanceMayChange === 'boolean' &&
      typeof payload.requiresConfirmation === 'boolean' &&
      Number.isFinite(payload.issuedAt) &&
      Number.isFinite(payload.expiresAt) &&
      payload.expiresAt > payload.issuedAt;
    if (!valid) throw new BadRequestException('Invalid movePlanToken payload');
  }

  private sign(value: string, secret: string): string {
    return createHmac('sha256', secret).update(value).digest('base64url');
  }

  private isSha256Hash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  private safeSignatureEqual(left: string, right: string): boolean {
    try {
      const leftBuffer = Buffer.from(left, 'base64url');
      const rightBuffer = Buffer.from(right, 'base64url');
      return (
        leftBuffer.length === rightBuffer.length &&
        timingSafeEqual(leftBuffer, rightBuffer)
      );
    } catch {
      return false;
    }
  }

  private getSigningSecret(): string {
    const secret = this.environmentService.getMcpTokenHashSecret()?.trim();
    if (!secret) {
      throw new InternalServerErrorException(
        'MCP page move planning is not configured',
      );
    }
    return secret;
  }

  private assertExpectedUpdatedAt(
    payload: MovePlanTokenPayload,
    value: string,
  ): void {
    const parsed = this.parseDateTime(value, 'expectedUpdatedAt');
    if (parsed.toISOString() !== payload.expectedUpdatedAt) {
      throw new ConflictException(
        'expectedUpdatedAt does not match movePlanToken; preview the move again',
      );
    }
  }

  private parseMoveInstruction(args: JsonObject): MoveInstruction {
    const placement = this.requirePlacement(args, 'placement');
    return {
      pageId: this.requireString(args, 'pageId'),
      targetParentPageId: this.requireNullableString(
        args,
        'targetParentPageId',
      ),
      placement,
      referencePageId: this.optionalString(args, 'referencePageId') ?? null,
    };
  }

  private toInstruction(payload: MovePlanTokenPayload): MoveInstruction {
    return {
      pageId: payload.pageId,
      targetParentPageId: payload.targetParentPageId,
      placement: payload.placement,
      referencePageId: payload.referencePageId,
    };
  }

  private parseBatchInputs(args: JsonObject): Array<{
    movePlanToken: string;
    expectedUpdatedAt: string;
  }> {
    if (!Array.isArray(args.moves)) {
      throw new BadRequestException('moves must be an array');
    }
    const maxMoveBatchSize = this.getMaxMoveBatchSize();
    if (args.moves.length < 1 || args.moves.length > maxMoveBatchSize) {
      throw new BadRequestException(
        `moves must contain between 1 and ${maxMoveBatchSize} items`,
      );
    }
    return args.moves.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(`moves[${index}] must be an object`);
      }
      const item = raw as JsonObject;
      return {
        movePlanToken: this.requireString(item, 'movePlanToken'),
        expectedUpdatedAt: this.requireString(item, 'expectedUpdatedAt'),
      };
    });
  }

  private parsePersistedMoveState(value: unknown): PersistedMoveState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const moves = (value as { moves?: unknown }).moves;
    if (!Array.isArray(moves)) return null;
    const parsed: PersistedMoveState['moves'] = [];
    for (const item of moves) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const move = item as Record<string, unknown>;
      if (
        typeof move.pageId !== 'string' ||
        (move.parentPageId !== null && typeof move.parentPageId !== 'string') ||
        (move.position !== null && typeof move.position !== 'string')
      ) {
        return null;
      }
      parsed.push({
        pageId: move.pageId,
        parentPageId: move.parentPageId as string | null,
        position: move.position as string | null,
      });
    }
    return { moves: parsed };
  }

  private getMaxMoveBatchSize(): number {
    const configured = this.environmentService.getMcpMaxBatchSize();
    if (!Number.isInteger(configured) || configured < 1) return 20;
    return Math.min(configured, MAX_MOVE_BATCH_SIZE);
  }

  private toPageSummary(
    page: Pick<
      Page,
      | 'id'
      | 'slugId'
      | 'title'
      | 'icon'
      | 'parentPageId'
      | 'spaceId'
      | 'workspaceId'
      | 'updatedAt'
    >,
  ) {
    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      icon: page.icon,
      parentPageId: page.parentPageId,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      updatedAt: page.updatedAt,
    };
  }

  private requireString(args: JsonObject, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${key} is required`);
    }
    return value.trim();
  }

  private optionalString(args: JsonObject, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${key} must be a non-empty string`);
    }
    return value.trim();
  }

  private requireNullableString(args: JsonObject, key: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new BadRequestException(`${key} is required`);
    }
    const value = args[key];
    if (value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${key} must be a UUID or null`);
    }
    return value.trim();
  }

  private requirePlacement(args: JsonObject, key: string): PagePlacement {
    const value = this.requireString(args, key);
    if (!['first', 'last', 'before', 'after'].includes(value)) {
      throw new BadRequestException(
        `${key} must be first, last, before, or after`,
      );
    }
    return value as PagePlacement;
  }

  private optionalInteger(
    args: JsonObject,
    key: string,
    min: number,
    max: number,
  ): number | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (
      !Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    ) {
      throw new BadRequestException(
        `${key} must be an integer between ${min} and ${max}`,
      );
    }
    return value as number;
  }

  private parseDateTime(value: string, field: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be an ISO date-time`);
    }
    return parsed;
  }

  private findDuplicateIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    return [...duplicates];
  }

  private setsEqual(left: Set<string>, right: Set<string>): boolean {
    return (
      left.size === right.size && [...left].every((value) => right.has(value))
    );
  }
}
