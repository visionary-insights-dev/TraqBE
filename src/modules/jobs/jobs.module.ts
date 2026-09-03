import { Module } from '@nestjs/common';
import { JobsInfrastructureModule } from '../../jobs/jobs.module.js';

@Module({
  imports: [JobsInfrastructureModule],
  exports: [JobsInfrastructureModule],
})
export class JobsModule {}
