import {
  ActionIcon,
  Code,
  Group,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconEye, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import NoTableResults from "@/components/common/no-table-results";
import {
  useMcpAuditLogsQuery,
  useMcpClientsQuery,
} from "@/features/mcp/queries/mcp-query";
import { IMcpAuditLog } from "@/features/mcp/types/mcp.types";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import classes from "./mcp-settings.module.css";

export function McpAuditLog() {
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [event, setEvent] = useState("");
  const [toolName, setToolName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedLog, setSelectedLog] = useState<IMcpAuditLog | null>(null);
  const [debouncedQuery] = useDebouncedValue(query.trim(), 300);
  const [debouncedEvent] = useDebouncedValue(event.trim(), 300);
  const [debouncedToolName] = useDebouncedValue(toolName.trim(), 300);
  const clientsQuery = useMcpClientsQuery({ limit: 100 });
  const spacesQuery = useGetSpacesQuery({ limit: 100 });
  const logsQuery = useMcpAuditLogsQuery({
    query: debouncedQuery || undefined,
    clientId: clientId ?? undefined,
    spaceId: spaceId ?? undefined,
    event: debouncedEvent || undefined,
    toolName: debouncedToolName || undefined,
    from: toIsoDate(from),
    to: toIsoDate(to),
    limit: 100,
  });
  const clientNames = useMemo(
    () =>
      new Map(
        clientsQuery.data?.items.map((client) => [client.id, client.name]) ??
          [],
      ),
    [clientsQuery.data],
  );
  const clientOptions =
    clientsQuery.data?.items.map((client) => ({
      value: client.id,
      label: client.name,
    })) ?? [];
  const spaceOptions =
    spacesQuery.data?.items.map((space) => ({
      value: space.id,
      label: space.name,
    })) ?? [];

  return (
    <>
      <div className={classes.filters}>
        <TextInput
          label="Search"
          placeholder="Event, tool, resource or request ID"
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(input) => setQuery(input.currentTarget.value)}
        />
        <Select
          label="Client"
          placeholder="All clients"
          data={clientOptions}
          value={clientId}
          onChange={(value) =>
            setClientId(typeof value === "string" ? value : null)
          }
          searchable
          clearable
        />
        <Select
          label="Space"
          placeholder="All spaces"
          data={spaceOptions}
          value={spaceId}
          onChange={(value) =>
            setSpaceId(typeof value === "string" ? value : null)
          }
          searchable
          clearable
        />
        <TextInput
          label="Event"
          placeholder="mcp.page.update"
          value={event}
          onChange={(input) => setEvent(input.currentTarget.value)}
        />
        <TextInput
          label="Tool"
          placeholder="update_page"
          value={toolName}
          onChange={(input) => setToolName(input.currentTarget.value)}
        />
        <Group grow align="flex-end" wrap="nowrap">
          <TextInput
            type="datetime-local"
            label="From"
            value={from}
            onChange={(input) => setFrom(input.currentTarget.value)}
          />
          <TextInput
            type="datetime-local"
            label="To"
            value={to}
            min={from || undefined}
            onChange={(input) => setTo(input.currentTarget.value)}
          />
        </Group>
      </div>

      <Table.ScrollContainer minWidth={980}>
        <Table verticalSpacing="sm" highlightOnHover layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="19%">Time</Table.Th>
              <Table.Th w="22%">Event</Table.Th>
              <Table.Th w="18%">Client</Table.Th>
              <Table.Th w="18%">Tool</Table.Th>
              <Table.Th w="17%">Resource</Table.Th>
              <Table.Th w={56}>
                <VisuallyHidden>Details</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {logsQuery.isLoading ? (
              <Table.Tr>
                <Table.Td colSpan={6} ta="center" py="xl">
                  <Loader size="sm" />
                </Table.Td>
              </Table.Tr>
            ) : logsQuery.data?.items.length ? (
              logsQuery.data.items.map((log) => (
                <Table.Tr key={log.id}>
                  <Table.Td>
                    <Text size="sm">{formatDate(log.createdAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500} lineClamp={1} title={log.event}>
                      {log.event}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {log.clientId
                        ? (clientNames.get(log.clientId) ?? "Deleted client")
                        : "Administrator"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1} title={log.toolName}>
                      {log.toolName}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {log.resourceType}
                      {log.resourceId ? ` / ${log.resourceId}` : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label="View audit details">
                      <ActionIcon
                        variant="subtle"
                        aria-label={`View details for ${log.event}`}
                        onClick={() => setSelectedLog(log)}
                      >
                        <IconEye size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))
            ) : (
              <NoTableResults colSpan={6} />
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <AuditDetailModal
        log={selectedLog}
        onClose={() => setSelectedLog(null)}
      />
    </>
  );
}

function AuditDetailModal({
  log,
  onClose,
}: {
  log: IMcpAuditLog | null;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={Boolean(log)}
      onClose={onClose}
      title="Audit log details"
      size="xl"
      centered
    >
      {log && (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <AuditField label="Time" value={formatDate(log.createdAt)} />
            <AuditField label="Event" value={log.event} />
            <AuditField label="Tool" value={log.toolName} />
            <AuditField label="Request ID" value={log.requestId} />
            <AuditField label="Client ID" value={log.clientId} />
            <AuditField label="Actor ID" value={log.actorUserId} />
            <AuditField label="Space ID" value={log.spaceId} />
            <AuditField label="IP address" value={log.ipAddress} />
            <AuditField label="Resource type" value={log.resourceType} />
            <AuditField label="Resource ID" value={log.resourceId} />
          </SimpleGrid>
          <AuditJson label="Before" value={log.before} />
          <AuditJson label="After" value={log.after} />
          <AuditJson label="Metadata" value={log.metadata} />
        </Stack>
      )}
    </Modal>
  );
}

function AuditField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" className={classes.breakValue}>
        {value || "Not recorded"}
      </Text>
    </div>
  );
}

function AuditJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <Text size="sm" fw={500} mb={4}>
        {label}
      </Text>
      <Code block className={classes.jsonValue}>
        {stringifyAuditValue(value)}
      </Code>
    </div>
  );
}

function stringifyAuditValue(value: unknown): string {
  if (value === null || typeof value === "undefined") return "Not recorded";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "Unable to display this value";
  }
}

function toIsoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
