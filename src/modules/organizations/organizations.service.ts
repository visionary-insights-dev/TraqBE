import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';

export const ORG_SETTINGS_DEFAULTS = {
  assignment_weight: 0.7,
  attendance_weight: 0.3,
  at_risk_attendance_threshold: 70,
  at_risk_assignment_threshold: 60,
  at_risk_overdue_threshold: 3,
  late_submission_penalty_percentage: 20,
  assignment_edit_window_minutes: 60,
  invitation_expiry_hours: 48,
} as const;

export type OrgSettingsKeys = keyof typeof ORG_SETTINGS_DEFAULTS;

export interface OrgSettingsResult {
  assignmentWeight: number;
  attendanceWeight: number;
  atRiskAttendanceThreshold: number;
  atRiskAssignmentThreshold: number;
  atRiskOverdueThreshold: number;
  lateSubmissionPenaltyPercentage: number;
  assignmentEditWindowMinutes: number;
  invitationExpiryHours: number;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // GET SETTINGS
  // =========================================================================
  async getSettings(organizationId: string): Promise<OrgSettingsResult> {
    const rows = await this.prisma.organizationSetting.findMany({
      where: { organization_id: organizationId },
    });

    const stored = new Map<string, number>();
    for (const row of rows) {
      stored.set(row.key, this.coerceNumber(row.value));
    }

    // Merge stored values over defaults, keyed by snake_case DB key
    const merged: Record<string, number> = { ...ORG_SETTINGS_DEFAULTS };
    for (const key of Object.keys(ORG_SETTINGS_DEFAULTS) as OrgSettingsKeys[]) {
      if (stored.has(key)) {
        merged[key] = stored.get(key) as number;
      }
    }

    return {
      assignmentWeight: merged.assignment_weight,
      attendanceWeight: merged.attendance_weight,
      atRiskAttendanceThreshold: merged.at_risk_attendance_threshold,
      atRiskAssignmentThreshold: merged.at_risk_assignment_threshold,
      atRiskOverdueThreshold: merged.at_risk_overdue_threshold,
      lateSubmissionPenaltyPercentage: merged.late_submission_penalty_percentage,
      assignmentEditWindowMinutes: merged.assignment_edit_window_minutes,
      invitationExpiryHours: merged.invitation_expiry_hours,
    };
  }

  // =========================================================================
  // PATCH SETTINGS
  // =========================================================================
  async updateSettings(organizationId: string, dto: UpdateSettingsDto, actorId: string): Promise<OrgSettingsResult> {
    // If both weights are being changed, they must sum to 1.0.
    // If only one is changed, we must check against the currently stored (or default) other weight.
    if (dto.assignmentWeight !== undefined || dto.attendanceWeight !== undefined) {
      const current = await this.getSettings(organizationId);
      const assignment = dto.assignmentWeight ?? current.assignmentWeight;
      const attendance = dto.attendanceWeight ?? current.attendanceWeight;

      if (Math.abs(assignment + attendance - 1.0) > 0.0001) {
        throw new BadRequestException({
          code: 'INVALID_WEIGHT_SUM',
          message: 'assignmentWeight + attendanceWeight must equal 1.0',
        });
      }
    }

    const updates: { key: string; value: number }[] = [];
    if (dto.assignmentWeight !== undefined) {
      updates.push({ key: 'assignment_weight', value: dto.assignmentWeight });
    }
    if (dto.attendanceWeight !== undefined) {
      updates.push({ key: 'attendance_weight', value: dto.attendanceWeight });
    }
    if (dto.atRiskAttendanceThreshold !== undefined) {
      updates.push({ key: 'at_risk_attendance_threshold', value: dto.atRiskAttendanceThreshold });
    }
    if (dto.atRiskAssignmentThreshold !== undefined) {
      updates.push({ key: 'at_risk_assignment_threshold', value: dto.atRiskAssignmentThreshold });
    }
    if (dto.atRiskOverdueThreshold !== undefined) {
      updates.push({ key: 'at_risk_overdue_threshold', value: dto.atRiskOverdueThreshold });
    }
    if (dto.lateSubmissionPenaltyPercentage !== undefined) {
      updates.push({ key: 'late_submission_penalty_percentage', value: dto.lateSubmissionPenaltyPercentage });
    }
    if (dto.assignmentEditWindowMinutes !== undefined) {
      updates.push({ key: 'assignment_edit_window_minutes', value: dto.assignmentEditWindowMinutes });
    }
    if (dto.invitationExpiryHours !== undefined) {
      updates.push({ key: 'invitation_expiry_hours', value: dto.invitationExpiryHours });
    }

    if (updates.length > 0) {
      // Upsert each key into the K/V table
      for (const u of updates) {
        await this.prisma.organizationSetting.upsert({
          where: {
            organization_id_key: {
              organization_id: organizationId,
              key: u.key,
            },
          },
          create: {
            organization_id: organizationId,
            key: u.key,
            value: u.value,
          },
          update: {
            value: u.value,
          },
        });
      }

      // Audit every settings change
      await this.audit.log({
        organizationId,
        actorId,
        action: 'ORGANIZATION_SETTINGS_UPDATED',
        entityType: 'ORGANIZATION',
        entityId: organizationId,
        metadata: Object.fromEntries(updates.map((u) => [u.key, u.value])),
      });
    }

    return this.getSettings(organizationId);
  }

  private coerceNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    // Prisma can return JSON numbers as strings depending on driver; fall back to default if unparseable
    throw new BadRequestException({ code: 'INVALID_SETTINGS_VALUE', message: 'A stored setting value is invalid' });
  }
}
