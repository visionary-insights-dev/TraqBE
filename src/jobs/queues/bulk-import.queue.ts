import { BullModule } from '@nestjs/bull';
import { Role } from '@prisma/client';

export const BULK_IMPORT_QUEUE = 'bulk-import';

export interface BulkInvitationRow {
  email: string;
  name: string;
  role: Role;
}

export interface BulkImportJobData {
  organizationId: string;
  invitationExpiryHours: number;
  rows: BulkInvitationRow[];
}

export const BulkImportQueueModule = BullModule.registerQueue({
  name: BULK_IMPORT_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
