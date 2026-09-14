import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { MeetingsService } from './meetings.service.js';
import { CreateMeetingDto } from './dto/create-meeting.dto.js';
import { UpdateMeetingDto } from './dto/update-meeting.dto.js';
import { ListMeetingsQueryDto } from './dto/list-meetings.query.dto.js';

@Controller('api/v1/meetings')
@ApiTags('Meetings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @RequirePermission(...permissionRoles('meetings.read'))
  @ApiOperation({ summary: 'List meetings in the organization (role-filtered, paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated meeting list' })
  async listMeetings(
    @CurrentUser() user: AuthUser,
    @Query() query: ListMeetingsQueryDto,
  ) {
    return this.meetingsService.listMeetings(user.organizationId, query, user);
  }

  @Post()
  @RequirePermission(...permissionRoles('meetings.create'))
  @ApiOperation({ summary: 'Create a meeting' })
  @ApiResponse({ status: 201, description: 'Meeting created' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async createMeeting(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMeetingDto,
  ) {
    return this.meetingsService.createMeeting(user.organizationId, dto, user.id);
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('meetings.read'))
  @ApiOperation({ summary: 'Get a meeting by ID' })
  @ApiResponse({ status: 200, description: 'Meeting details' })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  async getMeeting(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.meetingsService.getOne(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('meetings.update'))
  @ApiOperation({ summary: 'Update a meeting' })
  @ApiResponse({ status: 200, description: 'Meeting updated' })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  async updateMeeting(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMeetingDto,
  ) {
    return this.meetingsService.updateMeeting(user.organizationId, id, dto, user.id);
  }

  @Post(':id/archive')
  @RequirePermission(...permissionRoles('meetings.archive'))
  @ApiOperation({ summary: 'Archive a meeting (soft delete, history preserved)' })
  @ApiResponse({ status: 200, description: 'Meeting archived' })
  @ApiResponse({ status: 400, description: 'MEETING_ALREADY_ARCHIVED' })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  async archiveMeeting(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.meetingsService.archiveMeeting(user.organizationId, id, user.id);
  }
}
