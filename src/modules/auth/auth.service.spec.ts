import { AuthService, REFRESH_COOKIE_NAME } from './auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bull';
import type { Response } from 'express';
import { Role } from '@prisma/client';
import {
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('argon2', () => ({
  verify: vi.fn(),
  hash: vi.fn(),
  argon2id: 2,
}));

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    createHash: vi.fn(),
    randomBytes: vi.fn(),
    randomInt: vi.fn(),
    randomUUID: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_ID = 'org-00000000-0000-0000-0000-000000000001';
const USER_ID = 'user-00000000-0000-0000-0000-000000000001';
const USER_EMAIL = 'Test@Example.com';
const USER_NAME = 'Test User';
const PASSWORD = 'securepassword123';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$hash$hash';
const ROLE = Role.SCHOLAR;
const ACCESS_TOKEN = 'mock-access-token';
const REFRESH_TOKEN = 'mock-refresh-token';
const TOKEN_HASH = 'mocked-hash-value';
const OTP = '123456';
const RESET_TOKEN = 'mock-reset-token';
const INVITATION_TOKEN = 'raw-invitation-token';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeUser(
  overrides?: Partial<{
    id: string;
    email: string;
    archived_at: Date | null;
    password_hash: string;
    name: string;
  }>,
) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    name: USER_NAME,
    password_hash: PASSWORD_HASH,
    phone: null,
    avatar_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    ...overrides,
  };
}

function makeUserRole(
  overrides?: Partial<{
    id: string;
    user_id: string;
    organization_id: string;
    role: Role;
  }>,
) {
  return {
    id: 'ur-001',
    user_id: USER_ID,
    organization_id: ORG_ID,
    role: ROLE,
    created_at: new Date(),
    ...overrides,
  };
}

