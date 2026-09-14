import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { AttendanceService } from './attendance.service.js';
import { RecordAttendanceDto } from './dto/record-attendance.dto.js';
import { CorrectAttendanceDto } from './dto/correct-attendance.dto.js';

@Controller('api/v1/meetings/:id/attendance')
@ApiTags('Attendance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get('history')
  @RequirePermission(...permissionRoles('attendance.read'))
  @ApiParam({ name: 'id', description: 'Meeting UUID' })
  @ApiOperation({ summary: 'Get attendance correction history for a meeting' })
  @ApiResponse({ status: 200, description: 'List of corrections with actor and timestamps' })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  async getHistory(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.attendanceService.history(user.organizationId, id);
  }

  @Post()
  @RequirePermission(...permissionRoles('attendance.create'))
  @ApiParam({ name: 'id', description: 'Meeting UUID' })
  @ApiOperation({ summary: 'Bulk record attendance for a meeting (upsert, allows re-recording)' })
  @ApiResponse({ status: 201, description: 'Attendance recorded' })
  @ApiResponse({ status: 400, description: 'SCHOLAR_NOT_ENROLLED' })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  async recordAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RecordAttendanceDto,
  ) {
    return this.attendanceService.recordBulk(user.organizationId, id, dto, user.id);
  }

  @Patch(':scholarId')
  @RequirePermission(...permissionRoles('attendance.correct'))
  @ApiParam({ name: 'id', description: 'Meeting UUID' })
  @ApiParam({ name: 'scholarId', description: 'Scholar UUID' })
  @ApiOperation({ summary: 'Correct an attendance record (SUPER_ADMIN only)' })
  @ApiResponse({ status: 200, description: 'Attendance corrected' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_RECORD_NOT_FOUND / MEETING_NOT_FOUND' })
  async correctAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('scholarId') scholarId: string,
    @Body() dto: CorrectAttendanceDto,
  ) {
    return this.attendanceService.correct(user.organizationId, id, scholarId, dto, user.id);
  }
}
