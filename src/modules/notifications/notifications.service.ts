import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { NotificationChannel } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EMAIL_QUEUE, type EmailDispatchJobData } from '../../jobs/queues/email.queue.js';
import { NotificationsGateway } from './notifications.gateway.js';
import type { ListNotificationsQueryDto } from './dto/list-notifications.query.dto.js';

export interface CreateNotificationParams {
  organizationId: string;
  /** Recipient user id. */
  userId: string;
  /** Machine type, e.g. "attendance_absent", "assignment_overdue". */
  type: string;
  title: string;
  body: string;
  metadata?: Prisma.InputJsonValue;
  /** Defaults to [IN_APP]. Add EMAIL to also dispatch an email. */
  channels?: NotificationChannel[];
  /** Recipient email — required when channels includes EMAIL. */
  to?: string;
  /** Email template id (rendered by EmailProcessor). */
  templateId?: string;
  variables?: Record<string, string | number>;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  /**
   * Create a notification + delivery row(s), push a realtime WS event and (if
   * the EMAIL channel is requested) queue the email dispatch job.
   *
   * MUST be called after the caller's transaction commits — never inline in a
   * $transaction (WS emission and queue adds must not roll back with the domain
   * change).
   */
  async create(params: CreateNotificationParams) {
    const channels = params.channels?.length
      ? params.channels
      : [NotificationChannel.IN_APP];

    const notification = await this.prisma.notification.create({
      data: {
        organization_id: params.organizationId,
        title: params.title,
        body: params.body,
        type: params.type,
        metadata: params.metadata ?? undefined,
      },
    });

    await this.prisma.notificationDelivery.createMany({
      data: channels.map((channel) => ({
        notification_id: notification.id,
        user_id: params.userId,
        channel,
        status: 'PENDING',
      })),
    });

    // Realtime push — after the DB writes, outside any caller transaction.
    this.gateway.emitNotificationCreated(params.userId, {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      createdAt: notification.created_at.toISOString(),
    });

    // Email dispatch — queued (never awaited inline in a transaction).
    if (channels.includes(NotificationChannel.EMAIL) && params.to) {
      await this.emailQueue.add({
        organizationId: params.organizationId,
        to: params.to,
        subject: params.title,
        ...(params.templateId
          ? { templateId: params.templateId, variables: params.variables ?? {} }
          : { html: params.body }),
        notificationId: notification.id,
      });
    }

    return notification;
  }

  // =========================================================================
  // Query endpoints — ALWAYS scoped to the authenticated user
  // =========================================================================
  async list(userId: string, query: ListNotificationsQueryDto) {
    const readFilter =
      query.read === undefined ? {} : query.read === 'true' ? { not: null } : null;

    const where: Prisma.NotificationDeliveryWhereInput = {
      user_id: userId,
      read_at: readFilter,
    };

    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({
        where,
        include: {
          notification: {
            select: {
              id: true,
              type: true,
              title: true,
              body: true,
              created_at: true,
              metadata: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.notificationDelivery.count({ where }),
    ]);

    const data = rows.map((row) => ({
      id: row.notification.id,
      type: row.notification.type,
      title: row.notification.title,
      body: row.notification.body,
      createdAt: row.notification.created_at.toISOString(),
      readAt: row.read_at ? row.read_at.toISOString() : null,
      metadata: row.notification.metadata,
    }));

    return {
      data,
      meta: {
        total,
        totalPages: Math.ceil(total / query.limit),
        page: query.page,
        limit: query.limit,
      },
    };
  }

  async markRead(userId: string, notificationId: string) {
    // Own-delivery check — a user can only mark THEIR notifications read.
    const own = await this.prisma.notificationDelivery.findFirst({
      where: { notification_id: notificationId, user_id: userId },
      select: { id: true },
    });
    if (!own) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found.',
      });
    }

    const now = new Date();
    await this.prisma.notificationDelivery.updateMany({
      where: { notification_id: notificationId, user_id: userId, read_at: null },
      data: { read_at: now },
    });

    return { notificationId, readAt: now.toISOString() };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notificationDelivery.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });

    return { updated: result.count };
  }
}