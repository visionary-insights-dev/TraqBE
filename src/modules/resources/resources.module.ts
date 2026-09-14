import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';
import { R2Service } from './r2.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [ResourcesController],
  providers: [R2Service, ResourcesService],
  exports: [R2Service, ResourcesService],
})
export class ResourcesModule {}
