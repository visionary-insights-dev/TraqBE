import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { EmailQueueModule } from '../../jobs/queues/email.queue.js';
import { InvitationsQueueModule } from '../../jobs/queues/invitations.queue.js';

@Module({
  imports: [AuditModule, InvitationsQueueModule, EmailQueueModule, OrganizationsModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}