jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (value: string) => value.toLowerCase().replace(/\s+/g, '-'),
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { McpToolContext } from '../types/mcp-tool.types';
import { McpTemplateService } from './mcp-template.service';

describe('McpTemplateService', () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const templateSpaceId = '22222222-2222-4222-8222-222222222222';
  const targetSpaceId = '33333333-3333-4333-8333-333333333333';
  const templateId = '11111111-1111-4111-8111-111111111111';
  const actor = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId,
    role: 'member',
  };
  const context = {
    client: {
      id: 'client-1',
      workspaceId,
      actorUserId: actor.id,
      status: 'active',
    },
    requestId: 'request-1',
    ipAddress: '127.0.0.1',
  } as unknown as McpToolContext;
  const template = {
    id: templateId,
    key: 'project-brief',
    title: 'Project brief',
    purpose: 'Create project briefs',
    spaceId: templateSpaceId,
    workspaceId,
    status: 'published',
    currentVersion: 2,
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    deletedAt: null,
  };
  const version = {
    id: '44444444-4444-4444-8444-444444444444',
    templateId,
    workspaceId,
    version: 2,
    key: template.key,
  };
  const page = {
    id: '55555555-5555-4555-8555-555555555555',
    slugId: 'atlas-brief',
    title: 'Atlas brief',
    icon: null,
    parentPageId: null,
    spaceId: targetSpaceId,
    workspaceId,
    creatorId: actor.id,
    lastUpdatedById: actor.id,
    createdAt: new Date('2026-08-02T01:00:00.000Z'),
    updatedAt: new Date('2026-08-02T01:00:00.000Z'),
    deletedAt: null,
  };

  const createHarness = () => {
    const db = {};
    const actorAccessService = {
      requireActor: jest.fn().mockResolvedValue(actor),
    };
    const auditService = { tryLog: jest.fn().mockResolvedValue(true) };
    const environmentService = {
      isVectorSearchEnabled: jest.fn(() => false),
    };
    const checkpoint = jest.fn().mockResolvedValue(undefined);
    const idempotencyService = {
      run: jest.fn(async (input) =>
        input.run({
          checkpoint,
          checkpointResourceId: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };
    const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
    const permissionService = {
      getAllowedSpaceIds: jest.fn().mockResolvedValue([templateSpaceId]),
      assertSpacePermission: jest.fn().mockResolvedValue(undefined),
      assertPagePermission: jest.fn().mockResolvedValue(undefined),
    };
    const templateAccess = {
      assertWorkspaceAdmin: jest.fn((user) => {
        if (user.role === 'member') throw new ForbiddenException();
      }),
    };
    const templateRepo = {
      findVersion: jest.fn().mockResolvedValue(version),
      findById: jest.fn().mockResolvedValue(template),
      findInstanceByPageId: jest.fn(),
    };
    const templateService = {
      listForUser: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      requireTemplateByReference: jest.fn().mockResolvedValue(template),
      getPublishedForUser: jest.fn().mockResolvedValue({
        id: template.id,
        key: template.key,
        version: 2,
      }),
      renderForUser: jest.fn(),
      instantiateForUser: jest.fn(async (_user, _workspace, _dto, options) => {
        await options.checkpoint(page.id);
        return {
          page,
          template: { id: template.id, key: template.key, version: 2 },
          warnings: [],
        };
      }),
      getWorkspace: jest.fn().mockResolvedValue({ id: workspaceId }),
      createForUser: jest.fn(),
      updateForUser: jest.fn(),
      publishForUser: jest.fn(),
      archiveForUser: jest.fn(),
      deleteForUser: jest.fn(),
      getDraftForUser: jest.fn(),
    };
    const vectorIndexService = { indexPage: jest.fn() };
    const service = new McpTemplateService(
      db as never,
      actorAccessService as never,
      auditService as never,
      environmentService as never,
      idempotencyService as never,
      pageRepo as never,
      permissionService as never,
      templateAccess as never,
      templateRepo as never,
      templateService as never,
      vectorIndexService as never,
    );

    return {
      service,
      actorAccessService,
      auditService,
      checkpoint,
      idempotencyService,
      permissionService,
      templateAccess,
      templateRepo,
      templateService,
      vectorIndexService,
    };
  };

  it('registers the complete AI template workflow', () => {
    const names = createHarness()
      .service.listTools()
      .map((tool) => tool.name);
    expect(names).toEqual([
      'list_templates',
      'get_template',
      'render_template',
      'instantiate_template',
      'create_template',
      'update_template',
      'publish_template',
      'archive_template',
      'delete_template',
    ]);
  });

  it('lists only published templates in token-searchable spaces', async () => {
    const harness = createHarness();

    await harness.service.callTool(
      'list_templates',
      { query: 'brief', scope: 'all', limit: 25 },
      context,
    );

    expect(harness.templateService.listForUser).toHaveBeenCalledWith(
      actor,
      workspaceId,
      expect.objectContaining({
        query: 'brief',
        scope: 'space',
        status: 'published',
        limit: 25,
      }),
      {
        publishedOnly: true,
        accessibleSpaceIds: [templateSpaceId],
      },
    );
  });

  it('intersects template reads with token read permission', async () => {
    const harness = createHarness();

    const result = await harness.service.callTool(
      'get_template',
      { templateId, format: 'markdown' },
      context,
    );

    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenCalledWith(context.client, 'read', templateSpaceId);
    expect(harness.templateService.getPublishedForUser).toHaveBeenCalledWith(
      actor,
      workspaceId,
      expect.objectContaining({ templateId, format: 'markdown' }),
    );
    expect(result).toEqual(expect.objectContaining({ id: templateId }));
  });

  it('instantiates idempotently after checking source read and target create access', async () => {
    const harness = createHarness();

    const result = await harness.service.callTool(
      'instantiate_template',
      {
        templateId,
        targetSpaceId,
        variables: { projectName: 'Atlas' },
        idempotencyKey: 'instantiate-atlas-v1',
      },
      context,
    );

    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenNthCalledWith(1, context.client, 'read', templateSpaceId);
    expect(
      harness.permissionService.assertSpacePermission,
    ).toHaveBeenNthCalledWith(2, context.client, 'create', targetSpaceId);
    expect(harness.idempotencyService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instantiate_template',
        idempotencyKey: 'instantiate-atlas-v1',
        resourceType: 'page',
      }),
    );
    expect(harness.checkpoint).toHaveBeenCalledWith({
      stage: 'page_and_instance_created',
      resourceId: page.id,
    });
    expect(result).toEqual(
      expect.objectContaining({
        page: expect.objectContaining({ id: page.id }),
        template: { id: template.id, key: template.key, version: 2 },
      }),
    );
  });

  it('requires an administrator actor for workspace-global templates', async () => {
    const harness = createHarness();
    harness.templateService.requireTemplateByReference.mockResolvedValue({
      ...template,
      spaceId: null,
    });

    await expect(
      harness.service.callTool('get_template', { templateId }, context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.templateAccess.assertWorkspaceAdmin).toHaveBeenCalledWith(
      actor,
    );
  });

  it('refuses to instantiate a draft even if an old version exists', async () => {
    const harness = createHarness();
    harness.templateService.requireTemplateByReference.mockResolvedValue({
      ...template,
      status: 'draft',
    });

    await expect(
      harness.service.callTool(
        'instantiate_template',
        {
          templateId,
          targetSpaceId,
          idempotencyKey: 'draft-must-not-run',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.templateService.instantiateForUser).not.toHaveBeenCalled();
  });
});
