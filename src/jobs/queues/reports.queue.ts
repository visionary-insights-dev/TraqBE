import { BullModule } from '@nestjs/bull';

export const REPORTS_QUEUE = 'reports';

export const ReportsQueueModule = BullModule.registerQueue({
  name: REPORTS_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
