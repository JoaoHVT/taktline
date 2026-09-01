'use client'
/**
 * GanttInlineContext — shared state of the Factory Load MAIN PAGE (the page that
 * lives BEHIND the Gantt modal).
 *
 * AppHeader owns the Gantt lifecycle (period selection, base data cache, scenario /
 * comparison state). Once the user loads a period and opens the Gantt, AppHeader
 * publishes the ACTIVE raw dataset + the selected period/line filter here.
 *
 * The provider then runs the SAME aggregation pipeline the Resumo Geral uses
 * (windowGanttData → useGanttFilters → useSummaryCompute) and exposes:
 *   • the page filter state + option lists — rendered by the HEADER (Filtros / Datas
 *     buttons in AppHeader, gantt mode);
 *   • the computed summary — rendered by the FOOTER KPI bar (AppFooter, gantt mode);
 *   • the windowed dataset + active filters — consumed by the main content
 *     (FactoryLoadHome hierarchy).
 * Header, content and footer therefore always agree on the same filtered data.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { GanttData, TransactedHoursRollup, TransactedHoursScope } from '@/lib/api'
import { windowGanttData } from '@/lib/ganttUtils'
import { SCHEDULE_TIPO_KEYS } from '@/lib/tipos'
import { useGanttFilters } from '@/components/gantt/useGanttFilters'
import { useSummaryCompute } from '@/components/gantt/useSummaryCompute'
import type { SummaryTestResult, StatsResult } from '@/components/gantt/types'

export interface GanttInlineSnapshot {
  /** Active raw dataset (base or scenario). null until a period is loaded and the Gantt opened. */
  data: GanttData | null
  /** Period picked in the Gantt launch modal (dd/mm/yyyy strings — same shape GanttModal receives). */
  dateRange: { from?: string; to?: string } | null
  /** Line filter (linha names) picked in the launch modal, applied before any display. */
  lineFilter: string[] | null
  /** Tipo KEYS the load was opened with.
   *
   *  `lineFilter` cannot stand in for this. It is a list of Schedule "Linha" values, and a Tipo
   *  whose hours do not come from the Schedule contributes no Linha at all — it is invisible
   *  in it whether it was selected or not. The page needs the selection itself to know whether
   *  to show that Tipo's card. */
  lineTypes: string[] | null
}

type SetOfString = Set<string>
type SetUpdater  = React.Dispatch<React.SetStateAction<SetOfString>>

interface GanttInlineState extends GanttInlineSnapshot {
  publish: (snap: GanttInlineSnapshot) => void

  /** Dataset windowed to the loaded period + launch line filter (Resumo Geral rules). */
  effectiveData: GanttData | null

  // ── Page filter state (single source for header buttons + content + footer) ──
  selYears: SetOfString;        setSelYears: SetUpdater
  /** Fiscal quarters ("2026-Q1") — a coarser Mês filter (same 4-4-5 grouping). */
  selQuarters: SetOfString;     setSelQuarters: SetUpdater
  selMonths: SetOfString;       setSelMonths: SetUpdater
  selFws: SetOfString;          setSelFws: SetUpdater
  selAreas: SetOfString;        setSelAreas: SetUpdater
  selModels: SetOfString;       setSelModels: SetUpdater
  selWorkstations: SetOfString; setSelWorkstations: SetUpdater
  /** Tipo (line-type) toggle set — all four keys selected = no filter. */
  summaryLineTypes: SetOfString; setSummaryLineTypes: SetUpdater
  clearDateFilters: () => void
  clearDataFilters: () => void

  // ── Filter option lists (derived from effectiveData) ──
  years: string[]
  quarters: string[]
  months: string[]
  allFws: string[]
  allAreas: string[]
  allModels: string[]
  allWorkstations: string[]
  availableLineTypes: SetOfString
  /** Active business-day ISOs under the date filters (null = no date filter). */
  activeBizISOs: SetOfString | null

  // ── Aggregated summary (KPIs) — identical to the Resumo Geral pipeline ──
  summaryTestData: SummaryTestResult | null
  summaryComputing: boolean

  /** Rows of a published plan, when a Tipo not backed by the Schedule is in the selection.
   *
   *  Kept OUT of `summaryTestData`: that is the Schedule aggregation, and such a Tipo has no
   *  behind it. The page renders it as its own Tipo card rather than folding it into a rollup
   *  built on groups it does not appear in. `null` = not selected, or not loaded yet. */

  // ── Horas Transacionadas: UNSAVED prévia ──
  /** Rollup returned by a prévia that has not been written to the database. Set by the
   *  Horas Transacionadas modal (which lives in the header) and consumed by the page
   *  hierarchy, which prefers it over the stored snapshot so the mapping can be checked
   *  against the real hierarchy before the slow, irreversible write.
   *
   *  It lives here rather than in either component because those two sit on opposite
   *  sides of the tree and this provider is the nearest thing above both. */
  pendingRollup: TransactedHoursRollup | null
  setPendingRollup: (r: TransactedHoursRollup | null) => void
  /** Locos the page is currently rendering — ALL Tipos — with each one's Tipo and, for a
   *  serial planned under more than one, its routing. Published BY the page; the Horas
   *  Transacionadas modal sends it with the prévia so the rollup covers exactly what is on
   *  screen and attributes each row to the Tipo whose routing owns it. Deliberately not
   *  re-derived header-side: a second derivation of "which locos are loaded" is a second
   *  thing to keep in step with the filters. */
  mainLocoNames: TransactedHoursScope
  setMainLocoNames: (scope: TransactedHoursScope) => void
}

