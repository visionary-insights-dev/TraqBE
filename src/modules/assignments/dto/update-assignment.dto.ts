import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ example: 'Write a 500-word essay on the Lagos startup ecosystem' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ example: 'Submit as a PDF or Google Doc link' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '7c2d4e5f-8a9b-4c1d-8e2f-3a4b5c6d7e8f' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore?: number;
}