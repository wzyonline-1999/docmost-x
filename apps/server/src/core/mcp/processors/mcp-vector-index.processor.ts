import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import type { McpVectorQueueJobData } from '../types/vector.types';
import { McpVectorIndexService } from '../services/mcp-vector-index.service';

@Processor(QueueName.MCP_VECTOR_QUEUE, { concurrency: 2 })
export class McpVectorIndexProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(McpVectorIndexProcessor.name);

  constructor(private readonly vectorIndexService: McpVectorIndexService) {
    super();
  }

  async process(job: Job<McpVectorQueueJobData>): Promise<unknown> {
    if (job.name !== QueueJob.MCP_VECTOR_RUN_JOB) {
      throw new Error(`Unsupported MCP vector queue job: ${job.name}`);
    }

    return this.vectorIndexService.runQueuedJob(job.data.indexJobId);
  }

  @OnWorkerEvent('active')
  onActive(job: Job<McpVectorQueueJobData>): void {
    this.logger.debug({
      jobId: job.data.indexJobId,
      queueJobId: job.id,
      attempt: job.attemptsMade + 1,
      event: 'mcp.vector.job.active',
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<McpVectorQueueJobData>): void {
    this.logger.error({
      jobId: job.data?.indexJobId ?? 'unknown',
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      event: 'mcp.vector.job.failed',
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<McpVectorQueueJobData>): void {
    this.logger.debug({
      jobId: job.data.indexJobId,
      queueJobId: job.id,
      event: 'mcp.vector.job.completed',
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
