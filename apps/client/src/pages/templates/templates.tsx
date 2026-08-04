import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Pagination,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconAlertCircle,
  IconArchive,
  IconPlus,
  IconSearch,
  IconTemplate,
  IconTrash,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CreateTemplateModal } from "@/features/template/components/create-template-modal";
import {
  useArchiveTemplateMutation,
  useDeleteTemplateMutation,
  useTemplatesQuery,
} from "@/features/template/queries/template-query";
import type {
  ITemplate,
  TemplateStatus,
} from "@/features/template/types/template.types";
import { canManageTemplate } from "@/features/template/utils/template-permission";
import { getAppName } from "@/lib/config";
import { timeAgo } from "@/lib/time";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import useUserRole from "@/hooks/use-user-role";
import classes from "./templates.module.css";

const STATUS_COLORS: Record<TemplateStatus, string> = {
  draft: "gray",
  published: "green",
  archived: "orange",
};

export default function TemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspace = useAtomValue(workspaceAtom);
  const { isAdmin } = useUserRole();
  const canCreateTemplates =
    isAdmin || workspace?.settings?.templates?.allowMemberTemplates === true;
  const allowMemberTemplates =
    workspace?.settings?.templates?.allowMemberTemplates === true;
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const spaceRoleById = new Map(
    (spaces?.items ?? []).map((space) => [space.id, space.membership?.role]),
  );
  const archiveMutation = useArchiveTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();
  const [createOpened, { open: openCreate, close: closeCreate }] =
    useDisclosure(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 250);
  const [status, setStatus] = useState<TemplateStatus | "all">("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);
  const { data, isLoading, isFetching, isError } = useTemplatesQuery({
    query: debouncedQuery || undefined,
    status: status === "all" ? undefined : status,
    cursor,
    limit: 30,
  });

  const goNext = () => {
    if (!data?.meta.nextCursor) return;
    setHistory((current) => [...current, cursor ?? ""]);
    setCursor(data.meta.nextCursor);
  };
  const goPrevious = () => {
    const previous = history.at(-1);
    setHistory((current) => current.slice(0, -1));
    setCursor(previous || undefined);
  };

  const archive = (template: ITemplate) =>
    modals.openConfirmModal({
      title: t("Archive template"),
      children: t("Archived templates can no longer create pages."),
      labels: { confirm: t("Archive"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: async () => {
        await archiveMutation.mutateAsync({
          templateId: template.id,
          expectedUpdatedAt: template.updatedAt,
        });
      },
    });

  const remove = (template: ITemplate) =>
    modals.openConfirmModal({
      title: t("Delete template"),
      children: t("Are you sure you want to delete this template?"),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        await deleteMutation.mutateAsync({
          templateId: template.id,
          expectedUpdatedAt: template.updatedAt,
        });
      },
    });

  return (
    <>
      <Helmet>
        <title>
          {t("Templates")} - {getAppName()}
        </title>
      </Helmet>
      <Container size={980} py="xl">
        <Group justify="space-between" mb="xl" align="flex-start">
          <div>
            <Title order={1} size="h3">
              {t("Templates")}
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              {t("Reusable page structures for people, MCP, and API clients.")}
            </Text>
          </div>
          {canCreateTemplates && (
            <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
              {t("New template")}
            </Button>
          )}
        </Group>

        <Group mb="lg" align="flex-end" wrap="wrap">
          <TextInput
            aria-label={t("Search templates...")}
            placeholder={t("Search templates...")}
            leftSection={<IconSearch size={16} />}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setCursor(undefined);
              setHistory([]);
            }}
            className={classes.search}
          />
          <SegmentedControl
            aria-label={t("Template status")}
            value={status}
            onChange={(value) => {
              setStatus(value as TemplateStatus | "all");
              setCursor(undefined);
              setHistory([]);
            }}
            data={[
              { value: "all", label: t("All") },
              { value: "draft", label: t("Draft") },
              { value: "published", label: t("Published") },
              { value: "archived", label: t("Archived") },
            ]}
          />
          {isFetching && !isLoading && <Loader size="xs" />}
        </Group>

        {isError ? (
          <Center mih={260}>
            <Alert
              icon={<IconAlertCircle size={18} />}
              title={t("Templates could not be loaded")}
              color="red"
            >
              {t("Please refresh the page and try again.")}
            </Alert>
          </Center>
        ) : isLoading ? (
          <Center mih={260}>
            <Loader size="sm" />
          </Center>
        ) : data?.items.length ? (
          <Stack gap={0} className={classes.list}>
            {data.items.map((template) => {
              const canManage = canManageTemplate({
                isAdmin,
                allowMemberTemplates,
                spaceId: template.spaceId,
                spaceRole: template.spaceId
                  ? spaceRoleById.get(template.spaceId)
                  : undefined,
              });

              return (
                <TemplateRow
                  key={template.id}
                  template={template}
                  canManage={canManage}
                  archivePending={
                    archiveMutation.isPending &&
                    archiveMutation.variables?.templateId === template.id
                  }
                  deletePending={
                    deleteMutation.isPending &&
                    deleteMutation.variables?.templateId === template.id
                  }
                  onClick={() => navigate(`/templates/${template.id}`)}
                  onArchive={() => archive(template)}
                  onDelete={() => remove(template)}
                />
              );
            })}
          </Stack>
        ) : (
          <Center mih={260}>
            <Stack align="center" gap="xs">
              <IconTemplate size={34} stroke={1.5} />
              <Text fw={500}>{t("No templates found")}</Text>
              <Text size="sm" c="dimmed">
                {query
                  ? t("Try a different search term.")
                  : t("Create a template to standardize repeated work.")}
              </Text>
            </Stack>
          </Center>
        )}

        {(data?.meta.hasNextPage || history.length > 0) && (
          <Group justify="center" mt="xl">
            <Pagination.Root
              total={history.length + (data?.meta.hasNextPage ? 2 : 1)}
              value={history.length + 1}
            >
              <Group gap="xs">
                <Pagination.Previous
                  disabled={!history.length}
                  onClick={goPrevious}
                />
                <Pagination.Next
                  disabled={!data?.meta.hasNextPage}
                  onClick={goNext}
                />
              </Group>
            </Pagination.Root>
          </Group>
        )}
      </Container>
      <CreateTemplateModal opened={createOpened} onClose={closeCreate} />
    </>
  );
}

