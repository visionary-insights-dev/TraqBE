import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrismaMock(overrides?: { queryRaw?: ReturnType<typeof vi.fn> }) {
  return {
    $queryRaw: overrides?.queryRaw ?? vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
}

function makeRedisMock(overrides?: { ping?: ReturnType<typeof vi.fn> }) {
  return {
    ping: overrides?.ping ?? vi.fn().mockResolvedValue('PONG'),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // both healthy
  // =========================================================================
  it('returns status ok when both DB and Redis are healthy', async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock();
    controller = new HealthController(prisma as any, redis as any);

    const result = await controller.check();

    expect(result).toEqual(
      expect.objectContaining({
        status: 'ok',
        db: 'ok',
        redis: 'ok',
      }),
    );
    expect(result.timestamp).toBeDefined();
    // timestamp should be a valid ISO string
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  // =========================================================================
  // DB fails
  // =========================================================================
  it('returns status degraded when DB check throws', async () => {
    const prisma = makePrismaMock({
      queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const redis = makeRedisMock();
    controller = new HealthController(prisma as any, redis as any);

    const result = await controller.check();

    expect(result).toEqual(
      expect.objectContaining({
        status: 'degraded',
        db: 'error',
        redis: 'ok',
      }),
    );
  });

  // =========================================================================
  // Redis fails
  // =========================================================================
  it('returns status degraded when Redis check throws', async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock({
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    controller = new HealthController(prisma as any, redis as any);

    const result = await controller.check();

    expect(result).toEqual(
      expect.objectContaining({
        status: 'degraded',
        db: 'ok',
        redis: 'error',
      }),
    );
  });

  // =========================================================================
  // both fail
  // =========================================================================
  it('returns status degraded when both DB and Redis fail', async () => {
    const prisma = makePrismaMock({
      queryRaw: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const redis = makeRedisMock({
      ping: vi.fn().mockRejectedValue(new Error('Redis down')),
    });
    controller = new HealthController(prisma as any, redis as any);

    const result = await controller.check();

    expect(result).toEqual(
      expect.objectContaining({
        status: 'degraded',
        db: 'error',
        redis: 'error',
      }),
    );
  });

  // =========================================================================
  // timestamp always present
  // =========================================================================
  it('always includes a valid ISO timestamp', async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock();
    controller = new HealthController(prisma as any, redis as any);

    const before = Date.now();
    const result = await controller.check();
    const after = Date.now();

    const ts = new Date(result.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
