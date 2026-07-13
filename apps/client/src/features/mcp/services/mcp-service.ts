import api from "@/lib/api-client";
import {
  IMcpAuditFilters,
  IMcpAuditLogList,
  IMcpClientInput,
  IMcpClientList,
  IMcpClientTokenResponse,
  IMcpSpacePermission,
  McpClientStatus,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";

export async function getMcpClients(params?: {
  query?: string;
  status?: McpClientStatus;
  limit?: number;
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

export async function deleteMcpPermission(input: {
  clientId: string;
  spaceId: string;
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
