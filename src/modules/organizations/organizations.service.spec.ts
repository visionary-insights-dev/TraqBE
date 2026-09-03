import { BadRequestException } from '@nestjs/common';
import { OrganizationsService, ORG_SETTINGS_DEFAULTS } from './organizations.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_ID = 'org-00000000-0000-0000-0000-000000000001';
const ACTOR_ID = 'user-00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let prisma: {
    organizationSetting: {
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };
  let audit: {
    log: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      organizationSetting: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };

    audit = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    service = new OrganizationsService(
      prisma as any,
      audit as any,
    );
  });

  // =========================================================================
  // getSettings
  // =========================================================================
  describe('getSettings', () => {
    it('returns all defaults when no stored rows exist', async () => {
      prisma.organizationSetting.findMany.mockResolvedValue([]);

      const result = await service.getSettings(ORG_ID);

      expect(result).toEqual({
        assignmentWeight: ORG_SETTINGS_DEFAULTS.assignment_weight,
        attendanceWeight: ORG_SETTINGS_DEFAULTS.attendance_weight,
        atRiskAttendanceThreshold: ORG_SETTINGS_DEFAULTS.at_risk_attendance_threshold,
        atRiskAssignmentThreshold: ORG_SETTINGS_DEFAULTS.at_risk_assignment_threshold,
        atRiskOverdueThreshold: ORG_SETTINGS_DEFAULTS.at_risk_overdue_threshold,
        lateSubmissionPenaltyPercentage: ORG_SETTINGS_DEFAULTS.late_submission_penalty_percentage,
        assignmentEditWindowMinutes: ORG_SETTINGS_DEFAULTS.assignment_edit_window_minutes,
        invitationExpiryHours: ORG_SETTINGS_DEFAULTS.invitation_expiry_hours,
      });
    });

    it('overrides defaults with stored values', async () => {
      prisma.organizationSetting.findMany.mockResolvedValue([
        { organization_id: ORG_ID, key: 'at_risk_overdue_threshold', value: 5 },
      ]);

      const result = await service.getSettings(ORG_ID);

      expect(result.atRiskOverdueThreshold).toBe(5);
      // Everything else stays default
      expect(result.assignmentWeight).toBe(ORG_SETTINGS_DEFAULTS.assignment_weight);
      expect(result.attendanceWeight).toBe(ORG_SETTINGS_DEFAULTS.attendance_weight);
      expect(result.atRiskAttendanceThreshold).toBe(ORG_SETTINGS_DEFAULTS.at_risk_attendance_threshold);
      expect(result.atRiskAssignmentThreshold).toBe(ORG_SETTINGS_DEFAULTS.at_risk_assignment_threshold);
      expect(result.lateSubmissionPenaltyPercentage).toBe(ORG_SETTINGS_DEFAULTS.late_submission_penalty_percentage);
      expect(result.assignmentEditWindowMinutes).toBe(ORG_SETTINGS_DEFAULTS.assignment_edit_window_minutes);
      expect(result.invitationExpiryHours).toBe(ORG_SETTINGS_DEFAULTS.invitation_expiry_hours);
    });

    it('scopes query to organizationId', async () => {
      prisma.organizationSetting.findMany.mockResolvedValue([]);

      await service.getSettings(ORG_ID);

      expect(prisma.organizationSetting.findMany).toHaveBeenCalledWith({
        where: { organization_id: ORG_ID },
      });
    });
  });

  // =========================================================================
  // updateSettings
  // =========================================================================
  describe('updateSettings', () => {
    describe('weight validation', () => {
      it('rejects when weights do not sum to 1.0 (both provided)', async () => {
        // getSettings is called twice: once for validation, once for final return
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        try {
          await service.updateSettings(ORG_ID, { assignmentWeight: 0.6, attendanceWeight: 0.3 }, ACTOR_ID);
          expect.fail('Expected BadRequestException');
        } catch (e) {
          expect(e).toBeInstanceOf(BadRequestException);
          expect((e as BadRequestException).getResponse()).toEqual(
            expect.objectContaining({ code: 'INVALID_WEIGHT_SUM' }),
          );
        }
      });

      it('rejects when only one weight is set but sum is not 1.0', async () => {
        // Defaults: assignment=0.7, attendance=0.3. Setting only attendanceWeight=0.2 => 0.7+0.2=0.9
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        try {
          await service.updateSettings(ORG_ID, { attendanceWeight: 0.2 }, ACTOR_ID);
          expect.fail('Expected BadRequestException');
        } catch (e) {
          expect(e).toBeInstanceOf(BadRequestException);
          expect((e as BadRequestException).getResponse()).toEqual(
            expect.objectContaining({ code: 'INVALID_WEIGHT_SUM' }),
          );
        }
      });

      it('accepts setting only attendanceWeight when it matches default assignmentWeight (0.7 + 0.3 = 1.0)', async () => {
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        const result = await service.updateSettings(
          ORG_ID,
          { attendanceWeight: 0.3 },
          ACTOR_ID,
        );

        expect(result.attendanceWeight).toBe(0.3);
      });
    });

    describe('successful updates', () => {
      it('upserts each changed key and returns merged settings', async () => {
        // First call: validation via getSettings, returns empty defaults
        // Second call: final getSettings return
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        const result = await service.updateSettings(
          ORG_ID,
          { assignmentWeight: 0.7, attendanceWeight: 0.3 },
          ACTOR_ID,
        );

        // Two upserts (one per weight)
        expect(prisma.organizationSetting.upsert).toHaveBeenCalledTimes(2);
        expect(prisma.organizationSetting.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organization_id_key: { organization_id: ORG_ID, key: 'assignment_weight' },
            },
            create: { organization_id: ORG_ID, key: 'assignment_weight', value: 0.7 },
            update: { value: 0.7 },
          }),
        );
        expect(prisma.organizationSetting.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organization_id_key: { organization_id: ORG_ID, key: 'attendance_weight' },
            },
            create: { organization_id: ORG_ID, key: 'attendance_weight', value: 0.3 },
            update: { value: 0.3 },
          }),
        );

        expect(result.assignmentWeight).toBe(0.7);
        expect(result.attendanceWeight).toBe(0.3);
      });

      it('logs audit with ORGANIZATION_SETTINGS_UPDATED action', async () => {
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        await service.updateSettings(
          ORG_ID,
          { assignmentWeight: 0.7, attendanceWeight: 0.3 },
          ACTOR_ID,
        );

        expect(audit.log).toHaveBeenCalledTimes(1);
        expect(audit.log).toHaveBeenCalledWith(
          expect.objectContaining({
            organizationId: ORG_ID,
            actorId: ACTOR_ID,
            action: 'ORGANIZATION_SETTINGS_UPDATED',
            entityType: 'ORGANIZATION',
            entityId: ORG_ID,
          }),
        );
      });

      it('upserts non-weight settings correctly', async () => {
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        await service.updateSettings(
          ORG_ID,
          { atRiskOverdueThreshold: 10, invitationExpiryHours: 72 },
          ACTOR_ID,
        );

        expect(prisma.organizationSetting.upsert).toHaveBeenCalledTimes(2);
        expect(prisma.organizationSetting.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organization_id_key: { organization_id: ORG_ID, key: 'at_risk_overdue_threshold' },
            },
            create: { organization_id: ORG_ID, key: 'at_risk_overdue_threshold', value: 10 },
          }),
        );
        expect(prisma.organizationSetting.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organization_id_key: { organization_id: ORG_ID, key: 'invitation_expiry_hours' },
            },
            create: { organization_id: ORG_ID, key: 'invitation_expiry_hours', value: 72 },
          }),
        );
      });
    });

    describe('cross-tenant scoping', () => {
      it('scopes upsert where.organization_id to the passed organizationId', async () => {
        const otherOrgId = 'org-00000000-0000-0000-0000-000000000099';
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        await service.updateSettings(
          otherOrgId,
          { atRiskOverdueThreshold: 5 },
          ACTOR_ID,
        );

        expect(prisma.organizationSetting.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organization_id_key: { organization_id: otherOrgId, key: 'at_risk_overdue_threshold' },
            },
            create: { organization_id: otherOrgId, key: 'at_risk_overdue_threshold', value: 5 },
          }),
        );
      });
    });

    describe('audit logging', () => {
      it('does not log audit when no settings changed', async () => {
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        // Empty dto — nothing changes
        await service.updateSettings(ORG_ID, {}, ACTOR_ID);

        expect(audit.log).not.toHaveBeenCalled();
        expect(prisma.organizationSetting.upsert).not.toHaveBeenCalled();
      });

      it('logs audit only once when multiple settings change', async () => {
        prisma.organizationSetting.findMany.mockResolvedValue([]);

        await service.updateSettings(
          ORG_ID,
          { assignmentWeight: 0.7, attendanceWeight: 0.3, atRiskOverdueThreshold: 5 },
          ACTOR_ID,
        );

        expect(audit.log).toHaveBeenCalledTimes(1);
      });
    });
  });
});
