import { BadRequestException, Injectable } from '@nestjs/common';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Json, JsonObject } from '@docmost/db/types/db';
import { PageService } from '../../page/services/page.service';
import {
  EMPTY_TEMPLATE_SCHEMA,
  RenderedTemplate,
  TemplateInputSchema,
  TemplateSnapshot,
} from '../types/template.types';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_VARIABLE_BYTES = 256 * 1024;
const MAX_VARIABLES = 50;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const INLINE_VARIABLE =
  /\{\{(?!\{)\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*\}\}(?!\})/g;
const BLOCK_VARIABLE =
  /^\s*\{\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*\}\}\}\s*$/;
const FORBIDDEN_SCHEMA_KEYS = new Set([
  '$ref',
  '$dynamicRef',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'unevaluatedProperties',
]);

@Injectable()
export class TemplateRendererService {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly pageService: PageService) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      useDefaults: true,
      coerceTypes: false,
    });
    addFormats(this.ajv);
  }

  normalizeInputSchema(value?: unknown): TemplateInputSchema {
    const schema = value ?? EMPTY_TEMPLATE_SCHEMA;
    if (!this.isObject(schema)) {
      throw new BadRequestException('Template inputSchema must be an object');
    }
    if (this.byteLength(schema) > MAX_SCHEMA_BYTES) {
      throw new BadRequestException('Template inputSchema is too large');
    }
    if (schema.type !== 'object') {
      throw new BadRequestException('Template inputSchema.type must be object');
    }
    if (!this.isObject(schema.properties)) {
      throw new BadRequestException(
        'Template inputSchema.properties must be an object',
      );
    }
    if (Object.keys(schema.properties).length > MAX_VARIABLES) {
      throw new BadRequestException(
        `Template inputSchema supports at most ${MAX_VARIABLES} variables`,
      );
    }
    if (schema.additionalProperties !== false) {
      throw new BadRequestException(
        'Template inputSchema.additionalProperties must be false',
      );
    }

    this.assertNoForbiddenSchemaKeywords(schema);
    const propertyNames = new Set(Object.keys(schema.properties));
    for (const [name, rawDefinition] of Object.entries(schema.properties)) {
      if (!VARIABLE_NAME.test(name)) {
        throw new BadRequestException(
          `Invalid template variable name: ${name}`,
        );
      }
      if (!this.isObject(rawDefinition)) {
        throw new BadRequestException(
          `Template variable definition must be an object: ${name}`,
        );
      }
      this.assertSupportedProperty(name, rawDefinition);
    }

    const required = schema.required;
    if (required !== undefined) {
      if (
        !Array.isArray(required) ||
        required.some(
          (name) => typeof name !== 'string' || !propertyNames.has(name),
        )
      ) {
        throw new BadRequestException(
          'Template inputSchema.required contains an unknown variable',
        );
      }
    }

    if (!this.ajv.validateSchema(schema)) {
      throw new BadRequestException(
        `Invalid template inputSchema: ${this.formatErrors(this.ajv.errors)}`,
      );
    }

    return structuredClone(schema) as TemplateInputSchema;
  }

  async validateDraft(input: {
    inputSchema?: unknown;
    titleTemplate?: string | null;
    content?: Json | null;
  }): Promise<{ schema: TemplateInputSchema; warnings: string[] }> {
    const schema = this.normalizeInputSchema(input.inputSchema);
    const declared = new Set(Object.keys(schema.properties));
    const used = new Set<string>();

    this.collectInlineVariables(input.titleTemplate ?? '', used);
    this.collectContentVariables(input.content, used, schema);

    const unknown = [...used].filter((name) => !declared.has(name));
    if (unknown.length) {
      throw new BadRequestException(
        `Template contains undeclared variables: ${unknown.join(', ')}`,
      );
    }

    const warnings = [...declared]
      .filter((name) => !used.has(name))
      .map((name) => `Variable is declared but unused: ${name}`);
    return { schema, warnings };
  }

  async render(
    snapshot: TemplateSnapshot,
    rawVariables?: Record<string, unknown>,
    titleOverride?: string,
  ): Promise<RenderedTemplate> {
    const schema = this.normalizeInputSchema(snapshot.inputSchema);
    const variables = structuredClone(rawVariables ?? {});
    if (!this.isObject(variables)) {
      throw new BadRequestException('Template variables must be an object');
    }
    if (this.byteLength(variables) > MAX_VARIABLE_BYTES) {
      throw new BadRequestException('Template variables are too large');
    }

    const validator = this.getValidator(schema);
    if (!validator(variables)) {
      throw new BadRequestException({
        message: 'Template variables are invalid',
        errors: (validator.errors ?? []).slice(0, 20).map((error) => ({
          path: error.instancePath || error.params?.missingProperty || '',
          message: error.message ?? 'is invalid',
        })),
      });
    }

    const content = await this.renderNode(
      structuredClone(snapshot.content) as Record<string, unknown>,
      variables,
      schema,
    );
    if (!content || Array.isArray(content)) {
      throw new BadRequestException('Template content must be a document');
    }

    const title = titleOverride?.trim()
      ? titleOverride.trim()
      : this.renderText(snapshot.titleTemplate || snapshot.title, variables);
    if (!title.trim()) {
      throw new BadRequestException('Rendered page title cannot be empty');
    }

    return {
      templateId: snapshot.templateId,
      version: snapshot.version,
      title: title.slice(0, 250),
      icon: snapshot.icon ?? null,
      content,
      variables,
      warnings: [],
    };
  }

  private async renderNode(
    node: Record<string, unknown>,
    variables: Record<string, unknown>,
    schema: TemplateInputSchema,
  ): Promise<Record<string, unknown> | Record<string, unknown>[] | null> {
    const blockVariable = this.getBlockVariable(node);
    if (blockVariable) {
      const definition = schema.properties[blockVariable];
      if (definition?.['x-docmost-type'] !== 'markdown') {
        throw new BadRequestException(
          `Block variable must use x-docmost-type=markdown: ${blockVariable}`,
        );
      }
      const value = variables[blockVariable];
      if (value === undefined || value === null || value === '') {
        return [];
      }
      if (typeof value !== 'string') {
        throw new BadRequestException(
          `Markdown variable must be a string: ${blockVariable}`,
        );
      }
      const parsed = (await this.pageService.prepareProsemirrorContent(
        value,
        'markdown',
      )) as Record<string, unknown>;
      return Array.isArray(parsed.content)
        ? (parsed.content as Record<string, unknown>[])
        : [];
    }

    const rendered: Record<string, unknown> = { ...node };
    if (node.type === 'text' && typeof node.text === 'string') {
      if (node.text.includes('{{{')) {
        throw new BadRequestException(
          'Markdown variables must occupy an entire paragraph',
        );
      }
      rendered.text = this.renderText(node.text, variables);
    }

    if (Array.isArray(node.content)) {
      const children: Record<string, unknown>[] = [];
      for (const rawChild of node.content) {
        if (!this.isObject(rawChild)) continue;
        const child = await this.renderNode(rawChild, variables, schema);
        if (Array.isArray(child)) children.push(...child);
        else if (child) children.push(child);
      }
      rendered.content = children;
    }

    return rendered;
  }

  private renderText(text: string, variables: Record<string, unknown>): string {
    return text.replace(INLINE_VARIABLE, (_match, name: string) =>
      this.toInlineText(variables[name]),
    );
  }

  private toInlineText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private getBlockVariable(node: Record<string, unknown>): string | null {
    if (node.type !== 'paragraph' || !Array.isArray(node.content)) return null;
    const text = node.content
      .map((child) =>
        this.isObject(child) &&
        child.type === 'text' &&
        typeof child.text === 'string'
          ? child.text
          : '',
      )
      .join('');
    const match = BLOCK_VARIABLE.exec(text);
    return match?.[1] ?? null;
  }

  private collectContentVariables(
    value: unknown,
    output: Set<string>,
    schema: TemplateInputSchema,
  ): void {
    if (!this.isObject(value)) return;
    const block = this.getBlockVariable(value);
    if (block) {
      output.add(block);
      const definition = schema.properties[block];
      if (definition && definition['x-docmost-type'] !== 'markdown') {
        throw new BadRequestException(
          `Block variable must use x-docmost-type=markdown: ${block}`,
        );
      }
      return;
    }
    if (value.type === 'text' && typeof value.text === 'string') {
      if (value.text.includes('{{{')) {
        throw new BadRequestException(
          'Markdown variables must occupy an entire paragraph',
        );
      }
      this.collectInlineVariables(value.text, output);
    }
    if (Array.isArray(value.content)) {
      value.content.forEach((child) =>
        this.collectContentVariables(child, output, schema),
      );
    }
  }

  private collectInlineVariables(text: string, output: Set<string>): void {
    for (const match of text.matchAll(INLINE_VARIABLE)) {
      if (match[1]) output.add(match[1]);
    }
  }

  private assertSupportedProperty(
    name: string,
    definition: Record<string, unknown>,
  ): void {
    const type = definition.type;
    if (
      !['string', 'number', 'integer', 'boolean', 'array'].includes(
        String(type),
      )
    ) {
      throw new BadRequestException(
        `Unsupported type for template variable ${name}: ${String(type)}`,
      );
    }
    if (
      definition['x-docmost-type'] !== undefined &&
      definition['x-docmost-type'] !== 'markdown'
    ) {
      throw new BadRequestException(
        `Unsupported x-docmost-type for template variable ${name}`,
      );
    }
    if (definition['x-docmost-type'] === 'markdown' && type !== 'string') {
      throw new BadRequestException(
        `Markdown template variable must use type=string: ${name}`,
      );
    }
    if (type === 'array') {
      const items = definition.items;
      if (!this.isObject(items) || items.type !== 'string') {
        throw new BadRequestException(
          `Array template variable must contain strings: ${name}`,
        );
      }
    }
  }

  private assertNoForbiddenSchemaKeywords(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((item) => this.assertNoForbiddenSchemaKeywords(item));
      return;
    }
    if (!this.isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SCHEMA_KEYS.has(key)) {
        throw new BadRequestException(
          `Unsupported template inputSchema keyword: ${key}`,
        );
      }
      this.assertNoForbiddenSchemaKeywords(child);
    }
  }

  private getValidator(schema: TemplateInputSchema): ValidateFunction {
    const key = JSON.stringify(schema);
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.compile(schema);
      this.validators.set(key, validator);
      if (this.validators.size > 200) {
        this.validators.delete(this.validators.keys().next().value);
      }
    }
    return validator;
  }

  private formatErrors(errors: ErrorObject[] | null | undefined): string {
    return (errors ?? [])
      .slice(0, 3)
      .map((error) => `${error.instancePath || 'schema'} ${error.message}`)
      .join('; ');
  }

  private byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }

  private isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
