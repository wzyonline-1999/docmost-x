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
  useMcpClientsQuery,
  useUpsertMcpPermissionMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpSpacePermission,
  McpPermissionField,
} from "@/features/mcp/types/mcp.types";
import NoTableResults from "@/components/common/no-table-results";
import classes from "./mcp-settings.module.css";

const permissionColumns: Array<{
  field: McpPermissionField;
  label: string;
}> = [
  { field: "canSearch", label: "Search" },
  { field: "canSemanticSearch", label: "Semantic" },
  { field: "canRead", label: "Read" },
  { field: "canCreate", label: "Create" },
  { field: "canUpdate", label: "Update" },
  { field: "canAppend", label: "Append" },
  { field: "canDelete", label: "Delete" },
  { field: "canRestore", label: "Restore" },
  { field: "canIndex", label: "Index" },
];

export function McpPermissions() {
  const clientsQuery = useMcpClientsQuery({ limit: 100 });
  const spacesQuery = useGetSpacesQuery({ limit: 100 });
  const upsertMutation = useUpsertMcpPermissionMutation();
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

  const togglePermission = (
    spaceId: string,
    field: McpPermissionField,
    checked: boolean,
  ) => {
    if (!selectedClientId) return;
    const current = permissionBySpace.get(spaceId);
    const values = permissionColumns.reduce(
      (result, column) => {
        result[column.field] = current?.[column.field] ?? false;
        return result;
      },
      {} as Record<McpPermissionField, boolean>,
    );
    values[field] = checked;
    upsertMutation.mutate({ clientId: selectedClientId, spaceId, ...values });
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

      <Table.ScrollContainer minWidth={1080}>
        <Table verticalSpacing="sm" highlightOnHover layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={220}>Space</Table.Th>
              {permissionColumns.map((column) => (
                <Table.Th key={column.field} ta="center" w={88}>
                  {column.label}
                </Table.Th>
              ))}
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
                    {permissionColumns.map((column) => (
                      <Table.Td key={column.field} ta="center">
                        <Checkbox
                          aria-label={`${column.label} permission for ${space.name}`}
                          checked={permission?.[column.field] ?? false}
                          disabled={
                            !selectedClientId || upsertMutation.isPending
                          }
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
