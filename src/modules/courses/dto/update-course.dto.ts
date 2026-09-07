import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Partial update DTO for courses. Only the provided fields are updated.
 */
export class UpdateCourseDto {
  @ApiPropertyOptional({ example: '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsOptional()
  @IsUUID()
  programId?: string;

  @ApiPropertyOptional({ example: 'Financial Literacy 102' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Advanced personal finance for TMF scholars' })
  @IsOptional()
  @IsString()
  description?: string;
}
