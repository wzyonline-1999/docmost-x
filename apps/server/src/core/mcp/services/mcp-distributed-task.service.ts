import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export type McpDistributedTaskResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

@Injectable()
export class McpDistributedTaskService {
  private readonly redis: Redis;

  constructor(redisService: RedisService) {
    this.redis = redisService.getOrThrow();
  }

  async runWithLock<T>(
    name: string,
    ttlMs: number,
    task: () => Promise<T>,
  ): Promise<McpDistributedTaskResult<T>> {
    const token = randomUUID();
    const key = `docmost:mcp:task-lock:${name}`;
    const normalizedTtlMs = Math.max(1_000, Math.floor(ttlMs));
    let acquired: string | null;
    try {
      acquired = await this.redis.set(key, token, 'PX', normalizedTtlMs, 'NX');
    } catch {
      throw new ServiceUnavailableException(
        'Distributed task coordination is temporarily unavailable',
      );
    }

    if (acquired !== 'OK') {
      return { acquired: false };
    }

    try {
      const value = await this.runWithHeartbeat(
        key,
        token,
        normalizedTtlMs,
        task,
      );
      return { acquired: true, value };
    } finally {
      await this.redis
        .eval(RELEASE_LOCK_SCRIPT, 1, key, token)
        .catch(() => undefined);
    }
  }

  async runOncePerWindow<T>(
    name: string,
    ttlMs: number,
    task: () => Promise<T>,
  ): Promise<McpDistributedTaskResult<T>> {
    const token = randomUUID();
    const key = `docmost:mcp:task-window:${name}`;
    let acquired: string | null;
    try {
      acquired = await this.redis.set(
        key,
        token,
        'PX',
        Math.max(1_000, Math.floor(ttlMs)),
        'NX',
      );
    } catch {
      throw new ServiceUnavailableException(
        'Distributed task coordination is temporarily unavailable',
      );
    }

    if (acquired !== 'OK') {
      return { acquired: false };
    }

    try {
      return { acquired: true, value: await task() };
    } catch (err) {
      await this.redis
        .eval(RELEASE_LOCK_SCRIPT, 1, key, token)
        .catch(() => undefined);
      throw err;
    }
  }

  private async runWithHeartbeat<T>(
    key: string,
    token: string,
    ttlMs: number,
    task: () => Promise<T>,
  ): Promise<T> {
    let heartbeatError: unknown;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = () => {
      if (heartbeatInFlight || heartbeatError) {
        return;
      }

      heartbeatInFlight = this.redis
        .eval(RENEW_LOCK_SCRIPT, 1, key, token, ttlMs)
        .then((renewed) => {
          if (Number(renewed) !== 1) {
            throw new ServiceUnavailableException(
              'Distributed task lock was lost',
            );
          }
        })
        .catch((err) => {
          heartbeatError =
            err instanceof ServiceUnavailableException
              ? err
              : new ServiceUnavailableException(
                  'Distributed task lock renewal failed',
                );
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    };
    const timer = setInterval(heartbeat, Math.max(250, Math.floor(ttlMs / 3)));
    timer.unref?.();

    try {
      const value = await task();
      await heartbeatInFlight;
      if (heartbeatError) {
        throw heartbeatError;
      }
      return value;
    } finally {
      clearInterval(timer);
    }
  }
}
