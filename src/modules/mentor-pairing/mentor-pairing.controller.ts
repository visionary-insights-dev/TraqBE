import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { MentorPairingService } from './mentor-pairing.service.js';
import { CreateMentorAssignmentDto } from './dto/create-mentor-assignment.dto.js';
import { ReassignMentorAssignmentDto } from './dto/reassign-mentor-assignment.dto.js';

@Controller('api/v1/mentor-assignments')
@ApiTags('Mentor Pairing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MentorPairingController {
  constructor(private readonly mentorPairingService: MentorPairingService) {}

  @Get()
  @RequirePermission(...permissionRoles('mentor_assignments.read'))
  @ApiOperation({ summary: 'List mentor assignments in the organization (role-filtered)' })
  @ApiResponse({ status: 200, description: 'List of mentor assignments' })
  async list(@CurrentUser() user: AuthUser) {
    return this.mentorPairingService.list(user.organizationId, user);
  }

  @Post()
  @RequirePermission(...permissionRoles('mentor_assignments.create'))
  @ApiOperation({ summary: 'Create mentor assignments for scholars in a course' })
  @ApiResponse({ status: 201, description: 'Assignments created' })
  @ApiResponse({ status: 400, description: 'INVALID_ROLE / SCHOLAR_ALREADY_PAIRED / COURSE_MEMBER_NOT_FOUND' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateMentorAssignmentDto) {
    return this.mentorPairingService.create(user.organizationId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('mentor_assignments.update'))
  @ApiOperation({ summary: 'Reassign a mentor to a scholar (ends current, creates new)' })
  @ApiResponse({ status: 200, description: 'Assignment reassigned' })
  @ApiResponse({ status: 400, description: 'INVALID_ROLE / COURSE_MEMBER_NOT_FOUND' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND' })
  async reassign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReassignMentorAssignmentDto,
  ) {
    return this.mentorPairingService.reassign(user.organizationId, id, dto, user.id);
  }

  @Delete(':id')
  @RequirePermission(...permissionRoles('mentor_assignments.delete'))
  @ApiOperation({ summary: 'End a mentor assignment (soft end, history preserved)' })
  @ApiResponse({ status: 200, description: 'Assignment ended' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND' })
  async end(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.mentorPairingService.endAssignment(user.organizationId, id, user.id);
  }
}
