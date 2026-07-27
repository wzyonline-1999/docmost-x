import type { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { McpDistributedTaskService } from './mcp-distributed-task.service';

describe('McpDistributedTaskService', () => {
  const redis = {
    set: jest.fn(),
    eval: jest.fn(),
  };
  const redisService = {
    getOrThrow: jest.fn(() => redis),
  };
  let service: McpDistributedTaskService;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    service = new McpDistributedTaskService(
      redisService as unknown as RedisService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs a task only while holding the distributed lock', async () => {
    const task = jest.fn().mockResolvedValue('done');

    await expect(service.runWithLock('cleanup', 10_000, task)).resolves.toEqual(
      { acquired: true, value: 'done' },
    );
    expect(task).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      'docmost:mcp:task-lock:cleanup',
      expect.any(String),
    );
  });

  it('skips work when another replica owns the lock', async () => {
    redis.set.mockResolvedValueOnce(null);
    const task = jest.fn();

    await expect(service.runWithLock('cleanup', 10_000, task)).resolves.toEqual(
      { acquired: false },
    );
    expect(task).not.toHaveBeenCalled();
  });

  it('renews a long-running lock while the task is active', async () => {
    jest.useFakeTimers();
    let resolveTask: (value: string) => void;
    const task = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const result = service.runWithLock('cleanup', 3_000, task);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('PEXPIRE'"),
      1,
      'docmost:mcp:task-lock:cleanup',
      expect.any(String),
      3_000,
    );

    resolveTask!('done');
    await expect(result).resolves.toEqual({ acquired: true, value: 'done' });
  });

  it('fails closed when a long-running task loses its lock', async () => {
    jest.useFakeTimers();
    redis.eval.mockResolvedValueOnce(0);
    let resolveTask: () => void;
    const task = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const result = service.runWithLock('cleanup', 3_000, task);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);
    resolveTask!();

    await expect(result).rejects.toMatchObject({ status: 503 });
  });

  it('fails closed when Redis coordination is unavailable', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.runWithLock('cleanup', 10_000, async () => undefined),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('keeps a successful window lease until its TTL expires', async () => {
    const task = jest.fn().mockResolvedValue('snapshot');

    await expect(
      service.runOncePerWindow('metrics', 15_000, task),
    ).resolves.toEqual({
      acquired: true,
      value: 'snapshot',
    });
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      'docmost:mcp:task-window:metrics',
      expect.any(String),
      'PX',
      15_000,
      'NX',
    );
  });

  it('releases a failed window lease so another replica can retry', async () => {
    const task = jest.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.runOncePerWindow('metrics', 15_000, task),
    ).rejects.toThrow('database unavailable');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      'docmost:mcp:task-window:metrics',
      expect.any(String),
    );
  });
});
