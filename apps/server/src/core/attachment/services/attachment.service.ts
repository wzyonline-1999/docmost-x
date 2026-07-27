import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { StorageService } from '../../../integrations/storage/storage.service';
import { MultipartFile } from '@fastify/multipart';
import {
  getAttachmentFolderPath,
  getAttachmentStorageFilePath,
  PreparedFile,
  prepareFile,
  validateFileType,
} from '../attachment.utils';
import { v4 as uuid4, v7 as uuid7 } from 'uuid';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import {
  AttachmentType,
  SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS,
  validImageExtensions,
} from '../attachment.constants';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Attachment, User, Workspace } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { createByteCountingStream } from '../../../common/helpers/utils';
import { getMimeType, sanitizeFileName } from '../../../common/helpers';
import * as path from 'path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);
  constructor(
    private readonly storageService: StorageService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async uploadFile(opts: {
    filePromise: Promise<MultipartFile>;
    pageId?: string;
    userId: string;
    spaceId: string;
    workspaceId: string;
    attachmentId?: string;
  }) {
    const { filePromise, pageId, spaceId, userId, workspaceId } = opts;
    const preparedFile: PreparedFile = await prepareFile(filePromise, {
      skipBuffer: true,
    });

    let isUpdate = false;
    let attachmentId = null;
    let existingFilePath: string | null = null;

    // passing attachmentId to allow for updating diagrams
    // instead of creating new files for each save
    if (opts?.attachmentId) {
      const existingAttachment = await this.attachmentRepo.findById(
        opts.attachmentId,
      );
      if (!existingAttachment) {
        throw new NotFoundException(
          'Existing attachment to overwrite not found',
        );
      }

      if (
        existingAttachment.pageId !== pageId ||
        existingAttachment.fileExt !== preparedFile.fileExtension ||
        existingAttachment.workspaceId !== workspaceId
      ) {
        throw new BadRequestException('File attachment does not match');
      }
      attachmentId = opts.attachmentId;
      existingFilePath = existingAttachment.filePath;
      isUpdate = true;
    } else {
      attachmentId = uuid7();
    }

    const filePath =
      existingFilePath ??
      getAttachmentStorageFilePath(
        workspaceId,
        attachmentId,
        preparedFile.fileExtension,
      );

    const { stream, getBytesRead } = createByteCountingStream(
      preparedFile.multiPartFile.file,
    );

    await this.uploadToDrive(filePath, stream);

    // Update fileSize from the consumed stream
    preparedFile.fileSize = getBytesRead();

    let attachment: Attachment = null;
    try {
      if (isUpdate) {
        attachment = await this.attachmentRepo.updateAttachment(
          {
            fileSize: preparedFile.fileSize,
            textContent: null,
            contentIndexStatus: 'pending',
            contentIndexAttemptCount: 0,
            contentIndexError: null,
            contentIndexedAt: null,
            contentIndexLeaseOwner: null,
            contentIndexLeaseExpiresAt: null,
            updatedAt: new Date(),
          },
          attachmentId,
        );
      } else {
        attachment = await this.saveAttachment({
          attachmentId,
          preparedFile,
          filePath,
          type: AttachmentType.File,
          userId,
          spaceId,
          workspaceId,
          pageId,
        });
      }
    } catch (err) {
      if (!isUpdate) {
        await this.storageService
          .delete(filePath)
          .catch((cleanupError) =>
            this.logger.error(
              'Failed to clean up attachment upload',
              cleanupError,
            ),
          );
      }
      throw err;
    }

    if (isUpdate && attachment.pageId && attachment.workspaceId) {
      this.eventEmitter.emit(EventName.ATTACHMENT_CONTENT_UPDATED, {
        attachmentId: attachment.id,
        pageIds: [attachment.pageId],
        workspaceId: attachment.workspaceId,
      });
    }

    await this.queueContentIndex(attachment).catch((err) =>
      this.logger.warn(
        `Failed to queue attachment content indexing for ${attachment.id}: ${err.message}`,
      ),
    );

    return attachment;
  }

  async uploadBufferFile(opts: {
    buffer: Buffer;
    fileName: string;
    pageId: string;
    userId: string;
    spaceId: string;
    workspaceId: string;
    attachmentId?: string;
  }): Promise<Attachment> {
    if (!opts.buffer.length) {
      throw new BadRequestException('Attachment content is empty');
    }

    const fileName = sanitizeFileName(opts.fileName).slice(0, 255);
    const fileExtension = path.extname(fileName).toLowerCase();
    if (!fileName || !fileExtension) {
      throw new BadRequestException('Attachment file name is invalid');
    }

    const attachmentId = opts.attachmentId ?? uuid7();
    const filePath = getAttachmentStorageFilePath(
      opts.workspaceId,
      attachmentId,
      fileExtension,
    );
    const preparedFile: PreparedFile = {
      buffer: opts.buffer,
      fileName,
      fileSize: opts.buffer.length,
      fileExtension,
      mimeType: getMimeType(fileName),
    };

    await this.uploadToDrive(filePath, opts.buffer);

    let attachment: Attachment;
    try {
      attachment = await this.saveAttachment({
        attachmentId,
        preparedFile,
        filePath,
        type: AttachmentType.File,
        userId: opts.userId,
        spaceId: opts.spaceId,
        workspaceId: opts.workspaceId,
        pageId: opts.pageId,
      });
    } catch (err) {
      await this.storageService
        .delete(filePath)
        .catch((cleanupError) =>
          this.logger.error(
            'Failed to clean up MCP attachment upload',
            cleanupError,
          ),
        );
      throw err;
    }

    await this.queueContentIndex(attachment).catch((err) =>
      this.logger.warn(
        `Failed to queue attachment content indexing for ${attachment.id}: ${err.message}`,
      ),
    );
    return attachment;
  }

  async deleteFileAttachment(attachment: Attachment): Promise<void> {
    if (attachment.type !== AttachmentType.File) {
      throw new BadRequestException('Attachment is not a page file');
    }
    await this.beginAttachmentDeletion(attachment);
  }

  async resumeFileDeletion(attachmentId: string): Promise<void> {
    let attachment = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .executeTakeFirst();
    if (!attachment) {
      return;
    }

    if (attachment.deletionStatus === 'failed') {
      attachment = await this.db
        .updateTable('attachments')
        .set({
          deletionStatus: 'deleting',
          deletionAttemptCount: (eb) => eb('deletionAttemptCount', '+', 1),
          deletionError: null,
          deletionStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', attachment.id)
        .where('deletionStatus', '=', 'failed')
        .returningAll()
        .executeTakeFirst();
      if (!attachment) {
        return;
      }
    }

    if (attachment.deletionStatus === 'deleting') {
      try {
        if (await this.storageService.exists(attachment.filePath)) {
          await this.storageService.delete(attachment.filePath);
        }
        const storageDeleted = await this.db
          .updateTable('attachments')
          .set({
            deletionStatus: 'storage_deleted',
            deletionError: null,
            updatedAt: new Date(),
          })
          .where('id', '=', attachment.id)
          .where('deletionStatus', '=', 'deleting')
          .returningAll()
          .executeTakeFirst();
        if (storageDeleted) {
          attachment = storageDeleted;
        }
      } catch (err) {
        await this.db
          .updateTable('attachments')
          .set({
            deletionStatus: 'failed',
            deletionError: (err instanceof Error
              ? err.message
              : String(err)
            ).slice(0, 2000),
            updatedAt: new Date(),
          })
          .where('id', '=', attachment.id)
          .where('deletionStatus', '=', 'deleting')
          .execute();
        throw err;
      }
    }

    if (attachment.deletionStatus !== 'storage_deleted') {
      return;
    }

    await this.attachmentRepo.deleteAttachmentById(attachment.id);
    if (attachment.pageId && attachment.workspaceId) {
      this.eventEmitter.emit(EventName.ATTACHMENT_CONTENT_UPDATED, {
        attachmentId: attachment.id,
        pageIds: [attachment.pageId],
        workspaceId: attachment.workspaceId,
      });
    }
  }

  private async queueContentIndex(attachment: Attachment): Promise<void> {
    if (
      !SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS.has(
        attachment.fileExt.toLowerCase(),
      )
    ) {
      await this.db
        .updateTable('attachments')
        .set({
          contentIndexStatus: 'skipped',
          contentIndexError: null,
          contentIndexLeaseOwner: null,
          contentIndexLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where('id', '=', attachment.id)
        .execute();
      return;
    }
    await this.attachmentQueue.add(
      QueueJob.ATTACHMENT_INDEX_CONTENT,
      { attachmentId: attachment.id },
      {
        jobId: `attachment-content-${attachment.id}-${(attachment.contentIndexAttemptCount ?? 0) + 1}`,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
      },
    );
  }

  private async beginAttachmentDeletion(attachment: Attachment): Promise<void> {
    const claimed = await this.db
      .updateTable('attachments')
      .set({
        deletedAt: attachment.deletedAt ?? new Date(),
        deletionStatus: 'deleting',
        deletionAttemptCount: (eb) => eb('deletionAttemptCount', '+', 1),
        deletionError: null,
        deletionStartedAt: new Date(),
        contentIndexLeaseOwner: null,
        contentIndexLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', attachment.id)
      .where('deletionStatus', 'in', ['active', 'failed'])
      .returning(['id'])
      .executeTakeFirst();

    if (!claimed && attachment.deletionStatus === 'active') {
      return;
    }
    await this.resumeFileDeletion(attachment.id);
  }

  async uploadImage(
    filePromise: Promise<MultipartFile>,
    type:
      | AttachmentType.Avatar
      | AttachmentType.WorkspaceIcon
      | AttachmentType.SpaceIcon,
    userId: string,
    workspaceId: string,
    spaceId?: string,
  ) {
    const preparedFile: PreparedFile = await prepareFile(filePromise);
    validateFileType(preparedFile.fileExtension, validImageExtensions);

    preparedFile.fileName = uuid4() + preparedFile.fileExtension;

    const filePath = `${getAttachmentFolderPath(type, workspaceId)}/${preparedFile.fileName}`;

    await this.uploadToDrive(filePath, preparedFile.buffer);

    let attachment: Attachment = null;
    let oldFileName: string = null;

    try {
      await executeTx(this.db, async (trx) => {
        attachment = await this.saveAttachment({
          preparedFile,
          filePath,
          type,
          userId,
          workspaceId,
          trx,
        });

        if (type === AttachmentType.Avatar) {
          const user = await this.userRepo.findById(userId, workspaceId, {
            trx,
          });

          oldFileName = user.avatarUrl;

          await this.userRepo.updateUser(
            { avatarUrl: preparedFile.fileName },
            userId,
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.WorkspaceIcon) {
          const workspace = await this.workspaceRepo.findById(workspaceId, {
            trx,
          });

          oldFileName = workspace.logo;

          await this.workspaceRepo.updateWorkspace(
            { logo: preparedFile.fileName },
            workspaceId,
            trx,
          );
        } else if (type === AttachmentType.SpaceIcon && spaceId) {
          const space = await this.spaceRepo.findById(spaceId, workspaceId, {
            trx,
          });

          oldFileName = space.logo;

          await this.spaceRepo.updateSpace(
            { logo: preparedFile.fileName },
            spaceId,
            workspaceId,
            trx,
          );
        } else {
          throw new BadRequestException(`Image upload aborted.`);
        }
      });
    } catch (err) {
      // delete uploaded file on db update failure
      await this.deleteRedundantFile(filePath);
      throw new BadRequestException('Failed to upload image');
    }

    if (oldFileName && !oldFileName.toLowerCase().startsWith('http')) {
      // delete old avatar or logo
      const oldFilePath =
        getAttachmentFolderPath(type, workspaceId) + '/' + oldFileName;
      await this.deleteRedundantFile(oldFilePath);
    }

    return attachment;
  }

  async deleteRedundantFile(filePath: string) {
    try {
      await this.storageService.delete(filePath);
      await this.attachmentRepo.deleteAttachmentByFilePath(filePath);
    } catch (error) {
      this.logger.error('deleteRedundantFile', error);
    }
  }

  async uploadToDrive(filePath: string, fileContent: Buffer | Readable) {
    try {
      await this.storageService.upload(filePath, fileContent);
    } catch (err) {
      this.logger.error('Error uploading file to drive:', err);
      throw new BadRequestException('Error uploading file to drive');
    }
  }

  async saveAttachment(opts: {
    attachmentId?: string;
    preparedFile: PreparedFile;
    filePath: string;
    type: AttachmentType;
    userId: string;
    workspaceId: string;
    pageId?: string;
    spaceId?: string;
    trx?: KyselyTransaction;
  }): Promise<Attachment> {
    const {
      attachmentId,
      preparedFile,
      filePath,
      type,
      userId,
      workspaceId,
      pageId,
      spaceId,
      trx,
    } = opts;
    return this.attachmentRepo.insertAttachment(
      {
        id: attachmentId,
        type: type,
        filePath: filePath,
        fileName: preparedFile.fileName,
        fileSize: preparedFile.fileSize,
        mimeType: preparedFile.mimeType,
        fileExt: preparedFile.fileExtension,
        creatorId: userId,
        workspaceId: workspaceId,
        pageId: pageId,
        spaceId: spaceId,
      },
      trx,
    );
  }

  async handleDeleteAiChatAttachments(aiChatId: string) {
    try {
      const attachments = await this.attachmentRepo.findByAiChatId(aiChatId);
      if (!attachments || attachments.length === 0) {
        return;
      }

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            await this.beginAttachmentDeletion(attachment);
          } catch (err) {
            this.logger.log(
              `DeleteAiChatAttachments: failed to delete attachment ${attachment.id}:`,
              err,
            );
          }
        }),
      );
    } catch (err) {
      throw err;
    }
  }

  async handleDeleteSpaceAttachments(spaceId: string) {
    try {
      const attachments = await this.attachmentRepo.findBySpaceId(spaceId);
      if (!attachments || attachments.length === 0) {
        return;
      }

      const failedDeletions = [];

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            await this.beginAttachmentDeletion(attachment);
          } catch (err) {
            failedDeletions.push(attachment.id);
            this.logger.log(
              `DeleteSpaceAttachments: failed to delete attachment ${attachment.id}:`,
              err,
            );
          }
        }),
      );

      if (failedDeletions.length === attachments.length) {
        throw new Error(
          `Failed to delete any attachments for spaceId: ${spaceId}`,
        );
      }
    } catch (err) {
      throw err;
    }
  }

  async handleDeleteUserAvatars(userId: string) {
    try {
      const userAvatars = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('creatorId', '=', userId)
        .where('type', '=', AttachmentType.Avatar)
        .execute();

      if (!userAvatars || userAvatars.length === 0) {
        return;
      }

      await Promise.all(
        userAvatars.map(async (attachment) => {
          try {
            await this.beginAttachmentDeletion(attachment);
          } catch (err) {
            this.logger.log(
              `DeleteUserAvatar: failed to delete user avatar ${attachment.id}:`,
              err,
            );
          }
        }),
      );
    } catch (err) {
      throw err;
    }
  }

  async handleDeletePageAttachments(pageId: string) {
    try {
      // Fetch attachments for this page from database
      const attachments = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('pageId', '=', pageId)
        .execute();

      if (!attachments || attachments.length === 0) {
        return;
      }

      const failedDeletions = [];

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            await this.beginAttachmentDeletion(attachment);
          } catch (err) {
            failedDeletions.push(attachment.id);
            this.logger.error(
              `Failed to delete attachment ${attachment.id} for page ${pageId}:`,
              err,
            );
          }
        }),
      );

      if (failedDeletions.length > 0) {
        this.logger.warn(
          `Failed to delete ${failedDeletions.length} attachments for page ${pageId}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Error in handleDeletePageAttachments for page ${pageId}:`,
        err,
      );
      throw err;
    }
  }

  async removeUserAvatar(user: User) {
    if (user.avatarUrl && !user.avatarUrl.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.Avatar, user.workspaceId)}/${user.avatarUrl}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.userRepo.updateUser(
      { avatarUrl: null },
      user.id,
      user.workspaceId,
    );
  }

  async removeSpaceIcon(spaceId: string, workspaceId: string) {
    const space = await this.spaceRepo.findById(spaceId, workspaceId);

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    if (space.logo && !space.logo.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.SpaceIcon, workspaceId)}/${space.logo}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.spaceRepo.updateSpace({ logo: null }, spaceId, workspaceId);
  }

  async removeWorkspaceIcon(workspace: Workspace) {
    if (workspace.logo && !workspace.logo.toLowerCase().startsWith('http')) {
      const filePath = `${getAttachmentFolderPath(AttachmentType.WorkspaceIcon, workspace.id)}/${workspace.logo}`;
      await this.deleteRedundantFile(filePath);
    }

    await this.workspaceRepo.updateWorkspace({ logo: null }, workspace.id);
  }
}
