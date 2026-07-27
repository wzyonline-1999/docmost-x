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
import { MCP_MUTATION_TOOLS } from './constants/mcp-tool.constants';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import type { McpAuthenticatedClient } from './types/mcp.types';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  '2025-03-26',
]);
const MCP_BATCH_CONCURRENCY = 5;
const MCP_SERVER_VERSION = process.env.npm_package_version ?? '0.95.0';
type AuthenticateMcpRequest = () => Promise<McpAuthenticatedClient>;

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tokenService: McpTokenService,
    private readonly toolService: McpToolService,
    private readonly rateLimitService: McpRateLimitService,
    private readonly metricsService: McpMetricsService,
    private readonly environmentService: EnvironmentService,
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
      if (body.length === 0) {
        reply?.status(HttpStatus.BAD_REQUEST);
        return this.invalidRequestResponse('JSON-RPC batch must not be empty');
      }
      const maxBatchSize = this.environmentService.getMcpMaxBatchSize();
      if (body.length > maxBatchSize) {
        reply?.status(HttpStatus.BAD_REQUEST);
        return this.invalidRequestResponse(
          `JSON-RPC batch supports at most ${maxBatchSize} requests`,
        );
      }

      const authenticate = this.createAuthenticator(req, body.length);
      const responses = await this.mapBatchWithConcurrency(body, (request) =>
        this.handleRequest(request, req, authenticate, reply),
      );
      const responseBody = responses.filter((response) => response !== null);
      if (responseBody.length === 0) {
        reply?.status(HttpStatus.ACCEPTED);
        return undefined;
      }
      return responseBody;
    }

    const response = await this.handleRequest(
      body,
      req,
      this.createAuthenticator(req, 1),
      reply,
    );
    if (response === null) {
      reply?.status(HttpStatus.ACCEPTED);
      return undefined;
    }
    return response;
  }

  private async handleRequest(
    request: unknown,
    req: FastifyRequest,
    authenticate: AuthenticateMcpRequest,
    reply?: FastifyReply,
  ): Promise<McpJsonRpcResponse | null> {
    const id = this.getRequestId(request);
    const startedAt = process.hrtime.bigint();
    const method = this.getMetricMethod(this.getRequestMethod(request));
    const tool = this.getMetricTool(request);
    let outcome = 'success';
    let notification = false;

    try {
      this.validateRequest(request);
      notification = this.isNotification(request);
      const client = await authenticate();

      if (notification) {
        await this.handleNotification(request);
        return null;
      }

      const result = await this.dispatch(request, req, client);
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
      if (err instanceof HttpException && this.isTransportError(err)) {
        reply?.status(err.getStatus());
      }
      if (notification) {
        return null;
      }
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
    client: McpAuthenticatedClient,
  ): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: this.resolveProtocolVersion(request.params),
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'docmost-mcp',
            version: MCP_SERVER_VERSION,
          },
        };
      case 'tools/list':
        return {
          tools: this.toolService.listTools(),
        };
      case 'tools/call': {
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

  private async handleNotification(request: McpJsonRpcRequest): Promise<void> {
    if (request.method === 'notifications/initialized') {
      return;
    }

    throw new HttpException(
      `Unsupported MCP notification: ${request.method}`,
      HttpStatus.NOT_FOUND,
    );
  }

  private createAuthenticator(
    req: FastifyRequest,
    cost: number,
  ): AuthenticateMcpRequest {
    let authentication: Promise<McpAuthenticatedClient> | undefined;
    return () => {
      authentication ??= this.authenticate(req, cost);
      return authentication;
    };
  }

  private async authenticate(req: FastifyRequest, cost: number) {
    const token = extractBearerTokenFromHeader(req);
    if (!token) {
      throw new UnauthorizedException('Missing MCP bearer token');
    }

    const client = await this.tokenService.authenticateToken(token);
    await this.rateLimitService.assertWithinLimit(client, cost);
    await this.tokenService.recordSuccessfulUse(client.id);
    return client;
  }

  private validateRequest(
    request: unknown,
  ): asserts request is McpJsonRpcRequest {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new HttpException(
        'Invalid JSON-RPC request',
        HttpStatus.BAD_REQUEST,
      );
    }

    const envelope = request as Record<string, unknown>;
    if (envelope.jsonrpc !== '2.0') {
      throw new HttpException(
        'jsonrpc must be exactly "2.0"',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!envelope.method || typeof envelope.method !== 'string') {
      throw new HttpException(
        'JSON-RPC method is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (
      typeof envelope.id !== 'undefined' &&
      envelope.id !== null &&
      typeof envelope.id !== 'string' &&
      typeof envelope.id !== 'number'
    ) {
      throw new HttpException(
        'JSON-RPC id must be a string, number, or null',
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

  private getRequestId(request: unknown): JsonRpcId {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return null;
    }
    const id = (request as Record<string, unknown>).id;
    return typeof id === 'string' || typeof id === 'number' || id === null
      ? (id as JsonRpcId)
      : null;
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

  private getMetricTool(request: unknown): string {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return 'none';
    }
    const envelope = request as Record<string, unknown>;
    if (envelope.method !== 'tools/call') {
      return 'none';
    }
    const params = envelope.params;
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

  private getRequestMethod(request: unknown): unknown {
    return request && typeof request === 'object' && !Array.isArray(request)
      ? (request as Record<string, unknown>).method
      : undefined;
  }

  private invalidRequestResponse(message: string): McpJsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message,
      },
    };
  }

  private resolveProtocolVersion(params: unknown): string {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return MCP_PROTOCOL_VERSION;
    }
    const requested = (params as Record<string, unknown>).protocolVersion;
    return typeof requested === 'string' &&
      MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
  }

  private isTransportError(error: HttpException): boolean {
    return [
      HttpStatus.UNAUTHORIZED,
      HttpStatus.FORBIDDEN,
      HttpStatus.TOO_MANY_REQUESTS,
      HttpStatus.SERVICE_UNAVAILABLE,
    ].includes(error.getStatus());
  }

  private async mapBatchWithConcurrency<T, R>(
    items: T[],
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MCP_BATCH_CONCURRENCY, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await mapper(items[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }
}
