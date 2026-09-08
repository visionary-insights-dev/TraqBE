import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class CreateMentorAssignmentDto {
  @ApiProperty({ example: '8a3b6c1d-2e4f-4a7b-9c5d-1e8f0a2b3c4d' })
  @IsUUID()
  mentorId: string;

  @ApiProperty({
    type: [String],
    example: ['6f4a8b2c-1d3e-4f6a-8b7c-2e5d1a0b9c8d'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  scholarIds: string[];

  @ApiProperty({ example: '7c2d4e5f-8a9b-4c1d-8e2f-3a4b5c6d7e8f' })
  @IsUUID()
  courseId: string;
}
