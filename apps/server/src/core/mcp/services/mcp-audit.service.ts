import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { McpAuditLogInput } from '../types/mcp.types';
import { getMcpErrorType } from '../utils/mcp-error.util';
import { McpMetricsService } from './mcp-metrics.service';

@Injectable()
export class McpAuditService {
  private readonly logger = new Logger(McpAuditService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly metricsService: McpMetricsService,
  ) {}

  async log(input: McpAuditLogInput, trx?: KyselyTransaction): Promise<void> {
    try {
      await dbOrTx(this.db, trx)
        .insertInto('mcpAuditLogs')
        .values({
          workspaceId: input.workspaceId,
          clientId: input.clientId ?? null,
          actorUserId: input.actorUserId ?? null,
          event: input.event,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          spaceId: input.spaceId ?? null,
          toolName: input.toolName,
          requestId: input.requestId ?? null,
          before: input.before ?? null,
          after: input.after ?? null,
          metadata: input.metadata ?? null,
          ipAddress: this.normalizeIpAddress(input.ipAddress),
        })
        .execute();
    } catch (err) {
      this.metricsService.recordAuditFailure(input.event);
      throw err;
    }
  }

  async tryLog(input: McpAuditLogInput): Promise<boolean> {
    try {
      await this.log(input);
      return true;
    } catch (err) {
      this.logger.error({
        event: 'mcp.audit.persist_failed',
        auditEvent: input.event,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        errorType: getMcpErrorType(err),
      });
      return false;
    }
  }

  async logPermissionDenied(input: {
    workspaceId: string;
    clientId?: string | null;
    actorUserId?: string | null;
    toolName: string;
    action: string;
    spaceId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    requestId?: string | null;
    ipAddress?: string | null;
  }): Promise<boolean> {
    return this.tryLog({
      workspaceId: input.workspaceId,
      clientId: input.clientId ?? null,
      actorUserId: input.actorUserId ?? null,
      event: 'mcp.permission.denied',
      resourceType: input.resourceType ?? 'permission',
      resourceId: input.resourceId ?? null,
      spaceId: input.spaceId ?? null,
      toolName: input.toolName,
      requestId: input.requestId ?? null,
      metadata: {
        action: input.action,
      },
      ipAddress: this.normalizeIpAddress(input.ipAddress),
    });
  }

  private normalizeIpAddress(ipAddress?: string | null): string | null {
    const normalized = ipAddress?.trim();
    return normalized ? normalized : null;
  }
}
