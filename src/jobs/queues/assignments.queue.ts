import { BullModule } from '@nestjs/bull';

export const ASSIGNMENTS_QUEUE = 'assignments';

export const AssignmentsQueueModule = BullModule.registerQueue({
  name: ASSIGNMENTS_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
