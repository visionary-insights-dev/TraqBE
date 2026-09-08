import { Module } from '@nestjs/common';
import { MentorPairingController } from './mentor-pairing.controller.js';
import { MentorPairingService } from './mentor-pairing.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { EmailQueueModule } from '../../jobs/queues/email.queue.js';

@Module({
  imports: [AuditModule, EmailQueueModule],
  controllers: [MentorPairingController],
  providers: [MentorPairingService],
  exports: [MentorPairingService],
})
export class MentorPairingModule {}
