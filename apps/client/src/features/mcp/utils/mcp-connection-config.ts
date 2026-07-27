export const ACCESS_TOKEN_PLACEHOLDER = "YOUR_ACCESS_TOKEN";

export type McpConnectionSnippets = {
  codexCliCommand: string;
  codexConfig: string;
  tokenEnvironment: string;
  genericMcpJson: string;
  apiListToolsCurl: string;
  apiSearchCurl: string;
};

type BuildConnectionSnippetsInput = {
  mcpUrl: string;
  apiBaseUrl: string;
  token?: string | null;
};

export function buildMcpConnectionSnippets({
  mcpUrl,
  apiBaseUrl,
  token,
}: BuildConnectionSnippetsInput): McpConnectionSnippets {
  const normalizedMcpUrl = trimTrailingSlash(mcpUrl);
  const normalizedApiBaseUrl = trimTrailingSlash(apiBaseUrl);
  const tokenValue = token || ACCESS_TOKEN_PLACEHOLDER;

  return {
    codexCliCommand: [
      "codex mcp add docmost \\",
      `  --url "${escapeShellDoubleQuoted(normalizedMcpUrl)}" \\`,
      "  --bearer-token-env-var DOCMOST_ACCESS_TOKEN",
    ].join("\n"),
    codexConfig: [
      "[mcp_servers.docmost]",
      `url = "${escapeTomlString(normalizedMcpUrl)}"`,
      'bearer_token_env_var = "DOCMOST_ACCESS_TOKEN"',
    ].join("\n"),
    tokenEnvironment: `export DOCMOST_ACCESS_TOKEN="${escapeShellDoubleQuoted(
      tokenValue,
    )}"`,
    genericMcpJson: JSON.stringify(
      {
        mcpServers: {
          docmost: {
            url: normalizedMcpUrl,
            headers: {
              Authorization: `Bearer ${tokenValue}`,
            },
          },
        },
      },
      null,
      2,
    ),
    apiListToolsCurl: [
      "curl --request GET \\",
      `  --url "${normalizedApiBaseUrl}/tools" \\`,
      '  --header "Authorization: Bearer ${DOCMOST_ACCESS_TOKEN}"',
    ].join("\n"),
    apiSearchCurl: [
      "curl --request POST \\",
      `  --url "${normalizedApiBaseUrl}/tools/search_docs" \\`,
      '  --header "Authorization: Bearer ${DOCMOST_ACCESS_TOKEN}" \\',
      '  --header "Content-Type: application/json" \\',
      "  --data '{",
      '    "query": "employee onboarding process",',
      '    "mode": "hybrid",',
      '    "limit": 10',
      "  }'",
    ].join("\n"),
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeShellDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}
