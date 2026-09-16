import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateResourceDto {
  @ApiProperty({ description: 'R2 object key returned from the upload-url endpoint' })
  @IsString()
  @IsNotEmpty()
  objectKey!: string;

  @ApiProperty({ description: 'Original file name (e.g. "lecture-notes.pdf")' })
  @IsString()
  @IsNotEmpty()
  originalName!: string;

  @ApiProperty({ description: 'MIME type of the uploaded file' })
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

  @ApiPropertyOptional({ description: 'Optional description (max 500 chars)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
