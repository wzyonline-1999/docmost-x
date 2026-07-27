import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Divider,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconKey } from "@tabler/icons-react";
import { useClipboard } from "@mantine/hooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IMcpClientTokenResponse } from "@/features/mcp/types/mcp.types";
import { McpConnectionGuide } from "./mcp-connection-guide";
import classes from "./mcp-settings.module.css";

type McpTokenModalProps = {
  response: IMcpClientTokenResponse | null;
  onClose: () => void;
};

export function McpTokenModal({ response, onClose }: McpTokenModalProps) {
  const { t } = useTranslation();
  const clipboard = useClipboard({ timeout: 1500 });
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null);
  const confirmed =
    Boolean(response?.token) && confirmedToken === response?.token;

  return (
    <Modal
      opened={Boolean(response)}
      onClose={() => undefined}
      title={t("Developer access token")}
      centered
      size="xl"
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
      classNames={{ body: classes.connectionModalBody }}
    >
      <Stack gap="md">
        <Alert color="yellow" icon={<IconKey size={18} />}>
          {t(
            "This MCP and API token is shown once. Store it in your password manager before closing this dialog.",
          )}
        </Alert>
        <div>
          <Text size="xs" c="dimmed">
            {t("Client")}
          </Text>
          <Text size="sm" fw={500}>
            {response?.client.name}
          </Text>
        </div>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Code block className={classes.tokenValue}>
            {response?.token ?? ""}
          </Code>
          <Tooltip label={clipboard.copied ? t("Copied") : t("Copy token")}>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("Copy access token")}
              disabled={!response?.token}
              onClick={() => clipboard.copy(response?.token ?? "")}
            >
              {clipboard.copied ? (
                <IconCheck size={18} />
              ) : (
                <IconCopy size={18} />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
        <Divider />
        <McpConnectionGuide
          token={response?.token}
          clientName={response?.client.name}
        />
        <Divider />
        <Checkbox
          checked={confirmed}
          onChange={(event) =>
            setConfirmedToken(
              event.currentTarget.checked ? (response?.token ?? null) : null,
            )
          }
          label={t("I stored this token in a secure password manager.")}
        />
        <Group justify="flex-end">
          <Button disabled={!confirmed} onClick={onClose}>
            {t("Done")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
