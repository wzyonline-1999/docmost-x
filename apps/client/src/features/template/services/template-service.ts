import api from "@/lib/api-client";
import type {
  ICreateTemplateInput,
  IInstantiateTemplateInput,
  IInstantiatedTemplate,
  IPublishTemplateResponse,
  IRenderedTemplate,
  IRenderTemplateInput,
  ITemplate,
  ITemplateList,
  ITemplateListParams,
  ITemplateMutationResponse,
  ITemplateVersion,
  IUpdateTemplateInput,
} from "@/features/template/types/template.types";

export async function listTemplates(
  params: ITemplateListParams = {},
): Promise<ITemplateList> {
  const response = await api.post<ITemplateList>("/templates/list", params);
  return response.data;
}

export async function getTemplate(templateId: string): Promise<ITemplate> {
  const response = await api.post<ITemplate>("/templates/info", {
    templateId,
  });
  return response.data;
}

export async function listTemplateVersions(
  templateId: string,
  limit = 20,
): Promise<ITemplateVersion[]> {
  const response = await api.post<ITemplateVersion[]>("/templates/versions", {
    templateId,
    limit,
  });
  return response.data;
}

export async function createTemplate(
  input: ICreateTemplateInput,
): Promise<ITemplateMutationResponse> {
  const response = await api.post<ITemplateMutationResponse>(
    "/templates/create",
    input,
  );
  return response.data;
}

export async function updateTemplate(
  input: IUpdateTemplateInput,
): Promise<ITemplateMutationResponse> {
  const response = await api.post<ITemplateMutationResponse>(
    "/templates/update",
    input,
  );
  return response.data;
}

export async function publishTemplate(input: {
  templateId: string;
  expectedUpdatedAt: string;
}): Promise<IPublishTemplateResponse> {
  const response = await api.post<IPublishTemplateResponse>(
    "/templates/publish",
    input,
  );
  return response.data;
}

export async function archiveTemplate(input: {
  templateId: string;
  expectedUpdatedAt: string;
}): Promise<ITemplate> {
  const response = await api.post<ITemplate>("/templates/archive", input);
  return response.data;
}

export async function deleteTemplate(input: {
  templateId: string;
  expectedUpdatedAt: string;
}): Promise<{ templateId: string; deleted: true }> {
  const response = await api.post<{ templateId: string; deleted: true }>(
    "/templates/delete",
    input,
  );
  return response.data;
}

export async function renderTemplate(
  input: IRenderTemplateInput,
): Promise<IRenderedTemplate> {
  const response = await api.post<IRenderedTemplate>(
    "/templates/render",
    input,
  );
  return response.data;
}

export async function instantiateTemplate(
  input: IInstantiateTemplateInput,
): Promise<IInstantiatedTemplate> {
  const response = await api.post<IInstantiatedTemplate>(
    "/templates/instantiate",
    input,
  );
  return response.data;
}
