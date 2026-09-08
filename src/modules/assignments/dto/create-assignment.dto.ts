import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDefined,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateAssignmentDto {
  @ApiProperty({ example: 'Write a 500-word essay on the Lagos startup ecosystem' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Submit as a PDF or Google Doc link' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: '7c2d4e5f-8a9b-4c1d-8e2f-3a4b5c6d7e8f' })
  @IsUUID()
  courseId: string;

  @ApiProperty({ example: '2026-09-30T23:59:59.000Z' })
  @IsDateString()
  @IsDefined()
  dueAt: string;

  @ApiPropertyOptional({ example: 100, default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore?: number;
}