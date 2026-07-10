import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIN_LINE_PERCENT = 90;
const MIN_BRANCH_PERCENT = 80;
const CORE_SECURITY_FILES = [
  'mcp-actor-access.service.ts',
  'mcp-audit.service.ts',
  'mcp-idempotency.service.ts',
  'mcp-permission.service.ts',
  'mcp-rate-limit.service.ts',
  'mcp-token.service.ts',
  'mcp-vector-eligibility.service.ts',
];

type CoverageMetric = {
  covered: number;
  total: number;
};

type CoverageEntry = {
  lines: CoverageMetric;
  branches: CoverageMetric;
};

async function main(): Promise<void> {
  const coveragePath = path.resolve(
    __dirname,
    '../coverage/coverage-summary.json',
  );
  const summary = JSON.parse(await readFile(coveragePath, 'utf8')) as Record<
    string,
    CoverageEntry
  >;
  const entries = Object.entries(summary).filter(([filePath]) =>
    CORE_SECURITY_FILES.some((fileName) => filePath.endsWith(fileName)),
  );

  assert.equal(
    entries.length,
    CORE_SECURITY_FILES.length,
    'Coverage summary is missing one or more core MCP security services',
  );

  const lines = sumMetric(entries, 'lines');
  const branches = sumMetric(entries, 'branches');
  const linePercent = percent(lines);
  const branchPercent = percent(branches);

  process.stdout.write(
    `${JSON.stringify(
      {
        files: CORE_SECURITY_FILES.length,
        lines: { ...lines, percent: linePercent },
        branches: { ...branches, percent: branchPercent },
        thresholds: {
          lines: MIN_LINE_PERCENT,
          branches: MIN_BRANCH_PERCENT,
        },
      },
      null,
      2,
    )}\n`,
  );

  assert(
    linePercent >= MIN_LINE_PERCENT,
    `Core MCP security line coverage ${linePercent}% is below ${MIN_LINE_PERCENT}%`,
  );
  assert(
    branchPercent >= MIN_BRANCH_PERCENT,
    `Core MCP security branch coverage ${branchPercent}% is below ${MIN_BRANCH_PERCENT}%`,
  );
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

main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`MCP coverage gate failed (${errorType})\n`);
  process.exitCode = 1;
});
