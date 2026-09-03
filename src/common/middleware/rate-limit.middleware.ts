import {
  Injectable,
  NestMiddleware,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  keyPrefix?: string;
}

/**
 * Custom Redis-backed rate-limiting middleware.
 *
 * Replaces @nestjs/throttler because it does not yet support @nestjs/common 12.
 * Uses a fixed-window counter stored in Redis, keyed by client IP.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly redis: Redis | null;
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly keyPrefix: string;

  constructor(private readonly configService: ConfigService) {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') ??
      `redis://${this.configService.get<string>('REDIS_HOST') ?? 'localhost'}:${
        this.configService.get<string>('REDIS_PORT') ?? '6379'
      }`;

    // If no Redis config is present, degrade gracefully (no rate limiting).
    this.redis = redisUrl ? new Redis(redisUrl) : null;

    this.windowMs = parseInt(
      this.configService.get<string>('RATE_LIMIT_WINDOW_MS') ?? '60000',
      10,
    );
    this.limit = parseInt(
      this.configService.get<string>('RATE_LIMIT_LIMIT') ?? '100',
      10,
    );
    this.keyPrefix = 'rl';
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ip = req.ip || 'unknown';
    const key = `${this.keyPrefix}:${ip}`;

    try {
      if (this.redis) {
        const current = await this.redis.incr(key);

        if (current === 1) {
          await this.redis.pexpire(key, this.windowMs);
        }

        res.setHeader('X-RateLimit-Limit', String(this.limit));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(this.limit - current, 0)));

        if (current > this.limit) {
          throw new HttpException(
            {
              code: 'RATE_LIMITED',
              message: 'Too many requests, please try again later.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // If Redis is unavailable, allow the request through rather than blocking.
    }

    next();
  }
}
