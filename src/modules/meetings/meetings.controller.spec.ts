import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Stubbed JwtAuthGuard
// ---------------------------------------------------------------------------
let currentUser: AuthUser;

class StubJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = currentUser;
    return true;
  }
}

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';
const COURSE_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const MEETING_ID = '4f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const ORG_B_MEETING_ID = '9f4a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';

const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

const VALID_MEETING_PAYLOAD = {
  title: 'Week 5 Check-in',
  courseId: COURSE_ID,
  scheduledAt: '2026-01-10T10:00:00.000Z',
  durationMinutes: 60,
  type: 'Lecture',
};

const MEETING_RESPONSE = {
  id: MEETING_ID,
  courseId: COURSE_ID,
  courseName: 'Financial Literacy 101',
  title: 'Week 5 Check-in',
  description: null,
  type: 'Lecture',
  durationMinutes: 60,
  scheduledAt: '2026-01-10T10:00:00.000Z',
  endsAt: '2026-01-10T11:00:00.000Z',
  recordedBy: 'u-mentor-a',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('MeetingsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    listMeetings: vi.fn(),
    createMeeting: vi.fn(),
    getMeeting: vi.fn(),
    getOne: vi.fn(),
    updateMeeting: vi.fn(),
    archiveMeeting: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [MeetingsController],
      providers: [
        { provide: MeetingsService, useValue: service },
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
  // GET /api/v1/meetings — meetings.read (all roles)
  // =========================================================================
  describe('GET /api/v1/meetings', () => {
    it('lists meetings scoped to the caller org (200)', async () => {
      currentUser = ADMIN_A;
      service.listMeetings.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/meetings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.listMeetings).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ page: 1, limit: 25 }), ADMIN_A);
    });

    it('allows MENTOR and SCHOLAR to read meetings', async () => {
      service.listMeetings.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      currentUser = MENTOR_A;
      expect((await request(app.getHttpServer()).get('/api/v1/meetings')).status).toBe(200);

      currentUser = SCHOLAR_A;
      expect((await request(app.getHttpServer()).get('/api/v1/meetings')).status).toBe(200);
    });

    it('passes courseId query filter through', async () => {
      currentUser = ADMIN_A;
      service.listMeetings.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      await request(app.getHttpServer()).get('/api/v1/meetings').query({ courseId: COURSE_ID });

      expect(service.listMeetings).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ courseId: COURSE_ID }), ADMIN_A);
    });

    it('always passes the caller organizationId (cross-tenant at boundary)', async () => {
      currentUser = { ...ADMIN_A, organizationId: ORG_B };
      service.listMeetings.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      await request(app.getHttpServer()).get('/api/v1/meetings');

      expect(service.listMeetings).toHaveBeenCalledWith(ORG_B, expect.anything(), expect.objectContaining({ organizationId: ORG_B }));
      expect(service.listMeetings).not.toHaveBeenCalledWith(ORG_A, expect.anything(), expect.anything());
    });
  });

  // =========================================================================
  // POST /api/v1/meetings — meetings.create (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/meetings', () => {
    it('creates a meeting scoped to the caller org (201)', async () => {
      currentUser = ADMIN_A;
      service.createMeeting.mockResolvedValue(MEETING_RESPONSE);

      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send(VALID_MEETING_PAYLOAD);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(MEETING_ID);
      expect(service.createMeeting).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({ title: 'Week 5 Check-in', type: 'Lecture' }),
        ADMIN_A.id,
      );
    });

    it('allows MENTOR to create meetings', async () => {
      currentUser = MENTOR_A;
      service.createMeeting.mockResolvedValue(MEETING_RESPONSE);

      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send(VALID_MEETING_PAYLOAD);

      expect(res.status).toBe(201);
    });

    it('returns 403 for SCHOLAR role (meetings.create)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send(VALID_MEETING_PAYLOAD);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.createMeeting).not.toHaveBeenCalled();
    });

    it('rejects missing title (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, title: undefined });

      expect(res.status).toBe(400);
      expect(service.createMeeting).not.toHaveBeenCalled();
    });

    it('rejects missing courseId (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, courseId: undefined });

      expect(res.status).toBe(400);
    });

    it('rejects non-UUID courseId (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, courseId: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });

    it('rejects missing scheduledAt (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, scheduledAt: undefined });

      expect(res.status).toBe(400);
    });

    it('rejects invalid scheduledAt (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, scheduledAt: 'tomorrow-ish' });

      expect(res.status).toBe(400);
    });

    it('rejects missing durationMinutes (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, durationMinutes: undefined });

      expect(res.status).toBe(400);
    });

    it('rejects durationMinutes <= 0 (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, durationMinutes: 0 });

      expect(res.status).toBe(400);
    });

    it('rejects missing type (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/meetings')
        .send({ ...VALID_MEETING_PAYLOAD, type: undefined });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // GET /api/v1/meetings/:id
  // =========================================================================
  describe('GET /api/v1/meetings/:id', () => {
    it('returns a meeting (200)', async () => {
      currentUser = ADMIN_A;
      service.getOne.mockResolvedValue(MEETING_RESPONSE);

      const res = await request(app.getHttpServer()).get(`/api/v1/meetings/${MEETING_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.getOne).toHaveBeenCalledWith(ORG_A, MEETING_ID);
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting (release-blocking)', async () => {
      currentUser = ADMIN_A;
      service.getOne.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/meetings/${ORG_B_MEETING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND');
    });
  });

  // =========================================================================
  // PATCH /api/v1/meetings/:id
  // =========================================================================
  describe('PATCH /api/v1/meetings/:id', () => {
    it('updates a meeting (200)', async () => {
      currentUser = ADMIN_A;
      service.updateMeeting.mockResolvedValue({ ...MEETING_RESPONSE, title: 'Renamed' });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}`)
        .send({ title: 'Renamed' });

      expect(res.status).toBe(200);
      expect(service.updateMeeting).toHaveBeenCalledWith(ORG_A, MEETING_ID, { title: 'Renamed' }, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role (meetings.update)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}`)
        .send({ title: 'X' });

      expect(res.status).toBe(403);
      expect(service.updateMeeting).not.toHaveBeenCalled();
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting', async () => {
      currentUser = ADMIN_A;
      service.updateMeeting.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${ORG_B_MEETING_ID}`)
        .send({ title: 'X' });

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // POST /api/v1/meetings/:id/archive
  // =========================================================================
  describe('POST /api/v1/meetings/:id/archive', () => {
    it('archives a meeting (201)', async () => {
      currentUser = ADMIN_A;
      service.archiveMeeting.mockResolvedValue({ id: MEETING_ID, archivedAt: '2026-01-01T00:00:00.000Z', message: 'Meeting archived. Historical data is preserved.' });

      const res = await request(app.getHttpServer()).post(`/api/v1/meetings/${MEETING_ID}/archive`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.archiveMeeting).toHaveBeenCalledWith(ORG_A, MEETING_ID, ADMIN_A.id);
    });

    it('returns 403 for MENTOR role (meetings.archive -> SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/meetings/${MEETING_ID}/archive`);

      expect(res.status).toBe(403);
      expect(service.archiveMeeting).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).post(`/api/v1/meetings/${MEETING_ID}/archive`);

      expect(res.status).toBe(403);
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting', async () => {
      currentUser = ADMIN_A;
      service.archiveMeeting.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer()).post(`/api/v1/meetings/${ORG_B_MEETING_ID}/archive`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND');
    });
  });
});