import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { NotificationsService } from './notifications.service.js';
import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto.js';

@Controller('api/v1/notifications')
@ApiTags('Notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @RequirePermission(...permissionRoles('notifications.read'))
  @ApiOperation({ summary: 'List the authenticated user notifications (paginated, read filter)' })
  @ApiResponse({ status: 200, description: 'Paginated notifications for the current user only' })
  async listNotifications(
    @CurrentUser() user: AuthUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notificationsService.list(user.id, query);
  }

  @Patch(':id/read')
  @RequirePermission(...permissionRoles('notifications.update'))
  @ApiOperation({ summary: 'Mark one notification as read (own notifications only)' })
  @ApiResponse({ status: 200, description: 'Notification marked read' })
  @ApiResponse({ status: 404, description: 'NOTIFICATION_NOT_FOUND' })
  async markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notificationsService.markRead(user.id, id);
  }

  @Post('read-all')
  @RequirePermission(...permissionRoles('notifications.update'))
  @ApiOperation({ summary: 'Mark all notifications read for the current user' })
  @ApiResponse({ status: 201, description: 'Unread notifications marked read' })
  async markAllRead(@CurrentUser() user: AuthUser) {
    return this.notificationsService.markAllRead(user.id);
  }
}