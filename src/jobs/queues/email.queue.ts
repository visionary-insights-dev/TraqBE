import { BullModule } from '@nestjs/bull';

export const EMAIL_QUEUE = 'email';

export interface EmailDispatchJobData {
  organizationId: string;
  to: string;
  subject: string;
  /** Legacy raw-HTML body. Either this or templateId+variables must be provided. */
  html?: string;
  /** Template registry id — renders via templates when html is absent. */
  templateId?: string;
  variables?: Record<string, string | number>;
  /** Back-reference to the EMAIL NotificationDelivery row (for status/guard updates). */
  notificationId?: string;
}

export const EmailQueueModule = BullModule.registerQueue({
  name: EMAIL_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
