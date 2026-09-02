import { BullModule } from '@nestjs/bull';

export const ANALYTICS_QUEUE = 'analytics';

export const AnalyticsQueueModule = BullModule.registerQueue({
  name: ANALYTICS_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
