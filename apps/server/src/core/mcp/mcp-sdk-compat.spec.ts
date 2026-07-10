jest.mock('./services/mcp-tool.service', () => ({
  McpToolService: class McpToolService {},
}));

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { FastifyRequest } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpController } from './mcp.controller';
import type { McpRateLimitService } from './services/mcp-rate-limit.service';
import type { McpTokenService } from './services/mcp-token.service';
import type { McpToolService } from './services/mcp-tool.service';

describe('MCP Streamable HTTP SDK compatibility', () => {
  const authenticatedClient = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    status: 'active',
    actorUserId: null,
  };
  const tokenService = {
    authenticateToken: jest.fn(async () => authenticatedClient),
  };
  const toolService = {
    listTools: jest.fn(() => [
      {
        name: 'list_spaces',
        description: 'List permitted spaces',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      },
    ]),
    callTool: jest.fn(),
  };
  const rateLimitService = {
    assertWithinLimit: jest.fn(),
  };
  const metricsService = {
    observeRequest: jest.fn(),
    recordPermissionDenied: jest.fn(),
    recordMutation: jest.fn(),
  };

  let server: Server;
  let endpoint: URL;
  let sdkClient: Client;

  beforeAll(async () => {
    const controller = new McpController(
      tokenService as unknown as McpTokenService,
      toolService as unknown as McpToolService,
      rateLimitService as unknown as McpRateLimitService,
      metricsService as never,
    );
    server = createServer((request, response) => {
      void handleHttpRequest(controller, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    await sdkClient?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes initialize, notification, and tools/list through the real SDK', async () => {
    sdkClient = new Client({
      name: 'docmost-mcp-sdk-compat',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          Authorization: 'Bearer sdk-test-token',
        },
      },
    });

    await sdkClient.connect(transport);
    const result = await sdkClient.listTools();

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'list_spaces',
        inputSchema: expect.objectContaining({ type: 'object' }),
      }),
    ]);
    expect(tokenService.authenticateToken).toHaveBeenCalledWith(
      'sdk-test-token',
    );
    expect(rateLimitService.assertWithinLimit).toHaveBeenCalledWith(
      authenticatedClient,
    );
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'initialize',
        outcome: 'success',
      }),
    );
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'tools/list',
        outcome: 'success',
      }),
    );
  });
});

async function handleHttpRequest(
  controller: McpController,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end();
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request));
    const result = await controller.handleJsonRpc(body, {
      headers: request.headers,
      ip: request.socket.remoteAddress ?? '',
    } as unknown as FastifyRequest);

    if (result == null || (Array.isArray(result) && result.length === 0)) {
      response.statusCode = 202;
      response.end();
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  } catch {
    response.statusCode = 400;
    response.end();
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
