import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { createTwoFilesPatch } from 'diff';
import type { Json } from '@docmost/db/types/db';
import type { Page, PageHistory } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../../collaboration/collaboration.util';
import { PageHistoryService } from '../../page/services/page-history.service';
import { PageService } from '../../page/services/page.service';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpActorAccessService } from './mcp-actor-access.service';
import { McpAuditService } from './mcp-audit.service';
import {
  McpIdempotencyReconciliationRecord,
  McpIdempotencyService,
} from './mcp-idempotency.service';
import { McpPermissionService } from './mcp-permission.service';

type HistoryFormat = 'markdown' | 'html' | 'json';

type VersionTarget = {
  id: string;
  title: string | null;
  content: Json | null;
  createdAt: Date;
  kind: 'history' | 'current';
};

const MAX_DIFF_LENGTH = 200_000;
const AUDIT_PERSISTENCE_WARNING =
  'MCP operation succeeded, but its audit log could not be persisted';
const HISTORY_PERSISTENCE_WARNING =
  'MCP operation succeeded, but its page history snapshot could not be persisted';

@Injectable()
export class McpPageHistoryService {
  constructor(
    private readonly pageHistoryService: PageHistoryService,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly permissionService: McpPermissionService,
    private readonly actorAccessService: McpActorAccessService,
    private readonly auditService: McpAuditService,
    private readonly idempotencyService: McpIdempotencyService,
  ) {}

  async capturePageSnapshot(
    page: Page,
    actorUserId: string,
  ): Promise<string[]> {
    try {
      await this.pageHistoryService.saveSnapshotIfChanged(page, [actorUserId]);
      return [];
    } catch {
      return [HISTORY_PERSISTENCE_WARNING];
    }
  }

  async listPageVersions(
    input: { pageId: string; limit: number; cursor?: string },
    context: McpToolContext,
  ) {
    const page = await this.requireReadablePage(input.pageId, context);
    const pagination = new PaginationOptions();
    pagination.limit = input.limit;
    pagination.cursor = input.cursor;
    const result = await this.pageHistoryService.findHistoryByPageId(
      page.id,
      pagination,
    );

    return {
      items: result.items.map((history) => this.toVersionMetadata(history)),
      meta: result.meta,
    };
  }

  async getPageVersion(
    input: { historyId: string; format: HistoryFormat },
    context: McpToolContext,
  ) {
    const history = await this.requireReadableHistory(input.historyId, context);

    return {
      version: this.toVersionMetadata(history),
      content: this.formatContent(history.content, input.format),
      format: input.format,
    };
  }

  async diffPageVersions(
    input: {
      pageId: string;
      fromHistoryId: string;
      toHistoryId?: string;
    },
    context: McpToolContext,
  ) {
    const page = await this.requireReadablePage(input.pageId, context);
    const from = await this.requireHistoryForPage(
      input.fromHistoryId,
      page,
      context.client.workspaceId,
    );
    const to = input.toHistoryId
      ? await this.requireHistoryForPage(
          input.toHistoryId,
          page,
          context.client.workspaceId,
        )
      : this.toCurrentVersion(page);

    const patch = createTwoFilesPatch(
      this.versionLabel(from),
      this.versionLabel(to),
      this.versionMarkdown(from),
      this.versionMarkdown(to),
      undefined,
      undefined,
      { context: 3 },
    );
    const truncated = patch.length > MAX_DIFF_LENGTH;

    return {
      from: this.toTargetMetadata(from),
      to: this.toTargetMetadata(to),
      diff: truncated
        ? `${patch.slice(0, MAX_DIFF_LENGTH)}\n... diff truncated ...\n`
        : patch,
      truncated,
    };
  }

