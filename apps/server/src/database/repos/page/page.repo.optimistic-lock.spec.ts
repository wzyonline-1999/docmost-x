import { EventName } from '../../../common/events/event.contants';
import { PageRepo } from './page.repo';

describe('PageRepo optimistic locking', () => {
  const pageId = '11111111-1111-4111-8111-111111111111';
  const expectedUpdatedAt = new Date('2026-07-10T01:02:03.456Z');

  const createHarness = (numUpdatedRows: bigint) => {
    const updateQuery = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue({ numUpdatedRows }),
    };
    const db = {
      updateTable: jest.fn(() => updateQuery),
    };
    const eventEmitter = {
      emit: jest.fn(),
    };
    const repo = new PageRepo(db as never, null, eventEmitter as never);

    return { repo, updateQuery, eventEmitter };
  };

  it('adds the expected timestamp to the atomic update predicate', async () => {
    const { repo, updateQuery, eventEmitter } = createHarness(1n);

    await repo.updatePage({ title: 'Updated' }, pageId, undefined, {
      expectedUpdatedAt,
    });

    expect(updateQuery.where).toHaveBeenCalledWith(
      'updatedAt',
      '>=',
      expectedUpdatedAt,
    );
    expect(updateQuery.where).toHaveBeenCalledWith(
      'updatedAt',
      '<',
      new Date(expectedUpdatedAt.getTime() + 1),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(EventName.PAGE_UPDATED, {
      pageIds: [pageId],
      workspaceId: undefined,
    });
  });

  it('does not emit a page update event when the compare-and-set misses', async () => {
    const { repo, eventEmitter } = createHarness(0n);

    await repo.updatePage({ title: 'Stale update' }, pageId, undefined, {
      expectedUpdatedAt,
    });

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
