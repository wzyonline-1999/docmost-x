import {
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconTemplate } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { useCreateTemplateMutation } from "@/features/template/queries/template-query";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import useUserRole from "@/hooks/use-user-role";
import { SpaceRole } from "@/lib/types";

interface CreateTemplateModalProps {
  opened: boolean;
  onClose: () => void;
  initialSpaceId?: string;
}

export function CreateTemplateModal({
  opened,
  onClose,
  initialSpaceId,
}: CreateTemplateModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspace = useAtomValue(workspaceAtom);
  const { isAdmin } = useUserRole();
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const createMutation = useCreateTemplateMutation();
  const canCreateSpaceTemplate =
    isAdmin || workspace?.settings?.templates?.allowMemberTemplates === true;
  const writableSpaces = (spaces?.items ?? []).filter(
    (space) =>
      isAdmin ||
      (space.membership?.role && space.membership.role !== SpaceRole.READER),
  );
  const form = useForm({
    initialValues: {
      title: "",
      purpose: "",
      spaceId: initialSpaceId ?? (isAdmin ? "global" : ""),
    },
    validate: {
      title: (value) => (value.trim() ? null : t("Title is required")),
      purpose: (value) => (value.trim() ? null : t("Purpose is required")),
      spaceId: (value) => (value ? null : t("Scope is required")),
    },
  });

  const scopeOptions = [
    ...(isAdmin ? [{ value: "global", label: t("Global") }] : []),
    ...(writableSpaces.map((space) => ({
      value: space.id,
      label: space.name,
    })) ?? []),
  ];

  const close = () => {
    form.reset();
    onClose();
  };

  const submit = form.onSubmit(async (values) => {
    if (!canCreateSpaceTemplate && values.spaceId !== "global") return;
    const result = await createMutation.mutateAsync({
      title: values.title.trim(),
      purpose: values.purpose.trim(),
      spaceId: values.spaceId === "global" ? undefined : values.spaceId,
      format: "json",
    });
    close();
    navigate(`/templates/${result.template.id}`);
  });

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("New template")}
      centered
      size="lg"
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label={t("Name")}
            required
            autoFocus
            maxLength={250}
            {...form.getInputProps("title")}
          />
          <Textarea
            label={t("Purpose")}
            description={t(
              "Tell people and AI what this template is meant to produce.",
            )}
            required
            autosize
            minRows={3}
            maxLength={2000}
            {...form.getInputProps("purpose")}
          />
          <Select
            label={t("Scope")}
            description={t("Choose which space this template belongs to")}
            data={scopeOptions}
            searchable
            required
            {...form.getInputProps("spaceId")}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              leftSection={<IconTemplate size={16} />}
              loading={createMutation.isPending}
            >
              {t("Create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
