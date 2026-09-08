import { Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { EmailQueueModule } from '../../jobs/queues/email.queue.js';
import { AssignmentsQueueModule } from '../../jobs/queues/assignments.queue.js';
import { AnalyticsQueueModule } from '../../jobs/queues/analytics.queue.js';

@Module({
  imports: [
    AuditModule,
    OrganizationsModule,
    EmailQueueModule,
    AssignmentsQueueModule,
    AnalyticsQueueModule,
  ],
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}