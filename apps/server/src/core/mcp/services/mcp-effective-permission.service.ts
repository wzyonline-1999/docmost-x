import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import type { User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers';
import { SpaceRole } from '../../../common/helpers/types/permission';
import {
  MCP_PERMISSION_COLUMN,
  MCP_PERMISSION_FIELDS,
  McpActorSpaceRole,
  McpClientActorContext,
  McpNativeAccessReason,
  McpPermissionAction,
  McpPermissionField,
  McpPermissionValues,
  McpSpacePermissionCeiling,
} from '../types/mcp.types';

export type McpActorResolution = {
  actor: User | null;
  reason: Extract<
    McpNativeAccessReason,
    'actor_unmapped' | 'actor_unavailable' | null
  >;
};

const EMPTY_PERMISSION_VALUES: McpPermissionValues = {
  canSearch: false,
  canSemanticSearch: false,
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canAppend: false,
  canDelete: false,
  canRestore: false,
  canIndex: false,
};

const READER_PERMISSION_VALUES: McpPermissionValues = {
  ...EMPTY_PERMISSION_VALUES,
  canSearch: true,
  canSemanticSearch: true,
  canRead: true,
  canIndex: true,
};

const WRITER_PERMISSION_VALUES: McpPermissionValues =
  MCP_PERMISSION_FIELDS.reduce((values, field) => {
    values[field] = true;
    return values;
  }, {} as McpPermissionValues);

@Injectable()
export class McpEffectivePermissionService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async resolveActor(
    client: McpClientActorContext,
  ): Promise<McpActorResolution> {
    if (!client.actorUserId) {
      return { actor: null, reason: 'actor_unmapped' };
    }

    const actor = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', client.actorUserId)
      .where('workspaceId', '=', client.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!actor || isUserDisabled(actor)) {
      return { actor: null, reason: 'actor_unavailable' };
    }

    return { actor, reason: null };
  }

  async requireActor(client: McpClientActorContext): Promise<User> {
    const resolution = await this.resolveActor(client);
    if (resolution.actor) {
      return resolution.actor;
    }

    if (resolution.reason === 'actor_unmapped') {
      throw new ForbiddenException(
        'MCP page tools require an actor user mapping',
      );
    }

    throw new ForbiddenException('MCP actor user is unavailable');
  }

  async getClientSpaceCeilings(
    client: McpClientActorContext,
    spaceIds: string[],
  ): Promise<{
    actorAvailable: boolean;
    actorReason: McpActorResolution['reason'];
    spaces: McpSpacePermissionCeiling[];
  }> {
    const uniqueSpaceIds = [...new Set(spaceIds)];
    const resolution = await this.resolveActor(client);

    if (!resolution.actor) {
      return {
        actorAvailable: false,
        actorReason: resolution.reason,
        spaces: uniqueSpaceIds.map((spaceId) => ({
          spaceId,
          actorRole: null,
          reason: resolution.reason,
          permissions: this.emptyPermissions(),
        })),
      };
    }

    return {
      actorAvailable: true,
      actorReason: null,
      spaces: await this.getActorSpaceCeilings(
        resolution.actor,
        uniqueSpaceIds,
      ),
    };
  }

  async getActorSpaceCeilings(
    actor: User,
    spaceIds: string[],
  ): Promise<McpSpacePermissionCeiling[]> {
    const uniqueSpaceIds = [...new Set(spaceIds)];
    if (uniqueSpaceIds.length === 0) {
      return [];
    }

    const roles = await this.spaceMemberRepo.getUserRolesForSpaces(
      actor.id,
      uniqueSpaceIds,
    );
    const rolesBySpaceId = new Map<string, string[]>();
    for (const row of roles) {
      const values = rolesBySpaceId.get(row.spaceId) ?? [];
      values.push(row.role);
      rolesBySpaceId.set(row.spaceId, values);
    }

    return uniqueSpaceIds.map((spaceId) => {
      const spaceRoles = rolesBySpaceId.get(spaceId) ?? [];
      const actorRole = findHighestUserSpaceRole(
        spaceRoles.map((role) => ({ userId: actor.id, role })),
      ) as McpActorSpaceRole;

      return this.toCeiling(spaceId, actorRole ?? null);
    });
  }

  async assertActorAction(
    actor: User,
    action: McpPermissionAction,
    spaceId: string,
  ): Promise<void> {
    const [ceiling] = await this.getActorSpaceCeilings(actor, [spaceId]);
    if (!ceiling?.permissions[MCP_PERMISSION_COLUMN[action]]) {
      const suffix = action === 'create' ? 'create access' : 'space access';
      throw new ForbiddenException(`MCP actor lacks Docmost ${suffix}`);
    }
  }

  async filterActorSpaceIds(
    actor: User,
    action: McpPermissionAction,
    spaceIds: string[],
  ): Promise<string[]> {
    const ceilings = await this.getActorSpaceCeilings(actor, spaceIds);
    const field = MCP_PERMISSION_COLUMN[action];
    return ceilings
      .filter((ceiling) => ceiling.permissions[field])
      .map((ceiling) => ceiling.spaceId);
  }

  async isClientActionAllowed(
    client: McpClientActorContext,
    action: McpPermissionAction,
    spaceId: string,
  ): Promise<boolean> {
    const result = await this.getClientSpaceCeilings(client, [spaceId]);
    return Boolean(
      result.spaces[0]?.permissions[MCP_PERMISSION_COLUMN[action]],
    );
  }

  async filterClientSpaceIds(
    client: McpClientActorContext,
    action: McpPermissionAction,
    spaceIds: string[],
  ): Promise<string[]> {
    const result = await this.getClientSpaceCeilings(client, spaceIds);
    const field = MCP_PERMISSION_COLUMN[action];
    return result.spaces
      .filter((ceiling) => ceiling.permissions[field])
      .map((ceiling) => ceiling.spaceId);
  }

  assertPermissionPatchAllowed(
    ceiling: McpPermissionValues,
    patch: Partial<Record<McpPermissionField, boolean>>,
    current?: Partial<Record<McpPermissionField, boolean>>,
  ): void {
    const deniedFields = MCP_PERMISSION_FIELDS.filter(
      (field) =>
        patch[field] === true &&
        current?.[field] !== true &&
        ceiling[field] !== true,
    );

    if (deniedFields.length > 0) {
      throw new ForbiddenException(
        `MCP actor native permissions do not allow: ${deniedFields.join(', ')}`,
      );
    }
  }

  intersectPermissions(
    configured: Partial<Record<McpPermissionField, boolean>>,
    ceiling: McpPermissionValues,
  ): McpPermissionValues {
    return MCP_PERMISSION_FIELDS.reduce((values, field) => {
      values[field] = configured[field] === true && ceiling[field] === true;
      return values;
    }, {} as McpPermissionValues);
  }

  emptyPermissions(): McpPermissionValues {
    return { ...EMPTY_PERMISSION_VALUES };
  }

  private toCeiling(
    spaceId: string,
    actorRole: McpActorSpaceRole,
  ): McpSpacePermissionCeiling {
    if (actorRole === SpaceRole.ADMIN || actorRole === SpaceRole.WRITER) {
      return {
        spaceId,
        actorRole,
        reason: null,
        permissions: { ...WRITER_PERMISSION_VALUES },
      };
    }

    if (actorRole === SpaceRole.READER) {
      return {
        spaceId,
        actorRole,
        reason: 'read_only',
        permissions: { ...READER_PERMISSION_VALUES },
      };
    }

    return {
      spaceId,
      actorRole: null,
      reason: 'no_space_access',
      permissions: this.emptyPermissions(),
    };
  }
}
