import { Alert, Divider, List, Stack, Text } from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { McpConnectionGuide } from "./mcp-connection-guide";

export function McpAccessGuide() {
  const { t } = useTranslation();
  return (
    <Stack gap="lg" py="md">
      <Alert icon={<IconKey size={18} />} color="blue">
        {t(
          "MCP and HTTP API share the same clients, access tokens, representative users, space permissions, rate limits, and audit logs.",
        )}
      </Alert>

      <div>
        <Text fw={600} mb="xs">
          {t("Connect in three steps")}
        </Text>
        <List type="ordered" spacing="xs" size="sm">
          <List.Item>{t("Create a client and store its token.")}</List.Item>
          <List.Item>
            {t("Grant only the required space permissions.")}
          </List.Item>
          <List.Item>
            {t("Copy a configuration below into your MCP or API client.")}
          </List.Item>
        </List>
      </div>

      <Divider />
      <McpConnectionGuide />
    </Stack>
  );
}
