import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { McpMetricsController } from './mcp-metrics.controller';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';

describe('McpMetricsController', () => {
  const token = 'm'.repeat(32);
  const metricsService = {
    contentType: 'text/plain; version=0.0.4',
    metrics: jest.fn().mockResolvedValue('metric 1\n'),
  };
  const environmentService = {
    getMcpMetricsToken: jest.fn(() => token),
  };
  const reply = {
    header: jest.fn(),
  };

  let controller: McpMetricsController;

  beforeEach(() => {
    jest.clearAllMocks();
    environmentService.getMcpMetricsToken.mockReturnValue(token);
    controller = new McpMetricsController(
      metricsService as never,
      environmentService as never,
    );
  });

  it('exposes raw Prometheus text without the REST response envelope', () => {
    expect(
      Reflect.getMetadata(
        SKIP_TRANSFORM_KEY,
        McpMetricsController.prototype.getMetrics,
      ),
    ).toBe(true);
  });

  it('returns Prometheus text for the configured bearer token', async () => {
    await expect(
      controller.getMetrics(`Bearer ${token}`, reply as never),
    ).resolves.toBe('metric 1\n');
    expect(reply.header).toHaveBeenCalledWith(
      'content-type',
      metricsService.contentType,
    );
  });

  it('rejects an invalid token without exposing the configured value', async () => {
    await expect(
      controller.getMetrics(`Bearer ${'x'.repeat(32)}`, reply as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when metrics authentication is not configured', async () => {
    environmentService.getMcpMetricsToken.mockReturnValueOnce(undefined);

    await expect(
      controller.getMetrics(undefined, reply as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
