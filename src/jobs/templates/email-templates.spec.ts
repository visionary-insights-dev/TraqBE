import { describe, expect, it } from 'vitest';
import { renderTemplate } from './email-templates.js';

describe('renderTemplate', () => {
  it('renders attendance_absent with substituted date variable', () => {
    const result = renderTemplate('attendance_absent', { date: '2026-09-14' });
    expect(result).toContain('absent');
    expect(result).toContain('2026-09-14');
  });

  it('renders assignment_reminder_24h with title and dueDate', () => {
    const result = renderTemplate('assignment_reminder_24h', {
      title: 'Essay',
      dueDate: '2026-09-20',
    });
    expect(result).toContain('Essay');
    expect(result).toContain('24 hours');
    expect(result).toContain('2026-09-20');
  });

  it('renders assignment_reminder_1h with title and dueDate', () => {
    const result = renderTemplate('assignment_reminder_1h', {
      title: 'Report',
      dueDate: '2026-09-15',
    });
    expect(result).toContain('Report');
    expect(result).toContain('1 hour');
    expect(result).toContain('2026-09-15');
  });

  it('renders assignment_overdue with title', () => {
    const result = renderTemplate('assignment_overdue', { title: 'Thesis' });
    expect(result).toContain('Thesis');
    expect(result).toContain('overdue');
  });

  it('renders invitation_reminder_24h with expiryDate', () => {
    const result = renderTemplate('invitation_reminder_24h', {
      expiryDate: '2026-09-20T00:00:00.000Z',
    });
    expect(result).toContain('24 hours');
    expect(result).toContain('2026-09-20T00:00:00.000Z');
  });

  it('renders invitation_reminder_expiry with expiryDate', () => {
    const result = renderTemplate('invitation_reminder_expiry', {
      expiryDate: '2026-09-20T00:00:00.000Z',
    });
    expect(result).toContain('4 hours');
    expect(result).toContain('2026-09-20T00:00:00.000Z');
  });

  it('throws Error for unknown template id', () => {
    expect(() => renderTemplate('nope', {})).toThrow(
      'Unknown email template: nope',
    );
  });

  it('uses default values when variables are empty', () => {
    const result = renderTemplate('attendance_absent', {});
    expect(result).toContain('absent');
    expect(result).toContain('the scheduled date');
  });
});
