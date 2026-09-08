import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const CHANGE_REQUEST_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type ChangeRequestReviewAction = (typeof CHANGE_REQUEST_ACTIONS)[number];

export class ReviewChangeRequestDto {
  @ApiProperty({ enum: CHANGE_REQUEST_ACTIONS, example: 'APPROVE' })
  @IsEnum(CHANGE_REQUEST_ACTIONS)
  action: ChangeRequestReviewAction;

  @ApiPropertyOptional({ example: 'Approved — new due date set' })
  @IsOptional()
  @IsString()
  adminNote?: string;
}