import { Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query";
import {
  useCreateMcpClientMutation,
  useUpdateMcpClientMutation,
} from "@/features/mcp/queries/mcp-query";
import {
  IMcpClient,
  IMcpClientTokenResponse,
  McpClientStatus,
} from "@/features/mcp/types/mcp.types";

type McpClientFormModalProps = {
  opened: boolean;
  client: IMcpClient | null;
  onClose: () => void;
  onToken: (response: IMcpClientTokenResponse) => void;
};

type FormValues = {
  name: string;
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
  const membersQuery = useWorkspaceMembersQuery({ limit: 100 });
  const createMutation = useCreateMcpClientMutation();
  const updateMutation = useUpdateMcpClientMutation();
  const form = useForm<FormValues>({
    initialValues: {
      name: "",
      actorUserId: null,
      expiresAt: "",
      status: "active",
    },
    validate: {
      name: (value) => (value.trim() ? null : "Name is required"),
    },
  });

  useEffect(() => {
    if (!opened) return;
    form.setValues({
      name: client?.name ?? "",
      actorUserId: client?.actorUserId ?? null,
      expiresAt: client?.expiresAt
        ? toLocalDateTimeInput(client.expiresAt)
        : "",
      status: client?.status === "disabled" ? "disabled" : "active",
    });
    form.resetDirty();
  }, [opened, client?.id]);

  const actorOptions =
    membersQuery.data?.items.map((member) => ({
      value: member.id,
      label: `${member.name} (${member.email})`,
    })) ?? [];
  const pending = createMutation.isPending || updateMutation.isPending;

  const submit = form.onSubmit(async (values) => {
    const expiresAt = values.expiresAt
      ? new Date(values.expiresAt).toISOString()
      : null;
    if (client) {
      await updateMutation.mutateAsync({
        clientId: client.id,
        name: values.name.trim(),
        actorUserId: values.actorUserId,
        expiresAt,
        status: values.status,
      });
      onClose();
      return;
    }

    const response = await createMutation.mutateAsync({
      name: values.name.trim(),
      actorUserId: values.actorUserId,
      expiresAt: expiresAt ?? undefined,
      permissions: [],
    });
    onClose();
    onToken(response);
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={client ? "Edit MCP client" : "Create MCP client"}
      centered
      closeOnClickOutside={!pending}
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="Codex knowledge access"
            maxLength={120}
            required
            {...form.getInputProps("name")}
          />
          <Select
            label="Actor user"
            description="Native Docmost page permissions are evaluated as this user."
            placeholder="Select a workspace member"
            data={actorOptions}
            searchable
            clearable
            disabled={membersQuery.isLoading}
            {...form.getInputProps("actorUserId")}
          />
          <TextInput
            type="datetime-local"
            label="Expires at"
            description="Leave empty for no expiration."
            min={toLocalDateTimeInput(new Date().toISOString())}
            {...form.getInputProps("expiresAt")}
          />
          {client && (
            <Select
              label="Status"
              data={[
                { value: "active", label: "Active" },
                { value: "disabled", label: "Disabled" },
              ]}
              allowDeselect={false}
              {...form.getInputProps("status")}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {client ? "Save" : "Create"}
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
