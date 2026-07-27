import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsIn,
  Max,
  Min,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';

export class SearchDTO {
  @IsNotEmpty()
  @IsString()
  @MaxLength(10_000)
  query: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsUUID()
  rootPageId?: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(900)
  offset?: number;
}

export class SearchShareDTO extends OmitType(SearchDTO, [
  'rootPageId',
  'spaceId',
] as const) {
  @IsNotEmpty()
  @IsString()
  shareId: string;
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export class AdvancedSearchDTO extends SearchDTO {
  @IsOptional()
  @IsIn(['keyword', 'semantic', 'hybrid'])
  mode?: SearchMode;
}

export class SearchSuggestionDTO {
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
