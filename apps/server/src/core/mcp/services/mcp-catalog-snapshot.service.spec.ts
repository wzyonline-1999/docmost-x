import {
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import type { McpAuthenticatedClient } from '../types/mcp.types';
import { CATALOG_LIMITS } from '../types/mcp-catalog.types';
import { McpCatalogSnapshotService } from './mcp-catalog-snapshot.service';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT_AT = new Date('2026-08-20T09:00:00.000Z');
const UPDATED_AT = new Date('2026-08-20T08:00:00.000Z');

type ScriptedRows = Array<Record<string, unknown>>;

type SnapshotHarness = {
  db: Kysely<unknown>;
  service: McpCatalogSnapshotService;
  query: jest.Mock;
  responses: ScriptedRows[];
};

describe('McpCatalogSnapshotService', () => {
  const databases: Array<Kysely<unknown>> = [];
  const client = {
    id: 'client-1',
    workspaceId: WORKSPACE_ID,
    actorUserId: ACTOR_ID,
    status: 'active',
  } as McpAuthenticatedClient;

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it('captures readable Catalog pages in one read-only repeatable-read transaction', async () => {
    const harness = createHarness(successResponses());

    await expect(harness.service.capture(ROOT_ID, client)).resolves.toEqual({
      catalogRoot: {
        id: ROOT_ID,
        title: 'Catalog',
        spaceId: SPACE_ID,
        updatedAt: UPDATED_AT,
      },
      snapshotAt: SNAPSHOT_AT,
      pages: [
        expect.objectContaining({ id: ROOT_ID, spaceId: SPACE_ID }),
        expect.objectContaining({ id: CHILD_ID, spaceId: SPACE_ID }),
      ],
      scannedPageCount: 2,
      scannedContentBytes: 32,
    });

    expect(harness.responses).toHaveLength(0);
    const sql = harness.query.mock.calls
      .map(([statement]) =>
        String(statement).replace(/\s+/g, ' ').trim().toLowerCase(),
      )
      .join('\n');
    expect(sql).toContain(
      'start transaction isolation level repeatable read read only',
    );
    expect(sql).toContain('set_config');
    expect(sql).toContain('statement_timeout');
    expect(sql).toContain('transaction_timestamp()');
    expect(sql).toContain('mcp_client_space_permissions');
    expect(sql).toContain('group_users');
    expect(sql).toContain('with recursive "catalog_descendants"');
    expect(sql).toContain('with recursive permission_ancestors');
    expect(sql).toContain('page_access');
    expect(sql).toContain('commit');
  });

  it('accepts a database timestamp string and numeric content byte variants', async () => {
    const responses = successResponses();
    responses[0] = [{ snapshotAt: SNAPSHOT_AT.toISOString() }];
    responses[5] = [
      subtreeRow(ROOT_ID, null, '12'),
      subtreeRow(CHILD_ID, ROOT_ID, 20n),
    ];
    const harness = createHarness(responses);

    const snapshot = await harness.service.capture(ROOT_ID, client);

    expect(snapshot.snapshotAt).toEqual(SNAPSHOT_AT);
    expect(snapshot.scannedContentBytes).toBe(32);
  });

  it('rolls back when the database snapshot timestamp is unavailable', async () => {
    const harness = createHarness([[{ snapshotAt: 'invalid' }]]);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      InternalServerErrorException,
    );

    expect(lastSql(harness)).toBe('rollback');
  });

  it('masks a missing root as not found', async () => {
    const harness = createHarness([[{ snapshotAt: SNAPSHOT_AT }], []]);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
    expect(lastSql(harness)).toBe('rollback');
  });

  it.each([
    [{ canRead: false, canSearch: true }],
    [{ canRead: true, canSearch: false }],
    [undefined],
  ])('masks an insufficient MCP space permission', async (permission) => {
    const harness = createHarness([
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      permission ? [permission] : [],
    ]);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('masks an unmapped actor without querying the users table', async () => {
    const harness = createHarness([
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      [{ canRead: true, canSearch: true }],
    ]);

    await expect(
      harness.service.capture(ROOT_ID, { ...client, actorUserId: undefined }),
    ).rejects.toThrow(NotFoundException);
    expect(harness.responses).toHaveLength(0);
  });

  it('masks an unavailable actor', async () => {
    const harness = createHarness([
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      [{ canRead: true, canSearch: true }],
      [],
    ]);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('masks an actor without reader, writer, or admin space membership', async () => {
    const harness = createHarness([
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      [{ canRead: true, canSearch: true }],
      [{ id: ACTOR_ID }],
      [{ spaceId: SPACE_ID, role: 'guest' }],
    ]);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects a Catalog subtree that exceeds the scan page limit', async () => {
    const subtree = Array.from(
      { length: CATALOG_LIMITS.maxScannedPages + 1 },
      (_, index) =>
        subtreeRow(
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          index === 0 ? null : ROOT_ID,
          1,
        ),
    );
    const harness = createHarness(preSubtreeResponses(subtree));

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('rejects a Catalog subtree that exceeds the traversal depth limit', async () => {
    const harness = createHarness(
      preSubtreeResponses([
        subtreeRow(ROOT_ID, null, 1, CATALOG_LIMITS.maxTraversalDepth + 1),
      ]),
    );

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      `${CATALOG_LIMITS.maxTraversalDepth} levels`,
    );
  });

  it('masks rows that escape the requested workspace or space', async () => {
    const harness = createHarness(
      preSubtreeResponses([
        subtreeRow(ROOT_ID, null, 1),
        {
          ...subtreeRow(CHILD_ID, ROOT_ID, 1),
          workspaceId: '66666666-6666-4666-8666-666666666666',
        },
      ]),
    );

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects scanned Catalog content beyond the byte budget', async () => {
    const harness = createHarness(
      preSubtreeResponses([
        subtreeRow(ROOT_ID, null, CATALOG_LIMITS.maxScannedContentBytes + 1),
      ]),
    );

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('masks a root removed by inherited page permissions', async () => {
    const responses = preSubtreeResponses([subtreeRow(ROOT_ID, null, 1)]);
    responses.push([]);
    const harness = createHarness(responses);

    await expect(harness.service.capture(ROOT_ID, client)).rejects.toThrow(
      NotFoundException,
    );
  });

  function createHarness(responses: ScriptedRows[]): SnapshotHarness {
    const scripted = [...responses];
    const query = jest.fn(async (statement: string) => {
      const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        normalized.startsWith('start transaction') ||
        normalized === 'commit' ||
        normalized === 'rollback'
      ) {
        return { command: 'TRANSACTION', rowCount: 0, rows: [] };
      }
      if (
        normalized.includes('set_config') &&
        normalized.includes('statement_timeout')
      ) {
        return {
          command: 'SELECT',
          rowCount: 1,
          rows: [{ setConfig: '10000' }],
        };
      }
      const rows = scripted.shift();
      if (!rows) {
        throw new Error(`Unexpected SQL query: ${normalized}`);
      }
      return { command: 'SELECT', rowCount: rows.length, rows };
    });
    const clientConnection = {
      query,
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(async () => clientConnection),
      end: jest.fn(async () => undefined),
    };
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: pool as never }),
      plugins: [new CamelCasePlugin()],
    });
    databases.push(db);
    return {
      db,
      service: new McpCatalogSnapshotService(db as unknown as KyselyDB),
      query,
      responses: scripted,
    };
  }

  function successResponses(): ScriptedRows[] {
    return [
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      [{ canRead: true, canSearch: true }],
      [{ id: ACTOR_ID }],
      [{ spaceId: SPACE_ID, role: 'reader' }],
      [subtreeRow(ROOT_ID, null, 12), subtreeRow(CHILD_ID, ROOT_ID, 20)],
      [{ id: ROOT_ID }, { id: CHILD_ID }],
      [readablePage(ROOT_ID, null), readablePage(CHILD_ID, ROOT_ID)],
    ];
  }

  function preSubtreeResponses(subtree: ScriptedRows): ScriptedRows[] {
    return [
      [{ snapshotAt: SNAPSHOT_AT }],
      [rootRow()],
      [{ canRead: true, canSearch: true }],
      [{ id: ACTOR_ID }],
      [{ spaceId: SPACE_ID, role: 'admin' }],
      subtree,
    ];
  }

  function rootRow(): Record<string, unknown> {
    return {
      id: ROOT_ID,
      title: 'Catalog',
      spaceId: SPACE_ID,
      workspaceId: WORKSPACE_ID,
      updatedAt: UPDATED_AT,
    };
  }

  function subtreeRow(
    id: string,
    parentPageId: string | null,
    contentBytes: number | string | bigint,
    depth = parentPageId === null ? 0 : 1,
  ): Record<string, unknown> {
    return {
      id,
      title: id === ROOT_ID ? 'Catalog' : 'Child',
      parentPageId,
      spaceId: SPACE_ID,
      workspaceId: WORKSPACE_ID,
      updatedAt: UPDATED_AT,
      contentBytes,
      depth,
    };
  }

  function readablePage(
    id: string,
    parentPageId: string | null,
  ): Record<string, unknown> {
    return {
      id,
      title: id === ROOT_ID ? 'Catalog' : 'Child',
      parentPageId,
      spaceId: SPACE_ID,
      updatedAt: UPDATED_AT,
      content: { type: 'doc', content: [] },
    };
  }

  function lastSql(harness: SnapshotHarness): string {
    const calls = harness.query.mock.calls;
    return String(calls[calls.length - 1]?.[0])
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
});
