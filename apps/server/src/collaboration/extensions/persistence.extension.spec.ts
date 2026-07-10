jest.mock('@docmost/db/utils', () => ({
  executeTx: jest.fn(async (_db, callback) => callback({})),
}));

import { Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { executeTx } from '@docmost/db/utils';
import { tiptapExtensions } from '../collaboration.util';
import { PersistenceExtension } from './persistence.extension';

describe('PersistenceExtension', () => {
  const pageId = '11111111-1111-4111-8111-111111111111';
  const page = {
    id: pageId,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    creatorId: 'user-1',
    slugId: 'page-slug',
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    contributorIds: [],
    content: { type: 'doc', content: [] },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('contains follow-up failures after page content is persisted', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const harness = createHarness();
    harness.aiQueue.add.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      harness.extension.onStoreDocument(storePayload()),
    ).resolves.toBeUndefined();

    expect(harness.pageRepo.updatePage).toHaveBeenCalled();
    expect(harness.historyQueue.add).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith({
      event: 'page.persistence.follow_up_failed',
      pageId,
      effect: 'ai_queue',
      errorType: 'Error',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'queue unavailable',
    );
  });

  it('still rejects strict writes when the persistence transaction fails', async () => {
    const failure = new Error('database unavailable');
    (executeTx as jest.Mock).mockRejectedValueOnce(failure);
    const harness = createHarness();

    await expect(
      harness.extension.onStoreDocument(
        storePayload({ strictPersistence: true }),
      ),
    ).rejects.toBe(failure);

    expect(harness.aiQueue.add).not.toHaveBeenCalled();
    expect(harness.historyQueue.add).not.toHaveBeenCalled();
  });

  function createHarness() {
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
      updatePage: jest.fn().mockResolvedValue({ numUpdatedRows: 1n }),
    };
    const aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const historyQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const collabHistory = {
      addContributors: jest.fn().mockResolvedValue(undefined),
    };
    const transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
    };
    const extension = new PersistenceExtension(
      pageRepo as never,
      {} as never,
      aiQueue as never,
      historyQueue as never,
      notificationQueue as never,
      collabHistory as never,
      transclusionService as never,
    );

    return {
      extension,
      pageRepo,
      aiQueue,
      historyQueue,
    };
  }

  function storePayload(
    context: Record<string, unknown> = {},
  ): Parameters<PersistenceExtension['onStoreDocument']>[0] {
    const document = TiptapTransformer.toYdoc(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'paragraph-1', indent: 0 },
            content: [{ type: 'text', text: 'persisted content' }],
          },
        ],
      },
      'default',
      tiptapExtensions,
    ) as unknown as { broadcastStateless: jest.Mock };
    document.broadcastStateless = jest.fn();

    return {
      documentName: `page.${pageId}`,
      document,
      context: {
        user: { id: 'user-1' },
        ...context,
      },
    } as never;
  }
});
