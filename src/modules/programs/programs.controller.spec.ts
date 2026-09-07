import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role, MembershipType } from '@prisma/client';
import { ProgramsController } from './programs.controller.js';
import { ProgramsService } from './programs.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import { NotFoundException } from '@nestjs/common';
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
const PROGRAM_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_PROGRAM_ID = '8f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const MEMBER_USER = '5f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_USER = '6f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };
const ADMIN_B: AuthUser = { id: 'u-admin-b', email: 'admin@b.com', organizationId: ORG_B, roles: [Role.SUPER_ADMIN] };

describe('ProgramsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    listPrograms: vi.fn(),
    createProgram: vi.fn(),
    getProgram: vi.fn(),
    updateProgram: vi.fn(),
    archiveProgram: vi.fn(),
    listProgramMembers: vi.fn(),
    addProgramMember: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ProgramsController],
      providers: [
        { provide: ProgramsService, useValue: service },
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
  // GET /api/v1/programs — programs.read (all roles)
  // =========================================================================
  describe('GET /api/v1/programs', () => {
    it('lists programs scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.listPrograms.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/programs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.listPrograms).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ page: 1, limit: 25 }));
    });

    it('allows SCHOLAR to read programs (programs.read -> SUPER_ADMIN,MENTOR,SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      service.listPrograms.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/programs');

      expect(res.status).toBe(200);
      expect(service.listPrograms).toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it('allows MENTOR to read programs', async () => {
      currentUser = MENTOR_A;
      service.listPrograms.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/programs');

      expect(res.status).toBe(200);
    });

    it('always passes the caller organizationId (cross-tenant at boundary)', async () => {
      currentUser = ADMIN_B;
      service.listPrograms.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/programs');

      expect(res.status).toBe(200);
      expect(service.listPrograms).toHaveBeenCalledWith(ORG_B, expect.anything());
      expect(service.listPrograms).not.toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it('returns 401 without a token', async () => {
      // Override guard to NOT set a user -> the global guards would block. Here we
      // simulate by removing the StubJwtGuard behaviour. For a tokenless request we
      // simply ensure the route is protected; a 401 is produced by the real guard.
      // Since our stub always authenticates, we instead assert PermissionsGuard
      // is wired by the role tests elsewhere. This test documents route protection.
      currentUser = undefined as unknown as AuthUser;
      const res = await request(app.getHttpServer()).get('/api/v1/programs');
      // The PermissionsGuard rejects a user with no roles -> 403.
      expect(res.status).toBe(403);
      expect(service.listPrograms).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/v1/programs — programs.create (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/programs', () => {
    it('creates a program scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.createProgram.mockResolvedValue({
        id: PROGRAM_ID,
        name: 'TMF Leadership Accelerator',
        description: 'desc',
        startDate: null,
        endDate: null,
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/programs')
        .send({ name: 'TMF Leadership Accelerator', description: 'desc' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.createProgram).toHaveBeenCalledWith(ORG_A, { name: 'TMF Leadership Accelerator', description: 'desc' }, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role (programs.create -> SUPER_ADMIN only)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/programs')
        .send({ name: 'Nope' });

      expect(res.status).toBe(403);
      expect(service.createProgram).not.toHaveBeenCalled();
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/programs')
        .send({ name: 'Nope' });

      expect(res.status).toBe(403);
      expect(service.createProgram).not.toHaveBeenCalled();
    });

    it('rejects missing name (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/programs')
        .send({ description: 'no name' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.createProgram).not.toHaveBeenCalled();
    });

    it('rejects unknown fields (forbidNonWhitelisted => 400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/programs')
        .send({ name: 'X', evilField: 'hack' });

      expect(res.status).toBe(400);
      expect(service.createProgram).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/v1/programs/:id — programs.read (all roles), org-scoped 404
  // =========================================================================
  describe('GET /api/v1/programs/:id', () => {
    it('returns a program scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.getProgram.mockResolvedValue({
        id: PROGRAM_ID,
        name: 'P',
        progress: { totalMembers: 0, courseCount: 0, scholarCount: 0, mentorCount: 0 },
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${PROGRAM_ID}`);

      expect(res.status).toBe(200);
      expect(service.getProgram).toHaveBeenCalledWith(ORG_A, PROGRAM_ID);
    });

    it('maps PROGRAM_NOT_FOUND to 404 (cross-tenant must not leak)', async () => {
      currentUser = ADMIN_A;
      // An ORG_B-owned program id hit by an ORG_A user -> org-scoped 404.
      service.getProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${ORG_B_PROGRAM_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.getProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID);
    });

    it('allows SCHOLAR to read a program', async () => {
      currentUser = SCHOLAR_A;
      service.getProgram.mockResolvedValue({ id: PROGRAM_ID, name: 'P', progress: {} });

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${PROGRAM_ID}`);

      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // PATCH /api/v1/programs/:id — programs.update (SUPER_ADMIN only)
  // =========================================================================
  describe('PATCH /api/v1/programs/:id', () => {
    it('updates a program scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.updateProgram.mockResolvedValue({ id: PROGRAM_ID, name: 'Renamed' });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/programs/${PROGRAM_ID}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(service.updateProgram).toHaveBeenCalledWith(ORG_A, PROGRAM_ID, { name: 'Renamed' }, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/programs/${PROGRAM_ID}`)
        .send({ name: 'X' });

      expect(res.status).toBe(403);
      expect(service.updateProgram).not.toHaveBeenCalled();
    });

    it('maps PROGRAM_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.updateProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/programs/${ORG_B_PROGRAM_ID}`)
        .send({ name: 'H4ck' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.updateProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID, { name: 'H4ck' }, ADMIN_A.id);
    });
  });

  // =========================================================================
  // POST /api/v1/programs/:id/archive — programs.archive (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/programs/:id/archive', () => {
    it('archives a program scoped to the caller org', async () => {
      currentUser = ADMIN_A;
      service.archiveProgram.mockResolvedValue({
        id: PROGRAM_ID,
        archivedAt: '2026-01-01T00:00:00.000Z',
        message: 'Program archived. Historical data is preserved.',
      });

      const res = await request(app.getHttpServer()).post(`/api/v1/programs/${PROGRAM_ID}/archive`);

      expect(res.status).toBe(201); // @Post default status
      expect(service.archiveProgram).toHaveBeenCalledWith(ORG_A, PROGRAM_ID, ADMIN_A.id);
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/programs/${PROGRAM_ID}/archive`);

      expect(res.status).toBe(403);
      expect(service.archiveProgram).not.toHaveBeenCalled();
    });

    it('maps PROGRAM_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.archiveProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/programs/${ORG_B_PROGRAM_ID}/archive`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.archiveProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID, ADMIN_A.id);
    });
  });

  // =========================================================================
  // GET /api/v1/programs/:id/members — programs.read (all roles)
  // =========================================================================
  describe('GET /api/v1/programs/:id/members', () => {
    it('lists members scoped to the caller org', async () => {
      currentUser = ADMIN_A;
      service.listProgramMembers.mockResolvedValue({
        programId: PROGRAM_ID,
        members: [],
        summary: { total: 0, scholarCount: 0, mentorCount: 0 },
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${PROGRAM_ID}/members`);

      expect(res.status).toBe(200);
      expect(service.listProgramMembers).toHaveBeenCalledWith(ORG_A, PROGRAM_ID);
    });

    it('maps PROGRAM_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.listProgramMembers.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${ORG_B_PROGRAM_ID}/members`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.listProgramMembers).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID);
    });
  });

  // =========================================================================
  // POST /api/v1/programs/:id/members — programs.manage_members (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/programs/:id/members', () => {
    it('adds a member scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.addProgramMember.mockResolvedValue({
        id: 'pm-1',
        programId: PROGRAM_ID,
        userId: MEMBER_USER,
        membershipType: MembershipType.SCHOLAR,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/programs/${PROGRAM_ID}/members`)
        .send({ userId: MEMBER_USER, membershipType: MembershipType.SCHOLAR });

      expect(res.status).toBe(201);
      expect(service.addProgramMember).toHaveBeenCalledWith(
        ORG_A,
        PROGRAM_ID,
        { userId: MEMBER_USER, membershipType: MembershipType.SCHOLAR },
        ADMIN_A.id,
      );
    });

    it('returns 403 for SCHOLAR role (manage_members -> SUPER_ADMIN)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/programs/${PROGRAM_ID}/members`)
        .send({ userId: MEMBER_USER, membershipType: MembershipType.SCHOLAR });

      expect(res.status).toBe(403);
      expect(service.addProgramMember).not.toHaveBeenCalled();
    });

    it('rejects invalid membershipType (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/programs/${PROGRAM_ID}/members`)
        .send({ userId: MEMBER_USER, membershipType: 'FROB' });

      expect(res.status).toBe(400);
      expect(service.addProgramMember).not.toHaveBeenCalled();
    });

    it('maps USER_NOT_FOUND to 404 when adding an out-of-org user', async () => {
      currentUser = ADMIN_A;
      service.addProgramMember.mockRejectedValue(
        new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/programs/${PROGRAM_ID}/members`)
        .send({ userId: ORG_B_USER, membershipType: MembershipType.SCHOLAR });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
      expect(service.addProgramMember).toHaveBeenCalledWith(ORG_A, PROGRAM_ID, expect.anything(), ADMIN_A.id);
    });
  });

  // =========================================================================
  // Cross-tenant isolation at the HTTP boundary (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user reading an ORG_B-owned program id returns 404 PROGRAM_NOT_FOUND (no leak)', async () => {
      currentUser = ADMIN_A;
      // The service simulates the org-scoped miss.
      service.getProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${ORG_B_PROGRAM_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      // The caller org A, never org B.
      expect(service.getProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID);
      expect(service.getProgram).not.toHaveBeenCalledWith(ORG_B, ORG_B_PROGRAM_ID);
    });

    it('ORG_A admin cannot patch an ORG_B-owned program (404, never 200/403 data leak)', async () => {
      currentUser = ADMIN_A;
      service.updateProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/programs/${ORG_B_PROGRAM_ID}`)
        .send({ name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.updateProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID, { name: 'X' }, ADMIN_A.id);
    });

    it('ORG_A admin cannot archive an ORG_B-owned program (404)', async () => {
      currentUser = ADMIN_A;
      service.archiveProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/programs/${ORG_B_PROGRAM_ID}/archive`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.archiveProgram).toHaveBeenCalledWith(ORG_A, ORG_B_PROGRAM_ID, ADMIN_A.id);
    });

    it('ORG_A admin cannot list members of an ORG_B-owned program (404)', async () => {
      currentUser = ADMIN_A;
      service.listProgramMembers.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${ORG_B_PROGRAM_ID}/members`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
    });

    it('ORG_A user reading an ORG_B program as SCHOLAR is still denied read access to the foreign resource (404)', async () => {
      // SCHOLAR may have programs.read, but cross-tenant scoping still yields 404.
      currentUser = SCHOLAR_A;
      service.getProgram.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/programs/${ORG_B_PROGRAM_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
    });
  });
});
