import { AttachmentLifecycleService } from './attachment-lifecycle.service';

describe('AttachmentLifecycleService', () => {
  const updateQuery = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const selectQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const db = {
    updateTable: jest.fn(() => updateQuery),
    selectFrom: jest.fn(() => selectQuery),
  };
  const attachmentQueue = {
    add: jest.fn(),
  };
  const attachmentService = {
    resumeFileDeletion: jest.fn(),
  };
  let service: AttachmentLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    updateQuery.execute.mockResolvedValue([{ id: 'unsupported-1' }]);
    selectQuery.execute
      .mockResolvedValueOnce([
        {
          id: 'attachment-1',
          contentIndexAttemptCount: 2,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: 'attachment-delete-1' }]);
    attachmentQueue.add.mockResolvedValue(undefined);
    attachmentService.resumeFileDeletion.mockResolvedValue(undefined);
    service = new AttachmentLifecycleService(
      db as never,
      attachmentQueue as never,
      attachmentService as never,
    );
  });

  it('recovers unsupported, unqueued, and interrupted attachment work', async () => {
    await expect(service.recoverPendingWork()).resolves.toEqual({
      skippedUnsupported: 1,
      queuedIndexing: 1,
      resumedDeletions: 1,
    });
    expect(attachmentQueue.add).toHaveBeenCalledWith(
      'attachment-index-content',
      { attachmentId: 'attachment-1' },
      expect.objectContaining({
        jobId: 'attachment-content-attachment-1-3',
        attempts: 2,
      }),
    );
    expect(attachmentService.resumeFileDeletion).toHaveBeenCalledWith(
      'attachment-delete-1',
    );
  });

  it('keeps pending rows recoverable when BullMQ is unavailable', async () => {
    attachmentQueue.add.mockRejectedValueOnce(new Error('queue offline'));

    await expect(service.recoverPendingWork()).resolves.toEqual(
      expect.objectContaining({ queuedIndexing: 0 }),
    );
  });
});
