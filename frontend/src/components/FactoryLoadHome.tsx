'use client'
/**
 * FactoryLoadHome — Factory Load main page (Phase 1: planned production tracking).
 *
 * Rendered on the LEFT HALF of the main page once a period is loaded and the Gantt
 * has been opened. MAIN CONTENT ONLY — mirroring the Análise de Capacidade layout:
 *   • filters live in the HEADER ("Filtros" + "Datas" buttons in AppHeader, gantt mode);
 *   • KPI cards live in the FOOTER (AppFooter red bar, gantt mode).
 * All shared state (dataset, filters, computed summary) comes from GanttInlineContext,
 * so this content always agrees with the header filters and footer KPIs.
 *
 * Content: planned-production hierarchy in expandable containers —
 *   Tipo → Modelo → Locomotiva → Área → Workstation → Part Number,
 * Tipos/Modelos/Locos ordered by earliest Start Date.
 *
 * Per-locomotive status (Current Date vs Start Date):
 *   started  (today ≥ start) → ES_SIDE icon + progress bars
 *   standby  (today < start) → ES_FRONT icon + "Standby" badge (no percentage)
 *
 * Actual hours (green) come from the Horas Transacionadas snapshot stored in our own DB,
 * never from the warehouse — so every role sees them. NEW LOCOS ONLY: hours reach a locomotive
 * through the work-order-prefix rule, which is only known to hold for that type. Other
 * Tipos render planned-only, exactly as before.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Clock, AlertTriangle } from 'lucide-react'
import { useGanttInlineMaybe } from '@/context/GanttInlineContext'
import type { TransactedHoursRollup, TransactedHoursScope, LocoScope } from '@/lib/api'
import { SUMMARY_LINE_TYPE_MAP, getTipoGeral } from '@/components/gantt/useGanttFilters'
import { TIPO_LABEL, type TipoKey } from '@/lib/tipos'
import { RED, RED_LT, fmt, wsSubLabel, monthKeyQuarter } from '@/lib/ganttUtils'
import { getMergeLocoTypes, subscribeMergeLocoTypes, mergeGanttLocoTypes } from '@/lib/locoMerge'
import {
  classifyLocoStatus, tallyStatuses, StatusAggChips, LOCO_STATUS_META,
  LocoStatusIcon as LocoStatusDot, type LocoStatus,
} from '@/components/gantt/locoStatus'

// ── Hierarchy node types ───────────────────────────────────────────────────────

// `hours` is PLANNED. `actual` is transacted hours from the stored Horas Transacionadas
// snapshot, merged in at every level (phase 2). It is always a number — 0 means "no hours
// logged", which is a real answer; "no snapshot loaded at all" is carried separately by
// `actualAvailable` on the component, so the UI can tell those two apart.
//
// `actualOnly` marks a node the PLAN never had: hours were booked against a
// (loco, workstation, part number) that isn't in the routing. Those rows are grafted into
// the tree with hours=0 so the work is visible rather than silently dropped.
type PnNode   = { key: string; pn: string; desc: string; hours: number; actual: number; actualOnly?: boolean }
type WsNode   = { key: string; label: string; hours: number; actual: number; pns: PnNode[]; actualOnly?: boolean }
type AreaNode = { key: string; area: string; hours: number; actual: number; wss: WsNode[]; actualOnly?: boolean }
type LocoNode = {
  key: string; loco: string; model: string; linha: string
  /** Planned start (ISO yyyy-mm-dd) — start_ms when present, else first active hour. */
  startIso: string
  /** Planned end (ISO yyyy-mm-dd) — last active hour (same semantics as the Resumo Geral Finish). */
  finishIso: string
  hours: number
  actual: number
  areas: AreaNode[]
}
type ModelNode = { key: string; model: string; fallback: boolean; startIso: string; finishIso: string; hours: number; actual: number; locos: LocoNode[] }
type TypeNode  = { key: string; label: string; startIso: string; finishIso: string; hours: number; actual: number; models: ModelNode[] }

/** Area that holds work booked against a workstation the routing never had for this loco. */
const OFF_PLAN_AREA = 'Realizado fora do plano'

/** Workstation code out of a tree key (`${ws}||${subarea}`) — the warehouse records the
 *  code alone, so the subarea half is never part of a comparison. */
const wsCodeOfKey = (key: string): string => key.split('||')[0].trim().toUpperCase()

/**
 * The SERIAL behind a locomotive's display name.
 *
 * A name may carry an artificial `B3#` tag, added only because the schedule cannot hold
 * two locos of the same name when one physical serial is planned under two Tipos. Nothing
 * outside the schedule has ever seen that tag. Must stay in step with
 * `_DISPLAY_TAG_RE` in backend/services/transacted_hours.py — this copy exists so the page
 * can tell which serials are contested and send routing only for those.
 */
