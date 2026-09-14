import { Process, Processor } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { Resend } from 'resend';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../queues/email.queue.js';
import { renderTemplate } from '../templates/email-templates.js';

@Processor(EMAIL_QUEUE)
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);
  private readonly resend: Resend;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.resend = new Resend(config.get<string>('RESEND_API_KEY'));
  }

  @Process()
  async handleEmail(job: Job<EmailDispatchJobData>): Promise<void> {
    const { to, subject } = job.data;

    // 1. Re-validate the delivery state — a job is only marked complete when the
    //    email is actually sent. Skips the send if a previously-sent job retried.
    if (job.data.notificationId) {
      const delivery = await this.prisma.notificationDelivery.findFirst({
        where: {
          notification_id: job.data.notificationId,
          channel: 'EMAIL',
        },
        select: { status: true },
      });
      if (delivery?.status === 'SENT') {
        this.logger.log(`Email already sent for notification ${job.data.notificationId}; skipping`);
        return;
      }
    }

    // 2. Render body — templateId wins, falls back to the legacy raw html body.
    const html =
      job.data.templateId && !job.data.html
        ? renderTemplate(job.data.templateId, job.data.variables ?? {})
        : job.data.html;
    if (!html) {
      throw new Error('Email job has neither html nor a resolvable templateId');
    }

    // 3. Send via Resend.
    const { error } = await this.resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL ?? 'Traq <no-reply@traq.app>',
      to,
      subject,
      html,
    });
    if (error) {
      // Throwing lets BullMQ retry (attempts: 3, exponential backoff).
      throw new Error(`Resend failure: ${error.message}`);
    }

    // 4. Record SENT against the EMAIL delivery (idempotent — updateMany on null status).
    if (job.data.notificationId) {
      await this.prisma.notificationDelivery.updateMany({
        where: {
          notification_id: job.data.notificationId,
          channel: 'EMAIL',
          status: 'PENDING',
        },
        data: { status: 'SENT', sent_at: new Date() },
      });
    }

    this.logger.log(`Email dispatched to ${to} for job ${job.id}`);
  }
}