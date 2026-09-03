import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';

@Controller('api/v1/health')
@ApiTags('Health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness/readiness check' })
  check() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
