import {
  Controller,
  Get,
  Headers,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { McpMetricsService } from './services/mcp-metrics.service';

@Controller('mcp/metrics')
export class McpMetricsController {
  constructor(
    private readonly metricsService: McpMetricsService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Get()
  @SkipTransform()
  async getMetrics(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    this.assertAuthorized(authorization);
    reply.header('content-type', this.metricsService.contentType);
    return this.metricsService.metrics();
  }

  private assertAuthorized(authorization?: string): void {
    const expected = this.environmentService.getMcpMetricsToken();
    if (!expected) {
      throw new ServiceUnavailableException('MCP metrics are not configured');
    }

    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new UnauthorizedException('Invalid MCP metrics token');
    }
  }
}
