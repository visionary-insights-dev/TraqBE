import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { ASSIGNMENTS_QUEUE } from '../queues/assignments.queue.js';

export interface AssignmentReminderJobData {
  assignmentId: string;
  scholarId: string;
  organizationId: string;
  type: '24h' | '1h';
}

@Processor(ASSIGNMENTS_QUEUE)
export class AssignmentReminderProcessor {
  private readonly logger = new Logger(AssignmentReminderProcessor.name);

  @Process('reminder')
  async handleReminder(job: Job<AssignmentReminderJobData>): Promise<void> {
    const { assignmentId, scholarId, organizationId, type } = job.data;

    this.logger.log(
      `Processing assignment ${type} reminder for scholar ${scholarId}, assignment ${assignmentId}`,
    );

    // TODO: Implement assignment reminder
    // 1. Re-validate: check scholar_assignment.status is not VERIFIED
    // 2. If already VERIFIED → skip (idempotent)
    // 3. Create in-app notification + queue email dispatch
    // 4. Log failures to Sentry

    this.logger.log(`Assignment ${type} reminder sent for job ${job.id}`);
  }
}
