import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { UserRole } from '../../common/helpers/types/permission';
import {
  CreateMcpClientDto,
  DeleteMcpClientSpacePermissionDto,
  GetMcpPermissionMatrixDto,
  ListMcpAuditLogsDto,
  ListMcpClientsDto,
  McpClientIdDto,
  RotateMcpClientTokenDto,
  UpdateMcpClientDto,
  UpsertMcpClientSpacePermissionDto,
} from './dto/mcp-admin.dto';
import { McpAdminService } from './services/mcp-admin.service';
import type { McpAdminPrincipal } from './types/mcp.types';

@UseGuards(JwtAuthGuard)
@Controller('mcp/admin')
export class McpAdminController {
  constructor(
    private readonly mcpAdminService: McpAdminService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('clients')
  listClients(
    @Body() dto: ListMcpClientsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.listClients(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/info')
  getClient(
    @Body() dto: McpClientIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.getClient(
      workspace.id,
      this.toPrincipal(user),
      dto.clientId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/create')
  createClient(
    @Body() dto: CreateMcpClientDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.createClient(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/update')
  updateClient(
    @Body() dto: UpdateMcpClientDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.updateClient(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/disable')
  disableClient(
    @Body() dto: McpClientIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.disableClient(
      workspace.id,
      this.toPrincipal(user),
      dto.clientId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/delete')
  deleteClient(
    @Body() dto: McpClientIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.deleteClient(
      workspace.id,
      this.toPrincipal(user),
      dto.clientId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/rotate-token')
  rotateClientToken(
    @Body() dto: RotateMcpClientTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.rotateClientToken(
      workspace.id,
      this.toPrincipal(user),
      dto.clientId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('audit-logs')
  listAuditLogs(
    @Body() dto: ListMcpAuditLogsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.listAuditLogs(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/permissions/matrix')
  getPermissionMatrix(
    @Body() dto: GetMcpPermissionMatrixDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.getPermissionMatrix(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/permissions/upsert')
  upsertSpacePermission(
    @Body() dto: UpsertMcpClientSpacePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.upsertSpacePermission(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/permissions/delete')
  deleteSpacePermission(
    @Body() dto: DeleteMcpClientSpacePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManageMcp(user, workspace);
    return this.mcpAdminService.deleteSpacePermission(
      workspace.id,
      this.toPrincipal(user),
      dto,
    );
  }

  private assertCanManageMcp(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API)) {
      throw new ForbiddenException();
    }
  }

  private toPrincipal(user: User): McpAdminPrincipal {
    return {
      userId: user.id,
      isWorkspaceOwner: user.role === UserRole.OWNER,
    };
  }
}
