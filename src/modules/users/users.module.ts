import { Module } from '@nestjs/common';
import { UserManagementController } from './users.controller.js';
import { UserManagementService } from './users.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { EmailQueueModule } from '../../jobs/queues/email.queue.js';
import { BulkImportQueueModule } from '../../jobs/queues/bulk-import.queue.js';

@Module({
  imports: [AuditModule, EmailQueueModule, BulkImportQueueModule],
  controllers: [UserManagementController],
  providers: [UserManagementService],
  exports: [UserManagementService],
})
export class UserManagementModule {}
