import { Button, Group, Modal, Stack } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { IMcpClient } from "@/features/mcp/types/mcp.types";
import { McpConnectionGuide } from "./mcp-connection-guide";
import classes from "./mcp-settings.module.css";

type McpConnectionModalProps = {
  client: IMcpClient | null;
  onClose: () => void;
};

export function McpConnectionModal({
  client,
  onClose,
}: McpConnectionModalProps) {
  const { t } = useTranslation();
  return (
    <Modal
      opened={Boolean(client)}
      onClose={onClose}
      title={t("Connect client")}
      size="xl"
      centered
      classNames={{ body: classes.connectionModalBody }}
    >
      <Stack gap="lg">
        <McpConnectionGuide clientName={client?.name} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t("Close")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
