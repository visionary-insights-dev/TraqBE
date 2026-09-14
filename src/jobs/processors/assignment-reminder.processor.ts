import { Process, Processor } from '@nestjs/bull';
import { AssignmentStatus, NotificationChannel, ScholarAssignmentStatus } from '@prisma/client';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../../modules/notifications/notifications.service.js';
import { ASSIGNMENTS_QUEUE } from '../queues/assignments.queue.js';

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
    private readonly notifications: NotificationsService,
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

      // 3. In-app + email notification (after commit — via NotificationsService).
      await this.notifications.create({
        organizationId,
        userId: scholarId,
        to: scholar.email,
        type: 'assignment_reminder',
        title: 'Assignment reminder',
        body,
        metadata: {
          assignmentId,
          scholarId,
          type,
        },
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        templateId: type === '24h' ? 'assignment_reminder_24h' : 'assignment_reminder_1h',
        variables: {
          title,
          dueDate: dueAt ? dueAt.toISOString() : 'the scheduled date',
        },
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