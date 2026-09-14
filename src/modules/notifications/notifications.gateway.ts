import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

export interface WsJwtPayload {
  sub: string;
  email: string;
  role: string;
  organizationId: string;
}

export interface NotificationCreatedEvent {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface AssignmentStatusChangedEvent {
  assignmentId: string;
  scholarId: string;
  newStatus: string;
}

/**
 * WebSocket gateway at path /ws.
 *
 * - Authenticates the Bearer token from the handshake on connection.
 * - Server joins the socket to `user:{userId}` (and `organization:{orgId}:admins`
 *   for SUPER_ADMIN). Clients can NEVER join rooms themselves — there are no
 *   broadcast/subscribe handlers exposed.
 * - Emit helpers used by domain services to push realtime events.
 */
@WebSocketGateway({ path: '/ws', cors: { origin: true, credentials: true } })
export class NotificationsGateway {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        throw new Error('Missing bearer token');
      }
      const payload = await this.jwtService.verifyAsync<WsJwtPayload>(token);
      if (!payload?.sub || !payload?.organizationId) {
        throw new Error('Invalid token payload');
      }

      client.data.userId = payload.sub;

      // Server-side room membership — clients have no join endpoint.
      await client.join(`user:${payload.sub}`);
      if (payload.role === 'SUPER_ADMIN') {
        await client.join(`organization:${payload.organizationId}:admins`);
      }

      this.logger.log(`Socket connected: user:${payload.sub} (${client.id})`);
    } catch {
      client.emit('unauthorized', {
        code: 'TOKEN_INVALID',
        message: 'Invalid or missing access token',
      });
      client.disconnect(true);
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken) {
      return authToken;
    }
    const header = client.handshake.headers?.authorization;
    if (header && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  // =========================================================================
  // Emit helpers — used by NotificationsService / domain services
  // =========================================================================
  emitNotificationCreated(userId: string, payload: NotificationCreatedEvent): void {
    this.server?.to(`user:${userId}`).emit('notification.created', payload);
  }

  emitAssignmentStatusChanged(scholarId: string, payload: AssignmentStatusChangedEvent): void {
    this.server?.to(`user:${scholarId}`).emit('assignment.status_changed', payload);
  }

  emitCourseAnalyticsUpdated(organizationId: string, courseId: string): void {
    this.server
      ?.to(`organization:${organizationId}:admins`)
      .emit('analytics.course.updated', { scope: 'COURSE', courseId });
  }

  emitDashboardAnalyticsUpdated(organizationId: string): void {
    this.server
      ?.to(`organization:${organizationId}:admins`)
      .emit('analytics.dashboard.updated', { scope: 'ORG' });
  }
}