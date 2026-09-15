import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { permissionRoles } from '../../common/constants/permissions.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { AuditService } from './audit.service.js';
import { AuditLogQueryDto } from './dto/audit-log-query.dto.js';

@Controller('api/v1/audit-logs')
@ApiTags('Audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermission(...permissionRoles('audit.read'))
  @ApiOperation({
    summary: 'List organization audit logs (SUPER_ADMIN only, paginated)',
    description:
      'Append-only audit trail scoped to the caller organization. ' +
      'Filters: entityType, entityId, actorUserId, eventType, dateFrom, dateTo. ' +
      'Always sorted by created_at DESC.',
  })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries' })
  @ApiResponse({ status: 403, description: 'INSUFFICIENT_PERMISSIONS' })
  async listLogs(
    @CurrentUser() user: AuthUser,
    @Query() query: AuditLogQueryDto,
  ) {
    return this.auditService.list(user.organizationId, query);
  }
}