import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProgramsService } from './programs.service.js';

@Controller('api/v1/programs')
@ApiTags('Programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}
}
