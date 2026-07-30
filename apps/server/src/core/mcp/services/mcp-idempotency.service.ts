import { ConflictException, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash, randomUUID } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import type { Json } from '@docmost/db/types/db';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type { McpAuthenticatedClient } from '../types/mcp.types';
import { getMcpSafeErrorMessage } from '../utils/mcp-error.util';
import { McpDistributedTaskService } from './mcp-distributed-task.service';

const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;
const IDEMPOTENCY_HEARTBEAT_MS = Math.floor(IDEMPOTENCY_LEASE_MS / 3);
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const IDEMPOTENCY_CLEANUP_LOCK_MS = 10 * 60 * 1000;

type McpIdempotencyCheckpoint = {
  stage: string;
  resourceId?: string | null;
  beforeState?: unknown;
  targetState?: unknown;
};

export type McpIdempotencyExecution = {
  checkpointResourceId: (resourceId: string) => Promise<void>;
  checkpoint: (checkpoint: McpIdempotencyCheckpoint) => Promise<void>;
};

export type McpIdempotencyReconciliationRecord = {
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  operationStage: string;
  beforeState: unknown;
  targetState: unknown;
};

export type McpIdempotencyReconciliation<T> =
  | { outcome: 'completed'; response: T }
  | { outcome: 'retry' }
  | { outcome: 'unresolved' }
  | { outcome: 'repair_required' };

type IdempotencyInput<T> = {
  client: McpAuthenticatedClient;
  action: string;
  idempotencyKey?: string | null;
  request: unknown;
  run: (execution: McpIdempotencyExecution) => Promise<T>;
  resourceType?: string | null;
  resourceId?: string | null;
  operationStage?: string;
  beforeState?: unknown;
  targetState?: unknown;
  reconcile?: (
    record: McpIdempotencyReconciliationRecord,
  ) => Promise<McpIdempotencyReconciliation<T>>;
  getResourceId?: (response: T) => string | null | undefined;
};

