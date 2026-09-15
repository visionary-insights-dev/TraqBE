import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Paginated audit-log list query.
 *
 * All filters are optional; the organization is ALWAYS taken from the session
 * (`@CurrentUser().organizationId`), never from the query string.
 */
export class AuditLogQueryDto {
  @ApiPropertyOptional({
    example: 'PROGRAM',
    description: 'Filter by entity type, e.g. PROGRAM, COURSE, USER, ASSIGNMENT.',
  })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({
    example: '8f14e45f-ceea-4677-9d9b-2b002dcabfce',
    description: 'Filter by the affected entity id.',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    example: '8f14e45f-ceea-4677-9d9b-2b002dcabfce',
    description: 'Filter by the acting user id.',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({
    example: 'PROGRAM_UPDATED',
    description: 'Filter by event type (the stored `action` code).',
  })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Only entries created at or after this ISO timestamp.',
  })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09-30T23:59:59.999Z',
    description: 'Only entries created at or before this ISO timestamp.',
  })
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}