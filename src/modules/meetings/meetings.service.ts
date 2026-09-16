import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { CreateMeetingDto } from './dto/create-meeting.dto.js';
import { UpdateMeetingDto } from './dto/update-meeting.dto.js';
import { ListMeetingsQueryDto } from './dto/list-meetings.query.dto.js';

type MeetingWithCourse = Prisma.MeetingGetPayload<{
  include: { course: { select: { id: true; name: true } } };
}>;

type MeetingShape = {
  id: string;
  courseId: string;
  courseName: string;
  title: string;
  description: string | null;
  type: string | null;
  durationMinutes: number | null;
  scheduledAt: string;
  endsAt: string | null;
  recordedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // LIST MEETINGS (org-scoped, role-filtered, paginated)
  // =========================================================================
  async listMeetings(organizationId: string, query: ListMeetingsQueryDto, user: AuthUser) {
    const where: Prisma.MeetingWhereInput = {
      organization_id: organizationId,
      archived_at: query.archived ? { not: null } : null,
    };

    if (query.courseId) {
      where.course_id = query.courseId;
    }

    // Role scoping
    const roles = user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      if (roles.includes('MENTOR')) {
        // Mentors see meetings for courses where they have mentor-scholar pairings
        where.course = {
          is: {
            mentor_scholar_assignments: { some: { mentor_id: user.id } },
          },
        };
      } else if (roles.includes('SCHOLAR')) {
        // Scholars see meetings for their enrolled courses
        where.course = {
          is: {
            course_memberships: { some: { user_id: user.id } },
          },
        };
      }
    }

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        include: { course: { select: { id: true, name: true } } },
        orderBy: { starts_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.meeting.count({ where }),
    ]);

    const data = meetings.map((m) => this.shapeMeeting(m));

    return {
      data,
      meta: {
        total,
        totalPages: Math.ceil(total / query.limit),
        page: query.page,
        limit: query.limit,
      },
    };
  }

  // =========================================================================
  // CREATE MEETING
  // =========================================================================
  async createMeeting(organizationId: string, dto: CreateMeetingDto, actorId: string) {
    // Validate the course belongs to the org
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId, organization_id: organizationId },
      select: { id: true, name: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    const startsAt = new Date(dto.scheduledAt);
    const endsAt = new Date(startsAt.getTime() + dto.durationMinutes * 60_000);

    const meeting = await this.prisma.meeting.create({
      data: {
        organization_id: organizationId,
        course_id: dto.courseId,
        title: dto.title,
        description: dto.description ?? null,
        type: dto.type,
        duration_minutes: dto.durationMinutes,
        starts_at: startsAt,
        ends_at: endsAt,
        recorded_by: actorId,
      },
      include: { course: { select: { id: true, name: true } } },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'MEETING_CREATED',
      entityType: 'MEETING',
      entityId: meeting.id,
      metadata: { title: dto.title, courseId: dto.courseId, type: dto.type } as Record<string, string | null>,
    });

    return this.shapeMeeting(meeting);
  }

  // =========================================================================
  // GET MEETING (org-scoped) — also used by AttendanceService
  // =========================================================================
  async getMeeting(organizationId: string, id: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id, organization_id: organizationId },
      select: {
        id: true,
        organization_id: true,
        course_id: true,
        title: true,
        description: true,
        type: true,
        duration_minutes: true,
        starts_at: true,
        ends_at: true,
        recorded_by: true,
        archived_at: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!meeting) {
      throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' });
    }

    return meeting;
  }

  // =========================================================================
  // GET MEETING (full, for controller GET :id)
  // =========================================================================
  async getOne(organizationId: string, id: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id, organization_id: organizationId },
      include: { course: { select: { id: true, name: true } } },
    });

    if (!meeting) {
      throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' });
    }

    return this.shapeMeeting(meeting);
  }

  // =========================================================================
  // UPDATE MEETING (org-scoped)
  // =========================================================================
  async updateMeeting(organizationId: string, id: string, dto: UpdateMeetingDto, actorId: string) {
    await this.getMeeting(organizationId, id); // org-scoped 404 check

    const data: Prisma.MeetingUpdateInput = {};
    const changed: Record<string, string | number | null> = {};

    if (dto.title !== undefined) {
      data.title = dto.title;
      changed.title = dto.title;
    }
    if (dto.description !== undefined) {
      data.description = dto.description ?? null;
      changed.description = dto.description ?? null;
    }
    if (dto.type !== undefined) {
      data.type = dto.type;
      changed.type = dto.type;
    }
    if (dto.scheduledAt !== undefined || dto.durationMinutes !== undefined) {
      // Re-fetch current to compute ends_at properly
      const current = await this.getMeeting(organizationId, id);
      const startsAt = dto.scheduledAt ? new Date(dto.scheduledAt) : current.starts_at;
      const durationMinutes = dto.durationMinutes ?? current.duration_minutes ?? 60;
      data.starts_at = startsAt;
      data.duration_minutes = durationMinutes;
      data.ends_at = new Date(startsAt.getTime() + durationMinutes * 60_000);
      changed.scheduledAt = startsAt.toISOString();
      changed.durationMinutes = durationMinutes;
    }

    const meeting = await this.prisma.meeting.update({
      where: { id },
      data,
      include: { course: { select: { id: true, name: true } } },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'MEETING_UPDATED',
      entityType: 'MEETING',
      entityId: id,
      metadata: changed as Record<string, string | number | null>,
    });

    return this.shapeMeeting(meeting);
  }

  // =========================================================================
  // ARCHIVE MEETING (soft archive)
  // =========================================================================
  async archiveMeeting(organizationId: string, id: string, actorId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, archived_at: true },
    });

    if (!meeting) {
      throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' });
    }
    if (meeting.archived_at) {
      throw new BadRequestException({
        code: 'MEETING_ALREADY_ARCHIVED',
        message: 'Meeting is already archived',
      });
    }

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { archived_at: new Date() },
      select: { id: true, archived_at: true },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'MEETING_ARCHIVED',
      entityType: 'MEETING',
      entityId: id,
    });

    return {
      id: updated.id,
      archivedAt: updated.archived_at ? updated.archived_at.toISOString() : null,
      message: 'Meeting archived. Historical data is preserved.',
    };
  }

  // =========================================================================
  // SHAPE — camelCase output, strip org/scoped fields
  // =========================================================================
  private shapeMeeting(m: MeetingWithCourse): MeetingShape {
    return {
      id: m.id,
      courseId: m.course_id,
      courseName: m.course.name,
      title: m.title,
      description: m.description,
      type: m.type,
      durationMinutes: m.duration_minutes,
      scheduledAt: m.starts_at.toISOString(),
      endsAt: m.ends_at?.toISOString() ?? null,
      recordedBy: m.recorded_by,
      archivedAt: m.archived_at?.toISOString() ?? null,
      createdAt: m.created_at.toISOString(),
      updatedAt: m.updated_at.toISOString(),
    };
  }
}
