import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Role, ScholarAssignmentStatus } from '@prisma/client';
import { AnalyticsService } from './analytics.service.js';
import type { OrgSettingsResult } from '../organizations/organizations.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG = 'org-00000000-0000-0000-0000-000000000001';
const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@a.com', organizationId: ORG, roles: [Role.SUPER_ADMIN] };
const MENTOR: AuthUser = { id: 'u-mentor', email: 'mentor@a.com', organizationId: ORG, roles: [Role.MENTOR] };
const SCHOLAR: AuthUser = { id: 's-1', email: 'scholar@a.com', organizationId: ORG, roles: [Role.SCHOLAR] };
const OTHER_SCHOLAR = 's-2';

const SETTINGS: OrgSettingsResult = {
  assignmentWeight: 0.7,
  attendanceWeight: 0.3,
  atRiskAttendanceThreshold: 70,
  atRiskAssignmentThreshold: 60,
  atRiskOverdueThreshold: 3,
  lateSubmissionPenaltyPercentage: 20,
  assignmentEditWindowMinutes: 60,
  invitationExpiryHours: 48,
};

const emptyMetric = {
  assignmentScore: null,
  attendanceRate: null,
  overallProgress: null,
  isAtRisk: null,
  overdueCount: 0,
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: any;
  let organizationsService: any;
  let audit: any;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      userRole: { findMany: vi.fn(), findFirst: vi.fn() },
      mentorScholarAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
      courseMembership: { findMany: vi.fn(), findFirst: vi.fn() },
      course: { findUnique: vi.fn() },
      scholarAssignment: { findMany: vi.fn(), count: vi.fn() },
      attendanceRecord: { findMany: vi.fn() },
      assignment: { findMany: vi.fn() },
    };
    organizationsService = { getSettings: vi.fn().mockResolvedValue(SETTINGS) };
    audit = { recent: vi.fn(), log: vi.fn() };

    service = new AnalyticsService(prisma as any, organizationsService as any, audit as any);
  });

  // =========================================================================
  // calculateAttendanceRate (pure logic)
  // =========================================================================
  describe('calculateAttendanceRate', () => {
    it('excludes EXCUSED from both numerator and denominator (8 PRESENT, 1 ABSENT, 1 EXCUSED → 88.89)', () => {
      const rate = service.calculateAttendanceRate([
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
      ]);
      expect(rate).toBe(88.89);
    });

    it('returns null when every record is EXCUSED', () => {
      const rate = service.calculateAttendanceRate([
        { status: AttendanceStatus.EXCUSED },
        { status: AttendanceStatus.EXCUSED },
      ]);
      expect(rate).toBeNull();
    });

    it('returns null for an empty list (no division by zero)', () => {
      expect(service.calculateAttendanceRate([])).toBeNull();
    });

    it('returns 100 when all applicable records are PRESENT', () => {
      expect(
        service.calculateAttendanceRate([
          { status: AttendanceStatus.PRESENT },
          { status: AttendanceStatus.PRESENT },
        ]),
      ).toBe(100);
    });

    it('rounds to 2 decimals (2 present / 3 applicable → 66.67)', () => {
      const rate = service.calculateAttendanceRate([
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.PRESENT },
        { status: AttendanceStatus.ABSENT },
      ]);
      expect(rate).toBe(66.67);
    });
  });

  // =========================================================================
  // getDashboard
  // =========================================================================
  describe('getDashboard', () => {
    // One meaningful data setup for org-wide metrics:
    //  u1: VERIFIED 80 + PRESENT | u2: no data | u3: PRESENT+ABSENT (50%)
    function mockOrgWideData() {
      prisma.userRole.findMany.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'u2' },
        { user_id: 'u3' },
      ]);
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 80, assignment: { archived_at: null } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: AttendanceStatus.PRESENT },
        { scholar_id: 'u3', status: AttendanceStatus.PRESENT },
        { scholar_id: 'u3', status: AttendanceStatus.ABSENT },
      ]);
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: 'u1' },
        { user_id: 'u2' },
      ]);
      prisma.scholarAssignment.count
        .mockResolvedValueOnce(1) // PENDING_VERIFICATION
        .mockResolvedValueOnce(2); // OVERDUE
      audit.recent.mockResolvedValue([
        { id: 'a1', action: 'X', entityType: 'Y', entityId: 'z', actorId: 'u-admin', createdAt: new Date() },
      ]);
    }

    it('SUPER_ADMIN gets org-wide metrics', async () => {
      mockOrgWideData();

      const result = await service.getDashboard(ORG, ADMIN);

      // Scholar scope = all active scholars in the org.
      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG, role: 'SCHOLAR' }),
        }),
      );

      expect(result.totalScholars).toBe(3);
      expect(result.activeScholars).toBe(2);
      // u1: assignment 80 (not at-risk), attendance 100 → progress 86, not at-risk.
      // u2: no basis.
      // u3: attendance 50 (<70) → at-risk.
      expect(result.atRiskCount).toBe(1);
      expect(result.avgProgramProgress).toBe(86);
      expect(result.avgAttendanceRate).toBe(75);
      expect(result.pendingVerificationCount).toBe(1);
      expect(result.overdueCount).toBe(2);
      expect(result.recentActivity).toHaveLength(1);

      // Territory counts are org-scoped + NOT scholar-scoped for admins.
      expect(prisma.scholarAssignment.count).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG, status: 'PENDING_VERIFICATION' }),
        }),
      );
      expect(prisma.scholarAssignment.count).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG, status: 'OVERDUE' }),
        }),
      );
    });

    it('MENTOR is scoped to ACTIVE pairings and still gets recent activity', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1' },
        { scholar_id: 'u3' },
      ]);
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.courseMembership.findMany.mockResolvedValue([]);
      prisma.scholarAssignment.count.mockResolvedValue(0);
      audit.recent.mockResolvedValue([]);

      const result = await service.getDashboard(ORG, MENTOR);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG, mentor_id: MENTOR.id, ends_at: null }),
        }),
      );
      expect(result.totalScholars).toBe(2);
      // Territory counts ARE scholar-scoped for mentors.
      expect(prisma.scholarAssignment.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scholar_id: { in: ['u1', 'u3'] },
          }),
        }),
      );
      expect(prisma.scholarAssignment.count).toHaveBeenCalledTimes(2);
      expect(result.recentActivity).toEqual([]);
    });

    it('SCHOLAR only sees self metrics and never a recent-activity feed', async () => {
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: SCHOLAR.id },
      ]);
      prisma.scholarAssignment.count.mockResolvedValue(0);

      const result = await service.getDashboard(ORG, SCHOLAR);

      expect(result.totalScholars).toBe(1);
      expect(result.activeScholars).toBe(1);
      expect(prisma.scholarAssignment.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scholar_id: { in: [SCHOLAR.id] } }),
        }),
      );
      expect(result.recentActivity).toEqual([]);
    });
  });

  // =========================================================================
  // getScholarProgress
  // =========================================================================
  describe('getScholarProgress', () => {
    it('404s when the target is not an active SCHOLAR in the org (never reveals cross-org existence)', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);

      await expect(service.getScholarProgress(ORG, OTHER_SCHOLAR, ADMIN)).rejects.toMatchObject({
        status: 404,
        response: { code: 'SCHOLAR_NOT_FOUND' },
      });

      expect(prisma.userRole.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG,
            user_id: OTHER_SCHOLAR,
            role: 'SCHOLAR',
          }),
        }),
      );
    });

    it('SUPER_ADMIN can read any scholar in the org', async () => {
      prisma.userRole.findFirst.mockResolvedValue({ user_id: 'u1' });
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.courseMembership.findMany.mockResolvedValue([]);

      const result = await service.getScholarProgress(ORG, 'u1', ADMIN);

      expect(result.scholarId).toBe('u1');
      expect(result).toMatchObject(emptyMetric);
      expect(result.overdueCount).toBe(0);
    });

    it('SCHOLAR can read their own progress', async () => {
      prisma.userRole.findFirst.mockResolvedValue({ user_id: SCHOLAR.id });
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.courseMembership.findMany.mockResolvedValue([]);

      const result = await service.getScholarProgress(ORG, SCHOLAR.id, SCHOLAR);

      expect(result.scholarId).toBe(SCHOLAR.id);
    });

    it('blocks SCHOLAR peer access (release-blocking)', async () => {
      prisma.userRole.findFirst.mockResolvedValue({ user_id: OTHER_SCHOLAR });

      await expect(service.getScholarProgress(ORG, OTHER_SCHOLAR, SCHOLAR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('MENTOR can read a scholar they are actively paired with', async () => {
      prisma.userRole.findFirst.mockResolvedValue({ user_id: 'u1' });
      prisma.mentorScholarAssignment.findFirst.mockResolvedValue({ id: 'pair-1' });
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.courseMembership.findMany.mockResolvedValue([]);

      const result = await service.getScholarProgress(ORG, 'u1', MENTOR);

      expect(result.scholarId).toBe('u1');
      expect(prisma.mentorScholarAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG,
            mentor_id: MENTOR.id,
            scholar_id: 'u1',
            ends_at: null,
          }),
        }),
      );
    });

    it('blocks MENTOR reading an unpaired scholar', async () => {
      prisma.userRole.findFirst.mockResolvedValue({ user_id: 'u1' });
      prisma.mentorScholarAssignment.findFirst.mockResolvedValue(null);

      await expect(service.getScholarProgress(ORG, 'u1', MENTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // =========================================================================
  // getCourseMetrics
  // =========================================================================
  describe('getCourseMetrics', () => {
    it('404s when the course does not exist in the caller org (scoped findUnique)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      await expect(service.getCourseMetrics(ORG, 'course-1', ADMIN)).rejects.toMatchObject({
        status: 404,
        response: { code: 'COURSE_NOT_FOUND' },
      });

      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'course-1', organization_id: ORG } }),
      );
    });

    it('blocks SCHOLAR not enrolled in the course', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'course-1', name: 'Course A' });
      prisma.courseMembership.findFirst.mockResolvedValue(null);

      await expect(service.getCourseMetrics(ORG, 'course-1', SCHOLAR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('blocks MENTOR not assigned to the course', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'course-1', name: 'Course A' });
      prisma.mentorScholarAssignment.findFirst.mockResolvedValue(null);

      await expect(service.getCourseMetrics(ORG, 'course-1', MENTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('SUPER_ADMIN gets member roster, at-risk count and completion rates', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'course-1', name: 'Course A' });
      prisma.courseMembership.findMany.mockResolvedValue([
        { user: { id: 'u1', name: 'Ada' } },
        { user: { id: 'u2', name: 'Grace' } },
      ]);
      // u1: VERIFIED 80 + attendance PRESENT+ABSENT (50% → at-risk)
      // u2: no assignments (progress null); attendance PRESENT (100%)
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 80, assignment: { archived_at: null } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: AttendanceStatus.PRESENT },
        { scholar_id: 'u1', status: AttendanceStatus.ABSENT },
        { scholar_id: 'u2', status: AttendanceStatus.PRESENT },
      ]);
      prisma.assignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          title: 'HW 1',
          scholar_assignments: [
            { status: ScholarAssignmentStatus.VERIFIED },
            { status: ScholarAssignmentStatus.PENDING_VERIFICATION },
          ],
        },
      ]);

      const result = await service.getCourseMetrics(ORG, 'course-1', ADMIN);

      expect(result.courseName).toBe('Course A');
      expect(result.totalMembers).toBe(2);
      // u1 at-risk (attendance 50 < 70); u2 attendance 100 + pending (not at-risk).
      expect(result.atRiskCount).toBe(1);
      expect(result.avgAttendanceRate).toBe(75);
      // u1 progress = 80*.7 + 50*.3 = 71; u2 progress = null (no verified score) → only u1.
      expect(result.avgProgress).toBe(71);
      expect(result.assignmentCompletionRates).toEqual([
        { assignmentId: 'a1', title: 'HW 1', submittedCount: 2, verifiedCount: 1, totalMembers: 2 },
      ]);
      expect(result.members).toHaveLength(2);
      expect(result.members[0]).toMatchObject({ scholarId: 'u1', name: 'Ada', assignmentScore: 80, attendanceRate: 50 });
    });

    it('filters member metrics to the course (ignores other-course assignments/attendance)', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'course-1', name: 'Course A' });
      prisma.courseMembership.findMany.mockResolvedValue([
        { user: { id: 'u1', name: 'Ada' } },
      ]);
      // Even if the store returns cross-course rows (shouldn't happen because the
      // query filters by assignment.course_id), the member metric loop recomputes
      // from the course-scoped rows passed in.
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 100, assignment: { archived_at: null } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: AttendanceStatus.EXCUSED },
      ]);
      prisma.assignment.findMany.mockResolvedValue([]);

      const result = await service.getCourseMetrics(ORG, 'course-1', ADMIN);

      expect(result.members[0].assignmentScore).toBe(100);
      expect(result.members[0].attendanceRate).toBeNull();
      // EXCUSED attendance excluded → attendance adds no basis; assignment
      // score 100 still gives a basis → not at risk (false), not null.
      expect(result.members[0].isAtRisk).toBe(false);
    });
  });

  // =========================================================================
  // computeScholarsMetrics (aggregation)
  // =========================================================================
  describe('computeScholarsMetrics', () => {
    it('returns an empty map without hitting the DB when no scholars given', async () => {
      const result = await service.computeScholarsMetrics(ORG, [], SETTINGS);
      expect(result.size).toBe(0);
      expect(prisma.scholarAssignment.findMany).not.toHaveBeenCalled();
    });

    it('computes assignment score from non-archived rows, counts overdue, and applies weights', async () => {
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 80, assignment: { archived_at: null } },
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 60, assignment: { archived_at: null } },
        { scholar_id: 'u1', status: ScholarAssignmentStatus.OVERDUE, earned_credit: null, assignment: { archived_at: null } },
        // Archived assignment — excluded from the score denominator and overdue count.
        { scholar_id: 'u1', status: ScholarAssignmentStatus.VERIFIED, earned_credit: 50, assignment: { archived_at: new Date() } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: AttendanceStatus.PRESENT },
      ]);

      const result = await service.computeScholarsMetrics(ORG, ['u1'], SETTINGS);

      const m = result.get('u1')!;
      // 3 non-archived rows, earned sum 140 → 46.67
      expect(m.assignmentScore).toBe(46.67);
      expect(m.overdueCount).toBe(1);
      expect(m.attendanceRate).toBe(100);
      // 46.67*.7 + 100*.3 = 62.67
      expect(m.overallProgress).toBe(62.67);
      // assignment 46.67 < 60 → at-risk
      expect(m.isAtRisk).toBe(true);
    });

    it('returns null isAtRisk when there is no basis at all', async () => {
      // No assignment rows at all + only EXCUSED attendance → no basis.
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: AttendanceStatus.EXCUSED },
      ]);

      const result = await service.computeScholarsMetrics(ORG, ['u1'], SETTINGS);
      const m = result.get('u1')!;

      expect(m.assignmentScore).toBeNull();
      expect(m.attendanceRate).toBeNull();
      expect(m.overallProgress).toBeNull();
      expect(m.isAtRisk).toBeNull();
    });

    it('marks at-risk from overdue threshold alone', async () => {
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { scholar_id: 'u1', status: ScholarAssignmentStatus.OVERDUE, earned_credit: null, assignment: { archived_at: null } },
        { scholar_id: 'u1', status: ScholarAssignmentStatus.OVERDUE, earned_credit: null, assignment: { archived_at: null } },
        { scholar_id: 'u1', status: ScholarAssignmentStatus.OVERDUE, earned_credit: null, assignment: { archived_at: null } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      const result = await service.computeScholarsMetrics(ORG, ['u1'], SETTINGS);
      expect(result.get('u1')!.isAtRisk).toBe(true);
      expect(result.get('u1')!.overdueCount).toBe(3);
    });
  });

  // =========================================================================
  // computeScholarPerCourse
  // =========================================================================
  describe('computeScholarPerCourse', () => {
    it('breaks down metrics per enrolled course and excludes archived assignments', async () => {
      prisma.courseMembership.findMany.mockResolvedValue([
        { course: { id: 'c1', name: 'Course A' } },
        { course: { id: 'c2', name: 'Course B' } },
      ]);
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { status: ScholarAssignmentStatus.VERIFIED, earned_credit: 100, assignment: { course_id: 'c1', archived_at: null } },
        { status: ScholarAssignmentStatus.VERIFIED, earned_credit: 50, assignment: { course_id: 'c1', archived_at: new Date() } }, // ignored
        { status: ScholarAssignmentStatus.PENDING_VERIFICATION, earned_credit: null, assignment: { course_id: 'c2', archived_at: null } },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { status: AttendanceStatus.PRESENT, meeting: { course_id: 'c1' } },
        { status: AttendanceStatus.ABSENT, meeting: { course_id: 'c2' } },
      ]);

      const result = await service.computeScholarPerCourse(ORG, 'u1', SETTINGS);

      expect(result).toHaveLength(2);
      const [courseA, courseB] = result;
      expect(courseA.courseName).toBe('Course A');
      expect(courseA.assignmentScore).toBe(100);
      expect(courseA.attendanceRate).toBe(100);
      expect(courseA.overallProgress).toBe(100);
      expect(courseB.assignmentScore).toBe(0); // PENDING_VERIFICATION is not VERIFIED → 0 credit
      expect(courseB.attendanceRate).toBe(0);
      expect(courseB.overallProgress).toBe(0);
    });
  });
});