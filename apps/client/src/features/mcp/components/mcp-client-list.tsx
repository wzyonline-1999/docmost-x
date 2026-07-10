import {
  ActionIcon,
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
  IconKey,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUserOff,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useMemo, useState } from "react";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query";
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
import classes from "./mcp-settings.module.css";

type McpClientListProps = {
  onCreate: () => void;
  onEdit: (client: IMcpClient) => void;
  onToken: (response: IMcpClientTokenResponse) => void;
};

export function McpClientList({
  onCreate,
  onEdit,
  onToken,
}: McpClientListProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<McpClientStatus | null>(null);
  const clientsQuery = useMcpClientsQuery({
    query: query.trim() || undefined,
    status: status ?? undefined,
    limit: 100,
  });
  const membersQuery = useWorkspaceMembersQuery({ limit: 100 });
  const disableMutation = useDisableMcpClientMutation();
  const deleteMutation = useDeleteMcpClientMutation();
  const rotateMutation = useRotateMcpClientTokenMutation();
  const updateMutation = useUpdateMcpClientMutation();
  const actors = useMemo(
    () =>
      new Map(
        membersQuery.data?.items.map((member) => [member.id, member.name]) ??
          [],
      ),
    [membersQuery.data],
  );

  const confirmDisable = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: "Disable MCP client",
      children: (
        <Text size="sm">
          Existing requests from <strong>{client.name}</strong> will be rejected
          immediately.
        </Text>
      ),
      labels: { confirm: "Disable", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      onConfirm: () => disableMutation.mutate(client.id),
    });
  };

  const confirmRotate = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: "Rotate MCP token",
      children: (
        <Text size="sm">
          The current token for <strong>{client.name}</strong> will stop working
          after this transaction commits.
        </Text>
      ),
      labels: { confirm: "Rotate", cancel: "Cancel" },
      onConfirm: async () =>
        onToken(await rotateMutation.mutateAsync(client.id)),
    });
  };

  const confirmDelete = (client: IMcpClient) => {
    modals.openConfirmModal({
      title: "Delete MCP client",
      children: (
        <Text size="sm">
          Delete <strong>{client.name}</strong> and all of its space
          permissions?
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(client.id),
    });
  };

  return (
    <>
      <div className={classes.toolbar}>
        <Group gap="sm" wrap="wrap">
          <TextInput
            aria-label="Search MCP clients"
            placeholder="Search clients"
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Select
            aria-label="Filter MCP clients by status"
            placeholder="All statuses"
            clearable
            value={status}
            onChange={(value) => setStatus(value as McpClientStatus | null)}
            data={[
              { value: "active", label: "Active" },
              { value: "disabled", label: "Disabled" },
              { value: "expired", label: "Expired" },
            ]}
          />
        </Group>
        <Button leftSection={<IconPlus size={16} />} onClick={onCreate}>
          Create client
        </Button>
      </div>

      <Table.ScrollContainer minWidth={860}>
        <Table verticalSpacing="sm" highlightOnHover layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="28%">Client</Table.Th>
              <Table.Th w="14%">Status</Table.Th>
              <Table.Th w="20%">Actor</Table.Th>
              <Table.Th w="18%">Last used</Table.Th>
              <Table.Th w="14%">Expires</Table.Th>
              <Table.Th w={56}>
                <VisuallyHidden>Actions</VisuallyHidden>
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
                      Token ending in {client.tokenLastFour}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={client.status} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {client.actorUserId
                        ? (actors.get(client.actorUserId) ?? "Unknown member")
                        : "Not assigned"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {formatDate(client.lastUsedAt, "Never")}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {formatDate(client.expiresAt, "Never")}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <Tooltip label="Client actions">
                          <ActionIcon
                            variant="subtle"
                            aria-label={`Actions for ${client.name}`}
                          >
                            <IconDots size={18} />
                          </ActionIcon>
                        </Tooltip>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconEdit size={16} />}
                          onClick={() => onEdit(client)}
                        >
                          Edit
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconKey size={16} />}
                          onClick={() => confirmRotate(client)}
                        >
                          Rotate token
                        </Menu.Item>
                        {client.status === "active" && (
                          <Menu.Item
                            leftSection={<IconUserOff size={16} />}
                            color="orange"
                            onClick={() => confirmDisable(client)}
                          >
                            Disable
                          </Menu.Item>
                        )}
                        {client.status === "disabled" && (
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
                            Enable
                          </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item
                          leftSection={<IconTrash size={16} />}
                          color="red"
                          onClick={() => confirmDelete(client)}
                        >
                          Delete
                        </Menu.Item>
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
    </>
  );
}

function StatusBadge({ status }: { status: McpClientStatus }) {
  const colors: Record<McpClientStatus, string> = {
    active: "green",
    disabled: "gray",
    expired: "red",
  };
  return (
    <Badge color={colors[status]} variant="light">
      {status}
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
