import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, ScholarAssignmentStatus } from '@prisma/client';
import { ReportsService, SUPPORTED_REPORT_TYPES } from './reports.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG = 'org-00000000-0000-0000-0000-000000000001';
const ACTOR: AuthUser = { id: 'u-admin', email: 'admin@a.com', organizationId: ORG, roles: ['SUPER_ADMIN'] };

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: any;
  let audit: any;
  let r2Service: any;
  let reportsQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      reportExport: {
        create: vi.fn(),
        findUnique: vi.fn(),
      },
      userRole: { count: vi.fn(), findMany: vi.fn() },
      attendanceRecord: { count: vi.fn(), findMany: vi.fn() },
      scholarAssignment: { count: vi.fn(), findMany: vi.fn() },
      meeting: { count: vi.fn(), findMany: vi.fn() },
    };
    audit = { log: vi.fn().mockResolvedValue(undefined) };
    r2Service = { getDownloadUrl: vi.fn() };
    reportsQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };

    service = new ReportsService(
      prisma as any,
      audit as any,
      r2Service as any,
      reportsQueue as any,
    );
  });

  // =========================================================================
  // create — validation
  // =========================================================================
  describe('create', () => {
    it('supports the documented report types', () => {
      expect(SUPPORTED_REPORT_TYPES).toEqual(['scholars', 'attendance', 'assignments', 'meetings']);
    });

    it('rejects an unsupported report type (REPORT_TYPE_UNSUPPORTED)', async () => {
      await expect(
        service.create(ORG, { type: 'payroll', format: 'csv' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);

      try {
        await service.create(ORG, { type: 'payroll', format: 'csv' }, ACTOR);
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'REPORT_TYPE_UNSUPPORTED' });
      }
      expect(prisma.userRole.count).not.toHaveBeenCalled();
    });

    it('rejects anything other than CSV format (REPORT_FORMAT_UNSUPPORTED)', async () => {
      await expect(
        service.create(ORG, { type: 'scholars', format: 'pdf' as any }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // =========================================================================
  // create — synchronous path (< 1000 rows)
  // =========================================================================
  describe('create (sync path)', () => {
    function mockSyncRows() {
      prisma.userRole.count.mockResolvedValue(5);
      prisma.userRole.findMany.mockResolvedValue([
        { user: { id: 's-1', name: 'Ada', email: 'ada@example.com' } },
      ]);
    }

    it('returns rows + meta with generated:true for small datasets', async () => {
      mockSyncRows();

      const result = await service.create(ORG, { type: 'scholars', format: 'csv' }, ACTOR);

      expect(result).toEqual({
        data: [{ id: 's-1', name: 'Ada', email: 'ada@example.com' }],
        meta: { count: 5, generated: true },
      });
      // No export row, no audit, no queue in the sync path.
      expect(prisma.reportExport.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(reportsQueue.add).not.toHaveBeenCalled();
    });

    it('applies the sync row cap (take: 1000) on non-empty datasets', async () => {
      prisma.userRole.count.mockResolvedValue(999);
      prisma.userRole.findMany.mockResolvedValue([]);

      await service.create(ORG, { type: 'scholars', format: 'csv' }, ACTOR);

      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1000 }),
      );
    });
  });

  // =========================================================================
  // create — asynchronous path (>= 1000 rows)
  // =========================================================================
  describe('create (async path)', () => {
    it('persists a PENDING export, audits REPORT_REQUESTED, and queues the generator job', async () => {
      prisma.attendanceRecord.count.mockResolvedValue(1000);
      prisma.reportExport.create.mockResolvedValue({ id: 'rp-1', status: 'PENDING' });

      const result = await service.create(
        ORG,
        { type: 'attendance', format: 'csv', filters: { courseId: 'c-1', status: 'ABSENT' } },
        ACTOR,
      );

      expect(result).toEqual({ id: 'rp-1', status: 'PENDING' });

      expect(prisma.reportExport.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG,
          type: 'attendance',
          status: 'PENDING',
          format: 'csv',
          requested_by: ACTOR.id,
        }),
      });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          actorId: ACTOR.id,
          action: 'REPORT_REQUESTED',
          entityType: 'REPORT_EXPORT',
          entityId: 'rp-1',
          metadata: { type: 'attendance', format: 'csv', count: 1000 },
        }),
      );

      expect(reportsQueue.add).toHaveBeenCalledWith(
        'generate',
        {
          reportId: 'rp-1',
          organizationId: ORG,
          type: 'attendance',
          parameters: { type: 'attendance', format: 'csv', filters: { courseId: 'c-1', status: 'ABSENT' } },
          requestedBy: ACTOR.id,
        },
        { jobId: 'report-rp-1' },
      );
    });

    it('does not fetch rows synchronously on the async path', async () => {
      prisma.attendanceRecord.count.mockResolvedValue(2000);
      prisma.reportExport.create.mockResolvedValue({ id: 'rp-1' });

      await service.create(ORG, { type: 'attendance', format: 'csv' }, ACTOR);

      expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(reportsQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // get — status polling
  // =========================================================================
  describe('get', () => {
    it('returns status + timestamps for an existing report', async () => {
      prisma.reportExport.findUnique.mockResolvedValue({
        id: 'rp-1',
        status: 'COMPLETED',
        format: 'csv',
        created_at: new Date('2026-09-15T10:00:00Z'),
        completed_at: new Date('2026-09-15T10:00:05Z'),
        expires_at: new Date('2026-09-22T10:00:00Z'),
      });

      const result = await service.get(ORG, 'rp-1');

      expect(result).toEqual({
        id: 'rp-1',
        status: 'COMPLETED',
        format: 'csv',
        createdAt: '2026-09-15T10:00:00.000Z',
        completedAt: '2026-09-15T10:00:05.000Z',
        expiresAt: '2026-09-22T10:00:00.000Z',
      });
    });

    it('scopes the lookup by organization — a foreign org id behaves as 404', async () => {
      prisma.reportExport.findUnique.mockResolvedValue(null);

      await expect(service.get(ORG, 'rp-foreign')).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.reportExport.findUnique).toHaveBeenCalledWith({
        where: { id: 'rp-foreign', organization_id: ORG },
      });
      try {
        await service.get(ORG, 'rp-foreign');
      } catch (err) {
        expect((err as NotFoundException).getResponse()).toMatchObject({ code: 'REPORT_NOT_FOUND' });
      }
    });
  });

  // =========================================================================
  // download — signed R2 URL
  // =========================================================================
  describe('download', () => {
    it('returns a signed URL for a completed, unexpired report', async () => {
      prisma.reportExport.findUnique.mockResolvedValue({
        id: 'rp-1',
        status: 'COMPLETED',
        r2_key: 'reports/org/rp-1.csv',
        expires_at: new Date('2026-09-22T10:00:00Z'),
      });
      r2Service.getDownloadUrl.mockResolvedValue('https://signed-url/csv');

      const result = await service.download(ORG, 'rp-1');

      expect(r2Service.getDownloadUrl).toHaveBeenCalledWith('reports/org/rp-1.csv');
      expect(result).toEqual({ url: 'https://signed-url/csv', expiresInSeconds: 3600 });
    });

    it('404s when the report does not exist in the org', async () => {
      prisma.reportExport.findUnique.mockResolvedValue(null);

      await expect(service.download(ORG, 'rp-foreign')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s REPORT_NOT_READY when status is not COMPLETED', async () => {
      prisma.reportExport.findUnique.mockResolvedValue({
        id: 'rp-1',
        status: 'PENDING',
        r2_key: null,
        expires_at: null,
      });

      try {
        await service.download(ORG, 'rp-1');
        expect.unreachable();
      } catch (err) {
        expect((err as ConflictException).getResponse()).toMatchObject({ code: 'REPORT_NOT_READY' });
      }
      expect(r2Service.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('409s REPORT_NOT_READY when COMPLETED but the R2 key is missing', async () => {
      prisma.reportExport.findUnique.mockResolvedValue({
        id: 'rp-1',
        status: 'COMPLETED',
        r2_key: null,
        expires_at: new Date('2026-09-22T10:00:00Z'),
      });

      await expect(service.download(ORG, 'rp-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('410s REPORT_EXPIRED once the 7-day window has passed', async () => {
      prisma.reportExport.findUnique.mockResolvedValue({
        id: 'rp-1',
        status: 'COMPLETED',
        r2_key: 'reports/org/rp-1.csv',
        expires_at: new Date('2026-09-01T10:00:00Z'), // in the past
      });

      try {
        await service.download(ORG, 'rp-1');
        expect.unreachable();
      } catch (err) {
        expect((err as GoneException).getResponse()).toMatchObject({ code: 'REPORT_EXPIRED' });
      }
      expect(r2Service.getDownloadUrl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Row counting — every count is org-scoped
  // =========================================================================
  describe('countReportRows', () => {
    it('scopes attendance counts by organization_id', async () => {
      prisma.attendanceRecord.count.mockResolvedValue(3);

      const count = await service.countReportRows(ORG, 'attendance', {});

      expect(count).toBe(3);
      expect(prisma.attendanceRecord.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ organization_id: ORG }),
      });
    });

    it('scopes meeting counts by organization_id and excludes archived meetings', async () => {
      prisma.meeting.count.mockResolvedValue(2);

      await service.countReportRows(ORG, 'meetings', {});

      expect(prisma.meeting.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ organization_id: ORG, archived_at: null }),
      });
    });

    it('passes the status filter into assignment counts', async () => {
      prisma.scholarAssignment.count.mockResolvedValue(1);

      await service.countReportRows(ORG, 'assignments', { status: 'OVERDUE' });

      expect(prisma.scholarAssignment.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          organization_id: ORG,
          status: ScholarAssignmentStatus.OVERDUE as unknown as 'OVERDUE',
        }),
      });
    });
  });

  // =========================================================================
  // Row fetching + filters
  // =========================================================================
  describe('fetchReportRows / getReportData', () => {
    it('maps scholars rows and keeps the user un-archived in the where clause', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { user: { id: 's-1', name: 'Ada', email: 'ada@example.com' } },
      ]);

      const rows = await service.fetchReportRows(ORG, 'scholars', {}, 1000);

      expect(rows).toEqual([{ id: 's-1', name: 'Ada', email: 'ada@example.com' }]);
      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG,
            role: 'SCHOLAR',
            user: { archived_at: null },
          }),
        }),
      );
    });

    it('maps attendance rows including meeting title and ISO recordedAt', async () => {
      prisma.attendanceRecord.findMany.mockResolvedValue([
        {
          scholar_id: 's-1',
          scholar: { name: 'Ada' },
          meeting: { title: 'Weekly Sync' },
          status: AttendanceStatus.PRESENT,
          created_at: new Date('2026-09-15T10:00:00Z'),
        },
      ]);

      const rows = await service.fetchReportRows(ORG, 'attendance', {});

      expect(rows[0]).toMatchObject({
        scholarId: 's-1',
        name: 'Ada',
        meetingTitle: 'Weekly Sync',
        status: AttendanceStatus.PRESENT,
        recordedAt: '2026-09-15T10:00:00.000Z',
      });
    });

    it('rejects invalid date filters with INVALID_REPORT_FILTER', async () => {
      await expect(
        service.getReportData(ORG, 'attendance', { dateFrom: 'not-a-date' }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'INVALID_REPORT_FILTER' },
      });
      expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
    });

    it('passes allow-listed filters through to the attendance query', async () => {
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      await service.getReportData(ORG, 'attendance', {
        courseId: 'c-1',
        status: 'ABSENT',
        dateFrom: '2026-09-01',
        dateTo: '2026-09-10',
        ignoredExtra: true,
      });

      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            meeting: { course_id: 'c-1' },
            status: AttendanceStatus.ABSENT,
          }),
        }),
      );
    });
  });
});