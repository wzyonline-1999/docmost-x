import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader } from '../../common/helpers';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { McpRateLimitService } from './services/mcp-rate-limit.service';
import { McpTokenService } from './services/mcp-token.service';
import { McpToolService } from './services/mcp-tool.service';
import {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  JsonRpcId,
} from './types/mcp-json-rpc.types';
import { McpToolCallParams } from './types/mcp-tool.types';
import { McpMetricsService } from './services/mcp-metrics.service';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_MUTATION_TOOLS = new Set([
  'create_page',
  'update_page',
  'append_page',
  'delete_page',
  'restore_page',
  'reindex_page',
  'reindex_space',
  'reindex_workspace',
  'retry_index_job',
  'pause_index_job',
  'resume_index_job',
  'cancel_index_job',
]);

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tokenService: McpTokenService,
    private readonly toolService: McpToolService,
    private readonly rateLimitService: McpRateLimitService,
    private readonly metricsService: McpMetricsService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  @SkipTransform()
  async handleJsonRpc(
    @Body() body: McpJsonRpcRequest | McpJsonRpcRequest[],
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply?: FastifyReply,
  ): Promise<McpJsonRpcResponse | McpJsonRpcResponse[] | undefined> {
    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((request) => this.handleRequest(request, req)),
      );
      const responseBody = responses.filter((response) => response !== null);
      if (responseBody.length === 0) {
        reply?.status(HttpStatus.ACCEPTED);
        return undefined;
      }
      return responseBody;
    }

    const response = await this.handleRequest(body, req);
    if (response === null) {
      reply?.status(HttpStatus.ACCEPTED);
      return undefined;
    }
    return response;
  }

  private async handleRequest(
    request: McpJsonRpcRequest,
    req: FastifyRequest,
  ): Promise<McpJsonRpcResponse | null> {
    const id = this.getRequestId(request);
    const startedAt = process.hrtime.bigint();
    const method = this.getMetricMethod(request?.method);
    const tool = this.getMetricTool(request);
    let outcome = 'success';

    try {
      this.validateRequest(request);

      if (this.isNotification(request)) {
        await this.handleNotification(request, req);
        return null;
      }

      const result = await this.dispatch(request, req);
      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (err) {
      outcome = this.getMetricOutcome(err);
      if (outcome === 'forbidden') {
        this.metricsService.recordPermissionDenied(tool, tool);
      }
      this.logger.warn({
        requestId: String(id ?? ''),
        method,
        toolName: tool,
        outcome,
      });
      return {
        jsonrpc: '2.0',
        id,
        error: this.toJsonRpcError(err),
      };
    } finally {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metricsService.observeRequest({
        method,
        tool,
        outcome,
        durationSeconds,
      });
      if (MCP_MUTATION_TOOLS.has(tool)) {
        this.metricsService.recordMutation(tool, outcome);
      }
    }
  }

  private async dispatch(
    request: McpJsonRpcRequest,
    req: FastifyRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        await this.authenticate(req);
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'docmost-mcp',
            version: '0.1.0',
          },
        };
      case 'tools/list':
        await this.authenticate(req);
        return {
          tools: this.toolService.listTools(),
        };
      case 'tools/call': {
        const client = await this.authenticate(req);
        return this.toolService.callTool(this.asToolParams(request.params), {
          client,
          requestId: String(request.id ?? ''),
          ipAddress: this.getIpAddress(req),
        });
      }
      default:
        throw new HttpException(
          `Unsupported MCP method: ${request.method}`,
          HttpStatus.NOT_FOUND,
        );
    }
  }

  private async handleNotification(
    request: McpJsonRpcRequest,
    req: FastifyRequest,
  ): Promise<void> {
    if (request.method === 'notifications/initialized') {
      await this.authenticate(req);
      return;
    }

    throw new HttpException(
      `Unsupported MCP notification: ${request.method}`,
      HttpStatus.NOT_FOUND,
    );
  }

  private async authenticate(req: FastifyRequest) {
    const token = extractBearerTokenFromHeader(req);
    if (!token) {
      throw new UnauthorizedException('Missing MCP bearer token');
    }

    const client = await this.tokenService.authenticateToken(token);
    this.rateLimitService.assertWithinLimit(client);
    return client;
  }

  private validateRequest(request: McpJsonRpcRequest): void {
    if (!request || typeof request !== 'object') {
      throw new HttpException(
        'Invalid JSON-RPC request',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (request.jsonrpc && request.jsonrpc !== '2.0') {
      throw new HttpException(
        'Only JSON-RPC 2.0 requests are supported',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!request.method || typeof request.method !== 'string') {
      throw new HttpException(
        'JSON-RPC method is required',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private asToolParams(params: unknown): McpToolCallParams {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new HttpException(
        'tools/call params must be an object',
        HttpStatus.BAD_REQUEST,
      );
    }

    const toolParams = params as Record<string, unknown>;
    if (typeof toolParams.name !== 'string' || !toolParams.name.trim()) {
      throw new HttpException(
        'tools/call params.name is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      name: toolParams.name,
      arguments: toolParams.arguments,
    };
  }

  private isNotification(request: McpJsonRpcRequest): boolean {
    return typeof request.id === 'undefined';
  }

  private getRequestId(request: McpJsonRpcRequest): JsonRpcId {
    return typeof request?.id === 'undefined' ? null : request.id;
  }

  private toJsonRpcError(err: unknown): {
    code: number;
    message: string;
    data?: unknown;
  } {
    if (err instanceof HttpException) {
      return {
        code: this.httpStatusToJsonRpcCode(err.getStatus()),
        message: err.message,
      };
    }

    this.logger.error({
      event: 'mcp.request.unhandled_error',
      errorType: err instanceof Error ? err.name : typeof err,
    });

    const fallback = new InternalServerErrorException('Internal MCP error');
    return {
      code: this.httpStatusToJsonRpcCode(fallback.getStatus()),
      message: fallback.message,
    };
  }

  private httpStatusToJsonRpcCode(status: number): number {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return -32602;
      case HttpStatus.UNAUTHORIZED:
        return -32001;
      case HttpStatus.FORBIDDEN:
        return -32003;
      case HttpStatus.NOT_FOUND:
        return -32601;
      case HttpStatus.CONFLICT:
        return -32009;
      case HttpStatus.TOO_MANY_REQUESTS:
        return -32029;
      case HttpStatus.BAD_GATEWAY:
      case HttpStatus.SERVICE_UNAVAILABLE:
        return -32011;
      default:
        return -32603;
    }
  }

  private getIpAddress(req: FastifyRequest): string | null {
    const ipAddress = req.ip?.trim();
    return ipAddress ? ipAddress : null;
  }

  private getMetricMethod(method: unknown): string {
    return ['initialize', 'tools/list', 'tools/call'].includes(String(method))
      ? String(method)
      : 'unknown';
  }

  private getMetricTool(request: McpJsonRpcRequest): string {
    if (request?.method !== 'tools/call') {
      return 'none';
    }
    const params = request.params;
    const name =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>).name
        : undefined;
    if (typeof name !== 'string') {
      return 'unknown';
    }
    return this.toolService.listTools().some((tool) => tool.name === name)
      ? name
      : 'unknown';
  }

  private getMetricOutcome(err: unknown): string {
    if (!(err instanceof HttpException)) {
      return 'internal_error';
    }
    const status = err.getStatus();
    if (status === HttpStatus.FORBIDDEN) return 'forbidden';
    if (status === HttpStatus.UNAUTHORIZED) return 'unauthorized';
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'client_error';
  }
}
