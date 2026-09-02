import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { ASSIGNMENTS_QUEUE } from '../queues/assignments.queue.js';

export interface OverdueCheckJobData {
  organizationId?: string; // Optional: check specific org or all
}

@Processor(ASSIGNMENTS_QUEUE)
export class OverdueAssignmentProcessor {
  private readonly logger = new Logger(OverdueAssignmentProcessor.name);

  @Process('check-overdue')
  async handleOverdueCheck(job: Job<OverdueCheckJobData>): Promise<void> {
    this.logger.log(`Running overdue assignment check (job ${job.id})`);

    // TODO: Implement overdue check (cron-triggered)
    // 1. Find all scholar_assignments where:
    //    - status IN (NOT_STARTED, IN_PROGRESS)
    //    - assignment.due_at < now()
    // 2. Update status → OVERDUE
    // 3. Create notifications for overdue scholars
    // 4. Log failures to Sentry

    this.logger.log(`Overdue check completed for job ${job.id}`);
  }
}
