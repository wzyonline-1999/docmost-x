import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Json, JsonObject } from '@docmost/db/types/db';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { Page, Template, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { ContentFormat } from '../../page/dto/create-page.dto';
import {
  CreateTemplateDto,
  InstantiateTemplateDto,
  ListTemplatesDto,
  RenderTemplateDto,
  UpdateTemplateDto,
} from '../../template/dto/template.dto';
import { TemplateAccessService } from '../../template/services/template-access.service';
import { TemplateService } from '../../template/services/template.service';
import type {
  McpToolContext,
  McpToolDefinition,
} from '../types/mcp-tool.types';
import type { McpPermissionAction } from '../types/mcp.types';
import { getMcpSafeErrorMessage } from '../utils/mcp-error.util';
import { McpActorAccessService } from './mcp-actor-access.service';
import { McpAuditService } from './mcp-audit.service';
import {
  McpIdempotencyReconciliationRecord,
  McpIdempotencyService,
} from './mcp-idempotency.service';
import { McpPermissionService } from './mcp-permission.service';
import { McpVectorIndexService } from './mcp-vector-index.service';

const MAX_TEMPLATE_LIST_LIMIT = 100;
const RECOVERY_WARNING =
  'Recovered an interrupted idempotent template operation from persisted state';
const AUDIT_WARNING =
  'MCP operation succeeded, but its audit log could not be persisted';

type TemplateReference = { templateId?: string; key?: string };

@Injectable()
export class McpTemplateService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly actorAccessService: McpActorAccessService,
    private readonly auditService: McpAuditService,
    private readonly environmentService: EnvironmentService,
    private readonly idempotencyService: McpIdempotencyService,
    private readonly pageRepo: PageRepo,
    private readonly permissionService: McpPermissionService,
    private readonly templateAccess: TemplateAccessService,
    private readonly templateRepo: TemplateRepo,
    private readonly templateService: TemplateService,
    private readonly vectorIndexService: McpVectorIndexService,
  ) {}

  listTools(): McpToolDefinition[] {
    const referenceProperties = {
      templateId: { type: 'string' },
      key: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'Stable template key returned by list_templates.',
      },
      version: { type: 'number', minimum: 1, maximum: 100_000 },
    };
    const renderProperties = {
      ...referenceProperties,
      variables: {
        type: 'object',
        description: 'Values validated against the template inputSchema.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 250,
        description: 'Optional rendered page title override.',
      },
    };

    return [
      {
        name: 'list_templates',
        description:
          'Find published templates that the token can search. Prefer this before creating repetitive pages.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            spaceId: { type: 'string' },
            scope: { type: 'string', enum: ['all', 'global', 'space'] },
            tags: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: MAX_TEMPLATE_LIST_LIMIT,
            },
            cursor: { type: 'string' },
            beforeCursor: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'get_template',
        description:
          'Read an immutable published template version, including its purpose, usage guidance, variable schema, and body.',
        inputSchema: {
          type: 'object',
          properties: {
            ...referenceProperties,
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'render_template',
        description:
          'Validate variables and preview a published template without creating a page.',
        inputSchema: {
          type: 'object',
          properties: {
            ...renderProperties,
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'instantiate_template',
        description:
          'Create one page from an immutable published template version. Retries with the same idempotencyKey never create a duplicate page.',
        inputSchema: {
          type: 'object',
          properties: {
            ...renderProperties,
            targetSpaceId: { type: 'string' },
            parentPageId: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['targetSpaceId'],
          additionalProperties: false,
        },
      },
      {
        name: 'create_template',
        description:
          'Create an editable template draft in an allowed space, or a workspace-global draft for an administrator actor.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 250 },
            description: { type: 'string', maxLength: 2_000 },
            purpose: { type: 'string', minLength: 1, maxLength: 2_000 },
            useWhen: { type: 'string', maxLength: 2_000 },
            tags: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
            inputSchema: { type: 'object' },
            titleTemplate: { type: 'string', maxLength: 500 },
            content: { type: ['string', 'object'] },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
            icon: { type: 'string', maxLength: 32 },
            spaceId: { type: 'string' },
            sourcePageId: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['title', 'purpose'],
          additionalProperties: false,
        },
      },
      {
        name: 'update_template',
        description:
          'Update an editable template draft with optimistic concurrency protection.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string' },
            expectedUpdatedAt: { type: 'string', format: 'date-time' },
            title: { type: 'string', minLength: 1, maxLength: 250 },
            description: { type: 'string', maxLength: 2_000 },
            purpose: { type: 'string', minLength: 1, maxLength: 2_000 },
            useWhen: { type: 'string', maxLength: 2_000 },
            tags: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
            inputSchema: { type: 'object' },
            titleTemplate: { type: 'string', maxLength: 500 },
            content: { type: ['string', 'object'] },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
            icon: { type: 'string', maxLength: 32 },
            spaceId: { type: ['string', 'null'] },
            idempotencyKey: { type: 'string' },
          },
          required: ['templateId', 'expectedUpdatedAt'],
          additionalProperties: false,
        },
      },
      {
        name: 'publish_template',
        description:
          'Publish the current draft as a new immutable template version.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string' },
            expectedUpdatedAt: { type: 'string', format: 'date-time' },
            idempotencyKey: { type: 'string' },
          },
          required: ['templateId', 'expectedUpdatedAt'],
          additionalProperties: false,
        },
      },
      {
        name: 'archive_template',
        description: 'Archive a template so AI can no longer instantiate it.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string' },
            expectedUpdatedAt: { type: 'string', format: 'date-time' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['templateId', 'expectedUpdatedAt', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_template',
        description: 'Soft-delete a template. Published pages are not changed.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string' },
            expectedUpdatedAt: { type: 'string', format: 'date-time' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['templateId', 'expectedUpdatedAt', 'confirm'],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    switch (name) {
      case 'list_templates':
        return this.listTemplates(args, context);
      case 'get_template':
        return this.getTemplate(args, context);
      case 'render_template':
        return this.renderTemplate(args, context);
      case 'instantiate_template':
        return this.instantiateTemplate(args, context);
      case 'create_template':
        return this.createTemplate(args, context);
      case 'update_template':
        return this.updateTemplate(args, context);
      case 'publish_template':
        return this.publishTemplate(args, context);
      case 'archive_template':
        return this.archiveTemplate(args, context);
      case 'delete_template':
        return this.deleteTemplate(args, context);
      default:
        throw new NotFoundException(`Unknown template tool: ${name}`);
    }
  }

  private async listTemplates(args: JsonObject, context: McpToolContext) {
    const actor = await this.actorAccessService.requireActor(context.client);
    const allowedSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'search',
    );
    const requestedSpaceId = this.optionalString(args, 'spaceId');
    if (requestedSpaceId && !allowedSpaceIds.includes(requestedSpaceId)) {
      throw new ForbiddenException('MCP template search permission denied');
    }

    let scope = this.optionalEnum(args, 'scope', ['all', 'global', 'space']);
    if (!this.isWorkspaceAdmin(actor)) {
      if (scope === 'global') {
        throw new ForbiddenException(
          'Workspace administrator permission required for global templates',
        );
      }
      scope = 'space';
    }

    const dto = Object.assign(new ListTemplatesDto(), {
      limit:
        this.optionalInteger(args, 'limit', 1, MAX_TEMPLATE_LIST_LIMIT) ?? 20,
      cursor: this.optionalString(args, 'cursor'),
      beforeCursor: this.optionalString(args, 'beforeCursor'),
      query: this.optionalString(args, 'query'),
      spaceId: requestedSpaceId,
      scope: scope ?? 'all',
      status: 'published' as const,
      tags: this.optionalStringArray(args, 'tags'),
    });

    return this.templateService.listForUser(
      actor,
      context.client.workspaceId,
      dto,
      { publishedOnly: true, accessibleSpaceIds: allowedSpaceIds },
    );
  }

  private async getTemplate(args: JsonObject, context: McpToolContext) {
    const reference = this.getReference(args);
    const { actor } = await this.requireTemplatePermission(
      context,
      reference,
      'read',
    );
    return this.templateService.getPublishedForUser(
      actor,
      context.client.workspaceId,
      {
        ...reference,
        version: this.optionalInteger(args, 'version', 1, 100_000),
        format: this.getFormat(args, 'markdown'),
      },
    );
  }

  private async renderTemplate(args: JsonObject, context: McpToolContext) {
    const reference = this.getReference(args);
    const { actor } = await this.requireTemplatePermission(
      context,
      reference,
      'read',
    );
    return this.templateService.renderForUser(
      actor,
      context.client.workspaceId,
      {
        ...reference,
        version: this.optionalInteger(args, 'version', 1, 100_000),
        variables: this.optionalObject(args, 'variables'),
        title: this.optionalString(args, 'title'),
        format: this.getFormat(args, 'markdown'),
      },
      { publishedOnly: true },
    );
  }

  private async instantiateTemplate(args: JsonObject, context: McpToolContext) {
    const reference = this.getReference(args);
    const { actor, template } = await this.requireTemplatePermission(
      context,
      reference,
      'read',
    );
    const targetSpaceId = this.requireString(args, 'targetSpaceId');
    await this.permissionService.assertSpacePermission(
      context.client,
      'create',
      targetSpaceId,
    );

    const version = await this.templateRepo.findVersion(
      template.id,
      context.client.workspaceId,
      this.optionalInteger(args, 'version', 1, 100_000),
    );
    if (!version || template.status !== 'published') {
      throw new NotFoundException('Published template version not found');
    }

    const dto: InstantiateTemplateDto = {
      ...reference,
      version: version.version,
      variables: this.optionalObject(args, 'variables'),
      title: this.optionalString(args, 'title'),
      targetSpaceId,
      parentPageId: this.optionalString(args, 'parentPageId'),
      idempotencyKey: this.requireString(args, 'idempotencyKey'),
    };
    const targetState = {
      templateId: template.id,
      templateVersionId: version.id,
      targetSpaceId,
      parentPageId: dto.parentPageId ?? null,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'instantiate_template',
      idempotencyKey: dto.idempotencyKey,
      request: args,
      resourceType: 'page',
      operationStage: 'validated',
      targetState,
      getResourceId: (response) => this.getResponseResourceId(response, 'page'),
      reconcile: (record) =>
        this.reconcileInstantiation(record, context, template, version.version),
      run: async (execution) => {
        const result = await this.templateService.instantiateForUser(
          actor,
          context.client.workspaceId,
          dto,
          {
            clientId: context.client.id,
            requestId: context.requestId,
            checkpoint: (pageId) =>
              execution.checkpoint({
                stage: 'page_and_instance_created',
                resourceId: pageId,
              }),
          },
        );
        const indexAttempt = await this.tryIndexPage(context, result.page);
        const auditWarnings = await this.audit(context, {
          event: 'mcp.template.instantiate',
          toolName: 'instantiate_template',
          resourceType: 'template',
          resourceId: template.id,
          spaceId: targetSpaceId,
          after: {
            pageId: result.page.id,
            version: result.template.version,
          },
        });
        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: result.page.id,
        });
        return {
          page: this.toPageMetadata(result.page),
          template: result.template,
          index: indexAttempt.index,
          warnings: [
            ...result.warnings,
            ...indexAttempt.warnings,
            ...auditWarnings,
          ],
        };
      },
    });
  }

  private async createTemplate(args: JsonObject, context: McpToolContext) {
    const actor = await this.actorAccessService.requireActor(context.client);
    const workspace = await this.templateService.getWorkspace(
      context.client.workspaceId,
    );
    const spaceId = this.optionalString(args, 'spaceId');
    await this.assertScopePermission(context, actor, 'create', spaceId);

    const sourcePageId = this.optionalString(args, 'sourcePageId');
    if (sourcePageId) {
      await this.permissionService.assertPagePermission(
        context.client,
        'read',
        sourcePageId,
        { maskPermissionDeniedAsNotFound: true },
      );
    }

    const dto: CreateTemplateDto = {
      title: this.requireString(args, 'title'),
      purpose: this.requireString(args, 'purpose'),
      description: this.optionalString(args, 'description'),
      useWhen: this.optionalString(args, 'useWhen'),
      tags: this.optionalStringArray(args, 'tags'),
      inputSchema: this.optionalObject(args, 'inputSchema'),
      titleTemplate: this.optionalString(args, 'titleTemplate'),
      content: this.optionalContent(args, 'content'),
      format: this.getOptionalFormat(args),
      icon: this.optionalString(args, 'icon'),
      spaceId,
      sourcePageId,
    };
    const idempotencyKey = this.requireString(args, 'idempotencyKey');

    return this.idempotencyService.run({
      client: context.client,
      action: 'create_template',
      idempotencyKey,
      request: args,
      resourceType: 'template',
      operationStage: 'validated',
      targetState: { title: dto.title, spaceId: spaceId ?? null },
      getResourceId: (response) =>
        this.getResponseResourceId(response, 'template'),
      reconcile: (record) =>
        this.reconcileTemplateMutation(record, context, actor, args),
      run: async (execution) => {
        const result = await this.templateService.createForUser(
          actor,
          workspace,
          dto,
        );
        const template = result.template as Record<string, unknown>;
        await execution.checkpoint({
          stage: 'template_created',
          resourceId: String(template.id),
        });
        const auditWarnings = await this.audit(context, {
          event: 'mcp.template.create',
          toolName: 'create_template',
          resourceType: 'template',
          resourceId: String(template.id),
          spaceId,
          after: { title: dto.title, spaceId: spaceId ?? null },
        });
        return this.appendWarnings(result, auditWarnings);
      },
    });
  }

  private async updateTemplate(args: JsonObject, context: McpToolContext) {
    const templateId = this.requireString(args, 'templateId');
    const { actor, template } = await this.requireTemplatePermission(
      context,
      { templateId },
      'update',
      true,
    );
    const workspace = await this.templateService.getWorkspace(
      context.client.workspaceId,
    );
    const nextSpaceId = this.optionalNullableString(args, 'spaceId');
    if (nextSpaceId !== undefined && nextSpaceId !== template.spaceId) {
      await this.assertScopePermission(context, actor, 'update', nextSpaceId);
    }

    const dto: UpdateTemplateDto = {
      templateId,
      expectedUpdatedAt: this.requireString(args, 'expectedUpdatedAt'),
      title: this.optionalString(args, 'title'),
      description: this.optionalString(args, 'description'),
      purpose: this.optionalString(args, 'purpose'),
      useWhen: this.optionalString(args, 'useWhen'),
      tags: this.optionalStringArray(args, 'tags'),
      inputSchema: this.optionalObject(args, 'inputSchema'),
      titleTemplate: this.optionalString(args, 'titleTemplate'),
      content: this.optionalContent(args, 'content'),
      format: this.getOptionalFormat(args),
      icon: this.optionalString(args, 'icon'),
      spaceId: nextSpaceId as string | undefined,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'update_template',
      idempotencyKey: this.requireString(args, 'idempotencyKey'),
      request: args,
      resourceType: 'template',
      resourceId: template.id,
      operationStage: 'validated',
      beforeState: { updatedAt: template.updatedAt.toISOString() },
      targetState: this.templatePatchTarget(args),
      getResourceId: (response) =>
        this.getResponseResourceId(response, 'template'),
      reconcile: (record) =>
        this.reconcileTemplateMutation(record, context, actor, args),
      run: async (execution) => {
        const result = await this.templateService.updateForUser(
          actor,
          workspace,
          dto,
        );
        await execution.checkpoint({
          stage: 'template_updated',
          resourceId: template.id,
        });
        const updated = result.template as Record<string, unknown>;
        const auditWarnings = await this.audit(context, {
          event: 'mcp.template.update',
          toolName: 'update_template',
          resourceType: 'template',
          resourceId: template.id,
          spaceId: (updated.spaceId as string | null) ?? null,
          before: { updatedAt: template.updatedAt.toISOString() },
          after: { updatedAt: String(updated.updatedAt) },
        });
        return this.appendWarnings(result, auditWarnings);
      },
    });
  }

  private async publishTemplate(args: JsonObject, context: McpToolContext) {
    const templateId = this.requireString(args, 'templateId');
    const { actor, template } = await this.requireTemplatePermission(
      context,
      { templateId },
      'update',
      true,
    );
    const workspace = await this.templateService.getWorkspace(
      context.client.workspaceId,
    );

    return this.idempotencyService.run({
      client: context.client,
      action: 'publish_template',
      idempotencyKey: this.requireString(args, 'idempotencyKey'),
      request: args,
      resourceType: 'template',
      resourceId: template.id,
      operationStage: 'validated',
      beforeState: { currentVersion: template.currentVersion },
      targetState: { currentVersion: template.currentVersion + 1 },
      getResourceId: (response) =>
        this.getResponseResourceId(response, 'template'),
      reconcile: (record) =>
        this.reconcileTemplateMutation(record, context, actor, args),
      run: async (execution) => {
        const result = await this.templateService.publishForUser(
          actor,
          workspace,
          template.id,
          this.requireString(args, 'expectedUpdatedAt'),
        );
        await execution.checkpoint({
          stage: 'template_published',
          resourceId: template.id,
        });
        const auditWarnings = await this.audit(context, {
          event: 'mcp.template.publish',
          toolName: 'publish_template',
          resourceType: 'template',
          resourceId: template.id,
          spaceId: template.spaceId,
          after: { version: result.version.version },
        });
        return this.appendWarnings(result, auditWarnings);
      },
    });
  }

  private async archiveTemplate(args: JsonObject, context: McpToolContext) {
    this.requireConfirmation(args, 'archive_template');
    return this.changeTemplateLifecycle('archive', args, context);
  }

  private async deleteTemplate(args: JsonObject, context: McpToolContext) {
    this.requireConfirmation(args, 'delete_template');
    return this.changeTemplateLifecycle('delete', args, context);
  }

  private async changeTemplateLifecycle(
    action: 'archive' | 'delete',
    args: JsonObject,
    context: McpToolContext,
  ) {
    const templateId = this.requireString(args, 'templateId');
    const permissionAction: McpPermissionAction =
      action === 'delete' ? 'delete' : 'update';
    const { actor, template } = await this.requireTemplatePermission(
      context,
      { templateId },
      permissionAction,
    );
    const workspace = await this.templateService.getWorkspace(
      context.client.workspaceId,
    );
    const toolName = `${action}_template`;

    return this.idempotencyService.run({
      client: context.client,
      action: toolName,
      idempotencyKey: this.requireString(args, 'idempotencyKey'),
      request: args,
      resourceType: 'template',
      resourceId: template.id,
      operationStage: 'validated',
      beforeState: { status: template.status, deletedAt: template.deletedAt },
      targetState:
        action === 'delete' ? { deleted: true } : { status: 'archived' },
      getResourceId: (response) =>
        this.getResponseResourceId(response, 'template') ?? template.id,
      reconcile: (record) =>
        this.reconcileTemplateMutation(record, context, actor, args),
      run: async (execution) => {
        const result =
          action === 'delete'
            ? await this.templateService.deleteForUser(
                actor,
                workspace,
                template.id,
                this.requireString(args, 'expectedUpdatedAt'),
              )
            : await this.templateService.archiveForUser(
                actor,
                workspace,
                template.id,
                this.requireString(args, 'expectedUpdatedAt'),
              );
        await execution.checkpoint({
          stage: `template_${action}d`,
          resourceId: template.id,
        });
        const auditWarnings = await this.audit(context, {
          event: `mcp.template.${action}`,
          toolName,
          resourceType: 'template',
          resourceId: template.id,
          spaceId: template.spaceId,
        });
        return this.appendWarnings(result, auditWarnings);
      },
    });
  }

  private async requireTemplatePermission(
    context: McpToolContext,
    reference: TemplateReference,
    action: McpPermissionAction,
    includeContent = false,
  ): Promise<{ actor: User; template: Template }> {
    const actor = await this.actorAccessService.requireActor(context.client);
    const template = await this.templateService.requireTemplateByReference(
      context.client.workspaceId,
      reference,
      includeContent,
    );
    await this.assertScopePermission(context, actor, action, template.spaceId);
    return { actor, template };
  }

  private async assertScopePermission(
    context: McpToolContext,
    actor: User,
    action: McpPermissionAction,
    spaceId?: string | null,
  ): Promise<void> {
    if (spaceId) {
      await this.permissionService.assertSpacePermission(
        context.client,
        action,
        spaceId,
      );
      return;
    }
    this.templateAccess.assertWorkspaceAdmin(actor);
  }

  private async reconcileInstantiation(
    record: McpIdempotencyReconciliationRecord,
    context: McpToolContext,
    template: Template,
    expectedVersion: number,
  ) {
    if (!record.resourceId) return { outcome: 'retry' as const };
    const page = await this.pageRepo.findById(record.resourceId);
    const instance = await this.templateRepo.findInstanceByPageId(
      record.resourceId,
      context.client.workspaceId,
    );
    if (!page || !instance) return { outcome: 'retry' as const };
    if (
      page.workspaceId !== context.client.workspaceId ||
      instance.templateId !== template.id
    ) {
      return { outcome: 'repair_required' as const };
    }
    const version = await this.db
      .selectFrom('templateVersions')
      .select(['version', 'key'])
      .where('id', '=', instance.templateVersionId)
      .where('workspaceId', '=', context.client.workspaceId)
      .executeTakeFirst();
    if (!version || version.version !== expectedVersion) {
      return { outcome: 'repair_required' as const };
    }

    const indexAttempt = await this.tryIndexPage(context, page);
    const auditWarnings = await this.audit(context, {
      event: 'mcp.idempotency.reconciled',
      toolName: record.action,
      resourceType: 'page',
      resourceId: page.id,
      spaceId: page.spaceId,
      after: { templateId: template.id, version: version.version },
    });
    return {
      outcome: 'completed' as const,
      response: {
        page: this.toPageMetadata(page),
        template: {
          id: template.id,
          key: version.key,
          version: version.version,
        },
        index: indexAttempt.index,
        warnings: [
          RECOVERY_WARNING,
          ...indexAttempt.warnings,
          ...auditWarnings,
        ],
      },
    };
  }

  private async reconcileTemplateMutation(
    record: McpIdempotencyReconciliationRecord,
    context: McpToolContext,
    actor: User,
    args: JsonObject,
  ) {
    if (!record.resourceId) return { outcome: 'retry' as const };
    const template = await this.templateRepo.findById(
      record.resourceId,
      context.client.workspaceId,
      { includeContent: true, includeDeleted: true },
    );
    if (!template) return { outcome: 'retry' as const };

    if (record.action === 'delete_template') {
      if (!template.deletedAt) return { outcome: 'retry' as const };
      return {
        outcome: 'completed' as const,
        response: {
          templateId: template.id,
          deleted: true,
          warnings: [RECOVERY_WARNING],
        },
      };
    }

    if (record.action === 'archive_template') {
      if (template.status !== 'archived') {
        return { outcome: 'retry' as const };
      }
    } else if (record.action === 'publish_template') {
      const target = this.asObject(record.targetState);
      if (
        template.status !== 'published' ||
        template.currentVersion < Number(target.currentVersion ?? 0)
      ) {
        return { outcome: 'retry' as const };
      }
    } else if (record.action === 'create_template') {
      const target = this.asObject(record.targetState);
      if (
        template.title !== target.title ||
        template.spaceId !== (target.spaceId ?? null)
      ) {
        return { outcome: 'repair_required' as const };
      }
    } else if (
      record.action === 'update_template' &&
      !this.templateMatchesPatch(template, args)
    ) {
      return { outcome: 'retry' as const };
    }

    if (template.deletedAt) {
      return { outcome: 'repair_required' as const };
    }
    const response = await this.templateService.getDraftForUser(
      actor,
      context.client.workspaceId,
      template.id,
    );
    if (record.action === 'publish_template') {
      const version = await this.templateRepo.findVersion(
        template.id,
        context.client.workspaceId,
        template.currentVersion,
      );
      if (!version) return { outcome: 'repair_required' as const };
      return {
        outcome: 'completed' as const,
        response: {
          template: response,
          version: {
            id: version.id,
            templateId: version.templateId,
            version: version.version,
            contentHash: version.contentHash,
            createdById: version.createdById,
            createdAt: version.createdAt,
          },
          warnings: [RECOVERY_WARNING],
        },
      };
    }
    return {
      outcome: 'completed' as const,
      response:
        record.action === 'archive_template'
          ? this.appendWarnings(response, [RECOVERY_WARNING])
          : {
              template: response,
              warnings: [RECOVERY_WARNING],
            },
    };
  }

  private async tryIndexPage(context: McpToolContext, page: Page) {
    if (!this.environmentService.isVectorSearchEnabled()) {
      return { index: null, warnings: [] as string[] };
    }
    try {
      return {
        index: await this.vectorIndexService.indexPage({
          workspaceId: context.client.workspaceId,
          pageId: page.id,
          spaceId: page.spaceId,
          requestedByClientId: context.client.id,
          requestedByUserId: context.client.actorUserId,
        }),
        warnings: [] as string[],
      };
    } catch (err) {
      return {
        index: null,
        warnings: [getMcpSafeErrorMessage(err, 'Vector index was not updated')],
      };
    }
  }

  private async audit(
    context: McpToolContext,
    input: {
      event: string;
      toolName: string;
      resourceType: string;
      resourceId?: string | null;
      spaceId?: string | null;
      before?: Json | null;
      after?: Json | null;
    },
  ): Promise<string[]> {
    const persisted = await this.auditService.tryLog({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      ...input,
    });
    return persisted ? [] : [AUDIT_WARNING];
  }

  private getReference(args: JsonObject): TemplateReference {
    const templateId = this.optionalString(args, 'templateId');
    const key = this.optionalString(args, 'key');
    if (Boolean(templateId) === Boolean(key)) {
      throw new BadRequestException('Provide exactly one of templateId or key');
    }
    return { templateId, key };
  }

  private templatePatchTarget(args: JsonObject): Record<string, unknown> {
    const fields = [
      'title',
      'description',
      'purpose',
      'useWhen',
      'tags',
      'inputSchema',
      'titleTemplate',
      'content',
      'icon',
      'spaceId',
    ];
    return Object.fromEntries(
      fields
        .filter((field) => args[field] !== undefined)
        .map((field) => [field, args[field]]),
    );
  }

  private templateMatchesPatch(template: Template, args: JsonObject): boolean {
    const comparisons: Array<[string, unknown]> = [
      ['title', template.title],
      ['description', template.description],
      ['purpose', template.purpose],
      ['useWhen', template.useWhen],
      ['tags', template.tags],
      ['inputSchema', template.inputSchema],
      ['titleTemplate', template.titleTemplate],
      ['icon', template.icon],
      ['spaceId', template.spaceId],
    ];
    return comparisons.every(([field, current]) => {
      if (args[field] === undefined) return true;
      const expected = args[field] === '' ? null : args[field];
      return JSON.stringify(current) === JSON.stringify(expected);
    });
  }

  private toPageMetadata(page: Page) {
    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      icon: page.icon,
      parentPageId: page.parentPageId,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      creatorId: page.creatorId,
      lastUpdatedById: page.lastUpdatedById,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      deletedAt: page.deletedAt,
    };
  }

  private appendWarnings(result: unknown, warnings: string[]): unknown {
    if (!warnings.length) return result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const current = (result as { warnings?: unknown }).warnings;
      return {
        ...result,
        warnings: [...(Array.isArray(current) ? current : []), ...warnings],
      };
    }
    return { result, warnings };
  }

  private getResponseResourceId(
    response: unknown,
    field: 'page' | 'template',
  ): string | null {
    if (!response || typeof response !== 'object') return null;
    const resource = (response as Record<string, unknown>)[field];
    if (!resource || typeof resource !== 'object') return null;
    const id = (resource as Record<string, unknown>).id;
    return typeof id === 'string' ? id : null;
  }

  private isWorkspaceAdmin(actor: User): boolean {
    return [UserRole.OWNER, UserRole.ADMIN].includes(actor.role as UserRole);
  }

  private requireString(args: JsonObject, field: string): string {
    const value = args[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }

  private optionalString(args: JsonObject, field: string): string | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }
    return value.trim();
  }

  private optionalNullableString(
    args: JsonObject,
    field: string,
  ): string | null | undefined {
    if (!(field in args)) return undefined;
    if (args[field] === null) return null;
    return this.optionalString(args, field);
  }

  private optionalStringArray(
    args: JsonObject,
    field: string,
  ): string[] | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      throw new BadRequestException(`${field} must be an array of strings`);
    }
    return (value as string[]).map((item) => item.trim()).filter(Boolean);
  }

  private optionalObject(
    args: JsonObject,
    field: string,
  ): Record<string, unknown> | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  private optionalContent(
    args: JsonObject,
    field: string,
  ): string | object | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (
      typeof value !== 'string' &&
      (typeof value !== 'object' || Array.isArray(value))
    ) {
      throw new BadRequestException(`${field} must be a string or object`);
    }
    return value as string | object;
  }

  private optionalInteger(
    args: JsonObject,
    field: string,
    min: number,
    max: number,
  ): number | undefined {
    const value = args[field];
    if (value === undefined || value === null) return undefined;
    if (
      !Number.isInteger(value) ||
      Number(value) < min ||
      Number(value) > max
    ) {
      throw new BadRequestException(
        `${field} must be an integer between ${min} and ${max}`,
      );
    }
    return Number(value);
  }

  private optionalEnum<T extends string>(
    args: JsonObject,
    field: string,
    values: readonly T[],
  ): T | undefined {
    const value = this.optionalString(args, field);
    if (value === undefined) return undefined;
    if (!values.includes(value as T)) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return value as T;
  }

  private getFormat(args: JsonObject, fallback: ContentFormat): ContentFormat {
    return (
      this.optionalEnum(args, 'format', ['markdown', 'html', 'json']) ??
      fallback
    );
  }

  private getOptionalFormat(args: JsonObject): ContentFormat | undefined {
    return this.optionalEnum(args, 'format', ['markdown', 'html', 'json']);
  }

  private requireConfirmation(args: JsonObject, toolName: string): void {
    if (args.confirm !== true) {
      throw new BadRequestException(`${toolName} requires confirm=true`);
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
