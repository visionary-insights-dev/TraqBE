import { InjectQueue, Process, Processor } from '@nestjs/bull';
import {
  DeliveryStatus,
  NotificationChannel,
  ScholarAssignmentStatus,
} from '@prisma/client';
import { Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ASSIGNMENTS_QUEUE } from '../queues/assignments.queue.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../queues/email.queue.js';

export interface OverdueCheckJobData {
  organizationId?: string; // Optional: check specific org or all
}

/** Only these statuses are eligible to be marked OVERDUE. */
const OVERDUE_CANDIDATE_STATUSES: ScholarAssignmentStatus[] = [
  ScholarAssignmentStatus.NOT_STARTED,
  ScholarAssignmentStatus.IN_PROGRESS,
];

@Processor(ASSIGNMENTS_QUEUE)
export class OverdueAssignmentProcessor implements OnModuleInit {
  private readonly logger = new Logger(OverdueAssignmentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
    @InjectQueue(ASSIGNMENTS_QUEUE)
    private readonly assignmentsQueue: Queue<OverdueCheckJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Hourly repeatable job. Fixed jobId dedupes re-deploys/re-inits of this
      // module — BullMQ will not stack duplicate repeat rules.
      await this.assignmentsQueue.add(
        'check-overdue',
        {},
        {
          repeat: { every: 3_600_000 },
          jobId: 'overdue-check-cron',
          removeOnComplete: true,
        },
      );
      this.logger.log('Registered hourly overdue check repeatable job');
    } catch (err) {
      // Never crash startup if Redis is unavailable.
      this.logger.error('Failed to register overdue check cron (hourly repeatable)', err);
    }
  }

  @Process('check-overdue')
  async handleOverdueCheck(job: Job<OverdueCheckJobData>): Promise<void> {
    this.logger.log(`Running overdue assignment check (job ${job.id})`);

    try {
      const whereOrg = job.data.organizationId
        ? { organization_id: job.data.organizationId }
        : {};

      // 1. Find candidates — only NOT_STARTED/IN_PROGRESS rows whose assignment
      //    is past due. Guard per AGENTS.md: never flip VERIFIED/submitted rows.
      const overdueCandidates = await this.prisma.scholarAssignment.findMany({
        where: {
          ...whereOrg,
          status: { in: OVERDUE_CANDIDATE_STATUSES },
          assignment: {
            is: {
              due_at: { lt: new Date() },
            },
          },
        },
        select: {
          id: true,
          assignment_id: true,
          scholar_id: true,
          organization_id: true,
          assignment: {
            select: {
              title: true,
              due_at: true,
            },
          },
        },
      });

      // 2. Bulk update — idempotent: the status filter above guarantees only
      //    still-eligible rows change; re-running is a no-op.
      const overdueIds = overdueCandidates.map((row) => row.id);
      const updateResult = overdueIds.length
        ? await this.prisma.scholarAssignment.updateMany({
            where: { id: { in: overdueIds } },
            data: { status: ScholarAssignmentStatus.OVERDUE },
          })
        : { count: 0 };

      // 3. Notify each overdue scholar (in-app) + queue email dispatch.
      const scholarIds = [...new Set(overdueCandidates.map((row) => row.scholar_id))];
      const scholars = scholarIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: scholarIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailById = new Map(scholars.map((s) => [s.id, s.email]));

      for (const candidate of overdueCandidates) {
        await this.prisma.$transaction(async (tx) => {
          const notification = await tx.notification.create({
            data: {
              organization_id: candidate.organization_id,
              title: 'Assignment overdue',
              body: `Assignment "${candidate.assignment.title}" is overdue. Please submit as soon as possible.`,
              type: 'assignment_overdue',
              metadata: {
                scholarAssignmentId: candidate.id,
                assignmentId: candidate.assignment_id,
              },
            },
          });

          await tx.notificationDelivery.create({
            data: {
              notification_id: notification.id,
              user_id: candidate.scholar_id,
              channel: NotificationChannel.IN_APP,
              status: DeliveryStatus.PENDING,
            },
          });
        });

        const email = emailById.get(candidate.scholar_id);
        if (email) {
          await this.emailQueue.add({
            organizationId: candidate.organization_id,
            to: email,
            subject: 'Assignment overdue',
            html: `Assignment "<strong>${candidate.assignment.title}</strong>" was due on ${
              candidate.assignment.due_at?.toISOString() ?? 'the scheduled date'
            }. Please submit as soon as possible.`,
          });
        }
      }

      this.logger.log(
        `Overdue check completed for job ${job.id}: marked ${updateResult.count} assignments overdue`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to run overdue assignment check (job ${job.id})`,
        err instanceof Error ? err.stack : undefined,
      );
      // Rethrow so BullMQ retries with exponential backoff.
      throw err;
    }
  }
}