const serialOf = (name: string): string =>
  name.trim().toUpperCase().replace(/^[A-Z0-9]{1,4}#/, '')

/** Actual/realizado green. Planned stays RED — the two quantities are never the same
 *  colour anywhere in this view (bar, per-row figure, tooltip). */
const GREEN = '#16A34A'

const TYPE_LABELS: Record<string, string> = { ...TIPO_LABEL, other: 'Outros' }

/** Normalize a group's start_ms (ISO string or epoch ms) to yyyy-mm-dd; '' when absent. */
function startIsoOf(startMs: string | number | null | undefined): string {
  if (startMs == null || startMs === '') return ''
  if (typeof startMs === 'number') return new Date(startMs).toISOString().slice(0, 10)
  const s = String(startMs)
  return s.length >= 10 ? s.slice(0, 10) : ''
}

function fmtIsoDate(iso: string): string {
  return iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—'
}

/** Local "today" as yyyy-mm-dd (ISO-string comparison against start dates). */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Schedule (timeline) progress: elapsed share of the start→end window at `today`.
 *  0% before the start date · 100% after the end date · proportional in between. */
function timelinePct(startIso: string, finishIso: string, today: string): number {
  if (!startIso || !finishIso) return 0
  if (today < startIso) return 0
  if (today >= finishIso) return 100
  const s = Date.parse(startIso), e = Date.parse(finishIso), t = Date.parse(today)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 100
  return Math.max(0, Math.min(100, Math.round(((t - s) / (e - s)) * 100)))
}

// ── Tabular column widths (px) — identical on every Tipo/Modelo/Loco row so
// counters, dates, bars and hours line up vertically across all sections. ──────
//   icon   — fixed slot for the ES_SIDE/ES_FRONT loco icon (New Locos only); the slot
//            is ALWAYS present (empty for other Tipos) so loco names stay aligned.
//   status — fixed slot for the aggregated "icon + qty" status chips on Tipo/Modelo
//            rows, so following columns never shift as counts change.
//   hours  — holds BOTH hour figures side by side (planned | realizado), each in its own
//            half, so the two columns line up down the whole tree and the planned figure
//            does not move when no snapshot is loaded.
const COL = { icon: 24, status: 132, counter: 62, date: 100, hours: 132, bars: 190 } as const

// ── Small building blocks ──────────────────────────────────────────────────────

/** Rotating the app logo centered in a placeholder container (Capacity Analysis pattern). */
function SpinnerCard({ height = 120 }: { height?: number }) {
  return (
    <div style={{
      height, borderRadius: 10, border: '1px solid #E5E7EB', background: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    }}>
      <img src="/imagens/wab1.png" alt="" width={28} height={28} className="animate-spin" />
    </div>
  )
}

/** Per-Tipo row icon, in two states.
 *
 *  Every pair is ONE subject drawn two ways — side profile for a started unit, the head-on
 *  view for one still waiting — which is the rule ES_SIDE.png / ES_FRONT.png already set
 *  for New Locos. "Has it started" then reads off the silhouette without a legend, and a
 *  new Tipo only ever needs two more files.
 *
 *  Propulsion / Motor Diesel / Overhaul were REMOVED once (2026-08-13) because the pairs then
 *  in use kept coming back as a scroll performance problem — lag and flicker down an expanded
 *  section, across two investigations. RESTORED with purpose-drawn artwork and, crucially,
 *  WITHOUT `blend` (see below), which was the actual cost.
 *
 *  `blend` is `mix-blend-mode: multiply`, and it is a WORKAROUND, not a style: it exists to
 *  knock out an OPAQUE WHITE background. It is expensive — blending forces the compositor
 *  to read the backdrop back on every repaint of the region, which kills the fast scroll
 *  path for the whole stacking context; with one icon per locomotive row and no
 *  virtualization here, that showed up as flicker while scrolling an expanded section.
 *  NO ENTRY USES IT ANY MORE: every file below was checked to carry a real alpha channel
 *  (37–79% of pixels fully transparent, corner RGBA 0,0,0,0), so there is no white plate to
 *  knock out and the flag would be paying that cost for nothing. Only add it back for a
 *  replacement PNG that is genuinely opaque — and prefer re-exporting the PNG instead.
 *
 *  `masc` picks the agreement in the alt text ("Motor Diesel iniciado", not "iniciada").
 *
 *  Tipos absent from this map keep an empty (but reserved) slot, so names stay aligned. */
const TYPE_ICONS: Partial<Record<TipoKey, {
  started: string; standby: string; noun: string; masc?: boolean; blend?: boolean
}>> = {
  new_locos:    { started: '/imagens/ES_SIDE.png',         standby: '/imagens/ES_FRONT.png',         noun: 'Locomotiva' },
  propulsion:   { started: '/imagens/PROPULSION_SIDE.png', standby: '/imagens/PROPULSION_FRONT.png', noun: 'Propulsão' },
  motor_diesel: { started: '/imagens/DIESEL_SIDE.png',     standby: '/imagens/DIESEL_FRONT.png',     noun: 'Motor Diesel', masc: true },
  overhaul:     { started: '/imagens/OVERHAUL_SIDE.png',   standby: '/imagens/OVERHAUL_FRONT.png',   noun: 'Overhaul',     masc: true },
}

/** Fixed-width slot for the per-Tipo row icon.
 *
 *  The slot is ALWAYS `COL.icon` wide and the image is contained inside it, so:
 *   • every icon occupies the exact same fixed-width area and is perfectly aligned;
 *   • when the Tipo has no icon the slot stays reserved but empty, so every loco name
 *     lines up regardless of whether one is displayed. */
function LocoStartIcon({ tipo, started }: { tipo: string; started: boolean }) {
  // `tipo` arrives as a plain string (it can be the 'other' catch-all, which is not a
  // TipoKey and legitimately has no icon), so the lookup is narrowed here rather than by
  // widening the map — the map stays keyed on TipoKey so a new Tipo is visible in it.
  const icon = TYPE_ICONS[tipo as TipoKey]
  return (
    <span style={{ width: COL.icon, height: 22, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {icon && (
        <img
          src={started ? icon.started : icon.standby}
          alt={`${icon.noun} ${started ? 'iniciad' : 'não iniciad'}${icon.masc ? 'o' : 'a'}`}
          title={started ? 'Iniciada (data atual ≥ início)' : 'Aguardando início'}
          // Explicit pixel size, not `auto` + `max-*`: it removes any dependence on the
          // image's intrinsic size, so a row's height cannot change once the file decodes.
          width={22}
          height={22}
          style={{
            width: 22, height: 22, objectFit: 'contain',
            ...(icon.blend ? { mixBlendMode: 'multiply' as const } : null),
          }}
        />
      )}
    </span>
  )
}

/** Dual per-locomotive progress indicators, stacked in a fixed-width column. Each bar
 *  carries ITS OWN percentage on the same line, so neither number has to be inferred
 *  from the other:
 *
 *  • TOP (secondary, schedule): thin single-line bar filled with a diagonal hatch —
 *    elapsed timeline share (start → end vs Today, see timelinePct). The hatch takes the
 *    loco's STATUS colour (em dia green · em risco amber · atraso red · standby grey) at
 *    60% alpha, so how much time has gone and whether that is a problem are one glance
 *    instead of two. Kept thin and translucent: it stays secondary to the bar below.
 *  • BOTTOM (primary, hours): solid bar for Actual vs Planned hours, GREEN — the same
 *    colour the "hrs realizadas" figure uses, so the bar and the number are obviously the
 *    same quantity. Fed from the stored Horas Transacionadas snapshot.
 *
 *  `available` is false when NO snapshot is loaded. That is not 0% — it is "unknown", and
 *  drawing an empty green bar would assert that nothing has been built. The bar is left
 *  grey and the label shows "—".
 *
 *  Standby locos (Today < start) show "Standby" for the hours instead of a percentage.
 *  Percentages above 100 are shown as-is (over-run is real information) while the BAR
 *  clamps, so it can't overflow its track. */
function LocoProgress({ started, progress, schedulePct, available, status }: {
  started: boolean; progress: number; schedulePct: number; available: boolean
  status: LocoStatus
}) {
  const pct = Math.max(0, Math.min(100, progress))
  const sched = Math.max(0, Math.min(100, schedulePct))
  const statusColor = LOCO_STATUS_META[status].color
  const LABEL_W = 42
  const labelBase: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, width: LABEL_W, flexShrink: 0,
    textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, width: COL.bars, flexShrink: 0 }}>
      {/* Secondary: schedule progress (timeline). A small black clock marks the current
          position (Today) at the bar's leading edge, i.e. `sched%` of the start→end
          timeline; it only shows once the loco has started. */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          title={`Cronograma: ${sched}% do período decorrido · ${LOCO_STATUS_META[status].label}`}
          style={{ position: 'relative', flex: 1, minWidth: 0, height: 4, borderRadius: 2, background: '#F3F4F6', display: 'block' }}
        >
          <span style={{
            display: 'block', height: '100%', width: `${sched}%`, borderRadius: 2, transition: 'width 0.3s',
            backgroundImage: `repeating-linear-gradient(45deg, ${statusColor}99 0, ${statusColor}99 2px, transparent 2px, transparent 5px)`,
          }} />
          {started && (
            <span
              aria-hidden
              style={{
                position: 'absolute', top: '50%', left: `${sched}%`,
                transform: 'translate(-50%, -50%)', transition: 'left 0.3s',
                color: '#111827', display: 'inline-flex', pointerEvents: 'none',
              }}
            >
              <Clock size={9} strokeWidth={2.25} />
            </span>
          )}
        </span>
        <span style={{ ...labelBase, color: statusColor }}>{sched}%</span>
      </span>

      {/* Primary: Actual vs Planned hours — solid, prominent, GREEN */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          title={available
            ? `Horas realizadas vs. planejadas: ${Math.round(progress)}%`
            : 'Horas realizadas indisponíveis — carregue Horas Transacionadas'}
          style={{ flex: 1, minWidth: 0, height: 8, borderRadius: 4, background: '#F3F4F6', border: '1px solid #E5E7EB', overflow: 'hidden', display: 'block' }}
        >
          {available && (
            <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: GREEN, transition: 'width 0.3s' }} />
          )}
        </span>
        <span style={{
          ...labelBase,
          color: available && started ? GREEN : '#6B7280',
          textTransform: started ? undefined : 'uppercase',
          letterSpacing: started ? undefined : '0.03em',
        }}>
          {!started ? 'Standby' : available ? `${Math.round(progress)}%` : '—'}
        </span>
      </span>
    </span>
  )
}

