import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Body for POST /api/v1/reports.
 *
 * Only CSV output is supported for MVP. The report `type` is validated against
 * an allowlist in the service (`SUPPORTED_REPORT_TYPES`).
 */
export class CreateReportDto {
  @ApiProperty({ example: 'scholars', description: 'Report type: scholars | attendance | assignments | meetings' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiPropertyOptional({
    description: 'Optional filters: courseId, status, dateFrom, dateTo',
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, string | number | boolean>;

  @ApiProperty({ example: 'csv', description: 'Output format (CSV only)' })
  @IsIn(['csv'])
  format: 'csv';
}