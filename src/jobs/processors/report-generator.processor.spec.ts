import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotificationChannel, ReportStatus } from '@prisma/client';
import { ReportGeneratorProcessor } from './report-generator.processor.js';

describe('ReportGeneratorProcessor', () => {
  let processor: ReportGeneratorProcessor;
  let prisma: any;
  let reports: any;
  let r2: any;
  let audit: any;
  let notifications: any;

  beforeEach(() => {
    prisma = {
      reportExport: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    };
    reports = { getReportData: vi.fn() };
    r2 = { putObject: vi.fn() };
    audit = { log: vi.fn() };
    notifications = { create: vi.fn() };

    processor = new ReportGeneratorProcessor(
      prisma,
      reports,
      r2,
      audit,
      notifications,
    );
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const BASE_JOB = {
    data: {
      reportId: 'report-1',
      organizationId: 'org-1',
      type: 'scholars',
      parameters: { type: 'scholars', filters: {}, format: 'csv' },
      requestedBy: 'user-1',
    },
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
  };

  function expectCompletedUpdate() {
    const call = prisma.reportExport.updateMany.mock.calls.find(
      (c: any[]) => c[0].data.status === ReportStatus.COMPLETED,
    );
    expect(call).toBeDefined();
    const { data, where } = call[0];
    expect(where).toEqual({ id: 'report-1', organization_id: 'org-1' });
    expect(data.status).toBe(ReportStatus.COMPLETED);
    expect(data.r2_key).toBe('reports/org-1/report-1.csv');
    expect(data.completed_at).toBeInstanceOf(Date);
    expect(data.expires_at).toBeInstanceOf(Date);
    expect(data.expires_at.getTime() - data.completed_at.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  }

  // =========================================================================
  // Tests
  // =========================================================================
  it('generates, uploads to R2, marks COMPLETED, audits, and notifies the requester', async () => {
    prisma.reportExport.findFirst.mockResolvedValue({
      id: 'report-1',
      status: ReportStatus.PENDING,
    });
    reports.getReportData.mockResolvedValue([
      { id: 's-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    ]);
    r2.putObject.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue({ email: 'admin@example.com' });

    await processor.handleReport(BASE_JOB as any);

    // Claims PROCESSING before any generation work.
    expect(prisma.reportExport.updateMany).toHaveBeenCalledWith({
      where: { id: 'report-1', organization_id: 'org-1' },
      data: { status: ReportStatus.PROCESSING },
    });

    // Rows fetched org-scoped through the shared service.
    expect(reports.getReportData).toHaveBeenCalledWith('org-1', 'scholars', {});

    // CSV uploaded before completion is recorded (real encoder output, BOM-prefixed).
    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const [objectKey, csv, contentType] = r2.putObject.mock.calls[0];
    expect(objectKey).toBe('reports/org-1/report-1.csv');
    expect(csv).toBeInstanceOf(Buffer);
    expect(csv.toString('utf8').startsWith('\uFEFF')).toBe(true);
    expect(csv.toString('utf8')).toContain('s-1,Ada Lovelace,ada@example.com');
    expect(contentType).toBe('text/csv; charset=utf-8');

    expectCompletedUpdate();

    expect(audit.log).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorId: 'user-1',
      action: 'REPORT_GENERATED',
      entityType: 'REPORT_EXPORT',
      entityId: 'report-1',
      metadata: { type: 'scholars', rows: 1, objectKey: 'reports/org-1/report-1.csv' },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        to: 'admin@example.com',
        type: 'report_ready',
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        templateId: 'report_ready',
        variables: { reportType: 'scholars', rowCount: 1 },
      }),
    );
  });

  it('skips when the report is already COMPLETED (idempotent retry guard)', async () => {
    prisma.reportExport.findFirst.mockResolvedValue({
      id: 'report-1',
      status: ReportStatus.COMPLETED,
    });

    await processor.handleReport(BASE_JOB as any);

    expect(prisma.reportExport.updateMany).not.toHaveBeenCalled();
    expect(reports.getReportData).not.toHaveBeenCalled();
    expect(r2.putObject).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('skips silently when the report no longer exists (stale job)', async () => {
    prisma.reportExport.findFirst.mockResolvedValue(null);

    await processor.handleReport(BASE_JOB as any);

    expect(prisma.reportExport.updateMany).not.toHaveBeenCalled();
    expect(reports.getReportData).not.toHaveBeenCalled();
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it('marks FAILED and notifies on the final retry attempt, then rethrows', async () => {
    prisma.reportExport.findFirst.mockResolvedValue({
      id: 'report-1',
      status: ReportStatus.PROCESSING,
    });
    reports.getReportData.mockRejectedValue(new Error('db exploded'));

    const job = { ...BASE_JOB, attemptsMade: 2 };

    await expect(processor.handleReport(job as any)).rejects.toThrow('db exploded');

    // Failure is audited regardless of attempt count.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REPORT_GENERATION_FAILED',
        metadata: { type: 'scholars', error: 'db exploded' },
      }),
    );

    expect(prisma.reportExport.updateMany).toHaveBeenCalledWith({
      where: { id: 'report-1', organization_id: 'org-1' },
      data: { status: ReportStatus.FAILED },
    });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'report_failed',
        channels: [NotificationChannel.IN_APP],
      }),
    );
  });

  it('does NOT flip FAILED or notify failure before retries are exhausted', async () => {
    prisma.reportExport.findFirst.mockResolvedValue({
      id: 'report-1',
      status: ReportStatus.PENDING,
    });
    reports.getReportData.mockRejectedValue(new Error('transient'));

    const job = { ...BASE_JOB, attemptsMade: 0 };

    await expect(processor.handleReport(job as any)).rejects.toThrow('transient');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_GENERATION_FAILED' }),
    );
    // Processed transition happened, but no FAILED flip.
    expect(prisma.reportExport.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.reportExport.updateMany).toHaveBeenCalledWith({
      where: { id: 'report-1', organization_id: 'org-1' },
      data: { status: ReportStatus.PROCESSING },
    });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('passes the stored report filters through to row generation', async () => {
    prisma.reportExport.findFirst.mockResolvedValue({
      id: 'report-1',
      status: ReportStatus.PENDING,
    });
    reports.getReportData.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue(null);

    const job = {
      ...BASE_JOB,
      data: {
        ...BASE_JOB.data,
        type: 'attendance',
        parameters: {
          type: 'attendance',
          format: 'csv',
          filters: { courseId: 'course-1', status: 'ABSENT', dateFrom: '2026-09-01' },
        },
      },
    };

    await processor.handleReport(job as any);

    expect(reports.getReportData).toHaveBeenCalledWith(
      'org-1',
      'attendance',
      { courseId: 'course-1', status: 'ABSENT', dateFrom: '2026-09-01' },
    );
    // No email → in-app only.
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ channels: [NotificationChannel.IN_APP] }),
    );
  });
});