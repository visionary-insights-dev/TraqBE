import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScholarAssignmentStatus } from '@prisma/client';
import { CoursesService } from './courses.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';
const PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000001';
const OTHER_PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000099';
const COURSE_ID = 'course-00000000-0000-0000-0000-000000000001';
const OTHER_COURSE_ID = 'course-00000000-0000-0000-0000-000000000099';
const USER_IN_ORG = 'user-00000000-0000-0000-0000-000000000002';
const USER_NOT_IN_ORG = 'user-00000000-0000-0000-0000-000000000003';

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');

function makeCourse(overrides: Record<string, unknown> = {}) {
  return {
    id: COURSE_ID,
    program_id: PROGRAM_ID,
    name: 'Financial Literacy 101',
    description: 'Foundational personal finance',
    archived_at: null,
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    organization_id: ORG_A,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CoursesService', () => {
  let service: CoursesService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      course: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      program: {
        findUnique: vi.fn(),
      },
      courseMembership: {
        findMany: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
      },
      userRole: {
        findFirst: vi.fn(),
      },
      scholarAssignment: {
        findFirst: vi.fn(),
      },
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    service = new CoursesService(prisma as any, audit as any);
  });

  // =========================================================================
  // listCourses
  // =========================================================================
  describe('listCourses', () => {
    it('returns { data, meta } with correct total, totalPages, page and limit', async () => {
      prisma.course.findMany.mockResolvedValue([
        { ...makeCourse(), _count: { assignments: 3, course_memberships: 5 } },
        { ...makeCourse({ id: OTHER_COURSE_ID }), _count: { assignments: 1, course_memberships: 2 } },
      ]);
      prisma.course.count.mockResolvedValue(9);

      const result = await service.listCourses(ORG_A, { page: 3, limit: 2, archived: false });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: COURSE_ID,
          programId: PROGRAM_ID,
          assignmentCount: 3,
          memberCount: 5,
        }),
      );
      expect(result.meta).toEqual({ total: 9, totalPages: 5, page: 3, limit: 2 });
    });

    it('uses archived_at: null when archived=false', async () => {
      prisma.course.findMany.mockResolvedValue([]);
      prisma.course.count.mockResolvedValue(0);

      await service.listCourses(ORG_A, { page: 1, limit: 25, archived: false });

      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('uses archived_at: { not: null } when archived=true', async () => {
      prisma.course.findMany.mockResolvedValue([]);
      prisma.course.count.mockResolvedValue(0);

      await service.listCourses(ORG_A, { page: 1, limit: 25, archived: true });

      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
    });

    it('scopes the query by organization_id', async () => {
      prisma.course.findMany.mockResolvedValue([]);
      prisma.course.count.mockResolvedValue(0);

      await service.listCourses(ORG_A, { page: 1, limit: 25, archived: false });

      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.course.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });
  });

  // =========================================================================
  // createCourse
  // =========================================================================
  describe('createCourse', () => {
    it('verifies the program belongs to the calling org before creating', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.course.create.mockResolvedValue(makeCourse());

      await service.createCourse(ORG_A, { programId: PROGRAM_ID, name: 'Financial Literacy 101' }, ACTOR_ID);

      expect(prisma.program.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROGRAM_ID, organization_id: ORG_A },
        }),
      );
      expect(prisma.course.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          program_id: PROGRAM_ID,
          name: 'Financial Literacy 101',
        }),
      });
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND when the program is not in the org (cross-tenant)', async () => {
      // ORG_A admin tries to create a course under an ORG_B program.
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.createCourse(ORG_A, { programId: OTHER_PROGRAM_ID, name: 'X' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.course.create).not.toHaveBeenCalled();
    });

    it('logs audit with COURSE_CREATED', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.course.create.mockResolvedValue(makeCourse());

      await service.createCourse(ORG_A, { programId: PROGRAM_ID, name: 'Financial Literacy 101' }, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'COURSE_CREATED',
          entityType: 'COURSE',
          entityId: COURSE_ID,
          metadata: expect.objectContaining({ name: 'Financial Literacy 101', programId: PROGRAM_ID }),
        }),
      );
    });

    it('returns the shaped course object', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.course.create.mockResolvedValue(makeCourse());

      const result = await service.createCourse(ORG_A, { programId: PROGRAM_ID, name: 'Financial Literacy 101' }, ACTOR_ID);

      expect(result).toEqual(
        expect.objectContaining({
          id: COURSE_ID,
          programId: PROGRAM_ID,
          name: 'Financial Literacy 101',
          archivedAt: null,
        }),
      );
    });
  });

  // =========================================================================
  // getCourse
  // =========================================================================
  describe('getCourse', () => {
    it('returns a course with program include and counts', async () => {
      prisma.course.findUnique.mockResolvedValue({
        ...makeCourse(),
        program: { id: PROGRAM_ID, name: 'TMF Leadership Accelerator' },
        _count: { assignments: 2, course_memberships: 4 },
      });

      const result = await service.getCourse(ORG_A, COURSE_ID);

      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: COURSE_ID, organization_id: ORG_A },
          include: expect.objectContaining({
            program: { select: { id: true, name: true } },
          }),
        }),
      );
      expect(result.program).toEqual({ id: PROGRAM_ID, name: 'TMF Leadership Accelerator' });
      expect(result.assignmentCount).toBe(2);
      expect(result.memberCount).toBe(4);
    });

    it('throws NotFoundException COURSE_NOT_FOUND when findUnique returns null (cross-tenant or nonexistent)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.getCourse(ORG_A, COURSE_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
    });
  });

  // =========================================================================
  // updateCourse
  // =========================================================================
  describe('updateCourse', () => {
    it('only updates the provided fields', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.course.update.mockResolvedValue(makeCourse({ name: 'Updated Name' }));

      await service.updateCourse(ORG_A, COURSE_ID, { name: 'Updated Name' }, ACTOR_ID);

      const data = prisma.course.update.mock.calls[0][0].data;
      expect(data).toEqual(expect.objectContaining({ name: 'Updated Name' }));
      expect(data).not.toHaveProperty('description');
      expect(data).not.toHaveProperty('program');
    });

    it('scopes the existence check to the organization', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.course.update.mockResolvedValue(makeCourse());

      await service.updateCourse(ORG_A, COURSE_ID, { name: 'X' }, ACTOR_ID);

      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: COURSE_ID, organization_id: ORG_A },
        select: { id: true },
      });
    });

    it('can update programId only if that program is in the same org', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.program.findUnique.mockResolvedValue({ id: OTHER_PROGRAM_ID });
      prisma.course.update.mockResolvedValue(makeCourse({ program_id: OTHER_PROGRAM_ID }));

      await service.updateCourse(ORG_A, COURSE_ID, { programId: OTHER_PROGRAM_ID }, ACTOR_ID);

      expect(prisma.program.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_PROGRAM_ID, organization_id: ORG_A } }),
      );
      expect(prisma.course.update).toHaveBeenCalledWith({
        where: { id: COURSE_ID },
        data: expect.objectContaining({ program: { connect: { id: OTHER_PROGRAM_ID } } }),
      });
    });

    it('throws PROGRAM_NOT_FOUND when reassigning to a program outside the org', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.updateCourse(ORG_A, COURSE_ID, { programId: OTHER_PROGRAM_ID }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException COURSE_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.updateCourse(ORG_A, OTHER_COURSE_ID, { name: 'X' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('calls audit with COURSE_UPDATED', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.course.update.mockResolvedValue(makeCourse({ description: 'New desc' }));

      await service.updateCourse(ORG_A, COURSE_ID, { description: 'New desc' }, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'COURSE_UPDATED',
          entityType: 'COURSE',
          entityId: COURSE_ID,
          metadata: expect.objectContaining({ description: 'New desc' }),
        }),
      );
    });
  });

  // =========================================================================
  // archiveCourse
  // =========================================================================
  describe('archiveCourse', () => {
    it('sets archived_at and returns { id, archivedAt, message }', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, archived_at: null });
      prisma.course.update.mockResolvedValue({ id: COURSE_ID, archived_at: BASE_DATE });

      const result = await service.archiveCourse(ORG_A, COURSE_ID, ACTOR_ID);

      expect(result).toEqual({
        id: COURSE_ID,
        archivedAt: BASE_DATE.toISOString(),
        message: 'Course archived. Historical data is preserved.',
      });
      expect(prisma.course.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: COURSE_ID },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
    });

    it('throws NotFoundException COURSE_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.archiveCourse(ORG_A, OTHER_COURSE_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException COURSE_ALREADY_ARCHIVED when already archived', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, archived_at: BASE_DATE });

      try {
        await service.archiveCourse(ORG_A, COURSE_ID, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_ALREADY_ARCHIVED' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('calls audit with COURSE_ARCHIVED', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, archived_at: null });
      prisma.course.update.mockResolvedValue({ id: COURSE_ID, archived_at: BASE_DATE });

      await service.archiveCourse(ORG_A, COURSE_ID, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'COURSE_ARCHIVED',
          entityType: 'COURSE',
          entityId: COURSE_ID,
        }),
      );
    });
  });

  // =========================================================================
  // listCourseMembers
  // =========================================================================
  describe('listCourseMembers', () => {
    it('returns members and a total-only summary (no type)', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.courseMembership.findMany.mockResolvedValue([
        { user: { id: 's1', name: 'Scholar One', email: 's1@x.com' } },
        { user: { id: 's2', name: 'Scholar Two', email: 's2@x.com' } },
      ]);

      const result = await service.listCourseMembers(ORG_A, COURSE_ID);

      expect(result.courseId).toBe(COURSE_ID);
      expect(result.members).toHaveLength(2);
      expect(result.members[0]).toEqual(
        expect.objectContaining({ id: 's1', name: 'Scholar One' }),
      );
      // Course members have no membership type.
      expect(result.members[0]).not.toHaveProperty('membershipType');
      expect(result.summary).toEqual({ total: 2 });
    });

    it('scopes the memberships query to the organization and course', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.courseMembership.findMany.mockResolvedValue([]);

      await service.listCourseMembers(ORG_A, COURSE_ID);

      expect(prisma.courseMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A, course_id: COURSE_ID }),
        }),
      );
    });

    it('throws NotFoundException COURSE_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.listCourseMembers(ORG_A, OTHER_COURSE_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // addCourseMember
  // =========================================================================
  describe('addCourseMember', () => {
    it('verifies the user is in the calling org before upserting', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: USER_IN_ORG });
      prisma.courseMembership.upsert.mockResolvedValue({
        id: 'cm-1',
        course_id: COURSE_ID,
        user_id: USER_IN_ORG,
      });

      const result = await service.addCourseMember(ORG_A, COURSE_ID, { userId: USER_IN_ORG }, ACTOR_ID);

      expect(prisma.userRole.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: ORG_A, user_id: USER_IN_ORG },
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ courseId: COURSE_ID, userId: USER_IN_ORG }),
      );
    });

    it('throws NotFoundException USER_NOT_FOUND when the user is not in the calling org (cross-tenant leak prevention)', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.addCourseMember(ORG_A, COURSE_ID, { userId: USER_NOT_IN_ORG }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.upsert).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('throws NotFoundException COURSE_NOT_FOUND when course is in another org', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.addCourseMember(ORG_A, OTHER_COURSE_ID, { userId: USER_IN_ORG }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
    });

    it('calls audit with COURSE_MEMBER_ADDED', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: USER_IN_ORG });
      prisma.courseMembership.upsert.mockResolvedValue({
        id: 'cm-1',
        course_id: COURSE_ID,
        user_id: USER_IN_ORG,
      });

      await service.addCourseMember(ORG_A, COURSE_ID, { userId: USER_IN_ORG }, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'COURSE_MEMBER_ADDED',
          entityType: 'COURSE',
          entityId: COURSE_ID,
          metadata: expect.objectContaining({ userId: USER_IN_ORG }),
        }),
      );
    });
  });

  // =========================================================================
  // removeCourseMember
  // =========================================================================
  describe('removeCourseMember', () => {
    it('throws BadRequestException SCHOLAR_HAS_ACTIVE_ASSIGNMENTS when an active assignment exists', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.scholarAssignment.findFirst.mockResolvedValue({ id: 'sa-1' });

      try {
        await service.removeCourseMember(ORG_A, COURSE_ID, USER_IN_ORG, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'SCHOLAR_HAS_ACTIVE_ASSIGNMENTS' }),
        );
      }
      expect(prisma.scholarAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG_A,
            scholar_id: USER_IN_ORG,
            status: { in: [
              ScholarAssignmentStatus.NOT_STARTED,
              ScholarAssignmentStatus.IN_PROGRESS,
              ScholarAssignmentStatus.PENDING_VERIFICATION,
            ] },
            assignment: { course_id: COURSE_ID },
          }),
        }),
      );
      expect(prisma.courseMembership.deleteMany).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('removes the member when there is no active assignment', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.scholarAssignment.findFirst.mockResolvedValue(null);
      prisma.courseMembership.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeCourseMember(ORG_A, COURSE_ID, USER_IN_ORG, ACTOR_ID);

      expect(prisma.courseMembership.deleteMany).toHaveBeenCalledWith({
        where: {
          organization_id: ORG_A,
          course_id: COURSE_ID,
          user_id: USER_IN_ORG,
        },
      });
      expect(result).toEqual({ removed: true, courseId: COURSE_ID, userId: USER_IN_ORG });
    });

    it('calls audit with COURSE_MEMBER_REMOVED', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.scholarAssignment.findFirst.mockResolvedValue(null);
      prisma.courseMembership.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeCourseMember(ORG_A, COURSE_ID, USER_IN_ORG, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'COURSE_MEMBER_REMOVED',
          entityType: 'COURSE',
          entityId: COURSE_ID,
          metadata: expect.objectContaining({ userId: USER_IN_ORG }),
        }),
      );
    });

    it('throws NotFoundException COURSE_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.removeCourseMember(ORG_A, OTHER_COURSE_ID, USER_IN_ORG, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.scholarAssignment.findFirst).not.toHaveBeenCalled();
      expect(prisma.courseMembership.deleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cross-tenant isolation (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user cannot read an ORG_B course (findUnique null -> 404, no leak)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.getCourse(ORG_A, OTHER_COURSE_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_COURSE_ID, organization_id: ORG_A } }),
      );
    });

    it('ORG_A user cannot patch an ORG_B course', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.updateCourse(ORG_A, OTHER_COURSE_ID, { name: 'X' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot archive an ORG_B course', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.archiveCourse(ORG_A, OTHER_COURSE_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot list members of an ORG_B course', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.listCourseMembers(ORG_A, OTHER_COURSE_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.findMany).not.toHaveBeenCalled();
    });

    it('ORG_A admin cannot add an ORG_B member to an ORG_A course', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID });
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.addCourseMember(ORG_A, COURSE_ID, { userId: USER_NOT_IN_ORG }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.upsert).not.toHaveBeenCalled();
    });

    it('ORG_A admin cannot create a course under an ORG_B program', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.createCourse(ORG_A, { programId: OTHER_PROGRAM_ID, name: 'X' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.course.create).not.toHaveBeenCalled();
    });
  });
});
