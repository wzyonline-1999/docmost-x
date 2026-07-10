import { KyselyDB } from '@docmost/db/types/kysely.types';
import { McpAuditService } from './mcp-audit.service';

describe('McpAuditService', () => {
  const execute = jest.fn();
  const values = jest.fn(() => ({ execute }));
  const insertInto = jest.fn(() => ({ values }));
  const metricsService = {
    recordAuditFailure: jest.fn(),
  };

  let service: McpAuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue(undefined);
    service = new McpAuditService(
      {
        insertInto,
      } as unknown as KyselyDB,
      metricsService as never,
    );
  });

  it('stores blank IP addresses as null for inet columns', async () => {
    await service.log({
      workspaceId: 'workspace-1',
      event: 'mcp.page.created',
      resourceType: 'page',
      toolName: 'create_page',
      ipAddress: ' ',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: null,
      }),
    );
  });

  it.each(['127.0.0.1', '2001:db8::1'])(
    'preserves valid %s audit IP addresses',
    async (ipAddress) => {
      await service.log({
        workspaceId: 'workspace-1',
        event: 'mcp.page.created',
        resourceType: 'page',
        toolName: 'create_page',
        ipAddress,
      });

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress }),
      );
    },
  );

  it('reports a successful best-effort audit write', async () => {
    await expect(
      service.tryLog({
        workspaceId: 'workspace-1',
        event: 'mcp.page.update',
        resourceType: 'page',
        toolName: 'update_page',
      }),
    ).resolves.toBe(true);
  });

  it('stores permission denials with action metadata', async () => {
    await service.logPermissionDenied({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      actorUserId: 'user-1',
      toolName: 'update_page',
      action: 'update',
      spaceId: 'space-1',
      resourceType: 'page',
      resourceId: 'page-1',
      requestId: 'request-1',
      ipAddress: '127.0.0.1',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mcp.permission.denied',
        resourceType: 'page',
        resourceId: 'page-1',
        metadata: { action: 'update' },
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('contains audit persistence failures for an already-completed mutation', async () => {
    execute.mockRejectedValueOnce(
      new Error('database password secret-token should not escape'),
    );
    const loggerError = jest
      .spyOn(
        (
          service as unknown as {
            logger: { error: (message: string) => void };
          }
        ).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(
      service.tryLog({
        workspaceId: 'workspace-1',
        event: 'mcp.page.update',
        resourceType: 'page',
        resourceId: 'page-1',
        toolName: 'update_page',
      }),
    ).resolves.toBe(false);
    expect(loggerError).toHaveBeenCalledWith({
      event: 'mcp.audit.persist_failed',
      auditEvent: 'mcp.page.update',
      resourceType: 'page',
      resourceId: 'page-1',
      errorType: 'Error',
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'secret-token',
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'database password',
    );
    expect(metricsService.recordAuditFailure).toHaveBeenCalledWith(
      'mcp.page.update',
    );
  });
});
