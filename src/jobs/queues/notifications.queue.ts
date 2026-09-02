import { BullModule } from '@nestjs/bull';

export const NOTIFICATIONS_QUEUE = 'notifications';

export const NotificationsQueueModule = BullModule.registerQueue({
  name: NOTIFICATIONS_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
