/**
 * Display form of a SecurityEvent's `detail`.
 *
 * "Base atualizada" events (`data_edit_summary`) used to append a JSON tail listing every changed
 * row and cell — `Base 'X' atualizada por Y: … {"dataset":"schedule","ops":[…]}`. The backend no
 * longer writes it (see main.py db_dataset_mutate: WHICH base only; who and when are columns of the
 * event), but rows written BEFORE that change still carry the blob, and the admin panels would keep
 * rendering a wall of record-level data — including the edited values — for them.
 *
 * So the tail is also stripped on DISPLAY: everything from the first `{"` onward is dropped. No
 * legitimate detail sentence contains that sequence, and the cut is display-only — the stored row is
 * untouched, so the original text is still there for anyone reading the table directly.
 */
export function auditDetailText(detail: string | null | undefined): string {
  if (!detail) return ''
  const i = detail.indexOf('{"')
  return (i >= 0 ? detail.slice(0, i) : detail).trim()
}
