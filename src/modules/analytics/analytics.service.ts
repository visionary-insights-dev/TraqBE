import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrganizationsService, OrgSettingsResult } from '../organizations/organizations.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

/**
 * Aggregate metrics for a single scholar computed on-demand.
 * `isAtRisk` is `null` when there is no basis for an at-risk determination
 * (no attendance, no assignment data and zero overdue assignments).
 */
export interface ScholarMetrics {
  assignmentScore: number | null;
  attendanceRate: number | null;
  overallProgress: number | null;
  isAtRisk: boolean | null;
  overdueCount: number;
}

export interface AnalyticsDashboardPayload {
  totalScholars: number;
  activeScholars: number;
  atRiskCount: number;
  avgProgramProgress: number | null;
  avgAttendanceRate: number | null;
  pendingVerificationCount: number;
  overdueCount: number;
  recentActivity: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    actorId: string;
    createdAt: Date;
  }>;
}

export interface ScholarCourseMetric {
  courseId: string;
  courseName: string;
  assignmentScore: number | null;
  attendanceRate: number | null;
  overallProgress: number | null;
}

export interface ScholarProgressPayload {
  scholarId: string;
  assignmentScore: number | null;
  attendanceRate: number | null;
  overallProgress: number | null;
  isAtRisk: boolean | null;
  overdueCount: number;
  perCourse: ScholarCourseMetric[];
}

export interface AssignmentCompletionRate {
  assignmentId: string;
  title: string;
  submittedCount: number;
  verifiedCount: number;
  totalMembers: number;
}

export interface CourseMemberMetric {
  scholarId: string;
  name: string;
  assignmentScore: number | null;
  attendanceRate: number | null;
  overallProgress: number | null;
  isAtRisk: boolean | null;
}

export interface CourseMetricsPayload {
  courseId: string;
  courseName: string;
  totalMembers: number;
  atRiskCount: number;
  avgProgress: number | null;
  avgAttendanceRate: number | null;
  assignmentCompletionRates: AssignmentCompletionRate[];
  members: CourseMemberMetric[];
}

