import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { R2Service } from './r2.service.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto.js';
import { CreateResourceDto } from './dto/create-resource.dto.js';
import { ListResourcesQueryDto } from './dto/list-resources.query.dto.js';

// ---------------------------------------------------------------------------
// MIME whitelist: extension → MIME type
// ---------------------------------------------------------------------------
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  csv: 'text/csv',
  txt: 'text/plain',
};

// Reverse map: MIME type → canonical extension
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ResourceWithCourse = Prisma.ResourceGetPayload<{
  include: { course: { select: { id: true; name: true } } };
}>;

type ResourceShape = {
  id: string;
  objectKey: string;
  originalName: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number;
  courseId: string | null;
  uploaderId: string;
  createdAt: string;
  course: { id: string; name: string } | null;
};

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // 1. GENERATE UPLOAD URL
  // =========================================================================
  async generateUploadUrl(
    organizationId: string,
    dto: CreateUploadUrlDto,
    user: AuthUser,
  ): Promise<{ uploadUrl: string; objectKey: string; expiresAt: string }> {
    // File size check
    if (dto.fileSize > MAX_FILE_SIZE) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `File size exceeds the maximum allowed size of ${MAX_FILE_SIZE / (1024 * 1024)} MB.`,
      });
    }

    // Resolve canonical extension for the MIME type
    const ext = MIME_TO_EXT[dto.mimeType];
    if (!ext) {
      throw new BadRequestException({
        code: 'INVALID_FILE_TYPE',
        message: `MIME type "${dto.mimeType}" is not allowed.`,
      });
    }

    // Validate that the file extension matches the MIME type.
    // Some MIME types map to multiple extensions (e.g. image/jpeg → jpg, jpeg).
    const allowedExtsForMime = Object.entries(ALLOWED_MIME_TYPES)
      .filter(([, mime]) => mime === dto.mimeType)
      .map(([fileExt]) => fileExt);

    const fileNameParts = dto.fileName.split('.');
    if (fileNameParts.length < 2) {
      throw new BadRequestException({
        code: 'INVALID_FILE_TYPE',
        message: 'File name must include a valid extension.',
      });
    }
    const fileExt = fileNameParts[fileNameParts.length - 1]!.toLowerCase();
    if (!allowedExtsForMime.includes(fileExt)) {
      throw new BadRequestException({
        code: 'INVALID_FILE_TYPE',
        message: `File extension ".${fileExt}" does not match the provided MIME type "${dto.mimeType}".`,
      });
    }

    // If courseId provided, verify it belongs to this org
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, organization_id: organizationId },
        select: { id: true },
      });
      if (!course) {
        throw new NotFoundException({
          code: 'COURSE_NOT_FOUND',
          message: 'Course not found in this organization.',
        });
      }
    }

    // Build object key
    const objectKey = `${organizationId}/${randomUUID()}.${ext}`;

    // Get presigned upload URL
    const uploadUrl = await this.r2.getUploadUrl(objectKey, dto.mimeType, dto.fileSize);

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    return { uploadUrl, objectKey, expiresAt };
  }

  // =========================================================================
  // 2. CREATE RESOURCE (after client has uploaded to R2)
  // =========================================================================
  async createResource(
    organizationId: string,
    dto: CreateResourceDto,
    userId: string,
  ): Promise<ResourceShape> {
    // Validate objectKey pattern: {orgId}/uuid.ext where ext is in ALLOWED_MIME_TYPES
    const escapedOrgId = organizationId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const allowedExts = Object.keys(ALLOWED_MIME_TYPES).join('|');
    const keyRegex = new RegExp(
      `^${escapedOrgId}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(${allowedExts})$`,
      'i',
    );
    if (!keyRegex.test(dto.objectKey)) {
      throw new BadRequestException({
        code: 'INVALID_OBJECT_KEY',
        message:
          'The provided object key is invalid. It must be a valid upload URL key for this organization.',
      });
    }

    // Verify MIME type matches the extension in the object key
    const keyExt = dto.objectKey.split('.')?.pop()?.toLowerCase();
    const expectedExt = MIME_TO_EXT[dto.mimeType];
    if (!keyExt || keyExt !== expectedExt) {
      throw new BadRequestException({
        code: 'INVALID_OBJECT_KEY',
        message: 'The file extension in the object key does not match the provided MIME type.',
      });
    }

    // If courseId provided, verify org ownership
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, organization_id: organizationId },
        select: { id: true },
      });
      if (!course) {
        throw new NotFoundException({
          code: 'COURSE_NOT_FOUND',
          message: 'Course not found in this organization.',
        });
      }
    }

    const resource = await this.prisma.resource.create({
      data: {
        organization_id: organizationId,
        course_id: dto.courseId ?? null,
        object_key: dto.objectKey,
        file_name: dto.originalName,
        description: dto.description ?? null,
        mime_type: dto.mimeType,
        size_bytes: dto.fileSize,
        uploader_id: userId,
      },
      include: { course: { select: { id: true, name: true } } },
    });

    await this.audit.log({
      organizationId,
      actorId: userId,
      action: 'RESOURCE_CREATED',
      entityType: 'Resource',
      entityId: resource.id,
      metadata: {
        objectKey: dto.objectKey,
        courseId: dto.courseId ?? null,
        mimeType: dto.mimeType,
        sizeBytes: dto.fileSize,
      } as Prisma.InputJsonValue,
    });

    return this.shapeResource(resource);
  }

  // =========================================================================
  // 3. LIST RESOURCES (org-scoped, role-filtered, paginated)
  // =========================================================================
  async listResources(
    organizationId: string,
    query: ListResourcesQueryDto,
    user: AuthUser,
  ) {
    const where: Prisma.ResourceWhereInput = {
      organization_id: organizationId,
      archived_at: null,
    };

    if (query.courseId) {
      where.course_id = query.courseId;
    }

    // Role scoping — mirrors meetings.service.ts
    const roles = user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      if (roles.includes('MENTOR')) {
        where.course = {
          is: {
            mentor_scholar_assignments: { some: { mentor_id: user.id } },
          },
        };
      } else if (roles.includes('SCHOLAR')) {
        where.course = {
          is: {
            course_memberships: { some: { user_id: user.id } },
          },
        };
      }
    }

    const [resources, total] = await Promise.all([
      this.prisma.resource.findMany({
        where,
        include: { course: { select: { id: true, name: true } } },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.resource.count({ where }),
    ]);

    const data = resources.map((r) => this.shapeResource(r));

    return {
      data,
      meta: {
        total,
        totalPages: Math.ceil(total / query.limit),
        page: query.page,
        limit: query.limit,
      },
    };
  }

  // =========================================================================
  // 4. GET SINGLE RESOURCE (org-scoped, role-filtered, with download URL)
  // =========================================================================
  async getResource(
    organizationId: string,
    id: string,
    user: AuthUser,
  ) {
    const where: Prisma.ResourceWhereInput = {
      id,
      organization_id: organizationId,
      archived_at: null,
    };

    // Role scoping — same as listResources
    const roles = user.roles ?? [];
    if (!roles.includes('SUPER_ADMIN')) {
      if (roles.includes('MENTOR')) {
        where.course = {
          is: {
            mentor_scholar_assignments: { some: { mentor_id: user.id } },
          },
        };
      } else if (roles.includes('SCHOLAR')) {
        where.course = {
          is: {
            course_memberships: { some: { user_id: user.id } },
          },
        };
      }
    }

    const resource = await this.prisma.resource.findFirst({
      where,
      include: { course: { select: { id: true, name: true } } },
    });

    if (!resource) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    const downloadUrl = await this.r2.getDownloadUrl(resource.object_key);

    const shaped = this.shapeResource(resource);

    return {
      ...shaped,
      downloadUrl,
      expiresIn: 3600,
    };
  }

  // =========================================================================
  // 5. ARCHIVE RESOURCE (soft archive + fire-and-forget R2 delete)
  // =========================================================================
  async archiveResource(
    organizationId: string,
    id: string,
    userId: string,
  ) {
    const resource = await this.prisma.resource.findFirst({
      where: {
        id,
        organization_id: organizationId,
        archived_at: null,
      },
      select: { id: true, object_key: true },
    });

    if (!resource) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    const updated = await this.prisma.resource.update({
      where: { id },
      data: { archived_at: new Date() },
      select: { id: true, archived_at: true },
    });

    // Fire-and-forget R2 delete — non-fatal
    void this.r2.deleteObject(resource.object_key).catch((err) => {
      this.logger.warn(`Failed to delete R2 object ${resource.object_key}: ${err}`);
    });

    await this.audit.log({
      organizationId,
      actorId: userId,
      action: 'RESOURCE_ARCHIVED',
      entityType: 'Resource',
      entityId: id,
      metadata: { objectKey: resource.object_key } as Prisma.InputJsonValue,
    });

    return {
      id: updated.id,
      archivedAt: updated.archived_at ? updated.archived_at.toISOString() : null,
      objectKey: resource.object_key,
      message: 'Resource archived. File deleted from storage; metadata preserved.',
    };
  }

  // =========================================================================
  // SHAPE — camelCase output, strip org-scoped fields
  // =========================================================================
  private shapeResource(r: ResourceWithCourse): ResourceShape {
    return {
      id: r.id,
      objectKey: r.object_key,
      originalName: r.file_name,
      description: r.description,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      courseId: r.course_id,
      uploaderId: r.uploader_id,
      createdAt: r.created_at.toISOString(),
      course: r.course ? { id: r.course.id, name: r.course.name } : null,
    };
  }
}
