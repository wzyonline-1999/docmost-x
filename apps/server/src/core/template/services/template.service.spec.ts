jest.mock('../../../collaboration/collaboration.util', () => ({
  jsonToHtml: (content: unknown) => `html:${JSON.stringify(content)}`,
  jsonToMarkdown: (content: unknown) => `markdown:${JSON.stringify(content)}`,
  jsonToText: (content: unknown) => JSON.stringify(content),
}));

jest.mock('../../../common/helpers/prosemirror/utils', () => ({
  createYdocFromJson: () => Buffer.from('ydoc'),
}));

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (value: string) => value.toLowerCase().replace(/\s+/g, '-'),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TemplateService } from './template.service';

describe('TemplateService', () => {
  const workspace = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    settings: {},
  };
  const actor = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId: workspace.id,
    role: 'admin',
  };
  const template = {
    id: '11111111-1111-4111-8111-111111111111',
    key: 'project-brief',
    title: 'Project brief',
    description: 'A reusable brief',
    purpose: 'Create project briefs',
    useWhen: 'At project kickoff',
    tags: ['project'],
    inputSchema: {
      type: 'object',
      properties: { projectName: { type: 'string' } },
      required: ['projectName'],
      additionalProperties: false,
    },
    titleTemplate: '{{projectName}} brief',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '{{projectName}}' }],
        },
      ],
    },
    textContent: '{{projectName}}',
    ydoc: Buffer.from('draft'),
    icon: null,
    spaceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: workspace.id,
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    status: 'published',
    draftRevision: 2,
    currentVersion: 1,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    publishedById: actor.id,
    sourcePageId: null,
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
  };
  const version = {
    id: '33333333-3333-4333-8333-333333333333',
    templateId: template.id,
    workspaceId: workspace.id,
    spaceId: template.spaceId,
    version: 1,
    key: template.key,
    title: template.title,
    description: template.description,
    purpose: template.purpose,
    useWhen: template.useWhen,
    tags: template.tags,
    inputSchema: template.inputSchema,
    titleTemplate: template.titleTemplate,
    content: template.content,
    textContent: template.textContent,
    icon: null,
    contentHash: 'hash-v1',
    createdById: actor.id,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  const page = {
    id: '44444444-4444-4444-8444-444444444444',
    slugId: 'created-page',
    title: 'Atlas brief',
    icon: null,
    parentPageId: null,
    spaceId: template.spaceId,
    workspaceId: workspace.id,
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    deletedAt: null,
  };

  const createHarness = () => {
    const transaction = { id: 'trx' };
    const db = {
      transaction: jest.fn(() => ({
        execute: jest.fn((callback) => callback(transaction)),
      })),
    };
    const pageRepo = { findById: jest.fn() };
    const pageService = {
      create: jest.fn().mockResolvedValue(page),
      prepareProsemirrorContent: jest.fn(),
    };
    const spaceMemberRepo = { getUserSpaceIds: jest.fn() };
    const templateAccess = {
      assertCanRead: jest.fn().mockResolvedValue(undefined),
      assertCanManage: jest.fn().mockResolvedValue(undefined),
      assertCanCreatePageAt: jest.fn().mockResolvedValue(undefined),
      assertCanReadSourcePage: jest.fn().mockResolvedValue(undefined),
    };
    const templateRenderer = {
      normalizeInputSchema: jest.fn((value) => value),
      validateDraft: jest.fn().mockResolvedValue({
        schema: template.inputSchema,
        warnings: [],
      }),
      render: jest.fn().mockResolvedValue({
        templateId: template.id,
        version: 1,
        title: page.title,
        icon: null,
        content: template.content,
        variables: { projectName: 'Atlas' },
        warnings: [],
      }),
    };
    const templateRepo = {
      findById: jest.fn().mockResolvedValue(template),
      findByKey: jest.fn(),
      findVersion: jest.fn().mockResolvedValue(version),
      insertInstance: jest.fn().mockResolvedValue({ id: 'instance-1' }),
      insertVersion: jest.fn(),
      updateTemplate: jest.fn(),
    };
    const workspaceRepo = { findById: jest.fn().mockResolvedValue(workspace) };
    const service = new TemplateService(
      db as never,
      pageRepo as never,
      pageService as never,
      spaceMemberRepo as never,
      templateAccess as never,
      templateRenderer as never,
      templateRepo as never,
      workspaceRepo as never,
    );

    return {
      service,
      db,
      transaction,
      pageRepo,
      pageService,
      templateAccess,
      templateRenderer,
      templateRepo,
    };
  };

  it('returns an immutable published snapshot in the requested format', async () => {
    const harness = createHarness();
    const result = await harness.service.getPublishedForUser(
      actor as never,
      workspace.id,
      { templateId: template.id, format: 'markdown' },
    );

    expect(harness.templateRepo.findVersion).toHaveBeenCalledWith(
      template.id,
      workspace.id,
      undefined,
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: template.id,
        version: 1,
        format: 'markdown',
        content: expect.stringContaining('markdown:'),
      }),
    );
  });

  it('does not expose archived templates through published AI workflows', async () => {
    const harness = createHarness();
    harness.templateRepo.findById.mockResolvedValue({
      ...template,
      status: 'archived',
    });

    await expect(
      harness.service.getPublishedForUser(actor as never, workspace.id, {
        templateId: template.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.templateRepo.findVersion).not.toHaveBeenCalled();
  });

  it('creates the page and source record atomically before checkpointing', async () => {
    const harness = createHarness();
    const checkpoint = jest.fn().mockResolvedValue(undefined);

    const result = await harness.service.instantiateForUser(
      actor as never,
      workspace.id,
      {
        templateId: template.id,
        targetSpaceId: template.spaceId,
        variables: { projectName: 'Atlas' },
      },
      { clientId: 'client-1', requestId: 'request-1', checkpoint },
    );

    expect(harness.pageService.create).toHaveBeenCalledWith(
      actor.id,
      workspace.id,
      expect.objectContaining({
        title: page.title,
        content: template.content,
        format: 'json',
      }),
      harness.transaction,
    );
    expect(harness.templateRepo.insertInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: template.id,
        templateVersionId: version.id,
        pageId: page.id,
        clientId: 'client-1',
      }),
      harness.transaction,
    );
    expect(checkpoint).toHaveBeenCalledWith(page.id);
    expect(result.template).toEqual({
      id: template.id,
      key: template.key,
      version: 1,
    });
  });

  it('publishes a copied immutable snapshot and advances the version', async () => {
    const harness = createHarness();
    const nextVersion = { ...version, version: 2, id: 'version-2' };
    harness.templateRepo.insertVersion.mockResolvedValue(nextVersion);
    harness.templateRepo.updateTemplate.mockResolvedValue({
      ...template,
      currentVersion: 2,
    });

    const result = await harness.service.publishForUser(
      actor as never,
      workspace as never,
      template.id,
      template.updatedAt.toISOString(),
    );

    expect(harness.templateRepo.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: template.id,
        version: 2,
        content: template.content,
        inputSchema: template.inputSchema,
      }),
      harness.transaction,
    );
    expect(harness.templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', currentVersion: 2 }),
      template.id,
      workspace.id,
      { trx: harness.transaction },
    );
    expect(result.version.version).toBe(2);
  });

  it('moves a published template back to draft when its editable fields change', async () => {
    const harness = createHarness();
    const updatedAt = new Date('2026-08-02T01:00:00.000Z');
    harness.templateRepo.updateTemplate.mockResolvedValue({
      ...template,
      title: 'Updated project brief',
      status: 'draft',
      draftRevision: 3,
      updatedAt,
    });

    const result = await harness.service.updateForUser(
      actor as never,
      workspace as never,
      {
        templateId: template.id,
        expectedUpdatedAt: template.updatedAt.toISOString(),
        title: 'Updated project brief',
      },
    );

    expect(harness.templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Updated project brief',
        status: 'draft',
        draftRevision: 3,
        content: template.content,
      }),
      template.id,
      workspace.id,
      { expectedUpdatedAt: template.updatedAt },
    );
    expect(result.template).toEqual(
      expect.objectContaining({
        status: 'draft',
        content: template.content,
        updatedAt,
      }),
    );
  });

  it('rejects an update that does not change any draft field', async () => {
    const harness = createHarness();

    await expect(
      harness.service.updateForUser(actor as never, workspace as never, {
        templateId: template.id,
        expectedUpdatedAt: template.updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.templateRepo.updateTemplate).not.toHaveBeenCalled();
  });

  it('keeps template content in the archive response for safe editing', async () => {
    const harness = createHarness();
    harness.templateRepo.updateTemplate.mockResolvedValue({
      ...template,
      status: 'archived',
    });

    const result = await harness.service.archiveForUser(
      actor as never,
      workspace as never,
      template.id,
      template.updatedAt.toISOString(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: 'archived',
        content: template.content,
      }),
    );
  });
});
