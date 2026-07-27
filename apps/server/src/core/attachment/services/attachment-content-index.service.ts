import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import type { Attachment } from '@docmost/db/types/entity.types';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'crypto';
import * as mammoth from 'mammoth';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import * as yauzl from 'yauzl';
import { EventName } from '../../../common/events/event.contants';
import { StorageService } from '../../../integrations/storage/storage.service';
import {
  AttachmentType,
  SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS,
} from '../attachment.constants';

export const MAX_ATTACHMENT_INDEX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_INDEX_CHARS = 500_000;
export const MAX_ATTACHMENT_PDF_PAGES = 500;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 5_000;
export const ATTACHMENT_INDEX_TIMEOUT_MS = 30_000;
const ATTACHMENT_INDEX_LEASE_MS = 2 * 60 * 1000;

export type AttachmentContentIndexResult = {
  attachmentId: string;
  pageId: string | null;
  indexed: boolean;
  changed: boolean;
  charLength: number;
  truncated: boolean;
  skippedReason?: 'missing' | 'unsupported' | 'busy';
};

@Injectable()
export class AttachmentContentIndexService {
  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
    private readonly eventEmitter: EventEmitter2,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async indexAttachmentContent(
    attachmentId: string,
  ): Promise<AttachmentContentIndexResult> {
    const leaseOwner = randomUUID();
    const attachment = await this.claimAttachment(attachmentId, leaseOwner);
    if (!attachment) {
      return this.resolveUnclaimedAttachment(attachmentId);
    }

    try {
      if (!this.isActivePageFile(attachment)) {
        await this.markSkipped(attachment.id, leaseOwner);
        return this.skipped(
          attachment.id,
          attachment.pageId ?? null,
          'missing',
        );
      }
      const pageId = attachment.pageId as string;
      const fileExt = attachment.fileExt.toLowerCase();
      if (!SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS.has(fileExt)) {
        await this.markSkipped(attachment.id, leaseOwner);
        return this.skipped(attachment.id, pageId, 'unsupported');
      }
      if (Number(attachment.fileSize) > MAX_ATTACHMENT_INDEX_BYTES) {
        throw new BadRequestException(
          `Attachment exceeds the ${MAX_ATTACHMENT_INDEX_BYTES} byte text indexing limit`,
        );
      }

      const extracted = await this.withTimeout(
        this.readAndExtractText(attachment, fileExt),
        ATTACHMENT_INDEX_TIMEOUT_MS,
      );
      const normalized = this.normalizeText(extracted);
      const truncated = normalized.length > MAX_ATTACHMENT_INDEX_CHARS;
      const textContent = normalized
        ? normalized.slice(0, MAX_ATTACHMENT_INDEX_CHARS)
        : null;
      const changed = (attachment.textContent ?? null) !== textContent;
      const indexedAt = new Date();
      const updated = await this.db
        .updateTable('attachments')
        .set({
          textContent,
          contentIndexStatus: 'indexed',
          contentIndexError: null,
          contentIndexedAt: indexedAt,
          contentIndexLeaseOwner: null,
          contentIndexLeaseExpiresAt: null,
          updatedAt: indexedAt,
        })
        .where('id', '=', attachment.id)
        .where('contentIndexStatus', '=', 'indexing')
        .where('contentIndexLeaseOwner', '=', leaseOwner)
        .returning(['id'])
        .executeTakeFirst();
      if (!updated) {
        throw new Error('Attachment content indexing lease was lost');
      }

      if (changed) {
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
    } catch (err) {
      await this.markFailed(attachment.id, leaseOwner, err);
      throw err;
    }
  }

  private async claimAttachment(
    attachmentId: string,
    leaseOwner: string,
  ): Promise<Attachment | undefined> {
    const now = new Date();
    return this.db
      .updateTable('attachments')
      .set({
        contentIndexStatus: 'indexing',
        contentIndexAttemptCount: (eb) =>
          eb('contentIndexAttemptCount', '+', 1),
        contentIndexError: null,
        contentIndexLeaseOwner: leaseOwner,
        contentIndexLeaseExpiresAt: new Date(
          now.getTime() + ATTACHMENT_INDEX_LEASE_MS,
        ),
        updatedAt: now,
      })
      .where('id', '=', attachmentId)
      .where('deletedAt', 'is', null)
      .where('deletionStatus', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('contentIndexStatus', 'in', ['pending', 'failed']),
          eb.and([
            eb('contentIndexStatus', '=', 'indexing'),
            eb('contentIndexLeaseExpiresAt', '<=', now),
          ]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
  }

  private async resolveUnclaimedAttachment(
    attachmentId: string,
  ): Promise<AttachmentContentIndexResult> {
    const attachment =
      await this.attachmentRepo.findByIdWithContent(attachmentId);
    if (!attachment || !this.isActivePageFile(attachment)) {
      return this.skipped(attachmentId, attachment?.pageId ?? null, 'missing');
    }
    if (attachment.contentIndexStatus === 'indexed') {
      return {
        attachmentId,
        pageId: attachment.pageId,
        indexed: true,
        changed: false,
        charLength: attachment.textContent?.length ?? 0,
        truncated:
          (attachment.textContent?.length ?? 0) >= MAX_ATTACHMENT_INDEX_CHARS,
      };
    }
    if (attachment.contentIndexStatus === 'skipped') {
      return this.skipped(attachmentId, attachment.pageId, 'unsupported');
    }
    return this.skipped(attachmentId, attachment.pageId, 'busy');
  }

  private async readAndExtractText(
    attachment: Attachment,
    fileExt: string,
  ): Promise<string> {
    const buffer = await this.storageService.read(attachment.filePath);
    if (buffer.length > MAX_ATTACHMENT_INDEX_BYTES) {
      throw new BadRequestException(
        `Attachment exceeds the ${MAX_ATTACHMENT_INDEX_BYTES} byte text indexing limit`,
      );
    }
    return this.extractText(fileExt, buffer);
  }

  private async extractText(fileExt: string, buffer: Buffer): Promise<string> {
    if (fileExt === '.pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      try {
        if (pdf.numPages > MAX_ATTACHMENT_PDF_PAGES) {
          throw new BadRequestException(
            `PDF exceeds the ${MAX_ATTACHMENT_PDF_PAGES} page text indexing limit`,
          );
        }
        const result = await extractPdfText(pdf, { mergePages: true });
        return result.text;
      } finally {
        await pdf.destroy();
      }
    }
    if (fileExt === '.docx') {
      await this.validateDocxArchive(buffer);
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    return buffer.toString('utf8');
  }

  private validateDocxArchive(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(
        buffer,
        { lazyEntries: true, autoClose: true },
        (openError, zipFile) => {
          if (openError || !zipFile) {
            reject(openError ?? new BadRequestException('Invalid DOCX file'));
            return;
          }

          let entryCount = 0;
          let uncompressedBytes = 0;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            zipFile.close();
            reject(error);
          };

          zipFile.on('entry', (entry: yauzl.Entry) => {
            entryCount += 1;
            uncompressedBytes += entry.uncompressedSize;
            if (entryCount > MAX_DOCX_ENTRIES) {
              fail(
                new BadRequestException(
                  `DOCX exceeds the ${MAX_DOCX_ENTRIES} entry indexing limit`,
                ),
              );
              return;
            }
            if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
              fail(
                new BadRequestException(
                  `DOCX exceeds the ${MAX_DOCX_UNCOMPRESSED_BYTES} byte expanded indexing limit`,
                ),
              );
              return;
            }
            zipFile.readEntry();
          });
          zipFile.once('end', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          zipFile.once('error', fail);
          zipFile.readEntry();
        },
      );
    });
  }

