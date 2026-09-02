import { BullModule } from '@nestjs/bull';

export const EMAIL_QUEUE = 'email';

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
