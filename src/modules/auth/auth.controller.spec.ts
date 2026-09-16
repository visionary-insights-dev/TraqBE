import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

let currentUser: AuthUser;

class StubJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = currentUser;
    return true;
  }
}

const ORG_A = 'org-aaa';
const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

describe('AuthController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    forgotPassword: vi.fn(),
    verifyOtp: vi.fn(),
    resetPassword: vi.fn(),
    createInvitation: vi.fn(),
    validateInvitation: vi.fn(),
    registerFromInvitation: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: service },
        PermissionsGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtGuard())
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // POST /api/v1/auth/login (public)
  // =========================================================================
  describe('POST /api/v1/auth/login', () => {
    it('returns 201 with access token on valid credentials', async () => {
      service.login.mockResolvedValue({ accessToken: 'jwt-token-123' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@a.com', password: 'ValidPass123!' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBe('jwt-token-123');
      expect(service.login).toHaveBeenCalledWith('admin@a.com', 'ValidPass123!', expect.any(Object));
    });

    it('returns 401 INVALID_CREDENTIALS for invalid credentials', async () => {
      service.login.mockRejectedValue(new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@a.com', password: 'WrongPass123!' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 403 ACCOUNT_ARCHIVED for archived account', async () => {
      service.login.mockRejectedValue(new ForbiddenException({ code: 'ACCOUNT_ARCHIVED', message: 'Account archived' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'archived@a.com', password: 'ValidPass123!' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_ARCHIVED');
    });

    it('rejects login with invalid email format (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: 'ValidPass123!' });

      expect(res.status).toBe(400);
    });

    it('rejects login with missing password (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@a.com' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/v1/auth/refresh (public)
  // =========================================================================
  describe('POST /api/v1/auth/refresh', () => {
    it('returns 201 with new access token on valid refresh token', async () => {
      service.refresh.mockResolvedValue({ accessToken: 'new-jwt-token' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', ['refresh_token=valid-refresh-token']);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBe('new-jwt-token');
      expect(service.refresh).toHaveBeenCalledWith('valid-refresh-token', expect.any(Object));
    });

    it('returns 401 TOKEN_INVALID for invalid refresh token', async () => {
      service.refresh.mockRejectedValue(new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Invalid token' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', ['refresh_token=invalid-token']);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('handles missing refresh token cookie', async () => {
      service.refresh.mockResolvedValue({ accessToken: 'new-jwt-token' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh');

      expect(res.status).toBe(201);
      expect(service.refresh).toHaveBeenCalledWith(undefined, expect.any(Object));
    });
  });

  // =========================================================================
  // POST /api/v1/auth/logout (authenticated)
  // =========================================================================
  describe('POST /api/v1/auth/logout', () => {
    it('returns 204 and clears refresh cookie', async () => {
      currentUser = ADMIN_A;
      service.logout.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout');

      expect(res.status).toBe(204);
      expect(service.logout).toHaveBeenCalledWith(ADMIN_A.id, expect.any(Object));
    });

    it('returns 401 for unauthenticated request', async () => {
      currentUser = null as any;
      
      // Override guard to reject for this test
      const moduleRef = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: service },
          PermissionsGuard,
          Reflector,
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: () => {
            throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication required' });
          },
        })
        .compile();

      const unauthApp = moduleRef.createNestApplication();
      unauthApp.use(cookieParser());
      unauthApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      unauthApp.useGlobalFilters(new HttpExceptionFilter());
      unauthApp.useGlobalInterceptors(new TransformInterceptor());
      await unauthApp.init();

      const res = await request(unauthApp.getHttpServer())
        .post('/api/v1/auth/logout');

      expect(res.status).toBe(401);
      expect(service.logout).not.toHaveBeenCalled();
      
      await unauthApp.close();
    });
  });

  // =========================================================================
  // POST /api/v1/auth/forgot-password (public)
  // =========================================================================
  describe('POST /api/v1/auth/forgot-password', () => {
    it('returns 201 for existing email', async () => {
      service.forgotPassword.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'admin@a.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.forgotPassword).toHaveBeenCalledWith('admin@a.com');
    });

    it('returns 201 for non-existent email (no enumeration)', async () => {
      service.forgotPassword.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'unknown@a.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('rejects invalid email format (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/v1/auth/verify-otp (public)
  // =========================================================================
  describe('POST /api/v1/auth/verify-otp', () => {
    it('returns 201 with reset token on valid OTP', async () => {
      service.verifyOtp.mockResolvedValue({ resetToken: 'reset-token-123' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/verify-otp')
        .send({ email: 'admin@a.com', otp: '123456' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resetToken).toBe('reset-token-123');
      expect(service.verifyOtp).toHaveBeenCalledWith('admin@a.com', '123456');
    });

    it('returns 401 OTP_INVALID for wrong OTP', async () => {
      service.verifyOtp.mockRejectedValue(new UnauthorizedException({ code: 'OTP_INVALID', message: 'Invalid OTP' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/verify-otp')
        .send({ email: 'admin@a.com', otp: '999999' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('OTP_INVALID');
    });

    it('returns 400 OTP_EXPIRED for expired OTP', async () => {
      service.verifyOtp.mockRejectedValue(new UnauthorizedException({ code: 'OTP_EXPIRED', message: 'OTP expired' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/verify-otp')
        .send({ email: 'admin@a.com', otp: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('rejects missing OTP (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/verify-otp')
        .send({ email: 'admin@a.com' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/v1/auth/reset-password (public)
  // =========================================================================
  describe('POST /api/v1/auth/reset-password', () => {
    it('returns 201 on valid reset token', async () => {
      service.resetPassword.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ resetToken: 'valid-reset-token', newPassword: 'NewPass123!' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.resetPassword).toHaveBeenCalledWith('valid-reset-token', 'NewPass123!');
    });

    it('returns 400 RESET_TOKEN_INVALID for invalid token', async () => {
      service.resetPassword.mockRejectedValue(new UnauthorizedException({ code: 'RESET_TOKEN_INVALID', message: 'Invalid token' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ resetToken: 'invalid-token', newPassword: 'NewPass123!' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('RESET_TOKEN_INVALID');
    });

    it('rejects weak password (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ resetToken: 'valid-token', newPassword: 'weak' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /api/v1/auth/invitations (authenticated, SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/auth/invitations', () => {
    it('returns 201 for SUPER_ADMIN creating invitation', async () => {
      currentUser = ADMIN_A;
      service.createInvitation.mockResolvedValue({ token: 'invite-token-123', expiresAt: '2026-12-31T23:59:59Z' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'newuser@a.com', role: 'SCHOLAR' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBe('invite-token-123');
      expect(service.createInvitation).toHaveBeenCalledWith(ORG_A, 'newuser@a.com', Role.SCHOLAR, ADMIN_A.email);
    });

    it('returns 403 for MENTOR (insufficient permissions)', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'newuser@a.com', role: 'SCHOLAR' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.createInvitation).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR (insufficient permissions)', async () => {
      currentUser = SCHOLAR_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'newuser@a.com', role: 'SCHOLAR' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('returns 401 for unauthenticated request', async () => {
      currentUser = null as any;
      
      // Override guard to reject for this test
      const moduleRef = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: service },
          PermissionsGuard,
          Reflector,
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: () => {
            throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentication required' });
          },
        })
        .compile();

      const unauthApp = moduleRef.createNestApplication();
      unauthApp.use(cookieParser());
      unauthApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      unauthApp.useGlobalFilters(new HttpExceptionFilter());
      unauthApp.useGlobalInterceptors(new TransformInterceptor());
      await unauthApp.init();

      const res = await request(unauthApp.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'newuser@a.com', role: Role.SCHOLAR });

      expect(res.status).toBe(401);
      
      await unauthApp.close();
    });

    it('rejects invalid email format (400)', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'not-an-email', role: Role.SCHOLAR });

      expect(res.status).toBe(400);
    });

    it('rejects invalid role (400)', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'newuser@a.com', role: 'INVALID_ROLE' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for duplicate email (invitation already sent)', async () => {
      currentUser = ADMIN_A;
      service.createInvitation.mockRejectedValue(new Error('Invitation already exists for this email'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations')
        .send({ email: 'existing@a.com', role: 'SCHOLAR' });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  // =========================================================================
  // POST /api/v1/auth/invitations/:token/validate (public)
  // =========================================================================
  describe('POST /api/v1/auth/invitations/:token/validate', () => {
    it('returns 201 with invitation details on valid token', async () => {
      service.validateInvitation.mockResolvedValue({ email: 'newuser@a.com', role: Role.SCHOLAR, expiresAt: '2026-12-31T23:59:59Z' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/valid-token-123/validate');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe('newuser@a.com');
      expect(service.validateInvitation).toHaveBeenCalledWith('valid-token-123');
    });

    it('returns 404 INVITATION_NOT_FOUND for invalid token', async () => {
      service.validateInvitation.mockRejectedValue(new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Not found' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/invalid-token/validate');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('returns 400 INVITATION_EXPIRED for expired token', async () => {
      service.validateInvitation.mockRejectedValue(new Error('INVITATION_EXPIRED'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/expired-token/validate');

      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/v1/auth/invitations/:token/register (public)
  // =========================================================================
  describe('POST /api/v1/auth/invitations/:token/register', () => {
    it('returns 201 with access token on valid registration', async () => {
      service.registerFromInvitation.mockResolvedValue({ accessToken: 'jwt-token-456' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/valid-token-123/register')
        .send({ name: 'New User', password: 'StrongPass123!' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBe('jwt-token-456');
      expect(service.registerFromInvitation).toHaveBeenCalledWith('valid-token-123', { name: 'New User', password: 'StrongPass123!' }, expect.any(Object));
    });

    it('returns 404 INVITATION_NOT_FOUND for invalid token', async () => {
      service.registerFromInvitation.mockRejectedValue(new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Not found' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/invalid-token/register')
        .send({ name: 'New User', password: 'StrongPass123!' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('rejects weak password (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/valid-token/register')
        .send({ name: 'New User', password: 'weak' });

      expect(res.status).toBe(400);
    });

    it('rejects missing name (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/invitations/valid-token/register')
        .send({ password: 'StrongPass123!' });

      expect(res.status).toBe(400);
    });
  });
});
