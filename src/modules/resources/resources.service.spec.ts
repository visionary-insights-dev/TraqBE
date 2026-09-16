import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ResourcesService } from './resources.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A1 = '33333333-3333-4333-8333-333333333333';
const COURSE_B1 = '44444444-4444-4444-8444-444444444444';
const RESOURCE_ID = '55555555-5555-4555-8555-555555555555';
const UUID4 = '66666666-6666-4666-8666-666666666666';

const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@a.com', organizationId: ORG_A, roles: [Role.SUPER_ADMIN] };
const MENTOR: AuthUser = { id: 'u-mentor', email: 'mentor@a.com', organizationId: ORG_A, roles: [Role.MENTOR] };
const SCHOLAR: AuthUser = { id: 'u-scholar', email: 'scholar@a.com', organizationId: ORG_A, roles: [Role.SCHOLAR] };

const VALID_PDF_KEY = `${ORG_A}/${UUID4}.pdf`;
const VALID_PNG_KEY = `${ORG_A}/${UUID4}.png`;

type PrismaMock = {
  course: { findFirst: ReturnType<typeof vi.fn> };
  resource: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe('ResourcesService', () => {
  let service: ResourcesService;
  let prisma: PrismaMock;
  let r2: {
    getUploadUrl: ReturnType<typeof vi.fn>;
    getDownloadUrl: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = {
      course: { findFirst: vi.fn() },
      resource: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    };
    r2 = {
      getUploadUrl: vi.fn().mockResolvedValue('https://upload.example.com/signed'),
      getDownloadUrl: vi.fn().mockResolvedValue('https://download.example.com/signed'),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    audit = { log: vi.fn().mockResolvedValue(undefined) };

    service = new ResourcesService(
      prisma as unknown as never,
      r2 as unknown as never,
      audit as unknown as never,
    );
  });

  // =========================================================================
  // 1. generateUploadUrl
  // =========================================================================
  describe('generateUploadUrl', () => {
    const baseDto = { fileName: 'notes.pdf', mimeType: 'application/pdf', fileSize: 1024 };

    it('generates an object key, signed URL and 15min expiry', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      const result = await service.generateUploadUrl(ORG_A, baseDto, MENTOR);

      expect(result.objectKey).toMatch(new RegExp(`^${ORG_A}/[0-9a-f-]{36}\\.pdf$`));
      expect(result.uploadUrl).toBe('https://upload.example.com/signed');
      expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
      expect(r2.getUploadUrl).toHaveBeenCalledWith(
        result.objectKey,
        'application/pdf',
        1024,
      );
    });

    it('rejects files over 20MB with FILE_TOO_LARGE (release-blocking)', async () => {
      await expect(
        service.generateUploadUrl(ORG_A, { ...baseDto, fileSize: 20 * 1024 * 1024 + 1 }, MENTOR),
      ).rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });
      expect(r2.getUploadUrl).not.toHaveBeenCalled();
    });

    it('allows a file exactly at the 20MB limit', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      await expect(
        service.generateUploadUrl(ORG_A, { ...baseDto, fileSize: 20 * 1024 * 1024 }, MENTOR),
      ).resolves.toBeDefined();
    });

    it('rejects an unsupported MIME type with INVALID_FILE_TYPE', async () => {
      await expect(
        service.generateUploadUrl(
          ORG_A,
          { ...baseDto, mimeType: 'application/octet-stream' },
          MENTOR,
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_FILE_TYPE' } });
    });

    it('rejects an extension/mimeType mismatch with INVALID_FILE_TYPE', async () => {
      await expect(
        service.generateUploadUrl(ORG_A, { ...baseDto, fileName: 'notes.png' }, MENTOR),
      ).rejects.toMatchObject({ response: { code: 'INVALID_FILE_TYPE' } });
    });

    it('rejects a fileName without an extension', async () => {
      await expect(
        service.generateUploadUrl(ORG_A, { ...baseDto, fileName: 'notes' }, MENTOR),
      ).rejects.toMatchObject({ response: { code: 'INVALID_FILE_TYPE' } });
    });

    it('accepts both .jpg and .jpeg fileNames for image/jpeg', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      await expect(
        service.generateUploadUrl(ORG_A, { fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: 100 }, MENTOR),
      ).resolves.toBeDefined();
      await expect(
        service.generateUploadUrl(ORG_A, { fileName: 'photo.jpeg', mimeType: 'image/jpeg', fileSize: 100 }, MENTOR),
      ).resolves.toBeDefined();
    });

    it('returns COURSE_NOT_FOUND for a cross-org courseId', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      await expect(
        service.generateUploadUrl(ORG_A, { ...baseDto, courseId: COURSE_B1 }, MENTOR),
      ).rejects.toMatchObject({ response: { code: 'COURSE_NOT_FOUND' } });
    });

    it('scopes the course validation by organization_id', async () => {
      prisma.course.findFirst.mockResolvedValue({ id: COURSE_A1 });
      await service.generateUploadUrl(ORG_A, { ...baseDto, courseId: COURSE_A1 }, MENTOR);

      expect(prisma.course.findFirst).toHaveBeenCalledWith({
        where: { id: COURSE_A1, organization_id: ORG_A },
        select: { id: true },
      });
    });
  });

  // =========================================================================
  // 2. createResource
  // =========================================================================
  describe('createResource', () => {
    const baseDto = {
      objectKey: VALID_PDF_KEY,
      originalName: 'notes.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
    };

    const resourceRow = {
      id: RESOURCE_ID,
      organization_id: ORG_A,
      course_id: null,
      object_key: VALID_PDF_KEY,
      file_name: 'notes.pdf',
      description: null,
      mime_type: 'application/pdf',
      size_bytes: 1024,
      uploader_id: ADMIN.id,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      course: null,
    };

    it('creates the record, logs RESOURCE_CREATED and returns the camelCase shape', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      prisma.resource.create.mockResolvedValue(resourceRow);

      const result = await service.createResource(ORG_A, baseDto, ADMIN.id);

      expect(prisma.resource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: ORG_A,
            course_id: null,
            object_key: VALID_PDF_KEY,
            file_name: 'notes.pdf',
            mime_type: 'application/pdf',
            size_bytes: 1024,
            uploader_id: ADMIN.id,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_A,
          actorId: ADMIN.id,
          action: 'RESOURCE_CREATED',
          entityType: 'Resource',
          entityId: RESOURCE_ID,
          metadata: expect.objectContaining({ objectKey: VALID_PDF_KEY }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          id: RESOURCE_ID,
          objectKey: VALID_PDF_KEY,
          originalName: 'notes.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          courseId: null,
        }),
      );
    });

    it('rejects an object key with a different org prefix (INVALID_OBJECT_KEY)', async () => {
      await expect(
        service.createResource(ORG_A, { ...baseDto, objectKey: `${ORG_B}/${UUID4}.pdf` }, ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'INVALID_OBJECT_KEY' } });
      expect(prisma.resource.create).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID object key segment', async () => {
      await expect(
        service.createResource(ORG_A, { ...baseDto, objectKey: `${ORG_A}/not-a-uuid.pdf` }, ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'INVALID_OBJECT_KEY' } });
    });

    it('rejects an object key with an unknown extension', async () => {
      await expect(
        service.createResource(ORG_A, { ...baseDto, objectKey: `${ORG_A}/${UUID4}.exe` }, ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'INVALID_OBJECT_KEY' } });
    });

    it('rejects an object key whose extension does not match the MIME type', async () => {
      await expect(
        service.createResource(ORG_A, { ...baseDto, objectKey: VALID_PNG_KEY }, ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'INVALID_OBJECT_KEY' } });
    });

    it('returns COURSE_NOT_FOUND for a cross-org courseId', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      await expect(
        service.createResource(ORG_A, { ...baseDto, courseId: COURSE_B1 }, ADMIN.id),
      ).rejects.toMatchObject({ response: { code: 'COURSE_NOT_FOUND' } });
    });
  });

  // =========================================================================
  // 3. listResources
  // =========================================================================
  describe('listResources', () => {
    const row = {
      id: RESOURCE_ID,
      organization_id: ORG_A,
      course_id: COURSE_A1,
      object_key: VALID_PDF_KEY,
      file_name: 'notes.pdf',
      description: null,
      mime_type: 'application/pdf',
      size_bytes: 1024,
      uploader_id: ADMIN.id,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      course: { id: COURSE_A1, name: 'Math 101' },
    };

    it('SUPER_ADMIN sees all org resources without a course filter', async () => {
      prisma.resource.findMany.mockResolvedValue([]);
      prisma.resource.count.mockResolvedValue(0);

      await service.listResources(ORG_A, { page: 1, limit: 25 }, ADMIN);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organization_id: ORG_A, archived_at: null }),
        }),
      );
      const where = prisma.resource.findMany.mock.calls[0][0].where;
      expect(where.course).toBeUndefined();
    });

    it('MENTOR is scoped to courses where they have mentor-scholar pairings', async () => {
      prisma.resource.findMany.mockResolvedValue([]);
      prisma.resource.count.mockResolvedValue(0);

      await service.listResources(ORG_A, { page: 1, limit: 25 }, MENTOR);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            course: {
              is: { mentor_scholar_assignments: { some: { mentor_id: MENTOR.id } } },
            },
          }),
        }),
      );
    });

    it('SCHOLAR is scoped to their enrolled courses only (release-blocking)', async () => {
      prisma.resource.findMany.mockResolvedValue([]);
      prisma.resource.count.mockResolvedValue(0);

      await service.listResources(ORG_A, { page: 1, limit: 25 }, SCHOLAR);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            course: {
              is: { course_memberships: { some: { user_id: SCHOLAR.id } } },
            },
          }),
        }),
      );
    });

    it('applies the courseId query filter', async () => {
      prisma.resource.findMany.mockResolvedValue([]);
      prisma.resource.count.mockResolvedValue(0);

      await service.listResources(ORG_A, { page: 1, limit: 25, courseId: COURSE_A1 }, ADMIN);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ course_id: COURSE_A1 }),
        }),
      );
    });

    it('returns pagination meta', async () => {
      prisma.resource.findMany.mockResolvedValue([row]);
      prisma.resource.count.mockResolvedValue(1);

      const result = await service.listResources(ORG_A, { page: 1, limit: 25 }, ADMIN);

      expect(result).toEqual({
        data: [expect.objectContaining({ id: RESOURCE_ID, course: { id: COURSE_A1, name: 'Math 101' } })],
        meta: { total: 1, totalPages: 1, page: 1, limit: 25 },
      });
    });
  });

  // =========================================================================
  // 4. getResource — tenant isolation is release-blocking
  // =========================================================================
  describe('getResource', () => {
    const row = {
      id: RESOURCE_ID,
      organization_id: ORG_A,
      course_id: COURSE_A1,
      object_key: VALID_PDF_KEY,
      file_name: 'notes.pdf',
      description: null,
      mime_type: 'application/pdf',
      size_bytes: 1024,
      uploader_id: ADMIN.id,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      course: { id: COURSE_A1, name: 'Math 101' },
    };

    it('returns the resource with a 1hr download URL', async () => {
      prisma.resource.findFirst.mockResolvedValue(row);

      const result = await service.getResource(ORG_A, RESOURCE_ID, ADMIN);

      expect(result.downloadUrl).toBe('https://download.example.com/signed');
      expect(result.expiresIn).toBe(3600);
      expect(r2.getDownloadUrl).toHaveBeenCalledWith(VALID_PDF_KEY);
    });

    it('scopes the query by organization_id', async () => {
      prisma.resource.findFirst.mockResolvedValue(null);
      await expect(service.getResource(ORG_A, RESOURCE_ID, ADMIN)).rejects.toThrow(NotFoundException);

      expect(prisma.resource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: RESOURCE_ID, organization_id: ORG_A, archived_at: null }),
        }),
      );
    });

    it('returns RESOURCE_NOT_FOUND for a resource from a course the SCHOLAR is not in (release-blocking)', async () => {
      // Scholar's scope excludes the resource's course → findFirst returns null
      prisma.resource.findFirst.mockResolvedValue(null);

      await expect(service.getResource(ORG_A, RESOURCE_ID, SCHOLAR)).rejects.toMatchObject({
        response: { code: 'RESOURCE_NOT_FOUND' },
      });

      expect(prisma.resource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            course: { is: { course_memberships: { some: { user_id: SCHOLAR.id } } } },
          }),
        }),
      );
    });

    it('returns RESOURCE_NOT_FOUND for a MENTOR outside the course (release-blocking)', async () => {
      prisma.resource.findFirst.mockResolvedValue(null);

      await expect(service.getResource(ORG_A, RESOURCE_ID, MENTOR)).rejects.toMatchObject({
        response: { code: 'RESOURCE_NOT_FOUND' },
      });

      expect(prisma.resource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            course: { is: { mentor_scholar_assignments: { some: { mentor_id: MENTOR.id } } } },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 5. archiveResource
  // =========================================================================
  describe('archiveResource', () => {
    it('soft-archives, deletes from R2 fire-and-forget and logs RESOURCE_ARCHIVED', async () => {
      prisma.resource.findFirst.mockResolvedValue({ id: RESOURCE_ID, object_key: VALID_PDF_KEY });
      prisma.resource.update.mockResolvedValue({
        id: RESOURCE_ID,
        archived_at: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await service.archiveResource(ORG_A, RESOURCE_ID, ADMIN.id);

      expect(prisma.resource.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RESOURCE_ID }, data: { archived_at: expect.any(Date) } }),
      );
      expect(r2.deleteObject).toHaveBeenCalledWith(VALID_PDF_KEY);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RESOURCE_ARCHIVED',
          entityId: RESOURCE_ID,
          metadata: { objectKey: VALID_PDF_KEY },
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ id: RESOURCE_ID, objectKey: VALID_PDF_KEY }),
      );
    });

    it('returns RESOURCE_NOT_FOUND and does NOT delete when the resource belongs to another org (release-blocking)', async () => {
      prisma.resource.findFirst.mockResolvedValue(null);

      await expect(service.archiveResource(ORG_A, RESOURCE_ID, ADMIN.id)).rejects.toMatchObject({
        response: { code: 'RESOURCE_NOT_FOUND' },
      });

      expect(prisma.resource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: RESOURCE_ID, organization_id: ORG_A, archived_at: null }),
        }),
      );
      expect(r2.deleteObject).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('never fails the request when the R2 delete fails (fire-and-forget)', async () => {
      prisma.resource.findFirst.mockResolvedValue({ id: RESOURCE_ID, object_key: VALID_PDF_KEY });
      prisma.resource.update.mockResolvedValue({
        id: RESOURCE_ID,
        archived_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      r2.deleteObject.mockRejectedValue(new Error('R2 unavailable'));

      const result = await service.archiveResource(ORG_A, RESOURCE_ID, ADMIN.id);

      expect(result.id).toBe(RESOURCE_ID);
      expect(audit.log).toHaveBeenCalled();
    });
  });
});