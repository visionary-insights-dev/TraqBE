import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateMeetingDto {
  @ApiProperty({ example: 'Week 5 Check-in' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'UUID of the course this meeting belongs to' })
  @IsUUID()
  courseId: string;

  @ApiProperty({ example: '2026-09-20T10:00:00Z' })
  @IsDateString()
  scheduledAt: string;

  @ApiProperty({ example: 60, minimum: 1, maximum: 600 })
  @IsInt()
  @Min(1)
  @Max(600)
  durationMinutes: number;

  @ApiProperty({ example: 'Lecture' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiPropertyOptional({ example: 'Review of financial literacy concepts' })
  @IsOptional()
  @IsString()
  description?: string;
}
