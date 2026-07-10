import { Navigate, Outlet } from "react-router-dom";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { UserRole } from "@/lib/types";

export default function AdminRoute() {
  const currentUser = useCurrentUser();

  if (currentUser.isLoading) return null;

  const role = currentUser.data?.user.role;
  const canManage = role === UserRole.ADMIN || role === UserRole.OWNER;

  return canManage ? <Outlet /> : <Navigate to="/home" replace />;
}
