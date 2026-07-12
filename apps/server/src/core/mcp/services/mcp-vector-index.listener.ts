import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUTO_INDEX_DELAY_MS,
  McpVectorIndexService,
} from './mcp-vector-index.service';
import { getMcpErrorType } from '../utils/mcp-error.util';

type PageEvent = {
  pageIds: string[];
  workspaceId?: string | null;
};

@Injectable()
export class McpVectorIndexListener {
  private readonly logger = new Logger(McpVectorIndexListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly vectorIndexService: McpVectorIndexService,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  handlePageCreated(event: PageEvent): void {
    this.schedulePageJobs(event, 'page');
  }

  @OnEvent(EventName.PAGE_UPDATED)
  handlePageUpdated(event: PageEvent): void {
    this.schedulePageJobs(event, 'page');
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  handlePageSoftDeleted(event: PageEvent): void {
    this.schedulePageJobs(event, 'delete');
  }

  @OnEvent(EventName.PAGE_RESTORED)
  handlePageRestored(event: PageEvent): void {
    this.schedulePageJobs(event, 'restore');
  }

  @OnEvent(EventName.ATTACHMENT_CONTENT_UPDATED)
  handleAttachmentContentUpdated(event: PageEvent): void {
    this.schedulePageJobs(event, 'page');
  }

  private schedulePageJobs(
    event: PageEvent,
    jobType: 'page' | 'delete' | 'restore',
  ): void {
    if (!this.environmentService.isVectorSearchEnabled()) {
      return;
    }

    if (!event.pageIds?.length) {
      return;
    }

    this.vectorIndexService
      .enqueuePageIds({
        pageIds: event.pageIds,
        workspaceId: event.workspaceId ?? null,
        jobType,
        delayMs: AUTO_INDEX_DELAY_MS,
      })
      .catch((err) =>
        this.logger.warn({
          event: 'mcp.vector.enqueue_failed',
          jobType,
          errorType: getMcpErrorType(err),
        }),
      );
  }
}
