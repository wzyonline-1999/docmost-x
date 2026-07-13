import {
  ActionIcon,
  Alert,
  Checkbox,
  Loader,
  Select,
  Table,
  Text,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { IconInfoCircle, IconTrash } from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useMemo, useState } from "react";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import {
  useDeleteMcpPermissionMutation,
  useBulkUpsertMcpPermissionsMutation,
  useMcpClientsQuery,
  useUpsertMcpPermissionMutation,
} from "@/features/mcp/queries/mcp-query";
import { IMcpSpacePermission } from "@/features/mcp/types/mcp.types";
import {
  buildPermissionUpdates,
  getPermissionSelectionState,
  getPermissionValues,
  MCP_PERMISSION_COLUMNS,
  McpPermissionValues,
} from "@/features/mcp/utils/mcp-permission-utils";
import NoTableResults from "@/components/common/no-table-results";
import classes from "./mcp-settings.module.css";

export function McpPermissions() {
  const clientsQuery = useMcpClientsQuery({ limit: 100 });
  const spacesQuery = useGetSpacesQuery({ limit: 100 });
  const upsertMutation = useUpsertMcpPermissionMutation();
  const bulkUpsertMutation = useBulkUpsertMcpPermissionsMutation();
  const deleteMutation = useDeleteMcpPermissionMutation();
  const [clientId, setClientId] = useState<string | null>(null);
  const selectedClientId = clientId ?? clientsQuery.data?.items[0]?.id ?? null;
  const client = clientsQuery.data?.items.find(
    (item) => item.id === selectedClientId,
  );
  const permissionBySpace = useMemo(
    () =>
      new Map(
        client?.permissions.map((permission) => [
          permission.spaceId,
          permission,
        ]) ?? [],
      ),
    [client],
  );
  const clientOptions =
    clientsQuery.data?.items.map((item) => ({
      value: item.id,
      label: item.name,
    })) ?? [];
  const spaces = spacesQuery.data?.items ?? [];
  const isMutating = upsertMutation.isPending || bulkUpsertMutation.isPending;
  const allSelection = getPermissionSelectionState(
    spaces.flatMap((space) => {
      const permission = permissionBySpace.get(space.id);
      return MCP_PERMISSION_COLUMNS.map(
        (column) => permission?.[column.field] ?? false,
      );
    }),
  );
  const columnSelection = new Map(
    MCP_PERMISSION_COLUMNS.map((column) => [
      column.field,
      getPermissionSelectionState(
        spaces.map(
          (space) => permissionBySpace.get(space.id)?.[column.field] ?? false,
        ),
      ),
    ]),
  );

  const togglePermission = (
    spaceId: string,
    field: keyof McpPermissionValues,
    checked: boolean,
  ) => {
    if (!selectedClientId) return;
    const current = permissionBySpace.get(spaceId);
    const values = getPermissionValues(current);
    values[field] = checked;
    upsertMutation.mutate({ clientId: selectedClientId, spaceId, ...values });
  };

  const setPermissions = (changes: Partial<McpPermissionValues>) => {
    if (!selectedClientId) return;
    const updates = buildPermissionUpdates(
      selectedClientId,
      spaces.map((space) => ({
        id: space.id,
        permission: permissionBySpace.get(space.id),
      })),
      changes,
    );

    if (updates.length) bulkUpsertMutation.mutate(updates);
  };

  const toggleAllPermissions = (checked: boolean) => {
    setPermissions(
      MCP_PERMISSION_COLUMNS.reduce((result, column) => {
        result[column.field] = checked;
        return result;
      }, {} as McpPermissionValues),
    );
  };

  const confirmRemove = (
    permission: IMcpSpacePermission,
    spaceName: string,
  ) => {
    modals.openConfirmModal({
      title: "Remove space permission",
      children: (
        <Text size="sm">
          Remove all MCP access to <strong>{spaceName}</strong> for this client?
        </Text>
      ),
      labels: { confirm: "Remove", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        deleteMutation.mutate({
          clientId: permission.clientId,
          spaceId: permission.spaceId,
        }),
    });
  };

  if (!clientsQuery.isLoading && !clientsQuery.data?.items.length) {
    return (
      <Alert icon={<IconInfoCircle size={18} />} color="blue" mt="md">
        Create an MCP client before assigning space permissions.
      </Alert>
    );
  }

  return (
    <>
      <div className={classes.toolbar}>
        <Select
          label="Client"
          placeholder="Select a client"
          data={clientOptions}
          value={selectedClientId}
          onChange={(value) =>
            setClientId(typeof value === "string" ? value : null)
          }
          searchable
          allowDeselect={false}
          w={{ base: "100%", sm: 360 }}
        />
        <Text size="xs" c="dimmed">
          Changes are applied immediately and re-evaluated against the actor's
          native page access.
        </Text>
      </div>

      <Table.ScrollContainer minWidth={1080} type="native">
        <Table verticalSpacing="sm" highlightOnHover layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={220}>
                <div className={classes.permissionHeader}>
                  <Tooltip label="Select or clear all permissions">
                    <Checkbox
                      aria-label="Select or clear all permissions"
                      checked={allSelection.checked}
                      indeterminate={allSelection.indeterminate}
                      disabled={
                        !selectedClientId || !spaces.length || isMutating
                      }
                      onChange={(event) =>
                        toggleAllPermissions(event.currentTarget.checked)
                      }
                    />
                  </Tooltip>
                  <span>Space</span>
                </div>
              </Table.Th>
              {MCP_PERMISSION_COLUMNS.map((column) => {
                const selection = columnSelection.get(column.field);
                return (
                  <Table.Th key={column.field} ta="center" w={88}>
                    <div className={classes.permissionColumnHeader}>
                      <span>{column.label}</span>
                      <Tooltip
                        label={`Select or clear all ${column.label} permissions`}
                      >
                        <Checkbox
                          aria-label={`Select or clear all ${column.label} permissions`}
                          checked={selection?.checked ?? false}
                          indeterminate={selection?.indeterminate ?? false}
                          disabled={
                            !selectedClientId || !spaces.length || isMutating
                          }
                          onChange={(event) =>
                            setPermissions({
                              [column.field]: event.currentTarget.checked,
                            })
                          }
                        />
                      </Tooltip>
                    </div>
                  </Table.Th>
                );
              })}
              <Table.Th w={56}>
                <VisuallyHidden>Actions</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {spacesQuery.isLoading || clientsQuery.isLoading ? (
              <Table.Tr>
                <Table.Td colSpan={11} ta="center" py="xl">
                  <Loader size="sm" />
                </Table.Td>
              </Table.Tr>
            ) : spacesQuery.data?.items.length ? (
              spacesQuery.data.items.map((space) => {
                const permission = permissionBySpace.get(space.id);
                return (
                  <Table.Tr key={space.id}>
                    <Table.Td>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {space.name}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {space.slug}
                      </Text>
                    </Table.Td>
                    {MCP_PERMISSION_COLUMNS.map((column) => (
                      <Table.Td key={column.field} ta="center">
                        <Checkbox
                          aria-label={`${column.label} permission for ${space.name}`}
                          checked={permission?.[column.field] ?? false}
                          disabled={!selectedClientId || isMutating}
                          onChange={(event) =>
                            togglePermission(
                              space.id,
                              column.field,
                              event.currentTarget.checked,
                            )
                          }
                        />
                      </Table.Td>
                    ))}
                    <Table.Td>
                      {permission && (
                        <Tooltip label="Remove all permissions">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={`Remove all permissions for ${space.name}`}
                            onClick={() =>
                              confirmRemove(permission, space.name)
                            }
                          >
                            <IconTrash size={17} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })
            ) : (
              <NoTableResults colSpan={11} />
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </>
  );
}
