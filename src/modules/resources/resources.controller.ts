import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { ResourcesService } from './resources.service.js';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto.js';
import { CreateResourceDto } from './dto/create-resource.dto.js';
import { ListResourcesQueryDto } from './dto/list-resources.query.dto.js';

@Controller('api/v1/resources')
@ApiTags('Resources')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  // --------------------------------------------------------------------------
  // POST /upload-url — generate a presigned upload URL
  // --------------------------------------------------------------------------
  @Post('upload-url')
  @RequirePermission(...permissionRoles('resources.upload'))
  @ApiOperation({ summary: 'Generate a presigned upload URL for a file' })
  @ApiResponse({ status: 201, description: 'Upload URL generated with object key and expiry' })
  @ApiResponse({ status: 400, description: 'FILE_TOO_LARGE or INVALID_FILE_TYPE' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  @ApiResponse({ status: 503, description: 'R2_NOT_CONFIGURED' })
  async generateUploadUrl(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateUploadUrlDto,
  ) {
    return this.resourcesService.generateUploadUrl(user.organizationId, dto, user);
  }

  // --------------------------------------------------------------------------
  // POST / — create a resource entity after upload to R2
  // --------------------------------------------------------------------------
  @Post()
  @RequirePermission(...permissionRoles('resources.create'))
  @ApiOperation({ summary: 'Create a resource entity after uploading to R2' })
  @ApiResponse({ status: 201, description: 'Resource created' })
  @ApiResponse({ status: 400, description: 'INVALID_OBJECT_KEY' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async createResource(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateResourceDto,
  ) {
    return this.resourcesService.createResource(user.organizationId, dto, user.id);
  }

  // --------------------------------------------------------------------------
  // GET / — list resources (role-filtered, paginated)
  // --------------------------------------------------------------------------
  @Get()
  @RequirePermission(...permissionRoles('resources.read'))
  @ApiOperation({ summary: 'List resources in the organization (role-filtered, paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated resource list' })
  async listResources(
    @CurrentUser() user: AuthUser,
    @Query() query: ListResourcesQueryDto,
  ) {
    return this.resourcesService.listResources(user.organizationId, query, user);
  }

  // --------------------------------------------------------------------------
  // GET /:id — get a single resource with download URL
  // --------------------------------------------------------------------------
  @Get(':id')
  @RequirePermission(...permissionRoles('resources.read'))
  @ApiOperation({ summary: 'Get a resource by ID with a presigned download URL' })
  @ApiResponse({ status: 200, description: 'Resource details with download URL' })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  async getResource(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.resourcesService.getResource(user.organizationId, id, user);
  }

  // --------------------------------------------------------------------------
  // DELETE /:id — soft archive a resource
  // --------------------------------------------------------------------------
  @Delete(':id')
  @RequirePermission(...permissionRoles('resources.delete'))
  @ApiOperation({ summary: 'Archive a resource (soft delete, metadata preserved)' })
  @ApiResponse({ status: 200, description: 'Resource archived' })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  async archiveResource(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.resourcesService.archiveResource(user.organizationId, id, user.id);
  }
}
