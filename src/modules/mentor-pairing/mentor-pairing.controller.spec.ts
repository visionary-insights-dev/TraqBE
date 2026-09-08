import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  INestApplication,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { MentorPairingController } from './mentor-pairing.controller.js';
import { MentorPairingService } from './mentor-pairing.service.js';
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
const COURSE_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_COURSE_ID = '7f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const MENTOR_ID = '5f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const SCHOLAR_ID = '6f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const NEW_MENTOR_ID = '9f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ASSIGNMENT_ID = '1f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_ASSIGNMENT_ID = '2f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';

const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };
const ADMIN_B: AuthUser = { id: 'u-admin-b', email: 'admin@b.com', organizationId: ORG_B, roles: [Role.SUPER_ADMIN] };

describe('MentorPairingController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    list: vi.fn(),
    create: vi.fn(),
    reassign: vi.fn(),
    endAssignment: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [MentorPairingController],
      providers: [
        { provide: MentorPairingService, useValue: service },
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
  // GET /api/v1/mentor-assignments — mentor_assignments.read (all roles)
  // =========================================================================
  describe('GET /api/v1/mentor-assignments', () => {
    it('lists assignments scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(service.list).toHaveBeenCalledWith(ORG_A, ADMIN_A);
    });

    it('allows SCHOLAR to read (mentor_assignments.read -> SUPER_ADMIN,MENTOR,SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      service.list.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_A, SCHOLAR_A);
    });

    it('allows MENTOR to read', async () => {
      currentUser = MENTOR_A;
      service.list.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_A, MENTOR_A);
    });

    it('always passes the caller organizationId (cross-tenant at boundary)', async () => {
      currentUser = ADMIN_B;
      service.list.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_B, ADMIN_B);
      expect(service.list).not.toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it('rejects a user with no roles (403 INSUFFICIENT_PERMISSIONS)', async () => {
      currentUser = undefined as unknown as AuthUser;
      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('wraps a SCHOLAR role-filtered response in the envelope (only their own data)', async () => {
      currentUser = SCHOLAR_A;
      // Service returns only what the SCHOLAR is allowed to see.
      service.list.mockResolvedValue([
        {
          id: ASSIGNMENT_ID,
          mentor: { id: MENTOR_ID, name: 'Mentor One', email: 'm@a.com' },
          scholar: { id: SCHOLAR_ID, name: 'Scholar One', email: 's@a.com' },
          course: { id: COURSE_ID, name: 'Financial Literacy 101' },
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: null,
          endedAt: null,
        },
      ]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // The DTO only exposes the fields the service returned for this scholar.
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          scholar: expect.objectContaining({ id: SCHOLAR_ID }),
        }),
      );
      expect(res.body.data[0]).not.toHaveProperty('organization_id');
      expect(res.body.data[0]).not.toHaveProperty('mentor_id');
      expect(res.body.data[0]).not.toHaveProperty('scholar_id');
      // The service was called with the scholar user (so it can role-filter).
      expect(service.list).toHaveBeenCalledWith(ORG_A, SCHOLAR_A);
    });
  });

  // =========================================================================
  // POST /api/v1/mentor-assignments — mentor_assignments.create (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/mentor-assignments', () => {
    const validBody = {
      mentorId: MENTOR_ID,
      scholarIds: [SCHOLAR_ID],
      courseId: COURSE_ID,
    };

    it('creates assignments scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.create.mockResolvedValue({
        assignments: [
          {
            id: ASSIGNMENT_ID,
            mentor: { id: MENTOR_ID, name: 'Mentor One', email: 'm@a.com' },
            scholar: { id: SCHOLAR_ID, name: 'Scholar One', email: 's@a.com' },
            course: { id: COURSE_ID, name: null },
            startsAt: '2026-01-01T00:00:00.000Z',
            endsAt: null,
            endedAt: null,
          },
        ],
        pairedCount: 1,
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(service.create).toHaveBeenCalledWith(ORG_A, validBody, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role (create -> SUPER_ADMIN only)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send(validBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send(validBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects missing scholarIds (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, courseId: COURSE_ID });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects an empty scholarIds array (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, scholarIds: [], courseId: COURSE_ID });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID mentorId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: 'not-a-uuid', scholarIds: [SCHOLAR_ID], courseId: COURSE_ID });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID scholarId in the array (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, scholarIds: ['not-a-uuid'], courseId: COURSE_ID });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID courseId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, scholarIds: [SCHOLAR_ID], courseId: 'bad' });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects unknown fields (forbidNonWhitelisted => 400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ ...validBody, evilField: 'hack' });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('maps COURSE_NOT_FOUND to 404 when the course is outside the org', async () => {
      currentUser = ADMIN_A;
      service.create.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, scholarIds: [SCHOLAR_ID], courseId: ORG_B_COURSE_ID });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.create).toHaveBeenCalledWith(ORG_A, expect.anything(), ADMIN_A.id);
    });

    it('maps business-rule violations (INVALID_ROLE) to 400', async () => {
      currentUser = ADMIN_A;
      service.create.mockRejectedValue(
        new BadRequestException({ code: 'INVALID_ROLE', message: 'invalid role' }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_ROLE');
    });
  });

  // =========================================================================
  // PATCH /api/v1/mentor-assignments/:id — mentor_assignments.update (SUPER_ADMIN only)
  // =========================================================================
  describe('PATCH /api/v1/mentor-assignments/:id', () => {
    it('reassigns a mentor scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.reassign.mockResolvedValue({
        id: ASSIGNMENT_ID,
        mentor: { id: NEW_MENTOR_ID, name: 'New Mentor', email: 'nm@a.com' },
        scholar: { id: SCHOLAR_ID, email: 's@a.com' },
        course: { id: COURSE_ID, name: 'Financial Literacy 101' },
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: null,
        endedAt: null,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID, reason: 'unavailable' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(service.reassign).toHaveBeenCalledWith(
        ORG_A,
        ASSIGNMENT_ID,
        { newMentorId: NEW_MENTOR_ID, reason: 'unavailable' },
        ADMIN_A.id,
      );
    });

    it('returns 403 for SCHOLAR role (update -> SUPER_ADMIN only)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.reassign).not.toHaveBeenCalled();
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.reassign).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID newMentorId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({ newMentorId: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(service.reassign).not.toHaveBeenCalled();
    });

    it('rejects missing newMentorId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({});

      expect(res.status).toBe(400);
      expect(service.reassign).not.toHaveBeenCalled();
    });

    it('rejects reason that is not a string (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID, reason: 123 });

      expect(res.status).toBe(400);
      expect(service.reassign).not.toHaveBeenCalled();
    });

    it('maps ASSIGNMENT_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.reassign.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ORG_B_ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.reassign).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, expect.anything(), ADMIN_A.id);
    });
  });

  // =========================================================================
  // DELETE /api/v1/mentor-assignments/:id — mentor_assignments.delete (SUPER_ADMIN only)
  // =========================================================================
  describe('DELETE /api/v1/mentor-assignments/:id', () => {
    it('ends a mentor assignment scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.endAssignment.mockResolvedValue({
        id: ASSIGNMENT_ID,
        endedAt: '2026-01-01T00:00:00.000Z',
        message: 'Mentor pairing ended. Historical data is preserved.',
      });

      const res = await request(app.getHttpServer()).delete(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(service.endAssignment).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role (delete -> SUPER_ADMIN only)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).delete(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.endAssignment).not.toHaveBeenCalled();
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).delete(`/api/v1/mentor-assignments/${ASSIGNMENT_ID}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.endAssignment).not.toHaveBeenCalled();
    });

    it('maps ASSIGNMENT_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.endAssignment.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).delete(`/api/v1/mentor-assignments/${ORG_B_ASSIGNMENT_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.endAssignment).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A.id);
    });
  });

  // =========================================================================
  // Cross-tenant isolation at the HTTP boundary (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user creating a pairing for an ORG_B-owned course gets 404 COURSE_NOT_FOUND (no leak)', async () => {
      currentUser = ADMIN_A;
      // The service simulates the org-scoped miss for the ORG_B course.
      service.create.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/mentor-assignments')
        .send({ mentorId: MENTOR_ID, scholarIds: [SCHOLAR_ID], courseId: ORG_B_COURSE_ID });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      // Never leak any data about the other org.
      expect(res.body.data).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('org-bbb');
      // The caller org A, never org B.
      expect(service.create).toHaveBeenCalledWith(ORG_A, expect.anything(), ADMIN_A.id);
      expect(service.create).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    });

    it('ORG_A admin cannot reassign an ORG_B-owned assignment (404 ASSIGNMENT_NOT_FOUND, never reveal existence)', async () => {
      currentUser = ADMIN_A;
      service.reassign.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/mentor-assignments/${ORG_B_ASSIGNMENT_ID}`)
        .send({ newMentorId: NEW_MENTOR_ID });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('org-bbb');
      expect(service.reassign).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, expect.anything(), ADMIN_A.id);
      expect(service.reassign).not.toHaveBeenCalledWith(ORG_B, ORG_B_ASSIGNMENT_ID, expect.anything(), expect.anything());
    });

    it('ORG_A admin cannot end an ORG_B-owned assignment (404 ASSIGNMENT_NOT_FOUND)', async () => {
      currentUser = ADMIN_A;
      service.endAssignment.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).delete(`/api/v1/mentor-assignments/${ORG_B_ASSIGNMENT_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('org-bbb');
      expect(service.endAssignment).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A.id);
      expect(service.endAssignment).not.toHaveBeenCalledWith(ORG_B, ORG_B_ASSIGNMENT_ID, expect.anything());
    });

    it('ORG_A user reading as SCHOLAR is still org-scoped (service called with ORG_A never ORG_B)', async () => {
      currentUser = SCHOLAR_A;
      service.list.mockResolvedValue([
        {
          id: ASSIGNMENT_ID,
          mentor: { id: MENTOR_ID, name: 'M', email: 'm@a.com' },
          scholar: { id: SCHOLAR_ID, name: 'S', email: 's@a.com' },
          course: { id: COURSE_ID, name: 'C' },
          startsAt: null,
          endsAt: null,
          endedAt: null,
        },
      ]);

      const res = await request(app.getHttpServer()).get('/api/v1/mentor-assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_A, SCHOLAR_A);
      expect(service.list).not.toHaveBeenCalledWith(ORG_B, expect.anything());
    });
  });
});
