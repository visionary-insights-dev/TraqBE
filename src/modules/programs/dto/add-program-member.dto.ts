import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { MembershipType } from '@prisma/client';

export class AddProgramMemberDto {
  @ApiProperty({ example: '3f2a8b4c-9d1e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsUUID()
  userId: string;

  @ApiProperty({ enum: MembershipType, example: MembershipType.SCHOLAR })
  @IsEnum(MembershipType)
  membershipType: MembershipType;
}