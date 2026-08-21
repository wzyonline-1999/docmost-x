import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { validate as isValidUUID } from 'uuid';
import type { Json, JsonObject } from '@docmost/db/types/db';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../../collaboration/collaboration.util';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { ContentFormat } from '../../page/dto/create-page.dto';
import { PageService } from '../../page/services/page.service';
import { PageTreeScopeService } from '../../page/services/page-tree-scope.service';
import { McpAuditService } from './mcp-audit.service';
import { McpEmbeddingService } from './mcp-embedding.service';
import {
  McpIdempotencyReconciliation,
  McpIdempotencyReconciliationRecord,
  McpIdempotencyService,
} from './mcp-idempotency.service';
import { McpPermissionService } from './mcp-permission.service';
import { McpVectorIndexService } from './mcp-vector-index.service';
import { formatPgVector } from '../utils/mcp-vector-sql.util';
import { getMcpSafeErrorMessage } from '../utils/mcp-error.util';
import { McpActorAccessService } from './mcp-actor-access.service';
import { McpAttachmentService } from './mcp-attachment.service';
import { McpPageHistoryService } from './mcp-page-history.service';
import type { McpAuditLogInput } from '../types/mcp.types';
import {
  McpToolCallParams,
  McpToolCallResult,
  McpToolContext,
  McpToolDefinition,
} from '../types/mcp-tool.types';
import { McpToolInputValidator } from './mcp-tool-input-validator';
import { McpTemplateService } from './mcp-template.service';
import { McpPageMoveService } from './mcp-page-move.service';
import { McpCatalogBundleService } from './mcp-catalog-bundle.service';
import { McpCatalogV2Service } from './mcp-catalog-v2.service';
import { McpCatalogV3Service } from './mcp-catalog-v3.service';

type PageResult = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  spaceId: string;
  workspaceId: string;
  creatorId: string | null;
  lastUpdatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  content?: Json | null;
  textContent?: string | null;
};

type SearchItem = {
  pageId: string;
  spaceId: string;
  title: string | null;
  snippet: string | null;
  updatedAt?: Date;
  scores: {
    keyword?: number;
    semantic?: number;
    recency?: number;
    final: number;
  };
  source: 'keyword' | 'semantic' | 'hybrid';
  contentSource: {
    type: 'page' | 'attachment';
    attachmentId?: string;
    fileName?: string;
  };
};

type PageMetadata = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  spaceId: string;
  workspaceId: string;
  creatorId: string | null;
  lastUpdatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type PageWriteResponse = {
  page: PageMetadata;
  index: unknown | null;
  warnings: string[];
};

type PageRecoveryState = {
  title: string | null;
  icon: string | null;
  contentHash: string | null;
  deleted: boolean;
};

const MAX_SEARCH_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const RECENCY_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
const AUDIT_PERSISTENCE_WARNING =
  'MCP operation succeeded, but its audit log could not be persisted';

