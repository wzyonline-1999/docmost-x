import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import slugify from '@sindresorhus/slugify';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type {
  Page,
  Template,
  TemplateVersion,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import type { Json } from '@docmost/db/types/db';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { createYdocFromJson } from '../../../common/helpers/prosemirror/utils';
import {
  jsonToHtml,
  jsonToMarkdown,
  jsonToText,
} from '../../../collaboration/collaboration.util';
import { PageService } from '../../page/services/page.service';
import type { ContentFormat } from '../../page/dto/create-page.dto';
import {
  CreateTemplateDto,
  InstantiateTemplateDto,
  ListTemplatesDto,
  RenderTemplateDto,
  UpdateTemplateDto,
} from '../dto/template.dto';
import {
  FormattedRenderedTemplate,
  TemplateSnapshot,
} from '../types/template.types';
import { TemplateAccessService } from './template-access.service';
import { TemplateRendererService } from './template-renderer.service';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

type InstanceContext = {
  clientId?: string | null;
  requestId?: string | null;
  checkpoint?: (pageId: string) => Promise<void>;
};

@Injectable()
export class TemplateService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly templateAccess: TemplateAccessService,
    private readonly templateRenderer: TemplateRendererService,
    private readonly templateRepo: TemplateRepo,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  async listForUser(
    user: User,
    workspaceId: string,
    dto: ListTemplatesDto,
    opts?: { publishedOnly?: boolean; accessibleSpaceIds?: string[] },
  ) {
    const accessibleSpaceIds =
      opts?.accessibleSpaceIds ??
      (await this.spaceMemberRepo.getUserSpaceIds(user.id));
    const status = opts?.publishedOnly ? 'published' : dto.status;
    return this.templateRepo.findTemplates(
      workspaceId,
      accessibleSpaceIds,
      dto,
      {
        spaceId: dto.spaceId,
        scope: dto.scope,
        status,
        tags: this.normalizeTags(dto.tags),
      },
    );
  }

  async getDraftForUser(user: User, workspaceId: string, templateId: string) {
    const template = await this.requireTemplate(templateId, workspaceId, true);
    await this.templateAccess.assertCanRead(template, user);
    return this.toTemplateResponse(template, true);
  }

  async listVersionsForUser(
    user: User,
    workspaceId: string,
    templateId: string,
    limit = 20,
  ) {
    const template = await this.requireTemplate(templateId, workspaceId);
    await this.templateAccess.assertCanRead(template, user);
    return this.templateRepo.listVersions(
      template.id,
      workspaceId,
      Math.min(Math.max(limit, 1), 100),
    );
  }

  async createForUser(
    user: User,
    workspace: Workspace,
    dto: CreateTemplateDto,
  ) {
    const title = this.requireTrimmed(dto.title, 'title');
    const purpose = this.requireTrimmed(dto.purpose, 'purpose');
    await this.templateAccess.assertCanManage(
      { spaceId: dto.spaceId ?? null },
      user,
      workspace,
    );

    let sourcePage: Page | undefined;
    if (dto.sourcePageId) {
      if (dto.content !== undefined) {
        throw new BadRequestException(
          'Provide either sourcePageId or content, not both',
        );
      }
      sourcePage = await this.pageRepo.findById(dto.sourcePageId, {
        includeContent: true,
      });
      if (!sourcePage || sourcePage.workspaceId !== workspace.id) {
        throw new NotFoundException('Source page not found');
      }
      await this.templateAccess.assertCanReadSourcePage(sourcePage, user);
    }

    const content = sourcePage?.content
      ? (structuredClone(sourcePage.content) as Record<string, unknown>)
      : await this.prepareContent(dto.content, dto.format);
    const schema = this.templateRenderer.normalizeInputSchema(dto.inputSchema);
    const validation = await this.templateRenderer.validateDraft({
      inputSchema: schema,
      titleTemplate: dto.titleTemplate,
      content: content as Json,
    });
    const key = this.generateKey(title);

    const template = await this.templateRepo.insertTemplate({
      key,
      title,
      description: this.optionalTrimmed(dto.description),
      purpose,
      useWhen: this.optionalTrimmed(dto.useWhen),
      tags: this.normalizeTags(dto.tags),
      inputSchema: validation.schema as unknown as Json,
      titleTemplate: this.optionalTrimmed(dto.titleTemplate),
      content: content as Json,
      textContent: jsonToText(content),
      ydoc: createYdocFromJson(content),
      icon: dto.icon ?? sourcePage?.icon ?? null,
      spaceId: dto.spaceId ?? null,
      workspaceId: workspace.id,
      creatorId: user.id,
      lastUpdatedById: user.id,
      sourcePageId: sourcePage?.id ?? null,
      status: 'draft',
      draftRevision: 1,
      currentVersion: 0,
      publishedAt: null,
      publishedById: null,
      collaboratorIds: [user.id],
      deletedAt: null,
    });

    return {
      template: this.toTemplateResponse(template, true),
      warnings: validation.warnings,
    };
  }

  async updateForUser(
    user: User,
    workspace: Workspace,
    dto: UpdateTemplateDto,
  ) {
    const template = await this.requireTemplate(
      dto.templateId,
      workspace.id,
      true,
    );
    await this.templateAccess.assertCanManage(template, user, workspace);
    this.assertHasDraftChanges(dto);

    const nextSpaceId =
      dto.spaceId === undefined ? template.spaceId : dto.spaceId || null;
    if (nextSpaceId !== template.spaceId) {
      await this.templateAccess.assertCanManage(
        { spaceId: nextSpaceId },
        user,
        workspace,
      );
    }

    const nextContent =
      dto.content === undefined
        ? (template.content as Record<string, unknown>)
        : await this.prepareContent(dto.content, dto.format);
    const nextSchema = this.templateRenderer.normalizeInputSchema(
      dto.inputSchema ?? template.inputSchema,
    );
    const nextTitleTemplate =
      dto.titleTemplate === undefined
        ? template.titleTemplate
        : this.optionalTrimmed(dto.titleTemplate);
    const validation = await this.templateRenderer.validateDraft({
      inputSchema: nextSchema,
      titleTemplate: nextTitleTemplate,
      content: nextContent as Json,
    });

    const expectedUpdatedAt = this.parseExpectedUpdatedAt(
      dto.expectedUpdatedAt,
    );
    const updated = await this.templateRepo.updateTemplate(
      {
        title:
          dto.title === undefined
            ? template.title
            : this.requireTrimmed(dto.title, 'title'),
        description:
          dto.description === undefined
            ? template.description
            : this.optionalTrimmed(dto.description),
        purpose:
          dto.purpose === undefined
            ? template.purpose
            : this.requireTrimmed(dto.purpose, 'purpose'),
        useWhen:
          dto.useWhen === undefined
            ? template.useWhen
            : this.optionalTrimmed(dto.useWhen),
        tags:
          dto.tags === undefined ? template.tags : this.normalizeTags(dto.tags),
        inputSchema: validation.schema as unknown as Json,
        titleTemplate: nextTitleTemplate,
        content: nextContent as Json,
        textContent: jsonToText(nextContent),
        ydoc: createYdocFromJson(nextContent),
        icon: dto.icon === undefined ? template.icon : dto.icon || null,
        spaceId: nextSpaceId,
        lastUpdatedById: user.id,
        status: 'draft',
        draftRevision: template.draftRevision + 1,
      },
      template.id,
      workspace.id,
      { expectedUpdatedAt },
    );
    if (!updated) {
      throw new ConflictException(
        'Template changed since expectedUpdatedAt; reload before saving',
      );
    }

    return {
      template: this.toTemplateResponse(updated, true),
      warnings: validation.warnings,
    };
  }

  async publishForUser(
    user: User,
    workspace: Workspace,
    templateId: string,
    expectedUpdatedAt: string,
  ) {
    const expected = this.parseExpectedUpdatedAt(expectedUpdatedAt);
    return this.db.transaction().execute(async (trx) => {
      const template = await this.templateRepo.findById(
        templateId,
        workspace.id,
        { includeContent: true, trx, forUpdate: true },
      );
      if (!template) throw new NotFoundException('Template not found');
      await this.templateAccess.assertCanManage(template, user, workspace);
      if (template.updatedAt.getTime() !== expected.getTime()) {
        throw new ConflictException(
          'Template changed since expectedUpdatedAt; reload before publishing',
        );
      }
      if (
        !template.title?.trim() ||
        !template.purpose?.trim() ||
        !template.content
      ) {
        throw new BadRequestException(
          'A title, purpose, and content are required before publishing',
        );
      }

      const validation = await this.templateRenderer.validateDraft({
        inputSchema: template.inputSchema,
        titleTemplate: template.titleTemplate,
        content: template.content,
      });
      const versionNumber = template.currentVersion + 1;
      const version = await this.templateRepo.insertVersion(
        {
          templateId: template.id,
          workspaceId: template.workspaceId,
          spaceId: template.spaceId,
          version: versionNumber,
          key: template.key,
          title: template.title,
          description: template.description,
          purpose: template.purpose,
          useWhen: template.useWhen,
          tags: template.tags,
          inputSchema: validation.schema as unknown as Json,
          titleTemplate: template.titleTemplate,
          content: template.content,
          textContent: template.textContent,
          icon: template.icon,
          contentHash: this.hash(template.content),
          createdById: user.id,
        },
        trx,
      );
      const publishedAt = new Date();
      const updated = await this.templateRepo.updateTemplate(
        {
          status: 'published',
          currentVersion: versionNumber,
          publishedAt,
          publishedById: user.id,
          lastUpdatedById: user.id,
        },
        template.id,
        workspace.id,
        { trx },
      );
      if (!updated) throw new ConflictException('Template publish failed');

      return {
        template: this.toTemplateResponse(updated, true),
        version: this.toVersionResponse(version),
        warnings: validation.warnings,
      };
    });
  }

  async archiveForUser(
    user: User,
    workspace: Workspace,
    templateId: string,
    expectedUpdatedAt: string,
  ) {
    const template = await this.requireTemplate(templateId, workspace.id);
    await this.templateAccess.assertCanManage(template, user, workspace);
    const updated = await this.templateRepo.updateTemplate(
      { status: 'archived', lastUpdatedById: user.id },
      template.id,
      workspace.id,
      { expectedUpdatedAt: this.parseExpectedUpdatedAt(expectedUpdatedAt) },
    );
    if (!updated) throw new ConflictException('Template changed; reload first');
    return this.toTemplateResponse(updated, true);
  }

  async deleteForUser(
    user: User,
    workspace: Workspace,
    templateId: string,
    expectedUpdatedAt: string,
  ) {
    const template = await this.requireTemplate(templateId, workspace.id);
    await this.templateAccess.assertCanManage(template, user, workspace);
    const deleted = await this.templateRepo.softDeleteTemplate(
      template.id,
      workspace.id,
      { expectedUpdatedAt: this.parseExpectedUpdatedAt(expectedUpdatedAt) },
    );
    if (!deleted) throw new ConflictException('Template changed; reload first');
    return { templateId: deleted.id, deleted: true };
  }

  async renderForUser(
    user: User,
    workspaceId: string,
    dto: RenderTemplateDto,
    opts?: { publishedOnly?: boolean },
  ): Promise<FormattedRenderedTemplate> {
    const { template, snapshot } = await this.resolveSnapshot(
      workspaceId,
      dto,
      opts?.publishedOnly ?? false,
    );
    await this.templateAccess.assertCanRead(template, user);
    const rendered = await this.templateRenderer.render(
      snapshot,
      dto.variables,
      dto.title,
    );
    return this.formatRendered(rendered, dto.format ?? 'markdown');
  }

  async getPublishedForUser(
    user: User,
    workspaceId: string,
    dto: Pick<RenderTemplateDto, 'templateId' | 'key' | 'version' | 'format'>,
  ) {
    const { template, snapshot, version } = await this.resolveSnapshot(
      workspaceId,
      dto,
      true,
    );
    await this.templateAccess.assertCanRead(template, user);

    const format = dto.format ?? 'markdown';
    const content =
      format === 'markdown'
        ? jsonToMarkdown(snapshot.content)
        : format === 'html'
          ? jsonToHtml(snapshot.content)
          : snapshot.content;

    return {
      id: template.id,
      key: snapshot.key,
      title: snapshot.title,
      description: snapshot.description,
      purpose: snapshot.purpose,
      useWhen: snapshot.useWhen,
      tags: snapshot.tags,
      inputSchema: snapshot.inputSchema,
      titleTemplate: snapshot.titleTemplate,
      icon: snapshot.icon,
      spaceId: snapshot.spaceId,
      workspaceId: template.workspaceId,
      status: template.status,
      version: snapshot.version,
      versionId: version.id,
      content,
      format,
      publishedAt: template.publishedAt,
    };
  }

  async instantiateForUser(
    user: User,
    workspaceId: string,
    dto: InstantiateTemplateDto,
    context?: InstanceContext,
  ) {
    const { template, snapshot, version } = await this.resolveSnapshot(
      workspaceId,
      dto,
      true,
    );
    await this.templateAccess.assertCanRead(template, user);

    let parentPage: Page | undefined;
    if (dto.parentPageId) {
      parentPage = await this.pageRepo.findById(dto.parentPageId);
      if (!parentPage || parentPage.workspaceId !== workspaceId) {
        throw new NotFoundException('Parent page not found');
      }
    }
    await this.templateAccess.assertCanCreatePageAt(
      user,
      dto.targetSpaceId,
      parentPage,
    );

    const rendered = await this.templateRenderer.render(
      snapshot,
      dto.variables,
      dto.title,
    );
    const inputHash = this.hash({
      templateId: template.id,
      version: snapshot.version,
      targetSpaceId: dto.targetSpaceId,
      parentPageId: dto.parentPageId ?? null,
      title: rendered.title,
      variables: rendered.variables,
    });

    const page = await this.db.transaction().execute(async (trx) => {
      const createdPage = await this.pageService.create(
        user.id,
        workspaceId,
        {
          spaceId: dto.targetSpaceId,
          parentPageId: dto.parentPageId,
          title: rendered.title,
          icon: rendered.icon ?? undefined,
          content: rendered.content,
          format: 'json',
        },
        trx,
      );
      await this.templateRepo.insertInstance(
        {
          templateId: template.id,
          templateVersionId: version.id,
          pageId: createdPage.id,
          workspaceId,
          spaceId: dto.targetSpaceId,
          clientId: context?.clientId ?? null,
          actorUserId: user.id,
          variables: rendered.variables as unknown as Json,
          inputHash,
          requestId: context?.requestId ?? null,
        },
        trx,
      );
      await context?.checkpoint?.(createdPage.id);
      return createdPage;
    });

    return {
      page,
      template: {
        id: template.id,
        key: template.key,
        version: snapshot.version,
      },
      warnings: rendered.warnings,
    };
  }

  async requireTemplateByReference(
    workspaceId: string,
    input: { templateId?: string; key?: string },
    includeContent = false,
  ): Promise<Template> {
    if (input.templateId) {
      return this.requireTemplate(
        input.templateId,
        workspaceId,
        includeContent,
      );
    }
    if (input.key) {
      const template = await this.templateRepo.findByKey(
        input.key,
        workspaceId,
        {
          includeContent,
        },
      );
      if (template) return template;
    }
    throw new BadRequestException('templateId or key is required');
  }

  private async resolveSnapshot(
    workspaceId: string,
    dto: Pick<RenderTemplateDto, 'templateId' | 'key' | 'version'>,
    publishedOnly: boolean,
  ): Promise<{
    template: Template;
    snapshot: TemplateSnapshot;
    version: TemplateVersion;
  }> {
    const template = await this.requireTemplateByReference(
      workspaceId,
      dto,
      !publishedOnly && dto.version === undefined,
    );

    if (publishedOnly && template.status !== 'published') {
      throw new NotFoundException('Published template version not found');
    }

    if (!publishedOnly && dto.version === undefined) {
      if (!template.content || !template.title || !template.purpose) {
        throw new BadRequestException('Template draft is incomplete');
      }
      const draftSnapshot: TemplateSnapshot = {
        templateId: template.id,
        version: template.currentVersion + 1,
        key: template.key,
        title: template.title,
        description: template.description,
        purpose: template.purpose,
        useWhen: template.useWhen,
        tags: template.tags,
        inputSchema: template.inputSchema,
        titleTemplate: template.titleTemplate,
        content: template.content,
        icon: template.icon,
        spaceId: template.spaceId,
      };
      return {
        template,
        snapshot: draftSnapshot,
        version: { id: '', ...draftSnapshot } as unknown as TemplateVersion,
      };
    }

    const version = await this.templateRepo.findVersion(
      template.id,
      workspaceId,
      dto.version,
    );
    if (!version)
      throw new NotFoundException('Published template version not found');
    return {
      template,
      version,
      snapshot: this.versionToSnapshot(version),
    };
  }

  private versionToSnapshot(version: TemplateVersion): TemplateSnapshot {
    return {
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      key: version.key,
      title: version.title,
      description: version.description,
      purpose: version.purpose,
      useWhen: version.useWhen,
      tags: version.tags,
      inputSchema: version.inputSchema,
      titleTemplate: version.titleTemplate,
      content: version.content,
      icon: version.icon,
      spaceId: version.spaceId,
    };
  }

  private async requireTemplate(
    templateId: string,
    workspaceId: string,
    includeContent = false,
  ): Promise<Template> {
    const template = await this.templateRepo.findById(templateId, workspaceId, {
      includeContent,
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  private async prepareContent(
    content?: string | object,
    format?: ContentFormat,
  ): Promise<Record<string, unknown>> {
    if (content === undefined) return structuredClone(EMPTY_DOC);
    return (await this.pageService.prepareProsemirrorContent(
      content,
      format ?? 'json',
    )) as Record<string, unknown>;
  }

  private formatRendered(
    rendered: Awaited<ReturnType<TemplateRendererService['render']>>,
    format: ContentFormat,
  ): FormattedRenderedTemplate {
    const content =
      format === 'markdown'
        ? jsonToMarkdown(rendered.content)
        : format === 'html'
          ? jsonToHtml(rendered.content)
          : (rendered.content as Json);
    return { ...rendered, content, format };
  }

  private toTemplateResponse(template: Template, includeContent: boolean) {
    const response: Record<string, unknown> = {
      id: template.id,
      key: template.key,
      title: template.title ?? '',
      description: template.description,
      purpose: template.purpose ?? '',
      useWhen: template.useWhen,
      tags: template.tags,
      inputSchema: template.inputSchema,
      titleTemplate: template.titleTemplate,
      icon: template.icon,
      spaceId: template.spaceId,
      workspaceId: template.workspaceId,
      creatorId: template.creatorId,
      lastUpdatedById: template.lastUpdatedById,
      status: template.status,
      draftRevision: template.draftRevision,
      currentVersion: template.currentVersion,
      publishedAt: template.publishedAt,
      sourcePageId: template.sourcePageId,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      creator: (template as Template & { creator?: unknown }).creator,
    };
    if (includeContent) response.content = template.content;
    return response;
  }

  private toVersionResponse(version: TemplateVersion) {
    return {
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      contentHash: version.contentHash,
      createdById: version.createdById,
      createdAt: version.createdAt,
    };
  }

  private generateKey(title: string): string {
    const base = slugify(title).slice(0, 72) || 'template';
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  private normalizeTags(tags?: string[]): string[] {
    return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
      .slice(0, 20)
      .map((tag) => tag.slice(0, 64));
  }

  private requireTrimmed(
    value: string | null | undefined,
    field: string,
  ): string {
    const trimmed = value?.trim();
    if (!trimmed) throw new BadRequestException(`${field} is required`);
    return trimmed;
  }

  private optionalTrimmed(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private parseExpectedUpdatedAt(value: string): Date {
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        'expectedUpdatedAt must be an ISO date-time',
      );
    }
    return parsed;
  }

  private assertHasDraftChanges(dto: UpdateTemplateDto): void {
    const fields: Array<keyof UpdateTemplateDto> = [
      'title',
      'description',
      'purpose',
      'useWhen',
      'tags',
      'inputSchema',
      'titleTemplate',
      'content',
      'icon',
      'spaceId',
    ];
    if (fields.every((field) => dto[field] === undefined)) {
      throw new BadRequestException('At least one template field is required');
    }
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
