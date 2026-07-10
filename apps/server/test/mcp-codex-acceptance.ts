import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const baseUrl = process.env.MCP_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3111';
const adminEmail =
  process.env.MCP_ACCEPTANCE_ADMIN_EMAIL ?? 'mcp-acceptance@example.test';
const adminPassword =
  process.env.MCP_ACCEPTANCE_ADMIN_PASSWORD ?? 'AcceptanceOnly123!';
const codexBinary = process.env.MCP_ACCEPTANCE_CODEX_BIN ?? 'codex';
const codexModel = process.env.MCP_ACCEPTANCE_CODEX_MODEL ?? 'gpt-5.4-mini';
const codexApiBaseUrl = process.env.MCP_ACCEPTANCE_OPENAI_BASE_URL?.trim();
const codexApiKeyVariable = 'MCP_ACCEPTANCE_OPENAI_API_KEY';
const rateLimitMax = Number(process.env.MCP_ACCEPTANCE_RATE_LIMIT_MAX ?? '20');
const rateLimitWindowMs = Number(
  process.env.MCP_ACCEPTANCE_RATE_LIMIT_WINDOW_MS ?? '2000',
);
const codexTimeoutMs = Number(
  process.env.MCP_ACCEPTANCE_CODEX_TIMEOUT_MS ?? '180000',
);
const stamp = Date.now().toString();

type JsonRecord = Record<string, unknown>;

type JsonRpcResponse = {
  result?: JsonRecord;
  error?: {
    code?: number;
    message?: string;
  };
};

let cookie = '';

