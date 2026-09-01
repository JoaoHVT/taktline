'use client'
import { Fragment, useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react'
import { ChevronDown, Layers, Boxes, Loader2, SlidersHorizontal, Settings, LayoutGrid, X, ArrowUp, ArrowDown, Pencil, EyeOff, Hammer } from 'lucide-react'
import { FilterBox } from './FilterBox'
import { DateFilterDropdown } from './DateFilterDropdown'
import { RedSegment } from './RedSegment'
import { RED, RED_LT, fmt, monthKeyQuarter, monthLabel, validTakt } from '@/lib/ganttUtils'
import { TIPOS, tipoHasLoco, isScheduleBacked, anyScheduleBacked } from '@/lib/tipos'
import { SummaryAreaChart } from './SummaryAreaChart'
import type { SummaryTestResult, SummaryAreaRow, PnRow, LocoRow, ModelGroup } from './types'
import { locoKeyOf, isEmptyOverride, shiftIsoByBusinessDays, type LocoOverrideMap } from '@/lib/locoOverrides'
import { getMergeLocoTypes, subscribeMergeLocoTypes, mergeSummaryLocoTypes } from '@/lib/locoMerge'
import type { GanttData } from '@/lib/api'

/** Small red warning icon shown beside Takt when a LOCO has conflicts (icon only). */
function ConflictIcon() {
  return (
    <span title="Possui conflitos" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5 15 14H1z" fill={RED} stroke={RED} strokeWidth="1" strokeLinejoin="round" />
        <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="#fff" />
        <circle cx="8" cy="11.6" r="0.9" fill="#fff" />
      </svg>
    </span>
  )
}

// ── Scenario comparison indicator ────────────────────────────────────────────────
// Percentage difference of the current scenario vs the compared one:
//   ((current − compared) / compared) × 100
// > +5% → green up arrow · < −5% → red down arrow · within ±5% (or no comparison) → nothing.
// Blank/zero handling (so comparisons are NEVER suppressed and never produce NaN/Infinity):
//   • compared 0/blank, current > 0 → value APPEARED  → +100%
//   • current 0/blank, compared > 0 → value REMOVED   → −100% (from the normal formula)
//   • both 0/blank                  → no change       → null (no arrow)
// This is the single source of truth reused by the KPI cards, the Total column AND every
// month/week data cell, so the whole table stays consistent.
const COMPARE_THRESHOLD = 5
const COMPARE_GREEN = '#16A34A'
// Horizontal room (px) a KPI card reserves on its caption row so the top-right comparison badge
// ("35% ↑") sits in stretched whitespace instead of overlapping the caption. Applied per card, only
// when that card's own comparison clears the threshold — see cardBadgeReserve.
const CARD_BADGE_RESERVE = 48
// Consistent minimum width (px) for a content-sized KPI card. Cards grow to fit their caption +
// value (flex: 0 0 auto), but never fall below this floor, so the shortest card (e.g. Locos) still
// reads as a card rather than a sliver.
const KPI_CARD_MIN_W = 128
function comparePct(current: number, compared: number | null | undefined): number | null {
  if (compared == null) return null
  if (compared === 0) {
    if (!current) return null               // both empty/zero → no signal
    return 100                              // appeared from nothing → +100%
  }
  const pct = ((current - compared) / compared) * 100
  return Number.isFinite(pct) ? pct : null  // guard against any NaN/Infinity reaching the UI
}
/** Renders the ±5% indicator as an ABSOLUTELY POSITIONED overlay in the upper-right corner of its
 *  container (a `<td>` cell or a KPI card — both made `position: relative`). It is taken out of the
 *  normal flow so the primary value keeps EXACTLY the same layout/position whether comparison mode is
 *  on or off (no wrapping, no width stealing, no row-height/table-size changes). Layout is horizontal:
 *  the unsigned, whole-number magnitude % on the LEFT, the arrow on the RIGHT. Direction/meaning come
 *  from the arrow (green ↑ = increase, red ↓ = reduction). The label font scales with the arrow `size`
 *  so it stays aligned at every zoom level / table density.
 *
 *  `variant='cell'` tucks the badge into the cell's top padding (right edge); `variant='card'` seats it
 *  in the card's top-right whitespace (beside the caption, well clear of the large value). */
function CompareArrow({ current, compared, size = 12, variant = 'cell' }: { current: number; compared: number | null | undefined; size?: number; variant?: 'card' | 'cell' }) {
  const pct = comparePct(current, compared)
  if (pct == null || (pct <= COMPARE_THRESHOLD && pct >= -COMPARE_THRESHOLD)) return null
  const up = pct > COMPARE_THRESHOLD
  const color = up ? COMPARE_GREEN : RED
  const title = `${pct > 0 ? '+' : ''}${Math.round(pct)}% vs. cenário comparado`
  // Unsigned, whole-number magnitude — the sign would be redundant with the arrow's direction/color.
  const label = `${Math.round(Math.abs(pct))}%`
  // Secondary, compact label sized relative to the arrow (min 8px so it stays legible when zoomed out).
  const labelSize = Math.max(8, Math.round(size * 0.72))
  // Both variants overlay the badge in the container's top-right whitespace so the primary value never
  // shifts. Cards additionally reserve room via a caption right-padding (see CARD_BADGE_RESERVE) so the
  // card stretches to fit the badge instead of covering the caption.
  const layout: React.CSSProperties = variant === 'card'
    ? { position: 'absolute', top: 7, right: 9, zIndex: 1, pointerEvents: 'none' }
    : { position: 'absolute', top: 0, right: 1, zIndex: 1, pointerEvents: 'none' }
  return (
    <span title={title} style={{
      ...layout,
      display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 1,
      flexShrink: 0, lineHeight: 1, whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: labelSize, fontWeight: 700, color, lineHeight: 1, letterSpacing: '-0.02em' }}>{label}</span>
      {up ? <ArrowUp size={size} color={color} strokeWidth={2.5} />
          : <ArrowDown size={size} color={color} strokeWidth={2.5} />}
    </span>
  )
}

/** Chip that expands/collapses one filter group — same visual language as the
 *  Factory Load / Schedule filter chips (red accents, count badge). */
function FilterGroupChip({ icon, label, count, open, onClick }: {
  icon: React.ReactNode; label: string; count: number; open: boolean; onClick: () => void
}) {
  const hot = count > 0 || open
  return (
    <button onClick={onClick} title={open ? 'Recolher' : 'Expandir'} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
      borderRadius: 8, border: `1.5px solid ${hot ? RED : '#D1D5DB'}`,
      background: hot ? RED_LT : '#F9FAFB', cursor: 'pointer',
      fontSize: 12, fontWeight: 600, color: hot ? RED : '#374151', whiteSpace: 'nowrap',
    }}>
      <span style={{ color: hot ? RED : '#6B7280', display: 'flex' }}>{icon}</span>
      {label}
      {count > 0 && (
        <span style={{ marginLeft: 2, background: RED, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5 }}>{count}</span>
      )}
      <ChevronDown size={12} style={{ color: hot ? RED : '#9CA3AF', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
    </button>
  )
}

// Dropdown panel for the Datas / Filtros chips. Matches the main Análise de
// Capacidade filter card: absolutely positioned below the chip (OVERLAYS the
// table, no layout push), a header row ("FILTROS…" + "Limpar filtros") on top,
// then the filter controls laid out HORIZONTALLY in a single row.
const FILTER_DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50,
  background: '#fff', border: `1px solid ${RED}33`, borderRadius: 10,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: 10,
}

/** Header row for a filter dropdown: title (left) + "Limpar filtros" (right). */
function FilterDropdownHeader({ title, onClear, showClear }: {
  title: string; onClear: () => void; showClear: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{title}</span>
      {showClear && (
        <button onClick={onClear} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: RED, padding: 0, whiteSpace: 'nowrap' }}>
          <X size={13} /> Limpar filtros
        </button>
      )}
    </div>
  )
}

/** Horizontal row holding the filter controls inside a dropdown. */
const FILTER_ROW_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'nowrap',
}

/** A record is a "Setup" (a first-class schedule entity that is 0h by nature) when
 *  its model (wo) OR loco (task_name) name contains "setup". Used to keep Setup rows
 *  visible past the zero-hour Tipo filter. */
const isSetupName = (name: string | null | undefined): boolean =>
  !!name && /setup/i.test(name)

/** One cell of the statistics panel that sits to the LEFT of the distribution chart.
 *  Mirrors the KPI-card visual language (rounded, hairline border, gray caption, tabular
 *  value). `red` makes the Upper/Lower limits prominent; the smaller Variância / Desvio
 *  Padrão cells stay secondary via the default gray tone + smaller `size`. */
