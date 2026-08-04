import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Page,
  Template,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import { UserRole } from '../../../common/helpers/types/permission';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { PageAccessService } from '../../page/page-access/page-access.service';

@Injectable()
export class TemplateAccessService {
  constructor(
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
  ) {}

  async assertCanRead(template: Template, user: User): Promise<void> {
    if (!template.spaceId) return;
    const ability = await this.spaceAbility.createForUser(
      user,
      template.spaceId,
    );
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('Template read permission denied');
    }
  }

  async assertCanManage(
    template: Pick<Template, 'spaceId'>,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    if (!template.spaceId) {
      this.assertWorkspaceAdmin(user);
      return;
    }

    const settings = (workspace.settings ?? {}) as Record<string, any>;
    const isWorkspaceAdmin = [UserRole.OWNER, UserRole.ADMIN].includes(
      user.role as UserRole,
    );
    if (
      !isWorkspaceAdmin &&
      settings.templates?.allowMemberTemplates !== true
    ) {
      throw new ForbiddenException(
        'Workspace members are not allowed to manage templates',
      );
    }

    const ability = await this.spaceAbility.createForUser(
      user,
      template.spaceId,
    );
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('Template write permission denied');
    }
  }

  async assertCanCreatePageAt(
    user: User,
    targetSpaceId: string,
    parentPage?: Page,
  ): Promise<void> {
    if (parentPage) {
      if (parentPage.spaceId !== targetSpaceId || parentPage.deletedAt) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, user);
      return;
    }

    const ability = await this.spaceAbility.createForUser(user, targetSpaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('Page create permission denied');
    }
  }

  async assertCanReadSourcePage(page: Page, user: User): Promise<void> {
    await this.pageAccessService.validateCanView(page, user);
  }

  assertWorkspaceAdmin(user: User): void {
    if (![UserRole.OWNER, UserRole.ADMIN].includes(user.role as UserRole)) {
      throw new ForbiddenException(
        'Workspace administrator permission required',
      );
    }
  }
}
