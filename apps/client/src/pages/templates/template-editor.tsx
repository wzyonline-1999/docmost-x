import "@/features/editor/styles/index.css";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  IconArchive,
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconDots,
  IconEye,
  IconSend,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { FixedToolbar } from "@/features/editor/components/fixed-toolbar/fixed-toolbar";
import { templateExtensions } from "@/features/editor/extensions/extensions";
import {
  useGetSpacesQuery,
  useSpaceQuery,
} from "@/features/space/queries/space-query";
import { TemplateSchemaEditor } from "@/features/template/components/template-schema-editor";
import { TemplateVariableForm } from "@/features/template/components/template-variable-form";
import {
  useArchiveTemplateMutation,
  useDeleteTemplateMutation,
  usePublishTemplateMutation,
  useRenderTemplateMutation,
  useTemplateQuery,
  useUpdateTemplateMutation,
} from "@/features/template/queries/template-query";
import type {
  IRenderedTemplate,
  ITemplate,
  ITemplateInputSchema,
} from "@/features/template/types/template.types";
import {
  getDefaultTemplateVariables,
  renameTemplateVariableInContent,
  renameTemplateVariableInText,
} from "@/features/template/utils/template-variable-utils";
import { canManageTemplate } from "@/features/template/utils/template-permission";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { getAppName } from "@/lib/config";
import useUserRole from "@/hooks/use-user-role";
import { SpaceRole } from "@/lib/types";
import ReadonlyPageEditor from "@/features/editor/readonly-page-editor";
import classes from "./template-editor.module.css";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