const SUBMITTED_STATUSES = ['PENDING_VERIFICATION', 'VERIFIED', 'VERIFIED_LATE'];
const VERIFIED_STATUSES = ['VERIFIED', 'VERIFIED_LATE'];

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationsService: OrganizationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Calculate the attendance rate from a list of attendance records.
   *
   * Formula:
   *   rate = present_count / (present_count + absent_count) * 100
   *
   * EXCUSED sessions are excluded from both the numerator and denominator.
   * Returns `null` when no applicable sessions exist (avoids division by zero).
   *
   * Example: 8 PRESENT, 1 ABSENT, 1 EXCUSED → 88.89
   */
  calculateAttendanceRate(records: { status: AttendanceStatus }[]): number | null {
    const applicable = records.filter((r) => r.status !== AttendanceStatus.EXCUSED);

    if (applicable.length === 0) {
      return null;
    }

    const presentCount = applicable.filter(
      (r) => r.status === AttendanceStatus.PRESENT,
    ).length;

    // Round to 2 decimal places to avoid floating point artifacts
    return Math.round((presentCount / applicable.length) * 10000) / 100;
  }

  // =========================================================================
  // DASHBOARD
  // =========================================================================
  /**
   * Org-scoped dashboard metrics.
   *
   * - SUPER_ADMIN → org-wide metrics.
   * - MENTOR → metrics limited to their ACTIVE paired scholars.
   * - SCHOLAR → the caller's own metrics only (no recent activity feed).
   */
  async getDashboard(organizationId: string, user: AuthUser): Promise<AnalyticsDashboardPayload> {
    const settings = await this.organizationsService.getSettings(organizationId);

    const roles = user.roles ?? [];
    const isSuperAdmin = roles.includes('SUPER_ADMIN');
    const isMentor = roles.includes('MENTOR');

    // Resolve the scholar scope. `null scoped` means org-wide.
    let scholarIds: string[];
    let scoped = false;

    if (isSuperAdmin) {
      const roleRows = await this.prisma.userRole.findMany({
        where: {
          organization_id: organizationId,
          role: 'SCHOLAR',
          user: { archived_at: null },
        },
        select: { user_id: true },
      });
      scholarIds = roleRows.map((r) => r.user_id);
    } else if (isMentor) {
      const pairings = await this.prisma.mentorScholarAssignment.findMany({
        where: { organization_id: organizationId, mentor_id: user.id, ends_at: null },
        select: { scholar_id: true },
        distinct: ['scholar_id'],
      });
      scholarIds = pairings.map((p) => p.scholar_id);
      scoped = true;
    } else {
      scholarIds = [user.id];
      scoped = true;
    }

    const metrics = await this.computeScholarsMetrics(organizationId, scholarIds, settings);
    const scholarMetrics = [...metrics.values()];

    const atRiskCount = scholarMetrics.filter((m) => m.isAtRisk === true).length;
    const progressValues = scholarMetrics
      .map((m) => m.overallProgress)
      .filter((v): v is number => v !== null);
    const attendanceValues = scholarMetrics
      .map((m) => m.attendanceRate)
      .filter((v): v is number => v !== null);

    const avgProgramProgress =
      progressValues.length > 0
        ? this.round2(progressValues.reduce((sum, v) => sum + v, 0) / progressValues.length)
        : null;
    const avgAttendanceRate =
      attendanceValues.length > 0
        ? this.round2(attendanceValues.reduce((sum, v) => sum + v, 0) / attendanceValues.length)
        : null;

    // Scholars with ≥1 course membership in the org (exclude archived users).
    const memberships = await this.prisma.courseMembership.findMany({
      where: {
        organization_id: organizationId,
        user_id: { in: scholarIds },
        user: { archived_at: null },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });

    const scopeFilter: Prisma.ScholarAssignmentWhereInput = scoped
      ? { scholar_id: { in: scholarIds } }
      : {};

    const [pendingVerificationCount, overdueCount] = await Promise.all([
      this.prisma.scholarAssignment.count({
        where: { organization_id: organizationId, status: 'PENDING_VERIFICATION', ...scopeFilter },
      }),
      this.prisma.scholarAssignment.count({
        where: { organization_id: organizationId, status: 'OVERDUE', ...scopeFilter },
      }),
    ]);

    const recentActivity =
      isSuperAdmin || isMentor ? await this.audit.recent(organizationId, 10) : [];

    return {
      totalScholars: scholarIds.length,
      activeScholars: memberships.length,
      atRiskCount,
      avgProgramProgress,
      avgAttendanceRate,
      pendingVerificationCount,
      overdueCount,
      recentActivity,
    };
  }

  // =========================================================================
  // SCHOLAR PROGRESS
  // =========================================================================
  /**
   * Progress for a single scholar.
   *
   * Access: SUPER_ADMIN any scholar in the org; MENTOR only ACTIVE-paired
   * scholars; SCHOLAR only themselves (peers can never read each other).
   */
  async getScholarProgress(
    organizationId: string,
    scholarId: string,
    user: AuthUser,
  ): Promise<ScholarProgressPayload> {
    // Target must be an active SCHOLAR in this org — never reveal cross-org existence.
    const target = await this.prisma.userRole.findFirst({
      where: {
        organization_id: organizationId,
        user_id: scholarId,
        role: 'SCHOLAR',
        user: { archived_at: null },
      },
      select: { user_id: true },
    });
    if (!target) {
      throw new NotFoundException({ code: 'SCHOLAR_NOT_FOUND', message: 'Scholar not found' });
    }

    await this.assertScholarReadAccess(organizationId, scholarId, user);

    const settings = await this.organizationsService.getSettings(organizationId);
    const metrics = await this.computeScholarsMetrics(organizationId, [scholarId], settings);
    const m = metrics.get(scholarId) ?? this.emptyScholarMetrics();

    const perCourse = await this.computeScholarPerCourse(organizationId, scholarId, settings);

    return {
      scholarId,
      assignmentScore: m.assignmentScore,
      attendanceRate: m.attendanceRate,
      overallProgress: m.overallProgress,
      isAtRisk: m.isAtRisk,
      overdueCount: m.overdueCount,
      perCourse,
    };
  }

  // =========================================================================
  // COURSE METRICS
  // =========================================================================
  /**
   * Course-level metrics: member progress, at-risk roster and assignment
   * completion rates. Member metrics are computed within the course scope.
   */
  async getCourseMetrics(
    organizationId: string,
    courseId: string,
    user: AuthUser,
  ): Promise<CourseMetricsPayload> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId, organization_id: organizationId },
      select: { id: true, name: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    await this.assertCourseReadAccess(organizationId, courseId, user);

    const settings = await this.organizationsService.getSettings(organizationId);

    // Members (active users) of this course.
    const memberships = await this.prisma.courseMembership.findMany({
      where: { organization_id: organizationId, course_id: courseId, user: { archived_at: null } },
      select: { user: { select: { id: true, name: true } } },
    });
    const memberIds = memberships.map((m) => m.user.id);
    const nameById = new Map(memberships.map((m) => [m.user.id, m.user.name]));
    const totalMembers = memberIds.length;

    // Batch fetch the course-scoped scholar assignments + attendances.
    const assignments = await this.prisma.scholarAssignment.findMany({
      where: {
        organization_id: organizationId,
        scholar_id: { in: memberIds },
        assignment: { course_id: courseId },
      },
      select: {
        scholar_id: true,
        status: true,
        earned_credit: true,
        assignment: { select: { archived_at: true } },
      },
    });
    const attendances = await this.prisma.attendanceRecord.findMany({
      where: {
        organization_id: organizationId,
        scholar_id: { in: memberIds },
        meeting: { course_id: courseId },
      },
      select: { scholar_id: true, status: true },
    });

    const memberMetrics = new Map<string, ScholarMetrics>();
    for (const memberId of memberIds) {
      const scoreRows = assignments.filter(
        (a) => a.scholar_id === memberId && a.assignment.archived_at === null,
      );
      const overdueRows = assignments.filter(
        (a) => a.scholar_id === memberId && a.status === 'OVERDUE',
      );
      const attendanceRows = attendances.filter((at) => at.scholar_id === memberId);

      const assignmentScore = this.computeAssignmentScore(scoreRows);
      const attendanceRate = this.calculateAttendanceRate(attendanceRows);
      const overallProgress = this.computeOverallProgress(assignmentScore, attendanceRate, settings);
      const overdueCount = overdueRows.length;

      memberMetrics.set(memberId, {
        assignmentScore,
        attendanceRate,
        overallProgress,
        isAtRisk: this.computeIsAtRisk(assignmentScore, attendanceRate, overdueCount, settings),
        overdueCount,
      });
    }

    // Assignment completion rates for the course (non-archived assignments).
    const courseAssignments = await this.prisma.assignment.findMany({
      where: { organization_id: organizationId, course_id: courseId, archived_at: null },
      select: {
        id: true,
        title: true,
        scholar_assignments: { select: { status: true } },
      },
      orderBy: { created_at: 'asc' },
    });

    const assignmentCompletionRates: AssignmentCompletionRate[] = courseAssignments.map((a) => {
      const submissions = a.scholar_assignments;
      return {
        assignmentId: a.id,
        title: a.title,
        submittedCount: submissions.filter((sa) => SUBMITTED_STATUSES.includes(sa.status)).length,
        verifiedCount: submissions.filter((sa) => VERIFIED_STATUSES.includes(sa.status)).length,
        totalMembers,
      };
    });

    const courseMetrics = [...memberMetrics.values()];
    const atRiskCount = courseMetrics.filter((m) => m.isAtRisk === true).length;
    const progressValues = courseMetrics
      .map((m) => m.overallProgress)
      .filter((v): v is number => v !== null);
    const attendanceValues = courseMetrics
      .map((m) => m.attendanceRate)
      .filter((v): v is number => v !== null);

    const members: CourseMemberMetric[] = memberIds.map((memberId) => {
      const m = memberMetrics.get(memberId) ?? this.emptyScholarMetrics();
      return {
        scholarId: memberId,
        name: nameById.get(memberId) ?? '',
        assignmentScore: m.assignmentScore,
        attendanceRate: m.attendanceRate,
        overallProgress: m.overallProgress,
        isAtRisk: m.isAtRisk,
      };
    });

    return {
      courseId: course.id,
      courseName: course.name,
      totalMembers,
      atRiskCount,
      avgProgress:
        progressValues.length > 0
          ? this.round2(progressValues.reduce((sum, v) => sum + v, 0) / progressValues.length)
          : null,
      avgAttendanceRate:
        attendanceValues.length > 0
          ? this.round2(attendanceValues.reduce((sum, v) => sum + v, 0) / attendanceValues.length)
          : null,
      assignmentCompletionRates,
      members,
    };
  }

  // =========================================================================
  // ACCESS CONTROL
  // =========================================================================
  private async assertScholarReadAccess(
    organizationId: string,
    scholarId: string,
    user: AuthUser,
  ): Promise<void> {
    const roles = user.roles ?? [];
    if (roles.includes('SUPER_ADMIN')) return;

    if (roles.includes('SCHOLAR')) {
      // Release-blocking: peers can never read each other's progress.
      if (scholarId !== user.id) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: "You cannot access another scholar's progress",
        });
      }
      return;
    }

    if (roles.includes('MENTOR')) {
      const pairing = await this.prisma.mentorScholarAssignment.findFirst({
        where: {
          organization_id: organizationId,
          mentor_id: user.id,
          scholar_id: scholarId,
          ends_at: null,
        },
        select: { id: true },
      });
      if (!pairing) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You are not paired with this scholar',
        });
      }
      return;
    }

    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Forbidden' });
  }

  private async assertCourseReadAccess(
    organizationId: string,
    courseId: string,
    user: AuthUser,
  ): Promise<void> {
    const roles = user.roles ?? [];
    if (roles.includes('SUPER_ADMIN')) return;

    if (roles.includes('SCHOLAR')) {
      const membership = await this.prisma.courseMembership.findFirst({
        where: { organization_id: organizationId, course_id: courseId, user_id: user.id },
        select: { id: true },
      });
      if (!membership) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You are not enrolled in this course',
        });
      }
      return;
    }

    if (roles.includes('MENTOR')) {
      const pairing = await this.prisma.mentorScholarAssignment.findFirst({
        where: {
          organization_id: organizationId,
          course_id: courseId,
          mentor_id: user.id,
          ends_at: null,
        },
        select: { id: true },
      });
      if (!pairing) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You are not assigned to this course',
        });
      }
      return;
    }

    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Forbidden' });
  }

  // =========================================================================
  // METRIC COMPUTATION
  // =========================================================================

  /**
   * Compute aggregate metrics for a set of scholars.
   *
   * - assignment_score = avg(earned_credit where VERIFIED/VERIFIED_LATE)
   *     across non-archived assignment rows   (null when none)
   *     earned_credit is already 0–100 so no further scaling needed.
   * - attendance_rate  = calculateAttendanceRate(...) (null when none)
   * - overdue_count    = count(ScholarAssignment status OVERDUE)
   * - overall_progress = weighted sum; null when either component is null
   * - is_at_risk       = threshold checks against org settings; null when there
   *     is no basis at all (no attendance, no assignment score, zero overdue)
   */
  async computeScholarsMetrics(
    organizationId: string,
    scholarIds: string[],
    settings: OrgSettingsResult,
  ): Promise<Map<string, ScholarMetrics>> {
    const results = new Map<string, ScholarMetrics>();
    for (const scholarId of scholarIds) {
      results.set(scholarId, this.emptyScholarMetrics());
    }
    if (scholarIds.length === 0) return results;

    const [assignments, attendances] = await Promise.all([
      this.prisma.scholarAssignment.findMany({
        where: { organization_id: organizationId, scholar_id: { in: scholarIds } },
        select: {
          scholar_id: true,
          status: true,
          earned_credit: true,
          assignment: { select: { archived_at: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { organization_id: organizationId, scholar_id: { in: scholarIds } },
        select: { scholar_id: true, status: true },
      }),
    ]);

    const assignByScholar = new Map<string, typeof assignments>();
    for (const row of assignments) {
      const list = assignByScholar.get(row.scholar_id) ?? [];
      list.push(row);
      assignByScholar.set(row.scholar_id, list);
    }

    const attendanceByScholar = new Map<string, typeof attendances>();
    for (const row of attendances) {
      const list = attendanceByScholar.get(row.scholar_id) ?? [];
      list.push(row);
      attendanceByScholar.set(row.scholar_id, list);
    }

    for (const scholarId of scholarIds) {
      const m = results.get(scholarId)!;

      const rows = assignByScholar.get(scholarId) ?? [];
      const scoreRows = rows.filter((r) => r.assignment.archived_at === null);
      m.assignmentScore = this.computeAssignmentScore(scoreRows);
      m.overdueCount = rows.filter((r) => r.status === 'OVERDUE').length;

      const records = attendanceByScholar.get(scholarId) ?? [];
      m.attendanceRate = this.calculateAttendanceRate(records);

      m.overallProgress = this.computeOverallProgress(m.assignmentScore, m.attendanceRate, settings);
      m.isAtRisk = this.computeIsAtRisk(m.assignmentScore, m.attendanceRate, m.overdueCount, settings);
    }

    return results;
  }

  /**
   * Per-course breakdown for a scholar over their enrolled courses (from
   * CourseMemberships). Assignment score and attendance rate are scoped to the
   * course; overall progress uses the org weights.
   */
  async computeScholarPerCourse(
    organizationId: string,
    scholarId: string,
    settings: OrgSettingsResult,
  ): Promise<ScholarCourseMetric[]> {
    const memberships = await this.prisma.courseMembership.findMany({
      where: {
        organization_id: organizationId,
        user_id: scholarId,
        course: { archived_at: null },
      },
      select: { course: { select: { id: true, name: true } } },
    });

    const [assignments, attendances] = await Promise.all([
      this.prisma.scholarAssignment.findMany({
        where: { organization_id: organizationId, scholar_id: scholarId },
        select: {
          status: true,
          earned_credit: true,
          assignment: { select: { course_id: true, archived_at: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { organization_id: organizationId, scholar_id: scholarId },
        select: {
          status: true,
          meeting: { select: { course_id: true } },
        },
      }),
    ]);

    const result: ScholarCourseMetric[] = [];
    for (const membership of memberships) {
      const courseId = membership.course.id;
      const courseRows = assignments.filter((a) => a.assignment.course_id === courseId);
      const scoreRows = courseRows.filter((a) => a.assignment.archived_at === null);
      const courseAttendance = attendances.filter((at) => at.meeting.course_id === courseId);

      const assignmentScore = this.computeAssignmentScore(scoreRows);
      const attendanceRate = this.calculateAttendanceRate(courseAttendance);
      const overallProgress = this.computeOverallProgress(assignmentScore, attendanceRate, settings);

      result.push({
        courseId,
        courseName: membership.course.name,
        assignmentScore,
        attendanceRate,
        overallProgress,
      });
    }

    return result;
  }

  private computeAssignmentScore(
    rows: { status: string; earned_credit: number | null }[],
  ): number | null {
    const total = rows.length;
    if (total === 0) return null;

    const earned = rows
      .filter((r) => r.status === 'VERIFIED' || r.status === 'VERIFIED_LATE')
      .reduce((sum, r) => sum + (r.earned_credit ?? 0), 0);

    // earned_credit is already a 0–100 percentage (100 − penalty), so the
    // average is the assignment score directly.
    return this.round2(earned / total);
  }

  private computeOverallProgress(
    assignmentScore: number | null,
    attendanceRate: number | null,
    settings: OrgSettingsResult,
  ): number | null {
    if (assignmentScore === null || attendanceRate === null) return null;
    return this.round2(
      assignmentScore * settings.assignmentWeight + attendanceRate * settings.attendanceWeight,
    );
  }

  private computeIsAtRisk(
    assignmentScore: number | null,
    attendanceRate: number | null,
    overdueCount: number,
    settings: OrgSettingsResult,
  ): boolean | null {
    const noBasis = attendanceRate === null && assignmentScore === null && overdueCount === 0;
    if (noBasis) return null;

    return (
      (attendanceRate !== null && attendanceRate < settings.atRiskAttendanceThreshold) ||
      (assignmentScore !== null && assignmentScore < settings.atRiskAssignmentThreshold) ||
      overdueCount >= settings.atRiskOverdueThreshold
    );
  }

  private emptyScholarMetrics(): ScholarMetrics {
    return {
      assignmentScore: null,
      attendanceRate: null,
      overallProgress: null,
      isAtRisk: null,
      overdueCount: 0,
    };
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}