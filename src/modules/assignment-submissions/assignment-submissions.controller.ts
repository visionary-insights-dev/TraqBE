import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssignmentSubmissionsService } from './assignment-submissions.service.js';

@Controller('api/v1/assignments/:id/submissions')
@ApiTags('Assignment Submissions')
export class AssignmentSubmissionsController {
  constructor(
    private readonly assignmentSubmissionsService: AssignmentSubmissionsService,
  ) {}
}
