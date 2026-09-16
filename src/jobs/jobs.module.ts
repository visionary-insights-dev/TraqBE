import { Module } from '@nestjs/common';
import { EmailQueueModule } from './queues/email.queue.js';
import { AssignmentsQueueModule } from './queues/assignments.queue.js';
import { NotificationsQueueModule } from './queues/notifications.queue.js';
import { ReportsQueueModule } from './queues/reports.queue.js';
import { AnalyticsQueueModule } from './queues/analytics.queue.js';
import { BulkImportQueueModule } from './queues/bulk-import.queue.js';
import { InvitationsQueueModule } from './queues/invitations.queue.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { ReportsModule } from '../modules/reports/reports.module.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { ResourcesModule } from '../modules/resources/resources.module.js';
import { InvitationsModule } from '../modules/invitations/invitations.module.js';
import { EmailProcessor } from './processors/email.processor.js';
import { AssignmentReminderProcessor } from './processors/assignment-reminder.processor.js';
import { OverdueAssignmentProcessor } from './processors/overdue-assignment.processor.js';
import { ReportGeneratorProcessor } from './processors/report-generator.processor.js';
import { AnalyticsRefreshProcessor } from './processors/analytics-refresh.processor.js';
import { BulkImportProcessor } from './processors/bulk-import.processor.js';
import { InvitationReminderProcessor } from './processors/invitation-reminder.processor.js';

@Module({
  imports: [
    EmailQueueModule,
    AssignmentsQueueModule,
    NotificationsQueueModule,
    ReportsQueueModule,
    AnalyticsQueueModule,
    BulkImportQueueModule,
    InvitationsQueueModule,
    NotificationsModule,
    ReportsModule,
    AuditModule,
    ResourcesModule,
    InvitationsModule,
  ],
  providers: [
    EmailProcessor,
    AssignmentReminderProcessor,
    OverdueAssignmentProcessor,
    ReportGeneratorProcessor,
    AnalyticsRefreshProcessor,
    BulkImportProcessor,
    InvitationReminderProcessor,
  ],
  exports: [
    EmailQueueModule,
    AssignmentsQueueModule,
    NotificationsQueueModule,
    ReportsQueueModule,
    AnalyticsQueueModule,
    BulkImportQueueModule,
    InvitationsQueueModule,
  ],
})
export class JobsInfrastructureModule {}
