import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { UserManagementService } from './users.service.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomBytes: vi.fn(),
    createHash: vi.fn(),
  };
});

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_ID = 'org-00000000-0000-0000-0000-000000000001';
const USER_ID = 'user-00000000-0000-0000-0000-000000000001';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000002';
const EMAIL = 'alice@example.com';
const TOKEN_HASH = 'a'.repeat(64); // 64-char hex sha256

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeUser(overrides?: Partial<{ id: string; email: string; name: string; archived_at: Date | null; phone: string | null; avatar_url: string | null }>) {
  return {
    id: USER_ID,
    email: EMAIL,
    name: 'Alice',
    password_hash: 'hash',
    phone: null,
    avatar_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    ...overrides,
  };
}

function makeUserRoleWithUser(
  roleOverrides?: Partial<{ id: string; user_id: string; organization_id: string; role: Role }>,
  userOverrides?: Partial<{ id: string; email: string; name: string; archived_at: Date | null; phone: string | null; avatar_url: string | null }>,
) {
  return {
    ...makeUserRole(roleOverrides),
    user: makeUser(userOverrides),
  };
}

function makeUserRole(overrides?: Partial<{ id: string; user_id: string; organization_id: string; role: Role }>) {
  return {
    id: 'ur-001',
    user_id: USER_ID,
    organization_id: ORG_ID,
    role: Role.SCHOLAR,
    created_at: new Date(),
    ...overrides,
  };
}

