import { InjectQueue, Process, Processor } from '@nestjs/bull';
import {
  AssignmentStatus,
  DeliveryStatus,
  NotificationChannel,
  ScholarAssignmentStatus,
} from '@prisma/client';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ASSIGNMENTS_QUEUE } from '../queues/assignments.queue.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../queues/email.queue.js';

export interface AssignmentReminderJobData {
  assignmentId: string;
  scholarId: string;
  organizationId: string;
  type: '24h' | '1h';
}

/** Scholar assignments that are already completed or submitted — never re-notify. */
const COMPLETED_OR_SUBMITTED_STATUSES: ScholarAssignmentStatus[] = [
  ScholarAssignmentStatus.VERIFIED,
  ScholarAssignmentStatus.VERIFIED_LATE,
  ScholarAssignmentStatus.PENDING_VERIFICATION,
];

@Processor(ASSIGNMENTS_QUEUE)
export class AssignmentReminderProcessor {
  private readonly logger = new Logger(AssignmentReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  @Process('reminder')
  async handleReminder(job: Job<AssignmentReminderJobData>): Promise<void> {
    const { assignmentId, scholarId, organizationId, type } = job.data;

    this.logger.log(
      `Processing assignment ${type} reminder for scholar ${scholarId}, assignment ${assignmentId} (job ${job.id})`,
    );

    try {
      // 1. Re-validate state — job may be stale since it was queued.
      //    findFirst keeps the query org-scoped (multi-tenancy).
      const scholarAssignment = await this.prisma.scholarAssignment.findFirst({
        where: {
          assignment_id: assignmentId,
          scholar_id: scholarId,
          organization_id: organizationId,
        },
        include: {
          assignment: {
            select: {
              title: true,
              due_at: true,
              status: true,
            },
          },
        },
      });

      // Stale job — the row no longer exists. Skip quietly, don't throw.
      if (!scholarAssignment) {
        this.logger.warn(
          `Skipping assignment ${type} reminder for scholar ${scholarId}: scholar_assignment not found (job ${job.id})`,
        );
        return;
      }

      // Guard: already completed, verified, or pending verification → do not re-notify.
      if (COMPLETED_OR_SUBMITTED_STATUSES.includes(scholarAssignment.status)) {
        this.logger.log(
          `Skipping assignment ${type} reminder for scholar ${scholarId}: already ${scholarAssignment.status} (job ${job.id})`,
        );
        return;
      }

      // Guard: only PUBLISHED assignments should remind scholars.
      if (scholarAssignment.assignment.status !== AssignmentStatus.PUBLISHED) {
        this.logger.log(
          `Skipping assignment ${type} reminder for scholar ${scholarId}: assignment not PUBLISHED (job ${job.id})`,
        );
        return;
      }

      // 2. Scholar email — needed for the EMAIL_QUEUE dispatch job.
      const scholar = await this.prisma.user.findUnique({
        where: { id: scholarId },
        select: { email: true },
      });

      if (!scholar?.email) {
        this.logger.warn(
          `Skipping assignment ${type} reminder email for scholar ${scholarId}: no email on file (job ${job.id})`,
        );
        return;
      }

      const title = scholarAssignment.assignment.title;
      const dueAt = scholarAssignment.assignment.due_at;
      const subject =
        type === '24h' ? 'Assignment due in 24 hours' : 'Assignment due in 1 hour';
      const body =
        type === '24h' ? 'Assignment due in 24 hours' : 'Assignment due in 1 hour';

      // 3. In-app Notification + PENDING NotificationDelivery (org-scoped).
      await this.prisma.$transaction(async (tx) => {
        const notification = await tx.notification.create({
          data: {
            organization_id: organizationId,
            title: 'Assignment reminder',
            body,
            type: 'assignment_reminder',
            metadata: {
              assignmentId,
              scholarId,
              type,
            },
          },
        });

        await tx.notificationDelivery.create({
          data: {
            notification_id: notification.id,
            user_id: scholarId,
            channel: NotificationChannel.IN_APP,
            status: DeliveryStatus.PENDING,
          },
        });
      });

      // 4. Queue email dispatch — actual send is handled by EmailProcessor.
      await this.emailQueue.add({
        organizationId,
        to: scholar.email,
        subject,
        html: `Assignment "<strong>${title}</strong>" is due on ${
          dueAt?.toISOString() ?? 'the scheduled date'
        }. Please submit before the deadline.`,
      });

      this.logger.log(
        `Assignment ${type} reminder sent for scholar ${scholarId}, assignment ${assignmentId} (job ${job.id})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to process assignment ${type} reminder for scholar ${scholarId}, assignment ${assignmentId} (job ${job.id})`,
        err instanceof Error ? err.stack : undefined,
      );
      // Rethrow so BullMQ retries with exponential backoff.
      throw err;
    }
  }
}