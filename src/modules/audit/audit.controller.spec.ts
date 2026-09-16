import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
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

describe('AuditController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    list: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: AuditService, useValue: service },
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
  // GET /api/v1/audit-logs
  // =========================================================================
  describe('GET /api/v1/audit-logs', () => {
    it('returns a paginated audit trail for SUPER_ADMIN (success envelope)', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue({
        data: [
          {
            id: 'log-1',
            organizationId: ORG_A,
            actorUserId: 'u-1',
            actorName: 'Ada Lovelace',
            eventType: 'PROGRAM_UPDATED',
            entityType: 'PROGRAM',
            entityId: 'prog-1',
            previousState: null,
            newState: null,
            metadata: null,
            ipAddress: null,
            createdAt: '2026-09-01T10:00:00.000Z',
          },
        ],
        meta: { total: 1, totalPages: 1, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/audit-logs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.data[0].eventType).toBe('PROGRAM_UPDATED');
      expect(res.body.data.data[0].actorName).toBe('Ada Lovelace');
      expect(res.body.data.meta.total).toBe(1);
      expect(service.list).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({ page: 1, limit: 25 }),
      );
    });

    it('forwards every filter query param to the service', async () => {
      currentUser = ADMIN_A;
      service.list.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 2, limit: 10 },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/audit-logs?entityType=PROGRAM&entityId=11111111-1111-1111-8111-111111111111&actorUserId=22222222-2222-2222-9222-222222222222&eventType=PROGRAM_UPDATED&dateFrom=2026-09-01T00%3A00%3A00.000Z&page=2&limit=10',
      );

      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({
          entityType: 'PROGRAM',
          entityId: '11111111-1111-1111-8111-111111111111',
          actorUserId: '22222222-2222-2222-9222-222222222222',
          eventType: 'PROGRAM_UPDATED',
          dateFrom: '2026-09-01T00:00:00.000Z',
          page: 2,
          limit: 10,
        }),
      );
    });

    it('denies MENTOR with 403 INSUFFICIENT_PERMISSIONS', async () => {
      currentUser = MENTOR_A;

      const res = await request(app.getHttpServer()).get('/api/v1/audit-logs');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('denies SCHOLAR with 403 INSUFFICIENT_PERMISSIONS', async () => {
      currentUser = SCHOLAR_A;

      const res = await request(app.getHttpServer()).get('/api/v1/audit-logs');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.list).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated requests with 401', async () => {
      // The real JwtAuthGuard denies when no bearer token is present. Simulate
      // that denial path by substituting a guard that throws UnauthorizedException.
      class ThrowingGuard implements CanActivate {
        canActivate(): boolean {
          throw new UnauthorizedException({
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          });
        }
      }
      const moduleRef = await Test.createTestingModule({
        controllers: [AuditController],
        providers: [
          { provide: AuditService, useValue: service },
          PermissionsGuard,
          Reflector,
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue(new ThrowingGuard())
        .compile();

      const guardedApp = moduleRef.createNestApplication();
      guardedApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      guardedApp.useGlobalFilters(new HttpExceptionFilter());
      guardedApp.useGlobalInterceptors(new TransformInterceptor());
      await guardedApp.init();

      const res = await request(guardedApp.getHttpServer()).get('/api/v1/audit-logs');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      await guardedApp.close();
    });

    it('rejects invalid filter values with 400 (validation)', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer()).get('/api/v1/audit-logs?dateFrom=not-a-date');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('rejects unknown query params with 400 (forbidNonWhitelisted)', async () => {
      currentUser = ADMIN_A;

      const res = await request(app.getHttpServer()).get('/api/v1/audit-logs?organizationId=org-b');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});