export default function TemplateEditorPage() {
  const { t } = useTranslation();
  const { templateId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useUserRole();
  const workspace = useAtomValue(workspaceAtom);
  const { data, isLoading, isError } = useTemplateQuery(templateId);
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const { data: templateSpace } = useSpaceQuery(data?.spaceId ?? "");
  const updateMutation = useUpdateTemplateMutation();
  const publishMutation = usePublishTemplateMutation();
  const archiveMutation = useArchiveTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();
  const renderMutation = useRenderTemplateMutation();
  const [draft, setDraft] = useState<ITemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(false);
  const [preview, setPreview] = useState<IRenderedTemplate | null>(null);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const hydrating = useRef(false);
  const hydratedTemplateId = useRef<string | null>(null);
  const contentBaseline = useRef("");
  const canManageCurrentTemplate = Boolean(
    data &&
    canManageTemplate({
      isAdmin,
      allowMemberTemplates:
        workspace?.settings?.templates?.allowMemberTemplates === true,
      spaceId: data.spaceId,
      spaceRole: templateSpace?.membership?.role,
    }),
  );

  const editor = useEditor({
    extensions: templateExtensions,
    content: EMPTY_DOC,
    editable: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { "aria-label": t("Template content") },
    },
    onUpdate: ({ editor: current }) => {
      if (hydrating.current || hydratedTemplateId.current !== templateId) {
        return;
      }
      const content = current.getJSON();
      if (JSON.stringify(content) === contentBaseline.current) return;
      setDraft((value) => (value ? { ...value, content } : value));
      setDirty(true);
    },
  });

  useEffect(() => {
    if (!data || !editor || dirty) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      hydrating.current = true;
      try {
        setDraft(structuredClone(data));
        editor.commands.setContent(data.content ?? EMPTY_DOC, {
          emitUpdate: false,
        });
        contentBaseline.current = JSON.stringify(editor.getJSON());
        hydratedTemplateId.current = data.id;
      } finally {
        hydrating.current = false;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [data, editor, dirty]);

  useEffect(() => {
    editor?.setEditable(canManageCurrentTemplate);
  }, [canManageCurrentTemplate, editor]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (isError) {
    return (
      <Center mih="60vh">
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={t("Template could not be loaded")}
          color="red"
        >
          <Button
            variant="subtle"
            mt="xs"
            onClick={() => navigate("/templates")}
          >
            {t("Back to templates")}
          </Button>
        </Alert>
      </Center>
    );
  }

  if (isLoading || !draft) {
    return (
      <Center mih="60vh">
        <Loader size="sm" />
      </Center>
    );
  }

  const patch = <K extends keyof ITemplate>(key: K, value: ITemplate[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setDirty(true);
  };

  const save = async (): Promise<ITemplate> => {
    if (!dirty) return draft;
    const result = await updateMutation.mutateAsync({
      templateId: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      title: draft.title,
      description: draft.description ?? "",
      purpose: draft.purpose,
      useWhen: draft.useWhen ?? "",
      tags: draft.tags,
      inputSchema: draft.inputSchema,
      titleTemplate: draft.titleTemplate ?? "",
      content: draft.content ?? EMPTY_DOC,
      format: "json",
      icon: draft.icon ?? "",
      spaceId: draft.spaceId ?? null,
    });
    contentBaseline.current = JSON.stringify(
      result.template.content ?? EMPTY_DOC,
    );
    setDraft(result.template);
    setDirty(false);
    if (result.warnings.length) {
      notifications.show({
        title: t("Template saved with warnings"),
        message: result.warnings.join("\n"),
        color: "orange",
      });
    }
    return result.template;
  };

  const publish = async () => {
    const saved = await save();
    const result = await publishMutation.mutateAsync({
      templateId: saved.id,
      expectedUpdatedAt: saved.updatedAt,
    });
    setDraft(result.template);
    setDirty(false);
    notifications.show({ message: t("Template published") });
  };

  const openPreview = async () => {
    const saved = await save();
    setDraft(saved);
    setVariables(getDefaultTemplateVariables(saved.inputSchema));
    setPreview(null);
    setPreviewOpened(true);
  };

  const renderPreview = async () => {
    const result = await renderMutation.mutateAsync({
      templateId: draft.id,
      variables,
      format: "json",
    });
    setPreview(result);
  };

  const archive = () =>
    modals.openConfirmModal({
      title: t("Archive template"),
      children: t("Archived templates can no longer create pages."),
      labels: { confirm: t("Archive"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: async () => {
        const saved = await save();
        const result = await archiveMutation.mutateAsync({
          templateId: saved.id,
          expectedUpdatedAt: saved.updatedAt,
        });
        setDraft(result);
        setDirty(false);
      },
    });

  const remove = () =>
    modals.openConfirmModal({
      title: t("Delete template"),
      children: t("Are you sure you want to delete this template?"),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        await deleteMutation.mutateAsync({
          templateId: draft.id,
          expectedUpdatedAt: draft.updatedAt,
        });
        navigate("/templates");
      },
    });

  const insertVariable = (name: string, markdown: boolean) => {
    if (!editor) return;
    if (markdown) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "paragraph",
          content: [{ type: "text", text: `{{{${name}}}}` }],
        })
        .run();
    } else {
      editor.chain().focus().insertContent(`{{${name}}}`).run();
    }
  };

  const renameVariable = (oldName: string, nextName: string) => {
    if (!editor) return;
    const content = renameTemplateVariableInContent(
      editor.getJSON(),
      oldName,
      nextName,
    );
    hydrating.current = true;
    editor.commands.setContent(content, { emitUpdate: false });
    hydrating.current = false;
    setDraft((current) =>
      current
        ? {
            ...current,
            titleTemplate: renameTemplateVariableInText(
              current.titleTemplate ?? "",
              oldName,
              nextName,
            ),
            content,
          }
        : current,
    );
    setDirty(true);
  };

  const scopeOptions = [
    ...(isAdmin ? [{ value: "global", label: t("Global") }] : []),
    ...(spaces?.items ?? [])
      .filter(
        (space) =>
          isAdmin ||
          (workspace?.settings?.templates?.allowMemberTemplates === true &&
            space.membership?.role !== SpaceRole.READER),
      )
      .map((space) => ({
        value: space.id,
        label: space.name,
      })),
  ];

  return (
    <>
      <Helmet>
        <title>
          {draft.title} - {getAppName()}
        </title>
      </Helmet>
      <div className={classes.page}>
        <header className={classes.header}>
          <Group
            justify="space-between"
            wrap="nowrap"
            className={classes.headerRow}
          >
            <Group gap="xs" wrap="nowrap" className={classes.headerTitle}>
              <Tooltip label={t("Back to templates")}>
                <ActionIcon
                  variant="subtle"
                  aria-label={t("Back to templates")}
                  onClick={() => navigate("/templates")}
                >
                  <IconArrowLeft size={18} />
                </ActionIcon>
              </Tooltip>
              <Text fw={600} truncate>
                {draft.title}
              </Text>
              <Badge
                size="sm"
                variant="light"
                color={
                  draft.status === "published"
                    ? "green"
                    : draft.status === "archived"
                      ? "orange"
                      : "gray"
                }
              >
                {t(
                  draft.status === "published"
                    ? "Published"
                    : draft.status === "archived"
                      ? "Archived"
                      : "Draft",
                )}
              </Badge>
            </Group>
            <Group gap="xs" wrap="nowrap" className={classes.headerActions}>
              <Button
                variant="default"
                leftSection={<IconEye size={16} />}
                onClick={openPreview}
                loading={updateMutation.isPending}
              >
                {t("Preview")}
              </Button>
              {canManageCurrentTemplate && (
                <>
                  <Button
                    variant="default"
                    leftSection={<IconCheck size={16} />}
                    onClick={() => void save()}
                    disabled={!dirty}
                    loading={updateMutation.isPending}
                  >
                    {t("Save")}
                  </Button>
                  <Button
                    leftSection={<IconSend size={16} />}
                    onClick={publish}
                    loading={publishMutation.isPending}
                    disabled={draft.status === "published" && !dirty}
                  >
                    {t("Publish")}
                  </Button>
                  <Menu position="bottom-end" withArrow>
                    <Menu.Target>
                      <ActionIcon
                        variant="default"
                        aria-label={t("Template menu")}
                      >
                        <IconDots size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconArchive size={16} />}
                        onClick={archive}
                        disabled={draft.status === "archived"}
                      >
                        {t("Archive")}
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={16} />}
                        onClick={remove}
                      >
                        {t("Delete")}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </>
              )}
            </Group>
          </Group>
        </header>

        <div className={classes.workspace}>
          <main className={classes.main}>
            <Container size={820} px="lg" py="xl">
              <TextInput
                label={t("Name")}
                value={draft.title}
                onChange={(event) => patch("title", event.currentTarget.value)}
                size="md"
                className={classes.titleInput}
                readOnly={!canManageCurrentTemplate}
              />
              <Textarea
                mt="md"
                label={t("Description")}
                value={draft.description ?? ""}
                onChange={(event) =>
                  patch("description", event.currentTarget.value)
                }
                autosize
                minRows={2}
                readOnly={!canManageCurrentTemplate}
              />
              <Divider my="xl" />
              {editor && canManageCurrentTemplate && (
                <FixedToolbar editor={editor} templateMode />
              )}
              <div className={classes.editorSurface}>
                <EditorContent editor={editor} />
              </div>
            </Container>
          </main>

          <aside
            className={classes.settings}
            aria-label={t("Template settings")}
          >
            <ScrollArea h="calc(100vh - 102px)" type="auto">
              <Stack p="lg" gap="lg">
                <div>
                  <Title order={2} size="h5">
                    {t("AI instructions")}
                  </Title>
                  <Text size="xs" c="dimmed" mt={3}>
                    {t(
                      "These fields help AI choose and fill the template correctly.",
                    )}
                  </Text>
                </div>
                <Textarea
                  label={t("Purpose")}
                  required
                  value={draft.purpose}
                  onChange={(event) =>
                    patch("purpose", event.currentTarget.value)
                  }
                  autosize
                  minRows={3}
                  readOnly={!canManageCurrentTemplate}
                />
                <Textarea
                  label={t("Use when")}
                  value={draft.useWhen ?? ""}
                  onChange={(event) =>
                    patch("useWhen", event.currentTarget.value)
                  }
                  autosize
                  minRows={2}
                  readOnly={!canManageCurrentTemplate}
                />
                <TextInput
                  label={t("Page title pattern")}
                  description="{{projectName}}"
                  value={draft.titleTemplate ?? ""}
                  onChange={(event) =>
                    patch("titleTemplate", event.currentTarget.value)
                  }
                  readOnly={!canManageCurrentTemplate}
                />
                <TagsInput
                  label={t("Tags")}
                  value={draft.tags}
                  onChange={(value) => patch("tags", value)}
                  clearable
                  disabled={!canManageCurrentTemplate}
                />
                <Select
                  label={t("Scope")}
                  data={scopeOptions}
                  searchable
                  value={draft.spaceId ?? "global"}
                  onChange={(value) =>
                    patch("spaceId", value === "global" ? null : value)
                  }
                  allowDeselect={false}
                  disabled={!canManageCurrentTemplate}
                />
                <TextInput
                  label={t("Template key")}
                  value={draft.key}
                  readOnly
                  description={t(
                    "Stable identifier used by MCP and API clients.",
                  )}
                />
                <Divider />
                <TemplateSchemaEditor
                  schema={draft.inputSchema}
                  onChange={(schema: ITemplateInputSchema) =>
                    patch("inputSchema", schema)
                  }
                  onInsert={insertVariable}
                  onRename={renameVariable}
                  readOnly={!canManageCurrentTemplate}
                />
              </Stack>
            </ScrollArea>
          </aside>
        </div>
      </div>

      <Modal
        opened={previewOpened}
        onClose={() => setPreviewOpened(false)}
        title={t("Preview template: {{title}}", { title: draft.title })}
        size="xl"
        centered
      >
        <Stack gap="lg">
          {Object.keys(draft.inputSchema.properties).length > 0 && (
            <TemplateVariableForm
              schema={draft.inputSchema}
              values={variables}
              onChange={setVariables}
              disabled={renderMutation.isPending}
            />
          )}
          <Group justify="flex-end">
            <Button
              leftSection={<IconEye size={16} />}
              onClick={renderPreview}
              loading={renderMutation.isPending}
            >
              {t("Render preview")}
            </Button>
          </Group>
          {preview && typeof preview.content !== "string" && (
            <div className={classes.preview}>
              <ReadonlyPageEditor
                title={preview.title}
                content={preview.content}
              />
            </div>
          )}
        </Stack>
      </Modal>
    </>
  );
}
