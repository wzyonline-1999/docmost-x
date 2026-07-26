import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  bulkUpsertMcpPermissions,
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
  McpClientStatus,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";

const showMutationError = (error: Error) => {
  const message = error?.["response"]?.data?.message ?? error.message;
  notifications.show({ message, color: "red" });
};

const getMutationStatus = (error: Error): number | undefined =>
  error?.["response"]?.status;

export function useMcpClientsQuery(params?: {
  query?: string;
  status?: McpClientStatus;
  limit?: number;
  cursor?: string;
  beforeCursor?: string;
}) {
  return useQuery({
    queryKey: ["mcp-clients", params],
    queryFn: () => getMcpClients(params),
    placeholderData: keepPreviousData,
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IMcpClientInput) => createMcpClient(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: t("MCP client created") });
    },
    onError: showMutationError,
  });
}

export function useUpdateMcpClientMutation() {
  const { t } = useTranslation();
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
      notifications.show({ message: t("MCP client updated") });
    },
    onError: showMutationError,
  });
}

export function useDisableMcpClientMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disableMcpClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: t("MCP client disabled") });
    },
    onError: showMutationError,
  });
}

export function useDeleteMcpClientMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteMcpClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: t("MCP client deleted") });
    },
    onError: showMutationError,
  });
}

export function useRotateMcpClientTokenMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rotateMcpClientToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      notifications.show({ message: t("MCP token rotated") });
    },
    onError: showMutationError,
  });
}

export function useUpsertMcpPermissionMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (permission: McpSpacePermissionInput) =>
      upsertMcpPermission(permission),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
    },
    onError: (error) => {
      if (getMutationStatus(error) === 409) {
        notifications.show({
          title: t("Permission conflict"),
          message: t(
            "These permissions changed in another session. The latest values have been reloaded; review them and try again.",
          ),
          color: "orange",
        });
        queryClient.invalidateQueries({
          queryKey: ["mcp-permission-matrix"],
        });
        return;
      }
      showMutationError(error);
    },
  });
}

export function useBulkUpsertMcpPermissionsMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (permissions: McpSpacePermissionInput[]) =>
      bulkUpsertMcpPermissions(permissions),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
    },
    onError: (error) => {
      if (getMutationStatus(error) === 409) {
        notifications.show({
          title: t("Permission conflict"),
          message: t(
            "These permissions changed in another session. The latest values have been reloaded; review them and try again.",
          ),
          color: "orange",
        });
        return;
      }
      showMutationError(error);
    },
  });
}

export function useDeleteMcpPermissionMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteMcpPermission,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-clients"] });
      queryClient.invalidateQueries({
        queryKey: ["mcp-permission-matrix"],
      });
      notifications.show({ message: t("Space permission removed") });
    },
    onError: (error) => {
      if (getMutationStatus(error) === 409) {
        notifications.show({
          title: t("Permission conflict"),
          message: t(
            "These permissions changed in another session. The latest values have been reloaded; review them and try again.",
          ),
          color: "orange",
        });
        queryClient.invalidateQueries({
          queryKey: ["mcp-permission-matrix"],
        });
        return;
      }
      showMutationError(error);
    },
  });
}

export function useMcpAuditLogsQuery(filters?: IMcpAuditFilters) {
  return useQuery({
    queryKey: ["mcp-audit-logs", filters],
    queryFn: () => getMcpAuditLogs(filters),
    placeholderData: keepPreviousData,
  });
}
