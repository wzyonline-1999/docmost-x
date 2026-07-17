import { AttachmentType } from '../attachment.constants';
import { AttachmentService } from './attachment.service';
import { EventName } from '../../../common/events/event.contants';

describe('AttachmentService MCP buffer operations', () => {
  const attachment = {
    id: '11111111-1111-4111-8111-111111111111',
    type: AttachmentType.File,
    filePath:
      'workspace-1/files/11111111-1111-4111-8111-111111111111/content.pdf',
    fileName: 'report.pdf',
    fileSize: 4,
    fileExt: '.pdf',
    mimeType: 'application/pdf',
    creatorId: 'user-1',
    workspaceId: 'workspace-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    aiChatId: null,
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    deletedAt: null,
  };

  const createHarness = () => {
    const storageService = {
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const attachmentRepo = {
      insertAttachment: jest.fn().mockResolvedValue(attachment),
      deleteAttachmentById: jest.fn().mockResolvedValue(undefined),
    };
    const attachmentQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = new AttachmentService(
      storageService as never,
      attachmentRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      attachmentQueue as never,
      eventEmitter as never,
    );

    return {
      service,
      storageService,
      attachmentRepo,
      attachmentQueue,
      eventEmitter,
    };
  };

  it('stores a buffer attachment and queues PDF content extraction', async () => {
    const harness = createHarness();
    const result = await harness.service.uploadBufferFile({
      buffer: Buffer.from('test'),
      fileName: 'report.pdf',
      pageId: 'page-1',
      userId: 'user-1',
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      attachmentId: attachment.id,
    });

    expect(harness.storageService.upload).toHaveBeenCalledWith(
      attachment.filePath,
      expect.any(Buffer),
    );
    expect(harness.attachmentRepo.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: attachment.id,
        fileName: 'report.pdf',
        fileSize: 4,
        fileExt: '.pdf',
        mimeType: 'application/pdf',
      }),
      undefined,
    );
    expect(harness.attachmentQueue.add).toHaveBeenCalledWith(
      'attachment-index-content',
      { attachmentId: attachment.id },
      expect.objectContaining({ attempts: 2 }),
    );
    expect(result).toBe(attachment);
  });

  it('removes the uploaded object when metadata persistence fails', async () => {
    const harness = createHarness();
    harness.attachmentRepo.insertAttachment.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      harness.service.uploadBufferFile({
        buffer: Buffer.from('test'),
        fileName: 'report.txt',
        pageId: 'page-1',
        userId: 'user-1',
        spaceId: 'space-1',
        workspaceId: 'workspace-1',
        attachmentId: attachment.id,
      }),
    ).rejects.toThrow('database unavailable');
    expect(harness.storageService.delete).toHaveBeenCalledWith(
      'workspace-1/files/11111111-1111-4111-8111-111111111111/content.txt',
    );
  });

  it('keeps a Unicode display name out of the storage object key', async () => {
    const harness = createHarness();

    await harness.service.uploadBufferFile({
      buffer: Buffer.from('image'),
      fileName: '岗位发布业务模型图.png',
      pageId: 'page-1',
      userId: 'user-1',
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      attachmentId: attachment.id,
    });

    expect(harness.storageService.upload).toHaveBeenCalledWith(
      'workspace-1/files/11111111-1111-4111-8111-111111111111/content.png',
      expect.any(Buffer),
    );
    expect(harness.attachmentRepo.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath:
          'workspace-1/files/11111111-1111-4111-8111-111111111111/content.png',
        fileName: '岗位发布业务模型图.png',
        fileExt: '.png',
        mimeType: 'image/png',
      }),
      undefined,
    );
  });

  it('keeps a persisted attachment when content indexing cannot be queued', async () => {
    const harness = createHarness();
    harness.attachmentQueue.add.mockRejectedValue(new Error('queue offline'));

    await expect(
      harness.service.uploadBufferFile({
        buffer: Buffer.from('test'),
        fileName: 'report.pdf',
        pageId: 'page-1',
        userId: 'user-1',
        spaceId: 'space-1',
        workspaceId: 'workspace-1',
        attachmentId: attachment.id,
      }),
    ).resolves.toBe(attachment);
    expect(harness.storageService.delete).not.toHaveBeenCalled();
  });

  it('deletes both the stored object and attachment metadata', async () => {
    const harness = createHarness();

    await harness.service.deleteFileAttachment(attachment as never);

    expect(harness.storageService.delete).toHaveBeenCalledWith(
      attachment.filePath,
    );
    expect(harness.attachmentRepo.deleteAttachmentById).toHaveBeenCalledWith(
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

  it('queues markdown content extraction', async () => {
    const harness = createHarness();

    await harness.service.uploadBufferFile({
      buffer: Buffer.from('# searchable markdown'),
      fileName: 'notes.md',
      pageId: 'page-1',
      userId: 'user-1',
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      attachmentId: attachment.id,
    });

    expect(harness.attachmentQueue.add).toHaveBeenCalledWith(
      'attachment-index-content',
      { attachmentId: attachment.id },
      expect.objectContaining({ attempts: 2 }),
    );
  });
});
