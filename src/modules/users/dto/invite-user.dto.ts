import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEmail, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Role } from '@prisma/client';

export class InviteUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: Role.SCHOLAR, enum: Role })
  @IsEnum(Role)
  role: Role;

  /**
   * Deferred to the course memberships module — accepted but not used in this
   * phase. Kept for forward compatibility.
   */
  @ApiPropertyOptional({ type: [String], description: 'Deferred: course membership is handled separately' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  courseIds?: string[];
}
