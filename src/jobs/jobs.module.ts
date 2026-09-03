import { Module } from '@nestjs/common';
import { EmailQueueModule } from './queues/email.queue.js';
import { AssignmentsQueueModule } from './queues/assignments.queue.js';
import { NotificationsQueueModule } from './queues/notifications.queue.js';
import { ReportsQueueModule } from './queues/reports.queue.js';
import { AnalyticsQueueModule } from './queues/analytics.queue.js';
import { EmailProcessor } from './processors/email.processor.js';
import { AssignmentReminderProcessor } from './processors/assignment-reminder.processor.js';
import { OverdueAssignmentProcessor } from './processors/overdue-assignment.processor.js';
import { ReportGeneratorProcessor } from './processors/report-generator.processor.js';
import { AnalyticsRefreshProcessor } from './processors/analytics-refresh.processor.js';

@Module({
  imports: [
    EmailQueueModule,
    AssignmentsQueueModule,
    NotificationsQueueModule,
    ReportsQueueModule,
    AnalyticsQueueModule,
  ],
  providers: [
    EmailProcessor,
    AssignmentReminderProcessor,
    OverdueAssignmentProcessor,
    ReportGeneratorProcessor,
    AnalyticsRefreshProcessor,
  ],
  exports: [
    EmailQueueModule,
    AssignmentsQueueModule,
    NotificationsQueueModule,
    ReportsQueueModule,
    AnalyticsQueueModule,
  ],
})
export class JobsInfrastructureModule {}
