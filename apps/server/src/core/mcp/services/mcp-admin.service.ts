import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  McpAuditLog,
  McpClient,
  McpClientSpacePermission,
  UpdatableMcpClient,
} from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers/utils';
import {
  CreateMcpClientDto,
  DeleteMcpClientSpacePermissionDto,
  ListMcpAuditLogsDto,
  ListMcpClientsDto,
  McpSpacePermissionDto,
  UpdateMcpClientDto,
  UpsertMcpClientSpacePermissionDto,
} from '../dto/mcp-admin.dto';
import { McpAuditService } from './mcp-audit.service';
import { McpTokenService } from './mcp-token.service';
import type { McpClientStatus } from '../types/mcp.types';
import { getMcpErrorType } from '../utils/mcp-error.util';
import { McpVectorIndexService } from './mcp-vector-index.service';

type PublicMcpClient = {
  [key: string]: string | null;
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  tokenLastFour: string;
  actorUserId: string | null;
  createdById: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PublicMcpSpacePermission = {
  [key: string]: string | boolean;
  id: string;
  clientId: string;
  workspaceId: string;
  spaceId: string;
  canSearch: boolean;
  canSemanticSearch: boolean;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canAppend: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canIndex: boolean;
  createdAt: string;
  updatedAt: string;
};

type PublicMcpAuditLog = {
  id: string;
  workspaceId: string;
  clientId: string | null;
  actorUserId: string | null;
  event: string;
  resourceType: string;
  resourceId: string | null;
  spaceId: string | null;
  toolName: string;
  requestId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
};

type McpPermissionField =
  | 'canSearch'
  | 'canSemanticSearch'
  | 'canRead'
  | 'canCreate'
  | 'canUpdate'
  | 'canAppend'
  | 'canDelete'
  | 'canRestore'
  | 'canIndex';

const MCP_PERMISSION_FIELDS: readonly McpPermissionField[] = [
  'canSearch',
  'canSemanticSearch',
  'canRead',
  'canCreate',
  'canUpdate',
  'canAppend',
  'canDelete',
  'canRestore',
  'canIndex',
];

@Injectable()
export class McpAdminService {
  private readonly logger = new Logger(McpAdminService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly tokenService: McpTokenService,
    private readonly auditService: McpAuditService,
    private readonly vectorIndexService: McpVectorIndexService,
  ) {}

  async createClient(
    workspaceId: string,
    adminUserId: string,
    dto: CreateMcpClientDto,
  ) {
    const requestedSpaceIds =
      dto.permissions?.map((permission) => permission.spaceId) ?? [];
    this.assertUniqueSpaceIds(requestedSpaceIds);
    await this.assertActiveActorUser(workspaceId, dto.actorUserId);
    await this.assertSpacesExist(workspaceId, requestedSpaceIds);

    const expiresAt = this.parseFutureDate(dto.expiresAt, 'expiresAt');
    const token = this.tokenService.generateToken();

    const client = await this.db.transaction().execute(async (trx) => {
      const createdClient = await trx
        .insertInto('mcpClients')
        .values({
          workspaceId,
          name: dto.name.trim(),
          tokenHash: this.tokenService.hashToken(token),
          tokenLastFour: this.tokenService.getTokenLastFour(token),
          status: 'active',
          globalScopes: {},
          actorUserId: dto.actorUserId ?? null,
          createdById: adminUserId,
          expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const permission of dto.permissions ?? []) {
        await trx
          .insertInto('mcpClientSpacePermissions')
          .values({
            ...this.toPermissionInsertValues(
              createdClient.id,
              workspaceId,
              permission,
            ),
          })
          .execute();
      }

      await this.auditService.log(
        {
          workspaceId,
          actorUserId: adminUserId,
          clientId: createdClient.id,
          event: 'mcp.client.create',
          resourceType: 'mcp_client',
          resourceId: createdClient.id,
          toolName: 'mcp_admin.create_client',
          after: this.toPublicClient(createdClient),
          metadata: {
            permissionCount: dto.permissions?.length ?? 0,
          },
        },
        trx,
      );

      return createdClient;
    });

    await this.reconcileVectorSpaces(
      workspaceId,
      (dto.permissions ?? [])
        .filter((permission) => permission.canIndex)
        .map((permission) => permission.spaceId),
      true,
    );

    return {
      token,
      client: this.toPublicClient(client),
      permissions: await this.listClientPermissions(workspaceId, client.id),
    };
  }

  async listClients(workspaceId: string, dto: ListMcpClientsDto) {
    const limit = this.resolveLimit(dto.limit);
    let query = this.db
      .selectFrom('mcpClients')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (dto.status) {
      query = query.where('status', '=', dto.status);
    }

    if (dto.query) {
      query = query.where('name', 'ilike', `%${dto.query}%`);
    }

    const clients = await query.execute();
    const permissionsByClientId = await this.getPermissionsByClientId(
      workspaceId,
      clients.map((client) => client.id),
    );

    return {
      items: clients.map((client) => ({
        ...this.toPublicClient(client),
        permissions: permissionsByClientId.get(client.id) ?? [],
      })),
      meta: {
        limit,
        count: clients.length,
      },
    };
  }

  async getClient(workspaceId: string, clientId: string) {
    const client = await this.findClientOrThrow(workspaceId, clientId);

    return {
      client: this.toPublicClient(client),
      permissions: await this.listClientPermissions(workspaceId, client.id),
    };
  }

  async updateClient(
    workspaceId: string,
    adminUserId: string,
    dto: UpdateMcpClientDto,
  ) {
    const client = await this.findClientOrThrow(workspaceId, dto.clientId);
    const indexSpaceIds = (
      await this.listClientPermissions(workspaceId, client.id)
    )
      .filter((permission) => permission.canIndex)
      .map((permission) => permission.spaceId);
    const patch: UpdatableMcpClient = {};

    if (typeof dto.name !== 'undefined') {
      patch.name = dto.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(dto, 'actorUserId')) {
      await this.assertActiveActorUser(workspaceId, dto.actorUserId ?? null);
      patch.actorUserId = dto.actorUserId ?? null;
    }

    if (Object.prototype.hasOwnProperty.call(dto, 'expiresAt')) {
      patch.expiresAt = dto.expiresAt
        ? this.parseFutureDate(dto.expiresAt, 'expiresAt')
        : null;
    }

    if (dto.status) {
      patch.status = dto.status;
    }

    if (Object.keys(patch).length === 0) {
      return {
        client: this.toPublicClient(client),
        permissions: await this.listClientPermissions(workspaceId, client.id),
      };
    }

    const updatedClient = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mcpClients')
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where('id', '=', client.id)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.auditService.log(
        {
          workspaceId,
          actorUserId: adminUserId,
          clientId: client.id,
          event: 'mcp.client.update',
          resourceType: 'mcp_client',
          resourceId: client.id,
          toolName: 'mcp_admin.update_client',
          before: this.toPublicClient(client),
          after: this.toPublicClient(updated),
        },
        trx,
      );

      return updated;
    });

    if (
      Object.prototype.hasOwnProperty.call(patch, 'actorUserId') ||
      Object.prototype.hasOwnProperty.call(patch, 'status') ||
      Object.prototype.hasOwnProperty.call(patch, 'expiresAt')
    ) {
      await this.reconcileVectorSpaces(
        workspaceId,
        indexSpaceIds,
        updatedClient.status === 'active',
      );
    }

    return {
      client: this.toPublicClient(updatedClient),
      permissions: await this.listClientPermissions(workspaceId, client.id),
    };
  }

  async disableClient(
    workspaceId: string,
    adminUserId: string,
    clientId: string,
  ) {
    return this.updateClient(workspaceId, adminUserId, {
      clientId,
      status: 'disabled',
    });
  }

  async deleteClient(
    workspaceId: string,
    adminUserId: string,
    clientId: string,
  ): Promise<void> {
    const client = await this.findClientOrThrow(workspaceId, clientId);
    const indexSpaceIds = (
      await this.listClientPermissions(workspaceId, client.id)
    )
      .filter((permission) => permission.canIndex)
      .map((permission) => permission.spaceId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('mcpClients')
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', client.id)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      await trx
        .updateTable('mcpClientSpacePermissions')
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where('clientId', '=', client.id)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      await this.auditService.log(
        {
          workspaceId,
          actorUserId: adminUserId,
          clientId: client.id,
          event: 'mcp.client.delete',
          resourceType: 'mcp_client',
          resourceId: client.id,
          toolName: 'mcp_admin.delete_client',
          before: this.toPublicClient(client),
        },
        trx,
      );
    });

    await this.reconcileVectorSpaces(workspaceId, indexSpaceIds, false);
  }

  async rotateClientToken(
    workspaceId: string,
    adminUserId: string,
    clientId: string,
  ) {
    const client = await this.findClientOrThrow(workspaceId, clientId);
    const token = this.tokenService.generateToken();
    const updatedClient = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mcpClients')
        .set({
          tokenHash: this.tokenService.hashToken(token),
          tokenLastFour: this.tokenService.getTokenLastFour(token),
          updatedAt: new Date(),
        })
        .where('id', '=', client.id)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.auditService.log(
        {
          workspaceId,
          actorUserId: adminUserId,
          clientId: client.id,
          event: 'mcp.client.rotate_token',
          resourceType: 'mcp_client',
          resourceId: client.id,
          toolName: 'mcp_admin.rotate_client_token',
          before: this.toPublicClient(client),
          after: this.toPublicClient(updated),
        },
        trx,
      );

      return updated;
    });

    return {
      token,
      client: this.toPublicClient(updatedClient),
      permissions: await this.listClientPermissions(workspaceId, client.id),
    };
  }

  async listAuditLogs(workspaceId: string, dto: ListMcpAuditLogsDto) {
    const limit = this.resolveLimit(dto.limit);
    const from = this.parseOptionalDate(dto.from, 'from');
    const to = this.parseOptionalDate(dto.to, 'to');

    if (from && to && from > to) {
      throw new BadRequestException('from must be earlier than to');
    }

    let query = this.db
      .selectFrom('mcpAuditLogs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (dto.clientId) {
      query = query.where('clientId', '=', dto.clientId);
    }

    if (dto.spaceId) {
      query = query.where('spaceId', '=', dto.spaceId);
    }

    if (dto.event) {
      query = query.where('event', '=', dto.event);
    }

    if (dto.toolName) {
      query = query.where('toolName', '=', dto.toolName);
    }

    if (dto.resourceType) {
      query = query.where('resourceType', '=', dto.resourceType);
    }

    if (dto.resourceId) {
      query = query.where('resourceId', '=', dto.resourceId);
    }

    if (from) {
      query = query.where('createdAt', '>=', from);
    }

    if (to) {
      query = query.where('createdAt', '<=', to);
    }

    if (dto.query) {
      const searchTerm = `%${dto.query}%`;
      query = query.where((eb) =>
        eb.or([
          eb('event', 'ilike', searchTerm),
          eb('toolName', 'ilike', searchTerm),
          eb('resourceType', 'ilike', searchTerm),
          eb('resourceId', 'ilike', searchTerm),
          eb('requestId', 'ilike', searchTerm),
        ]),
      );
    }

    const logs = await query.execute();

    return {
      items: logs.map((log) => this.toPublicAuditLog(log)),
      meta: {
        limit,
        count: logs.length,
      },
    };
  }

  async upsertSpacePermission(
    workspaceId: string,
    adminUserId: string,
    dto: UpsertMcpClientSpacePermissionDto,
  ) {
    await this.findClientOrThrow(workspaceId, dto.clientId);
    await this.assertSpacesExist(workspaceId, [dto.spaceId]);

    const { existing, permission } = await this.db
      .transaction()
      .execute(async (trx) => {
        const current = await trx
          .selectFrom('mcpClientSpacePermissions')
          .selectAll()
          .where('clientId', '=', dto.clientId)
          .where('workspaceId', '=', workspaceId)
          .where('spaceId', '=', dto.spaceId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();

        const updatedPermission = current
          ? await trx
              .updateTable('mcpClientSpacePermissions')
              .set({
                ...this.toPermissionPatch(dto),
                updatedAt: new Date(),
              })
              .where('id', '=', current.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('mcpClientSpacePermissions')
              .values(
                this.toPermissionInsertValues(dto.clientId, workspaceId, dto),
              )
              .returningAll()
              .executeTakeFirstOrThrow();

        await this.auditService.log(
          {
            workspaceId,
            actorUserId: adminUserId,
            clientId: dto.clientId,
            event: 'mcp.permission.upsert',
            resourceType: 'mcp_client_space_permission',
            resourceId: updatedPermission.id,
            spaceId: dto.spaceId,
            toolName: 'mcp_admin.upsert_space_permission',
            before: current ? this.toPublicPermission(current) : null,
            after: this.toPublicPermission(updatedPermission),
          },
          trx,
        );

        return { existing: current, permission: updatedPermission };
      });

    if (existing?.canIndex || permission.canIndex) {
      await this.reconcileVectorSpaces(
        workspaceId,
        [dto.spaceId],
        permission.canIndex,
      );
    }

    return this.toPublicPermission(permission);
  }

  async deleteSpacePermission(
    workspaceId: string,
    adminUserId: string,
    dto: DeleteMcpClientSpacePermissionDto,
  ): Promise<void> {
    await this.findClientOrThrow(workspaceId, dto.clientId);
    const permission = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('mcpClientSpacePermissions')
        .selectAll()
        .where('clientId', '=', dto.clientId)
        .where('workspaceId', '=', workspaceId)
        .where('spaceId', '=', dto.spaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      if (!current) {
        throw new NotFoundException('MCP permission not found');
      }

      await trx
        .updateTable('mcpClientSpacePermissions')
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', current.id)
        .execute();

      await this.auditService.log(
        {
          workspaceId,
          actorUserId: adminUserId,
          clientId: dto.clientId,
          event: 'mcp.permission.delete',
          resourceType: 'mcp_client_space_permission',
          resourceId: current.id,
          spaceId: dto.spaceId,
          toolName: 'mcp_admin.delete_space_permission',
          before: this.toPublicPermission(current),
        },
        trx,
      );

      return current;
    });

    if (permission.canIndex) {
      await this.reconcileVectorSpaces(workspaceId, [dto.spaceId], false);
    }
  }

  private async reconcileVectorSpaces(
    workspaceId: string,
    spaceIds: string[],
    enqueueEligible: boolean,
  ): Promise<void> {
    for (const spaceId of new Set(spaceIds)) {
      try {
        await this.vectorIndexService.reconcileSpaceEligibility({
          workspaceId,
          spaceId,
          enqueueEligible,
        });
      } catch (err) {
        this.logger.error({
          event: 'mcp.vector.reconcile_failed',
          workspaceId,
          spaceId,
          errorType: getMcpErrorType(err),
        });
      }
    }
  }

  private async findClientOrThrow(
    workspaceId: string,
    clientId: string,
  ): Promise<McpClient> {
    const client = await this.db
      .selectFrom('mcpClients')
      .selectAll()
      .where('id', '=', clientId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!client) {
      throw new NotFoundException('MCP client not found');
    }

    return client;
  }

  private async assertActiveActorUser(
    workspaceId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    if (!actorUserId) {
      return;
    }

    const actor = await this.db
      .selectFrom('users')
      .select(['id', 'workspaceId', 'deactivatedAt', 'deletedAt'])
      .where('id', '=', actorUserId)
      .executeTakeFirst();

    if (!actor || actor.workspaceId !== workspaceId || isUserDisabled(actor)) {
      throw new BadRequestException('Invalid MCP actor user');
    }
  }

  private async assertSpacesExist(
    workspaceId: string,
    spaceIds: string[],
  ): Promise<void> {
    const uniqueSpaceIds = [...new Set(spaceIds)];
    if (uniqueSpaceIds.length === 0) {
      return;
    }

    const spaces = await this.db
      .selectFrom('spaces')
      .select(['id'])
      .where('id', 'in', uniqueSpaceIds)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    if (spaces.length !== uniqueSpaceIds.length) {
      throw new NotFoundException('Space not found');
    }
  }

  private assertUniqueSpaceIds(spaceIds: string[]): void {
    const uniqueSpaceIds = new Set(spaceIds);
    if (uniqueSpaceIds.size !== spaceIds.length) {
      throw new BadRequestException('Duplicate MCP space permissions');
    }
  }

  private resolveLimit(limit: number | undefined): number {
    if (!limit) {
      return 20;
    }
    return Math.min(Math.max(limit, 1), 100);
  }

  private async listClientPermissions(
    workspaceId: string,
    clientId: string,
  ): Promise<PublicMcpSpacePermission[]> {
    const permissions = await this.db
      .selectFrom('mcpClientSpacePermissions')
      .selectAll()
      .where('clientId', '=', clientId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();

    return permissions.map((permission) => this.toPublicPermission(permission));
  }

  private async getPermissionsByClientId(
    workspaceId: string,
    clientIds: string[],
  ): Promise<Map<string, PublicMcpSpacePermission[]>> {
    const grouped = new Map<string, PublicMcpSpacePermission[]>();
    if (clientIds.length === 0) {
      return grouped;
    }

    const permissions = await this.db
      .selectFrom('mcpClientSpacePermissions')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('clientId', 'in', clientIds)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();

    for (const permission of permissions) {
      const list = grouped.get(permission.clientId) ?? [];
      list.push(this.toPublicPermission(permission));
      grouped.set(permission.clientId, list);
    }

    return grouped;
  }

  private parseFutureDate(
    value: string | undefined,
    fieldName: string,
  ): Date | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${fieldName} must be a valid date`);
    }

    if (date <= new Date()) {
      throw new BadRequestException(`${fieldName} must be in the future`);
    }

    return date;
  }

  private parseOptionalDate(
    value: string | undefined,
    fieldName: string,
  ): Date | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${fieldName} must be a valid date`);
    }

    return date;
  }

  private toPermissionInsertValues(
    clientId: string,
    workspaceId: string,
    permission: McpSpacePermissionDto,
  ) {
    return {
      clientId,
      workspaceId,
      spaceId: permission.spaceId,
      canSearch: permission.canSearch ?? false,
      canSemanticSearch: permission.canSemanticSearch ?? false,
      canRead: permission.canRead ?? false,
      canCreate: permission.canCreate ?? false,
      canUpdate: permission.canUpdate ?? false,
      canAppend: permission.canAppend ?? false,
      canDelete: permission.canDelete ?? false,
      canRestore: permission.canRestore ?? false,
      canIndex: permission.canIndex ?? false,
    };
  }

  private toPermissionPatch(permission: McpSpacePermissionDto) {
    return MCP_PERMISSION_FIELDS.reduce(
      (patch, field) => {
        const value = permission[field];
        if (typeof value !== 'undefined') {
          patch[field] = value;
        }
        return patch;
      },
      {} as Partial<Record<(typeof MCP_PERMISSION_FIELDS)[number], boolean>>,
    );
  }

  private toPublicClient(client: McpClient): PublicMcpClient {
    return {
      id: client.id,
      workspaceId: client.workspaceId,
      name: client.name,
      status: client.status as McpClientStatus,
      tokenLastFour: client.tokenLastFour,
      actorUserId: client.actorUserId,
      createdById: client.createdById,
      expiresAt: this.toNullableIsoDate(client.expiresAt),
      lastUsedAt: this.toNullableIsoDate(client.lastUsedAt),
      createdAt: this.toIsoDate(client.createdAt),
      updatedAt: this.toIsoDate(client.updatedAt),
    };
  }

  private toPublicPermission(
    permission: McpClientSpacePermission,
  ): PublicMcpSpacePermission {
    return {
      id: permission.id,
      clientId: permission.clientId,
      workspaceId: permission.workspaceId,
      spaceId: permission.spaceId,
      canSearch: permission.canSearch,
      canSemanticSearch: permission.canSemanticSearch,
      canRead: permission.canRead,
      canCreate: permission.canCreate,
      canUpdate: permission.canUpdate,
      canAppend: permission.canAppend,
      canDelete: permission.canDelete,
      canRestore: permission.canRestore,
      canIndex: permission.canIndex,
      createdAt: this.toIsoDate(permission.createdAt),
      updatedAt: this.toIsoDate(permission.updatedAt),
    };
  }

  private toPublicAuditLog(log: McpAuditLog): PublicMcpAuditLog {
    return {
      id: log.id,
      workspaceId: log.workspaceId,
      clientId: log.clientId,
      actorUserId: log.actorUserId,
      event: log.event,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      spaceId: log.spaceId,
      toolName: log.toolName,
      requestId: log.requestId,
      before: log.before,
      after: log.after,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      createdAt: this.toIsoDate(log.createdAt),
    };
  }

  private toNullableIsoDate(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }
    return this.toIsoDate(value);
  }

  private toIsoDate(value: Date | string): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return new Date(value).toISOString();
  }
}
