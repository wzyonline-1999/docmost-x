import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import type { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpTokenService } from './mcp-token.service';

describe('McpTokenService', () => {
  const knownToken = 'dmost_mcp_known-token';
  const selectQuery = {
    selectAll: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
  };
  const insertQuery = {
    values: jest.fn().mockReturnThis(),
    returningAll: jest.fn().mockReturnThis(),
    executeTakeFirstOrThrow: jest.fn(),
  };
  const updateQuery = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const db = {
    selectFrom: jest.fn(() => selectQuery),
    insertInto: jest.fn(() => insertQuery),
    updateTable: jest.fn(() => updateQuery),
  };
  const environmentService = {
    isMcpEnabled: jest.fn(() => true),
    getMcpTokenHashSecret: jest.fn(() => 'test-hash-secret'),
  };

  let service: McpTokenService;
  let client: Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    environmentService.isMcpEnabled.mockReturnValue(true);
    environmentService.getMcpTokenHashSecret.mockReturnValue(
      'test-hash-secret',
    );
    updateQuery.execute.mockResolvedValue(undefined);
    service = new McpTokenService(
      db as unknown as KyselyDB,
      environmentService as unknown as EnvironmentService,
    );
    client = {
      id: 'client-1',
      workspaceId: 'workspace-1',
      name: 'Codex',
      tokenHash: service.hashToken(knownToken),
      tokenLastFour: 'oken',
      status: 'active',
      globalScopes: {},
      actorUserId: null,
      createdById: 'admin-1',
      ownerUserId: 'admin-1',
      scope: 'personal',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    selectQuery.executeTakeFirst.mockResolvedValue(client);
    insertQuery.executeTakeFirstOrThrow.mockResolvedValue(client);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates prefixed high-entropy tokens and exposes only the last four', () => {
    const first = service.generateToken();
    const second = service.generateToken();

    expect(first).toMatch(/^dmost_mcp_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(service.getTokenLastFour(first)).toBe(first.slice(-4));
  });

  it('fails closed when the token hash secret is missing', () => {
    environmentService.getMcpTokenHashSecret.mockReturnValueOnce(undefined);

    expect(() => service.hashToken(knownToken)).toThrow(
      InternalServerErrorException,
    );
  });

  it('uses constant-length hash comparison and rejects malformed hashes', () => {
    expect(service.isTokenHashMatch(knownToken, String(client.tokenHash))).toBe(
      true,
    );
    expect(service.isTokenHashMatch(knownToken, '00')).toBe(false);
  });

  it('creates a client without persisting or returning the raw token in the row', async () => {
    const result = await service.createClient({
      workspaceId: 'workspace-1',
      name: 'Codex',
      actorUserId: 'admin-1',
      createdById: 'admin-1',
      globalScopes: { read: true },
    });

    expect(result.client).toBe(client);
    expect(result.token).toMatch(/^dmost_mcp_/);
    expect(insertQuery.values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tokenLastFour: result.token.slice(-4),
        ownerUserId: 'admin-1',
        scope: 'personal',
      }),
    );
    expect(JSON.stringify(insertQuery.values.mock.calls)).not.toContain(
      result.token,
    );
  });

  it('rejects an explicitly personal client that impersonates another user', async () => {
    await expect(
      service.createClient({
        workspaceId: 'workspace-1',
        name: 'Impersonating client',
        scope: 'personal',
        ownerUserId: 'admin-1',
        actorUserId: 'actor-1',
        createdById: 'admin-1',
      }),
    ).rejects.toThrow('Personal MCP clients must act as their owner');

    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('rejects requests while MCP is disabled before querying clients', async () => {
    environmentService.isMcpEnabled.mockReturnValueOnce(false);

    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      ForbiddenException,
    );
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it.each(['', 'bad-token', 'dmost_wrong_prefix'])(
    'rejects malformed token %p before querying clients',
    async (token) => {
      await expect(service.authenticateToken(token)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(db.selectFrom).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown, deleted, or mismatched clients without touching usage', async () => {
    selectQuery.executeTakeFirst.mockResolvedValueOnce(undefined);
    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'Invalid MCP token',
    );

    selectQuery.executeTakeFirst.mockResolvedValueOnce({
      ...client,
      tokenHash: '00',
    });
    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'Invalid MCP token',
    );
    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('rejects a generator-shaped unknown token without touching usage', async () => {
    const unknownToken = `dmost_mcp_${'A'.repeat(43)}`;
    selectQuery.executeTakeFirst.mockResolvedValueOnce(undefined);

    await expect(service.authenticateToken(unknownToken)).rejects.toThrow(
      'Invalid MCP token',
    );

    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('rejects a formerly valid token after its client is soft deleted', async () => {
    selectQuery.executeTakeFirst
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce(undefined);

    await expect(service.authenticateToken(knownToken)).resolves.toBe(client);
    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'Invalid MCP token',
    );

    expect(updateQuery.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects the old token immediately after rotation and accepts only the new token', async () => {
    const rotatedToken = 'dmost_mcp_rotated-token';
    const rotatedClient = {
      ...client,
      tokenHash: service.hashToken(rotatedToken),
      tokenLastFour: 'oken',
    };
    selectQuery.executeTakeFirst
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(rotatedClient);

    await expect(service.authenticateToken(knownToken)).resolves.toBe(client);
    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'Invalid MCP token',
    );
    await expect(service.authenticateToken(rotatedToken)).resolves.toBe(
      rotatedClient,
    );
  });

  it.each([
    ['disabled', ForbiddenException, 'disabled'],
    ['expired', UnauthorizedException, 'expired'],
  ])('rejects a client with status %s', async (status, exception, message) => {
    selectQuery.executeTakeFirst.mockResolvedValueOnce({ ...client, status });
    const authentication = service.authenticateToken(knownToken);

    await expect(authentication).rejects.toThrow(exception);
    await expect(authentication).rejects.toThrow(message);
  });

  it('marks timestamp-expired clients and still rejects when status persistence fails', async () => {
    selectQuery.executeTakeFirst.mockResolvedValue({
      ...client,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'MCP token expired',
    );
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    updateQuery.execute.mockRejectedValueOnce(
      new Error('database password secret-token should not escape'),
    );
    await expect(service.authenticateToken(knownToken)).rejects.toThrow(
      'MCP token expired',
    );
    expect(warn).toHaveBeenCalledWith({
      event: 'mcp.token.mark_expired_failed',
      clientId: client.id,
      errorType: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
  });

  it('authenticates an active client and contains last-used update failures', async () => {
    await expect(service.authenticateToken(knownToken)).resolves.toBe(client);
    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUsedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    updateQuery.execute.mockRejectedValueOnce(
      new Error('database password secret-token should not escape'),
    );
    await expect(service.authenticateToken(knownToken)).resolves.toBe(client);
    expect(warn).toHaveBeenCalledWith({
      event: 'mcp.token.touch_last_used_failed',
      clientId: client.id,
      errorType: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
  });

  it('disables only the requested client in its workspace', async () => {
    await service.disableClient('client-1', 'workspace-1');

    expect(updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disabled' }),
    );
    expect(updateQuery.where).toHaveBeenCalledWith('id', '=', 'client-1');
    expect(updateQuery.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-1',
    );
    expect(updateQuery.where).toHaveBeenCalledWith('deletedAt', 'is', null);
  });
});
