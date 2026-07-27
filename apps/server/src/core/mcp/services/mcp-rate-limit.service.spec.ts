import { HttpException, HttpStatus } from '@nestjs/common';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { McpAuthenticatedClient } from '../types/mcp.types';
import { McpRateLimitService } from './mcp-rate-limit.service';

describe('McpRateLimitService', () => {
  const environmentService = {
    getMcpRateLimitWindowSeconds: jest.fn(() => 10),
    getMcpRateLimitMaxRequests: jest.fn(() => 2),
  };
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
  } as McpAuthenticatedClient;
  const redis = {
    eval: jest.fn(),
  };
  const redisService = {
    getOrThrow: jest.fn(() => redis),
  };
  let now: number;
  let service: McpRateLimitService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    environmentService.getMcpRateLimitWindowSeconds.mockReturnValue(10);
    environmentService.getMcpRateLimitMaxRequests.mockReturnValue(2);
    service = new McpRateLimitService(
      environmentService as unknown as EnvironmentService,
      redisService as unknown as RedisService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows exactly the configured maximum and rejects the next request', async () => {
    redis.eval
      .mockResolvedValueOnce([1, 10_000])
      .mockResolvedValueOnce([2, 9_000])
      .mockResolvedValueOnce([3, 8_000]);

    await expect(service.assertWithinLimit(client)).resolves.toBeUndefined();
    await expect(service.assertWithinLimit(client)).resolves.toBeUndefined();
    await expect(service.assertWithinLimit(client)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: expect.stringContaining('retry after 8s'),
    });
  });

  it('uses a new distributed bucket after the configured window', async () => {
    redis.eval.mockResolvedValue([1, 10_000]);
    await service.assertWithinLimit(client);
    const firstKey = redis.eval.mock.calls[0][2];
    now += 10_000;
    await service.assertWithinLimit(client);
    const secondKey = redis.eval.mock.calls[1][2];

    expect(firstKey).not.toBe(secondKey);
  });

  it('isolates buckets by both workspace and client id', async () => {
    redis.eval.mockResolvedValue([1, 10_000]);

    await service.assertWithinLimit(client);
    await service.assertWithinLimit({ ...client, id: 'client-2' });
    await service.assertWithinLimit({
      ...client,
      workspaceId: 'workspace-2',
    });

    const keys = redis.eval.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    [0, 10],
    [10, 0],
    [-1, 10],
  ])(
    'disables limiting for non-positive window/max values (%s, %s)',
    async (windowSeconds, maxRequests) => {
      environmentService.getMcpRateLimitWindowSeconds.mockReturnValue(
        windowSeconds,
      );
      environmentService.getMcpRateLimitMaxRequests.mockReturnValue(
        maxRequests,
      );

      for (let index = 0; index < 5; index += 1) {
        await expect(
          service.assertWithinLimit(client),
        ).resolves.toBeUndefined();
      }
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );

  it('charges a whole batch in one distributed increment', async () => {
    redis.eval.mockResolvedValueOnce([5, 10_000]);
    environmentService.getMcpRateLimitMaxRequests.mockReturnValue(10);

    await service.assertWithinLimit(client, 5);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.any(String),
      5,
      9_000,
    );
  });

  it('fails closed when Redis is unavailable', async () => {
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.assertWithinLimit(client)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
