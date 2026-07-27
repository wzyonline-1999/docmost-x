import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS } from '../attachment.constants';
import { AttachmentService } from './attachment.service';

const ATTACHMENT_RECOVERY_INTERVAL_MS = 60 * 1000;
const ATTACHMENT_RECOVERY_BATCH_SIZE = 100;
const ATTACHMENT_DELETION_STALE_MS = 5 * 60 * 1000;

@Injectable()
export class AttachmentLifecycleService {
  private readonly logger = new Logger(AttachmentLifecycleService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE)
    private readonly attachmentQueue: Queue,
    private readonly attachmentService: AttachmentService,
  ) {}

  @Interval(ATTACHMENT_RECOVERY_INTERVAL_MS)
  async recoverPendingWork(): Promise<{
    skippedUnsupported: number;
    queuedIndexing: number;
    resumedDeletions: number;
  }> {
    const skippedUnsupported = await this.skipUnsupportedPendingAttachments();
    const queuedIndexing = await this.requeuePendingContentIndexing();
    const resumedDeletions = await this.resumeInterruptedDeletions();
    return { skippedUnsupported, queuedIndexing, resumedDeletions };
  }

  private async skipUnsupportedPendingAttachments(): Promise<number> {
    const supported = [...SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS];
    const rows = await this.db
      .updateTable('attachments')
      .set({
        contentIndexStatus: 'skipped',
        contentIndexError: null,
        contentIndexLeaseOwner: null,
        contentIndexLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('deletedAt', 'is', null)
      .where('deletionStatus', '=', 'active')
      .where('contentIndexStatus', 'in', ['pending', 'failed'])
      .where('fileExt', 'not in', supported)
      .returning(['id'])
      .execute();
    return rows.length;
  }

  private async requeuePendingContentIndexing(): Promise<number> {
    const now = new Date();
    const candidates = await this.db
      .selectFrom('attachments')
      .select(['id', 'contentIndexAttemptCount', 'updatedAt'])
      .where('deletedAt', 'is', null)
      .where('deletionStatus', '=', 'active')
      .where('fileExt', 'in', [...SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS])
      .where((eb) =>
        eb.or([
          eb('contentIndexStatus', 'in', ['pending', 'failed']),
          eb.and([
            eb('contentIndexStatus', '=', 'indexing'),
            eb('contentIndexLeaseExpiresAt', '<=', now),
          ]),
        ]),
      )
      .orderBy('updatedAt', 'asc')
      .limit(ATTACHMENT_RECOVERY_BATCH_SIZE)
      .execute();

    let queued = 0;
    for (const attachment of candidates) {
      try {
        await this.attachmentQueue.add(
          QueueJob.ATTACHMENT_INDEX_CONTENT,
          { attachmentId: attachment.id },
          {
            jobId: `attachment-content-${attachment.id}-${attachment.contentIndexAttemptCount + 1}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
          },
        );
        queued += 1;
      } catch (err) {
        this.logger.warn(
          `Failed to recover content indexing for attachment ${attachment.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return queued;
  }

  private async resumeInterruptedDeletions(): Promise<number> {
    const staleBefore = new Date(Date.now() - ATTACHMENT_DELETION_STALE_MS);
    const candidates = await this.db
      .selectFrom('attachments')
      .select(['id'])
      .where((eb) =>
        eb.or([
          eb('deletionStatus', 'in', ['storage_deleted', 'failed']),
          eb.and([
            eb('deletionStatus', '=', 'deleting'),
            eb('deletionStartedAt', '<=', staleBefore),
          ]),
        ]),
      )
      .orderBy('updatedAt', 'asc')
      .limit(ATTACHMENT_RECOVERY_BATCH_SIZE)
      .execute();

    let resumed = 0;
    for (const attachment of candidates) {
      try {
        await this.attachmentService.resumeFileDeletion(attachment.id);
        resumed += 1;
      } catch (err) {
        this.logger.warn(
          `Failed to recover deletion for attachment ${attachment.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return resumed;
  }
}
