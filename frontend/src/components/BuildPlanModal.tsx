'use client'
// ── Build Plan ───────────────────────────────────────────────────────────────────
// Opened from Plano de Produção's toolbar. Four tabs in the KitsModal idiom (same shell, same
// red header, same tab bar, same Filtros / Exibição controls, same footer):
//
//   Tab 1 "Build Plan"     — one row per locomotive, as dates on the left and as fiscal weeks
//                            on the right. Answers "when does this loco run, and when do its
//                            kit / start / finish fall".
//   Tab 2 "Kit's Plan"      — the Kits module's editable consumption log, MOVED here from the
//                            standalone Kits window. Rendered by that module (LogConsumoTab), so it
//                            arrives with its own Filtros (Linha / Modelo) and its own Exibição —
//                            Parâmetros button included — rather than this window's Tipo filter.
//   Tab 3 "Build Schedule" / "Kits Schedule" — ONE tab, two views, picked by a toggle in the footer
//                            (session-persisted; the tab renames itself to match). Both are the same
//                            shape of grid, so they share the tab space, the comparison split and the
//                            export button; the view decides which module owns the numbers and
//                            therefore which Filtros/Exibição are shown. Build Schedule is
//                            Envio/Recebimento: columns are fiscal months or weeks, rows are
//                            models (or locomotives), cells count how many locos START or
//                            FINISH there, and a frozen Total closes the row. In comparison mode,
//                            "Comparação" extends the SAME table downwards: the active scenario's
//                            counts first, a separator, then Δ = Target − Base — one table, one
//                            frozen header, one scroller, so the two halves can never fall out of
//                            step (they used to be two synced tables, which is why the sync code
//                            is gone).
//   Tab 4 "Análises Gráficas" — contractual adherence. Left panel: how many locos finish late,
//                            early, or have no contractual date at all, each card opening into the
//                            list behind its number. Right: ONE chart filling the panel, flipped
//                            between the per-period and the cumulative reading by clicking its own
//                            title — the same two series either way, so two frames side by side
//                            only halved each one.
//
// The Build tabs read the SAME rows through the SAME filters (Tipo / Modelo), held here rather than
// in either tab — switching tabs must never change which locomotives you are looking at. The two
// Kits surfaces likewise share ONE useKitsPlanning instance (plan, parameters, per-row Log edits and
// Linha/Modelo filters), so an edit in the Log is already in the Kits Schedule when you get there.
//
// Everything comes from the loaded Schedule (start_ms / finish_ms / takt). "Started in a
// period" means the loco's own start milestone falls in it — the day no workstation of it can
// begin before — and "finished" its finish milestone, so the two counts are milestone counts
// and never double-count a loco that spans periods.
//
// The kit week (Tab 1) comes from the same planner the Kits window uses (lib/kitsPlanning) at
// its DEFAULT parameters, so this view never invents a second kits model: only New Locos have
// kits at all, and a loco covered by existing stock has no shipment and shows "-".
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { X, Hammer, Download, Settings, ChevronDown, SlidersHorizontal, Boxes, ArrowLeftRight, AlertTriangle, Undo2, Package } from 'lucide-react'
import * as XLSX from 'xlsx'
import type { GanttData } from '@/lib/api'
import { TIPO_KEYS, TIPO_LABEL as REGISTRY_TIPO_LABEL } from '@/lib/tipos'
import { FilterBox } from './gantt/FilterBox'
import {
  locoTypeOf, fwToMonth445, isoFw445MonthKey, monthLabel, MONTH_NAMES_PT,
  RED_LT as FILTER_RED_LT, RED_DK as FILTER_RED_DK,
} from '@/lib/ganttUtils'
import {
  buildFwAxis, extractKitLocos, computeKitPlan, defaultModelParams, initialProtectionFor,
  KIT_DEFAULT_LEAD_TIME, type FwAxis, type KitModelParams, type KitRow,
} from '@/lib/kitsPlanning'
import { AnalysisLineChart, type LineSeries } from './gantt/AnalysisLineChart'
// The footer names its scenarios with the SAME swatch+name label Resumo Geral's footer uses (solid
// red = active, dashed gray = compared), imported rather than re-styled so the two cannot drift.
import { ScenarioLabel } from './gantt/GanttModalFooter'
import { COMPARE_LINE } from './gantt/SummaryAreaChart'
// The Kits module moved IN here: this window now hosts both of its surfaces — Log de Consumo as its
// own tab, and Schedule de Kits as the second view of the Build Schedule tab. All of the planning
// state, the plan, the filters, the Parâmetros editor and the exports come from the module itself
// (useKitsPlanning), so there is exactly one implementation of each.
import {
  useKitsPlanning, KitsParamsModal, LogConsumoTab, KitsFilterPanel,
  ExibicaoDropdown as KitsExibicao, KitsMultiRedSegment as KitsSegment,
  ExibGroup, ExibRule, ExibCheck,
  computeKitsGroupedFor, computeKitRowsFor, type ScheduleGroupedRow,
} from './KitsModal'

/** Tab 2's label follows the view its footer toggle selects — the tab IS the Build Schedule or the
 *  Kits Schedule, never both at once, so the bar has to say which one is open. */
type ScheduleView = 'build' | 'kits'
type TabIdx = 0 | 1 | 2 | 3
const SCHEDULE_VIEW_KEY = 'optv.buildPlan.scheduleView'

/** Fixed row geometry for Tab 1. The two tables there are independent <table>s, so nothing but
 *  equal heights keeps their rows on the same line — hence explicit heights on every row, group
 *  header included, and no wrapping content anywhere in either. */
const ROW_H   = 30
const GROUP_H = 26

/** Tab 2 column widths — same frozen-column idiom (and sizes) as Schedule Kits. */
const MODELO_W = 112
const LOCO_W   = MODELO_W
const INICIO_W = 86
const TOTAL_W  = 72
const GROUP_MODELO_W = MODELO_W + LOCO_W
/** Weekly columns are pinned (50+ of them can never fit, so that view scrolls). Monthly columns
 *  have NO fixed width on purpose — see `colW` in the component. */
const FW_COL_W = 58

const TIPO_LABEL: Record<string, string> = { ...REGISTRY_TIPO_LABEL, other: 'Outros' }
/** Reading order of the TIPO blocks — the same order Resumo Geral lists them in, which is
 *  the registry's own order, with the 'other' catch-all last. */
const TIPO_ORDER: string[] = [...TIPO_KEYS, 'other']

const DASH = '-'
/** Início chips are red (the loco entering the shop), Fim chips grey (leaving it) — the same
 *  two-tone logic Schedule Kits uses for Recebimento/Envio. */
const INICIO_C = '#D32F2F'
const FIM_C    = '#6B7280'

type ExibKey = 'inicio' | 'fim'
type ColMode = 'mensal' | 'semanal'

interface BuildRow {
  key:       string
  tipo:      string
  modelo:    string
  loco:      string
  startIso:  string
  finishIso: string
  /** Contratual — the contractual finish date (ISO), as imported. '' when the loco has none.
   *  Never an input to anything computed here: it is only compared against, never scheduled on. */
  contractIso: string
  /** The REAL end of the loco: its last painted day AFTER overrides and shifts, which is what
   *  Resumo Geral's loco summary reports as the finish (`finishMS` there). Deliberately not
   *  `finishIso`: `finish_ms` is the loaded milestone and the worker keeps it ORIGINAL through
   *  every edit (it is the loco's stable identity), so a moved loco would compare as unmoved. */
  realFinishIso: string
  /** CALENDAR days the locomotive occupies, INCLUSIVE of both ends (23/12 → 29/01 = 38).
   *  Calendar, not working, days — and, above all, not derived from the loaded window: it used to be
   *  counted by walking the loaded period's working days between the two dates, so a loco whose span
   *  reached past the loaded window reported only the slice inside it (ES440727: 23/12/26 → 29/01/27
   *  read "4 dias"), and one entirely outside reported nothing at all and rendered "-". */
  duration:  number | null
  takt:      number | null
  startFw:   string | null
  finishFw:  string | null
  /** 4-4-5 fiscal month of the start / finish milestone (Tab 2's "mensal" columns). */
  startMonth:  string | null
  finishMonth: string | null
  kitFw:     string | null
  /** New Locos only: kits do not exist for the other types, and "no kit" must not read the same
   *  as "this type has no kits". Both render as "-", but only this one is a real gap. */
  kitEligible: boolean
}

