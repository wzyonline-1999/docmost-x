import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { McpAdminController } from './mcp-admin.controller';
import { McpController } from './mcp.controller';
import { McpAdminService } from './services/mcp-admin.service';
import { McpAuditService } from './services/mcp-audit.service';
import { McpEmbeddingService } from './services/mcp-embedding.service';
import { McpIdempotencyService } from './services/mcp-idempotency.service';
import { McpPermissionService } from './services/mcp-permission.service';
import { McpRateLimitService } from './services/mcp-rate-limit.service';
import { McpToolService } from './services/mcp-tool.service';
import { McpTokenService } from './services/mcp-token.service';
import { McpVectorIndexService } from './services/mcp-vector-index.service';
import { McpVectorIndexListener } from './services/mcp-vector-index.listener';
import { McpVectorTextService } from './services/mcp-vector-text.service';
import { McpActorAccessService } from './services/mcp-actor-access.service';
import { McpVectorEligibilityService } from './services/mcp-vector-eligibility.service';
import { McpVectorIndexProcessor } from './processors/mcp-vector-index.processor';
import { McpMetricsController } from './mcp-metrics.controller';
import { McpMetricsService } from './services/mcp-metrics.service';

@Module({
  imports: [PageModule],
  controllers: [McpController, McpAdminController, McpMetricsController],
  providers: [
    McpAdminService,
    McpActorAccessService,
    McpAuditService,
    McpEmbeddingService,
    McpIdempotencyService,
    McpMetricsService,
    McpPermissionService,
    McpRateLimitService,
    McpToolService,
    McpTokenService,
    McpVectorEligibilityService,
    McpVectorIndexProcessor,
    McpVectorIndexService,
    McpVectorIndexListener,
    McpVectorTextService,
  ],
  exports: [
    McpAdminService,
    McpActorAccessService,
    McpAuditService,
    McpEmbeddingService,
    McpIdempotencyService,
    McpMetricsService,
    McpPermissionService,
    McpRateLimitService,
    McpToolService,
    McpTokenService,
    McpVectorEligibilityService,
    McpVectorIndexService,
    McpVectorTextService,
  ],
})
export class McpModule {}
