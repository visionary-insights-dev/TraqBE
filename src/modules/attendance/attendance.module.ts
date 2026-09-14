import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AnalyticsQueueModule } from '../../jobs/queues/analytics.queue.js';

@Module({
  imports: [
    AuditModule,
    MeetingsModule,
    AnalyticsModule,
    NotificationsModule,
    AnalyticsQueueModule,
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
