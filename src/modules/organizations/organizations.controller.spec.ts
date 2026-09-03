import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
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

const DEFAULTS = {
  assignmentWeight: 0.7,
  attendanceWeight: 0.3,
  atRiskAttendanceThreshold: 70,
  atRiskAssignmentThreshold: 60,
  atRiskOverdueThreshold: 3,
  lateSubmissionPenaltyPercentage: 20,
  assignmentEditWindowMinutes: 60,
  invitationExpiryHours: 48,
};

describe('OrganizationsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: OrganizationsService, useValue: service },
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
  // GET /organization/settings — all authenticated roles can read
  // =========================================================================
  describe('GET /organization/settings', () => {
    it('returns settings for the caller\'s org (200 + success envelope)', async () => {
      currentUser = ADMIN_A;
      service.getSettings.mockResolvedValue(DEFAULTS);

      const res = await request(app.getHttpServer()).get('/api/v1/organization/settings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.assignmentWeight).toBe(0.7);
      // org scoping: service must receive the caller's org
      expect(service.getSettings).toHaveBeenCalledWith(ORG_A);
    });

    it('is readable by MENTOR and SCHOLAR roles (settings.read is broad)', async () => {
      for (const user of [MENTOR_A, SCHOLAR_A]) {
        currentUser = user;
        service.getSettings.mockResolvedValue(DEFAULTS);
        const res = await request(app.getHttpServer()).get('/api/v1/organization/settings');
        expect(res.status).toBe(200);
        expect(service.getSettings).toHaveBeenCalledWith(ORG_A);
      }
    });
  });

  // =========================================================================
  // PATCH /organization/settings — SUPER_ADMIN only
  // =========================================================================
  describe('PATCH /organization/settings', () => {
    it('updates settings scoped to the caller\'s org, actor is audit logged', async () => {
      currentUser = ADMIN_A;
      service.updateSettings.mockResolvedValue({ ...DEFAULTS, attendanceWeight: 0.3 });

      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 0.7, attendanceWeight: 0.3 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.updateSettings).toHaveBeenCalledWith(
        ORG_A,
        { assignmentWeight: 0.7, attendanceWeight: 0.3 },
        ADMIN_A.id,
      );
    });

    it('returns 403 when a MENTOR tries to update settings', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 0.7 });
      expect(res.status).toBe(403);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('returns 403 when a SCHOLAR tries to update settings', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 0.7 });
      expect(res.status).toBe(403);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range weight (0.7 + 1.2 -> attendanceWeight > 1) as 400 validation', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 0.7, attendanceWeight: 1.2 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('rejects a forbidden unknown field (400 validation, forbidNonWhitelisted)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ someUnknownField: true });
      expect(res.status).toBe(400);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric weight (400 validation)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 'high' });
      expect(res.status).toBe(400);
      expect(service.updateSettings).not.toHaveBeenCalled();
    });

    it('maps INVALID_WEIGHT_SUM business error to a 400 error envelope', async () => {
      currentUser = ADMIN_A;
      service.updateSettings.mockRejectedValue(
        new BadRequestException({
          code: 'INVALID_WEIGHT_SUM',
          message: 'assignmentWeight + attendanceWeight must equal 1.0',
        }),
      );

      const res = await request(app.getHttpServer())
        .patch('/api/v1/organization/settings')
        .send({ assignmentWeight: 0.6, attendanceWeight: 0.3 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_WEIGHT_SUM');
    });
  });
});