@Injectable()
export class McpIdempotencyService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly distributedTaskService: McpDistributedTaskService,
  ) {}

  async run<T>(input: IdempotencyInput<T>): Promise<T> {
    if (!input.idempotencyKey) {
      return input.run({
        checkpointResourceId: async () => undefined,
        checkpoint: async () => undefined,
      });
    }

    const requestHash = this.hashRequest(input.request);
    const leaseOwner = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = new Date();
      const reservation = await this.db
        .insertInto('mcpIdempotencyKeys')
        .values({
          clientId: input.client.id,
          workspaceId: input.client.workspaceId,
          idempotencyKey: input.idempotencyKey,
          action: input.action,
          requestHash,
          response: null,
          status: 'in_progress',
          leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS),
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          operationStage: input.operationStage ?? 'reserved',
          beforeState: this.toNullableJson(input.beforeState),
          targetState: this.toNullableJson(input.targetState),
        })
        .onConflict((oc) =>
          oc
            .columns(['clientId', 'action', 'idempotencyKey'])
            .where('deletedAt', 'is', null)
            .doNothing(),
        )
        .returning(['id'])
        .executeTakeFirst();

      if (reservation) {
        return this.runReserved(input, requestHash, reservation.id, leaseOwner);
      }

      const existing = await this.findExisting(input);
      if (!existing) {
        continue;
      }

      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency key was already used with a different request. Reuse a key only for an exact retry; if any argument changed, including expectedUpdatedAt, use a new idempotencyKey.',
        );
      }

      if (existing.status === 'completed' && existing.response !== null) {
        return existing.response as T;
      }

      if (existing.status === 'needs_reconciliation') {
        if (!input.reconcile) {
          throw new ConflictException(
            'Idempotent request requires reconciliation before it can be retried',
          );
        }

        const claimed = await this.claimForReconciliation(
          existing.id,
          existing.status,
          leaseOwner,
        );
        if (claimed) {
          return this.reconcileReserved(
            input,
            requestHash,
            existing,
            leaseOwner,
          );
        }
        continue;
      }

      if (existing.status === 'repair_required') {
        throw new ConflictException(
          'Idempotent request requires manual repair before it can be retried',
        );
      }

      if (
        existing.leaseExpiresAt &&
        new Date(existing.leaseExpiresAt).getTime() > Date.now()
      ) {
        throw new ConflictException(
          'Idempotent request is already in progress',
        );
      }

      if (!input.reconcile) {
        const marked = await this.markNeedsReconciliation(existing.id);
        if (!marked) {
          continue;
        }
        throw new ConflictException(
          'Idempotent request lease expired and requires reconciliation',
        );
      }

      const claimed = await this.claimForReconciliation(
        existing.id,
        existing.status,
        leaseOwner,
      );
      if (claimed) {
        return this.reconcileReserved(input, requestHash, existing, leaseOwner);
      }
    }

    throw new ConflictException(
      'Idempotency reservation changed; retry request',
    );
  }

  private async runReserved<T>(
    input: IdempotencyInput<T>,
    requestHash: string,
    reservationId: string,
    leaseOwner: string,
  ): Promise<T> {
    let response: T;
    let hasDurableResource = Boolean(input.resourceId);
    try {
      response = await this.withLeaseHeartbeat(reservationId, leaseOwner, () =>
        input.run({
          checkpointResourceId: async (resourceId) => {
            await this.checkpointOperation(reservationId, leaseOwner, {
              stage: 'resource_checkpointed',
              resourceId,
            });
            hasDurableResource = true;
          },
          checkpoint: async (checkpoint) => {
            await this.checkpointOperation(
              reservationId,
              leaseOwner,
              checkpoint,
            );
            hasDurableResource ||= Boolean(checkpoint.resourceId);
          },
        }),
      );
    } catch (err) {
      if (hasDurableResource) {
        await this.markOwnedNeedsReconciliation(reservationId, leaseOwner, err);
      } else {
        await this.releaseReservation(reservationId, leaseOwner);
      }
      throw err;
    }

    await this.finalizeReservation(
      input,
      requestHash,
      reservationId,
      leaseOwner,
      response,
    );

    return response;
  }

  private async reconcileReserved<T>(
    input: IdempotencyInput<T>,
    requestHash: string,
    existing: Awaited<ReturnType<McpIdempotencyService['findExisting']>>,
    leaseOwner: string,
  ): Promise<T> {
    const reconcile = input.reconcile;
    if (!reconcile) {
      throw new ConflictException(
        'Idempotent request requires reconciliation before it can be retried',
      );
    }

    let reconciliation: McpIdempotencyReconciliation<T>;
    try {
      reconciliation = await this.withLeaseHeartbeat(
        existing.id,
        leaseOwner,
        () =>
          reconcile({
            action: existing.action,
            resourceType: existing.resourceType,
            resourceId: existing.resourceId,
            operationStage: existing.operationStage,
            beforeState: existing.beforeState,
            targetState: existing.targetState,
          }),
      );
    } catch (err) {
      await this.markOwnedNeedsReconciliation(existing.id, leaseOwner, err);
      throw err;
    }

    if (reconciliation.outcome === 'completed') {
      await this.finalizeReservation(
        input,
        requestHash,
        existing.id,
        leaseOwner,
        reconciliation.response,
      );
      return reconciliation.response;
    }

    if (reconciliation.outcome === 'retry') {
      return this.runReserved(input, requestHash, existing.id, leaseOwner);
    }

    if (reconciliation.outcome === 'repair_required') {
      await this.markRepairRequired(existing.id, leaseOwner);
      throw new ConflictException(
        'Idempotent request requires manual repair before it can be retried',
      );
    }

    await this.markOwnedNeedsReconciliation(existing.id, leaseOwner);
    throw new ConflictException(
      'Idempotent request could not be reconciled automatically',
    );
  }

  private async finalizeReservation<T>(
    input: IdempotencyInput<T>,
    requestHash: string,
    reservationId: string,
    leaseOwner: string,
    response: T,
  ): Promise<void> {
    const resourceId =
      input.getResourceId?.(response) ?? input.resourceId ?? undefined;
    const finalized = await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        requestHash,
        response: this.toJson(response),
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
        ...(resourceId ? { resourceId } : {}),
        operationStage: 'completed',
        lastError: null,
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('deletedAt', 'is', null)
      .where('status', '=', 'in_progress')
      .where('leaseOwner', '=', leaseOwner)
      .where('response', 'is', null)
      .returning(['id'])
      .executeTakeFirst();

    if (!finalized) {
      throw new ConflictException('Idempotency reservation was lost');
    }
  }

  private findExisting<T>(input: IdempotencyInput<T>) {
    return this.db
      .selectFrom('mcpIdempotencyKeys')
      .select([
        'id',
        'requestHash',
        'response',
        'status',
        'leaseExpiresAt',
        'action',
        'resourceType',
        'resourceId',
        'operationStage',
        'beforeState',
        'targetState',
      ])
      .where('clientId', '=', input.client.id)
      .where('workspaceId', '=', input.client.workspaceId)
      .where('action', '=', input.action)
      .where('idempotencyKey', '=', input.idempotencyKey as string)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  private async releaseReservation(
    reservationId: string,
    leaseOwner: string,
  ): Promise<void> {
    await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        deletedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('leaseOwner', '=', leaseOwner)
      .where('response', 'is', null)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async checkpointOperation(
    reservationId: string,
    leaseOwner: string,
    checkpoint: McpIdempotencyCheckpoint,
  ): Promise<void> {
    const values = {
      operationStage: checkpoint.stage,
      ...(typeof checkpoint.resourceId !== 'undefined'
        ? { resourceId: checkpoint.resourceId }
        : {}),
      ...(typeof checkpoint.beforeState !== 'undefined'
        ? { beforeState: this.toNullableJson(checkpoint.beforeState) }
        : {}),
      ...(typeof checkpoint.targetState !== 'undefined'
        ? { targetState: this.toNullableJson(checkpoint.targetState) }
        : {}),
      leaseExpiresAt: new Date(Date.now() + IDEMPOTENCY_LEASE_MS),
      updatedAt: new Date(),
    };
    const checkpointResult = await this.db
      .updateTable('mcpIdempotencyKeys')
      .set(values)
      .where('id', '=', reservationId)
      .where('status', '=', 'in_progress')
      .where('leaseOwner', '=', leaseOwner)
      .where('deletedAt', 'is', null)
      .returning(['id'])
      .executeTakeFirst();

    if (!checkpointResult) {
      throw new ConflictException('Idempotency lease was lost');
    }
  }

  private async markNeedsReconciliation(
    reservationId: string,
  ): Promise<boolean> {
    const marked = await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        status: 'needs_reconciliation',
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('status', '=', 'in_progress')
      .where('leaseExpiresAt', '<=', new Date())
      .where('deletedAt', 'is', null)
      .returning(['id'])
      .executeTakeFirst();
    return Boolean(marked);
  }

  private async markOwnedNeedsReconciliation(
    reservationId: string,
    leaseOwner: string,
    err?: unknown,
  ): Promise<void> {
    await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        status: 'needs_reconciliation',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: err ? this.getSafeErrorMessage(err) : null,
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('status', '=', 'in_progress')
      .where('leaseOwner', '=', leaseOwner)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async markRepairRequired(
    reservationId: string,
    leaseOwner: string,
  ): Promise<void> {
    await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        status: 'repair_required',
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('status', '=', 'in_progress')
      .where('leaseOwner', '=', leaseOwner)
      .where('deletedAt', 'is', null)
      .execute();
  }

  private async claimForReconciliation(
    reservationId: string,
    status: string,
    leaseOwner: string,
  ): Promise<boolean> {
    let query = this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        status: 'in_progress',
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + IDEMPOTENCY_LEASE_MS),
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('status', '=', status)
      .where('deletedAt', 'is', null);

    if (status === 'in_progress') {
      query = query.where('leaseExpiresAt', '<=', new Date());
    }

    const claimed = await query.returning(['id']).executeTakeFirst();
    return Boolean(claimed);
  }

  @Interval(IDEMPOTENCY_CLEANUP_INTERVAL_MS)
  async maintainReservations(): Promise<{
    expiredLeases: number;
    deletedRecords: number;
  }> {
    const result = await this.distributedTaskService.runWithLock(
      'idempotency-maintenance',
      IDEMPOTENCY_CLEANUP_LOCK_MS,
      async () => {
        const expiredLeases = await this.markExpiredLeasesForReconciliation();
        const deletedRecords = await this.cleanupExpired();
        return { expiredLeases, deletedRecords };
      },
    );
    return result.acquired
      ? result.value
      : { expiredLeases: 0, deletedRecords: 0 };
  }

  async markExpiredLeasesForReconciliation(): Promise<number> {
    const rows = await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        status: 'needs_reconciliation',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: 'Execution lease expired before completion',
        updatedAt: new Date(),
      })
      .where('status', '=', 'in_progress')
      .where('leaseExpiresAt', '<=', new Date())
      .where('deletedAt', 'is', null)
      .returning(['id'])
      .execute();
    return rows.length;
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.db
      .deleteFrom('mcpIdempotencyKeys')
      .where('expiresAt', '<=', new Date())
      .where((eb) =>
        eb.or([
          eb('status', '=', 'completed'),
          eb('deletedAt', 'is not', null),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private hashRequest(request: unknown): string {
    return createHash('sha256').update(stableStringify(request)).digest('hex');
  }

  private toJson(value: unknown): Json {
    return JSON.parse(JSON.stringify(value)) as Json;
  }

  private toNullableJson(value: unknown): Json | null {
    return typeof value === 'undefined' ? null : this.toJson(value);
  }

  private getSafeErrorMessage(err: unknown): string {
    return getMcpSafeErrorMessage(err, 'MCP operation requires reconciliation');
  }

  private async withLeaseHeartbeat<T>(
    reservationId: string,
    leaseOwner: string,
    task: () => Promise<T>,
  ): Promise<T> {
    let heartbeatError: unknown;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = this.renewLease(reservationId, leaseOwner)
        .catch((err) => {
          heartbeatError = err;
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    };
    const timer = setInterval(heartbeat, IDEMPOTENCY_HEARTBEAT_MS);
    timer.unref?.();
    try {
      const result = await task();
      await heartbeatInFlight;
      if (heartbeatError) {
        throw heartbeatError;
      }
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async renewLease(
    reservationId: string,
    leaseOwner: string,
  ): Promise<void> {
    const renewed = await this.db
      .updateTable('mcpIdempotencyKeys')
      .set({
        leaseExpiresAt: new Date(Date.now() + IDEMPOTENCY_LEASE_MS),
        updatedAt: new Date(),
      })
      .where('id', '=', reservationId)
      .where('status', '=', 'in_progress')
      .where('leaseOwner', '=', leaseOwner)
      .where('deletedAt', 'is', null)
      .returning(['id'])
      .executeTakeFirst();
    if (!renewed) {
      throw new ConflictException('Idempotency lease was lost');
    }
  }
}

function stableStringify(value: unknown): string {
  if (typeof value === 'undefined') {
    return '"__undefined__"';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',')}}`;
}
