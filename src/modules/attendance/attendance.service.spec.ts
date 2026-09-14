import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendanceStatus } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { AttendanceService } from './attendance.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';
const MEETING_ID = 'meet-00000000-0000-0000-0000-000000000001';
const ORG_B_MEETING_ID = 'meet-00000000-0000-0000-0000-000000000099';
const COURSE_ID = 'course-00000000-0000-0000-0000-000000000001';
const SCHOLAR_1 = 'user-00000000-0000-0000-0000-000000000002';
const SCHOLAR_2 = 'user-00000000-0000-0000-0000-000000000003';
const SCHOLAR_NOT_ENROLLED = 'user-00000000-0000-0000-0000-000000000099';

const STARTS_AT = new Date('2026-01-10T10:00:00.000Z');

const MEETING = {
  id: MEETING_ID,
  organization_id: ORG_A,
  course_id: COURSE_ID,
  title: 'Week 5 Check-in',
  description: null,
  type: 'Lecture',
  duration_minutes: 60,
  starts_at: STARTS_AT,
  ends_at: new Date(STARTS_AT.getTime() + 60 * 60_000),
  recorded_by: ACTOR_ID,
  archived_at: null,
  created_at: STARTS_AT,
  updated_at: STARTS_AT,
};

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-00000000-0000-0000-0000-000000000001',
    organization_id: ORG_A,
    meeting_id: MEETING_ID,
    scholar_id: SCHOLAR_1,
    status: AttendanceStatus.PRESENT,
    notes: null,
    recorded_by: ACTOR_ID,
    created_at: STARTS_AT,
    updated_at: STARTS_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AttendanceService', () => {
  let service: AttendanceService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };
  let meetingsService: { getMeeting: ReturnType<typeof vi.fn> };
  let analyticsService: { calculateAttendanceRate: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };
  let analyticsQueue: { add: ReturnType<typeof vi.fn> };
  let tx: any;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      courseMembership: {
        findMany: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
      },
      attendanceRecord: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
      },
      auditLog: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    tx = {
      notification: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
      },
      notificationDelivery: {
        create: vi.fn().mockResolvedValue({ id: 'deliv-1' }),
      },
    };
    prisma.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) =>
      cb(tx),
    );

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    meetingsService = {
      getMeeting: vi.fn().mockResolvedValue(MEETING),
    };

    analyticsService = {
      calculateAttendanceRate: vi.fn().mockReturnValue(88.89),
    };

    emailQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    analyticsQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    service = new AttendanceService(
      prisma as any,
      audit as any,
      meetingsService as any,
      analyticsService as any,
      emailQueue as any,
      analyticsQueue as any,
    );
  });

  // =========================================================================
  // recordBulk
  // =========================================================================
  describe('recordBulk', () => {
    it('throws MEETING_NOT_FOUND when the meeting belongs to another org (release-blocking)', async () => {
      meetingsService.getMeeting.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      await expect(
        service.recordBulk(ORG_A, MEETING_ID, { records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT }] }, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('throws SCHOLAR_NOT_ENROLLED when a scholar is not a course member', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: SCHOLAR_1 },
      ]);

      await expect(
        service.recordBulk(ORG_A, MEETING_ID, {
          records: [
            { scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT },
            { scholarId: SCHOLAR_NOT_ENROLLED, status: AttendanceStatus.PRESENT },
          ],
        }, ACTOR_ID),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('scopes membership validation by organization_id and course_id', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([]);

      await service.recordBulk(ORG_A, MEETING_ID, { records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT }] }, ACTOR_ID);

      expect(prisma.courseMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG_A,
            course_id: COURSE_ID,
            user_id: { in: [SCHOLAR_1] },
          }),
        }),
      );
    });

    it('upserts a fresh record (allow re-recording) and audits it', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: SCHOLAR_1, email: 's1@example.com' }]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord({ status: AttendanceStatus.ABSENT }));

      const result = await service.recordBulk(ORG_A, MEETING_ID, {
        records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.ABSENT }],
      }, ACTOR_ID);

      expect(prisma.attendanceRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            meeting_id_scholar_id: { meeting_id: MEETING_ID, scholar_id: SCHOLAR_1 },
          },
          create: expect.objectContaining({
            organization_id: ORG_A,
            meeting_id: MEETING_ID,
            scholar_id: SCHOLAR_1,
            status: AttendanceStatus.ABSENT,
            recorded_by: ACTOR_ID,
          }),
          update: expect.objectContaining({
            status: AttendanceStatus.ABSENT,
            recorded_by: ACTOR_ID,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          entityType: 'ATTENDANCE_RECORD',
          metadata: expect.objectContaining({ meetingId: MEETING_ID, scholarId: SCHOLAR_1, status: AttendanceStatus.ABSENT }),
        }),
      );
      expect(result.records[0]).toEqual({ scholarId: SCHOLAR_1, status: AttendanceStatus.ABSENT, isNew: true });
    });

    it('re-records an existing record when status changes (isNew = true)', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: SCHOLAR_1, email: 's1@example.com' }]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(makeRecord({ status: AttendanceStatus.PRESENT }));
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord({ status: AttendanceStatus.EXCUSED }));

      const result = await service.recordBulk(ORG_A, MEETING_ID, {
        records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.EXCUSED }],
      }, ACTOR_ID);

      expect(result.records[0]).toEqual({ scholarId: SCHOLAR_1, status: AttendanceStatus.EXCUSED, isNew: true });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ previousStatus: AttendanceStatus.PRESENT }),
        }),
      );
    });

    it('is a no-op audit when the record already has the same status', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: SCHOLAR_1, email: 's1@example.com' }]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(makeRecord({ status: AttendanceStatus.PRESENT }));
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord({ status: AttendanceStatus.PRESENT }));

      await service.recordBulk(ORG_A, MEETING_ID, {
        records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT }],
      }, ACTOR_ID);

      expect(audit.log).not.toHaveBeenCalled();
      expect(analyticsQueue.add).not.toHaveBeenCalled();
    });

    it('queues a deduplicated analytics refresh per affected scholar', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: SCHOLAR_1, email: 's1@example.com' }]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord());

      await service.recordBulk(ORG_A, MEETING_ID, {
        records: [
          { scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT },
          { scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT },
        ],
      }, ACTOR_ID);

      expect(analyticsQueue.add).toHaveBeenCalledWith(
        'refresh',
        { organizationId: ORG_A, entity: 'scholar', entityId: SCHOLAR_1 },
        { jobId: `analytics-scholar-${ORG_A}-${SCHOLAR_1}` },
      );
    });

    it('creates an in-app notification and queues an email for ABSENT scholars only', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([
        { id: SCHOLAR_1, email: 's1@example.com' },
      ]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord({ status: AttendanceStatus.ABSENT }));

      await service.recordBulk(ORG_A, MEETING_ID, {
        records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.ABSENT }],
      }, ACTOR_ID);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: ORG_A,
            type: 'attendance_absent',
            metadata: expect.objectContaining({ meetingId: MEETING_ID, scholarId: SCHOLAR_1 }),
          }),
        }),
      );
      expect(tx.notificationDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notification_id: 'notif-1',
            user_id: SCHOLAR_1,
            channel: 'IN_APP',
            status: 'PENDING',
          }),
        }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          to: 's1@example.com',
          subject: 'Attendance marked absent',
        }),
      );
    });

    it('does NOT notify or email PRESENT scholars', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([{ user_id: SCHOLAR_1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: SCHOLAR_1, email: 's1@example.com' }]);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.upsert.mockResolvedValue(makeRecord({ status: AttendanceStatus.PRESENT }));

      await service.recordBulk(ORG_A, MEETING_ID, {
        records: [{ scholarId: SCHOLAR_1, status: AttendanceStatus.PRESENT }],
      }, ACTOR_ID);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // correct
  // =========================================================================
  describe('correct', () => {
    it('throws MEETING_NOT_FOUND when the meeting is outside the org (release-blocking)', async () => {
      meetingsService.getMeeting.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      await expect(
        service.correct(ORG_A, MEETING_ID, SCHOLAR_1, { status: AttendanceStatus.PRESENT, correctionReason: 'fix' }, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    });

    it('throws ATTENDANCE_RECORD_NOT_FOUND when no record exists', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);

      await expect(
        service.correct(ORG_A, MEETING_ID, SCHOLAR_1, { status: AttendanceStatus.PRESENT, correctionReason: 'fix' }, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates status and logs ATTENDANCE_CORRECTED with before/after/reason', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue(makeRecord({ status: AttendanceStatus.ABSENT }));
      prisma.attendanceRecord.update.mockResolvedValue(makeRecord({ status: AttendanceStatus.PRESENT }));

      const result = await service.correct(
        ORG_A,
        MEETING_ID,
        SCHOLAR_1,
        { status: AttendanceStatus.PRESENT, correctionReason: 'Was present in the lab' },
        ACTOR_ID,
      );

      expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: makeRecord().id },
          data: { status: AttendanceStatus.PRESENT, recorded_by: ACTOR_ID },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'ATTENDANCE_CORRECTED',
          entityType: 'ATTENDANCE_RECORD',
          metadata: {
            meetingId: MEETING_ID,
            scholarId: SCHOLAR_1,
            from: AttendanceStatus.ABSENT,
            to: AttendanceStatus.PRESENT,
            reason: 'Was present in the lab',
          },
        }),
      );
      expect(analyticsQueue.add).toHaveBeenCalledWith(
        'refresh',
        { organizationId: ORG_A, entity: 'scholar', entityId: SCHOLAR_1 },
        { jobId: `analytics-scholar-${ORG_A}-${SCHOLAR_1}` },
      );
      expect(result).toEqual(
        expect.objectContaining({
          previousStatus: AttendanceStatus.ABSENT,
          status: AttendanceStatus.PRESENT,
          correctionReason: 'Was present in the lab',
        }),
      );
    });
  });

  // =========================================================================
  // history
  // =========================================================================
  describe('history', () => {
    it('throws MEETING_NOT_FOUND when the meeting is outside the org', async () => {
      meetingsService.getMeeting.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      await expect(service.history(ORG_A, MEETING_ID)).rejects.toThrow(NotFoundException);
    });

    it('queries audit_logs org-scoped for ATTENDANCE_CORRECTED actions of this meeting', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);

      await service.history(ORG_A, MEETING_ID);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG_A,
            action: 'ATTENDANCE_CORRECTED',
            entity_type: 'ATTENDANCE_RECORD',
            metadata: { path: ['meetingId'], equals: MEETING_ID },
          }),
        }),
      );
    });

    it('maps corrections with actor, timestamp, before, after and reason', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          entity_id: 'att-1',
          created_at: new Date('2026-01-11T09:00:00.000Z'),
          actor: { id: 'admin-1', name: 'Admin One', email: 'admin@example.com' },
          metadata: {
            meetingId: MEETING_ID,
            scholarId: SCHOLAR_1,
            from: AttendanceStatus.ABSENT,
            to: AttendanceStatus.PRESENT,
            reason: 'Was present in the lab',
          },
        },
      ]);

      const result = await service.history(ORG_A, MEETING_ID);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          attendanceRecordId: 'att-1',
          actor: { id: 'admin-1', name: 'Admin One', email: 'admin@example.com' },
          timestamp: '2026-01-11T09:00:00.000Z',
          before: AttendanceStatus.ABSENT,
          after: AttendanceStatus.PRESENT,
          reason: 'Was present in the lab',
        }),
      );
    });
  });

  // =========================================================================
  // Attendance rate (AnalyticsService.calculateAttendanceRate — REAL impl)
  // =========================================================================
  describe('calculateAttendanceRate (AnalyticsService)', () => {
    const realAnalytics = new AnalyticsService();

    it('excludes EXCUSED sessions — 8 PRESENT, 1 ABSENT, 1 EXCUSED = 88.9 (release-blocking)', () => {
      const records = [
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.ABSENT },
        { status: AttendanceStatus.EXCUSED },
      ];

      const rate = realAnalytics.calculateAttendanceRate(records);

      expect(rate).toBe(88.89);
    });

    it('returns null when there are no applicable sessions (never divide by zero)', () => {
      const rate = realAnalytics.calculateAttendanceRate([
        { status: AttendanceStatus.EXCUSED },
      ]);

      expect(rate).toBeNull();
    });

    it('returns null for an empty list', () => {
      const rate = realAnalytics.calculateAttendanceRate([]);

      expect(rate).toBeNull();
    });

    it('returns 100 when all applicable sessions are present', () => {
      const rate = realAnalytics.calculateAttendanceRate([
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
      ]);

      expect(rate).toBe(100);
    });

    it('returns 50 for 5 present / 5 absent', () => {
      const records = [
        ...Array(5).fill({ status: AttendanceStatus.PRESENT }),
        ...Array(5).fill({ status: AttendanceStatus.ABSENT }),
      ];

      const rate = realAnalytics.calculateAttendanceRate(records);

      expect(rate).toBe(50);
    });
  });
});