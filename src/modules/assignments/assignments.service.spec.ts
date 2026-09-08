import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AssignmentsService } from './assignments.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const COURSE_ID = 'course-00000000-0000-0000-0000-000000000001';
const OTHER_COURSE_ID = 'course-00000000-0000-0000-0000-000000000099';
const PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000001';
const ASSIGNMENT_ID = 'assign-00000000-0000-0000-0000-000000000001';
const ORG_B_ASSIGNMENT_ID = 'assign-00000000-0000-0000-0000-000000000099';
const SCHOLAR_ASSIGNMENT_ID = 'sa-00000000-0000-0000-0000-000000000001';
const CHANGE_REQUEST_ID = 'cr-00000000-0000-0000-0000-000000000001';
const ORG_B_CHANGE_REQUEST_ID = 'cr-00000000-0000-0000-0000-000000000099';

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');
const PAST_DATE = new Date('2020-01-01T00:00:00.000Z');
const FUTURE_DATE = new Date('2099-01-01T00:00:00.000Z');

const ADMIN_A: AuthUser = {
  id: 'admin-a',
  email: 'admin@a.com',
  organizationId: ORG_A,
  roles: [Role.SUPER_ADMIN],
};

const MENTOR_A: AuthUser = {
  id: 'mentor-a',
  email: 'mentor@a.com',
  organizationId: ORG_A,
  roles: [Role.MENTOR],
};

const SCHOLAR_A: AuthUser = {
  id: 'scholar-a',
  email: 'scholar@a.com',
  organizationId: ORG_A,
  roles: [Role.SCHOLAR],
};

const SCHOLAR_B: AuthUser = {
  id: 'scholar-b',
  email: 'scholar@b.com',
  organizationId: ORG_B,
  roles: [Role.SCHOLAR],
};

// Full OrgSettingsResult shape returned by OrganizationsService.getSettings
const ORG_SETTINGS = {
  assignmentWeight: 0.7,
  attendanceWeight: 0.3,
  atRiskAttendanceThreshold: 70,
  atRiskAssignmentThreshold: 60,
  atRiskOverdueThreshold: 3,
  lateSubmissionPenaltyPercentage: 20,
  assignmentEditWindowMinutes: 60,
  invitationExpiryHours: 48,
};

// Helper: a fully-shaped Assignment row as returned by prisma
function makeAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_ID,
    organization_id: ORG_A,
    course_id: COURSE_ID,
    program_id: PROGRAM_ID,
    created_by: MENTOR_A.id,
    title: 'Write a 500-word essay',
    description: null,
    status: 'DRAFT',
    due_at: FUTURE_DATE,
    max_score: 100,
    published_at: null,
    edit_window_expires_at: null,
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    archived_at: null,
    course: { id: COURSE_ID, name: 'Financial Literacy 101' },
    creator: { id: MENTOR_A.id, name: 'Mentor A' },
    ...overrides,
  };
}

// Helper: a fully-shaped ScholarAssignment row as returned by prisma
function makeScholarSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHOLAR_ASSIGNMENT_ID,
    organization_id: ORG_A,
    assignment_id: ASSIGNMENT_ID,
    scholar_id: SCHOLAR_A.id,
    status: 'PENDING_VERIFICATION',
    score: null,
    is_late: false,
    earned_credit: null,
    marked_done_at: null,
    verified_at: null,
    verified_by: null,
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    scholar: { id: SCHOLAR_A.id, name: 'Scholar A', email: 'scholar@a.com' },
    ...overrides,
  };
}

