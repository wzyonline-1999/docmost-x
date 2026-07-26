import { Space } from '@docmost/db/types/entity.types';

export class SearchBreadcrumbDto {
  id: string;
  slugId: string;
  title: string;
  isBase: boolean;
}

export class SearchResponseDto {
  id: string;
  title: string;
  icon: string;
  parentPageId: string | null;
  creatorId: string;
  rank: number;
  highlight: string;
  createdAt: Date;
  updatedAt: Date;
  space: Partial<Space>;
  breadcrumbs: SearchBreadcrumbDto[];
  source?: 'keyword' | 'semantic' | 'hybrid';
  scores?: {
    keyword?: number;
    semantic?: number;
    recency?: number;
    final: number;
  };
}

export class AdvancedSearchResponseDto {
  items: SearchResponseDto[];
  mode: 'keyword' | 'semantic' | 'hybrid';
  semanticAvailable: boolean;
  fallback?: 'keyword';
}
