jest.mock('./services/mcp-tool.service', () => ({
  McpToolService: class McpToolService {},
}));

import { FastifyReply, FastifyRequest } from 'fastify';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { McpController } from './mcp.controller';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';
import { McpRateLimitService } from './services/mcp-rate-limit.service';
import { McpTokenService } from './services/mcp-token.service';
import { McpToolService } from './services/mcp-tool.service';

describe('McpController', () => {
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    actorUserId: null,
    status: 'active',
  };
  const tokenService = {
    authenticateToken: jest.fn(async () => client),
  };
  const toolService = {
    listTools: jest.fn(() => [
      {
        name: 'list_spaces',
        description: 'List spaces',
        inputSchema: { type: 'object' },
      },
    ]),
    callTool: jest.fn(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
    })),
  };
  const rateLimitService = {
    assertWithinLimit: jest.fn(),
  };
  const metricsService = {
    observeRequest: jest.fn(),
    recordPermissionDenied: jest.fn(),
    recordMutation: jest.fn(),
  };

  let controller: McpController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new McpController(
      tokenService as unknown as McpTokenService,
      toolService as unknown as McpToolService,
      rateLimitService as unknown as McpRateLimitService,
      metricsService as never,
    );
  });

  it('exposes raw JSON-RPC responses without the REST response envelope', () => {
    expect(
      Reflect.getMetadata(
        SKIP_TRANSFORM_KEY,
        McpController.prototype.handleJsonRpc,
      ),
    ).toBe(true);
  });

  it('handles initialize', async () => {
    const response = await controller.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      request(),
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: 'docmost-mcp' },
      },
    });
    expect(tokenService.authenticateToken).toHaveBeenCalledWith('token');
    expect(rateLimitService.assertWithinLimit).toHaveBeenCalledWith(client);
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'initialize',
        tool: 'none',
        outcome: 'success',
      }),
    );
  });

  it('lists tools', async () => {
    const response = await controller.handleJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      request(),
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: 'list_spaces' }],
      },
    });
  });

  it('calls a tool with authenticated context', async () => {
    const response = await controller.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: {
          name: 'list_spaces',
          arguments: {},
        },
      },
      request(),
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'call-1',
      result: {
        structuredContent: { ok: true },
      },
    });
    expect(toolService.callTool).toHaveBeenCalledWith(
      { name: 'list_spaces', arguments: {} },
      expect.objectContaining({
        client,
        requestId: 'call-1',
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('normalizes blank request IP addresses before calling tools', async () => {
    await controller.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 'call-blank-ip',
        method: 'tools/call',
        params: {
          name: 'list_spaces',
          arguments: {},
        },
      },
      request({ ip: ' ' }),
    );

    expect(toolService.callTool).toHaveBeenCalledWith(
      { name: 'list_spaces', arguments: {} },
      expect.objectContaining({
        ipAddress: null,
      }),
    );
  });

  it('returns JSON-RPC errors for unsupported methods', async () => {
    const response = await controller.handleJsonRpc(
      { jsonrpc: '2.0', id: 3, method: 'missing/method' },
      request(),
    );

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32601,
      },
    });
  });

  it('handles mixed JSON-RPC batches in request order', async () => {
    const response = await controller.handleJsonRpc(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'missing/method' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      ],
      request(),
    );

    expect(response).toEqual([
      expect.objectContaining({ id: 1, result: expect.any(Object) }),
      expect.objectContaining({
        id: 2,
        error: { code: -32601, message: expect.any(String) },
      }),
      expect.objectContaining({ id: 3, result: expect.any(Object) }),
    ]);
  });

  it('authenticates notifications and omits them from batch responses', async () => {
    const response = await controller.handleJsonRpc(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      request(),
    );

    expect(response).toEqual([
      expect.objectContaining({ id: 2, result: expect.any(Object) }),
    ]);
    expect(tokenService.authenticateToken).toHaveBeenCalledTimes(2);
  });

  it('returns 202 with an empty body for a single notification', async () => {
    const reply = fastifyReply();
    const response = await controller.handleJsonRpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      request(),
      reply,
    );

    expect(response).toBeUndefined();
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
  });

  it('returns 202 with an empty body for an all-notification batch', async () => {
    const reply = fastifyReply();
    const response = await controller.handleJsonRpc(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ],
      request(),
      reply,
    );

    expect(response).toBeUndefined();
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
  });

  it.each([
    [{ jsonrpc: '1.0', id: 1, method: 'tools/list' }, 'Only JSON-RPC 2.0'],
    [{ jsonrpc: '2.0', id: 1 } as never, 'method is required'],
    [null as never, 'Invalid JSON-RPC request'],
  ])('rejects malformed JSON-RPC envelopes', async (body, message) => {
    const response = await controller.handleJsonRpc(body as never, request());

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32602, message: expect.stringContaining(message) },
    });
    expect(tokenService.authenticateToken).not.toHaveBeenCalled();
  });

  it.each([undefined, [], 'bad'])(
    'rejects malformed tools/call params %p',
    async (params) => {
      const response = await controller.handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params,
        },
        request(),
      );

      expect(response).toMatchObject({
        error: { code: -32602 },
      });
      expect(toolService.callTool).not.toHaveBeenCalled();
    },
  );

  it('maps a missing page selector to JSON-RPC invalid params', async () => {
    toolService.callTool.mockRejectedValueOnce(
      new BadRequestException('pageId or slugId is required'),
    );

    const response = await controller.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_page', arguments: {} },
      },
      request(),
    );

    expect(response).toMatchObject({
      id: 1,
      error: {
        code: -32602,
        message: 'pageId or slugId is required',
      },
    });
  });

  it('rejects a missing bearer token before rate limiting', async () => {
    const response = await controller.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      request({ headers: {} }),
    );

    expect(response).toMatchObject({
      error: { code: -32001, message: 'Missing MCP bearer token' },
    });
    expect(tokenService.authenticateToken).not.toHaveBeenCalled();
    expect(rateLimitService.assertWithinLimit).not.toHaveBeenCalled();
  });

  it('maps rate limits and permission denials to stable public errors', async () => {
    rateLimitService.assertWithinLimit.mockImplementationOnce(() => {
      throw new HttpException('limit reached', HttpStatus.TOO_MANY_REQUESTS);
    });
    const limited = await controller.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      request(),
    );
    expect(limited).toMatchObject({
      error: { code: -32029, message: 'limit reached' },
    });

    toolService.callTool.mockRejectedValueOnce(
      new ForbiddenException('MCP permission denied'),
    );
    const denied = await controller.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_spaces', arguments: {} },
      },
      request(),
    );
    expect(denied).toMatchObject({
      error: { code: -32003, message: 'MCP permission denied' },
    });
    expect(metricsService.recordPermissionDenied).toHaveBeenCalled();
  });

  it('contains unexpected tool errors without exposing internal messages', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    toolService.callTool.mockRejectedValueOnce(
      new Error('database password should not escape'),
    );

    const response = await controller.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_spaces', arguments: {} },
      },
      request(),
    );

    expect(response).toMatchObject({
      error: { code: -32603, message: 'Internal MCP error' },
    });
    expect(JSON.stringify(response)).not.toContain('database password');
    expect(errorLog).toHaveBeenCalledWith({
      event: 'mcp.request.unhandled_error',
      errorType: 'Error',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'database password',
    );
  });
});

function request(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    headers: {
      authorization: 'Bearer token',
    },
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as FastifyRequest;
}

function fastifyReply(): FastifyReply {
  return {
    status: jest.fn(),
  } as unknown as FastifyReply;
}
