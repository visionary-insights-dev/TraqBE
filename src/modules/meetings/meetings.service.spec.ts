import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { MeetingsService } from './meetings.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';
const COURSE_ID = 'course-00000000-0000-0000-0000-000000000001';
const OTHER_COURSE_ID = 'course-00000000-0000-0000-0000-000000000099';
const MEETING_ID = 'meet-00000000-0000-0000-0000-000000000001';
const ORG_B_MEETING_ID = 'meet-00000000-0000-0000-0000-000000000099';

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');
const STARTS_AT = new Date('2026-01-10T10:00:00.000Z');

const ADMIN_A: AuthUser = {
  id: 'user-aaa-admin',
  email: 'admin@a.com',
  organizationId: ORG_A,
  roles: [Role.SUPER_ADMIN],
};
const MENTOR_A: AuthUser = {
  id: 'user-aaa-mentor',
  email: 'mentor@a.com',
  organizationId: ORG_A,
  roles: [Role.MENTOR],
};
const SCHOLAR_A: AuthUser = {
  id: 'user-aaa-scholar',
  email: 'scholar@a.com',
  organizationId: ORG_A,
  roles: [Role.SCHOLAR],
};

function makeMeeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    organization_id: ORG_A,
    course_id: COURSE_ID,
    title: 'Week 5 Check-in',
    description: 'Review of concepts',
    type: 'Lecture',
    duration_minutes: 60,
    starts_at: STARTS_AT,
    ends_at: new Date(STARTS_AT.getTime() + 60 * 60_000),
    recorded_by: ACTOR_ID,
    archived_at: null,
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    course: { id: COURSE_ID, name: 'Financial Literacy 101' },
    ...overrides,
  };
}

