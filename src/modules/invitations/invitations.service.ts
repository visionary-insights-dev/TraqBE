import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as crypto from 'crypto';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EMAIL_QUEUE } from '../../jobs/queues/email.queue.js';
import type { EmailDispatchJobData } from '../../jobs/queues/email.queue.js';
import { INVITATIONS_QUEUE } from '../../jobs/queues/invitations.queue.js';
import type { InvitationReminderJobData } from '../../jobs/queues/invitations.queue.js';
import { AuditService } from '../audit/audit.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import type { PaginatedResult } from '../../common/dto/pagination.dto.js';
import type { InvitationQueryDto } from './dto/invitation-query.dto.js';

const INVITATION_REMINDER_24H_MS = 24 * 60 * 60 * 1000; // 24 hours
const INVITATION_REMINDER_EXPIRY_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface InvitationListItem {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'expired' | 'used';
  expiresAt: string;
  createdAt: Date;
  usedAt: string | null;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
    @InjectQueue(INVITATIONS_QUEUE) private readonly invitationsQueue: Queue<InvitationReminderJobData>,
  ) {}

  // =========================================================================
  // LIST INVITATIONS (org-scoped, status derived from used_at/expires_at)
  // =========================================================================
  async list(
    organizationId: string,
    query: InvitationQueryDto,
  ): Promise<PaginatedResult<InvitationListItem>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const now = new Date();

    let statusWhere: Prisma.InvitationWhereInput | null = null;
    if (query.status === 'pending') {
      statusWhere = { used_at: null, expires_at: { gt: now } };
    } else if (query.status === 'expired') {
      statusWhere = { used_at: null, expires_at: { lte: now } };
    } else if (query.status === 'used') {
      statusWhere = { used_at: { not: null } };
    }

    const orgScope: Prisma.InvitationWhereInput = { organization_id: organizationId };
    const where: Prisma.InvitationWhereInput = statusWhere
      ? { AND: [orgScope, statusWhere] }
      : orgScope;

    const [rows, total] = await Promise.all([
      this.prisma.invitation.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invitation.count({ where }),
    ]);

    const data: InvitationListItem[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: this.computeStatus(row.used_at, row.expires_at),
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at,
      usedAt: row.used_at ? row.used_at.toISOString() : null,
    }));

    return {
      data,
      meta: {
        total,
        totalPages: Math.ceil(total / limit),
        page,
        limit,
      },
    };
  }

  // =========================================================================
  // RESEND INVITATION (rotate token, refresh expiry, re-queue email)
  // =========================================================================
  async resend(
    organizationId: string,
    actorId: string,
    id: string,
  ): Promise<{ invitationLink: string; expiresAt: string }> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id, organization_id: organizationId },
    });
    if (!invitation) {
      throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' });
    }
    if (invitation.used_at) {
      throw new BadRequestException({ code: 'INVITATION_ALREADY_USED', message: 'Invitation has already been used' });
    }

    // Rotate the raw token — the old hash no longer matches anything
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    // Org-configured expiry (defaults to 48h)
    const settings = await this.organizations.getSettings(organizationId);
    const expiryHours = settings.invitationExpiryHours;
    const newExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    await this.prisma.invitation.update({
      where: { id },
      data: { token_hash: tokenHash, expires_at: newExpiry },
    });

    const invitationLink = `${process.env.WEB_URL ?? 'http://localhost:3001'}/auth/invitations/${rawToken}`;

    // Queue invitation email (never send inline)
    await this.emailQueue.add({
      organizationId,
      to: invitation.email,
      subject: 'You have been invited to Traq',
      html: `You have been invited to join Traq. Click <a href="${invitationLink}">here</a> to accept your invitation. This link expires in ${expiryHours} hours.`,
    });

    // Resend replaces the old reminder jobs
    await this.scheduleReminders(organizationId, invitation.id, newExpiry);

    await this.audit.log({
      organizationId,
      actorId,
      action: 'INVITATION_RESENT',
      entityType: 'INVITATION',
      entityId: invitation.id,
      metadata: { email: invitation.email },
    });

    return { invitationLink, expiresAt: newExpiry.toISOString() };
  }

  // =========================================================================
  // REVOKE INVITATION (immediately expire — history preserved, no delete)
  // =========================================================================
  async revoke(organizationId: string, actorId: string, id: string): Promise<Record<string, never>> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id, organization_id: organizationId },
    });
    if (!invitation) {
      throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' });
    }
    if (invitation.used_at) {
      throw new BadRequestException({ code: 'INVITATION_ALREADY_USED', message: 'Invitation has already been used' });
    }

    await this.prisma.invitation.update({
      where: { id },
      data: { expires_at: new Date() },
    });

    await this.audit.log({
      organizationId,
      actorId,
      action: 'INVITATION_REVOKED',
      entityType: 'INVITATION',
      entityId: invitation.id,
      metadata: { email: invitation.email },
    });

    return {};
  }

  // =========================================================================
  // SCHEDULE REMINDERS — public, used by resend and invitation creation paths
  // =========================================================================
  async scheduleReminders(
    organizationId: string,
    invitationId: string,
    expiresAt: Date,
  ): Promise<void> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, organization_id: organizationId },
      select: { email: true },
    });
    if (!invitation) return;

    const twentyFourHourJobId = `invitation-reminder-24h-${invitationId}`;
    const expiryJobId = `invitation-reminder-expiry-${invitationId}`;

    // Remove any previously scheduled jobs so a resend replaces them (no duplicates)
    await this.invitationsQueue.removeJobs(twentyFourHourJobId).catch(() => undefined);
    await this.invitationsQueue.add(
      { invitationId, organizationId, email: invitation.email, type: '24h' },
      { delay: INVITATION_REMINDER_24H_MS, jobId: twentyFourHourJobId },
    );

    await this.invitationsQueue.removeJobs(expiryJobId).catch(() => undefined);
    await this.invitationsQueue.add(
      { invitationId, organizationId, email: invitation.email, type: 'expiry' },
      {
        delay: Math.max(
          0,
          expiresAt.getTime() - INVITATION_REMINDER_EXPIRY_LEAD_MS - Date.now(),
        ),
        jobId: expiryJobId,
      },
    );
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private computeStatus(
    usedAt: Date | null,
    expiresAt: Date,
  ): 'pending' | 'expired' | 'used' {
    if (usedAt) return 'used';
    return expiresAt.getTime() > Date.now() ? 'pending' : 'expired';
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}