import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { NotificationsService } from './notifications.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_A = 'user-00000000-0000-0000-0000-000000000001';
const USER_B = 'user-00000000-0000-0000-0000-000000000002';
const ORG_A = 'org-00000000-0000-0000-0000-000000000001';
const NOTIF_ID = 'notif-00000000-0000-0000-0000-000000000001';

const CREATED_AT = new Date('2026-09-14T10:00:00.000Z');

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIF_ID,
    organization_id: ORG_A,
    title: 'Test Notification',
    body: 'Test body',
    type: 'test_type',
    metadata: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-00000000-0000-0000-0000-000000000001',
    notification_id: NOTIF_ID,
    user_id: USER_A,
    channel: NotificationChannel.IN_APP,
    status: 'PENDING',
    read_at: null,
    sent_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    notification: makeNotification(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: any;
  let gateway: { emitNotificationCreated: ReturnType<typeof vi.fn> };
  let emailQueue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      notification: {
        create: vi.fn(),
      },
      notificationDelivery: {
        createMany: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    gateway = {
      emitNotificationCreated: vi.fn(),
    };

    emailQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    service = new NotificationsService(
      prisma as any,
      gateway as any,
      emailQueue as any,
    );
  });

  // =========================================================================
  // create
  // =========================================================================
  describe('create', () => {
    it('creates a notification + 1 delivery (IN_APP default) + emits gateway, NO email', async () => {
      prisma.notification.create.mockResolvedValue(makeNotification());
      prisma.notificationDelivery.createMany.mockResolvedValue({ count: 1 });

      await service.create({
        organizationId: ORG_A,
        userId: USER_A,
        type: 'test_type',
        title: 'Test Notification',
        body: 'Test body',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          organization_id: ORG_A,
          title: 'Test Notification',
          body: 'Test body',
          type: 'test_type',
          metadata: undefined,
        },
      });
      expect(prisma.notificationDelivery.createMany).toHaveBeenCalledWith({
        data: [
          {
            notification_id: NOTIF_ID,
            user_id: USER_A,
            channel: NotificationChannel.IN_APP,
            status: 'PENDING',
          },
        ],
      });
      expect(gateway.emitNotificationCreated).toHaveBeenCalledWith(
        USER_A,
        expect.objectContaining({
          id: NOTIF_ID,
          type: 'test_type',
          title: 'Test Notification',
          body: 'Test body',
          createdAt: CREATED_AT.toISOString(),
        }),
      );
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('creates 2 deliveries + emailQueue.add when channels = [IN_APP, EMAIL] with templateId', async () => {
      prisma.notification.create.mockResolvedValue(makeNotification());
      prisma.notificationDelivery.createMany.mockResolvedValue({ count: 2 });

      await service.create({
        organizationId: ORG_A,
        userId: USER_A,
        type: 'test_type',
        title: 'Test Notification',
        body: 'Test body',
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        to: 'user@example.com',
        templateId: 'attendance_absent',
        variables: { date: '2026-09-14' },
      });

      expect(prisma.notificationDelivery.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ channel: NotificationChannel.IN_APP }),
          expect.objectContaining({ channel: NotificationChannel.EMAIL }),
        ],
      });
      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'user@example.com',
        subject: 'Test Notification',
        templateId: 'attendance_absent',
        variables: { date: '2026-09-14' },
        notificationId: NOTIF_ID,
      });
    });

    it('uses body as html when no templateId (legacy path)', async () => {
      prisma.notification.create.mockResolvedValue(makeNotification());
      prisma.notificationDelivery.createMany.mockResolvedValue({ count: 2 });

      await service.create({
        organizationId: ORG_A,
        userId: USER_A,
        type: 'test_type',
        title: 'Test Notification',
        body: '<p>Hello</p>',
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        to: 'user@example.com',
      });

      expect(emailQueue.add).toHaveBeenCalledWith({
        organizationId: ORG_A,
        to: 'user@example.com',
        subject: 'Test Notification',
        html: '<p>Hello</p>',
        notificationId: NOTIF_ID,
      });
    });

    it('passes metadata through and uses created_at ISO string in gateway emit', async () => {
      const metadata = { meetingId: 'meet-1' };
      prisma.notification.create.mockResolvedValue(makeNotification({ metadata }));
      prisma.notificationDelivery.createMany.mockResolvedValue({ count: 1 });

      await service.create({
        organizationId: ORG_A,
        userId: USER_A,
        type: 'test_type',
        title: 'Test Notification',
        body: 'Test body',
        metadata,
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata }),
      });
      expect(gateway.emitNotificationCreated).toHaveBeenCalledWith(
        USER_A,
        expect.objectContaining({ createdAt: CREATED_AT.toISOString() }),
      );
    });
  });

  // =========================================================================
  // list
  // =========================================================================
  describe('list', () => {
    it('scopes by user_id and defaults pagination (page=1, limit=25)', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(0);

      await service.list(USER_A, { page: 1, limit: 25 });

      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: USER_A }),
          skip: 0,
          take: 25,
        }),
      );
      expect(prisma.notificationDelivery.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: USER_A }),
        }),
      );
    });

    it('read filter "true" → read_at not null', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(0);

      await service.list(USER_A, { page: 1, limit: 25, read: 'true' });

      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ read_at: { not: null } }),
        }),
      );
    });

    it('read filter "false" → read_at null', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(0);

      await service.list(USER_A, { page: 1, limit: 25, read: 'false' });

      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ read_at: null }),
        }),
      );
    });

    it('read filter undefined → no read_at constraint', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(0);

      await service.list(USER_A, { page: 1, limit: 25 });

      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ read_at: {} }),
        }),
      );
    });

    it('maps rows to envelope with readAt null when read_at is null', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([makeDelivery()]);
      prisma.notificationDelivery.count.mockResolvedValue(1);

      const result = await service.list(USER_A, { page: 1, limit: 25 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: NOTIF_ID,
        type: 'test_type',
        title: 'Test Notification',
        body: 'Test body',
        createdAt: CREATED_AT.toISOString(),
        readAt: null,
        metadata: null,
      });
    });

    it('returns correct meta total and totalPages', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(50);

      const result = await service.list(USER_A, { page: 2, limit: 25 });

      expect(result.meta).toEqual({
        total: 50,
        totalPages: 2,
        page: 2,
        limit: 25,
      });
    });

    it('calculates pagination skip/take from page and limit', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      prisma.notificationDelivery.count.mockResolvedValue(0);

      await service.list(USER_A, { page: 3, limit: 10 });

      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  // =========================================================================
  // markRead
  // =========================================================================
  describe('markRead', () => {
    it('marks own notification as read and returns notificationId + readAt ISO', async () => {
      prisma.notificationDelivery.findFirst.mockResolvedValue({ id: 'del-1' });
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markRead(USER_A, NOTIF_ID);

      expect(prisma.notificationDelivery.findFirst).toHaveBeenCalledWith({
        where: { notification_id: NOTIF_ID, user_id: USER_A },
        select: { id: true },
      });
      expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
        where: { notification_id: NOTIF_ID, user_id: USER_A, read_at: null },
        data: { read_at: expect.any(Date) },
      });
      expect(result.notificationId).toBe(NOTIF_ID);
      expect(result.readAt).toBeDefined();
      expect(new Date(result.readAt).toISOString()).toBe(result.readAt);
    });

    it('throws NOTIFICATION_NOT_FOUND when notification belongs to another user (release-blocking)', async () => {
      prisma.notificationDelivery.findFirst.mockResolvedValue(null);

      try {
        await service.markRead(USER_B, NOTIF_ID);
        expect.fail('Expected NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(
          expect.objectContaining({ code: 'NOTIFICATION_NOT_FOUND' }),
        );
      }

      expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // markAllRead
  // =========================================================================
  describe('markAllRead', () => {
    it('updates all unread deliveries for the user and returns { updated: n }', async () => {
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 7 });

      const result = await service.markAllRead(USER_A);

      expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
        where: { user_id: USER_A, read_at: null },
        data: { read_at: expect.any(Date) },
      });
      expect(result).toEqual({ updated: 7 });
    });
  });
});
