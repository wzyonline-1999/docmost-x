import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { McpClientSpacePermission } from '@docmost/db/types/entity.types';
import {
  MCP_PERMISSION_COLUMN,
  McpAuthenticatedClient,
  McpPermissionAction,
} from '../types/mcp.types';

export type McpPageTarget = {
  id: string;
  workspaceId: string;
  spaceId: string;
  deletedAt: Date | null;
};

@Injectable()
export class McpPermissionService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getSpacePermission(
    client: McpAuthenticatedClient,
    spaceId: string,
  ): Promise<McpClientSpacePermission | undefined> {
    return this.db
      .selectFrom('mcpClientSpacePermissions')
      .selectAll()
      .where('clientId', '=', client.id)
      .where('workspaceId', '=', client.workspaceId)
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async hasSpacePermission(
    client: McpAuthenticatedClient,
    action: McpPermissionAction,
    spaceId: string,
  ): Promise<boolean> {
    const permission = await this.getSpacePermission(client, spaceId);
    if (!permission) {
      return false;
    }

    return Boolean(permission[MCP_PERMISSION_COLUMN[action]]);
  }

  async assertSpacePermission(
    client: McpAuthenticatedClient,
    action: McpPermissionAction,
    spaceId: string,
  ): Promise<McpClientSpacePermission> {
    const permission = await this.getSpacePermission(client, spaceId);
    if (!permission || !permission[MCP_PERMISSION_COLUMN[action]]) {
      throw new ForbiddenException('MCP permission denied');
    }

    return permission;
  }

  async getAllowedSpaceIds(
    client: McpAuthenticatedClient,
    action: McpPermissionAction,
    requestedSpaceIds?: string[],
  ): Promise<string[]> {
    const permissionColumn = MCP_PERMISSION_COLUMN[action];
    let query = this.db
      .selectFrom('mcpClientSpacePermissions')
      .select(['spaceId'])
      .where('clientId', '=', client.id)
      .where('workspaceId', '=', client.workspaceId)
      .where('deletedAt', 'is', null)
      .where(permissionColumn, '=', true);

    if (requestedSpaceIds?.length) {
      query = query.where('spaceId', 'in', requestedSpaceIds);
    }

    const rows = await query.execute();
    return rows.map((row) => row.spaceId);
  }

  async resolvePageTarget(
    client: McpAuthenticatedClient,
    pageId: string,
    opts?: {
      includeDeleted?: boolean;
    },
  ): Promise<McpPageTarget> {
    const page = await this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', 'spaceId', 'deletedAt'])
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!page || page.workspaceId !== client.workspaceId) {
      throw new NotFoundException('Page not found');
    }

    if (page.deletedAt && !opts?.includeDeleted) {
      throw new NotFoundException('Page not found');
    }

    return page;
  }

  async assertPagePermission(
    client: McpAuthenticatedClient,
    action: McpPermissionAction,
    pageId: string,
    opts?: {
      includeDeleted?: boolean;
      maskPermissionDeniedAsNotFound?: boolean;
    },
  ): Promise<McpPageTarget> {
    const page = await this.resolvePageTarget(client, pageId, opts);

    try {
      await this.assertSpacePermission(client, action, page.spaceId);
    } catch (err) {
      if (
        opts?.maskPermissionDeniedAsNotFound &&
        err instanceof ForbiddenException
      ) {
        throw new NotFoundException('Page not found');
      }
      throw err;
    }

    return page;
  }
}
