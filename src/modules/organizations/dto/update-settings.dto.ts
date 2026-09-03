import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Partial update DTO for organization settings. Only the provided fields are
 * updated (upserted). The weight fields are validated together in the service
 * (assignmentWeight + attendanceWeight must equal 1.0).
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: 0.7, description: 'Must sum to 1.0 with attendanceWeight', minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  assignmentWeight?: number;

  @ApiPropertyOptional({ example: 0.3, description: 'Must sum to 1.0 with assignmentWeight', minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  attendanceWeight?: number;

  @ApiPropertyOptional({ example: 70, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  atRiskAttendanceThreshold?: number;

  @ApiPropertyOptional({ example: 60, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  atRiskAssignmentThreshold?: number;

  @ApiPropertyOptional({ example: 3, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  atRiskOverdueThreshold?: number;

  @ApiPropertyOptional({ example: 20, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  lateSubmissionPenaltyPercentage?: number;

  @ApiPropertyOptional({ example: 60, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  assignmentEditWindowMinutes?: number;

  @ApiPropertyOptional({ example: 48, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  invitationExpiryHours?: number;
}
