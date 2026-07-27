import { HttpStatus } from '@nestjs/common';
import type { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { EnvironmentService } from '../../integrations/environment/environment.service';
import { SearchRateLimitService } from './search-rate-limit.service';

describe('SearchRateLimitService', () => {
  const environmentService = {
    getVectorSearchRateLimitWindowSeconds: jest.fn(() => 60),
    getVectorSearchRateLimitMaxRequests: jest.fn(() => 2),
  };
  const redis = {
    eval: jest.fn(),
  };
  const redisService = {
    getOrThrow: jest.fn(() => redis),
  };
  let service: SearchRateLimitService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    environmentService.getVectorSearchRateLimitWindowSeconds.mockReturnValue(
      60,
    );
    environmentService.getVectorSearchRateLimitMaxRequests.mockReturnValue(2);
    service = new SearchRateLimitService(
      environmentService as unknown as EnvironmentService,
      redisService as unknown as RedisService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shares a workspace and user bucket across application replicas', async () => {
    redis.eval
      .mockResolvedValueOnce([1, 60_000])
      .mockResolvedValueOnce([2, 59_000])
      .mockResolvedValueOnce([3, 58_000]);

    const input = { workspaceId: 'workspace-1', userId: 'user-1' };
    await expect(
      service.assertSemanticSearchAllowed(input),
    ).resolves.toBeUndefined();
    await expect(
      service.assertSemanticSearchAllowed(input),
    ).resolves.toBeUndefined();
    await expect(
      service.assertSemanticSearchAllowed(input),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: expect.stringContaining('retry after 58s'),
    });

    expect(redis.eval.mock.calls.map((call) => call[2])).toEqual([
      expect.stringContaining('workspace-1:user-1'),
      expect.stringContaining('workspace-1:user-1'),
      expect.stringContaining('workspace-1:user-1'),
    ]);
    expect(redis.eval.mock.calls.map((call) => call[4])).toEqual([
      59_000, 59_000, 59_000,
    ]);
  });

  it('fails closed when distributed coordination is unavailable', async () => {
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.assertSemanticSearchAllowed({
        workspaceId: 'workspace-1',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
