/**
 * locoStatus — SINGLE SOURCE OF TRUTH for the per-locomotive status categorization
 * used across the Factory Load surfaces (main-tab hierarchy + the footer status bar).
 *
 * Phase 1 has no actual-hours data yet, so the classification is TIMELINE-based
 * (start/finish dates vs. Today). It maps onto the four categories already shown in
 * the AppFooter status bar so every view agrees on the same set + icons + colors:
 *
 *   standby  — not started (today < start)                      · gray  filled circle
 *   em_dia   — started, < 80% of the start→finish window elapsed · green warning
 *   em_risco — started, ≥ 80% elapsed but not past the deadline  · orange warning
 *   atraso   — today is past the finish date (deadline missed)   · red   warning
 *
 * When actual-hours integration lands, only `classifyLocoStatus` needs to change.
 */
import { Circle, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { RED } from '@/lib/ganttUtils'
import type { ModelGroup } from './types'

export type LocoStatus = 'standby' | 'em_dia' | 'em_risco' | 'atraso'

/** Fixed display order (Standby → Em dia → Em risco → Atraso). */
export const LOCO_STATUS_ORDER: LocoStatus[] = ['standby', 'em_dia', 'em_risco', 'atraso']

/** Timeline-based per-loco status (see file header). `today`, `startIso`, `finishIso`
 *  are all yyyy-mm-dd ISO strings so the comparisons are plain string/number math. */
export function classifyLocoStatus(startIso: string, finishIso: string, today: string): LocoStatus {
  if (!startIso || today < startIso) return 'standby'
  if (finishIso && today > finishIso) return 'atraso'
  const s = Date.parse(startIso)
  const e = Date.parse(finishIso || startIso)
  const t = Date.parse(today)
  const elapsed = Number.isFinite(s) && Number.isFinite(e) && e > s ? (t - s) / (e - s) : 1
  return elapsed >= 0.8 ? 'em_risco' : 'em_dia'
}

export const LOCO_STATUS_META: Record<LocoStatus, { label: string; color: string; Icon: LucideIcon; fill?: boolean }> = {
  standby:  { label: 'Standby',  color: '#9CA3AF', Icon: Circle, fill: true },
  em_dia:   { label: 'Em dia',   color: '#16A34A', Icon: AlertTriangle },
  em_risco: { label: 'Em risco', color: '#F59E0B', Icon: AlertTriangle },
  atraso:   { label: 'Atraso',   color: RED,       Icon: AlertTriangle },
}

/** Icon-only status indicator (no text). Tooltip carries the label for accessibility. */
export function LocoStatusIcon({ status, size = 12 }: { status: LocoStatus; size?: number }) {
  const m = LOCO_STATUS_META[status]
  const Icon = m.Icon
  return (
    <span title={m.label} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: m.color }}>
      <Icon size={size} {...(m.fill ? { fill: 'currentColor' } : {})} />
    </span>
  )
}

/** Aggregate a list of statuses into counts per category. */
export function tallyStatuses(statuses: Iterable<LocoStatus>): Record<LocoStatus, number> {
  const out: Record<LocoStatus, number> = { standby: 0, em_dia: 0, em_risco: 0, atraso: 0 }
  for (const s of statuses) out[s] += 1
  return out
}

/** Local "today" as yyyy-mm-dd (ISO-string comparison against start/finish dates).
 *  Shared so the main-tab hierarchy and the footer status bar use the same "today". */
export function todayIsoLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Derive a loco's planned start ISO exactly like the main-tab hierarchy: start_ms
 *  when present, else the first active hour (minISO). */
function locoStartIso(startMs: string | number | null | undefined, minISO: string): string {
  if (startMs == null || startMs === '') return minISO
  if (typeof startMs === 'number') return new Date(startMs).toISOString().slice(0, 10)
  const s = String(startMs)
  return (s.length >= 10 ? s.slice(0, 10) : '') || minISO
}

/** Aggregate per-loco statuses across every model group of a computed summary — the
 *  whole-dataset totals for the footer status bar. Uses the SAME start/finish
 *  derivation + classifier as the main-tab hierarchy so the counts always agree. */
export function tallySummaryStatuses(modelGroups: ModelGroup[], today: string): Record<LocoStatus, number> {
  const out: Record<LocoStatus, number> = { standby: 0, em_dia: 0, em_risco: 0, atraso: 0 }
  for (const mg of modelGroups)
    for (const l of mg.locos)
      out[classifyLocoStatus(locoStartIso(l.startMs, l.minISO), l.finishMS, today)] += 1
  return out
}

/** "icon + quantity" aggregated chips (no labels) for a Type/Model section. Only
 *  non-zero categories are shown, in fixed order, so the row reads left→right by
 *  severity. Rendered inside a fixed-width slot by the caller to avoid layout shift. */
export function StatusAggChips({ counts, size = 11, gap = 8 }: {
  counts: Record<LocoStatus, number>; size?: number; gap?: number
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap, whiteSpace: 'nowrap' }}>
      {LOCO_STATUS_ORDER.filter(s => counts[s] > 0).map(s => (
        <span key={s} title={LOCO_STATUS_META[s].label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <LocoStatusIcon status={s} size={size} />
          <span style={{ fontSize: size - 1, fontWeight: 700, color: LOCO_STATUS_META[s].color, fontVariantNumeric: 'tabular-nums' }}>
            {counts[s]}
          </span>
        </span>
      ))}
    </span>
  )
}
