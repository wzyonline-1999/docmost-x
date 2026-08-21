import {
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  Injectable,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql, SqlBool } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type { McpAuthenticatedClient } from '../types/mcp.types';
import { CATALOG_LIMITS, CatalogSnapshot } from '../types/mcp-catalog.types';

type CatalogSubtreeRow = {
  id: string;
  title: string | null;
  parentPageId: string | null;
  spaceId: string;
  workspaceId: string;
  updatedAt: Date;
  contentBytes: number | string | bigint;
};

@Injectable()
export class McpCatalogSnapshotService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async capture(
    catalogRootPageId: string,
    client: McpAuthenticatedClient,
  ): Promise<CatalogSnapshot> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const snapshotClock = await sql<{ snapshotAt: Date }>`
        SELECT transaction_timestamp() AS "snapshotAt"
      `.execute(trx);
        const snapshotAtValue = snapshotClock.rows[0]?.snapshotAt as
          | Date
          | string
          | undefined;
        const snapshotAt =
          snapshotAtValue instanceof Date
            ? snapshotAtValue
            : new Date(snapshotAtValue ?? Number.NaN);
        if (Number.isNaN(snapshotAt.getTime())) {
          throw new InternalServerErrorException(
            'Unable to capture the Catalog snapshot timestamp',
          );
        }

        const root = await trx
          .selectFrom('pages')
          .select(['id', 'title', 'spaceId', 'workspaceId', 'updatedAt'])
          .where('id', '=', catalogRootPageId)
          .where('workspaceId', '=', client.workspaceId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        if (!root) this.throwMaskedRootNotFound();

        const permission = await trx
          .selectFrom('mcpClientSpacePermissions')
          .select(['canRead', 'canSearch'])
          .where('clientId', '=', client.id)
          .where('workspaceId', '=', client.workspaceId)
          .where('spaceId', '=', root.spaceId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        if (!permission?.canRead || !permission.canSearch) {
          this.throwMaskedRootNotFound();
        }

        const actor = client.actorUserId
          ? await trx
              .selectFrom('users')
              .select(['id'])
              .where('id', '=', client.actorUserId)
              .where('workspaceId', '=', client.workspaceId)
              .where('deletedAt', 'is', null)
              .where('deactivatedAt', 'is', null)
              .executeTakeFirst()
          : undefined;
        if (!actor) this.throwMaskedRootNotFound();

        const actorRoles = await trx
          .selectFrom('spaceMembers')
          .select(['spaceId', 'role'])
          .where('spaceId', '=', root.spaceId)
          .where('userId', '=', actor.id)
          .where('deletedAt', 'is', null)
          .unionAll(
            trx
              .selectFrom('spaceMembers')
              .innerJoin(
                'groupUsers',
                'groupUsers.groupId',
                'spaceMembers.groupId',
              )
              .select(['spaceMembers.spaceId', 'spaceMembers.role'])
              .where('spaceMembers.spaceId', '=', root.spaceId)
              .where('groupUsers.userId', '=', actor.id)
              .where('spaceMembers.deletedAt', 'is', null),
          )
          .execute();
        if (
          !actorRoles.some((row) =>
            ['reader', 'writer', 'admin'].includes(row.role),
          )
        ) {
          this.throwMaskedRootNotFound();
        }

        const subtree = (await trx
          .withRecursive('catalogDescendants', (db) =>
            db
              .selectFrom('pages')
              .select([
                'pages.id',
                'pages.title',
                'pages.parentPageId',
                'pages.spaceId',
                'pages.workspaceId',
                'pages.updatedAt',
                sql<number>`octet_length(coalesce(pages.content::text, ''))`.as(
                  'contentBytes',
                ),
                sql<string[]>`ARRAY[pages.id]`.as('path'),
              ])
              .where('pages.id', '=', root.id)
              .where('pages.deletedAt', 'is', null)
              .unionAll((recursive) =>
                recursive
                  .selectFrom('pages as child')
                  .innerJoin(
                    'catalogDescendants as parent',
                    'child.parentPageId',
                    'parent.id',
                  )
                  .select([
                    'child.id',
                    'child.title',
                    'child.parentPageId',
                    'child.spaceId',
                    'child.workspaceId',
                    'child.updatedAt',
                    sql<number>`octet_length(coalesce(child.content::text, ''))`.as(
                      'contentBytes',
                    ),
                    sql<string[]>`parent.path || child.id`.as('path'),
                  ])
                  .where('child.deletedAt', 'is', null)
                  .where(sql<SqlBool>`NOT child.id = ANY(parent.path)`),
              ),
          )
          .selectFrom('catalogDescendants')
          .select([
            'id',
            'title',
            'parentPageId',
            'spaceId',
            'workspaceId',
            'updatedAt',
            'contentBytes',
          ])
          .orderBy('id', 'asc')
          .limit(CATALOG_LIMITS.maxScannedPages + 1)
          .execute()) as CatalogSubtreeRow[];

        if (subtree.length > CATALOG_LIMITS.maxScannedPages) {
          throw new PayloadTooLargeException(
            `Catalog snapshot supports at most ${CATALOG_LIMITS.maxScannedPages} scanned pages`,
          );
        }
        if (
          subtree.some(
            (page) =>
              page.workspaceId !== client.workspaceId ||
              page.spaceId !== root.spaceId,
          )
        ) {
          this.throwMaskedRootNotFound();
        }

        const scannedContentBytes = subtree.reduce(
          (total, page) => total + Number(page.contentBytes ?? 0),
          0,
        );
        if (scannedContentBytes > CATALOG_LIMITS.maxScannedContentBytes) {
          throw new PayloadTooLargeException(
            `Catalog snapshot content exceeds ${CATALOG_LIMITS.maxScannedContentBytes} bytes`,
          );
        }

        const candidateIds = subtree.map((page) => page.id);
        const readableRows = await trx
          .selectFrom('pages')
          .select('pages.id')
          .where('pages.id', 'in', candidateIds)
          .where(this.accessiblePagePredicate(actor.id, 'pages.id'))
          .execute();
        const readableIds = new Set(readableRows.map((row) => row.id));
        if (!readableIds.has(root.id)) this.throwMaskedRootNotFound();

        const readablePages = await trx
          .selectFrom('pages')
          .select([
            'id',
            'title',
            'parentPageId',
            'spaceId',
            'updatedAt',
            'content',
          ])
          .where('id', 'in', [...readableIds])
          .where('workspaceId', '=', client.workspaceId)
          .where('deletedAt', 'is', null)
          .orderBy('id', 'asc')
          .execute();

        return {
          catalogRoot: {
            id: root.id,
            title: root.title,
            spaceId: root.spaceId,
            updatedAt: root.updatedAt,
          },
          snapshotAt,
          pages: readablePages,
          scannedPageCount: subtree.length,
          scannedContentBytes,
        };
      });
  }

  private accessiblePagePredicate(userId: string, pageIdReference: string) {
    const pageId = sql.ref(pageIdReference);
    return sql<SqlBool>`
      NOT EXISTS (
        WITH RECURSIVE permission_ancestors AS (
          SELECT
            permission_page.id AS ancestor_id,
            permission_page.parent_page_id
          FROM pages AS permission_page
          WHERE permission_page.id = ${pageId}

          UNION ALL

          SELECT
            permission_parent.id AS ancestor_id,
            permission_parent.parent_page_id
          FROM pages AS permission_parent
          INNER JOIN permission_ancestors
            ON permission_ancestors.parent_page_id = permission_parent.id
        )
        SELECT 1
        FROM permission_ancestors
        INNER JOIN page_access
          ON page_access.page_id = permission_ancestors.ancestor_id
        LEFT JOIN page_permissions
          ON page_permissions.page_access_id = page_access.id
          AND (
            page_permissions.user_id = ${userId}
            OR page_permissions.group_id IN (
              SELECT group_users.group_id
              FROM group_users
              WHERE group_users.user_id = ${userId}
            )
          )
        WHERE page_permissions.id IS NULL
      )
    `;
  }

  private throwMaskedRootNotFound(): never {
    throw new NotFoundException('Catalog root page not found');
  }
}
