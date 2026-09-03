import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MentorPairingService } from './mentor-pairing.service.js';

@Controller('api/v1/mentor-assignments')
@ApiTags('Mentor Pairing')
export class MentorPairingController {
  constructor(private readonly mentorPairingService: MentorPairingService) {}
}
