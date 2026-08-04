import type { Json } from '@docmost/db/types/db';
import type { ContentFormat } from '../../page/dto/create-page.dto';

export const EMPTY_TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export type TemplateInputSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export type TemplateSnapshot = {
  id?: string;
  templateId: string;
  version: number;
  key: string;
  title: string;
  description?: string | null;
  purpose: string;
  useWhen?: string | null;
  tags: string[];
  inputSchema: Json;
  titleTemplate?: string | null;
  content: Json;
  icon?: string | null;
  spaceId?: string | null;
};

export type RenderedTemplate = {
  templateId: string;
  version: number;
  title: string;
  icon: string | null;
  content: Record<string, unknown>;
  variables: Record<string, unknown>;
  warnings: string[];
};

export type FormattedRenderedTemplate = Omit<RenderedTemplate, 'content'> & {
  content: Json | string;
  format: ContentFormat;
};