/** "Iniciadas / Total" counter chip shown on Tipo and Modelo cards — fixed-width
 *  column so counters line up vertically across all sections. `prominent` (Tipo rows)
 *  makes the locomotive count stand out (larger, bolder, always red-accented) so the
 *  Type-level summary is the easiest thing to scan; Modelo rows stay secondary. */
function StartedCounter({ started, total, prominent = false }: { started: number; total: number; prominent?: boolean }) {
  const hot = started > 0
  return (
    <span style={{ width: COL.counter, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
      <span title="Locomotivas iniciadas / total" style={{
        fontSize: prominent ? 12 : 10, fontWeight: prominent ? 800 : 700, whiteSpace: 'nowrap',
        color: prominent || hot ? RED : '#6B7280',
        background: prominent || hot ? RED_LT : '#F3F4F6',
        border: `1px solid ${prominent || hot ? `${RED}66` : '#E5E7EB'}`,
        borderRadius: 10, padding: prominent ? '2px 9px' : '1px 8px',
        boxShadow: prominent ? `0 0 0 1px ${RED}12` : undefined,
      }}>
        {fmt(started)} / {fmt(total)}
      </span>
    </span>
  )
}

/** Fixed-width date column ("Início dd/mm/yyyy" / "Fim dd/mm/yyyy") — same width on
 *  every row so start/end dates align vertically across all sections. `strong` (the
 *  Tipo Início/Fim) emphasises BOTH the label and the value in red/bold so the
 *  Start/End information reads as the primary Type-level summary; regular cells stay
 *  muted/secondary. */
function DateCell({ label, iso, size = 10, strong = false }: { label: string; iso: string; size?: number; strong?: boolean }) {
  return (
    <span style={{ width: COL.date, fontSize: size, color: strong ? RED : '#9CA3AF', fontWeight: strong ? 700 : undefined, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {label}{' '}
      <span style={{ color: strong ? RED : '#6B7280', fontWeight: strong ? 800 : 600, fontSize: strong ? size + 1 : size }}>
        {fmtIsoDate(iso)}
      </span>
    </span>
  )
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronDown size={13} style={{ color: '#9CA3AF', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
}

/** Fixed-width slot holding the aggregated "icon + qty" status chips on Tipo/Modelo
 *  rows. Right-aligned inside a constant `COL.status` width so the counter/date/hours
 *  columns that follow never shift as the status mix changes across sections. */
function StatusCell({ counts, size = 11 }: { counts: Record<LocoStatus, number>; size?: number }) {
  return (
    <span style={{ width: COL.status, display: 'inline-flex', justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0, overflow: 'hidden' }}>
      <StatusAggChips counts={counts} size={size} />
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

// Stable fallback for the no-provider/no-data case (keeps useMemo deps stable).
const EMPTY_SET: Set<string> = new Set()

export function FactoryLoadHome() {
  const inline = useGanttInlineMaybe()
  // Read-only here: the switch is owned by the Resumo Geral footer button (lib/locoMerge). This
  // page follows it so the two consolidations can never show a different picture of one serial,
  // but it deliberately offers no control of its own.
  const mergeLocos = useSyncExternalStore(subscribeMergeLocoTypes, getMergeLocoTypes, getMergeLocoTypes)
  const effectiveData    = inline?.effectiveData ?? null
  const activeBizISOs    = inline?.activeBizISOs ?? null
  const summaryLineTypes = inline?.summaryLineTypes ?? EMPTY_SET
  const selModels        = inline?.selModels ?? EMPTY_SET
  const selAreas         = inline?.selAreas ?? EMPTY_SET
  const selWorkstations  = inline?.selWorkstations ?? EMPTY_SET
  const selYears         = inline?.selYears ?? EMPTY_SET
  const selQuarters      = inline?.selQuarters ?? EMPTY_SET
  const selMonths        = inline?.selMonths ?? EMPTY_SET
  const selFws           = inline?.selFws ?? EMPTY_SET

  // ── Planned hierarchy: Tipo → Modelo → Loco → Área → Workstation → PN ───────
  // Applies the SAME filters as useSummaryCompute (line types, models, areas,
  // workstations, active date ISOs) so the containers always agree with the
  // footer KPIs computed in GanttInlineContext.
  const hierarchy = useMemo<TypeNode[]>(() => {
    if (!effectiveData) return []
    // "Unir locos" — one serial planned under two Tipos folds into the Tipo with the most
    // total hours BEFORE the tree is built, by re-badging the losing groups. Everything below
    // then accumulates them into a single locomotive node, under the winner's model and with
    // the winner's start date, with no special case anywhere in the build. Off (the default)
    // this is the identity function.
    const source = mergeLocos ? mergeGanttLocoTypes(effectiveData, getTipoGeral, activeBizISOs) : effectiveData
    const totalTypes = Object.keys(SUMMARY_LINE_TYPE_MAP).length
    const hasLineTypeFilter = summaryLineTypes.size < totalTypes
    const activeLinhas = new Set<string>()
    if (hasLineTypeFilter) {
      for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
        if (summaryLineTypes.has(key)) linhas.forEach(l => activeLinhas.add(l))
    }
    const isIsoActive = (iso: string) => !activeBizISOs || activeBizISOs.has(iso)

    type LocoAcc = {
      loco: string; model: string; linha: string; startMsIso: string; minISO: string; maxISO: string
      hours: number; fallback: boolean
      areas: Map<string, { hours: number; wss: Map<string, { label: string; hours: number; pns: Map<string, { pn: string; desc: string; hours: number }> }> }>
    }
    // Loco instance identity = task_name || start_ms (same as useSummaryCompute).
    const locosByModel = new Map<string, Map<string, LocoAcc>>()

    for (const g of source.groups) {
      if (hasLineTypeFilter && !activeLinhas.has(g.linha)) continue
      if (selModels.size > 0 && !selModels.has(g.wo)) continue
      let m = locosByModel.get(g.wo)
      if (!m) { m = new Map(); locosByModel.set(g.wo, m) }
      const instKey = `${g.task_name}||${String(g.start_ms ?? '')}`
      let acc = m.get(instKey)
      if (!acc) {
        acc = { loco: g.task_name, model: g.wo, linha: g.linha, startMsIso: startIsoOf(g.start_ms), minISO: '', maxISO: '', hours: 0, fallback: !!g.fallback, areas: new Map() }
        m.set(instKey, acc)
      }
      for (const wst of g.workstations) {
        const areaName = (wst.area && wst.area.trim()) || 'Sem área'
        if (selAreas.size > 0 && !selAreas.has(areaName)) continue
        if (selWorkstations.size > 0 && !selWorkstations.has(wst.ws)) continue
        let a = acc.areas.get(areaName)
        if (!a) { a = { hours: 0, wss: new Map() }; acc.areas.set(areaName, a) }
        const wsKey = `${wst.ws}||${(wst.subarea && wst.subarea.trim()) || ''}`
        let w = a.wss.get(wsKey)
        if (!w) { w = { label: wsSubLabel(wst.ws, wst.subarea), hours: 0, pns: new Map() }; a.wss.set(wsKey, w) }
        for (const dr of wst.desc_rows) {
          const pnKey = `${dr.pn ?? ''}||${dr.desc ?? ''}`
          let p = w.pns.get(pnKey)
          for (const [iso, cell] of Object.entries(dr.cells)) {
            if (!isIsoActive(iso)) continue
            const hh = Number(cell.hh || 0)
            if (hh === 0) continue
            if (!p) { p = { pn: dr.pn ?? '', desc: dr.desc ?? '', hours: 0 }; w.pns.set(pnKey, p) }
            p.hours += hh; w.hours += hh; a.hours += hh; acc.hours += hh
            if (!acc.minISO || iso < acc.minISO) acc.minISO = iso
            if (!acc.maxISO || iso > acc.maxISO) acc.maxISO = iso
          }
        }
      }
    }

    // Materialize + sort every level. Loco start = start_ms when present, else the
    // first active hour (same fallback the Resumo Geral uses for its Start column).
    const typeMap = new Map<string, TypeNode>()
    for (const [model, locoMap] of locosByModel) {
      const locos: LocoNode[] = [...locoMap.values()]
        .filter(l => l.hours > 0)
        .map(l => ({
          key: `${model}||${l.loco}||${l.startMsIso}`,
          loco: l.loco, model, linha: l.linha,
          startIso: l.startMsIso || l.minISO,
          finishIso: l.maxISO,
          hours: l.hours,
          actual: 0,                       // filled by the merge pass below
          areas: [...l.areas.entries()]
            .map(([area, a]) => ({
              key: area, area, hours: a.hours, actual: 0,
              wss: [...a.wss.entries()]
                .map(([wsKey, w]) => ({
                  key: wsKey, label: w.label, hours: w.hours, actual: 0,
                  pns: [...w.pns.values()]
                    .map(p => ({ key: `${p.pn}||${p.desc}`, pn: p.pn, desc: p.desc, hours: p.hours, actual: 0 }))
                    .sort((x, y) => y.hours - x.hours),
                }))
                .sort((x, y) => y.hours - x.hours),
            }))
            .sort((x, y) => y.hours - x.hours),
        }))
        .sort((x, y) => (x.startIso || '9999').localeCompare(y.startIso || '9999'))
      if (locos.length === 0) continue

      const tipo = getTipoGeral(locos[0].linha)
      const modelNode: ModelNode = {
        key: `${tipo}||${model}`, model,
        fallback: [...locoMap.values()].some(l => l.fallback),
        startIso: locos[0].startIso,
        finishIso: locos.reduce((max, l) => (l.finishIso > max ? l.finishIso : max), ''),
        hours: locos.reduce((s, l) => s + l.hours, 0),
        actual: 0,
        locos,
      }
      let t = typeMap.get(tipo)
      if (!t) { t = { key: tipo, label: TYPE_LABELS[tipo] ?? tipo, startIso: '', finishIso: '', hours: 0, actual: 0, models: [] }; typeMap.set(tipo, t) }
      t.models.push(modelNode)
      t.hours += modelNode.hours
      if (!t.startIso || (modelNode.startIso && modelNode.startIso < t.startIso)) t.startIso = modelNode.startIso
      if (modelNode.finishIso > t.finishIso) t.finishIso = modelNode.finishIso
    }
    const types = [...typeMap.values()]
    for (const t of types) t.models.sort((x, y) => (x.startIso || '9999').localeCompare(y.startIso || '9999'))
    types.sort((x, y) => (x.startIso || '9999').localeCompare(y.startIso || '9999'))
    return types
  }, [effectiveData, summaryLineTypes, selModels, selAreas, selWorkstations, activeBizISOs, mergeLocos])

  // ── Actual (transacted) hours ────────────────────────────────────────────────
  // Read from the snapshot phase 1 stored in our own DB — never from the warehouse — so this
  // works for every role and every session.
  //
  // EVERY Tipo is in scope, not just New Locos. The old restriction existed because the
  // work-order prefix rule could not tell two Tipos apart; it did not make the numbers
  // safe, it made Propulsion invisible — and worse, a Propulsion work order still began
  // with the bare serial, so it matched the New Locos loco of the same serial and its
  // hours landed there as "fora do plano". Attribution is now decided by ROUTING (see
  // services/transacted_hours.py::_fold_by_loco), so the scope can be complete.
  //
  // Routing is sent only for locos whose serial is shared by more than one loco — those
  // are the only rows the server ever consults it for, and shipping every loco's part
  // numbers would be a payload of tens of thousands of strings for nothing.
  const rollupScope = useMemo<TransactedHoursScope>(() => {
    type Entry = { loco: LocoNode; tipo: string }
    const all: Entry[] = []
    const typeWs: Record<string, Set<string>> = {}
    for (const t of hierarchy) {
      const vocab = typeWs[t.key] ?? (typeWs[t.key] = new Set())
      for (const m of t.models) for (const l of m.locos) {
        all.push({ loco: l, tipo: t.key })
        for (const a of l.areas) for (const w of a.wss) vocab.add(wsCodeOfKey(w.key))
      }
    }
    // A serial is "contested" when two locos normalize to it — that is exactly when the
    // server needs routing to choose between them.
    const bySerial = new Map<string, number>()
    for (const e of all) {
      const s = serialOf(e.loco.loco)
      bySerial.set(s, (bySerial.get(s) ?? 0) + 1)
    }
    const locos: LocoScope[] = all.map(({ loco, tipo }) => {
      if ((bySerial.get(serialOf(loco.loco)) ?? 0) < 2) return { name: loco.loco, tipo }
      const ws = new Set<string>()
      const items = new Set<string>()
      for (const a of loco.areas) for (const w of a.wss) {
        const code = wsCodeOfKey(w.key)
        ws.add(code)
        for (const p of w.pns) items.add(`${code}||${p.pn.trim().toUpperCase()}`)
      }
      return { name: loco.loco, tipo, ws: [...ws], items: [...items] }
    })
    return {
      locos,
      typeWs: Object.fromEntries(Object.entries(typeWs).map(([k, v]) => [k, [...v]])),
    }
  }, [hierarchy])

  // Actual hours arrive only as an inline prévia now; there is no stored snapshot to read.
  const storedRollup: TransactedHoursRollup | null = null

  // Stable identity for the scope: the names alone are enough, because routing only ever
  // changes alongside them.
  const locosKey = rollupScope.locos.map(l => `${l.tipo}:${l.name}`).join('|')

  // Publish the list so the Horas Transacionadas modal (header side) asks the server for a
  // rollup over exactly these locos — see GanttInlineContext.mainLocoNames.
  // Optional-chained: these hooks run above the `if (!inline?.data) return null` guard, so
  // they must tolerate a not-yet-populated provider.
  const publishLocos = inline?.setMainLocoNames
  useEffect(() => {
    publishLocos?.(rollupScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locosKey is rollupScope's stable identity
  }, [locosKey, publishLocos])

  // An unsaved prévia WINS over the stored snapshot. That is the point of applying it: the
  // user is checking this exact mapping before paying for the write, so the screen has to
  // show the candidate data, not the data it would replace. `pendingUnsaved` drives the
  // banner — the numbers are indistinguishable from stored ones without it.
  const rollup = inline?.pendingRollup ?? storedRollup
  const pendingUnsaved = !!inline?.pendingRollup?.pending
  // Distinguishes "0 h logged" from "no snapshot": the first is a fact worth showing, the
  // second must not be drawn as 0% progress against a plan.
  const actualAvailable = !!rollup?.has_data

  // Merge actual hours into the planned tree and graft on whatever the plan never had.
  //
  // Placement is keyed by (workstation, part number), matching the backend's grain. A
  // workstation is matched on its CODE — the tree's key is `${ws}||${subarea}`, and the
  // warehouse only records the code, so the subarea half is not part of the comparison.
  // Anything with no home is created: a missing part number joins its workstation with
  // planned 0, a missing workstation is created under OFF_PLAN_AREA. Both keep the work
  // visible instead of dropping it because the routing disagreed.
  const merged = useMemo<TypeNode[]>(() => {
    if (!rollup?.has_data) return hierarchy

    // Every Tipo, not only New Locos — see `rollupScope`. A Tipo with no hours simply gets
    // no hit and passes through untouched, which is what the old early-return did anyway
    // for the wrong reason.
    return hierarchy.map(t => {
      const models = t.models.map(m => {
        const locos = m.locos.map(l => {
          const hit = rollup.locos[l.loco]
          if (!hit) return l

          // Deep-clone the branches being mutated — `hierarchy` is memoized upstream and
          // must not be written through.
          const areas: AreaNode[] = l.areas.map(a => ({
            ...a, actual: 0,
            wss: a.wss.map(w => ({ ...w, actual: 0, pns: w.pns.map(p => ({ ...p, actual: 0 })) })),
          }))

          const wsCodeOf = wsCodeOfKey
          const findWs = (code: string) => {
            for (const a of areas) {
              const w = a.wss.find(x => wsCodeOf(x.key) === code)
              if (w) return { area: a, ws: w }
            }
            return null
          }

          for (const item of hit.items) {
            const code = item.workstation.trim().toUpperCase()
            const pn   = item.part_number.trim()
            let target = findWs(code)

            if (!target) {
              let offPlan = areas.find(a => a.key === OFF_PLAN_AREA)
              if (!offPlan) {
                offPlan = { key: OFF_PLAN_AREA, area: OFF_PLAN_AREA, hours: 0, actual: 0, wss: [], actualOnly: true }
                areas.push(offPlan)
              }
              const ws: WsNode = {
                key: `${item.workstation}||`, label: item.workstation || '(sem WS)',
                hours: 0, actual: 0, pns: [], actualOnly: true,
              }
              offPlan.wss.push(ws)
              target = { area: offPlan, ws }
            }

            let pnNode = target.ws.pns.find(p => p.pn.trim().toUpperCase() === pn.toUpperCase())
            if (!pnNode) {
              pnNode = { key: `${pn}||`, pn: pn || '(sem PN)', desc: '', hours: 0, actual: 0, actualOnly: true }
              target.ws.pns.push(pnNode)
            }
            pnNode.actual += item.hours
          }

          // Roll upward from the leaves so every level agrees by construction.
          for (const a of areas) {
            for (const w of a.wss) w.actual = w.pns.reduce((s, p) => s + p.actual, 0)
            a.actual = a.wss.reduce((s, w) => s + w.actual, 0)
            for (const w of a.wss) w.pns.sort((x, y) => (y.hours + y.actual) - (x.hours + x.actual))
            a.wss.sort((x, y) => (y.hours + y.actual) - (x.hours + x.actual))
          }
          areas.sort((x, y) => (y.hours + y.actual) - (x.hours + x.actual))

          return { ...l, actual: areas.reduce((s, a) => s + a.actual, 0), areas }
        })
        return { ...m, actual: locos.reduce((s, l) => s + l.actual, 0), locos }
      })
      return { ...t, actual: models.reduce((s, m) => s + m.actual, 0), models }
    })
  }, [hierarchy, rollup])

  // ── The GCR Tipo: one card, no drill-down ───────────────────────────────────
  //
  // A LEAF TypeNode — `models: []`. That is not a degenerate case to work around, it is the
  // shape of the Tipo: GCR plans PARTS and has no locomotives (`tipoHasLoco` is false for it),
  // so there is nothing under the card to open. Every level of this tree below Tipo is
  // Modelo → Loco, and rendering an expandable card onto an empty one would be a chevron that
  // opens nothing.
  //

  const sections = useMemo<TypeNode[]>(() => merged, [merged])

  // ── Expand/collapse state per level ──────────────────────────────────────────
  const [expTypes,  setExpTypes]  = useState<Set<string>>(new Set())
  const [expModels, setExpModels] = useState<Set<string>>(new Set())
  const [expLocos,  setExpLocos]  = useState<Set<string>>(new Set())
  const [expAreas,  setExpAreas]  = useState<Set<string>>(new Set())
  const [expWs,     setExpWs]     = useState<Set<string>>(new Set())
  const toggleKey = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (k: string) =>
    set(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const toggleType  = toggleKey(setExpTypes)
  const toggleModel = toggleKey(setExpModels)
  const toggleLoco  = toggleKey(setExpLocos)
  const toggleArea  = toggleKey(setExpAreas)
  const toggleWsKey = toggleKey(setExpWs)

  if (!inline?.data) return null

  const today = todayIso()
  const isStarted = (startIso: string) => !!startIso && startIso <= today
  const startedIn = (locos: LocoNode[]) => locos.filter(l => isStarted(l.startIso)).length
  // Per-loco status (timeline-based, Phase 1) + section aggregation — shared logic so
  // the per-loco icon and the Tipo/Modelo "icon + qty" totals always agree.
  const statusOf = (l: LocoNode): LocoStatus => classifyLocoStatus(l.startIso, l.finishIso, today)
  const statusCountsOf = (locos: LocoNode[]) => tallyStatuses(locos.map(statusOf))

  // The GCR fetch counts as loading too: for a GCR-ONLY selection the Schedule side finishes
  // immediately with nothing in it, so without this the page showed "Nenhuma locomotiva" until
  // the plan landed — an empty-state message for data that was still on its way.
  const loadingContent = inline.summaryComputing || !inline.summaryTestData 

  const rowBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '8px 12px',
  }
  // Planned hours (red / neutral by level) and the realizado figure BESIDE it in green —
  // two equal halves of one fixed-width cell, planned always left and realizado always
  // right. Side by side rather than stacked so a row is one line high and the two
  // quantities can be compared by reading across instead of down.
  //
  // The right half is ALWAYS rendered, empty when no snapshot is loaded: dropping it
  // would slide the planned figure sideways the moment hours arrive, moving every number
  // in the tree at once.
  const hoursLabel = (h: number, size = 11, color = '#6B7280', actual?: number) => (
    <span style={{ marginLeft: 'auto', width: COL.hours, flexShrink: 0, display: 'flex', alignItems: 'baseline', lineHeight: 1.15 }}>
      <span style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: size, fontWeight: 700, color, whiteSpace: 'nowrap' }}>
        {fmt(Math.round(h))} h
      </span>
      <span
        title={actualAvailable && actual != null ? `Horas realizadas: ${fmt(Math.round(actual))} h` : undefined}
        style={{ flex: 1, minWidth: 0, textAlign: 'right', paddingLeft: 8, fontSize: size, fontWeight: 700, color: GREEN, whiteSpace: 'nowrap' }}
      >
        {actualAvailable && actual != null ? `${fmt(Math.round(actual))} h` : ''}
      </span>
    </span>
  )

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '16px 24px', gap: 16 }}>
      {/* ── LEFT HALF: Factory Load planned-production hierarchy ── */}
      {/* 70%, not 50%: the hour figures now sit side by side rather than stacked, and the
          progress column carries a label per bar. */}
      <div style={{ width: '70%', minWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* No "Unir locos" control here BY DESIGN: the only trigger is in the Resumo Geral footer
            (GanttModalFooter). This tree still FOLLOWS the switch — it subscribes to the same store
            and re-merges when it flips — it just doesn't offer a second place to flip it. */}

        {/* Unsaved prévia. Everything green below is a candidate, not stored data — and the
            two are visually identical, so this banner is the only thing separating them.
            Amber rather than green: it is a warning about provenance, not a success. */}
        {pendingUnsaved && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8,
            background: '#FFFBEB', border: '1px solid #FDE68A',
          }}>
            <AlertTriangle size={14} style={{ color: '#F59E0B', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11, lineHeight: 1.35, color: '#92400E' }}>
              <strong>Prévia não salva.</strong> As horas realizadas abaixo vêm de uma consulta
              ainda não gravada no banco — confira o mapeamento e volte em Horas Transacionadas
              para salvar. Recarregar a página descarta.
            </span>
          </div>
        )}

        {/* Hours the rollup could not place. These MUST be on screen: the matcher refuses to
            guess an owner when a serial exists under two Tipos and neither Tipo's routing
            has the workstation, and a refusal that shows nothing is indistinguishable from
            hours that were never booked. Two causes, both listed by work order below:
            no locomotive matched the work-order prefix at all, or the serial was contested
            and unclaimable. */}
        {rollup?.unmatched && rollup.unmatched.hours > 0 && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8,
            background: '#FFF7ED', border: '1px solid #FED7AA',
          }}>
            <AlertTriangle size={14} style={{ color: '#EA580C', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11, lineHeight: 1.35, color: '#9A3412' }}>
              <strong>{fmt(Math.round(rollup.unmatched.hours))} h não atribuídas</strong>{' '}
              em {fmt(rollup.unmatched.workorders)} work order(s) — nenhuma locomotiva do plano
              reivindicou essas horas, ou a série existe em mais de um Tipo e a workstation não
              pertence à rota de nenhum deles. Elas não aparecem em nenhuma linha abaixo.
              {rollup.unmatched.sample.length > 0 && (
                <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
                  Exemplos: {rollup.unmatched.sample.slice(0, 8).join(' · ')}
                  {rollup.unmatched.workorders > 8 ? ' …' : ''}
                </span>
              )}
            </span>
          </div>
        )}

        {/* Placed, but the serial exists under more than one Tipo and both routings could
            have taken the row. Counted in the totals below — flagged so the collision can
            be resolved instead of quietly settled by sort order. */}
        {rollup?.ambiguous && rollup.ambiguous.hours > 0 && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8,
            background: '#FFFBEB', border: '1px solid #FDE68A',
          }}>
            <AlertTriangle size={14} style={{ color: '#F59E0B', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11, lineHeight: 1.35, color: '#92400E' }}>
              <strong>{fmt(Math.round(rollup.ambiguous.hours))} h ambíguas</strong>{' '}
              em {fmt(rollup.ambiguous.workorders)} work order(s): a série está planejada em mais
              de um Tipo e a workstation pertence à rota de ambos. As horas foram atribuídas a um
              deles — confira antes de usar o número.
              {rollup.ambiguous.sample.length > 0 && (
                <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
                  Exemplos: {rollup.ambiguous.sample.slice(0, 8).join(' · ')}
                  {rollup.ambiguous.workorders > 8 ? ' …' : ''}
                </span>
              )}
            </span>
          </div>
        )}

        {/* Placeholder containers with the rotating the app logo while loading
            (Capacity Analysis pattern), replaced by the hierarchy when ready */}
        {loadingContent ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SpinnerCard /><SpinnerCard /><SpinnerCard />
          </div>
        ) : sections.length === 0 ? (
          <div style={{ borderRadius: 10, border: '1px dashed #D1D5DB', background: '#F9FAFB', padding: '28px 16px', textAlign: 'center', fontSize: 12, color: '#9CA3AF' }}>
            Nenhuma locomotiva para os filtros selecionados.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sections.map(t => {
              // A Tipo with no Modelo level is a LEAF (GCR): the card shows its hours and does
              // not open. Rendered as a plain div, not a disabled button — there is no action
              // here to disable, and a button that never does anything still invites the click.
              const leaf = t.models.length === 0
              const tOpen = !leaf && expTypes.has(t.key)
              const tLocos = t.models.flatMap(m => m.locos)
              const header = (
                <>
                  {/* Same fixed columns as an expandable card, EMPTY where the Tipo has no such
                      figure, so hours stay in the same place down the whole page. */}
                  {leaf
                    ? <span style={{ width: 13, flexShrink: 0 }} />
                    : <Chevron open={tOpen} />}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 800, color: RED, letterSpacing: '0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
                  {leaf ? (
                    <>
                      {/* No locos, so no status mix, no started counter and no dates: the plan
                          is keyed by fiscal week and has no locomotives to date or count. */}
                      <span style={{ width: COL.status, flexShrink: 0 }} />
                      <span style={{ width: COL.counter, flexShrink: 0 }} />
                      <span style={{ width: COL.date, flexShrink: 0 }} />
                      <span style={{ width: COL.date, flexShrink: 0 }} />
                    </>
                  ) : (
                    <>
                      <StatusCell counts={statusCountsOf(tLocos)} size={12} />
                      <StartedCounter started={startedIn(tLocos)} total={tLocos.length} prominent />
                      <DateCell label="Início" iso={t.startIso} strong />
                      <DateCell label="Fim" iso={t.finishIso} strong />
                    </>
                  )}
                  {hoursLabel(t.hours, 13, RED, t.actual)}
                </>
              )
              return (
                <div key={t.key} style={{
                  // Tipo card — the most prominent card on the page: red left accent,
                  // red-tinted border and a slightly stronger shadow.
                  borderRadius: 10, border: `1px solid ${RED}40`, borderLeft: `4px solid ${RED}`,
                  background: '#fff', boxShadow: '0 2px 6px rgba(211,47,47,0.10)', overflow: 'hidden',
                }}>
                  {/* Tipo card header — fixed columns: counter | início | fim | horas */}
                  {leaf ? (
                    <div style={{ ...rowBase, padding: '12px 14px', cursor: 'default', background: 'linear-gradient(to right, #fff, #FFF8F8)' }}>
                      {header}
                    </div>
                  ) : (
                    <button onClick={() => toggleType(t.key)} style={{ ...rowBase, padding: '12px 14px', background: tOpen ? '#FFF5F5' : 'linear-gradient(to right, #fff, #FFF8F8)' }}>
                      {header}
                    </button>
                  )}
                  {tOpen && (
                    <div style={{ borderTop: '1px solid #F3F4F6', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, background: '#FCFCFD' }}>
                      {t.models.map(m => {
                        const mOpen = expModels.has(m.key)
                        return (
                          <div key={m.key} style={{
                            // Modelo card — moderate emphasis (less than the Tipo card):
                            // thinner, softer red left accent and a light shadow.
                            borderRadius: 8, border: '1px solid #E5E7EB', borderLeft: `3px solid ${RED}66`,
                            background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'hidden',
                          }}>
                            {/* Modelo card header — same fixed columns as the Tipo header
                                so counters/dates align across all model sections */}
                            <button onClick={() => toggleModel(m.key)} style={{ ...rowBase, padding: '8px 12px' }}>
                              <Chevron open={mOpen} />
                              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 800, color: '#1F2937', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {m.model}{m.fallback && <span style={{ color: '#9CA3AF', fontWeight: 500 }}> (FB)</span>}
                              </span>
                              <StatusCell counts={statusCountsOf(m.locos)} size={10} />
                              <StartedCounter started={startedIn(m.locos)} total={m.locos.length} />
                              <DateCell label="Início" iso={m.startIso} />
                              <DateCell label="Fim" iso={m.finishIso} />
                              {hoursLabel(m.hours, 11, '#374151', m.actual)}
                            </button>
                            {mOpen && (
                              <div style={{ borderTop: '1px solid #F3F4F6' }}>
                                {m.locos.map(l => {
                                  const lOpen = expLocos.has(l.key)
                                  const started = isStarted(l.startIso)
                                  return (
                                    <div key={l.key} style={{ borderBottom: '1px solid #F8FAFC' }}>
                                      {/* Locomotiva row: status icon + name | início | fim |
                                          schedule bar (thin, hatched) over hours bar | horas */}
                                      <button onClick={() => toggleLoco(l.key)} style={{ ...rowBase, paddingLeft: 26 }}>
                                        <Chevron open={lOpen} />
                                        {/* Per-Tipo icon; slot always reserved so names stay aligned */}
                                        <LocoStartIcon tipo={t.key} started={started} />
                                        {/* Per-loco status — icon only (no text), same categorization as the totals */}
                                        <LocoStatusDot status={statusOf(l)} size={12} />
                                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.loco}</span>
                                        {/* Date range only (no "Início"/"Fim" labels) — same 2-column width
                                            as the Modelo/Tipo date cells so everything stays aligned */}
                                        <span title="Início → Fim" style={{ width: COL.date * 2, fontSize: 9, color: '#6B7280', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                          {fmtIsoDate(l.startIso)} <span style={{ color: '#C4C9D0', fontWeight: 500 }}>→</span> {fmtIsoDate(l.finishIso)}
                                        </span>
                                        {/* Hours progress: realizado / planejado. Guarded on planned>0 — a 0-hour plan has no meaningful percentage. */}
                                        <LocoProgress started={started} progress={l.hours > 0 ? (l.actual / l.hours) * 100 : 0} schedulePct={timelinePct(l.startIso, l.finishIso, today)} available={actualAvailable} status={statusOf(l)} />
                                        {hoursLabel(l.hours, 10, '#6B7280', l.actual)}
                                      </button>
                                      {lOpen && (
                                        <div style={{ padding: '2px 12px 8px 44px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                          {l.areas.map(a => {
                                            const aKey = `${l.key}||${a.key}`
                                            const aOpen = expAreas.has(aKey)
                                            return (
                                              <div key={aKey} style={{ borderRadius: 6, border: '1px solid #F3F4F6', background: '#FAFAFA', overflow: 'hidden' }}>
                                                <button onClick={() => toggleArea(aKey)} style={{ ...rowBase, padding: '5px 10px' }}>
                                                  <Chevron open={aOpen} />
                                                  <span style={{ fontSize: 10.5, fontWeight: 700, color: '#4B5563' }}>{a.area}</span>
                                                  {hoursLabel(a.hours, 10, '#6B7280', a.actual)}
                                                </button>
                                                {aOpen && (
                                                  <div style={{ padding: '0 8px 6px 22px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                    {a.wss.map(w => {
                                                      const wKey = `${aKey}||${w.key}`
                                                      const wOpen = expWs.has(wKey)
                                                      return (
                                                        <div key={wKey}>
                                                          <button onClick={() => toggleWsKey(wKey)} style={{ ...rowBase, padding: '4px 8px' }}>
                                                            <Chevron open={wOpen} />
                                                            <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280' }}>{w.label}</span>
                                                            {hoursLabel(w.hours, 9.5, '#6B7280', w.actual)}
                                                          </button>
                                                          {wOpen && (
                                                            <div style={{ padding: '0 8px 4px 24px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                                                              {w.pns.map(p => (
                                                                <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px' }}>
                                                                  <span style={{ width: 4, height: 4, borderRadius: 2, background: '#D1D5DB', flexShrink: 0 }} />
                                                                  <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6B7280', whiteSpace: 'nowrap', flexShrink: 0 }}>{p.pn || '—'}</span>
                                                                  <span style={{ fontSize: 9.5, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.desc}</span>
                                                                  {hoursLabel(p.hours, 9, '#6B7280', p.actual)}
                                                                </div>
                                                              ))}
                                                            </div>
                                                          )}
                                                        </div>
                                                      )
                                                    })}
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── RIGHT HALF — reserved for the next phases of the Factory Load page ── */}
      <div style={{ width: '50%' }} />
    </div>
  )
}
