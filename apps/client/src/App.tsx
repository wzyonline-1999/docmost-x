import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import { Error404 } from "@/components/ui/error-404.tsx";
import { useTrackOrigin } from "@/hooks/use-track-origin";

const Layout = lazy(() => import("@/components/layouts/global/layout.tsx"));
const ShareLayout = lazy(
  () => import("@/features/share/components/share-layout.tsx"),
);
const AdminRoute = lazy(() => import("@/components/auth/admin-route"));
const SetupWorkspace = lazy(() => import("@/pages/auth/setup-workspace.tsx"));
const LoginPage = lazy(() => import("@/pages/auth/login"));
const InviteSignup = lazy(() => import("@/pages/auth/invite-signup.tsx"));
const ForgotPassword = lazy(() => import("@/pages/auth/forgot-password.tsx"));
const PasswordReset = lazy(() => import("@/pages/auth/password-reset"));
const Home = lazy(() => import("@/pages/dashboard/home"));
const Page = lazy(() => import("@/pages/page/page"));
const PageRedirect = lazy(() => import("@/pages/page/page-redirect.tsx"));
const SharedPage = lazy(() => import("@/pages/share/shared-page.tsx"));
const ShareRedirect = lazy(() => import("@/pages/share/share-redirect.tsx"));
const SpacesPage = lazy(() => import("@/pages/spaces/spaces.tsx"));
const FavoritesPage = lazy(() => import("@/pages/favorites/favorites-page"));
const LabelPage = lazy(() => import("@/pages/label/label-page"));
const SpaceHome = lazy(() => import("@/pages/space/space-home.tsx"));
const SpaceTrash = lazy(() => import("@/pages/space/space-trash.tsx"));
const AccountSettings = lazy(
  () => import("@/pages/settings/account/account-settings"),
);
const AccountPreferences = lazy(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
const WorkspaceMembers = lazy(
  () => import("@/pages/settings/workspace/workspace-members"),
);
const WorkspaceSettings = lazy(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
const Groups = lazy(() => import("@/pages/settings/group/groups"));
const GroupInfo = lazy(() => import("@/pages/settings/group/group-info"));
const Spaces = lazy(() => import("@/pages/settings/space/spaces.tsx"));
const Shares = lazy(() => import("@/pages/settings/shares/shares.tsx"));
const McpSettings = lazy(() => import("@/pages/settings/mcp/mcp-settings"));

function routeElement(
  Component: LazyExoticComponent<ComponentType>,
): ReactNode {
  return (
    <Suspense
      fallback={
        <Center mih="40vh" aria-label="Loading page">
          <Loader size="sm" />
        </Center>
      }
    >
      <Component />
    </Suspense>
  );
}

export default function App() {
  useTrackOrigin();

  return (
    <>
      <Routes>
        <Route index element={<Navigate to="/home" />} />
        <Route path={"/login"} element={routeElement(LoginPage)} />
        <Route
          path={"/invites/:invitationId"}
          element={routeElement(InviteSignup)}
        />
        <Route
          path={"/forgot-password"}
          element={routeElement(ForgotPassword)}
        />
        <Route path={"/password-reset"} element={routeElement(PasswordReset)} />
        <Route
          path={"/setup/register"}
          element={routeElement(SetupWorkspace)}
        />

        <Route element={routeElement(ShareLayout)}>
          <Route
            path={"/share/:shareId/p/:pageSlug"}
            element={routeElement(SharedPage)}
          />
          <Route
            path={"/share/p/:pageSlug"}
            element={routeElement(SharedPage)}
          />
        </Route>

        <Route path={"/share/:shareId"} element={routeElement(ShareRedirect)} />
        <Route path={"/p/:pageSlug"} element={routeElement(PageRedirect)} />

        <Route element={routeElement(Layout)}>
          <Route path={"/home"} element={routeElement(Home)} />
          <Route path={"/spaces"} element={routeElement(SpacesPage)} />
          <Route path={"/favorites"} element={routeElement(FavoritesPage)} />
          <Route
            path={"/labels/:labelName"}
            element={routeElement(LabelPage)}
          />
          <Route path={"/s/:spaceSlug"} element={routeElement(SpaceHome)} />
          <Route
            path={"/s/:spaceSlug/trash"}
            element={routeElement(SpaceTrash)}
          />
          <Route
            path={"/s/:spaceSlug/p/:pageSlug"}
            element={routeElement(Page)}
          />

          <Route path={"/settings"}>
            <Route
              path={"account/profile"}
              element={routeElement(AccountSettings)}
            />
            <Route
              path={"account/preferences"}
              element={routeElement(AccountPreferences)}
            />
            <Route
              path={"workspace"}
              element={routeElement(WorkspaceSettings)}
            />
            <Route path={"members"} element={routeElement(WorkspaceMembers)} />
            <Route path={"groups"} element={routeElement(Groups)} />
            <Route path={"groups/:groupId"} element={routeElement(GroupInfo)} />
            <Route path={"spaces"} element={routeElement(Spaces)} />
            <Route path={"sharing"} element={routeElement(Shares)} />
            <Route element={routeElement(AdminRoute)}>
              <Route path={"mcp"} element={routeElement(McpSettings)} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Error404 />} />
      </Routes>
    </>
  );
}
