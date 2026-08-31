/**
 * Persisted preferences for the Master Schedule Gantt launch flow.
 *
 * Two things survive across sessions (localStorage):
 *   • scheduleEnabled — whether the heavy Schedule module is loaded / its tab is
 *     accessible. Default OFF so users who only need dashboards, summaries or
 *     production planning never pay the Schedule loading cost.
 *   • lastGanttTab   — the tab the user was viewing when the Gantt was last closed,
 *     so re-opening restores them to their last working page (defaults to Resumo Geral).
 *
 * All access is SSR-safe (guards `window`) and never throws — a corrupt/unavailable
 * store simply falls back to the defaults.
 */

export type GanttTab = 0 | 1 | 2 | 3

/**
 * Reference mode for the Schedule (see GanttModal "Alternar Referência").
 *   • 'standard' — default. Original DB + all saved overrides; editing enabled;
 *     deviations/impacts measured against the original DB.
 *   • 'original' — read-only. Original DB ONLY (overrides + optimizer ignored);
 *     Move Mode / optimization / saving disabled. An auditing/validation view.
 *   • 'working'  — "Projeção": display identical to 'standard', but deviations measured
 *     against a frozen reference snapshot instead of the original DB.
 * NOTE: the mode is intentionally NOT persisted to storage — it lives only in GanttModal state. It
 * starts on 'standard' at the beginning of each session (page reload / new period load) but is
 * PRESERVED across the Schedule's close/reopen within that session (see GanttModal), so there is no
 * get/set here.
 */
export type ScheduleRefMode = 'standard' | 'original' | 'working'

const SCHEDULE_ENABLED_KEY = 'ov.gantt.scheduleEnabled'
const LAST_TAB_KEY = 'ov.gantt.lastTab'

export function getScheduleEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SCHEDULE_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function setScheduleEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCHEDULE_ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

export function getLastGanttTab(): GanttTab {
  if (typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(LAST_TAB_KEY)
    const n = raw == null ? 0 : Number(raw)
    return (n === 1 || n === 2 || n === 3) ? n : 0
  } catch {
    return 0
  }
}

export function setLastGanttTab(tab: GanttTab): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_TAB_KEY, String(tab))
  } catch {
    /* ignore */
  }
}
