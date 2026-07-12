import { BadRequestException } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { EventName } from '../../../common/events/event.contants';
import { AttachmentType } from '../attachment.constants';
import {
  AttachmentContentIndexService,
  MAX_ATTACHMENT_INDEX_BYTES,
  MAX_ATTACHMENT_INDEX_CHARS,
} from './attachment-content-index.service';

jest.mock('mammoth', () => ({ extractRawText: jest.fn() }));
jest.mock('unpdf', () => ({ extractText: jest.fn() }));

describe('AttachmentContentIndexService', () => {
  const attachment = {
    id: '11111111-1111-4111-8111-111111111111',
    type: AttachmentType.File,
    filePath: 'workspace-1/files/attachment/report.txt',
    fileName: 'report.txt',
    fileSize: 12,
    fileExt: '.txt',
    mimeType: 'text/plain',
    textContent: null,
    creatorId: 'user-1',
    workspaceId: 'workspace-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    aiChatId: null,
    createdAt: new Date('2026-07-12T00:00:00.000Z'),
    updatedAt: new Date('2026-07-12T00:00:00.000Z'),
    deletedAt: null,
  };

  const createHarness = (overrides = {}) => {
    const current = { ...attachment, ...overrides };
    const attachmentRepo = {
      findByIdWithContent: jest.fn().mockResolvedValue(current),
      updateAttachment: jest.fn().mockResolvedValue(current),
    };
    const storageService = {
      read: jest
        .fn()
        .mockResolvedValue(Buffer.from('hello\r\n\r\n\r\nworld\0')),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = new AttachmentContentIndexService(
      attachmentRepo as never,
      storageService as never,
      eventEmitter as never,
    );
    return { service, attachmentRepo, storageService, eventEmitter };
  };

  beforeEach(() => jest.clearAllMocks());

  it('extracts plain text, persists normalized content, and emits reindex metadata', async () => {
    const harness = createHarness();

    await expect(
      harness.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(
      expect.objectContaining({
        indexed: true,
        changed: true,
        charLength: 12,
        truncated: false,
      }),
    );
    expect(harness.attachmentRepo.updateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: 'hello\n\nworld' }),
      attachment.id,
    );
    expect(harness.eventEmitter.emit).toHaveBeenCalledWith(
      EventName.ATTACHMENT_CONTENT_UPDATED,
      {
        attachmentId: attachment.id,
        pageIds: [attachment.pageId],
        workspaceId: attachment.workspaceId,
      },
    );
  });

  it('uses mammoth for docx attachments', async () => {
    const harness = createHarness({ fileExt: '.docx' });
    jest
      .mocked(mammoth.extractRawText)
      .mockResolvedValue({ value: 'docx text', messages: [] });

    await harness.service.indexAttachmentContent(attachment.id);

    expect(mammoth.extractRawText).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
    });
    expect(harness.attachmentRepo.updateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: 'docx text' }),
      attachment.id,
    );
  });

  it('uses unpdf for pdf attachments', async () => {
    const harness = createHarness({ fileExt: '.pdf' });
    jest.mocked(extractPdfText).mockResolvedValue({
      text: 'pdf text',
      totalPages: 1,
    });

    await harness.service.indexAttachmentContent(attachment.id);

    expect(extractPdfText).toHaveBeenCalledWith(expect.any(Uint8Array), {
      mergePages: true,
    });
    expect(harness.attachmentRepo.updateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: 'pdf text' }),
      attachment.id,
    );
  });

  it('does not rewrite or emit when extracted text is unchanged', async () => {
    const harness = createHarness({ textContent: 'same' });
    harness.storageService.read.mockResolvedValue(Buffer.from('same'));

    await expect(
      harness.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(expect.objectContaining({ changed: false }));
    expect(harness.attachmentRepo.updateAttachment).not.toHaveBeenCalled();
    expect(harness.eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('truncates extracted text at the configured character limit', async () => {
    const harness = createHarness();
    harness.storageService.read.mockResolvedValue(
      Buffer.from('x'.repeat(MAX_ATTACHMENT_INDEX_CHARS + 1)),
    );

    await expect(
      harness.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(
      expect.objectContaining({
        changed: true,
        charLength: MAX_ATTACHMENT_INDEX_CHARS,
        truncated: true,
      }),
    );
    expect(harness.attachmentRepo.updateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        textContent: 'x'.repeat(MAX_ATTACHMENT_INDEX_CHARS),
      }),
      attachment.id,
    );
  });

  it('clears stale extracted text and emits a reindex event for empty content', async () => {
    const harness = createHarness({ textContent: 'stale text' });
    harness.storageService.read.mockResolvedValue(Buffer.from(' \r\n\0 '));

    await expect(
      harness.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(
      expect.objectContaining({
        changed: true,
        charLength: 0,
        truncated: false,
      }),
    );
    expect(harness.attachmentRepo.updateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: null }),
      attachment.id,
    );
    expect(harness.eventEmitter.emit).toHaveBeenCalledWith(
      EventName.ATTACHMENT_CONTENT_UPDATED,
      {
        attachmentId: attachment.id,
        pageIds: [attachment.pageId],
        workspaceId: attachment.workspaceId,
      },
    );
  });

  it('skips missing and unsupported attachments without reading storage', async () => {
    const missing = createHarness();
    missing.attachmentRepo.findByIdWithContent.mockResolvedValue(undefined);
    const unsupported = createHarness({ fileExt: '.zip' });

    await expect(
      missing.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(expect.objectContaining({ skippedReason: 'missing' }));
    await expect(
      unsupported.service.indexAttachmentContent(attachment.id),
    ).resolves.toEqual(
      expect.objectContaining({ skippedReason: 'unsupported' }),
    );
    expect(missing.storageService.read).not.toHaveBeenCalled();
    expect(unsupported.storageService.read).not.toHaveBeenCalled();
  });

  it('rejects oversized attachments before reading storage', async () => {
    const harness = createHarness({
      fileSize: MAX_ATTACHMENT_INDEX_BYTES + 1,
    });

    await expect(
      harness.service.indexAttachmentContent(attachment.id),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.storageService.read).not.toHaveBeenCalled();
  });
});
