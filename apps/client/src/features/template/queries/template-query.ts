import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  archiveTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  instantiateTemplate,
  listTemplates,
  listTemplateVersions,
  publishTemplate,
  renderTemplate,
  updateTemplate,
} from "@/features/template/services/template-service";
import type {
  ICreateTemplateInput,
  IInstantiateTemplateInput,
  IRenderTemplateInput,
  ITemplateListParams,
  IUpdateTemplateInput,
} from "@/features/template/types/template.types";

const useTemplateMutationError = () => {
  const { t } = useTranslation();
  return (error: Error) => {
    notifications.show({
      message: getApiErrorMessage(error, t("Template operation failed")),
      color: "red",
    });
  };
};

export function useTemplatesQuery(params: ITemplateListParams = {}) {
  return useQuery({
    queryKey: ["templates", params],
    queryFn: () => listTemplates(params),
    placeholderData: keepPreviousData,
  });
}

export function useTemplateQuery(templateId?: string) {
  return useQuery({
    queryKey: ["template", templateId],
    queryFn: () => getTemplate(templateId as string),
    enabled: Boolean(templateId),
  });
}

export function useTemplateVersionsQuery(templateId?: string) {
  return useQuery({
    queryKey: ["template-versions", templateId],
    queryFn: () => listTemplateVersions(templateId as string),
    enabled: Boolean(templateId),
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: (input: ICreateTemplateInput) => createTemplate(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      queryClient.setQueryData(
        ["template", result.template.id],
        result.template,
      );
    },
    onError,
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: (input: IUpdateTemplateInput) => updateTemplate(input),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["template", result.template.id],
        result.template,
      );
      queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
    onError,
  });
}

export function usePublishTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: publishTemplate,
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["template", result.template.id],
        result.template,
      );
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      queryClient.invalidateQueries({
        queryKey: ["template-versions", result.template.id],
      });
    },
    onError,
  });
}

export function useArchiveTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: archiveTemplate,
    onSuccess: (template) => {
      queryClient.setQueryData(["template", template.id], template);
      queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
    onError,
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: deleteTemplate,
    onSuccess: (result) => {
      queryClient.removeQueries({ queryKey: ["template", result.templateId] });
      queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
    onError,
  });
}

export function useRenderTemplateMutation() {
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: (input: IRenderTemplateInput) => renderTemplate(input),
    onError,
  });
}

export function useInstantiateTemplateMutation() {
  const queryClient = useQueryClient();
  const onError = useTemplateMutationError();
  return useMutation({
    mutationFn: (input: IInstantiateTemplateInput) =>
      instantiateTemplate(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["sidebar-pages", result.page.spaceId],
      });
      queryClient.invalidateQueries({ queryKey: ["recent-changes"] });
    },
    onError,
  });
}
