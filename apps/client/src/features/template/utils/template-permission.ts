import { SpaceRole } from "@/lib/types";

interface CanManageTemplateOptions {
  isAdmin: boolean;
  allowMemberTemplates: boolean;
  spaceId?: string | null;
  spaceRole?: SpaceRole | null;
}

export function canManageTemplate({
  isAdmin,
  allowMemberTemplates,
  spaceId,
  spaceRole,
}: CanManageTemplateOptions): boolean {
  if (isAdmin) return true;

  return Boolean(
    spaceId &&
    allowMemberTemplates &&
    spaceRole &&
    spaceRole !== SpaceRole.READER,
  );
}
