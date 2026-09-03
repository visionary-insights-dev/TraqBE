import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';

@Controller('api/v1/health')
@ApiTags('Health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness/readiness check (DB + Redis)' })
  async check() {
    let db: 'ok' | 'error' = 'ok';
    let redis: 'ok' | 'error' = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      db = 'error';
      this.logger.error(`DB health check failed: ${(err as Error).message}`);
    }

    try {
      await this.redis.ping();
    } catch (err) {
      redis = 'error';
      this.logger.error(`Redis health check failed: ${(err as Error).message}`);
    }

    return {
      status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
      timestamp: new Date().toISOString(),
    };
  }
}
