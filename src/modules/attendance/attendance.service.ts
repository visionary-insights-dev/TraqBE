import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { AttendanceStatus } from '@prisma/client';
import type { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MeetingsService } from '../meetings/meetings.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../../jobs/queues/email.queue.js';
import { ANALYTICS_QUEUE } from '../../jobs/queues/analytics.queue.js';
import type { AnalyticsRefreshJobData } from '../../jobs/processors/analytics-refresh.processor.js';
import type { RecordAttendanceDto } from './dto/record-attendance.dto.js';
import type { CorrectAttendanceDto } from './dto/correct-attendance.dto.js';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly meetingsService: MeetingsService,
    private readonly analyticsService: AnalyticsService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
    @InjectQueue(ANALYTICS_QUEUE) private readonly analyticsQueue: Queue<AnalyticsRefreshJobData>,
  ) {}

  // =========================================================================
  // BULK RECORD ATTENDANCE (upsert, allow re-recording)
  // =========================================================================
  async recordBulk(organizationId: string, meetingId: string, dto: RecordAttendanceDto, actorId: string) {
    // 1. Validate meeting is org-scoped (throws MEETING_NOT_FOUND if not)
    const meeting = await this.meetingsService.getMeeting(organizationId, meetingId);

    // 2. Validate all scholars are members of the meeting's course
    const scholarIds = dto.records.map((r) => r.scholarId);
    const memberships = await this.prisma.courseMembership.findMany({
      where: {
        organization_id: organizationId,
        course_id: meeting.course_id,
        user_id: { in: scholarIds },
      },
      select: { user_id: true },
    });
    const enrolledIds = new Set(memberships.map((m) => m.user_id));
    const notEnrolled = scholarIds.filter((id) => !enrolledIds.has(id));
    if (notEnrolled.length > 0) {
      throw new ForbiddenException({
        code: 'SCHOLAR_NOT_ENROLLED',
        message: `Scholars not enrolled in this course: ${notEnrolled.join(', ')}`,
      });
    }

    // 3. Fetch scholar emails for absent notifications
    const scholars = await this.prisma.user.findMany({
      where: { id: { in: scholarIds } },
      select: { id: true, email: true },
    });
    const emailById = new Map(scholars.map((s) => [s.id, s.email]));

    const results: Array<{
      scholarId: string;
      status: AttendanceStatus;
      isNew: boolean;
    }> = [];

    // 4. Upsert each record
    for (const record of dto.records) {
      const existing = await this.prisma.attendanceRecord.findUnique({
        where: {
          meeting_id_scholar_id: {
            meeting_id: meetingId,
            scholar_id: record.scholarId,
          },
        },
      });

      const isNew = !existing || existing.status !== record.status;

      await this.prisma.attendanceRecord.upsert({
        where: {
          meeting_id_scholar_id: {
            meeting_id: meetingId,
            scholar_id: record.scholarId,
          },
        },
        create: {
          organization_id: organizationId,
          meeting_id: meetingId,
          scholar_id: record.scholarId,
          status: record.status,
          recorded_by: actorId,
        },
        update: {
          status: record.status,
          recorded_by: actorId,
        },
      });

      // 5. Audit each change
      if (isNew) {
        await this.audit.log({
          organizationId,
          actorId,
          action: existing ? 'ATTENDANCE_RECORDED' : 'ATTENDANCE_RECORDED',
          entityType: 'ATTENDANCE_RECORD',
          entityId: existing?.id ?? `${meetingId}:${record.scholarId}`,
          metadata: {
            meetingId,
            scholarId: record.scholarId,
            status: record.status,
            previousStatus: existing?.status ?? null,
          } as Record<string, string | null>,
        });
      }

      // 6. Queue analytics refresh per affected scholar
      if (isNew) {
        await this.analyticsQueue.add(
          'refresh',
          { organizationId, entity: 'scholar', entityId: record.scholarId },
          { jobId: `analytics-scholar-${organizationId}-${record.scholarId}` },
        );
      }

      // 7. Notify scholars marked ABSENT
      if (record.status === AttendanceStatus.ABSENT && isNew) {
        // In-app notification
        await this.prisma.$transaction(async (tx) => {
          const notification = await tx.notification.create({
            data: {
              organization_id: organizationId,
              title: 'Attendance marked absent',
              body: `You have been marked absent for a meeting on ${meeting.starts_at.toISOString().split('T')[0]}.`,
              type: 'attendance_absent',
              metadata: {
                meetingId,
                scholarId: record.scholarId,
              },
            },
          });

          await tx.notificationDelivery.create({
            data: {
              notification_id: notification.id,
              user_id: record.scholarId,
              channel: 'IN_APP',
              status: 'PENDING',
            },
          });
        });

        // Queue email
        const email = emailById.get(record.scholarId);
        if (email) {
          await this.emailQueue.add({
            organizationId,
            to: email,
            subject: 'Attendance marked absent',
            html: `You have been marked absent for a meeting. Please contact your mentor if this is an error.`,
          });
        }
      }

      results.push({
        scholarId: record.scholarId,
        status: record.status,
        isNew,
      });
    }

    return {
      meetingId,
      records: results,
    };
  }

  // =========================================================================
  // CORRECT ATTENDANCE (SUPER_ADMIN only)
  // =========================================================================
  async correct(
    organizationId: string,
    meetingId: string,
    scholarId: string,
    dto: CorrectAttendanceDto,
    actorId: string,
  ) {
    // Validate meeting is org-scoped
    await this.meetingsService.getMeeting(organizationId, meetingId);

    const record = await this.prisma.attendanceRecord.findUnique({
      where: {
        meeting_id_scholar_id: { meeting_id: meetingId, scholar_id: scholarId },
      },
    });
    if (!record) {
      throw new NotFoundException({
        code: 'ATTENDANCE_RECORD_NOT_FOUND',
        message: 'Attendance record not found for this scholar in this meeting',
      });
    }

    if (record.organization_id !== organizationId) {
      throw new NotFoundException({
        code: 'ATTENDANCE_RECORD_NOT_FOUND',
        message: 'Attendance record not found',
      });
    }

    const previousStatus = record.status;

    await this.prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { status: dto.status, recorded_by: actorId },
    });

    // Audit with before/after snapshot
    await this.audit.log({
      organizationId,
      actorId,
      action: 'ATTENDANCE_CORRECTED',
      entityType: 'ATTENDANCE_RECORD',
      entityId: record.id,
      metadata: {
        meetingId,
        scholarId,
        from: previousStatus,
        to: dto.status,
        reason: dto.correctionReason,
      } as Record<string, string>,
    });

    // Queue analytics refresh
    await this.analyticsQueue.add(
      'refresh',
      { organizationId, entity: 'scholar', entityId: scholarId },
      { jobId: `analytics-scholar-${organizationId}-${scholarId}` },
    );

    return {
      id: record.id,
      previousStatus,
      status: dto.status,
      correctionReason: dto.correctionReason,
    };
  }

  // =========================================================================
  // ATTENDANCE HISTORY (corrections for a meeting)
  // =========================================================================
  async history(organizationId: string, meetingId: string) {
    // Validate meeting is org-scoped
    await this.meetingsService.getMeeting(organizationId, meetingId);

    const corrections = await this.prisma.auditLog.findMany({
      where: {
        organization_id: organizationId,
        action: 'ATTENDANCE_CORRECTED',
        entity_type: 'ATTENDANCE_RECORD',
        metadata: { path: ['meetingId'], equals: meetingId },
      },
      include: { actor: { select: { id: true, name: true, email: true } } },
      orderBy: { created_at: 'desc' },
    });

    const data = corrections.map((c) => {
      const meta = (c.metadata ?? {}) as Record<string, string>;
      return {
        id: c.id,
        attendanceRecordId: c.entity_id,
        actor: c.actor,
        timestamp: c.created_at.toISOString(),
        before: meta.from ?? null,
        after: meta.to ?? null,
        reason: meta.reason ?? null,
      };
    });

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
}
