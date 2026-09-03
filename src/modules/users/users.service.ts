import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailDispatchJobData, EMAIL_QUEUE } from '../../jobs/queues/email.queue.js';
import { BULK_IMPORT_QUEUE, BulkImportJobData } from '../../jobs/queues/bulk-import.queue.js';
import { InviteUserDto } from './dto/invite-user.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { ListUsersQueryDto } from './dto/list-users.query.dto.js';

// For bulk imports: process requests <= this many rows synchronously (return 200),
// anything above is queued and returns 202 with a jobId.
export const BULK_IMPORT_SYNC_THRESHOLD = 50;

const INVITATION_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

@Injectable()
export class UserManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
    @InjectQueue(BULK_IMPORT_QUEUE) private readonly bulkImportQueue: Queue<BulkImportJobData>,
  ) {}

  // =========================================================================
  // LIST USERS
  // =========================================================================
  async listUsers(organizationId: string, query: ListUsersQueryDto) {
    const where: Prisma.UserRoleWhereInput = {
      organization_id: organizationId,
      ...(query.role ? { role: query.role } : {}),
    };

    const [roles, total] = await Promise.all([
      this.prisma.userRole.findMany({
        where,
        include: { user: true },
        orderBy: { created_at: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.userRole.count({ where }),
    ]);

    const data = await Promise.all(
      roles.map(async (ur) => {
        const progress = await this.getProgressSummary(organizationId, ur.user_id);
        return {
          id: ur.user.id,
          name: ur.user.name,
          email: ur.user.email,
          role: ur.role,
          archivedAt: ur.user.archived_at ? ur.user.archived_at.toISOString() : null,
          progress,
        };
      }),
    );

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
  // GET USER (org-scoped)
  // =========================================================================
  async getUser(organizationId: string, userId: string) {
    const ur = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: userId },
      include: { user: true },
    });

    if (!ur) {
      // 404 scoped to org — never reveal cross-org existence
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const progress = await this.getProgressSummary(organizationId, userId);
    return {
      id: ur.user.id,
      name: ur.user.name,
      email: ur.user.email,
      phone: ur.user.phone,
      avatarUrl: ur.user.avatar_url,
      role: ur.role,
      archivedAt: ur.user.archived_at ? ur.user.archived_at.toISOString() : null,
      progress,
    };
  }

  // =========================================================================
  // UPDATE USER (name, phone, role)
  // =========================================================================
  async updateUser(organizationId: string, userId: string, dto: UpdateUserDto, actorId: string) {
    const ur = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: userId },
    });
    if (!ur) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }

    // If role is being changed, enforce the SCHOLAR + MENTOR single-role rule
    if (dto.role && dto.role !== ur.role) {
      await this.assertNoRoleConflict(organizationId, userId, dto.role);
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        },
      }),
      ...(dto.role && dto.role !== ur.role
        ? [
            this.prisma.userRole.update({
              where: { id: ur.id },
              data: { role: dto.role },
            }),
          ]
        : []),
    ]);

    await this.audit.log({
      organizationId,
      actorId,
      action: 'USER_UPDATED',
      entityType: 'USER',
      entityId: userId,
      metadata: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
      },
    });

    return this.getUser(organizationId, userId);
  }

  // =========================================================================
  // ARCHIVE USER
  // =========================================================================
  async archiveUser(organizationId: string, userId: string, actorId: string) {
    if (userId === actorId) {
      throw new BadRequestException({ code: 'CANNOT_ARCHIVE_SELF', message: 'You cannot archive your own account' });
    }

    const ur = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user_id: userId },
      include: { user: true },
    });
    if (!ur) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'USER_ARCHIVED',
      entityType: 'USER',
      entityId: userId,
    });

    return { id: userId, archivedAt: new Date().toISOString() };
  }

  // =========================================================================
  // GET MY PROFILE
  // =========================================================================
  async getMyProfile(user: { id: string; email: string }) {
    const record = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!record) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      phone: record.phone,
      avatarUrl: record.avatar_url,
    };
  }

  // =========================================================================
  // UPDATE MY PROFILE
  // =========================================================================
  async updateMyProfile(userId: string, dto: UpdateProfileDto) {
    const record = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.avatarUrl !== undefined ? { avatar_url: dto.avatarUrl } : {}),
      },
    });
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      phone: record.phone,
      avatarUrl: record.avatar_url,
    };
  }

  // =========================================================================
  // INVITE USER
  // =========================================================================
  async inviteUser(organizationId: string, actorId: string, dto: InviteUserDto) {
    const email = dto.email.toLowerCase();

    // Check email not already in org
    const existingMembership = await this.prisma.userRole.findFirst({
      where: { organization_id: organizationId, user: { email } },
    });
    if (existingMembership) {
      throw new BadRequestException({ code: 'USER_ALREADY_EXISTS', message: 'A user with this email is already in the organization' });
    }

    // ENFORCE: SCHOLAR + MENTOR combination blocked in the same org (for any user)
    const invitedEmailsWithRole = await this.prisma.invitation.findMany({
      where: {
        organization_id: organizationId,
        email,
        used_at: null,
        expires_at: { gt: new Date() },
      },
    });
    const pendingRoles = new Set(invitedEmailsWithRole.map((i) => i.role));
    for (const r of pendingRoles) {
      if (this.isRoleConflict(r, dto.role)) {
        throw new BadRequestException({
          code: 'INVALID_ROLE_COMBINATION',
          message: 'SCHOLAR and MENTOR roles cannot be combined in the same organization',
        });
      }
    }

    // Store token_hash, never the raw token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const invitation = await this.prisma.invitation.create({
      data: {
        organization_id: organizationId,
        email,
        role: dto.role,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + INVITATION_EXPIRY_MS),
      },
    });

    const invitationLink = `${process.env.WEB_URL ?? 'http://localhost:3001'}/auth/invitations/${rawToken}`;

    await this.emailQueue.add({
      organizationId,
      to: email,
      subject: 'You have been invited to Traq',
      html: `You have been invited to join Traq. Click <a href="${invitationLink}">here</a> to accept. This link expires in 48 hours.`,
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'USER_INVITED',
      entityType: 'USER',
      entityId: invitation.id,
      metadata: { email, role: dto.role },
    });

    return { invitationId: invitation.id, expiresAt: invitation.expires_at.toISOString() };
  }

  // =========================================================================
  // BULK IMPORT (CSV)
  // =========================================================================
  /**
   * Parse a CSV buffer with columns `email,name,role`. Validates every row and
   * returns the parsed rows (or throws with a summary of all errors).
   */
  parseCsv(buffer: Buffer): { email: string; name: string; role: Role }[] {
    const text = buffer.toString('utf-8');
    let records: Record<string, string>[];
    try {
      records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      throw new BadRequestException({ code: 'INVALID_CSV', message: 'Could not parse the CSV file' });
    }

    if (records.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_IMPORT', message: 'CSV contains no rows' });
    }

    const errors: string[] = [];
    const rows: { email: string; name: string; role: Role }[] = [];

    records.forEach((rec, idx) => {
      const email = (rec['email'] ?? '').trim().toLowerCase();
      const name = (rec['name'] ?? '').trim();
      const roleStr = (rec['role'] ?? '').trim().toUpperCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Row ${idx + 2}: invalid email "${rec['email']}"`);
        return;
      }
      if (!Object.values(Role).includes(roleStr as Role)) {
        errors.push(`Row ${idx + 2}: invalid role "${rec['role']}" (expected SUPER_ADMIN, MENTOR or SCHOLAR)`);
        return;
      }
      rows.push({ email, name, role: roleStr as Role });
    });

    if (errors.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_CSV',
        message: `CSV validation failed: ${errors.join('; ')}`,
      });
    }

    return rows;
  }
  async bulkImport(organizationId: string, actorId: string, rows: { email: string; name: string; role: Role }[]) {
    if (rows.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_IMPORT', message: 'CSV contains no valid rows' });
    }

    // A batch is processed synchronously if small, queued if large.
    if (rows.length <= BULK_IMPORT_SYNC_THRESHOLD) {
      const results = await this.processInviteBatch(organizationId, rows);
      await this.audit.log({
        organizationId,
        actorId,
        action: 'BULK_IMPORT',
        entityType: 'ORGANIZATION',
        entityId: organizationId,
        metadata: { total: rows.length, ...results },
      });
      return { mode: 'sync', results };
    }

    // Large: queue the bulk-invitation-dispatch job, return 202 with a jobId
    const job = await this.bulkImportQueue.add({
      organizationId,
      invitationExpiryHours: 48,
      rows,
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'BULK_IMPORT_QUEUED',
      entityType: 'ORGANIZATION',
      entityId: organizationId,
      metadata: { total: rows.length, jobId: String(job.id) },
    });

    return { mode: 'async', jobId: String(job.id) };
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Progress summary: assignment completion rate + attendance rate for a user
   * within an organization. Lightweight aggregate from existing tables.
   */
  private async getProgressSummary(organizationId: string, userId: string) {
    const [scholarAssignments, attendance] = await Promise.all([
      this.prisma.scholarAssignment.findMany({
        where: { organization_id: organizationId, scholar_id: userId },
        select: { status: true, score: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { organization_id: organizationId, scholar_id: userId },
        select: { status: true },
      }),
    ]);

    const completedStatuses = ['VERIFIED', 'VERIFIED_LATE', 'PENDING_VERIFICATION'];
    const assignmentTotal = scholarAssignments.length;
    const assignmentCompleted = scholarAssignments.filter((a) => completedStatuses.includes(a.status)).length;

    const present = attendance.filter((a) => a.status === 'PRESENT').length;
    // Denominator excludes excused
    const attendanceDenominator = attendance.filter((a) => a.status !== 'EXCUSED').length;
    const attendanceRate = attendanceDenominator > 0 ? present / attendanceDenominator : 0;

    return {
      totalAssignments: assignmentTotal,
      completedAssignments: assignmentCompleted,
      assignmentCompletionRate: assignmentTotal > 0 ? assignmentCompleted / assignmentTotal : 0,
      attendanceRate: Number(attendanceRate.toFixed(4)),
    };
  }

  private isRoleConflict(a: Role, b: Role): boolean {
    return (a === Role.SCHOLAR && b === Role.MENTOR) || (a === Role.MENTOR && b === Role.SCHOLAR);
  }

  private async assertNoRoleConflict(organizationId: string, userId: string, newRole: Role) {
    // Current roles for this user in this org (from other UserRole rows)
    const otherRoles = await this.prisma.userRole.findMany({
      where: { organization_id: organizationId, user_id: userId },
      select: { role: true },
    });
    for (const r of otherRoles) {
      if (this.isRoleConflict(r.role, newRole)) {
        throw new BadRequestException({
          code: 'INVALID_ROLE_COMBINATION',
          message: 'SCHOLAR and MENTOR roles cannot be combined in the same organization',
        });
      }
    }
  }

  /**
   * Create invitations for a batch of rows (validated upstream / by processor).
   * Returns counts of created / already-existing skips.
   */
  private async processInviteBatch(
    organizationId: string,
    rows: { email: string; name: string; role: Role }[],
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const email = row.email.toLowerCase();
      try {
        const existingMembership = await this.prisma.userRole.findFirst({
          where: { organization_id: organizationId, user: { email } },
        });
        if (existingMembership) {
          skipped++;
          continue;
        }

        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        await this.prisma.invitation.create({
          data: {
            organization_id: organizationId,
            email,
            role: row.role,
            token_hash: tokenHash,
            expires_at: new Date(Date.now() + INVITATION_EXPIRY_MS),
          },
        });

        const invitationLink = `${process.env.WEB_URL ?? 'http://localhost:3001'}/auth/invitations/${rawToken}`;
        await this.emailQueue.add({
          organizationId,
          to: email,
          subject: 'You have been invited to Traq',
          html: `Hi${row.name ? ` ${row.name}` : ''}, you have been invited to join Traq. Click <a href="${invitationLink}">here</a> to accept. This link expires in 48 hours.`,
        });

        created++;
      } catch (err) {
        errors.push(`${email}: ${(err as Error).message}`);
      }
    }

    return { created, skipped, errors };
  }
}
