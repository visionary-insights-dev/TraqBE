import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  INestApplication,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Stubbed JwtAuthGuard
// ---------------------------------------------------------------------------
let currentUser: AuthUser | undefined;

class StubJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentUser === undefined) {
      throw new UnauthorizedException();
    }
    context.switchToHttp().getRequest().user = currentUser;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_A = 'org-aaa';

const ADMIN_A: AuthUser = {
  id: 'u-admin-a',
  email: 'admin@a.com',
  organizationId: ORG_A,
  roles: ['SUPER_ADMIN'],
};

const SCHOLAR_A: AuthUser = {
  id: 'u-scholar-a',
  email: 'scholar@a.com',
  organizationId: ORG_A,
  roles: ['SCHOLAR'],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('NotificationsController (functional / HTTP)', () => {
  let app: INestApplication;

  const service = {
    list: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    currentUser = ADMIN_A;

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: service },
        PermissionsGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtGuard())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // GET /api/v1/notifications
  // =========================================================================
  describe('GET /api/v1/notifications', () => {
    it('returns paginated notifications for the current user (200)', async () => {
      service.list.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/notifications',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.list).toHaveBeenCalledWith(
        ADMIN_A.id,
        expect.anything(),
      );
    });

    it('passes query params through to the service', async () => {
      service.list.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 10 },
      });

      await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .query({ page: '1', limit: '10', read: 'true' });

      expect(service.list).toHaveBeenCalledWith(
        ADMIN_A.id,
        expect.objectContaining({ read: 'true', page: 1, limit: 10 }),
      );
    });

    it('returns 200 with populated notification data', async () => {
      service.list.mockResolvedValue({
        data: [
          {
            id: 'n1',
            type: 'test',
            title: 'Hello',
            body: 'body',
            createdAt: '2026-09-14T10:00:00.000Z',
            readAt: null,
            metadata: null,
          },
        ],
        meta: { total: 1, totalPages: 1, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get(
        '/api/v1/notifications',
      );

      expect(res.status).toBe(200);
      expect(res.body.data.data).toHaveLength(1);
      expect(res.body.data.data[0].id).toBe('n1');
    });
  });

  // =========================================================================
  // PATCH /api/v1/notifications/:id/read
  // =========================================================================
  describe('PATCH /api/v1/notifications/:id/read', () => {
    it('marks a notification as read (200)', async () => {
      service.markRead.mockResolvedValue({
        notificationId: 'notif-1',
        readAt: '2026-09-14T10:00:00.000Z',
      });

      const res = await request(app.getHttpServer()).patch(
        '/api/v1/notifications/notif-1/read',
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.markRead).toHaveBeenCalledWith(ADMIN_A.id, 'notif-1');
    });
  });

  // =========================================================================
  // POST /api/v1/notifications/read-all
  // =========================================================================
  describe('POST /api/v1/notifications/read-all', () => {
    it('marks all notifications read and returns { updated } (201)', async () => {
      service.markAllRead.mockResolvedValue({ updated: 5 });

      const res = await request(app.getHttpServer()).post(
        '/api/v1/notifications/read-all',
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ updated: 5 });
      expect(service.markAllRead).toHaveBeenCalledWith(ADMIN_A.id);
    });
  });

  // =========================================================================
  // Auth & role tests
  // =========================================================================
  it('returns 401 when there is no token (unauthorized)', async () => {
    currentUser = undefined;

    const res = await request(app.getHttpServer()).get(
      '/api/v1/notifications',
    );

    expect(res.status).toBe(401);
  });

  it('allows SCHOLAR to list notifications (notifications.read)', async () => {
    currentUser = SCHOLAR_A;
    service.list.mockResolvedValue({
      data: [],
      meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
    });

    const res = await request(app.getHttpServer()).get(
      '/api/v1/notifications',
    );

    expect(res.status).toBe(200);
  });

  it('allows SCHOLAR to mark a notification read (notifications.update)', async () => {
    currentUser = SCHOLAR_A;
    service.markRead.mockResolvedValue({
      notificationId: 'notif-1',
      readAt: '2026-09-14T10:00:00.000Z',
    });

    const res = await request(app.getHttpServer()).patch(
      '/api/v1/notifications/notif-1/read',
    );

    expect(res.status).toBe(200);
  });

  it('allows SCHOLAR to mark all read (notifications.update)', async () => {
    currentUser = SCHOLAR_A;
    service.markAllRead.mockResolvedValue({ updated: 3 });

    const res = await request(app.getHttpServer()).post(
      '/api/v1/notifications/read-all',
    );

    expect(res.status).toBe(201);
  });

  // =========================================================================
  // Validation
  // =========================================================================
  it('rejects invalid query params (400) — page=0', async () => {
    currentUser = ADMIN_A;

    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ page: '0' });

    expect(res.status).toBe(400);
  });
});
