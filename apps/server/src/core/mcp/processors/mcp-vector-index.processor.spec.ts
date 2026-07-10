import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { McpVectorIndexProcessor } from './mcp-vector-index.processor';
import type { McpVectorIndexService } from '../services/mcp-vector-index.service';
import type { McpVectorQueueJobData } from '../types/vector.types';

describe('McpVectorIndexProcessor', () => {
  const vectorIndexService = {
    runQueuedJob: jest.fn(),
  };
  const processor = new McpVectorIndexProcessor(
    vectorIndexService as unknown as McpVectorIndexService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes the persisted index job referenced by BullMQ', async () => {
    vectorIndexService.runQueuedJob.mockResolvedValueOnce({
      status: 'succeeded',
    });
    const job = {
      name: 'mcp-vector-run-job',
      data: { indexJobId: 'index-job-1' },
    } as Job<McpVectorQueueJobData>;

    await expect(processor.process(job)).resolves.toEqual({
      status: 'succeeded',
    });
    expect(vectorIndexService.runQueuedJob).toHaveBeenCalledWith('index-job-1');
  });

  it('rejects unknown queue jobs', async () => {
    const job = {
      name: 'unknown',
      data: { indexJobId: 'index-job-1' },
    } as Job<McpVectorQueueJobData>;

    await expect(processor.process(job)).rejects.toThrow(
      'Unsupported MCP vector queue job',
    );
  });

  it('does not log BullMQ failure messages that may contain content', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const job = {
      id: 'queue-job-1',
      data: { indexJobId: 'index-job-1' },
      attemptsMade: 2,
      failedReason: 'secret-token and page content',
    } as Job<McpVectorQueueJobData>;

    processor.onFailed(job);

    expect(error).toHaveBeenCalledWith({
      jobId: 'index-job-1',
      queueJobId: 'queue-job-1',
      attemptsMade: 2,
      event: 'mcp.vector.job.failed',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
  });
});
