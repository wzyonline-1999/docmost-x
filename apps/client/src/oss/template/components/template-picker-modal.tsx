import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconArrowLeft,
  IconExternalLink,
  IconSearch,
  IconTemplate,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { buildPageUrl } from "@/features/page/page.utils";
import { useSpaceQuery } from "@/features/space/queries/space-query";
import { TemplateVariableForm } from "@/features/template/components/template-variable-form";
import {
  useInstantiateTemplateMutation,
  useTemplatesQuery,
} from "@/features/template/queries/template-query";
import type { ITemplate } from "@/features/template/types/template.types";
import { getDefaultTemplateVariables } from "@/features/template/utils/template-variable-utils";
import classes from "./template-picker-modal.module.css";

interface TemplatePickerModalProps {
  opened: boolean;
  onClose: () => void;
  initialSpaceId: string;
}

export default function TemplatePickerModal({
  opened,
  onClose,
  initialSpaceId,
}: TemplatePickerModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 250);
  const [selected, setSelected] = useState<ITemplate | null>(null);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [title, setTitle] = useState("");
  const { data, isLoading } = useTemplatesQuery({
    query: debouncedQuery || undefined,
    status: "published",
    limit: 50,
  });
  const { data: targetSpace } = useSpaceQuery(initialSpaceId);
  const instantiateMutation = useInstantiateTemplateMutation();

  const selectTemplate = (template: ITemplate) => {
    setSelected(template);
    setVariables(getDefaultTemplateVariables(template.inputSchema));
    setTitle("");
  };

  const instantiate = async () => {
    if (!selected || !targetSpace) return;
    const result = await instantiateMutation.mutateAsync({
      templateId: selected.id,
      targetSpaceId: initialSpaceId,
      variables,
      title: title.trim() || undefined,
    });
    onClose();
    navigate(
      buildPageUrl(targetSpace.slug, result.page.slugId, result.page.title),
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={selected ? selected.title : t("Use a template")}
      size="lg"
      centered
    >
      {selected ? (
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start">
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconArrowLeft size={15} />}
              onClick={() => setSelected(null)}
            >
              {t("All templates")}
            </Button>
            <Badge variant="light">
              {t("Version {{version}}", {
                version: selected.currentVersion,
              })}
            </Badge>
          </Group>
          <div>
            <Text size="sm" fw={600}>
              {t("Purpose")}
            </Text>
            <Text size="sm" c="dimmed" mt={3}>
              {selected.purpose}
            </Text>
          </div>
          {selected.useWhen && (
            <div>
              <Text size="sm" fw={600}>
                {t("Use when")}
              </Text>
              <Text size="sm" c="dimmed" mt={3}>
                {selected.useWhen}
              </Text>
            </div>
          )}
          <TextInput
            label={t("Page title")}
            description={t("Leave empty to use the template title pattern.")}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          {Object.keys(selected.inputSchema.properties).length > 0 && (
            <TemplateVariableForm
              schema={selected.inputSchema}
              values={variables}
              onChange={setVariables}
              disabled={instantiateMutation.isPending}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              leftSection={<IconTemplate size={16} />}
              onClick={instantiate}
              loading={instantiateMutation.isPending}
            >
              {t("Use template")}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <TextInput
            aria-label={t("Search templates...")}
            placeholder={t("Search templates...")}
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoFocus
          />
          <ScrollArea h={420} type="auto">
            {isLoading ? (
              <Center h={240}>
                <Loader size="sm" />
              </Center>
            ) : data?.items.length ? (
              <Stack gap={0} className={classes.list}>
                {data.items.map((template) => (
                  <UnstyledButton
                    key={template.id}
                    className={classes.item}
                    onClick={() => selectTemplate(template)}
                  >
                    <IconTemplate size={18} />
                    <div className={classes.itemText}>
                      <Text fw={600} size="sm" lineClamp={1}>
                        {template.title}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {template.purpose}
                      </Text>
                    </div>
                  </UnstyledButton>
                ))}
              </Stack>
            ) : (
              <Center h={240}>
                <Stack align="center" gap="xs">
                  <IconTemplate size={30} stroke={1.5} />
                  <Text size="sm" fw={500}>
                    {t("No templates found")}
                  </Text>
                </Stack>
              </Center>
            )}
          </ScrollArea>
          <Button
            component={Link}
            to="/templates"
            variant="subtle"
            rightSection={<IconExternalLink size={15} />}
            onClick={onClose}
          >
            {t("Browse all templates")}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
