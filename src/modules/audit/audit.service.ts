import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditLogQueryDto } from './dto/audit-log-query.dto.js';
import type { PaginatedResult } from '../../common/dto/pagination.dto.js';

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  actorUserId: string;
  actorName: string;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState: Prisma.JsonValue | null;
  newState: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  createdAt: Date;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recent(
    organizationId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      action: string;
      entityType: string;
      entityId: string;
      actorId: string;
      createdAt: Date;
    }>
  > {
    const logs = await this.prisma.auditLog.findMany({
      where: { organization_id: organizationId },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        entity_type: true,
        entity_id: true,
        actor_id: true,
        created_at: true,
      },
    });

    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      actorId: log.actor_id,
      createdAt: log.created_at,
    }));
  }

  async log(params: {
    organizationId: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    previousState?: Prisma.InputJsonValue;
    newState?: Prisma.InputJsonValue;
    metadata?: Prisma.InputJsonValue;
    ipAddress?: string;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organization_id: params.organizationId,
        actor_id: params.actorId,
        action: params.action,
        entity_type: params.entityType,
        entity_id: params.entityId,
        previous_state: params.previousState ?? undefined,
        new_state: params.newState ?? undefined,
        metadata: params.metadata ?? undefined,
        ip_address: params.ipAddress ?? undefined,
      },
    });
  }

  /**
   * Paginated, org-scoped audit trail. The organization id comes from the
   * authenticated session only — never from the caller.
   *
   * Append-only: there are no update/delete endpoints, so only reads here.
   * Sort is always created_at DESC.
   */
  async list(
    organizationId: string,
    query: AuditLogQueryDto,
  ): Promise<PaginatedResult<AuditLogEntry>> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = new Date(query.dateFrom);
    if (query.dateTo) createdAt.lte = new Date(query.dateTo);

    const where: Prisma.AuditLogWhereInput = {
      organization_id: organizationId,
      entity_type: query.entityType,
      entity_id: query.entityId,
      actor_id: query.actorUserId,
      action: query.eventType,
      created_at: createdAt,
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: { select: { name: true } },
        },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const data: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      actorUserId: row.actor_id,
      actorName: row.actor.name,
      eventType: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      previousState: row.previous_state,
      newState: row.new_state,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
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
}