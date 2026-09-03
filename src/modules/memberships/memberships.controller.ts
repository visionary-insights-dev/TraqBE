import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MembershipsService } from './memberships.service.js';

@Controller('api/v1/memberships')
@ApiTags('Memberships')
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}
}
