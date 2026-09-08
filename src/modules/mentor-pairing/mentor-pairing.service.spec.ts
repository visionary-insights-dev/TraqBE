import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { MentorPairingService } from './mentor-pairing.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';
const COURSE_ID = 'course-00000000-0000-0000-0000-000000000001';
const OTHER_COURSE_ID = 'course-00000000-0000-0000-0000-000000000099';
const PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000001';
const MENTOR_ID = 'user-00000000-0000-0000-0000-000000000002';
const SCHOLAR_ID = 'user-00000000-0000-0000-0000-000000000003';
const SCHOLAR2_ID = 'user-00000000-0000-0000-0000-000000000004';
const NEW_MENTOR_ID = 'user-00000000-0000-0000-0000-000000000005';
const ASSIGNMENT_ID = 'assign-00000000-0000-0000-0000-000000000001';
const ORG_B_ASSIGNMENT_ID = 'assign-00000000-0000-0000-0000-000000000099';

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');

const SUPER_ADMIN_A: AuthUser = {
  id: ACTOR_ID,
  email: 'admin@a.com',
  organizationId: ORG_A,
  roles: [Role.SUPER_ADMIN],
};

const MENTOR_USER: AuthUser = {
  id: MENTOR_ID,
  email: 'mentor@a.com',
  organizationId: ORG_A,
  roles: [Role.MENTOR],
};

const SCHOLAR_USER: AuthUser = {
  id: SCHOLAR_ID,
  email: 'scholar@a.com',
  organizationId: ORG_A,
  roles: [Role.SCHOLAR],
};

