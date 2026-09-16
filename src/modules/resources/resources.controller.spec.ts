import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INestApplication, ValidationPipe, CanActivate, ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';
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

const ORG_A = '11111111-1111-4111-8111-111111111111';
const COURSE_A1 = '33333333-3333-4333-8333-333333333333';
const RESOURCE_ID = '55555555-5555-4555-8555-555555555555';
const VALID_PDF_KEY = `${ORG_A}/66666666-6666-4666-8666-666666666666.pdf`;

const ADMIN_A: AuthUser = { id: 'u-admin', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR_A: AuthUser = { id: 'u-mentor', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR_A: AuthUser = { id: 'u-scholar', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

describe('ResourcesController (functional / HTTP)', () => {
  let app: INestApplication;
  const service = {
    generateUploadUrl: vi.fn(),
    createResource: vi.fn(),
    listResources: vi.fn(),
    getResource: vi.fn(),
    archiveResource: vi.fn(),
  };

  const uploadBody = { fileName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 1024 };
  const createBody = { objectKey: VALID_PDF_KEY, originalName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 1024 };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ResourcesController],
      providers: [
        { provide: ResourcesService, useValue: service },
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
  // POST /api/v1/resources/upload-url — resources.upload (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/resources/upload-url', () => {
    it('returns 201 with uploadUrl, objectKey and expiresAt', async () => {
      currentUser = ADMIN_A;
      service.generateUploadUrl.mockResolvedValue({
        uploadUrl: 'https://upload.example.com/signed',
        objectKey: VALID_PDF_KEY,
        expiresAt: '2026-01-01T00:15:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/resources/upload-url')
        .send(uploadBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.objectKey).toBe(VALID_PDF_KEY);
      expect(service.generateUploadUrl).toHaveBeenCalledWith(ORG_A, uploadBody, ADMIN_A);
    });

    it('allows MENTOR (resources.upload)', async () => {
      currentUser = MENTOR_A;
      service.generateUploadUrl.mockResolvedValue({ uploadUrl: 'x', objectKey: VALID_PDF_KEY, expiresAt: '2026-01-01T00:15:00.000Z' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/resources/upload-url')
        .send(uploadBody);

      expect(res.status).toBe(201);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/resources/upload-url')
        .send(uploadBody);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(service.generateUploadUrl).not.toHaveBeenCalled();
    });

    it('rejects fileSize > 20MB with FILE_TOO_LARGE', async () => {
      currentUser = ADMIN_A;
      service.generateUploadUrl.mockRejectedValue(
        new (await import('@nestjs/common')).BadRequestException({
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds the maximum allowed size of 20 MB.',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/resources/upload-url')
        .send({ ...uploadBody, fileSize: 20 * 1024 * 1024 + 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('rejects invalid body fields (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/resources/upload-url')
        .send({ fileName: '', mimeType: '', fileSize: -5 });

      expect(res.status).toBe(400);
      expect(service.generateUploadUrl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/v1/resources — resources.create (SUPER_ADMIN, MENTOR)
  // =========================================================================
  describe('POST /api/v1/resources', () => {
    it('creates a resource record (201)', async () => {
      currentUser = ADMIN_A;
      service.createResource.mockResolvedValue({
        id: RESOURCE_ID,
        objectKey: VALID_PDF_KEY,
        originalName: 'notes.pdf',
        description: null,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        courseId: null,
        uploaderId: ADMIN_A.id,
        createdAt: '2026-01-01T00:00:00.000Z',
        course: null,
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/resources')
        .send(createBody);

      expect(res.status).toBe(201);
      expect(res.body.data.objectKey).toBe(VALID_PDF_KEY);
      expect(service.createResource).toHaveBeenCalledWith(ORG_A, createBody, ADMIN_A.id);
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/resources')
        .send(createBody);

      expect(res.status).toBe(403);
      expect(service.createResource).not.toHaveBeenCalled();
    });

    it('rejects missing required fields (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/resources')
        .send({ originalName: 'notes.pdf' });

      expect(res.status).toBe(400);
    });

    it('rejects a forbidden unknown field (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .post('/api/v1/resources')
        .send({ ...createBody, evil: true });

      expect(res.status).toBe(400);
      expect(service.createResource).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/v1/resources — resources.read (all roles)
  // =========================================================================
  describe('GET /api/v1/resources', () => {
    it('lists resources (200) with pagination meta', async () => {
      currentUser = ADMIN_A;
      service.listResources.mockResolvedValue({
        data: [],
        meta: { total: 0, totalPages: 0, page: 1, limit: 25 },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/resources');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.listResources).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({ page: 1, limit: 25 }),
        ADMIN_A,
      );
    });

    it('allows SCHOLAR to read (resources.read)', async () => {
      currentUser = SCHOLAR_A;
      service.listResources.mockResolvedValue({ data: [], meta: { total: 0, totalPages: 0, page: 1, limit: 25 } });

      const res = await request(app.getHttpServer()).get('/api/v1/resources');

      expect(res.status).toBe(200);
    });

    it('rejects a non-UUID courseId filter (400)', async () => {
      currentUser = ADMIN_A;
      const res = await request(app.getHttpServer())
        .get('/api/v1/resources')
        .query({ courseId: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // GET /api/v1/resources/:id — resources.read
  // =========================================================================
  describe('GET /api/v1/resources/:id', () => {
    it('returns the resource with a download URL (200)', async () => {
      currentUser = ADMIN_A;
      service.getResource.mockResolvedValue({
        id: RESOURCE_ID,
        objectKey: VALID_PDF_KEY,
        downloadUrl: 'https://download.example.com/signed',
        expiresIn: 3600,
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toBe('https://download.example.com/signed');
      expect(service.getResource).toHaveBeenCalledWith(ORG_A, RESOURCE_ID, ADMIN_A);
    });

    it('maps RESOURCE_NOT_FOUND to 404 (cross-org / non-existent)', async () => {
      currentUser = ADMIN_A;
      service.getResource.mockRejectedValue(
        new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }),
      );

      const res = await request(app.getHttpServer()).get(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  // =========================================================================
  // DELETE /api/v1/resources/:id — resources.delete (SUPER_ADMIN only)
  // =========================================================================
  describe('DELETE /api/v1/resources/:id', () => {
    it('soft-archives a resource (200)', async () => {
      currentUser = ADMIN_A;
      service.archiveResource.mockResolvedValue({
        id: RESOURCE_ID,
        archivedAt: '2026-01-01T00:00:00.000Z',
        objectKey: VALID_PDF_KEY,
        message: 'Resource archived.',
      });

      const res = await request(app.getHttpServer()).delete(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(service.archiveResource).toHaveBeenCalledWith(ORG_A, RESOURCE_ID, ADMIN_A.id);
    });

    it('returns 403 for MENTOR role (resources.delete -> SUPER_ADMIN only)', async () => {
      currentUser = MENTOR_A;
      const res = await request(app.getHttpServer()).delete(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(403);
      expect(service.archiveResource).not.toHaveBeenCalled();
    });

    it('returns 403 for SCHOLAR role', async () => {
      currentUser = SCHOLAR_A;
      const res = await request(app.getHttpServer()).delete(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(403);
    });

    it('maps RESOURCE_NOT_FOUND to 404', async () => {
      currentUser = ADMIN_A;
      service.archiveResource.mockRejectedValue(
        new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }),
      );

      const res = await request(app.getHttpServer()).delete(`/api/v1/resources/${RESOURCE_ID}`);

      expect(res.status).toBe(404);
    });
  });
});