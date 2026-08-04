import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User, Workspace } from '@docmost/db/types/entity.types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { EventName } from '../../common/events/event.contants';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  ArchiveTemplateDto,
  CreateTemplateDto,
  DeleteTemplateDto,
  InstantiateTemplateDto,
  ListTemplatesDto,
  PublishTemplateDto,
  RenderTemplateDto,
  TemplateIdDto,
  TemplateVersionsDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { TemplateService } from './services/template.service';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  constructor(
    private readonly templateService: TemplateService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('list')
  list(
    @Body() dto: ListTemplatesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.listForUser(user, workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  info(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.getDraftForUser(
      user,
      workspace.id,
      dto.templateId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('versions')
  versions(
    @Body() dto: TemplateVersionsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.listVersionsForUser(
      user,
      workspace.id,
      dto.templateId,
      dto.limit,
    );
  }

  @HttpCode(HttpStatus.CREATED)
  @Post('create')
  async create(
    @Body() dto: CreateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.createForUser(
      user,
      workspace,
      dto,
    );
    const template = result.template as {
      id: string;
      title?: string;
      spaceId?: string;
    };
    this.auditService.log({
      event: AuditEvent.TEMPLATE_CREATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      spaceId: template.spaceId,
      changes: { after: { title: template.title, spaceId: template.spaceId } },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.updateForUser(
      user,
      workspace,
      dto,
    );
    const template = result.template as {
      id: string;
      title?: string;
      spaceId?: string;
    };
    this.auditService.log({
      event: AuditEvent.TEMPLATE_UPDATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      spaceId: template.spaceId,
      changes: { after: { title: template.title, spaceId: template.spaceId } },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('publish')
  async publish(
    @Body() dto: PublishTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.publishForUser(
      user,
      workspace,
      dto.templateId,
      dto.expectedUpdatedAt,
    );
    const template = result.template as {
      id: string;
      currentVersion?: number;
      spaceId?: string;
    };
    this.auditService.log({
      event: AuditEvent.TEMPLATE_PUBLISHED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      spaceId: template.spaceId,
      changes: { after: { version: template.currentVersion } },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('archive')
  async archive(
    @Body() dto: ArchiveTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.archiveForUser(
      user,
      workspace,
      dto.templateId,
      dto.expectedUpdatedAt,
    );
    this.auditService.log({
      event: AuditEvent.TEMPLATE_ARCHIVED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: dto.templateId,
      spaceId: result.spaceId as string | undefined,
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: DeleteTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.deleteForUser(
      user,
      workspace,
      dto.templateId,
      dto.expectedUpdatedAt,
    );
    this.auditService.log({
      event: AuditEvent.TEMPLATE_DELETED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: dto.templateId,
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('render')
  render(
    @Body() dto: RenderTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.renderForUser(user, workspace.id, dto);
  }

  @HttpCode(HttpStatus.CREATED)
  @Post('instantiate')
  async instantiate(
    @Body() dto: InstantiateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.templateService.instantiateForUser(
      user,
      workspace.id,
      dto,
    );
    this.eventEmitter.emit(EventName.PAGE_CREATED, {
      pageIds: [result.page.id],
      workspaceId: workspace.id,
    });
    this.auditService.log({
      event: AuditEvent.TEMPLATE_INSTANTIATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: result.template.id,
      spaceId: result.page.spaceId,
      metadata: {
        pageId: result.page.id,
        version: result.template.version,
      },
    });
    return result;
  }
}