function makeRefreshToken(
  overrides?: Partial<{
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>,
) {
  return {
    id: 'rt-001',
    user_id: USER_ID,
    token_hash: TOKEN_HASH,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revoked_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeInvitation(
  overrides?: Partial<{
    id: string;
    organization_id: string;
    email: string;
    role: Role;
    token_hash: string;
    expires_at: Date;
    used_at: Date | null;
  }>,
) {
  return {
    id: 'inv-001',
    organization_id: ORG_ID,
    email: USER_EMAIL.toLowerCase(),
    role: ROLE,
    token_hash: TOKEN_HASH,
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
    used_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makePasswordResetToken(
  overrides?: Partial<{
    id: string;
    user_id: string;
    otp_hash: string;
    expires_at: Date;
    used_at: Date | null;
  }>,
) {
  return {
    id: 'prt-001',
    user_id: USER_ID,
    otp_hash: 'otp-hash-value',
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    used_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function createMockResponse() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    userRole: { findFirst: ReturnType<typeof vi.fn> };
    refreshToken: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    passwordResetToken: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    invitation: {
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let jwtService: {
    sign: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };
  let configService: { get: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };
  let response: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      user: { findUnique: vi.fn(), update: vi.fn() },
      userRole: { findFirst: vi.fn() },
      refreshToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      passwordResetToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      invitation: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    jwtService = {
      sign: vi.fn().mockReturnValue(ACCESS_TOKEN),
      verify: vi.fn(),
    };

    configService = {
      get: vi.fn((key: string) => {
        const config: Record<string, string> = {
          JWT_REFRESH_SECRET: 'refresh-secret',
          JWT_ACCESS_SECRET: 'access-secret',
          NODE_ENV: 'test',
          WEB_URL: 'http://localhost:3001',
        };
        return config[key] ?? '';
      }),
    };

    emailQueue = { add: vi.fn().mockResolvedValue({}) };
    response = createMockResponse();

    // Default crypto mocks
    (crypto.createHash as ReturnType<typeof vi.fn>).mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(TOKEN_HASH),
    });
    (crypto.randomBytes as ReturnType<typeof vi.fn>).mockReturnValue({
      toString: vi.fn().mockReturnValue('aabbccdd'.repeat(8)),
    });
    (crypto.randomInt as ReturnType<typeof vi.fn>).mockReturnValue(123456);
    (crypto.randomUUID as ReturnType<typeof vi.fn>).mockReturnValue(
      'fixed-uuid',
    );

    service = new AuthService(
      prisma as unknown as PrismaService,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
      emailQueue as unknown as Queue,
    );
  });

  // =========================================================================
  // 1. LOGIN — success
  // =========================================================================
  describe('login', () => {
    it('returns user with correct role/organizationId, sets refresh cookie, and returns accessToken', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.verify).mockResolvedValue(true as never);
      prisma.userRole.findFirst.mockResolvedValue(makeUserRole());
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.login(USER_EMAIL, PASSWORD, response);

      // Email should be looked up as lowercase
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });

      expect(result.user.id).toBe(USER_ID);
      expect(result.user.email).toBe(USER_EMAIL);
      expect(result.user.role).toBe(ROLE);
      expect(result.user.organizationId).toBe(ORG_ID);
      expect(result.user.name).toBe(USER_NAME);
      expect(result.accessToken).toBe(ACCESS_TOKEN);

      // Refresh cookie set
      expect(response.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.any(String),
        expect.objectContaining({ httpOnly: true, path: '/api/v1/auth' }),
      );

      // Refresh token stored in DB
      expect(prisma.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ user_id: USER_ID }),
        }),
      );
    });

    // -----------------------------------------------------------------
    // 2. LOGIN — wrong password
    // -----------------------------------------------------------------
    it('throws INVALID_CREDENTIALS for wrong password (same as nonexistent email)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.verify).mockResolvedValue(false as never);

      await expect(
        service.login(USER_EMAIL, 'wrongpassword', response),
      ).rejects.toThrow(UnauthorizedException);
    });

    // -----------------------------------------------------------------
    // 3. LOGIN — archived user
    // -----------------------------------------------------------------
    it('throws ACCOUNT_ARCHIVED for archived user', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ archived_at: new Date() }),
      );

      await expect(
        service.login(USER_EMAIL, PASSWORD, response),
      ).rejects.toThrow(ForbiddenException);
    });

    // -----------------------------------------------------------------
    // 4. LOGIN — nonexistent email
    // -----------------------------------------------------------------
    it('throws INVALID_CREDENTIALS for nonexistent email (no enumeration)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      try {
        await service.login('nobody@test.com', PASSWORD, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 5. LOGIN — no organization membership
    // -----------------------------------------------------------------
    it('throws INVALID_CREDENTIALS when user has no UserRole', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.verify).mockResolvedValue(true as never);
      prisma.userRole.findFirst.mockResolvedValue(null);

      try {
        await service.login(USER_EMAIL, PASSWORD, response);
        expect.fail('Expected ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
        );
      }
    });
  });

  // =========================================================================
  // 6. REFRESH — valid token
  // =========================================================================
  describe('refresh', () => {
    it('returns new accessToken, sets new refresh cookie, and revokes old token', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        email: USER_EMAIL,
        role: ROLE,
        organizationId: ORG_ID,
      });
      prisma.refreshToken.findUnique.mockResolvedValue(makeRefreshToken());
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.refresh(REFRESH_TOKEN, response);

      expect(result.accessToken).toBe(ACCESS_TOKEN);

      // Old token revoked
      expect(prisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rt-001' },
          data: { revoked_at: expect.any(Date) },
        }),
      );

      // New refresh cookie set
      expect(response.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.any(String),
        expect.objectContaining({ httpOnly: true }),
      );

      // New token stored
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // 7. REFRESH — expired token
    // -----------------------------------------------------------------
    it('throws TOKEN_EXPIRED for expired JWT', async () => {
      const error = new Error('jwt expired');
      (error as { name?: string }).name = 'TokenExpiredError';
      jwtService.verify.mockImplementation(() => {
        throw error;
      });

      try {
        await service.refresh(REFRESH_TOKEN, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 8. REFRESH — invalid token
    // -----------------------------------------------------------------
    it('throws TOKEN_INVALID for malformed JWT', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      try {
        await service.refresh(REFRESH_TOKEN, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'TOKEN_INVALID' }),
        );
      }
    });

    it('throws TOKEN_INVALID when no refresh token provided', async () => {
      try {
        await service.refresh(undefined, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'TOKEN_INVALID' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 9. REFRESH — revoked token
    // -----------------------------------------------------------------
    it('throws REFRESH_TOKEN_REVOKED for revoked token', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        email: USER_EMAIL,
        role: ROLE,
        organizationId: ORG_ID,
      });
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshToken({ revoked_at: new Date() }),
      );

      try {
        await service.refresh(REFRESH_TOKEN, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'REFRESH_TOKEN_REVOKED' }),
        );
      }
    });

    it('throws TOKEN_EXPIRED for expired stored token (JWT still valid)', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        email: USER_EMAIL,
        role: ROLE,
        organizationId: ORG_ID,
      });
      prisma.refreshToken.findUnique.mockResolvedValue(
        makeRefreshToken({ expires_at: new Date(Date.now() - 1000) }),
      );

      try {
        await service.refresh(REFRESH_TOKEN, response);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
        );
      }
    });
  });

  // =========================================================================
  // 10. LOGOUT
  // =========================================================================
  describe('logout', () => {
    it('revokes all refresh tokens for user and clears cookie', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      await service.logout(USER_ID, response);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { user_id: USER_ID, revoked_at: null },
        data: { revoked_at: expect.any(Date) },
      });
      expect(response.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.objectContaining({ httpOnly: true, path: '/api/v1/auth' }),
      );
    });
  });

  // =========================================================================
  // 11. FORGOT PASSWORD — success
  // =========================================================================
  describe('forgotPassword', () => {
    it('creates password reset token and queues email job', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.hash).mockResolvedValue('otp-hash' as never);
      prisma.passwordResetToken.create.mockResolvedValue({});

      await service.forgotPassword(USER_EMAIL);

      expect(prisma.passwordResetToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ user_id: USER_ID }),
        }),
      );
      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          to: USER_EMAIL,
          subject: expect.stringContaining('password reset'),
        }),
      );
    });

    // -----------------------------------------------------------------
    // 12. FORGOT PASSWORD — nonexistent email
    // -----------------------------------------------------------------
    it('returns silently for nonexistent email (no enumeration)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.forgotPassword('nobody@test.com');

      expect(emailQueue.add).not.toHaveBeenCalled();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it('normalizes email to lowercase', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.hash).mockResolvedValue('otp-hash' as never);
      prisma.passwordResetToken.create.mockResolvedValue({});

      await service.forgotPassword('TEST@EXAMPLE.COM');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });
  });

  // =========================================================================
  // 13. VERIFY OTP — success
  // =========================================================================
  describe('verifyOtp', () => {
    it('marks OTP used and returns resetToken JWT', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.passwordResetToken.findFirst.mockResolvedValue(
        makePasswordResetToken(),
      );
      vi.mocked(argon2.verify).mockResolvedValue(true as never);
      prisma.passwordResetToken.update.mockResolvedValue({});
      jwtService.sign.mockReturnValue(RESET_TOKEN);

      const result = await service.verifyOtp(USER_EMAIL, OTP);

      expect(result.resetToken).toBe(RESET_TOKEN);

      // OTP marked as used
      expect(prisma.passwordResetToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prt-001' },
          data: { used_at: expect.any(Date) },
        }),
      );

      // Reset token JWT issued with correct purpose
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'password_reset' }),
        expect.objectContaining({ secret: 'access-secret' }),
      );
    });

    // -----------------------------------------------------------------
    // 14. VERIFY OTP — expired
    // -----------------------------------------------------------------
    it('throws OTP_EXPIRED for expired OTP', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.passwordResetToken.findFirst.mockResolvedValue(
        makePasswordResetToken({ expires_at: new Date(Date.now() - 1000) }),
      );

      try {
        await service.verifyOtp(USER_EMAIL, OTP);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OTP_EXPIRED' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 15. VERIFY OTP — wrong code
    // -----------------------------------------------------------------
    it('throws OTP_INVALID for wrong OTP code', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.passwordResetToken.findFirst.mockResolvedValue(
        makePasswordResetToken(),
      );
      vi.mocked(argon2.verify).mockResolvedValue(false as never);

      try {
        await service.verifyOtp(USER_EMAIL, '999999');
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OTP_INVALID' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 16. VERIFY OTP — no pending reset
    // -----------------------------------------------------------------
    it('throws OTP_INVALID when no pending reset exists', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.passwordResetToken.findFirst.mockResolvedValue(null);

      try {
        await service.verifyOtp(USER_EMAIL, OTP);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OTP_INVALID' }),
        );
      }
    });

    it('throws OTP_INVALID for nonexistent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      try {
        await service.verifyOtp('nobody@test.com', OTP);
        expect.fail('Expected UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toEqual(
          expect.objectContaining({ code: 'OTP_INVALID' }),
        );
      }
    });
  });

  // =========================================================================
  // 17. RESET PASSWORD — success
  // =========================================================================
  describe('resetPassword', () => {
    it('updates password hash and revokes all refresh tokens in a transaction', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        purpose: 'password_reset',
      });
      prisma.user.findUnique.mockResolvedValue(makeUser());
      vi.mocked(argon2.hash).mockResolvedValue('new-pw-hash' as never);
      prisma.$transaction.mockResolvedValue([{}, {}]);

      await service.resetPassword(RESET_TOKEN, 'newpassword123');

      expect(argon2.hash).toHaveBeenCalledWith('newpassword123', {
        type: 2,
      });
      expect(prisma.$transaction).toHaveBeenCalled();

      // Verify the transaction includes password update + token revocation
      const txArg = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(txArg).toHaveLength(2);
    });

    // -----------------------------------------------------------------
    // 18. RESET PASSWORD — invalid token
    // -----------------------------------------------------------------
    it('throws RESET_TOKEN_INVALID for invalid JWT', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      try {
        await service.resetPassword('bad-token', 'newpassword');
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'RESET_TOKEN_INVALID' }),
        );
      }
    });

    it('throws RESET_TOKEN_INVALID for wrong purpose', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        purpose: 'wrong_purpose',
      });

      try {
        await service.resetPassword(RESET_TOKEN, 'newpassword');
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'RESET_TOKEN_INVALID' }),
        );
      }
    });

    it('throws RESET_TOKEN_INVALID for archived user', async () => {
      jwtService.verify.mockReturnValue({
        sub: USER_ID,
        purpose: 'password_reset',
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ archived_at: new Date() }),
      );

      try {
        await service.resetPassword(RESET_TOKEN, 'newpassword');
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'RESET_TOKEN_INVALID' }),
        );
      }
    });
  });

  // =========================================================================
  // 19. CREATE INVITATION — success
  // =========================================================================
  describe('createInvitation', () => {
    it('stores invitation with hashed token and queues email', async () => {
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.invitation.create.mockResolvedValue({});

      const result = await service.createInvitation(
        ORG_ID,
        USER_EMAIL,
        ROLE,
        'Admin User',
      );

      // Normalized email used for lookup and storage
      expect(prisma.invitation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ email: USER_EMAIL.toLowerCase() }),
        }),
      );

      expect(prisma.invitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: ORG_ID,
            email: USER_EMAIL.toLowerCase(),
            role: ROLE,
          }),
        }),
      );

      expect(result.invitationLink).toContain('/auth/invitations/');
      expect(result.invitationLink).toContain('http://localhost:3001');

      expect(emailQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          to: USER_EMAIL.toLowerCase(),
          html: expect.stringContaining('Admin User'),
        }),
      );
    });

    // -----------------------------------------------------------------
    // 27. CREATE INVITATION — duplicate
    // -----------------------------------------------------------------
    it('throws INVITATION_EXISTS for duplicate active invitation', async () => {
      prisma.invitation.findFirst.mockResolvedValue(makeInvitation());

      try {
        await service.createInvitation(ORG_ID, USER_EMAIL, ROLE);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVITATION_EXISTS' }),
        );
      }
    });
  });

  // =========================================================================
  // 20. VALIDATE INVITATION — success
  // =========================================================================
  describe('validateInvitation', () => {
    it('returns email, role, and organizationId for a valid invitation', async () => {
      const invitation = makeInvitation();
      prisma.invitation.findUnique.mockResolvedValue(invitation);

      const result = await service.validateInvitation(INVITATION_TOKEN);

      expect(result.email).toBe(invitation.email);
      expect(result.role).toBe(ROLE);
      expect(result.organizationId).toBe(ORG_ID);

      // Token is looked up by hash
      expect(prisma.invitation.findUnique).toHaveBeenCalledWith({
        where: { token_hash: TOKEN_HASH },
      });
    });

    // -----------------------------------------------------------------
    // 21. VALIDATE INVITATION — expired
    // -----------------------------------------------------------------
    it('throws INVITATION_EXPIRED for expired invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(
        makeInvitation({ expires_at: new Date(Date.now() - 1000) }),
      );

      try {
        await service.validateInvitation(INVITATION_TOKEN);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVITATION_EXPIRED' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 22. VALIDATE INVITATION — not found
    // -----------------------------------------------------------------
    it('throws INVITATION_NOT_FOUND for nonexistent token', async () => {
      prisma.invitation.findUnique.mockResolvedValue(null);

      try {
        await service.validateInvitation('nonexistent-token');
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVITATION_NOT_FOUND' }),
        );
      }
    });

    // -----------------------------------------------------------------
    // 23. VALIDATE INVITATION — already used
    // -----------------------------------------------------------------
    it('throws INVITATION_ALREADY_USED for used invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(
        makeInvitation({ used_at: new Date() }),
      );

      try {
        await service.validateInvitation(INVITATION_TOKEN);
        expect.fail('Expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'INVITATION_ALREADY_USED' }),
        );
      }
    });
  });

  // =========================================================================
  // 24. REGISTER FROM INVITATION — success
  // =========================================================================
  describe('registerFromInvitation', () => {
    const registerDto = { name: 'New User', password: 'securepassword123' };

    function setupTransactionMocks() {
      const createdUser = {
        id: 'new-user-id',
        email: 'test@example.com',
        name: 'New User',
        password_hash: 'pw-hash',
        phone: null,
        avatar_url: null,
        created_at: new Date(),
        updated_at: new Date(),
        archived_at: null,
      };

      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          user: { create: vi.fn().mockResolvedValue(createdUser) },
          userRole: { create: vi.fn().mockResolvedValue({}) },
          invitation: { update: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      return createdUser;
    }

    it('creates user, UserRole, marks invitation used, and returns tokens', async () => {
      prisma.invitation.findUnique.mockResolvedValue(makeInvitation());
      vi.mocked(argon2.hash).mockResolvedValue('pw-hash' as never);
      const createdUser = setupTransactionMocks();
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.registerFromInvitation(
        INVITATION_TOKEN,
        registerDto,
        response,
      );

      expect(result.user.id).toBe(createdUser.id);
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.role).toBe(ROLE);
      expect(result.user.organizationId).toBe(ORG_ID);
      expect(result.user.name).toBe('New User');
      expect(result.accessToken).toBe(ACCESS_TOKEN);

      // Password hashed with argon2id
      expect(argon2.hash).toHaveBeenCalledWith('securepassword123', {
        type: 2,
      });

      // Transaction executed (user created, role created, invitation marked)
      expect(prisma.$transaction).toHaveBeenCalled();

      // Refresh cookie set
      expect(response.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.any(String),
        expect.objectContaining({ httpOnly: true }),
      );
    });

    // -----------------------------------------------------------------
    // 25. REGISTER FROM INVITATION — expired
    // -----------------------------------------------------------------
    it('throws INVITATION_EXPIRED for expired invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(
        makeInvitation({ expires_at: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.registerFromInvitation(INVITATION_TOKEN, registerDto, response),
      ).rejects.toThrow(BadRequestException);
    });

    // -----------------------------------------------------------------
    // 26. REGISTER FROM INVITATION — already used
    // -----------------------------------------------------------------
    it('throws INVITATION_ALREADY_USED for used invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(
        makeInvitation({ used_at: new Date() }),
      );

      await expect(
        service.registerFromInvitation(INVITATION_TOKEN, registerDto, response),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws INVITATION_NOT_FOUND for nonexistent token', async () => {
      prisma.invitation.findUnique.mockResolvedValue(null);

      await expect(
        service.registerFromInvitation('bad-token', registerDto, response),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
