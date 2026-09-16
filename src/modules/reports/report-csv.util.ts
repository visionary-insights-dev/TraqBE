/**
 * CSV encoding for generated reports.
 *
 * Column order/labels are fixed per report type so the async (queued) and
 * synchronous (<1000 rows, returned as JSON) paths stay consistent, and so an
 * empty dataset still produces a valid header-only CSV.
 */
export interface CsvColumn {
  /** Property key on the row object returned by ReportsService.fetchReportRows. */
  key: string;
  /** Human-readable header. */
  label: string;
}

export const REPORT_COLUMNS: Record<string, CsvColumn[]> = {
  scholars: [
    { key: 'id', label: 'Scholar ID' },
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
  ],
  attendance: [
    { key: 'scholarId', label: 'Scholar ID' },
    { key: 'name', label: 'Name' },
    { key: 'meetingTitle', label: 'Meeting' },
    { key: 'status', label: 'Status' },
    { key: 'recordedAt', label: 'Recorded At (UTC)' },
  ],
  assignments: [
    { key: 'scholarId', label: 'Scholar ID' },
    { key: 'name', label: 'Name' },
    { key: 'assignmentTitle', label: 'Assignment' },
    { key: 'status', label: 'Status' },
    { key: 'earnedCredit', label: 'Earned Credit' },
  ],
  meetings: [
    { key: 'title', label: 'Title' },
    { key: 'courseName', label: 'Course' },
    { key: 'startsAt', label: 'Starts At (UTC)' },
    { key: 'durationMinutes', label: 'Duration (minutes)' },
  ],
};

/**
 * Encode report rows as a UTF-8 CSV buffer. Prepends a BOM so Excel renders
 * non-ASCII (names, accents) correctly. CRLF line endings per RFC 4180.
 *
 * @throws Error for unknown report types (no column mapping).
 */
export function encodeReportCsv(type: string, rows: unknown[]): Buffer {
  const columns = REPORT_COLUMNS[type];
  if (!columns) {
    throw new Error(`No CSV column mapping for report type "${type}"`);
  }

  const lines = [columns.map((c) => c.label).join(',')];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    lines.push(columns.map((c) => escapeCsvField(record[c.key])).join(','));
  }

  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Quote only when needed (comma, quote, line break) — RFC 4180.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}