  async restorePageVersion(
    input: {
      pageId: string;
      historyId: string;
      expectedUpdatedAt: string;
      idempotencyKey?: string;
      confirm: boolean;
    },
    context: McpToolContext,
  ) {
    if (!input.confirm) {
      throw new BadRequestException(
        'confirm must be true to restore a version',
      );
    }

    const page = await this.requireWritablePage(input.pageId, context);
    const actor = await this.actorAccessService.requireActor(context.client);
    const history = await this.requireHistoryForPage(
      input.historyId,
      page,
      context.client.workspaceId,
    );
    if (
      !history.content ||
      typeof history.content !== 'object' ||
      Array.isArray(history.content)
    ) {
      throw new BadRequestException('Page history content is unavailable');
    }

    const expectedUpdatedAt = this.parseExpectedUpdatedAt(
      input.expectedUpdatedAt,
    );
    const targetState = {
      title: history.title ?? '',
      contentHash: this.contentHash(history.content),
      historyId: history.id,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'restore_page_version',
      idempotencyKey: input.idempotencyKey,
      request: input,
      resourceType: 'page',
      resourceId: page.id,
      operationStage: 'validated',
      beforeState: {
        title: page.title,
        contentHash: this.contentHash(page.content),
        updatedAt: page.updatedAt.toISOString(),
      },
      targetState,
      reconcile: (record) =>
        this.reconcileRestore(record, context.client.workspaceId),
      run: async (execution) => {
        const historyWarnings = await this.capturePageSnapshot(page, actor.id);
        const restored = await this.pageService.update(
          page,
          {
            pageId: page.id,
            title: targetState.title,
            content: history.content as object,
            operation: 'replace',
            format: 'json',
          },
          actor,
          {
            expectedUpdatedAt,
            preparedContent: history.content as object,
          },
        );
        await execution.checkpoint({
          stage: 'page_version_restored',
          resourceId: page.id,
          targetState,
        });

        const auditPersisted = await this.auditService.tryLog({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.page.version.restore',
          resourceType: 'page',
          resourceId: page.id,
          spaceId: page.spaceId,
          toolName: 'restore_page_version',
          requestId: context.requestId,
          before: {
            title: page.title,
            updatedAt: page.updatedAt.toISOString(),
          },
          after: {
            title: restored.title,
            updatedAt: restored.updatedAt.toISOString(),
          },
          metadata: {
            historyId: history.id,
            restoredContentHash: targetState.contentHash,
          },
          ipAddress: context.ipAddress,
        });

        return this.restoreResponse(restored, history.id, [
          ...historyWarnings,
          ...(auditPersisted ? [] : [AUDIT_PERSISTENCE_WARNING]),
        ]);
      },
    });
  }

  private async requireReadableHistory(
    historyId: string,
    context: McpToolContext,
  ): Promise<PageHistory> {
    const history = await this.pageHistoryService.findById(historyId);
    if (!history || history.workspaceId !== context.client.workspaceId) {
      throw new NotFoundException('Page history not found');
    }
    const page = await this.requireReadablePage(history.pageId, context);
    return this.requireHistoryForPage(
      history.id,
      page,
      context.client.workspaceId,
      history,
    );
  }

  private async requireReadablePage(
    pageId: string,
    context: McpToolContext,
  ): Promise<Page> {
    return this.requirePage(pageId, context, 'read');
  }

  private async requireWritablePage(
    pageId: string,
    context: McpToolContext,
  ): Promise<Page> {
    return this.requirePage(pageId, context, 'update');
  }

  private async requirePage(
    pageId: string,
    context: McpToolContext,
    action: 'read' | 'update',
  ): Promise<Page> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
    });
    if (!page || page.workspaceId !== context.client.workspaceId) {
      throw new NotFoundException('Page not found');
    }
    await this.permissionService.assertSpacePermission(
      context.client,
      action,
      page.spaceId,
    );
    const actor = await this.actorAccessService.requireActor(context.client);
    if (action === 'read') {
      await this.actorAccessService.assertCanViewPage(actor, page);
    } else {
      await this.actorAccessService.assertCanEditPage(actor, page);
    }
    return page;
  }

  private async requireHistoryForPage(
    historyId: string,
    page: Page,
    workspaceId: string,
    resolved?: PageHistory,
  ): Promise<PageHistory> {
    const history =
      resolved ?? (await this.pageHistoryService.findById(historyId));
    if (
      !history ||
      history.workspaceId !== workspaceId ||
      history.pageId !== page.id ||
      history.spaceId !== page.spaceId
    ) {
      throw new NotFoundException('Page history not found');
    }
    return history;
  }

  private async reconcileRestore(
    record: McpIdempotencyReconciliationRecord,
    workspaceId: string,
  ) {
    if (!record.resourceId) {
      return { outcome: 'retry' as const };
    }
    const page = await this.pageRepo.findById(record.resourceId, {
      includeContent: true,
    });
    if (!page || page.workspaceId !== workspaceId) {
      return { outcome: 'repair_required' as const };
    }
    const target = this.asTargetState(record.targetState);
    if (
      page.title !== target?.title ||
      this.contentHash(page.content) !== target?.contentHash
    ) {
      return { outcome: 'repair_required' as const };
    }
    return {
      outcome: 'completed' as const,
      response: this.restoreResponse(page, target.historyId, []),
    };
  }

  private asTargetState(
    value: unknown,
  ):
    | { title: string; contentHash: string | null; historyId: string }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const target = value as Record<string, unknown>;
    if (
      typeof target.title !== 'string' ||
      typeof target.historyId !== 'string' ||
      (typeof target.contentHash !== 'string' && target.contentHash !== null)
    ) {
      return undefined;
    }
    return {
      title: target.title,
      contentHash: target.contentHash as string | null,
      historyId: target.historyId,
    };
  }

  private parseExpectedUpdatedAt(value: string): Date {
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('expectedUpdatedAt must be an ISO date');
    }
    return parsed;
  }

  private toCurrentVersion(page: Page): VersionTarget {
    return {
      id: page.id,
      title: page.title,
      content: page.content,
      createdAt: page.updatedAt,
      kind: 'current',
    };
  }

  private toVersionTarget(history: PageHistory): VersionTarget {
    return {
      id: history.id,
      title: history.title,
      content: history.content,
      createdAt: history.createdAt,
      kind: 'history',
    };
  }

  private versionLabel(version: PageHistory | VersionTarget): string {
    const target =
      'pageId' in version ? this.toVersionTarget(version) : version;
    return `${target.kind}:${target.id}`;
  }

  private versionMarkdown(version: PageHistory | VersionTarget): string {
    const target =
      'pageId' in version ? this.toVersionTarget(version) : version;
    const title = target.title ? `# ${target.title}\n\n` : '';
    return `${title}${this.formatContent(target.content, 'markdown')}`;
  }

  private toTargetMetadata(version: PageHistory | VersionTarget) {
    const target =
      'pageId' in version ? this.toVersionTarget(version) : version;
    return {
      id: target.id,
      kind: target.kind,
      title: target.title,
      createdAt: target.createdAt,
    };
  }

  private toVersionMetadata(history: PageHistory) {
    const related = history as PageHistory & {
      contributors?: Array<{
        id: string;
        name: string | null;
        avatarUrl: string | null;
      }>;
    };
    return {
      id: history.id,
      pageId: history.pageId,
      title: history.title,
      icon: history.icon,
      lastUpdatedById: history.lastUpdatedById,
      contributors: related.contributors ?? [],
      createdAt: history.createdAt,
    };
  }

  private formatContent(content: Json | null, format: HistoryFormat) {
    if (format === 'json') {
      return content;
    }
    if (!content || typeof content !== 'object') {
      return '';
    }
    return format === 'html'
      ? jsonToHtml(content as object)
      : jsonToMarkdown(content as object);
  }

  private contentHash(content: unknown): string | null {
    if (content === null || typeof content === 'undefined') {
      return null;
    }
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
  }

  private restoreResponse(page: Page, historyId: string, warnings: string[]) {
    return {
      page: {
        id: page.id,
        slugId: page.slugId,
        title: page.title,
        icon: page.icon,
        parentPageId: page.parentPageId,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        updatedAt: page.updatedAt,
      },
      restoredHistoryId: historyId,
      warnings,
    };
  }
}
