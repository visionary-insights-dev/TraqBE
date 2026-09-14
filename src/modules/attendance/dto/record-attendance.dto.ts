import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsUUID, ValidateNested } from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

class AttendanceRecordItem {
  @ApiProperty({ description: 'UUID of the scholar' })
  @IsUUID()
  scholarId: string;

  @ApiProperty({ enum: AttendanceStatus })
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;
}

export class RecordAttendanceDto {
  @ApiProperty({ type: [AttendanceRecordItem], minItems: 1, description: 'Bulk attendance records to upsert' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordItem)
  records: AttendanceRecordItem[];
}
