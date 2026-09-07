import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { CoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';
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
const COURSE_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_COURSE_ID = '9f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const PROGRAM_ID = '4f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_PROGRAM_ID = '7f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const MEMBER_USER = '5f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_USER = '6f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };
const ADMIN_B: AuthUser = { id: 'u-admin-b', email: 'admin@b.com', organizationId: ORG_B, roles: [Role.SUPER_ADMIN] };

describe('CoursesController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    listCourses: vi.fn(),
    createCourse: vi.fn(),
    getCourse: vi.fn(),
    updateCourse: vi.fn(),
    archiveCourse: vi.fn(),
    listCourseMembers: vi.fn(),
    addCourseMember: vi.fn(),
    removeCourseMember: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [
        { provide: CoursesService, useValue: service },
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
  // GET /api/v1/courses — courses.read (all roles)
  // =========================================================================
  describe('GET /api/v1/courses', () => {
    it('lists courses scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.listCourses.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/courses');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.listCourses).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ page: 1, limit: 25 }));
    });

    it('allows SCHOLAR to read courses (courses.read -> SUPER_ADMIN,MENTOR,SCHOLAR)', async () => {
      currentUser = SCHOLAR_A;
      service.listCourses.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/courses');

      expect(res.status).toBe(200);
    });

    it('allows MENTOR to read courses', async () => {
      currentUser = MENTOR_A;
      service.listCourses.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/courses');

      expect(res.status).toBe(200);
    });

    it('always passes the caller organizationId (cross-tenant at boundary)', async () => {
      currentUser = ADMIN_B;
      service.listCourses.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/courses');

      expect(res.status).toBe(200);
      expect(service.listCourses).toHaveBeenCalledWith(ORG_B, expect.anything());
      expect(service.listCourses).not.toHaveBeenCalledWith(ORG_A, expect.anything());
    });

    it('rejects a user with no roles (403 INSUFFICIENT_PERMISSIONS)', async () => {
      currentUser = undefined as unknown as AuthUser;
      const res = await request(app.getHttpServer()).get('/api/v1/courses');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.listCourses).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/v1/courses — courses.create (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/courses', () => {
    it('creates a course scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.createCourse.mockResolvedValue({
        id: COURSE_ID,
        programId: PROGRAM_ID,
        name: 'Financial Literacy 101',
        description: 'desc',
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: PROGRAM_ID, name: 'Financial Literacy 101', description: 'desc' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.createCourse).toHaveBeenCalledWith(
        ORG_A,
        { programId: PROGRAM_ID, name: 'Financial Literacy 101', description: 'desc' },
        ADMIN_A.id,
      );
    });

    it('returns 403 for SCHOLAR role (courses.create -> SUPER_ADMIN only)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: PROGRAM_ID, name: 'Nope' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.createCourse).not.toHaveBeenCalled();
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: PROGRAM_ID, name: 'Nope' });

      expect(res.status).toBe(403);
      expect(service.createCourse).not.toHaveBeenCalled();
    });

    it('rejects missing name (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: PROGRAM_ID });

      expect(res.status).toBe(400);
      expect(service.createCourse).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID programId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: 'not-a-uuid', name: 'X' });

      expect(res.status).toBe(400);
      expect(service.createCourse).not.toHaveBeenCalled();
    });

    it('maps PROGRAM_NOT_FOUND to 404 when the program is outside the org', async () => {
      currentUser = ADMIN_A;
      service.createCourse.mockRejectedValue(
        new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: 'Program not found' }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/courses')
        .send({ programId: ORG_B_PROGRAM_ID, name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
      expect(service.createCourse).toHaveBeenCalledWith(ORG_A, expect.anything(), ADMIN_A.id);
    });
  });

  // =========================================================================
  // GET /api/v1/courses/:id — courses.read (all roles), org-scoped 404
  // =========================================================================
  describe('GET /api/v1/courses/:id', () => {
    it('returns a course scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.getCourse.mockResolvedValue({
        id: COURSE_ID,
        programId: PROGRAM_ID,
        name: 'Financial Literacy 101',
        program: { id: PROGRAM_ID, name: 'TMF' },
        assignmentCount: 3,
        memberCount: 5,
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${COURSE_ID}`);

      expect(res.status).toBe(200);
      expect(service.getCourse).toHaveBeenCalledWith(ORG_A, COURSE_ID);
    });

    it('maps COURSE_NOT_FOUND to 404 (cross-tenant must not leak)', async () => {
      currentUser = ADMIN_A;
      service.getCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${ORG_B_COURSE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.getCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID);
    });

    it('allows SCHOLAR to read a course', async () => {
      currentUser = SCHOLAR_A;
      service.getCourse.mockResolvedValue({ id: COURSE_ID, name: 'C', program: {} });

      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${COURSE_ID}`);

      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // PATCH /api/v1/courses/:id — courses.update (SUPER_ADMIN only)
  // =========================================================================
  describe('PATCH /api/v1/courses/:id', () => {
    it('updates a course scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.updateCourse.mockResolvedValue({ id: COURSE_ID, name: 'Renamed' });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/courses/${COURSE_ID}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(service.updateCourse).toHaveBeenCalledWith(ORG_A, COURSE_ID, { name: 'Renamed' }, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/courses/${COURSE_ID}`)
        .send({ name: 'X' });

      expect(res.status).toBe(403);
      expect(service.updateCourse).not.toHaveBeenCalled();
    });

    it('maps COURSE_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.updateCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/courses/${ORG_B_COURSE_ID}`)
        .send({ name: 'H4ck' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.updateCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID, { name: 'H4ck' }, ADMIN_A.id);
    });
  });

  // =========================================================================
  // POST /api/v1/courses/:id/archive — courses.archive (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/courses/:id/archive', () => {
    it('archives a course scoped to the caller org', async () => {
      currentUser = ADMIN_A;
      service.archiveCourse.mockResolvedValue({
        id: COURSE_ID,
        archivedAt: '2026-01-01T00:00:00.000Z',
        message: 'Course archived. Historical data is preserved.',
      });

      const res = await request(app.getHttpServer()).post(`/api/v1/courses/${COURSE_ID}/archive`);

      expect(res.status).toBe(201); // @Post default status
      expect(service.archiveCourse).toHaveBeenCalledWith(ORG_A, COURSE_ID, ADMIN_A.id);
    });

    it('returns 403 for MENTOR role', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/courses/${COURSE_ID}/archive`);

      expect(res.status).toBe(403);
      expect(service.archiveCourse).not.toHaveBeenCalled();
    });

    it('maps COURSE_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.archiveCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/courses/${ORG_B_COURSE_ID}/archive`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.archiveCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID, ADMIN_A.id);
    });
  });

  // =========================================================================
  // GET /api/v1/courses/:id/members — courses.read (all roles)
  // =========================================================================
  describe('GET /api/v1/courses/:id/members', () => {
    it('lists members scoped to the caller org', async () => {
      currentUser = ADMIN_A;
      service.listCourseMembers.mockResolvedValue({
        courseId: COURSE_ID,
        members: [],
        summary: { total: 0 },
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${COURSE_ID}/members`);

      expect(res.status).toBe(200);
      expect(service.listCourseMembers).toHaveBeenCalledWith(ORG_A, COURSE_ID);
    });

    it('maps COURSE_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.listCourseMembers.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${ORG_B_COURSE_ID}/members`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
    });
  });

  // =========================================================================
  // POST /api/v1/courses/:id/members — courses.manage_members (SUPER_ADMIN only)
  // =========================================================================
  describe('POST /api/v1/courses/:id/members', () => {
    it('adds a member scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.addCourseMember.mockResolvedValue({ id: 'cm-1', courseId: COURSE_ID, userId: MEMBER_USER });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/courses/${COURSE_ID}/members`)
        .send({ userId: MEMBER_USER });

      expect(res.status).toBe(201);
      expect(service.addCourseMember).toHaveBeenCalledWith(ORG_A, COURSE_ID, { userId: MEMBER_USER }, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role (manage_members -> SUPER_ADMIN)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/courses/${COURSE_ID}/members`)
        .send({ userId: MEMBER_USER });

      expect(res.status).toBe(403);
      expect(service.addCourseMember).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID userId (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/courses/${COURSE_ID}/members`)
        .send({ userId: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(service.addCourseMember).not.toHaveBeenCalled();
    });

    it('maps USER_NOT_FOUND to 404 when adding an out-of-org user', async () => {
      currentUser = ADMIN_A;
      service.addCourseMember.mockRejectedValue(
        new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/courses/${COURSE_ID}/members`)
        .send({ userId: ORG_B_USER });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
      expect(service.addCourseMember).toHaveBeenCalledWith(ORG_A, COURSE_ID, expect.anything(), ADMIN_A.id);
    });
  });

  // =========================================================================
  // DELETE /api/v1/courses/:id/members/:userId — courses.manage_members
  // =========================================================================
  describe('DELETE /api/v1/courses/:id/members/:userId', () => {
    it('removes a member scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.removeCourseMember.mockResolvedValue({ removed: true, courseId: COURSE_ID, userId: MEMBER_USER });

      const res = await request(app.getHttpServer()).delete(`/api/v1/courses/${COURSE_ID}/members/${MEMBER_USER}`);

      expect(res.status).toBe(200);
      expect(service.removeCourseMember).toHaveBeenCalledWith(ORG_A, COURSE_ID, MEMBER_USER, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).delete(`/api/v1/courses/${COURSE_ID}/members/${MEMBER_USER}`);

      expect(res.status).toBe(403);
      expect(service.removeCourseMember).not.toHaveBeenCalled();
    });

    it('maps COURSE_NOT_FOUND to 404 on cross-tenant org-miss', async () => {
      currentUser = ADMIN_A;
      service.removeCourseMember.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer()).delete(`/api/v1/courses/${ORG_B_COURSE_ID}/members/${MEMBER_USER}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.removeCourseMember).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID, MEMBER_USER, ADMIN_A.id);
    });
  });

  // =========================================================================
  // Cross-tenant isolation at the HTTP boundary (release-blocking)
  // =========================================================================
  describe('cross-tenant isolation (release-blocking)', () => {
    it('ORG_A user reading an ORG_B-owned course id returns 404 COURSE_NOT_FOUND (no leak)', async () => {
      currentUser = ADMIN_A;
      service.getCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${ORG_B_COURSE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.getCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID);
      expect(service.getCourse).not.toHaveBeenCalledWith(ORG_B, ORG_B_COURSE_ID);
    });

    it('ORG_A admin cannot patch an ORG_B-owned course (404, never 200/403 data leak)', async () => {
      currentUser = ADMIN_A;
      service.updateCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/courses/${ORG_B_COURSE_ID}`)
        .send({ name: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.updateCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID, { name: 'X' }, ADMIN_A.id);
    });

    it('ORG_A admin cannot archive an ORG_B-owned course (404)', async () => {
      currentUser = ADMIN_A;
      service.archiveCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer()).post(`/api/v1/courses/${ORG_B_COURSE_ID}/archive`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
      expect(service.archiveCourse).toHaveBeenCalledWith(ORG_A, ORG_B_COURSE_ID, ADMIN_A.id);
    });

    it('ORG_A admin cannot list members of an ORG_B-owned course (404)', async () => {
      currentUser = ADMIN_A;
      service.listCourseMembers.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${ORG_B_COURSE_ID}/members`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
    });

    it('ORG_A admin cannot remove a member from an ORG_B-owned course (404)', async () => {
      currentUser = ADMIN_A;
      service.removeCourseMember.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer()).delete(`/api/v1/courses/${ORG_B_COURSE_ID}/members/${MEMBER_USER}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
    });

    it('ORG_A user reading an ORG_B course as SCHOLAR is still denied access to the foreign resource (404)', async () => {
      currentUser = SCHOLAR_A;
      service.getCourse.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );
      
      const res = await request(app.getHttpServer()).get(`/api/v1/courses/${ORG_B_COURSE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
    });
  });
});
