import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDebouncedValue } from "@mantine/hooks";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query";
import {
  useCreateMcpClientMutation,
  useUpdateMcpClientMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpClient,
  IMcpClientTokenResponse,
  McpClientScope,
  McpClientStatus,
} from "@/features/mcp/types/mcp.types";
import useUserRole from "@/hooks/use-user-role";

type McpClientFormModalProps = {
  opened: boolean;
  client: IMcpClient | null;
  onClose: () => void;
  onToken: (response: IMcpClientTokenResponse) => void;
};

type FormValues = {
  name: string;
  scope: McpClientScope;
  actorUserId: string | null;
  expiresAt: string;
  status: McpClientStatus;
};

export function McpClientFormModal({
  opened,
  client,
  onClose,
  onToken,
}: McpClientFormModalProps) {
  const { t } = useTranslation();
  const currentUser = useAtomValue(currentUserAtom);
  const { isOwner } = useUserRole();
  const [actorSearch, setActorSearch] = useState("");
  const [debouncedActorSearch] = useDebouncedValue(actorSearch.trim(), 300);
  const membersQuery = useWorkspaceMembersQuery({
    query: debouncedActorSearch || undefined,
    limit: 25,
  });
  const createMutation = useCreateMcpClientMutation();
  const updateMutation = useUpdateMcpClientMutation();
  const form = useForm<FormValues>({
    initialValues: {
      name: "",
      scope: "personal",
      actorUserId: null,
      expiresAt: "",
      status: "active",
    },
    validate: {
      name: (value) => (value.trim() ? null : t("Name is required")),
    },
  });

  useEffect(() => {
    if (!opened) return;
    form.setValues({
      name: client?.name ?? "",
      scope: client?.scope ?? "personal",
      actorUserId: client
        ? client.scope === "personal"
          ? (client.actorUserId ?? client.ownerUserId)
          : client.actorUserId
        : (currentUser?.user.id ?? null),
      expiresAt: client?.expiresAt
        ? toLocalDateTimeInput(client.expiresAt)
        : "",
      status: client?.status === "disabled" ? "disabled" : "active",
    });
    form.resetDirty();
  }, [opened, client?.id, currentUser?.user.id]);

  const actorOptions = useMemo(() => {
    const options =
      membersQuery.data?.items.map((member) => ({
        value: member.id,
        label: `${member.name} (${member.email})`,
      })) ?? [];
    const selectedActorId = form.values.actorUserId;
    if (
      selectedActorId &&
      !options.some((option) => option.value === selectedActorId)
    ) {
      options.unshift({
        value: selectedActorId,
        label: `${t("Current representative user")} (${selectedActorId.slice(
          0,
          8,
        )})`,
      });
    }
    return options;
  }, [form.values.actorUserId, membersQuery.data?.items, t]);
  const pending = createMutation.isPending || updateMutation.isPending;
  const closeModal = () => {
    setActorSearch("");
    onClose();
  };

  const submit = form.onSubmit(async (values) => {
    const expiresAt = values.expiresAt
      ? new Date(values.expiresAt).toISOString()
      : null;
    try {
      if (client) {
        await updateMutation.mutateAsync({
          clientId: client.id,
          name: values.name.trim(),
          actorUserId: values.actorUserId,
          expiresAt,
          status: values.status,
        });
        closeModal();
        return;
      }

      const response = await createMutation.mutateAsync({
        name: values.name.trim(),
        scope: values.scope,
        actorUserId:
          values.scope === "personal"
            ? currentUser?.user.id
            : values.actorUserId,
        expiresAt: expiresAt ?? undefined,
        permissions: [],
      });
      closeModal();
      onToken(response);
    } catch {
      // Mutation hooks display the server error and keep the form open.
    }
  });

  return (
    <Modal
      opened={opened}
      onClose={pending ? () => undefined : closeModal}
      title={client ? t("Edit access client") : t("Create access client")}
      centered
      closeOnClickOutside={!pending}
      closeOnEscape={!pending}
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label={t("Name")}
            placeholder={t("Codex knowledge access")}
            maxLength={120}
            required
            {...form.getInputProps("name")}
          />
          <Select
            label={t("Ownership")}
            description={
              form.values.scope === "personal"
                ? t("Only you can manage or rotate this client.")
                : t("Only the workspace owner can manage this shared client.")
            }
            data={[
              { value: "personal", label: t("Personal client") },
              { value: "workspace", label: t("Workspace client") },
            ]}
            allowDeselect={false}
            disabled={Boolean(client) || !isOwner}
            value={form.values.scope}
            onChange={(value) => {
              const scope = (value ?? "personal") as McpClientScope;
              form.setFieldValue("scope", scope);
              form.setFieldValue(
                "actorUserId",
                scope === "personal" ? (currentUser?.user.id ?? null) : null,
              );
            }}
          />
          {membersQuery.isError && form.values.scope === "workspace" && (
            <Alert
              icon={<IconAlertCircle size={17} />}
              color="red"
              title={t("Workspace members could not be loaded")}
            >
              <Group justify="space-between" align="center" wrap="wrap">
                <Text size="sm">
                  {t("Check the connection and try loading members again.")}
                </Text>
                <Button
                  variant="light"
                  color="red"
                  size="xs"
                  leftSection={<IconRefresh size={14} />}
                  onClick={() => membersQuery.refetch()}
                >
                  {t("Retry")}
                </Button>
              </Group>
            </Alert>
          )}
          <Select
            label={t("Representative user")}
            description={
              form.values.scope === "personal"
                ? t("Personal clients always use your Docmost permissions.")
                : t(
                    "Native Docmost page permissions are evaluated as this user.",
                  )
            }
            placeholder={t("Search workspace members")}
            data={actorOptions}
            searchValue={actorSearch}
            onSearchChange={setActorSearch}
            nothingFoundMessage={t("No members found")}
            searchable
            clearable
            rightSection={
              membersQuery.isFetching &&
              form.values.scope === "workspace" && <Loader size={14} />
            }
            disabled={membersQuery.isError || form.values.scope === "personal"}
            {...form.getInputProps("actorUserId")}
          />
          <TextInput
            type="datetime-local"
            label={t("Expires at")}
            description={t("Leave empty for no expiration.")}
            min={toLocalDateTimeInput(new Date().toISOString())}
            {...form.getInputProps("expiresAt")}
          />
          {client && (
            <Select
              label={t("Status")}
              data={[
                { value: "active", label: t("Active") },
                { value: "disabled", label: t("Disabled") },
              ]}
              allowDeselect={false}
              {...form.getInputProps("status")}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={closeModal} disabled={pending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {client ? t("Save") : t("Create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