// Helper: assert a promise rejects with a given HttpException + machine code
async function expectHttpError(
  promise: Promise<unknown>,
  type: new (...args: never[]) => Error,
  code: string,
) {
  try {
    await promise;
    expect.fail(`Expected ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(type);
    expect((e as { getResponse: () => unknown }).getResponse()).toEqual(
      expect.objectContaining({ code }),
    );
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AssignmentsService', () => {
  let service: AssignmentsService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };
  let organizations: { getSettings: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };
  let assignmentsQueue: { add: ReturnType<typeof vi.fn> };
  let analyticsQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      assignment: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      course: {
        findUnique: vi.fn(),
      },
      courseMembership: {
        findMany: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      userRole: {
        findMany: vi.fn(),
      },
      scholarAssignment: {
        findUnique: vi.fn(),
        update: vi.fn(),
        createMany: vi.fn(),
      },
      mentorScholarAssignment: {
        findFirst: vi.fn(),
      },
      assignmentChangeRequest: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    organizations = {
      getSettings: vi.fn().mockResolvedValue(ORG_SETTINGS),
    };

    emailQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    assignmentsQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    analyticsQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    service = new AssignmentsService(
      prisma as any,
      audit as any,
      organizations as any,
      emailQueue as any,
      assignmentsQueue as any,
      analyticsQueue as any,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // list
  // =========================================================================
  describe('list', () => {
    it('SUPER_ADMIN sees all assignments in the org (no role filter)', async () => {
      prisma.assignment.findMany.mockResolvedValue([
        makeAssignment(),
        makeAssignment({ id: ORG_B_ASSIGNMENT_ID }),
      ]);

      const result = await service.list(ORG_A, ADMIN_A);

      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: ORG_A },
        }),
      );
      // The where must NOT be filtered by creator or scholar for SUPER_ADMIN.
      const whereArg = prisma.assignment.findMany.mock.calls[0][0].where;
      expect(whereArg).not.toHaveProperty('OR');
      expect(whereArg).not.toHaveProperty('scholar_assignments');
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
    });

    it('MENTOR sees ONLY assignments they created (OR: [{ created_by }])', async () => {
      prisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

      await service.list(ORG_A, MENTOR_A);

      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            OR: [{ created_by: MENTOR_A.id }],
          },
        }),
      );
    });

    it('SCHOLAR sees ONLY assignments they are enrolled in', async () => {
      prisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

      await service.list(ORG_A, SCHOLAR_A);

      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization_id: ORG_A,
            scholar_assignments: { some: { scholar_id: SCHOLAR_A.id } },
          },
        }),
      );
    });

    it('scopes the query by organization_id and never ORG_B', async () => {
      prisma.assignment.findMany.mockResolvedValue([]);

      await service.list(ORG_A, ADMIN_A);

      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.assignment.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_B }),
        }),
      );
    });

    it('shapes the output: omits org fields and maps camelCase fields', async () => {
      prisma.assignment.findMany.mockResolvedValue([makeAssignment()]);

      const result = await service.list(ORG_A, ADMIN_A);

      const first = result.data[0];
      expect(first).not.toHaveProperty('organization_id');
      expect(first).not.toHaveProperty('organizationId');
      expect(first).not.toHaveProperty('course_id');
      expect(first).not.toHaveProperty('created_by');
      expect(first).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          title: 'Write a 500-word essay',
          dueAt: FUTURE_DATE.toISOString(),
          maxScore: 100,
          course: { id: COURSE_ID, name: 'Financial Literacy 101' },
          createdBy: { id: MENTOR_A.id, name: 'Mentor A' },
          createdAt: BASE_DATE.toISOString(),
          updatedAt: BASE_DATE.toISOString(),
        }),
      );
    });
  });

  // =========================================================================
  // create
  // =========================================================================
  describe('create', () => {
    const validDto = {
      title: 'Write a 500-word essay',
      courseId: COURSE_ID,
      dueAt: '2026-09-30T23:59:59.000Z',
    };

    function setupCreateHappyPath() {
      prisma.course.findUnique.mockResolvedValue({
        id: COURSE_ID,
        program_id: PROGRAM_ID,
      });
      prisma.assignment.create.mockResolvedValue(
        makeAssignment({ due_at: new Date(validDto.dueAt) }),
      );
    }

    it('scopes the course lookup by organization_id before creating', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ADMIN_A.id);

      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: COURSE_ID, organization_id: ORG_A },
        select: { id: true, program_id: true },
      });
    });

    it('creates a DRAFT with created_by = actorId and due_at from the dto', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ADMIN_A.id);

      expect(prisma.assignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          course_id: COURSE_ID,
          program_id: PROGRAM_ID,
          created_by: ADMIN_A.id,
          title: 'Write a 500-word essay',
          description: null,
          due_at: new Date('2026-09-30T23:59:59.000Z'),
          max_score: 100,
          status: 'DRAFT',
        }),
        include: expect.anything(),
      });
    });

    it('audits ASSIGNMENT_CREATED', async () => {
      setupCreateHappyPath();

      await service.create(ORG_A, validDto, ADMIN_A.id);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ADMIN_A.id,
        action: 'ASSIGNMENT_CREATED',
        entityType: 'ASSIGNMENT',
        entityId: ASSIGNMENT_ID,
        metadata: { courseId: COURSE_ID, title: 'Write a 500-word essay' },
      });
    });

    it('returns the shaped assignment (no org fields)', async () => {
      setupCreateHappyPath();

      const result = await service.create(ORG_A, validDto, ADMIN_A.id);

      expect(result).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          title: 'Write a 500-word essay',
          dueAt: '2026-09-30T23:59:59.000Z',
          maxScore: 100,
          status: 'DRAFT',
        }),
      );
      expect(result).not.toHaveProperty('organization_id');
    });

    it('throws NotFound COURSE_NOT_FOUND for a cross-org course id', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.create(ORG_A, { ...validDto, courseId: OTHER_COURSE_ID }, ADMIN_A.id),
        NotFoundException,
        'COURSE_NOT_FOUND',
      );

      // The lookup MUST be org-scoped: ORG_A caller, ORG_A tenant key.
      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: OTHER_COURSE_ID, organization_id: ORG_A },
        select: { id: true, program_id: true },
      });
      expect(prisma.assignment.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // findOne
  // =========================================================================
  describe('findOne', () => {
    it('SCHOLAR sees only their own submission (no stats / submissions array)', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({
          scholar_assignments: [
            makeScholarSubmission(),
            makeScholarSubmission({
              id: 'sa-other',
              scholar_id: 'another-scholar',
              scholar: { id: 'another-scholar', name: 'Other', email: 'o@a.com' },
            }),
          ],
        }),
      );

      const result = (await service.findOne(ORG_A, ASSIGNMENT_ID, SCHOLAR_A)) as any;
      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(result.assignment).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          title: 'Write a 500-word essay',
          dueAt: FUTURE_DATE.toISOString(),
          maxScore: 100,
        }),
      );
      // Own submission surfaced; the other scholar row is NOT leaked.
      expect(result.submission).toEqual(
        expect.objectContaining({
          id: SCHOLAR_ASSIGNMENT_ID,
          scholar: expect.objectContaining({ id: SCHOLAR_A.id }),
        }),
      );
      expect(result.submission.scholar.id).not.toBe('another-scholar');
      expect(result).not.toHaveProperty('stats');
      expect(result).not.toHaveProperty('submissions');
    });

    it('SCHOLAR with no submission gets submission: null', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({
          scholar_assignments: [
            makeScholarSubmission({ scholar_id: 'another-scholar' }),
          ],
        }),
      );

      const result = await service.findOne(ORG_A, ASSIGNMENT_ID, SCHOLAR_A);

      expect(result.submission).toBeNull();
    });

    it('MENTOR/ADMIN sees the full assignment with stats and submissions', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({
          scholar_assignments: [
            makeScholarSubmission({ status: 'PENDING_VERIFICATION' }),
            makeScholarSubmission({
              id: 'sa-2',
              scholar_id: 'scholar-2',
              scholar: { id: 'scholar-2', name: 'Two', email: 's2@a.com' },
              status: 'VERIFIED',
              is_late: false,
              earned_credit: 100,
            }),
            makeScholarSubmission({
              id: 'sa-3',
              scholar_id: 'scholar-3',
              scholar: { id: 'scholar-3', name: 'Three', email: 's3@a.com' },
              status: 'VERIFIED_LATE',
              is_late: true,
              earned_credit: 80,
            }),
            makeScholarSubmission({
              id: 'sa-4',
              scholar_id: 'scholar-4',
              scholar: { id: 'scholar-4', name: 'Four', email: 's4@a.com' },
              status: 'OVERDUE',
            }),
            makeScholarSubmission({
              id: 'sa-5',
              scholar_id: 'scholar-5',
              scholar: { id: 'scholar-5', name: 'Five', email: 's5@a.com' },
              status: 'RESUBMISSION_REQUIRED',
            }),
            makeScholarSubmission({
              id: 'sa-6',
              scholar_id: 'scholar-6',
              scholar: { id: 'scholar-6', name: 'Six', email: 's6@a.com' },
              status: 'NOT_STARTED',
            }),
          ],
        }),
      );

      const result = (await service.findOne(ORG_A, ASSIGNMENT_ID, ADMIN_A)) as any;

      expect(result).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          title: 'Write a 500-word essay',
          course: { id: COURSE_ID, name: 'Financial Literacy 101' },
          createdBy: { id: MENTOR_A.id, name: 'Mentor A' },
        }),
      );
      expect(result.stats).toEqual({
        total: 6,
        submitted: 3,
        verified: 2,
        pending: 1,
        overdue: 1,
        resubmissionRequired: 1,
      });
      expect(result.submissions).toHaveLength(6);
      expect(result.submissions[1]).toEqual(
        expect.objectContaining({
          id: 'sa-2',
          status: 'VERIFIED',
          earnedCredit: 100,
          scholar: expect.objectContaining({ id: 'scholar-2' }),
        }),
      );
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND for a cross-org id', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.findOne(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
    });
  });

  // =========================================================================
  // update
  // =========================================================================
  describe('update', () => {
    it('updates a DRAFT and audits ASSIGNMENT_UPDATED', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'DRAFT',
        edit_window_expires_at: null,
      });
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({ title: 'Updated title' }),
      );

      const result = await service.update(ORG_A, ASSIGNMENT_ID, { title: 'Updated title' }, ADMIN_A.id);

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        select: { id: true, status: true, edit_window_expires_at: true },
      });
      expect(prisma.assignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { title: 'Updated title' },
        include: expect.anything(),
      });
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ADMIN_A.id,
        action: 'ASSIGNMENT_UPDATED',
        entityType: 'ASSIGNMENT',
        entityId: ASSIGNMENT_ID,
        metadata: { title: 'Updated title' },
      });
      expect(result.title).toBe('Updated title');
    });

    it('updates a PUBLISHED assignment while the edit window is still open', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'PUBLISHED',
        edit_window_expires_at: FUTURE_DATE,
      });
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({ status: 'PUBLISHED', title: 'Updated title' }),
      );

      const result = await service.update(ORG_A, ASSIGNMENT_ID, { title: 'Updated title' }, ADMIN_A.id);

      expect(prisma.assignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { title: 'Updated title' },
        include: expect.anything(),
      });
      expect(result.title).toBe('Updated title');
    });

    it('rejects a PUBLISHED assignment when the edit window has expired', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'PUBLISHED',
        edit_window_expires_at: PAST_DATE,
      });

      await expectHttpError(
        service.update(ORG_A, ASSIGNMENT_ID, { title: 'Too late' }, ADMIN_A.id),
        BadRequestException,
        'ASSIGNMENT_EDIT_WINDOW_EXPIRED',
      );

      expect(prisma.assignment.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects CLOSED and ARCHIVED assignments with ASSIGNMENT_NOT_EDITABLE', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'CLOSED',
        edit_window_expires_at: null,
      });

      await expectHttpError(
        service.update(ORG_A, ASSIGNMENT_ID, { title: 'X' }, ADMIN_A.id),
        BadRequestException,
        'ASSIGNMENT_NOT_EDITABLE',
      );

      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'ARCHIVED',
        edit_window_expires_at: null,
      });

      await expectHttpError(
        service.update(ORG_A, ASSIGNMENT_ID, { title: 'X' }, ADMIN_A.id),
        BadRequestException,
        'ASSIGNMENT_NOT_EDITABLE',
      );
      expect(prisma.assignment.update).not.toHaveBeenCalled();
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND for a cross-org id', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.update(ORG_A, ORG_B_ASSIGNMENT_ID, { title: 'X' }, ADMIN_A.id),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );
    });

    it('throws NotFound COURSE_NOT_FOUND when switching to a cross-org course', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'DRAFT',
        edit_window_expires_at: null,
      });
      prisma.course.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.update(ORG_A, ASSIGNMENT_ID, { courseId: OTHER_COURSE_ID }, ADMIN_A.id),
        NotFoundException,
        'COURSE_NOT_FOUND',
      );

      expect(prisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: OTHER_COURSE_ID, organization_id: ORG_A },
        select: { id: true, program_id: true },
      });
      expect(prisma.assignment.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // publish
  // =========================================================================
  describe('publish', () => {
    it('publishes the assignment: status PUBLISHED, edit window from settings, scholar rows', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

      const dueAt = new Date('2026-06-10T00:00:00.000Z');
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({ status: 'DRAFT', due_at: dueAt }),
      );
      prisma.courseMembership.findMany.mockResolvedValue([
        { user_id: SCHOLAR_A.id },
        { user_id: 'scholar-2' },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: SCHOLAR_A.id, email: 'scholar@a.com' },
        { id: 'scholar-2', email: 'scholar2@a.com' },
      ]);
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({
          status: 'PUBLISHED',
          due_at: dueAt,
          published_at: new Date('2026-06-01T00:00:00.000Z'),
          edit_window_expires_at: new Date('2026-06-01T01:00:00.000Z'),
        }),
      );
      prisma.scholarAssignment.createMany.mockResolvedValue({ count: 2 });

      const result = await service.publish(ORG_A, ASSIGNMENT_ID, ADMIN_A.id);

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(organizations.getSettings).toHaveBeenCalledWith(ORG_A);

      // edit window MUST be derived from settings.assignmentEditWindowMinutes (60) * 60_000
      expect(prisma.assignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: {
          status: 'PUBLISHED',
          published_at: new Date('2026-06-01T00:00:00.000Z'),
          edit_window_expires_at: new Date('2026-06-01T01:00:00.000Z'),
        },
        include: expect.anything(),
      });
      const updateData = prisma.assignment.update.mock.calls[0][0].data;
      expect(
        updateData.edit_window_expires_at.getTime() - updateData.published_at.getTime(),
      ).toBe(60 * 60_000);

      // Scholar rows created for every course member, deduplicated.
      expect(prisma.scholarAssignment.createMany).toHaveBeenCalledWith({
        data: [
          {
            organization_id: ORG_A,
            assignment_id: ASSIGNMENT_ID,
            scholar_id: SCHOLAR_A.id,
            status: 'NOT_STARTED',
          },
          {
            organization_id: ORG_A,
            assignment_id: ASSIGNMENT_ID,
            scholar_id: 'scholar-2',
            status: 'NOT_STARTED',
          },
        ],
        skipDuplicates: true,
      });

      // 2 reminder jobs per scholar (24h + 1h), jobId-deduplicated.
      expect(assignmentsQueue.add).toHaveBeenCalledTimes(4);
      expect(assignmentsQueue.add).toHaveBeenCalledWith(
        'reminder',
        { assignmentId: ASSIGNMENT_ID, scholarId: SCHOLAR_A.id, organizationId: ORG_A, type: '24h' },
        { delay: expect.any(Number), jobId: `assignment-reminder-24h-${ASSIGNMENT_ID}-${SCHOLAR_A.id}` },
      );
      expect(assignmentsQueue.add).toHaveBeenCalledWith(
        'reminder',
        { assignmentId: ASSIGNMENT_ID, scholarId: SCHOLAR_A.id, organizationId: ORG_A, type: '1h' },
        { delay: expect.any(Number), jobId: `assignment-reminder-1h-${ASSIGNMENT_ID}-${SCHOLAR_A.id}` },
      );
      expect(assignmentsQueue.add).toHaveBeenCalledWith(
        'reminder',
        { assignmentId: ASSIGNMENT_ID, scholarId: 'scholar-2', organizationId: ORG_A, type: '24h' },
        { delay: expect.any(Number), jobId: `assignment-reminder-24h-${ASSIGNMENT_ID}-scholar-2` },
      );

      // One published email per member.
      expect(emailQueue.add).toHaveBeenCalledTimes(2);
      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'scholar@a.com',
        subject: 'New assignment published',
        html: expect.any(String),
      });
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'scholar2@a.com', subject: 'New assignment published' }),
      );

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ADMIN_A.id,
        action: 'ASSIGNMENT_PUBLISHED',
        entityType: 'ASSIGNMENT',
        entityId: ASSIGNMENT_ID,
        metadata: expect.objectContaining({
          courseId: COURSE_ID,
          dueAt: dueAt.toISOString(),
          scholarCount: 2,
          editWindowMinutes: 60,
        }),
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: ASSIGNMENT_ID,
          status: 'PUBLISHED',
          dueAt: dueAt.toISOString(),
        }),
      );
    });

    it('throws BadRequest DUE_AT_REQUIRED when the draft has no due date', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({ status: 'DRAFT', due_at: null }),
      );

      await expectHttpError(
        service.publish(ORG_A, ASSIGNMENT_ID, ADMIN_A.id),
        BadRequestException,
        'DUE_AT_REQUIRED',
      );

      expect(organizations.getSettings).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws BadRequest ASSIGNMENT_NOT_DRAFT when already published', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({ status: 'PUBLISHED' }),
      );

      await expectHttpError(
        service.publish(ORG_A, ASSIGNMENT_ID, ADMIN_A.id),
        BadRequestException,
        'ASSIGNMENT_NOT_DRAFT',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND for a cross-org id', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.publish(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A.id),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );
    });

    it('skips reminder/email queueing and createMany when the course has no members', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({ status: 'DRAFT' }),
      );
      prisma.courseMembership.findMany.mockResolvedValue([]);
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({ status: 'PUBLISHED' }),
      );

      await service.publish(ORG_A, ASSIGNMENT_ID, ADMIN_A.id);

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.scholarAssignment.createMany).not.toHaveBeenCalled();
      expect(assignmentsQueue.add).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ASSIGNMENT_PUBLISHED',
          metadata: expect.objectContaining({ scholarCount: 0 }),
        }),
      );
    });
  });

  // =========================================================================
  // submit
  // =========================================================================
  describe('submit', () => {
    function setupSubmit(overrides: { dueAt?: Date; is_late?: boolean } = {}) {
      const dueAt = overrides.dueAt ?? FUTURE_DATE;
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({
          status: 'PUBLISHED',
          due_at: dueAt,
          course_id: COURSE_ID,
        }),
      );
      prisma.scholarAssignment.findUnique.mockResolvedValue(
        makeScholarSubmission({ status: 'NOT_STARTED' }),
      );
      prisma.scholarAssignment.update.mockResolvedValue(
        makeScholarSubmission({
          status: 'PENDING_VERIFICATION',
          marked_done_at: new Date(),
          is_late: overrides.is_late ?? false,
        }),
      );
    }

    it('marks submission PENDING_VERIFICATION and computes is_late from server time (late)', async () => {
      // due_at in the past vs the test server's current time => late.
      setupSubmit({ dueAt: PAST_DATE, is_late: true });
      prisma.mentorScholarAssignment.findFirst.mockResolvedValue({
        mentor: { id: MENTOR_A.id, email: 'mentor@a.com' },
      });

      const result = await service.submit(ORG_A, ASSIGNMENT_ID, SCHOLAR_A);

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        select: expect.objectContaining({
          id: true,
          course_id: true,
          title: true,
          due_at: true,
          status: true,
        }),
      });
      expect(prisma.scholarAssignment.findUnique).toHaveBeenCalledWith({
        where: {
          assignment_id_scholar_id: {
            assignment_id: ASSIGNMENT_ID,
            scholar_id: SCHOLAR_A.id,
          },
        },
      });
      expect(prisma.scholarAssignment.update).toHaveBeenCalledWith({
        where: { id: SCHOLAR_ASSIGNMENT_ID },
        data: {
          status: 'PENDING_VERIFICATION',
          marked_done_at: expect.any(Date),
          is_late: true,
        },
      });

      // Paired mentor lookup is org-scoped.
      expect(prisma.mentorScholarAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          organization_id: ORG_A,
          course_id: COURSE_ID,
          scholar_id: SCHOLAR_A.id,
          ends_at: null,
        },
        include: expect.anything(),
      });

      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'mentor@a.com',
        subject: 'Assignment submitted for verification',
        html: expect.any(String),
      });

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: SCHOLAR_A.id,
        action: 'ASSIGNMENT_SUBMITTED',
        entityType: 'SCHOLAR_ASSIGNMENT',
        entityId: SCHOLAR_ASSIGNMENT_ID,
        metadata: { assignmentId: ASSIGNMENT_ID, isLate: true },
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: SCHOLAR_ASSIGNMENT_ID,
          status: 'PENDING_VERIFICATION',
          isLate: true,
          markedDoneAt: expect.any(String),
        }),
      );
    });

    it('computes is_late = false when due_at is still in the future', async () => {
      setupSubmit({ dueAt: FUTURE_DATE, is_late: false });
      prisma.mentorScholarAssignment.findFirst.mockResolvedValue(null);

      const result = await service.submit(ORG_A, ASSIGNMENT_ID, SCHOLAR_A);

      expect(prisma.scholarAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ is_late: false }),
        }),
      );
      expect(result.isLate).toBe(false);
      // No paired mentor => no email notification.
      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ASSIGNMENT_SUBMITTED',
          metadata: expect.objectContaining({ isLate: false }),
        }),
      );
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND for a cross-org id', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.submit(ORG_A, ORG_B_ASSIGNMENT_ID, SCHOLAR_A),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.scholarAssignment.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFound SUBMISSION_NOT_FOUND when the scholar has no submission row', async () => {
      prisma.assignment.findUnique.mockResolvedValue(
        makeAssignment({ status: 'PUBLISHED' }),
      );
      prisma.scholarAssignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.submit(ORG_A, ASSIGNMENT_ID, SCHOLAR_A),
        NotFoundException,
        'SUBMISSION_NOT_FOUND',
      );

      expect(prisma.scholarAssignment.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // verify
  // =========================================================================
  describe('verify', () => {
    // release-blocking: a scholar must never verify their own submission.
    it('verify — self verification: throws Forbidden CANNOT_VERIFY_SELF', async () => {
      await expectHttpError(
        service.verify(
          ORG_A,
          ASSIGNMENT_ID,
          { scholarId: SCHOLAR_A.id, action: 'VERIFY' },
          SCHOLAR_A,
        ),
        ForbiddenException,
        'CANNOT_VERIFY_SELF',
      );

      expect(prisma.assignment.findUnique).not.toHaveBeenCalled();
      expect(prisma.scholarAssignment.findUnique).not.toHaveBeenCalled();
    });

    // release-blocking: an ORG_A mentor must never verify an ORG_B submission.
    it('verify — tenant isolation: ORG_A mentor cannot reach an ORG_B assignment', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.verify(
          ORG_A,
          ORG_B_ASSIGNMENT_ID,
          { scholarId: SCHOLAR_B.id, action: 'VERIFY' },
          MENTOR_A,
        ),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      // The guard is the org-scoped assignment lookup.
      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        select: expect.anything(),
      });
      expect(prisma.scholarAssignment.findUnique).not.toHaveBeenCalled();
    });

    it('verify — tenant isolation: a valid ORG_A assignment never leaks an ORG_B submission', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        due_at: FUTURE_DATE,
        status: 'PUBLISHED',
      });
      prisma.scholarAssignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.verify(
          ORG_A,
          ASSIGNMENT_ID,
          { scholarId: SCHOLAR_B.id, action: 'VERIFY' },
          MENTOR_A,
        ),
        NotFoundException,
        'SUBMISSION_NOT_FOUND',
      );

      expect(prisma.scholarAssignment.findUnique).toHaveBeenCalledWith({
        where: {
          assignment_id_scholar_id: {
            assignment_id: ASSIGNMENT_ID,
            scholar_id: SCHOLAR_B.id,
          },
        },
        include: expect.anything(),
      });
      expect(prisma.scholarAssignment.update).not.toHaveBeenCalled();
    });

    it('verify — VERIFY action: not late => earned_credit 100, status VERIFIED, analytics + audit', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        due_at: FUTURE_DATE,
        status: 'PUBLISHED',
      });
      prisma.scholarAssignment.findUnique.mockResolvedValue(
        makeScholarSubmission({ status: 'PENDING_VERIFICATION', is_late: false }),
      );
      prisma.scholarAssignment.update.mockResolvedValue(
        makeScholarSubmission({
          status: 'VERIFIED',
          verified_at: new Date(),
          verified_by: MENTOR_A.id,
          earned_credit: 100,
        }),
      );

      const result = await service.verify(
        ORG_A,
        ASSIGNMENT_ID,
        { scholarId: SCHOLAR_A.id, action: 'VERIFY' },
        MENTOR_A,
      );

      expect(prisma.scholarAssignment.update).toHaveBeenCalledWith({
        where: { id: SCHOLAR_ASSIGNMENT_ID },
        data: {
          status: 'VERIFIED',
          verified_at: expect.any(Date),
          verified_by: MENTOR_A.id,
          earned_credit: 100,
        },
      });

      // Analytics refresh queued with deduplicated jobId.
      expect(analyticsQueue.add).toHaveBeenCalledTimes(1);
      expect(analyticsQueue.add).toHaveBeenCalledWith(
        'refresh',
        { organizationId: ORG_A, entity: 'scholar', entityId: SCHOLAR_A.id },
        { jobId: `analytics-scholar-${ORG_A}-${SCHOLAR_A.id}` },
      );

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: MENTOR_A.id,
        action: 'ASSIGNMENT_VERIFIED',
        entityType: 'SCHOLAR_ASSIGNMENT',
        entityId: SCHOLAR_ASSIGNMENT_ID,
        metadata: expect.objectContaining({
          assignmentId: ASSIGNMENT_ID,
          scholarId: SCHOLAR_A.id,
          earnedCredit: 100,
          isLate: false,
        }),
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: SCHOLAR_ASSIGNMENT_ID,
          status: 'VERIFIED',
          earnedCredit: 100,
          verifiedAt: expect.any(String),
        }),
      );
    });

    it('verify — VERIFY action: late => earned_credit = 100 - penalty (80), status VERIFIED_LATE', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        due_at: PAST_DATE,
        status: 'PUBLISHED',
      });
      prisma.scholarAssignment.findUnique.mockResolvedValue(
        makeScholarSubmission({ status: 'PENDING_VERIFICATION', is_late: true }),
      );
      prisma.scholarAssignment.update.mockResolvedValue(
        makeScholarSubmission({
          status: 'VERIFIED_LATE',
          verified_at: new Date(),
          verified_by: MENTOR_A.id,
          earned_credit: 80,
        }),
      );

      const result = await service.verify(
        ORG_A,
        ASSIGNMENT_ID,
        { scholarId: SCHOLAR_A.id, action: 'VERIFY' },
        MENTOR_A,
      );

      // penalty from settings (lateSubmissionPenaltyPercentage: 20) applied server-side.
      expect(prisma.scholarAssignment.update).toHaveBeenCalledWith({
        where: { id: SCHOLAR_ASSIGNMENT_ID },
        data: expect.objectContaining({
          status: 'VERIFIED_LATE',
          earned_credit: 80,
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({ status: 'VERIFIED_LATE', earnedCredit: 80 }),
      );
      expect(analyticsQueue.add).toHaveBeenCalledWith(
        'refresh',
        expect.objectContaining({ entityId: SCHOLAR_A.id }),
        { jobId: `analytics-scholar-${ORG_A}-${SCHOLAR_A.id}` },
      );
    });

    it('verify — REQUEST_RESUBMISSION: status RESUBMISSION_REQUIRED, emails scholar, audits', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        due_at: FUTURE_DATE,
        status: 'PUBLISHED',
      });
      prisma.scholarAssignment.findUnique.mockResolvedValue(
        makeScholarSubmission({ status: 'PENDING_VERIFICATION' }),
      );
      prisma.scholarAssignment.update.mockResolvedValue(
        makeScholarSubmission({ status: 'RESUBMISSION_REQUIRED' }),
      );

      const result = await service.verify(
        ORG_A,
        ASSIGNMENT_ID,
        { scholarId: SCHOLAR_A.id, action: 'REQUEST_RESUBMISSION', feedback: 'Please cite your sources' },
        MENTOR_A,
      );

      expect(prisma.scholarAssignment.update).toHaveBeenCalledWith({
        where: { id: SCHOLAR_ASSIGNMENT_ID },
        data: { status: 'RESUBMISSION_REQUIRED' },
      });
      expect(analyticsQueue.add).not.toHaveBeenCalled();
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'scholar@a.com',
          subject: 'Assignment needs revision',
          html: expect.stringContaining('Please cite your sources'),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: MENTOR_A.id,
        action: 'ASSIGNMENT_RESUBMISSION_REQUESTED',
        entityType: 'SCHOLAR_ASSIGNMENT',
        entityId: SCHOLAR_ASSIGNMENT_ID,
        metadata: { assignmentId: ASSIGNMENT_ID, scholarId: SCHOLAR_A.id },
      });
      expect(result).toEqual(
        expect.objectContaining({ id: SCHOLAR_ASSIGNMENT_ID, status: 'RESUBMISSION_REQUIRED' }),
      );
    });
  });

  // =========================================================================
  // createChangeRequest
  // =========================================================================
  describe('createChangeRequest', () => {
    const validDto = {
      field: 'dueAt',
      currentValue: '2026-09-30T23:59:59.000Z',
      requestedValue: '2026-10-07T23:59:59.000Z',
      reason: 'Please extend the deadline',
    };

    it('creates a PENDING change request once the edit window has expired', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'PUBLISHED',
        edit_window_expires_at: PAST_DATE,
      });
      prisma.assignmentChangeRequest.create.mockResolvedValue({
        id: CHANGE_REQUEST_ID,
        organization_id: ORG_A,
        assignment_id: ASSIGNMENT_ID,
        field: 'dueAt',
        current_value: '2026-09-30T23:59:59.000Z',
        requested_value: '2026-10-07T23:59:59.000Z',
        reason: 'Please extend the deadline',
        status: 'PENDING',
        admin_note: null,
        created_at: BASE_DATE,
        updated_at: BASE_DATE,
      });
      prisma.userRole.findMany.mockResolvedValue([
        { user: { id: 'admin-1', email: 'admin1@a.com' } },
        { user: { id: 'admin-2', email: 'admin2@a.com' } },
      ]);

      const result = await service.createChangeRequest(ORG_A, ASSIGNMENT_ID, validDto, MENTOR_A.id);

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        select: { id: true, status: true, edit_window_expires_at: true },
      });
      expect(prisma.assignmentChangeRequest.create).toHaveBeenCalledWith({
        data: {
          organization_id: ORG_A,
          assignment_id: ASSIGNMENT_ID,
          field: 'dueAt',
          current_value: '2026-09-30T23:59:59.000Z',
          requested_value: '2026-10-07T23:59:59.000Z',
          reason: 'Please extend the deadline',
          status: 'PENDING',
        },
      });

      // Notifies every org SUPER_ADMIN.
      expect(prisma.userRole.findMany).toHaveBeenCalledWith({
        where: { organization_id: ORG_A, role: 'SUPER_ADMIN' },
        include: expect.anything(),
      });
      expect(emailQueue.add).toHaveBeenCalledTimes(2);
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'admin1@a.com', subject: 'Assignment change request' }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'admin2@a.com', subject: 'Assignment change request' }),
      );

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: MENTOR_A.id,
        action: 'ASSIGNMENT_CHANGE_REQUESTED',
        entityType: 'ASSIGNMENT_CHANGE_REQUEST',
        entityId: CHANGE_REQUEST_ID,
        metadata: { assignmentId: ASSIGNMENT_ID, field: 'dueAt', reason: 'Please extend the deadline' },
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: CHANGE_REQUEST_ID,
          assignmentId: ASSIGNMENT_ID,
          field: 'dueAt',
          status: 'PENDING',
        }),
      );
    });

    it('throws BadRequest EDIT_WINDOW_NOT_EXPIRED while the edit window is still open', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'PUBLISHED',
        edit_window_expires_at: FUTURE_DATE,
      });

      await expectHttpError(
        service.createChangeRequest(ORG_A, ASSIGNMENT_ID, validDto, MENTOR_A.id),
        BadRequestException,
        'EDIT_WINDOW_NOT_EXPIRED',
      );

      expect(prisma.assignmentChangeRequest.create).not.toHaveBeenCalled();
    });

    it('throws BadRequest EDIT_WINDOW_NOT_EXPIRED when the window has never been set (null)', async () => {
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'DRAFT',
        edit_window_expires_at: null,
      });

      await expectHttpError(
        service.createChangeRequest(ORG_A, ASSIGNMENT_ID, validDto, MENTOR_A.id),
        BadRequestException,
        'EDIT_WINDOW_NOT_EXPIRED',
      );

      expect(prisma.assignmentChangeRequest.create).not.toHaveBeenCalled();
    });

    it('throws NotFound ASSIGNMENT_NOT_FOUND for a cross-org assignment id', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.createChangeRequest(ORG_A, ORG_B_ASSIGNMENT_ID, validDto, MENTOR_A.id),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.assignmentChangeRequest.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // reviewChangeRequest
  // =========================================================================
  describe('reviewChangeRequest', () => {
    function makeChangeRequest(overrides: Record<string, unknown> = {}) {
      return {
        id: CHANGE_REQUEST_ID,
        organization_id: ORG_A,
        assignment_id: ASSIGNMENT_ID,
        field: 'title',
        current_value: 'Old title',
        requested_value: 'New title',
        reason: 'Please rename',
        status: 'PENDING',
        admin_note: null,
        created_at: BASE_DATE,
        updated_at: BASE_DATE,
        ...overrides,
      };
    }

    it('APPROVE applies a string title change inside a transaction and notifies the creator', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(makeChangeRequest());
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        created_by: MENTOR_A.id,
      });
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({ title: 'New title' }),
      );
      prisma.assignmentChangeRequest.update.mockResolvedValue(
        makeChangeRequest({
          status: 'APPROVED',
          reviewed_by: ADMIN_A.id,
          admin_note: 'Approved',
        }),
      );
      prisma.user.findUnique.mockResolvedValue({ email: 'mentor@a.com' });

      const result = await service.reviewChangeRequest(
        ORG_A,
        ASSIGNMENT_ID,
        CHANGE_REQUEST_ID,
        { action: 'APPROVE', adminNote: 'Approved' },
        ADMIN_A.id,
      );

      // The change-request lookup MUST be org-scoped.
      expect(prisma.assignmentChangeRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: CHANGE_REQUEST_ID,
          assignment_id: ASSIGNMENT_ID,
          organization_id: ORG_A,
        },
      });
      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID, organization_id: ORG_A },
        select: { id: true, created_by: true },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.assignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { title: 'New title' },
      });
      expect(prisma.assignmentChangeRequest.update).toHaveBeenCalledWith({
        where: { id: CHANGE_REQUEST_ID },
        data: { status: 'APPROVED', reviewed_by: ADMIN_A.id, admin_note: 'Approved' },
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: MENTOR_A.id },
        select: { email: true },
      });
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'mentor@a.com',
          subject: 'Change request approved',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ADMIN_A.id,
        action: 'ASSIGNMENT_CHANGE_APPROVED',
        entityType: 'ASSIGNMENT_CHANGE_REQUEST',
        entityId: CHANGE_REQUEST_ID,
        metadata: { assignmentId: ASSIGNMENT_ID, field: 'title' },
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: CHANGE_REQUEST_ID,
          field: 'title',
          status: 'APPROVED',
        }),
      );
    });

    it('APPROVE maps a dueAt change to a Date and a maxScore change to an integer', async () => {
      // dueAt field -> Date
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(
        makeChangeRequest({
          field: 'dueAt',
          requested_value: '2026-10-07T00:00:00.000Z',
        }),
      );
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        created_by: MENTOR_A.id,
      });
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));
      prisma.assignment.update.mockResolvedValue(
        makeAssignment({ due_at: new Date('2026-10-07T00:00:00.000Z') }),
      );
      prisma.assignmentChangeRequest.update.mockResolvedValue(
        makeChangeRequest({
          field: 'dueAt',
          status: 'APPROVED',
          reviewed_by: ADMIN_A.id,
          admin_note: null,
        }),
      );
      prisma.user.findUnique.mockResolvedValue({ email: 'mentor@a.com' });

      await service.reviewChangeRequest(
        ORG_A,
        ASSIGNMENT_ID,
        CHANGE_REQUEST_ID,
        { action: 'APPROVE' },
        ADMIN_A.id,
      );

      expect(prisma.assignment.update).toHaveBeenCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { due_at: new Date('2026-10-07T00:00:00.000Z') },
      });

      // maxScore field -> integer
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(
        makeChangeRequest({
          field: 'maxScore',
          requested_value: 150,
        }),
      );
      await service.reviewChangeRequest(
        ORG_A,
        ASSIGNMENT_ID,
        CHANGE_REQUEST_ID,
        { action: 'APPROVE' },
        ADMIN_A.id,
      );

      expect(prisma.assignment.update).toHaveBeenLastCalledWith({
        where: { id: ASSIGNMENT_ID },
        data: { max_score: 150 },
      });
    });

    it('REJECT marks REJECTED, notifies the creator, and audits ASSIGNMENT_CHANGE_REJECTED', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(makeChangeRequest());
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        created_by: MENTOR_A.id,
      });
      prisma.assignmentChangeRequest.update.mockResolvedValue(
        makeChangeRequest({
          status: 'REJECTED',
          reviewed_by: ADMIN_A.id,
          admin_note: null,
        }),
      );
      prisma.user.findUnique.mockResolvedValue({ email: 'mentor@a.com' });

      const result = await service.reviewChangeRequest(
        ORG_A,
        ASSIGNMENT_ID,
        CHANGE_REQUEST_ID,
        { action: 'REJECT' },
        ADMIN_A.id,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.assignmentChangeRequest.update).toHaveBeenCalledWith({
        where: { id: CHANGE_REQUEST_ID },
        data: { status: 'REJECTED', reviewed_by: ADMIN_A.id, admin_note: null },
      });
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'mentor@a.com',
          subject: 'Change request rejected',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ADMIN_A.id,
        action: 'ASSIGNMENT_CHANGE_REJECTED',
        entityType: 'ASSIGNMENT_CHANGE_REQUEST',
        entityId: CHANGE_REQUEST_ID,
        metadata: { assignmentId: ASSIGNMENT_ID, field: 'title' },
      });
      expect(result).toEqual(
        expect.objectContaining({ id: CHANGE_REQUEST_ID, status: 'REJECTED' }),
      );
    });

    it('throws BadRequest CHANGE_REQUEST_ALREADY_REVIEWED for a non-PENDING request', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(
        makeChangeRequest({ status: 'APPROVED' }),
      );

      await expectHttpError(
        service.reviewChangeRequest(
          ORG_A,
          ASSIGNMENT_ID,
          CHANGE_REQUEST_ID,
          { action: 'APPROVE' },
          ADMIN_A.id,
        ),
        BadRequestException,
        'CHANGE_REQUEST_ALREADY_REVIEWED',
      );

      expect(prisma.assignment.findUnique).not.toHaveBeenCalled();
      expect(prisma.assignmentChangeRequest.update).not.toHaveBeenCalled();
    });

    it('throws BadRequest INVALID_CHANGE_FIELD for an unsupported field', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(
        makeChangeRequest({ field: 'bogusField', requested_value: 'x' }),
      );
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        created_by: MENTOR_A.id,
      });
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));

      await expectHttpError(
        service.reviewChangeRequest(
          ORG_A,
          ASSIGNMENT_ID,
          CHANGE_REQUEST_ID,
          { action: 'APPROVE' },
          ADMIN_A.id,
        ),
        BadRequestException,
        'INVALID_CHANGE_FIELD',
      );

      expect(prisma.assignmentChangeRequest.update).not.toHaveBeenCalled();
    });

    it('throws BadRequest INVALID_CHANGE_VALUE for an empty title', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(
        makeChangeRequest({ field: 'title', requested_value: '' }),
      );
      prisma.assignment.findUnique.mockResolvedValue({
        id: ASSIGNMENT_ID,
        created_by: MENTOR_A.id,
      });
      prisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(prisma));

      await expectHttpError(
        service.reviewChangeRequest(
          ORG_A,
          ASSIGNMENT_ID,
          CHANGE_REQUEST_ID,
          { action: 'APPROVE' },
          ADMIN_A.id,
        ),
        BadRequestException,
        'INVALID_CHANGE_VALUE',
      );
    });

    it('throws NotFound CHANGE_REQUEST_NOT_FOUND for a cross-org change request', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(null);

      await expectHttpError(
        service.reviewChangeRequest(
          ORG_A,
          ASSIGNMENT_ID,
          ORG_B_CHANGE_REQUEST_ID,
          { action: 'APPROVE' },
          ADMIN_A.id,
        ),
        NotFoundException,
        'CHANGE_REQUEST_NOT_FOUND',
      );

      expect(prisma.assignmentChangeRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: ORG_B_CHANGE_REQUEST_ID,
          assignment_id: ASSIGNMENT_ID,
          organization_id: ORG_A,
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cross-tenant isolation (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A admin listing assignments only queries ORG_A (never ORG_B)', async () => {
      prisma.assignment.findMany.mockResolvedValue([]);

      await service.list(ORG_A, ADMIN_A);

      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.assignment.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_B }),
        }),
      );
    });

    it('ORG_A admin cannot publish an ORG_B-owned assignment', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.publish(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A.id),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        include: expect.anything(),
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ORG_A scholar cannot submit an ORG_B-owned assignment', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.submit(ORG_A, ORG_B_ASSIGNMENT_ID, SCHOLAR_A),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { id: ORG_B_ASSIGNMENT_ID, organization_id: ORG_A },
        select: expect.anything(),
      });
    });

    it('ORG_A mentor cannot request a change on an ORG_B-owned assignment', async () => {
      prisma.assignment.findUnique.mockResolvedValue(null);

      await expectHttpError(
        service.createChangeRequest(
          ORG_A,
          ORG_B_ASSIGNMENT_ID,
          { field: 'title', requestedValue: 'X', reason: 'r' },
          MENTOR_A.id,
        ),
        NotFoundException,
        'ASSIGNMENT_NOT_FOUND',
      );

      expect(prisma.assignmentChangeRequest.create).not.toHaveBeenCalled();
    });

    it('ORG_A admin cannot review an ORG_B-owned change request', async () => {
      prisma.assignmentChangeRequest.findFirst.mockResolvedValue(null);

      await expectHttpError(
        service.reviewChangeRequest(
          ORG_A,
          ASSIGNMENT_ID,
          ORG_B_CHANGE_REQUEST_ID,
          { action: 'REJECT' },
          ADMIN_A.id,
        ),
        NotFoundException,
        'CHANGE_REQUEST_NOT_FOUND',
      );

      expect(prisma.assignmentChangeRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: ORG_B_CHANGE_REQUEST_ID,
          assignment_id: ASSIGNMENT_ID,
          organization_id: ORG_A,
        },
      });
    });
  });
});