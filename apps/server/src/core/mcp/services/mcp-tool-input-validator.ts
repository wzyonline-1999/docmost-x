import { BadRequestException } from '@nestjs/common';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { MCP_MUTATION_TOOLS } from '../constants/mcp-tool.constants';
import type { McpToolDefinition } from '../types/mcp-tool.types';

export const MCP_MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MCP_MAX_SPACE_IDS = 100;

const UUID_FIELDS = new Set([
  'attachmentId',
  'fromHistoryId',
  'historyId',
  'jobId',
  'pageId',
  'parentPageId',
  'rootPageId',
  'spaceId',
  'toHistoryId',
]);

export class McpToolInputValidator {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
    });
    addFormats(this.ajv);
  }

  hardenDefinition(definition: McpToolDefinition): McpToolDefinition {
    const schema = definition.inputSchema;
    const originalProperties = this.asRecord(schema.properties);
    const properties: Record<string, unknown> = {};

    for (const [field, rawProperty] of Object.entries(originalProperties)) {
      const property = this.asRecord(rawProperty);
      if (UUID_FIELDS.has(field)) {
        properties[field] = {
          ...property,
          format: 'uuid',
        };
        continue;
      }
      if (field === 'spaceIds') {
        properties[field] = {
          ...property,
          maxItems: MCP_MAX_SPACE_IDS,
          uniqueItems: true,
          items: {
            ...this.asRecord(property.items),
            format: 'uuid',
          },
        };
        continue;
      }
      if (field === 'idempotencyKey') {
        properties[field] = this.idempotencyKeySchema();
        continue;
      }
      if (field === 'expectedUpdatedAt') {
        properties[field] = {
          ...property,
          format: 'date-time',
        };
        continue;
      }
      if (field === 'query') {
        properties[field] = {
          ...property,
          minLength: 1,
          maxLength: 1000,
        };
        continue;
      }
      if (field === 'fileName') {
        properties[field] = { ...property, minLength: 1, maxLength: 255 };
        continue;
      }
      if (field === 'contentBase64') {
        properties[field] = {
          ...property,
          minLength: 1,
          maxLength: 700_000,
        };
        continue;
      }
      properties[field] = rawProperty;
    }

    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    if (MCP_MUTATION_TOOLS.has(definition.name)) {
      properties.idempotencyKey = this.idempotencyKeySchema();
      required.add('idempotencyKey');
    }
    if (
      definition.name === 'update_page' ||
      definition.name === 'append_page'
    ) {
      properties.expectedUpdatedAt = {
        type: 'string',
        format: 'date-time',
        description:
          'The updatedAt returned by the immediately preceding get_page call. After a conflict, re-read the page and use a new idempotencyKey for the changed request.',
      };
      required.add('expectedUpdatedAt');
    }

    return {
      ...definition,
      inputSchema: {
        ...schema,
        maxProperties: 20,
        properties,
        ...(required.size > 0 ? { required: [...required] } : {}),
        additionalProperties: false,
      },
    };
  }

  validate(definition: McpToolDefinition, args: Record<string, unknown>): void {
    let validator = this.validators.get(definition.name);
    if (!validator) {
      validator = this.ajv.compile(definition.inputSchema);
      this.validators.set(definition.name, validator);
    }
    if (validator(args)) {
      return;
    }

    throw new BadRequestException(
      `Invalid arguments for ${definition.name}: ${this.formatErrors(
        validator.errors,
      )}`,
    );
  }

  private idempotencyKeySchema(): Record<string, unknown> {
    return {
      type: 'string',
      minLength: 1,
      maxLength: MCP_MAX_IDEMPOTENCY_KEY_LENGTH,
      description:
        'Stable key for retries of this exact request only. If any argument changes, including expectedUpdatedAt, use a new key.',
    };
  }

  private formatErrors(errors: ErrorObject[] | null | undefined): string {
    if (!errors?.length) {
      return 'arguments do not match the tool schema';
    }
    return errors
      .slice(0, 3)
      .map((error) => {
        const field = error.instancePath || 'arguments';
        return `${field} ${error.message ?? 'is invalid'}`;
      })
      .join('; ');
  }

  private asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }
}
