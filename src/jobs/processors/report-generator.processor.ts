import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { NotificationChannel, ReportStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../modules/audit/audit.service.js';
import { R2Service } from '../../modules/resources/r2.service.js';
import { ReportsService } from '../../modules/reports/reports.service.js';
import { NotificationsService } from '../../modules/notifications/notifications.service.js';
import { encodeReportCsv } from '../../modules/reports/report-csv.util.js';
import { REPORTS_QUEUE } from '../queues/reports.queue.js';

export interface ReportGeneratorJobData {
  reportId: string;
  organizationId: string;
  type: string;
  parameters: Record<string, unknown>;
  requestedBy: string;
}

/** Download links stay valid for 7 days after generation. */
export const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ReportFiltersParams {
  filters?: Record<string, string | number | boolean>;
}

@Processor(REPORTS_QUEUE)
export class ReportGeneratorProcessor {
  private readonly logger = new Logger(ReportGeneratorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly r2: R2Service,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Process()
  async handleReport(job: Job<ReportGeneratorJobData>): Promise<void> {
    const { reportId, organizationId, type, parameters, requestedBy } = job.data;

    this.logger.log(`Generating report ${reportId} (type: ${type}) for org ${organizationId} (job ${job.id})`);

    // 1. Re-validate state — the report may have been removed since queuing, and
    //    a COMPLETED report must never be regenerated (idempotent retry guard).
    const report = await this.prisma.reportExport.findFirst({
      where: { id: reportId, organization_id: organizationId },
      select: { id: true, status: true },
    });
    if (!report) {
      this.logger.warn(`Skipping job ${job.id}: report ${reportId} not found`);
      return;
    }
    if (report.status === ReportStatus.COMPLETED) {
      this.logger.log(`Skipping job ${job.id}: report ${reportId} already COMPLETED`);
      return;
    }

    // 2. Claim the job — PENDING, PROCESSING and FAILED all re-enter here (a
    //    crash mid-generation is retried by BullMQ with the same jobId).
    await this.prisma.reportExport.updateMany({
      where: { id: reportId, organization_id: organizationId },
      data: { status: ReportStatus.PROCESSING },
    });

    try {
      // 3. Generate rows through the same org-scoped logic as the sync path.
      const rawFilters = (parameters as ReportFiltersParams | undefined)?.filters;
      const rows = await this.reports.getReportData(organizationId, type, rawFilters);

      // 4. Encode CSV (BOM-prefixed so Excel opens UTF-8 correctly).
      const csv = encodeReportCsv(type, rows);

      // 5. Upload to R2 BEFORE marking COMPLETED — a crash must never leave a
      //    COMPLETED row pointing at a missing file. Retries simply re-PUT.
      const objectKey = `reports/${organizationId}/${reportId}.csv`;
      await this.r2.putObject(objectKey, csv, 'text/csv; charset=utf-8');

      const now = new Date();
      await this.prisma.reportExport.updateMany({
        where: { id: reportId, organization_id: organizationId },
        data: {
          status: ReportStatus.COMPLETED,
          r2_key: objectKey,
          completed_at: now,
          expires_at: new Date(now.getTime() + REPORT_TTL_MS),
        },
      });

      await this.audit.log({
        organizationId,
        actorId: requestedBy,
        action: 'REPORT_GENERATED',
        entityType: 'REPORT_EXPORT',
        entityId: reportId,
        metadata: { type, rows: rows.length, objectKey },
      });

      await this.notifyReady(requestedBy, organizationId, reportId, type, rows.length);

      this.logger.log(`Report ${reportId} generated (${rows.length} rows) for job ${job.id}`);
    } catch (err) {
      await this.handleFailure(job, reportId, organizationId, requestedBy, type, err);
      // Rethrow so BullMQ retries with exponential backoff (attempts: 3).
      throw err;
    }
  }

  // =========================================================================
  // Failure path
  // =========================================================================
  private async handleFailure(
    job: Job<ReportGeneratorJobData>,
    reportId: string,
    organizationId: string,
    requestedBy: string,
    type: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.audit.log({
      organizationId,
      actorId: requestedBy,
      action: 'REPORT_GENERATION_FAILED',
      entityType: 'REPORT_EXPORT',
      entityId: reportId,
      metadata: { type, error: message },
    });

    // Only flip to FAILED once retries are exhausted — earlier attempts stay
    // PROCESSING across the backoff so polling shows an in-flight report.
    const attempts = job.opts.attempts ?? 3;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;
    if (isFinalAttempt) {
      await this.prisma.reportExport.updateMany({
        where: { id: reportId, organization_id: organizationId },
        data: { status: ReportStatus.FAILED },
      });
      await this.notifyFailure(requestedBy, organizationId, reportId, type);
    }

    this.logger.error(
      `Failed to generate report ${reportId} (job ${job.id}, attempt ${job.attemptsMade + 1}/${attempts})`,
      err instanceof Error ? err.stack : undefined,
    );
  }

  // =========================================================================
  // Notifications
  // =========================================================================
  private async notifyReady(
    requestedBy: string,
    organizationId: string,
    reportId: string,
    type: string,
    rowCount: number,
  ): Promise<void> {
    const requester = await this.prisma.user.findUnique({
      where: { id: requestedBy },
      select: { email: true },
    });

    const channels: NotificationChannel[] = [NotificationChannel.IN_APP];
    if (requester?.email) {
      channels.push(NotificationChannel.EMAIL);
    }

    await this.notifications.create({
      organizationId,
      userId: requestedBy,
      to: requester?.email,
      type: 'report_ready',
      title: 'Report ready to download',
      body: `Your ${type} report is ready (${rowCount} rows). Open the Reports page to download the CSV.`,
      metadata: { reportId, type, rowCount },
      channels,
      templateId: 'report_ready',
      variables: { reportType: type, rowCount },
    });
  }

  private async notifyFailure(
    requestedBy: string,
    organizationId: string,
    reportId: string,
    type: string,
  ): Promise<void> {
    await this.notifications.create({
      organizationId,
      userId: requestedBy,
      type: 'report_failed',
      title: 'Report generation failed',
      body: `Your ${type} report could not be generated. Please try again.`,
      metadata: { reportId, type },
      channels: [NotificationChannel.IN_APP],
    });
  }
}