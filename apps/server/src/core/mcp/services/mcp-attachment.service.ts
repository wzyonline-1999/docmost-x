import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { v7 as uuid7 } from 'uuid';
import type { Attachment, Page, User } from '@docmost/db/types/entity.types';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AttachmentType } from '../../attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../attachment/attachment.utils';
import { AttachmentService } from '../../attachment/services/attachment.service';
import { StorageService } from '../../../integrations/storage/storage.service';
import { sanitizeFileName } from '../../../common/helpers';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpActorAccessService } from './mcp-actor-access.service';
import { McpAuditService } from './mcp-audit.service';
import {
  McpIdempotencyReconciliationRecord,
  McpIdempotencyService,
} from './mcp-idempotency.service';
import { McpPermissionService } from './mcp-permission.service';

const MAX_MCP_ATTACHMENT_BYTES = 512 * 1024;
const MAX_EXTRACTED_TEXT_LENGTH = 100_000;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
const AUDIT_PERSISTENCE_WARNING =
  'MCP operation succeeded, but its audit log could not be persisted';

@Injectable()
export class McpAttachmentService {
  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
    private readonly pageRepo: PageRepo,
    private readonly permissionService: McpPermissionService,
    private readonly actorAccessService: McpActorAccessService,
    private readonly auditService: McpAuditService,
    private readonly idempotencyService: McpIdempotencyService,
  ) {}

  async listAttachments(
    input: { pageId: string; limit: number; offset: number },
    context: McpToolContext,
  ) {
    await this.requirePage(input.pageId, context, 'read');
    const attachments = await this.attachmentRepo.findPageFiles(
      input.pageId,
      context.client.workspaceId,
      { limit: input.limit, offset: input.offset },
    );

    return {
      items: attachments.map((attachment) => this.toMetadata(attachment)),
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getAttachment(
    input: {
      attachmentId: string;
      expiresInSeconds: number;
      includeExtractedText: boolean;
    },
    context: McpToolContext,
  ) {
    const { attachment, page, actor } = await this.requireAttachment(
      input.attachmentId,
      context,
      'read',
      true,
    );
    const signed = await this.createSignedDownload(
      attachment,
      input.expiresInSeconds,
    );
    const auditPersisted = await this.auditService.tryLog({
      workspaceId: context.client.workspaceId,
      clientId: context.client.id,
      actorUserId: actor.id,
      event: 'mcp.attachment.read',
      resourceType: 'attachment',
      resourceId: attachment.id,
      spaceId: page.spaceId,
      toolName: 'get_attachment',
      requestId: context.requestId,
      metadata: {
        pageId: page.id,
        includeExtractedText: input.includeExtractedText,
      },
      ipAddress: context.ipAddress,
    });
    const extractedText = input.includeExtractedText
      ? this.truncateExtractedText(attachment.textContent)
      : undefined;

    return {
      attachment: this.toMetadata(attachment),
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt,
      extractedText,
      warnings: [
        ...signed.warnings,
        ...(auditPersisted ? [] : [AUDIT_PERSISTENCE_WARNING]),
      ],
    };
  }

  async uploadAttachment(
    input: {
      pageId: string;
      fileName: string;
      contentBase64: string;
      idempotencyKey?: string;
    },
    context: McpToolContext,
  ) {
    const { page, actor } = await this.requirePage(
      input.pageId,
      context,
      'update',
    );
    const buffer = this.decodeBase64(input.contentBase64);
    const attachmentId = uuid7();
    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const targetState = {
      pageId: page.id,
      fileName: input.fileName,
      fileSize: buffer.length,
      contentHash,
    };

    return this.idempotencyService.run({
      client: context.client,
      action: 'upload_attachment',
      idempotencyKey: input.idempotencyKey,
      request: input,
      resourceType: 'attachment',
      resourceId: attachmentId,
      operationStage: 'validated',
      targetState,
      reconcile: (record) => this.reconcileUpload(record, context),
      run: async (execution) => {
        const attachment = await this.attachmentService.uploadBufferFile({
          buffer,
          fileName: input.fileName,
          pageId: page.id,
          userId: actor.id,
          spaceId: page.spaceId,
          workspaceId: context.client.workspaceId,
          attachmentId,
        });
        await execution.checkpoint({
          stage: 'attachment_uploaded',
          resourceId: attachment.id,
          targetState,
        });
        const signed = await this.createSignedDownload(
          attachment,
          DEFAULT_SIGNED_URL_TTL_SECONDS,
        );
        const auditPersisted = await this.auditService.tryLog({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.attachment.upload',
          resourceType: 'attachment',
          resourceId: attachment.id,
          spaceId: page.spaceId,
          toolName: 'upload_attachment',
          requestId: context.requestId,
          after: this.toMetadata(attachment),
          metadata: {
            pageId: page.id,
            contentHash,
          },
          ipAddress: context.ipAddress,
        });

        return {
          attachment: this.toMetadata(attachment),
          downloadUrl: signed.url,
          expiresAt: signed.expiresAt,
          warnings: [
            ...signed.warnings,
            ...(auditPersisted ? [] : [AUDIT_PERSISTENCE_WARNING]),
          ],
        };
      },
    });
  }

  async deleteAttachment(
    input: {
      attachmentId: string;
      idempotencyKey?: string;
      confirm: boolean;
    },
    context: McpToolContext,
  ) {
    if (!input.confirm) {
      throw new BadRequestException(
        'confirm must be true to delete an attachment',
      );
    }
    const existingAttachment = await this.attachmentRepo.findById(
      input.attachmentId,
    );
    if (!existingAttachment && input.idempotencyKey) {
      return this.replayDeletedAttachment(
        { ...input, idempotencyKey: input.idempotencyKey },
        context,
      );
    }
    const { attachment, page, actor } = await this.requireAttachment(
      input.attachmentId,
      context,
      'update',
    );
    const before = this.toMetadata(attachment);

    return this.idempotencyService.run({
      client: context.client,
      action: 'delete_attachment',
      idempotencyKey: input.idempotencyKey,
      request: input,
      resourceType: 'attachment',
      resourceId: attachment.id,
      operationStage: 'validated',
      beforeState: before,
      targetState: { deleted: true },
      reconcile: (record) => this.reconcileDelete(record, context),
      run: async (execution) => {
        await this.attachmentService.deleteFileAttachment(attachment);
        await execution.checkpoint({
          stage: 'attachment_deleted',
          resourceId: attachment.id,
          targetState: { deleted: true },
        });
        const auditPersisted = await this.auditService.tryLog({
          workspaceId: context.client.workspaceId,
          clientId: context.client.id,
          actorUserId: actor.id,
          event: 'mcp.attachment.delete',
          resourceType: 'attachment',
          resourceId: attachment.id,
          spaceId: page.spaceId,
          toolName: 'delete_attachment',
          requestId: context.requestId,
          before,
          metadata: { pageId: page.id },
          ipAddress: context.ipAddress,
        });
        return {
          attachmentId: attachment.id,
          deleted: true,
          warnings: auditPersisted ? [] : [AUDIT_PERSISTENCE_WARNING],
        };
      },
    });
  }

  private async replayDeletedAttachment(
    input: {
      attachmentId: string;
      idempotencyKey: string;
      confirm: boolean;
    },
    context: McpToolContext,
  ) {
    return this.idempotencyService.run({
      client: context.client,
      action: 'delete_attachment',
      idempotencyKey: input.idempotencyKey,
      request: input,
      resourceType: 'attachment',
      resourceId: input.attachmentId,
      operationStage: 'validated',
      targetState: { deleted: true },
      reconcile: (record) => this.reconcileDelete(record, context),
      run: async () => {
        throw new NotFoundException('Attachment not found');
      },
    });
  }

  private async requirePage(
    pageId: string,
    context: McpToolContext,
    action: 'read' | 'update',
  ): Promise<{ page: Page; actor: User }> {
    const page = await this.pageRepo.findById(pageId);
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
    return { page, actor };
  }

  private async requireAttachment(
    attachmentId: string,
    context: McpToolContext,
    action: 'read' | 'update',
    includeTextContent = false,
  ): Promise<{ attachment: Attachment; page: Page; actor: User }> {
    const attachment = includeTextContent
      ? await this.attachmentRepo.findByIdWithContent(attachmentId)
      : await this.attachmentRepo.findById(attachmentId);
    if (
      !attachment ||
      attachment.deletedAt ||
      attachment.type !== AttachmentType.File ||
      attachment.workspaceId !== context.client.workspaceId ||
      !attachment.pageId ||
      !attachment.spaceId
    ) {
      throw new NotFoundException('Attachment not found');
    }
    const { page, actor } = await this.requirePage(
      attachment.pageId,
      context,
      action,
    );
    if (page.spaceId !== attachment.spaceId) {
      throw new NotFoundException('Attachment not found');
    }
    return { attachment, page, actor };
  }

  private async createSignedDownload(
    attachment: Attachment,
    expiresInSeconds: number,
  ): Promise<{
    url: string | null;
    expiresAt: string | null;
    warnings: string[];
  }> {
    const ttl = Math.max(
      60,
      Math.min(Math.floor(expiresInSeconds), MAX_SIGNED_URL_TTL_SECONDS),
    );
    try {
      return {
        url: await this.storageService.getSignedUrl(attachment.filePath, ttl),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        warnings: [],
      };
    } catch {
      return {
        url: null,
        expiresAt: null,
        warnings: [
          'Signed download URLs are unavailable for this storage driver',
        ],
      };
    }
  }

  private decodeBase64(value: string): Buffer {
    const normalized = value.replace(/\s/g, '');
    if (
      !normalized ||
      normalized.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
      throw new BadRequestException('contentBase64 must be valid base64');
    }
    const buffer = Buffer.from(normalized, 'base64');
    if (
      buffer.toString('base64').replace(/=+$/, '') !==
      normalized.replace(/=+$/, '')
    ) {
      throw new BadRequestException('contentBase64 must be valid base64');
    }
    if (!buffer.length) {
      throw new BadRequestException('Attachment content is empty');
    }
    if (buffer.length > MAX_MCP_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        `Attachment exceeds the ${MAX_MCP_ATTACHMENT_BYTES} byte MCP limit`,
      );
    }
    return buffer;
  }

  private truncateExtractedText(value: string | null | undefined) {
    if (!value) {
      return { text: null, truncated: false };
    }
    const truncated = value.length > MAX_EXTRACTED_TEXT_LENGTH;
    return {
      text: truncated ? value.slice(0, MAX_EXTRACTED_TEXT_LENGTH) : value,
      truncated,
    };
  }

  private async reconcileUpload(
    record: McpIdempotencyReconciliationRecord,
    context: McpToolContext,
  ) {
    if (!record.resourceId) {
      return { outcome: 'retry' as const };
    }
    const attachment = await this.attachmentRepo.findById(record.resourceId);
    const target = this.asUploadTargetState(record.targetState);
    if (!target) {
      return { outcome: 'repair_required' as const };
    }
    if (!attachment) {
      const fileName = sanitizeFileName(target.fileName).slice(0, 255);
      const filePath = `${getAttachmentFolderPath(AttachmentType.File, context.client.workspaceId)}/${record.resourceId}/${fileName}`;
      await this.storageService.delete(filePath).catch(() => undefined);
      return { outcome: 'retry' as const };
    }
    if (
      attachment.workspaceId !== context.client.workspaceId ||
      attachment.deletedAt ||
      attachment.type !== AttachmentType.File ||
      attachment.pageId !== target.pageId ||
      attachment.fileName !== sanitizeFileName(target.fileName).slice(0, 255) ||
      Number(attachment.fileSize) !== target.fileSize
    ) {
      return { outcome: 'repair_required' as const };
    }
    let storedContent: Buffer;
    try {
      storedContent = await this.storageService.read(attachment.filePath);
    } catch {
      return { outcome: 'repair_required' as const };
    }
    if (
      createHash('sha256').update(storedContent).digest('hex') !==
      target.contentHash
    ) {
      return { outcome: 'repair_required' as const };
    }
    const signed = await this.createSignedDownload(
      attachment,
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    return {
      outcome: 'completed' as const,
      response: {
        attachment: this.toMetadata(attachment),
        downloadUrl: signed.url,
        expiresAt: signed.expiresAt,
        warnings: signed.warnings,
      },
    };
  }

  private async reconcileDelete(
    record: McpIdempotencyReconciliationRecord,
    context: McpToolContext,
  ) {
    if (!record.resourceId) {
      return { outcome: 'repair_required' as const };
    }
    const attachment = await this.attachmentRepo.findById(record.resourceId);
    if (!attachment) {
      return {
        outcome: 'completed' as const,
        response: {
          attachmentId: record.resourceId,
          deleted: true,
          warnings: [],
        },
      };
    }
    if (attachment.workspaceId !== context.client.workspaceId) {
      return { outcome: 'repair_required' as const };
    }
    return { outcome: 'retry' as const };
  }

  private asUploadTargetState(value: unknown):
    | {
        pageId: string;
        fileName: string;
        fileSize: number;
        contentHash: string;
      }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const target = value as Record<string, unknown>;
    if (
      typeof target.pageId !== 'string' ||
      typeof target.fileName !== 'string' ||
      typeof target.fileSize !== 'number' ||
      typeof target.contentHash !== 'string'
    ) {
      return undefined;
    }
    return {
      pageId: target.pageId,
      fileName: target.fileName,
      fileSize: target.fileSize,
      contentHash: target.contentHash,
    };
  }

  private toMetadata(attachment: Attachment) {
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      fileSize: Number(attachment.fileSize),
      fileExt: attachment.fileExt,
      mimeType: attachment.mimeType,
      creatorId: attachment.creatorId,
      pageId: attachment.pageId,
      spaceId: attachment.spaceId,
      createdAt: attachment.createdAt.toISOString(),
      updatedAt: attachment.updatedAt.toISOString(),
    };
  }
}
