import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';

type McpIndexActorCandidate = {
  actorUserId: string;
  spaceId: string;
};

export type McpVectorEligibilityResult = {
  eligiblePageIds: string[];
  ineligiblePageIds: string[];
};

@Injectable()
export class McpVectorEligibilityService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async evaluatePageIds(input: {
    workspaceId: string;
    pageIds: string[];
  }): Promise<McpVectorEligibilityResult> {
    const requestedPageIds = [...new Set(input.pageIds)];
    if (requestedPageIds.length === 0) {
      return { eligiblePageIds: [], ineligiblePageIds: [] };
    }

    const pages = await this.db
      .selectFrom('pages')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select(['pages.id', 'pages.spaceId'])
      .where('pages.workspaceId', '=', input.workspaceId)
      .where('pages.id', 'in', requestedPageIds)
      .where('pages.deletedAt', 'is', null)
      .where('spaces.deletedAt', 'is', null)
      .execute();

    if (pages.length === 0) {
      return { eligiblePageIds: [], ineligiblePageIds: requestedPageIds };
    }

    const spaceIds = [...new Set(pages.map((page) => page.spaceId))];
    const candidates = await this.loadIndexActorCandidates(
      input.workspaceId,
      spaceIds,
    );
    const eligiblePageIds = new Set<string>();
    const pagesBySpace = new Map<string, string[]>();

    for (const page of pages) {
      const pageIds = pagesBySpace.get(page.spaceId) ?? [];
      pageIds.push(page.id);
      pagesBySpace.set(page.spaceId, pageIds);
    }

    const membershipCache = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      let actorSpaceIds = membershipCache.get(candidate.actorUserId);
      if (!actorSpaceIds) {
        actorSpaceIds = new Set(
          await this.spaceMemberRepo.getUserSpaceIds(candidate.actorUserId),
        );
        membershipCache.set(candidate.actorUserId, actorSpaceIds);
      }

      if (!actorSpaceIds.has(candidate.spaceId)) {
        continue;
      }

      const candidatePageIds = pagesBySpace.get(candidate.spaceId) ?? [];
      const readablePageIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: candidatePageIds,
          userId: candidate.actorUserId,
          spaceId: candidate.spaceId,
        });

      for (const pageId of readablePageIds) {
        eligiblePageIds.add(pageId);
      }
    }

    return {
      eligiblePageIds: requestedPageIds.filter((pageId) =>
        eligiblePageIds.has(pageId),
      ),
      ineligiblePageIds: requestedPageIds.filter(
        (pageId) => !eligiblePageIds.has(pageId),
      ),
    };
  }

  async isPageEligible(workspaceId: string, pageId: string): Promise<boolean> {
    const result = await this.evaluatePageIds({
      workspaceId,
      pageIds: [pageId],
    });
    return result.eligiblePageIds.includes(pageId);
  }

  private loadIndexActorCandidates(
    workspaceId: string,
    spaceIds: string[],
  ): Promise<McpIndexActorCandidate[]> {
    const now = new Date();
    return this.db
      .selectFrom('mcpClientSpacePermissions as permissions')
      .innerJoin('mcpClients as clients', 'clients.id', 'permissions.clientId')
      .innerJoin('users as actors', 'actors.id', 'clients.actorUserId')
      .innerJoin('spaces', 'spaces.id', 'permissions.spaceId')
      .select(['clients.actorUserId as actorUserId', 'permissions.spaceId'])
      .distinct()
      .where('permissions.workspaceId', '=', workspaceId)
      .where('clients.workspaceId', '=', workspaceId)
      .where('actors.workspaceId', '=', workspaceId)
      .where('permissions.spaceId', 'in', spaceIds)
      .where('permissions.canIndex', '=', true)
      .where('permissions.deletedAt', 'is', null)
      .where('clients.status', '=', 'active')
      .where('clients.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('clients.expiresAt', 'is', null),
          eb('clients.expiresAt', '>', now),
        ]),
      )
      .where('actors.deletedAt', 'is', null)
      .where('actors.deactivatedAt', 'is', null)
      .where('spaces.deletedAt', 'is', null)
      .execute() as Promise<McpIndexActorCandidate[]>;
  }
}
