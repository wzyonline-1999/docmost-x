#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require("@modelcontextprotocol/sdk/types.js");

const REMOTE_URL = "https://docs.wzyonline.com/mcp";
const KEYCHAIN_SERVICE = "Docmost MCP Codex Canary";
const KEYCHAIN_ACCOUNT = "zeyu.wang";
const REQUEST_TIMEOUT_MS = 30_000;

let requestId = 0;

function readTokenFromKeychain() {
  let token;
  try {
    token = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error("Docmost MCP Token is unavailable in macOS Keychain");
  }

  if (token.length < 20) {
    throw new Error("Docmost MCP Token in macOS Keychain is invalid");
  }
  return token;
}

async function callRemote(token, method, params) {
  let response;
  try {
    response = await fetch(REMOTE_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "docmost-keychain-mcp-proxy/1.0.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `keychain-proxy-${process.pid}-${++requestId}`,
        method,
        ...(params ? { params } : {}),
      }),
    });
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      "Docmost MCP transport request failed",
    );
  }

  if (!response.ok) {
    throw new McpError(
      ErrorCode.InternalError,
      `Docmost MCP returned HTTP ${response.status}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      "Docmost MCP returned an invalid JSON response",
    );
  }

  if (payload?.error) {
    const code = Number.isInteger(payload.error.code)
      ? payload.error.code
      : ErrorCode.InternalError;
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message.slice(0, 500)
        : "Docmost MCP request failed";
    throw new McpError(code, message);
  }
  if (!payload?.result || typeof payload.result !== "object") {
    throw new McpError(
      ErrorCode.InternalError,
      "Docmost MCP response is missing a result",
    );
  }
  return payload.result;
}

async function main() {
  const token = readTokenFromKeychain();
  const server = new Server(
    { name: "docmost-keychain-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await callRemote(token, "tools/list");
    if (!Array.isArray(listed.tools)) {
      throw new McpError(
        ErrorCode.InternalError,
        "Docmost MCP tools/list returned no tools",
      );
    }
    return { tools: listed.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callRemote(token, "tools/call", request.params),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const name = error instanceof Error ? error.name : "Error";
  process.stderr.write(`Docmost Keychain MCP proxy failed (${name})\n`);
  process.exitCode = 1;
});
