import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_PLACEHOLDER,
  buildMcpConnectionSnippets,
} from "./mcp-connection-config";

describe("MCP and API connection snippets", () => {
  it("builds Codex, generic MCP, and HTTP API configurations", () => {
    const snippets = buildMcpConnectionSnippets({
      mcpUrl: "https://docs.example.com/mcp/",
      apiBaseUrl: "https://docs.example.com/api/developer/v1/",
      token: "dmost_mcp_secret",
    });

    expect(snippets.codexConfig).toContain(
      'url = "https://docs.example.com/mcp"',
    );
    expect(snippets.codexCliCommand).toBe(
      [
        "codex mcp add docmost \\",
        '  --url "https://docs.example.com/mcp" \\',
        "  --bearer-token-env-var DOCMOST_ACCESS_TOKEN",
      ].join("\n"),
    );
    expect(snippets.tokenEnvironment).toBe(
      'export DOCMOST_ACCESS_TOKEN="dmost_mcp_secret"',
    );
    expect(JSON.parse(snippets.genericMcpJson)).toEqual({
      mcpServers: {
        docmost: {
          url: "https://docs.example.com/mcp",
          headers: {
            Authorization: "Bearer dmost_mcp_secret",
          },
        },
      },
    });
    expect(snippets.apiListToolsCurl).toContain(
      "https://docs.example.com/api/developer/v1/tools",
    );
    expect(snippets.apiSearchCurl).toContain(
      "/api/developer/v1/tools/search_docs",
    );
  });

  it("uses a visible placeholder when an existing token cannot be recovered", () => {
    const snippets = buildMcpConnectionSnippets({
      mcpUrl: "https://docs.example.com/mcp",
      apiBaseUrl: "https://docs.example.com/api/developer/v1",
    });

    expect(snippets.tokenEnvironment).toContain(ACCESS_TOKEN_PLACEHOLDER);
    expect(snippets.genericMcpJson).toContain(ACCESS_TOKEN_PLACEHOLDER);
  });

  it("escapes token values embedded in shell examples", () => {
    const snippets = buildMcpConnectionSnippets({
      mcpUrl: "https://docs.example.com/mcp",
      apiBaseUrl: "https://docs.example.com/api/developer/v1",
      token: 'token"$`\\',
    });

    expect(snippets.tokenEnvironment).toBe(
      'export DOCMOST_ACCESS_TOKEN="token\\"\\$\\`\\\\"',
    );
  });

  it("escapes the MCP URL embedded in the Codex shell command", () => {
    const snippets = buildMcpConnectionSnippets({
      mcpUrl: 'https://docs.example.com/mcp?label="$HOME`',
      apiBaseUrl: "https://docs.example.com/api/developer/v1",
    });

    expect(snippets.codexCliCommand).toContain(
      '--url "https://docs.example.com/mcp?label=\\"\\$HOME\\`"',
    );
  });
});
