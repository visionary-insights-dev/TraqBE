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
import { AssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
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

// Shared shapes (UUIDs so DTO validation passes)
const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const COURSE_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_COURSE_ID = '7f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ASSIGNMENT_ID = '1f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_ASSIGNMENT_ID = '2f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const SCHOLAR_ID = '6f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const CHANGE_REQUEST_ID = '8f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_CHANGE_REQUEST_ID = '9f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';

const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };
const ADMIN_B: AuthUser = { id: 'u-admin-b', email: 'admin@b.com', organizationId: ORG_B, roles: [Role.SUPER_ADMIN] };

describe('AssignmentsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    list: vi.fn(),
    create: vi.fn(),
    findOne: vi.fn(),
    update: vi.fn(),
    publish: vi.fn(),
    submit: vi.fn(),
    verify: vi.fn(),
    createChangeRequest: vi.fn(),
    reviewChangeRequest: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AssignmentsController],
      providers: [
        { provide: AssignmentsService, useValue: service },
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
  // GET /api/v1/assignments — assignments.read (all roles)
  // =========================================================================
  describe('GET /api/v1/assignments', () => {
    it('lists assignments scoped to the caller org (200, envelope)', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 0 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      // TransformInterceptor wraps the service's paginated payload as-is.
      expect(res.body.data).toEqual(
        expect.objectContaining({
          data: [],
          meta: expect.objectContaining({ total: 0, totalPages: 0, page: 1, limit: 0 }),
        }),
      );
      expect(service.list).toHaveBeenCalledWith(ORG_A, ADMIN_A);
    });

    it('allows SCHOLAR to read (assignments.read -> SUPER_ADMIN,MENTOR,SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      service.list.mockResolvedValue({ data: [], meta: {} });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_A, SCHOLAR_A);
    });

    it('allows MENTOR to read', async () => {
      currentUser = MENTOR_A;
      service.list.mockResolvedValue({ data: [], meta: {} });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_A, MENTOR_A);
    });

    it('always passes the caller organizationId (cross-tenant at boundary)', async () => {
      currentUser = ADMIN_B;
      service.list.mockResolvedValue({ data: [], meta: {} });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(ORG_B, ADMIN_B);
      expect(service.list).not.toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it('rejects a user with no roles (403 INSUFFICIENT_PERMISSIONS)', async () => {
      currentUser = undefined as unknown as AuthUser;
      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('wraps a role-filtered response in the envelope', async () => {
      currentUser = SCHOLAR_A;
      service.list.mockResolvedValue({
        data: [
          {
            id: ASSIGNMENT_ID,
            title: 'Write a 500-word essay',
            dueAt: '2026-09-30T23:59:59.000Z',
            course: { id: COURSE_ID, name: 'Financial Literacy 101' },
          },
        ],
        meta: { total: 1, totalPages: 1, page: 1, limit: 1 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Paginated payload lives inside the envelope.
      expect(res.body.data.data).toHaveLength(1);
      expect(res.body.data.data[0]).toEqual(expect.objectContaining({ id: ASSIGNMENT_ID }));
      expect(res.body.data.data[0]).not.toHaveProperty('organization_id');
      expect(service.list).toHaveBeenCalledWith(ORG_A, SCHOLAR_A);
    });
  });

  // =========================================================================
  // POST /api/v1/assignments — assignments.create (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/assignments', () => {
    const validBody = {
      title: 'Write a 500-word essay',
      courseId: COURSE_ID,
      dueAt: '2026-09-30T23:59:59.000Z',
    };

    it('creates an assignment scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.create.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        status: 'DRAFT',
        dueAt: '2026-09-30T23:59:59.000Z',
        maxScore: 100,
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(res.body.data).toEqual(expect.objectContaining({ id: ASSIGNMENT_ID }));
      expect(service.create).toHaveBeenCalledWith(ORG_A, validBody, ADMIN_A.id);
    });

    it('allows MENTOR to create (assignments.create -> SUPER_ADMIN,MENTOR)', async () => {
      currentUser = MENTOR_A;
      service.create.mockResolvedValue({ id: ASSIGNMENT_ID });

      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(service.create).toHaveBeenCalledWith(ORG_A, validBody, MENTOR_A.id);
    });

    it('returns 403 for SCHOLAR role (create -> no SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send(validBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects missing dueAt (400 validation — dueAt is mandatory)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send({ title: 'X', courseId: COURSE_ID });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID courseId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send({ title: 'X', courseId: 'not-a-uuid', dueAt: '2026-09-30T23:59:59.000Z' });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects unknown fields (forbidNonWhitelisted => 400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send({ ...validBody, evilField: 'hack' });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects maxScore out of range (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send({ ...validBody, maxScore: 0 });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('maps COURSE_NOT_FOUND to 404 when the course is outside the org', async () => {
      currentUser = ADMIN_A;
      service.create.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/assignments')
        .send({ ...validBody, courseId: ORG_B_COURSE_ID });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.create).toHaveBeenCalledWith(ORG_A, expect.anything(), ADMIN_A.id);
      expect(service.create).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    });
  });

  // =========================================================================
  // GET /api/v1/assignments/:id — assignments.read (all roles)
  // =========================================================================
  describe('GET /api/v1/assignments/:id', () => {
    it('returns a single assignment for any authenticated role (200)', async () => {
      currentUser = ADMIN_A;
      service.findOne.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 500-word essay',
        status: 'PUBLISHED',
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/assignments/${ASSIGNMENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(res.body.data).toEqual(expect.objectContaining({ id: ASSIGNMENT_ID }));
      expect(service.findOne).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, ADMIN_A);
    });

    it('404s when the assignment does not exist in the caller org', async () => {
      currentUser = ADMIN_A;
      service.findOne.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.findOne).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A);
      expect(service.findOne).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    });

    it('forwards a non-UUID id to the service (no route-level UUID pipe; service owns validation)', async () => {
      currentUser = ADMIN_A;
      service.findOne.mockResolvedValue({ id: 'not-a-uuid' });

      const res = await request(app.getHttpServer()).get('/api/v1/assignments/not-a-uuid');

      expect(res.status).toBe(200);
      expect(service.findOne).toHaveBeenCalledWith(ORG_A, 'not-a-uuid', ADMIN_A);
    });
  });

  // =========================================================================
  // PATCH /api/v1/assignments/:id — assignments.update (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('PATCH /api/v1/assignments/:id', () => {
    it('updates an assignment scoped to the caller org (200)', async () => {
      currentUser = MENTOR_A;
      service.update.mockResolvedValue({
        id: ASSIGNMENT_ID,
        title: 'Write a 700-word essay',
        status: 'DRAFT',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}`)
        .send({ title: 'Write a 700-word essay' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toEqual({});
      expect(res.body.data).toEqual(expect.objectContaining({ title: 'Write a 700-word essay' }));
      expect(service.update).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, { title: 'Write a 700-word essay' }, MENTOR_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}`)
        .send({ title: 'Nope' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed dueAt with 400 validation', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}`)
        .send({ dueAt: 'not-a-date' });

      expect(res.status).toBe(400);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('404s on a cross-org assignment id (scoped lookup)', async () => {
      currentUser = ADMIN_A;
      service.update.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}`)
        .send({ title: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.update).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, expect.anything(), ADMIN_A.id);
      expect(service.update).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything(), expect.anything());
    });

    it('maps an expired edit window to 400 ASSIGNMENT_EDIT_WINDOW_EXPIRED', async () => {
      currentUser = ADMIN_A;
      service.update.mockRejectedValue(
        new BadRequestException({ code: 'ASSIGNMENT_EDIT_WINDOW_EXPIRED', message: 'Edit window expired' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}`)
        .send({ title: 'Too late' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSIGNMENT_EDIT_WINDOW_EXPIRED');
    });

    it('maps a closed/archived assignment to 400 ASSIGNMENT_NOT_EDITABLE', async () => {
      currentUser = ADMIN_A;
      service.update.mockRejectedValue(
        new BadRequestException({ code: 'ASSIGNMENT_NOT_EDITABLE', message: 'Not editable' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}`)
        .send({ title: 'Nope' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_EDITABLE');
    });
  });

  // =========================================================================
  // POST /api/v1/assignments/:id/publish — assignments.publish (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/assignments/:id/publish', () => {
    it('publishes a draft assignment (201 — POST default)', async () => {
      currentUser = ADMIN_A;
      service.publish.mockResolvedValue({
        id: ASSIGNMENT_ID,
        status: 'PUBLISHED',
        publishedAt: '2026-06-01T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/publish`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ status: 'PUBLISHED' }));
      expect(service.publish).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/publish`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.publish).not.toHaveBeenCalled();
    });

    it('404s on a cross-org assignment id', async () => {
      currentUser = ADMIN_A;
      service.publish.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignent not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/publish`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.publish).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A.id);
      expect(service.publish).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    });

    it('maps a non-draft publish attempt to 400 ASSIGNMENT_NOT_DRAFT', async () => {
      currentUser = MENTOR_A;
      service.publish.mockRejectedValue(
        new BadRequestException({ code: 'ASSIGNMENT_NOT_DRAFT', message: 'Not a draft' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/publish`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_DRAFT');
    });
  });

  // =========================================================================
  // POST /api/v1/assignments/:id/submissions — assignments.submit (SCHOLAR only)
  // =========================================================================
  describe('POST /api/v1/assignments/:id/submissions', () => {
    it('allows SCHOLAR to submit their own assignment (201)', async () => {
      currentUser = SCHOLAR_A;
      service.submit.mockResolvedValue({
        id: 'sub-1f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d',
        status: 'PENDING_VERIFICATION',
        submittedAt: '2026-09-29T10:00:00.000Z',
      });

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/submissions`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ status: 'PENDING_VERIFICATION' }));
      expect(service.submit).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, SCHOLAR_A);
    });

    it('returns 403 for SUPER_ADMIN role (submit -> SCHOLAR only)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/submissions`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.submit).not.toHaveBeenCalled();
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ASSIGNMENT_ID}/submissions`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.submit).not.toHaveBeenCalled();
    });

    it('404s when the assignment is unreachable for the caller org', async () => {
      currentUser = SCHOLAR_A;
      service.submit.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/submissions`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.submit).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, SCHOLAR_A);
      expect(service.submit).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    });
  });

  // =========================================================================
  // POST /api/v1/assignments/:id/verify — assignments.verify (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/assignments/:id/verify', () => {
    it('allows MENTOR to verify a scholar submission (201 — POST default)', async () => {
      currentUser = MENTOR_A;
      service.verify.mockResolvedValue({
        id: 'sub-1f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d',
        status: 'VERIFIED',
        earnedCredit: 100,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/verify`)
        .send({ scholarId: SCHOLAR_ID, action: 'VERIFY', feedback: 'Great work' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ status: 'VERIFIED' }));
      expect(service.verify).toHaveBeenCalledWith(
        ORG_A,
        ASSIGNMENT_ID,
        { scholarId: SCHOLAR_ID, action: 'VERIFY', feedback: 'Great work' },
        MENTOR_A,
      );
    });

    it('returns 403 for SCHOLAR role (verify -> no SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/verify`)
        .send({ scholarId: SCHOLAR_ID, action: 'VERIFY' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.verify).not.toHaveBeenCalled();
    });

    it('rejects an invalid action enum (400 validation)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/verify`)
        .send({ scholarId: SCHOLAR_ID, action: 'EXPLODE' });

      expect(res.status).toBe(400);
      expect(service.verify).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID scholarId (400 validation)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/verify`)
        .send({ scholarId: 'me', action: 'VERIFY' });

      expect(res.status).toBe(400);
      expect(service.verify).not.toHaveBeenCalled();
    });

    it('404s on a cross-org assignment id', async () => {
      currentUser = MENTOR_A;
      service.verify.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/verify`)
        .send({ scholarId: SCHOLAR_ID, action: 'VERIFY' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.verify).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, expect.anything(), MENTOR_A);
    });
  });

  // =========================================================================
  // POST /api/v1/assignments/:id/change-requests — assignments.request_change (MENTOR only)
  // =========================================================================
  describe('POST /api/v1/assignments/:id/change-requests', () => {
    const validBody = {
      field: 'dueAt',
      currentValue: '2026-09-30T23:59:59.000Z',
      requestedValue: '2026-10-07T23:59:59.000Z',
      reason: 'Please extend the deadline',
    };

    it('allows MENTOR to request a change (201)', async () => {
      currentUser = MENTOR_A;
      service.createChangeRequest.mockResolvedValue({
        id: CHANGE_REQUEST_ID,
        assignmentId: ASSIGNMENT_ID,
        field: 'dueAt',
        status: 'PENDING',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ id: CHANGE_REQUEST_ID, status: 'PENDING' }));
      expect(service.createChangeRequest).toHaveBeenCalledWith(ORG_A, ASSIGNMENT_ID, validBody, MENTOR_A.id);
    });

    it('returns 403 for SUPER_ADMIN (request_change -> MENTOR only)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests`)
        .send(validBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.createChangeRequest).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests`)
        .send(validBody);

      expect(res.status).toBe(403);
      expect(service.createChangeRequest).not.toHaveBeenCalled();
    });

    it('rejects a missing reason (400 validation)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests`)
        .send({ field: 'dueAt', requestedValue: '2026-10-07T23:59:59.000Z' });

      expect(res.status).toBe(400);
      expect(service.createChangeRequest).not.toHaveBeenCalled();
    });

    it('rejects a missing field (400 validation)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests`)
        .send({ reason: 'Please', requestedValue: '2026-10-07T23:59:59.000Z' });

      expect(res.status).toBe(400);
      expect(service.createChangeRequest).not.toHaveBeenCalled();
    });

    it('404s on a cross-org assignment id', async () => {
      currentUser = MENTOR_A;
      service.createChangeRequest.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/change-requests`)
        .send(validBody);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.createChangeRequest).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, validBody, MENTOR_A.id);
    });
  });

  // =========================================================================
  // PATCH /api/v1/assignments/:id/change-requests/:requestId
  //   — assignments.approve_change (SUPER_ADMIN only)
  // =========================================================================
  describe('PATCH /api/v1/assignments/:id/change-requests/:requestId', () => {
    it('allows SUPER_ADMIN to approve a change request (200)', async () => {
      currentUser = ADMIN_A;
      service.reviewChangeRequest.mockResolvedValue({
        id: CHANGE_REQUEST_ID,
        assignmentId: ASSIGNMENT_ID,
        status: 'APPROVED',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${CHANGE_REQUEST_ID}`)
        .send({ action: 'APPROVE', adminNote: 'Looks good' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({ status: 'APPROVED' }));
      expect(service.reviewChangeRequest).toHaveBeenCalledWith(
        ORG_A,
        ASSIGNMENT_ID,
        CHANGE_REQUEST_ID,
        { action: 'APPROVE', adminNote: 'Looks good' },
        ADMIN_A.id,
      );
    });

    it('returns 403 for MENTOR role (approve_change -> SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${CHANGE_REQUEST_ID}`)
        .send({ action: 'APPROVE' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.reviewChangeRequest).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${CHANGE_REQUEST_ID}`)
        .send({ action: 'APPROVE' });

      expect(res.status).toBe(403);
      expect(service.reviewChangeRequest).not.toHaveBeenCalled();
    });

    it('rejects an invalid action (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${CHANGE_REQUEST_ID}`)
        .send({ action: 'MAYBE' });

      expect(res.status).toBe(400);
      expect(service.reviewChangeRequest).not.toHaveBeenCalled();
    });

    it('404s on a cross-org change request id', async () => {
      currentUser = ADMIN_A;
      service.reviewChangeRequest.mockRejectedValue(
        new NotFoundException({ code: 'CHANGE_REQUEST_NOT_FOUND', message: 'Change request not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${ORG_B_CHANGE_REQUEST_ID}`)
        .send({ action: 'REJECT' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CHANGE_REQUEST_NOT_FOUND');
      expect(service.reviewChangeRequest).toHaveBeenCalledWith(
        ORG_A,
        ASSIGNMENT_ID,
        ORG_B_CHANGE_REQUEST_ID,
        expect.anything(),
        ADMIN_A.id,
      );
      expect(service.reviewChangeRequest).not.toHaveBeenCalledWith(
        ORG_B,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Cross-tenant boundary checks (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG A admin can never act on ORG B assignments (404 at service layer)', async () => {
      currentUser = ADMIN_A;
      service.findOne.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.findOne).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, ADMIN_A);
    });

    it('ORG A scholar cannot submit a course from ORG B', async () => {
      currentUser = SCHOLAR_A;
      service.submit.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/submissions`);

      expect(res.status).toBe(404);
      expect(service.submit).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, SCHOLAR_A);
    });

    it('ORG A mentor cannot request a change on an ORG B assignment', async () => {
      currentUser = MENTOR_A;
      service.createChangeRequest.mockRejectedValue(
        new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/assignments/${ORG_B_ASSIGNMENT_ID}/change-requests`)
        .send({ field: 'title', requestedValue: 'X', reason: 'r' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      expect(service.createChangeRequest).toHaveBeenCalledWith(ORG_A, ORG_B_ASSIGNMENT_ID, expect.anything(), MENTOR_A.id);
    });

    it('ORG A admin cannot review an ORG B change request', async () => {
      currentUser = ADMIN_A;
      service.reviewChangeRequest.mockRejectedValue(
        new NotFoundException({ code: 'CHANGE_REQUEST_NOT_FOUND', message: 'Change request not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assignments/${ASSIGNMENT_ID}/change-requests/${ORG_B_CHANGE_REQUEST_ID}`)
        .send({ action: 'APPROVE' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CHANGE_REQUEST_NOT_FOUND');
      expect(service.reviewChangeRequest).toHaveBeenCalledWith(
        ORG_A,
        ASSIGNMENT_ID,
        ORG_B_CHANGE_REQUEST_ID,
        expect.anything(),
        ADMIN_A.id,
      );
    });
  });
});