const Ctx = createContext<GanttInlineState | null>(null)

/** Optional accessor — returns null when no provider is mounted (e.g. the Capacity Analysis app). */
export function useGanttInlineMaybe(): GanttInlineState | null {
  return useContext(Ctx)
}

const ALL_LINE_TYPES: string[] = [...SCHEDULE_TIPO_KEYS]

/** Stable empty scope — a fresh `{ locos: [] }` per render would re-fire every consumer. */
const EMPTY_SCOPE: TransactedHoursScope = { locos: [] }

export function GanttInlineProvider({ children }: { children: React.ReactNode }) {
  const [snap, setSnap] = useState<GanttInlineSnapshot>({ data: null, dateRange: null, lineFilter: null, lineTypes: null })

  // Page filter state — mirrors the Resumo Geral filter semantics exactly.
  const [selYears,         setSelYears]         = useState<SetOfString>(new Set())
  const [selQuarters,      setSelQuarters]      = useState<SetOfString>(new Set())
  const [selMonths,        setSelMonths]        = useState<SetOfString>(new Set())
  const [selFws,           setSelFws]           = useState<SetOfString>(new Set())
  const [selAreas,         setSelAreas]         = useState<SetOfString>(new Set())
  const [selModels,        setSelModels]        = useState<SetOfString>(new Set())
  const [selWorkstations,  setSelWorkstations]  = useState<SetOfString>(new Set())
  const [summaryLineTypes, setSummaryLineTypes] = useState<SetOfString>(new Set(ALL_LINE_TYPES))
  const emptyLocoNames = useMemo(() => new Set<string>(), [])

  // Depends on the three fields the windowing actually reads, NOT on the `snap` object.
  // A publish that changes only `lineTypes` produces a new snapshot object; keying on it
  // handed out a new `effectiveData` identity for unchanged data, which `useSummaryCompute`
  // reads as a dataset change — it flips `summaryComputing` on and the whole page behind the
  // launch modal drops to its loading state. That is the flicker seen while ticking Tipos.
  const effectiveData = useMemo(
    () => windowGanttData(snap.data, snap.dateRange, snap.lineFilter),
    [snap.data, snap.dateRange, snap.lineFilter],
  )

  const {
    years, quarters, months, allFws, allAreas, allModels, allWorkstations,
    availableLineTypes, activeBizISOs,
  } = useGanttFilters({
    effectiveData, summaryTestReady: true, selYears, selQuarters, selMonths, selFws,
    selAreas, selModels, selLocoNames: emptyLocoNames, summaryLineTypes,
  })

  const [pendingRollup, setPendingRollup] = useState<TransactedHoursRollup | null>(null)
  const [mainLocoNames, setMainLocoNames] = useState<TransactedHoursScope>(EMPTY_SCOPE)

  const [summaryTestData,  setSummaryTestData]  = useState<SummaryTestResult | null>(null)
  const [summaryComputing, setSummaryComputing] = useState(false)
  const [, setStats] = useState<StatsResult | null>(null)
  useSummaryCompute({
    effectiveData, activeBizISOs, summaryLineTypes, selAreas, selModels,
    selLocoNames: emptyLocoNames, selWorkstations,
    setSummaryTestData, setStats, setSummaryComputing,
  })

  const value = useMemo<GanttInlineState>(() => ({
    ...snap,
    publish: setSnap,
    effectiveData,
    selYears, setSelYears,
    selQuarters, setSelQuarters,
    selMonths, setSelMonths,
    selFws, setSelFws,
    selAreas, setSelAreas,
    selModels, setSelModels,
    selWorkstations, setSelWorkstations,
    summaryLineTypes, setSummaryLineTypes,
    clearDateFilters: () => { setSelYears(new Set()); setSelQuarters(new Set()); setSelMonths(new Set()); setSelFws(new Set()) },
    clearDataFilters: () => { setSelAreas(new Set()); setSelModels(new Set()); setSelWorkstations(new Set()) },
    years, quarters, months, allFws, allAreas, allModels, allWorkstations,
    availableLineTypes, activeBizISOs,
    summaryTestData, summaryComputing,
    pendingRollup, setPendingRollup,
    mainLocoNames, setMainLocoNames,
  }), [
    snap, effectiveData,
    selYears, selQuarters, selMonths, selFws, selAreas, selModels, selWorkstations, summaryLineTypes,
    years, quarters, months, allFws, allAreas, allModels, allWorkstations, availableLineTypes, activeBizISOs,
    summaryTestData, summaryComputing, pendingRollup, mainLocoNames,
  ])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
