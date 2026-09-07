import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';

/**
 * Partial update DTO for programs. Only the provided fields are updated.
 */
export class UpdateProgramDto {
  @ApiPropertyOptional({ example: 'TMF Leadership Accelerator' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'An 8-week leadership program for TMF scholars' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: Date, example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startDate?: Date;

  @ApiPropertyOptional({ type: Date, example: '2026-10-31T00:00:00.000Z' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date;
}