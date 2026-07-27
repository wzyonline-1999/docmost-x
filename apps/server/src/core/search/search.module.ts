import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { McpModule } from '../mcp/mcp.module';
import { PageModule } from '../page/page.module';
import { SearchRateLimitService } from './search-rate-limit.service';

@Module({
  imports: [McpModule, PageModule],
  controllers: [SearchController],
  providers: [SearchRateLimitService, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
