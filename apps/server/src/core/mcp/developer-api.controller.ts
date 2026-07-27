import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader } from '../../common/helpers';
import { MCP_MUTATION_TOOLS } from './constants/mcp-tool.constants';
import { McpMetricsService } from './services/mcp-metrics.service';
import { McpRateLimitService } from './services/mcp-rate-limit.service';
import { McpTokenService } from './services/mcp-token.service';
import { McpToolService } from './services/mcp-tool.service';
import type { McpAuthenticatedClient } from './types/mcp.types';
import { getMcpErrorType } from './utils/mcp-error.util';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

@Controller('developer/v1')
export class DeveloperApiController {
  private readonly logger = new Logger(DeveloperApiController.name);

  constructor(
    private readonly tokenService: McpTokenService,
    private readonly toolService: McpToolService,
    private readonly rateLimitService: McpRateLimitService,
    private readonly metricsService: McpMetricsService,
  ) {}

  @Get('tools')
  async listTools(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const startedAt = process.hrtime.bigint();
    const requestId = this.resolveRequestId(req);
    let outcome = 'success';
    reply.header('X-Request-Id', requestId);

    try {
      await this.authenticate(req);
      const items = this.toolService.listTools();
      return {
        items,
        meta: {
          count: items.length,
          requestId,
        },
      };
    } catch (err) {
      outcome = this.getMetricOutcome(err);
      throw this.normalizeError(err, requestId, 'none');
    } finally {
      this.observeRequest(startedAt, 'api/tools/list', 'none', outcome);
    }
  }

  @Post('tools/:toolName')
  @HttpCode(HttpStatus.OK)
  async callTool(
    @Param('toolName') toolName: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const startedAt = process.hrtime.bigint();
    const requestId = this.resolveRequestId(req);
    let normalizedToolName = 'unknown';
    let outcome = 'success';
    reply.header('X-Request-Id', requestId);

    try {
      normalizedToolName = this.normalizeToolName(toolName);
      const client = await this.authenticate(req);
      const args = this.withIdempotencyKey(
        this.asArguments(body),
        normalizedToolName,
        req,
      );
      const result = await this.toolService.callTool(
        {
          name: normalizedToolName,
          arguments: args,
        },
        {
          client,
          requestId,
          ipAddress: this.getIpAddress(req),
        },
      );

      return {
        tool: normalizedToolName,
        requestId,
        result: result.structuredContent ?? null,
      };
    } catch (err) {
      outcome = this.getMetricOutcome(err);
      if (err instanceof ForbiddenException) {
        this.metricsService.recordPermissionDenied(
          normalizedToolName,
          normalizedToolName,
        );
      }
      throw this.normalizeError(err, requestId, normalizedToolName);
    } finally {
      this.observeRequest(
        startedAt,
        'api/tools/call',
        normalizedToolName,
        outcome,
      );
      if (MCP_MUTATION_TOOLS.has(normalizedToolName)) {
        this.metricsService.recordMutation(normalizedToolName, outcome);
      }
    }
  }

  private async authenticate(
    req: FastifyRequest,
  ): Promise<McpAuthenticatedClient> {
    const token = extractBearerTokenFromHeader(req);
    if (!token) {
      throw new UnauthorizedException('Missing developer bearer token');
    }

    const client = await this.tokenService.authenticateToken(token);
    await this.rateLimitService.assertWithinLimit(client);
    await this.tokenService.recordSuccessfulUse(client.id);
    return client;
  }

  private normalizeToolName(value: string): string {
    const toolName = value?.trim();
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      throw new BadRequestException('Invalid developer tool name');
    }
    return toolName;
  }

  private asArguments(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Developer tool body must be an object');
    }
    return { ...(value as Record<string, unknown>) };
  }

  private withIdempotencyKey(
    args: Record<string, unknown>,
    toolName: string,
    req: FastifyRequest,
  ): Record<string, unknown> {
    if (!MCP_MUTATION_TOOLS.has(toolName)) {
      return args;
    }

    const headerValue = this.getHeader(req, 'idempotency-key')?.trim();
    if (!headerValue) {
      throw new BadRequestException(
        'Idempotency-Key header is required for mutation tools',
      );
    }
    if (headerValue.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }

    const bodyValue = args.idempotencyKey;
    if (
      bodyValue !== undefined &&
      (typeof bodyValue !== 'string' || bodyValue !== headerValue)
    ) {
      throw new BadRequestException(
        'Idempotency-Key header conflicts with body idempotencyKey',
      );
    }

    return {
      ...args,
      idempotencyKey: headerValue,
    };
  }

  private resolveRequestId(req: FastifyRequest): string {
    const requestId = this.getHeader(req, 'x-request-id')?.trim();
    return requestId && REQUEST_ID_PATTERN.test(requestId)
      ? requestId
      : randomUUID();
  }

  private getHeader(req: FastifyRequest, name: string): string | undefined {
    const value = req.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private getIpAddress(req: FastifyRequest): string | null {
    const ipAddress = req.ip?.trim();
    return ipAddress ? ipAddress : null;
  }

  private observeRequest(
    startedAt: bigint,
    method: string,
    tool: string,
    outcome: string,
  ): void {
    this.metricsService.observeRequest({
      method,
      tool,
      outcome,
      durationSeconds:
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
  }

  private normalizeError(
    err: unknown,
    requestId: string,
    toolName: string,
  ): HttpException {
    if (err instanceof HttpException) {
      return err;
    }

    this.logger.error({
      event: 'developer_api.request.unhandled_error',
      requestId,
      toolName,
      errorType: getMcpErrorType(err),
    });
    return new InternalServerErrorException('Internal developer API error');
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
