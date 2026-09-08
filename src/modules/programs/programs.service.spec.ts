import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MembershipType } from '@prisma/client';
import { ProgramsService } from './programs.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';
const PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000001';
const OTHER_PROGRAM_ID = 'prog-00000000-0000-0000-0000-000000000099';
const USER_IN_ORG = 'user-00000000-0000-0000-0000-000000000002';
const USER_NOT_IN_ORG = 'user-00000000-0000-0000-0000-000000000003';

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');

// Helper: a fully-shaped Program record as returned by prisma
function makeProgram(overrides: Record<string, unknown> = {}) {
  return {
    id: PROGRAM_ID,
    name: 'TMF Leadership Accelerator',
    description: 'An 8-week program',
    starts_at: BASE_DATE,
    ends_at: null,
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

describe('ProgramsService', () => {
  let service: ProgramsService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      program: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      programMembership: {
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
      userRole: {
        findFirst: vi.fn(),
      },
      scholarAssignment: {
        findMany: vi.fn(),
      },
      attendanceRecord: {
        findMany: vi.fn(),
      },
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    service = new ProgramsService(prisma as any, audit as any);
  });

  // =========================================================================
  // listPrograms
  // =========================================================================
  describe('listPrograms', () => {
    it('returns { data, meta } with correct total, totalPages, page and limit', async () => {
      prisma.program.findMany.mockResolvedValue([
        {
          ...makeProgram(),
          _count: { courses: 3, program_memberships: 5 },
        },
        {
          ...makeProgram({ id: OTHER_PROGRAM_ID }),
          _count: { courses: 1, program_memberships: 2 },
        },
      ]);
      prisma.program.count.mockResolvedValue(7);

      const result = await service.listPrograms(ORG_A, { page: 2, limit: 2, archived: false });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: PROGRAM_ID,
          name: 'TMF Leadership Accelerator',
          courseCount: 3,
          memberCount: 5,
        }),
      );
      expect(result.meta).toEqual({
        total: 7,
        totalPages: 4,
        page: 2,
        limit: 2,
      });
    });

    it('uses archived_at: null when archived=false (only active)', async () => {
      prisma.program.findMany.mockResolvedValue([]);
      prisma.program.count.mockResolvedValue(0);

      await service.listPrograms(ORG_A, { page: 1, limit: 25, archived: false });

      expect(prisma.program.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('uses archived_at: { not: null } when archived=true (only archived)', async () => {
      prisma.program.findMany.mockResolvedValue([]);
      prisma.program.count.mockResolvedValue(0);

      await service.listPrograms(ORG_A, { page: 1, limit: 25, archived: true });

      expect(prisma.program.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
    });

    it('scopes the query by organization_id', async () => {
      prisma.program.findMany.mockResolvedValue([]);
      prisma.program.count.mockResolvedValue(0);

      await service.listPrograms(ORG_A, { page: 1, limit: 25, archived: false });

      expect(prisma.program.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.program.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });

    it('paginates with skip/take derived from page and limit', async () => {
      prisma.program.findMany.mockResolvedValue([]);
      prisma.program.count.mockResolvedValue(0);

      await service.listPrograms(ORG_A, { page: 3, limit: 10, archived: false });

      expect(prisma.program.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  // =========================================================================
  // createProgram
  // =========================================================================
  describe('createProgram', () => {
    it('creates with organization_id from the calling user (never from the body)', async () => {
      prisma.program.create.mockResolvedValue(makeProgram());

      await service.createProgram(ORG_A, { name: 'TMF Leadership Accelerator', description: 'desc' }, ACTOR_ID);

      expect(prisma.program.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          name: 'TMF Leadership Accelerator',
        }),
      });
    });

    it('logs audit with PROGRAM_CREATED', async () => {
      prisma.program.create.mockResolvedValue(makeProgram());

      await service.createProgram(ORG_A, { name: 'TMF Leadership Accelerator' }, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'PROGRAM_CREATED',
          entityType: 'PROGRAM',
          entityId: PROGRAM_ID,
          metadata: expect.objectContaining({ name: 'TMF Leadership Accelerator' }),
        }),
      );
    });

    it('returns the shaped program object', async () => {
      prisma.program.create.mockResolvedValue(makeProgram());

      const result = await service.createProgram(ORG_A, { name: 'TMF Leadership Accelerator' }, ACTOR_ID);

      expect(result).toEqual(
        expect.objectContaining({
          id: PROGRAM_ID,
          name: 'TMF Leadership Accelerator',
          startDate: BASE_DATE.toISOString(),
          archivedAt: null,
          createdAt: BASE_DATE.toISOString(),
        }),
      );
    });
  });

  // =========================================================================
  // getProgram
  // =========================================================================
  describe('getProgram', () => {
    function setupGetProgramSuccess() {
      prisma.program.findUnique.mockResolvedValue({
        ...makeProgram(),
        _count: { courses: 2, program_memberships: 4 },
      });
      prisma.programMembership.findMany.mockResolvedValue([
        { type: MembershipType.SCHOLAR, user_id: 's1' },
        { type: MembershipType.SCHOLAR, user_id: 's2' },
        { type: MembershipType.MENTOR, user_id: 'm1' },
      ]);
      prisma.scholarAssignment.findMany.mockResolvedValue([
        { status: 'VERIFIED' },
        { status: 'IN_PROGRESS' },
        { status: 'PENDING_VERIFICATION' },
        { status: 'VERIFIED_LATE' },
      ]);
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { status: 'PRESENT' },
        { status: 'PRESENT' },
        { status: 'ABSENT' },
        { status: 'EXCUSED' },
      ]);
    }

    it('returns progress summary with scholar/mentor counts and completion rates', async () => {
      setupGetProgramSuccess();

      const result = await service.getProgram(ORG_A, PROGRAM_ID);

      expect(prisma.program.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROGRAM_ID, organization_id: ORG_A },
        }),
      );
      // 2 scholars, 1 mentor
      expect(result.progress.scholarCount).toBe(2);
      expect(result.progress.mentorCount).toBe(1);
      expect(result.progress.totalMembers).toBe(4);
      expect(result.progress.courseCount).toBe(2);
      // assignment completed = VERIFIED + PENDING_VERIFICATION + VERIFIED_LATE = 3 of 4
      expect(result.progress.assignmentCompletionRate).toBeCloseTo(0.75);
      // attendance: present=2, denominator excludes excused => 2 / 3
      expect(result.progress.attendanceRate).toBeCloseTo(0.6667);
    });

    it('scopes the memberships/assignment/attendance queries to the organization', async () => {
      setupGetProgramSuccess();

      await service.getProgram(ORG_A, PROGRAM_ID);

      expect(prisma.programMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A, program_id: PROGRAM_ID }),
        }),
      );
      expect(prisma.scholarAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND when findUnique returns null (cross-tenant or nonexistent)', async () => {
      // A user from ORG_B hitting an ORG_A program: org-scoped where matches nothing.
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.getProgram(ORG_A, PROGRAM_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
    });
  });

  // =========================================================================
  // updateProgram
  // =========================================================================
  describe('updateProgram', () => {
    it('only updates the provided fields', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.program.update.mockResolvedValue(makeProgram({ name: 'Updated Name' }));

      await service.updateProgram(ORG_A, PROGRAM_ID, { name: 'Updated Name' }, ACTOR_ID);

      expect(prisma.program.update).toHaveBeenCalledWith({
        where: { id: PROGRAM_ID },
        data: expect.objectContaining({ name: 'Updated Name' }),
      });
      const data = prisma.program.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('starts_at');
      expect(data).not.toHaveProperty('description');
    });

    it('scopes the existence check to the organization', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.program.update.mockResolvedValue(makeProgram());

      await service.updateProgram(ORG_A, PROGRAM_ID, { name: 'X' }, ACTOR_ID);

      expect(prisma.program.findUnique).toHaveBeenCalledWith({
        where: { id: PROGRAM_ID, organization_id: ORG_A },
        select: { id: true },
      });
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND on cross-tenant org-miss', async () => {
      // User in ORG_A tries to PATCH an ORG_B program -> outlined findUnique returns null.
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.updateProgram(ORG_A, OTHER_PROGRAM_ID, { name: 'H4ck' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      // Never reaches update
      expect(prisma.program.update).not.toHaveBeenCalled();
    });

    it('calls audit with PROGRAM_UPDATED and changed metadata', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.program.update.mockResolvedValue(makeProgram({ description: 'New desc' }));
      const startDate = new Date('2026-09-01T00:00:00.000Z');

      await service.updateProgram(
        ORG_A,
        PROGRAM_ID,
        { description: 'New desc', startDate },
        ACTOR_ID,
      );

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'PROGRAM_UPDATED',
          entityType: 'PROGRAM',
          entityId: PROGRAM_ID,
          metadata: expect.objectContaining({
            description: 'New desc',
            startDate: startDate.toISOString(),
          }),
        }),
      );
    });

    it('returns the shaped updated program', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.program.update.mockResolvedValue(makeProgram({ name: 'Renamed' }));

      const result = await service.updateProgram(ORG_A, PROGRAM_ID, { name: 'Renamed' }, ACTOR_ID);

      expect(result.name).toBe('Renamed');
    });
  });

  // =========================================================================
  // archiveProgram
  // =========================================================================
  describe('archiveProgram', () => {
    it('sets archived_at and returns { id, archivedAt, message }', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID, archived_at: null });
      prisma.program.update.mockResolvedValue({ id: PROGRAM_ID, archived_at: BASE_DATE });

      const result = await service.archiveProgram(ORG_A, PROGRAM_ID, ACTOR_ID);

      expect(result).toEqual({
        id: PROGRAM_ID,
        archivedAt: BASE_DATE.toISOString(),
        message: 'Program archived. Historical data is preserved.',
      });
      expect(prisma.program.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROGRAM_ID },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.archiveProgram(ORG_A, OTHER_PROGRAM_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.program.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException PROGRAM_ALREADY_ARCHIVED when already archived', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID, archived_at: BASE_DATE });

      try {
        await service.archiveProgram(ORG_A, PROGRAM_ID, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_ALREADY_ARCHIVED' }),
        );
      }
      expect(prisma.program.update).not.toHaveBeenCalled();
    });

    it('calls audit with PROGRAM_ARCHIVED', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID, archived_at: null });
      prisma.program.update.mockResolvedValue({ id: PROGRAM_ID, archived_at: BASE_DATE });

      await service.archiveProgram(ORG_A, PROGRAM_ID, ACTOR_ID);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'PROGRAM_ARCHIVED',
          entityType: 'PROGRAM',
          entityId: PROGRAM_ID,
        }),
      );
    });
  });

  // =========================================================================
  // listProgramMembers
  // =========================================================================
  describe('listProgramMembers', () => {
    it('returns members with membershipType plus scholar/mentor summary', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.programMembership.findMany.mockResolvedValue([
        { user: { id: 's1', name: 'Scholar One', email: 's1@x.com' }, type: MembershipType.SCHOLAR },
        { user: { id: 's2', name: 'Scholar Two', email: 's2@x.com' }, type: MembershipType.SCHOLAR },
        { user: { id: 'm1', name: 'Mentor One', email: 'm1@x.com' }, type: MembershipType.MENTOR },
      ]);

      const result = await service.listProgramMembers(ORG_A, PROGRAM_ID);

      expect(result.programId).toBe(PROGRAM_ID);
      expect(result.members[0]).toEqual(
        expect.objectContaining({ id: 's1', membershipType: MembershipType.SCHOLAR }),
      );
      expect(result.summary).toEqual({ total: 3, scholarCount: 2, mentorCount: 1 });
    });

    it('scopes the memberships query to the organization and program', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.programMembership.findMany.mockResolvedValue([]);

      await service.listProgramMembers(ORG_A, PROGRAM_ID);

      expect(prisma.programMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A, program_id: PROGRAM_ID }),
        }),
      );
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND on cross-tenant org-miss', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.listProgramMembers(ORG_A, OTHER_PROGRAM_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.programMembership.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // addProgramMember
  // =========================================================================
  describe('addProgramMember', () => {
    it('verifies the target user is in the calling organization before upserting', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: USER_IN_ORG });
      prisma.programMembership.upsert.mockResolvedValue({
        id: 'pm-1',
        program_id: PROGRAM_ID,
        user_id: USER_IN_ORG,
        type: MembershipType.SCHOLAR,
      });

      const result = await service.addProgramMember(
        ORG_A,
        PROGRAM_ID,
        { userId: USER_IN_ORG, membershipType: MembershipType.SCHOLAR },
        ACTOR_ID,
      );

      expect(prisma.userRole.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: ORG_A, user_id: USER_IN_ORG },
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ programId: PROGRAM_ID, userId: USER_IN_ORG }),
      );
    });

    it('throws NotFoundException USER_NOT_FOUND when the user is not in the calling org (cross-tenant leak prevention)', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      // ORG_A admin tries to add an ORG_B user -> no userRole for that user in ORG_A.
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.addProgramMember(
          ORG_A,
          PROGRAM_ID,
          { userId: USER_NOT_IN_ORG, membershipType: MembershipType.SCHOLAR },
          ACTOR_ID,
        );
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
      expect(prisma.programMembership.upsert).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('throws NotFoundException PROGRAM_NOT_FOUND when program belongs to another org', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.addProgramMember(
          ORG_A,
          OTHER_PROGRAM_ID,
          { userId: USER_IN_ORG, membershipType: MembershipType.SCHOLAR },
          ACTOR_ID,
        );
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
    });

    it('calls audit with PROGRAM_MEMBER_ADDED', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue({ user_id: USER_IN_ORG });
      prisma.programMembership.upsert.mockResolvedValue({
        id: 'pm-1',
        program_id: PROGRAM_ID,
        user_id: USER_IN_ORG,
        type: MembershipType.MENTOR,
      });

      await service.addProgramMember(
        ORG_A,
        PROGRAM_ID,
        { userId: USER_IN_ORG, membershipType: MembershipType.MENTOR },
        ACTOR_ID,
      );

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'PROGRAM_MEMBER_ADDED',
          entityType: 'PROGRAM',
          entityId: PROGRAM_ID,
          metadata: expect.objectContaining({
            userId: USER_IN_ORG,
            membershipType: MembershipType.MENTOR,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Cross-tenant isolation (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user cannot read an ORG_B program (findUnique returns null -> 404, no leak)', async () => {
      // The ORG_A caller queries with where { id: prog_b, organization_id: ORG_A }.
      // A record owned by ORG_B is never returned, so it must throw 404.
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.getProgram(ORG_A, OTHER_PROGRAM_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      // The check must have been org-scoped.
      expect(prisma.program.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_PROGRAM_ID, organization_id: ORG_A } }),
      );
    });

    it('ORG_A user cannot patch an ORG_B program', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.updateProgram(ORG_A, OTHER_PROGRAM_ID, { name: 'X' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.program.update).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot archive an ORG_B program', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.archiveProgram(ORG_A, OTHER_PROGRAM_ID, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.program.update).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot list members of an ORG_B program', async () => {
      prisma.program.findUnique.mockResolvedValue(null);

      try {
        await service.listProgramMembers(ORG_A, OTHER_PROGRAM_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'PROGRAM_NOT_FOUND' }),
        );
      }
      expect(prisma.programMembership.findMany).not.toHaveBeenCalled();
    });

    it('ORG_A user cannot add an ORG_B member to an ORG_A program', async () => {
      prisma.program.findUnique.mockResolvedValue({ id: PROGRAM_ID });
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.addProgramMember(
          ORG_A,
          PROGRAM_ID,
          { userId: USER_NOT_IN_ORG, membershipType: MembershipType.SCHOLAR },
          ACTOR_ID,
        );
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
      expect(prisma.programMembership.upsert).not.toHaveBeenCalled();
    });
  });
});
