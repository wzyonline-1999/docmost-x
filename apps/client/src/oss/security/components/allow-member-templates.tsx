import { Group, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { updateWorkspace } from "@/features/workspace/services/workspace-service";
import useUserRole from "@/hooks/use-user-role";
import { getApiErrorMessage } from "@/lib/api-error";

export default function AllowMemberTemplates() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [loading, setLoading] = useState(false);
  const enabled = workspace?.settings?.templates?.allowMemberTemplates === true;

  const change = async (checked: boolean) => {
    setLoading(true);
    try {
      const updated = await updateWorkspace({
        allowMemberTemplates: checked,
      });
      setWorkspace(updated);
      notifications.show({ message: t("Template settings updated") });
    } catch (error) {
      notifications.show({
        message: getApiErrorMessage(
          error,
          t("Failed to update template settings"),
        ),
        color: "red",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Allow members to create templates")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Members can manage templates in spaces where they have edit access.",
          )}
        </Text>
      </div>
      <Switch
        aria-label={t("Allow members to create templates")}
        checked={enabled}
        disabled={!isAdmin || loading}
        onChange={(event) => void change(event.currentTarget.checked)}
      />
    </Group>
  );
}
