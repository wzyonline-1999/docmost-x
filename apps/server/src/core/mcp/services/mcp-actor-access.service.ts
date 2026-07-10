import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { Page, User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { PageAccessService } from '../../page/page-access/page-access.service';
import type { McpAuthenticatedClient } from '../types/mcp.types';

type ActorPageTarget = Pick<Page, 'id' | 'spaceId'>;

@Injectable()
export class McpActorAccessService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageAccessService: PageAccessService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async requireActor(client: McpAuthenticatedClient): Promise<User> {
    if (!client.actorUserId) {
      throw new ForbiddenException(
        'MCP page tools require an actor user mapping',
      );
    }

    const actor = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', client.actorUserId)
      .where('workspaceId', '=', client.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!actor || isUserDisabled(actor)) {
      throw new ForbiddenException('MCP actor user is unavailable');
    }

    return actor;
  }

  async assertCanReadSpace(actor: User, spaceId: string): Promise<void> {
    const ability = await this.getSpaceAbility(actor, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('MCP actor lacks Docmost space access');
    }
  }

  async assertCanCreateInSpace(actor: User, spaceId: string): Promise<void> {
    const ability = await this.getSpaceAbility(actor, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('MCP actor lacks Docmost create access');
    }
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

    const actorSpaceIds = new Set(
      await this.spaceMemberRepo.getUserSpaceIds(actor.id),
    );
    return [...new Set(candidateSpaceIds)].filter((spaceId) =>
      actorSpaceIds.has(spaceId),
    );
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

  private async getSpaceAbility(actor: User, spaceId: string) {
    try {
      return await this.spaceAbility.createForUser(actor, spaceId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new ForbiddenException('MCP actor lacks Docmost space access');
      }
      throw err;
    }
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
