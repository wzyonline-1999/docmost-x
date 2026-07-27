import {
  Accordion,
  ActionIcon,
  Alert,
  Button,
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
import {
  IconExclamationCircle,
  IconEye,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import NoTableResults from "@/components/common/no-table-results";
import Paginate from "@/components/common/paginate";
import {
  useMcpAuditLogsQuery,
  useMcpClientsQuery,
} from "@/features/mcp/queries/mcp-query";
import { IMcpAuditLog } from "@/features/mcp/types/mcp.types";
import { buildMcpAuditDiff } from "@/features/mcp/utils/mcp-audit-utils";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import classes from "./mcp-settings.module.css";

type AuditSelectOption = {
  value: string;
  label: string;
};

export function McpAuditLog() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [spaceSearch, setSpaceSearch] = useState("");
  const [selectedClientOption, setSelectedClientOption] =
    useState<AuditSelectOption | null>(null);
  const [selectedSpaceOption, setSelectedSpaceOption] =
    useState<AuditSelectOption | null>(null);
  const [event, setEvent] = useState("");
  const [toolName, setToolName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedLog, setSelectedLog] = useState<IMcpAuditLog | null>(null);
  const [debouncedQuery] = useDebouncedValue(query.trim(), 300);
  const [debouncedEvent] = useDebouncedValue(event.trim(), 300);
  const [debouncedToolName] = useDebouncedValue(toolName.trim(), 300);
  const [debouncedClientSearch] = useDebouncedValue(clientSearch.trim(), 300);
  const [debouncedSpaceSearch] = useDebouncedValue(spaceSearch.trim(), 300);
  const pagination = useCursorPaginate();
  const clientsQuery = useMcpClientsQuery({
    query: debouncedClientSearch || undefined,
    limit: 25,
  });
  const spacesQuery = useGetSpacesQuery({
    query: debouncedSpaceSearch || undefined,
    limit: 25,
  });
  const logsQuery = useMcpAuditLogsQuery({
    query: debouncedQuery || undefined,
    clientId: clientId ?? undefined,
    spaceId: spaceId ?? undefined,
    event: debouncedEvent || undefined,
    toolName: debouncedToolName || undefined,
    from: toIsoDate(from),
    to: toIsoDate(to),
    cursor: pagination.cursor,
    limit: 25,
  });
  const loadedClientOptions =
    clientsQuery.data?.items.map((client) => ({
      value: client.id,
      label: client.name,
    })) ?? [];
  const loadedSpaceOptions =
    spacesQuery.data?.items.map((space) => ({
      value: space.id,
      label: space.name,
    })) ?? [];
  const clientOptions = includeSelectedOption(
    loadedClientOptions,
    selectedClientOption,
  );
  const spaceOptions = includeSelectedOption(
    loadedSpaceOptions,
    selectedSpaceOption,
  );
  const clientNames = useMemo(
    () =>
      new Map(
        clientOptions.map((client) => [client.value, client.label] as const),
      ),
    [clientOptions],
  );

  const resetLogPage = () => pagination.resetCursor();

  return (
    <>
      <div className={classes.filters}>
        <TextInput
          label={t("Search")}
          placeholder={t("Event, tool, resource or request ID")}
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(input) => {
            setQuery(input.currentTarget.value);
            resetLogPage();
          }}
        />
        <Select
          label={t("Client")}
          placeholder={t("All clients")}
          data={clientOptions}
          value={clientId}
          onChange={(value) => {
            setClientId(typeof value === "string" ? value : null);
            setSelectedClientOption(
              loadedClientOptions.find((option) => option.value === value) ??
                null,
            );
            setClientSearch("");
            resetLogPage();
          }}
          searchValue={clientSearch}
          onSearchChange={setClientSearch}
          nothingFoundMessage={t("No clients found")}
          searchable
          clearable
        />
        <Select
          label={t("Space")}
          placeholder={t("All spaces")}
          data={spaceOptions}
          value={spaceId}
          onChange={(value) => {
            setSpaceId(typeof value === "string" ? value : null);
            setSelectedSpaceOption(
              loadedSpaceOptions.find((option) => option.value === value) ??
                null,
            );
            setSpaceSearch("");
            resetLogPage();
          }}
          searchValue={spaceSearch}
          onSearchChange={setSpaceSearch}
          nothingFoundMessage={t("No spaces found")}
          searchable
          clearable
        />
        <TextInput
          label={t("Event")}
          placeholder="mcp.page.update"
          value={event}
          onChange={(input) => {
            setEvent(input.currentTarget.value);
            resetLogPage();
          }}
        />
        <TextInput
          label={t("Tool")}
          placeholder="update_page"
          value={toolName}
          onChange={(input) => {
            setToolName(input.currentTarget.value);
            resetLogPage();
          }}
        />
        <Group grow align="flex-end" wrap="nowrap">
          <TextInput
            type="datetime-local"
            label={t("Start time")}
            value={from}
            max={to || undefined}
            onChange={(input) => {
              setFrom(input.currentTarget.value);
              resetLogPage();
            }}
          />
          <TextInput
            type="datetime-local"
            label={t("End time")}
            value={to}
            min={from || undefined}
            onChange={(input) => {
              setTo(input.currentTarget.value);
              resetLogPage();
            }}
          />
        </Group>
      </div>

      {logsQuery.isError ? (
        <Alert
          icon={<IconExclamationCircle size={18} />}
          color="red"
          title={t("Audit logs could not be loaded")}
        >
          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm">
              {t("Check the connection and try loading the audit log again.")}
            </Text>
            <Button
              variant="light"
              color="red"
              size="xs"
              leftSection={<IconRefresh size={15} />}
              onClick={() => logsQuery.refetch()}
            >
              {t("Retry")}
            </Button>
          </Group>
        </Alert>
      ) : (
        <>
          <Group justify="space-between" mb="xs">
            <Text size="xs" c="dimmed">
              {t("This page shows")} {logsQuery.data?.items.length ?? 0}{" "}
              {t("audit events")}
            </Text>
            {logsQuery.isFetching && !logsQuery.isLoading && (
              <Group gap={6}>
                <Loader size={13} />
                <Text size="xs" c="dimmed">
                  {t("Updating")}
                </Text>
              </Group>
            )}
          </Group>

          <Table.ScrollContainer minWidth={980}>
            <Table verticalSpacing="sm" highlightOnHover layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w="19%">{t("Time")}</Table.Th>
                  <Table.Th w="22%">{t("Event")}</Table.Th>
                  <Table.Th w="18%">{t("Client")}</Table.Th>
                  <Table.Th w="18%">{t("Tool")}</Table.Th>
                  <Table.Th w="17%">{t("Resource")}</Table.Th>
                  <Table.Th w={56}>
                    <VisuallyHidden>{t("Details")}</VisuallyHidden>
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
                        <Text
                          size="sm"
                          fw={500}
                          lineClamp={1}
                          title={log.event}
                        >
                          {log.event}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>
                          {log.clientId
                            ? (clientNames.get(log.clientId) ??
                              `${t("Client")} ${log.clientId.slice(0, 8)}`)
                            : t("Administrator")}
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
                        <Tooltip label={t("View audit details")}>
                          <ActionIcon
                            variant="subtle"
                            aria-label={`${t("View details for")} ${log.event}`}
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

          <Paginate
            hasPrevPage={logsQuery.data?.meta.hasPrevPage ?? false}
            hasNextPage={logsQuery.data?.meta.hasNextPage ?? false}
            onPrev={pagination.goPrev}
            onNext={() => pagination.goNext(logsQuery.data?.meta.nextCursor)}
          />
        </>
      )}

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
  const { t } = useTranslation();

  return (
    <Modal
      opened={Boolean(log)}
      onClose={onClose}
      title={t("Audit log details")}
      size="xl"
      centered
    >
      {log && (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <AuditField label={t("Time")} value={formatDate(log.createdAt)} />
            <AuditField label={t("Event")} value={log.event} />
            <AuditField label={t("Tool")} value={log.toolName} />
            <AuditField label={t("Request ID")} value={log.requestId} />
            <AuditField label={t("Client ID")} value={log.clientId} />
            <AuditField
              label={t("Representative user ID")}
              value={log.actorUserId}
            />
            <AuditField label={t("Space ID")} value={log.spaceId} />
            <AuditField label={t("IP address")} value={log.ipAddress} />
            <AuditField label={t("Resource type")} value={log.resourceType} />
            <AuditField label={t("Resource ID")} value={log.resourceId} />
          </SimpleGrid>

          <AuditDiff before={log.before} after={log.after} />

          <Accordion variant="contained" multiple>
            <Accordion.Item value="before">
              <Accordion.Control>{t("Raw before value")}</Accordion.Control>
              <Accordion.Panel>
                <AuditJson value={log.before} />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="after">
              <Accordion.Control>{t("Raw after value")}</Accordion.Control>
              <Accordion.Panel>
                <AuditJson value={log.after} />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="metadata">
              <Accordion.Control>{t("Metadata")}</Accordion.Control>
              <Accordion.Panel>
                <AuditJson value={log.metadata} />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      )}
    </Modal>
  );
}

function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const { t } = useTranslation();
  const changes = buildMcpAuditDiff(before, after);

  return (
    <div>
      <Text size="sm" fw={600} mb="xs">
        {t("Changes")}
      </Text>
      {changes.length ? (
        <Table.ScrollContainer minWidth={620}>
          <Table withTableBorder withColumnBorders verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="28%">{t("Field")}</Table.Th>
                <Table.Th w="36%">{t("Before")}</Table.Th>
                <Table.Th w="36%">{t("After")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {changes.map((change) => (
                <Table.Tr key={change.path}>
                  <Table.Td>
                    <Code>{change.path}</Code>
                  </Table.Td>
                  <Table.Td>
                    <AuditValue value={change.before} />
                  </Table.Td>
                  <Table.Td>
                    <AuditValue value={change.after} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          {t("No field changes were recorded for this event.")}
        </Text>
      )}
    </div>
  );
}

function AuditField({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation();
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" className={classes.breakValue}>
        {value || t("Not recorded")}
      </Text>
    </div>
  );
}

function AuditValue({ value }: { value: unknown }) {
  const { t } = useTranslation();
  return (
    <Code block className={classes.jsonValue}>
      {stringifyAuditValue(value, t("Not recorded"), t("Unable to display"))}
    </Code>
  );
}

function AuditJson({ value }: { value: unknown }) {
  const { t } = useTranslation();
  return (
    <Code block className={classes.jsonValue}>
      {stringifyAuditValue(value, t("Not recorded"), t("Unable to display"))}
    </Code>
  );
}

function stringifyAuditValue(
  value: unknown,
  emptyValue: string,
  errorValue: string,
): string {
  if (value === null || typeof value === "undefined") return emptyValue;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return errorValue;
  }
}

function includeSelectedOption(
  options: AuditSelectOption[],
  selected: AuditSelectOption | null,
): AuditSelectOption[] {
  if (!selected || options.some((option) => option.value === selected.value)) {
    return options;
  }
  return [selected, ...options];
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