function StatCell({ label, value, unit, sub, red = false, size = 14, borderColor, valueColor, labelColor }: {
  label: string; value: React.ReactNode; unit?: string; sub?: string; red?: boolean; size?: number
  /** Override the hairline border — used by the qualitative status card (light green/orange/red). */
  borderColor?: string
  /** Override the value color — pairs with borderColor for the status card. */
  valueColor?: string
  /** Override the caption color — when set, the label also drops its bold (used by the
   *  Variabilidade card to tint the caption the status color in a lighter weight). */
  labelColor?: string
}) {
  const bColor = borderColor ?? (red ? RED : '#E5E7EB')
  const vColor = valueColor ?? (red ? RED : '#374151')
  return (
    <div style={{
      borderRadius: 9, padding: '7px 10px',
      border: `1.5px solid ${bColor}`,
      background: red ? '#F0FDFA' : '#F9FAFB',
      display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, justifyContent: 'center',
    }}>
      <div title={label} style={{ fontSize: 9, color: labelColor ?? '#9CA3AF', fontWeight: labelColor ? 400 : 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size, fontWeight: red ? 800 : 700, color: vColor, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value}
          {unit && <span style={{ fontSize: Math.max(9, Math.round(size * 0.6)), fontWeight: 500, color: '#9CA3AF', marginLeft: 3 }}>{unit}</span>}
        </span>
      </div>
      {sub && <div style={{ fontSize: 9, color: '#9CA3AF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  )
}

/** Red segmented toggle — the standard control for all view-mode switches. */
interface ResumoGeralTabProps {
  summaryTestReady: boolean
  summaryComputing: boolean
  summaryTestData: SummaryTestResult | null
  /** Comparison mode only: the OTHER scenario's summary (same filters/period). null when not
   *  comparing. Drives the chart's compared Total line and the ±5% row/KPI indicators. */
  comparisonSummary?: SummaryTestResult | null
  /** Distribution-chart data source, computed IGNORING the month selection so the chart keeps
   *  showing the full timeline while KPIs/tables react to the selected month. Falls back to
   *  summaryTestData when absent (identical to the old behaviour). */
  chartSummaryData?: SummaryTestResult | null
  /** Compared scenario's chart source (month-independent). Falls back to comparisonSummary. */
  chartComparisonSummary?: SummaryTestResult | null
  /** UI-only toggle for the ±5% comparison arrows (default true). Never affects exports. */
  showCompareArrows?: boolean
  summaryMode: 'ue' | 'horas'
  setSummaryMode: (m: 'ue' | 'horas') => void
  rowMode: 'area' | 'locos'
  setRowMode: (m: 'area' | 'locos') => void
  viewMode: 'mensal' | 'semanal'
  setViewMode: (m: 'mensal' | 'semanal') => void
  showQuarters: boolean
  setShowQuarters: (fn: (v: boolean) => boolean) => void
  /** "Unir períodos" — drop the non-selected periods from the table AND the chart instead of
   *  showing them as zero-valued columns, so the remaining ones expand into the freed space.
   *  Purely presentational: no aggregation changes, the same filtered numbers are shown in fewer
   *  columns. Default OFF, which is the long-standing full-timeline behaviour. */
  mergePeriods: boolean
  setMergePeriods: (fn: (v: boolean) => boolean) => void
  summaryLineTypes: Set<string>
  setSummaryLineTypes: (fn: (prev: Set<string>) => Set<string>) => void
  availableLineTypes: Set<string>
  /** The Tipos this session was LOADED with — the launch screen's selection.
   *
   *  A chip outside this set cannot be switched on here. The data for it was never fetched:
   *  the request's Linha filter, the Schedule build and the whole windowed dataset were all
   *  scoped to the launch selection, so turning on a fourth Tipo mid-session only ever produced
   *  an empty column that looked like missing data. Widening the selection needs a fresh load,
   *  which is what the launch screen is for. Narrowing is still free — every chip in the set
   *  can be toggled off and back on. */
  loadedLineTypes: Set<string>
  years: string[]
  /** Fiscal-quarter keys ("2026-Q1") offered by the Trimestre date filter. */
  quarters: string[]
  months: string[]
  allFws: string[]
  allAreas: string[]
  allModels: string[]
  /** Schedule workstations (`useGanttFilters.allSummaryWorkstations`)
   *  — this tab shows both sources in one table, so its filter has to offer both vocabularies.
   *  NOT the Schedule panel's `allWorkstations`, which stays Schedule-only. */
  allWorkstations: string[]
  selYears: Set<string>
  selQuarters: Set<string>
  selMonths: Set<string>
  selFws: Set<string>
  selAreas: Set<string>
  selModels: Set<string>
  selWorkstations: Set<string>
  toggleYear: (v: string) => void
  toggleQuarter: (v: string) => void
  toggleMonth: (v: string) => void
  toggleFw: (v: string) => void
  setSelAreas: (fn: (prev: Set<string>) => Set<string>) => void
  setSelModels: (fn: (prev: Set<string>) => Set<string>) => void
  setSelWorkstations: (fn: (prev: Set<string>) => Set<string>) => void
  /** LOCO task_names that currently have ≥1 conflict (for the Takt conflict icon). */
  conflictLocoNames: Set<string>
  /** Canonical total conflict count (distinct loco-loco-ws PAIRS) for the visible set. */
  totalConflicts: number
  clearFilters: () => void
  clearDateFilters: () => void
  clearDataFilters: () => void
  hasFilter: boolean
  handleLocoClick: (taskName: string, linha?: string, modelWo?: string, startMs?: string | number | null) => void
  handleWsClick: (wo: string, taskName: string, ws: string, subarea?: string, linha?: string, startMs?: string) => void
  /** Right-click a LOCO label → open the "Editar LOCO" menu (x/y in viewport coords). */
  onLocoEdit?: (info: { wo: string; taskName: string; linha: string; startMs: string; takt: number | null; x: number; y: number }) => void
  /** Manual visual overrides (keyed linha||wo||task||start_ms) — applied to the displayed
   *  Takt / Start of each LOCO instantly, with no recompute. */
  locoOverrides?: LocoOverrideMap
  ganttBuiltRef: React.MutableRefObject<boolean>
  /** LOCOs currently hidden from the Schedule by "Ocultar LOCOs concluídas" (keyed
   *  wo||task||start_ms, computed in GanttModal from the same override-merged data the worker
   *  filters). Clicking such a loco must NOT navigate — there is no row to scroll to. null =
   *  the filter is off (every loco navigates normally). */
  hiddenScheduleLocos?: Set<string> | null
  /** The COMPARED scenario's schedule, for the Build Plan window's Δ table. Already in memory in
   *  comparison mode (GanttModal windows both), so this costs nothing to pass. */
  /** The two above WITHOUT the period window (line filter still applied). Pure passthrough to the
   *  Build Plan window's kit planner, whose Min floor is horizon-aware and needs to see the demand
   *  beyond the loaded window — nothing here reads them. */
  /** Comparison-mode passthrough for that window: which scenario the numbers belong to, which side
   *  it is (the Δ is always Target − Base), the two names, and how to switch — so both scenarios'
   *  build plans can be read without leaving it. */
  comparisonMode?: boolean
  comparisonActive?: 'base' | 'target'
  comparisonBaseName?: string
  comparisonTargetName?: string
  scenarioName?: string
  onSwitchScenario?: () => void
}

export function ResumoGeralTab({
  summaryTestReady, summaryComputing, summaryTestData: summaryTestDataRaw,
  comparisonSummary: comparisonSummaryRaw = null,
  chartSummaryData = null,
  chartComparisonSummary: chartComparisonSummaryRaw = null,
  showCompareArrows = true,
  summaryMode, setSummaryMode,
  rowMode, setRowMode,
  viewMode, setViewMode,
  showQuarters, setShowQuarters,
  mergePeriods, setMergePeriods,
  summaryLineTypes, setSummaryLineTypes, availableLineTypes, loadedLineTypes,
  years, quarters, months, allFws, allAreas, allModels, allWorkstations,
  selYears, selQuarters, selMonths, selFws, selAreas, selModels, selWorkstations,
  toggleYear, toggleQuarter, toggleMonth, toggleFw, setSelAreas, setSelModels, setSelWorkstations,
  conflictLocoNames,
  totalConflicts,
  clearDateFilters, clearDataFilters,
  handleLocoClick,
  onLocoEdit,
  locoOverrides,
  ganttBuiltRef,
  hiddenScheduleLocos = null,
  comparisonMode = false,
  comparisonActive = 'base',
  comparisonBaseName,
  comparisonTargetName,
  scenarioName,
  onSwitchScenario,
}: ResumoGeralTabProps) {
  // Build Plan window — reads the Schedule directly and holds no state this tab depends on, so
  // opening or closing it cannot disturb anything here.
  // ── "Unir locos" (optional) ────────────────────────────────────────────────
  // One physical serial planned under two Tipos (`MX1022` + `B3#MX1022`) folds into a
  // single entry under the Tipo with the most total hours. Applied HERE, at display time, and
  // only to what this tab reads: the same aggregate is shared with Plano de Produção and Plano Externo
  // Planned, which must keep seeing the unmerged split. `mergeSummaryLocoTypes` returns its
  // input untouched when no serial is contested, so the memo stays referentially stable.
  const mergeLocos = useSyncExternalStore(subscribeMergeLocoTypes, getMergeLocoTypes, getMergeLocoTypes)
  const summaryTestData = useMemo(
    () => (mergeLocos && summaryTestDataRaw ? mergeSummaryLocoTypes(summaryTestDataRaw) : summaryTestDataRaw),
    [mergeLocos, summaryTestDataRaw],
  )
  // The compared scenario gets the same treatment, or the ±5% arrows would measure a merged
  // figure against an unmerged one.
  //
  // AND an EMPTY reference is dropped here, at the source, rather than at each of the six places
  // that read it (the arrows, the phantom rows, the overlay line, the grand-total row…). A
  // reference with zero hours is not a comparison: every cell would carry a +100% badge measured
  // against nothing, the table would grow a phantom row for each área that exists only in the
  // empty side, and the chart would draw a flat line along the axis. That is precisely what a
  // selection whose hours come from OUTSIDE the Schedule produces — the deviation reference is
  // aggregated under the same Tipo filter, so a view with no Schedule references exactly zero. Nulling it
  // here makes every consumer behave as if no comparison were armed, which is the truth.
  const comparisonSummary = useMemo(
    () => {
      if (!comparisonSummaryRaw || comparisonSummaryRaw.totalHours <= 0) return null
      return mergeLocos ? mergeSummaryLocoTypes(comparisonSummaryRaw) : comparisonSummaryRaw
    },
    [mergeLocos, comparisonSummaryRaw],
  )
  /** The chart's compared series, under the same rule. Kept separate from `comparisonSummary`
   *  because the chart reads a month-INDEPENDENT aggregate; without the same emptiness test the
   *  overlay line would survive the suppression the table just applied. */
  const chartComparisonSummary = (chartComparisonSummaryRaw && chartComparisonSummaryRaw.totalHours > 0)
    ? chartComparisonSummaryRaw : null
  // Shared right-click → "Editar LOCO". model=wo, lr.loco=task_name (see useSummaryCompute).
  const locoCtx = (e: React.MouseEvent, wo: string, taskName: string, linha: string, startMs: string | number | null | undefined, takt: number | null | undefined) => {
    if (!onLocoEdit) return
    e.preventDefault(); e.stopPropagation()
    onLocoEdit({ wo, taskName, linha, startMs: startMs != null ? String(startMs) : '', takt: validTakt(takt) ?? null, x: e.clientX, y: e.clientY })
  }
  // Resolve a LOCO's manual visual override and the displayed (overridden) Takt + Start.
  // Pure derivation at render → instant, only the edited LOCO's cells change.
  const displayedLoco = (wo: string, taskName: string, linha: string, startMs: string | number | null | undefined, takt: number | null | undefined, finishMS?: string | null) => {
    const ov = locoOverrides?.[locoKeyOf({ linha, wo, task_name: taskName, start_ms: startMs })]
    const baseTakt = validTakt(takt)
    const taktVal = ov?.takt != null ? ov.takt : baseTakt
    const startVal = ov?.startShiftDays ? shiftIsoByBusinessDays(startMs, ov.startShiftDays) : (startMs != null ? String(startMs) : null)
    // Finish is ANCHORED to the committed deadline: a start shift consumes/grows the protection-day
    // buffer instead of dragging the end date, so it does NOT move the Finish. Only an explicit finish
    // (protection) shift moves it.
    const finishDelta = ov?.finishShiftDays ?? 0
    const finishVal = finishDelta && finishMS ? shiftIsoByBusinessDays(finishMS, finishDelta) : (finishMS ?? null)
    return {
      takt: taktVal,
      startMs: startVal,
      finishMs: finishVal,
      // ANY modification marks the locomotive as edited — not just the LOCO-level fields above.
      // This used to test `takt / startShiftDays / finishShiftDays` only, so moving, swapping, or
      // re-dating a WORKSTATION (which is stored under ov.ws / ov.desc, or ov.addWs for a manually
      // added station) left the loco looking untouched. isEmptyOverride is the single definition of
      // "carries a change" used by the reset/save paths, so the indicator now agrees with them.
      edited: !isEmptyOverride(ov),
    }
  }
  const [expandedAreasTest, setExpandedAreasTest] = useState<Set<string>>(new Set())
  const [expandedPnsTest, setExpandedPnsTest] = useState<Set<string>>(new Set())
  // Redesigned filter UI: the Datas filter is the shared DateFilterDropdown (which
  // owns its own open/close). The Dados (Filtros) group + gear settings keep their
  // own local open state + outside-click handling below.
  const [dataFiltersOpen, setDataFiltersOpen] = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  // Hours distribution chart metric: total hours per period vs hours/day per period.
  const [chartMetric,     setChartMetric]     = useState<'total' | 'perDay'>('total')
  const settingsRef    = useRef<HTMLDivElement>(null)
  const dataFiltersRef = useRef<HTMLDivElement>(null)
  // ── Layout measurements (element-attachment based, NOT mount based) ───────────────────
  // Both observers below are wired through CALLBACK refs rather than a `useEffect(…, [])`.
  // This component early-returns a loader while the summary is still computing (see the
  // `summaryComputing && !summaryTestData` guard), so at mount time the measured nodes do
  // not exist yet: a mount-time effect read `ref.current === null`, bailed out, and — with
  // empty deps — never ran again once the real markup appeared. The measurements therefore
  // stayed null after every load/simulation and only became correct when a tab switch
  // remounted the component with data already present (the "KPI cards align only after
  // changing tabs" bug). A callback ref fires on the actual attach/detach of the node, so it
  // always runs the first time the measured markup renders, whatever the loading order was.
  // Cap the chart + statistics panel (right side) to the exact height of the left-side
  // controls column (Type buttons → KPI cards → Filters). Measured natural height of the
  // left column drives the right column's height so neither the chart nor the stats table
  // can push the row taller than the controls. Recomputed on resize (e.g. KPI card wrap).
  const [leftColH, setLeftColH] = useState<number | null>(null)
  const leftColRoRef = useRef<ResizeObserver | null>(null)
  const leftColRef = useCallback((el: HTMLDivElement | null) => {
    leftColRoRef.current?.disconnect()
    leftColRoRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    setLeftColH(el.offsetHeight)
    const ro = new ResizeObserver(() => setLeftColH(el.offsetHeight))
    ro.observe(el)
    leftColRoRef.current = ro
  }, [])
  // Lock the Type-buttons row to the exact width the KPI cards row occupies, so both rows
  // share the same left/right edges. The KPI row is shrink-to-content (fit-content); we
  // measure its rendered width and hand it to the Type row, whose buttons flex to fill it.
  const [kpiRowW, setKpiRowW] = useState<number | null>(null)
  const kpiRowRoRef = useRef<ResizeObserver | null>(null)
  const kpiRowRef = useCallback((el: HTMLDivElement | null) => {
    kpiRowRoRef.current?.disconnect()
    kpiRowRoRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    setKpiRowW(el.offsetWidth)
    const ro = new ResizeObserver(() => setKpiRowW(el.offsetWidth))
    ro.observe(el)
    kpiRowRoRef.current = ro
  }, [])
  // Release both observers when the component unmounts (the callback refs already fire with
  // null on detach, but React does not guarantee that for a synchronous tree removal).
  useEffect(() => () => {
    leftColRoRef.current?.disconnect()
    kpiRowRoRef.current?.disconnect()
  }, [])
  useEffect(() => {
    if (!settingsOpen) return
    function onDown(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [settingsOpen])
  // Close the Filtros (Dados) dropdown when clicking outside its container. Clicks
  // inside the panel (incl. the nested FilterBox sub-dropdowns) keep it open.
  useEffect(() => {
    if (!dataFiltersOpen) return
    function onDown(e: MouseEvent) {
      if (dataFiltersRef.current && !dataFiltersRef.current.contains(e.target as Node)) setDataFiltersOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dataFiltersOpen])
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())

  // ── Periods picked BY CLICKING THE CHART ───────────────────────────────────────────────
  // The chart's red highlight (band + dot) marks a selection the user made ON the chart, not the
  // date filter in general: applying a Mês/FW filter from the Datas dropdown narrows the data but
  // must leave the chart unmarked. So the highlight is driven by this set — the keys this tab saw
  // a chart click for — intersected with the live filter, never by the filter alone.
  const [chartPicked, setChartPicked] = useState<Set<string>>(new Set())
  /** Is the "Locos" grouping meaningful for what is selected?
   *
   *  Only if at least one selected Tipo actually HAS locomotives. A selection that plans
   *  parts, so the Locos table would render empty — and an empty table is indistinguishable
   *  from a bug. An EMPTY selection counts as available: that is "no filter", not "only Tipos
   *  without LOCOs", and it must keep behaving exactly as it always has. */
  const locoViewAvailable = useMemo(
    () => summaryLineTypes.size === 0 || [...summaryLineTypes].some(tipoHasLoco),
    [summaryLineTypes],
  )
  // Never leave the view sitting on a mode that cannot render. Deselecting the last
  // LOCO-bearing Tipo while the Locos table is open would otherwise leave a blank grid until
  // the user happened to click Área.
  useEffect(() => {
    if (!locoViewAvailable && rowMode === 'locos') setRowMode('area')
  }, [locoViewAvailable, rowMode, setRowMode])

  const activeDateSel = viewMode === 'mensal' ? selMonths : selFws
  // Drop picked keys the filter no longer holds (cleared from the dropdown, "Limpar", or a coarse
  // Ano/Trimestre change), so re-selecting one later from the dropdown does not resurrect the mark.
  // Only keys of the CURRENT mode are pruned (month keys are "YYYY-MM", FW keys are not), so
  // switching Mensal↔Semanal does not wipe the marks of the mode being left.
  const isMonthKey = (k: string) => /^\d{4}-\d{2}$/.test(k)
  useEffect(() => {
    const ofThisMode = (k: string) => (viewMode === 'mensal' ? isMonthKey(k) : !isMonthKey(k))
    setChartPicked(prev => {
      if (prev.size === 0) return prev
      const next = new Set<string>()
      for (const k of prev) if (!ofThisMode(k) || activeDateSel.has(k)) next.add(k)
      return next.size === prev.size ? prev : next
    })
  }, [activeDateSel, viewMode])
  const toggleFromChart = (k: string) => {
    setChartPicked(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
    ;(viewMode === 'mensal' ? toggleMonth : toggleFw)(k)
  }
  // What the chart actually highlights: chart-clicked ∩ currently filtered.
  const chartSelectedKeys = useMemo(() => {
    const out = new Set<string>()
    for (const k of chartPicked) if (activeDateSel.has(k)) out.add(k)
    return out
  }, [chartPicked, activeDateSel])

  const summaryScale = summaryMode === 'ue' ? 3100 : 1
  const formatSummaryValue = (value: number) => summaryMode === 'ue'
    ? (value / summaryScale).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : fmt(Math.round(value))
  const perDayLabel = summaryMode === 'ue' ? 'U/d' : 'h/d'
  const perDayLabelLong = summaryMode === 'ue' ? 'U/dia' : 'h/dia'
  // Total-column value with its unit suffix. The Total is an ACCUMULATED quantity, so in U.E.
  // mode it is "… U" (Equivalent Units), never "U/d" — the per-day rate belongs only to the
  // small secondary line under each cell.
  const formatTotalValue = (value: number) => summaryMode === 'ue'
    ? `${formatSummaryValue(value)} U`
    : `${formatSummaryValue(value)} h`
  // Primary (first-line) value of a cell, with its accumulated unit: "… U" / "… h". The
  // secondary line keeps the per-day rate (perDayLabel). Used throughout so the first value
  // always carries its unit consistently.
  const fmtMain = (value: number) => summaryMode === 'ue'
    ? `${formatSummaryValue(value)} U`
    : `${formatSummaryValue(value)} h`

  if (summaryTestReady && summaryComputing && !summaryTestData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 8 }}>
        <Loader2 size={20} className="animate-spin" style={{ color: RED }} />
        <span style={{ fontSize: 13, color: '#9CA3AF' }}>Calculando resumo…</span>
      </div>
    )
  }

  if (!summaryTestReady) return null
  // Ready, not computing, and still nothing. Previously this rendered NOTHING — an entirely
  // blank tab, which is indistinguishable from a broken one and was exactly what a Schedule-less
  // load looked like when its plan failed to arrive. Say what happened instead.
  if (!summaryTestData) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    height: 160, gap: 6, textAlign: 'center', padding: '0 24px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7280' }}>
          Nenhum dado para os Tipos selecionados.
        </span>
        {/* Deliberately does NOT say "escolha outro Tipo acima": the chip row is part of the
            main render below, which this branch replaces, so there is nothing above to click. */}
        <span style={{ fontSize: 11.5, color: '#9CA3AF' }}>
          Volte à tela de abertura para carregar outro Tipo ou outro período.
        </span>
      </div>
    )
  }

  const activeMonthCount = Object.values(summaryTestData.totalsByYearMonth).filter(h => h > 0).length
  const avgPerMonth = activeMonthCount > 0 ? summaryTestData.totalHours / activeMonthCount : 0
  const avgPerDay = summaryTestData.businessDaysCount > 0 ? summaryTestData.totalHours / summaryTestData.businessDaysCount : 0

  // ── "Unir períodos" (mergePeriods) — which period COLUMNS are rendered ─────────────────────
  // `activeYearMonths` is every month of every year present in the data, so by default a month
  // filter leaves the whole timeline on screen with the non-selected months reading 0. With merge
  // on, a period is kept only if it passes EVERY active date filter, and the remaining columns
  // divide the table's width between them.
  //
  // The predicate tests the filters rather than a single "selected months" list, which is what makes
  // it work for Ano and Trimestre — and for any date filter added later: a new filter narrows the
  // set by adding one more test here, not by another visibility mode. `activeFws` is ALREADY
  // restricted to the active business days upstream (useSummaryCompute), so the coarse filters have
  // pruned the week list before it arrives and only the explicit week selection is left to apply.
  const ymInSelection = (ym: string) => {
    if (selYears.size    > 0 && !selYears.has(ym.slice(0, 4)))         return false
    if (selQuarters.size > 0 && !selQuarters.has(monthKeyQuarter(ym))) return false
    if (selMonths.size   > 0 && !selMonths.has(ym))                    return false
    return true
  }
  const fwInSelection = (fw: string) => selFws.size === 0 || selFws.has(fw)
  const viewYms = mergePeriods ? summaryTestData.activeYearMonths.filter(ymInSelection) : summaryTestData.activeYearMonths
  const viewFws = mergePeriods ? summaryTestData.activeFws.filter(fwInSelection) : summaryTestData.activeFws

  // ── Distribuição de horas (Área mode only) — derived from the already-filtered
  // summary table, so it tracks Área/Workstation/LOCO/Tipo/período + scenario + mode.
  // Cheap recompute each render (no hook — there's an early return above).
  // Metric: 'total' = total hours per period · 'perDay' = hours/day per period.
  const chartPerDay = chartMetric === 'perDay'
  const metricLabel = chartPerDay
    ? (summaryMode === 'ue' ? 'U.E./dia' : 'Horas/dia')
    : (summaryMode === 'ue' ? 'U.E.' : 'Horas')
  const chartTitle  = `${metricLabel} · ${viewMode === 'mensal' ? 'Mensal' : 'Semanal'}`
  const chartFormat = chartPerDay
    ? (v: number) => `${formatSummaryValue(v)} ${perDayLabel}`
    : (v: number) => summaryMode === 'ue' ? `${formatSummaryValue(v)} U.E.` : `${fmt(Math.round(v))} h`
  // Chart data source. The chart draws the FULL timeline regardless of the month selection, so it
  // reads a month-INDEPENDENT summary (chartSummaryData) instead of the month-filtered
  // summaryTestData that drives the KPIs/tables. It still reflects year/FW + the data filters
  // (area/model/loco/ws/type), so the chart tracks the current scope — only the month click no
  // longer collapses it. Falls back to summaryTestData when the chart source isn't ready yet.
  // With "Unir períodos" ON that is exactly the wrong source: the point of the option is that the
  // chart shows ONLY the selected periods, so it reads the fully-filtered summaryTestData instead —
  // which also handles the semanal case, where a MONTH selection prunes the week list upstream and
  // the month-independent source would still carry every week.
  const chartData = mergePeriods ? summaryTestData : (chartSummaryData ?? summaryTestData)
  const chartCompare = mergePeriods ? comparisonSummary : (chartComparisonSummary ?? comparisonSummary)
  // Chart x-axis periods. MONTHLY: only months with business days are plotted (empty months are
  // dropped rather than shown as misleading 0-value points). WEEKLY: `activeFws` is already
  // restricted to active business weeks. Because chartData ignores the month filter, the full set
  // of months/weeks stays on the axis even while a single month is selected on the dashboard.
  // Merge on: the same predicate the table columns use, so the chart's x-axis and the table's
  // period columns can never disagree about what is visible. SummaryAreaChart then reflows on its
  // own — monthly points are spread across the full container width, and a weekly series short
  // enough to fit stops scrolling — so the surviving periods expand into the freed space.
  const chartKeys = viewMode === 'mensal'
    ? chartData.activeYearMonths.filter(ym => (chartData.monthBusinessDays[ym] ?? 0) > 0 && (!mergePeriods || ymInSelection(ym)))
    : chartData.activeFws.filter(fw => !mergePeriods || fwInSelection(fw))
  const chartTotalOf = (k: string) => viewMode === 'mensal'
    ? (chartData.totalsByYearMonth[k] ?? 0)
    : chartData.areas.reduce((s, a) => s + (a.hoursByFw[k] || 0), 0)
  const chartDaysOf = (k: string) => viewMode === 'mensal'
    ? (chartData.monthBusinessDays[k] ?? 0)
    : (chartData.fwBusinessDays[k] || 0)
  const chartLabelOf = (k: string) => viewMode === 'mensal' ? monthLabel(k) : k
  const chartPoints = chartKeys.map(k => {
    const total = chartTotalOf(k), days = chartDaysOf(k)
    return { key: k, label: chartLabelOf(k), value: chartPerDay ? (days > 0 ? total / days : 0) : total }
  })
  // Average reference line — STANDARDIZED to the same methodology as the table KPIs so the chart and
  // table never disagree (rounding applied only at the final display stage, in chartFormat):
  //   • per-day metric → Σhours ÷ Σbusiness-days  (weighted overall rate, matches "Média / dia")
  //   • total metric   → Σhours ÷ active-period count (matches "Média / mês")
  // Using the weighted rate (not a mean-of-per-day-rates) is what removes the small chart↔table drift.
  const chartSumHours = chartKeys.reduce((s, k) => s + chartTotalOf(k), 0)
  const chartSumDays  = chartKeys.reduce((s, k) => s + chartDaysOf(k), 0)
  const chartActivePeriods = chartKeys.reduce((n, k) => n + (chartTotalOf(k) > 0 ? 1 : 0), 0)
  const chartAverage = chartPerDay
    ? (chartSumDays > 0 ? chartSumHours / chartSumDays : 0)
    : (chartActivePeriods > 0 ? chartSumHours / chartActivePeriods : 0)

  // ── Statistics panel (LEFT of the chart) — computed from the EXACT dataset feeding the chart
  // (chartPoints), so it recomputes automatically with metric (total/perDay), aggregation
  // (mensal/semanal), filters and scenario. Statistics over the plotted values:
  //   • Upper/Lower Limit  = max/min plotted value (+ the period it occurs in)
  //   • Mean               = chartAverage — the SAME mean drawn as the chart's "Média" line,
  //                          reused for the deviations AND the variance/std-dev so the panel and
  //                          the chart never disagree on the mean.
  //   • Deviation vs Mean  = (limit − mean) / mean, shown as a signed whole-number %
  //   • Variance / Std Dev = Σ(v − mean)² / n  (dispersion around that same mean) and its root
  const statValues = chartPoints.map(p => p.value)
  const statN = statValues.length
  const statMean = chartAverage
  let upperPoint: (typeof chartPoints)[number] | null = null
  // Lower limit ignores empty periods: months/weeks with value 0 (or blank) are skipped so the
  // "Limite Inferior" reports the smallest ACTIVE period instead of collapsing to 0. If every
  // period is empty, lowerPoint stays null and the card shows "—".
  let lowerPoint: (typeof chartPoints)[number] | null = null
  for (const p of chartPoints) {
    if (upperPoint == null || p.value > upperPoint.value) upperPoint = p
    if (p.value > 0 && (lowerPoint == null || p.value < lowerPoint.value)) lowerPoint = p
  }
  const statVariance = statN > 0 ? statValues.reduce((s, v) => s + (v - statMean) ** 2, 0) / statN : 0
  const statStdDev = Math.sqrt(statVariance)
  // Coefficient of Variation = StdDev / Mean, shown as a %. A scale-independent read on
  // workload volatility — comparable across scenarios in a way raw variance is not.
  const statCvPct = statN > 0 && statMean !== 0 ? (statStdDev / statMean) * 100 : null
  const upperDevPct = statMean !== 0 && upperPoint ? ((upperPoint.value - statMean) / statMean) * 100 : null
  const lowerDevPct = statMean !== 0 && lowerPoint ? ((lowerPoint.value - statMean) / statMean) * 100 : null
  // Absolute (raw) deviation from the mean, signed, in the chart's current unit.
  const upperDevAbs = upperPoint ? upperPoint.value - statMean : null
  const lowerDevAbs = lowerPoint ? lowerPoint.value - statMean : null
  // Unit suffix for the Std Dev / limit / deviation values, matching the chart's current metric.
  const statUnit = chartPerDay ? perDayLabel : (summaryMode === 'ue' ? 'U.E.' : 'h')
  // Bare numeric string (no unit) for a chart value — the unit is rendered separately, dimmed, by
  // StatCell so the number stays visually dominant (same hierarchy as the KPI cards).
  const chartNum = (v: number) =>
    (chartPerDay || summaryMode === 'ue') ? formatSummaryValue(v) : fmt(Math.round(v))
  // Deviation cell content: percentage PRIMARY (larger, dark) + absolute SECONDARY (smaller, gray),
  // both on one line — e.g. "50% / 50h". Shown as magnitudes (no minus): the card LABEL already
  // states the direction ("Desvio Superior" above the mean / "Desvio Inferior" below), so the
  // Lower card mirrors the Upper card instead of carrying a negative-sign indicator.
  const fmtDev = (pct: number | null, abs: number | null): React.ReactNode =>
    pct == null || abs == null ? '—' : (
      <>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{Math.round(Math.abs(pct))}%</span>
        <span style={{ fontSize: 10, fontWeight: 500, color: '#9CA3AF', marginLeft: 4 }}>
          / {formatSummaryValue(Math.abs(abs))}{statUnit}
        </span>
      </>
    )
  // ALL periods holding the max / min plotted value (ties included). The Total row marks each
  // with a thin red line — above the value for Upper-limit periods, below for Lower-limit ones —
  // WITHOUT changing any cell background or row color. Works in mensal/semanal × total/perDay.
  const statMax = statN > 0 ? Math.max(...statValues) : null
  const upperKeys = new Set(statMax == null ? [] : chartPoints.filter(p => Math.abs(p.value - statMax) < 1e-9).map(p => p.key))
  // Lower-limit marker follows the same non-zero lowerPoint as the "Limite Inferior" card (empty
  // periods are never flagged as the minimum).
  const lowerKeys = new Set(lowerPoint == null ? [] : chartPoints.filter(p => Math.abs(p.value - lowerPoint.value) < 1e-9).map(p => p.key))
  const limitLineShadow = (k: string): string | undefined => {
    const parts: string[] = []
    if (upperKeys.has(k)) parts.push(`inset 0 2px 0 ${RED}`)
    if (lowerKeys.has(k)) parts.push(`inset 0 -2px 0 ${RED}`)
    return parts.length ? parts.join(', ') : undefined
  }

  // Compared scenario's Total series, aligned 1:1 (same keys/order) to chartPoints so the overlay
  // lines share an x-axis. Business-day counts are calendar-based (identical across scenarios), so
  // the current scenario's day maps drive the per-day metric.
  const comparePoints = chartCompare
    ? chartKeys.map(k => {
        const total = viewMode === 'mensal'
          ? (chartCompare.totalsByYearMonth[k] ?? 0)
          : chartCompare.areas.reduce((s, a) => s + (a.hoursByFw[k] || 0), 0)
        const days = chartDaysOf(k)
        return { key: k, label: chartLabelOf(k), value: chartPerDay ? (days > 0 ? total / days : 0) : total }
      })
    : undefined

  // ── Scenario comparison lookups (compared scenario, same filters) ─────────────────────
  // Keyed by each row's natural identity so the ±% indicator tracks the SAME entity across
  // scenarios regardless of sort order. We keep the FULL entity (period maps + total), not just
  // the total, so the variation arrow can be shown on EVERY month/week cell — not only the Total
  // column — reusing the same comparePct methodology as the KPI cards. `comparing` gates all of it.
  // Cheap recompute each render (no hook — there's an early return above), matching this file's
  // established pattern; the work is O(entities) and dwarfed by the table's own render cost.
  // A comparison needs something to compare AGAINST. `totalHours > 0` is that test, and it is
  // not defensive padding: the deviation reference is aggregated under the SAME Tipo filter as
  // the current view, so a selection whose hours come from outside the Schedule produces
  // a reference of exactly zero. Every cell would then carry a "+∞ / +100%" badge measured
  // against nothing — a wall of red arrows that says only "the baseline is empty", on every row
  // of the table at once. Below the test, the tab behaves as if no comparison were armed.
  const comparing = !!comparisonSummary
  // Single gate for every comparison arrow: only render them when actually comparing (and the user
  // toggle is on). Without `comparing` here, every data cell would still instantiate a CompareArrow
  // that renders nothing — thousands of no-op components per table paint. Gating skips that work.
  const showArrows = showCompareArrows && comparing
  /** Caption right-padding that keeps the top-right badge clear of the caption text.
   *  Keyed off the DATA, not `showArrows`: a card only reserves room when its own comparison
   *  actually clears the threshold (no empty gap on cards with nothing to show), and hiding the
   *  arrows leaves the reserve in place (no resize when the toggle flips). */
  const cardBadgeReserve = (current: number, compared: number | null | undefined): number | undefined => {
    if (!comparing) return undefined
    const pct = comparePct(current, compared)
    if (pct == null || (pct <= COMPARE_THRESHOLD && pct >= -COMPARE_THRESHOLD)) return undefined
    return CARD_BADGE_RESERVE
  }
  type CmpPeriods ={ hoursByYearMonth: Record<string, number>; hoursByFw: Record<string, number>; total: number }
  type WsRow = SummaryAreaRow['workstations'][number]
  const cmpArea  = new Map<string, SummaryAreaRow>()
  const cmpWs    = new Map<string, WsRow>()
  const cmpPn    = new Map<string, PnRow>()
  const cmpModel = new Map<string, ModelGroup>()
  const cmpLoco  = new Map<string, LocoRow>()
  const cmpTipo  = new Map<string, CmpPeriods>()
  if (comparisonSummary) {
    for (const a of comparisonSummary.areas) {
      cmpArea.set(a.area, a)
      for (const ws of a.workstations) {
        cmpWs.set(`${a.area}||${ws.key}`, ws)
        for (const pn of ws.partNumbers) cmpPn.set(`${a.area}||${ws.key}||${pn.pn}||${pn.desc}`, pn)
      }
    }
    for (const mg of comparisonSummary.modelGroups) {
      cmpModel.set(mg.model, mg)
      for (const l of mg.locos) {
        cmpLoco.set(`${mg.model}||${l.loco}||${String(l.startMs ?? '')}`, l)
        const tk = l.tipoGeral || 'other'
        let t = cmpTipo.get(tk)
        if (!t) { t = { hoursByYearMonth: {}, hoursByFw: {}, total: 0 }; cmpTipo.set(tk, t) }
        for (const [ym, h] of Object.entries(l.hoursByYearMonth)) t.hoursByYearMonth[ym] = (t.hoursByYearMonth[ym] ?? 0) + h
        for (const [fw, h] of Object.entries(l.hoursByFw)) t.hoursByFw[fw] = (t.hoursByFw[fw] ?? 0) + h
        t.total += l.hours
      }
    }
  }
  // Compared value for ONE period of an entity (month key in 'mensal', fw key in 'semanal'). Returns
  // `undefined` when NOT comparing (arrow hidden), and 0 for an entity present only in the CURRENT
  // scenario (→ "+100%" / appeared). comparePct guards the rest (never NaN/Infinity).
  type PeriodMaps = { hoursByYearMonth: Record<string, number>; hoursByFw: Record<string, number> }
  const cmpPeriod = (e: PeriodMaps | undefined, period: string): number | undefined =>
    !comparing ? undefined : (e ? ((viewMode === 'mensal' ? e.hoursByYearMonth[period] : e.hoursByFw[period]) ?? 0) : 0)
  // Compared aggregate over a set of months (quarter columns). Same semantics as cmpPeriod.
  const cmpQuarter = (e: PeriodMaps | undefined, qKeys: string[]): number | undefined =>
    !comparing ? undefined : qKeys.reduce((s, k) => s + ((e ? e.hoursByYearMonth[k] : 0) ?? 0), 0)
  // Compared TOTAL of an entity (0 when only-current, undefined when not comparing).
  const cmpTotal = (total: number | undefined): number | undefined =>
    !comparing ? undefined : (total ?? 0)

  // ── Compared GRAND totals, for the two TOTAL rows ─────────────────────────────────────
  // Shaped as CmpPeriods so the TOTAL rows reuse cmpPeriod/cmpQuarter/cmpTotal unchanged —
  // same methodology, and therefore the same numbers, as every other cell.
  // Each mirrors how the CURRENT scenario's own TOTAL row derives its values, so the two
  // sides of the ratio are always computed the same way:
  //   • areas table → totalsByYearMonth / Σ areas.hoursByFw / totalHours
  //   • locos table → aggregated over tipo rows (cmpTipo ↔ tipoRows)
  const cmpGrand: CmpPeriods | undefined = comparisonSummary
    ? {
        hoursByYearMonth: comparisonSummary.totalsByYearMonth,
        hoursByFw: comparisonSummary.areas.reduce<Record<string, number>>((acc, a) => {
          for (const [fw, h] of Object.entries(a.hoursByFw)) acc[fw] = (acc[fw] ?? 0) + h
          return acc
        }, {}),
        total: comparisonSummary.totalHours,
      }
    : undefined
  const cmpLocosGrand: CmpPeriods | undefined = comparisonSummary
    ? (() => {
        const g: CmpPeriods = { hoursByYearMonth: {}, hoursByFw: {}, total: 0 }
        for (const t of cmpTipo.values()) {
          for (const [ym, h] of Object.entries(t.hoursByYearMonth)) g.hoursByYearMonth[ym] = (g.hoursByYearMonth[ym] ?? 0) + h
          for (const [fw, h] of Object.entries(t.hoursByFw)) g.hoursByFw[fw] = (g.hoursByFw[fw] ?? 0) + h
          g.total += t.total
        }
        return g
      })()
    : undefined

  // ── Union of entities across both scenarios (comparison mode only) ────────────────────
  // The table must show entities present in EITHER scenario — additions AND removals. Rows that
  // exist only in the COMPARED scenario are added as PHANTOMS: zero CURRENT hours (cells render
  // "—"), but their compared values still drive a −100% arrow. Built recursively area→ws→pn and
  // model→loco from the current rows plus any compared-only rows. The displayed hours/totals stay
  // the CURRENT scenario's; compared values are read separately (above) for the arrows.
  const emptyPeriods = () => ({ hoursByYearMonth: {} as Record<string, number>, hoursByFw: {} as Record<string, number> })
  const phantomPn = (p: PnRow): PnRow => ({ pn: p.pn, desc: p.desc, ...emptyPeriods(), total: 0 })
  const phantomWs = (w: WsRow): WsRow => ({ key: w.key, label: w.label, ...emptyPeriods(), total: 0, partNumbers: w.partNumbers.map(phantomPn) })
  const phantomArea = (a: SummaryAreaRow): SummaryAreaRow => ({ area: a.area, locos: 0, workstations: a.workstations.map(phantomWs), ...emptyPeriods(), total: 0 })
  const unionPns = (cur: PnRow[], cmp: PnRow[]): PnRow[] => {
    const seen = new Set(cur.map(p => `${p.pn}||${p.desc}`))
    const out = cur.slice()
    for (const p of cmp) if (!seen.has(`${p.pn}||${p.desc}`)) out.push(phantomPn(p))
    return out
  }
  const unionWs = (cur: WsRow[], cmp: WsRow[]): WsRow[] => {
    const cmpMap = new Map(cmp.map(w => [w.key, w]))
    const out = cur.map(w => { const cw = cmpMap.get(w.key); return cw ? { ...w, partNumbers: unionPns(w.partNumbers, cw.partNumbers) } : w })
    const seen = new Set(cur.map(w => w.key))
    for (const w of cmp) if (!seen.has(w.key)) out.push(phantomWs(w))
    return out
  }
  const displayAreas: SummaryAreaRow[] = !comparisonSummary ? summaryTestData.areas : (() => {
    const out = summaryTestData.areas.map(a => { const ca = cmpArea.get(a.area); return ca ? { ...a, workstations: unionWs(a.workstations, ca.workstations) } : a })
    const seen = new Set(summaryTestData.areas.map(a => a.area))
    for (const a of comparisonSummary.areas) if (!seen.has(a.area)) out.push(phantomArea(a))
    return out
  })()
  const locoIdOf = (l: { loco: string; startMs?: string | number | null }) => `${l.loco}||${String(l.startMs ?? '')}`
  const phantomLoco = (l: LocoRow): LocoRow => ({ ...l, hours: 0, ...emptyPeriods() })
  const phantomModel = (m: ModelGroup): ModelGroup => ({ model: m.model, locos: m.locos.map(phantomLoco), fallback: m.fallback, totalHours: 0, ...emptyPeriods() })
  const displayModelGroups: ModelGroup[] = !comparisonSummary ? summaryTestData.modelGroups : (() => {
    const out = summaryTestData.modelGroups.map(m => {
      const cm = cmpModel.get(m.model)
      if (!cm) return m
      const seenL = new Set(m.locos.map(locoIdOf))
      const locos = m.locos.slice()
      for (const l of cm.locos) if (!seenL.has(locoIdOf(l))) locos.push(phantomLoco(l))
      return { ...m, locos }
    })
    const seen = new Set(summaryTestData.modelGroups.map(m => m.model))
    for (const m of comparisonSummary.modelGroups) if (!seen.has(m.model)) out.push(phantomModel(m))
    return out
  })()
  // Compared aggregates for the KPI cards.
  const cmpTotalHours = comparisonSummary?.totalHours ?? null
  const cmpActiveMonthCount = comparisonSummary ? Object.values(comparisonSummary.totalsByYearMonth).filter(h => h > 0).length : 0
  const cmpAvgPerMonth = comparisonSummary && cmpActiveMonthCount > 0 ? comparisonSummary.totalHours / cmpActiveMonthCount : (comparisonSummary ? 0 : null)
  const cmpAvgPerDay = comparisonSummary && comparisonSummary.businessDaysCount > 0 ? comparisonSummary.totalHours / comparisonSummary.businessDaysCount : (comparisonSummary ? 0 : null)
  const cmpTotalLocos = comparisonSummary ? comparisonSummary.modelGroups.reduce((s, mg) => s + mg.locos.length, 0) : null

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Every body cell anchors the absolutely-positioned comparison badge (CompareArrow) in its
          own top-right corner, so the badge overlays the cell's whitespace instead of pushing the
          value. Harmless on non-data cells (only affects positioned descendants). */}
      <style>{`.resumo-cmp-table td { position: relative; }`}</style>

      {/* Header: left column (type filters → KPIs → filters row) + right distribution chart.
          Type buttons sit ABOVE the KPIs; the 4 KPI cards are ALWAYS shown in both Área and
          Locos modes; Exibição sits directly beside Filtros in the filters row. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Left column — its natural height is the reference cap for the chart + stats panel.
            `flex: 0 1 auto` (do NOT grow): every child of this column is content-sized
            (`alignSelf: flex-start`), so a growing column only produced dead space between the
            KPI cards' right edge and the chart. Not growing hands that space to the chart panel
            instead, which is what makes the chart reach up to the KPI cards. Shrink stays
            enabled so the cards can still wrap on a narrow window. */}
        <div ref={leftColRef} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: '0 1 auto' }}>
          {/* Type selectors — above the KPI cards. Width is locked to the measured KPI cards
              row so both rows share the same left/right edges; buttons flex to divide it evenly
              with consistent spacing, at any screen size.
              flexWrap MUST stay 'nowrap': the row width is driven by `kpiRowW`, a ResizeObserver
              measurement of the KPI row. During loading / scenario / filter reflows that value can
              be sampled mid-layout (KPI cards momentarily wrapped) and come back too small; with
              wrapping enabled the buttons would then stack vertically until the next measurement.
              'nowrap' guarantees a single horizontal row regardless of the measured width — a
              transient small width causes a self-correcting sliver of overflow, never a stack. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', alignSelf: 'flex-start', flexWrap: 'nowrap', width: kpiRowW ?? undefined, minWidth: 'max-content' }}>
            {TIPOS.map(lt => {
              const active = summaryLineTypes.has(lt.key)
              // TWO conditions, and they answer different questions.
              //   loaded  — was this Tipo part of the load? Only the launch screen decides that;
              //             a Tipo left out of it has no data behind it in this session at all.
              //   hasData — did the loaded dataset actually contain rows for it? Only meaningful
              //             for schedule-backed Tipos, which is where `availableLineTypes` comes
              //             from (it is derived from the Schedule's own Linhas). A Tipo with no
              //             Schedule behind it never appears there and must not be judged by it,
              //             or such a Tipo would be permanently greyed out the moment it was loaded.
              const loaded  = loadedLineTypes.size === 0 || loadedLineTypes.has(lt.key)
              const hasData = !isScheduleBacked(lt.key) || availableLineTypes.has(lt.key)
              const usable  = loaded && hasData
              return (
                <button key={lt.key} disabled={!usable}
                  onClick={() => { if (!usable) return; setSummaryLineTypes(prev => { const n = new Set(prev); if (n.has(lt.key)) n.delete(lt.key); else n.add(lt.key); return n }) }}
                  title={!loaded
                    ? `${lt.label} não faz parte desta carga — selecione-o na tela de abertura e carregue novamente.`
                    : !hasData ? `${lt.label} não foi carregado neste período` : undefined}
                  style={{ flex: '1 1 auto', minWidth: 'max-content', textAlign: 'center', border: `2px solid ${active && usable ? RED : usable ? '#99F6E4' : '#E5E7EB'}`, background: active && usable ? RED : usable ? '#F0FDFA' : '#F9FAFB', color: active && usable ? '#fff' : usable ? '#F87171' : '#D1D5DB', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: usable ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', transition: 'all 0.15s', letterSpacing: '0.01em', opacity: usable ? 1 : 0.5 }}>
                  {lt.label}
                </button>
              )
            })}
          </div>

          {/* KPI cards — ALWAYS 4: Horas Totais · Média/mês · Média/dia · Locos. Each card is
              content-sized (flex: 0 0 auto → basis = its caption + value), floored at KPI_CARD_MIN_W
              for visual consistency, so a low-content card (e.g. Locos) no longer reserves the same
              width as Horas Totais and lateral dead space is removed. `flex-shrink: 0` keeps a card
              from ever collapsing below its content, so text never wraps; the ROW uses
              `alignSelf: flex-start` to opt out of the column's `align-items: stretch` (an explicit
              `width: fit-content` is NOT honored here — stretch wins), so it shrinks to the cards'
              combined width on wide screens — leaving no gap at the right edge — and, capped at
              maxWidth 100%, fills the column and lets the cards wrap on narrow screens. The measured
              width still drives the Type buttons row above, so edges stay aligned. */}
          <div ref={kpiRowRef} style={{ display: 'flex', gap: 8, alignItems: 'stretch', alignSelf: 'flex-start', flexWrap: 'wrap', maxWidth: '100%' }}>
            <div style={{ flex: '0 0 auto', minWidth: KPI_CARD_MIN_W, position: 'relative', borderRadius: 10, padding: '10px 16px', border: `1.5px solid ${RED}`, background: '#F0FDFA', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500, paddingRight: cardBadgeReserve(summaryTestData.totalHours, cmpTotalHours), whiteSpace: 'nowrap' }}>Horas Totais</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: RED, lineHeight: 1.1, display: 'flex', alignItems: 'center' }}>
                {showArrows && <CompareArrow current={summaryTestData.totalHours} compared={cmpTotalHours} size={16} variant="card" />}
                {summaryMode === 'ue' ? formatSummaryValue(summaryTestData.totalHours) : fmt(Math.round(summaryTestData.totalHours))}
                <span style={{ fontSize: 11, fontWeight: 500, color: '#9CA3AF', marginLeft: 3 }}>{summaryMode === 'ue' ? 'U.E.' : 'h'}</span>
              </div>
            </div>
            <div style={{ flex: '0 0 auto', minWidth: KPI_CARD_MIN_W, position: 'relative', borderRadius: 10, padding: '10px 16px', border: '1.5px solid #E5E7EB', background: '#F9FAFB', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500, paddingRight: cardBadgeReserve(avgPerMonth, cmpAvgPerMonth), whiteSpace: 'nowrap' }}>Média / mês</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#374151', lineHeight: 1.1, display: 'flex', alignItems: 'center' }}>
                {showArrows && <CompareArrow current={avgPerMonth} compared={cmpAvgPerMonth} size={16} variant="card" />}
                {summaryMode === 'ue' ? formatSummaryValue(avgPerMonth) : fmt(Math.round(avgPerMonth))}
                <span style={{ fontSize: 11, fontWeight: 500, color: '#9CA3AF', marginLeft: 3 }}>{summaryMode === 'ue' ? 'U.E.' : 'h'}</span>
              </div>
            </div>
            <div style={{ flex: '0 0 auto', minWidth: KPI_CARD_MIN_W, position: 'relative', borderRadius: 10, padding: '10px 16px', border: '1.5px solid #E5E7EB', background: '#F9FAFB', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500, paddingRight: cardBadgeReserve(avgPerDay, cmpAvgPerDay), whiteSpace: 'nowrap' }}>Média / dia</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#374151', lineHeight: 1.1, display: 'flex', alignItems: 'center' }}>
                {showArrows && <CompareArrow current={avgPerDay} compared={cmpAvgPerDay} size={16} variant="card" />}
                {summaryMode === 'ue' ? formatSummaryValue(avgPerDay) : Math.round(avgPerDay)}
                <span style={{ fontSize: 11, fontWeight: 500, color: '#9CA3AF', marginLeft: 3 }}>{summaryMode === 'ue' ? 'U.E./dia' : 'h/dia'}</span>
              </div>
            </div>
            {/* Locos count + total conflicts — now ALWAYS shown (previously Locos-mode only).
                Conflict total reflects the visible/filtered dataset and updates with filters/optimization. */}
            {(() => {
              const totalLocos = summaryTestData.modelGroups.reduce((s, mg) => s + mg.locos.length, 0)
              return (
                <div style={{ flex: '0 0 auto', minWidth: KPI_CARD_MIN_W, position: 'relative', borderRadius: 10, padding: '10px 16px', border: '1.5px solid #E5E7EB', background: '#F9FAFB', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 500, paddingRight: cardBadgeReserve(totalLocos, cmpTotalLocos), whiteSpace: 'nowrap' }}>Locos</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#374151', lineHeight: 1.1, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      {showArrows && <CompareArrow current={totalLocos} compared={cmpTotalLocos} size={16} variant="card" />}
                      {fmt(totalLocos)}
                    </span>
                    <span title="Conflitos totais (WS40/WS50)" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 15, fontWeight: 800, color: totalConflicts > 0 ? RED : '#9CA3AF' }}>
                      {fmt(totalConflicts)}
                      <ConflictIcon />
                    </span>
                  </div>
                </div>
              )
            })()}
          </div>

          {/* Filters row: Datas + Filtros + Exibição (Exibição directly beside Filtros) */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            {/* Panel 1: Date filters — shared DateFilterDropdown (also used by Plano) */}
            <DateFilterDropdown
              years={years} quarters={quarters} months={months} fws={allFws}
              selYears={selYears} selQuarters={selQuarters} selMonths={selMonths} selFws={selFws}
              onToggleYear={toggleYear} onToggleQuarter={toggleQuarter} onToggleMonth={toggleMonth} onToggleFw={toggleFw}
              onClear={clearDateFilters}
            />

            {/* Panel 2: Data filters */}
            <div ref={dataFiltersRef} style={{ position: 'relative' }}>
              <FilterGroupChip
                icon={<SlidersHorizontal size={13} />} label="Filtros"
                count={selModels.size + selAreas.size + selWorkstations.size}
                open={dataFiltersOpen} onClick={() => setDataFiltersOpen(v => !v)}
              />
              {dataFiltersOpen && (
                <div style={FILTER_DROPDOWN_STYLE}>
                  <FilterDropdownHeader
                    title="Filtros de visualização"
                    showClear={selModels.size > 0 || selAreas.size > 0 || selWorkstations.size > 0}
                    onClear={clearDataFilters}
                  />
                  <div style={FILTER_ROW_STYLE}>
                    <FilterBox icon={<Boxes size={12}/>} label="Modelo" items={allModels} selected={selModels} onToggle={mdl => setSelModels(prev => { const n = new Set(prev); if (n.has(mdl)) n.delete(mdl); else n.add(mdl); return n })} formatItem={m => m} />
                    <FilterBox icon={<Layers size={12}/>} label="Área" items={allAreas} selected={selAreas} onToggle={a => setSelAreas(prev => { const n = new Set(prev); if (n.has(a)) n.delete(a); else n.add(a); return n })} formatItem={a => a} />
                    <FilterBox icon={<LayoutGrid size={12}/>} label="Workstation" items={allWorkstations} selected={selWorkstations} onToggle={w => setSelWorkstations(prev => { const n = new Set(prev); if (n.has(w)) n.delete(w); else n.add(w); return n })} formatItem={w => w} />
                  </div>
                </div>
              )}
            </div>

            {/* Panel 3: Exibição (settings) — directly beside Filtros */}
            <div ref={settingsRef} style={{ position: 'relative' }}>
              <button onClick={() => setSettingsOpen(v => !v)} title="Configurações de visualização" style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                borderRadius: 8, border: `1.5px solid ${settingsOpen ? RED : '#D1D5DB'}`,
                background: settingsOpen ? RED_LT : '#F9FAFB', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, color: settingsOpen ? RED : '#374151', whiteSpace: 'nowrap',
              }}>
                <Settings size={13} style={{ color: settingsOpen ? RED : '#6B7280' }} />
                Exibição
                <ChevronDown size={12} style={{ color: settingsOpen ? RED : '#9CA3AF', transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
              </button>
              {settingsOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50,
                  background: '#fff', border: `1px solid ${RED}33`, borderRadius: 10,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 230, padding: '12px 14px',
                  display: 'flex', flexDirection: 'column', gap: 10,
                }}>
              {/* Group: Visualização */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Visualização</span>
                <RedSegment
                  options={[{ key: 'mensal', label: 'Mensal' }, { key: 'semanal', label: 'Semanal' }] as const}
                  value={viewMode} onChange={setViewMode}
                />
                {(() => {
                  const quartersDisabled = viewMode === 'semanal'
                  return (
                    <button onClick={quartersDisabled ? undefined : () => setShowQuarters(q => !q)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${quartersDisabled ? '#E5E7EB' : showQuarters ? RED : '#D1D5DB'}`, background: quartersDisabled ? '#F9FAFB' : showQuarters ? RED_LT : '#fff', color: quartersDisabled ? '#D1D5DB' : showQuarters ? RED : '#6B7280', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 700, cursor: quartersDisabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', opacity: quartersDisabled ? 0.55 : 1 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, border: `1.5px solid ${quartersDisabled ? '#D1D5DB' : showQuarters ? RED : '#9CA3AF'}`, background: quartersDisabled ? '#F3F4F6' : showQuarters ? RED : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {showQuarters && !quartersDisabled && <span style={{ color: '#fff', fontSize: 8, lineHeight: 1 }}>✓</span>}
                      </span>
                      Mostrar quarters (Q1–Q4)
                    </button>
                  )
                })()}
                {/* "Unir períodos" — collapse the view onto the SELECTED periods only. Off (default)
                    the whole timeline stays on screen with the non-selected periods reading 0; on,
                    they are dropped from the table and the chart and the survivors expand into the
                    freed width. Works for Ano / Trimestre / Mês / Semana alike (see ymInSelection).
                    Same checkbox idiom as the quarters row above. */}
                <button onClick={() => setMergePeriods(v => !v)}
                  title="Unir períodos — exibir apenas os períodos selecionados nos filtros de data. Os demais saem da tabela e do gráfico (em vez de aparecerem zerados) e os restantes ocupam todo o espaço."
                  style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${mergePeriods ? RED : '#D1D5DB'}`, background: mergePeriods ? RED_LT : '#fff', color: mergePeriods ? RED : '#6B7280', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, border: `1.5px solid ${mergePeriods ? RED : '#9CA3AF'}`, background: mergePeriods ? RED : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {mergePeriods && <span style={{ color: '#fff', fontSize: 8, lineHeight: 1 }}>✓</span>}
                  </span>
                  Unir períodos
                </button>
              </div>
              <div style={{ height: 1, background: '#F3F4F6' }} />
              {/* Group: Unidade */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Unidade</span>
                <RedSegment
                  options={[{ key: 'horas', label: 'Horas' }, { key: 'ue', label: 'U.E.' }] as const}
                  value={summaryMode} onChange={setSummaryMode}
                />
              </div>
              <div style={{ height: 1, background: '#F3F4F6' }} />
              {/* Group: Agrupamento */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Agrupamento</span>
                {/* Locos is unavailable when there is nothing with LOCOs on screen — a
                    such a selection plans PARTS, and the Locos view would be an empty table
                    with no explanation. Disabled and labelled rather than hidden. */}
                <RedSegment
                  options={[{ key: 'area', label: 'Área' }, { key: 'locos', label: 'Locos' }] as const}
                  value={rowMode} onChange={setRowMode}
                  disabled={locoViewAvailable ? undefined : (['locos'] as const)}
                  titleFor={k => (k === 'locos' && !locoViewAvailable)
                    ? 'Os Tipos selecionados não possuem LOCO (planejam peças, não locomotivas).'
                    : undefined}
                />
              </div>
            </div>
          )}
            </div>
            {/* "Unir locos" is NOT here: it lives in the modal footer beside Exportar (see
                GanttModalFooter), where the export it also governs sits. */}
          </div>
        </div>

        {/* Right: statistics panel + distribution chart. The chart always shows the FULL timeline
            (the selected month is only highlighted, never filtered out); the stats panel to its
            LEFT summarizes the exact plotted dataset. */}
        {/* Height tracks the controls column as a MINIMUM (minHeight), not a hard cap. A hard
            `maxHeight + overflow:hidden` clipped the bottom stat row whenever the controls column
            was shorter than the three stat rows need (worsened once the CV/status content grew).
            Using minHeight lets the panel grow to fit the cards — no clipping — while still matching
            the controls column in the common case where it's the taller side. */}
        <div style={{ display: 'flex', gap: 10, minWidth: 546, flex: '2 1 546px', alignItems: 'stretch', minHeight: leftColH ?? undefined, overflow: 'visible' }}>
          {/* Fixed 2×3 statistics table — Upper/Lower Limit (prominent) · deviations (%/raw) ·
              Coef. Variação / Variabilidade (secondary). Recomputes with the chart data. Rows use
              minmax(min-content,1fr) so a card never shrinks below its content (no cut-off). */}
          <div style={{ flexShrink: 0, width: 240, display: 'grid', gridTemplateColumns: '1fr 1fr', gridAutoRows: 'minmax(min-content, 1fr)', gap: 6, minHeight: 0, overflow: 'visible' }}>
            <StatCell red size={17} label="Limite Superior" value={upperPoint ? chartNum(upperPoint.value) : '—'} unit={upperPoint ? statUnit : undefined} />
            <StatCell red size={17} label="Limite Inferior" value={lowerPoint ? chartNum(lowerPoint.value) : '—'} unit={lowerPoint ? statUnit : undefined} />
            <StatCell size={13} label="Desvio Superior" value={fmtDev(upperDevPct, upperDevAbs)} />
            <StatCell size={13} label="Desvio Inferior" value={fmtDev(lowerDevPct, lowerDevAbs)} />
            {/* Coef. Variação (primary %) + Desvio Padrão (secondary), same hierarchy as the
                deviation cards — e.g. "18% / 12h". */}
            <StatCell size={16} label="Coef. Variação" value={statCvPct == null ? '—' : (
              <>
                <span style={{ fontSize: 16, fontWeight: 800 }}>{Math.round(statCvPct)}%</span>
                <span style={{ fontSize: 10, fontWeight: 500, color: '#9CA3AF', marginLeft: 4 }}>
                  / {formatSummaryValue(statStdDev)}{statUnit}
                </span>
              </>
            )} />
            {/* Qualitative variability status derived from CV — subtle card, light status-colored
                border (no aggressive fill): Baixo ≤15% (green) · Médio ≤30% (orange) · Alto >30% (red). */}
            {(() => {
              const s = statCvPct == null
                ? { text: '—',           border: '#E5E7EB', color: '#9CA3AF' }
                : statCvPct <= 15
                  ? { text: 'Desvio Baixo', border: '#86EFAC', color: '#16A34A' }
                  : statCvPct <= 30
                    ? { text: 'Desvio Médio', border: '#FDBA74', color: '#EA580C' }
                    : { text: 'Desvio Alto',  border: '#FCA5A5', color: '#DC2626' }
              return <StatCell size={14} label="Variabilidade" value={s.text} borderColor={s.border} valueColor={s.color} labelColor={s.color} />
            })()}
          </div>
          <SummaryAreaChart
            points={chartPoints}
            comparePoints={comparePoints}
            average={chartAverage}
            title={chartTitle}
            formatValue={chartFormat}
            scrollable={viewMode === 'semanal'}
            color={RED}
            onToggleMetric={() => setChartMetric(m => m === 'total' ? 'perDay' : 'total')}
            onPointClick={toggleFromChart}
            selectedKeys={chartSelectedKeys}
            // Expanded view only (the chart ignores both in the compact card): the Exibição menu
            // that owns Mensal/Semanal is unreachable from inside the overlay, and the series names
            // are what the extra room is for. `scenarioName` is already the ACTIVE scenario in
            // comparison mode, so the compared label is whichever side it is not.
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            scenarioLabel={scenarioName}
            compareScenarioLabel={comparisonMode
              ? (comparisonActive === 'base' ? comparisonTargetName : comparisonBaseName)
              : undefined}
          />
        </div>
      </div>

      {/* ─── Area table ─── */}
      {rowMode === 'area' && <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto', background: '#fff' }}>
        {(() => {
          const BASE_COL_W = 176
          const anyAreaOpen = expandedAreasTest.size > 0
          const anyPnOpen = expandedPnsTest.size > 0
          const colBoost = anyPnOpen ? 2 : anyAreaOpen ? 1 : 0
          const col1W = Math.round(BASE_COL_W * (1 + colBoost * 0.20))
          const tblW = viewMode === 'mensal'
            ? (() => { const numYms = viewYms.length; const numQCols = showQuarters ? viewYms.filter(ym => parseInt(ym.slice(5,7)) % 3 === 0).length : 0; return col1W + 82 + numYms * 62 + numQCols * 56 + 88 })()
            : col1W + 82 + viewFws.length * 58 + 88
          return (
            <table className="resumo-cmp-table" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', width: tblW, minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#FFF1F1' }}>
                  <th style={{ width: col1W, minWidth: col1W, textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6B7280', borderBottom: '1px solid #CCFBF1', transition: 'width 0.2s' }}>Área</th>
                  <th style={{ width: 82, minWidth: 82, textAlign: 'center', padding: '10px 4px', fontSize: 10, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>Média</th>
                  {viewMode === 'mensal' ? (
                    viewYms.map((ym) => {
                      const monthNum = parseInt(ym.slice(5, 7))
                      return (
                        <Fragment key={`mh-${ym}`}>
                          <th style={{ width: 62, minWidth: 62, textAlign: 'center', padding: '10px 6px', fontSize: 11, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>{monthLabel(ym)}</th>
                          {showQuarters && monthNum % 3 === 0 && (
                            <th style={{ width: 56, minWidth: 56, textAlign: 'center', padding: '10px 2px', fontSize: 10, fontWeight: 800, color: RED, background: '#F0FDFA', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #99F6E4' }}>Q{Math.ceil(monthNum / 3)}</th>
                          )}
                        </Fragment>
                      )
                    })
                  ) : (
                    viewFws.map(fw => (
                      <th key={fw} style={{ width: 58, minWidth: 58, textAlign: 'center', padding: '10px 4px', fontSize: 10, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>{fw}</th>
                    ))
                  )}
                  <th style={{ width: 88, minWidth: 88, textAlign: 'center', padding: '10px 4px', fontSize: 11, color: RED, borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {displayAreas.map((area, rowIdx) => {
                  const isOpen = expandedAreasTest.has(area.area)
                  const areaAvgPerDay = summaryTestData.businessDaysCount > 0 ? area.total / summaryTestData.businessDaysCount : 0
                  return (
                    <Fragment key={area.area}>
                      <tr onClick={() => setExpandedAreasTest(prev => { const n = new Set(prev); if (n.has(area.area)) n.delete(area.area); else n.add(area.area); return n })} style={{ background: rowIdx % 2 === 0 ? '#fff' : '#FCFCFD', cursor: 'pointer' }}>
                        <td style={{ padding: '10px 14px', borderBottom: '1px solid #EEF2F7' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <ChevronDown size={13} style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s', color: '#9CA3AF', flexShrink: 0 }} />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: RED }}>{area.area}</div>
                              <div style={{ fontSize: 10, color: '#9CA3AF' }}>{area.workstations.length} subáreas</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                          {(() => { const activeM = viewMode === 'mensal' ? Object.values(area.hoursByYearMonth).filter(h => h > 0).length : Object.values(area.hoursByFw).filter(h => h > 0).length; const avg = activeM > 0 ? area.total / activeM : 0; return avg > 0 ? (<><div style={{ fontSize: 11, fontWeight: 700, color: '#4B5563' }}>{summaryMode === 'ue' ? formatSummaryValue(avg) : `${fmt(Math.round(avg))} h`}</div>{<div style={{ fontSize: 9, color: '#A3AAB7' }}>{summaryMode === 'ue' ? formatSummaryValue(areaAvgPerDay) : Math.round(areaAvgPerDay)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>—</div> })()}
                        </td>
                        {viewMode === 'mensal' ? (
                          viewYms.map((ym) => {
                            const h = area.hoursByYearMonth[ym] ?? 0
                            const days = summaryTestData.monthBusinessDays[ym] ?? 0
                            const monthNum = parseInt(ym.slice(5, 7))
                            const isQEnd = monthNum % 3 === 0
                            const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                            const qTotal = qKeys.reduce((s, key) => s + (area.hoursByYearMonth[key] ?? 0), 0)
                            const qDays  = qKeys.reduce((s, key) => s + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                            return (
                              <Fragment key={`${area.area}-${ym}`}>
                                <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpArea.get(area.area), ym)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                                  {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                                </td>
                                {showQuarters && isQEnd && (
                                  <td style={{ textAlign: 'center', padding: '6px 2px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #99F6E4', background: '#F0FDFA' }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: qTotal > 0 ? RED : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpArea.get(area.area), qKeys)} size={9} />}{qTotal > 0 ? (summaryMode === 'ue' ? formatSummaryValue(qTotal) : `${formatSummaryValue(qTotal)} h`) : '—'}</div>
                                    {qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}
                                  </td>
                                )}
                              </Fragment>
                            )
                          })
                        ) : (
                          viewFws.map(fw => {
                            const h = area.hoursByFw[fw] || 0
                            const days = summaryTestData.fwBusinessDays[fw] || 0
                            return (
                              <td key={fw} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpArea.get(area.area), fw)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                                {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                              </td>
                            )
                          })
                        )}
                        <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', background: '#F0FDFA', borderLeft: '1px solid #CCFBF1' }}>
                          <div style={{ fontSize: 12, fontWeight: 800, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={area.total} compared={cmpTotal(cmpArea.get(area.area)?.total)} />}{formatTotalValue(area.total)}</div>
                        </td>
                      </tr>

                      {isOpen && area.workstations.map((ws, wsIdx) => {
                        const wsAvgPerDay = summaryTestData.businessDaysCount > 0 ? ws.total / summaryTestData.businessDaysCount : 0
                        const wsPnsOpen = expandedPnsTest.has(ws.key)
                        const hasPns = ws.partNumbers.length > 0
                        return (
                          <Fragment key={ws.key}>
                            <tr onClick={hasPns ? () => setExpandedPnsTest(prev => { const n = new Set(prev); n.has(ws.key) ? n.delete(ws.key) : n.add(ws.key); return n }) : undefined} style={{ background: wsIdx % 2 === 0 ? '#FAFBFC' : '#F4F6F8', cursor: hasPns ? 'pointer' : 'default' }}>
                              <td style={{ padding: '7px 14px 7px 36px', borderBottom: '1px solid #EEF2F7' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {hasPns && <ChevronDown size={11} style={{ transform: wsPnsOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s', color: '#9CA3AF', flexShrink: 0 }} />}
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>{ws.label}</div>
                                    {hasPns && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{ws.partNumbers.length} itens</div>}
                                  </div>
                                </div>
                              </td>
                              <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                {(() => { const activeM = viewMode === 'mensal' ? Object.values(ws.hoursByYearMonth).filter(h => h > 0).length : Object.values(ws.hoursByFw).filter(h => h > 0).length; const avg = activeM > 0 ? ws.total / activeM : 0; return avg > 0 ? (<><div style={{ fontSize: 10, fontWeight: 600, color: '#4B5563' }}>{summaryMode === 'ue' ? formatSummaryValue(avg) : `${fmt(Math.round(avg))} h`}</div>{<div style={{ fontSize: 9, color: '#A3AAB7' }}>{summaryMode === 'ue' ? formatSummaryValue(wsAvgPerDay) : Math.round(wsAvgPerDay)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 10, fontWeight: 600, color: '#CBD5E1' }}>—</div> })()}
                              </td>
                              {viewMode === 'mensal' ? (
                                viewYms.map((ym) => {
                                  const h = ws.hoursByYearMonth[ym] ?? 0
                                  const days = summaryTestData.monthBusinessDays[ym] ?? 0
                                  const monthNum = parseInt(ym.slice(5, 7))
                                  const isQEnd = monthNum % 3 === 0
                                  const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                                  const qTotal = qKeys.reduce((s, key) => s + (ws.hoursByYearMonth[key] ?? 0), 0)
                                  const qDays  = qKeys.reduce((s, key) => s + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                                  return (
                                    <Fragment key={`${ws.key}-${ym}`}>
                                      <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                        <div style={{ fontSize: 11, fontWeight: 700, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpWs.get(`${area.area}||${ws.key}`), ym)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                                        {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                                      </td>
                                      {showQuarters && isQEnd && (
                                        <td style={{ textAlign: 'center', padding: '4px 2px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1', background: '#F4F6F8' }}>
                                          <div style={{ fontSize: 10, fontWeight: 700, color: qTotal > 0 ? '#374151' : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpWs.get(`${area.area}||${ws.key}`), qKeys)} size={9} />}{qTotal > 0 ? (summaryMode === 'ue' ? formatSummaryValue(qTotal) : `${formatSummaryValue(qTotal)} h`) : '—'}</div>
                                          {qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}
                                        </td>
                                      )}
                                    </Fragment>
                                  )
                                })
                              ) : (
                                viewFws.map(fw => {
                                  const h = ws.hoursByFw[fw] || 0
                                  const days = summaryTestData.fwBusinessDays[fw] || 0
                                  return (
                                    <td key={fw} style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                      <div style={{ fontSize: 11, fontWeight: 700, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpWs.get(`${area.area}||${ws.key}`), fw)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                                      {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                                    </td>
                                  )
                                })
                              )}
                              <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', background: '#F4F6F8', borderLeft: '1px solid #CCFBF1' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={ws.total} compared={cmpTotal(cmpWs.get(`${area.area}||${ws.key}`)?.total)} size={11} />}{formatTotalValue(ws.total)}</div>
                              </td>
                            </tr>

                            {wsPnsOpen && ws.partNumbers.map((pn, pnIdx) => (
                              <tr key={`${ws.key}-pn-${pnIdx}`} style={{ background: '#F0F4FF' }}>
                                <td style={{ padding: '5px 14px 5px 58px', borderBottom: '1px solid #E8ECF5' }}>
                                  <div>
                                    {pn.pn && <span style={{ fontSize: 10, fontWeight: 700, color: '#1D4ED8', marginRight: 5 }}>{pn.pn}</span>}
                                    <span style={{ fontSize: 10, color: '#6B7280' }}>{pn.desc || '—'}</span>
                                  </div>
                                </td>
                                <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}>
                                  {(() => { const activeM = viewMode === 'mensal' ? Object.values(pn.hoursByYearMonth).filter(h => h > 0).length : Object.values(pn.hoursByFw).filter(h => h > 0).length; const avg = activeM > 0 ? pn.total / activeM : 0; return avg > 0 ? <div style={{ fontSize: 10, fontWeight: 600, color: '#4B5563' }}>{summaryMode === 'ue' ? formatSummaryValue(avg) : `${fmt(Math.round(avg))} h`}</div> : <div style={{ fontSize: 10, color: '#CBD5E1' }}>—</div> })()}
                                </td>
                                {viewMode === 'mensal' ? (
                                  viewYms.map((ym) => {
                                    const h = pn.hoursByYearMonth[ym] ?? 0
                                    const monthNum = parseInt(ym.slice(5, 7))
                                    const isQEnd = monthNum % 3 === 0
                                    return (
                                      <Fragment key={`${ws.key}-pn${pnIdx}-${ym}`}>
                                        <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}>
                                          <div style={{ fontSize: 10, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpPn.get(`${area.area}||${ws.key}||${pn.pn}||${pn.desc}`), ym)} size={9} />}{h > 0 ? `${formatSummaryValue(h)} h` : '—'}</div>
                                        </td>
                                        {showQuarters && isQEnd && <td style={{ borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1', background: '#EEF2FF' }} />}
                                      </Fragment>
                                    )
                                  })
                                ) : (
                                  viewFws.map(fw => {
                                    const h = pn.hoursByFw[fw] || 0
                                    return (
                                      <td key={fw} style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}>
                                        <div style={{ fontSize: 10, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpPn.get(`${area.area}||${ws.key}||${pn.pn}||${pn.desc}`), fw)} size={9} />}{h > 0 ? `${formatSummaryValue(h)} h` : '—'}</div>
                                      </td>
                                    )
                                  })
                                )}
                                <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', background: '#EEF2FF', borderLeft: '1px solid #CCFBF1' }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, color: '#1D4ED8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={pn.total} compared={cmpTotal(cmpPn.get(`${area.area}||${ws.key}||${pn.pn}||${pn.desc}`)?.total)} size={10} />}{formatTotalValue(pn.total)}</div>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  )
                })}

                {/* Total row */}
                <tr style={{ background: '#CCFBF1' }}>
                  <td style={{ padding: '12px 14px', fontWeight: 800, color: RED, fontSize: 12, borderTop: '1px solid #CCFBF1' }}>TOTAL</td>
                  <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>
                    {(() => {
                      const activeM = viewMode === 'mensal' ? Object.values(summaryTestData.totalsByYearMonth).filter(h => h > 0).length : viewFws.length
                      const avg = activeM > 0 ? summaryTestData.totalHours / activeM : 0
                      return avg > 0 ? (<><div style={{ fontSize: 12, fontWeight: 800, color: RED }}>{summaryMode === 'ue' ? formatSummaryValue(avg) : `${fmt(Math.round(avg))} h`}</div>{<div style={{ fontSize: 9, color: '#9CA3AF' }}>{summaryMode === 'ue' ? formatSummaryValue(summaryTestData.businessDaysCount > 0 ? summaryTestData.totalHours / summaryTestData.businessDaysCount : 0) : Math.round(summaryTestData.businessDaysCount > 0 ? summaryTestData.totalHours / summaryTestData.businessDaysCount : 0)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 12, fontWeight: 800, color: '#CBD5E1' }}>—</div>
                    })()}
                  </td>
                  {viewMode === 'mensal' ? (
                    viewYms.map(ym => {
                      const h = summaryTestData.totalsByYearMonth[ym] ?? 0
                      const days = summaryTestData.monthBusinessDays[ym] ?? 0
                      const monthNum = parseInt(ym.slice(5, 7))
                      const isQEnd = monthNum % 3 === 0
                      const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                      const qTotal = qKeys.reduce((s, key) => s + (summaryTestData.totalsByYearMonth[key] ?? 0), 0)
                      const qDays  = qKeys.reduce((s, key) => s + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                      return (
                        <Fragment key={`total-${ym}`}>
                          <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1', boxShadow: limitLineShadow(ym) }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: RED }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpGrand, ym)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                            {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                          </td>
                          {showQuarters && isQEnd && <td style={{ textAlign: 'center', padding: '6px 2px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #99F6E4', background: '#CCFBF1' }}><div style={{ fontSize: 11, fontWeight: 900, color: qTotal > 0 ? RED : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpGrand, qKeys)} size={9} />}{qTotal > 0 ? (summaryMode === 'ue' ? formatSummaryValue(qTotal) : `${formatSummaryValue(qTotal)} h`) : '—'}</div>{qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}</td>}
                        </Fragment>
                      )
                    })
                  ) : (
                    viewFws.map(fw => {
                      const h = summaryTestData.areas.reduce((s, a) => s + (a.hoursByFw[fw] || 0), 0)
                      const days = summaryTestData.fwBusinessDays[fw] || 0
                      return (
                        <td key={fw} style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1', boxShadow: limitLineShadow(fw) }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: RED }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpGrand, fw)} size={9} />}{h > 0 ? (summaryMode === 'ue' ? formatSummaryValue(h) : `${formatSummaryValue(h)} h`) : '—'}</div>
                          {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                        </td>
                      )
                    })
                  )}
                  <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', background: '#F9DCDC', borderLeft: '1px solid #CCFBF1' }}>
                    <div style={{ fontSize: 13, fontWeight: 900, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={summaryTestData.totalHours} compared={cmpTotal(cmpGrand?.total)} />}{formatTotalValue(summaryTestData.totalHours)}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          )
        })()}
      </div>}

      {/* ─── Locos table ─── */}
      {rowMode === 'locos' && (() => {
        // LOCO-bearing Tipos in registry order + the 'other' catch-all. This whole table is
        // per-LOCO, so a Tipo without LOCOs has no row to contribute here.
        const TIPO_SECTIONS: { key: string; label: string }[] = [
          ...TIPOS.filter(t => t.hasLoco).map(t => ({ key: t.key as string, label: t.label })),
          { key: 'other',        label: 'Outros' },
        ]
        type TipoRow ={ tipo: string; label: string; hoursByYearMonth: Record<string, number>; hoursByFw: Record<string, number>; total: number; models: typeof summaryTestData.modelGroups }
        const tipoRows: TipoRow[] = TIPO_SECTIONS.map(s => {
          const models = displayModelGroups
            .map(mg => ({ ...mg, locos: mg.locos.filter(lr => (lr.tipoGeral || 'other') === s.key) }))
            .filter(mg => mg.locos.length > 0)
            .map(mg => {
              const mHoursByYm: Record<string, number> = {}
              const mHoursByFw: Record<string, number> = {}
              for (const l of mg.locos) {
                for (const [ym, h] of Object.entries(l.hoursByYearMonth)) mHoursByYm[ym] = (mHoursByYm[ym] ?? 0) + h
                for (const [fw, h] of Object.entries(l.hoursByFw)) mHoursByFw[fw] = (mHoursByFw[fw] ?? 0) + h
              }
              return { ...mg, hoursByYearMonth: mHoursByYm, hoursByFw: mHoursByFw, totalHours: mg.locos.reduce((s2, l) => s2 + l.hours, 0) }
            })
          const tipoHoursByYm: Record<string, number> = {}
          const tipoHoursByFw: Record<string, number> = {}
          for (const mg of models) {
            for (const [ym, h] of Object.entries(mg.hoursByYearMonth)) tipoHoursByYm[ym] = (tipoHoursByYm[ym] ?? 0) + h
            for (const [fw, h] of Object.entries(mg.hoursByFw)) tipoHoursByFw[fw] = (tipoHoursByFw[fw] ?? 0) + h
          }
          return { tipo: s.key, label: s.label, hoursByYearMonth: tipoHoursByYm, hoursByFw: tipoHoursByFw, total: models.reduce((s2, mg) => s2 + mg.totalHours, 0), models }
        // Hide all-zero-hour Tipo sections as before, EXCEPT when the section holds a
        // Setup entry (matched on wo or task_name) — Setups are 0h by nature and must
        // stay visible. Non-Setup zero-hour Tipos keep falling away.
        }).filter(t => t.total > 0 || t.models.some(mg => isSetupName(mg.model) || mg.locos.some(l => isSetupName(l.loco))))
        if (tipoRows.length === 0) return null

        const BASE_COL_W = 176
        const anyTipoOpen = expandedAreasTest.size > 0
        const anyModelOpen = expandedPnsTest.size > 0
        const colBoost = anyModelOpen ? 2 : anyTipoOpen ? 1 : 0
        const col1W = Math.round(BASE_COL_W * (1 + colBoost * 0.20))
        const tblW = viewMode === 'mensal'
          ? (() => { const numYms = viewYms.length; const numQCols = showQuarters ? viewYms.filter(ym => parseInt(ym.slice(5,7)) % 3 === 0).length : 0; return col1W + 82 + numYms * 62 + numQCols * 56 + 88 })()
          : col1W + 82 + viewFws.length * 58 + 88

        const locosGrandTotal = tipoRows.reduce((s2, t) => s2 + t.total, 0)
        const locosGrandByYm: Record<string, number> = {}
        const locosGrandByFw: Record<string, number> = {}
        for (const t of tipoRows) {
          for (const [ym, h] of Object.entries(t.hoursByYearMonth)) locosGrandByYm[ym] = (locosGrandByYm[ym] ?? 0) + h
          for (const [fw, h] of Object.entries(t.hoursByFw)) locosGrandByFw[fw] = (locosGrandByFw[fw] ?? 0) + h
        }

        const cellVal = (h: number) => h > 0 ? fmtMain(h) : '—'
        const cellColor = (h: number) => h > 0 ? '#4B5563' : '#CBD5E1'

        return (
          <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto', background: '#fff' }}>
            <table className="resumo-cmp-table" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', width: tblW, minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#FFF1F1' }}>
                  <th style={{ width: col1W, minWidth: col1W, textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6B7280', borderBottom: '1px solid #CCFBF1', transition: 'width 0.2s' }}>Tipo / Modelo / Loco</th>
                  <th style={{ width: 82, minWidth: 82, textAlign: 'center', padding: '10px 4px', fontSize: 10, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>Média</th>
                  {viewMode === 'mensal' ? (
                    viewYms.map((ym) => {
                      const monthNum = parseInt(ym.slice(5, 7))
                      return (
                        <Fragment key={`lh-${ym}`}>
                          <th style={{ width: 62, minWidth: 62, textAlign: 'center', padding: '10px 6px', fontSize: 11, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>{monthLabel(ym)}</th>
                          {showQuarters && monthNum % 3 === 0 && (
                            <th style={{ width: 56, minWidth: 56, textAlign: 'center', padding: '10px 2px', fontSize: 10, fontWeight: 800, color: RED, background: '#F0FDFA', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #99F6E4' }}>Q{Math.ceil(monthNum / 3)}</th>
                          )}
                        </Fragment>
                      )
                    })
                  ) : (
                    viewFws.map(fw => (
                      <th key={fw} style={{ width: 58, minWidth: 58, textAlign: 'center', padding: '10px 4px', fontSize: 10, color: '#6B7280', borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>{fw}</th>
                    ))
                  )}
                  <th style={{ width: 88, minWidth: 88, textAlign: 'center', padding: '10px 4px', fontSize: 11, color: RED, borderBottom: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {tipoRows.map((tipo, tipoIdx) => {
                  const isTipoOpen = expandedAreasTest.has(tipo.tipo)
                  const tipoActiveM = viewMode === 'mensal' ? Object.values(tipo.hoursByYearMonth).filter(h => h > 0).length : Object.values(tipo.hoursByFw).filter(h => h > 0).length
                  const tipoAvg = tipoActiveM > 0 ? tipo.total / tipoActiveM : 0
                  const tipoAvgDay = summaryTestData.businessDaysCount > 0 ? tipo.total / summaryTestData.businessDaysCount : 0
                  return (
                    <Fragment key={tipo.tipo}>
                      <tr onClick={() => setExpandedAreasTest(prev => { const n = new Set(prev); n.has(tipo.tipo) ? n.delete(tipo.tipo) : n.add(tipo.tipo); return n })} style={{ background: tipoIdx % 2 === 0 ? '#fff' : '#FCFCFD', cursor: 'pointer' }}>
                        <td style={{ padding: '10px 14px', borderBottom: '1px solid #EEF2F7' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <ChevronDown size={13} style={{ transform: isTipoOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s', color: '#9CA3AF', flexShrink: 0 }} />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: RED }}>{tipo.label}</div>
                              <div style={{ fontSize: 10, color: '#9CA3AF' }}>{tipo.models.length} modelos</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                          {tipoAvg > 0 ? (<><div style={{ fontSize: 11, fontWeight: 700, color: '#4B5563' }}>{fmtMain(tipoAvg)}</div>{<div style={{ fontSize: 9, color: '#A3AAB7' }}>{summaryMode === 'ue' ? formatSummaryValue(tipoAvgDay) : Math.round(tipoAvgDay)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>—</div>}
                        </td>
                        {viewMode === 'mensal' ? viewYms.map(ym => {
                          const h = tipo.hoursByYearMonth[ym] ?? 0
                          const days = summaryTestData.monthBusinessDays[ym] ?? 0
                          const monthNum = parseInt(ym.slice(5, 7))
                          const isQEnd = monthNum % 3 === 0
                          const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                          const qTotal = qKeys.reduce((s2, key) => s2 + (tipo.hoursByYearMonth[key] ?? 0), 0)
                          const qDays  = qKeys.reduce((s2, key) => s2 + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                          return (
                            <Fragment key={`${tipo.tipo}-${ym}`}>
                              <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: cellColor(h) }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpTipo.get(tipo.tipo), ym)} size={9} />}{cellVal(h)}</div>
                                {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                              </td>
                              {showQuarters && isQEnd && <td style={{ textAlign: 'center', padding: '6px 2px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #99F6E4', background: '#F0FDFA' }}><div style={{ fontSize: 11, fontWeight: 800, color: qTotal > 0 ? RED : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpTipo.get(tipo.tipo), qKeys)} size={9} />}{qTotal > 0 ? cellVal(qTotal) : '—'}</div>{qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}</td>}
                            </Fragment>
                          )
                        }) : viewFws.map(fw => {
                          const h = tipo.hoursByFw[fw] || 0
                          const days = summaryTestData.fwBusinessDays[fw] || 0
                          return <td key={fw} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}><div style={{ fontSize: 11, fontWeight: 700, color: cellColor(h) }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpTipo.get(tipo.tipo), fw)} size={9} />}{cellVal(h)}</div>{h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}</td>
                        })}
                        <td style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #EEF2F7', background: '#F0FDFA', borderLeft: '1px solid #CCFBF1' }}>
                          <div style={{ fontSize: 12, fontWeight: 800, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={tipo.total} compared={cmpTotal(cmpTipo.get(tipo.tipo)?.total)} />}{formatTotalValue(tipo.total)}</div>
                        </td>
                      </tr>

                      {isTipoOpen && tipo.models.map((mg, mgIdx) => {
                        const modelKey = `${tipo.tipo}||${mg.model}`
                        const isModelOpen = expandedPnsTest.has(modelKey)
                        const modelActiveM = viewMode === 'mensal' ? Object.values(mg.hoursByYearMonth).filter(h => h > 0).length : Object.values(mg.hoursByFw).filter(h => h > 0).length
                        const modelAvg = modelActiveM > 0 ? mg.totalHours / modelActiveM : 0
                        const modelAvgDay = summaryTestData.businessDaysCount > 0 ? mg.totalHours / summaryTestData.businessDaysCount : 0
                        return (
                          <Fragment key={modelKey}>
                            <tr onClick={() => setExpandedPnsTest(prev => { const n = new Set(prev); n.has(modelKey) ? n.delete(modelKey) : n.add(modelKey); return n })} style={{ background: mgIdx % 2 === 0 ? '#FAFBFC' : '#F4F6F8', cursor: 'pointer' }}>
                              <td style={{ padding: '7px 14px 7px 36px', borderBottom: '1px solid #EEF2F7' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <ChevronDown size={11} style={{ transform: isModelOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s', color: '#9CA3AF', flexShrink: 0 }} />
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#374151' }} title={mg.fallback ? 'Modelo resolvido via fallback (FB)' : undefined}>{mg.fallback ? `${mg.model} (FB)` : mg.model}</div>
                                    <div style={{ fontSize: 9, color: '#9CA3AF' }}>{mg.locos.length} {mg.locos.length === 1 ? 'loco' : 'locos'}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                {modelAvg > 0 ? (<><div style={{ fontSize: 10, fontWeight: 600, color: '#4B5563' }}>{fmtMain(modelAvg)}</div>{<div style={{ fontSize: 9, color: '#A3AAB7' }}>{summaryMode === 'ue' ? formatSummaryValue(modelAvgDay) : Math.round(modelAvgDay)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 10, fontWeight: 600, color: '#CBD5E1' }}>—</div>}
                              </td>
                              {viewMode === 'mensal' ? viewYms.map(ym => {
                                const h = mg.hoursByYearMonth[ym] ?? 0
                                const days = summaryTestData.monthBusinessDays[ym] ?? 0
                                const monthNum = parseInt(ym.slice(5, 7))
                                const isQEnd = monthNum % 3 === 0
                                const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                                const qTotal = qKeys.reduce((s2, key) => s2 + (mg.hoursByYearMonth[key] ?? 0), 0)
                                const qDays  = qKeys.reduce((s2, key) => s2 + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                                return (
                                  <Fragment key={`${modelKey}-${ym}`}>
                                    <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}>
                                      <div style={{ fontSize: 11, fontWeight: 700, color: cellColor(h) }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpModel.get(mg.model), ym)} size={9} />}{cellVal(h)}</div>
                                      {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                                    </td>
                                    {showQuarters && isQEnd && <td style={{ textAlign: 'center', padding: '4px 2px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1', background: '#F4F6F8' }}><div style={{ fontSize: 10, fontWeight: 700, color: qTotal > 0 ? '#374151' : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpModel.get(mg.model), qKeys)} size={9} />}{qTotal > 0 ? cellVal(qTotal) : '—'}</div>{qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}</td>}
                                  </Fragment>
                                )
                              }) : viewFws.map(fw => {
                                const h = mg.hoursByFw[fw] || 0
                                const days = summaryTestData.fwBusinessDays[fw] || 0
                                return <td key={fw} style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', borderLeft: '1px solid #CCFBF1' }}><div style={{ fontSize: 11, fontWeight: 700, color: cellColor(h) }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpModel.get(mg.model), fw)} size={9} />}{cellVal(h)}</div>{h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#A3AAB7' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}</td>
                              })}
                              <td style={{ textAlign: 'center', padding: '5px 4px', borderBottom: '1px solid #EEF2F7', background: '#F4F6F8', borderLeft: '1px solid #CCFBF1' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={mg.totalHours} compared={cmpTotal(cmpModel.get(mg.model)?.totalHours)} size={11} />}{formatTotalValue(mg.totalHours)}</div>
                              </td>
                            </tr>

                            {/* Editar LOCO is intentionally NOT available on the summary TABLE rows —
                                only on the LOCO summary cards below the table and directly on the Schedule. */}
                            {isModelOpen && mg.locos.map((lr, locoIdx) => (
                              <tr key={`${modelKey}-loco-${locoIdx}`} style={{ background: '#F0F4FF' }}>
                                <td style={{ padding: '5px 14px 5px 58px', borderBottom: '1px solid #E8ECF5' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: '#1D4ED8' }}>{lr.loco}</span>
                                    {(() => {
                                      const dl = displayedLoco(mg.model, lr.loco, lr.linha, lr.startMs, lr.takt)
                                      return (<>
                                        {dl.takt != null && <span style={{ fontSize: 9, fontWeight: 700, color: dl.edited ? '#1D4ED8' : RED, background: dl.edited ? '#E0EAFF' : '#F0FDFA', border: `1px solid ${dl.edited ? '#1D4ED8' : RED}`, borderRadius: 4, padding: '1px 5px' }} title={dl.edited ? 'Editado' : undefined}>T{dl.takt}</span>}
                                        {dl.startMs != null && dl.startMs.length >= 10 && <span style={{ fontSize: 9, color: dl.edited ? '#1D4ED8' : '#6B7280', fontWeight: dl.edited ? 700 : 400 }}>{dl.startMs.slice(8,10)}/{dl.startMs.slice(5,7)}/{dl.startMs.slice(0,4)}</span>}
                                      </>)
                                    })()}
                                  </div>
                                </td>
                                <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}>
                                  {(() => { const activeM = viewMode === 'mensal' ? Object.values(lr.hoursByYearMonth).filter(h => h > 0).length : Object.values(lr.hoursByFw).filter(h => h > 0).length; const avg = activeM > 0 ? lr.hours / activeM : 0; return avg > 0 ? <div style={{ fontSize: 10, fontWeight: 600, color: '#4B5563' }}>{fmtMain(avg)}</div> : <div style={{ fontSize: 10, color: '#CBD5E1' }}>—</div> })()}
                                </td>
                                {viewMode === 'mensal' ? viewYms.map(ym => {
                                  const h = lr.hoursByYearMonth[ym] ?? 0
                                  const monthNum = parseInt(ym.slice(5, 7))
                                  const isQEnd = monthNum % 3 === 0
                                  return (
                                    <Fragment key={`${modelKey}-loco${locoIdx}-${ym}`}>
                                      <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}>
                                        <div style={{ fontSize: 10, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpLoco.get(`${mg.model}||${lr.loco}||${String(lr.startMs ?? '')}`), ym)} size={9} />}{h > 0 ? cellVal(h) : '—'}</div>
                                      </td>
                                      {showQuarters && isQEnd && <td style={{ borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1', background: '#EEF2FF' }} />}
                                    </Fragment>
                                  )
                                }) : viewFws.map(fw => {
                                  const h = lr.hoursByFw[fw] || 0
                                  return <td key={fw} style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', borderLeft: '1px solid #CCFBF1' }}><div style={{ fontSize: 10, color: h > 0 ? '#4B5563' : '#CBD5E1' }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpLoco.get(`${mg.model}||${lr.loco}||${String(lr.startMs ?? '')}`), fw)} size={9} />}{h > 0 ? cellVal(h) : '—'}</div></td>
                                })}
                                <td style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #E8ECF5', background: '#EEF2FF', borderLeft: '1px solid #CCFBF1' }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, color: '#1D4ED8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={lr.hours} compared={cmpTotal(cmpLoco.get(`${mg.model}||${lr.loco}||${String(lr.startMs ?? '')}`)?.hours)} size={10} />}{formatTotalValue(lr.hours)}</div>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  )
                })}

                {/* Locos total row */}
                <tr style={{ background: '#CCFBF1' }}>
                  <td style={{ padding: '12px 14px', fontWeight: 800, color: RED, fontSize: 12, borderTop: '1px solid #CCFBF1' }}>TOTAL</td>
                  <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1' }}>
                    {(() => {
                      const activeM = viewMode === 'mensal' ? Object.values(locosGrandByYm).filter(h => h > 0).length : Object.values(locosGrandByFw).filter(h => h > 0).length
                      const avg = activeM > 0 ? locosGrandTotal / activeM : 0
                      const avgDay = summaryTestData.businessDaysCount > 0 ? locosGrandTotal / summaryTestData.businessDaysCount : 0
                      return avg > 0 ? (<><div style={{ fontSize: 12, fontWeight: 800, color: RED }}>{fmtMain(avg)}</div>{<div style={{ fontSize: 9, color: '#9CA3AF' }}>{summaryMode === 'ue' ? formatSummaryValue(avgDay) : Math.round(avgDay)} {perDayLabelLong}</div>}</>) : <div style={{ fontSize: 12, fontWeight: 800, color: '#CBD5E1' }}>—</div>
                    })()}
                  </td>
                  {viewMode === 'mensal' ? viewYms.map(ym => {
                    const h = locosGrandByYm[ym] ?? 0
                    const days = summaryTestData.monthBusinessDays[ym] ?? 0
                    const monthNum = parseInt(ym.slice(5, 7))
                    const isQEnd = monthNum % 3 === 0
                    const qKeys  = isQEnd ? [monthNum - 2, monthNum - 1, monthNum].map(m => `${ym.slice(0,5)}${String(m).padStart(2,'0')}`) : []
                    const qTotal = qKeys.reduce((s2, key) => s2 + (locosGrandByYm[key] ?? 0), 0)
                    const qDays  = qKeys.reduce((s2, key) => s2 + (summaryTestData.monthBusinessDays[key] ?? 0), 0)
                    return (
                      <Fragment key={`ltotal-${ym}`}>
                        <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1', boxShadow: limitLineShadow(ym) }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: RED }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpLocosGrand, ym)} size={9} />}{h > 0 ? cellVal(h) : '—'}</div>
                          {h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}
                        </td>
                        {showQuarters && isQEnd && <td style={{ textAlign: 'center', padding: '6px 2px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #99F6E4', background: '#CCFBF1' }}><div style={{ fontSize: 11, fontWeight: 900, color: qTotal > 0 ? RED : '#CBD5E1' }}>{showArrows && <CompareArrow current={qTotal} compared={cmpQuarter(cmpLocosGrand, qKeys)} size={9} />}{qTotal > 0 ? cellVal(qTotal) : '—'}</div>{qTotal > 0 && qDays > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(qTotal / qDays)} {perDayLabel}</div>}</td>}
                      </Fragment>
                    )
                  }) : viewFws.map(fw => {
                    const h = locosGrandByFw[fw] || 0
                    const days = summaryTestData.fwBusinessDays[fw] || 0
                    return <td key={fw} style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', borderLeft: '1px solid #CCFBF1', boxShadow: limitLineShadow(fw) }}><div style={{ fontSize: 11, fontWeight: 800, color: RED }}>{showArrows && <CompareArrow current={h} compared={cmpPeriod(cmpLocosGrand, fw)} size={9} />}{h > 0 ? cellVal(h) : '—'}</div>{h > 0 && days > 0 && <div style={{ fontSize: 9, color: '#9CA3AF' }}>{formatSummaryValue(h / days)} {perDayLabel}</div>}</td>
                  })}
                  <td style={{ textAlign: 'center', padding: '8px 4px', borderTop: '1px solid #CCFBF1', background: '#F9DCDC', borderLeft: '1px solid #CCFBF1' }}>
                    <div style={{ fontSize: 13, fontWeight: 900, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{showArrows && <CompareArrow current={locosGrandTotal} compared={cmpTotal(cmpLocosGrand?.total)} />}{formatTotalValue(locosGrandTotal)}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      })()}

      {/* ─── Locos por tipo geral (cards) ─── */}
      {rowMode === 'locos' && (() => {
        const toLabel = (iso: string) => iso && iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—'
        const TIPO_SECTIONS: { key: string; label: string }[] = [
          ...TIPOS.filter(t => t.hasLoco).map(t => ({ key: t.key as string, label: t.label })),
          { key: 'other',        label: 'Outros' },
        ]
        const groupedByTipo = TIPO_SECTIONS.map(s => ({
          ...s,
          groups: summaryTestData.modelGroups
            .map(mg => ({ ...mg, locos: mg.locos.filter(lr => (lr.tipoGeral || 'other') === s.key) }))
            .filter(mg => mg.locos.length > 0),
        })).filter(s => s.groups.length > 0)
        if (groupedByTipo.length === 0) return null
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groupedByTipo.map(section => (
              <div key={section.key}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, paddingLeft: 2 }}>{section.label}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {section.groups.map(mg => {
                    const cardKey = `${section.key}:${mg.model}`
                    const isOpen = expandedModels.has(cardKey)
                    const sectionHours = mg.locos.reduce((s, lr) => s + lr.hours, 0)
                    // Per-model conflict stat = how many of THIS model's LOCOs are in
                    // ≥1 conflict (same conflict source as the header/Schedule — a LOCO
                    // is "in conflict" iff it appears in a conflict pair). This is a
                    // per-model count of conflicting LOCOs, NOT a share of the pair total,
                    // so it deliberately does not sum to the global total (a cross-model
                    // pair makes a LOCO on each side count under its own model).
                    const modelConflicts = mg.locos.reduce((c, lr) => c + (conflictLocoNames.has(lr.loco) ? 1 : 0), 0)
                    // Per-model edited stat = how many of THIS model's LOCOs carry a manual
                    // visual override (the same LOCOs highlighted in blue in the card list).
                    const modelEdits = mg.locos.reduce((c, lr) => c + (displayedLoco(mg.model, lr.loco, lr.linha, lr.startMs, lr.takt).edited ? 1 : 0), 0)
                    return (
                      // `minWidth: 0` so opening a card can only add HEIGHT. Without it the item
                      // keeps the default `min-width: auto` and cannot go narrower than the
                      // min-content width of the panel that appears below — the loco rows with
                      // their non-shrinking takt/hours badges — so the card grew sideways on
                      // expand and shoved its neighbours onto another line. The name spans
                      // inside already ellipsize, so a narrower card cuts nothing off.
                      <div key={mg.model} style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 220, display: 'flex', flexDirection: 'column' }}>
                        <div
                          onClick={() => setExpandedModels(prev => { const n = new Set(prev); if (n.has(cardKey)) n.delete(cardKey); else n.add(cardKey); return n })}
                          style={{ borderRadius: isOpen ? '10px 10px 0 0' : 10, border: `1.5px solid ${isOpen ? RED : '#99F6E4'}`, background: isOpen ? '#F0FDFA' : '#F0FDFA', padding: '12px 14px', cursor: 'pointer', userSelect: 'none' }}
                        >
                          {/* Row 1: model name — ALWAYS a single line, ellipsized when too long (the
                              full name stays available via the title tooltip). Never wraps, so every
                              card header keeps the same height. */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                            <span title={mg.fallback ? `${mg.model} — modelo resolvido via fallback (FB)` : mg.model} style={{ fontSize: 12, fontWeight: 700, color: '#1E293B', lineHeight: 1.3, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mg.fallback ? `${mg.model} (FB)` : mg.model}</span>
                            <span style={{ fontSize: 10, color: '#94A3B8', whiteSpace: 'nowrap', flexShrink: 0 }}>{mg.locos.length} {mg.locos.length === 1 ? 'loco' : 'locos'}</span>
                            <ChevronDown size={11} style={{ color: isOpen ? RED : '#CBD5E1', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', flexShrink: 0, marginLeft: 4 }} />
                          </div>
                          {/* Row 2: total hours (left) + warning/edited counters (right, same line). */}
                          <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: RED, lineHeight: 1, whiteSpace: 'nowrap' }}>
                              {fmt(Math.round(sectionHours))}
                              <span style={{ fontSize: 11, fontWeight: 500, color: '#9CA3AF', marginLeft: 4 }}>h</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                              {modelConflicts > 0 && (
                                <span title={`${modelConflicts} loco(s) com conflito`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 800, color: RED, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  {modelConflicts}<ConflictIcon />
                                </span>
                              )}
                              {modelEdits > 0 && (
                                <span title={`${modelEdits} loco(s) com edição manual`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 800, color: '#1D4ED8', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  {modelEdits}<Pencil size={10} strokeWidth={2.5} />
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        {isOpen && (
                          <div style={{ border: `1.5px solid ${RED}`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
                            <div style={{ maxHeight: 5 * 52, overflowY: mg.locos.length > 5 ? 'auto' : 'hidden' }}>
                              {mg.locos.map((lr, locoIdx) => {
                                // Hidden from the Schedule by "Ocultar LOCOs concluídas": there is no
                                // row to navigate to, so the click is disabled (not-allowed cursor +
                                // EyeOff badge). Right-click edit stays available — it never navigates.
                                const hiddenInSchedule = hiddenScheduleLocos?.has(`${mg.model}||${lr.loco}||${String(lr.startMs ?? '')}`) ?? false
                                return (
                                <div
                                  key={`${lr.loco}||${String(lr.startMs ?? '')}`}
                                  onClick={(e) => { e.stopPropagation(); if (!hiddenInSchedule) handleLocoClick(lr.loco, lr.linha, mg.model, lr.startMs) }}
                                  onContextMenu={(e) => locoCtx(e, mg.model, lr.loco, lr.linha, lr.startMs, lr.takt)}
                                  title={hiddenInSchedule
                                    ? 'Oculta no Schedule ("Ocultar LOCOs concluídas" ativo) · clique direito para editar'
                                    : 'Clique para abrir no Schedule · clique direito para editar'}
                                  style={{ padding: '7px 10px', background: locoIdx % 2 === 0 ? '#fff' : '#F9FAFB', borderBottom: locoIdx < mg.locos.length - 1 ? '1px solid #EEF2F7' : undefined, cursor: hiddenInSchedule || !ganttBuiltRef.current ? 'not-allowed' : 'pointer', opacity: hiddenInSchedule ? 0.55 : undefined }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                    {hiddenInSchedule && (
                                      <EyeOff size={10} style={{ color: '#9CA3AF', flexShrink: 0 }} aria-label="Oculta no Schedule" />
                                    )}
                                    <span style={{ fontSize: 11, fontWeight: 600, color: '#1E293B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{lr.loco}</span>
                                    {(() => { const dl = displayedLoco(mg.model, lr.loco, lr.linha, lr.startMs, lr.takt, lr.finishMS); return dl.takt != null ? <span style={{ fontSize: 9, fontWeight: 700, color: dl.edited ? '#1D4ED8' : RED, background: dl.edited ? '#E0EAFF' : '#F0FDFA', border: `1px solid ${dl.edited ? '#1D4ED8' : RED}`, borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }} title={dl.edited ? 'Editado' : undefined}>T{dl.takt}</span> : null })()}
                                    <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: RED, borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmt(Math.round(lr.hours))} h</span>
                                  </div>
                                  {(() => {
                                    const dl = displayedLoco(mg.model, lr.loco, lr.linha, lr.startMs, lr.takt, lr.finishMS)
                                    const startLbl = dl.startMs && dl.startMs !== '' ? dl.startMs : lr.minISO
                                    return <div style={{ fontSize: 9, color: dl.edited ? '#1D4ED8' : '#94A3B8', marginTop: 3, fontWeight: dl.edited ? 600 : 400 }}>{toLabel(startLbl)}{dl.finishMs ? ` → ${toLabel(dl.finishMs)}` : ''}</div>
                                  })()}
                                </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      })()}

    </div>
  )
}
