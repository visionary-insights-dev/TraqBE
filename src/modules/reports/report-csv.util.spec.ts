import { describe, expect, it } from 'vitest';
import { encodeReportCsv, REPORT_COLUMNS } from './report-csv.util.js';

describe('encodeReportCsv', () => {
  it('emits a BOM-prefixed CSV with headers for an empty dataset', () => {
    const buffer = encodeReportCsv('scholars', []);
    const text = buffer.toString('utf8');

    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toBe('\uFEFFScholar ID,Name,Email\r\n');
  });

  it('encodes scholars rows in fixed column order', () => {
    const buffer = encodeReportCsv('scholars', [
      { id: 's-1', name: 'Ada Lovelace', email: 'ada@example.com' },
      { id: 's-2', name: 'Grace Hopper', email: 'grace@example.com' },
    ]);
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');

    expect(REPORT_COLUMNS.scholars.map((c) => c.label).join(',')).toBe(
      'Scholar ID,Name,Email',
    );
    expect(text.split('\r\n')).toEqual([
      'Scholar ID,Name,Email',
      's-1,Ada Lovelace,ada@example.com',
      's-2,Grace Hopper,grace@example.com',
      '',
    ]);
  });

  it('quotes fields containing commas, quotes, or newlines (RFC 4180)', () => {
    const text = encodeReportCsv('meetings', [
      {
        title: 'Q&A, "Catch-up"',
        courseName: 'Computer\nScience',
        startsAt: '2026-09-15T10:00:00.000Z',
        durationMinutes: 45,
      },
    ]).toString('utf8');

    expect(text).toContain('"Q&A, ""Catch-up"""');
    expect(text).toContain('"Computer\nScience"');
  });

  it('renders null/undefined as empty cells', () => {
    const text = encodeReportCsv('assignments', [
      { scholarId: 's-1', name: 'Ada', assignmentTitle: 'HW 1', status: 'SUBMITTED', earnedCredit: null },
    ]).toString('utf8');

    expect(text).toContain('s-1,Ada,HW 1,SUBMITTED,');
  });

  it('throws for unsupported report types', () => {
    expect(() => encodeReportCsv('payroll', [])).toThrow(
      'No CSV column mapping for report type "payroll"',
    );
  });
});