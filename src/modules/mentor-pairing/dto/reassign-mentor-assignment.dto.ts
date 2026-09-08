import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class ReassignMentorAssignmentDto {
  @ApiProperty({ example: '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsUUID()
  newMentorId: string;

  @ApiPropertyOptional({ example: 'Mentor no longer available' })
  @IsOptional()
  @IsString()
  reason?: string;
}
