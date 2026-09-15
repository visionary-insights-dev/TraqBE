import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Role } from '@prisma/client';
import { InvitationReminderProcessor } from './invitation-reminder.processor.js';

const ORG_A = 'org-a';
const INVITATION_ID = 'inv-1';

function makeInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION_ID,
    organization_id: ORG_A,
    email: 'db-invitee@example.com',
    role: Role.SCHOLAR,
    token_hash: 'token-hash',
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
    used_at: null,
    created_at: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

const BASE_JOB = {
  id: 'job-1',
  data: {
    invitationId: INVITATION_ID,
    organizationId: ORG_A,
    // Deliberately different from the DB row email — the DB must win.
    email: 'job-email@example.com',
    type: '24h',
  },
  attemptsMade: 0,
  opts: { attempts: 3 },
} as any;

describe('InvitationReminderProcessor', () => {
  let processor: InvitationReminderProcessor;
  let prisma: any;
  let emailQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = {
      invitation: {
        findFirst: vi.fn(),
      },
    };
    emailQueue = { add: vi.fn().mockResolvedValue(undefined) };

    processor = new InvitationReminderProcessor(prisma as any, emailQueue as any);
  });

  // =========================================================================
  // 24h reminders
  // =========================================================================
  describe('reminder type 24h', () => {
    it('queues an email from the DB row (not job.data.email) with the 24h template', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());

      await processor.handleReminder(BASE_JOB as any);

      expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, organization_id: ORG_A },
      });
      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'db-invitee@example.com',
        subject: 'Your invitation expires in 24 hours',
        templateId: 'invitation_reminder_24h',
        variables: { expiryDate: '2099-01-01T00:00:00.000Z' },
      });
      // The job.data.email is never trusted over the DB row.
      expect(emailQueue.add).not.toHaveBeenCalledWith(
        expect.objectContaining({ to: 'job-email@example.com' }),
      );
    });

    it('skips the send when the invitation is already used', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ used_at: new Date('2026-09-10T00:00:00.000Z') }),
      );

      await expect(processor.handleReminder(BASE_JOB as any)).resolves.toBeUndefined();

      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('skips the send when the invitation is already expired', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ expires_at: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await expect(processor.handleReminder(BASE_JOB as any)).resolves.toBeUndefined();

      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('skips quietly when the invitation no longer exists (stale job)', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);

      await expect(processor.handleReminder(BASE_JOB as any)).resolves.toBeUndefined();

      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // expiry reminders
  // =========================================================================
  describe('reminder type expiry', () => {
    const EXPIRY_JOB = {
      ...BASE_JOB,
      data: { ...BASE_JOB.data, type: 'expiry' },
    } as any;

    it('queues an expiry reminder with the expiry template and subject', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());

      await processor.handleReminder(EXPIRY_JOB);

      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'db-invitee@example.com',
        subject: 'Your invitation expires soon',
        templateId: 'invitation_reminder_expiry',
        variables: { expiryDate: '2099-01-01T00:00:00.000Z' },
      });
    });

    it('skips the send when the invitation is already used', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ used_at: new Date('2026-09-10T00:00:00.000Z') }),
      );

      await expect(processor.handleReminder(EXPIRY_JOB)).resolves.toBeUndefined();

      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('skips the send when the invitation is already expired', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ expires_at: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await expect(processor.handleReminder(EXPIRY_JOB)).resolves.toBeUndefined();

      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Error path
  // =========================================================================
  it('rethrows real errors so BullMQ retries with backoff', async () => {
    prisma.invitation.findFirst.mockRejectedValue(new Error('db exploded'));

    await expect(processor.handleReminder(BASE_JOB as any)).rejects.toThrow('db exploded');

    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});