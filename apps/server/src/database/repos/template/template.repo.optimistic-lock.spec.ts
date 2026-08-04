import { TemplateRepo } from './template.repo';

describe('TemplateRepo optimistic locking', () => {
  const templateId = '11111111-1111-4111-8111-111111111111';
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const expectedUpdatedAt = new Date('2026-08-02T01:02:03.456Z');

  const createHarness = (result: unknown) => {
    const updateQuery = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returningAll: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(result),
    };
    const db = {
      updateTable: jest.fn(() => updateQuery),
    };

    return {
      repo: new TemplateRepo(db as never),
      updateQuery,
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(expectedUpdatedAt);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('matches the full PostgreSQL microsecond range represented by an ISO millisecond', async () => {
    const { repo, updateQuery } = createHarness({ id: templateId });

    await repo.updateTemplate(
      { title: 'Updated' },
      templateId,
      workspaceId,
      { expectedUpdatedAt },
    );

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
    expect(updateQuery.set).toHaveBeenCalledWith({
      title: 'Updated',
      updatedAt: new Date(expectedUpdatedAt.getTime() + 1),
    });
  });

  it('returns undefined when the compare-and-set predicate misses', async () => {
    const { repo } = createHarness(undefined);

    await expect(
      repo.updateTemplate(
        { title: 'Stale update' },
        templateId,
        workspaceId,
        { expectedUpdatedAt },
      ),
    ).resolves.toBeUndefined();
  });
});
