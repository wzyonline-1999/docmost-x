export type McpAuditDiffEntry = {
  path: string;
  before: unknown;
  after: unknown;
};

const MAX_DIFF_DEPTH = 5;

export function buildMcpAuditDiff(
  before: unknown,
  after: unknown,
): McpAuditDiffEntry[] {
  return compareAuditValues(before, after, "", 0);
}

function compareAuditValues(
  before: unknown,
  after: unknown,
  path: string,
  depth: number,
): McpAuditDiffEntry[] {
  if (auditValuesEqual(before, after)) {
    return [];
  }

  if (
    depth < MAX_DIFF_DEPTH &&
    (isAuditRecord(before) || isAuditRecord(after))
  ) {
    const beforeRecord = isAuditRecord(before) ? before : {};
    const afterRecord = isAuditRecord(after) ? after : {};
    const keys = [
      ...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]),
    ].sort((left, right) => left.localeCompare(right));

    return keys.flatMap((key) =>
      compareAuditValues(
        beforeRecord[key],
        afterRecord[key],
        path ? `${path}.${key}` : key,
        depth + 1,
      ),
    );
  }

  return [{ path: path || "value", before, after }];
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function auditValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
