import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateInvitationDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: Role.SCHOLAR, enum: Role })
  @IsEnum(Role)
  role: Role;

  @ApiPropertyOptional({ description: 'Optional name hint shown to invitee', example: 'Jane Doe' })
  @IsString()
  name?: string;
}
