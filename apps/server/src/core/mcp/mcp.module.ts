import { Module } from '@nestjs/common';
import { AttachmentModule } from '../attachment/attachment.module';
import { PageModule } from '../page/page.module';
import { StorageModule } from '../../integrations/storage/storage.module';
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
import { McpPageHistoryService } from './services/mcp-page-history.service';
import { McpAttachmentService } from './services/mcp-attachment.service';
import { McpEffectivePermissionService } from './services/mcp-effective-permission.service';
import { DeveloperApiController } from './developer-api.controller';
import { McpDistributedTaskService } from './services/mcp-distributed-task.service';
import { McpVectorReconciliationService } from './services/mcp-vector-reconciliation.service';
import { McpRetentionService } from './services/mcp-retention.service';
import { TemplateModule } from '../template/template.module';
import { McpTemplateService } from './services/mcp-template.service';
import { McpPageMoveService } from './services/mcp-page-move.service';
import { CatalogContractRegistry } from './services/catalog-contract.registry';
import { McpCatalogBundleService } from './services/mcp-catalog-bundle.service';
import { McpCatalogSnapshotService } from './services/mcp-catalog-snapshot.service';
import { CatalogV2ContractRegistry } from './services/catalog-v2-contract.registry';
import { McpCatalogProofService } from './services/mcp-catalog-proof.service';
import { McpCatalogV2Service } from './services/mcp-catalog-v2.service';

@Module({
  imports: [AttachmentModule, PageModule, StorageModule, TemplateModule],
  controllers: [
    DeveloperApiController,
    McpController,
    McpAdminController,
    McpMetricsController,
  ],
  providers: [
    CatalogContractRegistry,
    CatalogV2ContractRegistry,
    McpAdminService,
    McpAttachmentService,
    McpCatalogBundleService,
    McpCatalogProofService,
    McpCatalogSnapshotService,
    McpCatalogV2Service,
    McpActorAccessService,
    McpAuditService,
    McpEffectivePermissionService,
    McpDistributedTaskService,
    McpEmbeddingService,
    McpIdempotencyService,
    McpMetricsService,
    McpPageHistoryService,
    McpPageMoveService,
    McpPermissionService,
    McpRateLimitService,
    McpRetentionService,
    McpToolService,
    McpTokenService,
    McpTemplateService,
    McpVectorEligibilityService,
    McpVectorIndexProcessor,
    McpVectorIndexService,
    McpVectorIndexListener,
    McpVectorReconciliationService,
    McpVectorTextService,
  ],
  exports: [
    CatalogContractRegistry,
    CatalogV2ContractRegistry,
    McpAdminService,
    McpAttachmentService,
    McpCatalogBundleService,
    McpCatalogProofService,
    McpCatalogSnapshotService,
    McpCatalogV2Service,
    McpActorAccessService,
    McpAuditService,
    McpEffectivePermissionService,
    McpDistributedTaskService,
    McpEmbeddingService,
    McpIdempotencyService,
    McpMetricsService,
    McpPageHistoryService,
    McpPageMoveService,
    McpPermissionService,
    McpRateLimitService,
    McpRetentionService,
    McpToolService,
    McpTokenService,
    McpTemplateService,
    McpVectorEligibilityService,
    McpVectorIndexService,
    McpVectorReconciliationService,
    McpVectorTextService,
  ],
})
export class McpModule {}
