import api from "@/lib/api-client";
import {
  IMcpAuditFilters,
  IMcpAuditLogList,
  IMcpClientInput,
  IMcpClientList,
  IMcpClientTokenResponse,
  IMcpPermissionMatrix,
  IMcpPermissionBatchResult,
  IMcpSpacePermission,
  McpClientStatus,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";

export async function getMcpClients(params?: {
  query?: string;
  status?: McpClientStatus;
  limit?: number;
  cursor?: string;
  beforeCursor?: string;
}): Promise<IMcpClientList> {
  const response = await api.post<IMcpClientList>("/mcp/admin/clients", params);
  return response.data;
}

export async function createMcpClient(
  input: IMcpClientInput,
): Promise<IMcpClientTokenResponse> {
  const response = await api.post<IMcpClientTokenResponse>(
    "/mcp/admin/clients/create",
    input,
  );
  return response.data;
}

export async function updateMcpClient(
  input: IMcpClientInput & { clientId: string; status?: McpClientStatus },
): Promise<void> {
  await api.post("/mcp/admin/clients/update", input);
}

export async function disableMcpClient(clientId: string): Promise<void> {
  await api.post("/mcp/admin/clients/disable", { clientId });
}

export async function deleteMcpClient(clientId: string): Promise<void> {
  await api.post("/mcp/admin/clients/delete", { clientId });
}

export async function rotateMcpClientToken(
  clientId: string,
): Promise<IMcpClientTokenResponse> {
  const response = await api.post<IMcpClientTokenResponse>(
    "/mcp/admin/clients/rotate-token",
    { clientId },
  );
  return response.data;
}

export async function upsertMcpPermission(
  permission: McpSpacePermissionInput,
): Promise<IMcpSpacePermission> {
  const response = await api.post<IMcpSpacePermission>(
    "/mcp/admin/clients/permissions/upsert",
    permission,
  );
  return response.data;
}

export async function bulkUpsertMcpPermissions(
  permissions: McpSpacePermissionInput[],
): Promise<IMcpPermissionBatchResult> {
  const first = permissions[0];
  if (!first) {
    throw new Error("Permission batch cannot be empty");
  }
  if (
    permissions.some((permission) => permission.clientId !== first.clientId)
  ) {
    throw new Error("Permission batch must target one access client");
  }

  const response = await api.post<IMcpPermissionBatchResult>(
    "/mcp/admin/clients/permissions/bulk-upsert",
    {
      clientId: first.clientId,
      permissions: permissions.map(
        ({ clientId: _clientId, ...permission }) => permission,
      ),
    },
  );
  return response.data;
}

export async function getMcpPermissionMatrix(input: {
  clientId: string;
  spaceIds: string[];
}): Promise<IMcpPermissionMatrix> {
  const response = await api.post<IMcpPermissionMatrix>(
    "/mcp/admin/clients/permissions/matrix",
    input,
  );
  return response.data;
}

export async function deleteMcpPermission(input: {
  clientId: string;
  spaceId: string;
  expectedUpdatedAt?: string | null;
}): Promise<void> {
  await api.post("/mcp/admin/clients/permissions/delete", input);
}

export async function getMcpAuditLogs(
  filters?: IMcpAuditFilters,
): Promise<IMcpAuditLogList> {
  const response = await api.post<IMcpAuditLogList>(
    "/mcp/admin/audit-logs",
    filters,
  );
  return response.data;
}
