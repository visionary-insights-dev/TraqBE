import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsNotEmpty, IsString } from 'class-validator';

export class CreateChangeRequestDto {
  @ApiProperty({ example: 'dueAt' })
  @IsString()
  @IsNotEmpty()
  field: string;

  @ApiPropertyOptional({ description: 'Current value of the field being changed' })
  @Allow()
  currentValue?: unknown;

  @ApiPropertyOptional({ description: 'Requested value of the field being changed' })
  @Allow()
  requestedValue?: unknown;

  @ApiProperty({ example: 'Please extend the due date by one week' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}