import { UserProvider } from "@/features/user/user-provider.tsx";
import { Outlet, useParams } from "react-router-dom";
import GlobalAppShell from "@/components/layouts/global/global-app-shell.tsx";
import { PosthogUser } from "@/oss/components/posthog-user.tsx";
import { isCloud } from "@/lib/config.ts";
import { SearchSpotlight } from "@/features/search/components/search-spotlight.tsx";
import React from "react";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";

export default function Layout() {
  const { spaceSlug, pageSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const { data: page } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });

  return (
    <UserProvider>
      <GlobalAppShell>
        <Outlet />
      </GlobalAppShell>
      {isCloud() && <PosthogUser />}
      <SearchSpotlight
        key={`${space?.id ?? "workspace"}:${page?.id ?? "index"}`}
        spaceId={space?.id}
        currentPage={page}
      />
    </UserProvider>
  );
}
