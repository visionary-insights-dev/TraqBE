import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailDispatchJobData, EMAIL_QUEUE } from '../../jobs/queues/email.queue.js';
import { CreateMentorAssignmentDto } from './dto/create-mentor-assignment.dto.js';
import { ReassignMentorAssignmentDto } from './dto/reassign-mentor-assignment.dto.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

type AuditMetadata = Record<string, string | number | boolean | null>;

@Injectable()
export class MentorPairingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  // =========================================================================
  // LIST MENTOR ASSIGNMENTS (org-scoped, role-filtered)
  // =========================================================================
  async list(organizationId: string, user: AuthUser) {
    const where: Prisma.MentorScholarAssignmentWhereInput = {
      organization_id: organizationId,
    };

    const roles = user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      if (roles.includes('MENTOR')) {
        where.mentor_id = user.id;
      } else if (roles.includes('SCHOLAR')) {
        where.scholar_id = user.id;
      }
    }

    const assignments = await this.prisma.mentorScholarAssignment.findMany({
      where,
      include: {
        mentor: { select: { id: true, name: true, email: true } },
        scholar: { select: { id: true, name: true, email: true } },
        course: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    return assignments.map((assignment) => ({
      id: assignment.id,
      mentor: assignment.mentor,
      scholar: assignment.scholar,
      course: { id: assignment.course.id, name: assignment.course.name },
      startsAt: assignment.starts_at ? assignment.starts_at.toISOString() : null,
      endsAt: assignment.ends_at ? assignment.ends_at.toISOString() : null,
      endedAt: assignment.ends_at ? assignment.ends_at.toISOString() : null,
    }));
  }

  // =========================================================================
  // CREATE MENTOR ASSIGNMENTS (org-scoped)
  // =========================================================================
  async create(organizationId: string, dto: CreateMentorAssignmentDto, actorId: string) {
    // 1. Validate the course belongs to the org
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId, organization_id: organizationId },
      select: { id: true, program_id: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    // 2. Validate the mentor has the MENTOR role in this org
    const mentorRole = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: dto.mentorId, role: 'MENTOR' },
      select: { user_id: true },
    });
    if (!mentorRole) {
      throw new BadRequestException({
        code: 'INVALID_ROLE',
        message: 'The specified mentor does not have the MENTOR role in this organization',
      });
    }

    // 3. Validate each scholar has the SCHOLAR role in this org
    const scholarRoles = await this.prisma.userRole.findMany({
      where: {
        organization_id: organizationId,
        user_id: { in: dto.scholarIds },
        role: 'SCHOLAR',
      },
      select: { user_id: true },
    });
    const scholarRoleIds = new Set(scholarRoles.map((r) => r.user_id));
    const missingScholars = dto.scholarIds.filter((id) => !scholarRoleIds.has(id));
    if (missingScholars.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_ROLE',
        message: `The following scholars do not have the SCHOLAR role in this organization: ${missingScholars.join(', ')}`,
      });
    }

    // 4. Validate all are members of the course
    const allUserIds = [dto.mentorId, ...dto.scholarIds];
    const memberships = await this.prisma.courseMembership.findMany({
      where: {
        organization_id: organizationId,
        course_id: dto.courseId,
        user_id: { in: allUserIds },
      },
      select: { user_id: true },
    });
    const memberIds = new Set(memberships.map((m) => m.user_id));
    const missingMembers = allUserIds.filter((id) => !memberIds.has(id));
    if (missingMembers.length > 0) {
      throw new BadRequestException({
        code: 'COURSE_MEMBER_NOT_FOUND',
        message: 'All users must be members of the course',
      });
    }

    // 5. Check scholars don't already have an active mentor in this course
    const activePairings = await this.prisma.mentorScholarAssignment.findMany({
      where: {
        organization_id: organizationId,
        course_id: dto.courseId,
        scholar_id: { in: dto.scholarIds },
        ends_at: null,
      },
      select: { id: true, scholar_id: true },
    });
    if (activePairings.length > 0) {
      const conflictingScholarIds = activePairings.map((p) => p.scholar_id);
      throw new BadRequestException({
        code: 'SCHOLAR_ALREADY_PAIRED',
        message: `Scholar(s) already have an active mentor: ${conflictingScholarIds.join(', ')}`,
      });
    }

    // 6. Get user emails for notifications
    const users = await this.prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, email: true, name: true },
    });

    // 7. Create assignments in a transaction (one per scholar)
    const createdRows = await this.prisma.$transaction(async (tx) => {
      const created: Array<{ id: string; scholar_id: string }> = [];
      for (const scholarId of dto.scholarIds) {
        const row = await tx.mentorScholarAssignment.create({
          data: {
            organization_id: organizationId,
            mentor_id: dto.mentorId,
            scholar_id: scholarId,
            program_id: course.program_id,
            course_id: dto.courseId,
            starts_at: new Date(),
          },
          select: { id: true, scholar_id: true },
        });
        created.push(row);
      }
      return created;
    });

    // 8. Queue notifications (after the transaction)
    const mentor = users.find((u) => u.id === dto.mentorId);
    const scholarCount = dto.scholarIds.length;

    if (mentor) {
      await this.emailQueue.add({
        organizationId,
        to: mentor.email,
        subject: 'New mentor pairing',
        html: `You have been paired with ${scholarCount} scholar(s) as their mentor.`,
      });
    }

    for (const scholarId of dto.scholarIds) {
      const scholar = users.find((u) => u.id === scholarId);
      if (scholar) {
        await this.emailQueue.add({
          organizationId,
          to: scholar.email,
          subject: 'You have been assigned a mentor',
          html: 'You have been assigned a mentor for your course.',
        });
      }
    }

    // 9. Audit one entry per created assignment
    for (const row of createdRows) {
      await this.audit.log({
        organizationId,
        actorId,
        action: 'MENTOR_ASSIGNMENT_CREATED',
        entityType: 'MENTOR_ASSIGNMENT',
        entityId: row.id,
        metadata: { mentorId: dto.mentorId, scholarId: row.scholar_id, courseId: dto.courseId } as AuditMetadata,
      });
    }

    // 10. Return shaped rows
    const shaped = createdRows.map((row) => ({
      id: row.id,
      mentor: { id: dto.mentorId, name: mentor?.name ?? null, email: mentor?.email ?? null },
      scholar: {
        id: row.scholar_id,
        name: users.find((u) => u.id === row.scholar_id)?.name ?? null,
        email: users.find((u) => u.id === row.scholar_id)?.email ?? null,
      },
      course: { id: dto.courseId, name: null },
      startsAt: new Date().toISOString(),
      endsAt: null,
      endedAt: null,
    }));

    return {
      assignments: shaped,
      pairedCount: scholarCount,
    };
  }

  // =========================================================================
  // REASSIGN MENTOR (org-scoped)
  // =========================================================================
  async reassign(organizationId: string, id: string, dto: ReassignMentorAssignmentDto, actorId: string) {
    // 1. Find the existing org-scoped assignment
    const assignment = await this.prisma.mentorScholarAssignment.findUnique({
      where: { id, organization_id: organizationId },
      include: {
        mentor: { select: { id: true, email: true } },
        scholar: { select: { id: true, email: true } },
        course: { select: { id: true, name: true, program_id: true } },
      },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    // 2. Validate newMentorId has MENTOR role in org
    const mentorRole = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: dto.newMentorId, role: 'MENTOR' },
      select: { user_id: true },
    });
    if (!mentorRole) {
      throw new BadRequestException({
        code: 'INVALID_ROLE',
        message: 'The specified mentor does not have the MENTOR role in this organization',
      });
    }

    // 3. Validate newMentorId is a member of the course
    const membership = await this.prisma.courseMembership.findFirst({
      where: {
        organization_id: organizationId,
        course_id: assignment.course_id,
        user_id: dto.newMentorId,
      },
      select: { user_id: true },
    });
    if (!membership) {
      throw new BadRequestException({
        code: 'COURSE_MEMBER_NOT_FOUND',
        message: 'All users must be members of the course',
      });
    }

    const newMentorUser = await this.prisma.user.findUnique({
      where: { id: dto.newMentorId },
      select: { id: true, email: true, name: true },
    });

    // 4. Transaction: end current + create new assignment
    const newAssignment = await this.prisma.$transaction(async (tx) => {
      await tx.mentorScholarAssignment.update({
        where: { id },
        data: { ends_at: new Date() },
      });

      return tx.mentorScholarAssignment.create({
        data: {
          organization_id: organizationId,
          mentor_id: dto.newMentorId,
          scholar_id: assignment.scholar_id,
          program_id: assignment.course.program_id,
          course_id: assignment.course_id,
          starts_at: new Date(),
        },
        select: { id: true },
      });
    });

    // 5. Queue notifications (after the transaction)
    if (assignment.mentor?.email) {
      await this.emailQueue.add({
        organizationId,
        to: assignment.mentor.email,
        subject: 'Mentor pairing ended',
        html: 'Your mentor pairing has ended. Thank you for your service.',
      });
    }

    if (newMentorUser?.email) {
      await this.emailQueue.add({
        organizationId,
        to: newMentorUser.email,
        subject: 'New mentor pairing',
        html: 'You have been assigned as a mentor for a scholar.',
      });
    }

    if (assignment.scholar?.email) {
      await this.emailQueue.add({
        organizationId,
        to: assignment.scholar.email,
        subject: 'You have been assigned a new mentor',
        html: 'You have been assigned a new mentor for your course.',
      });
    }

    // 6. Audit MENTOR_ASSIGNMENT_REASSIGNED for the NEW assignment id
    await this.audit.log({
      organizationId,
      actorId,
      action: 'MENTOR_ASSIGNMENT_REASSIGNED',
      entityType: 'MENTOR_ASSIGNMENT',
      entityId: newAssignment.id,
      metadata: {
        oldMentorId: assignment.mentor_id,
        newMentorId: dto.newMentorId,
        scholarId: assignment.scholar_id,
        reason: dto.reason ?? null,
      } as AuditMetadata,
    });

    // 7. Return shaped new assignment
    return {
      id: newAssignment.id,
      mentor: { id: dto.newMentorId, name: newMentorUser?.name ?? null, email: newMentorUser?.email ?? null },
      scholar: { id: assignment.scholar_id, email: assignment.scholar?.email ?? null },
      course: { id: assignment.course.id, name: assignment.course.name },
      startsAt: new Date().toISOString(),
      endsAt: null,
      endedAt: null,
    };
  }

  // =========================================================================
  // END ASSIGNMENT (soft end, org-scoped)
  // =========================================================================
  async endAssignment(organizationId: string, id: string, actorId: string) {
    const assignment = await this.prisma.mentorScholarAssignment.findUnique({
      where: { id, organization_id: organizationId },
      include: {
        mentor: { select: { id: true, email: true } },
        scholar: { select: { id: true, email: true } },
      },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    // Idempotent: if already ended, just return the confirmation
    if (!assignment.ends_at) {
      await this.prisma.mentorScholarAssignment.update({
        where: { id },
        data: { ends_at: new Date() },
      });

      // Queue notifications
      if (assignment.mentor?.email) {
        await this.emailQueue.add({
          organizationId,
          to: assignment.mentor.email,
          subject: 'Mentor pairing ended',
          html: 'Your mentor pairing has ended. Thank you for your service.',
        });
      }

      if (assignment.scholar?.email) {
        await this.emailQueue.add({
          organizationId,
          to: assignment.scholar.email,
          subject: 'Mentor pairing ended',
          html: 'Your mentor pairing has ended.',
        });
      }

      await this.audit.log({
        organizationId,
        actorId,
        action: 'MENTOR_ASSIGNMENT_ENDED',
        entityType: 'MENTOR_ASSIGNMENT',
        entityId: id,
        metadata: { mentorId: assignment.mentor_id, scholarId: assignment.scholar_id } as AuditMetadata,
      });
    }

    return {
      id,
      endedAt: new Date().toISOString(),
      message: 'Mentor pairing ended. Historical data is preserved.',
    };
  }
}
