import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconKey } from "@tabler/icons-react";
import { useClipboard } from "@mantine/hooks";
import { useState } from "react";
import { IMcpClientTokenResponse } from "@/features/mcp/types/mcp.types";
import classes from "./mcp-settings.module.css";

type McpTokenModalProps = {
  response: IMcpClientTokenResponse | null;
  onClose: () => void;
};

export function McpTokenModal({ response, onClose }: McpTokenModalProps) {
  const clipboard = useClipboard({ timeout: 1500 });
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Modal
      opened={Boolean(response)}
      onClose={() => undefined}
      title="MCP bearer token"
      centered
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
    >
      <Stack gap="md">
        <Alert color="yellow" icon={<IconKey size={18} />}>
          This token is shown once. Store it in your password manager before
          closing this dialog.
        </Alert>
        <Text size="sm" fw={500}>
          {response?.client.name}
        </Text>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Code block className={classes.tokenValue}>
            {response?.token ?? ""}
          </Code>
          <Tooltip label={clipboard.copied ? "Copied" : "Copy token"}>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Copy MCP token"
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
        <Checkbox
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
          label="I stored this token in a secure password manager."
        />
        <Group justify="flex-end">
          <Button disabled={!confirmed} onClick={onClose}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
