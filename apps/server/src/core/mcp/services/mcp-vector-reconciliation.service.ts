import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpDistributedTaskService } from './mcp-distributed-task.service';
import { McpVectorIndexService } from './mcp-vector-index.service';
import {
  getMcpErrorType,
  getMcpSafeErrorMessage,
} from '../utils/mcp-error.util';

type EligibilityReconciliationLease = {
  workspaceId: string;
  spaceId: string;
  requestedAt: Date;
};

const RECONCILIATION_INTERVAL_MS = 60 * 1000;
const RECONCILIATION_LOCK_MS = 55 * 1000;
const RECONCILIATION_LEASE_MS = 5 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 10;

@Injectable()
export class McpVectorReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(McpVectorReconciliationService.name);
  private readonly leaseOwner = randomUUID();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly distributedTaskService: McpDistributedTaskService,
    private readonly vectorIndexService: McpVectorIndexService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.environmentService.isVectorSearchEnabled()) {
      return;
    }

    await this.seedStartupReconciliations().catch((err) =>
      this.logger.warn({
        event: 'mcp.vector.reconciliation_seed_failed',
        errorType: getMcpErrorType(err),
      }),
    );
    await this.reconcilePendingWithLock().catch((err) =>
      this.logger.warn({
        event: 'mcp.vector.reconciliation_startup_failed',
        errorType: getMcpErrorType(err),
      }),
    );
  }

  @Interval(RECONCILIATION_INTERVAL_MS)
  async reconcilePendingWithLock(): Promise<void> {
    if (!this.environmentService.isVectorSearchEnabled()) {
      return;
    }

    await this.distributedTaskService.runWithLock(
      'vector-eligibility-reconciliation',
      RECONCILIATION_LOCK_MS,
      async () => {
        await this.expireElapsedClients();
        await this.processPendingReconciliations();
      },
    );
  }

  private async seedStartupReconciliations(): Promise<void> {
    await sql`
      INSERT INTO docmost_mcp_eligibility_reconciliations (
        workspace_id,
        space_id,
        reason
      )
      SELECT DISTINCT candidate.workspace_id, candidate.space_id, 'startup'
      FROM (
        SELECT workspace_id, space_id
        FROM mcp_client_space_permissions
        WHERE deleted_at IS NULL AND can_index = true
        UNION
        SELECT workspace_id, space_id
        FROM docmost_mcp_chunks
        WHERE deleted_at IS NULL
      ) AS candidate
      JOIN spaces AS space
        ON space.id = candidate.space_id
        AND space.workspace_id = candidate.workspace_id
      ON CONFLICT (workspace_id, space_id) DO NOTHING
    `.execute(this.db);
  }

  private async expireElapsedClients(): Promise<void> {
    await this.db
      .updateTable('mcpClients')
      .set({ status: 'expired', updatedAt: new Date() })
      .where('status', '=', 'active')
      .where('deletedAt', 'is', null)
      .where('expiresAt', 'is not', null)
      .where('expiresAt', '<=', new Date())
      .execute();
  }

  private async processPendingReconciliations(): Promise<void> {
    const leases = await this.claimPendingReconciliations();
    for (const lease of leases) {
      try {
        await this.vectorIndexService.reconcileSpaceEligibility({
          workspaceId: lease.workspaceId,
          spaceId: lease.spaceId,
          enqueueEligible: true,
        });
        await this.completeLease(lease);
      } catch (err) {
        await this.releaseFailedLease(lease, err);
        this.logger.warn({
          event: 'mcp.vector.eligibility_reconciliation_failed',
          workspaceId: lease.workspaceId,
          spaceId: lease.spaceId,
          errorType: getMcpErrorType(err),
        });
      }
    }
  }

  private async claimPendingReconciliations(): Promise<
    EligibilityReconciliationLease[]
  > {
    const leaseExpiresAt = new Date(Date.now() + RECONCILIATION_LEASE_MS);
    const result = await sql<EligibilityReconciliationLease>`
      WITH candidates AS (
        SELECT workspace_id, space_id
        FROM docmost_mcp_eligibility_reconciliations
        WHERE lease_expires_at IS NULL OR lease_expires_at <= now()
        ORDER BY requested_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${RECONCILIATION_BATCH_SIZE}
      )
      UPDATE docmost_mcp_eligibility_reconciliations AS reconciliation
      SET
        lease_owner = ${this.leaseOwner},
        lease_expires_at = ${leaseExpiresAt},
        attempt_count = reconciliation.attempt_count + 1
      FROM candidates
      WHERE reconciliation.workspace_id = candidates.workspace_id
        AND reconciliation.space_id = candidates.space_id
      RETURNING
        reconciliation.workspace_id AS "workspaceId",
        reconciliation.space_id AS "spaceId",
        reconciliation.requested_at AS "requestedAt"
    `.execute(this.db);
    return result.rows;
  }

  private async completeLease(
    lease: EligibilityReconciliationLease,
  ): Promise<void> {
    const deleted = await this.db
      .deleteFrom('docmostMcpEligibilityReconciliations')
      .where('workspaceId', '=', lease.workspaceId)
      .where('spaceId', '=', lease.spaceId)
      .where('leaseOwner', '=', this.leaseOwner)
      .where('requestedAt', '=', lease.requestedAt)
      .executeTakeFirst();

    if (Number(deleted.numDeletedRows) > 0) {
      return;
    }

    // A newer trigger request arrived while this lease was being processed.
    await this.db
      .updateTable('docmostMcpEligibilityReconciliations')
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where('workspaceId', '=', lease.workspaceId)
      .where('spaceId', '=', lease.spaceId)
      .where('leaseOwner', '=', this.leaseOwner)
      .execute();
  }

  private async releaseFailedLease(
    lease: EligibilityReconciliationLease,
    err: unknown,
  ): Promise<void> {
    await this.db
      .updateTable('docmostMcpEligibilityReconciliations')
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: getMcpSafeErrorMessage(
          err,
          'Vector eligibility reconciliation failed',
        ).slice(0, 2000),
      })
      .where('workspaceId', '=', lease.workspaceId)
      .where('spaceId', '=', lease.spaceId)
      .where('leaseOwner', '=', this.leaseOwner)
      .execute();
  }
}
