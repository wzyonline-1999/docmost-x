import {
  ActionIcon,
  Alert,
  Badge,
  Code,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import {
  IconApi,
  IconBraces,
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getDeveloperApiBaseUrl, getMcpPublicUrl } from "@/lib/config";
import {
  buildMcpConnectionSnippets,
  McpConnectionSnippets,
} from "@/features/mcp/utils/mcp-connection-config";
import classes from "./mcp-settings.module.css";

type ConnectionMode = "codex" | "json" | "api";

type McpConnectionGuideProps = {
  token?: string | null;
  clientName?: string | null;
};

export function McpConnectionGuide({
  token,
  clientName,
}: McpConnectionGuideProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ConnectionMode>("codex");
  const mcpUrl = getMcpPublicUrl();
  const apiBaseUrl = getDeveloperApiBaseUrl();
  const snippets = useMemo(
    () =>
      buildMcpConnectionSnippets({
        mcpUrl,
        apiBaseUrl,
        token,
      }),
    [apiBaseUrl, mcpUrl, token],
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Text fw={600}>{t("Connection setup")}</Text>
          <Text size="sm" c="dimmed">
            {t(
              "The same access token works for MCP and HTTP API calls with identical permissions and audit logs.",
            )}
          </Text>
        </div>
        {clientName && (
          <Badge variant="light" color="gray">
            {clientName}
          </Badge>
        )}
      </Group>

      {!token && (
        <Alert color="blue" icon={<IconInfoCircle size={18} />}>
          {t(
            "Existing tokens cannot be displayed again. Replace YOUR_ACCESS_TOKEN with the token stored in your password manager, or rotate the token.",
          )}
        </Alert>
      )}

      <CopyableCode label={t("MCP server URL")} value={mcpUrl} singleLine />

      <SegmentedControl
        fullWidth
        value={mode}
        onChange={(value) => setMode(value as ConnectionMode)}
        data={[
          {
            value: "codex",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconTerminal2 size={16} />
                <span>Codex</span>
              </Group>
            ),
          },
          {
            value: "json",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconBraces size={16} />
                <span>{t("MCP JSON")}</span>
              </Group>
            ),
          },
          {
            value: "api",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconApi size={16} />
                <span>HTTP API</span>
              </Group>
            ),
          },
        ]}
        aria-label={t("Connection type")}
        className={classes.connectionMode}
      />

      {mode === "codex" && <CodexSetup snippets={snippets} />}
      {mode === "json" && <JsonSetup snippets={snippets} />}
      {mode === "api" && (
        <ApiSetup apiBaseUrl={apiBaseUrl} snippets={snippets} />
      )}
    </Stack>
  );
}

function CodexSetup({ snippets }: { snippets: McpConnectionSnippets }) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t(
          "Expose the token as an environment variable, then run the Codex CLI command. The TOML block is available as a manual alternative.",
        )}
      </Text>
      <CopyableCode
        label={t("Token environment variable")}
        value={snippets.tokenEnvironment}
      />
      <CopyableCode
        label={t("Codex CLI command")}
        value={snippets.codexCliCommand}
      />
      <CopyableCode
        label={t("Manual Codex configuration")}
        value={snippets.codexConfig}
      />
    </Stack>
  );
}

function JsonSetup({ snippets }: { snippets: McpConnectionSnippets }) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t(
          "Use this JSON in MCP clients that support remote HTTP servers and custom headers.",
        )}
      </Text>
      <CopyableCode
        label={t("Generic MCP JSON")}
        value={snippets.genericMcpJson}
      />
    </Stack>
  );
}

function ApiSetup({
  apiBaseUrl,
  snippets,
}: {
  apiBaseUrl: string;
  snippets: McpConnectionSnippets;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <CopyableCode
        label={t("Developer API base URL")}
        value={apiBaseUrl}
        singleLine
      />
      <Text size="sm" c="dimmed">
        {t(
          "Use the bearer token in the Authorization header. Tool names and request arguments are identical to MCP.",
        )}
      </Text>
      <CopyableCode
        label={t("List available tools")}
        value={snippets.apiListToolsCurl}
      />
      <CopyableCode
        label={t("Search example")}
        value={snippets.apiSearchCurl}
      />
      <Text size="xs" c="dimmed">
        {t(
          "For write calls, send an Idempotency-Key header so retries cannot create duplicate changes.",
        )}
      </Text>
    </Stack>
  );
}

function CopyableCode({
  label,
  value,
  singleLine = false,
}: {
  label: string;
  value: string;
  singleLine?: boolean;
}) {
  const { t } = useTranslation();
  const clipboard = useClipboard({ timeout: 1500 });

  return (
    <div className={classes.connectionSnippet}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" fw={600} c="dimmed">
          {label}
        </Text>
        <Tooltip label={clipboard.copied ? t("Copied") : t("Copy")}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label={`${t("Copy")} ${label}`}
            onClick={() => clipboard.copy(value)}
          >
            {clipboard.copied ? (
              <IconCheck size={16} />
            ) : (
              <IconCopy size={16} />
            )}
          </ActionIcon>
        </Tooltip>
      </Group>
      <Code
        block
        className={
          singleLine ? classes.connectionCodeSingleLine : classes.connectionCode
        }
      >
        {value}
      </Code>
    </div>
  );
}
