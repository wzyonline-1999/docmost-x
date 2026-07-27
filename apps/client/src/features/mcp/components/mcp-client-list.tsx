import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconDots,
  IconEdit,
  IconExclamationCircle,
  IconKey,
  IconPlayerPlay,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUserOff,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import {
  useDeleteMcpClientMutation,
  useDisableMcpClientMutation,
  useMcpClientsQuery,
  useRotateMcpClientTokenMutation,
  useUpdateMcpClientMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpClient,
  IMcpClientTokenResponse,
  McpClientStatus,
} from "@/features/mcp/types/mcp.types";
import NoTableResults from "@/components/common/no-table-results";
import Paginate from "@/components/common/paginate";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import classes from "./mcp-settings.module.css";

type McpClientListProps = {
  onCreate: () => void;
  onEdit: (client: IMcpClient) => void;
  onConfigure: (client: IMcpClient) => void;
  onToken: (response: IMcpClientTokenResponse) => void;
};

export function McpClientList({
  onCreate,
  onEdit,
  onConfigure,
  onToken,
}: McpClientListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query.trim(), 300);
  const [status, setStatus] = useState<McpClientStatus | null>(null);
  const { cursor, goNext, goPrev, resetCursor } = useCursorPaginate();
  const clientsQuery = useMcpClientsQuery({
    query: debouncedQuery || undefined,
    status: status ?? undefined,
    cursor,
    limit: 25,
  });
  const disableMutation = useDisableMcpClientMutation();
  const deleteMutation = useDeleteMcpClientMutation();
  const rotateMutation = useRotateMcpClientTokenMutation();
  const updateMutation = useUpdateMcpClientMutation();
  const confirmDisable = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: t("Disable access client"),
      children: (
        <Text size="sm">
          {t("Existing requests from")} <strong>{client.name}</strong>{" "}
          {t("will be rejected immediately.")}
        </Text>
      ),
      labels: { confirm: t("Disable"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: () => disableMutation.mutate(client.id),
    });
  };

  const confirmRotate = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: t("Rotate access token"),
      children: (
        <Text size="sm">
          {t("The current token for")} <strong>{client.name}</strong>{" "}
          {t("will stop working after this transaction commits.")}
        </Text>
      ),
      labels: { confirm: t("Rotate"), cancel: t("Cancel") },
      onConfirm: async () =>
        onToken(await rotateMutation.mutateAsync(client.id)),
    });
  };

  const confirmDelete = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: t("Delete access client"),
      children: (
        <Text size="sm">
          {t("Delete")} <strong>{client.name}</strong>{" "}
          {t("and all of its space permissions")}?
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(client.id),
    });
  };

  return (
    <>
      <div className={classes.toolbar}>
        <Group gap="sm" wrap="wrap">
          <TextInput
            aria-label={t("Search access clients")}
            placeholder={t("Search clients")}
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              resetCursor();
            }}
          />
          <Select
            aria-label={t("Filter access clients by status")}
            placeholder={t("All statuses")}
            clearable
            value={status}
            onChange={(value) => {
              setStatus(value as McpClientStatus | null);
              resetCursor();
            }}
            data={[
              { value: "active", label: t("Active") },
              { value: "disabled", label: t("Disabled") },
              { value: "expired", label: t("Expired") },
            ]}
          />
        </Group>
        <Button leftSection={<IconPlus size={16} />} onClick={onCreate}>
          {t("Create client")}
        </Button>
      </div>

      {clientsQuery.isError ? (
        <Alert
          icon={<IconExclamationCircle size={18} />}
          color="red"
          title={t("Access clients could not be loaded")}
        >
          <Group justify="space-between" align="center">
            <Text size="sm">
              {t("Check the connection and try loading the client list again.")}
            </Text>
            <Button
              variant="light"
              color="red"
              size="xs"
              leftSection={<IconRefresh size={15} />}
              onClick={() => clientsQuery.refetch()}
            >
              {t("Retry")}
            </Button>
          </Group>
        </Alert>
      ) : (
        <>
          <Group justify="space-between" mb="xs">
            <Text size="xs" c="dimmed">
              {t("This page shows")} {clientsQuery.data?.items.length ?? 0}{" "}
              {t("clients")}
            </Text>
            {clientsQuery.isFetching && !clientsQuery.isLoading && (
              <Group gap={6}>
                <Loader size={13} />
                <Text size="xs" c="dimmed">
                  {t("Updating")}
                </Text>
              </Group>
            )}
          </Group>

          <Table.ScrollContainer minWidth={860}>
            <Table verticalSpacing="sm" highlightOnHover layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w="28%">{t("Client")}</Table.Th>
                  <Table.Th w="14%">{t("Status")}</Table.Th>
                  <Table.Th w="20%">{t("Representative user")}</Table.Th>
                  <Table.Th w="18%">{t("Last used")}</Table.Th>
                  <Table.Th w="14%">{t("Expires")}</Table.Th>
                  <Table.Th w={56}>
                    <VisuallyHidden>{t("Actions")}</VisuallyHidden>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {clientsQuery.isLoading ? (
                  <Table.Tr>
                    <Table.Td colSpan={6} ta="center" py="xl">
                      <Loader size="sm" />
                    </Table.Td>
                  </Table.Tr>
                ) : clientsQuery.data?.items.length ? (
                  clientsQuery.data.items.map((client) => (
                    <Table.Tr key={client.id}>
                      <Table.Td>
                        <Text size="sm" fw={500} lineClamp={1}>
                          {client.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {client.scope === "workspace"
                            ? t("Workspace client")
                            : `${t("Personal client")}${
                                client.ownerUserId
                                  ? ` ${t("owned by")} ${
                                      client.ownerUserName ??
                                      t("unknown member")
                                    }`
                                  : ""
                              }`}
                          {" - "}
                          {t("token ending in")} {client.tokenLastFour}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={client.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>
                          {client.actorUserId
                            ? (client.actorUserName ?? t("Unknown member"))
                            : t("Not assigned")}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatDate(client.lastUsedAt, t("Never"))}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatDate(client.expiresAt, t("Never"))}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <Tooltip label={t("Client actions")}>
                              <ActionIcon
                                variant="subtle"
                                aria-label={`${t("Actions for")} ${client.name}`}
                              >
                                <IconDots size={18} />
                              </ActionIcon>
                            </Tooltip>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconPlugConnected size={16} />}
                              onClick={() => onConfigure(client)}
                            >
                              {t("Connection setup")}
                            </Menu.Item>
                            {client.capabilities.canEdit && (
                              <Menu.Item
                                leftSection={<IconEdit size={16} />}
                                onClick={() => onEdit(client)}
                              >
                                {t("Edit")}
                              </Menu.Item>
                            )}
                            {client.capabilities.canRotateToken && (
                              <Menu.Item
                                leftSection={<IconKey size={16} />}
                                onClick={() => confirmRotate(client)}
                              >
                                {t("Rotate token")}
                              </Menu.Item>
                            )}
                            {client.status === "active" &&
                              client.capabilities.canDisable && (
                                <Menu.Item
                                  leftSection={<IconUserOff size={16} />}
                                  color="orange"
                                  onClick={() => confirmDisable(client)}
                                >
                                  {t("Disable")}
                                </Menu.Item>
                              )}
                            {client.status === "disabled" &&
                              client.capabilities.canEdit && (
                                <Menu.Item
                                  leftSection={<IconPlayerPlay size={16} />}
                                  onClick={() =>
                                    updateMutation.mutate({
                                      clientId: client.id,
                                      name: client.name,
                                      status: "active",
                                    })
                                  }
                                >
                                  {t("Enable")}
                                </Menu.Item>
                              )}
                            {client.capabilities.canDelete && (
                              <>
                                <Menu.Divider />
                                <Menu.Item
                                  leftSection={<IconTrash size={16} />}
                                  color="red"
                                  onClick={() => confirmDelete(client)}
                                >
                                  {t("Delete")}
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    </Table.Tr>
                  ))
                ) : (
                  <NoTableResults colSpan={6} />
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          <Paginate
            hasPrevPage={clientsQuery.data?.meta.hasPrevPage ?? false}
            hasNextPage={clientsQuery.data?.meta.hasNextPage ?? false}
            onPrev={goPrev}
            onNext={() => goNext(clientsQuery.data?.meta.nextCursor)}
          />
        </>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: McpClientStatus }) {
  const { t } = useTranslation();
  const colors: Record<McpClientStatus, string> = {
    active: "green",
    disabled: "gray",
    expired: "red",
  };
  return (
    <Badge color={colors[status]} variant="light">
      {t(status[0].toUpperCase() + status.slice(1))}
    </Badge>
  );
}

function formatDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
