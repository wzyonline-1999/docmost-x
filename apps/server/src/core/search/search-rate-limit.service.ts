import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { EnvironmentService } from '../../integrations/environment/environment.service';

const SEARCH_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

@Injectable()
export class SearchRateLimitService {
  private readonly redis: Redis;

  constructor(
    private readonly environmentService: EnvironmentService,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async assertSemanticSearchAllowed(input: {
    workspaceId: string;
    userId: string;
    cost?: number;
  }): Promise<void> {
    const windowSeconds =
      this.environmentService.getVectorSearchRateLimitWindowSeconds();
    const maxRequests =
      this.environmentService.getVectorSearchRateLimitMaxRequests();
    const cost = Math.max(1, Math.floor(input.cost ?? 1));
    const windowMs = windowSeconds * 1_000;
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const bucketTtlMs = Math.max(1, windowMs - (now % windowMs));
    const key = `docmost:search:semantic-rate-limit:${input.workspaceId}:${input.userId}:${window}`;

    let result: unknown;
    try {
      result = await this.redis.eval(
        SEARCH_RATE_LIMIT_SCRIPT,
        1,
        key,
        cost,
        bucketTtlMs,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Semantic search rate limiter is temporarily unavailable',
      );
    }

    const [countValue, ttlValue] = Array.isArray(result) ? result : [];
    const count = Number(countValue);
    const remainingTtlMs = Math.max(0, Number(ttlValue));
    if (!Number.isFinite(count)) {
      throw new ServiceUnavailableException(
        'Semantic search rate limiter returned an invalid response',
      );
    }

    if (count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil(remainingTtlMs / 1_000));
      throw new HttpException(
        `Semantic search rate limit exceeded; retry after ${retryAfterSeconds}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
