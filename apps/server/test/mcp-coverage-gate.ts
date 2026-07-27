import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type CoverageMetric = {
  covered: number;
  total: number;
};

type CoverageEntry = {
  lines: CoverageMetric;
  branches: CoverageMetric;
};

type CoverageGroup = {
  name: string;
  files: string[];
  minimum: {
    lines: number;
    branches: number;
  };
};

const COVERAGE_GROUPS: CoverageGroup[] = [
  {
    name: 'MCP security and distributed coordination',
    files: [
      'core/mcp/services/mcp-actor-access.service.ts',
      'core/mcp/services/mcp-audit.service.ts',
      'core/mcp/services/mcp-distributed-task.service.ts',
      'core/mcp/services/mcp-idempotency.service.ts',
      'core/mcp/services/mcp-permission.service.ts',
      'core/mcp/services/mcp-rate-limit.service.ts',
      'core/mcp/services/mcp-token.service.ts',
      'core/mcp/services/mcp-tool-input-validator.ts',
      'core/mcp/services/mcp-vector-eligibility.service.ts',
    ],
    minimum: {
      lines: 90,
      branches: 80,
    },
  },
  {
    name: 'MCP external boundaries and durable jobs',
    files: [
      'core/mcp/mcp.controller.ts',
      'core/mcp/developer-api.controller.ts',
      'core/mcp/mcp-admin.controller.ts',
      'core/mcp/services/mcp-admin.service.ts',
      'core/mcp/services/mcp-metrics.service.ts',
      'core/mcp/services/mcp-retention.service.ts',
      'core/mcp/services/mcp-tool.service.ts',
      'core/mcp/services/mcp-vector-index.service.ts',
      'core/mcp/services/mcp-vector-reconciliation.service.ts',
    ],
    minimum: {
      lines: 75,
      branches: 70,
    },
  },
  {
    name: 'Web search',
    files: [
      'core/search/search.service.ts',
      'core/search/search-rate-limit.service.ts',
    ],
    minimum: {
      lines: 70,
      branches: 65,
    },
  },
  {
    name: 'Attachment lifecycle',
    files: [
      'core/attachment/services/attachment.service.ts',
      'core/attachment/services/attachment-lifecycle.service.ts',
      'core/attachment/services/attachment-content-index.service.ts',
    ],
    minimum: {
      lines: 50,
      branches: 65,
    },
  },
];

async function main(): Promise<void> {
  const coveragePath = path.resolve(
    __dirname,
    '../coverage/coverage-summary.json',
  );
  const summary = JSON.parse(await readFile(coveragePath, 'utf8')) as Record<
    string,
    CoverageEntry
  >;
  const results = COVERAGE_GROUPS.map((group) => evaluateGroup(summary, group));

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

function evaluateGroup(
  summary: Record<string, CoverageEntry>,
  group: CoverageGroup,
) {
  const entries = group.files.map((filePath) => {
    const matches = Object.entries(summary).filter(([coveragePath]) =>
      normalize(coveragePath).endsWith(filePath),
    );
    assert.equal(
      matches.length,
      1,
      `${group.name} coverage expected one entry for ${filePath}, found ${matches.length}`,
    );
    return matches[0];
  });
  const lines = sumMetric(entries, 'lines');
  const branches = sumMetric(entries, 'branches');
  const linePercent = percent(lines);
  const branchPercent = percent(branches);

  assert(
    linePercent >= group.minimum.lines,
    `${group.name} line coverage ${linePercent}% is below ${group.minimum.lines}%`,
  );
  assert(
    branchPercent >= group.minimum.branches,
    `${group.name} branch coverage ${branchPercent}% is below ${group.minimum.branches}%`,
  );

  return {
    group: group.name,
    files: group.files.length,
    lines: { ...lines, percent: linePercent },
    branches: { ...branches, percent: branchPercent },
    thresholds: group.minimum,
  };
}

function sumMetric(
  entries: Array<[string, CoverageEntry]>,
  metric: keyof CoverageEntry,
): CoverageMetric {
  return entries.reduce(
    (total, [, entry]) => ({
      covered: total.covered + entry[metric].covered,
      total: total.total + entry[metric].total,
    }),
    { covered: 0, total: 0 },
  );
}

function percent(metric: CoverageMetric): number {
  return Number(((metric.covered / metric.total) * 100).toFixed(2));
}

function normalize(filePath: string): string {
  return filePath.replaceAll(path.sep, '/');
}

main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`Quality coverage gate failed (${errorType})\n`);
  process.exitCode = 1;
});
