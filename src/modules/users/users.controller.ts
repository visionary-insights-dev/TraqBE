import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags, ApiBody } from '@nestjs/swagger';
import type { Express } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { UserManagementService } from './users.service.js';
import { InviteUserDto } from './dto/invite-user.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { ListUsersQueryDto } from './dto/list-users.query.dto.js';

@Controller('api/v1/users')
@ApiTags('User Management')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UserManagementController {
  constructor(private readonly userManagementService: UserManagementService) {}

  // ---- SELF-SERVICE (any authenticated user) ---------------------------------
  @Get('me/profile')
  @RequirePermission(...permissionRoles('users.me.read'))
  @ApiOperation({ summary: 'Get the authenticated user\'s own profile' })
  @ApiResponse({ status: 200, description: 'Own profile' })
  async getMyProfile(@CurrentUser() user: AuthUser) {
    return this.userManagementService.getMyProfile(user);
  }

  @Patch('me/profile')
  @RequirePermission(...permissionRoles('users.me.update'))
  @ApiOperation({ summary: 'Update the authenticated user\'s own profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async updateMyProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.userManagementService.updateMyProfile(user.id, dto);
  }

  // ---- SUPER_ADMIN ------------------------------------------------------------
  @Get()
  @RequirePermission(...permissionRoles('users.read'))
  @ApiOperation({ summary: 'List users in the organization (SUPER_ADMIN)' })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  async listUsers(@CurrentUser() user: AuthUser, @Query() query: ListUsersQueryDto) {
    const result = await this.userManagementService.listUsers(user.organizationId, query);
    return result;
  }

  @Post('invite')
  @RequirePermission(...permissionRoles('users.invite'))
  @ApiOperation({ summary: 'Invite a user to the organization (SUPER_ADMIN)' })
  @ApiResponse({ status: 201, description: 'Invitation created' })
  @ApiResponse({ status: 400, description: 'USER_ALREADY_EXISTS / INVALID_ROLE_COMBINATION' })
  async inviteUser(@CurrentUser() user: AuthUser, @Body() dto: InviteUserDto) {
    const result = await this.userManagementService.inviteUser(user.organizationId, user.id, dto);
    return result;
  }

  @Post('bulk-import')
  @RequirePermission(...permissionRoles('users.invite'))
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Bulk import users from a CSV file (email,name,role)' })
  @ApiResponse({ status: 200, description: 'Small import processed synchronously' })
  @ApiResponse({ status: 202, description: 'Large import queued — returns jobId' })
  async bulkImport(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      return { success: false, error: { code: 'FILE_REQUIRED', message: 'A CSV file is required' } };
    }
    const rows = this.userManagementService.parseCsv(file.buffer);
    const result = await this.userManagementService.bulkImport(user.organizationId, user.id, rows);
    return result;
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('users.read'))
  @ApiOperation({ summary: 'Get a user within the organization (SUPER_ADMIN)' })
  @ApiResponse({ status: 200, description: 'User' })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND' })
  async getUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.userManagementService.getUser(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('users.update'))
  @ApiOperation({ summary: 'Update a user (name, phone, role) (SUPER_ADMIN)' })
  @ApiResponse({ status: 200, description: 'User updated' })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND' })
  async updateUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.userManagementService.updateUser(user.organizationId, id, dto, user.id);
  }

  @Post(':id/archive')
  @RequirePermission(...permissionRoles('users.archive'))
  @ApiOperation({ summary: 'Archive a user (SUPER_ADMIN)' })
  @ApiResponse({ status: 200, description: 'User archived' })
  @ApiResponse({ status: 400, description: 'CANNOT_ARCHIVE_SELF' })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND' })
  async archiveUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.userManagementService.archiveUser(user.organizationId, id, user.id);
  }
}
