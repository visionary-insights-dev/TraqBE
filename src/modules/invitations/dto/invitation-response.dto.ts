import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class InvitationResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({ enum: Role }) role: Role;
  @ApiProperty({ enum: ['pending', 'expired', 'used'] }) status: 'pending' | 'expired' | 'used';
  @ApiProperty() expiresAt: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional() usedAt: string | null;
}