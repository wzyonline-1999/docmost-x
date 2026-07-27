import { Tabs } from "@mantine/core";
import {
  IconBook2,
  IconHistory,
  IconKey,
  IconShieldLock,
} from "@tabler/icons-react";
import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { McpAuditLog } from "@/features/mcp/components/mcp-audit-log";
import { McpAccessGuide } from "@/features/mcp/components/mcp-access-guide";
import { McpClientFormModal } from "@/features/mcp/components/mcp-client-form-modal";
import { McpClientList } from "@/features/mcp/components/mcp-client-list";
import { McpConnectionModal } from "@/features/mcp/components/mcp-connection-modal";
import { McpPermissions } from "@/features/mcp/components/mcp-permissions";
import { McpTokenModal } from "@/features/mcp/components/mcp-token-modal";
import {
  IMcpClient,
  IMcpClientTokenResponse,
} from "@/features/mcp/types/mcp.types";
import { getAppName } from "@/lib/config";

export default function McpSettings() {
  const { t } = useTranslation();
  const [formOpened, setFormOpened] = useState(false);
  const [editingClient, setEditingClient] = useState<IMcpClient | null>(null);
  const [configClient, setConfigClient] = useState<IMcpClient | null>(null);
  const [tokenResponse, setTokenResponse] =
    useState<IMcpClientTokenResponse | null>(null);

  const openCreate = () => {
    setEditingClient(null);
    setFormOpened(true);
  };
  const openEdit = (client: IMcpClient) => {
    setEditingClient(client);
    setFormOpened(true);
  };
  const closeForm = () => {
    setFormOpened(false);
    setEditingClient(null);
  };

  return (
    <>
      <Helmet>
        <title>MCP / API - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title="MCP / API" />
      <Tabs defaultValue="clients" keepMounted={false}>
        <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
          <Tabs.Tab value="clients" leftSection={<IconKey size={17} />}>
            {t("Clients")}
          </Tabs.Tab>
          <Tabs.Tab
            value="permissions"
            leftSection={<IconShieldLock size={17} />}
          >
            {t("Permissions")}
          </Tabs.Tab>
          <Tabs.Tab value="guide" leftSection={<IconBook2 size={17} />}>
            {t("Connection guide")}
          </Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconHistory size={17} />}>
            {t("Audit")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="clients" pt="sm">
          <McpClientList
            onCreate={openCreate}
            onEdit={openEdit}
            onConfigure={setConfigClient}
            onToken={setTokenResponse}
          />
        </Tabs.Panel>
        <Tabs.Panel value="permissions" pt="sm">
          <McpPermissions />
        </Tabs.Panel>
        <Tabs.Panel value="guide" pt="sm">
          <McpAccessGuide />
        </Tabs.Panel>
        <Tabs.Panel value="audit" pt="sm">
          <McpAuditLog />
        </Tabs.Panel>
      </Tabs>

      <McpClientFormModal
        opened={formOpened}
        client={editingClient}
        onClose={closeForm}
        onToken={setTokenResponse}
      />
      <McpTokenModal
        key={tokenResponse?.client.updatedAt ?? "closed"}
        response={tokenResponse}
        onClose={() => setTokenResponse(null)}
      />
      <McpConnectionModal
        client={configClient}
        onClose={() => setConfigClient(null)}
      />
    </>
  );
}
