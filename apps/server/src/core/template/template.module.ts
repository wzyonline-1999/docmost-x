import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { TemplateController } from './template.controller';
import { TemplateAccessService } from './services/template-access.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { TemplateService } from './services/template.service';

@Module({
  imports: [PageModule],
  controllers: [TemplateController],
  providers: [TemplateAccessService, TemplateRendererService, TemplateService],
  exports: [TemplateAccessService, TemplateRendererService, TemplateService],
})
export class TemplateModule {}
