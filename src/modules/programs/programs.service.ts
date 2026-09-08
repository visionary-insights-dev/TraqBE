import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MembershipType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateProgramDto } from './dto/create-program.dto.js';
import { UpdateProgramDto } from './dto/update-program.dto.js';
import { ListProgramsQueryDto } from './dto/list-programs.query.dto.js';
import { AddProgramMemberDto } from './dto/add-program-member.dto.js';

const COMPLETED_ASSIGNMENT_STATUSES = ['VERIFIED', 'VERIFIED_LATE', 'PENDING_VERIFICATION'];

@Injectable()
export class ProgramsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // LIST PROGRAMS
  // =========================================================================
  async listPrograms(organizationId: string, query: ListProgramsQueryDto) {
    const where: Prisma.ProgramWhereInput = {
      organization_id: organizationId,
      archived_at: query.archived ? { not: null } : null,
    };

    const [programs, total] = await Promise.all([
      this.prisma.program.findMany({
        where,
        include: { _count: { select: { courses: true, program_memberships: true } } },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.program.count({ where }),
    ]);

    const data = programs.map((program) => ({
      id: program.id,
      name: program.name,
      description: program.description,
      startDate: program.starts_at ? program.starts_at.toISOString() : null,
      endDate: program.ends_at ? program.ends_at.toISOString() : null,
      archivedAt: program.archived_at ? program.archived_at.toISOString() : null,
      courseCount: program._count.courses,
      memberCount: program._count.program_memberships,
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
  // CREATE PROGRAM
  // =========================================================================
  async createProgram(organizationId: string, dto: CreateProgramDto, actorId: string) {
    const program = await this.prisma.program.create({
      data: {
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        starts_at: dto.startDate ?? null,
        ends_at: dto.endDate ?? null,
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'PROGRAM_CREATED',
      entityType: 'PROGRAM',
      entityId: program.id,
      metadata: { name: program.name },
    });

    return this.shapeProgram(program);
  }

  // =========================================================================
  // GET PROGRAM (org-scoped) with progress summary
  // =========================================================================
  async getProgram(organizationId: string, id: string) {
    const program = await this.prisma.program.findUnique({
      where: { id, organization_id: organizationId },
      include: { _count: { select: { courses: true, program_memberships: true } } },
    });

    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
    }

    const memberships = await this.prisma.programMembership.findMany({
      where: { organization_id: organizationId, program_id: id },
      select: { type: true, user_id: true },
    });

    const scholarIds = memberships
      .filter((m) => m.type === MembershipType.SCHOLAR)
      .map((m) => m.user_id);
    const scholarCount = scholarIds.length;
    const mentorCount = memberships.length - scholarCount;

    const [scholarAssignments, attendance] = await Promise.all([
      this.prisma.scholarAssignment.findMany({
        where: { organization_id: organizationId, scholar_id: { in: scholarIds } },
        select: { status: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { organization_id: organizationId, scholar_id: { in: scholarIds } },
        select: { status: true },
      }),
    ]);

    const assignmentTotal = scholarAssignments.length;
    const assignmentCompleted = scholarAssignments.filter((a) =>
      COMPLETED_ASSIGNMENT_STATUSES.includes(a.status),
    ).length;
    const assignmentCompletionRate = assignmentTotal > 0 ? assignmentCompleted / assignmentTotal : 0;

    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    // Denominator excludes excused
    const attendanceDenominator = attendance.filter((a) => a.status !== 'EXCUSED').length;
    const attendanceRate = attendanceDenominator > 0 ? present / attendanceDenominator : 0;

    return {
      ...this.shapeProgram(program),
      courseCount: program._count.courses,
      memberCount: program._count.program_memberships,
      progress: {
        totalMembers: program._count.program_memberships,
        courseCount: program._count.courses,
        scholarCount,
        mentorCount,
        assignmentCompletionRate: Number(assignmentCompletionRate.toFixed(4)),
        attendanceRate: Number(attendanceRate.toFixed(4)),
      },
    };
  }

  // =========================================================================
  // UPDATE PROGRAM (org-scoped)
  // =========================================================================
  async updateProgram(organizationId: string, id: string, dto: UpdateProgramDto, actorId: string) {
    const existing = await this.prisma.program.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
    }

    const data: Prisma.ProgramUpdateInput = {};
    const changed: Record<string, string | number | boolean | null> = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
      changed.name = dto.name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description;
      changed.description = dto.description;
    }
    if (dto.startDate !== undefined) {
      data.starts_at = dto.startDate;
      changed.startDate = dto.startDate instanceof Date ? dto.startDate.toISOString() : null;
    }
    if (dto.endDate !== undefined) {
      data.ends_at = dto.endDate;
      changed.endDate = dto.endDate instanceof Date ? dto.endDate.toISOString() : null;
    }

    const program = await this.prisma.program.update({
      where: { id },
      data,
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'PROGRAM_UPDATED',
      entityType: 'PROGRAM',
      entityId: id,
      metadata: changed,
    });

    return this.shapeProgram(program);
  }

  // =========================================================================
  // ARCHIVE PROGRAM (org-scoped)
  // =========================================================================
  async archiveProgram(organizationId: string, id: string, actorId: string) {
    const program = await this.prisma.program.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, archived_at: true },
    });
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
    }
    if (program.archived_at) {
      throw new BadRequestException({
        code: 'PROGRAM_ALREADY_ARCHIVED',
        message: 'Program is already archived',
      });
    }

    const updated = await this.prisma.program.update({
      where: { id },
      data: { archived_at: new Date() },
      select: { id: true, archived_at: true },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'PROGRAM_ARCHIVED',
      entityType: 'PROGRAM',
      entityId: id,
    });

    return {
      id: updated.id,
      archivedAt: updated.archived_at ? updated.archived_at.toISOString() : null,
      message: 'Program archived. Historical data is preserved.',
    };
  }

  // =========================================================================
  // LIST PROGRAM MEMBERS (org-scoped)
  // =========================================================================
  async listProgramMembers(organizationId: string, id: string) {
    const program = await this.prisma.program.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true },
    });
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
    }

    const memberships = await this.prisma.programMembership.findMany({
      where: { organization_id: organizationId, program_id: id },
      include: { user: true },
      orderBy: { created_at: 'asc' },
    });

    const members = memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      membershipType: m.type,
    }));

    return {
      programId: id,
      members,
      summary: {
        total: memberships.length,
        scholarCount: memberships.filter((m) => m.type === MembershipType.SCHOLAR).length,
        mentorCount: memberships.filter((m) => m.type === MembershipType.MENTOR).length,
      },
    };
  }

  // =========================================================================
  // ADD PROGRAM MEMBER (org-scoped)
  // =========================================================================
  async addProgramMember(organizationId: string, programId: string, dto: AddProgramMemberDto, actorId: string) {
    const program = await this.prisma.program.findUnique({
      where: { id: programId, organization_id: organizationId },
      select: { id: true },
    });
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' });
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

    const membership = await this.prisma.programMembership.upsert({
      where: {
        program_id_user_id: {
          program_id: programId,
          user_id: dto.userId,
        },
      },
      create: {
        organization_id: organizationId,
        program_id: programId,
        user_id: dto.userId,
        type: dto.membershipType,
      },
      update: {
        type: dto.membershipType,
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'PROGRAM_MEMBER_ADDED',
      entityType: 'PROGRAM',
      entityId: programId,
      metadata: { userId: dto.userId, membershipType: dto.membershipType },
    });

    return {
      id: membership.id,
      programId: membership.program_id,
      userId: membership.user_id,
      membershipType: membership.type,
    };
  }

  // =========================================================================
  // SHAPING
  // =========================================================================
  private shapeProgram(program: {
    id: string;
    name: string;
    description: string | null;
    starts_at: Date | null;
    ends_at: Date | null;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      id: program.id,
      name: program.name,
      description: program.description,
      startDate: program.starts_at ? program.starts_at.toISOString() : null,
      endDate: program.ends_at ? program.ends_at.toISOString() : null,
      archivedAt: program.archived_at ? program.archived_at.toISOString() : null,
      createdAt: program.created_at.toISOString(),
      updatedAt: program.updated_at.toISOString(),
    };
  }
}