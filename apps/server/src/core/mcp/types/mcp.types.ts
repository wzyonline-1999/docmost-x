import type {
  McpClient,
  McpClientSpacePermission,
} from '@docmost/db/types/entity.types';
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

export const MCP_PERMISSION_COLUMN: Record<
  McpPermissionAction,
  keyof McpClientSpacePermission
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

export type McpAuthenticatedClient = McpClient & {
  status: McpClientStatus;
};

export type CreateMcpClientInput = {
  workspaceId: string;
  name: string;
  createdById?: string | null;
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
