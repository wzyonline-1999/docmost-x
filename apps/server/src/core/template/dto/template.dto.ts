import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { ContentFormat } from '../../page/dto/create-page.dto';

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

export class TemplateVersionsDto extends TemplateIdDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListTemplatesDto extends PaginationOptions {
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsIn(['all', 'global', 'space'])
  scope?: 'all' | 'global' | 'space';

  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}

export class CreateTemplateDto {
  @IsString()
  @MaxLength(250)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsString()
  @MaxLength(2_000)
  purpose: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  useWhen?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  inputSchema?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  titleTemplate?: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((value) => value.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  icon?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsUUID()
  sourcePageId?: string;
}

export class UpdateTemplateDto {
  @IsUUID()
  templateId: string;

  @IsString()
  expectedUpdatedAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  purpose?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  useWhen?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  inputSchema?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  titleTemplate?: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((value) => value.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  icon?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class PublishTemplateDto {
  @IsUUID()
  templateId: string;

  @IsString()
  expectedUpdatedAt: string;
}

export class ArchiveTemplateDto extends PublishTemplateDto {}

export class DeleteTemplateDto extends PublishTemplateDto {}

export class RenderTemplateDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  key?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  version?: number;

  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase() ?? 'markdown')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;
}

export class InstantiateTemplateDto extends RenderTemplateDto {
  @IsUUID()
  targetSpaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}
