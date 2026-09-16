import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EmailProcessor } from './email.processor.js';

describe('EmailProcessor', () => {
  let processor: EmailProcessor;
  let prisma: any;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_FROM_EMAIL = 'Traq <no-reply@traq.app>';

    prisma = {
      notificationDelivery: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    const config = {
      get: vi.fn((key: string) =>
        key === 'RESEND_API_KEY' ? 'test-key' : undefined,
      ),
    };

    processor = new EmailProcessor(prisma as any, config as any);
    mockSend = vi.fn().mockResolvedValue({ error: null });
    (processor as any).resend = { emails: { send: mockSend } };
  });

  afterEach(() => {
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('constructs without an API key (no boot crash) and skips send until configured', async () => {
    const noKeyConfig = {
      get: vi.fn(() => undefined),
    };
    expect(() => new EmailProcessor(prisma as any, noKeyConfig as any)).not.toThrow();

    const unconfigured = new EmailProcessor(prisma as any, noKeyConfig as any);
    prisma.notificationDelivery.findFirst.mockResolvedValue(null);

    await expect(
      unconfigured.handleEmail(makeJob({ notificationId: 'notif-1' })),
    ).rejects.toThrow('RESEND_API_KEY not configured; email delivery skipped');

    expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Helper
  // ---------------------------------------------------------------------------
  function makeJob(data: Record<string, unknown> = {}) {
    return {
      data: {
        organizationId: 'org-1',
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
        ...data,
      },
      id: 'job-1',
    } as any;
  }

  // =========================================================================
  // Tests
  // =========================================================================
  it('sends email via resend and updates delivery to SENT', async () => {
    prisma.notificationDelivery.findFirst.mockResolvedValue(null);

    await processor.handleEmail(makeJob({ notificationId: 'notif-1' }));

    expect(mockSend).toHaveBeenCalledWith({
      from: 'Traq <no-reply@traq.app>',
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
    });
    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        notification_id: 'notif-1',
        channel: 'EMAIL',
        status: 'PENDING',
      },
      data: { status: 'SENT', sent_at: expect.any(Date) },
    });
  });

  it('skips send when existing delivery status is SENT (idempotency / retry guard)', async () => {
    prisma.notificationDelivery.findFirst.mockResolvedValue({ status: 'SENT' });

    await processor.handleEmail(makeJob({ notificationId: 'notif-1' }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('renders templateId via renderTemplate when html is absent', async () => {
    prisma.notificationDelivery.findFirst.mockResolvedValue(null);
    const job = makeJob({
      notificationId: 'notif-1',
      templateId: 'attendance_absent',
      variables: { date: '2026-09-14' },
    });
    delete job.data.html;

    await processor.handleEmail(job);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('absent'),
      }),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('2026-09-14'),
      }),
    );
  });

  it('throws when neither html nor a resolvable templateId is present', async () => {
    prisma.notificationDelivery.findFirst.mockResolvedValue(null);
    const job = {
      data: {
        organizationId: 'org-1',
        to: 'user@example.com',
        subject: 'Test',
        // no html, no templateId
      },
      id: 'job-1',
    } as any;

    await expect(processor.handleEmail(job)).rejects.toThrow(
      'Email job has neither html nor a resolvable templateId',
    );
  });

  it('throws on Resend error and does NOT mark SENT', async () => {
    prisma.notificationDelivery.findFirst.mockResolvedValue(null);
    mockSend.mockResolvedValue({ error: { message: 'boom' } });

    await expect(
      processor.handleEmail(makeJob({ notificationId: 'notif-1' })),
    ).rejects.toThrow('Resend failure: boom');

    expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('legacy job without notificationId never touches prisma.notificationDelivery', async () => {
    const job = {
      data: {
        organizationId: 'org-1',
        to: 'user@example.com',
        subject: 'Legacy',
        html: '<p>Legacy HTML</p>',
        // no notificationId
      },
      id: 'job-2',
    } as any;

    await processor.handleEmail(job);

    expect(mockSend).toHaveBeenCalled();
    expect(prisma.notificationDelivery.findFirst).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
  });
});
