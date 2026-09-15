import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
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
const SCHOLAR_A: AuthUser = { id: 'u-scholar-a', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

describe('AnalyticsController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    getDashboard: vi.fn(),
    getScholarProgress: vi.fn(),
    getCourseMetrics: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: AnalyticsService, useValue: service },
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
  // GET /analytics/dashboard
  // =========================================================================
  describe('GET /api/v1/analytics/dashboard', () => {
    it('returns org-wide dashboard metrics for SUPER_ADMIN (success envelope)', async () => {
      currentUser = ADMIN_A;
      service.getDashboard.mockResolvedValue({
        totalScholars: 12,
        activeScholars: 10,
        atRiskCount: 3,
        avgProgramProgress: 78.4,
        avgAttendanceRate: 85.2,
        pendingVerificationCount: 2,
        overdueCount: 4,
        recentActivity: [],
      });

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalScholars).toBe(12);
      expect(res.body.data.atRiskCount).toBe(3);
      expect(service.getDashboard).toHaveBeenCalledWith(ORG_A, currentUser);
    });

    it('allows SCHOLAR (analytics.read is available to every authenticated role)', async () => {
      currentUser = SCHOLAR_A;
      service.getDashboard.mockResolvedValue({ totalScholars: 1 });

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/dashboard');

      expect(res.status).toBe(200);
      expect(service.getDashboard).toHaveBeenCalledWith(ORG_A, currentUser);
    });
  });

  // =========================================================================
  // GET /analytics/scholars/:id/progress
  // =========================================================================
  describe('GET /api/v1/analytics/scholars/:id/progress', () => {
    it('returns a scholar progress payload', async () => {
      currentUser = ADMIN_A;
      service.getScholarProgress.mockResolvedValue({
        scholarId: 'u-1',
        assignmentScore: 80,
        attendanceRate: 100,
        overallProgress: 86,
        isAtRisk: false,
        overdueCount: 0,
        perCourse: [],
      });

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/scholars/u-1/progress');

      expect(res.status).toBe(200);
      expect(res.body.data.scholarId).toBe('u-1');
      expect(res.body.data.overallProgress).toBe(86);
      expect(service.getScholarProgress).toHaveBeenCalledWith(ORG_A, 'u-1', currentUser);
    });

    it('maps SCHOLAR_NOT_FOUND to 404', async () => {
      currentUser = ADMIN_A;
      service.getScholarProgress.mockRejectedValue(
        new NotFoundException({ code: 'SCHOLAR_NOT_FOUND', message: 'Scholar not found' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/scholars/u-999/progress');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SCHOLAR_NOT_FOUND');
    });

    it('maps peer-access denial to 403', async () => {
      currentUser = SCHOLAR_A;
      service.getScholarProgress.mockRejectedValue(
        new ForbiddenException({ code: 'FORBIDDEN', message: 'not paired' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/scholars/u-2/progress');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // =========================================================================
  // GET /analytics/courses/:id
  // =========================================================================
  describe('GET /api/v1/analytics/courses/:id', () => {
    it('returns course metrics', async () => {
      currentUser = ADMIN_A;
      service.getCourseMetrics.mockResolvedValue({
        courseId: 'c-1',
        courseName: 'Course A',
        totalMembers: 5,
        atRiskCount: 1,
        avgProgress: 70,
        avgAttendanceRate: 80,
        assignmentCompletionRates: [],
        members: [],
      });

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/courses/c-1');

      expect(res.status).toBe(200);
      expect(res.body.data.courseName).toBe('Course A');
      expect(res.body.data.totalMembers).toBe(5);
      expect(service.getCourseMetrics).toHaveBeenCalledWith(ORG_A, 'c-1', currentUser);
    });

    it('maps COURSE_NOT_FOUND to 404', async () => {
      currentUser = ADMIN_A;
      service.getCourseMetrics.mockRejectedValue(
        new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course not found' }),
      );

      const res = await request(app.getHttpServer()).get('/api/v1/analytics/courses/c-999');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COURSE_NOT_FOUND');
    });
  });
});