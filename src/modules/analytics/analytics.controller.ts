import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { AnalyticsService } from './analytics.service.js';

@Controller('api/v1/analytics')
@ApiTags('Analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @RequirePermission(...permissionRoles('analytics.read'))
  @ApiOperation({
    summary:
      'Get analytics dashboard (SUPER_ADMIN: org-wide; MENTOR: paired scholars; SCHOLAR: own metrics)',
  })
  @ApiResponse({ status: 200, description: 'Dashboard metrics' })
  async getDashboard(@CurrentUser() user: AuthUser) {
    return this.analyticsService.getDashboard(user.organizationId, user);
  }

  @Get('scholars/:id/progress')
  @RequirePermission(...permissionRoles('analytics.read'))
  @ApiParam({ name: 'id', description: 'Scholar UUID' })
  @ApiOperation({
    summary: 'Get a scholar\'s progress (SUPER_ADMIN/MENTOR any paired scholar; SCHOLAR only self)',
  })
  @ApiResponse({ status: 200, description: 'Scholar progress with per-course breakdown' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — not paired / peer access' })
  @ApiResponse({ status: 404, description: 'SCHOLAR_NOT_FOUND' })
  async getScholarProgress(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getScholarProgress(user.organizationId, id, user);
  }

  @Get('courses/:id')
  @RequirePermission(...permissionRoles('analytics.read'))
  @ApiParam({ name: 'id', description: 'Course UUID' })
  @ApiOperation({ summary: 'Get course-level analytics (members, at-risk, completion rates)' })
  @ApiResponse({ status: 200, description: 'Course metrics' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — not enrolled / not assigned' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async getCourseMetrics(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getCourseMetrics(user.organizationId, id, user);
  }
}