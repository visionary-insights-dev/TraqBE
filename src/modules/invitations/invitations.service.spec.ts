import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { InvitationsService } from './invitations.service.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ACTOR_ID = 'actor-1';
const INVITATION_ID = '11111111-1111-1111-8111-111111111111';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const INVITATION_REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const INVITATION_REMINDER_EXPIRY_LEAD_MS = 4 * 60 * 60 * 1000;

function makeInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION_ID,
    organization_id: ORG_A,
    email: 'invitee@example.com',
    role: Role.SCHOLAR,
    token_hash: 'old-token-hash',
    expires_at: new Date('2099-10-01T00:00:00.000Z'),
    used_at: null,
    created_at: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('InvitationsService', () => {
  let service: InvitationsService;
  let prisma: any;
  let audit: { log: ReturnType<typeof vi.fn> };
  let organizations: { getSettings: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };
  let invitationsQueue: { add: ReturnType<typeof vi.fn>; removeJobs: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = {
      invitation: {
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    };
    audit = { log: vi.fn().mockResolvedValue(undefined) };
    organizations = { getSettings: vi.fn() };
    emailQueue = { add: vi.fn().mockResolvedValue(undefined) };
    invitationsQueue = {
      add: vi.fn().mockResolvedValue(undefined),
      removeJobs: vi.fn().mockResolvedValue(undefined),
    };

    service = new InvitationsService(
      prisma as any,
      audit as any,
      organizations as any,
      emailQueue as any,
      invitationsQueue as any,
    );
  });

  afterEach(() => {
    // Restore any Date.now spy created inside a test (deterministic delays).
    vi.restoreAllMocks();
  });

  // Suppress the real scheduleReminders for resend tests that don't exercise
  // it — keeps the prisma/queue assertions focused on rotation + mailing.
  function stubScheduleReminders() {
    (service as any).scheduleReminders = vi.fn().mockResolvedValue(undefined);
  }

  function expectOrgScopedFindFirst() {
    expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
      where: { id: INVITATION_ID, organization_id: ORG_A },
    });
  }

  // =========================================================================
  // list
  // =========================================================================
  describe('list', () => {
    it('always scopes the query by the passed organization_id (tenant isolation)', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(0);

      await service.list(ORG_A, {} as any);

      expect(prisma.invitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
      // The count used for pagination is scoped too.
      expect(prisma.invitation.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });

    it('filters pending as used_at null AND expires_at > now', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(0);

      await service.list(ORG_A, { status: 'pending', page: 1, limit: 25 } as any);

      const where = prisma.invitation.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({ organization_id: ORG_A });
      expect(where.AND[1]).toEqual({
        used_at: null,
        expires_at: { gt: expect.any(Date) },
      });
    });

    it('filters expired as used_at null AND expires_at <= now', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(0);

      await service.list(ORG_A, { status: 'expired', page: 1, limit: 25 } as any);

      const where = prisma.invitation.findMany.mock.calls[0][0].where;
      expect(where.AND[1]).toEqual({
        used_at: null,
        expires_at: { lte: expect.any(Date) },
      });
    });

    it('filters used as used_at set', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(0);

      await service.list(ORG_A, { status: 'used', page: 1, limit: 25 } as any);

      const where = prisma.invitation.findMany.mock.calls[0][0].where;
      expect(where.AND[1]).toEqual({ used_at: { not: null } });
    });

    it('computes pagination skip/take and meta (page 2, limit 10, total 45 → 5 pages)', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(45);

      const result = await service.list(ORG_A, { page: 2, limit: 10 } as any);

      expect(prisma.invitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.meta).toEqual({
        total: 45,
        totalPages: 5,
        page: 2,
        limit: 10,
      });
    });

    it('sorts by created_at DESC always', async () => {
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.count.mockResolvedValue(0);

      await service.list(ORG_A, {} as any);

      expect(prisma.invitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { created_at: 'desc' } }),
      );
    });

    it('maps each row to the public shape and never leaks token_hash/organization_id', async () => {
      prisma.invitation.findMany.mockResolvedValue([
        makeInvitation({
          token_hash: 'should-never-leak',
          organization_id: ORG_B,
        }),
      ]);
      prisma.invitation.count.mockResolvedValue(1);

      const item = (await service.list(ORG_A, {} as any)).data[0];

      expect(item).toEqual({
        id: INVITATION_ID,
        email: 'invitee@example.com',
        role: Role.SCHOLAR,
        status: 'pending',
        expiresAt: '2099-10-01T00:00:00.000Z',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        usedAt: null,
      });
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'role',
        'status',
        'usedAt',
      ]);
      expect(item).not.toHaveProperty('token_hash');
      expect(item).not.toHaveProperty('organization_id');
    });

    it('derives status per row: used wins, then expired/pending by expires_at vs now', async () => {
      prisma.invitation.findMany.mockResolvedValue([
        makeInvitation({
          id: '22222222-2222-2222-8222-222222222222',
          used_at: new Date('2026-09-10T00:00:00.000Z'),
          expires_at: new Date('2099-10-01T00:00:00.000Z'),
        }),
        makeInvitation({
          id: '33333333-3333-3333-8333-333333333333',
          used_at: null,
          expires_at: new Date('2020-01-01T00:00:00.000Z'),
        }),
        makeInvitation({
          id: '44444444-4444-4444-8444-444444444444',
          used_at: null,
          expires_at: new Date('2099-10-01T00:00:00.000Z'),
        }),
      ]);
      prisma.invitation.count.mockResolvedValue(3);

      const result = await service.list(ORG_A, { page: 1, limit: 25 } as any);

      expect(result.data.map((row) => row.status)).toEqual([
        'used',
        'expired',
        'pending',
      ]);
      // used rows expose the ISO usedAt; pending/expired rows leave it null.
      expect(result.data[0].usedAt).toBe('2026-09-10T00:00:00.000Z');
      expect(result.data[1].usedAt).toBeNull();
    });
  });

  // =========================================================================
  // resend
  // =========================================================================
  describe('resend', () => {
    it('throws INVITATION_NOT_FOUND (404) when the invitation does not exist', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);

      const error = await service
        .resend(ORG_A, ACTOR_ID, INVITATION_ID)
        .catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'INVITATION_NOT_FOUND' }),
      );
      // The lookup is org-scoped — an ORG_B record id must not resolve.
      expectOrgScopedFindFirst();
      expect(prisma.invitation.update).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('throws INVITATION_ALREADY_USED (400) when used_at is set', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ used_at: new Date('2026-09-10T00:00:00.000Z') }),
      );

      const error = await service
        .resend(ORG_A, ACTOR_ID, INVITATION_ID)
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'INVITATION_ALREADY_USED' }),
      );
      expect(prisma.invitation.update).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('rotates the token hash and refreshes expiry to now + org-config hours', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());
      organizations.getSettings.mockResolvedValue({ invitationExpiryHours: 48 });
      stubScheduleReminders();

      const before = Date.now();
      await service.resend(ORG_A, ACTOR_ID, INVITATION_ID);
      const after = Date.now();

      expect(prisma.invitation.update).toHaveBeenCalledTimes(1);
      const [updateArgs] = prisma.invitation.update.mock.calls[0];
      expect(updateArgs.where).toEqual({ id: INVITATION_ID });
      expect(updateArgs.data.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(updateArgs.data.token_hash).not.toBe('old-token-hash');
      const expiryMs = updateArgs.data.expires_at.getTime();
      expect(expiryMs).toBeGreaterThanOrEqual(before + 48 * HOUR_MS);
      expect(expiryMs).toBeLessThanOrEqual(after + 48 * HOUR_MS);
    });

    it('queues the invitation email with the raw token embedded in the link', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());
      organizations.getSettings.mockResolvedValue({ invitationExpiryHours: 48 });
      stubScheduleReminders();

      await service.resend(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          to: 'invitee@example.com',
          subject: 'You have been invited to Traq',
          html: expect.stringMatching(/\/auth\/invitations\/[a-f0-9]{64}/),
        }),
      );
    });

    it('calls scheduleReminders with the refreshed expiry so old reminders are replaced', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());
      organizations.getSettings.mockResolvedValue({ invitationExpiryHours: 48 });
      stubScheduleReminders();

      await service.resend(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(service.scheduleReminders).toHaveBeenCalledWith(
        ORG_A,
        INVITATION_ID,
        expect.any(Date),
      );
    });

    it('audits INVITATION_RESENT with entityType INVITATION and the invitee email', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());
      organizations.getSettings.mockResolvedValue({ invitationExpiryHours: 48 });
      stubScheduleReminders();

      await service.resend(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ACTOR_ID,
        action: 'INVITATION_RESENT',
        entityType: 'INVITATION',
        entityId: INVITATION_ID,
        metadata: { email: 'invitee@example.com' },
      });
    });

    it('returns { invitationLink, expiresAt } with an ISO expiresAt', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());
      organizations.getSettings.mockResolvedValue({ invitationExpiryHours: 48 });
      stubScheduleReminders();

      const result = await service.resend(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(result).toEqual({
        invitationLink: expect.stringMatching(/\/auth\/invitations\/[a-f0-9]{64}/),
        expiresAt: expect.any(String),
      });
      expect(new Date(result.expiresAt).toString()).not.toBe('Invalid Date');
    });
  });

  // =========================================================================
  // revoke
  // =========================================================================
  describe('revoke', () => {
    it('throws INVITATION_NOT_FOUND (404) when the invitation does not exist', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);

      const error = await service
        .revoke(ORG_A, ACTOR_ID, INVITATION_ID)
        .catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'INVITATION_NOT_FOUND' }),
      );
      expectOrgScopedFindFirst();
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('throws INVITATION_ALREADY_USED (400) when used_at is set', async () => {
      prisma.invitation.findFirst.mockResolvedValue(
        makeInvitation({ used_at: new Date('2026-09-10T00:00:00.000Z') }),
      );

      const error = await service
        .revoke(ORG_A, ACTOR_ID, INVITATION_ID)
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'INVITATION_ALREADY_USED' }),
      );
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('expires the invitation immediately, returns {}, and never deletes the row', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());

      const result = await service.revoke(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(result).toEqual({});
      expect(prisma.invitation.update).toHaveBeenCalledWith({
        where: { id: INVITATION_ID },
        data: { expires_at: expect.any(Date) },
      });
      // update receives a single argument object (where + data).
      const [updateArgs] = prisma.invitation.update.mock.calls[0];
      expect(updateArgs.data.expires_at).toBeInstanceOf(Date);
      expect(updateArgs.data.expires_at).not.toBeNull();
      // History is preserved — revoke must never delete the invitation row.
      expect(prisma.invitation).not.toHaveProperty('delete');
      expect(invitationsQueue.removeJobs).not.toHaveBeenCalled();
    });

    it('audits INVITATION_REVOKED', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());

      await service.revoke(ORG_A, ACTOR_ID, INVITATION_ID);

      expect(audit.log).toHaveBeenCalledWith({
        organizationId: ORG_A,
        actorId: ACTOR_ID,
        action: 'INVITATION_REVOKED',
        entityType: 'INVITATION',
        entityId: INVITATION_ID,
        metadata: { email: 'invitee@example.com' },
      });
    });
  });

  // =========================================================================
  // scheduleReminders
  // =========================================================================
  describe('scheduleReminders', () => {
    it('returns early (no queue activity) when the invitation no longer exists', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);

      await service.scheduleReminders(
        ORG_A,
        INVITATION_ID,
        new Date(Date.now() + DAY_MS),
      );

      expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, organization_id: ORG_A },
        select: { email: true },
      });
      expect(invitationsQueue.add).not.toHaveBeenCalled();
      expect(invitationsQueue.removeJobs).not.toHaveBeenCalled();
    });

    it('adds the 24h job at delay 86400000 with the DB row email', async () => {
      prisma.invitation.findFirst.mockResolvedValue({ email: 'invitee@example.com' });

      await service.scheduleReminders(
        ORG_A,
        INVITATION_ID,
        new Date(Date.now() + 2 * DAY_MS),
      );

      expect(invitationsQueue.add).toHaveBeenCalledWith(
        {
          invitationId: INVITATION_ID,
          organizationId: ORG_A,
          email: 'invitee@example.com',
          type: '24h',
        },
        {
          delay: INVITATION_REMINDER_24H_MS,
          jobId: `invitation-reminder-24h-${INVITATION_ID}`,
        },
      );
    });

    it('adds the expiry job with delay Math.max(0, expiresAt - 4h - now)', async () => {
      // Deterministic clock: expiresAt = now + 48h → delay = 48h - 4h.
      const fixedNow = new Date('2026-09-01T00:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      const expiresAt = new Date(fixedNow + 48 * HOUR_MS);
      prisma.invitation.findFirst.mockResolvedValue({ email: 'invitee@example.com' });

      await service.scheduleReminders(ORG_A, INVITATION_ID, expiresAt);

      expect(invitationsQueue.add).toHaveBeenCalledWith(
        {
          invitationId: INVITATION_ID,
          organizationId: ORG_A,
          email: 'invitee@example.com',
          type: 'expiry',
        },
        {
          delay: 48 * HOUR_MS - INVITATION_REMINDER_EXPIRY_LEAD_MS, // 158400000
          jobId: `invitation-reminder-expiry-${INVITATION_ID}`,
        },
      );
    });

    it('removes both prior job ids BEFORE adding so a resend replaces, never duplicates', async () => {
      prisma.invitation.findFirst.mockResolvedValue({ email: 'invitee@example.com' });

      await service.scheduleReminders(
        ORG_A,
        INVITATION_ID,
        new Date(Date.now() + 2 * DAY_MS),
      );

      expect(invitationsQueue.removeJobs).toHaveBeenCalledWith(
        `invitation-reminder-24h-${INVITATION_ID}`,
      );
      expect(invitationsQueue.removeJobs).toHaveBeenCalledWith(
        `invitation-reminder-expiry-${INVITATION_ID}`,
      );
      expect(invitationsQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: '24h' }),
        expect.objectContaining({ jobId: `invitation-reminder-24h-${INVITATION_ID}` }),
      );
      expect(invitationsQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'expiry' }),
        expect.objectContaining({ jobId: `invitation-reminder-expiry-${INVITATION_ID}` }),
      );

      // Order is remove → add → remove → add.
      const removeOrder = invitationsQueue.removeJobs.mock.invocationCallOrder;
      const addOrder = invitationsQueue.add.mock.invocationCallOrder;
      expect(removeOrder).toHaveLength(2);
      expect(addOrder).toHaveLength(2);
      expect(removeOrder[0]).toBeLessThan(addOrder[0]);
      expect(removeOrder[1]).toBeLessThan(addOrder[1]);
    });
  });

  // =========================================================================
  // Cross-tenant isolation (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('list can never be re-scoped away from the session organization_id', async () => {
      // The service signature takes organizationId from the session arg and
      // NEVER from the query DTO, so even if mocked rows for ORG_B came back,
      // a caller has no way to request them. This is release-blocking.
      prisma.invitation.findMany.mockResolvedValue([
        makeInvitation({
          id: '55555555-5555-5555-8555-555555555555',
          organization_id: ORG_B,
        }),
      ]);
      prisma.invitation.count.mockResolvedValue(1);

      const result = await service.list(ORG_A, {} as any);

      const where = prisma.invitation.findMany.mock.calls[0][0].where;
      expect(where.organization_id).toBe(ORG_A);
      expect(where.organization_id).not.toBe(ORG_B);
      // Mapped responses never carry the org so nothing can leak to clients.
      expect(result.data[0]).not.toHaveProperty('organization_id');
    });
  });
});