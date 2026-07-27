jest.mock('../../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { ConflictException } from '@nestjs/common';
import { PageService } from './page.service';

describe('PageService optimistic locking', () => {
  const expectedUpdatedAt = new Date('2026-07-10T01:02:03.456Z');
  const page = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    updatedAt: expectedUpdatedAt,
    title: 'Original',
    icon: null,
    lastUpdatedById: 'user-0',
    contributorIds: [],
    content: { type: 'doc', content: [] },
  };
  const user = { id: 'user-1' };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(expectedUpdatedAt);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createHarness = (
    numUpdatedRows: bigint,
    options: {
      collaborationError?: Error;
      storedContent?: object;
      rollbackRows?: bigint;
    } = {},
  ) => {
    const updatedPage = {
      ...page,
      title: 'Updated',
      updatedAt: new Date(expectedUpdatedAt.getTime() + 1),
      contributorIds: [user.id],
    };
    const updatePage = jest
      .fn()
      .mockResolvedValueOnce({ numUpdatedRows })
      .mockResolvedValue({
        numUpdatedRows: options.rollbackRows ?? 1n,
      });
    const pageRepo = {
      updatePage,
      findById: jest
        .fn()
        .mockResolvedValue(
          options.storedContent
            ? { ...updatedPage, content: options.storedContent }
            : updatedPage,
        ),
    };
    const generalQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const collaborationGateway = {
      handleYjsEvent: options.collaborationError
        ? jest
            .fn()
            .mockRejectedValueOnce(options.collaborationError)
            .mockResolvedValue(undefined)
        : jest.fn().mockResolvedValue(undefined),
    };
    const service = new PageService(
      pageRepo as never,
      null,
      null,
      null,
      null,
      null,
      null,
      generalQueue as never,
      null,
      collaborationGateway as never,
      null,
      null,
    );

    return {
      service,
      pageRepo,
      generalQueue,
      collaborationGateway,
      updatedPage,
    };
  };

  it('passes the expected timestamp into the repository compare-and-set', async () => {
    const { service, pageRepo, updatedPage } = createHarness(1n);

    await expect(
      service.update(
        page as never,
        { pageId: page.id, title: 'Updated' },
        user as never,
        { expectedUpdatedAt },
      ),
    ).resolves.toBe(updatedPage);

    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Updated',
        updatedAt: new Date(expectedUpdatedAt.getTime() + 1),
      }),
      page.id,
      undefined,
      { expectedUpdatedAt },
    );
  });

  it('throws before follow-up work when the compare-and-set misses', async () => {
    const { service, pageRepo, generalQueue } = createHarness(0n);

    await expect(
      service.update(
        page as never,
        { pageId: page.id, title: 'Stale update' },
        user as never,
        { expectedUpdatedAt },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(generalQueue.add).not.toHaveBeenCalled();
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('validates replacement content before updating page metadata', async () => {
    const { service, pageRepo } = createHarness(1n);
    jest
      .spyOn(service, 'prepareProsemirrorContent')
      .mockRejectedValueOnce(new Error('invalid content'));

    await expect(
      service.update(
        page as never,
        {
          pageId: page.id,
          content: 'invalid',
          operation: 'replace',
          format: 'markdown',
        },
        user as never,
      ),
    ).rejects.toThrow('invalid content');
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('compensates metadata when collaborative content persistence fails', async () => {
    const failure = new Error('collaboration unavailable');
    const { service, pageRepo, generalQueue } = createHarness(1n, {
      collaborationError: failure,
    });
    const preparedContent = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };

    await expect(
      service.update(
        page as never,
        {
          pageId: page.id,
          title: 'Updated',
          content: 'replacement',
          operation: 'replace',
          format: 'markdown',
        },
        user as never,
        { preparedContent },
      ),
    ).rejects.toThrow('collaboration unavailable');

    expect(pageRepo.updatePage).toHaveBeenCalledTimes(2);
    expect(pageRepo.updatePage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: page.title,
        icon: page.icon,
        lastUpdatedById: page.lastUpdatedById,
        updatedAt: page.updatedAt,
      }),
      page.id,
      undefined,
      { expectedUpdatedAt: new Date(expectedUpdatedAt.getTime() + 1) },
    );
    expect(generalQueue.add).not.toHaveBeenCalled();
  });

  it('accepts semantically equal content normalized by Yjs', async () => {
    const preparedContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'paragraph-1', indent: 0, textAlign: null },
          content: [{ type: 'text', text: 'Appended content' }],
        },
      ],
    };
    const storedContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'paragraph-1', indent: 0 },
          content: [{ type: 'text', text: 'Appended content' }],
        },
      ],
    };
    const { service, pageRepo } = createHarness(1n, { storedContent });

    await expect(
      service.update(
        page as never,
        {
          pageId: page.id,
          content: 'Appended content',
          operation: 'append',
          format: 'markdown',
        },
        user as never,
        { preparedContent },
      ),
    ).resolves.toMatchObject({ content: storedContent });

    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
  });

  it('compensates metadata when persisted content is incomplete', async () => {
    const { service, pageRepo, generalQueue } = createHarness(1n, {
      storedContent: { type: 'doc', content: [] },
    });

    await expect(
      service.update(
        page as never,
        {
          pageId: page.id,
          content: 'Expected content',
          operation: 'replace',
          format: 'markdown',
        },
        user as never,
        {
          preparedContent: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Expected content' }],
              },
            ],
          },
        },
      ),
    ).rejects.toThrow('Page content persistence was not verified');

    expect(pageRepo.updatePage).toHaveBeenCalledTimes(2);
    expect(generalQueue.add).not.toHaveBeenCalled();
  });

  it('marks the write as repair-required when compensation loses its CAS', async () => {
    const { service } = createHarness(1n, {
      collaborationError: new Error('collaboration unavailable'),
      rollbackRows: 0n,
    });

    await expect(
      service.update(
        page as never,
        {
          pageId: page.id,
          content: 'replacement',
          operation: 'replace',
          format: 'markdown',
        },
        user as never,
        { preparedContent: { type: 'doc', content: [] } },
      ),
    ).rejects.toThrow('requires repair');
  });
});
