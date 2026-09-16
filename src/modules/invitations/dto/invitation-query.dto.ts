import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class InvitationQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'expired', 'used'] })
  @IsOptional()
  @IsIn(['pending', 'expired', 'used'])
  status?: 'pending' | 'expired' | 'used';

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}