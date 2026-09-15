/**
 * Small server-side email template registry. Renders a string from templateId
 * + variables. Kept deliberately dependency-free (no templating lib) so email
 * dispatch stays fast and testable.
 */
const TEMPLATES: Record<string, (v: Record<string, string | number>) => string> = {
  attendance_absent: (v) =>
    `<p>You have been marked <strong>absent</strong> for the meeting on <strong>${v['date'] ?? 'the scheduled date'}</strong>.</p><p>Please contact your mentor if this is an error.</p>`,
  assignment_reminder_24h: (v) =>
    `<p>This is a reminder that your assignment <strong>"${v['title'] ?? 'Untitled'}"</strong> is due in <strong>24 hours</strong> (${v['dueDate'] ?? 'the scheduled date'}).</p><p>Please submit before the deadline.</p>`,
  assignment_reminder_1h: (v) =>
    `<p>This is a reminder that your assignment <strong>"${v['title'] ?? 'Untitled'}"</strong> is due in <strong>1 hour</strong> (${v['dueDate'] ?? 'the scheduled date'}).</p><p>Please submit before the deadline.</p>`,
  assignment_overdue: (v) =>
    `<p>Your assignment <strong>"${v['title'] ?? 'Untitled'}"</strong> is now <strong>overdue</strong>.</p><p>Please submit as soon as possible.</p>`,
  report_ready: (v) =>
    `<p>Your <strong>${v['reportType'] ?? 'report'}</strong> report (${v['rowCount'] ?? 0} rows) is ready to download.</p><p>Open the <strong>Reports</strong> page in Traq to download the CSV. The download link expires in 7 days.</p>`,
};

export function renderTemplate(
  templateId: string,
  variables: Record<string, string | number>,
): string {
  const render = TEMPLATES[templateId];
  if (!render) {
    throw new Error(`Unknown email template: ${templateId}`);
  }
  return render(variables);
}