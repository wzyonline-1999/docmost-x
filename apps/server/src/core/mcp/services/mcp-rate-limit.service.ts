import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { McpAuthenticatedClient } from '../types/mcp.types';

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

@Injectable()
export class McpRateLimitService {
  private readonly redis: Redis;

  constructor(
    private readonly environmentService: EnvironmentService,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async assertWithinLimit(
    client: McpAuthenticatedClient,
    cost = 1,
  ): Promise<void> {
    const windowSeconds =
      this.environmentService.getMcpRateLimitWindowSeconds();
    const maxRequests = this.environmentService.getMcpRateLimitMaxRequests();

    if (windowSeconds <= 0 || maxRequests <= 0) {
      return;
    }

    const normalizedCost = Math.max(1, Math.floor(cost));
    const windowMs = windowSeconds * 1000;
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const bucketTtlMs = Math.max(1, windowMs - (now % windowMs));
    const key = `docmost:mcp:rate-limit:${client.workspaceId}:${client.id}:${window}`;
    let result: unknown;
    try {
      result = await this.redis.eval(
        RATE_LIMIT_SCRIPT,
        1,
        key,
        normalizedCost,
        bucketTtlMs,
      );
    } catch {
      throw new ServiceUnavailableException(
        'MCP rate limiter is temporarily unavailable',
      );
    }

    const [countValue, ttlValue] = Array.isArray(result) ? result : [];
    const count = Number(countValue);
    const remainingTtlMs = Math.max(0, Number(ttlValue));
    if (!Number.isFinite(count)) {
      throw new ServiceUnavailableException(
        'MCP rate limiter returned an invalid response',
      );
    }

    if (count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil(remainingTtlMs / 1000));
      throw new HttpException(
        `MCP rate limit exceeded; retry after ${retryAfterSeconds}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