async function main(): Promise<void> {
  assert(Number.isInteger(rateLimitMax) && rateLimitMax > 0);
  assert(Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0);
  assert(Number.isFinite(codexTimeoutMs) && codexTimeoutMs > 0);
  assert(
    !codexApiBaseUrl || process.env[codexApiKeyVariable],
    `${codexApiKeyVariable} is required with MCP_ACCEPTANCE_OPENAI_BASE_URL`,
  );

  const { user, workspace } = await loginOrSetup();
  const space = await apiPost<JsonRecord>('/api/spaces/create', {
    name: `Codex acceptance ${stamp}`,
    slug: `codex_acceptance_${stamp}`,
    description: 'Non-sensitive disposable MCP acceptance space',
  });
  const spaceId = requireString(space, 'id');
  const client = await createClient(user, spaceId, `Codex CLI ${stamp}`);
  const token = requireString(client, 'token');
  const publicClient = requireRecord(client.client, 'client');
  const clientId = requireString(publicClient, 'id');
  const beacon = `codex acceptance beacon ${stamp}`;

  const seeded = await callTool(
    token,
    'create_page',
    {
      spaceId,
      title: `Codex acceptance page ${stamp}`,
      content: `# Codex acceptance\n\n${beacon}`,
      format: 'markdown',
      idempotencyKey: `seed-${stamp}`,
    },
    'seed-page',
  );
  const seededPage = requireRecord(seeded.page, 'seeded page');
  const pageId = requireString(seededPage, 'id');

  const codexResult = await runCodexSmoke({
    token,
    beacon,
    expectedSpaceId: spaceId,
    expectedPageId: pageId,
    expectedTitle: requireString(seededPage, 'title'),
  });

  const updated = await callTool(
    token,
    'update_page',
    {
      pageId,
      title: `Codex acceptance updated ${stamp}`,
      expectedUpdatedAt: requireString(seededPage, 'updatedAt'),
      idempotencyKey: `update-${stamp}`,
    },
    'update-page',
  );
  assert.equal(requireRecord(updated.page, 'updated page').id, pageId);

  const appended = await callTool(
    token,
    'append_page',
    {
      pageId,
      heading: 'Acceptance append',
      content: `append marker ${stamp}`,
      idempotencyKey: `append-${stamp}`,
    },
    'append-page',
  );
  assert.equal(requireRecord(appended.page, 'appended page').id, pageId);

  const deleted = await callTool(
    token,
    'delete_page',
    {
      pageId,
      confirm: true,
      reason: 'acceptance soft delete',
      idempotencyKey: `delete-${stamp}`,
    },
    'delete-page',
  );
  assert.equal(deleted.deleted, true);

  const restored = await callTool(
    token,
    'restore_page',
    {
      pageId,
      confirm: true,
      reason: 'acceptance restore',
      idempotencyKey: `restore-${stamp}`,
    },
    'restore-page',
  );
  assert.equal(requireRecord(restored.page, 'restored page').id, pageId);

  const replayArgs = {
    spaceId,
    title: `Idempotent acceptance ${stamp}`,
    content: `idempotent marker ${stamp}`,
    format: 'markdown',
    idempotencyKey: `replay-${stamp}`,
  };
  const firstReplay = await callTool(
    token,
    'create_page',
    replayArgs,
    'replay-first',
  );
  const secondReplay = await callTool(
    token,
    'create_page',
    replayArgs,
    'replay-second',
  );
  assert.equal(
    requireRecord(firstReplay.page, 'first replay page').id,
    requireRecord(secondReplay.page, 'second replay page').id,
  );

  const rateClient = await createClient(user, spaceId, `Rate limit ${stamp}`);
  const rateToken = requireString(rateClient, 'token');
  for (let request = 0; request < rateLimitMax; request += 1) {
    const response = await mcp(rateToken, 'tools/list', undefined, request);
    assert(response.result, `Rate-limit request ${request + 1} was rejected`);
  }
  const limited = await mcp(
    rateToken,
    'tools/list',
    undefined,
    rateLimitMax + 1,
  );
  assert.equal(limited.error?.code, -32029);
  await sleep(rateLimitWindowMs + 250);
  const afterReset = await mcp(
    rateToken,
    'tools/list',
    undefined,
    rateLimitMax + 2,
  );
  assert(afterReset.result, 'Rate limit did not reset');

  const auditResult = await apiPost<JsonRecord>('/api/mcp/admin/audit-logs', {
    clientId,
    limit: 100,
  });
  const auditItems = requireArray(auditResult.items, 'audit items');
  const auditEvents = new Set(
    auditItems.map((item) =>
      requireString(requireRecord(item, 'audit'), 'event'),
    ),
  );
  for (const event of [
    'mcp.page.create',
    'mcp.page.update',
    'mcp.page.append',
    'mcp.page.delete',
    'mcp.page.restore',
  ]) {
    assert(auditEvents.has(event), `Missing audit event ${event}`);
  }

  const rotated = await apiPost<JsonRecord>(
    '/api/mcp/admin/clients/rotate-token',
    { clientId },
  );
  const rotatedToken = requireString(rotated, 'token');
  const oldAuthentication = await mcp(token, 'tools/list', undefined, 'old');
  assert.equal(oldAuthentication.error?.code, -32001);
  const newAuthentication = await mcp(
    rotatedToken,
    'tools/list',
    undefined,
    'new',
  );
  assert(newAuthentication.result, 'Rotated token did not authenticate');

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        workspaceId: requireString(workspace, 'id'),
        spaceId,
        pageId,
        codexCli: codexResult,
        crud: ['create', 'update', 'append', 'delete', 'restore'],
        idempotencyReplay: true,
        rateLimitReset: true,
        auditEvents: [...auditEvents].sort(),
        tokenRotation: true,
      },
      null,
      2,
    )}\n`,
  );
}

async function loginOrSetup(): Promise<{
  user: JsonRecord;
  workspace: JsonRecord;
}> {
  const setup = await rawRequest('POST', '/api/auth/setup', {
    name: 'MCP Acceptance Admin',
    email: adminEmail,
    password: adminPassword,
    workspaceName: 'MCP Acceptance Workspace',
  });

  if (!setup.ok) {
    const login = await rawRequest('POST', '/api/auth/login', {
      email: adminEmail,
      password: adminPassword,
    });
    assert(login.ok, `Acceptance login failed with HTTP ${login.status}`);
  }

  const me = await apiPost<JsonRecord>('/api/users/me', {});
  return {
    user: requireRecord(me.user, 'user'),
    workspace: requireRecord(me.workspace, 'workspace'),
  };
}

async function createClient(
  user: JsonRecord,
  spaceId: string,
  name: string,
): Promise<JsonRecord> {
  return apiPost<JsonRecord>('/api/mcp/admin/clients/create', {
    name,
    actorUserId: requireString(user, 'id'),
    permissions: [
      {
        spaceId,
        canSearch: true,
        canSemanticSearch: true,
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canAppend: true,
        canDelete: true,
        canRestore: true,
        canIndex: false,
      },
    ],
  });
}

async function runCodexSmoke(input: {
  token: string;
  beacon: string;
  expectedSpaceId: string;
  expectedPageId: string;
  expectedTitle: string;
}): Promise<{ version: string; searchAndRead: true }> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'docmost-codex-acceptance-'),
  );
  const outputPath = path.join(tempDirectory, 'result.json');
  const isolatedCodexHome = path.join(tempDirectory, 'codex-home');
  await mkdir(isolatedCodexHome, { mode: 0o700 });
  if (!codexApiBaseUrl) {
    const sourceCodexHome =
      process.env.MCP_ACCEPTANCE_SOURCE_CODEX_HOME ??
      process.env.CODEX_HOME ??
      path.join(os.homedir(), '.codex');
    await symlink(
      path.join(sourceCodexHome, 'auth.json'),
      path.join(isolatedCodexHome, 'auth.json'),
    );
  }
  const schemaPath = path.resolve(
    __dirname,
    'fixtures/mcp-codex-output.schema.json',
  );
  const prompt = [
    'Run a deterministic MCP acceptance check.',
    'Use only the docmost_acceptance MCP tools; do not use shell commands, web search, or prior knowledge.',
    `Call search_docs in keyword mode for this exact query: ${input.beacon}`,
    'Read the matching page with get_page in markdown format.',
    'Return the discovered spaceId, pageId, title, and contentIncludesBeacon=true.',
  ].join(' ');
  const childEnvironment = { ...process.env };
  for (const variable of [
    'CODEX_CI',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_THREAD_ID',
  ]) {
    delete childEnvironment[variable];
  }
  const providerArgs = codexApiBaseUrl
    ? [
        '-c',
        'model_provider="acceptance_api"',
        '-c',
        'model_providers.acceptance_api.name="Acceptance API"',
        '-c',
        `model_providers.acceptance_api.base_url=${JSON.stringify(codexApiBaseUrl)}`,
        '-c',
        'model_providers.acceptance_api.wire_api="responses"',
        '-c',
        `model_providers.acceptance_api.env_key="${codexApiKeyVariable}"`,
        '-c',
        'model_providers.acceptance_api.supports_websockets=false',
      ]
    : [
        '-c',
        'model_provider="chatgpt_http"',
        '-c',
        'model_providers.chatgpt_http.name="ChatGPT HTTP"',
        '-c',
        'model_providers.chatgpt_http.base_url="https://chatgpt.com/backend-api/codex"',
        '-c',
        'model_providers.chatgpt_http.wire_api="responses"',
        '-c',
        'model_providers.chatgpt_http.requires_openai_auth=true',
        '-c',
        'model_providers.chatgpt_http.supports_websockets=false',
      ];
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--disable',
    'plugins',
    '--disable',
    'apps',
    '--disable',
    'browser_use',
    '--disable',
    'computer_use',
    '--disable',
    'image_generation',
    '--disable',
    'in_app_browser',
    '--disable',
    'multi_agent',
    '--disable',
    'goals',
    '--disable',
    'workspace_dependencies',
    '--disable',
    'tool_suggest',
    '--disable',
    'responses_websockets',
    '--disable',
    'responses_websockets_v2',
    '--color',
    'never',
    '--model',
    codexModel,
    '--json',
    '--sandbox',
    'read-only',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '-c',
    `mcp_servers.docmost_acceptance.url="${baseUrl}/mcp"`,
    '-c',
    'mcp_servers.docmost_acceptance.bearer_token_env_var="DOCMOST_MCP_TOKEN"',
    '-c',
    'mcp_servers.docmost_acceptance.default_tools_approval_mode="approve"',
    '-c',
    'approval_policy="never"',
    '-c',
    'model_reasoning_effort="low"',
    ...providerArgs,
    '-c',
    'skills.bundled.enabled=false',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'include_apps_instructions=false',
    '-c',
    'include_collaboration_mode_instructions=false',
    '-c',
    'include_environment_context=false',
    '-c',
    'include_permissions_instructions=false',
    '-c',
    'project_doc_max_bytes=0',
    prompt,
  ];

  try {
    const secrets = [
      input.token,
      adminPassword,
      process.env[codexApiKeyVariable],
    ].filter((secret): secret is string => Boolean(secret));
    const child = spawn(codexBinary, args, {
      cwd: tempDirectory,
      env: {
        ...childEnvironment,
        CODEX_HOME: isolatedCodexHome,
        DOCMOST_MCP_TOKEN: input.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, codexTimeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timeout));

    assert(
      !timedOut,
      `Codex CLI acceptance timed out: ${redact(
        stderr || stdout,
        secrets,
      ).slice(-5_000)}`,
    );
    assert.equal(
      exitCode,
      0,
      `Codex CLI failed: ${redact(stderr || stdout, secrets).slice(-2_000)}`,
    );

    const output = JSON.parse(await readFile(outputPath, 'utf8')) as JsonRecord;
    const outputMatches =
      output.spaceId === input.expectedSpaceId &&
      output.pageId === input.expectedPageId &&
      output.title === input.expectedTitle &&
      output.contentIncludesBeacon === true;
    assert(
      outputMatches,
      `Codex MCP result mismatch: output=${JSON.stringify(
        output,
      )}; events=${redact(stdout, secrets).slice(-5_000)}`,
    );

    return { version: 'codex-cli 0.142.5', searchAndRead: true };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function callTool(
  token: string,
  name: string,
  argumentsValue: JsonRecord,
  id: string,
): Promise<JsonRecord> {
  const response = await mcp(
    token,
    'tools/call',
    { name, arguments: argumentsValue },
    id,
  );
  assert(!response.error, `${name} failed: ${response.error?.message}`);
  return requireRecord(response.result?.structuredContent, `${name} result`);
}

async function mcp(
  token: string,
  method: string,
  params: JsonRecord | undefined,
  id: string | number,
): Promise<JsonRpcResponse> {
  const response = await rawRequest(
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    },
    {
      cookie: false,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  assert(response.ok, `MCP HTTP request failed with ${response.status}`);
  return unwrap(response.body) as JsonRpcResponse;
}

async function apiPost<T extends JsonRecord>(
  requestPath: string,
  body: JsonRecord,
): Promise<T> {
  const response = await rawRequest('POST', requestPath, body);
  assert(response.ok, `${requestPath} failed with HTTP ${response.status}`);
  const payload = unwrap(response.body);
  assert(payload && typeof payload === 'object' && !Array.isArray(payload));
  return payload as T;
}

async function rawRequest(
  method: string,
  requestPath: string,
  body?: JsonRecord,
  options: { cookie?: boolean; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.cookie !== false && cookie) {
    headers.Cookie = cookie;
  }

  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  updateCookie(response.headers);
  const text = await response.text();
  let responseBody: unknown = null;
  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  return { ok: response.ok, status: response.status, body: responseBody };
}

function updateCookie(headers: Headers): void {
  const cookieHeaders =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [headers.get('set-cookie')].filter(Boolean);
  if (cookieHeaders.length > 0) {
    cookie = cookieHeaders
      .map((value) => String(value).split(';')[0])
      .join('; ');
  }
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as JsonRecord;
    if ('data' in record) {
      return record.data;
    }
  }
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  assert(value && typeof value === 'object' && !Array.isArray(value), label);
  return value as JsonRecord;
}

function requireArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), label);
  return value;
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  assert.equal(typeof value, 'string', `${key} must be a string`);
  return value as string;
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-1_000_000);
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join('[redacted]'),
    value,
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : 'unknown failure';
  process.stderr.write(
    `MCP Codex acceptance failed (${errorType}): ${redact(message, [
      adminPassword,
    ])}\n`,
  );
  process.exitCode = 1;
});
