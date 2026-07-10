import type { McpAuthenticatedClient } from './mcp.types';

export type McpToolContext = {
  client: McpAuthenticatedClient;
  requestId?: string | null;
  ipAddress?: string | null;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolCallResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpToolCallParams = {
  name?: string;
  arguments?: unknown;
};
