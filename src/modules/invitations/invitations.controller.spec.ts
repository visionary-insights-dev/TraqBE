import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
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

// Valid UUID for the :id param (variant nibble must be 8/9/a/b in group 4).
const INVITATION_ID = '11111111-1111-1111-8111-111111111111';

describe('InvitationsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    list: vi.fn(),
    resend: vi.fn(),
    revoke: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: InvitationsService, useValue: service },
        PermissionsGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtGuard())
      .compile();

    app = moduleRef.createNestApplication();
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
  // GET /api/v1/invitations
  // =========================================================================
  describe('GET /api/v1/invitations', () => {
    it('returns a paginated invitation list for SUPER_ADMIN (success envelope)', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue({
        data: [
          {
            id: INVITATION_ID,
            email: 'invitee@example.com',
            role: Role.SCHOLAR,
            status: 'pending',
            expiresAt: '2099-10-01T00:00:00.000Z',
            createdAt: '2026-09-01T10:00:00.000Z',
            usedAt: null,
          },
        ],
        meta: { total: 1, totalPages: 1, page: 1, limit: 25 },
      });

      // Request page/limit explicitly: InvitationQueryDto carries no class-field
      // defaults — page=1/limit=25 defaults are applied inside the service.
      const res = await request(app.getHttpServer()).get(
        '/api/v1/invitations?page=1&limit=25',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.data[0].email).toBe('invitee@example.com');
      expect(res.body.data.data[0].status).toBe('pending');
      expect(res.body.data.meta.total).toBe(1);
      expect(service.list).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({ page: 1, limit: 25 }),
      );
    });

    it('forwards status/page/limit query params to the service', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 2, limit: 10 },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/invitations?status=expired&limit=10&page=2',
      );

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({ status: 'expired', page: 2, limit: 10 }),
      );
    });

    it('denies MENTOR with 403 INSUFFICIENT_PERMISSIONS', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer()).get('/api/v1/invitations');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('denies SCHOLAR with 403 INSUFFICIENT_PERMISSIONS', async () => {
      currentUser = SCHOLAR_A;

      const res = await request(app.getHttpServer()).get('/api/v1/invitations');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('rejects an invalid status value with 400 (validation)', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer()).get('/api/v1/invitations?status=bogus');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/v1/invitations/:id/resend
  // =========================================================================
  describe('POST /api/v1/invitations/:id/resend', () => {
    it('resends an invitation for SUPER_ADMIN (200, fresh link + expiry)', async () => {
      currentUser = ADMIN_A;
      service.resend.mockResolvedValue({
        invitationLink:
          'http://localhost:3001/auth/invitations/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        expiresAt: '2026-11-01T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer()).post(
        `/api/v1/invitations/${INVITATION_ID}/resend`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitationLink).toContain('/auth/invitations/');
      expect(res.body.data.expiresAt).toEqual(expect.any(String));
      expect(service.resend).toHaveBeenCalledWith(ORG_A, ADMIN_A.id, INVITATION_ID);
    });

    it('maps INVITATION_ALREADY_USED to 400', async () => {
      currentUser = ADMIN_A;
      service.resend.mockRejectedValue(
        new BadRequestException({
          code: 'INVITATION_ALREADY_USED',
          message: 'Invitation has already been used',
        }),
      );

      const res = await request(app.getHttpServer()).post(
        `/api/v1/invitations/${INVITATION_ID}/resend`,
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_USED');
    });

    it('maps INVITATION_NOT_FOUND to 404', async () => {
      currentUser = ADMIN_A;
      service.resend.mockRejectedValue(
        new NotFoundException({
          code: 'INVITATION_NOT_FOUND',
          message: 'Invitation not found',
        }),
      );

      const res = await request(app.getHttpServer()).post(
        `/api/v1/invitations/${INVITATION_ID}/resend`,
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('rejects a malformed UUID id with 400 before hitting the service', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer()).post(
        '/api/v1/invitations/not-a-uuid/resend',
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.resend).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DELETE /api/v1/invitations/:id
  // =========================================================================
  describe('DELETE /api/v1/invitations/:id', () => {
    it('revokes an invitation for SUPER_ADMIN (200)', async () => {
      currentUser = ADMIN_A;
      service.revoke.mockResolvedValue({});

      const res = await request(app.getHttpServer()).delete(
        `/api/v1/invitations/${INVITATION_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.revoke).toHaveBeenCalledWith(ORG_A, ADMIN_A.id, INVITATION_ID);
    });

    it('maps INVITATION_ALREADY_USED to 400', async () => {
      currentUser = ADMIN_A;
      service.revoke.mockRejectedValue(
        new BadRequestException({
          code: 'INVITATION_ALREADY_USED',
          message: 'Invitation has already been used',
        }),
      );

      const res = await request(app.getHttpServer()).delete(
        `/api/v1/invitations/${INVITATION_ID}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVITATION_ALREADY_USED');
    });

    it('denies MENTOR with 403 INSUFFICIENT_PERMISSIONS', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer()).delete(
        `/api/v1/invitations/${INVITATION_ID}`,
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.revoke).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Authentication boundary
  // =========================================================================
  it('rejects unauthenticated requests with 401', async () => {
    // The real JwtAuthGuard denies when no bearer token is present. Simulate
    // that denial path by substituting a guard that throws UnauthorizedException.
    class ThrowingGuard implements CanActivate {
      canActivate(): boolean {
        throw new UnauthorizedException({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: InvitationsService, useValue: service },
        PermissionsGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new ThrowingGuard())
      .compile();

    const guardedApp = moduleRef.createNestApplication();
    guardedApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    guardedApp.useGlobalFilters(new HttpExceptionFilter());
    guardedApp.useGlobalInterceptors(new TransformInterceptor());
    await guardedApp.init();

    const res = await request(guardedApp.getHttpServer()).get('/api/v1/invitations');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    await guardedApp.close();
  });
});