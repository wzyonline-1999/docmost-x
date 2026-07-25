import {
  ActionIcon,
  Alert,
  Badge,
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
  useMcpPermissionMatrixQuery,
  useUpsertMcpPermissionMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpPermissionMatrixSpace,
  IMcpSpacePermission,
  McpNativeAccessReason,
  McpPermissionField,
  McpPermissionValues,
} from "@/features/mcp/types/mcp.types";
import {
  buildPermissionUpdates,
  getPermissionSelectionState,
  MCP_PERMISSION_COLUMNS,
} from "@/features/mcp/utils/mcp-permission-utils";
import NoTableResults from "@/components/common/no-table-results";
import classes from "./mcp-settings.module.css";

function getNativeAccessDisplay(
  row: IMcpPermissionMatrixSpace | undefined,
  actorReason: McpNativeAccessReason | undefined,
) {
  if (row?.actorRole) {
    return {
      label: `Actor: ${row.actorRole[0].toUpperCase()}${row.actorRole.slice(1)}`,
      color: row.actorRole === "reader" ? "blue" : "green",
    };
  }

  const reason = row?.reason ?? actorReason;
  const labels: Record<
    Exclude<McpNativeAccessReason, "read_only" | null>,
    string
  > = {
    actor_unmapped: "No actor mapping",
    actor_unavailable: "Actor unavailable",
    no_space_access: "No space access",
  };

  return {
    label:
      reason && reason !== "read_only"
        ? labels[reason]
        : "Native access unavailable",
    color: "red",
  };
}

