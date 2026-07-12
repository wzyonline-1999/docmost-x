import type { Job } from 'bullmq';
import { QueueJob } from '../../../integrations/queue/constants';
import { AttachmentProcessor } from './attachment.processor';

describe('AttachmentProcessor content indexing', () => {
  const attachmentService = {
    handleDeleteSpaceAttachments: jest.fn(),
    handleDeleteUserAvatars: jest.fn(),
    handleDeletePageAttachments: jest.fn(),
    handleDeleteAiChatAttachments: jest.fn(),
  };
  const attachmentContentIndexService = {
    indexAttachmentContent: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new AttachmentProcessor(
    attachmentService as never,
    attachmentContentIndexService as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it.each([QueueJob.ATTACHMENT_INDEX_CONTENT, QueueJob.ATTACHMENT_INDEXING])(
    'routes %s to the community content indexer',
    async (name) => {
      await processor.process({
        name,
        data: { attachmentId: 'attachment-1' },
      } as Job);

      expect(
        attachmentContentIndexService.indexAttachmentContent,
      ).toHaveBeenCalledWith('attachment-1');
    },
  );
});
