import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

export class CorrectAttendanceDto {
  @ApiProperty({ enum: AttendanceStatus, description: 'Corrected attendance status' })
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  @ApiProperty({ example: 'Scholar was present but marked absent by mistake' })
  @IsString()
  @IsNotEmpty()
  correctionReason: string;
}
