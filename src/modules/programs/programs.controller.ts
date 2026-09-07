import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { ProgramsService } from './programs.service.js';
import { CreateProgramDto } from './dto/create-program.dto.js';
import { UpdateProgramDto } from './dto/update-program.dto.js';
import { ListProgramsQueryDto } from './dto/list-programs.query.dto.js';
import { AddProgramMemberDto } from './dto/add-program-member.dto.js';

@Controller('api/v1/programs')
@ApiTags('Programs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Get()
  @RequirePermission(...permissionRoles('programs.read'))
  @ApiOperation({ summary: 'List programs in the organization (paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated program list' })
  async listPrograms(@CurrentUser() user: AuthUser, @Query() query: ListProgramsQueryDto) {
    const result = await this.programsService.listPrograms(user.organizationId, query);
    return result;
  }

  @Post()
  @RequirePermission(...permissionRoles('programs.create'))
  @ApiOperation({ summary: 'Create a program' })
  @ApiResponse({ status: 201, description: 'Program created' })
  async createProgram(@CurrentUser() user: AuthUser, @Body() dto: CreateProgramDto) {
    return this.programsService.createProgram(user.organizationId, dto, user.id);
  }

  @Get(':id')
  @RequirePermission(...permissionRoles('programs.read'))
  @ApiOperation({ summary: 'Get a program with progress summary' })
  @ApiResponse({ status: 200, description: 'Program with progress summary' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async getProgram(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.programsService.getProgram(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission(...permissionRoles('programs.update'))
  @ApiOperation({ summary: 'Update a program' })
  @ApiResponse({ status: 200, description: 'Program updated' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async updateProgram(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateProgramDto) {
    return this.programsService.updateProgram(user.organizationId, id, dto, user.id);
  }

  @Post(':id/archive')
  @RequirePermission(...permissionRoles('programs.archive'))
  @ApiOperation({ summary: 'Archive a program (soft delete, history preserved)' })
  @ApiResponse({ status: 200, description: 'Program archived' })
  @ApiResponse({ status: 400, description: 'PROGRAM_ALREADY_ARCHIVED' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async archiveProgram(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.programsService.archiveProgram(user.organizationId, id, user.id);
  }

  @Get(':id/members')
  @RequirePermission(...permissionRoles('programs.read'))
  @ApiOperation({ summary: 'List members of a program with scholar/mentor counts' })
  @ApiResponse({ status: 200, description: 'Program members' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async listProgramMembers(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.programsService.listProgramMembers(user.organizationId, id);
  }

  @Post(':id/members')
  @RequirePermission(...permissionRoles('programs.manage_members'))
  @ApiOperation({ summary: 'Add (or update the role of) a member in a program' })
  @ApiResponse({ status: 201, description: 'Member added' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND / USER_NOT_FOUND' })
  async addProgramMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddProgramMemberDto,
  ) {
    return this.programsService.addProgramMember(user.organizationId, id, dto, user.id);
  }
}