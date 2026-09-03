import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssignmentsService } from './assignments.service.js';

@Controller('api/v1/assignments')
@ApiTags('Assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}
}
