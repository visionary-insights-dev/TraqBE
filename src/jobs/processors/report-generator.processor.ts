import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { REPORTS_QUEUE } from '../queues/reports.queue.js';

export interface ReportGeneratorJobData {
  reportId: string;
  organizationId: string;
  type: string;
  parameters: Record<string, unknown>;
  requestedBy: string;
}

@Processor(REPORTS_QUEUE)
export class ReportGeneratorProcessor {
  private readonly logger = new Logger(ReportGeneratorProcessor.name);

  @Process()
  async handleReport(job: Job<ReportGeneratorJobData>): Promise<void> {
    const { reportId, organizationId, type, parameters, requestedBy } =
      job.data;

    this.logger.log(
      `Generating report ${reportId} (type: ${type}) for org ${organizationId}`,
    );

    // TODO: Implement report generation
    // 1. Re-validate: check report.status is PENDING or PROCESSING
    // 2. If already COMPLETED → skip (idempotent)
    // 3. Update report.status → PROCESSING
    // 4. Generate report (query data, build CSV/PDF)
    // 5. Upload to R2, update report.file_url
    // 6. Update report.status → COMPLETED
    // 7. Log failures to Sentry, set report.status → FAILED

    this.logger.log(`Report ${reportId} generated for job ${job.id}`);
  }
}
