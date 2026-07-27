import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import NoTableResults from "@/components/common/no-table-results";
import Paginate from "@/components/common/paginate";
import {
  useBulkUpsertMcpPermissionsMutation,
  useDeleteMcpPermissionMutation,
  useMcpClientsQuery,
  useMcpPermissionMatrixQuery,
  useUpsertMcpPermissionMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpClient,
  IMcpPermissionMatrixSpace,
  IMcpSpacePermission,
  McpNativeAccessReason,
  McpPermissionField,
  McpPermissionValues,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";
import {
  buildPermissionUpdates,
  getPermissionSelectionState,
  MCP_PERMISSION_COLUMNS,
} from "@/features/mcp/utils/mcp-permission-utils";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import classes from "./mcp-settings.module.css";

type SaveState = "idle" | "saving" | "saved" | "failed";

const PERMISSION_DESCRIPTIONS: Record<McpPermissionField, string> = {
  canSearch: "Find pages with keyword search",
  canSemanticSearch: "Find pages by meaning with vector search",
  canRead: "Open and read page content",
  canCreate: "Create new pages",
  canUpdate: "Replace existing page content",
  canAppend: "Append content without replacing the page",
  canDelete: "Move pages to trash",
  canRestore: "Restore deleted pages",
  canIndex: "Add page content to the vector index",
};

function getNativeAccessDisplay(
  row: IMcpPermissionMatrixSpace | undefined,
  actorReason: McpNativeAccessReason | undefined,
  t: TFunction,
) {
  if (row?.actorRole) {
    const role = `${row.actorRole[0].toUpperCase()}${row.actorRole.slice(1)}`;
    return {
      label: `${t("Representative user")}: ${t(role)}`,
      color: row.actorRole === "reader" ? "blue" : "green",
    };
  }

  const reason = row?.reason ?? actorReason;
  const labels: Record<
    Exclude<McpNativeAccessReason, "read_only" | null>,
    string
  > = {
    actor_unmapped: "No representative user",
    actor_unavailable: "Representative user unavailable",
    no_space_access: "No space access",
  };

  return {
    label:
      reason && reason !== "read_only"
        ? t(labels[reason])
        : t("Native access unavailable"),
    color: "red",
  };
}

function getUnavailablePermissionLabel(
  row: IMcpPermissionMatrixSpace | undefined,
  t: TFunction,
) {
  if (row?.reason === "read_only") {
    return t(
      "The representative user's read-only role does not allow this permission",
    );
  }
  if (row?.reason === "no_space_access") {
    return t("The representative user no longer has access to this space");
  }
  if (row?.reason === "actor_unmapped") {
    return t("This client has no representative user");
  }
  if (row?.reason === "actor_unavailable") {
    return t("The representative user is unavailable");
  }
  return t(
    "This permission is outside the representative user's current native access",
  );
}

function getClientOptionLabel(
  client: IMcpClient,
  actorName: string,
  t: TFunction,
) {
  const scope =
    client.scope === "workspace" ? t("Workspace client") : t("Personal client");
  const status = t(
    `${client.status[0].toUpperCase()}${client.status.slice(1)}`,
  );
  const editability = client.capabilities.canManagePermissions
    ? t("Editable")
    : t("Read only");

  return `${client.name} - ${scope} - ${actorName} - ${status} - ${editability}`;
}

export function McpPermissions() {
  const { t } = useTranslation();
  const isCompact = useMediaQuery("(max-width: 62em)", false);
  const [clientSearch, setClientSearch] = useState("");
  const [spaceSearch, setSpaceSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<IMcpClient | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [debouncedClientSearch] = useDebouncedValue(clientSearch.trim(), 300);
  const [debouncedSpaceSearch] = useDebouncedValue(spaceSearch.trim(), 300);
  const clientPagination = useCursorPaginate();
  const spacePagination = useCursorPaginate();

  const clientsQuery = useMcpClientsQuery({
    query: debouncedClientSearch || undefined,
    cursor: clientPagination.cursor,
    limit: 20,
  });
  const spacesQuery = useGetSpacesQuery({
    query: debouncedSpaceSearch || undefined,
    cursor: spacePagination.cursor,
    limit: 20,
  });
  const upsertMutation = useUpsertMcpPermissionMutation();
  const bulkUpsertMutation = useBulkUpsertMcpPermissionsMutation();
  const deleteMutation = useDeleteMcpPermissionMutation();

  const clients = clientsQuery.data?.items ?? [];
  const refreshedSelectedClient = selectedClient
    ? clients.find((item) => item.id === selectedClient.id)
    : null;
  const client =
    refreshedSelectedClient ??
    selectedClient ??
    (clientPagination.cursor || debouncedClientSearch ? null : clients[0]) ??
    null;
  const selectedClientId = client?.id ?? null;
  const selectableClients = useMemo(() => {
    if (
      !selectedClient ||
      clients.some((item) => item.id === selectedClient.id)
    ) {
      return clients;
    }
    return [selectedClient, ...clients];
  }, [clients, selectedClient]);
  const clientOptions = selectableClients.map((item) => {
    const actorName = item.actorUserId
      ? (item.actorUserName ??
        `${t("Representative user")} ${item.actorUserId.slice(0, 8)}`)
      : t("No representative user");
    return {
      value: item.id,
      label: getClientOptionLabel(item, actorName, t),
    };
  });

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
    [matrixQuery.data?.spaces],
  );
  const isMutating =
    upsertMutation.isPending ||
    bulkUpsertMutation.isPending ||
    deleteMutation.isPending;
  const isInteractionLocked =
    isMutating ||
    Boolean(spacesQuery.isFetching) ||
    Boolean(matrixQuery.isFetching);
  const matrixReady = Boolean(matrixQuery.data) && !matrixQuery.isError;

  const actionablePermissionValues = spaces.flatMap((space) => {
    const row = matrixBySpace.get(space.id);
    return MCP_PERMISSION_COLUMNS.flatMap((column) =>
      row?.ceiling[column.field] || row?.configured[column.field]
        ? [row.configured[column.field]]
        : [],
    );
  });
  const allSelection = getPermissionSelectionState(actionablePermissionValues);
  const columnSelection = new Map(
    MCP_PERMISSION_COLUMNS.map((column) => {
      const actionableValues = spaces.flatMap((space) => {
        const row = matrixBySpace.get(space.id);
        return row?.ceiling[column.field] || row?.configured[column.field]
          ? [row.configured[column.field]]
          : [];
      });
      return [
        column.field,
        {
          ...getPermissionSelectionState(actionableValues),
          actionableCount: actionableValues.length,
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
  const configuredPermissionCount =
    matrixQuery.data?.spaces.reduce(
      (count, row) =>
        count +
        MCP_PERMISSION_COLUMNS.filter((column) => row.configured[column.field])
          .length,
      0,
    ) ?? 0;

  const markMutation = (
    mutate: (callbacks: { onSuccess: () => void; onError: () => void }) => void,
  ) => {
    setSaveState("saving");
    mutate({
      onSuccess: () => setSaveState("saved"),
      onError: () => setSaveState("failed"),
    });
  };

  const togglePermission = (
    spaceId: string,
    field: McpPermissionField,
    checked: boolean,
  ) => {
    if (!selectedClientId || !canManagePermissions) return;
    const row = matrixBySpace.get(spaceId);
    if (!row || (checked && !row.ceiling[field])) return;

    markMutation((callbacks) =>
      upsertMutation.mutate(
        {
          clientId: selectedClientId,
          spaceId,
          expectedUpdatedAt: row.permission?.updatedAt ?? null,
          [field]: checked,
        },
        callbacks,
      ),
    );
  };

  const runBulkMutation = (updates: McpSpacePermissionInput[]) => {
    markMutation((callbacks) => bulkUpsertMutation.mutate(updates, callbacks));
  };

  const setPermissions = (
    changes: Partial<McpPermissionValues>,
    permissionLabel: string,
  ) => {
    if (!selectedClientId || !canManagePermissions) return;
    const updates = buildPermissionUpdates(
      selectedClientId,
      spaces.map((space) => ({
        id: space.id,
        permission: matrixBySpace.get(space.id)?.permission ?? undefined,
        ceiling: matrixBySpace.get(space.id)?.ceiling,
      })),
      changes,
    );
    if (!updates.length) return;

    const enabling = Object.values(changes).some(Boolean);
    modals.openConfirmModal({
      title: enabling ? t("Confirm bulk grant") : t("Confirm bulk removal"),
      children: (
        <Stack gap={6}>
          <Text size="sm">
            {enabling
              ? t("Grant the selected permissions to")
              : t("Clear the selected permissions from")}{" "}
            <strong>{updates.length}</strong> {t("spaces on this page")}?
          </Text>
          <Text size="xs" c="dimmed">
            {permissionLabel}.{" "}
            {t("This operation is transactional and affects this page only.")}
          </Text>
        </Stack>
      ),
      labels: {
        confirm: enabling ? t("Grant permissions") : t("Clear permissions"),
        cancel: t("Cancel"),
      },
      confirmProps: { color: enabling ? "blue" : "red" },
      onConfirm: () => runBulkMutation(updates),
    });
  };

  const toggleAllPermissions = (checked: boolean) => {
    setPermissions(
      MCP_PERMISSION_COLUMNS.reduce((result, column) => {
        result[column.field] = checked;
        return result;
      }, {} as McpPermissionValues),
      t("All permission columns"),
    );
  };

  const confirmRemove = (
    permission: IMcpSpacePermission,
    spaceName: string,
  ) => {
    if (!canManagePermissions) return;
    modals.openConfirmModal({
      title: t("Remove space permission"),
      children: (
        <Text size="sm">
          {t("Remove all client access to")} <strong>{spaceName}</strong>{" "}
          {t("for this client")}?
        </Text>
      ),
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () =>
        markMutation((callbacks) =>
          deleteMutation.mutate(
            {
              clientId: permission.clientId,
              spaceId: permission.spaceId,
              expectedUpdatedAt: permission.updatedAt,
            },
            callbacks,
          ),
        ),
    });
  };

  const renderPermissionControl = (
    space: { id: string; name: string },
    row: IMcpPermissionMatrixSpace | undefined,
    field: McpPermissionField,
    label: string,
  ) => {
    const configured = row?.configured[field] ?? false;
    const effective = row?.effective[field] ?? false;
    const withinCeiling = row?.ceiling[field] ?? false;
    const inactive = configured && !effective;
    const disabled =
      !selectedClientId ||
      !matrixReady ||
      !canManagePermissions ||
      isInteractionLocked ||
      (!withinCeiling && !configured);
    const reason = !matrixReady
      ? t("Effective permissions are not available")
      : !canManagePermissions
        ? t("Only the client owner can change permissions")
        : inactive || !withinCeiling
          ? getUnavailablePermissionLabel(row, t)
          : null;
    const reasonId = `mcp-${space.id}-${field}-reason`;
    const ariaLabel = `${label} ${t("permission for")} ${space.name}${
      inactive ? ` (${t("configured but inactive")})` : ""
    }`;

    return (
      <Tooltip label={reason} disabled={!reason} withinPortal>
        <div
          className={`${classes.permissionCell} ${
            inactive ? classes.permissionCellInactive : ""
          }`}
          data-inactive={inactive || undefined}
          tabIndex={reason ? 0 : undefined}
        >
          <Checkbox
            aria-label={ariaLabel}
            aria-describedby={reason ? reasonId : undefined}
            checked={configured}
            color={inactive ? "orange" : undefined}
            disabled={disabled}
            onChange={(event) =>
              togglePermission(space.id, field, event.currentTarget.checked)
            }
          />
          {reason && (
            <VisuallyHidden>
              <span id={reasonId}>{reason}</span>
            </VisuallyHidden>
          )}
        </div>
      </Tooltip>
    );
  };

  const renderSpaceRows = () =>
    spaces.map((space) => {
      const row = matrixBySpace.get(space.id);
      const accessDisplay = getNativeAccessDisplay(
        row,
        matrixQuery.data?.actorReason,
        t,
      );

      return (
        <Table.Tr key={space.id}>
          <Table.Td className={classes.stickySpaceCell}>
            <Text size="sm" fw={500} lineClamp={1}>
              {space.name}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={1}>
              {space.slug}
            </Text>
            <Badge size="xs" variant="light" color={accessDisplay.color} mt={4}>
              {accessDisplay.label}
            </Badge>
          </Table.Td>
          {MCP_PERMISSION_COLUMNS.map((column) => (
            <Table.Td key={column.field}>
              {renderPermissionControl(
                space,
                row,
                column.field,
                t(column.label),
              )}
            </Table.Td>
          ))}
          <Table.Td>
            <div className={classes.permissionCell}>
              {row?.permission && (
                <Tooltip
                  label={
                    canManagePermissions
                      ? t("Remove all permissions")
                      : t("Only the client owner can change permissions")
                  }
                >
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`${t("Remove all permissions for")} ${space.name}`}
                    disabled={!canManagePermissions || isInteractionLocked}
                    onClick={() => confirmRemove(row.permission!, space.name)}
                  >
                    <IconTrash size={17} />
                  </ActionIcon>
                </Tooltip>
              )}
            </div>
          </Table.Td>
        </Table.Tr>
      );
    });

  const renderCompactSpaces = () => (
    <Accordion
      className={classes.compactPermissions}
      variant="separated"
      multiple
    >
      {spaces.map((space) => {
        const row = matrixBySpace.get(space.id);
        const accessDisplay = getNativeAccessDisplay(
          row,
          matrixQuery.data?.actorReason,
          t,
        );
        return (
          <Accordion.Item key={space.id} value={space.id}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Box miw={0}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {space.name}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {space.slug}
                  </Text>
                </Box>
                <Badge
                  size="xs"
                  variant="light"
                  color={accessDisplay.color}
                  className={classes.compactRoleBadge}
                >
                  {accessDisplay.label}
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap={0}>
                {MCP_PERMISSION_COLUMNS.map((column) => (
                  <Group
                    key={column.field}
                    className={classes.compactPermissionRow}
                    justify="space-between"
                    wrap="nowrap"
                    gap="md"
                  >
                    <Box miw={0}>
                      <Text size="sm" fw={500}>
                        {t(column.label)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t(PERMISSION_DESCRIPTIONS[column.field])}
                      </Text>
                    </Box>
                    {renderPermissionControl(
                      space,
                      row,
                      column.field,
                      t(column.label),
                    )}
                  </Group>
                ))}
                {row?.permission && (
                  <Button
                    mt="sm"
                    variant="subtle"
                    color="red"
                    size="xs"
                    leftSection={<IconTrash size={15} />}
                    disabled={!canManagePermissions || isInteractionLocked}
                    onClick={() => confirmRemove(row.permission!, space.name)}
                  >
                    {t("Remove all permissions")}
                  </Button>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );

  return (
    <div className={classes.permissionLayout}>
      <Stack gap="sm" my="md">
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label={t("Find a client")}
            aria-label={t("Search access clients")}
            placeholder={t("Search by client name")}
            leftSection={<IconSearch size={16} />}
            value={clientSearch}
            onChange={(event) => {
              setClientSearch(event.currentTarget.value);
              clientPagination.resetCursor();
            }}
            w={{ base: "100%", sm: 260 }}
          />
          <Select
            label={t("Client")}
            placeholder={t("Select a client")}
            data={clientOptions}
            value={selectedClientId}
            onChange={(value) => {
              const next = selectableClients.find((item) => item.id === value);
              setSelectedClient(next ?? null);
              setSaveState("idle");
            }}
            searchable
            allowDeselect={false}
            nothingFoundMessage={t("No clients on this page")}
            w={{ base: "100%", sm: 520 }}
          />
        </Group>

        <Group justify="flex-end">
          <Paginate
            hasPrevPage={clientsQuery.data?.meta?.hasPrevPage ?? false}
            hasNextPage={clientsQuery.data?.meta?.hasNextPage ?? false}
            onPrev={clientPagination.goPrev}
            onNext={() =>
              clientPagination.goNext(clientsQuery.data?.meta?.nextCursor)
            }
          />
        </Group>
      </Stack>

      {clientsQuery.isError && (
        <RetryAlert
          title={t("Access clients could not be loaded")}
          message={t("Check the connection and try loading clients again.")}
          onRetry={() => clientsQuery.refetch()}
        />
      )}

      {!clientsQuery.isLoading &&
        !clientsQuery.isError &&
        !client &&
        (debouncedClientSearch || clientPagination.cursor ? (
          <Alert icon={<IconInfoCircle size={18} />} color="blue" mb="sm">
            {t("No access clients match this page or search.")}
          </Alert>
        ) : (
          <Alert icon={<IconInfoCircle size={18} />} color="blue" mb="sm">
            {t("Create an access client before assigning space permissions.")}
          </Alert>
        ))}

      {client && client.status !== "active" && (
        <Alert
          icon={<IconAlertCircle size={18} />}
          color={client.status === "expired" ? "red" : "orange"}
          mb="sm"
          title={
            client.status === "expired"
              ? t("Client expired")
              : t("Client disabled")
          }
        >
          {client.status === "expired"
            ? t(
                "This client's token has expired. Its permissions are visible but requests are rejected.",
              )
            : t(
                "This client is disabled. Its permissions are visible but requests are rejected.",
              )}
        </Alert>
      )}

      {client && !canManagePermissions && (
        <Alert icon={<IconInfoCircle size={18} />} color="blue" mb="sm">
          {t(
            "This personal client belongs to another administrator. You can review its permissions, but only its owner can change them.",
          )}
        </Alert>
      )}

      {matrixQuery.data && !matrixQuery.data.actorAvailable && (
        <Alert icon={<IconInfoCircle size={18} />} color="red" mb="sm">
          {t(
            "The representative user is missing or unavailable. All configured permissions are currently inactive.",
          )}
        </Alert>
      )}

      {inactiveConfiguredCount > 0 && (
        <Alert icon={<IconInfoCircle size={18} />} color="orange" mb="sm">
          {inactiveConfiguredCount}{" "}
          {inactiveConfiguredCount === 1
            ? t("configured permission is inactive")
            : t("configured permissions are inactive")}{" "}
          {t(
            "under the representative user's current role. Orange checks can be cleared but cannot be enabled again unless native access is restored.",
          )}
        </Alert>
      )}

      {spacesQuery.isError && (
        <RetryAlert
          title={t("Spaces could not be loaded")}
          message={t("Check the connection and try loading spaces again.")}
          onRetry={() => spacesQuery.refetch()}
        />
      )}

      {matrixQuery.isError && (
        <RetryAlert
          title={t("Effective permissions could not be loaded")}
          message={t(
            "Changes are disabled until the permission matrix is available.",
          )}
          onRetry={() => matrixQuery.refetch()}
        />
      )}

      {client && !spacesQuery.isError && (
        <>
          <div className={classes.permissionOperations}>
            <TextInput
              aria-label={t("Search spaces")}
              placeholder={t("Search spaces on the server")}
              leftSection={<IconSearch size={16} />}
              value={spaceSearch}
              onChange={(event) => {
                setSpaceSearch(event.currentTarget.value);
                spacePagination.resetCursor();
              }}
              w={{ base: "100%", sm: 280 }}
            />
            <Group gap="xs" wrap="wrap">
              {configuredPermissionCount > 0 && canManagePermissions && (
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  leftSection={<IconTrash size={14} />}
                  disabled={!matrixReady || isInteractionLocked}
                  onClick={() =>
                    setPermissions(
                      MCP_PERMISSION_COLUMNS.reduce((result, column) => {
                        result[column.field] = false;
                        return result;
                      }, {} as McpPermissionValues),
                      t("All configured permissions on this page"),
                    )
                  }
                >
                  {t("Clear page permissions")}
                </Button>
              )}
              {saveState === "saving" && (
                <Badge
                  variant="light"
                  color="blue"
                  leftSection={<Loader size={10} />}
                >
                  {t("Saving changes")}
                </Badge>
              )}
              {saveState === "saved" && (
                <Badge
                  variant="light"
                  color="green"
                  leftSection={<IconCheck size={12} />}
                >
                  {t("All changes saved")}
                </Badge>
              )}
              {saveState === "failed" && (
                <Badge
                  variant="light"
                  color="red"
                  leftSection={<IconAlertCircle size={12} />}
                >
                  {t("Last change failed")}
                </Badge>
              )}
            </Group>
          </div>

          {isCompact && (
            <div className={classes.compactBulkControls}>
              <Checkbox
                label={t("All permissions on this page")}
                aria-label={t("Select or clear all permissions")}
                checked={allSelection.checked}
                indeterminate={allSelection.indeterminate}
                disabled={
                  !selectedClientId ||
                  !spaces.length ||
                  !matrixReady ||
                  actionablePermissionValues.length === 0 ||
                  !canManagePermissions ||
                  isInteractionLocked
                }
                onChange={(event) =>
                  toggleAllPermissions(event.currentTarget.checked)
                }
              />
              <Group gap="md" wrap="wrap">
                {MCP_PERMISSION_COLUMNS.map((column) => {
                  const selection = columnSelection.get(column.field);
                  return (
                    <Checkbox
                      key={column.field}
                      size="xs"
                      label={t(column.label)}
                      aria-label={`${t("Select or clear all")} ${t(
                        column.label,
                      )} ${t("permissions")}`}
                      checked={selection?.checked ?? false}
                      indeterminate={selection?.indeterminate ?? false}
                      disabled={
                        !selectedClientId ||
                        !spaces.length ||
                        !matrixReady ||
                        selection?.actionableCount === 0 ||
                        !canManagePermissions ||
                        isInteractionLocked
                      }
                      onChange={(event) =>
                        setPermissions(
                          { [column.field]: event.currentTarget.checked },
                          `${t(column.label)} ${t("permission column")}`,
                        )
                      }
                    />
                  );
                })}
              </Group>
            </div>
          )}

          {spacesQuery.isLoading ||
          clientsQuery.isLoading ||
          (Boolean(selectedClientId) &&
            spaces.length > 0 &&
            matrixQuery.isLoading) ? (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
          ) : spaces.length ? (
            isCompact ? (
              renderCompactSpaces()
            ) : (
              <Table.ScrollContainer
                minWidth={1080}
                type="native"
                className={classes.permissionTableScroller}
              >
                <Table
                  verticalSpacing="sm"
                  highlightOnHover
                  layout="fixed"
                  className={classes.permissionTable}
                >
                  <Table.Thead className={classes.stickyPermissionHeader}>
                    <Table.Tr>
                      <Table.Th w={220} className={classes.stickySpaceHeader}>
                        <div className={classes.permissionHeader}>
                          <Tooltip
                            label={t(
                              "Select or clear all permissions on this page",
                            )}
                          >
                            <Checkbox
                              aria-label={t("Select or clear all permissions")}
                              checked={allSelection.checked}
                              indeterminate={allSelection.indeterminate}
                              disabled={
                                !selectedClientId ||
                                !spaces.length ||
                                !matrixReady ||
                                actionablePermissionValues.length === 0 ||
                                !canManagePermissions ||
                                isInteractionLocked
                              }
                              onChange={(event) =>
                                toggleAllPermissions(
                                  event.currentTarget.checked,
                                )
                              }
                            />
                          </Tooltip>
                          <span>{t("Space")}</span>
                        </div>
                      </Table.Th>
                      {MCP_PERMISSION_COLUMNS.map((column) => {
                        const selection = columnSelection.get(column.field);
                        return (
                          <Table.Th key={column.field} ta="center" w={88}>
                            <div className={classes.permissionColumnHeader}>
                              <Tooltip
                                label={t(PERMISSION_DESCRIPTIONS[column.field])}
                              >
                                <span tabIndex={0}>{t(column.label)}</span>
                              </Tooltip>
                              <Tooltip
                                label={`${t("Select or clear all")} ${t(
                                  column.label,
                                )} ${t("permissions on this page")}`}
                              >
                                <Checkbox
                                  aria-label={`${t(
                                    "Select or clear all",
                                  )} ${t(column.label)} ${t("permissions")}`}
                                  checked={selection?.checked ?? false}
                                  indeterminate={
                                    selection?.indeterminate ?? false
                                  }
                                  disabled={
                                    !selectedClientId ||
                                    !spaces.length ||
                                    !matrixReady ||
                                    selection?.actionableCount === 0 ||
                                    !canManagePermissions ||
                                    isInteractionLocked
                                  }
                                  onChange={(event) =>
                                    setPermissions(
                                      {
                                        [column.field]:
                                          event.currentTarget.checked,
                                      },
                                      `${t(column.label)} ${t(
                                        "permission column",
                                      )}`,
                                    )
                                  }
                                />
                              </Tooltip>
                            </div>
                          </Table.Th>
                        );
                      })}
                      <Table.Th w={56}>
                        <VisuallyHidden>{t("Actions")}</VisuallyHidden>
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>{renderSpaceRows()}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )
          ) : (
            <Table>
              <Table.Tbody>
                <NoTableResults colSpan={1} />
              </Table.Tbody>
            </Table>
          )}

          <Group justify="flex-end" align="center" mt="sm">
            <Paginate
              hasPrevPage={spacesQuery.data?.meta?.hasPrevPage ?? false}
              hasNextPage={spacesQuery.data?.meta?.hasNextPage ?? false}
              onPrev={spacePagination.goPrev}
              onNext={() =>
                spacePagination.goNext(spacesQuery.data?.meta?.nextCursor)
              }
            />
          </Group>
        </>
      )}
    </div>
  );
}

function RetryAlert({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      icon={<IconAlertCircle size={18} />}
      color="red"
      title={title}
      mb="sm"
    >
      <Group justify="space-between" align="center" wrap="wrap">
        <Text size="sm">{message}</Text>
        <Button
          variant="light"
          color="red"
          size="xs"
          leftSection={<IconRefresh size={15} />}
          onClick={onRetry}
        >
          {t("Retry")}
        </Button>
      </Group>
    </Alert>
  );
}
