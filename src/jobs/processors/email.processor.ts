import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { EMAIL_QUEUE } from '../queues/email.queue.js';

export interface EmailDispatchJobData {
  organizationId: string;
  to: string;
  subject: string;
  html: string;
  notificationId?: string;
}

@Processor(EMAIL_QUEUE)
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);

  @Process()
  async handleEmail(job: Job<EmailDispatchJobData>): Promise<void> {
    const { to, subject, html, notificationId } = job.data;

    this.logger.log(`Processing email job ${job.id} → ${to}`);

    // TODO: Implement Resend email dispatch
    // 1. Re-validate: check if notification delivery already SENT
    // 2. Send via Resend SDK
    // 3. Update notification_deliveries.status = SENT
    // 4. Log failures to Sentry

    this.logger.log(`Email dispatched to ${to} for job ${job.id}`);
  }
}
