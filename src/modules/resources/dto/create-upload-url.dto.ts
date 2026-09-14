import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateUploadUrlDto {
  @ApiProperty({ description: 'Original file name with extension (e.g. "lecture-notes.pdf")' })
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @ApiProperty({ description: 'MIME type (e.g. "application/pdf")' })
  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @ApiProperty({ description: 'File size in bytes', minimum: 1 })
  @IsInt()
  @Min(1)
  fileSize!: number;

  @ApiPropertyOptional({ description: 'Optional course UUID to associate the resource with' })
  @IsOptional()
  @IsUUID()
  courseId?: string;
}