  private async markSkipped(
    attachmentId: string,
    leaseOwner: string,
  ): Promise<void> {
    await this.db
      .updateTable('attachments')
      .set({
        contentIndexStatus: 'skipped',
        contentIndexError: null,
        contentIndexLeaseOwner: null,
        contentIndexLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', attachmentId)
      .where('contentIndexLeaseOwner', '=', leaseOwner)
      .execute();
  }

  private async markFailed(
    attachmentId: string,
    leaseOwner: string,
    err: unknown,
  ): Promise<void> {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Attachment content indexing failed';
    await this.db
      .updateTable('attachments')
      .set({
        contentIndexStatus: 'failed',
        contentIndexError: message.slice(0, 2000),
        contentIndexLeaseOwner: null,
        contentIndexLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', attachmentId)
      .where('contentIndexStatus', '=', 'indexing')
      .where('contentIndexLeaseOwner', '=', leaseOwner)
      .execute();
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Attachment content indexing exceeded ${timeoutMs} milliseconds`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
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
      attachment.deletionStatus === 'active' &&
      attachment.type === AttachmentType.File &&
      attachment.pageId &&
      attachment.spaceId,
    );
  }

  private skipped(
    attachmentId: string,
    pageId: string | null,
    skippedReason: 'missing' | 'unsupported' | 'busy',
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