// Helper: a fully-shaped MentorScholarAssignment row as returned by prisma
function makeAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_ID,
    organization_id: ORG_A,
    mentor_id: MENTOR_ID,
    scholar_id: SCHOLAR_ID,
    program_id: PROGRAM_ID,
    course_id: COURSE_ID,
    starts_at: BASE_DATE,
    ends_at: null,
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    mentor: { id: MENTOR_ID, name: 'Mentor One', email: 'mentor@a.com' },
    scholar: { id: SCHOLAR_ID, name: 'Scholar One', email: 'scholar@a.com' },
    course: { id: COURSE_ID, name: 'Financial Literacy 101' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MentorPairingService', () => {
  let service: MentorPairingService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      mentorScholarAssignment: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      course: {
        findUnique: vi.fn(),
      },
      userRole: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      courseMembership: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    emailQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    service = new MentorPairingService(prisma as any, audit as any, emailQueue as any);
  });

  // =========================================================================
  // list
  // =========================================================================
  describe('list', () => {
    it('SUPER_ADMIN sees all assignments in the org (no role filter)', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([
        makeAssignment({ id: ASSIGNMENT_ID }),
        makeAssignment({
          id: ORG_B_ASSIGNMENT_ID,
          scholar_id: SCHOLAR2_ID,
          mentor_id: NEW_MENTOR_ID,
        }),
      ]);

      const result = await service.list(ORG_A, SUPER_ADMIN_A);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: ORG_A },
        }),
      );
      // The where must NOT be filtered by mentor_id or scholar_id for SUPER_ADMIN.
      const whereArg = prisma.mentorScholarAssignment.findMany.mock.calls[0][0].where;
      expect(whereArg).not.toHaveProperty('mentor_id');
      expect(whereArg).not.toHaveProperty('scholar_id');
      expect(result).toHaveLength(2);
    });

    it('scopes the query by organization_id', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([]);

      await service.list(ORG_A, SUPER_ADMIN_A);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });

    it('MENTOR user sees ONLY assignments where mentor_id = user.id', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([makeAssignment()]);

      const result = await service.list(ORG_A, MENTOR_USER);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            mentor_id: MENTOR_ID,
          },
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('SCHOLAR user sees ONLY assignments where scholar_id = user.id', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([makeAssignment()]);

      const result = await service.list(ORG_A, SCHOLAR_USER);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            scholar_id: SCHOLAR_ID,
          },
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('shapes the output: omits organization_id and maps camelCase fields', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([makeAssignment()]);

      const result = await service.list(ORG_A, SUPER_ADMIN_A);

      const first = result[0];
      expect(first).not.toHaveProperty('organization_id');
      expect(first).not.toHaveProperty('organizationId');
      expect(first).not.toHaveProperty('created_at');
      expect(first).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          mentor: { id: MENTOR_ID, name: 'Mentor One', email: 'mentor@a.com' },
          scholar: { id: SCHOLAR_ID, name: 'Scholar One', email: 'scholar@a.com' },
          course: { id: COURSE_ID, name: 'Financial Literacy 101' },
        }),
      );
      expect(first.startsAt).toBe(BASE_DATE.toISOString());
      expect(first.endsAt).toBeNull();
      expect(first.endedAt).toBeNull();
    });
  });

  // =========================================================================
  // create — happy path
  // =========================================================================
  describe('create', () => {
    // A valid DTO payload used across the happy-path tests.
    const validDto = {
      mentorId: MENTOR_ID,
      scholarIds: [SCHOLAR_ID, SCHOLAR2_ID],
      courseId: COURSE_ID,
    };

    function setupCreateHappyPath() {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, program_id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: MENTOR_ID });
      prisma.userRole.findMany.mockResolvedValue([
        { user_id: SCHOLAR_ID },
        { user_id: SCHOLAR2_ID },
      ]);
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: MENTOR_ID },
        { user_id: SCHOLAR_ID },
        { user_id: SCHOLAR2_ID },
      ]);
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([]); // no active pairings
      prisma.user.findMany.mockResolvedValue([
        { id: MENTOR_ID, email: 'mentor@a.com', name: 'Mentor One' },
        { id: SCHOLAR_ID, email: 'scholar@a.com', name: 'Scholar One' },
        { id: SCHOLAR2_ID, email: 'scholar2@a.com', name: 'Scholar Two' },
      ]);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: any) => Promise<any>) => cb(prisma),
      );
      prisma.mentorScholarAssignment.create
        .mockResolvedValueOnce({ id: ASSIGNMENT_ID, scholar_id: SCHOLAR_ID })
        .mockResolvedValueOnce({ id: 'assign-2', scholar_id: SCHOLAR2_ID });
    }

    it('scopes the course lookup by organization_id (cross-org course must NOT resolve)', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ACTOR_ID);

      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: COURSE_ID, organization_id: ORG_A },
        select: { id: true, program_id: true },
      });
    });

    it('creates N assignments inside a $transaction and sets starts_at / ends_at null', async () => {
      setupCreateHappyPath();

      const result = await service.create(ORG_A, validDto, ACTOR_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Two create calls within the transaction.
      expect(prisma.mentorScholarAssignment.create).toHaveBeenCalledTimes(2);
      expect(prisma.mentorScholarAssignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          mentor_id: MENTOR_ID,
          scholar_id: SCHOLAR_ID,
          program_id: PROGRAM_ID,
          course_id: COURSE_ID,
          starts_at: expect.any(Date),
        }),
        select: { id: true, scholar_id: true },
      });
      // ends_at is never provided -> stays null by default.
      const dataFirst = prisma.mentorScholarAssignment.create.mock.calls[0][0].data;
      expect(dataFirst).not.toHaveProperty('ends_at');

      expect(result.pairedCount).toBe(2);
      expect(result.assignments).toHaveLength(2);
    });

    it('returns { assignments, pairedCount } in a camelCase shape', async () => {
      setupCreateHappyPath();

      const result = await service.create(ORG_A, validDto, ACTOR_ID);

      expect(result.pairedCount).toBe(2);
      expect(result.assignments).toHaveLength(2);
      const first = result.assignments[0];
      expect(first).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          mentor: { id: MENTOR_ID, name: 'Mentor One', email: 'mentor@a.com' },
          scholar: { id: SCHOLAR_ID, name: 'Scholar One', email: 'scholar@a.com' },
          course: { id: COURSE_ID, name: null },
          endsAt: null,
          endedAt: null,
        }),
      );
      // startsAt is dynamic server time but must be an ISO string, never undefined.
      expect(first.startsAt).toEqual(expect.any(String));
      expect(result.assignments[1].scholar).toEqual(
        expect.objectContaining({ id: SCHOLAR2_ID }),
      );
    });

    it('queues one email to the mentor and one to each scholar', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ACTOR_ID);

      // mentor + 2 scholars = 3 emails
      expect(emailQueue.add).toHaveBeenCalledTimes(3);
      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'mentor@a.com',
        subject: 'New mentor pairing',
        html: expect.any(String),
      });
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'scholar@a.com', subject: 'You have been assigned a mentor' }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'scholar2@a.com', subject: 'You have been assigned a mentor' }),
      );
    });

    it('calls audit.log once per created assignment', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(2);
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ACTOR_ID,
        action: 'MENTOR_ASSIGNMENT_CREATED',
        entityType: 'MENTOR_ASSIGNMENT',
        entityId: ASSIGNMENT_ID,
        metadata: { mentorId: MENTOR_ID, scholarId: SCHOLAR_ID, courseId: COURSE_ID },
      });
    });

    // ------------------------------------------------------------------
    // create — error paths
    // ------------------------------------------------------------------
    it('throws NotFound COURSE_NOT_FOUND when the course does not exist in the org', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      // Simulate a cross-org course: ORG_A caller, ORG_B course id.
      try {
        await service.create(ORG_A, { ...validDto, courseId: OTHER_COURSE_ID }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      // The lookup must be org-scoped.
      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: OTHER_COURSE_ID, organization_id: ORG_A },
        select: { id: true, program_id: true },
      });
      expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('throws BadRequest INVALID_ROLE when the mentor lacks MENTOR role in the org', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, program_id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue(null); // no MENTOR role row

      try {
        await service.create(ORG_A, validDto, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_ROLE' }),
        );
      }
      expect(prisma.userRole.findFirst).toHaveBeenCalledWith({
        where: { organization_id: ORG_A, user_id: MENTOR_ID, role: 'MENTOR' },
        select: { user_id: true },
      });
      expect(prisma.courseMembership.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws BadRequest INVALID_ROLE when a scholar lacks the SCHOLAR role in the org', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, program_id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: MENTOR_ID });
      // Only SCHOLAR_ID has SCHOLAR role; SCHOLAR2_ID is missing.
      prisma.userRole.findMany.mockResolvedValue([{ user_id: SCHOLAR_ID }]);

      try {
        await service.create(
          ORG_A,
          { ...validDto, scholarIds: [SCHOLAR_ID, SCHOLAR2_ID] },
          ACTOR_ID,
        );
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_ROLE' }),
        );
      }
      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            user_id: { in: [SCHOLAR_ID, SCHOLAR2_ID] },
            role: 'SCHOLAR',
          },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws BadRequest COURSE_MEMBER_NOT_FOUND when a user is not a course member', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, program_id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: MENTOR_ID });
      // Both scholars DO have the SCHOLAR role (so we pass step 3)...
      prisma.userRole.findMany.mockResolvedValue([
        { user_id: SCHOLAR_ID },
        { user_id: SCHOLAR2_ID },
      ]);
      // ...but SCHOLAR2_ID is missing from the course membership (fails step 4).
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: MENTOR_ID },
        { user_id: SCHOLAR_ID },
      ]);

      try {
        await service.create(
          ORG_A,
          { ...validDto, scholarIds: [SCHOLAR_ID, SCHOLAR2_ID] },
          ACTOR_ID,
        );
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_MEMBER_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            course_id: COURSE_ID,
            user_id: { in: [MENTOR_ID, SCHOLAR_ID, SCHOLAR2_ID] },
          },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws BadRequest SCHOLAR_ALREADY_PAIRED when a scholar already has an active pairing in the course', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, program_id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: MENTOR_ID });
      prisma.userRole.findMany.mockResolvedValue([
        { user_id: SCHOLAR_ID },
        { user_id: SCHOLAR2_ID },
      ]);
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: MENTOR_ID },
        { user_id: SCHOLAR_ID },
        { user_id: SCHOLAR2_ID },
      ]);
      // SCHOLAR_ID already has an active pairing in this course.
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([
        { id: 'existing-1', scholar_id: SCHOLAR_ID },
      ]);

      try {
        await service.create(
          ORG_A,
          { ...validDto, scholarIds: [SCHOLAR_ID, SCHOLAR2_ID] },
          ACTOR_ID,
        );
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'SCHOLAR_ALREADY_PAIRED' }),
        );
      }
      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            course_id: COURSE_ID,
            scholar_id: { in: [SCHOLAR_ID, SCHOLAR2_ID] },
            ends_at: null,
          },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // reassign
  // =========================================================================
  describe('reassign', () => {
    const reassignDto = { newMentorId: NEW_MENTOR_ID, reason: 'Mentor unavailable' };

    function setupReassignHappyPath() {
      const existingAssignment = makeAssignment({
        mentor: { id: MENTOR_ID, email: 'mentor@a.com' },
        scholar: { id: SCHOLAR_ID, email: 'scholar@a.com' },
        course: { id: COURSE_ID, name: 'Financial Literacy 101', program_id: PROGRAM_ID },
      });
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(existingAssignment);
      prisma.userRole.findFirst.mockResolvedValue({ user_id: NEW_MENTOR_ID });
      prisma.courseMembership.findFirst.mockResolvedValue({ user_id: NEW_MENTOR_ID });
      prisma.user.findUnique.mockResolvedValue({
        id: NEW_MENTOR_ID,
        name: 'New Mentor',
        email: 'newmentor@a.com',
      });
      prisma.$transaction.mockImplementation(
        async (cb: (tx: any) => Promise<any>) => cb(prisma),
      );
      prisma.mentorScholarAssignment.create.mockResolvedValue({ id: 'new-assign-1' });
    }

    it('scopes the assignment lookup by organization_id (cross-org id resolves to NotFound)', async () => {
      // ORG_A caller trying to reassign an ORG_B-owned assignment.
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(null);

      try {
        await service.reassign(ORG_A, ORG_B_ASSIGNMENT_ID, reassignDto, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }),
        );
      }
      expect(prisma.mentorScholarAssignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path updates old (ended_at set) and creates new with same course_id/scholar_id', async () => {
      setupReassignHappyPath();

      await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);

      // update old assignment -> ended_at set
      expect(prisma.mentorScholarAssignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { ends_at: expect.any(Date) },
      });
      // create new assignment with same course_id and scholar_id, new mentor
      expect(prisma.mentorScholarAssignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          mentor_id: NEW_MENTOR_ID,
          scholar_id: SCHOLAR_ID,
          program_id: PROGRAM_ID,
          course_id: COURSE_ID,
          starts_at: expect.any(Date),
        }),
        select: { id: true },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('validates the newMentor has MENTOR role in the org', async () => {
      setupReassignHappyPath();
      prisma.userRole.findFirst.mockResolvedValue(null); // new mentor lacks MENTOR role

      try {
        await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_ROLE' }),
        );
      }
      expect(prisma.userRole.findFirst).toHaveBeenCalledWith({
        where: { organization_id: ORG_A, user_id: NEW_MENTOR_ID, role: 'MENTOR' },
        select: { user_id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('validates the newMentor is a member of the course', async () => {
      setupReassignHappyPath();
      prisma.courseMembership.findFirst.mockResolvedValue(null); // not a member

      try {
        await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_MEMBER_NOT_FOUND' }),
        );
      }
      expect(prisma.courseMembership.findFirst).toHaveBeenCalledWith({
        where: {
          organization_id: ORG_A,
          course_id: COURSE_ID,
          user_id: NEW_MENTOR_ID,
        },
        select: { user_id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('queues 3 emails: old mentor ended, new mentor, scholar', async () => {
      setupReassignHappyPath();

      await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);

      expect(emailQueue.add).toHaveBeenCalledTimes(3);
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'mentor@a.com', subject: 'Mentor pairing ended' }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'newmentor@a.com', subject: 'New mentor pairing' }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'scholar@a.com', subject: 'You have been assigned a new mentor' }),
      );
    });

    it('audits MENTOR_ASSIGNMENT_REASSIGNED with newMentorId + reason metadata', async () => {
      setupReassignHappyPath();

      await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ACTOR_ID,
        action: 'MENTOR_ASSIGNMENT_REASSIGNED',
        entityType: 'MENTOR_ASSIGNMENT',
        entityId: 'new-assign-1',
        metadata: {
          oldMentorId: MENTOR_ID,
          newMentorId: NEW_MENTOR_ID,
          scholarId: SCHOLAR_ID,
          reason: 'Mentor unavailable',
        },
      });
    });

    it('returns the shaped new assignment', async () => {
      setupReassignHappyPath();

      const result = await service.reassign(ORG_A, ASSIGNMENT_ID, reassignDto, ACTOR_ID);

      expect(result).toEqual(
        expect.objectContaining({
          id: 'new-assign-1',
          mentor: { id: NEW_MENTOR_ID, name: 'New Mentor', email: 'newmentor@a.com' },
          scholar: { id: SCHOLAR_ID, email: 'scholar@a.com' },
          course: { id: COURSE_ID, name: 'Financial Literacy 101' },
          endsAt: null,
          endedAt: null,
        }),
      );
    });
  });

  // =========================================================================
  // endAssignment
  // =========================================================================
  describe('endAssignment', () => {
    function setupEndHappyPath() {
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(
        makeAssignment({
          mentor: { id: MENTOR_ID, email: 'mentor@a.com' },
          scholar: { id: SCHOLAR_ID, email: 'scholar@a.com' },
          ends_at: null,
        }),
      );
      prisma.mentorScholarAssignment.update.mockResolvedValue({ id: ASSIGNMENT_ID });
    }

    it('sets ended_at and returns confirmation', async () => {
      setupEndHappyPath();

      const result = await service.endAssignment(ORG_A, ASSIGNMENT_ID, ACTOR_ID);

      expect(prisma.mentorScholarAssignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(prisma.mentorScholarAssignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { ends_at: expect.any(Date) },
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          endedAt: expect.any(String),
          message: 'Mentor pairing ended. Historical data is preserved.',
        }),
      );
    });

    it('queues 2 emails (mentor + scholar) with Mentor pairing ended', async () => {
      setupEndHappyPath();

      await service.endAssignment(ORG_A, ASSIGNMENT_ID, ACTOR_ID);

      expect(emailQueue.add).toHaveBeenCalledTimes(2);
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'mentor@a.com', subject: 'Mentor pairing ended' }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'scholar@a.com', subject: 'Mentor pairing ended' }),
      );
    });

    it('audits MENTOR_ASSIGNMENT_ENDED', async () => {
      setupEndHappyPath();

      await service.endAssignment(ORG_A, ASSIGNMENT_ID, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ACTOR_ID,
        action: 'MENTOR_ASSIGNMENT_ENDED',
        entityType: 'MENTOR_ASSIGNMENT',
        entityId: ASSIGNMENT_ID,
        metadata: { mentorId: MENTOR_ID, scholarId: SCHOLAR_ID },
      });
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND on cross-org id', async () => {
      // ORG_A caller tries to end an ORG_B assignment -> org-scoped miss.
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(null);

      try {
        await service.endAssignment(ORG_A, ORG_B_ASSIGNMENT_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }),
        );
      }
      expect(prisma.mentorScholarAssignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(prisma.mentorScholarAssignment.update).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('is idempotent: already-ended assignment returns confirmation without re-queueing/auditing', async () => {
      // assignment already ended (ends_at set)
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(
        makeAssignment({ ends_at: BASE_DATE }),
      );

      const result = await service.endAssignment(ORG_A, ASSIGNMENT_ID, ACTOR_ID);

      // No update, no emails, no audit for an already-ended assignment.
      expect(prisma.mentorScholarAssignment.update).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          message: 'Mentor pairing ended. Historical data is preserved.',
        }),
      );
    });
  });

  // =========================================================================
  // Cross-tenant isolation (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user cannot create a pairing for an ORG_B-owned course', async () => {
      // An ORG_B course id hits the org-scoped course lookup for ORG_A -> null.
      prisma.course.findUnique.mockResolvedValue(null);

      try {
        await service.create(
          ORG_A,
          { mentorId: MENTOR_ID, scholarIds: [SCHOLAR_ID], courseId: OTHER_COURSE_ID },
          ACTOR_ID,
        );
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'COURSE_NOT_FOUND' }),
        );
      }
      // The DB query itself MUST be org-scoped.
      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: OTHER_COURSE_ID, organization_id: ORG_A }),
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot reassign an ORG_B-owned assignment', async () => {
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(null);

      try {
        await service.reassign(ORG_A, ORG_B_ASSIGNMENT_ID, { newMentorId: NEW_MENTOR_ID }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }),
        );
      }
      expect(prisma.mentorScholarAssignment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A }),
        }),
      );
      // Must NOT have queried with ORG_B.
      expect(prisma.mentorScholarAssignment.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_B }),
        }),
      );
    });

    it('ORG_A user cannot end an ORG_B-owned assignment', async () => {
      prisma.mentorScholarAssignment.findUnique.mockResolvedValue(null);

      try {
        await service.endAssignment(ORG_A, ORG_B_ASSIGNMENT_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }),
        );
      }
      expect(prisma.mentorScholarAssignment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A }),
        }),
      );
    });

    it('ORG_A admin listing assignments only queries ORG_A (never ORG_B)', async () => {
      prisma.mentorScholarAssignment.findMany.mockResolvedValue([]);

      await service.list(ORG_A, SUPER_ADMIN_A);

      expect(prisma.mentorScholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.mentorScholarAssignment.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_B }),
        }),
      );
    });
  });
});
