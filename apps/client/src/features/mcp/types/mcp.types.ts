export type McpClientStatus = "active" | "disabled" | "expired";
export type McpClientScope = "personal" | "workspace";

export type McpPermissionField =
  | "canSearch"
  | "canSemanticSearch"
  | "canRead"
  | "canCreate"
  | "canUpdate"
  | "canAppend"
  | "canDelete"
  | "canRestore"
  | "canIndex";

export interface IMcpSpacePermission {
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
}

export type McpSpacePermissionInput = {
  clientId: string;
  spaceId: string;
} & Partial<Record<McpPermissionField, boolean>>;

export interface IMcpClient {
  id: string;
  workspaceId: string;
  name: string;
  status: McpClientStatus;
  tokenLastFour: string;
  actorUserId: string | null;
  createdById: string | null;
  ownerUserId: string | null;
  scope: McpClientScope;
  capabilities: {
    canEdit: boolean;
    canRotateToken: boolean;
    canDisable: boolean;
    canDelete: boolean;
    canManagePermissions: boolean;
  };
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: IMcpSpacePermission[];
}

export interface IMcpClientList {
  items: IMcpClient[];
  meta: { limit: number; count: number };
}

export interface IMcpClientTokenResponse {
  token: string;
  client: IMcpClient;
  permissions: IMcpSpacePermission[];
}

export interface IMcpClientInput {
  name: string;
  scope?: McpClientScope;
  actorUserId?: string | null;
  expiresAt?: string | null;
  permissions?: Partial<IMcpSpacePermission>[];
}

export interface IMcpAuditLog {
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
}

export interface IMcpAuditLogList {
  items: IMcpAuditLog[];
  meta: { limit: number; count: number };
}

export interface IMcpAuditFilters {
  clientId?: string;
  spaceId?: string;
  event?: string;
  toolName?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
}
