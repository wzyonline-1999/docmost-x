import type { JSONContent } from "@tiptap/core";
import type { IPagination } from "@/lib/types";

export type TemplateStatus = "draft" | "published" | "archived";
export type TemplateScope = "all" | "global" | "space";
export type TemplateContentFormat = "json" | "markdown" | "html";
export type TemplateVariableType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array";

export interface ITemplateVariableDefinition {
  type: TemplateVariableType;
  title?: string;
  description?: string;
  default?: unknown;
  items?: { type: "string" };
  "x-docmost-type"?: "markdown";
}

export interface ITemplateInputSchema {
  type: "object";
  properties: Record<string, ITemplateVariableDefinition>;
  required?: string[];
  additionalProperties: false;
}

export const EMPTY_TEMPLATE_INPUT_SCHEMA: ITemplateInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export interface ITemplateCreator {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface ITemplate {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  purpose: string;
  useWhen?: string | null;
  tags: string[];
  inputSchema: ITemplateInputSchema;
  titleTemplate?: string | null;
  content?: JSONContent;
  icon?: string | null;
  spaceId?: string | null;
  workspaceId: string;
  creatorId?: string | null;
  lastUpdatedById?: string | null;
  status: TemplateStatus;
  draftRevision: number;
  currentVersion: number;
  publishedAt?: string | null;
  sourcePageId?: string | null;
  createdAt: string;
  updatedAt: string;
  creator?: ITemplateCreator | null;
}

export interface ITemplateVersion {
  id: string;
  templateId: string;
  version: number;
  contentHash: string;
  createdById?: string | null;
  createdAt: string;
}

export interface ITemplateListParams {
  query?: string;
  cursor?: string;
  beforeCursor?: string;
  limit?: number;
  spaceId?: string;
  scope?: TemplateScope;
  status?: TemplateStatus;
  tags?: string[];
}

export interface ICreateTemplateInput {
  title: string;
  purpose: string;
  description?: string;
  useWhen?: string;
  tags?: string[];
  inputSchema?: ITemplateInputSchema;
  titleTemplate?: string;
  content?: string | JSONContent;
  format?: TemplateContentFormat;
  icon?: string;
  spaceId?: string;
  sourcePageId?: string;
}

export interface IUpdateTemplateInput extends Partial<
  Omit<ICreateTemplateInput, "sourcePageId">
> {
  templateId: string;
  expectedUpdatedAt: string;
  spaceId?: string | null;
}

export interface ITemplateMutationResponse {
  template: ITemplate;
  warnings: string[];
}

export interface IPublishTemplateResponse extends ITemplateMutationResponse {
  version: ITemplateVersion;
}

export interface IRenderTemplateInput {
  templateId?: string;
  key?: string;
  version?: number;
  variables?: Record<string, unknown>;
  title?: string;
  format?: TemplateContentFormat;
}

export interface IRenderedTemplate {
  templateId: string;
  version: number;
  title: string;
  icon?: string | null;
  content: JSONContent | string;
  variables: Record<string, unknown>;
  warnings: string[];
  format: TemplateContentFormat;
}

export interface IInstantiateTemplateInput extends IRenderTemplateInput {
  targetSpaceId: string;
  parentPageId?: string;
}

export interface IInstantiatedTemplate {
  page: {
    id: string;
    slugId: string;
    title: string;
    icon?: string | null;
    parentPageId?: string | null;
    spaceId: string;
  };
  template: { id: string; key: string; version: number };
  warnings: string[];
}

export type ITemplateList = IPagination<ITemplate>;
