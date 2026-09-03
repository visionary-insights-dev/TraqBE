import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RedisService } from './redis.service.js';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures these exist before vi.mock factories run
// ---------------------------------------------------------------------------

const mockClient = {
  ping: vi.fn().mockResolvedValue('PONG'),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

// Use a regular function (not arrow) so `new` works
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockRedis = vi.fn(function (this: any, _urlOrOpts?: string | Record<string, unknown>) {
  // Returning an object from a constructor replaces `this`
  return mockClient;
}) as any;

vi.mock('ioredis', () => ({
  default: MockRedis,
  Redis: MockRedis,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, string | number> = {}) {
  const defaults: Record<string, string | number> = {
    REDIS_URL: '',
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    ...overrides,
  };
  return {
    get: vi.fn((key: string, fallback?: string | number) => {
      return defaults[key] ?? fallback;
    }),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default return values after clearAllMocks
    mockClient.ping.mockResolvedValue('PONG');
    mockClient.get.mockResolvedValue(null);
    mockClient.set.mockResolvedValue('OK');
    mockClient.del.mockResolvedValue(1);
    mockClient.quit.mockResolvedValue(undefined);
    service = new RedisService(makeConfigService());
  });

  // =========================================================================
  // onModuleInit
  // =========================================================================
  describe('onModuleInit', () => {
    it('creates ioredis client using REDIS_URL when provided', async () => {
      const config = makeConfigService({ REDIS_URL: 'redis://myhost:6380' });
      const svc = new RedisService(config);

      await svc.onModuleInit();

      expect(MockRedis).toHaveBeenCalledWith('redis://myhost:6380');
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
    });

    it('creates ioredis client using host + port when REDIS_URL is empty', async () => {
      const config = makeConfigService({
        REDIS_URL: '',
        REDIS_HOST: '10.0.0.1',
        REDIS_PORT: 6380,
      });
      const svc = new RedisService(config);

      await svc.onModuleInit();

      expect(MockRedis).toHaveBeenCalledWith({ host: '10.0.0.1', port: 6380 });
    });

    it('falls back to defaults (localhost:6379) when host/port not set', async () => {
      const config = makeConfigService({ REDIS_URL: '' });
      const svc = new RedisService(config);

      await svc.onModuleInit();

      expect(MockRedis).toHaveBeenCalledWith({ host: 'localhost', port: 6379 });
    });
  });

  // =========================================================================
  // onModuleDestroy
  // =========================================================================
  describe('onModuleDestroy', () => {
    it('calls client.quit() when client exists', async () => {
      await service.onModuleInit();
      await service.onModuleDestroy();

      expect(mockClient.quit).toHaveBeenCalledTimes(1);
    });

    it('does not throw when client is null (no init)', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // ping
  // =========================================================================
  describe('ping', () => {
    it('returns result from client.ping()', async () => {
      await service.onModuleInit();
      mockClient.ping.mockResolvedValue('PONG');

      const result = await service.ping();

      expect(result).toBe('PONG');
      expect(mockClient.ping).toHaveBeenCalledTimes(1);
    });

    it('throws when client not initialized', async () => {
      await expect(service.ping()).rejects.toThrow('Redis client not initialized');
    });
  });

  // =========================================================================
  // get
  // =========================================================================
  describe('get', () => {
    it('returns value from client.get()', async () => {
      await service.onModuleInit();
      mockClient.get.mockResolvedValue('my-value');

      const result = await service.get('my-key');

      expect(result).toBe('my-value');
      expect(mockClient.get).toHaveBeenCalledWith('my-key');
    });

    it('returns null when key does not exist', async () => {
      await service.onModuleInit();
      mockClient.get.mockResolvedValue(null);

      const result = await service.get('missing-key');

      expect(result).toBeNull();
    });

    it('throws when client not initialized', async () => {
      await expect(service.get('key')).rejects.toThrow('Redis client not initialized');
    });
  });

  // =========================================================================
  // set
  // =========================================================================
  describe('set', () => {
    it('calls client.set(key, value) without TTL when ttlSeconds omitted', async () => {
      await service.onModuleInit();

      await service.set('foo', 'bar');

      expect(mockClient.set).toHaveBeenCalledWith('foo', 'bar');
      expect(mockClient.set).not.toHaveBeenCalledWith('foo', 'bar', 'EX', expect.anything());
    });

    it('calls client.set(key, value, "EX", ttl) when ttlSeconds provided', async () => {
      await service.onModuleInit();

      await service.set('foo', 'bar', 300);

      expect(mockClient.set).toHaveBeenCalledWith('foo', 'bar', 'EX', 300);
    });

    it('treats ttlSeconds = 0 as falsy (no EX)', async () => {
      await service.onModuleInit();

      await service.set('foo', 'bar', 0);

      expect(mockClient.set).toHaveBeenCalledWith('foo', 'bar');
    });

    it('throws when client not initialized', async () => {
      await expect(service.set('k', 'v')).rejects.toThrow('Redis client not initialized');
    });
  });

  // =========================================================================
  // del
  // =========================================================================
  describe('del', () => {
    it('calls client.del(key)', async () => {
      await service.onModuleInit();

      await service.del('my-key');

      expect(mockClient.del).toHaveBeenCalledWith('my-key');
    });

    it('throws when client not initialized', async () => {
      await expect(service.del('key')).rejects.toThrow('Redis client not initialized');
    });
  });
});
