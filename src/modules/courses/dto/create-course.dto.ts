import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCourseDto {
  @ApiProperty({ example: '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsUUID()
  programId: string;

  @ApiProperty({ example: 'Financial Literacy 101' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Foundational personal finance for TMF scholars' })
  @IsOptional()
  @IsString()
  description?: string;
}
