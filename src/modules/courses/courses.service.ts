import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ScholarAssignmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateCourseDto } from './dto/create-course.dto.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';
import { ListCoursesQueryDto } from './dto/list-courses.query.dto.js';
import { AddCourseMemberDto } from './dto/add-course-member.dto.js';

const ACTIVE_ASSIGNMENT_STATUSES: ScholarAssignmentStatus[] = [
  ScholarAssignmentStatus.NOT_STARTED,
  ScholarAssignmentStatus.IN_PROGRESS,
  ScholarAssignmentStatus.PENDING_VERIFICATION,
];

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // LIST COURSES
  // =========================================================================
  async listCourses(organizationId: string, query: ListCoursesQueryDto) {
    const where: Prisma.CourseWhereInput = {
      organization_id: organizationId,
      archived_at: query.archived ? { not: null } : null,
    };

    const [courses, total] = await Promise.all([
      this.prisma.course.findMany({
        where,
        include: { _count: { select: { assignments: true, course_memberships: true } } },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.course.count({ where }),
    ]);

    const data = courses.map((course) => ({
      id: course.id,
      name: course.name,
      description: course.description,
      programId: course.program_id,
      archivedAt: course.archived_at ? course.archived_at.toISOString() : null,
      assignmentCount: course._count.assignments,
      memberCount: course._count.course_memberships,
    }));

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
  // CREATE COURSE
  // =========================================================================
  async createCourse(organizationId: string, dto: CreateCourseDto, actorId: string) {
    // The program must belong to this org — otherwise return an org-scoped 404.
    const program = await this.prisma.program.findUnique({
      where: { id: dto.programId, organization_id: organizationId },
      select: { id: true },
    });
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
    }

    const course = await this.prisma.course.create({
      data: {
        organization_id: organizationId,
        program_id: dto.programId,
        name: dto.name,
        description: dto.description ?? null,
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'COURSE_CREATED',
      entityType: 'COURSE',
      entityId: course.id,
      metadata: { name: course.name, programId: dto.programId },
    });

    return this.shapeCourse(course);
  }

  // =========================================================================
  // GET COURSE (org-scoped)
  // =========================================================================
  async getCourse(organizationId: string, id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id, organization_id: organizationId },
      include: {
        program: { select: { id: true, name: true } },
        _count: { select: { assignments: true, course_memberships: true } },
      },
    });

    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    return {
      ...this.shapeCourse(course),
      program: { id: course.program.id, name: course.program.name },
      assignmentCount: course._count.assignments,
      memberCount: course._count.course_memberships,
    };
  }

  // =========================================================================
  // UPDATE COURSE (org-scoped)
  // =========================================================================
  async updateCourse(organizationId: string, id: string, dto: UpdateCourseDto, actorId: string) {
    const existing = await this.prisma.course.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    if (dto.programId !== undefined) {
      const program = await this.prisma.program.findUnique({
        where: { id: dto.programId, organization_id: organizationId },
        select: { id: true },
      });
      if (!program) {
        throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
      }
    }

    const data: Prisma.CourseUpdateInput = {};
    const changed: Record<string, string | null> = {};
    if (dto.programId !== undefined) {
      data.program = { connect: { id: dto.programId } };
      changed.programId = dto.programId;
    }
    if (dto.name !== undefined) {
      data.name = dto.name;
      changed.name = dto.name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description;
      changed.description = dto.description;
    }

    const course = await this.prisma.course.update({
      where: { id },
      data,
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'COURSE_UPDATED',
      entityType: 'COURSE',
      entityId: id,
      metadata: changed,
    });

    return this.shapeCourse(course);
  }

  // =========================================================================
  // ARCHIVE COURSE (org-scoped)
  // =========================================================================
  async archiveCourse(organizationId: string, id: string, actorId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, archived_at: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }
    if (course.archived_at) {
      throw new BadRequestException({
        code: 'COURSE_ALREADY_ARCHIVED',
        message: 'Course is already archived',
      });
    }

    const updated = await this.prisma.course.update({
      where: { id },
      data: { archived_at: new Date() },
      select: { id: true, archived_at: true },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'COURSE_ARCHIVED',
      entityType: 'COURSE',
      entityId: id,
    });

    return {
      id: updated.id,
      archivedAt: updated.archived_at ? updated.archived_at.toISOString() : null,
      message: 'Course archived. Historical data is preserved.',
    };
  }

  // =========================================================================
  // LIST COURSE MEMBERS (org-scoped)
  // =========================================================================
  async listCourseMembers(organizationId: string, id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    const memberships = await this.prisma.courseMembership.findMany({
      where: { organization_id: organizationId, course_id: id },
      include: { user: true },
      orderBy: { created_at: 'asc' },
    });

    const members = memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
    }));

    return {
      courseId: id,
      members,
      summary: {
        total: memberships.length,
      },
    };
  }

  // =========================================================================
  // ADD COURSE MEMBER (org-scoped)
  // =========================================================================
  async addCourseMember(organizationId: string, courseId: string, dto: AddCourseMemberDto, actorId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId, organization_id: organizationId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    // The user must belong to this organization — otherwise return an
    // org-scoped 404 and never reveal cross-org existence.
    const userRole = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: dto.userId },
      select: { user_id: true },
    });
    if (!userRole) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const membership = await this.prisma.courseMembership.upsert({
      where: {
        course_id_user_id: {
          course_id: courseId,
          user_id: dto.userId,
        },
      },
      create: {
        organization_id: organizationId,
        course_id: courseId,
        user_id: dto.userId,
      },
      update: {},
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'COURSE_MEMBER_ADDED',
      entityType: 'COURSE',
      entityId: courseId,
      metadata: { userId: dto.userId },
    });

    return {
      id: membership.id,
      courseId: membership.course_id,
      userId: membership.user_id,
    };
  }

  // =========================================================================
  // REMOVE COURSE MEMBER (org-scoped) with active-assignment guard
  // =========================================================================
  async removeCourseMember(organizationId: string, courseId: string, userId: string, actorId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId, organization_id: organizationId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    // Guard: a scholar with ACTIVE ScholarAssignments in this course cannot be
    // removed. ScholarAssignment links to an Assignment which links to a Course.
    const activeAssignment = await this.prisma.scholarAssignment.findFirst({
      where: {
        organization_id: organizationId,
        scholar_id: userId,
        assignment: { course_id: courseId },
        status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      },
      select: { id: true },
    });
    if (activeAssignment) {
      throw new BadRequestException({
        code: 'SCHOLAR_HAS_ACTIVE_ASSIGNMENTS',
        message: 'Cannot remove a scholar who has active assignments',
      });
    }

    // Idempotent delete: whether or not the membership exists, the org-scoped
    // 404 check above already guarantees we never reveal cross-org state.
    await this.prisma.courseMembership.deleteMany({
      where: {
        organization_id: organizationId,
        course_id: courseId,
        user_id: userId,
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'COURSE_MEMBER_REMOVED',
      entityType: 'COURSE',
      entityId: courseId,
      metadata: { userId },
    });

    return {
      removed: true,
      courseId,
      userId,
    };
  }

  // =========================================================================
  // SHAPING
  // =========================================================================
  private shapeCourse(course: {
    id: string;
    program_id: string;
    name: string;
    description: string | null;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      id: course.id,
      name: course.name,
      description: course.description,
      programId: course.program_id,
      archivedAt: course.archived_at ? course.archived_at.toISOString() : null,
      createdAt: course.created_at.toISOString(),
      updatedAt: course.updated_at.toISOString(),
    };
  }
}
