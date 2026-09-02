import { Module } from '@nestjs/common';
import { AssignmentSubmissionsController } from './assignment-submissions.controller.js';
import { AssignmentSubmissionsService } from './assignment-submissions.service.js';

@Module({
  controllers: [AssignmentSubmissionsController],
  providers: [AssignmentSubmissionsService],
  exports: [AssignmentSubmissionsService],
})
export class AssignmentSubmissionsModule {}
