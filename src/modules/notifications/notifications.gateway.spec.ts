import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotificationsGateway } from './notifications.gateway.js';

describe('NotificationsGateway', () => {
  let gateway: NotificationsGateway;
  let jwtService: { verifyAsync: ReturnType<typeof vi.fn> };
  let mockEmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jwtService = { verifyAsync: vi.fn() };
    gateway = new NotificationsGateway(jwtService as any);

    mockEmit = vi.fn();
    gateway.server = {
      to: vi.fn().mockReturnValue({ emit: mockEmit }),
    } as any;
  });

  // ---------------------------------------------------------------------------
  // Helper: build a minimal Socket mock
  // ---------------------------------------------------------------------------
  function makeClient(
    opts: {
      token?: string;
      auth?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const joinRooms: string[] = [];
    return {
      id: 'socket-1',
      data: {} as Record<string, unknown>,
      handshake: {
        auth: opts.auth ?? (opts.token !== undefined ? { token: opts.token } : {}),
        headers: opts.headers ?? {},
      },
      join: vi.fn(async (room: string) => {
        joinRooms.push(room);
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
      _joinRooms: joinRooms,
    } as any;
  }

  // =========================================================================
  // handleConnection
  // =========================================================================
  describe('handleConnection', () => {
    it('joins user:{sub} and sets client.data.userId for a valid SCHOLAR token', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'user1@example.com',
        role: 'SCHOLAR',
        organizationId: 'org-1',
      });

      const client = makeClient({ token: 'valid-token' });
      await gateway.handleConnection(client);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-token');
      expect(client.data.userId).toBe('user-1');
      expect(client.join).toHaveBeenCalledWith('user:user-1');
      // SCHOLAR should NOT join the admin room
      expect(client.join).toHaveBeenCalledTimes(1);
    });

    it('joins both user:{sub} and organization:{orgId}:admins for SUPER_ADMIN', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'admin-1',
        email: 'admin@example.com',
        role: 'SUPER_ADMIN',
        organizationId: 'org-1',
      });

      const client = makeClient({ token: 'valid-token' });
      await gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('user:admin-1');
      expect(client.join).toHaveBeenCalledWith('organization:org-1:admins');
      expect(client.join).toHaveBeenCalledTimes(2);
    });

    it('extracts token from handshake.auth.token and from Authorization Bearer header', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'u@e.com',
        role: 'SCHOLAR',
        organizationId: 'org-1',
      });

      // Case 1 — auth.token
      const client1 = makeClient({ token: 'from-auth' });
      await gateway.handleConnection(client1);
      expect(jwtService.verifyAsync).toHaveBeenCalledWith('from-auth');

      vi.clearAllMocks();
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-2',
        email: 'u2@e.com',
        role: 'SCHOLAR',
        organizationId: 'org-1',
      });
      mockEmit = vi.fn();
      gateway.server = { to: vi.fn().mockReturnValue({ emit: mockEmit }) } as any;

      // Case 2 — Authorization Bearer header
      const client2 = makeClient({
        headers: { authorization: 'Bearer from-header' },
      });
      await gateway.handleConnection(client2);
      expect(jwtService.verifyAsync).toHaveBeenCalledWith('from-header');
    });

    it('emits unauthorized + disconnect(true) when no token is provided', async () => {
      const client = makeClient({});
      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith('unauthorized', {
        code: 'TOKEN_INVALID',
        message: 'Invalid or missing access token',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('emits unauthorized + disconnect(true) when payload has no sub', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        email: 'user1@example.com',
        role: 'SCHOLAR',
        organizationId: 'org-1',
        // sub is missing
      });

      const client = makeClient({ token: 'bad-payload' });
      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith('unauthorized', {
        code: 'TOKEN_INVALID',
        message: 'Invalid or missing access token',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Emit helpers
  // =========================================================================
  describe('emit helpers', () => {
    it('emitNotificationCreated targets user:{userId} with notification.created', () => {
      gateway.emitNotificationCreated('user-1', {
        id: 'n1',
        type: 'test',
        title: 'Hi',
        body: 'body',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(gateway.server!.to).toHaveBeenCalledWith('user:user-1');
      expect(mockEmit).toHaveBeenCalledWith(
        'notification.created',
        expect.objectContaining({ id: 'n1' }),
      );
    });

    it('emitAssignmentStatusChanged targets user:{scholarId} with assignment.status_changed', () => {
      gateway.emitAssignmentStatusChanged('scholar-1', {
        assignmentId: 'a1',
        scholarId: 'scholar-1',
        newStatus: 'VERIFIED',
      });

      expect(gateway.server!.to).toHaveBeenCalledWith('user:scholar-1');
      expect(mockEmit).toHaveBeenCalledWith(
        'assignment.status_changed',
        expect.objectContaining({ assignmentId: 'a1' }),
      );
    });

    it('emitCourseAnalyticsUpdated targets organization:{orgId}:admins', () => {
      gateway.emitCourseAnalyticsUpdated('org-1', 'course-1');

      expect(gateway.server!.to).toHaveBeenCalledWith(
        'organization:org-1:admins',
      );
      expect(mockEmit).toHaveBeenCalledWith('analytics.course.updated', {
        scope: 'COURSE',
        courseId: 'course-1',
      });
    });

    it('emitDashboardAnalyticsUpdated targets organization:{orgId}:admins', () => {
      gateway.emitDashboardAnalyticsUpdated('org-1');

      expect(gateway.server!.to).toHaveBeenCalledWith(
        'organization:org-1:admins',
      );
      expect(mockEmit).toHaveBeenCalledWith('analytics.dashboard.updated', {
        scope: 'ORG',
      });
    });

    it('emit helpers no-op safely when server is undefined', () => {
      gateway.server = undefined as any;

      expect(() => {
        gateway.emitNotificationCreated('user-1', {
          id: 'n1',
          type: 't',
          title: 'T',
          body: 'B',
          createdAt: '2026-01-01',
        });
        gateway.emitAssignmentStatusChanged('s1', {
          assignmentId: 'a1',
          scholarId: 's1',
          newStatus: 'VERIFIED',
        });
        gateway.emitCourseAnalyticsUpdated('org-1', 'c1');
        gateway.emitDashboardAnalyticsUpdated('org-1');
      }).not.toThrow();
    });
  });
});
