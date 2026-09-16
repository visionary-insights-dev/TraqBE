import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { InvitationsService } from './invitations.service.js';
import { InvitationQueryDto } from './dto/invitation-query.dto.js';
import { InvitationResponseDto } from './dto/invitation-response.dto.js';

@Controller('api/v1/invitations')
@ApiTags('Invitations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Get()
  @RequirePermission(...permissionRoles('invitations.read'))
  @ApiOperation({
    summary: 'List organization invitations (SUPER_ADMIN only, paginated)',
    description:
      'Invitations scoped to the caller organization. Status is derived from used_at/expires_at: ' +
      'pending = not used & not expired, expired = not used & past expiry, used = used_at set. ' +
      'Always sorted by created_at DESC.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated invitations',
    type: InvitationResponseDto,
    isArray: true,
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'INSUFFICIENT_PERMISSIONS' })
  async findAll(@CurrentUser() user: AuthUser, @Query() query: InvitationQueryDto) {
    return this.invitationsService.list(user.organizationId, query);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RequirePermission(...permissionRoles('invitations.resend'))
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiOperation({
    summary: 'Resend an invitation (SUPER_ADMIN only)',
    description:
      'Rotates the token (old invitation link is invalidated), refreshes the expiry to the ' +
      'org-configured invitation expiry hours, re-queues the invitation email and schedules reminders.',
  })
  @ApiResponse({ status: 200, description: 'New invitation link and expiry' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'INSUFFICIENT_PERMISSIONS' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  async resend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitationsService.resend(user.organizationId, user.id, id);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission(...permissionRoles('invitations.revoke'))
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiOperation({
    summary: 'Revoke an invitation (SUPER_ADMIN only)',
    description:
      'Immediately expires the invitation by setting expires_at to now. The row is preserved for history.',
  })
  @ApiResponse({ status: 200, description: 'Invitation revoked' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'INSUFFICIENT_PERMISSIONS' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  async revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitationsService.revoke(user.organizationId, user.id, id);
  }
}