const ORG_SETTINGS = {
  assignmentEditWindowMinutes: 60,
  lateSubmissionPenaltyPercentage: 20,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MeetingsService', () => {
  let service: MeetingsService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      meeting: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      course: {
        findUnique: vi.fn(),
      },
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    service = new MeetingsService(prisma as any, audit as any);
  });

  // =========================================================================
  // listMeetings
  // =========================================================================
  describe('listMeetings', () => {
    it('returns { data, meta } with pagination for SUPER_ADMIN (all org meetings)', async () => {
      prisma.meeting.findMany.mockResolvedValue([makeMeeting(), makeMeeting({ id: 'meet-x' })]);
      prisma.meeting.count.mockResolvedValue(9);

      const result = await service.listMeetings(ORG_A, { page: 2, limit: 2, archived: false }, ADMIN_A);

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: MEETING_ID,
          courseId: COURSE_ID,
          courseName: 'Financial Literacy 101',
          title: 'Week 5 Check-in',
          type: 'Lecture',
          durationMinutes: 60,
        }),
      );
      expect(result.meta).toEqual({ total: 9, totalPages: 5, page: 2, limit: 2 });
    });

    it('scopes queries by organization_id (release-blocking)', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false }, ADMIN_A);

      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_A }) }),
      );
      expect(prisma.meeting.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organization_id: ORG_A }) }),
      );
    });

    it('filters archived meetings when archived=true', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: true }, ADMIN_A);

      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: { not: null } }) }),
      );
    });

    it('filters active meetings (archived_at: null) by default', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false }, ADMIN_A);

      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('filters by courseId when provided', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false, courseId: COURSE_ID }, ADMIN_A);

      expect(prisma.meeting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ course_id: COURSE_ID }) }),
      );
    });

    it('scopes MENTOR to meetings for their courses via mentor_scholar_assignments', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false }, MENTOR_A);

      const where = prisma.meeting.findMany.mock.calls[0][0].where;
      expect(where.course).toEqual({
        is: { mentor_scholar_assignments: { some: { mentor_id: MENTOR_A.id } } },
      });
    });

    it('scopes SCHOLAR to meetings for their enrolled courses via course_memberships', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false }, SCHOLAR_A);

      const where = prisma.meeting.findMany.mock.calls[0][0].where;
      expect(where.course).toEqual({
        is: { course_memberships: { some: { user_id: SCHOLAR_A.id } } },
      });
    });

    it('does NOT apply a role filter for SUPER_ADMIN', async () => {
      prisma.meeting.findMany.mockResolvedValue([]);
      prisma.meeting.count.mockResolvedValue(0);

      await service.listMeetings(ORG_A, { page: 1, limit: 25, archived: false }, ADMIN_A);

      const where = prisma.meeting.findMany.mock.calls[0][0].where;
      expect(where.course).toBeUndefined();
      expect(where).toEqual(expect.objectContaining({ organization_id: ORG_A }));
    });
  });

  // =========================================================================
  // createMeeting
  // =========================================================================
  describe('createMeeting', () => {
    it('creates a meeting and computes ends_at from durationMinutes', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: COURSE_ID, name: 'Financial Literacy 101' });
      prisma.meeting.create.mockResolvedValue(makeMeeting());

      const dto = {
        title: 'Week 5 Check-in',
        courseId: COURSE_ID,
        scheduledAt: STARTS_AT.toISOString(),
        durationMinutes: 60,
        type: 'Lecture',
      };

      const result = await service.createMeeting(ORG_A, dto, ACTOR_ID);

      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: COURSE_ID, organization_id: ORG_A } }),
      );
      expect(prisma.meeting.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: ORG_A,
            course_id: COURSE_ID,
            title: 'Week 5 Check-in',
            type: 'Lecture',
            duration_minutes: 60,
            starts_at: STARTS_AT,
            ends_at: new Date(STARTS_AT.getTime() + 60 * 60_000),
            recorded_by: ACTOR_ID,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ACTOR_ID,
          action: 'MEETING_CREATED',
          entityType: 'MEETING',
          entityId: MEETING_ID,
        }),
      );
      expect(result.title).toBe('Week 5 Check-in');
      expect(result.durationMinutes).toBe(60);
      expect(result.scheduledAt).toBe(STARTS_AT.toISOString());
    });

    it('throws COURSE_NOT_FOUND when the course belongs to another org (tenant isolation)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);

      await expect(
        service.createMeeting(ORG_A, {
          title: 'X',
          courseId: COURSE_ID,
          scheduledAt: STARTS_AT.toISOString(),
          durationMinutes: 60,
          type: 'Lecture',
        }, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getOne / getMeeting
  // =========================================================================
  describe('getOne', () => {
    it('returns a meeting for the same org', async () => {
      prisma.meeting.findUnique.mockResolvedValue(makeMeeting());

      const result = await service.getOne(ORG_A, MEETING_ID);

      expect(prisma.meeting.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MEETING_ID, organization_id: ORG_A } }),
      );
      expect(result.id).toBe(MEETING_ID);
      expect(result).toEqual(
        expect.objectContaining({
          courseId: COURSE_ID,
          title: 'Week 5 Check-in',
          scheduledAt: STARTS_AT.toISOString(),
        }),
      );
    });

    it('throws MEETING_NOT_FOUND for an org B meeting id (release-blocking)', async () => {
      prisma.meeting.findUnique.mockResolvedValue(null);

      await expect(service.getOne(ORG_A, ORG_B_MEETING_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getMeeting (shared helper)', () => {
    it('throws MEETING_NOT_FOUND when the meeting is outside the org', async () => {
      prisma.meeting.findUnique.mockResolvedValue(null);

      await expect(service.getMeeting(ORG_A, ORG_B_MEETING_ID)).rejects.toThrow(NotFoundException);
    });

    it('scopes the query by organization_id', async () => {
      prisma.meeting.findUnique.mockResolvedValue(makeMeeting());

      await service.getMeeting(ORG_A, MEETING_ID);

      expect(prisma.meeting.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MEETING_ID, organization_id: ORG_A } }),
      );
    });
  });

  // =========================================================================
  // updateMeeting
  // =========================================================================
  describe('updateMeeting', () => {
    it('applies a partial update (title only) and logs MEETING_UPDATED', async () => {
      prisma.meeting.findUnique
        .mockResolvedValueOnce(makeMeeting()) // getMeeting re-fetch
        .mockResolvedValueOnce(makeMeeting({ title: 'Renamed' })); // update result
      prisma.meeting.update.mockResolvedValue(makeMeeting({ title: 'Renamed' }));

      const result = await service.updateMeeting(ORG_A, MEETING_ID, { title: 'Renamed' }, ACTOR_ID);

      expect(prisma.meeting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MEETING_ID },
          data: expect.objectContaining({ title: 'Renamed' }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEETING_UPDATED',
          entityId: MEETING_ID,
          metadata: expect.objectContaining({ title: 'Renamed' }),
        }),
      );
      expect(result.title).toBe('Renamed');
    });

    it('recomputes ends_at when scheduledAt or durationMinutes change', async () => {
      prisma.meeting.findUnique
        .mockResolvedValueOnce(makeMeeting())
        .mockResolvedValueOnce(makeMeeting({ duration_minutes: 90 }));
      prisma.meeting.update.mockResolvedValue(makeMeeting({ duration_minutes: 90 }));

      const newStart = new Date('2026-01-11T09:00:00.000Z');
      await service.updateMeeting(ORG_A, MEETING_ID, { scheduledAt: newStart.toISOString(), durationMinutes: 90 }, ACTOR_ID);

      const updateArgs = prisma.meeting.update.mock.calls[0][0];
      expect(updateArgs.data.starts_at).toEqual(newStart);
      expect(updateArgs.data.duration_minutes).toBe(90);
      expect(updateArgs.data.ends_at).toEqual(new Date(newStart.getTime() + 90 * 60_000));
    });

    it('throws MEETING_NOT_FOUND for a cross-org meeting id', async () => {
      prisma.meeting.findUnique.mockResolvedValue(null);

      await expect(
        service.updateMeeting(ORG_A, ORG_B_MEETING_ID, { title: 'X' }, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.meeting.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // archiveMeeting
  // =========================================================================
  describe('archiveMeeting', () => {
    it('soft-archives a meeting and logs MEETING_ARCHIVED', async () => {
      prisma.meeting.findUnique.mockResolvedValue({ id: MEETING_ID, archived_at: null });
      prisma.meeting.update.mockResolvedValue({ id: MEETING_ID, archived_at: BASE_DATE });

      const result = await service.archiveMeeting(ORG_A, MEETING_ID, ACTOR_ID);

      expect(prisma.meeting.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MEETING_ID }, data: { archived_at: expect.any(Date) } }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MEETING_ARCHIVED', entityId: MEETING_ID }),
      );
      expect(result.archivedAt).toBe(BASE_DATE.toISOString());
    });

    it('throws MEETING_ALREADY_ARCHIVED on second archive', async () => {
      prisma.meeting.findUnique.mockResolvedValue({ id: MEETING_ID, archived_at: BASE_DATE });

      await expect(service.archiveMeeting(ORG_A, MEETING_ID, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('throws MEETING_NOT_FOUND for a cross-org meeting id (release-blocking)', async () => {
      prisma.meeting.findUnique.mockResolvedValue(null);

      await expect(service.archiveMeeting(ORG_A, ORG_B_MEETING_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
      expect(prisma.meeting.update).not.toHaveBeenCalled();
    });
  });
});