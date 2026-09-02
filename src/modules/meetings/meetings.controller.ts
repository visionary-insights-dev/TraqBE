import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MeetingsService } from './meetings.service.js';

@Controller('api/v1/meetings')
@ApiTags('Meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}
}
