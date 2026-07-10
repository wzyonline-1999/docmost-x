import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import type { McpAuthenticatedClient } from '../types/mcp.types';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class McpRateLimitService {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(private readonly environmentService: EnvironmentService) {}

  assertWithinLimit(client: McpAuthenticatedClient): void {
    const windowSeconds =
      this.environmentService.getMcpRateLimitWindowSeconds();
    const maxRequests = this.environmentService.getMcpRateLimitMaxRequests();

    if (windowSeconds <= 0 || maxRequests <= 0) {
      return;
    }

    const key = `${client.workspaceId}:${client.id}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      this.pruneExpiredBuckets(now);
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      throw new HttpException(
        `MCP rate limit exceeded; retry after ${retryAfterSeconds}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private pruneExpiredBuckets(now: number): void {
    if (this.buckets.size < 1000) {
      return;
    }

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
