import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

const VERIFY_SUBMISSION_ACTIONS = ['VERIFY', 'REQUEST_RESUBMISSION'] as const;
export type VerifySubmissionAction = (typeof VERIFY_SUBMISSION_ACTIONS)[number];

export class VerifySubmissionDto {
  @ApiProperty({ example: '6f4a8b2c-1d3e-4f6a-8b7c-2e5d1a0b9c8d' })
  @IsUUID()
  scholarId: string;

  @ApiProperty({ enum: VERIFY_SUBMISSION_ACTIONS, example: 'VERIFY' })
  @IsEnum(VERIFY_SUBMISSION_ACTIONS)
  action: VerifySubmissionAction;

  @ApiPropertyOptional({ example: 'Great work! Please cite your sources next time.' })
  @IsOptional()
  @IsString()
  feedback?: string;
}