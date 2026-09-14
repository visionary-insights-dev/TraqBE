import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
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
const MEETING_ID = '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';
const SCHOLAR_ID = '5f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d';

const ADMIN_A: AuthUser = { id: 'u-admin-a', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor-a', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

describe('AttendanceController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    recordBulk: vi.fn(),
    correct: vi.fn(),
    history: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AttendanceController],
      providers: [
        { provide: AttendanceService, useValue: service },
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
  // POST /api/v1/meetings/:id/attendance — attendance.create (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/meetings/:id/attendance', () => {
    it('creates bulk attendance records (201)', async () => {
      currentUser = ADMIN_A;
      service.recordBulk.mockResolvedValue({
        meetingId: MEETING_ID,
        records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT', isNew: true }],
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({
          records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(service.recordBulk).toHaveBeenCalledWith(
        ORG_A,
        MEETING_ID,
        { records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }] },
        ADMIN_A.id,
      );
    });

    it('allows MENTOR to record attendance', async () => {
      currentUser = MENTOR_A;
      service.recordBulk.mockResolvedValue({ meetingId: MEETING_ID, records: [] });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }] });

      expect(res.status).toBe(201);
    });

    it('returns 403 for SCHOLAR role (attendance.create)', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.recordBulk).not.toHaveBeenCalled();
    });

    it('rejects empty records array (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [] });

      expect(res.status).toBe(400);
      expect(service.recordBulk).not.toHaveBeenCalled();
    });

    it('rejects invalid AttendanceStatus enum value (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: SCHOLAR_ID, status: 'SUSPENDED' }] });

      expect(res.status).toBe(400);
      expect(service.recordBulk).not.toHaveBeenCalled();
    });

    it('rejects non-UUID scholarId (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: 'not-a-uuid', status: 'PRESENT' }] });

      expect(res.status).toBe(400);
    });

    it('maps SCHOLAR_NOT_ENROLLED to 403', async () => {
      currentUser = ADMIN_A;
      service.recordBulk.mockRejectedValue(
        new (await import('@nestjs/common')).ForbiddenException({
          code: 'SCHOLAR_NOT_ENROLLED',
          message: 'Scholars not enrolled',
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SCHOLAR_NOT_ENROLLED');
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting (release-blocking)', async () => {
      currentUser = ADMIN_A;
      service.recordBulk.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/meetings/${MEETING_ID}/attendance`)
        .send({ records: [{ scholarId: SCHOLAR_ID, status: 'PRESENT' }] });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND');
    });
  });

  // =========================================================================
  // PATCH /api/v1/meetings/:id/attendance/:scholarId — attendance.correct (SUPER_ADMIN only)
  // =========================================================================
  describe('PATCH /api/v1/meetings/:id/attendance/:scholarId', () => {
    it('corrects an attendance record (200)', async () => {
      currentUser = ADMIN_A;
      service.correct.mockResolvedValue({
        id: 'att-1',
        previousStatus: 'ABSENT',
        status: 'PRESENT',
        correctionReason: 'was present',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'PRESENT', correctionReason: 'was present' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.correct).toHaveBeenCalledWith(
        ORG_A,
        MEETING_ID,
        SCHOLAR_ID,
        { status: 'PRESENT', correctionReason: 'was present' },
        ADMIN_A.id,
      );
    });

    it('returns 403 for MENTOR role (attendance.correct -> SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'PRESENT', correctionReason: 'fix' });

      expect(res.status).toBe(403);
      expect(service.correct).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'PRESENT', correctionReason: 'fix' });

      expect(res.status).toBe(403);
    });

    it('rejects invalid status enum (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'SUSPENDED', correctionReason: 'fix' });

      expect(res.status).toBe(400);
      expect(service.correct).not.toHaveBeenCalled();
    });

    it('rejects missing correctionReason (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'PRESENT' });

      expect(res.status).toBe(400);
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting', async () => {
      currentUser = ADMIN_A;
      service.correct.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/meetings/${MEETING_ID}/attendance/${SCHOLAR_ID}`)
        .send({ status: 'PRESENT', correctionReason: 'fix' });

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // GET /api/v1/meetings/:id/attendance/history — attendance.read (all roles)
  // =========================================================================
  describe('GET /api/v1/meetings/:id/attendance/history', () => {
    it('returns corrections history (200)', async () => {
      currentUser = ADMIN_A;
      service.history.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 0 },
      });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/meetings/${MEETING_ID}/attendance/history`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.history).toHaveBeenCalledWith(ORG_A, MEETING_ID);
    });

    it('allows SCHOLAR to read attendance history (attendance.read)', async () => {
      currentUser = SCHOLAR_A;
      service.history.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 0 } });

      const res = await request(app.getHttpServer()).get(
        `/api/v1/meetings/${MEETING_ID}/attendance/history`,
      );

      expect(res.status).toBe(200);
    });

    it('maps MEETING_NOT_FOUND to 404 for a cross-org meeting', async () => {
      currentUser = ADMIN_A;
      service.history.mockRejectedValue(
        new NotFoundException({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }),
      );

      const res = await request(app.getHttpServer()).get(
        `/api/v1/meetings/${MEETING_ID}/attendance/history`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEETING_NOT_FOUND');
    });
  });
});