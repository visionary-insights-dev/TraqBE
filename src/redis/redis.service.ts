/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: any = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    // Dynamic import to avoid ESM type issues with ioredis
    const mod = await import('ioredis');
    const RedisClient = (mod as any).default ?? (mod as any).Redis;

    const redisUrl = this.configService.get<string>('REDIS_URL');
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);

    this.client = redisUrl ? new RedisClient(redisUrl) : new RedisClient({ host, port });

    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    this.client.on('connect', () => {
      this.logger.log('Redis connected');
    });
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  async ping(): Promise<string> {
    if (!this.client) throw new Error('Redis client not initialized');
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis client not initialized');
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) throw new Error('Redis client not initialized');
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) throw new Error('Redis client not initialized');
    await this.client.del(key);
  }
}
