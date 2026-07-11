import { PageHistoryService } from './page-history.service';

describe('PageHistoryService', () => {
  const page = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Snapshot title',
    icon: null,
    coverPhoto: null,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  };

  const createHarness = () => {
    const pageHistoryRepo = {
      findPageLastHistory: jest.fn().mockResolvedValue(null),
      saveHistory: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PageHistoryService(pageHistoryRepo as never);
    return { service, pageHistoryRepo };
  };

  it('saves a first snapshot with the supplied contributors', async () => {
    const harness = createHarness();

    await expect(
      harness.service.saveSnapshotIfChanged(page as never, ['user-1']),
    ).resolves.toBe(true);

    expect(harness.pageHistoryRepo.saveHistory).toHaveBeenCalledWith(page, {
      contributorIds: ['user-1'],
    });
  });

  it('does not duplicate an identical latest snapshot', async () => {
    const harness = createHarness();
    harness.pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      ...page,
      content: page.content,
    });

    await expect(
      harness.service.saveSnapshotIfChanged(page as never, ['user-1']),
    ).resolves.toBe(false);

    expect(harness.pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'Previous title' }],
    ['icon', { icon: 'book' }],
    ['cover photo', { coverPhoto: 'cover.png' }],
    ['content', { content: { type: 'doc', content: [] } }],
  ])('saves when the latest %s differs', async (_label, difference) => {
    const harness = createHarness();
    harness.pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      ...page,
      ...difference,
    });

    await expect(
      harness.service.saveSnapshotIfChanged(page as never),
    ).resolves.toBe(true);
    expect(harness.pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
  });
});
