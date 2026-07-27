import { ForbiddenException } from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { McpAdminController } from './mcp-admin.controller';
import { ListMcpAuditLogsDto, ListMcpClientsDto } from './dto/mcp-admin.dto';
import { McpAdminService } from './services/mcp-admin.service';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';

describe('McpAdminController', () => {
  const adminService = {
    listClients: jest.fn(),
    getClient: jest.fn(),
    createClient: jest.fn(),
    updateClient: jest.fn(),
    disableClient: jest.fn(),
    deleteClient: jest.fn(),
    rotateClientToken: jest.fn(),
    listAuditLogs: jest.fn(),
    listRepairRecords: jest.fn(),
    retryRepairRecord: jest.fn(),
    discardRepairRecord: jest.fn(),
    getPermissionMatrix: jest.fn(),
    bulkUpsertSpacePermissions: jest.fn(),
    upsertSpacePermission: jest.fn(),
    deleteSpacePermission: jest.fn(),
  };
  const workspaceAbility = {
    createForUser: jest.fn(),
  };
  const workspace = { id: 'workspace-1' };
  const adminUser = { id: 'user-1', role: 'admin' };
  const adminPrincipal = {
    userId: 'user-1',
    isWorkspaceOwner: false,
  };

  let controller: McpAdminController;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceAbility.createForUser.mockReturnValue({
      cannot: jest.fn(() => false),
    });
    adminService.createClient.mockResolvedValue({
      token: 'dmost_mcp_secret',
      client: { id: 'client-1', tokenLastFour: 'cret' },
      permissions: [],
    });
    adminService.listClients.mockResolvedValue({ items: [], meta: {} });
    adminService.rotateClientToken.mockResolvedValue({
      token: 'dmost_mcp_rotated',
      client: { id: 'client-1', tokenLastFour: 'ated' },
      permissions: [],
    });
    adminService.listAuditLogs.mockResolvedValue({ items: [], meta: {} });
    adminService.listRepairRecords.mockResolvedValue({ items: [], meta: {} });
    adminService.getPermissionMatrix.mockResolvedValue({
      clientId: 'client-1',
      spaces: [],
    });
    controller = new McpAdminController(
      adminService as unknown as McpAdminService,
      workspaceAbility as unknown as WorkspaceAbilityFactory,
    );
  });

  it('creates a client for workspace API admins', async () => {
    const response = await controller.createClient(
      { name: 'Codex MCP' },
      adminUser as unknown as User,
      workspace as unknown as Workspace,
    );

    expect(response).toMatchObject({
      token: 'dmost_mcp_secret',
      client: { id: 'client-1' },
    });
    expect(adminService.createClient).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      { name: 'Codex MCP' },
    );
  });

  it('rotates a client token for workspace API admins', async () => {
    const response = await controller.rotateClientToken(
      { clientId: 'client-1' },
      adminUser as unknown as User,
      workspace as unknown as Workspace,
    );

    expect(response).toMatchObject({
      token: 'dmost_mcp_rotated',
      client: { id: 'client-1' },
    });
    expect(adminService.rotateClientToken).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      'client-1',
    );
  });

  it('lists audit logs for workspace API admins', async () => {
    const dto = Object.assign(new ListMcpAuditLogsDto(), {
      clientId: 'client-1',
    });

    const response = await controller.listAuditLogs(
      dto,
      adminUser as unknown as User,
      workspace as unknown as Workspace,
    );

    expect(response).toEqual({ items: [], meta: {} });
    expect(adminService.listAuditLogs).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      dto,
    );
  });

  it('returns the effective permission matrix for workspace API admins', async () => {
    const dto = {
      clientId: 'client-1',
      spaceIds: ['space-1'],
    };

    await expect(
      controller.getPermissionMatrix(
        dto,
        adminUser as unknown as User,
        workspace as unknown as Workspace,
      ),
    ).resolves.toEqual({
      clientId: 'client-1',
      spaces: [],
    });
    expect(adminService.getPermissionMatrix).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      dto,
    );
  });

  it('forwards repair-record actions with the current admin principal', async () => {
    const expectedUpdatedAt = '2026-07-27T08:00:00.000Z';
    adminService.retryRepairRecord.mockResolvedValueOnce({
      id: 'record-1',
      status: 'needs_reconciliation',
    });

    await expect(
      controller.retryRepairRecord(
        { recordId: 'record-1', expectedUpdatedAt },
        adminUser as unknown as User,
        workspace as unknown as Workspace,
      ),
    ).resolves.toMatchObject({ status: 'needs_reconciliation' });
    expect(adminService.retryRepairRecord).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      { recordId: 'record-1', expectedUpdatedAt },
    );

    await controller.discardRepairRecord(
      { recordId: 'record-1', expectedUpdatedAt, confirm: true },
      adminUser as unknown as User,
      workspace as unknown as Workspace,
    );
    expect(adminService.discardRepairRecord).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      { recordId: 'record-1', expectedUpdatedAt, confirm: true },
    );
  });

  it('forwards an atomic permission batch for workspace API admins', async () => {
    const dto = {
      clientId: 'client-1',
      permissions: [
        { spaceId: 'space-1', canRead: true },
        { spaceId: 'space-2', canSearch: true },
      ],
    };
    adminService.bulkUpsertSpacePermissions.mockResolvedValueOnce({
      items: [],
      meta: { count: 2 },
    });

    await expect(
      controller.bulkUpsertSpacePermissions(
        dto,
        adminUser as unknown as User,
        workspace as unknown as Workspace,
      ),
    ).resolves.toEqual({ items: [], meta: { count: 2 } });
    expect(adminService.bulkUpsertSpacePermissions).toHaveBeenCalledWith(
      'workspace-1',
      adminPrincipal,
      dto,
    );
  });

  it('marks workspace owners in the MCP management principal', async () => {
    const owner = { id: 'owner-1', role: 'owner' };
    await controller.listClients(
      new ListMcpClientsDto(),
      owner as unknown as User,
      workspace as unknown as Workspace,
    );

    expect(adminService.listClients).toHaveBeenCalledWith(
      'workspace-1',
      { userId: 'owner-1', isWorkspaceOwner: true },
      expect.any(ListMcpClientsDto),
    );
  });

  it.each([
    [
      'list clients',
      () =>
        controller.listClients(
          new ListMcpClientsDto(),
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.listClients,
    ],
    [
      'get client',
      () =>
        controller.getClient(
          { clientId: 'client-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.getClient,
    ],
    [
      'create client',
      () =>
        controller.createClient(
          { name: 'Blocked client' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.createClient,
    ],
    [
      'update client',
      () =>
        controller.updateClient(
          { clientId: 'client-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.updateClient,
    ],
    [
      'disable client',
      () =>
        controller.disableClient(
          { clientId: 'client-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.disableClient,
    ],
    [
      'delete client',
      () =>
        controller.deleteClient(
          { clientId: 'client-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.deleteClient,
    ],
    [
      'rotate token',
      () =>
        controller.rotateClientToken(
          { clientId: 'client-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.rotateClientToken,
    ],
    [
      'list audit logs',
      () =>
        controller.listAuditLogs(
          new ListMcpAuditLogsDto(),
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.listAuditLogs,
    ],
    [
      'list repair records',
      () =>
        controller.listRepairRecords(
          { limit: 20 } as never,
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.listRepairRecords,
    ],
    [
      'retry repair record',
      () =>
        controller.retryRepairRecord(
          {
            recordId: 'record-1',
            expectedUpdatedAt: '2026-07-27T08:00:00.000Z',
          },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.retryRepairRecord,
    ],
    [
      'discard repair record',
      () =>
        controller.discardRepairRecord(
          {
            recordId: 'record-1',
            expectedUpdatedAt: '2026-07-27T08:00:00.000Z',
            confirm: true,
          },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.discardRepairRecord,
    ],
    [
      'get permission matrix',
      () =>
        controller.getPermissionMatrix(
          { clientId: 'client-1', spaceIds: ['space-1'] },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.getPermissionMatrix,
    ],
    [
      'bulk upsert permissions',
      () =>
        controller.bulkUpsertSpacePermissions(
          {
            clientId: 'client-1',
            permissions: [{ spaceId: 'space-1', canRead: true }],
          },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.bulkUpsertSpacePermissions,
    ],
    [
      'upsert permission',
      () =>
        controller.upsertSpacePermission(
          { clientId: 'client-1', spaceId: 'space-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.upsertSpacePermission,
    ],
    [
      'delete permission',
      () =>
        controller.deleteSpacePermission(
          { clientId: 'client-1', spaceId: 'space-1' },
          adminUser as unknown as User,
          workspace as unknown as Workspace,
        ),
      adminService.deleteSpacePermission,
    ],
  ])(
    'blocks users that cannot manage workspace API credentials from %s',
    (_name, invoke, serviceMethod) => {
      workspaceAbility.createForUser.mockReturnValue({
        cannot: jest.fn(() => true),
      });

      expect(invoke).toThrow(ForbiddenException);
      expect(serviceMethod).not.toHaveBeenCalled();
    },
  );
});
