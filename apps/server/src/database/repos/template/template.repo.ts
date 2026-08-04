import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ExpressionBuilder, sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  InsertableTemplate,
  InsertableTemplateInstance,
  InsertableTemplateVersion,
  Template,
  TemplateInstance,
  TemplateVersion,
  UpdatableTemplate,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { DB } from '@docmost/db/types/db';

export type TemplateScopeFilter = 'all' | 'global' | 'space';

@Injectable()
export class TemplateRepo {
  private readonly baseFields: Array<keyof Template> = [
    'id',
    'key',
    'title',
    'description',
    'purpose',
    'useWhen',
    'tags',
    'inputSchema',
    'titleTemplate',
    'icon',
    'spaceId',
    'workspaceId',
    'creatorId',
    'lastUpdatedById',
    'status',
    'draftRevision',
    'currentVersion',
    'publishedAt',
    'publishedById',
    'sourcePageId',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    templateId: string,
    workspaceId: string,
    opts?: {
      includeContent?: boolean;
      includeDeleted?: boolean;
      trx?: KyselyTransaction;
      forUpdate?: boolean;
    },
  ): Promise<Template | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    let query = db
      .selectFrom('templates')
      .select(this.baseFields)
      .$if(opts?.includeContent ?? false, (qb) =>
        qb.select(['content', 'textContent', 'ydoc']),
      )
      .select((eb) => [this.withCreator(eb)])
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    if (!opts?.includeDeleted) {
      query = query.where('deletedAt', 'is', null);
    }
    if (opts?.forUpdate) {
      query = query.forUpdate();
    }

    return query.executeTakeFirst() as Promise<Template | undefined>;
  }

  async findByKey(
    key: string,
    workspaceId: string,
    opts?: { includeContent?: boolean; trx?: KyselyTransaction },
  ): Promise<Template | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    return db
      .selectFrom('templates')
      .select(this.baseFields)
      .$if(opts?.includeContent ?? false, (qb) =>
        qb.select(['content', 'textContent', 'ydoc']),
      )
      .select((eb) => [this.withCreator(eb)])
      .where('key', '=', key)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst() as Promise<Template | undefined>;
  }

  async findTemplates(
    workspaceId: string,
    accessibleSpaceIds: string[],
    pagination: PaginationOptions,
    opts?: {
      spaceId?: string;
      status?: 'draft' | 'published' | 'archived';
      scope?: TemplateScopeFilter;
      tags?: string[];
    },
  ) {
    let query = this.db
      .selectFrom('templates')
      .select(this.baseFields)
      .select((eb) => [this.withCreator(eb)])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    if (opts?.status) {
      query = query.where('status', '=', opts.status);
    }

    if (opts?.spaceId) {
      if (!accessibleSpaceIds.includes(opts.spaceId)) {
        query = query.where(sql<boolean>`false`);
      } else {
        query = query.where('spaceId', '=', opts.spaceId);
      }
    } else if (opts?.scope === 'global') {
      query = query.where('spaceId', 'is', null);
    } else if (opts?.scope === 'space') {
      query = accessibleSpaceIds.length
        ? query.where('spaceId', 'in', accessibleSpaceIds)
        : query.where(sql<boolean>`false`);
    } else {
      query = query.where((eb) =>
        eb.or([
          eb('spaceId', 'is', null),
          ...(accessibleSpaceIds.length
            ? [eb('spaceId', 'in', accessibleSpaceIds)]
            : []),
        ]),
      );
    }

    if (opts?.tags?.length) {
      query = query.where(sql<boolean>`tags && ${opts.tags}`);
    }

    if (pagination.query?.trim()) {
      const searchTerm = `%${pagination.query.trim()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql`f_unaccent(title)`, 'ilike', sql`f_unaccent(${searchTerm})`),
          eb(
            sql`f_unaccent(description)`,
            'ilike',
            sql`f_unaccent(${searchTerm})`,
          ),
          eb(sql`f_unaccent(purpose)`, 'ilike', sql`f_unaccent(${searchTerm})`),
          eb(
            sql`f_unaccent(use_when)`,
            'ilike',
            sql`f_unaccent(${searchTerm})`,
          ),
          eb(
            sql`f_unaccent(text_content)`,
            'ilike',
            sql`f_unaccent(${searchTerm})`,
          ),
        ]),
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async insertTemplate(
    insertableTemplate: InsertableTemplate,
    trx?: KyselyTransaction,
  ): Promise<Template> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('templates')
      .values(insertableTemplate)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateTemplate(
    updatableTemplate: UpdatableTemplate,
    templateId: string,
    workspaceId: string,
    opts?: {
      trx?: KyselyTransaction;
      expectedUpdatedAt?: Date;
    },
  ): Promise<Template | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    const updatedAt = opts?.expectedUpdatedAt
      ? new Date(
          Math.max(Date.now(), opts.expectedUpdatedAt.getTime() + 1),
        )
      : new Date();
    let query = db
      .updateTable('templates')
      .set({ ...updatableTemplate, updatedAt })
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    if (opts?.expectedUpdatedAt) {
      query = query
        .where('updatedAt', '>=', opts.expectedUpdatedAt)
        .where(
          'updatedAt',
          '<',
          new Date(opts.expectedUpdatedAt.getTime() + 1),
        );
    }

    return query.returningAll().executeTakeFirst();
  }

  async softDeleteTemplate(
    templateId: string,
    workspaceId: string,
    opts?: { trx?: KyselyTransaction; expectedUpdatedAt?: Date },
  ): Promise<Template | undefined> {
    return this.updateTemplate(
      { deletedAt: new Date(), status: 'archived' },
      templateId,
      workspaceId,
      opts,
    );
  }

  async insertVersion(
    version: InsertableTemplateVersion,
    trx?: KyselyTransaction,
  ): Promise<TemplateVersion> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('templateVersions')
      .values(version)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findVersion(
    templateId: string,
    workspaceId: string,
    version?: number,
    trx?: KyselyTransaction,
  ): Promise<TemplateVersion | undefined> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .selectFrom('templateVersions')
      .selectAll()
      .where('templateId', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    query = version
      ? query.where('version', '=', version)
      : query.orderBy('version', 'desc').limit(1);

    return query.executeTakeFirst();
  }

  async listVersions(
    templateId: string,
    workspaceId: string,
    limit = 20,
  ): Promise<TemplateVersion[]> {
    return this.db
      .selectFrom('templateVersions')
      .selectAll()
      .where('templateId', '=', templateId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('version', 'desc')
      .limit(limit)
      .execute();
  }

  async insertInstance(
    instance: InsertableTemplateInstance,
    trx?: KyselyTransaction,
  ): Promise<TemplateInstance> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('templateInstances')
      .values(instance)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findInstanceByPageId(
    pageId: string,
    workspaceId: string,
  ): Promise<TemplateInstance | undefined> {
    return this.db
      .selectFrom('templateInstances')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  private withCreator(eb: ExpressionBuilder<DB, 'templates'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'templates.creatorId'),
    ).as('creator');
  }
}
