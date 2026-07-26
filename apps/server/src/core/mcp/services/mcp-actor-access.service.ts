import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageAccessService } from '../../page/page-access/page-access.service';
import type { McpAuthenticatedClient } from '../types/mcp.types';
import { McpEffectivePermissionService } from './mcp-effective-permission.service';

type ActorPageTarget = Pick<Page, 'id' | 'spaceId'>;

@Injectable()
export class McpActorAccessService {
  constructor(
    private readonly pageAccessService: PageAccessService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly effectivePermissionService: McpEffectivePermissionService,
  ) {}

  async requireActor(client: McpAuthenticatedClient): Promise<User> {
    return this.effectivePermissionService.requireActor(client);
  }

  async assertCanReadSpace(actor: User, spaceId: string): Promise<void> {
    await this.effectivePermissionService.assertActorAction(
      actor,
      'read',
      spaceId,
    );
  }

  async assertCanCreateInSpace(actor: User, spaceId: string): Promise<void> {
    await this.effectivePermissionService.assertActorAction(
      actor,
      'create',
      spaceId,
    );
  }

  async assertCanViewPage(actor: User, page: ActorPageTarget): Promise<void> {
    await this.runMaskedPageCheck(() =>
      this.pageAccessService.validateCanView(page as Page, actor),
    );
  }

  async assertCanEditPage(actor: User, page: ActorPageTarget): Promise<void> {
    await this.runMaskedPageCheck(() =>
      this.pageAccessService.validateCanEdit(page as Page, actor),
    );
  }

  async filterReadableSpaceIds(
    actor: User,
    candidateSpaceIds: string[],
  ): Promise<string[]> {
    if (candidateSpaceIds.length === 0) {
      return [];
    }

    return this.effectivePermissionService.filterActorSpaceIds(actor, 'read', [
      ...new Set(candidateSpaceIds),
    ]);
  }

  async filterReadablePageIds(
    actor: User,
    pageIds: string[],
    spaceId?: string,
  ): Promise<string[]> {
    return this.pagePermissionRepo.filterAccessiblePageIds({
      pageIds: [...new Set(pageIds)],
      userId: actor.id,
      spaceId,
    });
  }

  getReadablePagePredicate(actor: User, pageIdReference = 'pages.id') {
    return this.pagePermissionRepo.getAccessiblePagePredicate(
      actor.id,
      pageIdReference,
    );
  }

  private async runMaskedPageCheck(
    check: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await check();
    } catch (err) {
      if (
        err instanceof ForbiddenException ||
        err instanceof NotFoundException
      ) {
        throw new NotFoundException('Page not found');
      }
      throw err;
    }
  }
}
