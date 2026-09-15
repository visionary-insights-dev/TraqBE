import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../queues/email.queue.js';
import { INVITATIONS_QUEUE } from '../queues/invitations.queue.js';
import type { InvitationReminderJobData } from '../queues/invitations.queue.js';

@Processor(INVITATIONS_QUEUE)
export class InvitationReminderProcessor {
  private readonly logger = new Logger(InvitationReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  @Process('reminder')
  async handleReminder(job: Job<InvitationReminderJobData>): Promise<void> {
    const { invitationId, organizationId, type } = job.data;

    this.logger.log(
      `Processing invitation ${type} reminder for ${invitationId} (job ${job.id})`,
    );

    try {
      // 1. Re-validate state — job may be stale since it was queued.
      //    findFirst keeps the query org-scoped (multi-tenancy).
      const invitation = await this.prisma.invitation.findFirst({
        where: { id: invitationId, organization_id: organizationId },
      });

      // Stale job — the row no longer exists. Skip quietly, don't throw.
      if (!invitation) {
        this.logger.warn(
          `Skipping: invitation ${invitationId} not found (job ${job.id})`,
        );
        return;
      }

      // Guard A — already used.
      if (invitation.used_at) {
        this.logger.log(
          `Skipping: invitation already used (job ${job.id})`,
        );
        return;
      }

      // Guard B — already expired (applies to both types: the 24h reminder
      // isn't useful once expired, and the 4h-before-expiry reminder
      // definitely isn't).
      if (invitation.expires_at.getTime() < Date.now()) {
        this.logger.log(
          `Skipping: invitation already expired (job ${job.id})`,
        );
        return;
      }

      // 2. Queue the email (never send inline). Trust the DB row over
      //    job.data.email — the row is the source of truth.
      const subject =
        type === '24h'
          ? 'Your invitation expires in 24 hours'
          : 'Your invitation expires soon';

      await this.emailQueue.add({
        organizationId,
        to: invitation.email,
        subject,
        templateId:
          type === '24h' ? 'invitation_reminder_24h' : 'invitation_reminder_expiry',
        variables: { expiryDate: invitation.expires_at.toISOString() },
      });

      this.logger.log(
        `Invitation ${type} reminder queued for ${invitationId} (job ${job.id})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to process invitation ${type} reminder for ${invitationId} (job ${job.id})`,
        err instanceof Error ? err.stack : undefined,
      );
      // Rethrow so BullMQ retries with exponential backoff.
      throw err;
    }
  }
}