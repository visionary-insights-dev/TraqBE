import { BullModule } from '@nestjs/bull';

export const INVITATIONS_QUEUE = 'invitations';

export interface InvitationReminderJobData {
  invitationId: string;
  organizationId: string;
  email: string;
  type: '24h' | 'expiry';
}

export const InvitationsQueueModule = BullModule.registerQueue({
  name: INVITATIONS_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});