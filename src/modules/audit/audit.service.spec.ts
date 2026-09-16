import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuditService } from './audit.service.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    organization_id: ORG_A,
    actor_id: 'u-1',
    actor: { name: 'Ada Lovelace' },
    action: 'PROGRAM_UPDATED',
    entity_type: 'PROGRAM',
    entity_id: 'prog-1',
    previous_state: null,
    new_state: null,
    metadata: null,
    ip_address: null,
    created_at: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('AuditService', () => {
  let service: AuditService;
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = {
      auditLog: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
      },
    };
    service = new AuditService(prisma as any);
  });

  // =========================================================================
  // list
  // =========================================================================
  describe('list', () => {
    it('always scopes the query by the session organization_id (tenant isolation)', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await service.list(ORG_A, {} as any);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A }),
        }),
      );
    });

    it('cannot be re-scoped by caller-supplied query properties (release-blocking: no cross-org read)', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      // A malicious client stuffing an org id into the query must have no effect.
      await service.list(ORG_A, { organizationId: ORG_B } as any);

      const where = prisma.auditLog.findMany.mock.calls[0][0].where as any;
      expect(where.organization_id).toBe(ORG_A);
      expect(where.organization_id).not.toBe(ORG_B);
    });

    it('maps every optional filter into the where clause', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await service.list(ORG_A, {
        entityType: 'PROGRAM',
        entityId: 'prog-1',
        actorUserId: 'u-3',
        eventType: 'PROGRAM_UPDATED',
      } as any);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: ORG_A,
            entity_type: 'PROGRAM',
            entity_id: 'prog-1',
            actor_id: 'u-3',
            action: 'PROGRAM_UPDATED',
          }),
        }),
      );
    });

    it('maps dateFrom/dateTo onto created_at gte/lte', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await service.list(ORG_A, {
        dateFrom: '2026-09-01T00:00:00.000Z',
        dateTo: '2026-09-30T23:59:59.999Z',
      } as any);

      const where = prisma.auditLog.findMany.mock.calls[0][0].where as any;
      expect(where.created_at).toEqual({
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T23:59:59.999Z'),
      });
    });

    it('computes pagination skip/take and meta (page 2, limit 10, total 45 → 5 pages)', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(45);

      const result = await service.list(ORG_A, { page: 2, limit: 10 } as any);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
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
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await service.list(ORG_A, {} as any);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { created_at: 'desc' } }),
      );
    });

    it('reports zero pages and an empty array for an empty result', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      const result = await service.list(ORG_A, { page: 1, limit: 25 } as any);

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({ total: 0, totalPages: 0, page: 1, limit: 25 });
    });

    it('joins the actor name and maps every response field', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        makeRow({
          previous_state: { name: 'Old Program' },
          new_state: { name: 'New Program' },
          metadata: { reason: 'rename' },
          ip_address: '127.0.0.1',
        }),
      ]);
      prisma.auditLog.count.mockResolvedValue(1);

      const result = await service.list(ORG_A, {} as any);

      expect(result.data[0]).toEqual({
        id: 'log-1',
        organizationId: ORG_A,
        actorUserId: 'u-1',
        actorName: 'Ada Lovelace',
        eventType: 'PROGRAM_UPDATED',
        entityType: 'PROGRAM',
        entityId: 'prog-1',
        previousState: { name: 'Old Program' },
        newState: { name: 'New Program' },
        metadata: { reason: 'rename' },
        ipAddress: '127.0.0.1',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });
    });

    it('never leaks sensitive fields (password_hash / token_hash / OTP hashes)', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        makeRow({
          action: 'USER_UPDATED',
          entity_type: 'USER',
          entity_id: 'u-2',
          // Even if the raw row somehow carried secrets, the mapper must drop them.
          password_hash: 'should-never-leak',
          token_hash: 'should-never-leak',
          otp_hash: 'should-never-leak',
        }),
      ]);
      prisma.auditLog.count.mockResolvedValue(1);

      const entry = (await service.list(ORG_A, {} as any)).data[0];

      expect(entry).not.toHaveProperty('password_hash');
      expect(entry).not.toHaveProperty('token_hash');
      expect(entry).not.toHaveProperty('otp_hash');
      expect(Object.keys(entry).sort()).toEqual([
        'actorName',
        'actorUserId',
        'createdAt',
        'entityId',
        'entityType',
        'eventType',
        'id',
        'ipAddress',
        'metadata',
        'newState',
        'organizationId',
        'previousState',
      ]);
    });
  });

  // =========================================================================
  // log
  // =========================================================================
  describe('log', () => {
    it('persists previous_state and new_state when provided', async () => {
      await service.log({
        organizationId: ORG_A,
        actorId: 'u-1',
        action: 'PROGRAM_UPDATED',
        entityType: 'PROGRAM',
        entityId: 'prog-1',
        previousState: { name: 'Old' },
        newState: { name: 'New' },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organization_id: ORG_A,
          actor_id: 'u-1',
          action: 'PROGRAM_UPDATED',
          entity_type: 'PROGRAM',
          entity_id: 'prog-1',
          previous_state: { name: 'Old' },
          new_state: { name: 'New' },
        }),
      });
    });

    it('leaves state columns undefined when not provided (append-only is intact)', async () => {
      await service.log({
        organizationId: ORG_A,
        actorId: 'u-1',
        action: 'AUTH_LOGIN',
        entityType: 'AUTH',
        entityId: 'u-1',
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          previous_state: undefined,
          new_state: undefined,
        }),
      });
    });
  });
});