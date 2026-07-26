import type { IPageSearch } from "@/features/search/types/search.types";

type SearchPathSource = Pick<IPageSearch, "space" | "breadcrumbs">;

export function buildPageSearchPath(
  result: SearchPathSource,
  includeSpace: boolean,
  formatPageTitle: (title: string, isBase: boolean) => string,
): string[] {
  const path: string[] = [];

  if (includeSpace && result.space?.name) {
    path.push(result.space.name);
  }

  for (const breadcrumb of result.breadcrumbs ?? []) {
    path.push(formatPageTitle(breadcrumb.title, breadcrumb.isBase));
  }

  return path;
}
