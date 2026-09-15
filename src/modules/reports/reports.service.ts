import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import {
  AttendanceStatus,
  Prisma,
  ScholarAssignmentStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { R2Service } from '../resources/r2.service.js';
import { REPORTS_QUEUE } from '../../jobs/queues/reports.queue.js';
import type { ReportGeneratorJobData } from '../../jobs/processors/report-generator.processor.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import type { CreateReportDto } from './dto/create-report.dto.js';

export const SUPPORTED_REPORT_TYPES = ['scholars', 'attendance', 'assignments', 'meetings'];

const SYNC_REPORT_LIMIT = 1000;

interface ReportFilters {
  courseId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly r2Service: R2Service,
    @InjectQueue(REPORTS_QUEUE) private readonly reportsQueue: Queue<ReportGeneratorJobData>,
  ) {}

  // =========================================================================
  // CREATE REPORT
  // =========================================================================
  /**
   * Synchronous for datasets under 1000 rows (returns rows + meta.generated).
   * Larger datasets are persisted as a PENDING ReportExport and queued for the
   * report-generator processor (returns { id, status: 'PENDING' }).
   */
  async create(organizationId: string, dto: CreateReportDto, user: AuthUser) {
    if (!SUPPORTED_REPORT_TYPES.includes(dto.type)) {
      throw new BadRequestException({
        code: 'REPORT_TYPE_UNSUPPORTED',
        message: `Report type "${dto.type}" is not supported`,
      });
    }

    if (dto.format !== 'csv') {
      throw new BadRequestException({
        code: 'REPORT_FORMAT_UNSUPPORTED',
        message: 'Only CSV reports are supported',
      });
    }

    const filters = this.extractFilters(dto.filters);
    const count = await this.countReportRows(organizationId, dto.type, filters);

    if (count < SYNC_REPORT_LIMIT) {
      const data = await this.fetchReportRows(organizationId, dto.type, filters, SYNC_REPORT_LIMIT);
      return {
        data,
        meta: { count, generated: true },
      };
    }

    // Async path — persist the export and queue the generator job.
    const parameters = {
      type: dto.type,
      filters: dto.filters ?? {},
      format: dto.format,
    };

    const report = await this.prisma.reportExport.create({
      data: {
        organization_id: organizationId,
        type: dto.type,
        parameters: parameters as Prisma.InputJsonValue,
        status: 'PENDING',
        format: dto.format,
        requested_by: user.id,
      },
    });

    await this.audit.log({
      organizationId,
      actorId: user.id,
      action: 'REPORT_REQUESTED',
      entityType: 'REPORT_EXPORT',
      entityId: report.id,
      metadata: {
        type: dto.type,
        format: dto.format,
        count,
      },
    });

    await this.reportsQueue.add(
      'generate',
      {
        reportId: report.id,
        organizationId,
        type: dto.type,
        parameters,
        requestedBy: user.id,
      },
      { jobId: `report-${report.id}` },
    );

    return { id: report.id, status: 'PENDING' };
  }

  // =========================================================================
  // GET REPORT (status polling)
  // =========================================================================
  async get(organizationId: string, id: string) {
    const report = await this.prisma.reportExport.findUnique({
      where: { id, organization_id: organizationId },
    });
    if (!report) {
      throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Report not found' });
    }

    return {
      id: report.id,
      status: report.status,
      format: report.format,
      createdAt: report.created_at.toISOString(),
      completedAt: report.completed_at ? report.completed_at.toISOString() : null,
      expiresAt: report.expires_at ? report.expires_at.toISOString() : null,
    };
  }

  // =========================================================================
  // DOWNLOAD REPORT (signed R2 URL)
  // =========================================================================
  async download(organizationId: string, id: string) {
    const report = await this.prisma.reportExport.findUnique({
      where: { id, organization_id: organizationId },
    });
    if (!report) {
      throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Report not found' });
    }

    if (report.status !== 'COMPLETED' || !report.r2_key) {
      throw new ConflictException({
        code: 'REPORT_NOT_READY',
        message: 'Report is not ready for download',
      });
    }

    if (report.expires_at && new Date() > report.expires_at) {
      throw new GoneException({
        code: 'REPORT_EXPIRED',
        message: 'Report download link has expired',
      });
    }

    const url = await this.r2Service.getDownloadUrl(report.r2_key);
    return { url, expiresInSeconds: 3600 };
  }

  // =========================================================================
  // ROW COUNT + ROW FETCH (per report type)
  //
  // Public — the ReportGeneratorProcessor reuses these to build the async CSV,
  // so sync (<1000 rows) and async paths produce identical data.
  // =========================================================================
  /**
   * Resolve + fetch ALL rows for a report (async path). Filters are extracted
   * through the same allowlist as the sync path.
   */
  async getReportData(
    organizationId: string,
    type: string,
    rawFilters?: Record<string, string | number | boolean>,
  ): Promise<unknown[]> {
    const filters = this.extractFilters(rawFilters);
    return this.fetchReportRows(organizationId, type, filters);
  }

  async countReportRows(organizationId: string, type: string, filters: ReportFilters): Promise<number> {
    switch (type) {
      case 'scholars':
        return this.prisma.userRole.count({ where: this.buildScholarWhere(organizationId, filters) });
      case 'attendance':
        return this.prisma.attendanceRecord.count({ where: this.buildAttendanceWhere(organizationId, filters) });
      case 'assignments':
        return this.prisma.scholarAssignment.count({ where: this.buildAssignmentWhere(organizationId, filters) });
      case 'meetings':
        return this.prisma.meeting.count({ where: this.buildMeetingWhere(organizationId, filters) });
      default:
        throw new BadRequestException({
          code: 'REPORT_TYPE_UNSUPPORTED',
          message: `Report type "${type}" is not supported`,
        });
    }
  }

  /**
   * Fetch report rows for a type + filters. `take` limits the result set
   * (sync path passes SYNC_REPORT_LIMIT; async path fetches everything).
   */
  async fetchReportRows(
    organizationId: string,
    type: string,
    filters: ReportFilters,
    take?: number,
  ): Promise<unknown[]> {
    switch (type) {
      case 'scholars': {
        const rows = await this.prisma.userRole.findMany({
          where: this.buildScholarWhere(organizationId, filters),
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { created_at: 'asc' },
          take,
        });
        return rows.map((r) => ({
          id: r.user.id,
          name: r.user.name,
          email: r.user.email,
        }));
      }
      case 'attendance': {
        const rows = await this.prisma.attendanceRecord.findMany({
          where: this.buildAttendanceWhere(organizationId, filters),
          include: {
            scholar: { select: { id: true, name: true } },
            meeting: { select: { title: true } },
          },
          orderBy: { created_at: 'asc' },
          take,
        });
        return rows.map((r) => ({
          scholarId: r.scholar_id,
          name: r.scholar.name,
          meetingTitle: r.meeting.title,
          status: r.status,
          recordedAt: r.created_at.toISOString(),
        }));
      }
      case 'assignments': {
        const rows = await this.prisma.scholarAssignment.findMany({
          where: this.buildAssignmentWhere(organizationId, filters),
          include: {
            scholar: { select: { id: true, name: true } },
            assignment: { select: { title: true } },
          },
          orderBy: { created_at: 'asc' },
          take,
        });
        return rows.map((r) => ({
          scholarId: r.scholar_id,
          name: r.scholar.name,
          assignmentTitle: r.assignment.title,
          status: r.status,
          earnedCredit: r.earned_credit,
        }));
      }
      case 'meetings': {
        const rows = await this.prisma.meeting.findMany({
          where: this.buildMeetingWhere(organizationId, filters),
          include: { course: { select: { name: true } } },
          orderBy: { starts_at: 'asc' },
          take,
        });
        return rows.map((r) => ({
          title: r.title,
          courseName: r.course.name,
          startsAt: r.starts_at.toISOString(),
          durationMinutes: r.duration_minutes,
        }));
      }
      default:
        throw new BadRequestException({
          code: 'REPORT_TYPE_UNSUPPORTED',
          message: `Report type "${type}" is not supported`,
        });
    }
  }

  // =========================================================================
  // FILTER BUILDERS (org-scoped)
  // =========================================================================
  private buildScholarWhere(organizationId: string, filters: ReportFilters): Prisma.UserRoleWhereInput {
    const userFilter: Prisma.UserWhereInput = { archived_at: null };
    if (filters.courseId) {
      userFilter.course_memberships = {
        some: { organization_id: organizationId, course_id: filters.courseId },
      };
    }

    const where: Prisma.UserRoleWhereInput = {
      organization_id: organizationId,
      role: 'SCHOLAR',
      user: userFilter,
    };

    if (filters.dateFrom || filters.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) createdAt.gte = this.parseFilterDate(filters.dateFrom);
      if (filters.dateTo) createdAt.lte = this.parseFilterDate(filters.dateTo);
      where.created_at = createdAt;
    }

    return where;
  }

  private buildAttendanceWhere(organizationId: string, filters: ReportFilters): Prisma.AttendanceRecordWhereInput {
    const where: Prisma.AttendanceRecordWhereInput = { organization_id: organizationId };

    if (filters.courseId) {
      where.meeting = { course_id: filters.courseId };
    }
    if (filters.status) {
      where.status = filters.status as AttendanceStatus;
    }
    if (filters.dateFrom || filters.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) createdAt.gte = this.parseFilterDate(filters.dateFrom);
      if (filters.dateTo) createdAt.lte = this.parseFilterDate(filters.dateTo);
      where.created_at = createdAt;
    }

    return where;
  }

  private buildAssignmentWhere(organizationId: string, filters: ReportFilters): Prisma.ScholarAssignmentWhereInput {
    const where: Prisma.ScholarAssignmentWhereInput = { organization_id: organizationId };

    if (filters.courseId) {
      where.assignment = { course_id: filters.courseId };
    }
    if (filters.status) {
      where.status = filters.status as ScholarAssignmentStatus;
    }
    if (filters.dateFrom || filters.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) createdAt.gte = this.parseFilterDate(filters.dateFrom);
      if (filters.dateTo) createdAt.lte = this.parseFilterDate(filters.dateTo);
      where.created_at = createdAt;
    }

    return where;
  }

  private buildMeetingWhere(organizationId: string, filters: ReportFilters): Prisma.MeetingWhereInput {
    const where: Prisma.MeetingWhereInput = {
      organization_id: organizationId,
      archived_at: null,
    };

    if (filters.courseId) {
      where.course_id = filters.courseId;
    }
    if (filters.dateFrom || filters.dateTo) {
      const startsAt: Prisma.DateTimeFilter = {};
      if (filters.dateFrom) startsAt.gte = this.parseFilterDate(filters.dateFrom);
      if (filters.dateTo) startsAt.lte = this.parseFilterDate(filters.dateTo);
      where.starts_at = startsAt;
    }

    return where;
  }

  private extractFilters(filters?: Record<string, string | number | boolean>): ReportFilters {
    const out: ReportFilters = {};
    if (!filters) return out;

    if (typeof filters.courseId === 'string' && filters.courseId) out.courseId = filters.courseId;
    if (typeof filters.status === 'string' && filters.status) out.status = filters.status;
    if (typeof filters.dateFrom === 'string' && filters.dateFrom) out.dateFrom = filters.dateFrom;
    if (typeof filters.dateTo === 'string' && filters.dateTo) out.dateTo = filters.dateTo;

    return out;
  }

  private parseFilterDate(value: string | number | boolean): Date {
    if (typeof value === 'boolean') {
      throw new BadRequestException({
        code: 'INVALID_REPORT_FILTER',
        message: 'dateFrom/dateTo must be a date string or timestamp',
      });
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_FILTER',
        message: 'dateFrom/dateTo must be valid dates',
      });
    }
    return date;
  }
}