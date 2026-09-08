import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { EmailDispatchJobData, EMAIL_QUEUE } from '../../jobs/queues/email.queue.js';
import { ASSIGNMENTS_QUEUE } from '../../jobs/queues/assignments.queue.js';
import { ANALYTICS_QUEUE } from '../../jobs/queues/analytics.queue.js';
import type { AssignmentReminderJobData } from '../../jobs/processors/assignment-reminder.processor.js';
import type { AnalyticsRefreshJobData } from '../../jobs/processors/analytics-refresh.processor.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { CreateAssignmentDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { VerifySubmissionDto } from './dto/verify-submission.dto.js';
import { CreateChangeRequestDto } from './dto/create-change-request.dto.js';
import { ReviewChangeRequestDto } from './dto/review-change-request.dto.js';

type AuditMetadata = Record<string, string | number | boolean | null>;

type AssignmentForShape = Prisma.AssignmentGetPayload<{
  include: {
    course: { select: { id: true; name: true } };
    creator: { select: { id: true; name: true } };
  };
}>;

type ScholarSubmissionWithScholar = Prisma.ScholarAssignmentGetPayload<{
  include: { scholar: { select: { id: true; name: true; email: true } } };
}>;

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly organizationsService: OrganizationsService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
    @InjectQueue(ASSIGNMENTS_QUEUE) private readonly assignmentsQueue: Queue<AssignmentReminderJobData>,
    @InjectQueue(ANALYTICS_QUEUE) private readonly analyticsQueue: Queue<AnalyticsRefreshJobData>,
  ) {}

  // =========================================================================
  // LIST ASSIGNMENTS (org-scoped, role-filtered)
  // =========================================================================
  async list(organizationId: string, user: AuthUser) {
    const where: Prisma.AssignmentWhereInput = {
      organization_id: organizationId,
    };

    const roles = user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      if (roles.includes('MENTOR')) {
        // Mentors only see assignments they created
        where.OR = [{ created_by: user.id }];
      } else if (roles.includes('SCHOLAR')) {
        // Scholars only see assignments they are enrolled in
        where.scholar_assignments = { some: { scholar_id: user.id } };
      }
    }

    const assignments = await this.prisma.assignment.findMany({
      where,
      include: {
        course: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const data = assignments.map((assignment) => this.shapeAssignment(assignment));

    return {
      data,
      meta: {
        total: data.length,
        totalPages: data.length > 0 ? 1 : 0,
        page: 1,
        limit: data.length,
      },
    };
  }

  // =========================================================================
  // CREATE ASSIGNMENT (draft, org-scoped)
  // =========================================================================
  async create(organizationId: string, dto: CreateAssignmentDto, actorId: string) {
    // 1. Validate the course belongs to the org
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId, organization_id: organizationId },
      select: { id: true, program_id: true },
    });
    if (!course) {
      throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
    }

    // 2. Create the draft
    const assignment = await this.prisma.assignment.create({
      data: {
        organization_id: organizationId,
        course_id: dto.courseId,
        program_id: course.program_id,
        created_by: actorId,
        title: dto.title,
        description: dto.description ?? null,
        due_at: new Date(dto.dueAt),
        max_score: dto.maxScore ?? 100,
        status: 'DRAFT',
      },
      include: {
        course: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'ASSIGNMENT_CREATED',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      metadata: { courseId: dto.courseId, title: assignment.title } as AuditMetadata,
    });

    return this.shapeAssignment(assignment);
  }

  // =========================================================================
  // GET ASSIGNMENT (org-scoped, role-filtered)
  // =========================================================================
  async findOne(organizationId: string, id: string, user: AuthUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      include: {
        course: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        scholar_assignments: {
          include: { scholar: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    const roles = user.roles ?? [];
    if (roles.includes('SCHOLAR')) {
      // Scholars only ever see their own submission
      const submission =
        assignment.scholar_assignments.find((sa) => sa.scholar_id === user.id) ?? null;
      return {
        assignment: {
          id: assignment.id,
          title: assignment.title,
          description: assignment.description,
          dueAt: assignment.due_at ? assignment.due_at.toISOString() : null,
          maxScore: assignment.max_score,
        },
        submission: submission ? this.shapeScholarSubmission(submission) : null,
      };
    }

    const submissions = assignment.scholar_assignments;
    const stats = {
      total: submissions.length,
      submitted: submissions.filter((sa) =>
        ['PENDING_VERIFICATION', 'VERIFIED', 'VERIFIED_LATE'].includes(sa.status),
      ).length,
      verified: submissions.filter((sa) => ['VERIFIED', 'VERIFIED_LATE'].includes(sa.status)).length,
      pending: submissions.filter((sa) => sa.status === 'PENDING_VERIFICATION').length,
      overdue: submissions.filter((sa) => sa.status === 'OVERDUE').length,
      resubmissionRequired: submissions.filter((sa) => sa.status === 'RESUBMISSION_REQUIRED').length,
    };

    return {
      ...this.shapeAssignment(assignment),
      submissions: submissions.map((sa) => this.shapeScholarSubmission(sa)),
      stats,
    };
  }

  // =========================================================================
  // UPDATE ASSIGNMENT (draft or within publish edit window)
  // =========================================================================
  async update(organizationId: string, id: string, dto: UpdateAssignmentDto, actorId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, status: true, edit_window_expires_at: true },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    // Edit-window gate: published assignments are only editable within the window
    if (
      assignment.status === 'PUBLISHED' &&
      (!assignment.edit_window_expires_at || new Date() >= assignment.edit_window_expires_at)
    ) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_EDIT_WINDOW_EXPIRED',
        message: 'Assignment is no longer editable; request a change instead',
      });
    }

    if (!['DRAFT', 'PUBLISHED'].includes(assignment.status)) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_NOT_EDITABLE',
        message: 'Assignment is not editable',
      });
    }

    const data: Prisma.AssignmentUpdateInput = {};
    const changed: Record<string, string | number | boolean | null> = {};

    if (dto.title !== undefined) {
      data.title = dto.title;
      changed.title = dto.title;
    }
    if (dto.description !== undefined) {
      data.description = dto.description;
      changed.description = dto.description;
    }
    if (dto.courseId !== undefined) {
      const course = await this.prisma.course.findUnique({
        where: { id: dto.courseId, organization_id: organizationId },
        select: { id: true, program_id: true },
      });
      if (!course) {
        throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' });
      }
      data.course = { connect: { id: dto.courseId } };
      data.program = { connect: { id: course.program_id } };
      changed.courseId = dto.courseId;
    }
    if (dto.dueAt !== undefined) {
      data.due_at = new Date(dto.dueAt);
      changed.dueAt = dto.dueAt;
    }
    if (dto.maxScore !== undefined) {
      data.max_score = dto.maxScore;
      changed.maxScore = dto.maxScore;
    }

    const updated = await this.prisma.assignment.update({
      where: { id },
      data,
      include: {
        course: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'ASSIGNMENT_UPDATED',
      entityType: 'ASSIGNMENT',
      entityId: id,
      metadata: changed,
    });

    return this.shapeAssignment(updated);
  }

  // =========================================================================
  // PUBLISH ASSIGNMENT (creates scholar submissions + queues reminders)
  // =========================================================================
  async publish(organizationId: string, id: string, actorId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      include: { course: { select: { id: true, name: true } } },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }
    if (assignment.status !== 'DRAFT') {
      throw new BadRequestException({
        code: 'ASSIGNMENT_NOT_DRAFT',
        message: 'Only draft assignments can be published',
      });
    }
    if (!assignment.due_at) {
      throw new BadRequestException({
        code: 'DUE_AT_REQUIRED',
        message: 'An assignment must have a due date before publishing',
      });
    }

    const settings = await this.organizationsService.getSettings(organizationId);
    const editWindowMinutes = settings.assignmentEditWindowMinutes;

    const memberships = await this.prisma.courseMembership.findMany({
      where: { organization_id: organizationId, course_id: assignment.course_id },
      select: { user_id: true },
    });
    const memberUserIds = memberships.map((m) => m.user_id);

    // Get member emails for notifications (only when there are members)
    const members =
      memberUserIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: memberUserIds } },
            select: { id: true, email: true },
          })
        : [];

    const published = await this.prisma.$transaction(async (tx) => {
      const updatedAssignment = await tx.assignment.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          published_at: new Date(),
          edit_window_expires_at: new Date(Date.now() + editWindowMinutes * 60_000),
        },
        include: {
          course: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
        },
      });

      if (memberUserIds.length > 0) {
        await tx.scholarAssignment.createMany({
          data: memberUserIds.map((scholarId) => ({
            organization_id: organizationId,
            assignment_id: id,
            scholar_id: scholarId,
            status: 'NOT_STARTED',
          })),
          skipDuplicates: true,
        });
      }

      return updatedAssignment;
    });

    // AFTER the transaction: queue reminders + emails
    const dueAtMs = assignment.due_at.getTime();
    const nowMs = Date.now();
    for (const member of members) {
      const reminder24hDelay = Math.max(0, dueAtMs - 24 * 60 * 60 * 1000 - nowMs);
      const reminder1hDelay = Math.max(0, dueAtMs - 60 * 60 * 1000 - nowMs);

      await this.assignmentsQueue.add(
        'reminder',
        { assignmentId: id, scholarId: member.id, organizationId, type: '24h' },
        { delay: reminder24hDelay, jobId: `assignment-reminder-24h-${id}-${member.id}` },
      );
      await this.assignmentsQueue.add(
        'reminder',
        { assignmentId: id, scholarId: member.id, organizationId, type: '1h' },
        { delay: reminder1hDelay, jobId: `assignment-reminder-1h-${id}-${member.id}` },
      );

      await this.emailQueue.add({
        organizationId,
        to: member.email,
        subject: 'New assignment published',
        html: `A new assignment "${assignment.title}" has been published for your course. It is due on ${assignment.due_at.toISOString()}.`,
      });
    }

    await this.audit.log({
      organizationId,
      actorId,
      action: 'ASSIGNMENT_PUBLISHED',
      entityType: 'ASSIGNMENT',
      entityId: id,
      metadata: {
        courseId: assignment.course_id,
        dueAt: assignment.due_at.toISOString(),
        scholarCount: memberUserIds.length,
        editWindowMinutes,
      } as AuditMetadata,
    });

    return this.shapeAssignment(published);
  }

  // =========================================================================
  // SUBMIT ASSIGNMENT (scholar marks done; server time decides lateness)
  // =========================================================================
  async submit(organizationId: string, id: string, user: AuthUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, course_id: true, title: true, due_at: true, status: true },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    const scholarAssignment = await this.prisma.scholarAssignment.findUnique({
      where: {
        assignment_id_scholar_id: { assignment_id: id, scholar_id: user.id },
      },
    });
    if (!scholarAssignment) {
      throw new NotFoundException({ code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found' });
    }

    const now = new Date();
    const late = !!(assignment.due_at && now > assignment.due_at);

    const updated = await this.prisma.scholarAssignment.update({
      where: { id: scholarAssignment.id },
      data: {
        status: 'PENDING_VERIFICATION',
        marked_done_at: now,
        is_late: late,
      },
    });

    // Notify the paired mentor (if any) so they can verify
    const pairing = await this.prisma.mentorScholarAssignment.findFirst({
      where: {
        organization_id: organizationId,
        course_id: assignment.course_id,
        scholar_id: user.id,
        ends_at: null,
      },
      include: { mentor: { select: { id: true, email: true } } },
    });
    if (pairing?.mentor?.email) {
      await this.emailQueue.add({
        organizationId,
        to: pairing.mentor.email,
        subject: 'Assignment submitted for verification',
        html: `A scholar has submitted the assignment "${assignment.title}" and it is ready for verification.`,
      });
    }

    await this.audit.log({
      organizationId,
      actorId: user.id,
      action: 'ASSIGNMENT_SUBMITTED',
      entityType: 'SCHOLAR_ASSIGNMENT',
      entityId: updated.id,
      metadata: { assignmentId: id, isLate: late } as AuditMetadata,
    });

    return {
      id: updated.id,
      status: 'PENDING_VERIFICATION',
      markedDoneAt: now.toISOString(),
      isLate: late,
    };
  }

  // =========================================================================
  // VERIFY SUBMISSION (mentor/admin verifies or requests resubmission)
  // =========================================================================
  async verify(organizationId: string, id: string, dto: VerifySubmissionDto, user: AuthUser) {
    // A scholar (or a SUPER_ADMIN who is also enrolled) cannot verify themselves
    if (user.id === dto.scholarId) {
      throw new ForbiddenException({
        code: 'CANNOT_VERIFY_SELF',
        message: 'Scholars cannot verify their own assignment',
      });
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, title: true, due_at: true, status: true },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    const scholarAssignment = await this.prisma.scholarAssignment.findUnique({
      where: {
        assignment_id_scholar_id: { assignment_id: id, scholar_id: dto.scholarId },
      },
      include: { scholar: { select: { id: true, email: true, name: true } } },
    });
    if (!scholarAssignment) {
      throw new NotFoundException({ code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found' });
    }

    const now = new Date();

    if (dto.action === 'VERIFY') {
      const settings = await this.organizationsService.getSettings(organizationId);
      const penalty = settings.lateSubmissionPenaltyPercentage;
      const earnedCredit = scholarAssignment.is_late ? Math.max(0, 100 - penalty) : 100;
      const status: 'VERIFIED_LATE' | 'VERIFIED' = scholarAssignment.is_late
        ? 'VERIFIED_LATE'
        : 'VERIFIED';

      const updated = await this.prisma.scholarAssignment.update({
        where: { id: scholarAssignment.id },
        data: {
          status,
          verified_at: now,
          verified_by: user.id,
          earned_credit: earnedCredit,
        },
      });

      await this.analyticsQueue.add(
        'refresh',
        { organizationId, entity: 'scholar', entityId: dto.scholarId },
        { jobId: `analytics-scholar-${organizationId}-${dto.scholarId}` },
      );

      await this.audit.log({
        organizationId,
        actorId: user.id,
        action: 'ASSIGNMENT_VERIFIED',
        entityType: 'SCHOLAR_ASSIGNMENT',
        entityId: updated.id,
        metadata: {
          assignmentId: id,
          scholarId: dto.scholarId,
          earnedCredit,
          isLate: scholarAssignment.is_late ?? false,
        } as AuditMetadata,
      });

      return {
        id: updated.id,
        status,
        verifiedAt: now.toISOString(),
        earnedCredit,
      };
    }

    // REQUEST_RESUBMISSION
    const updated = await this.prisma.scholarAssignment.update({
      where: { id: scholarAssignment.id },
      data: { status: 'RESUBMISSION_REQUIRED' },
    });

    if (scholarAssignment.scholar?.email) {
      await this.emailQueue.add({
        organizationId,
        to: scholarAssignment.scholar.email,
        subject: 'Assignment needs revision',
        html: `Your assignment "${assignment.title}" needs revision. ${dto.feedback ?? 'Please revise and resubmit'}`,
      });
    }

    await this.audit.log({
      organizationId,
      actorId: user.id,
      action: 'ASSIGNMENT_RESUBMISSION_REQUESTED',
      entityType: 'SCHOLAR_ASSIGNMENT',
      entityId: updated.id,
      metadata: { assignmentId: id, scholarId: dto.scholarId } as AuditMetadata,
    });

    return {
      id: updated.id,
      status: 'RESUBMISSION_REQUIRED',
    };
  }

  // =========================================================================
  // CREATE CHANGE REQUEST (only after the edit window has passed)
  // =========================================================================
  async createChangeRequest(organizationId: string, id: string, dto: CreateChangeRequestDto, actorId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id, organization_id: organizationId },
      select: { id: true, status: true, edit_window_expires_at: true },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    if (!assignment.edit_window_expires_at || new Date() < assignment.edit_window_expires_at) {
      throw new BadRequestException({
        code: 'EDIT_WINDOW_NOT_EXPIRED',
        message: 'Assignment is still within its edit window; use PATCH instead',
      });
    }

    const changeRequest = await this.prisma.assignmentChangeRequest.create({
      data: {
        organization_id: organizationId,
        assignment_id: id,
        field: dto.field,
        current_value: this.toJsonValue(dto.currentValue),
        requested_value: this.toJsonValue(dto.requestedValue),
        reason: dto.reason,
        status: 'PENDING',
      },
    });

    // Notify all org SUPER_ADMINs about the pending request
    const admins = await this.prisma.userRole.findMany({
      where: { organization_id: organizationId, role: 'SUPER_ADMIN' },
      include: { user: { select: { id: true, email: true } } },
    });
    for (const admin of admins) {
      if (admin.user?.email) {
        await this.emailQueue.add({
          organizationId,
          to: admin.user.email,
          subject: 'Assignment change request',
          html: `A change request has been submitted for assignment "${id}" (field: ${dto.field}). Reason: ${dto.reason}`,
        });
      }
    }

    await this.audit.log({
      organizationId,
      actorId,
      action: 'ASSIGNMENT_CHANGE_REQUESTED',
      entityType: 'ASSIGNMENT_CHANGE_REQUEST',
      entityId: changeRequest.id,
      metadata: { assignmentId: id, field: dto.field, reason: dto.reason } as AuditMetadata,
    });

    return this.shapeChangeRequest(changeRequest);
  }

  // =========================================================================
  // REVIEW CHANGE REQUEST (approve applies the change; reject denies it)
  // =========================================================================
  async reviewChangeRequest(
    organizationId: string,
    assignmentId: string,
    changeRequestId: string,
    dto: ReviewChangeRequestDto,
    actorId: string,
  ) {
    const changeRequest = await this.prisma.assignmentChangeRequest.findFirst({
      where: { id: changeRequestId, assignment_id: assignmentId, organization_id: organizationId },
    });
    if (!changeRequest) {
      throw new NotFoundException({ code: 'CHANGE_REQUEST_NOT_FOUND', message: 'Change request not found' });
    }

    if (changeRequest.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'CHANGE_REQUEST_ALREADY_REVIEWED',
        message: 'Change request has already been reviewed',
      });
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId, organization_id: organizationId },
      select: { id: true, created_by: true },
    });
    if (!assignment) {
      throw new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    }

    if (dto.action === 'APPROVE') {
      const fieldMap = this.mapChangeRequestField(changeRequest.field, changeRequest.requested_value);

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.assignment.update({
          where: { id: assignmentId },
          data: fieldMap,
        });
        return tx.assignmentChangeRequest.update({
          where: { id: changeRequestId },
          data: {
            status: 'APPROVED',
            reviewed_by: actorId,
            admin_note: dto.adminNote ?? null,
          },
        });
      });

      const creator = assignment.created_by
        ? await this.prisma.user.findUnique({
            where: { id: assignment.created_by },
            select: { email: true },
          })
        : null;
      if (creator?.email) {
        await this.emailQueue.add({
          organizationId,
          to: creator.email,
          subject: 'Change request approved',
          html: `Your change request for assignment "${assignmentId}" has been approved.`,
        });
      }

      await this.audit.log({
        organizationId,
        actorId,
        action: 'ASSIGNMENT_CHANGE_APPROVED',
        entityType: 'ASSIGNMENT_CHANGE_REQUEST',
        entityId: changeRequestId,
        metadata: { assignmentId, field: changeRequest.field } as AuditMetadata,
      });

      return this.shapeChangeRequest(updated);
    }

    // REJECT
    const updated = await this.prisma.assignmentChangeRequest.update({
      where: { id: changeRequestId },
      data: {
        status: 'REJECTED',
        reviewed_by: actorId,
        admin_note: dto.adminNote ?? null,
      },
    });

    const creator = assignment.created_by
      ? await this.prisma.user.findUnique({
          where: { id: assignment.created_by },
          select: { email: true },
        })
      : null;
    if (creator?.email) {
      await this.emailQueue.add({
        organizationId,
        to: creator.email,
        subject: 'Change request rejected',
        html: `Your change request for assignment "${assignmentId}" was rejected.`,
      });
    }

    await this.audit.log({
      organizationId,
      actorId,
      action: 'ASSIGNMENT_CHANGE_REJECTED',
      entityType: 'ASSIGNMENT_CHANGE_REQUEST',
      entityId: changeRequestId,
      metadata: { assignmentId, field: changeRequest.field } as AuditMetadata,
    });

    return this.shapeChangeRequest(updated);
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /** Coerce an unknown JSON payload into a Prisma InputJsonValue (or DB null). */
  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return (value ?? Prisma.DbNull) as Prisma.InputJsonValue;
  }

  /** Map an approved change-request field into an assignment update input. */
  private mapChangeRequestField(field: string, requestedValue: Prisma.JsonValue | null): Prisma.AssignmentUpdateInput {
    switch (field) {
      case 'title': {
        const value = this.stringifyChangeValue(requestedValue, field);
        if (!value) {
          throw new BadRequestException({ code: 'INVALID_CHANGE_VALUE', message: 'title cannot be empty' });
        }
        return { title: value };
      }
      case 'description': {
        const value = this.stringifyChangeValue(requestedValue, field);
        return { description: value };
      }
      case 'dueAt': {
        const raw = requestedValue === null || requestedValue === undefined ? '' : String(requestedValue);
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw new BadRequestException({ code: 'INVALID_CHANGE_VALUE', message: 'dueAt must be a valid ISO date string' });
        }
        return { due_at: date };
      }
      case 'maxScore': {
        const parsed = requestedValue === null || requestedValue === undefined ? Number.NaN : Number(requestedValue);
        if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          throw new BadRequestException({ code: 'INVALID_CHANGE_VALUE', message: 'maxScore must be an integer between 1 and 1000' });
        }
        return { max_score: parsed };
      }
      default:
        throw new BadRequestException({ code: 'INVALID_CHANGE_FIELD', message: `Unsupported field "${field}"` });
    }
  }

  private stringifyChangeValue(value: Prisma.JsonValue | null, field: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    throw new BadRequestException({ code: 'INVALID_CHANGE_VALUE', message: `${field} must be a plain value` });
  }

  private shapeAssignment(assignment: AssignmentForShape) {
    return {
      id: assignment.id,
      title: assignment.title,
      description: assignment.description,
      status: assignment.status,
      dueAt: assignment.due_at ? assignment.due_at.toISOString() : null,
      maxScore: assignment.max_score,
      course: { id: assignment.course.id, name: assignment.course.name },
      createdBy: assignment.creator
        ? { id: assignment.creator.id, name: assignment.creator.name }
        : null,
      createdAt: assignment.created_at.toISOString(),
      updatedAt: assignment.updated_at.toISOString(),
    };
  }

  private shapeScholarSubmission(submission: ScholarSubmissionWithScholar) {
    return {
      id: submission.id,
      status: submission.status,
      score: submission.score,
      isLate: submission.is_late ?? null,
      earnedCredit: submission.earned_credit ?? null,
      markedDoneAt: submission.marked_done_at ? submission.marked_done_at.toISOString() : null,
      verifiedAt: submission.verified_at ? submission.verified_at.toISOString() : null,
      scholar: {
        id: submission.scholar.id,
        name: submission.scholar.name,
        email: submission.scholar.email,
      },
    };
  }

  private shapeChangeRequest(changeRequest: {
    id: string;
    assignment_id: string;
    field: string;
    status: string;
    reason: string;
    admin_note: string | null;
    current_value: Prisma.JsonValue | null;
    requested_value: Prisma.JsonValue | null;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      id: changeRequest.id,
      assignmentId: changeRequest.assignment_id,
      field: changeRequest.field,
      status: changeRequest.status,
      reason: changeRequest.reason,
      currentValue: changeRequest.current_value ?? null,
      requestedValue: changeRequest.requested_value ?? null,
      adminNote: changeRequest.admin_note,
      createdAt: changeRequest.created_at.toISOString(),
      updatedAt: changeRequest.updated_at.toISOString(),
    };
  }
}