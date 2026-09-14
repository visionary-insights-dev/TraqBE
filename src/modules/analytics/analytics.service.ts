import { Injectable } from '@nestjs/common';
import { AttendanceStatus } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  constructor() {}

  /**
   * Calculate the attendance rate from a list of attendance records.
   *
   * Formula:
   *   rate = present_count / (present_count + absent_count) * 100
   *
   * EXCUSED sessions are excluded from both the numerator and denominator.
   * Returns `null` when no applicable sessions exist (avoids division by zero).
   *
   * Example: 8 PRESENT, 1 ABSENT, 1 EXCUSED → 88.89
   */
  calculateAttendanceRate(records: { status: AttendanceStatus }[]): number | null {
    const applicable = records.filter((r) => r.status !== AttendanceStatus.EXCUSED);

    if (applicable.length === 0) {
      return null;
    }

    const presentCount = applicable.filter(
      (r) => r.status === AttendanceStatus.PRESENT,
    ).length;

    // Round to 2 decimal places to avoid floating point artifacts
    return Math.round((presentCount / applicable.length) * 10000) / 100;
  }
}
