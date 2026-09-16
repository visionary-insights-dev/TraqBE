import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { ReportsService } from './reports.service.js';
import { CreateReportDto } from './dto/create-report.dto.js';

@Controller('api/v1/reports')
@ApiTags('Reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @RequirePermission(...permissionRoles('reports.generate'))
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Generate a report (SUPER_ADMIN). Synchronous CSV rows when <1000 rows, otherwise queues generation and returns 202 with the report id',
  })
  @ApiResponse({ status: 200, description: 'Report rows generated synchronously' })
  @ApiResponse({ status: 202, description: 'Report generation queued ({ id, status: "PENDING" })' })
  @ApiResponse({ status: 400, description: 'REPORT_TYPE_UNSUPPORTED / REPORT_FORMAT_UNSUPPORTED / validation' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReportDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reportsService.create(user.organizationId, dto, user);
    if ('id' in result && result.status === 'PENDING') {
      res.status(202);
    }
    return result;
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('reports.read'))
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiOperation({ summary: 'Poll report generation status' })
  @ApiResponse({ status: 200, description: 'Report status and timestamps' })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_FOUND' })
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reportsService.get(user.organizationId, id);
  }

  @Get(':id/download')
  @RequirePermission(...permissionRoles('reports.read'))
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiOperation({ summary: 'Get a signed R2 download URL for a completed report' })
  @ApiResponse({ status: 200, description: 'Signed download URL ({ url, expiresInSeconds })' })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'REPORT_NOT_READY' })
  @ApiResponse({ status: 410, description: 'REPORT_EXPIRED' })
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reportsService.download(user.organizationId, id);
  }
}