function getUnavailablePermissionLabel(
  row: IMcpPermissionMatrixSpace | undefined,
) {
  if (row?.reason === "read_only") {
    return "The actor's read-only role does not allow this permission";
  }
  if (row?.reason === "no_space_access") {
    return "The actor no longer has access to this space";
  }
  if (row?.reason === "actor_unmapped") {
    return "This client has no actor mapping";
  }
  if (row?.reason === "actor_unavailable") {
    return "The mapped actor is unavailable";
  }
  return "This permission is outside the actor's current native access";
}

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
  const spaces = useMemo(
    () => spacesQuery.data?.items ?? [],
    [spacesQuery.data?.items],
  );
  const spaceIds = useMemo(() => spaces.map((space) => space.id), [spaces]);
  const matrixQuery = useMcpPermissionMatrixQuery(selectedClientId, spaceIds);
  const canManagePermissions =
    client?.capabilities.canManagePermissions ?? false;
  const matrixBySpace = useMemo(
    () =>
      new Map(
        matrixQuery.data?.spaces.map((space) => [space.spaceId, space]) ?? [],
      ),
    [matrixQuery.data],
  );
  const clientOptions =
    clientsQuery.data?.items.map((item) => ({
      value: item.id,
      label: item.name,
    })) ?? [];
  const isMutating = upsertMutation.isPending || bulkUpsertMutation.isPending;
  const eligiblePermissionValues = spaces.flatMap((space) => {
    const row = matrixBySpace.get(space.id);
    return MCP_PERMISSION_COLUMNS.flatMap((column) =>
      row?.ceiling[column.field] ? [row.configured[column.field]] : [],
    );
  });
  const allSelection = getPermissionSelectionState(eligiblePermissionValues);
  const columnSelection = new Map(
    MCP_PERMISSION_COLUMNS.map((column) => {
      const eligibleValues = spaces.flatMap((space) => {
        const row = matrixBySpace.get(space.id);
        return row?.ceiling[column.field] ? [row.configured[column.field]] : [];
      });
      return [
        column.field,
        {
          ...getPermissionSelectionState(eligibleValues),
          eligibleCount: eligibleValues.length,
        },
      ];
    }),
  );
  const inactiveConfiguredCount =
    matrixQuery.data?.spaces.reduce(
      (count, row) =>
        count +
        MCP_PERMISSION_COLUMNS.filter(
          (column) =>
            row.configured[column.field] && !row.effective[column.field],
        ).length,
      0,
    ) ?? 0;

  const togglePermission = (
    spaceId: string,
    field: McpPermissionField,
    checked: boolean,
  ) => {
    if (!selectedClientId || !canManagePermissions) return;
    const row = matrixBySpace.get(spaceId);
    if (!row || (checked && !row.ceiling[field])) return;
    const values = { ...row.configured };
    values[field] = checked;
    upsertMutation.mutate({ clientId: selectedClientId, spaceId, ...values });
  };

  const setPermissions = (changes: Partial<McpPermissionValues>) => {
    if (!selectedClientId || !canManagePermissions) return;
    const updates = buildPermissionUpdates(
      selectedClientId,
      spaces.map((space) => ({
        id: space.id,
        permission: matrixBySpace.get(space.id)?.configured,
        ceiling: matrixBySpace.get(space.id)?.ceiling,
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
    if (!canManagePermissions) return;
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
          Effective access is the intersection of these settings and the
          actor&apos;s current native role.
        </Text>
      </div>

      {client && !canManagePermissions && (
        <Alert icon={<IconInfoCircle size={18} />} color="blue" mb="sm">
          This personal client belongs to another administrator. You can review
          its permissions, but only its owner can change them.
        </Alert>
      )}

      {matrixQuery.data && !matrixQuery.data.actorAvailable && (
        <Alert icon={<IconInfoCircle size={18} />} color="red" mb="sm">
          The mapped actor is missing or unavailable. All configured permissions
          are currently inactive.
        </Alert>
      )}

      {inactiveConfiguredCount > 0 && (
        <Alert icon={<IconInfoCircle size={18} />} color="orange" mb="sm">
          {inactiveConfiguredCount} configured permission
          {inactiveConfiguredCount === 1 ? " is" : "s are"} inactive under the
          actor&apos;s current role. Orange checks can be cleared but cannot be
          enabled again unless native access is restored.
        </Alert>
      )}

      {matrixQuery.isError && (
        <Alert icon={<IconInfoCircle size={18} />} color="red" mb="sm">
          Effective permissions could not be loaded. Changes are disabled until
          the permission matrix is available.
        </Alert>
      )}

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
                        !selectedClientId ||
                        !spaces.length ||
                        !matrixQuery.data ||
                        eligiblePermissionValues.length === 0 ||
                        !canManagePermissions ||
                        isMutating
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
                            !selectedClientId ||
                            !spaces.length ||
                            !matrixQuery.data ||
                            selection?.eligibleCount === 0 ||
                            !canManagePermissions ||
                            isMutating
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
            {spacesQuery.isLoading ||
            clientsQuery.isLoading ||
            (Boolean(selectedClientId) &&
              spaces.length > 0 &&
              matrixQuery.isLoading) ? (
              <Table.Tr>
                <Table.Td colSpan={11} ta="center" py="xl">
                  <Loader size="sm" />
                </Table.Td>
              </Table.Tr>
            ) : spacesQuery.data?.items.length ? (
              spacesQuery.data.items.map((space) => {
                const row = matrixBySpace.get(space.id);
                const accessDisplay = getNativeAccessDisplay(
                  row,
                  matrixQuery.data?.actorReason,
                );
                return (
                  <Table.Tr key={space.id}>
                    <Table.Td>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {space.name}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {space.slug}
                      </Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={accessDisplay.color}
                        mt={4}
                      >
                        {accessDisplay.label}
                      </Badge>
                    </Table.Td>
                    {MCP_PERMISSION_COLUMNS.map((column) => {
                      const configured = row?.configured[column.field] ?? false;
                      const effective = row?.effective[column.field] ?? false;
                      const withinCeiling = row?.ceiling[column.field] ?? false;
                      const inactive = configured && !effective;
                      const disabled =
                        !selectedClientId ||
                        !matrixQuery.data ||
                        !canManagePermissions ||
                        isMutating ||
                        (!withinCeiling && !configured);

                      return (
                        <Table.Td key={column.field}>
                          <Tooltip
                            label={
                              inactive
                                ? `Configured but inactive. ${getUnavailablePermissionLabel(row)}`
                                : getUnavailablePermissionLabel(row)
                            }
                            disabled={withinCeiling && !inactive}
                          >
                            <div
                              className={`${classes.permissionCell} ${
                                inactive ? classes.permissionCellInactive : ""
                              }`}
                              data-inactive={inactive || undefined}
                            >
                              <Checkbox
                                aria-label={`${column.label} permission for ${space.name}${
                                  inactive ? " (configured but inactive)" : ""
                                }`}
                                checked={configured}
                                color={inactive ? "orange" : undefined}
                                disabled={disabled}
                                onChange={(event) =>
                                  togglePermission(
                                    space.id,
                                    column.field,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                            </div>
                          </Tooltip>
                        </Table.Td>
                      );
                    })}
                    <Table.Td>
                      <div className={classes.permissionCell}>
                        {row?.permission && (
                          <Tooltip
                            label={
                              canManagePermissions
                                ? "Remove all permissions"
                                : "Only the client owner can change permissions"
                            }
                          >
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={`Remove all permissions for ${space.name}`}
                              disabled={!canManagePermissions}
                              onClick={() =>
                                confirmRemove(row.permission!, space.name)
                              }
                            >
                              <IconTrash size={17} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </div>
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
