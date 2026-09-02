import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ResourcesService } from './resources.service.js';

@Controller('api/v1/resources')
@ApiTags('Resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}
}
