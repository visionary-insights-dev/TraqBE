import { INestApplication, ValidationPipe, CanActivate, ExecutionContext, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { UserManagementController } from './users.controller.js';
import { UserManagementService } from './users.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Stubbed JwtAuthGuard — injects a mutable AuthUser so each test can act as a
// different tenant/role without a live JWT/DB/Redis.
// ---------------------------------------------------------------------------
let currentUser: AuthUser;

class StubJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = currentUser;
    return true;
  }
}

// Shared shapes
const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };
const ADMIN_B: AuthUser = { id: 'u-admin-b', email: 'admin@b.com', organizationId: ORG_B, roles: [Role.SUPER_ADMIN] };

describe('UserManagementController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    listUsers: vi.fn(),
    inviteUser: vi.fn(),
    bulkImport: vi.fn(),
    parseCsv: vi.fn(),
    getUser: vi.fn(),
    updateUser: vi.fn(),
    archiveUser: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [UserManagementController],
      providers: [
        { provide: UserManagementService, useValue: service },
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
  // GET /users/me/profile — any authenticated role
  // =========================================================================
  describe('GET /users/me/profile', () => {
    it('returns the caller\'s own profile (200 + success envelope)', async () => {
      currentUser = ADMIN_A;
      service.getMyProfile.mockResolvedValue({ id: ADMIN_A.id, email: ADMIN_A.email, name: 'Admin A' });

      const res = await request(app.getHttpServer()).get('/api/v1/users/me/profile');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(ADMIN_A.email);
      expect(service.getMyProfile).toHaveBeenCalledWith(ADMIN_A);
    });

    it('allows any authenticated role (scholar can read own profile)', async () => {
      currentUser = SCHOLAR_A;
      service.getMyProfile.mockResolvedValue({ id: SCHOLAR_A.id, email: SCHOLAR_A.email });

      const res = await request(app.getHttpServer()).get('/api/v1/users/me/profile');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // =========================================================================
  // PATCH /users/me/profile
  // =========================================================================
  describe('PATCH /users/me/profile', () => {
    it('updates own profile and returns data', async () => {
      currentUser = MENTOR_A;
      service.updateMyProfile.mockResolvedValue({ id: MENTOR_A.id, name: 'New Name' });

      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me/profile')
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.updateMyProfile).toHaveBeenCalledWith(MENTOR_A.id, { name: 'New Name' });
    });

    it('rejects invalid avatar URL (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me/profile')
        .send({ avatarUrl: 'not-a-url' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.updateMyProfile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /users — SUPER_ADMIN only
  // =========================================================================
  describe('GET /users', () => {
    it('lists users scoped to the caller\'s organization (200)', async () => {
      currentUser = ADMIN_A;
      service.listUsers.mockResolvedValue({
        data: [{ id: 'u1', role: Role.SCHOLAR }],
        meta: { total: 1, totalPages: 1, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/users?role=SCHOLAR');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // org scoping: service must be called with the caller's org, not a hardcoded value
      expect(service.listUsers).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ role: Role.SCHOLAR }));
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).get('/api/v1/users');
      expect(res.status).toBe(403);
      expect(service.listUsers).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).get('/api/v1/users');
      expect(res.status).toBe(403);
      expect(service.listUsers).not.toHaveBeenCalled();
    });

    it('rejects an invalid role query param (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer()).get('/api/v1/users?role=NOT_A_ROLE');
      expect(res.status).toBe(400);
      expect(service.listUsers).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /users/invite — SUPER_ADMIN only
  // =========================================================================
  describe('POST /users/invite', () => {
    it('invites a user scoped to the caller\'s org (201)', async () => {
      currentUser = ADMIN_A;
      service.inviteUser.mockResolvedValue({ invitationId: 'inv-1', expiresAt: new Date().toISOString() });

      const res = await request(app.getHttpServer())
        .post('/api/v1/users/invite')
        .send({ email: 'new@example.com', role: Role.SCHOLAR });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.inviteUser).toHaveBeenCalledWith(ORG_A, ADMIN_A.id, {
        email: 'new@example.com',
        role: Role.SCHOLAR,
      });
    });

    it('returns 403 for non-SUPER_ADMIN roles', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/users/invite')
        .send({ email: 'new@example.com', role: Role.SCHOLAR });
      expect(res.status).toBe(403);
      expect(service.inviteUser).not.toHaveBeenCalled();
    });

    it('rejects missing email (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/users/invite')
        .send({ role: Role.SCHOLAR });
      expect(res.status).toBe(400);
      expect(service.inviteUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /users/:id — SUPER_ADMIN only, org-scoped 404
  // =========================================================================
  describe('GET /users/:id', () => {
    it('returns a user scoped to the caller org', async () => {
      currentUser = ADMIN_A;
      service.getUser.mockResolvedValue({ id: 'u-scholar-a', role: Role.SCHOLAR });

      const res = await request(app.getHttpServer()).get('/api/v1/users/u-scholar-a');

      expect(res.status).toBe(200);
      expect(service.getUser).toHaveBeenCalledWith(ORG_A, 'u-scholar-a');
    });

    it('maps USER_NOT_FOUND to 404 while org-scoped (cross-tenant must not leak)', async () => {
      currentUser = ADMIN_A;
      // User only exists in org B.
      service.getUser.mockRejectedValue(
        new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/users/u-admin-b');

      expect(res.status).toBe(404);
      // Important: the controller passes the caller's ORG_A, never ORG_B.
      expect(service.getUser).toHaveBeenCalledWith(ORG_A, 'u-admin-b');
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).get('/api/v1/users/u-scholar-a');
      expect(res.status).toBe(403);
      expect(service.getUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // PATCH /users/:id — SUPER_ADMIN only
  // =========================================================================
  describe('PATCH /users/:id', () => {
    it('updates a user scoped to caller org', async () => {
      currentUser = ADMIN_A;
      service.updateUser.mockResolvedValue({ id: 'u1', name: 'Jane' });

      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/u1')
        .send({ name: 'Jane' });

      expect(res.status).toBe(200);
      expect(service.updateUser).toHaveBeenCalledWith(ORG_A, 'u1', { name: 'Jane' }, ADMIN_A.id);
    });

    it('rejects an invalid role value (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/u1')
        .send({ role: 'FROB' });
      expect(res.status).toBe(400);
      expect(service.updateUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /users/:id/archive — SUPER_ADMIN only
  // =========================================================================
  describe('POST /users/:id/archive', () => {
    it('archives a non-self user scoped to caller org', async () => {
      currentUser = ADMIN_A;
      service.archiveUser.mockResolvedValue({ id: 'u1', archivedAt: new Date().toISOString() });

      const res = await request(app.getHttpServer()).post('/api/v1/users/u1/archive');

      expect(res.status).toBe(201); // @Post default status
      expect(service.archiveUser).toHaveBeenCalledWith(ORG_A, 'u1', ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).post('/api/v1/users/u1/archive');
      expect(res.status).toBe(403);
      expect(service.archiveUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /users/bulk-import — SUPER_ADMIN only
  // =========================================================================
  describe('POST /users/bulk-import', () => {
    it('processes small CSV synchronously scoped to caller org', async () => {
      currentUser = ADMIN_A;
      const rows = [{ email: 'a@b.co', name: 'A', role: Role.SCHOLAR }];
      service.parseCsv.mockReturnValue(rows);
      service.bulkImport.mockResolvedValue({ mode: 'sync', results: { created: 1, skipped: 0, errors: [] } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/users/bulk-import')
        .attach('file', Buffer.from('email,name,role\na@b.co,A,SCHOLAR\n'), 'users.csv');

      expect(res.status).toBe(201); // @Post default status
      expect(service.parseCsv).toHaveBeenCalledWith(expect.any(Buffer));
      expect(service.bulkImport).toHaveBeenCalledWith(ORG_A, ADMIN_A.id, rows);
    });

    it('returns 202 with jobId for a large import (queued async)', async () => {
      currentUser = ADMIN_A;
      const rows = Array.from({ length: 51 }, () => ({
        email: 'x' + Math.random() + '@b.co',
        name: 'X',
        role: Role.SCHOLAR,
      }));
      service.parseCsv.mockReturnValue(rows);
      service.bulkImport.mockResolvedValue({ mode: 'async', jobId: 'job-1' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/users/bulk-import')
        .attach('file', Buffer.from('email,name,role\n' + rows.map((r) => `${r.email},X,SCHOLAR`).join('\n')), 'users.csv');

      expect(res.status).toBe(201); // @Post default status
      expect(service.bulkImport).toHaveBeenCalledWith(ORG_A, ADMIN_A.id, rows);
    });
  });

  // =========================================================================
  // Cross-tenant isolation at the guard/controller boundary
  // =========================================================================
  describe('cross-tenant', () => {
    it('always passes the caller\'s organizationId to the service', async () => {
      currentUser = ADMIN_B;
      service.listUsers.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/users');

      expect(res.status).toBe(200);
      // The caller from org B must only ever query org B.
      expect(service.listUsers).toHaveBeenCalledWith(ORG_B, expect.anything());
      expect(service.listUsers).not.toHaveBeenCalledWith(ORG_A, expect.anything());
    });
  });
});