@Injectable()
export class McpToolService {
  private readonly logger = new Logger(McpToolService.name);
  private readonly inputValidator = new McpToolInputValidator();
  private toolDefinitions?: McpToolDefinition[];

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly auditService: McpAuditService,
    private readonly attachmentMcpService: McpAttachmentService,
    private readonly embeddingService: McpEmbeddingService,
    private readonly environmentService: EnvironmentService,
    private readonly idempotencyService: McpIdempotencyService,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageHistoryMcpService: McpPageHistoryService,
    private readonly pageMoveMcpService: McpPageMoveService,
    private readonly catalogBundleService: McpCatalogBundleService,
    private readonly catalogV2Service: McpCatalogV2Service,
    private readonly catalogV3Service: McpCatalogV3Service,
    private readonly permissionService: McpPermissionService,
    private readonly templateMcpService: McpTemplateService,
    private readonly vectorIndexService: McpVectorIndexService,
    private readonly actorAccessService: McpActorAccessService,
    private readonly pageTreeScopeService: PageTreeScopeService,
  ) {}

  listTools(): McpToolDefinition[] {
    if (this.toolDefinitions) {
      return this.toolDefinitions;
    }
    const tools: McpToolDefinition[] = [
      {
        name: 'list_spaces',
        description: 'List Docmost spaces visible to this MCP token.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'list_pages',
        description:
          'List the immediate children of one allowed space or parent page. Omit parentPageId for root pages; when search permission is available, use search_docs in keyword mode to locate a page by name without walking the tree.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string' },
            parentPageId: {
              type: ['string', 'null'],
              description:
                'Parent page UUID. Omit or pass null to list only root pages.',
            },
            limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT },
            offset: { type: 'number', minimum: 0 },
          },
          required: ['spaceId'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_page',
        description: 'Read one Docmost page in markdown, html, or json format.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            slugId: { type: 'string' },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
          },
          additionalProperties: false,
        },
      },
      ...this.pageMoveMcpService.listTools(),
      ...this.catalogBundleService.listTools(),
      ...this.catalogV2Service.listTools(),
      ...this.catalogV3Service.listTools(),
      {
        name: 'list_page_versions',
        description: 'List saved versions for one readable Docmost page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT },
            cursor: { type: 'string' },
          },
          required: ['pageId'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_page_version',
        description: 'Read one saved page version.',
        inputSchema: {
          type: 'object',
          properties: {
            historyId: { type: 'string' },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
          },
          required: ['historyId'],
          additionalProperties: false,
        },
      },
      {
        name: 'diff_page_versions',
        description:
          'Create a unified markdown diff between two saved versions, or a saved version and the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            fromHistoryId: { type: 'string' },
            toHistoryId: { type: 'string' },
          },
          required: ['pageId', 'fromHistoryId'],
          additionalProperties: false,
        },
      },
      {
        name: 'restore_page_version',
        description:
          'Restore a saved title and page body with optimistic concurrency protection.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            historyId: { type: 'string' },
            expectedUpdatedAt: { type: 'string' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['pageId', 'historyId', 'expectedUpdatedAt', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_attachments',
        description: 'List file attachments belonging to one readable page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT },
            offset: { type: 'number', minimum: 0 },
          },
          required: ['pageId'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_attachment',
        description:
          'Get attachment metadata, an expiring signed download URL, and optional extracted text.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            expiresInSeconds: {
              type: 'number',
              minimum: 60,
              maximum: 3600,
            },
            includeExtractedText: { type: 'boolean' },
          },
          required: ['attachmentId'],
          additionalProperties: false,
        },
      },
      {
        name: 'upload_attachment',
        description:
          'Upload a base64-encoded page attachment up to 512 KiB. Large-file upload URLs are not yet supported.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            fileName: { type: 'string' },
            contentBase64: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['pageId', 'fileName', 'contentBase64'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_attachment',
        description:
          'Permanently delete one page attachment from storage and metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['attachmentId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'search_docs',
        description:
          'Search allowed Docmost spaces with keyword, semantic, or hybrid mode.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            spaceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            rootPageId: {
              type: 'string',
              format: 'uuid',
              minLength: 1,
              description:
                'Limit search to this readable page and its descendants.',
            },
            limit: { type: 'number', minimum: 1, maximum: MAX_SEARCH_LIMIT },
            mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'] },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'semantic_search_docs',
        description:
          'Run vector-only search in spaces with semantic-search permission.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            spaceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            rootPageId: {
              type: 'string',
              format: 'uuid',
              minLength: 1,
              description:
                'Limit search to this readable page and its descendants.',
            },
            limit: { type: 'number', minimum: 1, maximum: MAX_SEARCH_LIMIT },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'create_page',
        description:
          'Create a Docmost page in a space with create permission. Search first to avoid duplicates, then read the created page back when exact Markdown fidelity matters.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string' },
            parentPageId: { type: 'string' },
            title: { type: 'string' },
            icon: { type: 'string' },
            content: { type: ['string', 'object'] },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
            idempotencyKey: { type: 'string' },
          },
          required: ['spaceId', 'title'],
          additionalProperties: false,
        },
      },
      {
        name: 'update_page',
        description:
          'Replace a page title, icon, or content with optimistic concurrency protection. Read the page immediately before updating and read content back after success to verify Markdown fidelity. On a conflict, read it again, reconcile the change, and use the new updatedAt plus a new idempotencyKey.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            title: { type: 'string' },
            icon: { type: 'string' },
            content: { type: ['string', 'object'] },
            format: { type: 'string', enum: ['markdown', 'html', 'json'] },
            expectedUpdatedAt: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['pageId'],
          additionalProperties: false,
        },
      },
      {
        name: 'append_page',
        description:
          'Append Markdown with optimistic concurrency protection. Read the page immediately before appending and read content back after success to verify Markdown fidelity. On a conflict, read it again and retry the reconciled request with a new idempotencyKey.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            content: { type: 'string' },
            heading: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
          required: ['pageId', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_page',
        description:
          'Soft-delete a page. Permanent deletion is intentionally unsupported.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            reason: { type: 'string' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['pageId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'restore_page',
        description: 'Restore a soft-deleted page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            reason: { type: 'string' },
            idempotencyKey: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['pageId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'reindex_page',
        description: 'Rebuild the vector index for one allowed page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
          },
          required: ['pageId'],
          additionalProperties: false,
        },
      },
      {
        name: 'reindex_space',
        description:
          'Queue vector reindex jobs for all pages in one allowed space.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 1000 },
            confirm: { type: 'boolean' },
          },
          required: ['spaceId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'reindex_workspace',
        description:
          'Queue vector reindex jobs for all spaces with index permission.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 1000 },
            confirm: { type: 'boolean' },
          },
          required: ['confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_index_status',
        description: 'Read vector index status for one allowed page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
          },
          required: ['pageId'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_index_jobs',
        description: 'List recent vector index jobs in allowed spaces.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string' },
            spaceId: { type: 'string' },
            status: {
              type: 'string',
              enum: [
                'queued',
                'running',
                'paused',
                'succeeded',
                'failed',
                'cancelled',
              ],
            },
            limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'retry_index_job',
        description:
          'Retry a failed or queued vector index job in an allowed scope.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['jobId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'pause_index_job',
        description: 'Pause a running or queued batch vector index job.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['jobId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'resume_index_job',
        description: 'Resume a paused batch vector index job.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['jobId', 'confirm'],
          additionalProperties: false,
        },
      },
      {
        name: 'cancel_index_job',
        description: 'Cancel an active vector index job.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            confirm: { type: 'boolean' },
          },
          required: ['jobId', 'confirm'],
          additionalProperties: false,
        },
      },
      ...this.templateMcpService.listTools(),
    ];
    this.toolDefinitions = tools.map((definition) =>
      this.inputValidator.hardenDefinition(definition),
    );
    return this.toolDefinitions;
  }

  async callTool(
    params: McpToolCallParams,
    context: McpToolContext,
  ): Promise<McpToolCallResult> {
    if (!params?.name) {
      throw new BadRequestException('MCP tool name is required');
    }

    const args = this.asObject(params.arguments);
    const definition = this.listTools().find(
      (candidate) => candidate.name === params.name,
    );
    if (!definition) {
      throw new NotFoundException(`Unknown MCP tool: ${params.name}`);
    }
    this.inputValidator.validate(definition, args);
    let result: unknown;

    try {
      result = await this.dispatchTool(params.name, args, context);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        const pageId =
          typeof args.pageId === 'string' ? args.pageId : undefined;
        const spaceId =
          typeof args.spaceId === 'string' ? args.spaceId : undefined;
        const attachmentId =
          typeof args.attachmentId === 'string' ? args.attachmentId : undefined;
        const historyId =
          typeof args.historyId === 'string' ? args.historyId : undefined;
        const templateId =
          typeof args.templateId === 'string' ? args.templateId : undefined;
        const targetSpaceId =
          typeof args.targetSpaceId === 'string'
            ? args.targetSpaceId
            : undefined;
        const deniedSpaceId = spaceId ?? targetSpaceId;
        const moveResourceType =
          params.name === 'move_pages'
            ? 'page_batch'
            : params.name === 'move_page'
              ? 'page'
              : undefined;
        await this.auditService.logPermissionDenied({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: context.client.actorUserId,
          toolName: params.name,
          action: params.name,
          spaceId: deniedSpaceId,
          resourceType: attachmentId
            ? 'attachment'
            : historyId
              ? 'page_history'
              : templateId
                ? 'template'
                : pageId
                  ? 'page'
                  : moveResourceType
                    ? moveResourceType
                    : deniedSpaceId
                      ? 'space'
                      : 'permission',
          resourceId:
            attachmentId ?? historyId ?? templateId ?? pageId ?? deniedSpaceId,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
        });
        this.logger.warn({
          requestId: context.requestId,
          clientId: context.client.id,
          workspaceId: context.client.workspaceId,
          toolName: params.name,
          resourceId:
            attachmentId ??
            historyId ??
            templateId ??
            pageId ??
            deniedSpaceId ??
            null,
          event: 'mcp.permission.denied',
        });
      }

      throw err;
    }

    const text = this.catalogBundleService.isCatalogTool(params.name)
      ? this.catalogBundleService.summarize(result as never)
      : this.catalogV2Service.isCatalogV2Tool(params.name)
        ? this.catalogV2Service.summarize(result as never)
        : this.catalogV3Service.isCatalogV3Tool(params.name)
          ? this.catalogV3Service.summarize(result as never)
          : JSON.stringify(result, null, 2);
    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      structuredContent: result,
    };
  }

  private async dispatchTool(
    name: string,
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    switch (name) {
      case 'list_spaces':
        return this.listSpaces(context);
      case 'list_pages':
        return this.listPages(args, context);
      case 'get_page':
        return this.getPage(args, context);
      case 'get_page_tree':
      case 'preview_page_move':
      case 'move_page':
      case 'move_pages':
        return this.pageMoveMcpService.callTool(name, args, context);
      case 'resolve_catalog_bundle':
      case 'resolve_catalog_delta':
        return this.catalogBundleService.callTool(name, args, context);
      case 'resolve_catalog_bundle_v2':
      case 'resolve_catalog_delta_v2':
        return this.catalogV2Service.callTool(name, args, context);
      case 'begin_catalog_resolution':
      case 'resolve_catalog_bundle_v3':
      case 'resolve_catalog_delta_v3':
        return this.catalogV3Service.callTool(name, args, context);
      case 'list_page_versions':
        return this.pageHistoryMcpService.listPageVersions(
          {
            pageId: this.requireString(args, 'pageId'),
            limit: this.getLimit(args, MAX_LIST_LIMIT, 25),
            cursor: this.optionalString(args, 'cursor') ?? undefined,
          },
          context,
        );
      case 'get_page_version':
        return this.pageHistoryMcpService.getPageVersion(
          {
            historyId: this.requireString(args, 'historyId'),
            format: this.getContentFormat(args, 'markdown'),
          },
          context,
        );
      case 'diff_page_versions':
        return this.pageHistoryMcpService.diffPageVersions(
          {
            pageId: this.requireString(args, 'pageId'),
            fromHistoryId: this.requireString(args, 'fromHistoryId'),
            toHistoryId: this.optionalString(args, 'toHistoryId') ?? undefined,
          },
          context,
        );
      case 'restore_page_version':
        this.requireConfirmation(args, 'restore_page_version');
        return this.pageHistoryMcpService.restorePageVersion(
          {
            pageId: this.requireString(args, 'pageId'),
            historyId: this.requireString(args, 'historyId'),
            expectedUpdatedAt: this.requireString(args, 'expectedUpdatedAt'),
            idempotencyKey:
              this.optionalString(args, 'idempotencyKey') ?? undefined,
            confirm: true,
          },
          context,
        );
      case 'list_attachments':
        return this.attachmentMcpService.listAttachments(
          {
            pageId: this.requireString(args, 'pageId'),
            limit: this.getLimit(args, MAX_LIST_LIMIT, 25),
            offset: this.getOffset(args),
          },
          context,
        );
      case 'get_attachment':
        return this.attachmentMcpService.getAttachment(
          {
            attachmentId: this.requireString(args, 'attachmentId'),
            expiresInSeconds: this.getNamedLimit(
              args,
              'expiresInSeconds',
              3600,
              900,
            ),
            includeExtractedText: this.optionalBoolean(
              args,
              'includeExtractedText',
              false,
            ),
          },
          context,
        );
      case 'upload_attachment':
        return this.attachmentMcpService.uploadAttachment(
          {
            pageId: this.requireString(args, 'pageId'),
            fileName: this.requireString(args, 'fileName'),
            contentBase64: this.requireString(args, 'contentBase64'),
            idempotencyKey:
              this.optionalString(args, 'idempotencyKey') ?? undefined,
          },
          context,
        );
      case 'delete_attachment':
        this.requireConfirmation(args, 'delete_attachment');
        return this.attachmentMcpService.deleteAttachment(
          {
            attachmentId: this.requireString(args, 'attachmentId'),
            idempotencyKey:
              this.optionalString(args, 'idempotencyKey') ?? undefined,
            confirm: true,
          },
          context,
        );
      case 'search_docs':
        return this.searchDocs(args, context);
      case 'semantic_search_docs':
        return this.semanticSearchDocs(args, context);
      case 'create_page':
        return this.createPage(args, context);
      case 'update_page':
        return this.updatePage(args, context);
      case 'append_page':
        return this.appendPage(args, context);
      case 'delete_page':
        return this.deletePage(args, context);
      case 'restore_page':
        return this.restorePage(args, context);
      case 'reindex_page':
        return this.reindexPage(args, context);
      case 'reindex_space':
        return this.reindexSpace(args, context);
      case 'reindex_workspace':
        return this.reindexWorkspace(args, context);
      case 'get_index_status':
        return this.getIndexStatus(args, context);
      case 'list_index_jobs':
        return this.listIndexJobs(args, context);
      case 'retry_index_job':
        return this.retryIndexJob(args, context);
      case 'pause_index_job':
        return this.controlIndexJob('pause', args, context);
      case 'resume_index_job':
        return this.controlIndexJob('resume', args, context);
      case 'cancel_index_job':
        return this.controlIndexJob('cancel', args, context);
      default:
        if (name.endsWith('_template') || name === 'list_templates') {
          return this.templateMcpService.callTool(name, args, context);
        }
        throw new NotFoundException(`Unknown MCP tool: ${name}`);
    }
  }

  private async listSpaces(context: McpToolContext): Promise<unknown> {
    const rows = await this.db
      .selectFrom('mcpClientSpacePermissions as permissions')
      .innerJoin('spaces', 'spaces.id', 'permissions.spaceId')
      .select([
        'spaces.id',
        'spaces.name',
        'spaces.slug',
        'spaces.description',
        'spaces.visibility',
        'spaces.isPersonal',
        'spaces.createdAt',
        'spaces.updatedAt',
        'permissions.canSearch',
        'permissions.canSemanticSearch',
        'permissions.canRead',
        'permissions.canCreate',
        'permissions.canUpdate',
        'permissions.canAppend',
        'permissions.canDelete',
        'permissions.canRestore',
        'permissions.canIndex',
      ])
      .where('permissions.clientId', '=', context.client.id)
      .where('permissions.workspaceId', '=', context.client.workspaceId)
      .where('permissions.deletedAt', 'is', null)
      .where('spaces.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('permissions.canSearch', '=', true),
          eb('permissions.canSemanticSearch', '=', true),
          eb('permissions.canRead', '=', true),
          eb('permissions.canCreate', '=', true),
          eb('permissions.canUpdate', '=', true),
          eb('permissions.canAppend', '=', true),
          eb('permissions.canDelete', '=', true),
          eb('permissions.canRestore', '=', true),
          eb('permissions.canIndex', '=', true),
        ]),
      )
      .orderBy('spaces.name', 'asc')
      .execute();
    const actor = await this.actorAccessService.requireActor(context.client);
    const readableSpaceIds = new Set(
      await this.actorAccessService.filterReadableSpaceIds(
        actor,
        rows.map((row) => row.id),
      ),
    );
    const readableRows = rows.filter((row) => readableSpaceIds.has(row.id));
    const effectivePermissions =
      await this.permissionService.resolveEffectivePermissions(
        context.client,
        readableRows.map((row) => ({
          spaceId: row.id,
          permissions: row,
        })),
      );
    const effectiveBySpaceId = new Map(
      effectivePermissions.map((item) => [item.spaceId, item.permissions]),
    );

    return {
      items: readableRows.flatMap((row) => {
        const permissions = effectiveBySpaceId.get(row.id);
        if (!permissions || !Object.values(permissions).some(Boolean)) {
          return [];
        }

        return [
          {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            visibility: row.visibility,
            isPersonal: row.isPersonal,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            permissions,
          },
        ];
      }),
    };
  }

  private async listPages(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const spaceId = this.requireString(args, 'spaceId');
    await this.assertCanListPages(context, spaceId);
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanReadSpace(actor, spaceId);

    const parentPageId = this.optionalString(args, 'parentPageId');
    const limit = this.getLimit(args, MAX_LIST_LIMIT, 25);
    const offset = this.getOffset(args);

    const rows = await this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'spaceId',
        'workspaceId',
        'creatorId',
        'lastUpdatedById',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', context.client.workspaceId)
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .$if(parentPageId == null, (qb) => qb.where('parentPageId', 'is', null))
      .$if(typeof parentPageId === 'string', (qb) =>
        qb.where('parentPageId', '=', parentPageId),
      )
      .orderBy('position', (ob) => ob.collate('C').asc())
      .limit(limit)
      .offset(offset)
      .execute();
    const readablePageIds = new Set(
      await this.actorAccessService.filterReadablePageIds(
        actor,
        rows.map((row) => row.id),
        spaceId,
      ),
    );

    return {
      items: rows.filter((row) => readablePageIds.has(row.id)),
      limit,
      offset,
    };
  }

  private async getPage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const page = await this.getPageByArgs(
      args,
      context.client.workspaceId,
      true,
    );
    await this.permissionService.assertSpacePermission(
      context.client,
      'read',
      page.spaceId,
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanViewPage(actor, page);

    const format = this.optionalString(args, 'format') ?? 'markdown';
    if (!['markdown', 'html', 'json'].includes(format)) {
      throw new BadRequestException('format must be markdown, html, or json');
    }

    const [permissions, indexStatus] = await Promise.all([
      this.getSpacePermissions(context, page.spaceId),
      this.getIndexStatusForPage(context.client.workspaceId, page.id),
      this.maybeAuditRead(context, page),
    ]);

    return {
      page: this.toPageMetadata(page),
      content: this.formatPageContent(page, format),
      format,
      permissions,
      indexStatus,
    };
  }

  private async searchDocs(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const mode = this.optionalString(args, 'mode') ?? 'hybrid';
    if (!['hybrid', 'keyword', 'semantic'].includes(mode)) {
      throw new BadRequestException(
        'mode must be hybrid, keyword, or semantic',
      );
    }

    if (mode === 'semantic') {
      return this.semanticSearchDocs(args, context);
    }

    const query = this.requireQuery(args);
    const limit = this.getLimit(args, MAX_SEARCH_LIMIT, 10);
    const requestedSpaceIds = this.optionalStringArray(args, 'spaceIds');
    const mcpSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'search',
      requestedSpaceIds,
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    const searchSpaceIds = await this.actorAccessService.filterReadableSpaceIds(
      actor,
      mcpSpaceIds,
    );

    if (!searchSpaceIds.length) {
      return { items: [], warnings: ['No spaces allowed for keyword search'] };
    }

    const scopedPageIds = await this.resolveSearchRootPageIds(
      args,
      context,
      actor,
      searchSpaceIds,
    );
    const rawKeywordItems =
      scopedPageIds === undefined
        ? await this.keywordSearch(
            context.client.workspaceId,
            searchSpaceIds,
            query,
            limit,
            actor,
          )
        : await this.keywordSearch(
            context.client.workspaceId,
            searchSpaceIds,
            query,
            limit,
            actor,
            scopedPageIds,
          );
    const keywordItems = await this.filterSearchItemsForActor(
      actor,
      rawKeywordItems,
    );
    const warnings: string[] = [];

    if (mode === 'keyword') {
      return { items: keywordItems, warnings };
    }

    let semanticItems: SearchItem[] = [];
    try {
      semanticItems = await this.semanticSearchItems(
        args,
        context,
        limit,
        searchSpaceIds,
        actor,
        scopedPageIds,
      );
    } catch (err) {
      warnings.push(
        getMcpSafeErrorMessage(
          err,
          'Semantic search is temporarily unavailable',
        ),
      );
    }

    return {
      items: this.mergeSearchItems(keywordItems, semanticItems, limit),
      warnings,
    };
  }

  private async semanticSearchDocs(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const limit = this.getLimit(args, MAX_SEARCH_LIMIT, 10);
    const items = await this.semanticSearchItems(
      args,
      context,
      limit,
      undefined,
    );
    return { items, warnings: [] };
  }

  private async createPage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const spaceId = this.requireString(args, 'spaceId');
    await this.permissionService.assertSpacePermission(
      context.client,
      'create',
      spaceId,
    );
    await this.assertActiveSpace(context.client.workspaceId, spaceId);
    const actor = await this.actorAccessService.requireActor(context.client);

    const title = this.requireString(args, 'title');
    const parentPageId = this.optionalString(args, 'parentPageId');
    if (parentPageId) {
      const parentPage = await this.assertParentPage(spaceId, parentPageId);
      await this.actorAccessService.assertCanEditPage(actor, parentPage);
    } else {
      await this.actorAccessService.assertCanCreateInSpace(actor, spaceId);
    }

    const content = this.optionalContent(args);
    const hasContent = typeof content !== 'undefined';
    const format = hasContent
      ? this.getContentFormat(args, 'markdown')
      : undefined;
    const idempotencyKey = this.optionalString(args, 'idempotencyKey');

    const targetState = {
      workspaceId: context.client.workspaceId,
      spaceId,
      parentPageId: parentPageId ?? null,
      title,
      icon: this.optionalString(args, 'icon') ?? null,
      contentHash: this.getContentHash(content),
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'create_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      operationStage: 'validated',
      targetState,
      getResourceId: (response) => this.getResponsePageId(response),
      reconcile: async (record) => {
        if (!record.resourceId) {
          return { outcome: 'retry' };
        }

        const recoveredPage = await this.findRecoveryPage(
          record.resourceId,
          context.client.workspaceId,
        );
        if (!recoveredPage) {
          return { outcome: 'retry' };
        }
        if (
          recoveredPage.spaceId !== spaceId ||
          recoveredPage.title !== title
        ) {
          return { outcome: 'repair_required' };
        }

        return {
          outcome: 'completed',
          response: await this.buildRecoveredPageResponse(
            context,
            recoveredPage,
            record,
          ),
        };
      },
      run: async (execution) => {
        const page = await this.db.transaction().execute(async (trx) => {
          const createdPage = await this.pageService.create(
            actor.id,
            context.client.workspaceId,
            {
              spaceId,
              parentPageId: parentPageId ?? undefined,
              title,
              icon: this.optionalString(args, 'icon') ?? undefined,
              content,
              format,
            },
            trx,
          );
          await execution.checkpoint({
            stage: 'page_created',
            resourceId: createdPage.id,
          });
          return createdPage;
        });
        const [historyWarnings, indexAttempt, auditWarnings] =
          await Promise.all([
            this.pageHistoryMcpService.capturePageSnapshot(page, actor.id),
            this.tryIndexPage(context, page.id),
            this.auditMutation({
              workspaceId: context.client.workspaceId,
              clientId: context.client.id,
              actorUserId: actor.id,
              event: 'mcp.page.create',
              resourceType: 'page',
              resourceId: page.id,
              spaceId: page.spaceId,
              toolName: 'create_page',
              requestId: context.requestId,
              after: {
                title: page.title,
                spaceId: page.spaceId,
                parentPageId: page.parentPageId,
              },
              metadata: {
                contentHash: this.getContentHash(content),
              },
              ipAddress: context.ipAddress,
            }),
          ]);

        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: page.id,
        });
        return this.buildWriteResponse(page, indexAttempt, [
          ...historyWarnings,
          ...auditWarnings,
        ]);
      },
    });
  }

  private async updatePage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const pageId = this.requireString(args, 'pageId');
    const page = await this.getWritablePage(context, pageId, 'update');
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanEditPage(actor, page);
    const expectedUpdatedAt = this.parseExpectedUpdatedAt(
      this.requireString(args, 'expectedUpdatedAt'),
    );

    const content = this.optionalContent(args);
    const hasContent = typeof content !== 'undefined';
    const title = this.optionalString(args, 'title');
    const icon = this.optionalString(args, 'icon');
    if (
      typeof title === 'undefined' &&
      typeof icon === 'undefined' &&
      !hasContent
    ) {
      throw new BadRequestException(
        'At least one of title, icon, or content is required',
      );
    }

    const format = hasContent
      ? this.getContentFormat(args, 'markdown')
      : undefined;
    const preparedContent = hasContent
      ? await this.pageService.prepareProsemirrorContent(content, format)
      : undefined;
    const idempotencyKey = this.requireString(args, 'idempotencyKey');
    const beforeState = this.getPageRecoveryState(page);
    const targetState: PageRecoveryState = {
      ...beforeState,
      title: title ?? page.title,
      icon: icon ?? page.icon,
      contentHash: preparedContent
        ? this.getContentHash(preparedContent)
        : beforeState.contentHash,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'update_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      resourceId: page.id,
      operationStage: 'validated',
      beforeState,
      targetState,
      getResourceId: (response) => this.getResponsePageId(response),
      reconcile: (record) => this.reconcilePageWrite(context, record, 'page'),
      run: async (execution) => {
        const updatedPage = await this.runPageUpdateWithGuidance(() =>
          this.pageService.update(
            page,
            {
              pageId: page.id,
              title: title ?? undefined,
              icon: icon ?? undefined,
              content,
              operation: hasContent ? 'replace' : undefined,
              format,
            },
            actor,
            { expectedUpdatedAt, preparedContent },
          ),
        );
        await execution.checkpoint({
          stage: 'page_mutated',
          resourceId: page.id,
        });
        const [historyWarnings, indexAttempt, auditWarnings] =
          await Promise.all([
            this.pageHistoryMcpService.capturePageSnapshot(page, actor.id),
            this.tryIndexPage(context, page.id),
            this.auditMutation({
              workspaceId: context.client.workspaceId,
              clientId: context.client.id,
              actorUserId: actor.id,
              event: 'mcp.page.update',
              resourceType: 'page',
              resourceId: page.id,
              spaceId: page.spaceId,
              toolName: 'update_page',
              requestId: context.requestId,
              before: {
                title: page.title,
                icon: page.icon,
                updatedAt: page.updatedAt.toISOString(),
              },
              after: {
                title: updatedPage.title,
                icon: updatedPage.icon,
                updatedAt: updatedPage.updatedAt.toISOString(),
              },
              metadata: {
                contentHash: this.getContentHash(content),
                blindUpdate: false,
              },
              ipAddress: context.ipAddress,
            }),
          ]);

        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: page.id,
        });
        return this.buildWriteResponse(updatedPage, indexAttempt, [
          ...historyWarnings,
          ...auditWarnings,
        ]);
      },
    });
  }

  private async appendPage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const pageId = this.requireString(args, 'pageId');
    const page = await this.getWritablePage(context, pageId, 'append');
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanEditPage(actor, page);
    const expectedUpdatedAt = this.parseExpectedUpdatedAt(
      this.requireString(args, 'expectedUpdatedAt'),
    );
    const content = this.requireString(args, 'content');
    this.assertWriteContentLimit(content);

    const heading = this.optionalString(args, 'heading');
    const markdown = heading
      ? `\n\n## ${heading}\n\n${content}`
      : `\n\n${content}`;
    const preparedContent = await this.pageService.prepareProsemirrorContent(
      markdown,
      'markdown',
    );
    const idempotencyKey = this.requireString(args, 'idempotencyKey');
    const beforeState = this.getPageRecoveryState(page);
    const targetContent = this.appendPreparedContent(
      page.content,
      preparedContent,
    );
    const targetState: PageRecoveryState = {
      ...beforeState,
      contentHash: this.getContentHash(targetContent),
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'append_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      resourceId: page.id,
      operationStage: 'validated',
      beforeState,
      targetState,
      getResourceId: (response) => this.getResponsePageId(response),
      reconcile: (record) => this.reconcilePageWrite(context, record, 'page'),
      run: async (execution) => {
        const updatedPage = await this.runPageUpdateWithGuidance(() =>
          this.pageService.update(
            page,
            {
              pageId: page.id,
              content: markdown,
              operation: 'append',
              format: 'markdown',
            },
            actor,
            { expectedUpdatedAt, preparedContent },
          ),
        );
        await execution.checkpoint({
          stage: 'page_mutated',
          resourceId: page.id,
        });
        const [historyWarnings, indexAttempt, auditWarnings] =
          await Promise.all([
            this.pageHistoryMcpService.capturePageSnapshot(page, actor.id),
            this.tryIndexPage(context, page.id),
            this.auditMutation({
              workspaceId: context.client.workspaceId,
              clientId: context.client.id,
              actorUserId: actor.id,
              event: 'mcp.page.append',
              resourceType: 'page',
              resourceId: page.id,
              spaceId: page.spaceId,
              toolName: 'append_page',
              requestId: context.requestId,
              metadata: {
                heading: heading ?? null,
                contentHash: this.getContentHash(content),
                contentLength: content.length,
              },
              ipAddress: context.ipAddress,
            }),
          ]);

        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: page.id,
        });
        return this.buildWriteResponse(updatedPage, indexAttempt, [
          ...historyWarnings,
          ...auditWarnings,
        ]);
      },
    });
  }

  private async deletePage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    this.requireConfirmation(args, 'delete_page');
    const pageId = this.requireString(args, 'pageId');
    const idempotencyKey = this.optionalString(args, 'idempotencyKey');
    const page = await this.getWritablePage(context, pageId, 'delete', {
      includeDeleted: Boolean(idempotencyKey),
    });
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanEditPage(actor, page);
    const beforeState = this.getPageRecoveryState(page);
    const targetState: PageRecoveryState = {
      ...beforeState,
      deleted: true,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'delete_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      resourceId: page.id,
      operationStage: 'validated',
      beforeState,
      targetState,
      getResourceId: () => page.id,
      reconcile: (record) => this.reconcilePageWrite(context, record, 'delete'),
      run: async (execution) => {
        if (page.deletedAt) {
          throw new NotFoundException('Page not found');
        }

        const historyWarnings =
          await this.pageHistoryMcpService.capturePageSnapshot(page, actor.id);
        await this.pageService.removePage(
          page.id,
          actor.id,
          context.client.workspaceId,
        );
        await execution.checkpoint({
          stage: 'page_mutated',
          resourceId: page.id,
        });
        const indexAttempt = await this.tryIndexPage(
          context,
          page.id,
          'delete',
        );

        const auditWarnings = await this.auditMutation({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.page.delete',
          resourceType: 'page',
          resourceId: page.id,
          spaceId: page.spaceId,
          toolName: 'delete_page',
          requestId: context.requestId,
          before: {
            title: page.title,
            spaceId: page.spaceId,
            updatedAt: page.updatedAt.toISOString(),
          },
          metadata: {
            reason: this.optionalString(args, 'reason') ?? null,
          },
          ipAddress: context.ipAddress,
        });

        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: page.id,
        });
        return {
          page: this.toPageMetadata({ ...page, deletedAt: new Date() }),
          index: indexAttempt.index,
          deleted: true,
          warnings: [
            ...historyWarnings,
            ...indexAttempt.warnings,
            ...auditWarnings,
          ],
        };
      },
    });
  }

  private async restorePage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    this.requireConfirmation(args, 'restore_page');
    const pageId = this.requireString(args, 'pageId');
    const target = await this.permissionService.assertPagePermission(
      context.client,
      'restore',
      pageId,
      { includeDeleted: true },
    );
    const page = await this.pageRepo.findById(target.id, {
      includeContent: true,
      includeTextContent: true,
    });
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanEditPage(actor, page);
    const idempotencyKey = this.optionalString(args, 'idempotencyKey');
    const beforeState = this.getPageRecoveryState(page);
    const targetState: PageRecoveryState = {
      ...beforeState,
      deleted: false,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'restore_page',
      idempotencyKey,
      request: args,
      resourceType: 'page',
      resourceId: page.id,
      operationStage: 'validated',
      beforeState,
      targetState,
      getResourceId: (response) => this.getResponsePageId(response),
      reconcile: (record) =>
        this.reconcilePageWrite(context, record, 'restore'),
      run: async (execution) => {
        await this.pageRepo.restorePage(page.id, context.client.workspaceId);
        await execution.checkpoint({
          stage: 'page_mutated',
          resourceId: page.id,
        });
        const restoredPage =
          (await this.pageRepo.findById(page.id, {
            includeContent: true,
            includeTextContent: true,
          })) ?? page;
        const indexAttempt = await this.tryIndexPage(
          context,
          page.id,
          'restore',
        );

        const auditWarnings = await this.auditMutation({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.page.restore',
          resourceType: 'page',
          resourceId: page.id,
          spaceId: page.spaceId,
          toolName: 'restore_page',
          requestId: context.requestId,
          after: {
            title: page.title,
            spaceId: page.spaceId,
          },
          metadata: {
            reason: this.optionalString(args, 'reason') ?? null,
          },
          ipAddress: context.ipAddress,
        });

        await execution.checkpoint({
          stage: 'side_effects_complete',
          resourceId: page.id,
        });
        return this.buildWriteResponse(
          restoredPage,
          indexAttempt,
          auditWarnings,
        );
      },
    });
  }

  private async reindexPage(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const pageId = this.requireString(args, 'pageId');
    const page = await this.permissionService.assertPagePermission(
      context.client,
      'index',
      pageId,
      { includeDeleted: true },
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanViewPage(actor, page);

    const result = await this.vectorIndexService.indexPage({
      workspaceId: context.client.workspaceId,
      pageId: page.id,
      requestedByClientId: context.client.id,
      requestedByUserId: context.client.actorUserId,
    });

    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.page.reindex',
      resourceType: 'page',
      resourceId: page.id,
      spaceId: page.spaceId,
      toolName: 'reindex_page',
      requestId: context.requestId,
      metadata: {
        jobId: result.jobId,
        status: result.status,
      },
      ipAddress: context.ipAddress,
    });

    return this.appendWarnings(result, auditWarnings);
  }

  private async reindexSpace(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    this.requireConfirmation(args, 'reindex_space');
    const spaceId = this.requireString(args, 'spaceId');
    await this.permissionService.assertSpacePermission(
      context.client,
      'index',
      spaceId,
    );
    await this.assertActiveSpace(context.client.workspaceId, spaceId);
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanReadSpace(actor, spaceId);

    const result = await this.vectorIndexService.enqueueSpace({
      workspaceId: context.client.workspaceId,
      spaceId,
      requestedByClientId: context.client.id,
      requestedByUserId: context.client.actorUserId,
      limit: this.getLimit(args, 1000, 1000),
    });

    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.space.reindex',
      resourceType: 'space',
      resourceId: spaceId,
      spaceId,
      toolName: 'reindex_space',
      requestId: context.requestId,
      metadata: {
        jobId: result.jobId,
        status: result.status,
      },
      ipAddress: context.ipAddress,
    });

    return this.appendWarnings(result, auditWarnings);
  }

  private async reindexWorkspace(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    this.requireConfirmation(args, 'reindex_workspace');
    const mcpSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'index',
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    const allowedSpaceIds =
      await this.actorAccessService.filterReadableSpaceIds(actor, mcpSpaceIds);

    if (allowedSpaceIds.length === 0) {
      throw new ForbiddenException('MCP permission denied');
    }

    const result = await this.vectorIndexService.enqueueWorkspace({
      workspaceId: context.client.workspaceId,
      spaceIds: allowedSpaceIds,
      requestedByClientId: context.client.id,
      requestedByUserId: context.client.actorUserId,
      limit: this.getLimit(args, 1000, 1000),
    });

    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.workspace.reindex',
      resourceType: 'workspace',
      resourceId: context.client.workspaceId,
      toolName: 'reindex_workspace',
      requestId: context.requestId,
      metadata: {
        jobId: result.jobId,
        allowedSpaceCount: allowedSpaceIds.length,
        status: result.status,
      },
      ipAddress: context.ipAddress,
    });

    return this.appendWarnings(result, auditWarnings);
  }

  private async getIndexStatus(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const pageId = this.requireString(args, 'pageId');
    const page = await this.permissionService.resolvePageTarget(
      context.client,
      pageId,
      { includeDeleted: true },
    );
    const canRead = await this.permissionService.hasSpacePermission(
      context.client,
      'read',
      page.spaceId,
    );
    const canIndex = await this.permissionService.hasSpacePermission(
      context.client,
      'index',
      page.spaceId,
    );

    if (!canRead && !canIndex) {
      throw new ForbiddenException('MCP permission denied');
    }
    const actor = await this.actorAccessService.requireActor(context.client);
    await this.actorAccessService.assertCanViewPage(actor, page);

    return this.getIndexStatusForPage(context.client.workspaceId, page.id);
  }

  private async listIndexJobs(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const limit = this.getLimit(args, MAX_LIST_LIMIT, 20);
    const pageId = this.optionalString(args, 'pageId');
    const spaceId = this.optionalString(args, 'spaceId');
    const status = this.optionalString(args, 'status');

    if (pageId) {
      const page = await this.permissionService.resolvePageTarget(
        context.client,
        pageId,
        { includeDeleted: true },
      );
      await this.assertCanReadIndexStatusForSpace(context, page.spaceId);
      const actor = await this.actorAccessService.requireActor(context.client);
      await this.actorAccessService.assertCanViewPage(actor, page);
      return this.queryIndexJobs(context.client.workspaceId, {
        pageId: page.id,
        status,
        limit,
      });
    }

    if (spaceId) {
      await this.assertCanReadIndexStatusForSpace(context, spaceId);
      const actor = await this.actorAccessService.requireActor(context.client);
      await this.actorAccessService.assertCanReadSpace(actor, spaceId);
      return this.queryIndexJobs(context.client.workspaceId, {
        spaceId,
        status,
        limit,
      });
    }

    const mcpSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'index',
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    const allowedSpaceIds =
      await this.actorAccessService.filterReadableSpaceIds(actor, mcpSpaceIds);

    if (allowedSpaceIds.length === 0) {
      throw new ForbiddenException('MCP permission denied');
    }

    return this.queryIndexJobs(context.client.workspaceId, {
      spaceIds: allowedSpaceIds,
      status,
      limit,
    });
  }

  private async retryIndexJob(
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    this.requireConfirmation(args, 'retry_index_job');
    const jobId = this.requireString(args, 'jobId');
    const { job, workspaceSpaceIds: retrySpaceIds } =
      await this.authorizeIndexJob(context, jobId);

    const result = await this.vectorIndexService.retryJob(job.id, {
      spaceIds: retrySpaceIds,
    });

    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.index.retry',
      resourceType: 'mcp_index_job',
      resourceId: job.id,
      spaceId: job.spaceId,
      toolName: 'retry_index_job',
      requestId: context.requestId,
      metadata: {
        jobType: job.jobType,
        statusBeforeRetry: job.status,
      },
      ipAddress: context.ipAddress,
    });

    return this.appendWarnings(result, auditWarnings);
  }

  private async controlIndexJob(
    action: 'pause' | 'resume' | 'cancel',
    args: JsonObject,
    context: McpToolContext,
  ): Promise<unknown> {
    const toolName = `${action}_index_job`;
    this.requireConfirmation(args, toolName);
    const jobId = this.requireString(args, 'jobId');
    const { job, workspaceSpaceIds } = await this.authorizeIndexJob(
      context,
      jobId,
    );

    const result =
      action === 'pause'
        ? await this.vectorIndexService.pauseJob(job.id)
        : action === 'resume'
          ? await this.vectorIndexService.resumeJob(job.id, {
              spaceIds: workspaceSpaceIds,
            })
          : await this.vectorIndexService.cancelJob(job.id);
    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: `mcp.index.${action}`,
      resourceType: 'mcp_index_job',
      resourceId: job.id,
      spaceId: job.spaceId,
      toolName,
      requestId: context.requestId,
      metadata: {
        jobType: job.jobType,
        statusBeforeControl: job.status,
      },
      ipAddress: context.ipAddress,
    });
    return this.appendWarnings(result, auditWarnings);
  }

  private async authorizeIndexJob(context: McpToolContext, jobId: string) {
    const job = await this.db
      .selectFrom('docmostMcpIndexJobs')
      .selectAll()
      .where('id', '=', jobId)
      .where('workspaceId', '=', context.client.workspaceId)
      .executeTakeFirst();
    if (!job) {
      throw new NotFoundException('MCP vector index job not found');
    }

    if (job.pageId) {
      const page = await this.permissionService.resolvePageTarget(
        context.client,
        job.pageId,
        { includeDeleted: true },
      );
      await this.permissionService.assertSpacePermission(
        context.client,
        'index',
        page.spaceId,
      );
      const actor = await this.actorAccessService.requireActor(context.client);
      await this.actorAccessService.assertCanViewPage(actor, page);
      return { job, workspaceSpaceIds: undefined };
    }

    if (job.spaceId) {
      await this.permissionService.assertSpacePermission(
        context.client,
        'index',
        job.spaceId,
      );
      const actor = await this.actorAccessService.requireActor(context.client);
      await this.actorAccessService.assertCanReadSpace(actor, job.spaceId);
      return { job, workspaceSpaceIds: undefined };
    }

    const mcpSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'index',
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    const allowedSpaceIds =
      await this.actorAccessService.filterReadableSpaceIds(actor, mcpSpaceIds);
    if (allowedSpaceIds.length === 0) {
      throw new ForbiddenException('MCP permission denied');
    }
    return { job, workspaceSpaceIds: allowedSpaceIds };
  }

  private async keywordSearch(
    workspaceId: string,
    spaceIds: string[],
    query: string,
    limit: number,
    actor: User,
    scopedPageIds?: string[],
  ): Promise<SearchItem[]> {
    let keywordQuery = this.db
      .selectFrom('pages')
      .select([
        'id',
        'spaceId',
        'title',
        'updatedAt',
        sql<number>`ts_rank(tsv, websearch_to_tsquery('english', f_unaccent(${query})))`.as(
          'score',
        ),
        sql<string>`ts_headline('english', text_content, websearch_to_tsquery('english', f_unaccent(${query})), 'MinWords=8, MaxWords=24, MaxFragments=2')`.as(
          'snippet',
        ),
      ])
      .where('workspaceId', '=', workspaceId)
      .where('spaceId', 'in', spaceIds)
      .where(
        this.actorAccessService.getReadablePagePredicate(actor, 'pages.id'),
      )
      .where('deletedAt', 'is', null);

    if (scopedPageIds !== undefined) {
      keywordQuery = keywordQuery.where(
        sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`,
      );
    }

    const rows = await keywordQuery
      .where(
        'tsv',
        '@@',
        sql<string>`websearch_to_tsquery('english', f_unaccent(${query}))`,
      )
      .orderBy('score', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      pageId: row.id,
      spaceId: row.spaceId,
      title: row.title,
      snippet: this.normalizeSnippet(row.snippet),
      updatedAt: row.updatedAt,
      scores: {
        keyword: Number(row.score),
        final: Number(row.score),
      },
      source: 'keyword',
      contentSource: { type: 'page' },
    }));
  }

  private async semanticSearchItems(
    args: JsonObject,
    context: McpToolContext,
    limit: number,
    requiredSearchSpaceIds?: string[],
    actor?: User,
    preResolvedScopedPageIds?: string[],
  ): Promise<SearchItem[]> {
    const query = this.requireQuery(args);
    const requestedSpaceIds = this.optionalStringArray(args, 'spaceIds');
    const mcpSpaceIds = await this.permissionService.getAllowedSpaceIds(
      context.client,
      'semanticSearch',
      requestedSpaceIds,
    );
    const resolvedActor =
      actor ?? (await this.actorAccessService.requireActor(context.client));
    let spaceIds = await this.actorAccessService.filterReadableSpaceIds(
      resolvedActor,
      mcpSpaceIds,
    );

    if (requiredSearchSpaceIds) {
      const searchSpaceIdSet = new Set(requiredSearchSpaceIds);
      spaceIds = spaceIds.filter((spaceId) => searchSpaceIdSet.has(spaceId));
    }

    if (!spaceIds.length) {
      return [];
    }

    const scopedPageIds =
      preResolvedScopedPageIds ??
      (await this.resolveSearchRootPageIds(
        args,
        context,
        resolvedActor,
        spaceIds,
      ));
    if (scopedPageIds?.length === 0) {
      return [];
    }

    if (!this.environmentService.isVectorSearchEnabled()) {
      throw new BadGatewayException('Vector search is disabled');
    }

    const [embedding] = await this.embeddingService.createEmbeddings([query]);
    const vector = formatPgVector(embedding);
    const distance = sql<number>`chunks.embedding <=> ${vector}::vector`;
    const mapRows = (
      rows: Array<{
        pageId: string;
        spaceId: string;
        title: string | null;
        updatedAt: Date;
        content: string;
        metadata: Json;
        score: number;
      }>,
    ) =>
      this.dedupeBestSemanticItems(
        rows.map((row) => ({
          pageId: row.pageId,
          spaceId: row.spaceId,
          title: row.title,
          snippet: row.content,
          updatedAt: row.updatedAt,
          scores: {
            semantic: Number(row.score),
            final: Number(row.score),
          },
          source: 'semantic',
          contentSource: this.toSearchContentSource(row.metadata),
        })),
      );

    let semanticItems: SearchItem[];
    if (
      await this.shouldUseExactVectorSearch(
        context.client.workspaceId,
        scopedPageIds,
      )
    ) {
      let bestChunksQuery = this.db
        .selectFrom('docmostMcpChunks as chunks')
        .innerJoin('pages', (join) =>
          join
            .onRef('pages.id', '=', 'chunks.pageId')
            .onRef('pages.workspaceId', '=', 'chunks.workspaceId'),
        )
        .select([
          'chunks.pageId',
          'pages.spaceId',
          'pages.title',
          'pages.updatedAt',
          'chunks.content',
          'chunks.chunkIndex',
          'chunks.metadata',
          sql<number>`1 - (${distance})`.as('score'),
        ])
        .distinctOn('chunks.pageId')
        .where('chunks.workspaceId', '=', context.client.workspaceId)
        .where('pages.workspaceId', '=', context.client.workspaceId)
        .where('pages.spaceId', 'in', spaceIds)
        .where(
          this.actorAccessService.getReadablePagePredicate(
            resolvedActor,
            'pages.id',
          ),
        );

      if (scopedPageIds !== undefined) {
        bestChunksQuery = bestChunksQuery.where(
          sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`,
        );
      }

      const bestChunks = bestChunksQuery
        .where('pages.deletedAt', 'is', null)
        .where(
          'chunks.embeddingModel',
          '=',
          this.environmentService.getEmbeddingModel(),
        )
        .where('chunks.deletedAt', 'is', null)
        .orderBy('chunks.pageId', 'asc')
        .orderBy(distance, 'asc')
        .orderBy('chunks.chunkIndex', 'asc')
        .as('bestChunks');
      const rows = await this.db
        .selectFrom(bestChunks)
        .selectAll()
        .orderBy('score', 'desc')
        .limit(limit)
        .execute();
      semanticItems = mapRows(rows);
    } else {
      semanticItems = await this.withHnswIterativeScan(async (trx) => {
        const maxCandidates = this.getVectorAnnMaxCandidates();
        let candidateLimit = this.getVectorAnnCandidateLimit(limit);
        let items: SearchItem[] = [];

        while (true) {
          let candidateQuery = trx
            .selectFrom('docmostMcpChunks as chunks')
            .innerJoin('pages', (join) =>
              join
                .onRef('pages.id', '=', 'chunks.pageId')
                .onRef('pages.workspaceId', '=', 'chunks.workspaceId'),
            )
            .select([
              'chunks.pageId',
              'pages.spaceId',
              'pages.title',
              'pages.updatedAt',
              'chunks.content',
              'chunks.metadata',
              sql<number>`1 - (${distance})`.as('score'),
            ])
            .where('chunks.workspaceId', '=', context.client.workspaceId)
            .where('pages.workspaceId', '=', context.client.workspaceId)
            .where('pages.spaceId', 'in', spaceIds)
            .where(
              this.actorAccessService.getReadablePagePredicate(
                resolvedActor,
                'pages.id',
              ),
            );

          if (scopedPageIds !== undefined) {
            candidateQuery = candidateQuery.where(
              sql<boolean>`pages.id = ANY(${scopedPageIds}::uuid[])`,
            );
          }

          const rows = await candidateQuery
            .where('pages.deletedAt', 'is', null)
            .where(
              'chunks.embeddingModel',
              '=',
              this.environmentService.getEmbeddingModel(),
            )
            .where('chunks.deletedAt', 'is', null)
            .orderBy(distance, 'asc')
            .limit(candidateLimit)
            .execute();
          items = mapRows(rows).slice(0, limit);

          if (
            items.length >= limit ||
            rows.length < candidateLimit ||
            candidateLimit >= maxCandidates
          ) {
            break;
          }
          candidateLimit = Math.min(maxCandidates, candidateLimit * 2);
        }

        return items;
      });
    }

    return this.filterSearchItemsForActor(resolvedActor, semanticItems);
  }

  private async withHnswIterativeScan<T>(
    callback: (trx: KyselyTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      // Filtered HNSW scans otherwise stop after the default ef_search window.
      await sql`SET LOCAL hnsw.iterative_scan = strict_order`.execute(trx);
      return callback(trx);
    });
  }

  private async resolveSearchRootPageIds(
    args: JsonObject,
    context: McpToolContext,
    actor: User,
    allowedSpaceIds: string[],
  ): Promise<string[] | undefined> {
    if (!Object.prototype.hasOwnProperty.call(args, 'rootPageId')) {
      return undefined;
    }

    const rootPageId = this.optionalString(args, 'rootPageId');
    if (!rootPageId) {
      throw new BadRequestException(
        'rootPageId must be a non-empty UUID when provided',
      );
    }

    const scope = await this.pageTreeScopeService.resolveReadableSubtree({
      rootPageId,
      workspaceId: context.client.workspaceId,
      userId: actor.id,
      allowedSpaceIds,
    });
    return scope.pageIds;
  }

  private async shouldUseExactVectorSearch(
    workspaceId: string,
    scopedPageIds?: string[],
  ): Promise<boolean> {
    if (scopedPageIds === undefined) {
      return false;
    }

    const threshold = Math.max(
      1,
      this.environmentService.getVectorExactChunkThreshold?.() ?? 4000,
    );
    const overflowChunk = await this.db
      .selectFrom('docmostMcpChunks as chunks')
      .select('chunks.id')
      .where('chunks.workspaceId', '=', workspaceId)
      .where(
        'chunks.embeddingModel',
        '=',
        this.environmentService.getEmbeddingModel(),
      )
      .where('chunks.deletedAt', 'is', null)
      .where(sql<boolean>`chunks.page_id = ANY(${scopedPageIds}::uuid[])`)
      .limit(1)
      .offset(threshold)
      .executeTakeFirst();

    return !overflowChunk;
  }

  private getVectorAnnMaxCandidates(): number {
    return Math.max(
      100,
      this.environmentService.getVectorAnnMaxCandidates?.() ?? 5000,
    );
  }

  private getVectorAnnCandidateLimit(resultLimit: number): number {
    const multiplier = Math.max(
      2,
      this.environmentService.getVectorAnnCandidateMultiplier?.() ?? 24,
    );
    return Math.min(
      this.getVectorAnnMaxCandidates(),
      Math.max(200, resultLimit * multiplier),
    );
  }

  private async filterSearchItemsForActor(
    actor: User,
    items: SearchItem[],
  ): Promise<SearchItem[]> {
    const readablePageIds = new Set(
      await this.actorAccessService.filterReadablePageIds(
        actor,
        items.map((item) => item.pageId),
      ),
    );
    return items.filter((item) => readablePageIds.has(item.pageId));
  }

  private mergeSearchItems(
    keywordItems: SearchItem[],
    semanticItems: SearchItem[],
    limit: number,
  ): SearchItem[] {
    const weights = this.getHybridWeights();
    const bestSemanticItems = this.dedupeBestSemanticItems(semanticItems);
    const normalizedKeyword = this.normalizeSearchScores(
      keywordItems,
      'keyword',
    );
    const normalizedSemantic = this.normalizeSearchScores(
      bestSemanticItems,
      'semantic',
    );
    const keywordPageIds = new Set(keywordItems.map((item) => item.pageId));
    const semanticPageIds = new Set(
      bestSemanticItems.map((item) => item.pageId),
    );
    const byPage = new Map<string, SearchItem>();

    for (const item of keywordItems) {
      byPage.set(item.pageId, {
        ...item,
        scores: { ...item.scores },
      });
    }

    for (const item of bestSemanticItems) {
      const existing = byPage.get(item.pageId);
      if (!existing) {
        byPage.set(item.pageId, {
          ...item,
          scores: { ...item.scores },
        });
        continue;
      }

      existing.snippet = existing.snippet || item.snippet;
      existing.updatedAt = existing.updatedAt ?? item.updatedAt;
      existing.source = 'hybrid';
      existing.scores.semantic = item.scores.semantic ?? 0;
    }

    for (const item of byPage.values()) {
      const keywordScore = normalizedKeyword.get(item.pageId) ?? 0;
      const semanticScore = normalizedSemantic.get(item.pageId) ?? 0;
      const recencyScore = this.getRecencyScore(item.updatedAt);
      item.scores.keyword = keywordScore;
      item.scores.semantic = semanticScore;
      item.scores.recency = recencyScore;
      item.scores.final =
        keywordScore * weights.keyword +
        semanticScore * weights.semantic +
        recencyScore * weights.recency;
      item.source =
        keywordPageIds.has(item.pageId) && semanticPageIds.has(item.pageId)
          ? 'hybrid'
          : semanticPageIds.has(item.pageId)
            ? 'semantic'
            : 'keyword';
    }

    return Array.from(byPage.values())
      .sort(
        (a, b) =>
          b.scores.final - a.scores.final || a.pageId.localeCompare(b.pageId),
      )
      .slice(0, limit);
  }

  private dedupeBestSemanticItems(items: SearchItem[]): SearchItem[] {
    const bestByPage = new Map<string, SearchItem>();
    for (const item of items) {
      const existing = bestByPage.get(item.pageId);
      if (
        !existing ||
        (item.scores.semantic ?? Number.NEGATIVE_INFINITY) >
          (existing.scores.semantic ?? Number.NEGATIVE_INFINITY)
      ) {
        bestByPage.set(item.pageId, item);
      }
    }
    return [...bestByPage.values()];
  }

  private normalizeSearchScores(
    items: SearchItem[],
    component: 'keyword' | 'semantic',
  ): Map<string, number> {
    const scores = items
      .map((item) => item.scores[component])
      .filter((score): score is number => Number.isFinite(score));
    const normalized = new Map<string, number>();
    if (scores.length === 0) {
      return normalized;
    }

    const minimum = Math.min(...scores);
    const maximum = Math.max(...scores);
    for (const item of items) {
      const score = item.scores[component];
      if (!Number.isFinite(score)) {
        continue;
      }
      normalized.set(
        item.pageId,
        maximum === minimum ? 1 : (score - minimum) / (maximum - minimum),
      );
    }
    return normalized;
  }

  private getHybridWeights(): {
    semantic: number;
    keyword: number;
    recency: number;
  } {
    const configured = {
      semantic: Math.max(
        0,
        this.environmentService.getVectorHybridSemanticWeight(),
      ),
      keyword: Math.max(
        0,
        this.environmentService.getVectorHybridKeywordWeight(),
      ),
      recency: Math.max(
        0,
        this.environmentService.getVectorHybridRecencyWeight(),
      ),
    };
    const total = configured.semantic + configured.keyword + configured.recency;
    if (!Number.isFinite(total) || total <= 0) {
      return { semantic: 0.65, keyword: 0.25, recency: 0.1 };
    }
    return {
      semantic: configured.semantic / total,
      keyword: configured.keyword / total,
      recency: configured.recency / total,
    };
  }

  private getRecencyScore(updatedAt?: Date): number {
    if (!updatedAt) {
      return 0;
    }
    const updatedAtTime = new Date(updatedAt).getTime();
    if (!Number.isFinite(updatedAtTime)) {
      return 0;
    }
    const age = Math.max(0, Date.now() - updatedAtTime);
    return 2 ** (-age / RECENCY_HALF_LIFE_MS);
  }

  private async getPageByArgs(
    args: JsonObject,
    workspaceId: string,
    includeContent: boolean,
  ): Promise<PageResult> {
    const pageId = this.optionalString(args, 'pageId');
    const slugId = this.optionalString(args, 'slugId');

    if (!pageId && !slugId) {
      throw new BadRequestException('pageId or slugId is required');
    }

    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'spaceId',
        'workspaceId',
        'creatorId',
        'lastUpdatedById',
        'createdAt',
        'updatedAt',
        'deletedAt',
      ])
      .$if(includeContent, (qb) => qb.select(['content', 'textContent']))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    if (pageId) {
      query = isValidUUID(pageId)
        ? query.where('id', '=', pageId)
        : query.where('slugId', '=', pageId);
    } else {
      query = query.where('slugId', '=', slugId);
    }

    const page = await query.executeTakeFirst();
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    return page;
  }

  private async getIndexStatusForPage(
    workspaceId: string,
    pageId: string,
  ): Promise<unknown> {
    const [chunkStats, lastJob, jobStatusRows, recentJobs] = await Promise.all([
      this.db
        .selectFrom('docmostMcpChunks')
        .select([
          sql<number>`count(*)::int`.as('chunkCount'),
          sql<Date>`max(indexed_at)`.as('lastIndexedAt'),
        ])
        .where('workspaceId', '=', workspaceId)
        .where('pageId', '=', pageId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst(),
      this.db
        .selectFrom('docmostMcpIndexJobs')
        .select([
          'id',
          'status',
          'jobType',
          'lastError',
          'stats',
          'createdAt',
          'startedAt',
          'finishedAt',
        ])
        .where('workspaceId', '=', workspaceId)
        .where('pageId', '=', pageId)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom('docmostMcpIndexJobs')
        .select(['status', sql<number>`count(*)::int`.as('count')])
        .where('workspaceId', '=', workspaceId)
        .where('pageId', '=', pageId)
        .groupBy('status')
        .execute(),
      this.db
        .selectFrom('docmostMcpIndexJobs')
        .select([
          'id',
          'status',
          'jobType',
          'attemptCount',
          'lastError',
          'stats',
          'createdAt',
          'startedAt',
          'finishedAt',
        ])
        .where('workspaceId', '=', workspaceId)
        .where('pageId', '=', pageId)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .execute(),
    ]);

    return {
      pageId,
      chunkCount: chunkStats?.chunkCount ?? 0,
      lastIndexedAt: chunkStats?.lastIndexedAt ?? null,
      jobsByStatus: jobStatusRows.reduce(
        (acc, row) => ({ ...acc, [row.status]: row.count }),
        {} as Record<string, number>,
      ),
      lastJob: lastJob ?? null,
      recentJobs,
    };
  }

  private async assertCanReadIndexStatusForSpace(
    context: McpToolContext,
    spaceId: string,
  ): Promise<void> {
    const canRead = await this.permissionService.hasSpacePermission(
      context.client,
      'read',
      spaceId,
    );
    const canIndex = await this.permissionService.hasSpacePermission(
      context.client,
      'index',
      spaceId,
    );

    if (!canRead && !canIndex) {
      throw new ForbiddenException('MCP permission denied');
    }
  }

  private async queryIndexJobs(
    workspaceId: string,
    opts: {
      pageId?: string;
      spaceId?: string;
      spaceIds?: string[];
      status?: string | null;
      limit: number;
    },
  ): Promise<unknown> {
    this.assertIndexJobStatus(opts.status);

    let query = this.db
      .selectFrom('docmostMcpIndexJobs')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'pageId',
        'jobType',
        'status',
        'attemptCount',
        'lastError',
        'stats',
        'requestedByClientId',
        'requestedByUserId',
        'createdAt',
        'updatedAt',
        'startedAt',
        'finishedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(opts.limit);

    if (opts.pageId) {
      query = query.where('pageId', '=', opts.pageId);
    }

    if (opts.spaceId) {
      query = query.where('spaceId', '=', opts.spaceId);
    }

    if (opts.spaceIds?.length) {
      query = query.where('spaceId', 'in', opts.spaceIds);
    }

    if (opts.status) {
      query = query.where('status', '=', opts.status);
    }

    const items = await query.execute();
    return {
      items,
      meta: {
        count: items.length,
        limit: opts.limit,
      },
    };
  }

  private assertIndexJobStatus(status?: string | null): void {
    if (!status) {
      return;
    }

    if (
      ![
        'queued',
        'running',
        'paused',
        'succeeded',
        'failed',
        'cancelled',
      ].includes(status)
    ) {
      throw new BadRequestException('status is invalid');
    }
  }

  private async assertCanListPages(
    context: McpToolContext,
    spaceId: string,
  ): Promise<void> {
    const canRead = await this.permissionService.hasSpacePermission(
      context.client,
      'read',
      spaceId,
    );
    const canSearch = await this.permissionService.hasSpacePermission(
      context.client,
      'search',
      spaceId,
    );

    if (!canRead && !canSearch) {
      throw new ForbiddenException('MCP permission denied');
    }
  }

  private async getSpacePermissions(
    context: McpToolContext,
    spaceId: string,
  ): Promise<unknown> {
    const permission = await this.permissionService.getEffectiveSpacePermission(
      context.client,
      spaceId,
    );

    return permission ?? {};
  }

  private async maybeAuditRead(
    context: McpToolContext,
    page: PageResult,
  ): Promise<void> {
    const sampleRate = this.environmentService.getMcpReadAuditSampleRate();
    if (sampleRate <= 0 || Math.random() > sampleRate) {
      return;
    }

    await this.auditService.tryLog({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.page.read',
      resourceType: 'page',
      resourceId: page.id,
      spaceId: page.spaceId,
      toolName: 'get_page',
      requestId: context.requestId,
      metadata: {
        title: page.title,
      },
      ipAddress: context.ipAddress,
    });
  }

  private formatPageContent(page: PageResult, format: string): unknown {
    if (format === 'json') {
      return page.content ?? null;
    }

    if (!page.content) {
      return '';
    }

    if (format === 'html') {
      return jsonToHtml(page.content);
    }

    return jsonToMarkdown(page.content);
  }

  private toPageMetadata(page: PageResult): PageMetadata {
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

  private async getWritablePage(
    context: McpToolContext,
    pageId: string,
    action: 'update' | 'append' | 'delete',
    opts?: { includeDeleted?: boolean },
  ): Promise<Page> {
    const target = await this.permissionService.assertPagePermission(
      context.client,
      action,
      pageId,
      {
        includeDeleted: opts?.includeDeleted,
        maskPermissionDeniedAsNotFound: true,
      },
    );
    const page = await this.pageRepo.findById(target.id, {
      includeContent: true,
      includeTextContent: true,
    });

    if (
      !page ||
      page.workspaceId !== context.client.workspaceId ||
      (page.deletedAt && !opts?.includeDeleted)
    ) {
      throw new NotFoundException('Page not found');
    }

    return page;
  }

  private async assertParentPage(
    spaceId: string,
    parentPageId: string,
  ): Promise<Page> {
    const parentPage = await this.pageRepo.findById(parentPageId);
    if (!parentPage || parentPage.deletedAt || parentPage.spaceId !== spaceId) {
      throw new NotFoundException('Parent page not found');
    }

    return parentPage;
  }

  private async assertActiveSpace(
    workspaceId: string,
    spaceId: string,
  ): Promise<void> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id'])
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!space) {
      throw new NotFoundException('Space not found');
    }
  }

  private parseExpectedUpdatedAt(
    expectedUpdatedAt?: string | null,
  ): Date | undefined {
    if (!expectedUpdatedAt) {
      return undefined;
    }

    const expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) {
      throw new BadRequestException('expectedUpdatedAt must be a valid date');
    }

    return expected;
  }

  private optionalContent(args: JsonObject): string | object | undefined {
    const value = args.content;
    if (typeof value === 'undefined') {
      return undefined;
    }

    if (typeof value === 'string') {
      this.assertWriteContentLimit(value);
      return value;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      this.assertWriteContentLimit(value);
      return value;
    }

    throw new BadRequestException('content must be a string or object');
  }

  private getContentFormat(
    args: JsonObject,
    fallback: ContentFormat,
  ): ContentFormat {
    const format = this.optionalString(args, 'format') ?? fallback;
    if (!['markdown', 'html', 'json'].includes(format)) {
      throw new BadRequestException('format must be markdown, html, or json');
    }

    return format as ContentFormat;
  }

  private assertWriteContentLimit(content: string | object): void {
    const serialized =
      typeof content === 'string' ? content : JSON.stringify(content);
    if (
      serialized.length > this.environmentService.getMcpMaxWriteContentLength()
    ) {
      throw new BadRequestException('content is too long');
    }
  }

  private getContentHash(content: string | object | undefined): string | null {
    if (typeof content === 'undefined') {
      return null;
    }

    const serialized =
      typeof content === 'string' ? content : JSON.stringify(content);
    return createHash('sha256').update(serialized).digest('hex');
  }

  private async runPageUpdateWithGuidance(
    update: () => Promise<Page>,
  ): Promise<Page> {
    try {
      return await update();
    } catch (err) {
      if (
        err instanceof ConflictException &&
        err.message === 'Page changed since expectedUpdatedAt'
      ) {
        throw new ConflictException(
          'Page changed since expectedUpdatedAt. Call get_page, reconcile with the latest content, then retry with its updatedAt and a new idempotencyKey.',
        );
      }
      throw err;
    }
  }

  private async tryIndexPage(
    context: McpToolContext,
    pageId: string,
    jobType: 'page' | 'delete' | 'restore' = 'page',
  ): Promise<{ index: unknown | null; warnings: string[] }> {
    if (!this.environmentService.isVectorSearchEnabled()) {
      return { index: null, warnings: [] };
    }

    try {
      return {
        index: await this.vectorIndexService.enqueuePage(
          {
            workspaceId: context.client.workspaceId,
            pageId,
            requestedByClientId: context.client.id,
            requestedByUserId: context.client.actorUserId,
          },
          {
            autoRun: true,
            jobType,
            stats: { trigger: 'mcp_write' },
          },
        ),
        warnings: [],
      };
    } catch (err) {
      return {
        index: null,
        warnings: [getMcpSafeErrorMessage(err, 'Vector index was not updated')],
      };
    }
  }

  private buildWriteResponse(
    page: Page,
    indexAttempt: { index: unknown | null; warnings: string[] },
    additionalWarnings: string[] = [],
  ): PageWriteResponse {
    return {
      page: this.toPageMetadata(page),
      index: indexAttempt.index,
      warnings: [...indexAttempt.warnings, ...additionalWarnings],
    };
  }

  private async reconcilePageWrite(
    context: McpToolContext,
    record: McpIdempotencyReconciliationRecord,
    jobType: 'page' | 'delete' | 'restore',
  ): Promise<McpIdempotencyReconciliation<unknown>> {
    if (!record.resourceId) {
      return { outcome: 'unresolved' };
    }

    const page = await this.findRecoveryPage(
      record.resourceId,
      context.client.workspaceId,
    );
    if (!page) {
      return { outcome: 'repair_required' };
    }

    const beforeState = this.parsePageRecoveryState(record.beforeState);
    const targetState = this.parsePageRecoveryState(record.targetState);
    if (!beforeState || !targetState) {
      return { outcome: 'repair_required' };
    }

    const currentState = this.getPageRecoveryState(page);
    if (this.pageRecoveryStatesEqual(currentState, targetState)) {
      return {
        outcome: 'completed',
        response: await this.buildRecoveredPageResponse(
          context,
          page,
          record,
          jobType,
        ),
      };
    }

    if (this.pageRecoveryStatesEqual(currentState, beforeState)) {
      return { outcome: 'retry' };
    }

    return { outcome: 'repair_required' };
  }

  private async findRecoveryPage(
    pageId: string,
    workspaceId: string,
  ): Promise<Page | null> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeTextContent: true,
    });
    return page?.workspaceId === workspaceId ? page : null;
  }

  private async buildRecoveredPageResponse(
    context: McpToolContext,
    page: Page,
    record: McpIdempotencyReconciliationRecord,
    jobType: 'page' | 'delete' | 'restore' = 'page',
  ): Promise<unknown> {
    const indexAttempt = await this.tryIndexPage(context, page.id, jobType);
    const auditWarnings = await this.auditMutation({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: context.client.actorUserId,
      event: 'mcp.idempotency.reconciled',
      resourceType: 'page',
      resourceId: page.id,
      spaceId: page.spaceId,
      toolName: record.action,
      requestId: context.requestId,
      metadata: {
        operationStage: record.operationStage,
        outcome: 'completed',
      },
      ipAddress: context.ipAddress,
    });
    const warnings = [
      'Recovered an interrupted idempotent operation from persisted state',
      ...indexAttempt.warnings,
      ...auditWarnings,
    ];

    if (jobType === 'delete') {
      return {
        page: this.toPageMetadata(page),
        index: indexAttempt.index,
        deleted: true,
        warnings,
      };
    }

    return this.buildWriteResponse(page, indexAttempt, [
      'Recovered an interrupted idempotent operation from persisted state',
      ...auditWarnings,
    ]);
  }

  private getPageRecoveryState(page: Page): PageRecoveryState {
    const content =
      page.content &&
      typeof page.content === 'object' &&
      !Array.isArray(page.content)
        ? page.content
        : undefined;
    return {
      title: page.title,
      icon: page.icon,
      contentHash: this.getContentHash(content),
      deleted: Boolean(page.deletedAt),
    };
  }

  private parsePageRecoveryState(value: unknown): PageRecoveryState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const state = value as Record<string, unknown>;
    if (
      !('title' in state) ||
      !('icon' in state) ||
      !('contentHash' in state) ||
      typeof state.deleted !== 'boolean'
    ) {
      return null;
    }

    if (
      (state.title !== null && typeof state.title !== 'string') ||
      (state.icon !== null && typeof state.icon !== 'string') ||
      (state.contentHash !== null && typeof state.contentHash !== 'string')
    ) {
      return null;
    }

    return state as PageRecoveryState;
  }

  private pageRecoveryStatesEqual(
    left: PageRecoveryState,
    right: PageRecoveryState,
  ): boolean {
    return (
      left.title === right.title &&
      left.icon === right.icon &&
      left.contentHash === right.contentHash &&
      left.deleted === right.deleted
    );
  }

  private appendPreparedContent(
    currentContent: Json | null,
    preparedContent: object,
  ): object {
    const current =
      currentContent &&
      typeof currentContent === 'object' &&
      !Array.isArray(currentContent)
        ? (currentContent as Record<string, unknown>)
        : { type: 'doc', content: [] };
    const prepared = preparedContent as Record<string, unknown>;

    return {
      ...current,
      type: typeof current.type === 'string' ? current.type : 'doc',
      content: [
        ...(Array.isArray(current.content) ? current.content : []),
        ...(Array.isArray(prepared.content) ? prepared.content : []),
      ],
    };
  }

  private async auditMutation(input: McpAuditLogInput): Promise<string[]> {
    return (await this.auditService.tryLog(input))
      ? []
      : [AUDIT_PERSISTENCE_WARNING];
  }

  private appendWarnings(result: unknown, warnings: string[]): unknown {
    if (warnings.length === 0) {
      return result;
    }

    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const currentWarnings = (result as { warnings?: unknown }).warnings;
      return {
        ...result,
        warnings: [
          ...(Array.isArray(currentWarnings) ? currentWarnings : []),
          ...warnings,
        ],
      };
    }

    return { result, warnings };
  }

  private getResponsePageId(response: unknown): string | null {
    if (!response || typeof response !== 'object') {
      return null;
    }

    const page = (response as { page?: unknown }).page;
    if (!page || typeof page !== 'object') {
      return null;
    }

    const id = (page as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }

  private requireQuery(args: JsonObject): string {
    const query = this.requireString(args, 'query').trim();
    if (!query) {
      throw new BadRequestException('query is required');
    }

    if (query.length > this.environmentService.getMcpMaxQueryLength()) {
      throw new BadRequestException('query is too long');
    }

    return query;
  }

  private requireString(args: JsonObject, field: string): string {
    const value = args[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requireConfirmation(args: JsonObject, toolName: string): void {
    if (args.confirm !== true) {
      throw new BadRequestException(`${toolName} requires confirm=true`);
    }
  }

  private optionalString(
    args: JsonObject,
    field: string,
  ): string | null | undefined {
    const value = args[field];
    if (typeof value === 'undefined') {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim();
  }

  private optionalStringArray(
    args: JsonObject,
    field: string,
  ): string[] | undefined {
    const value = args[field];
    if (typeof value === 'undefined' || value === null) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array`);
    }

    return value.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new BadRequestException(`${field} must contain strings`);
      }
      return item.trim();
    });
  }

  private getLimit(args: JsonObject, max: number, fallback: number): number {
    return this.getNamedLimit(args, 'limit', max, fallback);
  }

  private getNamedLimit(
    args: JsonObject,
    field: string,
    max: number,
    fallback: number,
  ): number {
    const value = args[field];
    if (typeof value === 'undefined' || value === null) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${field} must be a number`);
    }

    return Math.max(1, Math.min(Math.floor(value), max));
  }

  private optionalBoolean(
    args: JsonObject,
    field: string,
    fallback: boolean,
  ): boolean {
    const value = args[field];
    if (typeof value === 'undefined' || value === null) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }
    return value;
  }

  private getOffset(args: JsonObject): number {
    const value = args.offset;
    if (typeof value === 'undefined' || value === null) {
      return 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException('offset must be a non-negative number');
    }

    return Math.floor(value);
  }

  private asObject(value: unknown): JsonObject {
    if (!value) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('MCP tool arguments must be an object');
    }

    return value as JsonObject;
  }

  private normalizeSnippet(snippet: string | null): string | null {
    if (!snippet) {
      return null;
    }

    return snippet.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ');
  }

  private toSearchContentSource(
    value: Json | null,
  ): SearchItem['contentSource'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { type: 'page' };
    }
    const metadata = value as Record<string, unknown>;
    if (
      metadata.sourceType === 'attachment' &&
      typeof metadata.attachmentId === 'string' &&
      typeof metadata.attachmentFileName === 'string'
    ) {
      return {
        type: 'attachment',
        attachmentId: metadata.attachmentId,
        fileName: metadata.attachmentFileName,
      };
    }
    return { type: 'page' };
  }
}
