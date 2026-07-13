import {
  IMcpSpacePermission,
  McpPermissionField,
  McpSpacePermissionInput,
} from "@/features/mcp/types/mcp.types";

export const MCP_PERMISSION_COLUMNS: ReadonlyArray<{
  field: McpPermissionField;
  label: string;
}> = [
  { field: "canSearch", label: "Search" },
  { field: "canSemanticSearch", label: "Semantic" },
  { field: "canRead", label: "Read" },
  { field: "canCreate", label: "Create" },
  { field: "canUpdate", label: "Update" },
  { field: "canAppend", label: "Append" },
  { field: "canDelete", label: "Delete" },
  { field: "canRestore", label: "Restore" },
  { field: "canIndex", label: "Index" },
];

export type McpPermissionValues = Record<McpPermissionField, boolean>;

export type McpPermissionSelectionState = {
  checked: boolean;
  indeterminate: boolean;
};

export function getPermissionValues(
  permission?: Partial<IMcpSpacePermission>,
): McpPermissionValues {
  return MCP_PERMISSION_COLUMNS.reduce((result, column) => {
    result[column.field] = permission?.[column.field] ?? false;
    return result;
  }, {} as McpPermissionValues);
}

export function getPermissionSelectionState(
  values: ReadonlyArray<boolean>,
): McpPermissionSelectionState {
  const selectedCount = values.filter(Boolean).length;

  return {
    checked: values.length > 0 && selectedCount === values.length,
    indeterminate: selectedCount > 0 && selectedCount < values.length,
  };
}

export function buildPermissionUpdates(
  clientId: string,
  spaces: ReadonlyArray<{
    id: string;
    permission?: Partial<IMcpSpacePermission>;
  }>,
  changes: Partial<McpPermissionValues>,
): McpSpacePermissionInput[] {
  return spaces.flatMap(({ id, permission }) => {
    const current = getPermissionValues(permission);
    const hasChanges = Object.entries(changes).some(
      ([field, checked]) =>
        checked !== undefined &&
        current[field as McpPermissionField] !== checked,
    );

    if (!hasChanges) return [];

    return [
      {
        clientId,
        spaceId: id,
        ...current,
        ...changes,
      },
    ];
  });
}
