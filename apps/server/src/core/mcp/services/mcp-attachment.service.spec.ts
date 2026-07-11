import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AttachmentType } from '../../attachment/attachment.constants';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpAttachmentService } from './mcp-attachment.service';

describe('McpAttachmentService', () => {
  const actor = { id: 'user-1', workspaceId: 'workspace-1' };
  const page = {
    id: '11111111-1111-4111-8111-111111111111',
    slugId: 'page-slug',
    title: 'Page',
    icon: null,
    parentPageId: null,
    spaceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'workspace-1',
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    deletedAt: null,
  };
  const attachment = {
    id: '33333333-3333-4333-8333-333333333333',
    type: AttachmentType.File,
    filePath: `${page.workspaceId}/files/33333333-3333-4333-8333-333333333333/readme.txt`,
    fileName: 'readme.txt',
    fileSize: 5,
    fileExt: '.txt',
    mimeType: 'text/plain',
    creatorId: actor.id,
    workspaceId: page.workspaceId,
    pageId: page.id,
    spaceId: page.spaceId,
    aiChatId: null,
    textContent: 'hello',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    updatedAt: new Date('2026-07-11T00:00:00.000Z'),
    deletedAt: null,
  };
  const context = {
    client: {
      id: 'client-1',
      workspaceId: page.workspaceId,
      actorUserId: actor.id,
      status: 'active',
    },
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
  } as unknown as McpToolContext;

  const createHarness = () => {
    const attachmentService = {
      uploadBufferFile: jest.fn().mockResolvedValue(attachment),
      deleteFileAttachment: jest.fn().mockResolvedValue(undefined),
    };
    const attachmentRepo = {
      findPageFiles: jest.fn().mockResolvedValue([attachment]),
      findById: jest.fn().mockResolvedValue(attachment),
      findByIdWithContent: jest.fn().mockResolvedValue(attachment),
    };
    const storageService = {
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://storage.example/signed'),
      delete: jest.fn().mockResolvedValue(undefined),
      read: jest.fn().mockResolvedValue(Buffer.from('hello')),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
    };
    const permissionService = {
      assertSpacePermission: jest.fn().mockResolvedValue(undefined),
    };
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
      assertCanViewPage: jest.fn().mockResolvedValue(undefined),
      assertCanEditPage: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = {
      tryLog: jest.fn().mockResolvedValue(true),
    };
    const idempotencyService = {
      run: jest.fn(async (input) =>
        input.run({
          checkpoint: jest.fn().mockResolvedValue(undefined),
          checkpointResourceId: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    const service = new McpAttachmentService(
      attachmentService as never,
      attachmentRepo as never,
      storageService as never,
      pageRepo as never,
      permissionService as never,
      actorAccessService as never,
      auditService as never,
      idempotencyService as never,
    );
    return {
      service,
      attachmentService,
      attachmentRepo,
      storageService,
      pageRepo,
      permissionService,
      actorAccessService,
      auditService,
      idempotencyService,
    };
  };

  it('lists attachment metadata only after page read checks', async () => {
    const harness = createHarness();

    const result = await harness.service.listAttachments(
      { pageId: page.id, limit: 25, offset: 0 },
      context,
    );

    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenCalledWith(context.client, 'read', page.spaceId);
    expect(harness.actorAccessService.assertCanViewPage).toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({
        id: attachment.id,
        fileName: attachment.fileName,
        fileSize: 5,
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty('filePath');
  });

  it('returns a signed URL and optional extracted text without exposing paths', async () => {
    const harness = createHarness();

    const result = await harness.service.getAttachment(
      {
        attachmentId: attachment.id,
        expiresInSeconds: 600,
        includeExtractedText: true,
      },
      context,
    );

    expect(harness.storageService.getSignedUrl).toHaveBeenCalledWith(
      attachment.filePath,
      600,
    );
    expect(result).toEqual(
      expect.objectContaining({
        downloadUrl: 'https://storage.example/signed',
        extractedText: { text: 'hello', truncated: false },
        warnings: [],
      }),
    );
    expect(harness.auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.attachment.read',
        resourceId: attachment.id,
      }),
    );
  });

  it('clamps signed URL lifetime, truncates extracted text, and reports audit failure', async () => {
    const harness = createHarness();
    harness.attachmentRepo.findByIdWithContent.mockResolvedValue({
      ...attachment,
      textContent: 'x'.repeat(100_001),
    });
    harness.auditService.tryLog.mockResolvedValue(false);

    const result = await harness.service.getAttachment(
      {
        attachmentId: attachment.id,
        expiresInSeconds: 1,
        includeExtractedText: true,
      },
      context,
    );

    expect(harness.storageService.getSignedUrl).toHaveBeenCalledWith(
      attachment.filePath,
      60,
    );
    expect(result.extractedText).toEqual({
      text: 'x'.repeat(100_000),
      truncated: true,
    });
    expect(result.warnings).toContain(
      'MCP operation succeeded, but its audit log could not be persisted',
    );
  });

  it('fails closed for an attachment from another workspace', async () => {
    const harness = createHarness();
    harness.attachmentRepo.findByIdWithContent.mockResolvedValue({
      ...attachment,
      workspaceId: 'workspace-2',
    });

    await expect(
      harness.service.getAttachment(
        {
          attachmentId: attachment.id,
          expiresInSeconds: 600,
          includeExtractedText: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.storageService.getSignedUrl).not.toHaveBeenCalled();
  });

  it('uploads valid base64 through the attachment service with idempotency and audit', async () => {
    const harness = createHarness();
    const contentBase64 = Buffer.from('hello').toString('base64');

    const result = await harness.service.uploadAttachment(
      {
        pageId: page.id,
        fileName: attachment.fileName,
        contentBase64,
        idempotencyKey: 'upload-1',
      },
      context,
    );

    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenCalledWith(context.client, 'update', page.spaceId);
    expect(harness.attachmentService.uploadBufferFile).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from('hello'),
        fileName: attachment.fileName,
        pageId: page.id,
        userId: actor.id,
      }),
    );
    expect(harness.idempotencyService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upload_attachment',
        idempotencyKey: 'upload-1',
        resourceType: 'attachment',
      }),
    );
    expect(harness.auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp.attachment.upload' }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        attachment: expect.objectContaining({ id: attachment.id }),
        downloadUrl: 'https://storage.example/signed',
      }),
    );
  });

  it('rejects malformed and oversized base64 before writing storage', async () => {
    const harness = createHarness();

    await expect(
      harness.service.uploadAttachment(
        {
          pageId: page.id,
          fileName: 'bad.txt',
          contentBase64: 'not-base64',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      harness.service.uploadAttachment(
        {
          pageId: page.id,
          fileName: 'large.bin',
          contentBase64: Buffer.alloc(512 * 1024 + 1).toString('base64'),
        },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.attachmentService.uploadBufferFile).not.toHaveBeenCalled();
  });

  it('cleans an orphaned object before retrying upload reconciliation', async () => {
    const harness = createHarness();
    await harness.service.uploadAttachment(
      {
        pageId: page.id,
        fileName: attachment.fileName,
        contentBase64: Buffer.from('hello').toString('base64'),
        idempotencyKey: 'upload-reconcile',
      },
      context,
    );
    const input = harness.idempotencyService.run.mock.calls[0][0];
    harness.attachmentRepo.findById.mockResolvedValue(null);

    const result = await input.reconcile({
      resourceId: '44444444-4444-4444-8444-444444444444',
      targetState: input.targetState,
    });

    expect(harness.storageService.delete).toHaveBeenCalledWith(
      'workspace-1/files/44444444-4444-4444-8444-444444444444/readme.txt',
    );
    expect(result).toEqual({ outcome: 'retry' });
  });

  it('completes matching upload reconciliation and rejects conflicting metadata', async () => {
    const harness = createHarness();
    await harness.service.uploadAttachment(
      {
        pageId: page.id,
        fileName: attachment.fileName,
        contentBase64: Buffer.from('hello').toString('base64'),
        idempotencyKey: 'upload-completed',
      },
      context,
    );
    const input = harness.idempotencyService.run.mock.calls[0][0];

    await expect(
      input.reconcile({
        resourceId: attachment.id,
        targetState: input.targetState,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'completed',
        response: expect.objectContaining({
          attachment: expect.objectContaining({ id: attachment.id }),
        }),
      }),
    );

    harness.attachmentRepo.findById.mockResolvedValue({
      ...attachment,
      fileSize: 99,
    });
    await expect(
      input.reconcile({
        resourceId: attachment.id,
        targetState: input.targetState,
      }),
    ).resolves.toEqual({ outcome: 'repair_required' });
  });

  it('requires confirmation and deletes storage plus metadata through the service', async () => {
    const harness = createHarness();

    await expect(
      harness.service.deleteAttachment(
        { attachmentId: attachment.id, confirm: false },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const result = await harness.service.deleteAttachment(
      {
        attachmentId: attachment.id,
        idempotencyKey: 'delete-1',
        confirm: true,
      },
      context,
    );

    expect(harness.attachmentService.deleteFileAttachment).toHaveBeenCalledWith(
      attachment,
    );
    expect(harness.auditService.tryLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp.attachment.delete' }),
    );
    expect(result).toEqual({
      attachmentId: attachment.id,
      deleted: true,
      warnings: [],
    });
  });

  it('reconciles completed, retryable, and cross-workspace attachment deletion', async () => {
    const harness = createHarness();
    await harness.service.deleteAttachment(
      {
        attachmentId: attachment.id,
        idempotencyKey: 'delete-reconcile',
        confirm: true,
      },
      context,
    );
    const input = harness.idempotencyService.run.mock.calls[0][0];

    harness.attachmentRepo.findById.mockResolvedValue(null);
    await expect(
      input.reconcile({ resourceId: attachment.id }),
    ).resolves.toEqual({
      outcome: 'completed',
      response: {
        attachmentId: attachment.id,
        deleted: true,
        warnings: [],
      },
    });

    harness.attachmentRepo.findById.mockResolvedValue(attachment);
    await expect(
      input.reconcile({ resourceId: attachment.id }),
    ).resolves.toEqual({ outcome: 'retry' });

    harness.attachmentRepo.findById.mockResolvedValue({
      ...attachment,
      workspaceId: 'workspace-2',
    });
    await expect(
      input.reconcile({ resourceId: attachment.id }),
    ).resolves.toEqual({ outcome: 'repair_required' });
  });

  it('degrades safely when the storage driver cannot create signed URLs', async () => {
    const harness = createHarness();
    harness.storageService.getSignedUrl.mockRejectedValue(
      new Error('unsupported'),
    );

    const result = await harness.service.getAttachment(
      {
        attachmentId: attachment.id,
        expiresInSeconds: 900,
        includeExtractedText: false,
      },
      context,
    );

    expect(result.downloadUrl).toBeNull();
    expect(result.warnings).toContain(
      'Signed download URLs are unavailable for this storage driver',
    );
  });
});