function makeInvitation(overrides?: Partial<{ id: string; organization_id: string; email: string; role: Role; token_hash: string; expires_at: Date; used_at: Date | null }>) {
  return {
    id: 'inv-001',
    organization_id: ORG_ID,
    email: EMAIL,
    role: Role.SCHOLAR,
    token_hash: TOKEN_HASH,
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
    used_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('UserManagementService', () => {
  let service: UserManagementService;
  let prisma: {
    userRole: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    invitation: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    scholarAssignment: {
      findMany: ReturnType<typeof vi.fn>;
    };
    attendanceRecord: {
      findMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };
  let bulkImportQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      userRole: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      invitation: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      scholarAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      attendanceRecord: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn().mockImplementation((fns: any[]) => Promise.all(fns)),
    };

    audit = { log: vi.fn().mockResolvedValue(undefined) };
    emailQueue = { add: vi.fn().mockResolvedValue({}) };
    bulkImportQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };

    // Default crypto mocks
    (crypto.randomBytes as ReturnType<typeof vi.fn>).mockReturnValue({
      toString: vi.fn().mockReturnValue('a'.repeat(64)),
    });
    (crypto.createHash as ReturnType<typeof vi.fn>).mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(TOKEN_HASH),
    });

    service = new UserManagementService(
      prisma as any,
      audit as any,
      emailQueue as any,
      bulkImportQueue as any,
    );
  });

  // =========================================================================
  // listUsers
  // =========================================================================
  describe('listUsers', () => {
    it('scopes userRole.findMany to organizationId', async () => {
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.userRole.count.mockResolvedValue(0);

      await service.listUsers(ORG_ID, { page: 1, limit: 25 } as any);

      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_ID }),
        }),
      );
    });

    it('returns paginated data with correct meta', async () => {
      const ur = makeUserRoleWithUser();
      prisma.userRole.findMany.mockResolvedValue([ur]);
      prisma.userRole.count.mockResolvedValue(30);

      const result = await service.listUsers(ORG_ID, { page: 1, limit: 25 } as any);

      expect(result.meta.total).toBe(30);
      expect(result.meta.totalPages).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(25);
      expect(result.data).toHaveLength(1);
    });

    it('includes a progress object per user', async () => {
      const ur = makeUserRoleWithUser();
      prisma.userRole.findMany.mockResolvedValue([ur]);
      prisma.userRole.count.mockResolvedValue(1);
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      const result = await service.listUsers(ORG_ID, { page: 1, limit: 25 } as any);

      expect(result.data[0].progress).toBeDefined();
      expect(result.data[0].progress).toHaveProperty('totalAssignments');
      expect(result.data[0].progress).toHaveProperty('completedAssignments');
      expect(result.data[0].progress).toHaveProperty('assignmentCompletionRate');
      expect(result.data[0].progress).toHaveProperty('attendanceRate');
    });
  });

  // =========================================================================
  // getUser — cross-tenant isolation
  // =========================================================================
  describe('getUser', () => {
    it('returns user with progress when found in org', async () => {
      prisma.userRole.findFirst.mockResolvedValue(makeUserRoleWithUser());
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      const result = await service.getUser(ORG_ID, USER_ID);

      expect(result.id).toBe(USER_ID);
      expect(result.email).toBe(EMAIL);
      expect(result.role).toBe(Role.SCHOLAR);
    });

    it('throws NotFoundException with USER_NOT_FOUND when not in org', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.getUser(ORG_ID, 'other-user-id');
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
    });

    it('scopes query to both organization_id and user_id', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);

      await service.getUser(ORG_ID, USER_ID).catch(() => {});

      expect(prisma.userRole.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: ORG_ID, user_id: USER_ID },
        }),
      );
    });
  });

  // =========================================================================
  // updateUser — cross-tenant isolation
  // =========================================================================
  describe('updateUser', () => {
    it('throws USER_NOT_FOUND when user not in org', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.updateUser(ORG_ID, 'other-user', { name: 'New' }, ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
    });

    it('updates name and logs audit on success', async () => {
      const ur = makeUserRole();
      prisma.userRole.findFirst
        .mockResolvedValueOnce(ur) // initial lookup
        .mockResolvedValueOnce(makeUserRoleWithUser({}, { name: 'New Name' })); // getUser call
      prisma.$transaction.mockImplementation((fns: any[]) => Promise.all(fns));
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      const result = await service.updateUser(ORG_ID, USER_ID, { name: 'New Name' }, ACTOR_ID);

      expect(result.name).toBe('New Name');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_UPDATED' }),
      );
    });
  });

  // =========================================================================
  // updateUser — role conflict (SCHOLAR + MENTOR blocked)
  // =========================================================================
  describe('updateUser role conflict', () => {
    it('throws INVALID_ROLE_COMBINATION when changing to conflicting role', async () => {
      const ur = makeUserRole({ role: Role.SCHOLAR });
      prisma.userRole.findFirst.mockResolvedValueOnce(ur); // initial lookup
      // assertNoRoleConflict: findMany returns a row with SCHOLAR role, trying to change to MENTOR
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: Role.SCHOLAR }]);

      try {
        await service.updateUser(ORG_ID, USER_ID, { role: Role.MENTOR }, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_ROLE_COMBINATION' }),
        );
      }
    });

    it('does not check role conflict when role is not changing', async () => {
      const ur = makeUserRole({ role: Role.SCHOLAR });
      prisma.userRole.findFirst
        .mockResolvedValueOnce(ur) // initial lookup
        .mockResolvedValueOnce(makeUserRoleWithUser()); // getUser call
      prisma.$transaction.mockImplementation((fns: any[]) => Promise.all(fns));
      prisma.scholarAssignment.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);

      await service.updateUser(ORG_ID, USER_ID, { name: 'Updated' }, ACTOR_ID);

      // findMany should not have been called for role conflict check
      // (it's only called for getProgressSummary via scholarAssignment/attendanceRecord)
      expect(prisma.userRole.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // archiveUser
  // =========================================================================
  describe('archiveUser', () => {
    it('throws CANNOT_ARCHIVE_SELF when archiving own account', async () => {
      try {
        await service.archiveUser(ORG_ID, ACTOR_ID, ACTOR_ID);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'CANNOT_ARCHIVE_SELF' }),
        );
      }
    });

    it('throws USER_NOT_FOUND when not in org', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.archiveUser(ORG_ID, 'other-user', ACTOR_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_NOT_FOUND' }),
        );
      }
    });

    it('sets archived_at and logs audit on success', async () => {
      prisma.userRole.findFirst.mockResolvedValue(makeUserRoleWithUser());
      prisma.user.update.mockResolvedValue({});

      const result = await service.archiveUser(ORG_ID, USER_ID, ACTOR_ID);

      expect(result.id).toBe(USER_ID);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: USER_ID },
          data: { archived_at: expect.any(Date) },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_ARCHIVED' }),
      );
    });
  });

  // =========================================================================
  // inviteUser
  // =========================================================================
  describe('inviteUser', () => {
    const inviteDto = { email: EMAIL, role: Role.SCHOLAR };

    it('throws USER_ALREADY_EXISTS when email already in org', async () => {
      prisma.userRole.findFirst.mockResolvedValue(makeUserRole());

      try {
        await service.inviteUser(ORG_ID, ACTOR_ID, inviteDto as any);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'USER_ALREADY_EXISTS' }),
        );
      }
    });

    it('throws INVALID_ROLE_COMBINATION when pending invitation has conflicting role', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);
      prisma.invitation.findMany.mockResolvedValue([
        makeInvitation({ role: Role.MENTOR }),
      ]);

      try {
        await service.inviteUser(ORG_ID, ACTOR_ID, { email: EMAIL, role: Role.SCHOLAR } as any);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_ROLE_COMBINATION' }),
        );
      }
    });

    it('creates invitation with hashed token, queues email, and logs audit', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.create.mockResolvedValue({
        id: 'inv-new',
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

      const result = await service.inviteUser(ORG_ID, ACTOR_ID, inviteDto as any);

      expect(result.invitationId).toBe('inv-new');
      expect(result.expiresAt).toBeDefined();

      // Token is hashed, not stored raw
      const createData = prisma.invitation.create.mock.calls[0][0].data;
      expect(createData.token_hash).toBe(TOKEN_HASH);
      expect(createData).not.toHaveProperty('token');

      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_INVITED' }),
      );
    });

    it('token_hash is a 64-char hex sha256, NOT the raw token', async () => {
      const rawToken = 'b'.repeat(64);
      (crypto.randomBytes as ReturnType<typeof vi.fn>).mockReturnValue({
        toString: vi.fn().mockReturnValue(rawToken),
      });
      const expectedHash = 'c'.repeat(64);
      (crypto.createHash as ReturnType<typeof vi.fn>).mockReturnValue({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue(expectedHash),
      });

      prisma.userRole.findFirst.mockResolvedValue(null);
      prisma.invitation.findMany.mockResolvedValue([]);
      prisma.invitation.create.mockResolvedValue({
        id: 'inv-new',
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

      await service.inviteUser(ORG_ID, ACTOR_ID, inviteDto as any);

      const createData = prisma.invitation.create.mock.calls[0][0].data;
      expect(createData.token_hash).toBe(expectedHash);
      expect(createData.token_hash).not.toBe(rawToken);
      expect(createData.token_hash).toHaveLength(64);
      // Verify it's a hex string
      expect(/^[0-9a-f]{64}$/.test(createData.token_hash)).toBe(true);

      // Verify createHash was called with 'sha256'
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
    });
  });

  // =========================================================================
  // parseCsv
  // =========================================================================
  describe('parseCsv', () => {
    it('parses valid CSV with normalized emails and uppercase roles', () => {
      const csv = 'email,name,role\n"a@b.co","Alice",SCHOLAR\n"c@d.co","Bob",MENTOR\n';
      const result = service.parseCsv(Buffer.from(csv));

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ email: 'a@b.co', name: 'Alice', role: 'SCHOLAR' });
      expect(result[1]).toEqual({ email: 'c@d.co', name: 'Bob', role: 'MENTOR' });
    });

    it('normalizes mixed-case email to lowercase and role to uppercase', () => {
      const csv = 'email,name,role\n"Test@Example.COM","User",scholar\n';
      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].email).toBe('test@example.com');
      expect(result[0].role).toBe('SCHOLAR');
    });

    it('throws INVALID_CSV for invalid role', () => {
      const csv = 'email,name,role\n"a@b.co","Alice",ADMIN\n';

      try {
        service.parseCsv(Buffer.from(csv));
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_CSV' }),
        );
      }
    });

    it('throws EMPTY_IMPORT for empty CSV (header only)', () => {
      const csv = 'email,name,role\n';

      try {
        service.parseCsv(Buffer.from(csv));
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const response = (e as BadRequestException).getResponse() as Record<string, string>;
        expect(['EMPTY_IMPORT', 'INVALID_CSV']).toContain(response.code);
      }
    });

    it('throws INVALID_CSV for blank email rows', () => {
      const csv = 'email,name,role\n"","Alice",SCHOLAR\n"c@d.co","Bob",MENTOR\n';

      try {
        service.parseCsv(Buffer.from(csv));
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_CSV' }),
        );
      }
    });
  });

  // =========================================================================
  // bulkImport
  // =========================================================================
  describe('bulkImport', () => {
    const rows = [
      { email: 'a@b.co', name: 'Alice', role: Role.SCHOLAR },
      { email: 'c@d.co', name: 'Bob', role: Role.MENTOR },
    ];

    it('processes synchronously for ≤50 rows and returns sync mode', async () => {
      prisma.userRole.findFirst.mockResolvedValue(null);
      prisma.invitation.create.mockResolvedValue({ id: 'inv-1', expires_at: new Date() });

      const result = await service.bulkImport(ORG_ID, ACTOR_ID, rows);

      expect(result.mode).toBe('sync');
      expect(result.results).toBeDefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BULK_IMPORT' }),
      );
    });

    it('skips existing users in sync mode', async () => {
      prisma.userRole.findFirst.mockResolvedValue(makeUserRole());

      const result = await service.bulkImport(ORG_ID, ACTOR_ID, rows);

      expect(result.results).toEqual(
        expect.objectContaining({ skipped: 2 }),
      );
      expect(prisma.invitation.create).not.toHaveBeenCalled();
    });

    it('queues async job for >50 rows and returns async mode', async () => {
      const largeRows = Array.from({ length: 51 }, (_, i) => ({
        email: `user${i}@example.com`,
        name: `User ${i}`,
        role: Role.SCHOLAR,
      }));

      bulkImportQueue.add.mockResolvedValue({ id: 'job-123' });

      const result = await service.bulkImport(ORG_ID, ACTOR_ID, largeRows);

      expect(result.mode).toBe('async');
      expect(result.jobId).toBe('job-123');
      expect(bulkImportQueue.add).toHaveBeenCalledTimes(1);
      expect(prisma.invitation.create).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BULK_IMPORT_QUEUED' }),
      );
    });

    it('throws EMPTY_IMPORT for empty rows array', async () => {
      try {
        await service.bulkImport(ORG_ID, ACTOR_ID, []);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'EMPTY_IMPORT' }),
        );
      }
    });
  });
});
