import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import type { McpClientStatus } from '../types/mcp.types';

export class McpClientIdDto {
  @IsUUID()
  clientId!: string;
}

export class RotateMcpClientTokenDto extends McpClientIdDto {}

export class McpSpacePermissionDto {
  @IsUUID()
  spaceId!: string;

  @IsOptional()
  @IsBoolean()
  canSearch?: boolean;

  @IsOptional()
  @IsBoolean()
  canSemanticSearch?: boolean;

  @IsOptional()
  @IsBoolean()
  canRead?: boolean;

  @IsOptional()
  @IsBoolean()
  canCreate?: boolean;

  @IsOptional()
  @IsBoolean()
  canUpdate?: boolean;

  @IsOptional()
  @IsBoolean()
  canAppend?: boolean;

  @IsOptional()
  @IsBoolean()
  canDelete?: boolean;

  @IsOptional()
  @IsBoolean()
  canRestore?: boolean;

  @IsOptional()
  @IsBoolean()
  canIndex?: boolean;
}

export class CreateMcpClientDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => McpSpacePermissionDto)
  permissions?: McpSpacePermissionDto[];
}

export class ListMcpClientsDto extends PaginationOptions {
  @IsOptional()
  @IsString()
  @IsIn(['active', 'disabled', 'expired'])
  status?: McpClientStatus;
}

export class UpdateMcpClientDto extends McpClientIdDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'disabled'])
  status?: Extract<McpClientStatus, 'active' | 'disabled'>;
}

export class UpsertMcpClientSpacePermissionDto extends McpSpacePermissionDto {
  @IsUUID()
  clientId!: string;
}

export class DeleteMcpClientSpacePermissionDto extends McpClientIdDto {
  @IsUUID()
  spaceId!: string;
}

export class ListMcpAuditLogsDto extends PaginationOptions {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  event?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  toolName?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  resourceType?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  resourceId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