function fmtDate(iso: string): string {
  if (!iso) return DASH
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}/${m}/${y.slice(2)}` : DASH
}

/** "FW01/Jan" — the fiscal week plus the 4-4-5 fiscal month it belongs to (fwToMonth445, the
 *  same mapping the Schedule and the Kits window use, NOT the calendar month of its first day). */
function fmtFwMonth(fw: string | null): string {
  if (!fw) return DASH
  const num = fw.match(/(\d+)/)?.[1]
  if (!num) return fw
  const month = MONTH_NAMES_PT[fwToMonth445(fw) - 1] ?? ''
  const label = `FW${num.padStart(2, '0')}`
  return month ? `${label}/${month}` : label
}

function fwShort(fw: string): string {
  const num = fw.match(/(\d+)/)?.[1]
  return num ? `FW${num.padStart(2, '0')}` : fw
}

function fmtTakt(t: number | null): string {
  if (t == null || !isFinite(t) || t <= 0) return DASH
  return Number.isInteger(t) ? String(t) : t.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
}

/** HORIZONTE — (início − hoje) / 30, in months: how far AHEAD the loco starts. Positive for work
 *  still to come, negative for work already begun — the sign is the direction in time, so a loco
 *  that started eight months ago reads −8,3 and not +8,3. */
function horizonMonths(startIso: string, todayIso: string): number | null {
  if (!startIso) return null
  const a = Date.parse(`${startIso}T00:00:00Z`)
  const b = Date.parse(`${todayIso}T00:00:00Z`)
  if (!isFinite(a) || !isFinite(b)) return null
  return ((a - b) / 86_400_000) / 30
}
function fmtHorizon(m: number | null): string {
  if (m == null) return DASH
  return `${m.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} meses`
}

/** Calendar days between two ISO dates (b − a), or null when either is missing/unparseable.
 *  CALENDAR days, not working days: a contractual date is a promise on the calendar, so "3 days
 *  late" means three real days whatever the shop calendar says about them. */
function daysBetweenIso(a: string, b: string): number | null {
  if (!a || !b) return null
  const ta = Date.parse(`${a}T00:00:00Z`), tb = Date.parse(`${b}T00:00:00Z`)
  if (!isFinite(ta) || !isFinite(tb)) return null
  return Math.round((tb - ta) / 86_400_000)
}

// ── Análises Gráficas — contractual adherence ────────────────────────────────────
// Each loco's REAL end (its last painted day, after overrides and shifts — see BuildRow.realFinishIso)
// against its Contratual date. Positive delta = finished AFTER the contract = atrasada.
type AnalysisKind = 'atrasadas' | 'adiantadas' | 'sem'
interface AnalysisItem {
  key:       string
  modelo:    string
  loco:      string
  /** The real finish, i.e. what the expanded list shows under TÉRMINO. */
  finishIso: string
  /** Days vs the contractual date. Null only in the "sem data contratual" bucket. */
  delta:     number | null
}
/** Card colours: green ahead, red late, grey no contractual date. */
const ANALYSIS_COLOR: Record<AnalysisKind, string> = {
  atrasadas:  '#DC2626',
  adiantadas: '#16A34A',
  sem:        '#9CA3AF',
}
const ANALYSIS_TINT: Record<AnalysisKind, string> = {
  atrasadas:  '#FEF2F2',
  adiantadas: '#F0FDF4',
  sem:        '#F9FAFB',
}
const ANALYSIS_LABEL: Record<AnalysisKind, string> = {
  atrasadas:  'Locos Atrasadas',
  adiantadas: 'Locos Adiantadas',
  sem:        'Locos Sem Data Contratual',
}

/** One summary card. Collapsed it reads count + the average |delta| of its bucket; clicked it opens
 *  into the list behind that number (Modelo · Locomotiva · TÉRMINO · DELTA), which is the whole point
 *  of the panel — a number nobody can drill into is not an analysis.
 *
 *  ACCORDION: exactly one of the three is open at all times, so clicking a card only ever moves the
 *  open one — there is no "all closed" state, and the panel's height is always spent on a list. An
 *  empty bucket is therefore openable too (it says so in place of the table); refusing the click
 *  would leave the previous card open and make the header lie about which one is selected. */
function AnalysisCard({ kind, items, avgDays, open, onToggle }: {
  kind:    AnalysisKind
  items:   AnalysisItem[]
  /** Average days late / ahead (magnitude). Null for the "sem data" card, which has no delta. */
  avgDays: number | null
  open:    boolean
  onToggle: () => void
}) {
  const color = ANALYSIS_COLOR[kind]
  const fmtAvg = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return (
    <div style={{
      border: `1.5px solid ${open ? color : '#E5E7EB'}`, borderRadius: 10, background: '#fff',
      display: 'flex', flexDirection: 'column', minHeight: 0,
      // Only the open card competes for the panel's leftover height; the closed ones stay their
      // natural size, so opening one never squeezes the other two out of readability.
      flex: open ? '1 1 auto' : '0 0 auto', overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        title={items.length ? 'Ver as locomotivas' : 'Nenhuma locomotiva nesta categoria'}
        style={{
          all: 'unset', boxSizing: 'border-box', cursor: open ? 'default' : 'pointer',
          // ~15% roomier than the first pass: the longest label ("Locos Sem Data Contratual") and
          // the average line were both being clipped at the old size.
          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3,
          background: open ? ANALYSIS_TINT[kind] : '#fff', flexShrink: 0,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', letterSpacing: '0.03em', textTransform: 'uppercase', lineHeight: 1.35 }}>
            {ANALYSIS_LABEL[kind]}
          </span>
          <ChevronDown size={14} style={{ marginLeft: 'auto', color: open ? color : '#9CA3AF', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 28, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
            {items.length}
          </span>
          <span style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600 }}>
            loco{items.length !== 1 ? 's' : ''}
          </span>
        </span>
        {/* The collapsed metric: how late (or how early) they are on average. */}
        <span style={{ fontSize: 11, lineHeight: 1.35, color: avgDays == null ? '#C4C4C4' : '#6B7280', fontWeight: 600 }}>
          {avgDays == null
            ? 'sem delta a medir'
            : `média ${fmtAvg(avgDays)} dia${avgDays === 1 ? '' : 's'} ${kind === 'atrasadas' ? 'de atraso' : 'de adiantamento'}`}
        </span>
      </button>
      {open && items.length === 0 && (
        // The open card always fills the panel, so an empty bucket has to SAY it is empty — a blank
        // stretch of card would read as a rendering failure.
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: `1px solid ${color}33` }}>
          <span style={{ fontSize: 11, color: '#C4C4C4', fontWeight: 600, padding: '0 10px', textAlign: 'center' }}>
            Nenhuma locomotiva nesta categoria.
          </span>
        </div>
      )}
      {open && items.length > 0 && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${color}33` }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '27%' }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: '19%' }} />
            </colgroup>
            <thead>
              <tr>
                {['MODELO', 'LOCO', 'TÉRMINO', 'DELTA'].map((h, i) => (
                  <th key={h} title={h === 'TÉRMINO' ? 'Fim real da loco, já com os deslocamentos aplicados' : h === 'DELTA' ? 'Dias entre o fim real e a data contratual' : undefined}
                      style={{
                        position: 'sticky', top: 0, zIndex: 1, background: ANALYSIS_TINT[kind],
                        padding: '5px 6px', fontSize: 9, fontWeight: 700, color: '#6B7280',
                        textAlign: i < 2 ? 'left' : 'center', whiteSpace: 'nowrap',
                        borderBottom: `1px solid ${color}22`,
                      }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.key}>
                  <td title={it.modelo} style={{ padding: '4px 6px', fontSize: 10, color: '#6B7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderTop: '1px solid #F5F5F5' }}>
                    {it.modelo || DASH}
                  </td>
                  <td title={it.loco} style={{ padding: '4px 6px', fontSize: 10, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderTop: '1px solid #F5F5F5' }}>
                    {it.loco || DASH}
                  </td>
                  <td style={{ padding: '4px 6px', fontSize: 10, color: '#6B7280', textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid #F5F5F5' }}>
                    {fmtDate(it.finishIso)}
                  </td>
                  <td style={{ padding: '4px 6px', fontSize: 10, fontWeight: 800, color, textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid #F5F5F5' }}>
                    {it.delta == null ? DASH : `${it.delta > 0 ? '+' : ''}${it.delta}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Alternated as the MODELO changes inside a TIPO block, so a model's rows read as one bundle. A
 *  light red rather than a neutral grey: the tint has to be visible at a glance across a long table,
 *  and red is this window's own colour, so it reads as banding and not as a warning state. Both
 *  tables use the same sequence — line N is the same locomotive in both, so it gets the same tint. */
const MODEL_TINTS = ['#FFFFFF', '#FCEAEA'] as const

// ── Row extraction ───────────────────────────────────────────────────────────────
// One row per distinct LOCO instance of the loaded Schedule, whatever its type. Shared by both
// tabs so a locomotive's start/finish can never differ between them.
function buildBuildRows(data: GanttData): { rows: BuildRow[]; axis: FwAxis } {
  const axis = buildFwAxis(data)

  // Kit shipment week per LOCO, from the Kits planner at its defaults. Keyed exactly as
  // extractKitLocos keys its locos, so the join below cannot silently miss.
  const kitLocos = extractKitLocos(data, axis)
  const perModel: Record<string, KitModelParams> = {}
  for (const l of kitLocos) if (!perModel[l.model]) perModel[l.model] = defaultModelParams(l.model)
  const kitPlan = computeKitPlan(kitLocos, { perModel, leadTimeWeeks: KIT_DEFAULT_LEAD_TIME }, axis, {})
  const kitFwByKey = new Map<string, string | null>(
    kitPlan.rows.map(r => [r.key, r.needsReplenish ? (r.shipFw ?? (r.shipIso ? axis.isoToFw(r.shipIso) : null)) : null]),
  )

  const seen = new Set<string>()
  const rows: BuildRow[] = []
  for (const g of data.groups) {
    const key = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    // start_ms / finish_ms are the Schedule's own milestones. When one is missing, fall back to
    // the extreme painted cell (the same fallback extractKitLocos uses for start).
    let startIso = g.start_ms != null && g.start_ms !== '' ? String(g.start_ms).slice(0, 10) : ''
    let finishIso = g.finish_ms ? String(g.finish_ms).slice(0, 10) : ''
    // Extremes of the PAINTED cells. Always computed (not only as a fallback): the last painted day
    // is the loco's real end after overrides, which the Análises tab compares against Contratual.
    let min = '', max = ''
    for (const w of g.workstations)
      for (const dr of w.desc_rows)
        for (const iso of Object.keys(dr.cells)) {
          if (!min || iso < min) min = iso
          if (!max || iso > max) max = iso
        }
    if (!startIso)  startIso  = min
    if (!finishIso) finishIso = max

    const tipo = locoTypeOf(g.linha)
    const startFw  = startIso  ? axis.isoToFw(startIso)  : null
    const finishFw = finishIso ? axis.isoToFw(finishIso) : null
    rows.push({
      key, tipo,
      modelo: g.wo,
      loco:   g.task_name,
      startIso, finishIso,
      contractIso: g.contract_ms ? String(g.contract_ms).slice(0, 10) : '',
      realFinishIso: max || finishIso,
      // Real calendar span, both ends included. Null only when a date is missing or the finish
      // precedes the start — never because the span leaves the loaded period.
      duration: (() => {
        const d = daysBetweenIso(startIso, finishIso)
        return d == null || d < 0 ? null : d + 1
      })(),
      takt:     g.takt ?? null,
      startFw, finishFw,
      startMonth:  startFw  ? isoFw445MonthKey(startIso, startFw)   : null,
      finishMonth: finishFw ? isoFw445MonthKey(finishIso, finishFw) : null,
      kitFw:      kitFwByKey.get(key) ?? null,
      kitEligible: tipo === 'new_locos',
    })
  }
  return { rows, axis }
}

/** TIPO blocks, each sorted by INÍCIO ascending (loco name as tie-break, so the order is stable
 *  when several share a start date). */
function groupByTipo(rows: BuildRow[]): { tipo: string; rows: BuildRow[] }[] {
  const byTipo = new Map<string, BuildRow[]>()
  for (const r of rows) {
    let arr = byTipo.get(r.tipo)
    if (!arr) { arr = []; byTipo.set(r.tipo, arr) }
    arr.push(r)
  }
  for (const arr of byTipo.values()) {
    arr.sort((a, b) => (a.startIso || '9999').localeCompare(b.startIso || '9999') || a.loco.localeCompare(b.loco))
  }
  return TIPO_ORDER.filter(t => byTipo.has(t)).map(t => ({ tipo: t, rows: byTipo.get(t)! }))
}

/** The shared display filter. Module-scope so both scenarios are narrowed by the very same rule. */
const keep = (r: BuildRow, tipos: Set<string>, models: Set<string>) =>
  (tipos.size === 0 || tipos.has(r.tipo)) && (models.size === 0 || models.has(r.modelo))

// ── Tab 2 grid ───────────────────────────────────────────────────────────────────
/** One line of the Build Schedule grid: a MODELO (grouped) or a LOCO (ungrouped), its per-column
 *  counts and its total. Delta rows reuse the same shape with negative values allowed, and carry
 *  the two sides behind each difference for the tooltip. */
interface GridRow {
  key:      string
  /** Identity ACROSS scenarios. Deliberately not `key`: a loco's row key carries its start_ms, and
   *  a scenario that moved the loco would then never match its own counterpart. */
  matchKey: string
  modelo:   string
  loco:     string
  startIso: string
  counts:   Record<string, number>
  total:    number
  base?:        Record<string, number>
  target?:      Record<string, number>
  baseTotal?:   number
  targetTotal?: number
}
interface GridBlock { tipo: string; rows: GridRow[] }

/** Counts are per column and per Exibição side, so a row's Total is the count of the milestone
 *  actually on screen — never a sum of the two, which would count one loco twice.
 *
 *  A locomotive whose milestone falls outside the loaded window has no column key and is simply
 *  not counted, exactly as Schedule Kits plots no box for an out-of-window shipment. */
function buildGrid(
  groups: { tipo: string; rows: BuildRow[] }[],
  groupByModel: boolean, exib: ExibKey, colMode: ColMode,
): GridBlock[] {
  const keyOf = (r: BuildRow): string | null => (
    exib === 'inicio'
      ? (colMode === 'semanal' ? r.startFw  : r.startMonth)
      : (colMode === 'semanal' ? r.finishFw : r.finishMonth)
  )
  return groups.map(g => {
    if (!groupByModel) {
      return {
        tipo: g.tipo,
        rows: g.rows.map<GridRow>(r => {
          const k = keyOf(r)
          const counts: Record<string, number> = {}
          if (k) counts[k] = 1
          return {
            key: r.key, matchKey: `${g.tipo}||${r.modelo}||${r.loco}`,
            modelo: r.modelo, loco: r.loco, startIso: r.startIso,
            counts, total: k ? 1 : 0,
          }
        }),
      }
    }
    const byModel = new Map<string, GridRow>()
    for (const r of g.rows) {
      let m = byModel.get(r.modelo)
      if (!m) {
        m = { key: `${g.tipo}||${r.modelo}`, matchKey: `${g.tipo}||${r.modelo}`, modelo: r.modelo, loco: '', startIso: '', counts: {}, total: 0 }
        byModel.set(r.modelo, m)
      }
      const k = keyOf(r)
      if (k) { m.counts[k] = (m.counts[k] ?? 0) + 1; m.total++ }
    }
    return { tipo: g.tipo, rows: [...byModel.values()].sort((a, b) => a.modelo.localeCompare(b.modelo)) }
  })
}

/** Δ = Target − Base, cell by cell, over the UNION of rows: a model planned in only one of the two
 *  scenarios is the most interesting difference there is, so it appears with its whole count as the
 *  delta rather than being dropped for lack of a counterpart. Zero-delta rows stay too — "this model
 *  did not move" is an answer, and hiding it would make the reader wonder where it went. */
function deltaGrid(base: GridBlock[], target: GridBlock[]): GridBlock[] {
  const byTipo = new Map<string, Map<string, GridRow>>()
  const absorb = (blocks: GridBlock[], which: 'base' | 'target') => {
    for (const b of blocks) {
      let m = byTipo.get(b.tipo)
      if (!m) { m = new Map(); byTipo.set(b.tipo, m) }
      for (const r of b.rows) {
        let d = m.get(r.matchKey)
        if (!d) {
          d = {
            key: r.matchKey, matchKey: r.matchKey, modelo: r.modelo, loco: r.loco, startIso: r.startIso,
            counts: {}, total: 0, base: {}, target: {}, baseTotal: 0, targetTotal: 0,
          }
          m.set(r.matchKey, d)
        }
        const bucket = which === 'base' ? d.base! : d.target!
        for (const [k, v] of Object.entries(r.counts)) bucket[k] = (bucket[k] ?? 0) + v
        if (which === 'base') d.baseTotal! += r.total
        else                  d.targetTotal! += r.total
      }
    }
  }
  absorb(base, 'base')
  absorb(target, 'target')

  const out: GridBlock[] = []
  for (const tipo of TIPO_ORDER) {
    const m = byTipo.get(tipo)
    if (!m) continue
    const rows: GridRow[] = []
    for (const d of m.values()) {
      const counts: Record<string, number> = {}
      for (const k of new Set([...Object.keys(d.base!), ...Object.keys(d.target!)])) {
        const delta = (d.target![k] ?? 0) - (d.base![k] ?? 0)
        if (delta !== 0) counts[k] = delta
      }
      rows.push({ ...d, counts, total: d.targetTotal! - d.baseTotal! })
    }
    rows.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.loco.localeCompare(b.loco))
    out.push({ tipo, rows })
  }
  return out
}

/** Kits, expressed as this window's own grid rows — which is what makes the Kits Schedule and the
 *  Build Schedule LOOK identical instead of merely similar: they are the same table, the same frozen
 *  columns, the same month band, the same Mensal/Semanal columns and the same totals row, differing
 *  only in what the numbers count. `keyOfFw` maps a kit's fiscal week onto the active column key, so
 *  Mensal aggregates the weeks of a fiscal month exactly as the locos grid does.
 *
 *  `matchKey` is the MODEL, which is what makes the Δ across scenarios line up (a model is the same
 *  model in both; a kit row has no other cross-scenario identity). */
function kitsGroupedToBlocks(
  grouped: ScheduleGroupedRow[], side: 'ship' | 'receipt', keyOfFw: (fw: string) => string,
): GridBlock[] {
  const rows = grouped.map<GridRow>(g => {
    const counts: Record<string, number> = {}
    let total = 0
    for (const [fw, ev] of Object.entries(g.eventsByFw)) {
      const n = side === 'ship' ? ev.ship : ev.receipt
      if (!n) continue
      const k = keyOfFw(fw)
      if (!k) continue
      counts[k] = (counts[k] ?? 0) + n
      total += n
    }
    return { key: g.key, matchKey: g.model, modelo: g.model, loco: '', startIso: '', counts, total }
  })
  return rows.length ? [{ tipo: 'new_locos', rows }] : []
}

// ── Análises Gráficas · chart series colours ────────────────────────────────────────────
/** Series names, shared by BOTH charts (legend and hover bubble alike). "Kits em Fluxo" is the whole
 *  label: spelling out "enviados + em trânsito + recebidos não consumidos" is the definition, not a
 *  name, and it does not fit a legend beside three other series. The definition lives in the comment
 *  on `kitsInFlowAt`. */
const LABEL_LOCOS = 'Locos iniciadas'
const LABEL_KITS  = 'Kits em Fluxo'
/** The compared scenario's two lines. GENERIC, not "<series> · <scenario name>": the scenario names
 *  are already spelled out (with the same solid/dashed swatches) in the footer two rows below, and a
 *  saved scenario name is long enough to push the four legend entries onto three lines and to blow
 *  the hover bubble's width out past the frame. "Comparação" is what the dashed line means. */
const LABEL_LOCOS_CMP = 'Locos Comparação'
const LABEL_KITS_CMP  = 'Kits Comparação'

/** Kits, active scenario — the SAME grey the Envio chips carry in the Kits Schedule (FIM_C), not a
 *  green of its own. The two-tone rule is meant to hold across the whole window: red is the loco side
 *  (Início / Recebimento / locos started) and grey the kit side (Fim / Envio / kits in flow), so a
 *  reader carries one colour key from the header to the table to the chart. A third hue here made
 *  "Kits em Fluxo" look like a third quantity rather than the grey column's own curve.
 *
 *  It sits beside the compared-locos line (COMPARE_LINE, #4B5563) in comparison mode, which is also
 *  grey — but that one is DASHED and darker, the same solid/dashed split that already separates the
 *  active red line from its comparison. */
const KITS_LINE = FIM_C
/** Kits, compared scenario. Orange was the first suggestion; PURPLE reads better here: the chart
 *  already carries red (locos) and green (kits), and orange sits between them on the hue wheel, so
 *  at a 1.5px dashed stroke it reads as a washed-out red on a light background — exactly the line it
 *  must not be confused with. Purple is far from all three (and from the gray dashed locos line),
 *  and it is already this app's fourth accent (the optimizer's), so no new colour is invented. */
const KITS_COMPARE_LINE = '#7B1FA2'

/** Kits available to the pool at the END of a period, per model and then summed:
 *
 *      Inicial + shipped on or before it − consumed on or before it
 *
 *  The three states a kit passes through in that window — Enviado, Em Trânsito, Recebido-mas-não-
 *  consumido — are all "shipped and not yet consumed", so the measure never double-counts a kit that
 *  changed state mid-period.
 *
 *  INICIAL is part of it. It used to count shipments only, which made a pool that opens with stock on
 *  the shelf start the chart at zero and only climb once its FIRST replenishment shipped — a model
 *  with Inicial 3 read as 0 kits standing by while three physically sat there. Those opening kits are
 *  also why some LOCOs pull in no shipment at all (`needsReplenish` false, covered by stock): counting
 *  only shipments hid the stock AND the consumption it covers, so both halves are now counted.
 *
 *  Per model, floored at 0: pools do not share stock (see kitModel), and a receipt is allowed to land
 *  after the consumption it is tied to, so one pool's momentary negative must not eat another's stock.
 *  `initialOf` resolves the opening quantity for a model — `initialProtectionFor`, the planner's own. */
function kitsInFlowAt(rows: KitRow[], endIso: string, initialOf: (model: string) => number): number {
  if (!endIso) return 0
  const byModel = new Map<string, number>()
  for (const r of rows) {
    let n = byModel.get(r.model)
    if (n === undefined) { n = initialOf(r.model); byModel.set(r.model, n) }
    const consume = r.startIso ? String(r.startIso).slice(0, 10) : null
    if (consume && consume <= endIso) n -= 1
    if (r.needsReplenish && r.qty > 0) {
      const ship = r.shipIso ? String(r.shipIso).slice(0, 10) : null
      if (ship && ship <= endIso) n += r.qty
    }
    byModel.set(r.model, n)
  }
  let total = 0
  for (const n of byModel.values()) total += Math.max(0, n)
  return total
}

/** Δ chips. Green for an increase, red for a decrease — a direction, not a verdict: more locos
 *  finishing may be good and more starting may not, which is why the header says Δ = Target − Base
 *  in words instead of leaving the colour to be read as praise. */
const DELTA_UP   = '#16A34A'
const DELTA_DOWN = '#DC2626'

// ── Filtros — the same chip+reveal panel as KitsModal's, with Tipo where Kits has Linha ──────
// Pure display filter, shared by both tabs: selections narrow which already-computed rows are
// rendered (and exported), never how anything is computed.
function BuildFilterPanel({
  allTipos, selTipos, allModels, selModels, onToggleTipo, onToggleModel, onClear, RED,
}: {
  allTipos: string[]
  selTipos: Set<string>
  allModels: string[]
  selModels: Set<string>
  onToggleTipo: (v: string) => void
  onToggleModel: (v: string) => void
  onClear: () => void
  RED: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const hasAny = selTipos.size > 0 || selModels.size > 0
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])
  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        title={open ? 'Recolher filtros' : 'Expandir filtros'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          borderRadius: 8, border: `1.5px solid ${hasAny || open ? RED : '#D1D5DB'}`,
          background: hasAny || open ? FILTER_RED_LT : '#F9FAFB', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, color: hasAny || open ? RED : '#374151',
          whiteSpace: 'nowrap', flexShrink: 0,
        }}
      >
        <SlidersHorizontal size={13} style={{ color: hasAny || open ? RED : '#6B7280' }} />
        Filtros
        {hasAny && (
          <span style={{
            marginLeft: 2, background: RED, color: '#fff', borderRadius: 10,
            fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5,
          }}>{selTipos.size + selModels.size}</span>
        )}
      </button>
      {/* Anchored to the button's RIGHT edge, so the panel hangs inwards. Anchored left it grew
          past the modal's right edge and was cut off by the window's `overflow: hidden` — this
          button sits at the end of the toolbar, so there is never room to its right. The width
          comes from the FilterBoxes, so it is also capped and allowed to wrap. */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50,
          background: '#fff', border: `1px solid ${RED}33`, borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '8px 10px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          maxWidth: 'min(420px, 80vw)',
        }}>
          {/* Each FilterBox carries its own label, so no external label is rendered. */}
          <FilterBox
            icon={<Boxes size={13} />} label="Modelo"
            items={allModels} selected={selModels} onToggle={onToggleModel} formatItem={v => v}
          />
          <FilterBox
            icon={<Boxes size={13} />} label="Tipo"
            items={allTipos} selected={selTipos} onToggle={onToggleTipo}
            formatItem={v => TIPO_LABEL[v] ?? v}
          />
          {hasAny && (
            <button
              onClick={onClear}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 11, color: FILTER_RED_DK, fontWeight: 600, background: 'none',
                border: 'none', cursor: 'pointer', padding: '2px 4px',
              }}
            >
              <X size={11} /> Limpar filtros
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Exibição — Schedule Kits' dropdown, with Início/Fim where it has Envio/Chegada, plus the
 *  month/week column toggle and "Agrupar por modelo". No Parâmetros section: this view computes
 *  nothing that could be parameterised. */
function BuildExibicao({
  RED, exib, onPickExib, showExib = true, colMode, onPickColMode,
  groupByModel, onToggleGroupByModel, showGroupByModel = true,
  compareAvailable, compare, onToggleCompare,
}: {
  RED: string
  exib: ExibKey
  onPickExib: (k: ExibKey) => void
  /** Início/Fim belongs to the Build Schedule grid alone — it is the only view whose columns count
   *  one milestone or the other. Build Plan shows both dates side by side and Análises Gráficas
   *  measures the real finish against the contract, so offering the switch there implied it changed
   *  something. The `exib` state itself stays shared; only this control is hidden. */
  showExib?: boolean
  colMode: ColMode
  onPickColMode: (m: ColMode) => void
  groupByModel: boolean
  onToggleGroupByModel: () => void
  /** "Agrupar por modelo" only steers the Build Schedule grid's ROWS (one line per MODELO or per
   *  LOCO). The Build Plan tab always lists one line per locomotive and Análises Gráficas counts
   *  locomotives into buckets, so neither has rows for it to group — offering it there implied it
   *  changed something. The state stays shared; only this control is hidden. */
  showGroupByModel?: boolean
  /** Only offered in comparison mode, where a second scenario actually exists to subtract. */
  compareAvailable: boolean
  compare: boolean
  onToggleCompare: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} title="Configurações de visualização" style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderRadius: 8, border: `1.5px solid ${open ? RED : '#D1D5DB'}`,
        background: open ? '#FFF4F4' : '#F9FAFB', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, color: open ? RED : '#374151', whiteSpace: 'nowrap',
      }}>
        <Settings size={13} style={{ color: open ? RED : '#6B7280' }} />
        Exibição
        <ChevronDown size={12} style={{ color: open ? RED : '#9CA3AF', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50,
          background: '#fff', border: `1px solid ${RED}33`, borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 230, padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {/* Group: Marco — which milestone the columns count. Only where it steers something. */}
          {showExib && (
            <>
              <ExibGroup label="Marco">
                {/* The SAME segmented control the Kits Exibição uses (imported, not restyled to match),
                    so the two dropdowns of this window cannot drift apart. It takes a Set because the
                    Kits Envio/Chegada choice is expressed as one; here the choice is a scalar, wrapped. */}
                <KitsSegment
                  options={[{ key: 'inicio' as ExibKey, label: 'Início', color: RED }, { key: 'fim' as ExibKey, label: 'Fim', color: RED }]}
                  value={new Set([exib])} onToggle={onPickExib}
                />
              </ExibGroup>
              <ExibRule />
            </>
          )}
          {/* Group: Período — the column granularity. */}
          <ExibGroup label="Período">
            <KitsSegment
              options={[{ key: 'mensal' as ColMode, label: 'Mensal', color: RED }, { key: 'semanal' as ColMode, label: 'Semanal', color: RED }]}
              value={new Set([colMode])} onToggle={onPickColMode}
            />
          </ExibGroup>
          {/* Group: Agrupamento — Build Schedule only (see showGroupByModel). */}
          {showGroupByModel && (
            <>
              <ExibRule />
              <ExibGroup label="Agrupamento">
                <ExibCheck RED={RED} on={groupByModel} onClick={onToggleGroupByModel} label="Agrupar por modelo" />
              </ExibGroup>
            </>
          )}
          {compareAvailable && (
            <>
              <ExibRule />
              <ExibGroup label="Cenários">
                <ExibCheck
                  RED={RED} on={compare} onClick={onToggleCompare} label="Comparação"
                  title="Divide a aba: o schedule do cenário ativo acima, a diferença entre os dois cenários abaixo"
                />
              </ExibGroup>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function BuildPlanModal({
  data, otherData = null, planData = null, otherPlanData = null, RED, onClose,
  comparisonMode = false, comparisonActive = 'base', comparisonBaseName, comparisonTargetName,
  scenarioName, onSwitchScenario,
}: {
  data: GanttData
  /** The COMPARED scenario, already windowed identically to `data` (GanttModal's
   *  comparisonOtherEffective). Present only in comparison mode; it is what the Δ table subtracts.
   *  Note it carries no session overrides — those belong to the active scenario alone — so the Δ is
   *  "the other scenario as saved" against "this one as it stands". */
  otherData?: GanttData | null
  /** `data` WITHOUT the period window (the line filter is still applied) — the demand the KIT PLAN is
   *  computed against, while everything drawn still comes from `data`. The kit planner's Min floor is
   *  horizon-aware, so planning on the window alone made every pool run itself to zero at the window's
   *  end; see `useKitsPlanning`. Optional: absent, the plan falls back to the window, which is the
   *  previous behaviour. Only the kits surfaces read it — the Build Plan / Build Schedule tabs are
   *  about the loaded period by definition and stay on `data`. */
  planData?: GanttData | null
  /** The same, for `otherData`. */
  otherPlanData?: GanttData | null
  RED: string
  onClose: () => void
  /** Comparison mode only: the footer names BOTH scenarios (from the two names below) and carries the
   *  switch, so both scenarios' build plans can be read without leaving this window. There is no
   *  separate `scenarioName`: in comparison mode it is always one of these two, and a third source for
   *  the same string is a third thing to keep in step. */
  comparisonMode?: boolean
  /** Which side `data` is — and therefore which name the footer draws in solid red. The Δ is always
   *  Target − Base, whichever of the two is on screen, so switching re-orients the subtraction
   *  (see `deltaBlocks`) without changing its sign convention. */
  comparisonActive?: 'base' | 'target'
  comparisonBaseName?: string
  comparisonTargetName?: string
  /** The ACTIVE scenario's name outside comparison mode — the footer names it there too, so the
   *  reader is never left guessing whose build plan is on screen just because there is only one.
   *  Undefined when no scenario is loaded at all (the base data), which has no name to print.
   *  Ignored in comparison mode, where the two names above are the authority. */
  scenarioName?: string
  onSwitchScenario?: () => void
}) {
  const [activeTab, setActiveTab] = useState<TabIdx>(0)
  // Which of the two schedules tab 2 shows. Session-scoped (sessionStorage, not localStorage): it is
  // a working preference for the sitting, not a setting — reopening the app should start from the
  // Build Schedule again.
  const [scheduleView, setScheduleView] = useState<ScheduleView>(() => {
    if (typeof window === 'undefined') return 'build'
    return sessionStorage.getItem(SCHEDULE_VIEW_KEY) === 'kits' ? 'kits' : 'build'
  })
  const pickScheduleView = (v: ScheduleView) => {
    setScheduleView(v)
    try { sessionStorage.setItem(SCHEDULE_VIEW_KEY, v) } catch { /* private mode: the choice just doesn't persist */ }
  }
  // ── The Kits module, hosted here ────────────────────────────────────────────────────
  // One instance for the whole window: the Log tab and the Kits Schedule view are two readings of
  // the SAME plan, so an edit in the Log (or a parameter change) must be visible in the schedule
  // immediately, and neither surface may hold its own copy of the filters.
  const kits = useKitsPlanning(data, planData)
  /** Kits exist for New Locos only (extractKitLocos ignores every other Tipo), so with none loaded
   *  there is no kit plan to show: the toggle is disabled AND a 'kits' choice left over from earlier
   *  in the session is ignored, rather than opening an empty grid. */
  const kitsAvailable = kits.modelKeys.length > 0
  const kitsView = scheduleView === 'kits' && kitsAvailable
  const TABS = ['Build Plan', "Kit's Plan", kitsView ? 'Kits Schedule' : 'Build Schedule', 'Análises Gráficas'] as const

  // Shared by BOTH tabs — see the file header.
  const [selTipos,  setSelTipos]  = useState<Set<string>>(new Set())
  const [selModels, setSelModels] = useState<Set<string>>(new Set())
  const [exib,      setExib]      = useState<ExibKey>('inicio')
  const [colMode,   setColMode]   = useState<ColMode>('mensal')
  const [groupByModel, setGroupByModel] = useState(true)
  /** ON by default. Opening this window from a loaded comparison and finding the Δ section switched
   *  off meant every reader's first action was to open Exibição and turn it on; the checkbox is only
   *  rendered when a second scenario exists at all, so with no comparison loaded this flag steers
   *  nothing. Turning it off is still one click. */
  const [compare,   setCompare]   = useState(true)
  /** Análises Gráficas: the ONE chart's reading — per period, or the running total of the same
   *  timeline. A display toggle over the very same series (see `analysisCharts`), flipped by clicking
   *  the chart's title, not a second chart. */
  const [chartCumulative, setChartCumulative] = useState(false)
  /** Tab 3: which summary card is expanded. ALWAYS exactly one (accordion): two open lists would
   *  leave neither readable in a panel this narrow, and none open would waste the height it was
   *  given. Opens on "atrasadas" — the bucket the panel exists to surface. */
  const [openCard, setOpenCard] = useState<AnalysisKind>('atrasadas')

  const { rows: allRows, axis } = useMemo(() => buildBuildRows(data), [data])
  /** The compared scenario's rows, built by the same extractor so nothing can differ but the data.
   *  Only in comparison mode, and only worth the work while the Δ table is on screen. */
  const compareAvailable = comparisonMode && !!otherData
  const baseLabel   = comparisonBaseName   || 'Base'
  const targetLabel = comparisonTargetName || 'Target'
  // Also built for the Análises tab, whose chart plots the compared scenario as dashed lines — there
  // the comparison is the point of the chart, not an opt-in split, so it does not wait for the
  // "Comparação" checkbox the Build Schedule Δ is gated on.
  const otherAllRows = useMemo(
    () => (compareAvailable && (compare || activeTab === 3) && otherData ? buildBuildRows(otherData).rows : null),
    [compareAvailable, compare, activeTab, otherData],
  )

  const availableTipos = useMemo(
    () => TIPO_ORDER.filter(t => allRows.some(r => r.tipo === t)),
    [allRows],
  )
  const availableModels = useMemo(
    () => [...new Set(allRows.map(r => r.modelo).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [allRows],
  )

  const rows = useMemo(
    () => allRows.filter(r => keep(r, selTipos, selModels)),
    [allRows, selTipos, selModels],
  )
  /** The compared scenario under the SAME filters — a Δ computed on two different row sets would be
   *  meaningless. The filter OPTIONS still come from the active scenario, which is the one on screen. */
  const otherRows = useMemo(
    () => otherAllRows?.filter(r => keep(r, selTipos, selModels)) ?? null,
    [otherAllRows, selTipos, selModels],
  )

  // ── Tab 3 buckets — contractual adherence over the FILTERED rows, so the panel always answers
  // for the same locomotives the other two tabs are showing.
  //   atrasada  = real finish AFTER the contractual date  (delta > 0)
  //   adiantada = real finish ON or BEFORE it             (delta ≤ 0 — a loco finished exactly on
  //               the contractual day is not late, and counts as 0 days ahead)
  //   sem data  = no contractual date at all (and, in principle, a loco with no measurable end —
  //               a group only exists here when it has painted cells, so that case cannot occur)
  const analysis = useMemo(() => {
    const late: AnalysisItem[] = [], early: AnalysisItem[] = [], none: AnalysisItem[] = []
    for (const r of rows) {
      const delta = r.contractIso ? daysBetweenIso(r.contractIso, r.realFinishIso) : null
      const item: AnalysisItem = { key: r.key, modelo: r.modelo, loco: r.loco, finishIso: r.realFinishIso, delta }
      if (delta == null) none.push(item)
      else if (delta > 0) late.push(item)
      else early.push(item)
    }
    // Worst first in each list — the reason to open the card is the extremes, not the alphabet.
    late.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.loco.localeCompare(b.loco))
    early.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || a.loco.localeCompare(b.loco))
    none.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.loco.localeCompare(b.loco))
    const avgAbs = (arr: AnalysisItem[]) =>
      arr.length ? arr.reduce((s, i) => s + Math.abs(i.delta ?? 0), 0) / arr.length : null
    return { late, early, none, avgLate: avgAbs(late), avgEarly: avgAbs(early) }
  }, [rows])

  const tipoGroups = useMemo(() => groupByTipo(rows), [rows])
  const otherTipoGroups = useMemo(() => (otherRows ? groupByTipo(otherRows) : null), [otherRows])

  /** Today, in the user's own calendar day (not UTC — a late-evening local date must not read as
   *  tomorrow's horizon). Fixed per mount, which is what a window like this wants. */
  const todayIso = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  /** Row background per MODELO run. Rows are ordered by start date, so one model can appear in
   *  several runs; the tint alternates per RUN, which is exactly what makes two adjacent models
   *  distinguishable (the goal) rather than colouring by model identity. */
  const tintByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of tipoGroups) {
      let idx = 0
      let prev: string | null = null
      for (const r of g.rows) {
        if (prev !== null && r.modelo !== prev) idx = (idx + 1) % MODEL_TINTS.length
        prev = r.modelo
        m.set(r.key, MODEL_TINTS[idx])
      }
    }
    return m
  }, [tipoGroups])

  const toggleIn = (set: (fn: (p: Set<string>) => Set<string>) => void) => (v: string) =>
    set(prev => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n })
  const clearFilters = () => { setSelTipos(new Set()); setSelModels(new Set()) }

  // ── Tab 2 columns: fiscal weeks, or the 4-4-5 fiscal months they belong to ──────────────
  // Weekly keeps the two-level header (month band over week columns) Schedule Kits uses; monthly
  // collapses to one column per fiscal month, and the band disappears with it.
  // `endIso` is the last loaded day of the column — what a cumulative measure (kits still in the
  // pipeline at the end of the period) has to be evaluated at. Derived from the axis rather than from
  // calendar arithmetic, so it is always a day the Schedule actually loaded.
  const columns = useMemo(() => {
    if (colMode === 'semanal') {
      return axis.order.map(fw => ({
        key: fw,
        label: fwShort(fw),
        month: isoFw445MonthKey(axis.firstIso[fw] ?? '', fw),
        endIso: axis.lastIso[fw] ?? axis.firstIso[fw] ?? '',
      }))
    }
    const seen: string[] = []
    const endByYm: Record<string, string> = {}
    for (const fw of axis.order) {
      const ym = isoFw445MonthKey(axis.firstIso[fw] ?? '', fw)
      if (!ym) continue
      if (!seen.includes(ym)) seen.push(ym)
      const end = axis.lastIso[fw] ?? axis.firstIso[fw] ?? ''
      if (end && (!endByYm[ym] || end > endByYm[ym])) endByYm[ym] = end
    }
    return seen.map(ym => ({ key: ym, label: monthLabel(ym), month: ym, endIso: endByYm[ym] ?? '' }))
  }, [colMode, axis])

  /** Month band over the weekly columns — contiguous weeks of one fiscal month collapse into a
   *  spanning header. Null in monthly mode, where the columns ARE the months. */
  const monthSpans = useMemo(() => {
    if (colMode !== 'semanal') return null
    const bands: { label: string; span: number }[] = []
    for (const c of columns) {
      const label = c.month ? monthLabel(c.month) : '—'
      const last = bands[bands.length - 1]
      if (last && last.label === label) last.span++
      else bands.push({ label, span: 1 })
    }
    return bands
  }, [colMode, columns])

  /** Tab 2 body: TIPO blocks, each holding either one row per MODELO (grouped) or one per LOCO. */
  const gridBlocks = useMemo(
    () => buildGrid(tipoGroups, groupByModel, exib, colMode),
    [tipoGroups, groupByModel, exib, colMode],
  )
  /** The Δ table's body — measured AGAINST THE SCENARIO ON SCREEN: Base is always the active
   *  scenario (the counts above the separator), Target always the compared one. Switching the active
   *  scenario therefore swaps the two sides of the subtraction and every Δ flips sign, which is the
   *  whole point of the switch — it re-references the comparison.
   *
   *  It used to orient the subtraction by `comparisonActive` instead (Base − Target by NAME). That
   *  looks like the more principled convention, but `data` and `otherData` swap at the same moment
   *  `comparisonActive` does, so the two swaps cancelled: the Δ column came out byte-identical
   *  before and after the switch and the button appeared to do nothing to this table. */
  const deltaBlocks = useMemo(() => {
    if (!compare || !otherTipoGroups) return null
    const other = buildGrid(otherTipoGroups, groupByModel, exib, colMode)
    return deltaGrid(gridBlocks, other)   // Base = on screen, Target = the compared scenario
  }, [compare, otherTipoGroups, gridBlocks, groupByModel, exib, colMode])

  // ── Kits, through this window's grid ────────────────────────────────────────────────
  // Which side is plotted (Envio or Recebimento — the Kits Exibição is mutually exclusive), and how a
  // kit's fiscal WEEK lands on the active column: itself in Semanal, its 4-4-5 fiscal month in Mensal.
  // The month mapping is `isoFw445MonthKey`, the same function the loco columns are built from, so the
  // two schedules can never disagree about where a period starts.
  const kitsSide: 'ship' | 'receipt' = kits.exibSet.has('envio') ? 'ship' : 'receipt'
  const kitsKeyOfFw = useMemo(() => {
    const firstIso = kits.axis.firstIso
    return (fw: string) => (colMode === 'semanal' ? fw : (isoFw445MonthKey(firstIso[fw] ?? '', fw) || ''))
  }, [colMode, kits.axis])

  const kitsBlocks = useMemo<GridBlock[]>(() => {
    if (!kitsView) return []
    if (kits.groupByModel) return kitsGroupedToBlocks(kits.groupedScheduleRows, kitsSide, kitsKeyOfFw)
    // Ungrouped: one row per LOCO, its single shipment (or receipt) counted in the period it falls in.
    const rows = kits.filteredRows.map<GridRow>(r => {
      const fw = kitsSide === 'ship' ? r.shipFw : r.receiptFw
      const counts: Record<string, number> = {}
      let total = 0
      if (fw && r.qty > 0) {
        const k = kitsKeyOfFw(fw)
        if (k) { counts[k] = r.qty; total = r.qty }
      }
      return {
        key: r.key, matchKey: `${r.model}||${r.loco}`,
        modelo: r.model, loco: r.loco, startIso: r.startIso ?? '', counts, total,
      }
    })
    return rows.length ? [{ tipo: 'new_locos', rows }] : []
  }, [kitsView, kits.groupByModel, kits.groupedScheduleRows, kits.filteredRows, kitsSide, kitsKeyOfFw])

  /** The compared scenario's kit ROWS (not the grouped schedule): the flow metric needs each kit's
   *  own ship and consumption dates, which grouping throws away. Same parameters and filters as the
   *  active scenario, no session row edits — the comparison is "the other scenario as planned". */
  const otherKitRows = useMemo(() => {
    if (activeTab !== 3 || !compareAvailable || !kitsAvailable || !otherData) return null
    const { rows, plannedRows } = computeKitRowsFor(
      otherData, kits.params, kits.initialOverride, kits.selLines, kits.selModels, otherPlanData,
    )
    return { rows, plannedRows }
  }, [activeTab, compareAvailable, kitsAvailable, otherData, otherPlanData, kits.params, kits.initialOverride, kits.selLines, kits.selModels])

  /** Name of the scenario the dashed lines belong to — the side that is NOT on screen. It is also
   *  the Δ's TARGET: the subtraction is referenced to whatever is on screen (see `deltaBlocks`). */
  const otherScenarioLabel  = comparisonActive === 'base' ? targetLabel : baseLabel
  /** …and the one whose counts the table above the separator holds, i.e. the Δ's BASE. */
  const activeScenarioLabel = comparisonActive === 'base' ? baseLabel : targetLabel

  /** How the shared grid reads when it is counting kits. The palette is the locos grid's own — the
   *  active side takes red, the other grey — so Envio/Recebimento sit in the same two tones as
   *  Início/Fim rather than introducing a third. */
  const kitsGridOpts = {
    unit: 'kit',
    sideLabel: kitsSide === 'ship' ? 'envio' : 'recebimento',
    chipColor: kitsSide === 'ship' ? FIM_C : INICIO_C,
    // Total in the frozen-column grey, not the side's accent — it is an identity column, and it must
    // NOT flip red when the Exibição switches to Recebimento while the header above it stays grey.
    totalColor: FIM_C,
    emptyText: 'Nenhuma LOCO New Locos no período carregado.',
    grouped: kits.groupByModel,
  }

  /** The Kits Δ table's body: the compared scenario's kit schedule under the same parameters and the
   *  same Linha/Modelo filters, subtracted through the SAME `deltaGrid` the locos table uses and with
   *  the SAME reference — Base = the scenario on screen, Target = the compared one, so switching the
   *  active scenario flips every sign here too (see `deltaBlocks`). Per MODEL, always: a Δ per LOCO is
   *  one kit changing week, which the model rows already show. Computed only while the Kits view is
   *  open AND Comparação is on — planning a second scenario's kits is real work. */
  const kitsDeltaBlocks = useMemo(() => {
    if (!kitsView || !compare || !compareAvailable || !otherData) return null
    const mine = kitsGroupedToBlocks(kits.groupedScheduleRows, kitsSide, kitsKeyOfFw)
    const other = kitsGroupedToBlocks(
      computeKitsGroupedFor(otherData, kits.params, kits.initialOverride, kits.selLines, kits.selModels, otherPlanData),
      kitsSide, kitsKeyOfFw,
    )
    return deltaGrid(mine, other)   // Base = on screen, Target = the compared scenario
  }, [kitsView, compare, compareAvailable, otherData, otherPlanData, kitsSide, kitsKeyOfFw,
      kits.params, kits.initialOverride, kits.selLines, kits.selModels, kits.groupedScheduleRows])

  // ── Análises Gráficas · charts 1 & 2 ────────────────────────────────────────────────
  // Two readings of the SAME two quantities, at the granularity the Exibição's Mensal/Semanal picks,
  // built together so the pair can never disagree about a period:
  //
  //   Chart 1 — PER PERIOD:
  //     • locos STARTED in the period (their own start milestone falls in it) — always the START, not
  //       the Exibição's Início/Fim: the chart answers "how much work opens" against "how much kit
  //       stock is standing by for it";
  //     • kits IN FLOW at the end of the period = shipped and not yet consumed, which is exactly
  //       Enviado + Em Trânsito + Recebido-não-consumido (see `kitsInFlowAt`).
  //
  //   Chart 2 — CUMULATIVE (running total of the same timeline):
  //     • locos: the running sum of the same starts, i.e. how many have opened up to that period;
  //     • kits: the running sum of SHIPMENTS, not of the in-flow line above. "In flow" is a LEVEL
  //       (a stock at a moment), and accumulating a level counts the same kit once per period it
  //       sits in the pipeline — a number that only ever grows and answers nothing. Its cumulative
  //       counterpart is the flow that FEEDS it: kits entering the pipeline. That is also what makes
  //       the two red/green curves comparable here — "kits supplied so far" against "locos started
  //       so far" is the supply-vs-demand reading a cumulative chart is for.
  //
  // In comparison mode both quantities are drawn again for the other scenario, dashed, in both charts.
  const analysisCharts = useMemo(() => {
    if (activeTab !== 3 || columns.length === 0) return null
    const startKeyOf = (r: BuildRow) => (colMode === 'semanal' ? r.startFw : r.startMonth)
    const startsOf = (rs: BuildRow[]) => {
      const per: Record<string, number> = {}
      for (const r of rs) {
        const k = startKeyOf(r)
        if (k) per[k] = (per[k] ?? 0) + 1
      }
      return columns.map(c => per[c.key] ?? 0)
    }
    // The opening stock a pool holds, straight from the planner's own resolver so the chart and the
    // Kits Schedule can never disagree about what "Inicial" is for a model.
    const initialOf = (model: string) => initialProtectionFor(model, kits.params, kits.initialOverride)
    const flowOf = (rs: KitRow[]) => columns.map(c => kitsInFlowAt(rs, c.endIso, initialOf))
    /** Kits ENTERING the pipeline per period — the same Envio the Kits Schedule plots, mapped onto the
     *  active columns by the same `kitsKeyOfFw` (a null shipFw means the shipment falls outside the
     *  loaded window, so it is plotted nowhere, exactly as in that grid). */
    const shippedOf = (rs: KitRow[]) => {
      const per: Record<string, number> = {}
      for (const r of rs) {
        if (!r.needsReplenish || r.qty <= 0 || !r.shipFw) continue
        const k = kitsKeyOfFw(r.shipFw)
        if (k) per[k] = (per[k] ?? 0) + r.qty
      }
      return columns.map(c => per[c.key] ?? 0)
    }
    const running = (vals: number[]) => {
      let acc = 0
      return vals.map(v => (acc += v))
    }

    const locoStarts = startsOf(rows)
    const otherStarts = compareAvailable && otherRows ? startsOf(otherRows) : null

    // ONE label per line, shared by both charts: the two are the same four series read two ways, and
    // an "(acum.)" suffix on the second legend would say what its own title already says while making
    // the pair look like eight different things. What each chart shows lives in its TITLE.
    const perPeriod: LineSeries[] = [
      { key: 'locos', label: LABEL_LOCOS, color: RED, dashed: false, values: locoStarts },
    ]
    const cumulative: LineSeries[] = [
      { key: 'locos', label: LABEL_LOCOS, color: RED, dashed: false, values: running(locoStarts) },
    ]
    // No kits line at all without New Locos: kits exist for that Tipo only, so a flat zero would be a
    // statement about stock rather than the absence of the concept.
    if (kitsAvailable) {
      // `plannedRows`, not `filteredRows`: in flow is a LEVEL, so it is read off each pool's whole
      // history — the visible rows alone would re-credit an opening stock already spent before the
      // window. `shippedOf` below stays on the visible rows: that one is a per-period COUNT of
      // shipments, and a shipment outside the loaded columns is plotted nowhere by design.
      perPeriod.push({ key: 'kits', label: LABEL_KITS, color: KITS_LINE, dashed: false, values: flowOf(kits.plannedRows) })
      cumulative.push({ key: 'kits', label: LABEL_KITS, color: KITS_LINE, dashed: false, values: running(shippedOf(kits.filteredRows)) })
    }
    if (otherStarts) {
      perPeriod.push({ key: 'locos-cmp', label: LABEL_LOCOS_CMP, color: COMPARE_LINE, dashed: true, values: otherStarts })
      cumulative.push({ key: 'locos-cmp', label: LABEL_LOCOS_CMP, color: COMPARE_LINE, dashed: true, values: running(otherStarts) })
      if (kitsAvailable && otherKitRows) {
        perPeriod.push({ key: 'kits-cmp', label: LABEL_KITS_CMP, color: KITS_COMPARE_LINE, dashed: true, values: flowOf(otherKitRows.plannedRows) })
        cumulative.push({ key: 'kits-cmp', label: LABEL_KITS_CMP, color: KITS_COMPARE_LINE, dashed: true, values: running(shippedOf(otherKitRows.rows)) })
      }
    }
    return { labels: columns.map(c => c.label), perPeriod, cumulative }
  }, [activeTab, columns, colMode, rows, kitsAvailable, kits.filteredRows, kits.plannedRows,
      kits.params, kits.initialOverride, compareAvailable, otherRows, otherKitRows, kitsKeyOfFw, RED])

  // Lock body scroll while open (KitsModal does the same).
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  function exportBuildPlan() {
    const header = ['TIPO', 'MODELO', 'LOCOMOTIVA', 'INICIO', 'FIM', 'CONTRATUAL', 'HORIZONTE (meses)', 'DURACAO (dias corridos)', 'TAKT', 'KITS', 'START', 'FGI']
    const aoa: (string | number)[][] = [header]
    for (const g of tipoGroups) {
      for (const r of g.rows) {
        const hz = horizonMonths(r.startIso, todayIso)
        aoa.push([
          TIPO_LABEL[g.tipo] ?? g.tipo, r.modelo, r.loco,
          fmtDate(r.startIso), fmtDate(r.finishIso), fmtDate(r.contractIso),
          // Numbers, not the formatted labels: the units are in the headers, so the sheet stays
          // sortable and computable.
          hz == null ? DASH : Math.round(hz * 10) / 10,
          r.duration ?? DASH, fmtTakt(r.takt),
          fmtFwMonth(r.kitFw), fmtFwMonth(r.startFw), fmtFwMonth(r.finishFw),
        ])
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 17 }, { wch: 14 }, { wch: 7 }, { wch: 11 }, { wch: 11 }, { wch: 11 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Build Plan')
    XLSX.writeFile(wb, 'Build_Plan.xlsx')
  }

  function exportBuildSchedule() {
    const side = exib === 'inicio' ? 'Inicio' : 'Fim'
    const head = groupByModel
      ? ['TIPO', 'MODELO', `TOTAL (${side})`, ...columns.map(c => c.label)]
      : ['TIPO', 'MODELO', 'LOCOMOTIVA', 'INICIO', `TOTAL (${side})`, ...columns.map(c => c.label)]
    const aoa: (string | number)[][] = [head]
    for (const b of gridBlocks) {
      for (const r of b.rows) {
        const cells = columns.map(c => r.counts[c.key] ?? '')
        aoa.push(groupByModel
          ? [TIPO_LABEL[b.tipo] ?? b.tipo, r.modelo, r.total, ...cells]
          : [TIPO_LABEL[b.tipo] ?? b.tipo, r.modelo, r.loco, fmtDate(r.startIso), r.total, ...cells])
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Build Schedule')
    XLSX.writeFile(wb, 'Build_Schedule.xlsx')
  }

  // ── Shared cell styles ──────────────────────────────────────────────────────────
  const th: React.CSSProperties = {
    padding: '8px 6px', fontSize: 10, fontWeight: 700, color: '#6B7280',
    background: '#FFF1F1', borderBottom: '1px solid #F2CACA',
    whiteSpace: 'nowrap', textAlign: 'left', position: 'sticky', top: 0, zIndex: 1,
  }
  const td: React.CSSProperties = {
    padding: '0 6px', height: ROW_H, fontSize: 11, color: '#374151',
    borderTop: '1px solid #F5F5F5', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis',
  }
  const num: React.CSSProperties = { ...td, fontVariantNumeric: 'tabular-nums' }
  /** Centred variants — every measure column (dates, horizon, duration, takt, and the right
   *  table's three FW columns) uses these for BOTH the header and the body, so a column's
   *  heading always sits over its own values. */
  const thC:  React.CSSProperties = { ...th, textAlign: 'center' }
  const numC: React.CSSProperties = { ...num, textAlign: 'center' }
  const stickyHead: React.CSSProperties = {
    position: 'sticky', zIndex: 3, padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#6B7280',
    textAlign: 'center', background: '#FFF1F1',
    borderBottom: '1px solid #F2CACA', boxShadow: 'inset -1px 0 0 #F2CACA',
  }

  /** Tab 1's TIPO separator, repeated in BOTH tables so the two stay row-for-row aligned. Only
   *  the left one carries the label — the right table's copy is a spacer of identical height. */
  const planGroupRow = (tipo: string, count: number, cols: number, withLabel: boolean) => (
    <tr key={`g-${tipo}`}>
      <td colSpan={cols} style={{
        height: GROUP_H, padding: '0 8px', background: '#F9FAFB',
        borderTop: '1px solid #E5E7EB', borderBottom: '1px solid #E5E7EB',
        fontSize: 10, fontWeight: 800, color: withLabel ? '#6B7280' : 'transparent',
        letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}>
        {withLabel ? `${TIPO_LABEL[tipo] ?? tipo} · ${count}` : '·'}
      </td>
    </tr>
  )

  // Column sizing. Semanal pins every week to FW_COL_W and scrolls — 50+ weeks cannot fit and
  // squeezing them would make the chips unreadable. Mensal must NOT scroll: the table is stretched
  // to 100% and the month columns get no explicit width, so `table-layout: fixed` divides the
  // leftover (everything the frozen columns don't take) evenly between them. `undefined` here is
  // what makes that happen — a fixed MONTH_COL_W is exactly what forced the scrollbar before.
  const weekly = colMode === 'semanal'
  const colW = weekly ? FW_COL_W : undefined

  /** The Build Schedule grid — ONE table, one scroller, one frozen header. With Comparação on, the Δ
   *  section is appended to the SAME table below a separator instead of being a second table: the
   *  columns, the widths and the frozen identity columns are then the same objects rather than two
   *  copies kept in step by mirroring two scroll positions (which is what this used to do, and what
   *  the `pane`/sync machinery here existed for).
   *
   *  `deltaOf` is the Δ section, or null for the plain view. */
  const renderGrid = (
    blocks: GridBlock[], deltaOf: GridBlock[] | null,
    /** What the cells count. Defaults describe the locos grid; the Kits view overrides them so the
     *  SAME table can be read as kits without a second implementation of it. */
    opts?: {
      unit?: string; sideLabel?: string; chipColor?: string; emptyText?: string; grouped?: boolean
      /** Ink for the frozen Total column (row totals + the grand total). Defaults to the chip colour,
       *  which is what the locos grid wants. The Kits view passes neutral grey: Total is a frozen
       *  IDENTITY column like Modelo / Locomotiva / Início, all of which are grey, and painting it in
       *  the side's accent made the one summary column the loudest thing in a table whose accent is
       *  supposed to mean "a kit moves in this period". The Δ section keeps its own signed colours. */
      totalColor?: string
    },
  ) => {
  // Which identity columns are frozen: one Modelo column when rows ARE models, Modelo+Locomotiva+
  // Inicio when they are locomotives. Per CALL, not per window — the Kits view groups on its own
  // Exibição setting, independently of the locos grid.
  const grouped = opts?.grouped ?? groupByModel
  const frozenCols = grouped ? 2 : 4
  const frozenW = grouped ? GROUP_MODELO_W + TOTAL_W : MODELO_W + LOCO_W + INICIO_W + TOTAL_W
  const unit = opts?.unit ?? 'loco'
  const sideLabel = opts?.sideLabel ?? (exib === 'inicio' ? 'início' : 'fim')
  const baseChip = opts?.chipColor ?? (exib === 'inicio' ? INICIO_C : FIM_C)
  const totalInk = opts?.totalColor ?? baseChip
  const emptyText = opts?.emptyText ?? 'Nenhuma locomotiva com os filtros ativos.'
  const plural = (n: number) => `${n} ${unit}${n !== 1 ? 's' : ''}`

  // Column totals — the counterpart of the frozen Total column: that one closes a row, this one
  // closes a column. Summed over the SAME blocks being rendered (so filters apply), from the rows'
  // own counts rather than recounting the locos, which is what keeps the two totals consistent by
  // construction. In the Δ section it is the sum of the deltas, i.e. Target − Base for that column.
  const totalsOf = (bs: GridBlock[]) => {
    const colTotals: Record<string, number> = {}
    let grandTotal = 0
    for (const b of bs) {
      for (const r of b.rows) {
        for (const [k, v] of Object.entries(r.counts)) colTotals[k] = (colTotals[k] ?? 0) + v
        grandTotal += r.total
      }
    }
    return { colTotals, grandTotal }
  }

  /** One section of the table: a TIPO band and the lines under it. `kind` decides only how the
   *  numbers are coloured and worded — the geometry is the table's, so both sections sit under the
   *  one frozen header by construction. */
  const sectionRows = (bs: GridBlock[], kind: 'count' | 'delta') => bs.map(b => (
    <Fragment key={`${kind}-${b.tipo}`}>
      {/* TIPO band. The label sits in a sticky cell so it stays readable while
          the columns scroll; the band itself spans the whole row. */}
      <tr>
        <td colSpan={frozenCols} style={{
          position: 'sticky', left: 0, zIndex: 2, background: '#F9FAFB',
          width: frozenW, minWidth: frozenW,
          height: GROUP_H, padding: '0 10px',
          borderTop: '1px solid #E5E7EB', borderBottom: '1px solid #E5E7EB',
          fontSize: 10, fontWeight: 800, color: '#6B7280',
          letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
          boxShadow: 'inset -1px 0 0 #F2CACA',
        }}>
          {TIPO_LABEL[b.tipo] ?? b.tipo}
        </td>
        <td colSpan={columns.length} style={{
          background: '#F9FAFB', height: GROUP_H,
          borderTop: '1px solid #E5E7EB', borderBottom: '1px solid #E5E7EB',
        }} />
      </tr>
      {b.rows.map((r, ri) => {
        const bg = ri % 2 === 0 ? '#fff' : '#FAFAFA'
        const stickyCell: React.CSSProperties = {
          position: 'sticky', zIndex: 2, background: bg,
          padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap',
          borderTop: '1px solid #F5F5F5',
          overflow: 'hidden', textOverflow: 'ellipsis', boxShadow: 'inset -1px 0 0 #F2CACA',
        }
        const totalColor = kind === 'delta'
          ? (r.total > 0 ? DELTA_UP : r.total < 0 ? DELTA_DOWN : '#9CA3AF')
          : (r.total > 0 ? totalInk : '#9CA3AF')
        return (
          <tr key={r.key}>
            <td style={{ ...stickyCell, left: 0, maxWidth: grouped ? GROUP_MODELO_W : MODELO_W, fontWeight: 700, color: RED }} title={r.modelo}>
              {r.modelo || DASH}
            </td>
            {!grouped && (
              <td style={{ ...stickyCell, left: MODELO_W, maxWidth: LOCO_W, fontWeight: 600, color: '#374151' }} title={r.loco}>
                {r.loco}
              </td>
            )}
            {!grouped && (
              <td style={{ ...stickyCell, left: MODELO_W + LOCO_W, width: INICIO_W, minWidth: INICIO_W, textAlign: 'center', fontSize: 10, color: '#6B7280' }}>
                {r.startIso ? fmtDate(r.startIso) : DASH}
              </td>
            )}
            <td
              style={{
                ...stickyCell, left: grouped ? GROUP_MODELO_W : MODELO_W + LOCO_W + INICIO_W,
                width: TOTAL_W, minWidth: TOTAL_W, textAlign: 'center',
                fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: totalColor,
              }}
              title={kind === 'delta'
                ? `Target ${r.targetTotal ?? 0} − Base ${r.baseTotal ?? 0} = ${r.total > 0 ? '+' : ''}${r.total}`
                : `${plural(r.total)} · ${sideLabel}`}
            >
              {kind === 'delta'
                ? (r.total === 0 ? DASH : `${r.total > 0 ? '+' : ''}${r.total}`)
                : (r.total || DASH)}
            </td>
            {columns.map((c, ci) => {
              const n = r.counts[c.key] ?? 0
              const chipColor = kind === 'delta'
                ? (n > 0 ? DELTA_UP : DELTA_DOWN)
                : baseChip
              return (
                <td key={c.key} style={{
                  width: colW, minWidth: colW, padding: 3, textAlign: 'center',
                  borderTop: '1px solid #F5F5F5',
                  borderLeft: ci === 0 ? undefined : '1px solid #F5F5F5',
                  background: bg,
                }}>
                  {n !== 0 && (
                    <div
                      title={kind === 'delta'
                        ? `${c.label} · Target ${r.target?.[c.key] ?? 0} − Base ${r.base?.[c.key] ?? 0} = ${n > 0 ? '+' : ''}${n}`
                        : `${c.label} · ${plural(n)} · ${sideLabel}`}
                      style={{
                        height: 16, borderRadius: 4,
                        background: chipColor, border: `1px solid ${chipColor}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: 8.5, fontWeight: 700, lineHeight: 1,
                        overflow: 'hidden',
                      }}
                    >
                      {/* The QUANTITY only, in both granularities — the unit is already on
                          the tooltip and in the column header's meaning, and "3 locos" in a
                          58px week box was two thirds word and one third data. */}
                      {kind === 'delta' ? `${n > 0 ? '+' : ''}${n}` : n}
                    </div>
                  )}
                </td>
              )
            })}
          </tr>
        )
      })}
    </Fragment>
  ))

  /** A section's totals line. `sticky` pins it to the BOTTOM of the scroller, like the head is to the
   *  top: a total that scrolls out of sight on a long grid is a total nobody reads. Only the LAST
   *  section gets it — the counts section's own total travels with its rows, closing them right above
   *  the separator, which is where a reader looks for it. The frozen cells stay sticky on the left
   *  either way (corner cell = the grand total). */
  const totalsLine = (bs: GridBlock[], kind: 'count' | 'delta', sticky: boolean) => {
    const { colTotals, grandTotal } = totalsOf(bs)
    return (
      <tr>
        <td
          colSpan={frozenCols - 1}
          style={{
            position: 'sticky', left: 0, ...(sticky ? { bottom: 0 } : null), zIndex: sticky ? 4 : 2,
            background: '#FFF1F1',
            width: frozenW - TOTAL_W, minWidth: frozenW - TOTAL_W,
            height: GROUP_H, padding: '0 10px', fontSize: 10, fontWeight: 800, color: '#6B7280',
            letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
            borderTop: '1px solid #F2CACA',
          }}
        >
          {kind === 'delta' ? 'Δ ' : ''}Total {colMode === 'semanal' ? 'por semana' : 'por mês'}
        </td>
        <td
          title={kind === 'delta'
            ? 'Diferença total do período (Target − Base)'
            : `Total de ${unit}s com ${sideLabel} no período carregado`}
          style={{
            position: 'sticky', left: grouped ? GROUP_MODELO_W : MODELO_W + LOCO_W + INICIO_W,
            ...(sticky ? { bottom: 0 } : null), zIndex: sticky ? 4 : 2, background: '#FFF1F1',
            width: TOTAL_W, minWidth: TOTAL_W, height: GROUP_H, textAlign: 'center',
            fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
            color: kind === 'delta'
              ? (grandTotal > 0 ? DELTA_UP : grandTotal < 0 ? DELTA_DOWN : '#9CA3AF')
              : (opts?.totalColor ?? RED),
            borderTop: '1px solid #F2CACA', boxShadow: 'inset -1px 0 0 #F2CACA',
          }}
        >
          {kind === 'delta'
            ? (grandTotal === 0 ? DASH : `${grandTotal > 0 ? '+' : ''}${grandTotal}`)
            : (grandTotal || DASH)}
        </td>
        {columns.map((c, ci) => {
          const n = colTotals[c.key] ?? 0
          return (
            <td
              key={c.key}
              title={kind === 'delta'
                ? `${c.label} · Δ total ${n > 0 ? '+' : ''}${n}`
                : `${c.label} · ${plural(n)}`}
              style={{
                ...(sticky ? { position: 'sticky', bottom: 0, zIndex: 3 } : null), background: '#FFF1F1',
                width: colW, minWidth: colW, height: GROUP_H, textAlign: 'center',
                fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                color: n === 0
                  ? '#C4C4C4'
                  : kind === 'delta'
                    ? (n > 0 ? DELTA_UP : DELTA_DOWN)
                    : baseChip,
                borderTop: '1px solid #F2CACA',
                borderLeft: ci === 0 ? undefined : '1px solid #F2CACA',
              }}
            >
              {n === 0 ? DASH : kind === 'delta' ? `${n > 0 ? '+' : ''}${n}` : n}
            </td>
          )
        })}
      </tr>
    )
  }

  return (
    <div
      style={{
        border: '1px solid #E5E7EB', borderRadius: 10, background: '#fff', flex: 1, minHeight: 0,
        // Mensal fits by construction, so only the vertical axis may scroll; semanal keeps
        // both (its week columns are pinned to a readable width and will overflow).
        overflowX: weekly ? 'auto' : 'hidden', overflowY: 'auto',
      }}
    >
      {blocks.length === 0 || columns.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
          {emptyText}
        </div>
      ) : (
        <table style={{
          borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed',
          ...(weekly ? null : { width: '100%' }),
        }}>
          {/* Explicit widths so the merged month headers (colSpan) can't distort the
              per-column sizing under table-layout:fixed — keeps header and body aligned. */}
          <colgroup>
            <col style={{ width: grouped ? GROUP_MODELO_W : MODELO_W }} />
            {!grouped && <col style={{ width: LOCO_W }} />}
            {!grouped && <col style={{ width: INICIO_W }} />}
            <col style={{ width: TOTAL_W }} />
            {columns.map(c => <col key={c.key} style={{ width: colW }} />)}
          </colgroup>
          <thead>
            <tr style={{ background: '#FFF1F1' }}>
              <th rowSpan={monthSpans ? 2 : 1} style={{ ...stickyHead, left: 0, width: grouped ? GROUP_MODELO_W : MODELO_W, minWidth: grouped ? GROUP_MODELO_W : MODELO_W }}>
                Modelo
              </th>
              {!grouped && (
                <th rowSpan={monthSpans ? 2 : 1} style={{ ...stickyHead, left: MODELO_W, width: LOCO_W, minWidth: LOCO_W }}>
                  Locomotiva
                </th>
              )}
              {!grouped && (
                <th rowSpan={monthSpans ? 2 : 1} style={{ ...stickyHead, left: MODELO_W + LOCO_W, width: INICIO_W, minWidth: INICIO_W }}>
                  Inicio
                </th>
              )}
              {/* Frozen Total. The ONE header of the table, so it is worded for the counts section it
                  sits over; below the separator the same column holds that row's Δ, which the
                  separator says and every cell there spells out with a sign. */}
              <th
                rowSpan={monthSpans ? 2 : 1}
                title={deltaOf
                  ? `Total de ${unit}s com ${sideLabel} no período carregado — e, abaixo do separador, o Δ (Target − Base)`
                  : `Total de ${unit}s com ${sideLabel} no período carregado`}
                style={{ ...stickyHead, left: grouped ? GROUP_MODELO_W : MODELO_W + LOCO_W + INICIO_W, width: TOTAL_W, minWidth: TOTAL_W }}
              >
                Total
              </th>
              {monthSpans
                ? monthSpans.map((ms, mi) => (
                    <th key={`${ms.label}-${mi}`} colSpan={ms.span} style={{
                      padding: '6px 4px', fontSize: 11, fontWeight: 700, color: '#fff',
                      background: RED, textAlign: 'center', whiteSpace: 'nowrap',
                      borderBottom: '1px solid #F2CACA',
                      borderLeft: mi === 0 ? undefined : '1px solid rgba(255,255,255,0.35)',
                    }}>
                      {ms.label}
                    </th>
                  ))
                : columns.map((c, ci) => (
                    <th key={c.key} style={{
                      padding: '6px 4px', fontSize: 11, fontWeight: 700, color: '#fff',
                      background: RED, textAlign: 'center', whiteSpace: 'nowrap',
                      borderBottom: '1px solid #F2CACA',
                      borderLeft: ci === 0 ? undefined : '1px solid rgba(255,255,255,0.35)',
                      width: colW, minWidth: colW,
                    }}>
                      {c.label}
                    </th>
                  ))}
            </tr>
            {monthSpans && (
              <tr style={{ background: '#FFF1F1' }}>
                {columns.map((c, ci) => (
                  <th key={c.key} style={{
                    padding: '6px 2px', fontSize: 9.5, fontWeight: 600, color: '#6B7280',
                    borderBottom: '1px solid #F2CACA', borderLeft: ci === 0 ? undefined : '1px solid #F2CACA',
                    whiteSpace: 'nowrap', textAlign: 'center', background: '#FFF1F1',
                    width: colW, minWidth: colW,
                  }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {sectionRows(blocks, 'count')}
            {deltaOf && (
              <>
                {/* The counts section closes with its own total, then the separator, then the Δ. */}
                {totalsLine(blocks, 'count', false)}
                {/* ── The separator ────────────────────────────────────────────────────────────
                    A band, not a second header: everything above it is the scenario on screen, and
                    everything below is that same grid holding Target − Base. Two pixels of rule plus
                    the Δ mark is all it takes, because the columns are literally the same columns —
                    which is the point of merging the two tables in the first place. */}
                <tr key="delta-sep">
                  <td colSpan={frozenCols} style={{
                    position: 'sticky', left: 0, zIndex: 2, background: '#F3F4F6',
                    width: frozenW, minWidth: frozenW, height: 22, padding: '0 10px',
                    borderTop: '2px solid #D1D5DB', borderBottom: '1px solid #E5E7EB',
                    fontSize: 10, fontWeight: 800, color: '#6B7280',
                    letterSpacing: '0.06em', whiteSpace: 'nowrap',
                    boxShadow: 'inset -1px 0 0 #F2CACA',
                  }}>
                    Δ TARGET − BASE
                  </td>
                  <td colSpan={columns.length} style={{
                    background: '#F3F4F6', height: 22,
                    borderTop: '2px solid #D1D5DB', borderBottom: '1px solid #E5E7EB',
                  }} />
                </tr>
                {sectionRows(deltaOf, 'delta')}
              </>
            )}
          </tbody>
          {/* Column totals of the LAST section, sticky to the bottom of the scroller the way the head
              is to the top: a total that scrolls out of sight on a long grid is a total nobody reads.
              The frozen cells stay sticky on the left as well (corner cell = the grand total), so the
              row survives a horizontal scroll exactly as the Modelo/Total columns do. */}
          <tfoot>
            {deltaOf ? totalsLine(deltaOf, 'delta', true) : totalsLine(blocks, 'count', true)}
          </tfoot>
        </table>
      )}
    </div>
  )
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 [&_svg]:cursor-default"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '86vw', maxWidth: 1240, height: '80vh' }}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ background: RED }}>
          <div className="flex items-center gap-2 min-w-0">
            <Hammer size={15} className="text-white shrink-0" />
            <span className="font-semibold text-sm text-white tracking-wide">Build Plan</span>
            <span className="text-[11px] leading-tight" style={{ color: 'rgba(255,255,255,0.72)' }}>
              {rows.length} loco{rows.length !== 1 ? 's' : ''}
              {rows.length !== allRows.length ? ` de ${allRows.length}` : ''}
              {' · '}{tipoGroups.length} tipo{tipoGroups.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Manual Log edits layered over the computed kit plan, in the same idiom the Kits window
                used: a count plus the single action that reverses it. Only while a Kits surface is
                open — on the Build tabs it would report state nothing on screen reflects. */}
            {(activeTab === 1 || (activeTab === 2 && kitsView)) && kits.editCount > 0 && (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <span className="text-[10px] font-semibold text-white bg-white/20 rounded-full px-2 py-0.5">
                  {kits.editCount} alteração(ões) manual(is)
                </span>
                <button
                  onClick={kits.clearRowOverrides}
                  title="Descartar todas as alterações manuais e voltar ao plano de kits calculado"
                  className="flex items-center gap-1 text-[10px] font-semibold text-white bg-white/20 hover:bg-white/30 transition-colors rounded-full px-2 py-0.5 cursor-pointer"
                >
                  <Undo2 size={11} /> Descartar
                </button>
              </span>
            )}
            {/* No scenario pill and no switch here anymore: both live in the FOOTER, beside Exportar,
                which is the pattern Resumo Geral already uses — one place identifies the scenario. */}
            <button onClick={onClose} className="rounded p-1 hover:bg-white/20 transition-colors cursor-pointer" title="Fechar">
              <X size={16} className="text-white" />
            </button>
          </div>
        </div>

        {/* ── Tab bar — same two-tab bar as the Kits window ── */}
        <div className="flex items-stretch bg-gray-50 border-b border-gray-200 shrink-0">
          {TABS.map((name, i) => {
            const active = activeTab === i
            return (
              <button
                key={name}
                onClick={() => setActiveTab(i as TabIdx)}
                className="flex-1 flex items-center justify-center px-6 py-2.5 text-xs font-semibold transition-all select-none whitespace-nowrap cursor-pointer hover:bg-[#FFF5F5]"
                style={{
                  borderBottom:    active ? `3px solid ${RED}` : '3px solid transparent',
                  backgroundColor: active ? '#FFF5F5' : 'transparent',
                  color:           active ? RED : '#6B7280',
                }}
              >
                {name}
              </button>
            )
          })}
        </div>

        {/* ── Content ── */}
        {/* Shortage banner — the Kits module's own warning, shown while one of its surfaces is open.
            Surfaces only weeks where the stock cannot cover the demand still remaining INSIDE the
            loaded period; a planned drawdown to zero at the end of the horizon is not a shortage. */}
        {(activeTab === 1 || (activeTab === 2 && kitsView)) && kits.plan.violations.length > 0 && (() => {
          const shortModels = [...new Set(kits.plan.violations.map(v => v.model))]
          return (
            <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b" style={{ background: '#FEF2F2', borderColor: '#FECACA' }}>
              <AlertTriangle size={13} style={{ color: '#B91C1C', flexShrink: 0 }} />
              <span className="text-[11px] font-medium" style={{ color: '#B91C1C' }}>
                Estoque insuficiente para a demanda do período em {kits.plan.violations.length} semana(s) · {shortModels.length} modelo(s): {shortModels.join(', ')} — Lead Time muito longo para o Max/Min configurado.
              </span>
            </div>
          )
        })()}

        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 3 ? (
            // ── Tab 3: Análises Gráficas ──────────────────────────────────────────────────
            // Left ~20%: the contractual-adherence cards. Right ~80%: the four chart frames —
            // deliberately EMPTY for now, so the arrangement can be judged before any chart is
            // drawn into it. They are the agreed next step, not forgotten placeholders.
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: RED }}>Análises Gráficas</span>
                <span style={{ fontSize: 11, color: '#6B7280', fontStyle: 'italic' }}>
                  Fim real de cada loco contra a sua data contratual.
                </span>
                <div style={{ flex: 1 }} />
                <BuildFilterPanel
                  allTipos={availableTipos} selTipos={selTipos}
                  allModels={availableModels} selModels={selModels}
                  onToggleTipo={toggleIn(setSelTipos)} onToggleModel={toggleIn(setSelModels)}
                  onClear={clearFilters} RED={RED}
                />
                {/* No Início/Fim here: this tab measures the REAL finish against the contractual
                    date, and the milestone switch steers nothing it shows. */}
                <BuildExibicao
                  RED={RED} exib={exib} onPickExib={setExib} showExib={false} showGroupByModel={false}
                  colMode={colMode} onPickColMode={setColMode}
                  groupByModel={groupByModel} onToggleGroupByModel={() => setGroupByModel(v => !v)}
                  compareAvailable={compareAvailable}
                  compare={compare} onToggleCompare={() => setCompare(v => !v)}
                />
              </div>

              <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12 }}>
                {/* LEFT — the three summary cards. A quarter of the row, with a floor so the
                    four-column expanded list stays legible on a narrow window. It went 23% → 20%
                    to buy the chart room when its opening period read as cut off; that turned out
                    to be the plot's own inset (see AnalysisLineChart's X_INSET), not the width, so
                    the cards take the space back — 20% → 25%, a quarter wider than they were. */}
                <div style={{ flex: '0 0 25%', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
                  {/* Accordion: clicking a card MOVES the open one — a click on the card already
                      open is a no-op, so the panel is never left with nothing expanded. */}
                  <AnalysisCard
                    kind="atrasadas" items={analysis.late} avgDays={analysis.avgLate}
                    open={openCard === 'atrasadas'}
                    onToggle={() => setOpenCard('atrasadas')}
                  />
                  <AnalysisCard
                    kind="adiantadas" items={analysis.early} avgDays={analysis.avgEarly}
                    open={openCard === 'adiantadas'}
                    onToggle={() => setOpenCard('adiantadas')}
                  />
                  <AnalysisCard
                    kind="sem" items={analysis.none} avgDays={null}
                    open={openCard === 'sem'}
                    onToggle={() => setOpenCard('sem')}
                  />
                </div>

                {/* RIGHT — ONE chart, the whole panel. Per período and Acumulado are two readings of
                    the same four series over the same timeline, so they were never two charts worth
                    of information: clicking the title flips the reading and the frame keeps all of the
                    space, which is what these curves need to be legible. */}
                <div style={{
                  flex: 1, minWidth: 0, minHeight: 0, display: 'grid',
                  gridTemplateColumns: '1fr', gridTemplateRows: '1fr',
                }}>
                  {analysisCharts ? (
                    <AnalysisLineChart
                      title={`${chartCumulative ? 'Acumulado' : 'Por período'} · ${colMode === 'semanal' ? 'Semanal' : 'Mensal'}`}
                      onTitleClick={() => setChartCumulative(v => !v)}
                      titleHint={chartCumulative
                        ? 'Clique para ver por período (valor de cada período)'
                        : 'Clique para ver o acumulado (soma corrida do mesmo período)'}
                      labels={analysisCharts.labels}
                      series={chartCumulative ? analysisCharts.cumulative : analysisCharts.perPeriod}
                      emptyText="Sem locos iniciando no período"
                    />
                  ) : (
                    <div style={{
                      border: '1.5px dashed #E5E7EB', borderRadius: 10, background: '#FCFCFD',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, minWidth: 0,
                    }}>
                      <span style={{ fontSize: 10.5, color: '#C4C4C4', fontWeight: 600 }}>Sem período carregado</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === 1 ? (
            // ── Tab 2: Kit's Plan (the Kits consumption log, relocated from the Kits window) ──
            // Rendered by the Kits module itself, which brings its OWN toolbar with it: the Kits
            // Filtros (Linha / Modelo — not this window's Tipo / Modelo, which mean nothing to a kit
            // pool) and the Kits Exibição, Parâmetros button included. That is the whole point of
            // reusing the component instead of re-deriving the tab here.
            <LogConsumoTab
              rows={kits.filteredRows} RED={RED} leadTime={kits.leadTime}
              lineByLoco={kits.lineByLoco} offsets={kits.axis.offsets}
              availableLines={kits.availableLines} selLines={kits.selLines}
              availableModels={kits.availableModels} selModels={kits.selModels}
              onToggleLine={kits.toggleLineFilter} onToggleModel={kits.toggleModelFilter}
              onClearFilters={kits.clearFilters}
              exibSet={kits.exibSet} onToggleExib={kits.toggleExib} onOpenParams={kits.openParams}
              rowOverrides={kits.rowOverrides}
              onEditShip={kits.editRowShip} onEditReceipt={kits.editRowReceipt}
              onEditProtection={kits.editRowProtection} onEditTransit={kits.editRowTransit}
            />
          ) : activeTab === 0 ? (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', boxSizing: 'border-box' }}>
              {/* Same toolbar shape as Schedule Kits: title + sentence + Filtros (shared). */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: RED }}>Build Plan</span>
                <span style={{ fontSize: 11, color: '#6B7280', fontStyle: 'italic' }}>Datas e semanas fiscais de cada loco.</span>
                <div style={{ flex: 1 }} />
                <BuildFilterPanel
                  allTipos={availableTipos} selTipos={selTipos}
                  allModels={availableModels} selModels={selModels}
                  onToggleTipo={toggleIn(setSelTipos)} onToggleModel={toggleIn(setSelModels)}
                  onClear={clearFilters} RED={RED}
                />
                {/* Same Exibição on every tab, driving the SAME shared state — a setting made here is
                    the setting the Build Schedule grid is already using when you get there. Início/Fim
                    is the exception: this tab prints both dates as columns, so the switch is hidden. */}
                <BuildExibicao
                  RED={RED} exib={exib} onPickExib={setExib} showExib={false} showGroupByModel={false}
                  colMode={colMode} onPickColMode={setColMode}
                  groupByModel={groupByModel} onToggleGroupByModel={() => setGroupByModel(v => !v)}
                  compareAvailable={compareAvailable}
                  compare={compare} onToggleCompare={() => setCompare(v => !v)}
                />
              </div>

              {rows.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
                  Nenhuma locomotiva com os filtros ativos.
                </div>
              ) : (
                // ONE scroller for both tables: two independent scrollers would let the halves
                // drift out of step, which is what the shared row height exists to prevent.
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                  <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', minWidth: 'min-content' }}>
                    {/* LEFT — the schedule as dates */}
                    <div style={{ flex: '1 1 auto', minWidth: 560, border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden' }}>
                      <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', tableLayout: 'fixed' }}>
                        <colgroup>
                          <col style={{ width: '19%' }} />
                          <col style={{ width: '17%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '13%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '8%' }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th style={th}>MODELO</th>
                            <th style={th}>LOCOMOTIVA</th>
                            {/* Every measure column is centred, header and body alike — mixing
                                left-aligned dates with right-aligned numbers made the block read as
                                four unrelated columns. */}
                            <th style={thC}>INÍCIO</th>
                            <th style={thC}>FIM</th>
                            {/* Contratual sits beside the scheduled end so the two dates are read
                                together — but it is an independent imported field, not a computed
                                one, and moving the loco never moves it. */}
                            <th style={thC} title="Data contratual de término, importada da aba Schedule - MS. Independente do fim planejado — nenhum cálculo do schedule a utiliza.">CONTRATUAL</th>
                            <th style={thC} title="Quanto falta para o início da loco, em meses de 30 dias (início − hoje). Negativo = a loco já começou.">HORIZONTE</th>
                            <th style={thC} title="Dias corridos entre o início e o fim, contando os dois extremos. Dias de calendário, não dias úteis — e independente do período carregado.">DURAÇÃO</th>
                            <th style={thC}>TAKT</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tipoGroups.map(g => (
                            <Fragment key={g.tipo}>
                              {planGroupRow(g.tipo, g.rows.length, 8, true)}
                              {g.rows.map(r => {
                                const bg = tintByKey.get(r.key)
                                const hz = horizonMonths(r.startIso, todayIso)
                                return (
                                  <tr key={r.key} style={{ background: bg }}>
                                    <td style={td} title={r.modelo}>{r.modelo || DASH}</td>
                                    <td style={{ ...td, fontWeight: 700 }} title={r.loco}>{r.loco || DASH}</td>
                                    <td style={numC}>{fmtDate(r.startIso)}</td>
                                    <td style={numC}>{fmtDate(r.finishIso)}</td>
                                    {/* "-" is the real answer for a loco with no contractual date;
                                        dimmed so it reads as absent rather than as a value. */}
                                    <td style={{ ...numC, color: r.contractIso ? '#374151' : '#9CA3AF' }}
                                        title={r.contractIso ? undefined : 'Sem data contratual para esta loco'}>
                                      {fmtDate(r.contractIso)}
                                    </td>
                                    {/* Red = the loco already started (negative horizon), green = it is
                                        still ahead. The sign is the direction in time, so the colour
                                        carries the same reading the number does. */}
                                    <td style={{ ...numC, fontWeight: 700, color: hz == null ? '#9CA3AF' : hz < 0 ? DELTA_DOWN : DELTA_UP }}>{fmtHorizon(hz)}</td>
                                    <td style={numC}>{r.duration != null ? `${r.duration} dias` : DASH}</td>
                                    <td style={numC}>{fmtTakt(r.takt)}</td>
                                  </tr>
                                )
                              })}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* RIGHT — the same rows in fiscal weeks (FW/Mês) */}
                    <div style={{ flex: '0 0 auto', width: 330, border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden' }}>
                      <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', tableLayout: 'fixed' }}>
                        <colgroup>
                          <col style={{ width: '34%' }} />
                          <col style={{ width: '33%' }} />
                          <col style={{ width: '33%' }} />
                        </colgroup>
                        <thead>
                          <tr>
                            {/* Centred, header and body alike — same rule as the left table's
                                measure columns, so the two halves read as one row. */}
                            <th style={thC} title="FW do envio do kit desta loco">KITS</th>
                            <th style={thC} title="FW do início desta loco">START</th>
                            <th style={thC} title="FW do fim desta loco">FGI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tipoGroups.map(g => (
                            <Fragment key={g.tipo}>
                              {planGroupRow(g.tipo, g.rows.length, 3, false)}
                              {g.rows.map(r => (
                                <tr key={r.key} style={{ background: tintByKey.get(r.key) }}>
                                  <td
                                    style={{ ...numC, color: r.kitFw ? '#374151' : '#9CA3AF' }}
                                    title={r.kitEligible
                                      ? (r.kitFw ? undefined : 'Sem envio de kit — a loco é coberta pelo estoque, ou o envio cai fora do período carregado')
                                      : 'Kits aplicam-se apenas a New Locos'}
                                  >
                                    {fmtFwMonth(r.kitFw)}
                                  </td>
                                  <td style={numC}>{fmtFwMonth(r.startFw)}</td>
                                  <td style={numC}>{fmtFwMonth(r.finishFw)}</td>
                                </tr>
                              ))}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            // ── Tab 3: Build Schedule / Kits Schedule (one tab, two views) ────────────────
            // The footer toggle picks which schedule this tab IS. The two are structurally the same
            // grid — frozen identity columns, a Total, then one column per period — so they share the
            // tab space, the comparison split and the export button; what changes with the view is
            // which module owns the numbers, and therefore which Filtros and which Exibição are shown.
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: RED }}>
                  {kitsView ? 'Schedule de Kits' : 'Build Schedule'}
                </span>
                <span style={{ fontSize: 11, color: '#6B7280', fontStyle: 'italic' }}>
                  {kitsView
                    ? `Kits com ${kits.exibSet.has('envio') ? 'envio' : 'recebimento'} em cada ${colMode === 'semanal' ? 'semana' : 'mês'} fiscal.`
                    : `Locos que ${exib === 'inicio' ? 'iniciam' : 'terminam'} em cada ${colMode === 'semanal' ? 'semana' : 'mês'} fiscal.`}
                </span>
                {/* How to read the Δ section of the table below — up here with the other labels rather
                    than wedged between two grids, which is where it sat while they were two tables.
                    Base is always the scenario ON SCREEN and Target the compared one, so "Trocar
                    Cenário" re-references the subtraction and every sign flips. */}
                {compare && (kitsView ? kitsDeltaBlocks : deltaBlocks) && (
                  <span
                    title={`Δ = Target − Base · Base = ${activeScenarioLabel} (cenário ativo, contagens acima do separador) · Target = ${otherScenarioLabel} (cenário comparado). Trocar de cenário inverte o sinal.`}
                    style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 10.5, flexWrap: 'wrap', minWidth: 0 }}
                  >
                    <span style={{ fontWeight: 800, color: '#374151' }}>Δ = Target − Base</span>
                    <span style={{ color: '#6B7280', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {otherScenarioLabel} − {activeScenarioLabel}
                    </span>
                    <span style={{ color: DELTA_UP, fontWeight: 700 }}>+ {kitsView ? 'mais kits' : 'aumento'}</span>
                    <span style={{ color: DELTA_DOWN, fontWeight: 700 }}>− {kitsView ? 'menos kits' : 'redução'}</span>
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {kitsView ? (
                  // Kits' own controls: Linha / Modelo filters and the Kits Exibição (Envio ↔
                  // Recebimento, Agrupar por modelo, Parâmetros) — this window's Tipo filter and
                  // Início/Fim switch steer nothing in a kit plan.
                  <>
                    <KitsFilterPanel
                      allLines={kits.availableLines} selLines={kits.selLines}
                      allModels={kits.availableModels} selModels={kits.selModels}
                      onToggleLine={kits.toggleLineFilter} onToggleModel={kits.toggleModelFilter}
                      onClear={kits.clearFilters}
                    />
                    <KitsExibicao
                      RED={RED} exibSet={kits.exibSet} onToggleExib={kits.toggleExib}
                      onOpenParams={kits.openParams}
                      // Mensal/Semanal is the SAME state the Build Schedule uses, so the granularity
                      // you set in one view is the granularity the other opens in.
                      colMode={colMode} onPickColMode={setColMode}
                      groupByModel={kits.groupByModel} onToggleGroupByModel={kits.toggleGroupByModel}
                      compareAvailable={compareAvailable}
                      compare={compare} onToggleCompare={() => setCompare(v => !v)}
                    />
                  </>
                ) : (
                  <>
                    <BuildFilterPanel
                      allTipos={availableTipos} selTipos={selTipos}
                      allModels={availableModels} selModels={selModels}
                      onToggleTipo={toggleIn(setSelTipos)} onToggleModel={toggleIn(setSelModels)}
                      onClear={clearFilters} RED={RED}
                    />
                    <BuildExibicao
                      RED={RED} exib={exib} onPickExib={setExib}
                      colMode={colMode} onPickColMode={setColMode}
                      groupByModel={groupByModel} onToggleGroupByModel={() => setGroupByModel(v => !v)}
                      compareAvailable={compareAvailable}
                      compare={compare} onToggleCompare={() => setCompare(v => !v)}
                    />
                  </>
                )}
              </div>

              {/* ONE table either way: with Comparação on, the Δ is appended to it below a separator
                  (the sign convention is on the toolbar above, beside the title). */}
              {kitsView
                ? renderGrid(kitsBlocks, compare ? kitsDeltaBlocks : null, kitsGridOpts)
                : renderGrid(gridBlocks, compare ? deltaBlocks : null)}
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────────────────────────
            Three zones, not two: the hint on the left, the actions on the right (Kits/Build toggle,
            Exportar, Fechar), and the SCENARIO group centred in the window — absolutely, so it sits
            on the window's midline instead of wherever the two side groups happen to leave it. The
            centre group is names + Trocar Cenário only: that button re-references everything the
            names identify, so it belongs with them, while the toggle and Exportar act on the tab. */}
        <div className="shrink-0 relative flex items-center gap-2 px-4 py-2 border-t border-gray-200 bg-gray-50">
          <span className="text-[10px] text-gray-400 truncate" style={{ maxWidth: '26%' }}>
            {activeTab === 0
              ? 'Ordenado por início · agrupado por tipo · semanas em FW/Mês fiscal'
              : activeTab === 1
                ? `${kits.totalShipments} envio${kits.totalShipments !== 1 ? 's' : ''} · Lead Time ${kits.leadTime} sem · New Locos`
                : activeTab === 2
                  ? kitsView
                    ? `${kits.exibSet.has('envio') ? 'Envio' : 'Recebimento'} · ${colMode === 'semanal' ? 'semanal' : 'mensal'} · Lead Time ${kits.leadTime} sem${compare && kitsDeltaBlocks ? ' · Δ Target − Base' : ''}`
                    : `${exib === 'inicio' ? 'Início' : 'Fim'} · ${colMode === 'semanal' ? 'semanal' : 'mensal'} · agrupado por tipo${compare && deltaBlocks ? ' · Δ Target − Base' : ''}`
                  : 'Fim real (com deslocamentos) × data contratual · delta em dias corridos'}
          </span>
          {/* CENTRE — the data source, and (in comparison mode) the switch that acts on it. */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2">
              {/* Outside comparison mode there is exactly one source and it is the one on screen:
                  solid red, same swatch, no switch beside it. With no scenario loaded that source is
                  the live database, named "Database" — the SAME fallback the Resumo Geral footer
                  uses (`scenarioName || 'Database'`), so the two windows never disagree about what
                  the numbers are read from. */}
              {!comparisonMode && (
                <ScenarioLabel
                  name={scenarioName || 'Database'}
                  color={RED}
                  dashed={false}
                  maxWidth={260}
                  title={scenarioName ? `Cenário: ${scenarioName}` : 'Fonte de dados: Database'}
                />
              )}
              {/* Scenario identification — Resumo Geral's footer pattern: both scenarios named with
                  the chart's own swatch (solid red = the one whose numbers are on screen, dashed gray
                  = the compared one), Base always first so the two never swap places under the
                  reader. */}
              {comparisonMode && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <ScenarioLabel
                    name={baseLabel}
                    color={comparisonActive === 'base' ? RED : COMPARE_LINE}
                    dashed={comparisonActive !== 'base'}
                    maxWidth={150}
                    title={`Cenário Base: ${baseLabel} — ${comparisonActive === 'base' ? 'ativo (contagens acima do separador; é a BASE do Δ)' : 'comparado (é o TARGET do Δ)'}`}
                  />
                  <ScenarioLabel
                    name={targetLabel}
                    color={comparisonActive === 'target' ? RED : COMPARE_LINE}
                    dashed={comparisonActive !== 'target'}
                    maxWidth={150}
                    title={`Cenário Target: ${targetLabel} — ${comparisonActive === 'target' ? 'ativo (contagens acima do separador; é a BASE do Δ)' : 'comparado (é o TARGET do Δ)'}`}
                  />
                </span>
              )}
              {comparisonMode && onSwitchScenario && (
                <button
                  onClick={() => onSwitchScenario()}
                  title={`Trocar Cenário (ativo: ${comparisonActive === 'base' ? 'Base' : 'Target'}) — o Δ passa a ser medido contra o outro cenário e troca de sinal`}
                  className="flex items-center justify-center rounded border transition-colors hover:bg-[#FFF0F0] cursor-pointer"
                  style={{ width: 28, height: 28, borderColor: '#D1D5DB', color: '#6B7280' }}
                >
                  <ArrowLeftRight size={15} />
                </button>
              )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* Which schedule tab 3 shows — immediately left of Exportar, the action it changes the
                meaning of. In the FOOTER and not in Exibição because it does not configure a view, it
                chooses between two of them, and the tab bar renames itself to match. The ICON is the
                destination, not the current state: viewing locos it offers the kits window's Package,
                viewing kits it offers this window's Hammer. Disabled with no New Locos loaded, since
                there would be no kit plan on the other side. */}
            {activeTab === 2 && (
              <>
                <button
                  onClick={() => { if (kitsAvailable) pickScheduleView(kitsView ? 'build' : 'kits') }}
                  disabled={!kitsAvailable}
                  title={!kitsAvailable
                    ? 'Kits só existem para New Locos — nenhum modelo New Locos carregado'
                    : kitsView ? 'Ver o Build Schedule (locos)' : 'Ver o Kits Schedule (kits)'}
                  className="flex items-center justify-center rounded border transition-colors hover:bg-[#FFF0F0] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent cursor-pointer"
                  style={{ width: 28, height: 28, borderColor: '#D1D5DB', color: kitsAvailable ? RED : '#9CA3AF' }}
                >
                  {kitsView ? <Hammer size={15} /> : <Package size={15} />}
                </button>
                <div style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />
              </>
            )}
            <button
              onClick={() => {
                if (activeTab === 0) return exportBuildPlan()
                if (activeTab === 1) return kits.exportLogConsumo()
                if (activeTab === 2) return kitsView ? kits.exportScheduleKits() : exportBuildSchedule()
              }}
              // Análises Gráficas has no table to export yet; the Kits surfaces export nothing when the
              // plan has no rows, exactly as the Build tabs don't when the filters empty them.
              disabled={activeTab === 3
                || (activeTab === 1 || (activeTab === 2 && kitsView) ? kits.filteredRows.length === 0 : rows.length === 0)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border font-medium transition-colors hover:bg-gray-100 disabled:opacity-40 cursor-pointer"
              style={{ borderColor: RED + 'AA', color: RED }}
            >
              <Download size={12} /> Exportar
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-white rounded font-medium transition-colors hover:bg-[#B71C1C] cursor-pointer"
              style={{ backgroundColor: RED }}
            >
              Fechar
            </button>
          </div>
        </div>
      </div>

      {/* Parâmetros de Kits — reached from the Kits Exibição on either Kits surface. The editor is the
          module's own window; every change recomputes the plan both surfaces read. */}
      {kits.paramsOpen && (
        <KitsParamsModal
          models={kits.plan.models}
          perModelParams={kits.params.perModel}
          initialOverride={kits.initialOverride}
          leadTime={kits.leadTime}
          onChangeModel={kits.setModelParam}
          onChangeInitial={kits.setInitialParam}
          onChangeLeadTime={kits.setLeadTime}
          onReset={kits.resetParams}
          onClose={kits.closeParams}
        />
      )}
    </div>
  )
}
