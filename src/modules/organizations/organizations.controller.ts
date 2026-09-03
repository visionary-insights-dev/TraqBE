import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { OrganizationsService } from './organizations.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';

@Controller('api/v1/organization')
@ApiTags('Organizations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('settings')
  @RequirePermission(...permissionRoles('organization.settings.read'))
  @ApiOperation({ summary: 'Get organization settings with defaults' })
  @ApiResponse({ status: 200, description: 'Organization settings' })
  async getSettings(@CurrentUser() user: AuthUser) {
    const data = await this.organizationsService.getSettings(user.organizationId);
    return data;
  }

  @Patch('settings')
  @RequirePermission(...permissionRoles('organization.settings.update'))
  @ApiOperation({ summary: 'Update organization settings' })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  @ApiResponse({ status: 400, description: 'INVALID_WEIGHT_SUM' })
  async updateSettings(@CurrentUser() user: AuthUser, @Body() dto: UpdateSettingsDto) {
    const data = await this.organizationsService.updateSettings(user.organizationId, dto, user.id);
    return data;
  }
}
