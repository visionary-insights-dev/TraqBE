import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    organizationId: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
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
        metadata: params.metadata ?? undefined,
        ip_address: params.ipAddress ?? undefined,
      },
    });
  }
}
