import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AddCourseMemberDto {
  @ApiProperty({ example: '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsUUID()
  userId: string;
}