function TemplateRow({
  template,
  canManage,
  archivePending,
  deletePending,
  onClick,
  onArchive,
  onDelete,
}: {
  template: ITemplate;
  canManage: boolean;
  archivePending: boolean;
  deletePending: boolean;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Box className={classes.row}>
      <UnstyledButton className={classes.rowMain} onClick={onClick}>
        <Box className={classes.icon}>
          <IconTemplate size={18} />
        </Box>
        <div className={classes.summary}>
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} size="sm" lineClamp={1}>
              {template.title}
            </Text>
            <Badge
              className={classes.statusBadge}
              size="xs"
              variant="light"
              color={STATUS_COLORS[template.status]}
            >
              {t(
                template.status === "published"
                  ? "Published"
                  : template.status === "archived"
                    ? "Archived"
                    : "Draft",
              )}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed" lineClamp={1}>
            {template.purpose || template.description || t("No description")}
          </Text>
        </div>
      </UnstyledButton>
      <Group className={classes.metaAndActions} gap="xs" wrap="nowrap">
        <Group className={classes.meta} gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {template.spaceId ? t("Space template") : t("Global")}
          </Text>
          <Text size="xs" c="dimmed">
            {timeAgo(new Date(template.updatedAt))}
          </Text>
        </Group>
        {canManage && (
          <Group className={classes.actions} gap={2} wrap="nowrap">
            <Tooltip
              label={
                template.status === "archived" ? t("Archived") : t("Archive")
              }
              withArrow
            >
              <ActionIcon
                variant="subtle"
                color="orange"
                aria-label={t("Archive template")}
                disabled={template.status === "archived" || deletePending}
                loading={archivePending}
                onClick={onArchive}
              >
                <IconArchive size={17} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Delete")} withArrow>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("Delete template")}
                disabled={archivePending}
                loading={deletePending}
                onClick={onDelete}
              >
                <IconTrash size={17} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
    </Box>
  );
}
