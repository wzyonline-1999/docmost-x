jest.mock('./services/mcp-tool.service', () => ({
  McpToolService: class McpToolService {},
}));

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DeveloperApiController } from './developer-api.controller';
import type { McpMetricsService } from './services/mcp-metrics.service';
import type { McpRateLimitService } from './services/mcp-rate-limit.service';
import type { McpTokenService } from './services/mcp-token.service';
import type { McpToolService } from './services/mcp-tool.service';

describe('DeveloperApiController', () => {
  const client = {
    id: 'client-1',
    workspaceId: 'workspace-1',
    actorUserId: 'actor-1',
    status: 'active',
  };
  const tokenService = {
    authenticateToken: jest.fn(async () => client),
    recordSuccessfulUse: jest.fn(async () => undefined),
  };
  const toolService = {
    listTools: jest.fn(() => [
      {
        name: 'list_spaces',
        description: 'List spaces',
        inputSchema: { type: 'object' },
      },
      {
        name: 'create_page',
        description: 'Create page',
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

  let controller: DeveloperApiController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new DeveloperApiController(
      tokenService as unknown as McpTokenService,
      toolService as unknown as McpToolService,
      rateLimitService as unknown as McpRateLimitService,
      metricsService as unknown as McpMetricsService,
    );
  });

  it('lists the same authenticated tools exposed through MCP', async () => {
    const reply = fastifyReply();
    const response = await controller.listTools(request(), reply);

    expect(response).toMatchObject({
      items: [{ name: 'list_spaces' }, { name: 'create_page' }],
      meta: { count: 2, requestId: expect.any(String) },
    });
    expect(tokenService.authenticateToken).toHaveBeenCalledWith('token');
    expect(rateLimitService.assertWithinLimit).toHaveBeenCalledWith(client);
    expect(tokenService.recordSuccessfulUse).toHaveBeenCalledWith(client.id);
    expect(reply.header).toHaveBeenCalledWith(
      'X-Request-Id',
      expect.any(String),
    );
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'api/tools/list',
        tool: 'none',
        outcome: 'success',
      }),
    );
  });

  it('calls a tool with the same client, actor, request, and IP context', async () => {
    const reply = fastifyReply();
    const response = await controller.callTool(
      'search_docs',
      { query: 'onboarding', mode: 'hybrid' },
      request({
        headers: {
          authorization: 'Bearer token',
          'x-request-id': 'api-request-1',
        },
      }),
      reply,
    );

    expect(response).toEqual({
      tool: 'search_docs',
      requestId: 'api-request-1',
      result: { ok: true },
    });
    expect(toolService.callTool).toHaveBeenCalledWith(
      {
        name: 'search_docs',
        arguments: { query: 'onboarding', mode: 'hybrid' },
      },
      {
        client,
        requestId: 'api-request-1',
        ipAddress: '127.0.0.1',
      },
    );
  });

  it('copies the Idempotency-Key header into mutation tool arguments', async () => {
    await controller.callTool(
      'create_page',
      { spaceId: 'space-1', title: 'Runbook' },
      request({
        headers: {
          authorization: 'Bearer token',
          'idempotency-key': 'create-runbook-1',
        },
      }),
      fastifyReply(),
    );

    expect(toolService.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          idempotencyKey: 'create-runbook-1',
        }),
      }),
      expect.any(Object),
    );
    expect(metricsService.recordMutation).toHaveBeenCalledWith(
      'create_page',
      'success',
    );
  });

  it('rejects conflicting header and body idempotency keys', async () => {
    await expect(
      controller.callTool(
        'create_page',
        { idempotencyKey: 'body-key' },
        request({
          headers: {
            authorization: 'Bearer token',
            'idempotency-key': 'header-key',
          },
        }),
        fastifyReply(),
      ),
    ).rejects.toThrow(
      'Idempotency-Key header conflicts with body idempotencyKey',
    );
    expect(toolService.callTool).not.toHaveBeenCalled();
  });

  it.each([[], 'query', 1])(
    'rejects a non-object request body (%p)',
    async (body) => {
      await expect(
        controller.callTool('search_docs', body, request(), fastifyReply()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(toolService.callTool).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed tool names before authentication', async () => {
    await expect(
      controller.callTool('../search_docs', {}, request(), fastifyReply()),
    ).rejects.toThrow('Invalid developer tool name');
    expect(tokenService.authenticateToken).not.toHaveBeenCalled();
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'unknown',
        outcome: 'client_error',
      }),
    );
  });

  it('accepts an empty body for argument-free tools', async () => {
    await controller.callTool(
      'list_spaces',
      undefined,
      request(),
      fastifyReply(),
    );

    expect(toolService.callTool).toHaveBeenCalledWith(
      { name: 'list_spaces', arguments: {} },
      expect.any(Object),
    );
  });

  it('requires the shared bearer token before rate limiting', async () => {
    await expect(
      controller.listTools(request({ headers: {} }), fastifyReply()),
    ).rejects.toThrow('Missing developer bearer token');
    expect(tokenService.authenticateToken).not.toHaveBeenCalled();
    expect(rateLimitService.assertWithinLimit).not.toHaveBeenCalled();
  });

  it('records permission denials for API tool calls', async () => {
    toolService.callTool.mockRejectedValueOnce(
      new ForbiddenException('MCP permission denied'),
    );

    await expect(
      controller.callTool(
        'get_page',
        { pageId: 'page-1' },
        request(),
        fastifyReply(),
      ),
    ).rejects.toThrow('MCP permission denied');
    expect(metricsService.recordPermissionDenied).toHaveBeenCalledWith(
      'get_page',
      'get_page',
    );
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'forbidden' }),
    );
  });

  it('preserves rate limit status and metrics', async () => {
    rateLimitService.assertWithinLimit.mockImplementationOnce(() => {
      throw new HttpException('limit reached', HttpStatus.TOO_MANY_REQUESTS);
    });

    await expect(
      controller.listTools(request(), fastifyReply()),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(metricsService.observeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rate_limited' }),
    );
  });

  it('contains unexpected errors without exposing internal messages', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    toolService.callTool.mockRejectedValueOnce(
      new Error('database password should not escape'),
    );

    await expect(
      controller.callTool(
        'get_page',
        { pageId: 'page-1' },
        request(),
        fastifyReply(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InternalServerErrorException>>({
        message: 'Internal developer API error',
      }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'database password',
    );
  });

  it('replaces unsafe caller request IDs with a generated value', async () => {
    const reply = fastifyReply();
    const response = await controller.listTools(
      request({
        headers: {
          authorization: 'Bearer token',
          'x-request-id': 'invalid request id with spaces',
        },
      }),
      reply,
    );

    expect(response.meta.requestId).not.toContain(' ');
    expect(response.meta.requestId).toHaveLength(36);
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
    header: jest.fn(),
  } as unknown as FastifyReply;
}
