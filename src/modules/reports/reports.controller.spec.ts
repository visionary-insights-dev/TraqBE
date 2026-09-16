import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, CanActivate, ConflictException, ExecutionContext, GoneException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
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

describe('ReportsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    create: vi.fn(),
    get: vi.fn(),
    download: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: service },
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
  // POST /api/v1/reports
  // =========================================================================
  describe('POST /api/v1/reports', () => {
    it('returns 200 with rows + meta when generated synchronously', async () => {
      currentUser = ADMIN_A;
      service.create.mockResolvedValue({
        data: [{ id: 's-1', name: 'Ada', email: 'ada@example.com' }],
        meta: { count: 1, generated: true },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ type: 'scholars', format: 'csv' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.meta.count).toBe(1);
      expect(res.body.data.meta.generated).toBe(true);
      expect(service.create).toHaveBeenCalledWith(ORG_A, { type: 'scholars', format: 'csv' }, currentUser);
    });

    it('returns 202 with the report id when generation is queued (async path)', async () => {
      currentUser = ADMIN_A;
      service.create.mockResolvedValue({ id: 'rp-1', status: 'PENDING' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ type: 'attendance', format: 'csv', filters: { courseId: 'c-1' } });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBe('rp-1');
      expect(res.body.data.status).toBe('PENDING');
    });

    it('blocks MENTOR (reports.generate is SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ type: 'scholars', format: 'csv' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('returns 400 validation error for a missing report type', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ format: 'csv' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('returns 400 validation error for a non-CSV format', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ type: 'scholars', format: 'pdf' });

      expect(res.status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('propagates REPORT_TYPE_UNSUPPORTED as 400', async () => {
      currentUser = ADMIN_A;
      service.create.mockRejectedValue(
        new BadRequestException({
          code: 'REPORT_TYPE_UNSUPPORTED',
          message: 'Report type "payroll" is not supported',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/reports')
        .send({ type: 'payroll', format: 'csv' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('REPORT_TYPE_UNSUPPORTED');
    });
  });

  // =========================================================================
  // GET /api/v1/reports/:id (poll)
  // =========================================================================
  describe('GET /api/v1/reports/:id', () => {
    it('returns the report status payload', async () => {
      currentUser = ADMIN_A;
      service.get.mockResolvedValue({
        id: 'rp-1',
        status: 'PROCESSING',
        format: 'csv',
        createdAt: '2026-09-15T10:00:00.000Z',
        completedAt: null,
        expiresAt: null,
      });

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-1');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PROCESSING');
      expect(service.get).toHaveBeenCalledWith(ORG_A, 'rp-1');
    });

    it('maps a foreign/cross-org report id to 404', async () => {
      currentUser = ADMIN_A;
      service.get.mockRejectedValue(
        new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Report not found' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-foreign');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('REPORT_NOT_FOUND');
    });
  });

  // =========================================================================
  // GET /api/v1/reports/:id/download
  // =========================================================================
  describe('GET /api/v1/reports/:id/download', () => {
    it('returns a signed R2 download URL', async () => {
      currentUser = ADMIN_A;
      service.download.mockResolvedValue({ url: 'https://signed-url/csv', expiresInSeconds: 3600 });

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-1/download');

      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe('https://signed-url/csv');
      expect(res.body.data.expiresInSeconds).toBe(3600);
      expect(service.download).toHaveBeenCalledWith(ORG_A, 'rp-1');
    });

    it('maps REPORT_NOT_READY to 409', async () => {
      currentUser = ADMIN_A;
      service.download.mockRejectedValue(
        new ConflictException({ code: 'REPORT_NOT_READY', message: 'Report is not ready for download' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-1/download');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REPORT_NOT_READY');
    });

    it('maps REPORT_EXPIRED to 410', async () => {
      currentUser = ADMIN_A;
      service.download.mockRejectedValue(
        new GoneException({
          code: 'REPORT_EXPIRED',
          message: 'Report download link has expired',
        }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-1/download');

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('REPORT_EXPIRED');
    });

    it('blocks MENTOR (reports.read is SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer()).get('/api/v1/reports/rp-1/download');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.download).not.toHaveBeenCalled();
    });
  });
});