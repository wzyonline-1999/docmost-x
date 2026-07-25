import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  createMcpClient,
  deleteMcpClient,
  deleteMcpPermission,
  disableMcpClient,
  getMcpAuditLogs,
  getMcpClients,
  getMcpPermissionMatrix,
  rotateMcpClientToken,
  updateMcpClient,
  upsertMcpPermission,
} from "@/features/mcp/services/mcp-service";
import {
  IMcpAuditFilters,
  IMcpClientInput,
  IMcpSpacePermission,
  McpClientStatus,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";

const showMutationError = (error: Error) => {
  const message = error?.["response"]?.data?.message ?? error.message;
  notifications.show({ message, color: "red" });
};

export function useMcpClientsQuery(params?: {
  query?: string;
  status?: McpClientStatus;
  limit?: number;
}) {
  return useQuery({
    queryKey: ["mcp-clients", params],
    queryFn: () => getMcpClients(params),
  });
}

export function useMcpPermissionMatrixQuery(
  clientId: string | null,
  spaceIds: string[],
) {
  return useQuery({
    queryKey: ["mcp-permission-matrix", clientId, spaceIds],
    queryFn: () =>
      getMcpPermissionMatrix({
        clientId: clientId as string,
        spaceIds,
      }),
    enabled: Boolean(clientId) && spaceIds.length > 0,
  });
}

export function useCreateMcpClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IMcpClientInput) => createMcpClient(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: "MCP client created" });
    },
    onError: showMutationError,
  });
}

export function useUpdateMcpClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      input: IMcpClientInput & {
        clientId: string;
        status?: McpClientStatus;
      },
    ) => updateMcpClient(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
      notifications.show({ message: "MCP client updated" });
    },
    onError: showMutationError,
  });
}

export function useDisableMcpClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disableMcpClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: "MCP client disabled" });
    },
    onError: showMutationError,
  });
}

export function useDeleteMcpClientMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteMcpClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: "MCP client deleted" });
    },
    onError: showMutationError,
  });
}

export function useRotateMcpClientTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rotateMcpClientToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: "MCP token rotated" });
    },
    onError: showMutationError,
  });
}

export function useUpsertMcpPermissionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      permission: Partial<IMcpSpacePermission> & {
        clientId: string;
        spaceId: string;
      },
    ) => upsertMcpPermission(permission),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
    },
    onError: showMutationError,
  });
}

export function useBulkUpsertMcpPermissionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (permissions: McpSpacePermissionInput[]) => {
      const results = await Promise.allSettled(
        permissions.map(upsertMcpPermission),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failure) throw failure.reason;
      return results.map((result) =>
        result.status === "fulfilled" ? result.value : undefined,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
    },
    onError: showMutationError,
  });
}

export function useDeleteMcpPermissionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteMcpPermission,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
      notifications.show({ message: "Space permission removed" });
    },
    onError: showMutationError,
  });
}

export function useMcpAuditLogsQuery(filters?: IMcpAuditFilters) {
  return useQuery({
    queryKey: ["mcp-audit-logs", filters],
    queryFn: () => getMcpAuditLogs(filters),
  });
}
