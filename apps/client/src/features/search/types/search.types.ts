import { IUser } from "@/features/user/types/user.types.ts";
import { IGroup } from "@/features/group/types/group.types.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { IPage } from "@/features/page/types/page.types.ts";

export interface IPageSearch {
  id: string;
  title: string;
  icon: string;
  parentPageId: string | null;
  slugId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: number;
  highlight: string;
  source?: SearchMode;
  scores?: {
    keyword?: number;
    semantic?: number;
    recency?: number;
    final: number;
  };
  space: Partial<ISpace>;
  breadcrumbs: Array<{
    id: string;
    slugId: string;
    title: string;
    isBase: boolean;
  }>;
}

export interface SearchSuggestionParams {
  query: string;
  includeUsers?: boolean;
  includeGroups?: boolean;
  includePages?: boolean;
  spaceId?: string;
  limit?: number;
}

export interface ISuggestionResult {
  users?: Partial<IUser[]>;
  groups?: Partial<IGroup[]>;
  pages?: Partial<IPage[]>;
}

export interface IPageSearchParams {
  query: string;
  spaceId?: string;
  rootPageId?: string;
  shareId?: string;
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface IAdvancedPageSearchParams extends IPageSearchParams {
  mode: SearchMode;
}

export interface IAdvancedPageSearchResponse {
  items: IPageSearch[];
  mode: SearchMode;
  semanticAvailable: boolean;
  fallback?: "keyword";
}

export interface IAttachmentSearch {
  id: string;
  fileName: string;
  pageId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: string;
  highlight: string;
  space: {
    id: string;
    name: string;
    slug: string;
    icon: string;
  };
  page: {
    id: string;
    title: string;
    slugId: string;
  };
}
