import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import type { Attachment } from '@docmost/db/types/entity.types';
import * as mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { EventName } from '../../../common/events/event.contants';
import { StorageService } from '../../../integrations/storage/storage.service';
import {
  AttachmentType,
  SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS,
} from '../attachment.constants';

export const MAX_ATTACHMENT_INDEX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_INDEX_CHARS = 500_000;
export type AttachmentContentIndexResult = {
  attachmentId: string;
  pageId: string | null;
  indexed: boolean;
  changed: boolean;
  charLength: number;
  truncated: boolean;
  skippedReason?: 'missing' | 'unsupported';
};

@Injectable()
export class AttachmentContentIndexService {
  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async indexAttachmentContent(
    attachmentId: string,
  ): Promise<AttachmentContentIndexResult> {
    const attachment =
      await this.attachmentRepo.findByIdWithContent(attachmentId);
    if (!attachment) {
      return this.skipped(attachmentId, null, 'missing');
    }
    if (!this.isActivePageFile(attachment)) {
      return this.skipped(attachmentId, attachment.pageId ?? null, 'missing');
    }
    const pageId = attachment.pageId as string;

    const fileExt = attachment.fileExt.toLowerCase();
    if (!SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS.has(fileExt)) {
      return this.skipped(attachment.id, pageId, 'unsupported');
    }
    if (Number(attachment.fileSize) > MAX_ATTACHMENT_INDEX_BYTES) {
      throw new BadRequestException(
        `Attachment exceeds the ${MAX_ATTACHMENT_INDEX_BYTES} byte text indexing limit`,
      );
    }

    const buffer = await this.storageService.read(attachment.filePath);
    if (buffer.length > MAX_ATTACHMENT_INDEX_BYTES) {
      throw new BadRequestException(
        `Attachment exceeds the ${MAX_ATTACHMENT_INDEX_BYTES} byte text indexing limit`,
      );
    }

    const extracted = this.normalizeText(
      await this.extractText(fileExt, buffer),
    );
    const truncated = extracted.length > MAX_ATTACHMENT_INDEX_CHARS;
    const textContent = extracted
      ? extracted.slice(0, MAX_ATTACHMENT_INDEX_CHARS)
      : null;
    const changed = (attachment.textContent ?? null) !== textContent;

    if (changed) {
      await this.attachmentRepo.updateAttachment(
        { textContent, updatedAt: new Date() },
        attachment.id,
      );
      this.eventEmitter.emit(EventName.ATTACHMENT_CONTENT_UPDATED, {
        attachmentId: attachment.id,
        pageIds: [pageId],
        workspaceId: attachment.workspaceId,
      });
    }

    return {
      attachmentId: attachment.id,
      pageId,
      indexed: true,
      changed,
      charLength: textContent?.length ?? 0,
      truncated,
    };
  }

  private async extractText(fileExt: string, buffer: Buffer): Promise<string> {
    if (fileExt === '.pdf') {
      const result = await extractPdfText(new Uint8Array(buffer), {
        mergePages: true,
      });
      return result.text;
    }
    if (fileExt === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    return buffer.toString('utf8');
  }

  private normalizeText(value: string): string {
    return value
      .replace(/\0/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isActivePageFile(attachment: Attachment): boolean {
    return Boolean(
      attachment &&
      !attachment.deletedAt &&
      attachment.type === AttachmentType.File &&
      attachment.pageId &&
      attachment.spaceId,
    );
  }

  private skipped(
    attachmentId: string,
    pageId: string | null,
    skippedReason: 'missing' | 'unsupported',
  ): AttachmentContentIndexResult {
    return {
      attachmentId,
      pageId,
      indexed: false,
      changed: false,
      charLength: 0,
      truncated: false,
      skippedReason,
    };
  }
}
