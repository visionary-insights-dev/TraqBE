import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { AssignmentsService } from './assignments.service.js';
import { CreateAssignmentDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { VerifySubmissionDto } from './dto/verify-submission.dto.js';
import { CreateChangeRequestDto } from './dto/create-change-request.dto.js';
import { ReviewChangeRequestDto } from './dto/review-change-request.dto.js';

@Controller('api/v1/assignments')
@ApiTags('Assignments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Get()
  @RequirePermission(...permissionRoles('assignments.read'))
  @ApiOperation({ summary: 'List assignments in the organization (role-filtered)' })
  @ApiResponse({ status: 200, description: 'List of assignments' })
  async list(@CurrentUser() user: AuthUser) {
    return this.assignmentsService.list(user.organizationId, user);
  }

  @Post()
  @RequirePermission(...permissionRoles('assignments.create'))
  @ApiOperation({ summary: 'Create an assignment draft' })
  @ApiResponse({ status: 201, description: 'Assignment created' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAssignmentDto) {
    return this.assignmentsService.create(user.organizationId, dto, user.id);
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('assignments.read'))
  @ApiOperation({ summary: 'Get assignment details (role-filtered)' })
  @ApiResponse({ status: 200, description: 'Assignment details' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND' })
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assignmentsService.findOne(user.organizationId, id, user);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('assignments.update'))
  @ApiOperation({ summary: 'Update a draft (or a published assignment within its edit window)' })
  @ApiResponse({ status: 200, description: 'Assignment updated' })
  @ApiResponse({ status: 400, description: 'ASSIGNMENT_EDIT_WINDOW_EXPIRED / ASSIGNMENT_NOT_EDITABLE' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND / COURSE_NOT_FOUND' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentDto,
  ) {
    return this.assignmentsService.update(user.organizationId, id, dto, user.id);
  }

  @Post(':id/publish')
  @RequirePermission(...permissionRoles('assignments.publish'))
  @ApiOperation({ summary: 'Publish an assignment (creates scholar submissions + queues reminders)' })
  @ApiResponse({ status: 201, description: 'Assignment published' })
  @ApiResponse({ status: 400, description: 'ASSIGNMENT_NOT_DRAFT / DUE_AT_REQUIRED' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND' })
  async publish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assignmentsService.publish(user.organizationId, id, user.id);
  }

  @Post(':id/submissions')
  @RequirePermission(...permissionRoles('assignments.submit'))
  @ApiOperation({ summary: 'Mark an assignment as submitted (scholar)' })
  @ApiResponse({ status: 201, description: 'Submission marked done' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND / SUBMISSION_NOT_FOUND' })
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assignmentsService.submit(user.organizationId, id, user);
  }

  @Post(':id/verify')
  @RequirePermission(...permissionRoles('assignments.verify'))
  @ApiOperation({ summary: 'Verify a submission or request resubmission' })
  @ApiResponse({ status: 201, description: 'Submission verified / resubmission requested' })
  @ApiResponse({ status: 403, description: 'CANNOT_VERIFY_SELF' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND / SUBMISSION_NOT_FOUND' })
  async verify(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: VerifySubmissionDto,
  ) {
    return this.assignmentsService.verify(user.organizationId, id, dto, user);
  }

  @Post(':id/change-requests')
  @RequirePermission(...permissionRoles('assignments.request_change'))
  @ApiOperation({ summary: 'Request a change once the assignment edit window has passed' })
  @ApiResponse({ status: 201, description: 'Change request created' })
  @ApiResponse({ status: 400, description: 'EDIT_WINDOW_NOT_EXPIRED' })
  @ApiResponse({ status: 404, description: 'ASSIGNMENT_NOT_FOUND' })
  async createChangeRequest(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateChangeRequestDto,
  ) {
    return this.assignmentsService.createChangeRequest(user.organizationId, id, dto, user.id);
  }

  @Patch(':id/change-requests/:requestId')
  @RequirePermission(...permissionRoles('assignments.approve_change'))
  @ApiOperation({ summary: 'Approve or reject a change request' })
  @ApiResponse({ status: 200, description: 'Change request reviewed' })
  @ApiResponse({ status: 400, description: 'CHANGE_REQUEST_ALREADY_REVIEWED / INVALID_CHANGE_FIELD / INVALID_CHANGE_VALUE' })
  @ApiResponse({ status: 404, description: 'CHANGE_REQUEST_NOT_FOUND / ASSIGNMENT_NOT_FOUND' })
  async reviewChangeRequest(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: ReviewChangeRequestDto,
  ) {
    return this.assignmentsService.reviewChangeRequest(
      user.organizationId,
      id,
      requestId,
      dto,
      user.id,
    );
  }
}