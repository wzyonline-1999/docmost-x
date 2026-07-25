import type { McpClient } from '@docmost/db/types/entity.types';
import type { Json } from '@docmost/db/types/db';

export type McpPermissionAction =
  | 'search'
  | 'semanticSearch'
  | 'read'
  | 'create'
  | 'update'
  | 'append'
  | 'delete'
  | 'restore'
  | 'index';

export const MCP_PERMISSION_FIELDS = [
  'canSearch',
  'canSemanticSearch',
  'canRead',
  'canCreate',
  'canUpdate',
  'canAppend',
  'canDelete',
  'canRestore',
  'canIndex',
] as const;

export type McpPermissionField = (typeof MCP_PERMISSION_FIELDS)[number];
export type McpPermissionValues = Record<McpPermissionField, boolean>;

export const MCP_PERMISSION_COLUMN: Record<
  McpPermissionAction,
  McpPermissionField
> = {
  search: 'canSearch',
  semanticSearch: 'canSemanticSearch',
  read: 'canRead',
  create: 'canCreate',
  update: 'canUpdate',
  append: 'canAppend',
  delete: 'canDelete',
  restore: 'canRestore',
  index: 'canIndex',
};

export type McpClientStatus = 'active' | 'disabled' | 'expired';
export type McpClientScope = 'personal' | 'workspace';
export type McpActorSpaceRole = 'admin' | 'writer' | 'reader' | null;
export type McpNativeAccessReason =
  | 'actor_unmapped'
  | 'actor_unavailable'
  | 'no_space_access'
  | 'read_only'
  | null;

export type McpClientActorContext = Pick<
  McpClient,
  'actorUserId' | 'workspaceId'
>;

export type McpSpacePermissionCeiling = {
  spaceId: string;
  actorRole: McpActorSpaceRole;
  reason: McpNativeAccessReason;
  permissions: McpPermissionValues;
};

export type McpAdminPrincipal = {
  userId: string;
  isWorkspaceOwner: boolean;
};

export type McpAuthenticatedClient = McpClient & {
  status: McpClientStatus;
};

export type CreateMcpClientInput = {
  workspaceId: string;
  name: string;
  createdById?: string | null;
  ownerUserId?: string | null;
  scope?: McpClientScope;
  actorUserId?: string | null;
  expiresAt?: Date | string | null;
  globalScopes?: Json;
};

export type CreatedMcpClient = {
  client: McpClient;
  token: string;
};

export type McpAuditLogInput = {
  workspaceId: string;
  clientId?: string | null;
  actorUserId?: string | null;
  event: string;
  resourceType: string;
  resourceId?: string | null;
  spaceId?: string | null;
  toolName: string;
  requestId?: string | null;
  before?: Json | null;
  after?: Json | null;
  metadata?: Json | null;
  ipAddress?: string | null;
};
