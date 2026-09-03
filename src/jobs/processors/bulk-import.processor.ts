import { Process, Processor } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EmailDispatchJobData, EMAIL_QUEUE } from '../queues/email.queue.js';
import { BULK_IMPORT_QUEUE } from '../queues/bulk-import.queue.js';
import type { BulkImportJobData } from '../queues/bulk-import.queue.js';

@Processor(BULK_IMPORT_QUEUE)
export class BulkImportProcessor {
  private readonly logger = new Logger(BulkImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  @Process()
  async handleBulkImport(job: Job<BulkImportJobData>): Promise<{ created: number; skipped: number }> {
    const { organizationId, invitationExpiryHours, rows } = job.data;
    this.logger.log(`Processing bulk import job ${job.id} → ${organizationId} (${rows.length} rows)`);

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      const email = row.email.toLowerCase();

      // Skip if the user is already in the org or has a pending invitation
      const existingUser = await this.prisma.userRole.findFirst({
        where: { organization_id: organizationId, user: { email } },
      });
      const existingInvite = await this.prisma.invitation.findFirst({
        where: {
          organization_id: organizationId,
          email,
          used_at: null,
          expires_at: { gt: new Date() },
        },
      });

      if (existingUser || existingInvite) {
        skipped++;
        continue;
      }

      // Store token_hash (never the raw token)
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const invitation = await this.prisma.invitation.create({
        data: {
          organization_id: organizationId,
          email,
          role: row.role,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + invitationExpiryHours * 60 * 60 * 1000),
        },
      });

      const invitationLink = `${process.env.WEB_URL ?? 'http://localhost:3001'}/auth/invitations/${rawToken}`;

      await this.emailQueue.add({
        organizationId,
        to: email,
        subject: 'You have been invited to Traq',
        html: `Hi${row.name ? ` ${row.name}` : ''}, you have been invited to join Traq. Click <a href="${invitationLink}">here</a> to accept. This link expires in ${invitationExpiryHours} hours.`,
      });

      created++;
      // Keep a reference to the invitation id for reporting (avoid unused var lint)
      void invitation;
    }

    this.logger.log(`Bulk import job ${job.id} done: ${created} created, ${skipped} skipped`);
    return { created, skipped };
  }
}
