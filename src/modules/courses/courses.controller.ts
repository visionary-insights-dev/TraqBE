import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { CoursesService } from './courses.service.js';
import { CreateCourseDto } from './dto/create-course.dto.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';
import { ListCoursesQueryDto } from './dto/list-courses.query.dto.js';
import { AddCourseMemberDto } from './dto/add-course-member.dto.js';

@Controller('api/v1/courses')
@ApiTags('Courses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  @RequirePermission(...permissionRoles('courses.read'))
  @ApiOperation({ summary: 'List courses in the organization (paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated course list' })
  async listCourses(@CurrentUser() user: AuthUser, @Query() query: ListCoursesQueryDto) {
    const result = await this.coursesService.listCourses(user.organizationId, query);
    return result;
  }

  @Post()
  @RequirePermission(...permissionRoles('courses.create'))
  @ApiOperation({ summary: 'Create a course' })
  @ApiResponse({ status: 201, description: 'Course created' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async createCourse(@CurrentUser() user: AuthUser, @Body() dto: CreateCourseDto) {
    return this.coursesService.createCourse(user.organizationId, dto, user.id);
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('courses.read'))
  @ApiOperation({ summary: 'Get a course with program and counts' })
  @ApiResponse({ status: 200, description: 'Course with program and counts' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async getCourse(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.coursesService.getCourse(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('courses.update'))
  @ApiOperation({ summary: 'Update a course' })
  @ApiResponse({ status: 200, description: 'Course updated' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND / PROGRAM_NOT_FOUND' })
  async updateCourse(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    return this.coursesService.updateCourse(user.organizationId, id, dto, user.id);
  }

  @Post(':id/archive')
  @RequirePermission(...permissionRoles('courses.archive'))
  @ApiOperation({ summary: 'Archive a course (soft delete, history preserved)' })
  @ApiResponse({ status: 200, description: 'Course archived' })
  @ApiResponse({ status: 400, description: 'COURSE_ALREADY_ARCHIVED' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async archiveCourse(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.coursesService.archiveCourse(user.organizationId, id, user.id);
  }

  @Get(':id/members')
  @RequirePermission(...permissionRoles('courses.read'))
  @ApiOperation({ summary: 'List members of a course' })
  @ApiResponse({ status: 200, description: 'Course members' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async listCourseMembers(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.coursesService.listCourseMembers(user.organizationId, id);
  }

  @Post(':id/members')
  @RequirePermission(...permissionRoles('courses.manage_members'))
  @ApiOperation({ summary: 'Add a member to a course' })
  @ApiResponse({ status: 201, description: 'Member added' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND / USER_NOT_FOUND' })
  async addCourseMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddCourseMemberDto,
  ) {
    return this.coursesService.addCourseMember(user.organizationId, id, dto, user.id);
  }

  @Delete(':id/members/:userId')
  @RequirePermission(...permissionRoles('courses.manage_members'))
  @ApiOperation({ summary: 'Remove a member from a course (blocked if scholar has active assignments)' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({ status: 400, description: 'SCHOLAR_HAS_ACTIVE_ASSIGNMENTS' })
  @ApiResponse({ status: 404, description: 'COURSE_NOT_FOUND' })
  async removeCourseMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.coursesService.removeCourseMember(user.organizationId, id, userId, user.id);
  }
}
