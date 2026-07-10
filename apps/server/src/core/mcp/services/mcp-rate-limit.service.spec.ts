import { HttpException, HttpStatus } from '@nestjs/common';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
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
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows exactly the configured maximum and rejects the next request', () => {
    expect(() => service.assertWithinLimit(client)).not.toThrow();
    expect(() => service.assertWithinLimit(client)).not.toThrow();

    let error: unknown;
    try {
      service.assertWithinLimit(client);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect((error as Error).message).toContain('retry after 10s');
  });

  it('resets a bucket after the configured window', () => {
    service.assertWithinLimit(client);
    service.assertWithinLimit(client);
    expect(() => service.assertWithinLimit(client)).toThrow(HttpException);

    now += 10_000;
    expect(() => service.assertWithinLimit(client)).not.toThrow();
  });

  it('isolates buckets by both workspace and client id', () => {
    service.assertWithinLimit(client);
    service.assertWithinLimit(client);

    expect(() =>
      service.assertWithinLimit({ ...client, id: 'client-2' }),
    ).not.toThrow();
    expect(() =>
      service.assertWithinLimit({ ...client, workspaceId: 'workspace-2' }),
    ).not.toThrow();
  });

  it.each([
    [0, 10],
    [10, 0],
    [-1, 10],
  ])(
    'disables limiting for non-positive window/max values (%s, %s)',
    (windowSeconds, maxRequests) => {
      environmentService.getMcpRateLimitWindowSeconds.mockReturnValue(
        windowSeconds,
      );
      environmentService.getMcpRateLimitMaxRequests.mockReturnValue(
        maxRequests,
      );

      for (let index = 0; index < 5; index += 1) {
        expect(() => service.assertWithinLimit(client)).not.toThrow();
      }
    },
  );

  it('prunes expired buckets once the map reaches its safety threshold', () => {
    environmentService.getMcpRateLimitMaxRequests.mockReturnValue(10);
    environmentService.getMcpRateLimitWindowSeconds.mockReturnValue(1);
    for (let index = 0; index < 1000; index += 1) {
      service.assertWithinLimit({
        ...client,
        id: `client-${index}`,
      });
    }

    now += 2_000;
    service.assertWithinLimit({ ...client, id: 'fresh-client' });

    const buckets = (
      service as unknown as {
        buckets: Map<string, unknown>;
      }
    ).buckets;
    expect(buckets.size).toBe(1);
    expect(buckets.has('workspace-1:fresh-client')).toBe(true);
  });
});
