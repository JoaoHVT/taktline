'use client'
import { useState, useEffect, useRef, useMemo, useCallback, useTransition } from 'react'
import { X, ChevronLeft, ChevronRight, ChevronDown, Loader2, RefreshCw, Save, RotateCcw, Lock, History } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import { getGanttData } from '@/lib/api'
import type { GanttData, LocoEdit, OptScopeFilter } from '@/lib/api'
import { triggerUnlock } from '@/lib/unlockStore'
import {
  locoKeyOf, isEmptyOverride, isEmptyScopedEdit, wsEditKeyOf, descEditKeyOf,
  snapshotOverrides, loadOverrides, hydrateOverridesFromDb, saveOverridesToDb,
  getSavedBaseline, countUnsavedEdits, mergeOverrideMaps, setActiveScenario,
  hydrateProjectionBaselinesFromDb, saveProjectionBaselineToDb,
  loadProjOverrides, getProjSavedBaseline, snapshotProjOverrides,
  hydrateProjOverridesFromDb, saveProjOverridesToDb,
  bakeGanttDiffToOverrides, combineBakedWithManual, applyMoveNote, MANUAL_SWAP_CATEGORY, MOVE_NOTE_MAX_LEN,
  hydrateSaturdayWorkdays, saveSaturdayWorkdays, applySaturdayWorkdays, collectOptimizerSaturdays,
  type LocoOverrideMap, type LocoVisualOverride, type ScopedEdit, type MoveNote, type ProjectionBaseline,
  type AddedWorkstation,
} from '@/lib/locoOverrides'
import { getMergeLocoTypes, mergeSummaryLocoTypes } from '@/lib/locoMerge'
import { MoveNotePrompt, type MoveNoteMode, type PropagateMode } from './gantt/MoveNotePrompt'
import { MovePdWarningPrompt } from './gantt/MovePdWarningPrompt'
import { MoveNotePopover } from './gantt/MoveNotePopover'

// Where a displayed move-note actually LIVES: which scope (ws/desc), under which scoped-edit key, and
// at which slot of that scope's own `notes` array. The bubble shows a chronological CROSS-SCOPE merge,
// so this is what makes an in-place edit of a shown note resolvable back to storage.
type NoteRef = { scope: 'ws' | 'desc'; key: string; idx: number }

// Protection Days WS matcher — the SAME set isProtectionWs uses in gantt-table-worker.js. Module-level
// because both the PD count (Resumo/LOCO card) and the Move-Mode buffer limit need it, and the two must
// agree on what counts as a buffer station or the limit would guard a different set of rows than it counts.
function isProtectionWs(ws: string): boolean {
  const n = String(ws || '').trim().toUpperCase().replace(/\s+/g, '')
  return n === 'PROTECTIONDAYS' || n === 'PROTECAO' || n === 'DIASDEPROTECAO' || n === 'PROTECTIONDAY' || n.includes('PROTECTION')
}
import { SavePasswordModal } from './gantt/SavePasswordModal'
import { SaveStatusOverlay } from './gantt/SaveStatusOverlay'
import { ContextMenu } from './OptimizationResultsModal/ContextMenu'
import { PanelLocoEdit } from './OptimizationResultsModal/NumberRoller'
import { PanelAddWorkstation } from './OptimizationResultsModal/PanelAddWorkstation'
import { Pencil, CalendarPlus, CalendarMinus, AlertTriangle, ArrowLeftRight, Plus, Trash2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { RED, RED_DK, monthLabel, computeConflictCounts, validTakt, locoTypeOf, isOverlapAllowedPair, windowGanttData, wsSubLabel, localTodayIso } from '@/lib/ganttUtils'
import { TIPOS, DEFAULT_TIPO_KEY, anyScheduleBacked } from '@/lib/tipos'
import { GanttTable, type GanttTableHandle, type WsExpandState, type GanttFreezeGeom } from './gantt/GanttTable'
import { ResumoGeralTab } from './gantt/ResumoGeralTab'
import { GanttModalFooter } from './gantt/GanttModalFooter'
import { useConflictWs } from './gantt/useConflictWs'
import { getGlobalPropOptions } from '@/lib/globalPropOptions'
import { OptimizeScheduleModal } from './gantt/OptimizeScheduleModal'
import { Mode1OptionsModal, type Mode1Options } from './gantt/Mode1OptionsModal'
import { useGanttFilters } from './gantt/useGanttFilters'
import { ScheduleFilterPanel } from './gantt/ScheduleFilterPanel'
import { useSummaryCompute } from './gantt/useSummaryCompute'
import { makeScrollNavigation } from './gantt/useScrollNavigation'
import type { SummaryTestResult, StatsResult } from './gantt/types'
import { usePermissions } from '@/context/PermissionsContext'
import { type ScheduleRefMode } from '@/lib/ganttPrefs'

// ── Re-exports for backward compatibility ─────────────────────────────────────
export { FilterBox } from './gantt/FilterBox'
export { GanttLaunchModal } from './GanttLaunchModal'

// Tracks the last time Gantt data was freshly fetched, used to skip redundant silent refreshes
let _ganttDataFetchedAt = 0

// Stable empty override map. In 'original' reference mode the DISPLAY pipeline is fed this
// instead of the live `locoOverrides` — the real edits stay in state (so they return on
// switching back to Standard), but the rendered schedule ignores them. A single frozen
// identity keeps the merge/summary memos from thrashing while the mode is held.
const EMPTY_OVERRIDES: LocoOverrideMap = Object.freeze({}) as LocoOverrideMap

// Reference-mode picker for the Schedule header. Matches the app's standard dropdown idiom
// (compact chevron button → white panel, active row in red). Order: Original, Padrão, Projeção.
const REF_MODE_OPTIONS: { id: ScheduleRefMode; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'standard', label: 'Padrão' },
  { id: 'working',  label: 'Projeção' },
]
// Hachure marking the PADRÃO (standard) reference — and only it. Painted as the chip's own
// BACKGROUND (a faint red diagonal over white, red text on top), never through the glyphs: a
// background-clip:text hachure dissolved the label itself and read as a rendering fault rather than
// a texture. Combined with `overflow-hidden` + `rounded` on the button, the stripes are clipped to
// the chip's box, so the effect can never bleed outside the button area.
//
// Original and Projeção deliberately carry NO hachure and no special background — they keep the
// plain translucent white-text idiom shared with the "Somente leitura" chip beside them. The
// texture is what says "this is the standard working view", so it must be exclusive to that mode.
// The hachure now lives ONLY inside the open dropdown LIST, on the Padrão row. The closed chip
// keeps Padrão's red-on-white identity without the texture, so the header carries no pattern at
// all: whichever mode is selected, the chip reads as a plain control, and the texture is something
// you meet when you go looking at the options.
const HACHURE_ROW = 'repeating-linear-gradient(45deg, rgba(211,47,47,0.18) 0 2px, rgba(211,47,47,0) 2px 5px)'
const STANDARD_CHIP: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  color: RED,
  borderColor: 'rgba(255,255,255,0.85)',
}
function RefModeDropdown({ mode, onChange }: { mode: ScheduleRefMode; onChange: (m: ScheduleRefMode) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const current = REF_MODE_OPTIONS.find(o => o.id === mode) ?? REF_MODE_OPTIONS[1]
  // Padrão is the primary working mode: red label on a hachured white chip. Original/Projeção keep
  // the plain translucent white-text idiom — no hachure, no special background.
  const standardActive = mode === 'standard'
  return (
    <div className="relative" ref={ref}>
      {/* Selector chip. Non-standard modes share the "Somente leitura" idiom — white font on a
          slightly-grey translucent box that reads as a native control on the red header. Padrão is
          red on plain white (STANDARD_CHIP); the hachure is in the LIST, not here. */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Referência do Schedule — Original (somente banco), Padrão (com edições) ou Projeção (desvio vs. Padrão salvo)"
        // focus:outline-none — the UA's focus ring lands as a thick black box on this red header and
        // reads as an error state. Same treatment every other control in the app gets.
        className={`flex items-center justify-between gap-1 rounded overflow-hidden px-2 py-1 text-[11px] border transition-colors focus:outline-none ${
          standardActive ? 'font-semibold shadow-sm' : 'font-normal text-white bg-white/[0.16] hover:bg-white/25 border-white/[0.35]'
        }`}
        style={standardActive ? { width: 92, ...STANDARD_CHIP } : { width: 92 }}
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown
          size={11}
          className="shrink-0"
          style={{ color: standardActive ? RED : 'rgba(255,255,255,0.85)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        />
      </button>
      {open && (
        // The list itself stays a standard white panel with red-accented active item — readable where
        // it drops over the white content area below the header (only the chip button adopts the
        // translucent header idiom).
        <div className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-300 rounded shadow-xl overflow-hidden" style={{ minWidth: 108 }}>
          {REF_MODE_OPTIONS.map(o => {
            const active = o.id === mode
            // Padrão is the primary mode: darker + bolder in the list; Original/Projeção are muted so
            // the eye lands on Padrão first. The active row still wins with the red accent.
            const isStd = o.id === 'standard'
            return (
              <button
                key={o.id}
                onClick={() => { onChange(o.id); setOpen(false) }}
                className="w-full text-left px-2.5 py-1.5 text-[11px] cursor-pointer transition-colors whitespace-nowrap focus:outline-none"
                // The hachure is HERE and only here, and only on Padrão. Colour and texture are
                // separate longhands (backgroundColor + backgroundImage) so the hover handlers can
                // repaint the fill without wiping the stripes — and so nothing mixes the
                // `background` shorthand with a longhand it would fight over.
                style={{
                  backgroundColor: active ? '#FFF0F0' : '#fff',
                  ...(isStd ? { backgroundImage: HACHURE_ROW } : null),
                  color: active ? RED : (isStd ? '#111827' : '#9CA3AF'),
                  fontWeight: isStd ? 700 : active ? 400 : 500,
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = '#F9FAFB' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = '#fff' }}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// windowGanttData (period + line-filter windowing) lives in lib/ganttUtils — the single
// source of truth shared with the Factory Load home pipeline (GanttInlineContext).

// ── GanttModal ────────────────────────────────────────────────────────────────
// Retired-but-preserved Projeção reference UI ("Atualizar referência" + Histórico). The three-layer
// model (Original → Standard → Projeção) measures Projeção against the LIVE Standard, so freezing a
// snapshot no longer means anything. Kept behind a flag — not deleted — because the versioning
// structure behind it is planned for reuse as saved VERSIONS OF THE STANDARD schedule.
const SHOW_PROJ_REF_ACTIONS = false

export function GanttModal({ visible = true, onClose, initialData, onDataLoaded, initialTab = 0, dateRange = null, lineFilter = null, preloadSchedule = false, onScheduleProgress, onScheduleReady, onScheduleBuilt, scenarioActive = false, scenarioName, initialLineTypeKeys, tokenReady, comparisonMode = false, comparisonActive = 'base', comparisonOtherData = null, comparisonBaseName, comparisonTargetName, onComparisonSwitch, scheduleEnabled = true, onScheduleEnabledChange, onTabChange }: {
  visible?:            boolean
  onClose:             () => void
  initialData?:        GanttData | null
  onDataLoaded?:       (d: GanttData) => void
  initialTab?:         0 | 1 | 2 | 3
  dateRange?:          { from?: string; to?: string } | null
  lineFilter?:         string[] | null
  preloadSchedule?:    boolean
  /** Whether the heavy Schedule module is loaded / its tab is accessible. When off, the
   *  Schedule tab is locked; clicking it enables the module (via onScheduleEnabledChange)
   *  and builds it on demand — no restart needed. Comparison mode always keeps it available. */
  scheduleEnabled?:    boolean
  /** Persist a Schedule enable/disable request (e.g. clicking the locked Schedule tab). */
  onScheduleEnabledChange?: (enabled: boolean) => void
  /** Fires when the user switches tabs so the parent can remember the last viewed tab. */
  onTabChange?:        (tab: 0 | 1 | 2 | 3) => void
  onScheduleProgress?: (pct: number) => void
  onScheduleReady?:    () => void
  /** Fires whenever the Schedule (tab 3) iframe finishes building — used by the
   *  parent to mark the current period/scenario as "built & alive" so a later
   *  reopen of the same dataset can be restored instantly without rebuilding. */
  onScheduleBuilt?:    () => void
  scenarioActive?:     boolean
  scenarioName?:       string
  initialLineTypeKeys?: string[]
  tokenReady?: 'pending' | 'ok' | 'reauth-required'
  /** Scenario-comparison mode: two scenarios held in memory, one shown at a time. The active scenario
   *  arrives via `initialData` (and its name via `scenarioName`) and swaps on "Trocar Cenário". ALL
   *  tabs — including the Schedule tab — work per-scenario: each shows only its own data, overrides
   *  (persisted under its scenarioName) and calculations. See AppHeader's compare state. */
  comparisonMode?:     boolean
  comparisonActive?:   'base' | 'target'
  /** The OTHER (inactive) scenario's raw data, used to overlay its Total line and to compute
   *  the ±10% comparison indicators in Resumo Geral. Only meaningful in comparison mode. */
  comparisonOtherData?: GanttData | null
  /** Both compared scenarios' names — rendered as the FOOTER's scenario labels (the header no
   *  longer shows a name pill). `scenarioName` is only the ACTIVE one, which is not enough to
   *  label both series. */
  comparisonBaseName?:   string
  comparisonTargetName?: string
  onComparisonSwitch?: () => void
}) {
  // canSave: Editor/Admin may persist edits; Readers edit locally only.
  // username: the byline stamped on a move description (see MoveNote).
  const { canSave, username } = usePermissions()
  const [data,            setData]          = useState<GanttData | null>(initialData ?? null)
  const dataRef = useRef<GanttData | null>(initialData ?? null)
  const [loading,         setLoading]       = useState(!initialData)
  const [isTransitioning, startTransition]  = useTransition()
  const [isTabTransitioning, startTabTransition] = useTransition()
  const [error,           setError]         = useState<string | null>(null)
  const [exporting,       setExporting]     = useState(false)
  const [activeTab,       setActiveTab]     = useState<0 | 1 | 2 | 3>(initialTab)
  const [zoom,            setZoom]          = useState(1)
  const [scheduleGateMsg, setScheduleGateMsg] = useState<string | null>(null)
  const [summaryTestReady,  setSummaryTestReady]  = useState(false)
  const [scheduleTabReady,  setScheduleTabReady]  = useState(false)
  const [selYears,    setSelYears]    = useState<Set<string>>(new Set())
  // Fiscal quarters ("2026-Q1") — a coarser Mês filter, same 4-4-5 grouping the Q columns use.
  const [selQuarters, setSelQuarters] = useState<Set<string>>(new Set())
  const [selMonths,   setSelMonths]   = useState<Set<string>>(new Set())
  const [selFws,      setSelFws]      = useState<Set<string>>(new Set())
  const [showExportMenu,       setShowExportMenu]       = useState(false)
  const exportMenuRef      = useRef<HTMLDivElement>(null)
  const resumoScrollRef    = useRef<HTMLDivElement>(null)
  const planoScrollRef     = useRef<HTMLDivElement>(null)
  const [summaryMode,   setSummaryMode]   = useState<'ue' | 'horas'>('horas')
  const [rowMode,       setRowMode]       = useState<'area' | 'locos'>('area')
  const [viewMode,      setViewMode]      = useState<'mensal' | 'semanal'>('mensal')
  const [showQuarters,  setShowQuarters]  = useState(false)
  // "Unir períodos" — Resumo Geral shows only the SELECTED date periods instead of the whole
  // timeline with zeros. View-only; default off (the long-standing behaviour).
  const [mergePeriods,  setMergePeriods]  = useState(false)
  const [summaryLineTypes, setSummaryLineTypes] = useState<Set<string>>(new Set<string>([DEFAULT_TIPO_KEY]))
  /** The Tipos this session was opened with — see the seeding effect. Empty until the first
   *  open, which the chip row reads as "no restriction" so nothing is locked before a load. */
  const [loadedLineTypes, setLoadedLineTypes] = useState<Set<string>>(new Set<string>())

  // Schedule content is accessible when the module is enabled OR in comparison mode
  // (which is always per-scenario schedule-capable). When false, the Schedule tab is locked.
  // ALSO gated on the Tipo selection: a Tipo with no Schedule behind it contributes no groups,
  // so with only such Tipos selected the module was never built and its tab must stay locked
  // rather than opening onto a blank grid. The parent applies the same test to the LAUNCH
  // selection (AppHeader's scheduleActive, which is what stops the heavy preload); this one
  // covers the selection being narrowed from inside the modal afterwards.
  //
  // Declared HERE and not beside the other flags at the top of the component: it reads
  // `summaryLineTypes`, and a `const` referenced above its own declaration is a TDZ crash, not
  // an undefined.
  //
  // TWO flags, because the two "no Schedule" states are not the same thing to a reader:
  //   • scheduleApplicable — there IS a Schedule behind this selection. False for GCR alone.
  //     Nothing can make its tab work, so that tab is DISABLED: no click, no navigation.
  //     It used to be merely locked, which meant clicking it turned the module on, switched to
  //     tab 3, and the guard effect below immediately bounced the user to Resumo Geral — a
  //     click that read as a redirect.
  //   • scheduleAvailable — the module is actually loaded (or comparison mode, which is always
  //     schedule-capable). False with the toggle off but the selection fine: that tab stays
  //     LOCKED and clickable, and clicking it loads Schedule in place.
  const scheduleApplicable = anyScheduleBacked(summaryLineTypes) || comparisonMode
  const scheduleAvailable = (scheduleEnabled && scheduleApplicable) || comparisonMode
  const [selAreas,        setSelAreas]        = useState<Set<string>>(new Set())
  const [selModels,       setSelModels]       = useState<Set<string>>(new Set())
  const [selLocoNames,    setSelLocoNames]    = useState<Set<string>>(new Set())
  // Resumo Geral Workstation filter (new — part of the "Dados" filter panel).
  const [selWorkstations, setSelWorkstations] = useState<Set<string>>(new Set())
  // Schedule-tab-only filters (Modelo / Área / Workstation) — independent from the
  // Resumo Geral filters above; persist until the user changes or clears them.
  const [selSchedModels,       setSelSchedModels]       = useState<Set<string>>(new Set())
  const [selSchedAreas,        setSelSchedAreas]        = useState<Set<string>>(new Set())
  const [selSchedWorkstations, setSelSchedWorkstations] = useState<Set<string>>(new Set())
  const [tableBuilt,    setTableBuilt]    = useState(true)
  // Bumped each time the Schedule iframe genuinely finishes a build (onBuilt). Distinct from the
  // initial `tableBuilt=true`, which is true BEFORE any build — used to paint hydrated overrides
  // only after a real build exists.
  const [builtNonce,    setBuiltNonce]    = useState(0)
  const [ganttProgress, setGanttProgress] = useState(0)
  const [forceReloadToken, setForceReloadToken] = useState(0)
  // The Schedule is a THREE-LEVEL tree now: LOCO ▸ Workstation ▸ Componente, both tiers
  // per-row expand/collapse with the same base-XOR-exceptions model. The old global view
  // modes are gone — FULL/WORK/LOCO in the footer are bulk actions over the tiers.
  //
  // Workstation ↔ Componente tier. `base` is the bulk default (Expand All = true / Collapse
  // All = false — false on open, so the compact former-WORK look is the default);
  // `exceptions` holds individually toggled keys (linha||wo||task||start_ms||ws||subarea):
  // expanded = base XOR exceptions.has(key). Stale keys (filtered-out LOCOs, other
  // scenarios) are harmless — they never match. `wsExpandBulk` bumps the Schedule buildKey on
  // Expand/Collapse All so the whole grid re-renders IN PLACE (structuralKey unchanged →
  // scroll kept, no flash); individual toggles re-render one LOCO via patchLocos instead.
  const [wsExpandBase, setWsExpandBase] = useState(false)
  const [wsExpandExc,  setWsExpandExc]  = useState<ReadonlySet<string>>(() => new Set<string>())
  const [wsExpandBulk, setWsExpandBulk] = useState(0)
  // LOCO ↔ Workstation tier, same model one level up (keys linha||wo||task||start_ms).
  // `locoExpandBase` defaults to TRUE — the tree is the default view; a collapsed LOCO
  // renders as its single summary row (the old LOCO-mode row, WS card included). When the
  // tier is exactly all-collapsed the narrow layout kicks in (WS column width-0 — the old
  // LOCO mode look), synced to the DOM by GanttTable.
  const [locoExpandBase, setLocoExpandBase] = useState(true)
  const [locoExpandExc,  setLocoExpandExc]  = useState<ReadonlySet<string>>(() => new Set<string>())
  const [locoExpandBulk, setLocoExpandBulk] = useState(0)
  const wsExpand = useMemo<WsExpandState>(
    () => ({ base: wsExpandBase, exceptions: wsExpandExc, locoBase: locoExpandBase, locoExceptions: locoExpandExc }),
    [wsExpandBase, wsExpandExc, locoExpandBase, locoExpandExc])
  const [ganttGrabMode,    setGanttGrabMode]    = useState(false)
  // The two "Ocultar" options, independent so all four combinations are reachable:
  // hideBeforeStart hides each LOCO's cells before its own start_ms; hidePastLocos drops
  // whole LOCOs that have no activity today or later. Neither clamps the timeline — a
  // still-running LOCO keeps its past columns. Visualization only (see worker payload).
  const [hideBeforeStart,  setHideBeforeStart]  = useState(false)
  const [hidePastLocos,    setHidePastLocos]    = useState(false)
  const [zoomBusy,         setZoomBusy]         = useState(false)
  const ganttBuiltRef  = useRef(false)
  const onceBuiltRef   = useRef<(() => void) | null>(null)
  // Once the Schedule has built at least once, keep this modal mounted (hidden
  // offscreen) even after close, so reopening the same period restores the built
  // iframe — scroll, filters, optimization — instantly instead of rebuilding.
  // A genuine dataset change (period/scenario) remounts via the parent's React
  // key, which resets this flag for the fresh instance.
  const keepAliveRef   = useRef(false)
  const pendingScrollRef = useRef<(() => void) | null>(null)
  // One-time initial jump to Today the first time the Schedule table builds.
  const scrolledToTodayRef = useRef(false)
  // Persisted LOCO search text (lifted out of the footer so it survives tab
  // switches / footer remounts). Only cleared by an explicit user action.
  const [locoSearch, setLocoSearch] = useState('')
  // Kits planning window (New Locos only) — opened from the Schedule footer.

  const [summaryTestData, setSummaryTestData] = useState<SummaryTestResult | null>(null)


  const [summaryComputing, setSummaryComputing] = useState(false)
  const [stats, setStats] = useState<StatsResult | null>(null)
  // Comparison mode: aggregated summary of the OTHER (inactive) scenario, under the same
  // filters/period — powers the chart's compared Total line and the ±5% indicators.
  const [comparisonOtherSummary, setComparisonOtherSummary] = useState<SummaryTestResult | null>(null)
  // Resumo Geral distribution chart summaries — computed IGNORING the month selection so the
  // chart always shows the full timeline while KPIs/tables react to the selected month. One
  // for the active scenario, one for the compared scenario (comparison mode only).
  const [chartSummaryData, setChartSummaryData] = useState<SummaryTestResult | null>(null)
  const [chartComparisonSummary, setChartComparisonSummary] = useState<SummaryTestResult | null>(null)
  // Single-scenario deviation reference (NOT the scenario-compare above): the ACTIVE mode's
  // reference schedule (planoBaseSource) aggregated under the same filters, so Resumo Geral shows
  // each cell's deviation vs Padrão→original / Original→itself / Projeção→frozen baseline. One
  // month-filtered (cells/KPIs), one month-independent (chart line). Reuses the same compare
  // engine as scenario mode; only wired when NOT in a scenario-compare session.
  const [refSummary, setRefSummary] = useState<SummaryTestResult | null>(null)
  const [refChartSummary, setRefChartSummary] = useState<SummaryTestResult | null>(null)

  const refSummaryCmp             = refSummary
  const refChartSummaryCmp        = refChartSummary
  const comparisonOtherSummaryCmp = comparisonOtherSummary
  const chartComparisonSummaryCmp = chartComparisonSummary
  // UI-only toggle for the ±5% comparison arrows (default ON). Persists while the modal is open.
  const [showCompareArrows, setShowCompareArrows] = useState(true)

  const [activeOptMode,   setActiveOptMode]  = useState<1 | 2 | 3 | null>(null)
  const [optimizedData,   setOptimizedData]  = useState<GanttData | null>(null)
  // Per-scenario working Saturdays: dates promoted to is_weekend=false so WS40/WS50 work can sit on
  // them. Hydrated per scenario; bake auto-registers the Saturdays a saved optimization used so they
  // persist on reload (see applySaturdayWorkdays / collectOptimizerSaturdays). `saturdayWorkdays` is
  // the working set (edited locally, instant); `savedSaturday` is the persisted baseline so Save knows
  // whether it changed and Reset can revert. `satMenu` positions the right-click toggle popover.
  const [saturdayWorkdays, setSaturdayWorkdays] = useState<string[]>([])
  const [savedSaturday,    setSavedSaturday]    = useState<string[]>([])
  const [satMenu, setSatMenu] = useState<{ iso: string; x: number; y: number } | null>(null)
  const _sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
  // Unsaved working-Saturday change → enables Save + counts toward the footer's dirty state.
  const saturdayDirty = !_sameSet([...saturdayWorkdays].sort(), [...savedSaturday].sort())
  // How MANY Saturdays are unsaved = the symmetric difference against the persisted baseline (each
  // promoted-or-demoted date is one edit). A working Saturday is a real, savable schedule change, so
  // it belongs in the edit COUNT like any loco edit — `saturdayDirty` alone only said "something
  // changed", which left the footer showing Save/Reset with no number next to them.
  const saturdayEditCount = useMemo(() => {
    const saved = new Set(savedSaturday)
    const live  = new Set(saturdayWorkdays)
    let n = 0
    for (const iso of live)  if (!saved.has(iso)) n++   // newly promoted
    for (const iso of saved) if (!live.has(iso))  n++   // reverted to weekend
    return n
  }, [saturdayWorkdays, savedSaturday])
  // REVERSE VALIDATION: a working Saturday that still carries allocations cannot be reverted.
  // Reverting drops the Saturday off the business-day axis, and anything sitting on it is then
  // silently FOLDED onto a neighbouring weekday (_remapCells' off-axis path) — work would appear to
  // teleport, and could even stack onto an occupied day. So we block the revert while any workstation
  // is allocated there and name the offenders; the user displaces them off the Saturday first (a move
  // now closes the gap it leaves behind). `satBlock` drives the explanatory dialog.
  const [satBlock, setSatBlock] = useState<{ iso: string; locos: string[] } | null>(null)

  /** Workstations allocated on `iso` in the FULL schedule (base ⊕ optimization ⊕ saved/live edits).
   *  Deliberately UNWINDOWED — `effectiveData` is clipped by the date/line filters, but a LOCO hidden
   *  by the current filter still has real work on that Saturday and reverting would move it too, so
   *  filtering here would let the user revert a Saturday whose allocations they simply can't see.
   *  Edits live in the worker (the override transform can't run here), so we ask it for the merged
   *  schedule; if it can't answer we fall back to the unmerged one rather than silently allowing. */
  async function allocationsOn(iso: string): Promise<string[]> {
    // Read the schedule from a REF, never by capturing `baseData` directly: this is the only closure
    // over `baseData`, and capturing it makes the React Compiler treat it as "may be modified later"
    // and bail out of memoizing `effectiveData` (a hot path). Mirrors `effectiveDataRef`, which
    // exists for the same "read current data without closure staleness" reason.
    const src0 = baseDataRef.current
    if (!src0) return []
    const merged = (Object.keys(locoOverrides).length > 0 && ganttTableRef.current)
      ? await ganttTableRef.current.computeEffective(src0, locoOverrides).catch(() => null)
      : null
    const src = merged ?? src0
    const out = new Set<string>()
    for (const g of src.groups)
      for (const w of g.workstations)
        for (const dr of w.desc_rows)
          if (dr.cells[iso]) out.add(`${g.task_name} · ${w.ws}`)
    return [...out].sort()
  }

  // Toggle a Saturday's working state LOCALLY (instant column flip); it persists on the next Save
  // (Editor + app password), exactly like a loco edit. Readers toggle session-only, like their edits.
  // Promoting a Saturday is always safe; only the REVERT is guarded (it can displace existing work).
  async function toggleSaturdayWorkday(iso: string) {
    const reverting = saturdayWorkdays.includes(iso)
    setSatMenu(null)
    if (reverting) {
      const locos = await allocationsOn(iso)
      if (locos.length) { setSatBlock({ iso, locos }); return }
    }
    setSaturdayWorkdays(prev => (prev.includes(iso) ? prev.filter(s => s !== iso) : [...prev, iso]).sort())
    startTransition(() => { setTableBuilt(false) })   // rebuild so the column flips working/weekend
  }
  const [optLoading,      setOptLoading]     = useState(false)
  const [optError,        setOptError]       = useState<string | null>(null)
  const [optLogs,         setOptLogs]        = useState<string[]>([])
  const [optProgress,     setOptProgress]    = useState(0)
  const [optMessage,      setOptMessage]     = useState('')
  const [optStatus,       setOptStatus]      = useState<'running' | 'done' | 'error'>('running')
  const [showOptTerminal, setShowOptTerminal] = useState(false)
  const [showMode1Options, setShowMode1Options] = useState(false)
  const optAbortRef = useRef<AbortController | null>(null)
  const originalDataRef = useRef<GanttData | null>(null)
  // Ref to effectiveData so handleOptimizeMode can read the current filtered WO list
  const effectiveDataRef = useRef<GanttData | null>(null)
  const baseDataRef = useRef<GanttData | null>(null)

  // ── Manual LOCO editing ("Editar LOCO") — visual/local override only ───────────
  // Editing a LOCO no longer triggers a backend recompute / full Gantt rebuild. It writes
  // a lightweight visual override (keyed by linha||wo||task||start_ms) and surgically
  // re-renders ONLY that LOCO's row in the live iframe (ganttTableRef.patchLocos). The base
  // schedule is never mutated:  Original Data + Visual Override = Displayed Result.
  // An edit target identifies WHAT is being edited and at WHICH scope. `loco` edits the whole
  // LOCO (top-level override fields); `ws` edits one workstation/station; `desc` edits one
  // description row (Componente). ws/subarea/desc are only set for the finer scopes.
  type EditScope = 'loco' | 'ws' | 'desc'
  type EditTarget = {
    scope: EditScope
    wo: string; taskName: string; linha: string; startMs: string; takt: number | null
    ws?: string; subarea?: string; desc?: string
    // A `desc`-scope target that REPRESENTS the whole workstation (its sole component). Presentation
    // only — the panel titles it "Editar Workstation" and labels the Hours section accordingly. It
    // never touches the override key (scopedEditOf/writeScopedEdit ignore it), so hours still store
    // and scale through the tested desc-scope path.
    asWs?: boolean
  }
  const [locoOverrides, setLocoOverrides] = useState<LocoOverrideMap>(() => loadOverrides())
  // ── Projeção override LAYER (three-layer model) ───────────────────────────────────────────────
  // Original (imported DB) → Standard (`locoOverrides`) → Projeção (`projOverrides`). Each layer
  // inherits ONLY from the one directly beneath it:
  //   • Standard edits are visible in Standard AND Projeção (Standard is Projeção's baseline).
  //   • Projeção edits are visible in Projeção ONLY — an isolated future-planning layer.
  // Stored and saved separately (own DB namespace, own saved baseline, own unsaved counter), so a
  // simulation can never be published into the operational plan by accident.
  const [projOverrides, setProjOverrides] = useState<LocoOverrideMap>(() => loadProjOverrides())
  const projSavedBaselineRef = useRef<LocoOverrideMap>(getProjSavedBaseline())
  // Mirror for the async hydrate, which resolves long after its closure was created.
  const projOverridesRef = useRef(projOverrides)
  projOverridesRef.current = projOverrides
  const [projSavedVersion, setProjSavedVersion] = useState(0)

  // ── Schedule reference mode ("Alternar Referência") ─────────────────────────────────────────
  // Governs which schedule the tabs DISPLAY and which baseline deviations/impacts compare against.
  //   • 'standard' — original DB + overrides; editable; reference = original DB.
  //   • 'original' — original DB only (overrides + optimizer ignored); read-only audit view.
  //   • 'working'  — Mode 3 "Projeção": display IDENTICAL to 'standard' (editable, overrides applied),
  //     but deviations/impacts measure against a FROZEN reference snapshot (see projectionRef below),
  //     not against the original DB and not against the live-moving saved baseline.
  // The Schedule opens on 'standard' at the START of a session, then PRESERVES the user's mode across
  // close/reopen for the rest of that session (see the visibility effect below — it only resets on the
  // first open of a fresh modal instance). A "new session" = page reload or a new period/scenario load
  // (both remount via key={ganttLoadKey}), which starts back on 'standard'. A build-invalidating change:
  // switching modes may swap the displayed data, so `changeRefMode` forces a full Schedule rebuild.
  const [refMode, setRefMode] = useState<ScheduleRefMode>('standard')
  const refModeRef = useRef(refMode)
  refModeRef.current = refMode   // mirror for the open-transition reset (reads current mode without a stale closure)
  const readOnly = refMode === 'original'
  const isProjection = refMode === 'working'

  // ── The layer seam ───────────────────────────────────────────────────────────────────────────
  // Projeção = Standard ⊕ Projeção, composed with mergeOverrideMaps — a per-OBJECT REPLACE, which is
  // the right operator because startShiftDays is absolute-from-base. An object Projeção never touched
  // inherits Standard transparently; one it did touch is fully described by its own entry (and a later
  // Standard edit to it stays masked, which is what "inherits only from the layer beneath" means).
  const projectionComposed = useMemo(
    () => mergeOverrideMaps(locoOverrides, projOverrides),
    [locoOverrides, projOverrides],
  )
  // READS (what is stored for a target, panel prefill, origShiftOf) see the COMPOSED map, so an edit
  // in Projeção starts from the position the user is looking at rather than snapping back to base.
  const activeOverrides = isProjection ? projectionComposed : locoOverrides
  // WRITES land in the active layer only. In Projeção that is projOverrides, so touching an object
  // here "promotes" it into the projection layer and the operational plan is never modified.
  const setActiveOverrides = isProjection ? setProjOverrides : setLocoOverrides
  // The raw write layer — what a Reset clears, and what the unsaved counter/save persist. Distinct
  // from `activeOverrides`: resetting in Projeção must drop only the projection edit, revealing the
  // Standard one underneath, never clear Standard itself.
  const writeOverrides = isProjection ? projOverrides : locoOverrides
  // Fallback the write layer seeds from when it has no entry yet for an object (Projeção only), so a
  // projection edit inherits the Standard entry's riders — notes, satManual, swap/swapShift, hours —
  // instead of silently dropping them. null in Standard mode (nothing beneath it but the original).
  const inheritOverrides = isProjection ? locoOverrides : null

  function changeRefMode(m: ScheduleRefMode) {
    if (m === refMode) return
    setRefMode(m)
    // Grab/pan stays available in every mode (it only scrolls the view) — do NOT force it off here.
    startTransition(() => { setTableBuilt(false) })       // full rebuild on every mode change
  }
  // Original mode is view-only: shown when the user tries an editing action (e.g. Move Mode). Uses the
  // schedule gate banner and auto-clears so it never lingers.
  function notifyOriginalReadOnly() {
    setScheduleGateMsg('Modo Original é somente leitura. Mude para Padrão ou Projeção para fazer alterações.')
    window.setTimeout(() => setScheduleGateMsg(m => (m && m.startsWith('Modo Original') ? null : m)), 3500)
  }

  // ── Projeção (Mode 3) reference: VERSIONED baselines (Option A) ──────────────────────────────
  // Every "Atualizar referência" freeze APPENDS a version instead of overwriting, so the accumulated
  // delay history is never lost. Stored SHARED in the DB (Editor+ appends, everyone reads). From this
  // list we derive:
  //   • projectionRef      — the LATEST version's overrides = the INCREMENTAL deviation baseline
  //     (unchanged behavior: Mode-3 deviations/impacts measure the current schedule against this).
  //   • originalRefOverrides — version 0's overrides = the reference OF RECORD, against which the
  //     CUMULATIVE deviation is measured (the history panel; other modes never read it).
  // Empty list = none frozen yet (deviations then fall back to the last saved standard, see below).
  const [projBaselines, setProjBaselines] = useState<ProjectionBaseline[]>([])
  // Retired as a deviation reference (Projeção now measures against the LIVE Standard layer), and so
  // currently read by nothing. Kept — with the baselines it derives from — for the planned "saved
  // versions of the Standard schedule" feature; see SHOW_PROJ_REF_ACTIONS.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const projectionRef = useMemo<LocoOverrideMap>(
    () => (projBaselines.length ? projBaselines[projBaselines.length - 1].overrides : {}),
    [projBaselines],
  )
  const [showRefHistory, setShowRefHistory] = useState(false)
  const [showUpdateRefConfirm, setShowUpdateRefConfirm] = useState(false)
  const [projRefSaveState, setProjRefSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [projRefError, setProjRefError] = useState<string | null>(null)

  // The last DB-persisted override map (the "saved baseline"). Unsaved edits = working ⊖ baseline.
  // A ref (not state) so advancing it after a save costs no re-render of this heavy modal; `savedVersion`
  // is bumped to recompute the counter exactly when the baseline moves (save / hydrate).
  const savedBaselineRef = useRef<LocoOverrideMap>(getSavedBaseline())
  const [savedVersion, setSavedVersion] = useState(0)
  const [editMenu,    setEditMenu]    = useState<{ x: number; y: number; target: EditTarget } | null>(null)
  const [editPanel,   setEditPanel]   = useState<EditTarget | null>(null)
  // "Adicionar Workstation" dialog — open against a LOCO-scope target (which LOCO gets the new station).
  const [addWsPanel,  setAddWsPanel]  = useState<EditTarget | null>(null)
  // Transient message for a manual-swap that couldn't run (not MX10 / interleaved WS / no WS pair).
  // Imperative handle into the Schedule's GanttTable for single-LOCO visual patches.
  const ganttTableRef = useRef<GanttTableHandle>(null)

  // Keep the (in-memory) persistence snapshot mirroring the LIVE override map, so EVERY active edit
  // — including Move Mode / arrow-key edits, not just the panel's "Salvar" — survives a modal close
  // and reopen (loadOverrides reads this snapshot on mount). Reset → {} snapshots {} too, so a reset
  // truly clears persistence. Tab navigation already keeps the React state; this covers reopen.
  useEffect(() => { snapshotOverrides(locoOverrides) }, [locoOverrides])
  useEffect(() => { snapshotProjOverrides(projOverrides) }, [projOverrides])

  // On first mount, pull the saved (DB) overrides for the base schedule so edits persist across
  // full reloads / other sessions. Only adopt them while the live map is still empty (no edits made
  // yet this session) so an in-flight fetch can never clobber a fresh edit. Runs once.
  // Previously-hydrated scenario key (null until the first hydrate). Used to tell an INITIAL load
  // (keep the safe merge-under-session-edits behaviour) apart from a scenario SWITCH (the previous
  // scenario's edits must NOT bleed into the new one — reset and load the new scenario's saved set).
  const prevScenarioRef = useRef<string | null>(null)
  // Saved overrides that still need to be PAINTED onto the Schedule iframe after a reload. Setting
  // `locoOverrides` alone is not enough: the worker only reads overrides at BUILD time, and the first
  // build can finish before OR after the async hydrate resolves — so without an explicit repaint the
  // Schedule would render base data even though the edits are loaded. Cleared once applied.
  const [hydratedOverrides, setHydratedOverrides] = useState<LocoOverrideMap | null>(null)
  // Per-scenario persistence: edits load/save under the ACTIVE scenario identity (its name; '' = base
  // DB schedule). Re-runs when the scenario changes so each scenario restores its OWN saved edits and
  // one scenario's edits never affect another. `setActiveScenario` resets the module's hydration cache.
  const overrideScenarioKey = scenarioActive && scenarioName ? scenarioName : ''
  useEffect(() => {
    const isSwitch = prevScenarioRef.current !== null && prevScenarioRef.current !== overrideScenarioKey
    prevScenarioRef.current = overrideScenarioKey
    setActiveScenario(overrideScenarioKey)
    // On a real switch, drop the previous scenario's working edits AND any live optimization overlay
    // before loading this one's — otherwise the previous scenario's optimized bars would flash on the
    // new one. (A SAVED optimization is baked into that scenario's overrides, so it reloads normally.)
    if (isSwitch) {
      setLocoOverrides({}); setProjOverrides({}); setHydratedOverrides({})
      setOptimizedData(null); setActiveOptMode(null)
      setSaturdayWorkdays([]); setSavedSaturday([])
      setProjBaselines([])   // clear the old scenario's frozen reference history before loading this one's
    }
    let cancelled = false
    // Shared Projeção reference history for this scenario (DB). Empty = none frozen yet.
    hydrateProjectionBaselinesFromDb(overrideScenarioKey).then(v => { if (!cancelled) setProjBaselines(v) }).catch(() => {})
    // Working-Saturday set for this scenario (applied client-side to date_info). Independent of the
    // override hydrate; a failure just means no working Saturdays (folded), never a broken schedule.
    hydrateSaturdayWorkdays().then(sats => { if (!cancelled) { setSaturdayWorkdays(sats); setSavedSaturday(sats) } }).catch(() => {})
    hydrateProjOverridesFromDb().then(saved => {
      if (cancelled) return
      projSavedBaselineRef.current = getProjSavedBaseline()
      setProjSavedVersion(v => v + 1)
      // Same guard as the standard layer: adopt the DB copy only under edits already made this
      // session (a switch replaces outright), so a slow load can never discard a fresh edit.
      if (saved && Object.keys(saved).length > 0) {
        const nextProj = (isSwitch || Object.keys(projOverridesRef.current).length === 0)
          ? saved : mergeOverrideMaps(saved, projOverridesRef.current)
        setProjOverrides(nextProj)
        // Queue the same one-time iframe repaint the standard layer gets — but only while Projeção is
        // the active mode, since that is the only mode whose displayed schedule includes this layer.
        // The worker reads overrides at BUILD time, so without this the hydrated projection edits
        // would sit in state unpainted until the next rebuild.
        if (refModeRef.current === 'working') {
          setHydratedOverrides(mergeOverrideMaps(loadOverrides(), nextProj))
        }
      }
    }).catch(() => {})
    hydrateOverridesFromDb().then(saved => {
      if (cancelled) return
      // The DB state is now the saved baseline (so the counter reflects only edits made since).
      savedBaselineRef.current = getSavedBaseline()
      setSavedVersion(v => v + 1)
      if (saved && Object.keys(saved).length > 0) {
        // INITIAL load → merge saved UNDER any edits already made this session (edits win) so a slow
        // load never discards them. SWITCH → replace, since those edits belonged to the old scenario.
        setLocoOverrides(prev => (isSwitch || Object.keys(prev).length === 0 ? saved : mergeOverrideMaps(saved, prev)))
        setHydratedOverrides(saved)   // queue the one-time repaint of the live iframe
      }
    }).catch(() => { /* offline / no DB → keep in-memory */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideScenarioKey])

  // "Atualizar referência": freeze the CURRENT schedule as a NEW Projeção baseline VERSION (DB append).
  // Gated by the ADMIN second factor (NOT the import password): `triggerUnlock` ensures a valid
  // X-Admin-Unlock grant (prompting for ADMIN_PASSWORD via the shared UnlockModal when needed); the api
  // interceptor also re-prompts on a 401. Incremental deviations reset to zero and grow again from here
  // for everyone, while the prior versions (and the cumulative deviation vs version 0) are preserved.
  // Independent of Save (which persists the working overrides). Flow: confirm → admin unlock → append →
  // re-hydrate.
  async function runUpdateProjectionRef(): Promise<void> {
    const snap = JSON.parse(JSON.stringify(locoOverrides)) as LocoOverrideMap
    const ok = await triggerUnlock()          // ADMIN_PASSWORD second factor; false = cancelled / locked out
    if (!ok) return
    setProjRefError(null)
    setProjRefSaveState('saving')
    try {
      await saveProjectionBaselineToDb(overrideScenarioKey, snap)
      // Re-hydrate the full history so version indices, timestamps and author match the DB (and any
      // lazy version-0 seeding from a legacy snapshot is reflected). projectionRef re-derives from it.
      const versions = await hydrateProjectionBaselinesFromDb(overrideScenarioKey)
      setProjBaselines(versions)
      setProjRefSaveState('saved')
      setTimeout(() => setProjRefSaveState(s => (s === 'saved' ? 'idle' : s)), 2500)
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } }; message?: string }
      const status = err?.response?.status
      const detail = err?.response?.data?.detail
      console.error('[gantt] update projection ref failed', { status, detail, error: e })
      setProjRefError(
        status === 401 ? 'Desbloqueio administrativo necessário (senha de administrador).'
          : status ? `Falha ao atualizar (HTTP ${status})${detail ? `: ${detail}` : ''}.`
          : `Sem resposta do servidor${err?.message ? ` (${err.message})` : ''}. Verifique a conexão com o backend.`,
      )
      setProjRefSaveState('error')
    }
  }
  function retryUpdateProjectionRef() { setProjRefSaveState('idle'); setProjRefError(null); runUpdateProjectionRef() }

  // Paint the hydrated (DB) overrides onto the Schedule iframe once BOTH the worker has built the
  // table AND the overrides have arrived — whichever happens last. Depends on both so it fires under
  // either ordering; runs once (clears `hydratedOverrides`). If the build already applied them
  // (hydrate resolved first), this surgical re-patch of the same locos is a harmless no-op-equivalent.
  useEffect(() => {
    if (!hydratedOverrides || !ganttTableRef.current) return
    // Gate on an ACTUAL completed build (ganttBuiltRef), not `tableBuilt` (which starts true before
    // any build). `builtNonce` re-runs this when a build finishes, so it fires under either ordering:
    // hydrate-then-build (build's own overridesRef paints; this re-patch is a harmless no-op) or
    // build-then-hydrate (this paints). Without a real build the worker has no cachedData → patch is
    // a silent no-op that would wrongly clear the queue, so we wait.
    if (!ganttBuiltRef.current) return
    if (Object.keys(hydratedOverrides).length === 0) { setHydratedOverrides(null); return }
    ganttTableRef.current.patchLocos(hydratedOverrides)
    setHydratedOverrides(null)
  }, [hydratedOverrides, builtNonce])

  const locoKeyForTarget = (t: EditTarget) =>
    locoKeyOf({ linha: t.linha, wo: t.wo, task_name: t.taskName, start_ms: t.startMs })

  const scopedFrom = (takt: number | null, startShift: number | null, finishShift: number | null, propagate: boolean, notes?: MoveNote[], satManual?: boolean, swap?: boolean, hoursTotal?: number | null, swapShift?: ScopedEdit['swapShift'] | null, parallelStarts?: boolean, removeGaps?: boolean, satDays?: string[]): ScopedEdit => {
    const e: ScopedEdit = {}
    if (takt != null) e.takt = takt
    if (startShift) e.startShiftDays = startShift
    if (finishShift) e.finishShiftDays = finishShift
    if (propagate) e.propagate = true
    if (notes?.length) e.notes = notes
    if (satManual) e.satManual = true
    // The committed working-Saturday licence. An empty array clears it (a move off every Saturday), so
    // only a non-empty list is stored.
    if (satDays && satDays.length) e.satDays = satDays
    if (swap) e.swap = true
    if (hoursTotal != null) e.hoursTotal = hoursTotal
    // Only meaningful alongside `swap`; an un-swap passes null and drops it with the marker.
    if (swap && swapShift) e.swapShift = swapShift
    // Only the opt-OUT is stored: ON is the default, so `true`/undefined leave the field absent and
    // an override saved before this feature existed reads as ON without any migration.
    if (parallelStarts === false) e.parallelStarts = false
    // Mirror image of the line above: OFF is the default here, so only the opt-IN is stored.
    if (removeGaps) e.removeGaps = true
    return e
  }

  // The scoped edit currently stored for this target (for panel prefill).
  function scopedEditOf(t: EditTarget): ScopedEdit | LocoVisualOverride | undefined {
    const ov = activeOverrides[locoKeyForTarget(t)]
    if (!ov) return undefined
    if (t.scope === 'loco') return ov
    if (t.scope === 'ws')   return ov.ws?.[wsEditKeyOf(t.ws ?? '')]
    return ov.desc?.[descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? '')]
  }

  // Write one scoped edit into a LOCO override object (pure; returns the updated override). Shared by
  // the single-edit and batch appliers so they stay byte-for-byte consistent. null fields = "no
  // change for that dimension"; an empty scoped edit drops its nested entry.
  // `notes` (move descriptions) and `satManual` (Move Mode's working-Saturday permission) are
  // CARRIED FORWARD when the caller passes none: every write here rebuilds the scoped edit from
  // scratch, so without this any later edit of the same box — another move, a panel save — would
  // silently erase why it was moved, or bounce it off a Saturday a planner deliberately chose.
  // `satManual` is additive (once granted by a Move Mode edit it stays with the box's edit);
  // clearing the box's edit still drops both, since an empty scoped edit deletes the whole entry
  // (see isEmptyScopedEdit).
  // `swap` is normally additive (once a station is marked as swapped the flag rides along), but an
  // explicit `false` CLEARS it — that is how un-swapping drops the marker without having to delete the
  // whole scoped edit and every unrelated edit stored on it. `swapShift` follows the same lifecycle.
  // `inherit` is the layer BENEATH this one (Projeção only — see the layer seam above). When the
  // write layer has no entry yet for the object being edited, the rider fields are carried forward
  // from `inherit` instead of being lost: a projection move over a Standard-swapped workstation must
  // keep its swap marker/swapShift, its move notes and its hours override, or the delay maths and the
  // reason trail would silently reset the first time the object is touched in Projeção.
  // `satDays` (the committed working-Saturday licence) is carried forward when the caller passes
  // `undefined` (like notes/satManual — a later panel save must not bounce a box off a Saturday), and
  // REPLACED when passed explicitly (a Move-Mode commit always recomputes it; `[]` clears it).
  function writeScopedEdit(curIn: LocoVisualOverride, t: EditTarget, takt: number | null, startShift: number | null, finishShift: number | null, propagate: boolean, notes?: MoveNote[], satManual?: boolean, swap?: boolean, hoursTotal?: number | null, swapShift?: ScopedEdit['swapShift'] | null, parallelStarts?: boolean, inherit?: LocoVisualOverride | null, removeGaps?: boolean, satDays?: string[]): LocoVisualOverride {
    const cur: LocoVisualOverride = { ...curIn }
    if (cur.ws) cur.ws = { ...cur.ws }
    if (cur.desc) cur.desc = { ...cur.desc }
    if (t.scope === 'loco') {
      if (takt != null) cur.takt = takt; else delete cur.takt
      if (startShift) cur.startShiftDays = startShift; else delete cur.startShiftDays
      if (finishShift) cur.finishShiftDays = finishShift; else delete cur.finishShiftDays
    } else if (t.scope === 'ws') {
      const wsIn = { ...(cur.ws || {}) }
      const k = wsEditKeyOf(t.ws ?? '')
      // Seed from the layer beneath when this layer hasn't got the object yet.
      const ws = (k in wsIn) ? wsIn : (inherit?.ws?.[k] ? { ...wsIn, [k]: inherit.ws[k] } : wsIn)
      const keepSwap = swap === false ? false : (swap || ws[k]?.swap)
      const nextSatDays = satDays === undefined ? ws[k]?.satDays : (satDays.length ? satDays : undefined)
      // LEGACY-SWAP NORMALIZATION. A swap saved before `swapShift` existed carries only the flag, so the
      // delay maths treat the station's WHOLE shift as the trade — and a swap that is later MOVED reports
      // no delay at all (the reference sits at the moved position, hatch/badge vanish: issue #4/#6). The
      // first time such a station is written, record its PRE-EDIT shift as the trade's own contribution;
      // the new shift then decomposes into trade (swapShift) + move, and the move hatches normally. A
      // modern swap already carries swapShift and is untouched; an un-swap clears it (swapShift === null).
      let nextSwapShift = swapShift === null ? null : (swapShift ?? ws[k]?.swapShift)
      if (keepSwap && !nextSwapShift && (ws[k]?.startShiftDays || ws[k]?.finishShiftDays)) {
        nextSwapShift = { start: ws[k]?.startShiftDays ?? 0, finish: ws[k]?.finishShiftDays ?? 0 }
      }
      const edit = scopedFrom(
        takt, startShift, finishShift, propagate, notes ?? ws[k]?.notes,
        satManual || ws[k]?.satManual, keepSwap, hoursTotal ?? ws[k]?.hoursTotal,
        nextSwapShift,
        parallelStarts ?? ws[k]?.parallelStarts, removeGaps ?? ws[k]?.removeGaps, nextSatDays,
      )
      if (isEmptyScopedEdit(edit)) delete ws[k]; else ws[k] = edit
      if (Object.keys(ws).length) cur.ws = ws; else delete cur.ws
    } else {
      const descIn = { ...(cur.desc || {}) }
      const k = descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? '')
      const desc = (k in descIn) ? descIn : (inherit?.desc?.[k] ? { ...descIn, [k]: inherit.desc[k] } : descIn)
      // hoursTotal is passed EXPLICITLY (like takt/shift, NOT inherited): the panel defines the full
      // Componente state, so toggling "Horas" off clears it and "Remover edição"/reset drops it. The
      // The Move-Mode commit (resolveMoveProp) re-passes the stored hoursTotal so a nudge never wipes it.
      const nextSatDaysD = satDays === undefined ? desc[k]?.satDays : (satDays.length ? satDays : undefined)
      const edit = scopedFrom(takt, startShift, finishShift, propagate, notes ?? desc[k]?.notes, satManual || desc[k]?.satManual, swap || desc[k]?.swap, hoursTotal, null, parallelStarts ?? desc[k]?.parallelStarts, removeGaps ?? desc[k]?.removeGaps, nextSatDaysD)
      if (isEmptyScopedEdit(edit)) delete desc[k]; else desc[k] = edit
      if (Object.keys(desc).length) cur.desc = desc; else delete cur.desc
    }
    return cur
  }

  // (The single-edit `applyScopedEdit` wrapper is gone: its only remaining caller was
  // clearScopedEdit, which must DELETE rather than write an all-null edit. Every write goes
  // through applyScopedEdits/commitScopedEdits below, which fold one or many edits identically.)

  // Apply MANY scoped edits in one shot. Multi-row Move Mode edits several rows of the SAME LOCO at
  // once; doing that with N sequential applyScopedEdit calls would clobber siblings (each reads the
  // pre-batch override). This folds every edit into one accumulated map, updates state once, and
  // patches each touched LOCO a single time. Each row keeps its OWN scope/key, so the worker still
  // recalculates every row independently with its existing scheduling rules.
  type ScopedEditItem = { target: EditTarget; takt: number | null; startShift: number | null; finishShift: number | null; propagate: boolean; notes?: MoveNote[]; satManual?: boolean; swap?: boolean; hoursTotal?: number | null; swapShift?: ScopedEdit['swapShift'] | null; parallelStarts?: boolean; removeGaps?: boolean; satDays?: string[] }

  // Fold `items` onto an EXPLICIT base map (not necessarily the current `locoOverrides`), commit the
  // result, patch the touched locos, and RETURN the new map. Taking the base explicitly lets the
  // Global-propagation flow chain a second commit onto the post-primary map across the async worker
  // round-trip WITHOUT hitting a stale `locoOverrides` closure (the cascade base = the primary result).
  // `base` is the map of the layer being WRITTEN (Standard, or Projeção in Projeção mode). The
  // returned map belongs to that same layer, so a caller chaining commits (Global propagation) stays
  // on one layer throughout.
  /** The map these edits WOULD produce, without touching state or the iframe.
   *
   *  Split out of `commitScopedEdits` so a caller can try an edit, measure what the worker makes of
   *  it, and only then commit — which is what the WS40↔WS50 swap does to land its two stations on
   *  exact target slots (see swapWorkstationFromMenu). Same writeScopedEdit, same inherit layer, so a
   *  trial map and the committed one can never disagree. */
  function nextOverrideMap(base: LocoOverrideMap, items: ScopedEditItem[]): LocoOverrideMap {
    const next: LocoOverrideMap = { ...base }
    for (const it of items) {
      const key = locoKeyForTarget(it.target)
      next[key] = writeScopedEdit(next[key] || {}, it.target, it.takt, it.startShift, it.finishShift, it.propagate, it.notes, it.satManual, it.swap, it.hoursTotal, it.swapShift, it.parallelStarts, inheritOverrides?.[key], it.removeGaps, it.satDays)
    }
    return next
  }

  function commitScopedEdits(base: LocoOverrideMap, items: ScopedEditItem[], persist = false): LocoOverrideMap {
    if (!items.length) return base
    const next = nextOverrideMap(base, items)
    const touched = new Set<string>()
    for (const it of items) touched.add(locoKeyForTarget(it.target))
    const patch: LocoOverrideMap = {}
    for (const key of touched) {
      if (isEmptyOverride(next[key])) { delete next[key]; patch[key] = {} }   // {} re-renders base
      else patch[key] = next[key]
    }
    // The iframe renders the COMPOSED schedule, so in Projeção each patched loco must be re-composed
    // over its Standard entry: a projection edit that clears itself has to reveal the Standard edit
    // beneath it, not the untouched base row.
    if (isProjection) {
      for (const key of touched) {
        const merged = mergeOverrideMaps({ [key]: locoOverrides[key] ?? {} }, { [key]: next[key] ?? {} })[key] ?? {}
        patch[key] = isEmptyOverride(merged) ? {} : merged
      }
    }
    setActiveOverrides(next)
    if (persist) (isProjection ? snapshotProjOverrides : snapshotOverrides)(next)
    ganttTableRef.current?.patchLocos(patch)
    return next
  }

  function applyScopedEdits(items: ScopedEditItem[], persist = false): LocoOverrideMap {
    return commitScopedEdits(writeOverrides, items, persist)
  }

  // ── Global propagation (Propagar efeitos: Global) ──────────────────────────────────────────────
  // Runs AFTER the primary edit is committed (which already did Local propagation inside the edited
  // loco). For each edited workstation, asks the worker to follow that ONE WS through the subsequent
  // same-Type / same-line locos and return the per-loco shift needed to clear the overlap (or recover
  // a delay), PD-bounded. Each returned move is committed as a WS-scope `startShiftDays` +
  // `propagate:true` on that loco's own WS string — reusing Local propagation so the WS and everything
  // downstream inside that loco shifts. Committed as its own step against the post-primary map so the
  // async worker round-trip never clobbers the primary edit. EVERY workstation is eligible (the rank
  // list no longer gates this); WS40/WS50 additionally cascade across Type and Main↔Special, being one
  // shared physical resource. A loco that doesn't occupy the WS is skipped, so the scope self-limits.
  //
  // ── Sub-options (the arrow next to "Global" — lib/globalPropOptions) ─────────────────────────
  //   • advance  — passed to the worker: close gaps, so an ADVANCE ripples forward the same way a
  //                delay does. Everything else about the commit is unchanged.
  //   • singleWs — commit WITHOUT adding `propagate`, so only that workstation moves on each
  //                downstream loco. Never REVOKES propagation a station already carries: that is
  //                the same rule the "Não" answer follows, and dropping a committed propagate here
  //                would silently undo an earlier decision the user made about that row.
  //   • duration — the edited workstation's duration delta (its WS-scope `finishShiftDays`, which
  //                IS a duration change, not an absolute finish) is written onto the SAME
  //                workstation of every other loco that runs it. Applied FIRST, in its own commit,
  //                so the cascade that follows measures overlaps against the new durations rather
  //                than the old ones. Implies singleWs (enforced in the store).
  async function runGlobalCascade(baseMap: LocoOverrideMap, editedKey: string, editedWsList: string[], persist = false) {
    const handle = ganttTableRef.current
    if (!handle || !editedKey || !editedWsList.length) return
    const opts = getGlobalPropOptions()
    let map = baseMap

    if (opts.duration) {
      // Pass 1 — duration only. `wsLocos` comes from a cascade probe against the CURRENT map; only
      // its membership list is used here, the moves it also computed are discarded and recomputed
      // below against the post-duration map.
      const durItems: ScopedEditItem[] = []
      for (const ws of editedWsList) {
        const editedDur = map[editedKey]?.ws?.[wsEditKeyOf(ws)]?.finishShiftDays ?? null
        if (editedDur == null) continue          // this workstation's duration was not changed
        let wsLocos: { key: string; ws: string }[] = []
        try { ({ wsLocos } = await handle.computeGlobalCascade(editedKey, ws, map, scheduleHatchReference, opts.advance)) }
        catch { wsLocos = [] }
        for (const l of wsLocos) {
          const parts = l.key.split('||')
          if (parts.length < 4) continue
          const [linha, wo, taskName, startMs] = parts
          const prev = map[l.key]?.ws?.[wsEditKeyOf(l.ws)]
          if ((prev?.finishShiftDays ?? null) === editedDur) continue   // already at that duration
          durItems.push({
            target: { scope: 'ws', linha, wo, taskName, startMs, ws: l.ws, takt: null },
            takt: prev?.takt ?? null, startShift: prev?.startShiftDays ?? null,
            finishShift: editedDur, propagate: prev?.propagate ?? false,
            notes: prev?.notes, hoursTotal: prev?.hoursTotal ?? null,
          })
        }
      }
      if (durItems.length) map = commitScopedEdits(map, durItems, persist)
    }

    const items: ScopedEditItem[] = []
    for (const ws of editedWsList) {
      let moves: { key: string; shift: number; ws: string }[] = []
      try { ({ moves } = await handle.computeGlobalCascade(editedKey, ws, map, scheduleHatchReference, opts.advance)) }
      catch { moves = [] }
      for (const m of moves) {
        const parts = m.key.split('||')
        if (parts.length < 4) continue
        const [linha, wo, taskName, startMs] = parts
        // Shift is a DELTA from the loco's current position; the WS-scope startShiftDays is ABSOLUTE,
        // so fold it onto whatever loco-WS shift already exists in the (post-primary) base map.
        //
        // Every OTHER dimension the touched station already carries must be carried through unchanged:
        // this cascade only repositions a workstation, it is not an edit of its duration, takt or hours.
        // Passing them as null wrote a fresh scoped edit with those fields absent, so a Global
        // propagation silently reset the duration/takt/hours of every downstream station it moved.
        // Read from `map`, not the original baseMap: with "Propagar Duração" on, the duration pass
        // above already wrote to these same stations, and folding the shift onto a stale entry
        // would drop that write.
        const prev = map[m.key]?.ws?.[wsEditKeyOf(m.ws)]
        const existing = prev?.startShiftDays ?? 0
        const newStart = existing + m.shift
        items.push({
          target: { scope: 'ws', linha, wo, taskName, startMs, ws: m.ws, takt: null },
          takt: prev?.takt ?? null, startShift: newStart || null,
          finishShift: prev?.finishShiftDays ?? null,
          // "Propagar WS Única": move this workstation alone. Whatever propagation the station
          // already carried stays — declining to ADD it is not the same as revoking it.
          propagate: opts.singleWs ? (prev?.propagate ?? false) : true,
          notes: prev?.notes, hoursTotal: prev?.hoursTotal ?? null,
        })
      }
    }
    if (items.length) commitScopedEdits(map, items, persist)
  }

  // "Remover edição" — clear just this target's scope.
  //
  // DELETES the scope's entry outright instead of writing an all-null edit through writeScopedEdit.
  // That path deliberately CARRIES metadata forward when a caller passes `undefined` (notes,
  // satManual, satDays, hoursTotal and — decisively — `swap`/`swapShift`/`satNever`), which is right
  // for an edit and wrong for a reset: isEmptyScopedEdit treats swap/swapShift/satNever as real
  // changes, so the "cleared" entry survived, kept displacing the station, and kept producing
  // deviation records after a Save. Deleting makes the reset complete by construction — the same
  // reason resetWorkstationFromMenu deletes rather than clears.
  function clearScopedEdit(t: EditTarget) { deleteScopedEdit(t) }

  /** Drop this target's scope entry from the active layer entirely, then repaint just this LOCO.
   *  Shared by every reset entry point (menu "Resetar …", the panel's "Remover edição"). */
  function deleteScopedEdit(t: EditTarget) {
    const key = locoKeyForTarget(t)
    const cur = writeOverrides[key]
    if (!cur) return
    const next: LocoVisualOverride = { ...cur }
    if (t.scope === 'loco') {
      // LOCO scope owns only these three fields; its ws/desc children have their own resets.
      delete next.takt; delete next.startShiftDays; delete next.finishShiftDays
    } else if (t.scope === 'ws') {
      const w = { ...(next.ws ?? {}) }
      delete w[wsEditKeyOf(t.ws ?? '')]
      if (Object.keys(w).length) next.ws = w; else delete next.ws
    } else {
      const d = { ...(next.desc ?? {}) }
      delete d[descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? '')]
      if (Object.keys(d).length) next.desc = d; else delete next.desc
    }
    const empty = isEmptyOverride(next)
    setActiveOverrides(prev => {
      const out = { ...prev }
      if (empty) delete out[key]; else out[key] = next
      return out
    })
    // Projeção: re-compose over Standard so clearing a projection edit reveals the Standard one.
    const shown = isProjection
      ? (mergeOverrideMaps({ [key]: locoOverrides[key] ?? {} }, { [key]: empty ? {} : next })[key] ?? {})
      : (empty ? {} : next)
    ganttTableRef.current?.patchLocos({ [key]: isEmptyOverride(shown) ? {} : shown })
  }

  // ── "Adicionar Workstation" — manually-inserted station (see AddedWorkstation / addWs) ────────────
  // Writes an `addWs` entry into the active layer's override for the LOCO, then patches just that LOCO.
  // The worker's applyOverrideToGroup injects it into the group before every other pass, so it flows
  // into the Gantt render AND (via computeEffective → mergedData → summarySource) the Plano de Produção
  // with no extra plumbing. Mirrors commitScopedEdits' patch/Projeção-recompose logic.
  function _patchLoco(next: LocoOverrideMap, key: string, persist: boolean) {
    const patch: LocoOverrideMap = {}
    if (isEmptyOverride(next[key])) { delete next[key]; patch[key] = {} }   // {} re-renders base
    else patch[key] = next[key]
    if (isProjection) {
      const merged = mergeOverrideMaps({ [key]: locoOverrides[key] ?? {} }, { [key]: next[key] ?? {} })[key] ?? {}
      patch[key] = isEmptyOverride(merged) ? {} : merged
    }
    setActiveOverrides(next)
    if (persist) (isProjection ? snapshotProjOverrides : snapshotOverrides)(next)
    ganttTableRef.current?.patchLocos(patch)
  }
  function commitAddedWorkstation(target: EditTarget, entry: AddedWorkstation, propagate = true, persist = true) {
    const key = locoKeyForTarget(target)
    const prev = writeOverrides[key] || {}
    const wsKey = wsEditKeyOf(entry.ws)
    const addWs = { ...(prev.addWs ?? {}), [wsKey]: entry }
    // "Propagar efeitos imediatamente" — the station is an INSERTION, so the work that has to clear it
    // moves. The flag lives on the addWs ENTRY, not in a ws-scope edit: a scoped edit carrying nothing
    // but `propagate` counts as EMPTY (isEmptyScopedEdit) and would be dropped on the next save, and
    // the station keeps NO shift of its own anyway — it stays anchored to the typed date, since
    // creation must never generate its own delay. The worker turns the flag into the insertion push:
    // exactly as far as the first follower must travel to clear the new station, and 0 when it already
    // does. Downstream then cascades through the normal machinery, so Protection Days, parallel starts
    // and post-PD anchoring all still apply.
    if (propagate) addWs[wsKey] = { ...entry, propagate: true }
    const next: LocoOverrideMap = { ...writeOverrides, [key]: { ...prev, addWs } }
    _patchLoco(next, key, persist)
  }
  // Remove a manually-added station: drop its addWs entry AND any ws/desc edits keyed to it, so the
  // station and everything the planner did to it disappear together.
  function removeAddedWorkstation(target: EditTarget, persist = true) {
    const key = locoKeyForTarget(target)
    const wsKey = target.ws ? wsEditKeyOf(target.ws) : ''
    const cur = writeOverrides[key]
    if (!wsKey || !cur?.addWs?.[wsKey]) { setEditMenu(null); return }
    const prev: LocoVisualOverride = { ...cur }
    const addWs = { ...(prev.addWs ?? {}) }; delete addWs[wsKey]
    if (Object.keys(addWs).length) prev.addWs = addWs; else delete prev.addWs
    if (prev.ws?.[wsKey]) { const w = { ...prev.ws }; delete w[wsKey]; if (Object.keys(w).length) prev.ws = w; else delete prev.ws }
    if (prev.desc) {
      const d = { ...prev.desc }
      for (const dk of Object.keys(d)) if (dk.startsWith(`${target.ws}||`)) delete d[dk]
      if (Object.keys(d).length) prev.desc = d; else delete prev.desc
    }
    const next: LocoOverrideMap = { ...writeOverrides, [key]: prev }
    _patchLoco(next, key, persist)
    setEditMenu(null)
  }
  // True when the clicked station is a manually-added one (so the menu can offer "Remover Workstation").
  function isAddedWs(t: EditTarget): boolean {
    if (!t.ws) return false
    return !!writeOverrides[locoKeyForTarget(t)]?.addWs?.[wsEditKeyOf(t.ws)]
  }
  /** The manually-added station a target refers to, read from the COMPOSED map so a station added in
   *  Standard is still recognised while editing Projeção (same layer rule as scopedEditOf). READ ONLY —
   *  writes must still go to writeOverrides. */
  function addedWsOf(t: EditTarget): AddedWorkstation | null {
    if (!t.ws) return null
    return activeOverrides[locoKeyForTarget(t)]?.addWs?.[wsEditKeyOf(t.ws)] ?? null
  }
  /** Rewrite a manually-added station's TOTAL HOURS on `base`, returning the new map (PURE, so the
   *  caller can fold it into the same commit as the panel's other fields instead of racing it).
   *
   *  A manual station's hours are AUTHORED — they live on the addWs entry and the worker spreads them
   *  across its day-boxes — not derived from a routing, so they are edited at the source rather than
   *  through a desc-scope `hoursTotal` override: that one SCALES the existing hours by
   *  newTotal/baseTotal and so can never move a station off 0 h, which is exactly how a freshly
   *  created manual station starts. Writes into the WRITE layer, so in Projeção the edit lands there
   *  and Standard keeps its own value; the entry is composed over the layer beneath so a Projeção edit
   *  of a station added in Standard carries the whole entry across, not just its hours. */
  function withAddedWsHours(base: LocoOverrideMap, t: EditTarget, hours: number): LocoOverrideMap {
    const key = locoKeyForTarget(t)
    const wsKey = t.ws ? wsEditKeyOf(t.ws) : ''
    const src = wsKey ? (base[key]?.addWs?.[wsKey] ?? activeOverrides[key]?.addWs?.[wsKey]) : null
    if (!src) return base
    const prev = base[key] ?? {}
    return {
      ...base,
      [key]: { ...prev, addWs: { ...(prev.addWs ?? {}), [wsKey]: { ...src, hoursTotal: Math.max(0, hours) } } },
    }
  }
  // Workstation names already on this LOCO (base data + already-added), for the dialog's uniqueness check.
  function existingWsNamesForLoco(t: EditTarget): string[] {
    const key = locoKeyForTarget(t)
    const names = new Set<string>()
    for (const g of (effectiveDataRef.current?.groups ?? [])) {
      if (locoKeyOf(g) !== key) continue
      for (const w of g.workstations) names.add(String(w.ws))
    }
    const add = writeOverrides[key]?.addWs
    if (add) for (const k of Object.keys(add)) names.add(add[k].ws)
    return [...names]
  }
  /** Áreas already in use anywhere in the schedule, for the Add-Workstation picker. Collected across
   *  the WHOLE dataset (not just this LOCO) because a planner inserting a station usually wants to file
   *  it under an área the plant already knows, and a LOCO may not yet use it. Manually-added stations
   *  are included via effectiveData, so a new área is offered to the next station right away. */
  function existingAreasForPicker(): string[] {
    const set = new Set<string>()
    for (const g of (effectiveDataRef.current?.groups ?? []))
      for (const w of g.workstations) { const a = String(w.area ?? '').trim(); if (a) set.add(a) }
    return [...set]
  }
  function openAddWorkstation(t: EditTarget) { setEditMenu(null); setAddWsPanel(t) }

  // ── Workstation ↔ Componente expand/collapse ──────────────────────────────────────────────
  const wsExpandKeyOf = (i: { linha: string; wo: string; taskName: string; startMs: string; ws: string; subarea: string }) =>
    `${i.linha}||${i.wo}||${i.taskName}||${i.startMs}||${i.ws}||${i.subarea}`
  // Only caller was the removed Move-Mode auto-expand path (+/− now resizes a collapsed workstation
  // directly). Kept as the tier's read accessor next to wsExpandKeyOf.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isWsExpanded = (key: string) => (wsExpandExc.has(key) ? !wsExpandBase : wsExpandBase)

  // Re-render ONE LOCO's tbody with the given (fresh) expansion state — either tier's toggle
  // routes through here (pass the CURRENT sets for the tier that didn't change). The loco's
  // CURRENT override must ride along — `{}` would wrongly reset its visual edits to base.
  function patchLocoExpansion(locoKey: string, exceptions: ReadonlySet<string>, locoExceptions?: ReadonlySet<string>) {
    ganttTableRef.current?.patchLocos(
      { [locoKey]: activeOverrides[locoKey] ?? {} },
      { base: wsExpandBase, exceptions, locoBase: locoExpandBase, locoExceptions: locoExceptions ?? locoExpandExc },
    )
  }

  // Chevron click on a workstation row → flip just that WS for that locomotive.
  function toggleWsExpand(info: { wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string }) {
    const key = wsExpandKeyOf(info)
    const next = new Set(wsExpandExc)
    if (next.has(key)) next.delete(key); else next.add(key)
    setWsExpandExc(next)
    patchLocoExpansion(`${info.linha}||${info.wo}||${info.taskName}||${info.startMs}`, next)
  }

  // Bulk actions (the former FULL/WORK buttons). Setting base + clearing exceptions + bumping
  // wsExpandBulk changes the Schedule buildKey → in-place rebuild with the new state. Asking
  // for the tree also expands every LOCO (the tier above), so FULL/WORK always land on the
  // exact historical views.
  function setAllWsExpanded(expanded: boolean) {
    setAllLocosExpanded(true)
    if (wsExpandBase === expanded && wsExpandExc.size === 0) return   // already exactly there
    setWsExpandBase(expanded)
    setWsExpandExc(new Set<string>())
    setWsExpandBulk(n => n + 1)
  }
  const wsExpandSummary: 'all' | 'none' | 'mixed' =
    wsExpandExc.size > 0 ? 'mixed' : (wsExpandBase ? 'all' : 'none')

  // ── LOCO ↔ Workstation expand/collapse (the tier above) ───────────────────────────────────
  // Chevron click on a LOCO's frozen LINHA cell → flip just that LOCO between its summary row
  // and its Workstation ↔ Componente tree. The WS-tier state is untouched: it stays dormant
  // under a collapsed LOCO and reappears exactly as it was on re-expand.
  function toggleLocoExpand(info: { wo: string; taskName: string; linha: string; startMs: string }) {
    const key = `${info.linha}||${info.wo}||${info.taskName}||${info.startMs}`
    const next = new Set(locoExpandExc)
    if (next.has(key)) next.delete(key); else next.add(key)
    setLocoExpandExc(next)
    patchLocoExpansion(key, wsExpandExc, next)
  }

  // Bulk action (the footer LOCO button = collapse all; FULL/WORK imply expand all). Note the
  // narrow compact layout (WS column width-0) applies ONLY in the exact all-collapsed state
  // (base=false, no exceptions) — collapsing every LOCO one by one keeps the 220px column,
  // by design: "all collapsed" must be a table-global fact, and only the bulk path knows it.
  function setAllLocosExpanded(expanded: boolean) {
    // Collapsing every LOCO (the "full retract" LOCO view) ALSO retracts the WS tier to summary
    // rows: expanding a single LOCO afterwards then reveals its Workstations, never drilling straight
    // to Componentes — which a leftover FULL-mode wsExpandBase=true would otherwise do. (Runs before
    // the early-return so a re-collapse still normalises the WS tier.)
    if (!expanded && (wsExpandBase || wsExpandExc.size > 0)) {
      setWsExpandBase(false)
      setWsExpandExc(new Set<string>())
      setWsExpandBulk(n => n + 1)
    }
    if (locoExpandBase === expanded && locoExpandExc.size === 0) return   // already exactly there
    setLocoExpandBase(expanded)
    setLocoExpandExc(new Set<string>())
    setLocoExpandBulk(n => n + 1)
  }
  const locoExpandSummary: 'all' | 'none' | 'mixed' =
    locoExpandExc.size > 0 ? 'mixed' : (locoExpandBase ? 'all' : 'none')

  // ── Move Mode ─────────────────────────────────────────────────────────────────────────────
  // Double-click a WS/Componente box → enter Move Mode. ← → nudge ±1 business day; +/− adjust
  // duration (FULL/Componente only). Up/Down GROW a contiguous multi-row selection (Ctrl+Up/Down
  // shrink it); GanttTable owns the row ordering (DOM) and reports the current selection here. Every
  // lever writes the SAME visual-override fields manual edits use, applied to ALL selected rows, so
  // each row keeps its own scheduling/dependency/PD/propagation behavior. `dStart`/`dFinish` are the
  // shared net deltas; `orig` is each row's pre-move shift so cancel/shrink restores it exactly.
  type MoveRow = { scope: 'ws' | 'desc'; wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string; desc: string; takt: number | null }
  // `riders` are rows carried by an AUTO-EXPAND retarget (a collapsed workstation the user had
  // already moved before pressing +/−): their applied shift stays in place and is NOT stepped
  // anymore, but Escape/X still restores them to the recorded pre-move ss/fs, and the commit
  // prompt's propagate answer covers them too — so the whole operation stays one undoable unit.
  const [moveMode, setMoveMode] = useState<{
    targets: EditTarget[]                              // contiguous selection (≥1, same LOCO)
    dStart: number; dFinish: number                   // shared net deltas applied to every row
    orig: Record<string, { ss: number; fs: number; pr: boolean }>  // per-row pre-move shift + original
                                                       // propagate flag (key = moveSelKey). Used by the
                                                       // COMMIT (committed shift + net delta) and by
                                                       // recovery/rigid detection — never mutated by preview.
    durationEditable: boolean                          // +/− enabled? (Componente rows only)
    riders?: { target: EditTarget; ss: number; fs: number }[]  // pre-move restore points
    locoKey: string                                    // the moved LOCO (one selection = one LOCO)
    freezeGeom: { ws: string; subarea: string; absStart: number }[]  // FROZEN-PREVIEW pins: every station's
                                                       // absolute saved start shift (idx(saved)−idx(base)),
                                                       // snapshotted at move start. Move Mode renders the loco
                                                       // from these pins (propagate OFF) so downstream stay
                                                       // EXACTLY where they were saved while only the selected
                                                       // station moves — see paintMoveFreeze. The real override
                                                       // map is never touched during the preview.
    freezeDesc: { ws: string; subarea: string; desc: string; absStart: number }[]  // per-COMPONENTE residual
                                                       // pins: what the station pin above does NOT reproduce
                                                       // (a row moved WITHIN its workstation). Without these
                                                       // the freeze re-derived every desc row from its base
                                                       // offset, so siblings jumped and earlier component
                                                       // moves were lost/re-applied on the next drag.
    pdSlack: number | null                             // protection days left for the CURRENT selection
                                                       // (null = no limit: no buffer, or every selected
                                                       // row already sits past it). Derived from pdRows,
                                                       // recomputed whenever the selection changes.
    pdRows: Record<string, number> | null              // per-row slack for the WHOLE loco, snapshotted
                                                       // once at move start (see pdSlackForTargets) so
                                                       // growing/shrinking the selection needs no
                                                       // round-trip and can never police the move with
                                                       // a row that is no longer selected.
    pdAck?: boolean                                    // planner acknowledged the crossing warning →
                                                       // the PD limit no longer BLOCKS steps (it only
                                                       // colours the border red beyond the limit). Reset
                                                       // to false each fresh move so every move re-arms.
  } | null>(null)
  // Always-current mirror of moveMode, so the async freeze finalizer (computeMovedLocoState resolves a
  // worker round-trip later) can read the LATEST deltas/selection instead of a stale startMove closure.
  const moveModeRef = useRef(moveMode)
  moveModeRef.current = moveMode
  // Pending keystroke held back by the Protection-Days crossing warning. When a step would push the
  // move BEYOND the limit and it hasn't been acknowledged yet, we stash the keystroke here and open
  // MovePdWarningPrompt instead of applying it — "Continuar" replays it, "Parar aqui" drops it.
  const [pdWarn, setPdWarn] = useState<
    { kind: 'step' | 'dur' | 'durStart'; dir: -1 | 1; step: number } | null
  >(null)
  // Lightweight post-move prompt shown after committing a move (Enter): the move's "Descrição"
  // (why) + "Propagar efeitos?". Always centered in the Schedule view (not near the box/mouse).
  // Replaces opening the full Edit panel. null = hidden.
  // `orig` is carried over from Move Mode so the prompt's X can still undo the whole move.
  const [movePropPrompt, setMovePropPrompt] = useState<
    { targets: EditTarget[]; orig: Record<string, { ss: number; fs: number; pr: boolean }>; riders?: { target: EditTarget; ss: number; fs: number }[]; recovery?: boolean;
      dStart: number; dFinish: number   // net move deltas carried from Move Mode — the commit applies
                                        // committed-shift + delta (the preview never wrote them to the map)
      locoKey: string                   // moved LOCO, so the prompt's X can clear the frozen preview render
      overLimit?: boolean            // committed BEYOND the PD limit → stamp the note pdOverLimit (red badge)
      propagationDisabled?: boolean  // post-PD selection → hide propagation controls, force "Não"
    } | null
  >(null)
  // Open move-description bubble: the trail of a box the user clicked the indicator on, with the
  // anchor point in parent-viewport coords. null = closed; nothing renders until asked for.
  //
  // `refs` is the provenance of each displayed note, parallel to `notes` (same index). The trail is
  // CROSS-SCOPE (a WS badge merges its own trail with every Componente trail of that workstation, then
  // sorts chronologically), so the position of a note in the DISPLAYED list says nothing about where it
  // is STORED. Editing a note in place (see updateMoveNote) needs to write back into the exact scoped
  // edit and array slot it came from, which is what a NoteRef records.
  const [moveNoteView, setMoveNoteView] = useState<
    { notes: MoveNote[]; refs: NoteRef[]; locoKey: string; title: string; x: number; y: number } | null
  >(null)

  const moveTargetOf = (r: MoveRow): EditTarget => ({
    scope: r.scope, wo: r.wo, taskName: r.taskName, linha: r.linha,
    startMs: r.startMs, takt: r.takt, ws: r.ws, subarea: r.subarea, desc: r.desc,
  })
  // Stable per-row key WITHIN one LOCO (every selection shares the LOCO), used to track each row's
  // original shift for restore and to diff added/removed rows on selection change.
  const moveSelKey = (t: EditTarget) => `${t.scope}|${t.ws ?? ''}|${t.subarea ?? ''}|${t.desc ?? ''}`
  const origShiftOf = (t: EditTarget) => {
    const sc = scopedEditOf(t) as ScopedEdit | undefined
    // `pr` = the row's CURRENTLY-COMMITTED propagate flag, captured before the move isolates the drag.
    // Commit (resolveMoveProp) and cancel restore from this so an in-progress preview never erases a
    // cascade the loco already had.
    return { ss: sc?.startShiftDays ?? 0, fs: sc?.finishShiftDays ?? 0, pr: !!sc?.propagate }
  }

  // Earliest BASE-schedule ISO of a target workstation (min cell date across its rows). Used to order a
  // multi-row Move-Mode selection by SEQUENCE so the rigid-group fix in resolveMoveProp can pick the
  // leader (earliest) regardless of the order the rows were selected (down-arrow vs up-arrow).
  const baseWsStartIso = (t: EditTarget): string | null => {
    const g = (dataRef.current?.groups ?? []).find(gr => locoKeyOf(gr) === locoKeyForTarget(t))
    if (!g) return null
    const norm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    const want = norm(t.ws ?? '')
    let m: string | null = null
    for (const w of g.workstations) {
      if (norm(w.ws) !== want) continue
      for (const dr of w.desc_rows) for (const iso in dr.cells) if (m === null || iso < m) m = iso
    }
    return m
  }

  // ── Frozen Move-Mode preview ────────────────────────────────────────────────────────────────────
  // MOVE MODE IS A PURE PREVIEW and the real override map is NEVER written while dragging. Instead the
  // moved LOCO is RE-RENDERED from a throwaway override in which EVERY station is pinned to its absolute
  // saved position (propagate OFF) and only the selected station carries the live move delta on top.
  // Because propagation is off and every station is pinned, no cascade runs: downstream stations stay
  // EXACTLY where they were saved (WS12→Day15, WS13→Day20 stay put while WS11 moves). Nothing
  // recalculates, repropagates, or snaps back to a reference. Propagation happens only on commit, when
  // resolveMoveProp writes the real edit (committed shift + delta) and the worker recomputes normally.
  //
  // The pins reproduce the SAVED render exactly (startShiftDays = idx(savedStart) − idx(baseStart) on the
  // business axis), so painting at delta 0 is visually identical to the saved schedule — entering Move
  // Mode changes nothing. Cancel/commit just re-render the untouched real override (clearMoveFreeze),
  // which is why nothing can ever be left behind or corrupted by the preview.

  // The loco's CURRENT propagated positions live ONLY in the worker: `mergedData` is deliberately NOT
  // recomputed while the Schedule tab is open (see the mergedData effect's `activeTab === 3` guard, to
  // keep the editing worker free), so reading it here returned base positions and the freeze collapsed
  // the whole loco to baseline the instant Move Mode opened. So ask the worker to merge JUST this loco
  // (a one-group computeEffective — cheap, and correct for both Local cascade and the explicit shifts a
  // Global cascade already baked into the loco's own override) and read the saved positions from that.
  async function computeMovedLocoState(
    locoKey: string,
    movedWs: (string | undefined)[],
  ): Promise<GanttFreezeGeom> {
    const handle = ganttTableRef.current
    if (!handle) return { geom: [], descGeom: [], pdSlack: null, pdSlackByRow: null }
    // Measured IN THE WORKER against `cachedData` — the exact base/axis handlePatchLocos renders with —
    // so every station's start pin reproduces its DISPLAYED position. The previous implementation measured
    // pins on the main thread against `effectiveData` (a separately-windowed copy of the schedule); once a
    // loco carried an override the two bases diverged and every pinned station drifted the instant Move
    // Mode opened (workstations + Protection Days jumped). computeFreezeGeom also returns the PD slack,
    // computed on that same base, so the Protection-Days limit warning fires against the real geometry.
    const ov = activeOverrides[locoKey]
    try { return await handle.computeFreezeGeom(locoKey, ov && !isEmptyOverride(ov) ? ov : null, movedWs) }
    catch { return { geom: [], descGeom: [], pdSlack: null, pdSlackByRow: null } }
  }

  // Render the loco with all stations pinned frozen and the selected station(s) shifted by the deltas.
  function paintMoveFreeze(
    locoKey: string,
    freezeGeom: { ws: string; subarea: string; absStart: number }[],
    freezeDesc: { ws: string; subarea: string; desc: string; absStart: number }[],
    targets: EditTarget[],
    dStart: number,
    dFinish: number,
  ) {
    // NET-ZERO MOVE ⇒ render the SAVED state directly, never the reconstructed pins. When the selection
    // carries no displacement (Move Mode just opened, or the user stepped back to zero) the frozen preview
    // is BY DEFINITION the already-resolved schedule on screen. Reconstructing it from per-station pins
    // means applying the override a SECOND time (measure the resolved positions, then re-pin them through
    // applyOverrideToGroup) — a round-trip that is lossless on a clean loco (all pins 0) but drifts on a
    // loco that already carries saved overrides / propagation / Protection-Days consumption, which is
    // exactly the "opening Move Mode shifts workstations / regrows Protection Days" family of bugs. Loading
    // the committed override straight through makes opening a GUARANTEED no-op for every loco. The pins are
    // only ever needed once the user actually displaces something (dStart/dFinish ≠ 0).
    if (dStart === 0 && dFinish === 0) { clearMoveFreeze(locoKey); return }
    // PINS NOT READY YET ⇒ hold the committed render, never paint a displacement without them. The freeze
    // pins arrive from an async worker round-trip (computeMovedLocoState at move start); computeFreezeGeom
    // returns one pin per station (absStart 0 for a clean loco), so an EMPTY list means only "not fetched
    // yet". The reconstruction below strips the committed loco-level shift/takt and every scope's
    // propagation on the assumption the pins reproduce them — with no pins those effects simply VANISH for
    // a frame, so an edited/propagated station jumps to its un-shifted position (and a takt-driven row to
    // its original DURATION) until the pins land and repaint. That is the reported "other workstations
    // temporarily jump back during a drag, then return when Move Mode finishes". Holding the committed
    // render (what is already on screen) makes the drag a visual no-op until the pins arrive; the deltas
    // still accumulate in moveMode, and computeMovedLocoState's .then repaints at the current deltas the
    // instant the real pins are in hand. (Issue #1.)
    if (freezeGeom.length === 0) { clearMoveFreeze(locoKey); return }
    const norm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    // Split the selection BY SCOPE. A whole-workstation target displaces the WS pin; a Componente
    // (desc-scope) target must move ONLY its own row — so dragging one box inside an EXPANDED workstation
    // never drags the whole station. A desc target flagged asWs (the workstation's SOLE component) is a
    // workstation move and stays with the WS pins. This mirrors what commit (resolveMoveProp) stores, so
    // the preview and the committed result agree.
    const selWs = new Set(targets.filter(t => t.ws && (t.scope !== 'desc' || t.asWs)).map(t => norm(t.ws!)))
    const selDesc = targets.filter(t => t.scope === 'desc' && !t.asWs)
    const committed = activeOverrides[locoKey] ?? {}
    const ov: LocoVisualOverride = structuredClone(committed)
    // Legacy-swap normalization for the LIVE PREVIEW (mirror of writeScopedEdit's, so the hatch matches
    // during the drag and after the commit): a swap with no swapShift gets its committed shift recorded as
    // the trade's contribution, so dragging a legacy-swapped station shows the delay it is accruing instead
    // of hiding it (the reference would otherwise track the dragged position). Issue #4.
    if (ov.ws) for (const k of Object.keys(ov.ws)) {
      const e = ov.ws[k]
      if (e && e.swap && !e.swapShift && (e.startShiftDays || e.finishShiftDays)) {
        ov.ws[k] = { ...e, swapShift: { start: e.startShiftDays ?? 0, finish: e.finishShiftDays ?? 0 } }
      }
    }
    // NO DOUBLE-APPLICATION. Every WS pin below carries `absStart` = the station's FULL resolved start
    // measured base → committed-resolved (computeFreezeGeom), so it ALREADY contains any LOCO-level shift
    // and any propagated cascade. Two committed scopes would otherwise be re-applied ON TOP of that and
    // shove the whole loco the instant a drag begins ("other workstations start moving"):
    //   • a LOCO-level startShiftDays/finishShiftDays (a whole-loco delay — a common override) would add
    //     its shift a SECOND time to every station, so strip the loco-level shift fields here; the pins
    //     reproduce them exactly.
    //   • a propagating Componente (desc) edit's cascade is baked into the DOWNSTREAM pins, so leaving it
    //     `propagate:true` re-cascades it — freeze every desc edit's propagation (its own row geometry is
    //     preserved, only the cascade is silenced, exactly like the WS pins).
    // This enforces the Move-Mode rule directly: no propagation of ANY scope runs during the drag.
    delete ov.startShiftDays; delete ov.finishShiftDays; delete ov.takt
    // A Componente (desc) edit's committed START shift is replaced by its own PIN below (freezeDesc),
    // for the same no-double-application reason as the WS pins: the pins are absolute positions measured
    // on the resolved schedule, so re-applying the stored delta on top would shift the row twice. Strip
    // the start here and keep the row's intrinsic finish/takt/hours geometry, which no pin carries.
    if (ov.desc) for (const k of Object.keys(ov.desc)) { const e = { ...ov.desc[k], propagate: false }; delete e.startShiftDays; ov.desc[k] = e }
    const wsMap: Record<string, ScopedEdit> = { ...(ov.ws ?? {}) }
    for (const g of freezeGeom) {
      const key = wsEditKeyOf(g.ws)
      const prev = wsMap[key] ?? {}
      const isSel = selWs.has(norm(g.ws))
      const ss = g.absStart + (isSel ? dStart : 0)
      const fs = (prev.finishShiftDays ?? 0) + (isSel ? dFinish : 0)
      const entry: ScopedEdit = { ...prev, propagate: false }
      if (ss) entry.startShiftDays = ss; else delete entry.startShiftDays
      if (fs) entry.finishShiftDays = fs; else delete entry.finishShiftDays
      if (isSel) entry.satHand = true   // LIVE drag → this row may land on ANY working Saturday (transient)
      wsMap[key] = entry
    }
    ov.ws = wsMap
    // ── COMPONENTE PINS ─────────────────────────────────────────────────────────────────────────
    // A workstation pin holds the STATION put, but the worker re-lays each of its Componente rows at
    // stationStart + the row's BASE offset — it does not remember that the planner had moved one row
    // WITHIN the station. So a component that had been displaced snapped back to its base offset the
    // moment any drag began, and (because the station pin is measured from the station's MINIMUM row)
    // its siblings were dragged along with it. That is the "moving one component repositions the
    // others" / "previously applied delays are re-applied" family — the same class of bug the WS pins
    // fixed between workstations, one level down.
    //
    // freezeDesc carries each Componente's RESIDUAL pin: exactly what the station pin does not already
    // reproduce, measured in the worker against the station-pinned render. Writing it as the row's
    // startShiftDays reproduces the current display row-for-row, so every non-selected component holds
    // still and only the selected one moves.
    const descMap: Record<string, ScopedEdit> = { ...(ov.desc ?? {}) }
    const selDescKeys = new Set(selDesc.map(t => descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? '')))
    for (const d of freezeDesc) {
      const dk = descEditKeyOf(d.ws, d.subarea, d.desc)
      const prev = descMap[dk] ?? {}
      const isSel = selDescKeys.has(dk)
      const ss = d.absStart + (isSel ? dStart : 0)
      const e: ScopedEdit = { ...prev, propagate: false }
      if (ss) e.startShiftDays = ss; else delete e.startShiftDays
      if (isSel) e.satHand = true
      descMap[dk] = e
    }
    // Componente-scope SELECTION: displace the selected row(s) on top of their pin (which holds them
    // where they are now), so the drag moves that ONE box while its siblings and the workstation frame
    // stay anchored. A selected row with no pin of its own (residual 0) starts from the station pin.
    if (selDesc.length) {
      for (const t of selDesc) {
        const dk = descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? '')
        const pinned = freezeDesc.find(d => descEditKeyOf(d.ws, d.subarea, d.desc) === dk)
        const prev = descMap[dk] ?? {}
        const e: ScopedEdit = { ...prev, propagate: false, satHand: true }
        const ss = (pinned?.absStart ?? 0) + dStart
        if (ss) e.startShiftDays = ss; else delete e.startShiftDays
        // Duration change is a DELTA on the row's committed geometry (the pins are start-only).
        const fs = ((ov.desc?.[dk]?.finishShiftDays) ?? 0) + dFinish
        if (fs) e.finishShiftDays = fs; else delete e.finishShiftDays
        descMap[dk] = e
      }
    }
    if (Object.keys(descMap).length) ov.desc = descMap
    ganttTableRef.current?.patchLocos(
      { [locoKey]: ov },
      { base: wsExpandBase, exceptions: wsExpandExc, locoBase: locoExpandBase, locoExceptions: locoExpandExc },
    )
  }

  // Drop the frozen preview: re-render the loco from the untouched real override (its saved state).
  function clearMoveFreeze(locoKey: string) {
    const committed = activeOverrides[locoKey]
    ganttTableRef.current?.patchLocos(
      { [locoKey]: committed && !isEmptyOverride(committed) ? committed : {} },
      { base: wsExpandBase, exceptions: wsExpandExc, locoBase: locoExpandBase, locoExceptions: locoExpandExc },
    )
  }

  // ── Protection Days as a HARD limit ───────────────────────────────────────────────────────────
  // The buffer downstream of the moved rows is finite, and once spent the LOCO physically cannot slip
  // further: everything after Protection Days is anchored (and locked from editing), so a move past
  // the limit does not delay anything — it just draws the station on top of work that cannot move.
  //
  // The limit is enforced on INPUT rather than on render, and that is the important part. If the
  // over-consuming shift were stored and merely clamped when drawing, shifting back would first have
  // to burn off an invisible excess before the buffer reappeared. Refusing the keystroke keeps the
  // stored shift and the picture in step, so the operation is exactly symmetric: step right until the
  // indicator turns orange, step left and the protection days come straight back.
  //
  // The slack is measured to the DEADLINE — the committed Protection-Days FINISH, which stays put as the
  // buffer is spent — so the buffer may be consumed to its very last day and only the step that would
  // push a finish PAST the deadline warns. It is captured ONCE per row, when the move starts, by
  // computeFreezeGeom (worker-side, on the SAME render base as the pins), so a stray keystroke can't
  // false-trigger before the values land, and every subsequent step is a delta from that snapshot.
  //
  // ONE SOURCE OF TRUTH: the post-Protection-Days boundary used to be re-derived here as well (an
  // isPostPdTarget mirror of the worker's array-order rule) purely to null out the limit for a post-PD
  // selection. The worker now simply omits post-PD rows from pdSlackByRow, so the boundary is decided
  // in exactly one place — and a MIXED selection is bound by its pre-PD rows instead of by the post-PD
  // one, which sits beyond the deadline and used to report slack 0 (warning on the very first step).

  /** The Protection-Days limit for a SELECTION: the tightest limit among the rows in it, so the FIRST
   *  row that would cross the deadline raises the warning — not whichever row the move happened to
   *  start on. Rows the worker left out of the map (post-PD ones) carry no limit and are skipped; a
   *  selection made up entirely of those returns null, exactly like a LOCO with no buffer.
   *
   *  A Componente row is looked up by its own key first, since it has its own finish and may be free to
   *  travel further than the latest row of its workstation. */
  function pdSlackForTargets(targets: EditTarget[], rows: Record<string, number> | null): number | null {
    if (!rows) return null
    const norm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    let best: number | null = null
    for (const t of targets) {
      if (!t.ws) continue
      const wsKey = norm(t.ws)
      const v = (t.scope === 'desc' ? rows[`${wsKey}||${t.subarea ?? ''}||${t.desc ?? ''}`] : undefined) ?? rows[wsKey]
      if (v == null) continue
      if (best == null || v < best) best = v
    }
    return best
  }

  /** May the move sit at these deltas? A move consumes buffer by however much it pushes its FINISH
   *  later, which is `dStart + dFinish` (a rigid move carries dFinish = 0; a pure resize carries
   *  dStart = 0). Pulling earlier / shortening always passes — that RESTORES buffer.
   *
   *  The buffer is CONSUMABLE TO THE LAST DAY: with 5 days left, +1…+5 all pass (the fifth spends the
   *  buffer exactly) and only +6 — the step that would push the finish PAST the deadline — warns. */
  function pdAllows(m: NonNullable<typeof moveMode>, dStart: number, dFinish: number): boolean {
    if (m.pdSlack == null) return true
    const consumed = dStart + dFinish
    if (consumed <= (m.pdSlack ?? 0)) return true
    // Never block a keystroke that IMPROVES the situation (e.g. stepping left while already at/over
    // the limit), so the user can always get back out of the corner they moved into.
    return consumed < m.dStart + m.dFinish
  }

  // These run from GanttTable via always-current refs, so reading `moveMode` directly is safe
  // (GanttModal re-renders between discrete key events) and keeps side effects out of updaters.
  function startMove(rows: MoveRow[]) {
    if (!rows.length) return
    const targets = rows.map(moveTargetOf)
    const orig: Record<string, { ss: number; fs: number; pr: boolean }> = {}
    for (const t of targets) orig[moveSelKey(t)] = origShiftOf(t)
    // Duration editing is allowed on EVERY selectable row — Componente (desc) and workstation (ws)
    // alike. A ws-scope edit carries finishShiftDays/startShiftDays exactly like a Componente, and
    // applyWsEdits sizes every description row of the station from it, so +/− on a COLLAPSED
    // workstation resizes the whole workstation in one step.
    //
    // This used to exclude a multi-Componente WS, so the first +/− auto-expanded the workstation and
    // retargeted to its FIRST Componente — which both forced an expansion the user didn't ask for and
    // applied the change to one component instead of the workstation. That path is gone.
    const durationEditable = true
    // Every row of a selection belongs to the same LOCO, so ONE per-row snapshot covers the whole move,
    // however the selection is grown or shrunk afterwards. A POST-PD row sits past the buffer already
    // and carries no limit (the worker omits it from the map), but it DOES propagate like any other
    // station (see the pdExcess path in the worker).
    const locoKey = locoKeyForTarget(targets[0])
    // Enter Move Mode IMMEDIATELY with no pins yet and no PD limit: painting an empty freeze re-renders
    // the loco straight from its committed override — i.e. the saved propagated schedule already on
    // screen — so opening Move Mode changes NOTHING (no jump to baseline). pdSlack stays null until the
    // real value lands so a stray early keystroke can't false-trigger the PD warning.
    setMoveMode({ targets, dStart: 0, dFinish: 0, orig, durationEditable, locoKey, freezeGeom: [], freezeDesc: [], pdSlack: null, pdRows: null, pdAck: false })
    paintMoveFreeze(locoKey, [], [], targets, 0, 0)
    // Fetch the loco's CURRENT propagated positions from the worker (mergedData is deferred on the
    // Schedule tab and would give BASE positions here). Then install the freeze pins + PD slack and
    // repaint at whatever deltas the user may already have entered while the round-trip was in flight.
    void computeMovedLocoState(locoKey, targets.map(t => t.ws)).then(({ geom, descGeom, pdSlackByRow }) => {
      const m = moveModeRef.current
      if (!m || m.locoKey !== locoKey) return   // the move ended or switched before the merge landed
      // Resolved against the LATEST selection, not `targets`: the user may already have extended it
      // while the round-trip was in flight.
      setMoveMode({ ...m, freezeGeom: geom, freezeDesc: descGeom, pdRows: pdSlackByRow, pdSlack: pdSlackForTargets(m.targets, pdSlackByRow) })
      paintMoveFreeze(locoKey, geom, descGeom, m.targets, m.dStart, m.dFinish)
    })
  }

  // Selection changed (Up/Down expand or Ctrl+Up/Down shrink). Apply the current deltas to ANY newly
  // added rows and RESTORE any removed rows to their pre-move shift; already-selected rows are
  // unchanged. orig is captured for new rows and retained for removed ones (so a later re-add or
  // cancel restores correctly).
  function selectMove(rows: MoveRow[]) {
    if (!moveMode || !rows.length || pdWarn) return
    const newTargets = rows.map(moveTargetOf)
    const orig = { ...moveMode.orig }
    for (const t of newTargets) { const k = moveSelKey(t); if (!(k in orig)) orig[k] = origShiftOf(t) }
    // Repaint the frozen preview for the NEW selection: added rows pick up the current deltas, removed
    // rows fall back to their pinned saved position (they are simply no longer in the selected set).
    paintMoveFreeze(moveMode.locoKey, moveMode.freezeGeom, moveMode.freezeDesc, newTargets, moveMode.dStart, moveMode.dFinish)
    // The Protection-Days limit belongs to the SELECTION, so it is re-derived here. Extending the
    // selection onto a station closer to the buffer must tighten the limit immediately — otherwise the
    // newly-added station moves straight through the Protection Days and the warning waits for the row
    // the move started on. Shrinking symmetrically relaxes it. No round-trip: pdRows covers every row.
    setMoveMode({ ...moveMode, targets: newTargets, orig, pdSlack: pdSlackForTargets(newTargets, moveMode.pdRows) })
  }

  // Arrow ←/→ rigidly move the whole selection: startShift shifts start AND finish together, so the
  // duration is unchanged. `step` is the magnitude in days: 1 (default) or 0.5 for Ctrl/Cmd half-day
  // displacement (the fine-adjust mirror of the +/− duration half-day mode).
  function stepMove(dir: -1 | 1, step = 1) {
    if (!moveMode || pdWarn) return   // frozen while the crossing warning is open (answer it first)
    const dStart = moveMode.dStart + dir * step
    // Crossing the Protection-Days limit is now allowed, but the FIRST time a keystroke would push the
    // move beyond it we hold the keystroke and raise a warning (MovePdWarningPrompt) — the station stays
    // at its last valid position. Once acknowledged (pdAck) the limit no longer blocks; it only recolours
    // the border red. Stepping back inside always applies (pdAllows treats an improving move as allowed).
    if (!pdAllows(moveMode, dStart, moveMode.dFinish) && !moveMode.pdAck) { setPdWarn({ kind: 'step', dir, step }); return }
    paintMoveFreeze(moveMode.locoKey, moveMode.freezeGeom, moveMode.freezeDesc, moveMode.targets, dStart, moveMode.dFinish)
    setMoveMode({ ...moveMode, dStart })
  }

  // + / − adjust duration by editing the LAST box (finish) via finishShiftDays (grows/shrinks the
  // finish; the worker clamps to ≥0.5 business day). Start stays put; the existing duration-edit logic
  // recomputes Start/Finish. `step` is the magnitude in days: 1 (default) or 0.5 for the Ctrl/Cmd
  // half-day fine-adjust mode. The 0.5 flows straight into finishShiftDays, reusing the worker's
  // existing half-day rendering (trailing half-width hatched box) and dependency/propagation handling.
  function stepDuration(dir: -1 | 1, step = 1) {
    if (!moveMode || !moveMode.durationEditable || pdWarn) return
    const dFinish = moveMode.dFinish + dir * step
    // Growing the duration pushes the finish later, so it consumes buffer exactly like moving right —
    // same crossing warning as stepMove (held once, then allowed with a red border once acknowledged).
    if (!pdAllows(moveMode, moveMode.dStart, dFinish) && !moveMode.pdAck) { setPdWarn({ kind: 'dur', dir, step }); return }
    paintMoveFreeze(moveMode.locoKey, moveMode.freezeGeom, moveMode.freezeDesc, moveMode.targets, moveMode.dStart, dFinish)
    setMoveMode({ ...moveMode, dFinish })
  }

  // Shift+"+"/"−" are the exact MIRROR of Ctrl+"+"/"−" (stepDuration): same duration change, same hour
  // redistribution, but the PARTIAL half-day lands on the STARTING side while the FINISH stays pinned.
  //   • Ctrl grows/shrinks the FINISH by `dir·step`, start fixed  → trailing half at the END.
  //   • Shift grows/shrinks the FRONT: the START moves by −dir·step (earlier on "+", later on "−") and
  //     the duration grows by +dir·step so the finish edge does NOT move → leading half at the START.
  // Because startShift and finishShift move by EQUAL-AND-OPPOSITE amounts, the finish slot
  // (startSlot + durSlots) is invariant; only the leading edge and total duration change. A half-integer
  // startShift puts the start on a PM slot, which the worker's slot path renders as a `half:'second'`
  // leading box (whole-day _occStep/_regenRowCells can only ever express a TRAILING half). `step` is 0.5.
  function stepDurationStart(dir: -1 | 1, step = 0.5) {
    if (!moveMode || !moveMode.durationEditable || pdWarn) return
    const dStart = moveMode.dStart - dir * step    // "+" pulls the start earlier, "−" pushes it later
    const dFinish = moveMode.dFinish + dir * step  // duration follows so the FINISH edge stays pinned
    // No PD check needed: start and duration move equal-and-opposite, so the finish — and therefore
    // buffer consumption (dStart + dFinish) — is invariant under this operation by construction.
    paintMoveFreeze(moveMode.locoKey, moveMode.freezeGeom, moveMode.freezeDesc, moveMode.targets, dStart, dFinish)
    setMoveMode({ ...moveMode, dStart, dFinish })
  }

  // ── Move Mode: SPACE = "never occupy a Saturday" veto (satNever) ──────────────────────────────
  // A standing, persisted constraint on the SELECTED station(s) — not a displacement. Space flips it on
  // and off. The worker's satCapForEdit short-circuits to `false` when it is set (ahead of satHand), so
  // the row is laid out as if no Saturday were ever a working day: a Saturday inside its span is skipped
  // and the box stretches past it.
  //
  // Written straight into the committed override rather than held as a Move-Mode delta. paintMoveFreeze
  // re-reads `activeOverrides[locoKey]` on every repaint and carries unknown fields through via
  // `{ ...prev }`, so the flag reaches the preview by itself — and at zero displacement the freeze clears
  // and renders the committed override directly, which now carries it. One write covers both paths.
  //
  // Toggle direction is decided by the WHOLE selection: it clears only when EVERY selected row already
  // has the veto, so Space on a mixed selection sets all of them (rather than flipping each row
  // independently and leaving the selection half-flagged).
  function toggleSatNever() {
    if (!moveMode) return
    const locoKey = moveMode.locoKey
    // Same scope split paintMoveFreeze uses: a desc target flagged asWs is a WORKSTATION move.
    const wsKeys = Array.from(new Set(moveMode.targets
      .filter(t => t.ws && (t.scope !== 'desc' || t.asWs))
      .map(t => wsEditKeyOf(t.ws ?? ''))))
    const descKeys = Array.from(new Set(moveMode.targets
      .filter(t => t.scope === 'desc' && !t.asWs)
      .map(t => descEditKeyOf(t.ws ?? '', t.subarea ?? '', t.desc ?? ''))))
    if (!wsKeys.length && !descKeys.length) return

    const cur = activeOverrides[locoKey] ?? {}
    const allSet = wsKeys.every(k => !!cur.ws?.[k]?.satNever) && descKeys.every(k => !!cur.desc?.[k]?.satNever)
    const next = !allSet

    const ws = { ...(cur.ws ?? {}) }
    const desc = { ...(cur.desc ?? {}) }
    const write = (map: Record<string, ScopedEdit>, k: string) => {
      const e: ScopedEdit = { ...(map[k] ?? {}) }
      if (next) e.satNever = true; else delete e.satNever
      // Clearing the veto can leave a shift-less entry behind; drop it so it neither counts as an
      // unsaved edit nor persists an empty record (isEmptyScopedEdit treats satNever as real, so this
      // only ever fires on the clear path).
      if (isEmptyScopedEdit(e)) delete map[k]; else map[k] = e
    }
    for (const k of wsKeys) write(ws, k)
    for (const k of descKeys) write(desc, k)

    const nextOv: LocoVisualOverride = { ...cur }
    if (Object.keys(ws).length) nextOv.ws = ws; else delete nextOv.ws
    if (Object.keys(desc).length) nextOv.desc = desc; else delete nextOv.desc

    setActiveOverrides(prevMap => {
      const m = { ...prevMap }
      if (isEmptyOverride(nextOv)) delete m[locoKey]; else m[locoKey] = nextOv
      return m
    })
    // Geometry CHANGES here (a spanned Saturday is skipped), so this is a real repaint, not an
    // annotation refresh — patchLocos falls back to an in-place rebuild when the axis cannot absorb it.
    ganttTableRef.current?.patchLocos({ [locoKey]: isEmptyOverride(nextOv) ? {} : nextOv })
  }

  // ── Protection-Days crossing warning resolution ───────────────────────────────────────────────
  // "Continuar" — acknowledge the crossing and REPLAY the held keystroke against the acknowledged move
  // (pdAck flips the limit from a hard block to a red-border-only signal). Applied inline against a local
  // copy because setMoveMode is async — reading `moveMode` in stepMove would still see pdAck=false.
  function pdWarnContinue() {
    const w = pdWarn
    if (!w || !moveMode) { setPdWarn(null); return }
    setPdWarn(null)
    const m = moveMode
    if (w.kind === 'dur') {
      const dFinish = m.dFinish + w.dir * w.step
      paintMoveFreeze(m.locoKey, m.freezeGeom, m.freezeDesc, m.targets, m.dStart, dFinish)
      setMoveMode({ ...m, dFinish, pdAck: true })
    } else {
      const dStart = m.dStart + w.dir * w.step
      paintMoveFreeze(m.locoKey, m.freezeGeom, m.freezeDesc, m.targets, dStart, m.dFinish)
      setMoveMode({ ...m, dStart, pdAck: true })
    }
  }
  // "Parar aqui" — drop the held keystroke. Move Mode stays active at the last valid position and the
  // warning re-arms (pdAck stays false), so the user may continue moving elsewhere or try again.
  function pdWarnStop() { setPdWarn(null) }

  // Recovery-Plan detection: TRUE when this move REDUCES an existing delay without worsening it.
  // "Delayed before" = at least one moved row (target or rider) had a positive pre-move start shift
  // (baseline = shift 0, positive = late). "Advanced" = the net move pulled work earlier (started
  // earlier OR shorter duration); "worsened" = it pushed later OR extended duration. A recovery must
  // advance AND not worsen — so +2→+1 / +2→0 / +5→+3 qualify, while 0→+1 (first-time delay), +2→+4
  // (more delay), and an unchanged delay do NOT. Drives the prompt's auto "Recovery Plan" classify.
  function moveReducesDelay(m: NonNullable<typeof moveMode>): boolean {
    // Pre-move shift of every moved row (targets + auto-expand riders). A box is "delayed before" when
    // it started late (ss > 0) OR runs long (fs > 0) — a stretched duration finishes later, so shrinking
    // it back is just as much a recovery as pulling a late start earlier. (The old check looked only at
    // ss, so reducing a duration-based delay was never auto-classified — the reported bug.)
    const priorShifts = [
      ...m.targets.map(t => m.orig[moveSelKey(t)] ?? { ss: 0, fs: 0 }),
      ...(m.riders ?? []).map(r => ({ ss: r.ss, fs: r.fs })),
    ]
    const delayedBefore = priorShifts.some(s => s.ss > 0 || s.fs > 0)
    const advanced = m.dStart < 0 || m.dFinish < 0   // pulled earlier and/or shortened
    const worsened = m.dStart > 0 || m.dFinish > 0   // pushed later and/or extended
    return delayedBefore && advanced && !worsened
  }

  function commitMove() {
    if (!moveMode || pdWarn) return   // an unanswered crossing warning blocks Enter/commit
    // Exit Move Mode; the moves are already applied (propagate No). Show a small centered Yes/No
    // prompt for the WHOLE selection instead of opening the full Edit panel. A delay-reducing move
    // is flagged as a recovery so the prompt pre-selects/pre-fills "Recovery Plan" (and relaxes the
    // mandatory-category rule).
    // A move finalized BEYOND the Protection-Days limit stamps its note pdOverLimit (prominent red badge,
    // visual only). Post-PD selections now propagate like any other station (only the PD warning stays
    // suppressed for them), so propagation controls are shown for every selection.
    const overLimit = moveMode.pdSlack != null && (moveMode.dStart + moveMode.dFinish) > moveMode.pdSlack
    // Carry the net deltas + locoKey: the preview never wrote to the map, so the commit applies
    // committed-shift + delta (resolveMoveProp) and the prompt's X re-renders the untouched saved state.
    setMovePropPrompt({ targets: moveMode.targets, orig: moveMode.orig, riders: moveMode.riders, recovery: moveReducesDelay(moveMode), dStart: moveMode.dStart, dFinish: moveMode.dFinish, locoKey: moveMode.locoKey, overLimit, propagationDisabled: false })
    setPdWarn(null)
    setMoveMode(null)
  }

  // The prompt's X (or Esc): undo the move that was just committed. The preview only ever re-rendered
  // the loco (the real override was never touched), so "undo" is simply dropping the frozen preview and
  // repainting the saved state. The only exit that leaves no trace.
  function cancelMoveProp() {
    if (!movePropPrompt) return
    clearMoveFreeze(movePropPrompt.locoKey)
    setMovePropPrompt(null)
  }

  // Resolve the post-move prompt by re-applying every selected row's current shift with the chosen
  // propagation:
  //   • Local/Global → propagate ON.
  //   • Não          → propagate unchanged. It means "do not ADD propagation for this move", NOT
  //                    "revoke the propagation this row already had".
  //
  // That last point is the fix for the "downstream workstations revert" report. `propagate` is a
  // persistent flag on the row's override, and overrides are re-applied from base on every render — so
  // clearing it retroactively un-cascades the EARLIER move too, yanking every downstream workstation
  // back to its base position. A row that is already cascading therefore keeps cascading, and the new
  // shift simply cascades with it (the worker recomputes the cascade from the row's current position,
  // so the downstream stations follow the latest edited state rather than any remembered offset).
  //
  // Turning propagation OFF is still possible, but only through the deliberate paths: the edit panel
  // (which opens with propagate OFF and saves exactly what it shows — see panelView) and
  // "Remover edição". Neither is reachable by accident mid-move, which is the point.
  // The shifts themselves are preserved either way; the effect is visual-only.
  //
  // The move's REASON = a `category` (classification) + the optional `noteText` observation. The
  // category is normally mandatory, but a recovery move (delay-reducing) makes it OPTIONAL and may
  // arrive as null. It is stored on the FIRST (topmost) selected row only — one reason describes one
  // move, so copying it onto all N rows of a multi-row selection would just be N copies of the
  // same sentence and N indicators. That row is therefore the one that renders the indicator.
  // `noteMode` picks history ('append') or replace ('override').
  // `propagate` is the tri-state answer: 'no' (this row only), 'local' (cascade within the loco — the
  // former "Sim"), or 'global' (Local PLUS ripple the edited workstation across subsequent same-line
  // locos). Local and Global both apply the row's edit with propagate ON; Global then additionally
  // runs runGlobalCascade against the post-primary map for each distinct edited ranked workstation.
  // Compute the committed working-Saturday licence for a Move-Mode commit and stamp it onto each moved
  // item as `satDays`, so a Saturday landing survives Enter. The worker reproduces the preview landing
  // (transient satHand) against the loco's about-to-be-persisted override and reports the promoted
  // Saturdays each moved row occupies; those become the row's NARROW licence (see satCapForEdit). An
  // empty array clears any stale licence (the box now sits on no Saturday). On worker unavailability the
  // items are returned untouched (satDays undefined → the prior licence is carried forward, not erased).
  async function stampCommitSatDays(items: ScopedEditItem[], locoKey: string): Promise<ScopedEditItem[]> {
    const handle = ganttTableRef.current
    if (!handle || !items.length) return items
    // Prospective WRITE-layer override = the current write map folded with the pending edits (no satDays
    // yet), then COMPOSED with the Standard layer beneath in Projeção so the worker measures the same
    // schedule the renderer draws.
    let writeOv: LocoVisualOverride = writeOverrides[locoKey] || {}
    for (const it of items) {
      writeOv = writeScopedEdit(writeOv, it.target, it.takt, it.startShift, it.finishShift, it.propagate, it.notes, it.satManual, it.swap, it.hoursTotal, it.swapShift, it.parallelStarts, inheritOverrides?.[locoKey], it.removeGaps)
    }
    const composedOv = isProjection
      ? (mergeOverrideMaps({ [locoKey]: locoOverrides[locoKey] ?? {} }, { [locoKey]: writeOv })[locoKey] ?? {})
      : writeOv
    const movedWs = [...new Set(items.map(it => it.target.ws).filter((w): w is string => !!w))]
    if (!movedWs.length) return items
    const satMap = await handle.computeLandedSaturdays(locoKey, isEmptyOverride(composedOv) ? null : composedOv, movedWs)
    if (!satMap) return items
    const norm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    return items.map(it => {
      const t = it.target
      if (!t.ws) return it
      const wsKey = norm(t.ws)
      const days = (t.scope === 'desc' ? satMap[`${wsKey}||${t.subarea ?? ''}||${t.desc ?? ''}`] : undefined) ?? satMap[wsKey]
      return { ...it, satDays: days ?? [] }
    })
  }

  async function resolveMoveProp(propagate: PropagateMode, noteText = '', noteMode: MoveNoteMode = 'append', category?: string | null, parallelStarts = true, removeGaps = false) {
    if (!movePropPrompt) return
    const targets = movePropPrompt.targets
    const anchorKey = targets.length ? moveSelKey(targets[0]) : null
    const propOn = propagate !== 'no'
    // Only an opt-OUT is worth recording, and only when this answer actually turns propagation on:
    // answering "Não" must not stamp `parallelStarts:false` onto propagation inherited from an earlier
    // move (same reasoning as `propOn || sc?.propagate` below — a move never revokes what it didn't set).
    const par: boolean | undefined = propOn && !parallelStarts ? false : undefined
    // "Remover gaps futuros" is the mirror image: OFF is the default, so only an opt-IN on an answer
    // that actually turns propagation on is recorded. Answering "Não" must not stamp it onto a cascade
    // inherited from an earlier move.
    const gaps: boolean | undefined = propOn && removeGaps ? true : undefined
    // ── "Propagar WS Única" applies to the EDITED loco too ────────────────────────────────────────
    // The sub-option means "move the edited workstation ALONE". That has to hold on the loco being
    // edited, not only on the downstream ones: the primary commit was adding Local propagation
    // unconditionally for Global, so every station AFTER the edited one inside the current loco
    // followed — exactly what the option asks not to happen, while runGlobalCascade already withheld
    // propagation downstream. Same code path as the downstream commits, so the parallel-start
    // handling that already works for WS Única is preserved by construction (the worker's
    // parallel-carry lives inside the propagate branch — see applyWsEdits).
    // Declining to ADD propagation never REVOKES what a row already carries (`|| o.pr` below).
    const singleWsGlobal = propagate === 'global' && getGlobalPropOptions().singleWs
    const addProp = propOn && !singleWsGlobal

    // ── Rigid-group de-duplication (workstations moved TOGETHER) ─────────────────────────────────
    // When several workstations are moved as one rigid Move-Mode selection and propagation is now
    // turned on, the LEADER's cascade will carry the followers downstream. A follower that ALSO keeps
    // its own equal start shift is therefore displaced TWICE — an artificial gap opens between them and
    // the propagated delay is inflated. Revert each follower's START shift to its pre-move value so the
    // leader's cascade lands it exactly where the user dragged it (the followers moved by the SAME
    // delta, so pre-move + leader-cascade = the intended position). A LATER solo edit of the leader
    // re-propagates normally: the follower's reduced shift simply rides the new cascade — which is the
    // required "move one alone → it DOES affect the other" behaviour. Only for a RIGID move (leader
    // duration unchanged) and only the non-leader members; the leader (earliest by base start) is kept.
    // The preview never wrote to the override, so the committed edit is the PRE-MOVE shift (orig) plus
    // the net delta the drag accumulated. `dS`/`dF` are the same for every selected row (rigid group).
    const dS = movePropPrompt.dStart, dF = movePropPrompt.dFinish
    const reduceKeys = new Set<string>()
    if (propOn && targets.length >= 2) {
      const withIso = targets.map(t => ({ t, iso: baseWsStartIso(t) }))
      const leader = withIso.reduce((a, b) => (b.iso != null && (a.iso == null || b.iso < a.iso) ? b : a))
      const rigid = dF === 0   // a rigid move carries no duration change
      if (rigid) for (const { t } of withIso) if (moveSelKey(t) !== moveSelKey(leader.t)) reduceKeys.add(moveSelKey(t))
    }

    const items: ScopedEditItem[] = [
      ...targets.map(t => {
        const sc = scopedEditOf(t) as ScopedEdit | undefined
        const o = movePropPrompt.orig[moveSelKey(t)]
        // The anchor row carries the move's note; stamp pdOverLimit on it when this move finished beyond
        // the Protection-Days limit (prominent red badge, visual only — the shift itself is unchanged).
        const notes = moveSelKey(t) === anchorKey
          ? applyMoveNote(sc?.notes, noteText, username, noteMode, category, movePropPrompt.overLimit)
          : sc?.notes
        // Committed shift = pre-move shift + net delta. Followers of a rigid group drop the (double-
        // counted) start delta back to pre-move so the leader's cascade lands them exactly once.
        const startShift = reduceKeys.has(moveSelKey(t)) ? (o?.ss ?? 0) : ((o?.ss ?? 0) + dS)
        const finishShift = (o?.fs ?? 0) + dF
        return {
          target: t, takt: sc?.takt ?? null,
          startShift: startShift || null, finishShift: finishShift || null,
          // `|| o.pr` — "Não" (and Global under "WS Única") declines to ADD propagation but never
          // revokes what the row already had (o.pr = the row's committed propagate, captured pre-move).
          propagate: addProp || !!o?.pr, notes, hoursTotal: sc?.hoursTotal ?? null,   // preserve a Componente's hours override across the move commit
          parallelStarts: par, removeGaps: gaps,
        }
      }),
      // Riders (auto-expand carry-over): keep their applied shift, honor the propagate answer.
      // The reason (category/observation) stays on the anchor row — one reason per move.
      ...(movePropPrompt.riders ?? []).map(r => {
        const sc = scopedEditOf(r.target) as ScopedEdit | undefined
        return {
          target: r.target, takt: sc?.takt ?? null,
          startShift: sc?.startShiftDays ?? null, finishShift: sc?.finishShiftDays ?? null,
          propagate: addProp || !!sc?.propagate, notes: sc?.notes, parallelStarts: par, removeGaps: gaps,
        }
      }),
    ]
    // ── Persist the working-Saturday landing (satDays) so it survives Enter ───────────────────────
    // The committed startShiftDays counts occupiable days — and a Saturday the planner dragged the box
    // onto (satHand preview) WAS occupiable, so the same shift replayed without a licence would skip it
    // and land the box a slot off. Ask the worker which promoted Saturdays each moved row occupies at
    // the committed position (it reproduces the preview with a transient satHand) and stamp them as
    // satDays — a NARROW licence scoped to exactly those dates, never a blanket one (see satCapForEdit).
    // Cheap and skipped entirely when the loco has no working Saturday on its axis.
    const withSatDays = await stampCommitSatDays(items, movePropPrompt.locoKey)
    const primaryNext = applyScopedEdits(withSatDays)
    if (propagate === 'global' && targets.length) {
      // Follow each DISTINCT edited workstation independently through the downstream locos. The edited
      // loco is the anchor row's loco (Move Mode edits rows of a single loco). Non-ranked WS no-op.
      const editedKey = locoKeyForTarget(targets[0])
      const editedWsList = [...new Set(targets.map(t => t.ws).filter((w): w is string => !!w))]
      void runGlobalCascade(primaryNext, editedKey, editedWsList)
    }
    setMovePropPrompt(null)
  }

  // Indicator clicked on a moved box → show that box's reason trail. The worker only reports WHICH
  // row was clicked; the reasons themselves are read from the live override map here, so the text
  // exists in exactly one place and the bubble can never show a stale copy.
  // The trail is CROSS-SCOPE, mirroring what the badge renders (worker _mergeNotes): a Componente
  // row's badge also carries the WS-scope reason, and the collapsed summary row's badge carries
  // every Componente's reason — so the lookup merges the same trails chronologically. Without
  // this, clicking a badge whose own scope has no notes would silently open nothing.
  function openMoveNote(info: { scope: 'ws' | 'desc'; wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string; desc: string; x: number; y: number }) {
    const locoKey = `${info.linha}||${info.wo}||${info.taskName}||${info.startMs}`
    const ov = activeOverrides[locoKey]
    // Each collected note keeps its own provenance (scope + scoped-edit key + slot in that scope's own
    // notes array) so the chronological merge below stays reversible — see NoteRef / updateMoveNote.
    const collected: { note: MoveNote; ref: NoteRef }[] = []
    const take = (scope: 'ws' | 'desc', key: string, arr: MoveNote[] | undefined) => {
      (arr ?? []).forEach((note, idx) => collected.push({ note, ref: { scope, key, idx } }))
    }
    take('ws', wsEditKeyOf(info.ws), ov?.ws?.[wsEditKeyOf(info.ws)]?.notes)
    if (info.scope === 'desc') {
      const k = descEditKeyOf(info.ws, info.subarea, info.desc)
      take('desc', k, ov?.desc?.[k]?.notes)
    } else {
      // Aggregated summary row: WS-scope trail + every Componente trail of this workstation.
      const prefix = `${info.ws}||${info.subarea ?? ''}||`
      for (const [k, se] of Object.entries(ov?.desc ?? {})) {
        if (k.startsWith(prefix) && se.notes?.length) take('desc', k, se.notes)
      }
    }
    collected.sort((a, b) => String(a.note.at ?? '').localeCompare(String(b.note.at ?? '')))
    if (!collected.length) return
    const title = info.scope === 'desc'
      ? `${info.ws}${info.desc ? `-${info.desc}` : ''}`
      : wsSubLabel(info.ws, info.subarea)
    setMoveNoteView({
      notes: collected.map(c => c.note), refs: collected.map(c => c.ref),
      locoKey, title, x: info.x, y: info.y,
    })
  }

  // ── Edit an existing reason card (metadata only) ──────────────────────────────────────────────
  // Changing a move's classification/observation used to require MOVING THE BOX AGAIN, which is the
  // wrong tool: re-moving writes a new shift and appends a new trail entry just to fix a typo. This
  // rewrites the stored note IN PLACE and touches nothing else.
  //
  // It deliberately does NOT route through writeScopedEdit/applyScopedEdits: those rebuild the whole
  // scoped edit from takt/startShift/finishShift arguments, so a metadata fix would have to
  // reconstruct every positional field correctly to avoid perturbing the schedule. Writing the notes
  // array directly makes "positions cannot change here" true by construction, not by care.
  //
  // `at`/`by` are left untouched — they record when the MOVE happened and who made it, which an
  // after-the-fact correction of the reason does not change.
  function updateMoveNote(index: number, category: string | null, text: string) {
    const view = moveNoteView
    if (!view) return
    const ref = view.refs[index]
    const cur = activeOverrides[view.locoKey]
    if (!ref || !cur) return
    const bucket = ref.scope === 'ws' ? cur.ws : cur.desc
    const scoped = bucket?.[ref.key]
    const prev = scoped?.notes?.[ref.idx]
    if (!scoped || !prev) return

    const cleanText = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MOVE_NOTE_MAX_LEN)
    const cleanCat = String(category ?? '').trim()
    // A note with neither a classification nor an observation carries no information; the trail keeps
    // the entry only while one of the two survives (mirrors applyMoveNote's empty-entry rule).
    if (!cleanText && !cleanCat) return
    const nextNote: MoveNote = { ...prev, text: cleanText }
    if (cleanCat) nextNote.category = cleanCat; else delete nextNote.category

    const notes = scoped.notes!.slice()
    notes[ref.idx] = nextNote
    const nextScoped: ScopedEdit = { ...scoped, notes }
    const nextOv: LocoVisualOverride = ref.scope === 'ws'
      ? { ...cur, ws: { ...(cur.ws ?? {}), [ref.key]: nextScoped } }
      : { ...cur, desc: { ...(cur.desc ?? {}), [ref.key]: nextScoped } }

    setActiveOverrides(prevMap => ({ ...prevMap, [view.locoKey]: nextOv }))
    // Re-render the LOCO so the badge's hover title picks up the new text. Notes never feed a date
    // transform, so this repaints annotations only — no bar can move.
    ganttTableRef.current?.patchLocos({ [view.locoKey]: nextOv })
    // Keep the open bubble in sync with what was just stored (same refs — only the note changed).
    setMoveNoteView(v => {
      if (!v) return v
      const shown = v.notes.slice()
      shown[index] = nextNote
      return { ...v, notes: shown }
    })
  }

  function cancelMove() {
    if (!moveMode) return
    // Esc while the crossing warning is open = "Parar aqui": dismiss the warning, keep the move at its
    // last valid position (do NOT tear the whole move down).
    if (pdWarn) { setPdWarn(null); return }
    // The preview only re-rendered the loco (the real override was never touched), so cancelling is just
    // dropping the frozen preview and repainting the saved state — nothing to revert.
    clearMoveFreeze(moveMode.locoKey)
    setPdWarn(null)
    setMoveMode(null)
  }

  // Open the scoped edit dialog from the right-click menu at the chosen scope.
  function openEditPanelFromMenu(scope: EditScope) {
    if (!editMenu) return
    setEditPanel({ ...editMenu.target, scope })
    setEditMenu(null)
  }

  // True when THIS target's scope carries an active modification (so the menu can offer a
  // contextual "Resetar …" below its "Editar …"). For `loco` only the LOCO-level fields count
  // (its nested ws/desc edits have their own per-item reset); ws/desc check their own entry.
  /** Does this locomotive carry ANY override at all (loco-level, workstation or componente)? Gates the
   *  "Resetar LOCO" menu item, which restores the ENTIRE locomotive — so a loco whose only edits are on
   *  its workstations must offer it. `hasActiveScope('loco', …)` is deliberately narrower (loco-level
   *  fields only) and is still what the LOCO edit panel uses. */
  function hasAnyLocoOverride(target: EditTarget): boolean {
    return !isEmptyOverride(writeOverrides[locoKeyForTarget(target)])
  }

  function hasActiveScope(scope: EditScope, target: EditTarget): boolean {
    const sc = scopedEditOf({ ...target, scope })
    if (!sc) return false
    if (scope === 'loco') {
      const o = sc as LocoVisualOverride
      return o.takt != null || !!o.startShiftDays || !!o.finishShiftDays
    }
    return !isEmptyScopedEdit(sc as ScopedEdit)
  }

  // Any reset drops the override the active Move Mode / post-move prompt was built on. Leaving that
  // transient state around means its `orig`/deltas (captured against the PRE-reset shift) get replayed
  // onto a now-baseline row — the "after Reset the workstation jumps several boxes / won't move" report.
  // Clearing it forces the next Move to start cleanly from the reset position.
  function endMoveStateForReset() {
    // Drop any frozen preview so a reset never leaves the moved loco showing its (untouched) preview render.
    if (moveMode) clearMoveFreeze(moveMode.locoKey)
    else if (movePropPrompt) clearMoveFreeze(movePropPrompt.locoKey)
    setMoveMode(null)
    setMovePropPrompt(null)
    setPdWarn(null)
  }

  // Reset just the chosen scope of the right-clicked target — clears only that item's override
  // (the one componente). Other locomotives, workstations, components, and global overrides are
  // untouched. LOCO and Workstation resets are WIDER than one scope — see the two below.
  function resetScopeFromMenu(scope: EditScope) {
    if (!editMenu) return
    endMoveStateForReset()
    clearScopedEdit({ ...editMenu.target, scope })
    setEditMenu(null)
  }

  // ── Reset LOCO — back to the imported baseline, completely ────────────────────────────────────
  // This used to clear only the LOCO-LEVEL fields (takt / start / finish shift) and deliberately left
  // every nested workstation and componente edit in place. The result was a "reset" that returned a
  // partially edited locomotive: durations restored where a loco-level takt had been applied, but
  // every per-workstation start shift still active. "Reset" has to mean the baseline.
  //
  // Dropping the whole map entry removes the loco-level edit, every ws/desc edit, and with them every
  // propagation effect those edits were producing — propagation is a flag ON an edit, so it cannot
  // outlive it. Nothing else can reintroduce a shift: overrides are re-applied from base each render,
  // so a locomotive with no entry renders exactly as imported.
  //
  // Cross-loco cascades that a GLOBAL propagation wrote into OTHER locomotives are their own stored
  // edits and are intentionally left alone — resetting this loco must not silently rewrite its
  // neighbours. Reset those locos individually (or use the global Reset) if that is what is wanted.
  //
  // In Projeção this clears only the PROJECTION entry: the locomotive falls back to its Standard
  // state, not to base. Resetting a simulation must never delete operational planning.
  function resetLocoFromMenu(t: EditTarget) {
    const key = locoKeyForTarget(t)
    endMoveStateForReset()
    setActiveOverrides(prev => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    const revealed = inheritOverrides?.[key]
    ganttTableRef.current?.patchLocos({ [key]: revealed && !isEmptyOverride(revealed) ? revealed : {} })
    setEditMenu(null)
  }

  /** Every desc-scope key belonging to one workstation. A Componente key is `ws||subarea||desc`, so a
   *  workstation owns every key prefixed `ws||` — across ALL its sub-áreas. (Same prefix convention as
   *  the cross-scope note lookup in openMoveNote.) The `||` separator keeps "WS4" from matching
   *  "WS40||…". */
  function descKeysOfWorkstation(ov: LocoVisualOverride | undefined, ws: string): string[] {
    if (!ov?.desc) return []
    const prefix = `${ws}||`
    return Object.keys(ov.desc).filter(k => k.startsWith(prefix))
  }

  // How many component rows the clicked row's workstation carries — counted by ws key across ALL its
  // sub-área entries (the ws edit-scope is the ws alone). Drives the FULL-mode single-component menu
  // simplification: a WS with exactly one component makes "Editar Workstation" redundant with
  // "Editar Componente", so only the component action is offered.
  function wsComponentCount(t: EditTarget): number {
    return wsComponentsOf(t).length
  }

  /** The DISTINCT Componentes of a workstation, deduped exactly the way the renderer and the edit keys
   *  define one: `ws || subarea || desc`.
   *
   *  Counting raw `desc_rows` instead (as this used to) counts PART-NUMBER rows, and a workstation whose
   *  part rows all share a single description renders as ONE component but counted as several. It was
   *  therefore treated as multi-component and denied direct hours editing, even though the user sees a
   *  single entity — the reported bug. descEditKeyOf is the authority on Componente identity, so the
   *  count has to agree with it or the two disagree about what a component is. */
  const _wsNorm4050 = (ws: string): string => String(ws || '').trim().toUpperCase().replace(/\s+/g, '')

  function wsComponentsOf(t: EditTarget): { ws: string; subarea: string; desc: string }[] {
    const key = locoKeyForTarget(t)
    const g = (dataRef.current?.groups ?? []).find(gr => locoKeyOf(gr) === key)
    if (!g) return []
    const wsN = _wsNorm4050(t.ws ?? '')
    const seen = new Map<string, { ws: string; subarea: string; desc: string }>()
    for (const w of g.workstations) {
      if (_wsNorm4050(w.ws) !== wsN) continue
      for (const dr of w.desc_rows) {
        const comp = { ws: String(w.ws ?? ''), subarea: String(w.subarea ?? ''), desc: String(dr.desc ?? '') }
        const k = descEditKeyOf(comp.ws, comp.subarea, comp.desc)
        if (!seen.has(k)) seen.set(k, comp)
      }
    }
    // A MANUALLY-ADDED station has no rows in the base data (it exists only as an override), so the
    // loop above finds nothing and the station used to be treated as having ZERO components — which
    // sent it down the multi-component path and disabled its hours with "gerenciadas no nível do
    // componente", even though it has exactly one and no component level to go to. It is a
    // single-component station by construction: one desc_row, named after itself unless the entry
    // says otherwise (mirrors _injectAddedWorkstations in the worker).
    if (!seen.size) {
      const a = addedWsOf(t)
      if (a) return [{ ws: a.ws, subarea: a.subarea ?? '', desc: a.desc || a.ws }]
    }
    return [...seen.values()]
  }

  // For a workstation target, when the WS has EXACTLY ONE component (one desc row across its sub-área
  // entries — a lone blank-descrição row counts), return that component's DESC-scope target. Hours are
  // desc-scoped in the worker (applyDescEdits scales part-number rows; applyWsEdits ignores hoursTotal),
  // so a single-component workstation edits its sole component under a "Workstation" label (asWs).
  // null when the WS has 0 or ≥2 components.
  function soleComponentTarget(t: EditTarget): EditTarget | null {
    // Deduped by Componente identity (wsComponentsOf), so a workstation whose several part-number rows
    // share ONE description resolves to that single component and edits its hours directly — which is
    // what the user sees on screen. Multiple part rows are summed by componentHoursBase and rescaled
    // proportionally by the worker, so the total shown and saved covers the whole workstation.
    const comps = wsComponentsOf(t)
    if (comps.length !== 1) return null
    return { ...t, scope: 'desc', ws: comps[0].ws, subarea: comps[0].subarea, desc: comps[0].desc, asWs: true }
  }

  // The target the "Editar Workstation" action edits: a single-component workstation edits its sole
  // component (desc scope → the Hours section works); any other workstation edits at ws scope.
  function workstationEditTarget(t: EditTarget): EditTarget {
    return soleComponentTarget(t) ?? { ...t, scope: 'ws' }
  }
  function openWorkstationEditFromMenu() {
    if (!editMenu) return
    setEditPanel(workstationEditTarget(editMenu.target))
    setEditMenu(null)
  }
  // "Editar Workstation" has an override to reset when the WS scope (e.g. a Trocar Workstation swap)
  // OR ANY of the workstation's componentes carries one — not just its sole component. A
  // multi-component workstation whose components were edited individually is still an edited
  // workstation, and used to offer no reset at all.
  function hasWorkstationScope(t: EditTarget): boolean {
    if (hasActiveScope('ws', t)) return true
    const ov = writeOverrides[locoKeyForTarget(t)]
    return descKeysOfWorkstation(ov, String(t.ws ?? '')).some(k => !isEmptyScopedEdit(ov?.desc?.[k]))
  }

  // Reset Workstation — the WS-scope edit AND every componente underneath it.
  //
  // It used to clear the WS scope plus the SOLE component (when the workstation had exactly one), so
  // on a multi-component workstation every per-component edit survived the reset: duration came back
  // from the WS-scope clear while the components kept their own start shifts. That is precisely the
  // "duration restored, start date still overridden" symptom. A workstation reset now covers every
  // componente of every sub-área, in one commit so the rows can't clobber each other.
  //
  // Deletes the entries OUTRIGHT rather than writing empty scoped edits. writeScopedEdit deliberately
  // carries metadata forward when a caller passes none (notes, satManual, swap, and — for ws scope —
  // hoursTotal), which is right for an edit but wrong for a reset: it would leave the very "associated
  // override metadata" a reset is supposed to remove. Deleting makes completeness structural.
  function resetWorkstationFromMenu(t: EditTarget) {
    const key = locoKeyForTarget(t)
    const ws = String(t.ws ?? '')
    if (!writeOverrides[key]) { setEditMenu(null); return }
    endMoveStateForReset()
    // HALF A SWAP CANNOT SURVIVE ITS PARTNER'S RESET. A WS40↔WS50 trade is one exchange stored as two
    // equal-and-opposite entries; deleting only the reset station's half left the partner parked in the
    // vacated slot with nothing traded for it — the station stayed displaced, so the "reset" workstation
    // kept generating deviation records against the baseline. Undo the partner's half first (the same
    // exact inverse the un-swap toggle uses: subtract its recorded swapShift, drop the markers, keep
    // every unrelated edit), then delete this station's own entry on top of the result.
    let base = writeOverrides
    const n4050 = _wsNorm4050(ws)
    if (n4050 === 'WS40' || n4050 === 'WS50') {
      // Read the COMPOSED map for the markers, like swapWorkstationFromMenu: in Projeção the swap may
      // live in the Standard layer, where the raw write layer has no entry for it yet.
      const composed = activeOverrides[key]
      const mine = composed?.ws?.[wsEditKeyOf(ws)]
      if (mine?.swap || mine?.swapShift) {
        const otherWs = n4050 === 'WS40' ? 'WS50' : 'WS40'
        const other = composed?.ws?.[wsEditKeyOf(otherWs)]
        if (other?.swap || other?.swapShift) base = commitScopedEdits(base, [unswapItem(t, otherWs, other)])
      }
    }
    const cur = base[key]
    if (!cur) { setEditMenu(null); return }
    const next: LocoVisualOverride = { ...cur }
    if (next.ws) {
      const w = { ...next.ws }
      delete w[wsEditKeyOf(ws)]
      if (Object.keys(w).length) next.ws = w; else delete next.ws
    }
    const descKeys = descKeysOfWorkstation(cur, ws)
    if (descKeys.length && next.desc) {
      const d = { ...next.desc }
      for (const k of descKeys) delete d[k]
      if (Object.keys(d).length) next.desc = d; else delete next.desc
    }
    // A MANUALLY-ADDED station is itself an override of this workstation, so a reset to baseline has to
    // take it with the rest: the baseline simply has no such station. Leaving it behind produced a
    // "reset" workstation that still carried its authored hours into the plan and kept generating
    // deviation records. ("Remover Workstation" remains the targeted way to delete only the station.)
    if (next.addWs) {
      const a = { ...next.addWs }
      delete a[wsEditKeyOf(ws)]
      if (Object.keys(a).length) next.addWs = a; else delete next.addWs
    }
    // A locomotive left with nothing at all drops its entry entirely, so it renders straight from base
    // and stops counting as an edited loco.
    const empty = isEmptyOverride(next)
    setActiveOverrides(prev => {
      const out = { ...prev }
      if (empty) delete out[key]; else out[key] = next
      return out
    })
    // Projeção: re-compose over Standard so clearing a projection edit reveals the Standard one.
    const shown = isProjection
      ? (mergeOverrideMaps({ [key]: locoOverrides[key] ?? {} }, { [key]: empty ? {} : next })[key] ?? {})
      : (empty ? {} : next)
    ganttTableRef.current?.patchLocos({ [key]: isEmptyOverride(shown) ? {} : shown })
    setEditMenu(null)
  }


  /** FALLBACK inverse of a swap, for the cases where the live exchange cannot run (Schedule not
   *  ready, the backend refusing an interleaved pair — see `failSwap`). The normal path un-swaps by
   *  exchanging the stations' CURRENT slots, which is the only version that survives a cascade the
   *  pair inherited in the meantime.
   *
   *  Undo one station's half of a swap: subtract the recorded `swapShift` from its cumulative shift and
   *  drop the swap markers, keeping every unrelated edit (takt, hours, propagation, reason trail,
   *  Saturday permission — the last two ride along automatically in writeScopedEdit).
   *
   *  A station with no recorded swapShift is a legacy swap saved before it existed; there the whole
   *  stored shift IS the swap (nothing composed onto it back then), so subtracting it lands on base —
   *  the same result the old "clear the scope" behaviour produced. */
  function unswapItem(t: EditTarget, wsKey: 'WS40' | 'WS50', prev: ScopedEdit | undefined): ScopedEditItem {
    const d = prev?.swapShift ?? { start: prev?.startShiftDays ?? 0, finish: prev?.finishShiftDays ?? 0 }
    return {
      target: { ...t, scope: 'ws', ws: wsKey },
      takt: prev?.takt ?? null,
      startShift: (prev?.startShiftDays ?? 0) - d.start,
      finishShift: (prev?.finishShiftDays ?? 0) - d.finish,
      propagate: !!prev?.propagate,
      swap: false,        // explicit false CLEARS the marker (undefined would inherit it — see writeScopedEdit)
      swapShift: null,
      hoursTotal: prev?.hoursTotal ?? null,
    }
  }

  // Derive the panel's labels + prefill values for the active target (pure; reads state only).
  function panelView(t: EditTarget) {
    const scoped = scopedEditOf(t)
    // WS title mirrors the Workstation column label exactly (wsSubLabel with the em-dash separator):
    // "WS50 — CABLING", or just "WS50" when there's no distinct subárea. Componente title uses the
    // "WS-COMPONENT" form shown in the component box, e.g. "WS11-Handrail".
    const ws = String(t.ws ?? '')
    const sub = String(t.subarea ?? '')
    const wsColLabel = wsSubLabel(ws, sub)
    // A `desc` target flagged asWs (the sole component of its workstation) is titled/labelled as a
    // Workstation edit, not a Componente one.
    const asWs = !!t.asWs
    const title =
      (t.scope === 'ws' || asWs) ? `Editar Workstation "${wsColLabel}"`
      : t.scope === 'desc' ? `Editar Component "${ws}${t.desc ? `-${t.desc}` : ''}"`
      : `Editar LOCO — ${t.wo}`
    const subtitle = [t.linha, t.taskName, (t.scope === 'desc' && !asWs) ? (t.desc || t.subarea) : null]
      .filter(Boolean).join(' · ') || undefined
    // "Horas totais" — edited at the COMPONENT level. Base = the Componente's current total across its
    // part-number rows (from the base data); a zero-hour Componente can't be scaled → field disabled.
    const isDesc = t.scope === 'desc'
    const isWs = t.scope === 'ws'
    const showHoursFor = isDesc || isWs   // Hours exist for workstations/componentes, never for a LOCO
    // The editor ALWAYS opens showing the entity's current total hours — a component's own total, or a
    // multi-component workstation's summed total. It used to compute 0 for anything at ws scope, so the
    // field opened on "0" and the planner had to work out the real figure themselves.
    const hoursBase = isDesc ? componentHoursBase(t) : (isWs ? workstationHoursBase(t) : 0)
    const scopedHours = (scoped as ScopedEdit | undefined)?.hoursTotal
    return {
      title, subtitle,
      takt: scoped?.takt ?? t.takt,
      startShift: scoped?.startShiftDays ?? null,
      finishShift: scoped?.finishShiftDays ?? null,
      // Propagation is a per-edit opt-in: the panel ALWAYS opens with it OFF, so each new edit must
      // enable it explicitly. A propagate flag stored by a prior edit never silently re-applies here
      // (saving without re-enabling it clears propagation → this item's edit stops cascading).
      propagate: false,
      // The Hours tab is ALWAYS present on a workstation/component edit (never for LOCO), so it never
      // appears/disappears between a single- and a multi-component workstation (stable layout).
      showHours: showHoursFor,
      // Editable only at the component level: a single-component workstation reaches this panel as its
      // sole component (desc); a MULTI-component workstation (ws scope) shows the tab DISABLED with a
      // "managed per component" note; a zero-hour component is disabled too — EXCEPT a manually-added
      // station, whose hours are authored rather than scaled, so 0 h is a perfectly editable starting
      // point (see setAddedWsHours).
      hoursDisabled: isWs ? true : (isDesc && hoursBase <= 0 && !addedWsOf(t)),
      // A multi-component workstation can't be edited here, but it must still SHOW its current total —
      // the disabled message replaces the input, so the figure has to live in the message itself.
      hoursDisabledMsg: isWs
        ? `Total atual: ${hoursBase.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h · As horas são gerenciadas no nível do componente desta workstation.`
        : undefined,
      hoursAsWs: asWs,   // labels the section "da workstation" instead of "do componente"
      hoursBase,
      // Prefill: the stored override if any, else the current base total — for BOTH scopes, so the
      // value on screen is always the entity's real current hours (see hoursBase above).
      hoursTotal: scopedHours ?? (showHoursFor ? hoursBase : null),
      // An override is stored → open the section ON. A manually-added station ALWAYS has authored
      // hours (they are part of what created it), so its section opens on too.
      hoursActive: isDesc && (scopedHours != null || !!addedWsOf(t)),
    }
  }

  // Current TOTAL hours of a Componente (DESCRIÇÃO) = sum of its part-number rows' day-box hours, from
  // the BASE data (dataRef, never override-mutated). Base is the reference the worker scales from, and
  // the prefill/disabled state for the "Horas totais" field. Matches the ws||subarea||desc grouping the
  // worker's applyDescEdits uses.
  function componentHoursBase(t: EditTarget): number {
    const key = locoKeyForTarget(t)
    // A manually-added station has no base rows at all: its hours are AUTHORED on the addWs entry,
    // which IS the base the worker spreads across the day-boxes. Read them from there.
    const added = addedWsOf(t)
    if (added) return Math.max(0, Number(added.hoursTotal) || 0)
    const g = (dataRef.current?.groups ?? []).find(gr => locoKeyOf(gr) === key)
    if (!g) return 0
    const ws = String(t.ws ?? ''), sub = String(t.subarea ?? ''), desc = String(t.desc ?? '')
    let sum = 0
    for (const w of g.workstations) {
      if (String(w.ws ?? '') !== ws || String(w.subarea ?? '') !== sub) continue
      for (const dr of w.desc_rows) {
        if (String(dr.desc ?? '') !== desc) continue
        for (const iso in dr.cells) sum += Number((dr.cells as Record<string, { hh?: number }>)[iso]?.hh) || 0
      }
    }
    return sum
  }

  /** Total current hours of a WHOLE workstation = the sum of its Componentes. Used to prefill the Hours
   *  field on a multi-component workstation, where editing stays per-component but the planner should
   *  still SEE the workstation's real total instead of a meaningless 0. */
  function workstationHoursBase(t: EditTarget): number {
    return wsComponentsOf(t).reduce(
      (sum, c) => sum + componentHoursBase({ ...t, scope: 'desc', ws: c.ws, subarea: c.subarea, desc: c.desc }),
      0,
    )
  }

  // Visual overrides → backend LocoEdit[] (only when the user explicitly runs Optimize,
  // which intentionally recomputes; the override is its starting baseline). Only LOCO-level
  // edits map to the backend today; WS/Componente edits are display-only (skip the no-ops).
  function overridesToLocoEdits(): LocoEdit[] {
    const out: LocoEdit[] = []
    for (const [key, ov] of Object.entries(locoOverrides)) {
      if (ov.takt == null && !ov.startShiftDays && !ov.finishShiftDays) continue
      const [, wo, task_name] = key.split('||')
      out.push({
        wo, task_name,
        takt: ov.takt ?? null,
        start_shift: ov.startShiftDays ?? null,
        finish_shift: ov.finishShiftDays ?? null,
      })
    }
    return out
  }

  // UNSAVED edits = objects whose current value differs from the saved (DB) baseline. After a
  // successful save the baseline advances to the working map, so this returns to 0. Recomputes on a
  // working-map change (editing) or when the baseline moves (`savedVersion` bump on save/hydrate).
  // Working-Saturday toggles are counted alongside the loco edits: both are unsaved schedule changes
  // persisted by the SAME Save, so the footer must report one honest total rather than omit them.
  //
  // Each LAYER has its own baseline and its own Save, so the footer reports the layer currently being
  // edited: in Projeção the projection layer alone (working Saturdays belong to the operational plan,
  // so they are not counted there — a simulation does not change the factory calendar).
  const editCount = useMemo(
    () => (isProjection
      ? countUnsavedEdits(projOverrides, projSavedBaselineRef.current)
      : countUnsavedEdits(locoOverrides, savedBaselineRef.current) + saturdayEditCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isProjection, locoOverrides, projOverrides, savedVersion, projSavedVersion, saturdayEditCount],
  )

  // Global toolbar actions (both also exist per-LOCO in the edit panel).
  // Save = persist overrides to the DB delta layer · Reset = clear all (local + DB) + repaint base.
  const [overridesSaveState, setOverridesSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedCount, setSavedCount] = useState(0)        // # edits persisted (for the success message)
  const [saveError, setSaveError]   = useState<string | null>(null)
  // Password-confirmation modal before persisting. Its password text/show state lives INSIDE
  // SavePasswordModal, so typing never re-renders this heavy modal (that was the password-input stutter).
  // Edits stay local/visual until the password validates server-side — nothing is written before that.
  const [savePwModal, setSavePwModal] = useState(false)
  function openSaveModal() {
    // Allow saving when there are unsaved edits, an active optimization to bake into edits, OR an
    // unsaved working-Saturday change (a manual right-click toggle with no other edits still saves).
    // Projeção saves ONLY its own layer, so neither an active optimization nor a dirty working-Saturday
    // set can be persisted from here — gating on those would run a no-op projection save and leave the
    // real change silently unsaved. Both belong to the operational plan: save them from Padrão.
    if (isProjection ? editCount === 0 : (editCount === 0 && !optimizedData && !saturdayDirty)) return
    setSaveError(null)
    setSavePwModal(true)
  }
  // Runs from SavePasswordModal once a password is entered. Closes the dialog and hands all feedback to
  // the centered SaveStatusOverlay (saving → saved/error). On success advances the saved baseline so the
  // unsaved-edit count drops to 0. The success badge only appears AFTER the DB write actually resolves.
  async function confirmSaveOverrides(pw: string): Promise<void> {
    const n = editCount                 // edits being saved (captured before the baseline advances)
    setSavePwModal(false)               // close the dialog; the overlay now owns the feedback
    setSaveError(null)
    setOverridesSaveState('saving')
    // "Save after optimize" — bake the optimizer's result into ordinary overrides. The conflict
    // optimizer only DISPLACES/SWAPS workstations, so base→optimized is a set of per-WS business-day
    // shifts (bakeGanttDiffToOverrides); any manual edits made over the optimized view fold on top
    // (combineBakedWithManual). We persist that union as normal overrides and flip the live session to
    // the baked view (no optimizedData, no indicators), so a reload — any role, no solver — shows a
    // plain saved schedule. Without an active optimization this is the ordinary edit save.
    const base = originalDataRef.current
    // Projeção saves its OWN layer and nothing else: no optimizer bake (the optimizer plans the
    // operational schedule, not a simulation) and no working-Saturday write. Keeping the two saves
    // fully disjoint is what guarantees a projection experiment can never reach the operational plan.
    if (isProjection) {
      try {
        await saveProjOverridesToDb(projOverrides, pw)
        projSavedBaselineRef.current = getProjSavedBaseline()
        setProjSavedVersion(v => v + 1)               // → editCount recomputes to 0
        setSavedCount(n)
        setOverridesSaveState('saved')
        setTimeout(() => setOverridesSaveState(s => (s === 'saved' ? 'idle' : s)), 2500)
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: { detail?: string } }; message?: string }
        setSaveError(err?.response?.data?.detail || err?.message || 'Falha ao salvar a projeção.')
        setOverridesSaveState('error')
      }
      return
    }
    const baking = !!(optimizedData && base)
    try {
      let toPersist = locoOverrides
      // Working-Saturday set to persist: the manual toggles (working set) plus, when baking, the
      // Saturdays the optimizer actually used (so a reload re-creates those columns).
      let nextSats = saturdayWorkdays
      if (baking) {
        const used = collectOptimizerSaturdays(optimizedData)
        if (used.length) nextSats = Array.from(new Set([...saturdayWorkdays, ...used])).sort()
      }
      // Persist the working-Saturday set FIRST when it changed, so the axis the bake/edits assume
      // matches what a reload rebuilds. A wrong password fails HERE (same gate), before any override
      // write, so nothing lands inconsistently.
      if (!_sameSet(nextSats, savedSaturday)) {
        await saveSaturdayWorkdays(nextSats, pw)
      }
      if (baking) {
        // Bake base→optimized on the axis that now includes the registered Saturdays (retention), then
        // fold manual edits on top.
        const adjustedBase = applySaturdayWorkdays(base, nextSats) ?? base!
        toPersist = combineBakedWithManual(bakeGanttDiffToOverrides(adjustedBase, optimizedData!), locoOverrides)
      }
      await saveOverridesToDb(toPersist, pw)
      setSavedSaturday(nextSats)                       // working-Saturday baseline advances (dirty → 0)
      if (baking) {
        // The optimization is now ordinary edits: drop the optimized overlay + all indicators and make
        // the baked map the live working map, so what's shown equals what a reload will show.
        setOptimizedData(null)
        setActiveOptMode(null)
        setShowOptTerminal(false)
        setSaturdayWorkdays(nextSats)
        setLocoOverrides(toPersist)
        setHydratedOverrides(toPersist)                 // repaint the Schedule iframe with the baked layout
        startTransition(() => { setTableBuilt(false) })
      }
      savedBaselineRef.current = getSavedBaseline()   // the working map is now the persisted baseline
      setSavedVersion(v => v + 1)                     // → editCount recomputes to 0
      setSavedCount(baking ? (n || Object.keys(toPersist).length) : n)
      setOverridesSaveState('saved')
      setTimeout(() => setOverridesSaveState(s => (s === 'saved' ? 'idle' : s)), 2500)
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } }; message?: string }
      const status = err?.response?.status
      const detail = err?.response?.data?.detail
      // Full error to the console for diagnosis (status, server detail, or a network/CORS message).
      console.error('[gantt] save overrides failed', { status, detail, error: e })
      setSaveError(
        status === 403
          ? 'Senha incorreta.'
          : status
            ? `Falha ao salvar (HTTP ${status})${detail ? `: ${detail}` : ''}.`
            // No HTTP response at all → network drop / CORS / backend unreachable.
            : `Sem resposta do servidor${err?.message ? ` (${err.message})` : ''}. Verifique a conexão com o backend.`,
      )
      setOverridesSaveState('error')
    }
  }
  // From the error overlay's "Tentar novamente": clear the error and reopen the password dialog.
  function retrySave() { setOverridesSaveState('idle'); setSaveError(null); setSavePwModal(true) }
  // Reset reverts ONLY unsaved edits: restore the working map to the saved baseline (already-persisted
  // edits are kept) and surgically repaint just the LOCOs that differ. Never clears the DB.
  function resetAllOverrides() {
    endMoveStateForReset()
    // Also revert an unsaved working-Saturday change back to the persisted baseline (rebuild so the
    // column's working/weekend state flips back). Full rebuild, since date_info identity changes.
    if (saturdayDirty) {
      setSaturdayWorkdays(savedSaturday)
      startTransition(() => { setTableBuilt(false) })
    }
    // Reverts the layer currently being edited, against ITS baseline. In Projeção that restores the
    // saved projection layer and leaves Standard untouched.
    const baseline = isProjection ? projSavedBaselineRef.current : savedBaselineRef.current
    const working  = writeOverrides
    const patch: LocoOverrideMap = {}
    for (const k of new Set<string>([...Object.keys(working), ...Object.keys(baseline)])) {
      const cur  = JSON.stringify(working[k] ?? {})
      const base = JSON.stringify(baseline[k] ?? {})
      if (cur === base) continue
      const restored = baseline[k] ? JSON.parse(JSON.stringify(baseline[k])) : {}
      // Repaint against the COMPOSED schedule in Projeção, so a reverted projection edit falls back
      // to its Standard state rather than to the untouched base row.
      const shown = isProjection
        ? (mergeOverrideMaps({ [k]: locoOverrides[k] ?? {} }, { [k]: restored })[k] ?? {})
        : restored
      patch[k] = isEmptyOverride(shown) ? {} : shown
    }
    if (Object.keys(patch).length === 0) return   // no loco edits to revert (Saturday handled above)
    setActiveOverrides(JSON.parse(JSON.stringify(baseline)))
    ganttTableRef.current?.patchLocos(patch)        // repaint only the reverted LOCOs (Schedule iframe)
  }

  // The Schedule's conflict optimizer was removed with its endpoint; the mode selector now only
  // switches between the views that are computed in the browser.
  function handleOptimizeMode(mode: 1 | 2 | 3) {
    setActiveOptMode(mode)
  }

  // Focus tab scroll containers
  useEffect(() => {
    if (activeTab === 0 && resumoScrollRef.current) {
      const t = setTimeout(() => resumoScrollRef.current?.focus({ preventScroll: true }), 50)
      return () => clearTimeout(t)
    }
    if (activeTab === 2 && planoScrollRef.current) {
      const t = setTimeout(() => planoScrollRef.current?.focus({ preventScroll: true }), 50)
      return () => clearTimeout(t)
    }
  }, [activeTab])

  // Close export menus on outside click
  useEffect(() => {
    if (!showExportMenu) return
    const h = (e: MouseEvent) => { if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setShowExportMenu(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [showExportMenu])

  // Base schedule with the scenario's registered working Saturdays applied (is_weekend→false), so those
  // columns join the axis and baked WS40/WS50 work sits on them. A live optimize already carries its own
  // Saturday columns, so the overlay wins as-is. `originalDataRef` keeps the RAW base (optimizer input +
  // displacement diff reference).
  const calendarData = useMemo(() => applySaturdayWorkdays(data, saturdayWorkdays), [data, saturdayWorkdays])

  // ── Displayed schedule vs. deviation reference (the mode seam) ───────────────────────────────
  // Kept as two distinct inputs so Mode 3 can later re-point the reference WITHOUT touching the
  // display pipeline or duplicating any GanttData structure:
  //   • displayOptimized / displayOverrides — what the tabs RENDER. In 'original' mode both are
  //     neutralised (no optimizer overlay, no overrides) so every tab shows the untouched DB plan.
  //     The live edits remain in `locoOverrides`/`optimizedData` state and return on Standard.
  //   • referenceOverrides — the baseline deviations/impacts compare against (see planoBaseSource).
  const displayOptimized = readOnly ? null : optimizedData
  // Original → nothing; Padrão → Standard; Projeção → Standard ⊕ Projeção (the three-layer model).
  const displayOverrides = readOnly ? EMPTY_OVERRIDES : (isProjection ? projectionComposed : locoOverrides)
  const baseData = displayOptimized ?? calendarData
  if (data && !originalDataRef.current) originalDataRef.current = data
  if (optimizedData) console.log('[render] using optimizedData — groups:', optimizedData.groups.length, 'dates:', optimizedData.date_info.length)

  // Clips data to the dateRange and lineFilter passed from GanttLaunchModal
  const effectiveData = useMemo(
    () => windowGanttData(baseData, dateRange, lineFilter),
    [baseData, dateRange, lineFilter],
  )

  // Compared (inactive) scenario, windowed identically. Only in comparison mode.
  const comparisonOtherEffective = useMemo(
    () => (comparisonMode ? windowGanttData(comparisonOtherData ?? null, dateRange, lineFilter) : null),
    [comparisonMode, comparisonOtherData, dateRange, lineFilter],
  )

  // The same two datasets with the LINE filter but NO period window — the Build Plan window's kit
  // planner reads these. Its Min floor is horizon-aware (it relaxes as the remaining demand runs
  // out), so planning on the window alone told it demand ENDS at the window's edge and every pool
  // drained itself to zero there. The line filter stays applied: a Tipo the user did not load is not
  // demand they are planning for. Nothing is DRAWN from these — the columns come from the window.
  const unwindowedForPlan = useMemo(
    () => windowGanttData(baseData, null, lineFilter),
    [baseData, lineFilter],
  )
  const comparisonOtherUnwindowed = useMemo(
    () => (comparisonMode ? windowGanttData(comparisonOtherData ?? null, null, lineFilter) : null),
    [comparisonMode, comparisonOtherData, lineFilter],
  )

  // Keep ref in sync so handleOptimizeMode can read active WO list without closure staleness
  effectiveDataRef.current = effectiveData
  // Unwindowed schedule for the working-Saturday revert guard (allocationsOn). Synced in an EFFECT,
  // not during render, so it neither trips the refs-during-render rule nor captures `baseData`.
  useEffect(() => { baseDataRef.current = baseData }, [baseData])

  // ── Override-MERGED schedule for the non-Schedule tabs ─────────────────────────────────────
  // The Schedule iframe merges overrides itself (in the worker), but General Summary / Gets Planned
  // / Production Plan compute from a GanttData object. When edits are active we ask the worker — the
  // SAME merge engine, via the GanttTable handle — for the override-applied data and feed THAT to
  // those tabs, so every tab agrees with the Schedule. No overrides (or worker not ready) → fall
  // back to base data unchanged, so the zero-edit path is byte-identical to before.
  const [mergedData, setMergedData] = useState<GanttData | null>(null)
  // The exact (effectiveData identity, locoOverrides map) pair that produced the CURRENT mergedData.
  // computeEffective is a pure function of those two inputs, so when neither has changed the existing
  // mergedData is still valid and we must NOT recompute. Recomputing handed back a NEW object identity,
  // which made `summarySource` change and tricked useSummaryCompute into treating it as a dataset
  // change → it cleared the table and flashed the "recalculating" state. Because this effect also
  // depends on `activeTab` (to defer the merge off the Schedule tab), that meant EVERY tab navigation
  // produced a fresh merge → a redundant recalc flash even though no data had changed. Set only on a
  // SUCCESSFUL merge (and on the no-override branch), so a deferred/failed attempt still recomputes.
  const lastMergeRef = useRef<{ data: GanttData | null; ov: LocoOverrideMap } | null>(null)
  useEffect(() => {
    // Uses displayOverrides (not the raw edit map): in 'original' mode this is empty, so the tabs
    // fall straight through to base `effectiveData` — the untouched DB plan — with no merge at all.
    const hasOv = Object.keys(displayOverrides).length > 0
    if (!hasOv || !effectiveData || !ganttTableRef.current) {
      setMergedData(null)
      lastMergeRef.current = { data: effectiveData, ov: displayOverrides }
      return
    }
    // Only the summary/plan tabs (0/1/2) consume this merged data; the Schedule tab (3) merges
    // overrides itself inside its own iframe/worker pass. Editing happens ON the Schedule tab, and the
    // worker is SHARED — so running this full-dataset merge there would block the very same worker that
    // must do the surgical patchLocos repaint, stalling the live Schedule. THAT was the editing freeze.
    // Skip it entirely while the Schedule tab is active; it recomputes on switch to a summary tab.
    if (activeTab === 3) return
    // Reuse guard: a successful merge already exists for these EXACT inputs (same effectiveData
    // identity + same override map). A pure tab switch changes neither, so reuse the cached mergedData
    // instead of recomputing — this is what removes the redundant "recalculating" flash on navigation.
    // A real edit (new locoOverrides identity) or new dataset (new effectiveData) fails this check and
    // recomputes exactly once, which is the desired post-edit recalculation.
    if (lastMergeRef.current && lastMergeRef.current.data === effectiveData && lastMergeRef.current.ov === displayOverrides) return
    let cancelled = false
    // Debounce: a burst of edits (e.g. holding ← / + in Move Mode) would otherwise fire a full worker
    // merge per keystroke. A short trailing delay collapses a burst into ONE recompute.
    const timer = setTimeout(() => {
      if (cancelled || !ganttTableRef.current) return
      ganttTableRef.current.computeEffective(effectiveData, displayOverrides)
        .then(d => {
          if (cancelled) return
          // A REAL merge always hands back a NEW object ({...data, groups}), so getting the INPUT back
          // means the worker could not answer (unavailable, or the 8s safety net fired) and fell through
          // to its pass-the-input fallback. That must NOT be recorded as a successful merge: the reuse
          // guard above would then never recompute, pinning the un-merged plan into `summarySource` for
          // the rest of the session — overrides silently absent from every summary tab. Leave the cache
          // untouched so the next render retries.
          if (d === effectiveData) { setMergedData(null); return }
          setMergedData(d)
          lastMergeRef.current = { data: effectiveData, ov: displayOverrides }
        })
        .catch(() => { if (!cancelled) setMergedData(null) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
    // `tableBuilt` is included so that overrides hydrated from the DB on a fresh load recompute
    // once the worker has finished its first build (it isn't ready to answer before that).
  }, [effectiveData, displayOverrides, tableBuilt, activeTab])
  // What the computational tabs read: merged when edits exist (and ready), else the base data.
  const summarySource = (Object.keys(displayOverrides).length > 0 && mergedData) ? mergedData : effectiveData

  // ── Mode 3 (Projeção) deviation reference: the FROZEN reference snapshot ─────────────────────
  // = the projection reference overrides (`projectionRef`, frozen on "Atualizar referência") applied
  // to the base calendar, via the SAME worker merge as `mergedData`. Only computed in 'working' mode;
  // other modes leave it null and fall back to the original-DB reference below. Recomputes when the
  // frozen reference changes (re-freeze). Skipped on the Schedule tab (tab 3) so it never contends
  // with the live surgical repaint, mirroring the mergedData guard.
  const [referenceData, setReferenceData] = useState<GanttData | null>(null)
  const refWindowed = useMemo(
    () => (refMode === 'working' ? windowGanttData(calendarData, dateRange, lineFilter) : null),
    [refMode, calendarData, dateRange, lineFilter],
  )
  useEffect(() => {
    if (refMode !== 'working' || !refWindowed || !ganttTableRef.current) { setReferenceData(null); return }
    if (activeTab === 3) return
    // Baseline = the LIVE Standard layer. In the three-layer model Projeção sits directly on top of
    // Standard, so its deviation reference is simply "the schedule without the projection edits" —
    // recomputed automatically as Standard changes, with nothing to freeze and no ambiguity about
    // which snapshot is current. Projeção NEVER compares against Original.
    //
    // Empty Standard = Standard IS the original, so the reference is the base calendar itself; leaving
    // it null makes planoBaseSource fall back to the current schedule, which would report zero
    // deviation for real projection edits. Pass the empty map through instead so the comparison is
    // against base and the projection's own edits show up as the deviation they are.
    const baselineOv = locoOverrides
    let cancelled = false
    ganttTableRef.current.computeEffective(refWindowed, baselineOv)
      .then(d => { if (!cancelled) setReferenceData(d) })
      .catch(() => { if (!cancelled) setReferenceData(refWindowed) })
    return () => { cancelled = true }
    // locoOverrides → the reference now tracks the LIVE Standard layer, so every Standard edit
    // recomputes it; tableBuilt → worker readiness.
  }, [refMode, refWindowed, activeTab, locoOverrides, tableBuilt])

  // ── Projeção reference history: cumulative / per-freeze deviation ledger ─────────────────────
  // Quantifies what each "Atualizar referência" freeze absorbed and the deviation accumulated since the
  // original reference (version 0). Each baseline's SCHEDULE = its frozen overrides applied to the base
  // calendar (worker computeEffective); we compare consecutive versions and the current schedule at the
  // WORKSTATION level — the same grain as the red/orange delay/recovery hatches: a WS can deviate from
  // the reference even when the LOCO finish doesn't move. Per WS (loco‖ws‖subárea) finish delta in
  // business days: net = Σ(delay − recovery); deviatingWs = how many workstations differ (either way).
  // Computed lazily while the history panel is open (Projeção only). Placed here so it can read
  // refWindowed / summarySource (declared above).
  // Two complementary views of one deviation (the user asked for BOTH):
  //   • netDays / deviatingWs — SCHEDULE date slip, per workstation finish (the red/orange hatch grain).
  //   • hoursMoved — PRODUCTION hours redistributed between fiscal weeks (the Plano de Produção "Impacto
  //     no Planejamento" metric): how many hours entered a new week vs the reference.
  type RefDeviation = { netDays: number; deviatingWs: number; hoursMoved: number }
  type RefFreezeStat = { version: number; label: string | null; createdAt: string | null; createdBy: string | null; absorbed: RefDeviation }
  const [refHistoryStats, setRefHistoryStats] = useState<{ freezes: RefFreezeStat[]; cumulative: RefDeviation; incremental: RefDeviation } | null>(null)
  const [refHistoryBusy, setRefHistoryBusy] = useState(false)

  const _bizAxis = (): string[] =>
    (dataRef.current?.date_info ?? []).filter(d => !d.is_weekend && !d.is_holiday).map(d => d.iso).sort()
  const _idxAtOrBefore = (axis: string[], iso: string): number => {
    let lo = 0, hi = axis.length - 1, ans = 0
    while (lo <= hi) { const m = (lo + hi) >> 1; if (axis[m] <= iso) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans
  }
  // Finish ISO per WORKSTATION (keyed loco‖ws‖subárea) = the latest cell across that station's desc rows.
  const _finishByWs = (d: GanttData | null): Map<string, string> => {
    const out = new Map<string, string>()
    for (const g of d?.groups ?? []) {
      const lk = locoKeyOf(g)
      for (const w of g.workstations) {
        let last = ''
        for (const dr of w.desc_rows) for (const iso in dr.cells) if (iso > last) last = iso
        if (!last) continue
        const key = `${lk}||${w.ws ?? ''}||${w.subarea ?? ''}`
        const prev = out.get(key)
        if (prev == null || last > prev) out.set(key, last)   // a WS split across rows → keep the latest finish
      }
    }
    return out
  }
  // Hours per (work unit × fiscal week), mirroring buildPlanoRows' impact keying (loco‖area‖ws-desc‖pn‖
  // modelo) so the ledger's hours number reconciles with the Plano de Produção resume.
  const _hoursByUnitFw = (d: GanttData | null): Map<string, number> => {
    const out = new Map<string, number>()
    const fwMap = d?.fw_map ?? {}
    for (const g of d?.groups ?? []) {
      for (const w of g.workstations) {
        const area = w.area ?? ''
        for (const dr of w.desc_rows) {
          const unit = `${g.task_name}||${area}||${w.ws ?? ''}-${dr.desc ?? ''}||${String(dr.pn ?? '')}||${g.wo}`
          const cells = dr.cells as Record<string, { hh?: number }>
          for (const iso in cells) {
            const fw = fwMap[iso]; if (!fw) continue
            const hh = Number(cells[iso]?.hh) || 0
            if (!hh) continue
            const key = `${unit}||${fw}`
            out.set(key, (out.get(key) ?? 0) + hh)
          }
        }
      }
    }
    return out
  }
  const _deviationBetween = (axis: string[], newer: GanttData | null, older: GanttData | null): RefDeviation => {
    const oldF = _finishByWs(older), newF = _finishByWs(newer)
    let netDays = 0, deviatingWs = 0
    for (const [k, isoNew] of newF) {
      const isoOld = oldF.get(k); if (isoOld == null) continue
      const d = _idxAtOrBefore(axis, isoNew) - _idxAtOrBefore(axis, isoOld)
      netDays += d
      if (d !== 0) deviatingWs++
    }
    // Hours moved = Σ hours that ENTERED a (work unit, fiscal week) slot vs the reference.
    const oldH = _hoursByUnitFw(older), newH = _hoursByUnitFw(newer)
    let hoursMoved = 0
    for (const [k, hv] of newH) { const b = oldH.get(k) ?? 0; if (hv > b) hoursMoved += hv - b }
    return { netDays, deviatingWs, hoursMoved }
  }

  useEffect(() => {
    if (!showRefHistory) return
    const tbl = ganttTableRef.current
    // Gate on a built worker: computeEffective silently returns the base data (no overrides applied)
    // when the worker isn't ready, which would show misleading zero deviations.
    if (!tbl || !tableBuilt || !refWindowed || !summarySource || projBaselines.length === 0) { setRefHistoryStats(null); return }
    let cancelled = false
    setRefHistoryBusy(true)
    ;(async () => {
      try {
        const axis = _bizAxis()
        const scheds: GanttData[] = []
        for (const v of projBaselines) {
          const s = await tbl.computeEffective(refWindowed, v.overrides)
          if (cancelled) return
          scheds.push(s)
        }
        const freezes: RefFreezeStat[] = projBaselines.map((v, i) => ({
          version: v.version, label: v.label, createdAt: v.createdAt, createdBy: v.createdBy,
          absorbed: i === 0 ? { netDays: 0, deviatingWs: 0, hoursMoved: 0 } : _deviationBetween(axis, scheds[i], scheds[i - 1]),
        }))
        const cumulative  = _deviationBetween(axis, summarySource, scheds[0])
        const incremental = _deviationBetween(axis, summarySource, scheds[scheds.length - 1])
        if (!cancelled) setRefHistoryStats({ freezes, cumulative, incremental })
      } catch { if (!cancelled) setRefHistoryStats(null) }
      finally { if (!cancelled) setRefHistoryBusy(false) }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRefHistory, projBaselines, summarySource, refWindowed, tableBuilt])

  // Presentation helpers for the history panel.
  const fmtRefDate = (iso: string | null): string => {
    if (!iso) return 'Referência importada (data original)'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  const devText = (dev?: RefDeviation): string => {
    if (!dev) return '—'
    if (dev.netDays === 0) return 'sem desvio'
    return dev.netDays > 0 ? `+${dev.netDays} dia(s) de atraso` : `${Math.abs(dev.netDays)} dia(s) adiantado`
  }
  const devColor = (dev?: RefDeviation): string =>
    (!dev || dev.netDays === 0) ? '#6B7280' : dev.netDays > 0 ? '#DC2626' : '#059669'
  const hoursText = (dev?: RefDeviation): string =>
    (!dev || dev.hoursMoved <= 0) ? '0 h' : `${Math.round(dev.hoursMoved).toLocaleString('pt-BR')} h`

  // ── LOCOs hidden from the Schedule by "Ocultar LOCOs concluídas" ─────────────────────
  // The worker drops rows with no activity today or later, evaluated on the OVERRIDE-MERGED
  // groups. This mirrors that rule on the same merged data (summarySource), so the set here and
  // the rows the Schedule actually shows always agree — Resumo Geral uses it to disable
  // navigation clicks on locos the Schedule can't display. Key = wo||task||start_ms (the same
  // per-instance identity useSummaryCompute groups by). null = the filter is off.
  const hiddenScheduleLocos = useMemo<Set<string> | null>(() => {
    if (!hidePastLocos || !summarySource) return null
    const today = localTodayIso()
    const future = new Set<string>()
    const all = new Set<string>()
    for (const g of summarySource.groups) {
      const k = `${g.wo}||${g.task_name}||${String(g.start_ms ?? '')}`
      all.add(k)
      if (future.has(k)) continue
      outer: for (const w of g.workstations) {
        for (const dr of w.desc_rows) {
          for (const iso in dr.cells) if (iso >= today) { future.add(k); break outer }
        }
      }
    }
    const hidden = new Set<string>()
    for (const k of all) if (!future.has(k)) hidden.add(k)
    return hidden
  }, [hidePastLocos, summarySource])

  // Base Scenario reference for the Plano de Produção impact summary: the loaded schedule
  // WITHOUT optimizer output and WITHOUT loco overrides, windowed exactly like
  // summarySource so the two are directly comparable. `calendarData` (not raw `data`) is
  // the right base: the scenario's working Saturdays are part of the plan being edited,
  // not one of the edits, and using it keeps both sides on the same date axis.
  // Everything summarySource adds on top of this — overrides, moves, optimizations — is
  // precisely the impact being measured.
  //
  // With no optimization active this IS `effectiveData`, returned by identity rather than
  // re-windowed. That matters: with no edits either, summarySource is also effectiveData,
  // so the tab receives base === data, sees there is nothing to compare, and skips the
  // whole base row build. An unedited schedule therefore costs exactly what it did before
  // this feature existed — no second pass over ~67k rows to render a strip of zeros.
  //
  // This is the DEVIATION REFERENCE SCHEDULE, deliberately distinct from the displayed schedule
  // (`summarySource`). That separation is the whole Mode-3 seam:
  //   • 'standard' / 'original' → reference = original DB plan (calendarData, no overrides), as
  //     below. `displayOptimized` (not raw optimizedData) keeps 'original' mode on the identity
  //     fast-path: with the optimizer suppressed, planoBaseSource === effectiveData === summarySource,
  //     so the read-only audit view measures zero deviation and skips the base pass entirely.
  //   • 'working' (Mode 3, Projeção) → reference = the FROZEN reference snapshot (`referenceData`,
  //     computed above from projectionRef, falling back to the saved standard). Deviations measure the
  //     current schedule against the last "Atualizar referência" freeze / the saved standard — NEVER
  //     against the untouched original. When there is no reference yet (referenceData null) we fall back
  //     to `summarySource` (the current schedule itself) so the tab sees base === data and shows ZERO
  //     deviation, rather than a spurious delay versus the original plan.
  const planoBaseSource = useMemo(
    () => {
      if (refMode === 'working') return referenceData ?? summarySource
      return displayOptimized ? windowGanttData(calendarData, dateRange, lineFilter) : effectiveData
    },
    [refMode, referenceData, summarySource, displayOptimized, calendarData, dateRange, lineFilter, effectiveData],
  )

  // ── Schedule-tab delay hatches: reference the ACTIVE mode's baseline (Projeção) ───────────────
  // The red/orange delay/recovery boxes on the Schedule are computed in the worker as the shift of
  // each WS from a BASE. In Padrão/Original that base is the original schedule (empty map → the
  // worker keeps its original behaviour). In Projeção the base must be the FROZEN projection
  // reference so a loco already sitting at the reference hatches ZERO — the SAME baseline
  // `referenceData` uses (latest frozen version, else the saved standard), so the hatches agree
  // with the Plano/Resumo deviations. Empty outside Projeção → worker behaviour unchanged there.
  const scheduleHatchReference = useMemo<LocoOverrideMap>(
    () => {
      if (refMode !== 'working') return EMPTY_OVERRIDES
      // Mirrors `referenceData`: the hatch base is the LIVE Standard layer, so a WS sitting exactly
      // where Standard put it hatches ZERO and only the projection's own displacement is drawn. Both
      // the Schedule hatches and the Plano/Resumo deviations therefore read the same baseline.
      return locoOverrides
    },
    [refMode, locoOverrides],
  )

  // Displacement map: only present when optimizedData is active.
  // For each shifted ws, records the business days between original and optimized first-active day.
  const displacementInfo = useMemo((): { map: Record<string, string[]>; advance: Set<string>; recovered: Record<string, string[]> } | undefined => {
    // `displayOptimized` (not raw optimizedData) → in 'original' read-only mode the optimizer overlay
    // is suppressed along with everything else, so there is no displacement/recovery decoration.
    if (!displayOptimized || !originalDataRef.current) return undefined
    const orig = originalDataRef.current
    const opt  = displayOptimized
    // Displacement = the WORKING days a workstation moved across. It MUST exclude
    // holidays as well as weekends, exactly like the backend's _add_business_days
    // (which skips Sat/Sun AND Brazilian holidays). Counting only !is_weekend left
    // holidays in the span, so a shift that crossed a holiday cluster (e.g. Oct 11–12
    // 2027, Aparecida + bridge) over-reported the delay by the #holidays crossed —
    // e.g. a real +4-business-day shift showed as +6. Holidays now come from the
    // server's admin-editable calendar via date_info.is_holiday (single source of truth).
    const _diSrc = effectiveData?.date_info ?? orig.date_info
    // A "working Saturday" (Mode 1 "Usar Sábados") is flagged is_weekend=false by the
    // backend (gantt_builder _is_weekend_day) so it renders as a normal column — but it is
    // RECOVERED time, never a lost working day. The delay/hatched region must therefore
    // exclude Saturdays (and Sundays) by WEEKDAY, not just trust is_weekend; otherwise a
    // recovered Saturday is miscounted as a delay day (hatched box on a Saturday AND an
    // inflated Delay Days badge).
    const isSatOrSun = (iso: string): boolean => {
      const wd = new Date(`${iso}T00:00:00Z`).getUTCDay()  // 0=Sun … 6=Sat
      return wd === 0 || wd === 6
    }
    const businessDaySet = new Set(
      _diSrc
        .filter(d => !d.is_weekend && !d.is_holiday && !isSatOrSun(d.iso))
        .map(d => d.iso)
    )

    // First active ISO day of ONE desc_row (not the whole WS) — displacement must be
    // computed per DESCRIÇÃO row, because rows in the same WS can have different starts.
    const descRowFirstDay = (dr: { cells: Record<string, unknown> }): string | undefined =>
      Object.keys(dr.cells).sort()[0]
    // Last allocated day of ONE desc_row — needed for the early-finish recovery box (req 3),
    // which trails AFTER the WS block (the displacement box leads BEFORE it).
    const descRowLastDay = (dr: { cells: Record<string, unknown> }): string | undefined => {
      const ks = Object.keys(dr.cells).sort()
      return ks[ks.length - 1]
    }
    // Count of Saturday cells a desc_row occupies (only WS40/WS50 ever can). Each Saturday
    // used means one fewer WEEKDAY slot is needed, so the block's tail lands that many
    // weekdays earlier than the same cells placed Mon–Fri — i.e. the gained/recovered days.
    const rowSaturdayCells = (dr: { cells: Record<string, unknown> }): number =>
      Object.keys(dr.cells).filter(iso => new Date(`${iso}T00:00:00Z`).getUTCDay() === 6).length

    const wsNorm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    const isTargetWs = (ws: string) => wsNorm(ws) === 'WS40' || wsNorm(ws) === 'WS50'
    // LOCOs whose WS40↔WS50 order was actually swapped — only these earn an "advanced WS"
    // (moved-earlier) visual box. swapped_locos is keyed "wo||task_name" (backend meta).
    const swappedSet = new Set<string>(opt._optimization?.swapped_locos ?? [])

    const sortedBizDays = [...businessDaySet].sort()
    // The hatched region is ALWAYS the working days in [s0, s1) — INCLUSIVE of s0, EXCLUSIVE
    // of s1 (so it abuts the WS box, ending at s1−1, and never plots before s0). Saturdays /
    // holidays are already absent from sortedBizDays. EVERY displaced WS (target or successor,
    // delayed or advanced) uses this single span — same start-date reference for hatched
    // boxes, Delay Days and the displacement count, so the three can never disagree.
    const bizDaysBetween = (s0: string, s1: string): string[] =>
      sortedBizDays.filter(iso => iso >= s0 && iso < s1)

    // Key by wo||task_name only — start_ms differs between orig and opt after shifting
    const origByKey = new Map<string, typeof orig.groups[number]>()
    for (const g of orig.groups) {
      origByKey.set(`${g.wo}||${g.task_name}`, g)
    }

    const result: Record<string, string[]> = {}
    // Row keys whose box is an ADVANCED (moved-earlier) swapped WS: rendered for the visual
    // but EXCLUDED from the +N delay badge so the swap's reorder distance never inflates it.
    const advance = new Set<string>()
    // Early-finish recovery boxes (req 3): per-row trailing weekdays a conflict WS (WS40/WS50)
    // would have extended into had it NOT used a Saturday. Purely informational (orange) — never
    // a delay/PD/conflict; kept separate from `result` so it can never feed any metric.
    const recovered: Record<string, string[]> = {}
    for (const optGroup of opt.groups) {
      const groupKey = `${optGroup.wo}||${optGroup.task_name}`
      const origGroup = origByKey.get(groupKey)
      if (!origGroup) continue

      const origWsMap = new Map<string, typeof origGroup.workstations[number]>()
      for (const wst of origGroup.workstations) {
        origWsMap.set(`${wst.ws}||${wst.subarea ?? ''}`, wst)
      }

      // SWAPPED BASELINE. When WS40↔WS50 are reordered the two stations EXCHANGE slots:
      // WS40 inherits WS50's original anchor and vice-versa. Displacement must therefore be
      // measured against the SWAPPED reference (WS40 → WS50's old start, WS50 → WS40's old
      // start), not each WS's pre-swap start — otherwise the reorder distance itself shows up
      // as a bogus delay (one WS hatched all the way from A to B, Delay Days overcounted).
      // A clean swap (each WS lands on its partner's old slot) then has zero displacement.
      const isSwapped = swappedSet.has(groupKey)
      let origWs40First: string | undefined
      let origWs50First: string | undefined
      if (isSwapped) {
        for (const wst of origGroup.workstations) {
          const n = wsNorm(wst.ws)
          if (n !== 'WS40' && n !== 'WS50') continue
          const f = wst.desc_rows.map(descRowFirstDay).filter((x): x is string => !!x).sort()[0]
          if (!f) continue
          if (n === 'WS40') origWs40First = !origWs40First || f < origWs40First ? f : origWs40First
          else              origWs50First = !origWs50First || f < origWs50First ? f : origWs50First
        }
      }

      for (const optWst of optGroup.workstations) {
        const wsKey  = `${optWst.ws}||${optWst.subarea ?? ''}`
        const locoKey = `${optGroup.linha}||${optGroup.wo}||${optGroup.task_name}||${optGroup.start_ms ?? ''}`
        // Each WS is matched to its OWN original counterpart (same ws||subarea) for row pairing;
        // the displacement REFERENCE is overridden to the swapped partner's start below.
        const origWst = origWsMap.get(wsKey)
        if (!origWst) continue
        const isTgt = isTargetWs(optWst.ws)
        // For a swapped target WS, the displacement baseline is the PARTNER's original start.
        const swapRef = isSwapped && isTgt
          ? (wsNorm(optWst.ws) === 'WS40' ? origWs50First : origWs40First)
          : undefined
        // Match orig↔opt desc_rows by DESCRIÇÃO (fallback to row index). Optimizer
        // only shifts dates — never adds/removes/reorders rows — so position is stable.
        const origByDesc = new Map<string, typeof origWst.desc_rows[number]>()
        origWst.desc_rows.forEach((dr, i) => origByDesc.set(`${dr.desc ?? ''}#${i}`, dr))
        const origByDescOnly = new Map<string, typeof origWst.desc_rows[number]>()
        origWst.desc_rows.forEach(dr => { if (!origByDescOnly.has(dr.desc ?? '')) origByDescOnly.set(dr.desc ?? '', dr) })

        optWst.desc_rows.forEach((optDr, dIdx) => {
          const origDr =
            origByDesc.get(`${optDr.desc ?? ''}#${dIdx}`) ??
            origByDescOnly.get(optDr.desc ?? '') ??
            origWst.desc_rows[dIdx]
          const origFirst = origDr ? descRowFirstDay(origDr) : undefined
          const optFirst  = descRowFirstDay(optDr)
          // Reference = swapped partner's original start for a swapped target WS, else this
          // WS's own original start. ALL of hatched box, Delay Days and displacement read this
          // single `refFirst`, so they can never disagree (post-swap or otherwise).
          const refFirst = swapRef ?? origFirst
          // Map key must match worker: uses optGroup fields + per-desc-row index.
          const rowKey = `${locoKey}||${wsKey}||${dIdx}`

          // ── Early-finish recovery (req 3) ──────────────────────────────────────────
          // A target WS (WS40/WS50) that landed cells on Saturdays finishes EARLIER (in weekday
          // terms) than the same cells placed Mon–Fri: every Saturday used frees one weekday at
          // the tail, pulling the downstream chain up by that many days. Show those gained days —
          // where the WS WOULD have extended without the Saturday — as an orange recovered-time
          // box: the next `satCount` business days after the row's last allocated cell. This is
          // measured from the FINAL (Saturday-inclusive) schedule only (cells already reflect the
          // single rebuilt timeline), never the pre-Saturday version. Computed BEFORE the
          // start-displacement early-return because a row can recover at its tail with an
          // unchanged start. Visual only — never a delay/PD/conflict, kept out of `result`/
          // `advance` so no metric can ever read it.
          if (isTgt) {
            const satCount = rowSaturdayCells(optDr)
            const optLast  = descRowLastDay(optDr)
            if (satCount > 0 && optLast) {
              const recDays = sortedBizDays.filter(iso => iso > optLast).slice(0, satCount)
              if (recDays.length > 0) recovered[rowKey] = recDays
            }
          }

          if (!refFirst || !optFirst || optFirst === refFirst) return
          if (optFirst > refFirst) {
            // DELAYED vs baseline — start slid LATER than the (swapped or own) reference. The
            // hatched region is exactly the working days [refFirst, optFirst): first box ON the
            // reference start (inclusive), last on new-start − 1, so it abuts the WS and never
            // plots before refFirst. For a swapped target this is the GENUINE leftover delay
            // after removing the reorder distance — so it DOES feed the +N delay badge.
            const dispDays = bizDaysBetween(refFirst, optFirst)
            if (dispDays.length === 0) return
            result[rowKey] = dispDays
          } else if (isTgt && isSwapped) {
            // EARLIER than the swapped baseline — a swapped target WS that landed before its
            // partner's old slot (a time SAVING, not a delay). Plot the vacated working days
            // [optFirst, refFirst) so the move is visible; the worker hatches only the days the
            // WS does NOT itself occupy, trailing back to refFirst − 1. Tracked in `advance`
            // so the +N delay badge IGNORES it (visual-only — a saving never inflates delay).
            const dispDays = bizDaysBetween(optFirst, refFirst)
            if (dispDays.length === 0) return
            result[rowKey] = dispDays
            advance.add(rowKey)
          }
        })
      }
    }
    return (Object.keys(result).length > 0 || Object.keys(recovered).length > 0)
      ? { map: result, advance, recovered }
      : undefined
  }, [displayOptimized, effectiveData])

  // Thin views over the combined displacement computation. `displacementMap` (delay +
  // advanced boxes) is what the worker renders; `advanceBoxKeys` flags the moved-earlier
  // swap boxes so the +N delay badge can exclude them (visual-only, no delay inflation).
  const displacementMap = displacementInfo?.map
  const advanceBoxKeys = displacementInfo?.advance
  // Early-finish recovery boxes (req 3) — orange trailing placeholders, rendered by the worker
  // exactly like displacement but AFTER the WS block. Visual only; never feeds any metric.
  const recoveredMap = displacementInfo?.recovered

  // Overlap rules are INTRINSIC to conflict classification, applied identically before
  // and after optimization: a permitted overlap on WS40/WS50 (an allowed cross-type pair,
  // OR a boundary handoff between EXACTLY 2 LOCOs — end of one == start of the other) is
  // NEVER a true conflict. Classifying with the rules ALWAYS (not only post-optimization)
  // makes the initial and optimized views agree, excludes permitted overlaps from every
  // conflict counter/label/summary, and renders them in the orange overlap style from the
  // first render — exactly as they appear after optimization. Defined before locoMeta /
  // conflictCounts so every conflict derivation in this component reads the same flag.
  const allowOverlap = true

  // Session-only conflict-WS selection (ConflictWsModal). Declared HERE, above locoMeta, because
  // the MODELO-column conflict count must evaluate the SAME set as the counts and the worker's
  // borders — a per-LOCO badge counting WS40/WS50 while the grid outlines WS71 is the exact
  // divergence this override was reported broken for.
  const conflictWs = useConflictWs()

  // Per-LOCO MODELO-column metadata for the worker: conflict count in the current
  // view, the ORIGINAL conflict count (optimization mode), and net shift in business
  // days. Purely a visual exposure of existing optimization results — no recompute of
  // the optimization itself. Keyed by "linha||wo||task_name||start_ms" (worker's key).
  const locoMeta = useMemo((): Record<string, { conflicts: number; origConflicts?: number; shiftDays?: number; pd?: number; origPd?: number; hours?: number; takt?: number; swapped?: boolean; usesSaturday?: boolean }> | undefined => {
    if (!effectiveData) return undefined
    // DETECTION set = the session selection (defaults to WS40/WS50). SAT_WS stays the physical
    // pair: the Saturday clock icon reports an optimizer placement rule, not a highlighting choice.
    const CONFLICT_WS = conflictWs
    const SAT_WS = new Set(['WS40', 'WS50'])
    const wsNorm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
    // Only Protection Days that exist INSIDE the loaded visible period may be counted,
    // displayed or compared. `effectiveData` already windows its cells, but the original
    // snapshot (`originalDataRef.current`) carries the FULL un-windowed schedule, so PD
    // activity outside the loaded interval used to leak into `origPd` — producing a bogus
    // "X → 0" strikethrough for a LOCO that has no in-scope PD at all. Restrict EVERY PD
    // count to the loaded date_info ISOs so out-of-window PD is never seen by the UI.
    const windowIsoSet = new Set(effectiveData.date_info.map(d => d.iso))
    // Protection Days per LOCO. Counts cells in the PROTECTIONDAYS workstation that fall
    // inside the loaded window, honoring half-day cells (0.5) so fractional values
    // (0.5, 1.5, 2.5…) are exact. Keyed by linha||wo||task_name||start_ms (worker key).
    const pdCountByLoco = (groups: GanttData['groups']): Map<string, number> => {
      const out = new Map<string, number>()
      for (const g of groups) {
        const lk = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
        let pd = 0
        for (const w of g.workstations) {
          if (!isProtectionWs(w.ws)) continue
          for (const dr of w.desc_rows) {
            for (const [iso, c] of Object.entries(dr.cells)) {
              if (!windowIsoSet.has(iso)) continue
              pd += (c as { half?: string }).half ? 0.5 : 1
            }
          }
        }
        if (pd > 0) out.set(lk, (out.get(lk) ?? 0) + pd)
      }
      return out
    }

    // Count, per LOCO, how many (iso, conflict-WS) cells it shares with another LOCO.
    // When the active optimization ran with overlap rules on (allowOverlap), a shared
    // cell that is a valid boundary handoff between EXACTLY two LOCOs (end of one == start
    // of the other) is NOT a conflict — mirrors backend _is_boundary_share_day and the
    // canonical computeConflictCounts so the MODELO badge / Takt icon agree with the header.
    const conflictCountByLoco = (groups: GanttData['groups']): Map<string, number> => {
      // day|ws → set of loco keys present
      const occ = new Map<string, Set<string>>()
      const locoCells = new Map<string, string[]>() // locoKey → list of "iso||ws"
      // lk||ws → { min, max } iso span on that target WS (for the boundary test)
      const span = new Map<string, { min: string; max: string }>()
      const locoType = new Map<string, string>()    // lk → line type (overlap type rule)
      for (const g of groups) {
        const lk = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
        if (!locoType.has(lk)) locoType.set(lk, locoTypeOf(g.linha))
        for (const w of g.workstations) {
          const wn = wsNorm(w.ws)
          if (!CONFLICT_WS.has(wn)) continue
          for (const dr of w.desc_rows) {
            for (const iso of Object.keys(dr.cells)) {
              // Only count conflicts on cells INSIDE the loaded/visible window. The original
              // snapshot (originalDataRef) is un-windowed and a partial LOCO can carry target-WS
              // cells outside the loaded period; without this guard those out-of-scope cells
              // produce phantom `origConflicts` (a "N → 0" badge for a LOCO that never showed a
              // conflict in the visible view). Mirrors pdCountByLoco's windowIsoSet filter so the
              // before/after conflict counts use the exact same scope the user sees.
              if (!windowIsoSet.has(iso)) continue
              const cellKey = `${iso}||${wn}`
              let s = occ.get(cellKey); if (!s) { s = new Set(); occ.set(cellKey, s) }
              s.add(lk)
              let lst = locoCells.get(lk); if (!lst) { lst = []; locoCells.set(lk, lst) }
              lst.push(cellKey)
              const sk = `${lk}||${wn}`
              const sp = span.get(sk)
              if (!sp) span.set(sk, { min: iso, max: iso })
              else { if (iso < sp.min) sp.min = iso; if (iso > sp.max) sp.max = iso }
            }
          }
        }
      }
      const isBoundaryShare = (iso: string, ws: string, lkA: string, lkB: string): boolean => {
        const a = span.get(`${lkA}||${ws}`); const b = span.get(`${lkB}||${ws}`)
        if (!a || !b) return false
        return (iso === a.max && iso === b.min) || (iso === b.max && iso === a.min)
      }
      const out = new Map<string, number>()
      for (const [lk, cells] of locoCells) {
        let n = 0
        const seen = new Set<string>()
        for (const c of cells) {
          if (seen.has(c)) continue
          seen.add(c)
          const present = occ.get(c)
          if (!present || present.size < 2) continue
          if (allowOverlap && present.size === 2) {
            const [iso, ws] = c.split('||')
            const other = [...present].find(x => x !== lk)
            if (other) {
              // TYPE rule (allowed cross-type pair) OR BOUNDARY rule (end/start handoff).
              if (isOverlapAllowedPair(locoType.get(lk) ?? 'other', locoType.get(other) ?? 'other')) continue
              if (isBoundaryShare(iso, ws, lk, other)) continue
            }
          }
          n++
        }
        out.set(lk, n)
      }
      return out
    }

    const curCounts = conflictCountByLoco(effectiveData.groups)
    const curPd     = pdCountByLoco(effectiveData.groups)

    // Optimization mode: original conflicts (by wo||task_name, since start_ms shifts)
    // and net shift days (max per-row displacement for the LOCO = the LOCO-level shift).
    let origByWoTask:   Map<string, number> | undefined
    let origPdByWoTask: Map<string, number> | undefined
    let shiftByLoco:    Map<string, number> | undefined
    if (optimizedData && originalDataRef.current) {
      const origCounts = conflictCountByLoco(originalDataRef.current.groups)
      const origPdMap  = pdCountByLoco(originalDataRef.current.groups)
      origByWoTask   = new Map()
      origPdByWoTask = new Map()
      for (const g of originalDataRef.current.groups) {
        const woTask = `${g.wo}||${g.task_name}`
        const lk = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
        // collapse same wo||task across start_ms variants by summing (orig has one)
        origByWoTask.set(woTask, (origByWoTask.get(woTask) ?? 0) + (origCounts.get(lk) ?? 0))
        origPdByWoTask.set(woTask, (origPdByWoTask.get(woTask) ?? 0) + (origPdMap.get(lk) ?? 0))
      }
      // Net shift = max displacement length across the LOCO's rows (displacementMap value lengths).
      shiftByLoco = new Map()
      if (displacementMap) {
        for (const [rowKey, isos] of Object.entries(displacementMap)) {
          // Advanced (moved-earlier) swap boxes are visual-only: their length is the reorder
          // distance, which must NOT feed the +N delay badge (user: don't inflate the delay).
          if (advanceBoxKeys?.has(rowKey)) continue
          // rowKey = "linha||wo||task_name||start_ms||ws||subarea||dIdx"
          const parts = rowKey.split('||')
          const lk = parts.slice(0, 4).join('||')
          shiftByLoco.set(lk, Math.max(shiftByLoco.get(lk) ?? 0, isos.length))
        }
      }
    }

    // Total scheduled hours per LOCO (sum of every cell's hh) for the MODELO column.
    const hoursByLoco = new Map<string, number>()
    for (const g of effectiveData.groups) {
      const lk = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
      let h = 0
      for (const w of g.workstations)
        for (const dr of w.desc_rows)
          for (const c of Object.values(dr.cells))
            h += Number((c as { hh?: number }).hh) || 0
      hoursByLoco.set(lk, (hoursByLoco.get(lk) ?? 0) + h)
    }

    // LOCOs whose WS40↔WS50 order was actually swapped during optimization. Keyed by
    // "wo||task_name" (backend meta). Only present/non-empty in the optimized view, so
    // the swap icon never shows in the original/non-optimized Schedule.
    const swappedWoTask = new Set<string>(
      optimizedData ? (optimizedData._optimization?.swapped_locos ?? []) : []
    )

    const out: Record<string, { conflicts: number; origConflicts?: number; shiftDays?: number; pd?: number; origPd?: number; hours?: number; takt?: number; swapped?: boolean; usesSaturday?: boolean }> = {}
    for (const g of effectiveData.groups) {
      const lk = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
      if (out[lk]) continue
      const pd = curPd.get(lk) ?? 0
      const entry: { conflicts: number; origConflicts?: number; shiftDays?: number; pd?: number; origPd?: number; hours?: number; takt?: number; swapped?: boolean; usesSaturday?: boolean } = {
        conflicts: curCounts.get(lk) ?? 0,
      }
      const hrs = hoursByLoco.get(lk) ?? 0
      if (hrs > 0) entry.hours = hrs
      // Loco Takt — only set when valid (finite > 0); the worker renders it at the top
      // of the MODELO column. Invalid/missing Takt is omitted so nothing is shown.
      const tk = validTakt(g.takt)
      if (tk != null) entry.takt = tk
      if (pd > 0) entry.pd = pd
      if (optimizedData) {
        // BEFORE/AFTER comparison (original conflicts + original Protection Days) for the LIVE optimize
        // view. Once the optimization is SAVED it's baked into ordinary overrides and optimizedData is
        // cleared, so this whole block (and every indicator) is gone on reload — a saved optimization
        // reloads as a plain schedule.
        entry.origConflicts = origByWoTask?.get(`${g.wo}||${g.task_name}`) ?? 0
        entry.origPd = origPdByWoTask?.get(`${g.wo}||${g.task_name}`) ?? 0
        const sd = shiftByLoco?.get(lk) ?? 0
        if (sd > 0) entry.shiftDays = sd
        if (swappedWoTask.has(`${g.wo}||${g.task_name}`)) entry.swapped = true
        // Saturday usage: any target WS (WS40/WS50) op of this LOCO landing on a Saturday
        // (optimizer-only — non-target WS are never placed on Saturdays). Drives the grey
        // clock icon next to the swap icon in the MODELO column.
        let usesSat = false
        for (const w of g.workstations) {
          if (!SAT_WS.has(wsNorm(w.ws))) continue
          for (const dr of w.desc_rows) {
            for (const iso of Object.keys(dr.cells)) {
              if (new Date(`${iso}T00:00:00Z`).getUTCDay() === 6) { usesSat = true; break }
            }
            if (usesSat) break
          }
          if (usesSat) break
        }
        if (usesSat) entry.usesSaturday = true
      }
      out[lk] = entry
    }
    return out
  }, [effectiveData, optimizedData, displacementMap, advanceBoxKeys, allowOverlap, conflictWs])

  // Set of LOCO task_names that currently have ≥1 conflict — for the Resumo Geral
  // LOCO-mode Takt conflict icon. Derived from the same per-LOCO meta (visual only).
  const conflictLocoNames = useMemo((): Set<string> => {
    const s = new Set<string>()
    if (!locoMeta) return s
    for (const [lk, m] of Object.entries(locoMeta)) {
      if (m.conflicts > 0) {
        const taskName = lk.split('||')[2] ?? ''
        if (taskName) s.add(taskName)
      }
    }
    return s
  }, [locoMeta])

  // Canonical conflict counts for the visible/filtered dataset — distinct (loco, loco,
  // ws) PAIRS, matching the backend _detect_conflicts / optimizer. Single source of
  // truth: the header total, per-model cards, and Schedule footer all derive from this
  // (see lib/ganttUtils computeConflictCounts). Updates with filters/date/optimization,
  // and with the session conflict-WS override (conflictWs) so a custom set recomputes all.
  const conflictCounts = useMemo(
    () => computeConflictCounts(effectiveData?.groups ?? [], allowOverlap, conflictWs),
    [effectiveData, allowOverlap, conflictWs],
  )
  const totalConflicts = conflictCounts.total

  // Lock body scroll while visible
  useEffect(() => {
    if (!visible) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [visible])

  // Switch tab on visibility
  const prevVisibleRef = useRef(false)
  // True once this modal instance has been opened at least once. The instance is remounted
  // (key={ganttLoadKey}) on a full page reload / a new period or scenario load — i.e. a "new
  // session" — so this ref is false again exactly then.
  const openedOnceRef = useRef(false)
  const initialLineTypeKeysRef = useRef(initialLineTypeKeys)
  useEffect(() => { initialLineTypeKeysRef.current = initialLineTypeKeys })
  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      // Start every SESSION on Standard, but PRESERVE the user's mode across close/reopen within it.
      // The kept-alive modal naturally retains refMode across reopens; we only force it back to
      // Standard on the FIRST open of a fresh instance (page reload / new period). On later reopens
      // the last active mode (Original / Projeção) is kept intact — no reset, no rebuild.
      if (!openedOnceRef.current) {
        openedOnceRef.current = true
        if (refModeRef.current !== 'standard') {
          setRefMode('standard')
          startTransition(() => { setTableBuilt(false) })
        }
      }
      // Never open directly on the Schedule tab when the module is unavailable.
      const startTab: 0 | 1 | 2 | 3 = (initialTab === 3 && !scheduleAvailable) ? 0 : initialTab
      setActiveTab(startTab)
      const keys = initialLineTypeKeysRef.current
      if (keys && keys.length > 0) {
        setSummaryLineTypes(new Set(keys))
        // The LOAD's selection, frozen. The Resumo Geral chips can narrow this but never widen
        // it: the data for a Tipo left out was never fetched (the Linha filter, the Schedule
        // build and the windowed dataset were all scoped to it), so switching one on mid-session
        // only ever produced an empty column that looked like missing data.
        setLoadedLineTypes(new Set(keys))
      }
      if (startTab === 0) setSummaryTestReady(true)
      
      else setScheduleTabReady(true)
    }
    prevVisibleRef.current = visible
  }, [visible, initialTab, scheduleAvailable])

  // Remember the active tab so re-opening restores the user's last working page.
  // Ref-indirected so an inline onTabChange prop doesn't re-fire this every render.
  const onTabChangeRef = useRef(onTabChange)
  useEffect(() => { onTabChangeRef.current = onTabChange })
  useEffect(() => {
    if (visible) onTabChangeRef.current?.(activeTab)
  }, [visible, activeTab])

  // If Schedule gets disabled while its tab is open, fall back to Resumo Geral.
  useEffect(() => {
    if (!scheduleAvailable && activeTab === 3) setActiveTab(0)
  }, [scheduleAvailable, activeTab])

  // Drain pending scroll when tab 3 becomes active
  useEffect(() => {
    if (activeTab !== 3 || !pendingScrollRef.current) return
    const fn = pendingScrollRef.current; pendingScrollRef.current = null; fn()
  }, [activeTab])

  // Reset filters on period change
  const prevDateRangeKeyRef = useRef(`${dateRange?.from}|${dateRange?.to}`)
  useEffect(() => {
    const key = `${dateRange?.from}|${dateRange?.to}`
    if (key === prevDateRangeKeyRef.current) return
    prevDateRangeKeyRef.current = key
    setSelYears(new Set()); setSelQuarters(new Set()); setSelMonths(new Set()); setSelFws(new Set())
    setSelAreas(new Set()); setSelModels(new Set()); setSelLocoNames(new Set())
    setSelWorkstations(new Set())
  }, [dateRange?.from, dateRange?.to])

  // Reset the Schedule-tab filters whenever the loaded Type selection changes (via the
  // Main Tab's initial types or the Resumo Geral Type buttons). The Schedule panel's
  // Modelo/Área/Workstation picks — and the loco-name search — reference the previously
  // loaded Type's dataset; a leftover selection would silently hide rows (or match nothing)
  // once a different Type loads. Clearing them returns the Schedule to its default, full
  // state for the new dataset, which then rebuilds via the GanttTable buildKey below.
  const prevLineTypesKeyRef = useRef([...summaryLineTypes].sort().join(','))
  useEffect(() => {
    const key = [...summaryLineTypes].sort().join(',')
    if (key === prevLineTypesKeyRef.current) return
    prevLineTypesKeyRef.current = key
    setSelSchedModels(new Set())
    setSelSchedAreas(new Set())
    setSelSchedWorkstations(new Set())
    setLocoSearch('')
  }, [summaryLineTypes])

  const TABS = [{ i: 0, name: 'Resumo Geral' }, { i: 3, name: 'Schedule Geral' }] as const

  async function load(silent = false, userRefresh = false) {
    if (!silent) { setLoading(true); setError(null) }
    if (userRefresh) setForceReloadToken(v => v + 1)
    if (silent && !userRefresh && Date.now() - _ganttDataFetchedAt < 5 * 60 * 1000) return
    try {
      const fresh = await getGanttData()
      _ganttDataFetchedAt = Date.now()
      if (!silent) { setLoading(false); setTableBuilt(false) }
      startTransition(() => { dataRef.current = fresh; setData(fresh); onDataLoaded?.(fresh) })
    } catch (e: unknown) {
      // If data is already loaded, treat auth errors silently — keep the existing view
      // and let the tokenReady recovery effect retry once the token is refreshed.
      const hasData = dataRef.current != null
      const isAuthError = (e as { response?: { status?: number } })?.response?.status === 401
      if (!silent && !(hasData && isAuthError)) {
        setLoading(false)
        setError(e instanceof Error ? e.message : 'Erro ao carregar o Gantt.')
        if (!visible && preloadSchedule) onScheduleReady?.()
      } else if (!silent && hasData && isAuthError) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!visible && !initialData) return
    if (scenarioActive) return
    load(initialData ? true : false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const _prevTokenReadyRef = useRef(tokenReady)
  useEffect(() => {
    const prev = _prevTokenReadyRef.current; _prevTokenReadyRef.current = tokenReady
    if (tokenReady === 'ok' && prev !== 'ok' && !scenarioActive) {
      // Always retry when token recovers: covers both error state and silent auth failures
      // that kept the existing data visible without showing an error.
      load(dataRef.current != null ? true : false, false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenReady])

  const _lastInitialDataRef = useRef<GanttData | null | undefined>(initialData)
  useEffect(() => {
    if (!initialData || initialData === _lastInitialDataRef.current) return
    _lastInitialDataRef.current = initialData
    _ganttDataFetchedAt = Date.now()
    setLoading(false); setError(null)
    startTransition(() => { dataRef.current = initialData; setData(initialData) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData])

  useEffect(() => {
    if (preloadSchedule && !visible) setScheduleTabReady(true)
  }, [preloadSchedule, visible])

  useEffect(() => {
    if (!preloadSchedule || visible) return
    if (ganttBuiltRef.current) onScheduleReady?.()
  }, [preloadSchedule, visible]) // eslint-disable-line react-hooks/exhaustive-deps


  // Export levels per Summary mode. The hierarchy MUST mirror the on-screen table:
  //   Area mode  → Área → Subárea → Itens   (area | subarea | itens)
  //   Loco mode  → Tipo → Modelo → Loco      (tipo  | modelo  | loco)
  type SummaryExportLevel = 'area' | 'subarea' | 'itens' | 'tipo' | 'modelo' | 'loco'

  async function handleExportSummary(level: SummaryExportLevel = 'subarea') {
    if (!summaryTestData) return
    setExporting(true)
    try {
      const wb = XLSX.utils.book_new()
      const isMonthly = viewMode === 'mensal'
      const colHeaders = isMonthly ? summaryTestData.activeYearMonths.map(ym => monthLabel(ym)) : summaryTestData.activeFws
      const r = (v: number) => Math.round(v * 10) / 10
      const vals = (hbym: Record<string, number>, hbf: Record<string, number>) =>
        isMonthly ? summaryTestData!.activeYearMonths.map(ym => r(hbym[ym] ?? 0)) : summaryTestData!.activeFws.map(fw => r(hbf[fw] ?? 0))

      const isLocoMode = level === 'tipo' || level === 'modelo' || level === 'loco'

      // "Unir locos" — the export must agree with the screen, and the toggle now sits beside
      // this very button. Only the LOCO side needs it: `areas` (Área/Subárea/Itens) and the
      // period columns are invariant under the merge, which moves attribution between Tipos
      // without changing an hour. Off ⇒ the same object, so nothing is recomputed.
      const exportGroups = getMergeLocoTypes()
        ? mergeSummaryLocoTypes(summaryTestData).modelGroups
        : summaryTestData.modelGroups

      if (isLocoMode) {
        // ── Loco mode: Tipo → Modelo → Loco ──────────────────────────────────
        // Mirror the on-screen Locos table exactly: same TIPO_SECTIONS, same
        // per-tipo loco filtering, same model aggregation, same >0 filtering and
        // ordering. No calculation changes — only grouping/labels/levels.
        // Registry order, LOCO-bearing Tipos only — this table is per-LOCO, so a Tipo with
        // no LOCOs would contribute an always-empty section. 'other' is not a Tipo and has
        // no registry entry; it stays appended by hand as the catch-all it is.
        const TIPO_SECTIONS: { key: string; label: string }[] = [
          ...TIPOS.filter(t => t.hasLoco).map(t => ({ key: t.key as string, label: t.label })),
          { key: 'other',        label: 'Outros' },
        ]
        const tipoRows = TIPO_SECTIONS.map(s => {
          const models = exportGroups
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
          const tHoursByYm: Record<string, number> = {}
          const tHoursByFw: Record<string, number> = {}
          for (const mg of models) {
            for (const [ym, h] of Object.entries(mg.hoursByYearMonth)) tHoursByYm[ym] = (tHoursByYm[ym] ?? 0) + h
            for (const [fw, h] of Object.entries(mg.hoursByFw)) tHoursByFw[fw] = (tHoursByFw[fw] ?? 0) + h
          }
          return { tipo: s.key, label: s.label, hoursByYearMonth: tHoursByYm, hoursByFw: tHoursByFw, total: models.reduce((s2, mg) => s2 + mg.totalHours, 0), models }
        }).filter(t => t.total > 0)

        const headerRow = level === 'loco'
          ? ['Tipo', 'Modelo', 'Loco', 'Linha', ...colHeaders, 'Total (h)']
          : level === 'modelo' ? ['Tipo', 'Modelo', ...colHeaders, 'Total (h)']
          : ['Tipo', ...colHeaders, 'Total (h)']
        const sheetRows: (string | number)[][] = [headerRow]
        for (const t of tipoRows) {
          if (level === 'tipo') {
            sheetRows.push([t.label, ...vals(t.hoursByYearMonth, t.hoursByFw), r(t.total)])
          } else {
            sheetRows.push([t.label, ...(level === 'loco' ? ['', ''] : ['']), ...vals(t.hoursByYearMonth, t.hoursByFw), r(t.total)])
            for (const mg of t.models) {
              if (level === 'modelo') {
                sheetRows.push(['', mg.model, ...vals(mg.hoursByYearMonth, mg.hoursByFw), r(mg.totalHours)])
              } else {
                sheetRows.push(['', mg.model, '', '', ...vals(mg.hoursByYearMonth, mg.hoursByFw), r(mg.totalHours)])
                for (const l of mg.locos)
                  sheetRows.push(['', '', l.loco, l.linha ?? '', ...vals(l.hoursByYearMonth, l.hoursByFw), r(l.hours)])
              }
            }
          }
        }
        // Grand total — same aggregation source as the table footer.
        const grandByYm: Record<string, number> = {}
        const grandByFw: Record<string, number> = {}
        for (const t of tipoRows) {
          for (const [ym, h] of Object.entries(t.hoursByYearMonth)) grandByYm[ym] = (grandByYm[ym] ?? 0) + h
          for (const [fw, h] of Object.entries(t.hoursByFw)) grandByFw[fw] = (grandByFw[fw] ?? 0) + h
        }
        const grandTotal = tipoRows.reduce((s2, t) => s2 + t.total, 0)
        const totalPad = level === 'loco' ? ['', ''] : level === 'modelo' ? [''] : []
        sheetRows.push(['TOTAL', ...totalPad, ...vals(grandByYm, grandByFw), r(grandTotal)])
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows), 'Resumo Geral')
      } else {
        // ── Area mode: Área → Subárea → Itens ────────────────────────────────
        const headerRow = level === 'itens'
          ? ['Área', 'Subárea', 'Part Number', 'Descrição', ...colHeaders, 'Total (h)']
          : level === 'subarea' ? ['Área', 'Subárea', ...colHeaders, 'Total (h)']
          : ['Área', ...colHeaders, 'Total (h)']
        const sheetRows: (string | number)[][] = [headerRow]
        for (const area of summaryTestData.areas) {
          if (level === 'area') {
            sheetRows.push([area.area, ...vals(area.hoursByYearMonth, area.hoursByFw), r(area.total)])
          } else {
            sheetRows.push([area.area, ...(level === 'itens' ? ['', '', ''] : ['']), ...vals(area.hoursByYearMonth, area.hoursByFw), r(area.total)])
            for (const ws of area.workstations) {
              if (level === 'subarea') {
                sheetRows.push(['', ws.label, ...vals(ws.hoursByYearMonth, ws.hoursByFw), r(ws.total)])
              } else {
                sheetRows.push(['', ws.label, '', '', ...vals(ws.hoursByYearMonth, ws.hoursByFw), r(ws.total)])
                for (const pn of ws.partNumbers)
                  sheetRows.push(['', '', pn.pn, pn.desc, ...vals(pn.hoursByYearMonth, pn.hoursByFw), r(pn.total)])
              }
            }
          }
        }
        const totalVals = vals(summaryTestData.totalsByYearMonth, Object.fromEntries(
          summaryTestData.activeFws.map(fw => [fw, summaryTestData!.areas.reduce((s, a) => s + (a.hoursByFw[fw] ?? 0), 0)])
        ))
        const totalPad = level === 'itens' ? ['', '', ''] : level === 'subarea' ? [''] : []
        sheetRows.push(['TOTAL', ...totalPad, ...totalVals, r(summaryTestData.totalHours)])
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows), 'Resumo Geral')
      }

      // Per-loco detail sheet (kept for both modes — unchanged raw loco listing).
      const locoRows: (string | number)[][] = [['Modelo', 'Loco', 'Linha', 'Tipo', 'Início', 'Término', 'Horas']]
      for (const mg of exportGroups)
        for (const l of mg.locos)
          locoRows.push([mg.model, l.loco, l.linha ?? '', l.tipoGeral ?? '', l.minISO ?? '', l.finishMS ?? '', Math.round(l.hours * 10) / 10])
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(locoRows), 'Locos')
      XLSX.writeFile(wb, 'resumo_geral.xlsx')
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Falha ao exportar resumo.')
    } finally {
      setExporting(false)
    }
  }

  function toggleFw(fw: string)     { setSelFws(prev => { const n = new Set(prev); n.has(fw) ? n.delete(fw) : n.add(fw); return n }) }
  function toggleMonth(ym: string)  { setSelMonths(prev => { const n = new Set(prev); n.has(ym) ? n.delete(ym) : n.add(ym); return n }) }
  function toggleQuarter(q: string) { setSelQuarters(prev => { const n = new Set(prev); n.has(q) ? n.delete(q) : n.add(q); return n }) }
  function toggleYear(y: string)    { setSelYears(prev => { const n = new Set(prev); n.has(y) ? n.delete(y) : n.add(y); return n }) }
  function clearFilters() { setSelYears(new Set()); setSelQuarters(new Set()); setSelMonths(new Set()); setSelFws(new Set()); setSelAreas(new Set()); setSelModels(new Set()); setSelLocoNames(new Set()); setSelWorkstations(new Set()) }
  // Per-panel clears for the redesigned Resumo Geral filter groups.
  function clearDateFilters() { setSelYears(new Set()); setSelQuarters(new Set()); setSelMonths(new Set()); setSelFws(new Set()) }
  function clearDataFilters() { setSelAreas(new Set()); setSelModels(new Set()); setSelWorkstations(new Set()) }

  // Schedule-tab filter toggles (independent set-based multi-select).
  const _toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (v: string) => setter(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n })
  const toggleSchedModel       = _toggle(setSelSchedModels)
  const toggleSchedArea        = _toggle(setSelSchedAreas)
  const toggleSchedWorkstation = _toggle(setSelSchedWorkstations)
  function clearSchedFilters() { setSelSchedModels(new Set()); setSelSchedAreas(new Set()); setSelSchedWorkstations(new Set()) }

  const {
    years, quarters, months, allFws, allAreas, allModels, allLocoNames,
    allSchedModels, allSchedAreas, allWorkstations, allSummaryWorkstations, availableLineTypes,
    activeBizISOs, activeBizISOsChart, filteredDateInfo, scheduleFilteredGroups,
  } = useGanttFilters({
    effectiveData, summaryTestReady, selYears, selQuarters, selMonths, selFws,
    selAreas, selModels, selLocoNames, summaryLineTypes,
    selSchedModels, selSchedAreas, selSchedWorkstations,
  })

  // Comparison-mode summary cache: keyed by active scenario ('base'/'target') + the
  // full filter signature so toggling back to an already-computed view is instant
  // (no recompute flash). Disabled (undefined key) outside comparison mode so the
  // single-scenario flow is byte-for-byte unchanged.
  const summaryCacheRef = useRef<Map<string, { summary: SummaryTestResult; stats: StatsResult }>>(new Map())
  // Stable per-scenario identity for the comparison cache. Keyed on the raw scenario
  // object (compareBase/compareTarget are stable refs in the parent), NOT on the
  // `comparisonActive` prop. The prop flips a render BEFORE `data` actually swaps (the
  // swap happens in the initialData effect above), so keying on it cached the OUTGOING
  // scenario's aggregates under the INCOMING scenario's key → Target permanently showed
  // Base. Keying on `data` moves the key in lockstep with `effectiveData`.
  const _scenIdRef  = useRef(new WeakMap<object, number>())
  const _scenSeqRef = useRef(0)
  const scenarioId = (d: GanttData | null): string => {
    if (!d) return 'none'
    let id = _scenIdRef.current.get(d)
    if (id == null) { id = ++_scenSeqRef.current; _scenIdRef.current.set(d, id) }
    return `s${id}`
  }
  const summaryCacheKey = comparisonMode
    ? [
        scenarioId(data),
        `lt:${[...summaryLineTypes].sort().join(',')}`,
        `a:${[...selAreas].sort().join(',')}`,
        `m:${[...selModels].sort().join(',')}`,
        `l:${[...selLocoNames].sort().join(',')}`,
        `w:${[...selWorkstations].sort().join(',')}`,
        `y:${[...selYears].sort().join(',')}`,
        `q:${[...selQuarters].sort().join(',')}`,
        `mo:${[...selMonths].sort().join(',')}`,
        `f:${[...selFws].sort().join(',')}`,
      ].join('|')
    : undefined

  useSummaryCompute({
    effectiveData: summarySource, activeBizISOs, summaryLineTypes, selAreas, selModels, selLocoNames,
    selWorkstations,
    setSummaryTestData: (v) => setSummaryTestData(v),
    setStats: (v) => setStats(v),
    setSummaryComputing: (v) => setSummaryComputing(v),
    cache: comparisonMode ? summaryCacheRef : undefined,
    cacheKey: summaryCacheKey,
  })

  // Second pass (comparison mode only): aggregate the inactive scenario under the SAME filters
  // so Resumo Geral can overlay its Total line and compute ±10% indicators. effectiveData=null
  // outside comparison mode → the hook no-ops and clears the state.
  useSummaryCompute({
    effectiveData: comparisonOtherEffective,
    activeBizISOs, summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations,
    setSummaryTestData: setComparisonOtherSummary,
    setStats: () => {},
    setSummaryComputing: () => {},
  })

  // Chart-only passes: identical to the two above but keyed off activeBizISOsChart (the
  // month-independent ISO set), so the distribution chart keeps the WHOLE timeline while the
  // month filter still restricts the KPIs/tables (which read summaryTestData). Same data
  // filters (area/model/loco/ws/line-type) apply, so the chart still tracks the current scope.
  // Crucially, activeBizISOsChart does NOT depend on selMonths, so selecting/clearing a month
  // never re-fires these passes — the chart data stays byte-for-byte stable across month clicks
  // (no re-render/collapse of the chart itself), exactly as required.
  useSummaryCompute({
    effectiveData: summarySource, activeBizISOs: activeBizISOsChart,
    summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations,
    setSummaryTestData: setChartSummaryData,
    setStats: () => {},
    setSummaryComputing: () => {},
  })
  useSummaryCompute({
    effectiveData: comparisonOtherEffective, activeBizISOs: activeBizISOsChart,
    summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations,
    setSummaryTestData: setChartComparisonSummary,
    setStats: () => {},
    setSummaryComputing: () => {},
  })

  // ── Single-scenario deviation reference (Resumo Geral: current plan vs the mode's reference) ──
  // The reference is the ACTIVE mode's baseline schedule (`planoBaseSource`, the SAME reference the
  // Plano de Produção impact uses): Padrão → original DB, Original → itself, Projeção → frozen
  // baseline. There is something to compare ONLY when that reference differs from the displayed
  // schedule (identity check) — Original mode and an unedited Padrão collapse to summarySource, so
  // deviationRefSource is null → the passes clear → no arrows → zero deviation, exactly as intended.
  // Edits change summarySource, so this auto-refreshes on every override change. Disabled during a
  // scenario-compare session, which owns comparisonSummary/chartComparisonSummary instead.
  const deviationRefSource = (!comparisonMode && planoBaseSource && planoBaseSource !== summarySource)
    ? planoBaseSource : null
  useSummaryCompute({
    effectiveData: deviationRefSource,
    activeBizISOs, summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations,
    setSummaryTestData: setRefSummary,
    setStats: () => {},
    setSummaryComputing: () => {},
  })
  useSummaryCompute({
    effectiveData: deviationRefSource, activeBizISOs: activeBizISOsChart,
    summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations,
    setSummaryTestData: setRefChartSummary,
    setStats: () => {},
    setSummaryComputing: () => {},
  })

  // Auto-select current year on first Resumo Geral visit
  useEffect(() => {
    if (!summaryTestReady || selYears.size > 0 || years.length === 0) return
    const current = String(new Date().getFullYear())
    setSelYears(new Set([years.includes(current) ? current : years[years.length - 1]]))
  }, [summaryTestReady, years, selYears.size])

  function handleTabSwitch(tab: 0 | 1 | 2 | 3) {
    if (loading) return
    if (tab === activeTab) return
    // Nothing in the selection is laid out on a Schedule (GCR alone) — the tab is inert. Refuse
    // the switch outright rather than moving and being bounced back by the guard effect.
    if (tab === 3 && !scheduleApplicable) return
    // The Schedule tab builds on demand for whatever dataset is currently loaded (the modal
    // only ever opens with a period selected). If the module is off, clicking the locked tab
    // turns it on (persisted) and loads Schedule in place — no period re-selection or restart.
    if (tab === 3 && !scheduleAvailable) onScheduleEnabledChange?.(true)
    startTabTransition(() => {
      if (tab === 0) setSummaryTestReady(true)
      if (tab === 2) setSummaryTestReady(true)
      if (tab === 3) setScheduleTabReady(true)
      setActiveTab(tab)
      setScheduleGateMsg(null)
    })
  }

  const { handleLocoClick, handleWsClick, scrollInitial, handleDayClick } = makeScrollNavigation({
    effectiveData, activeTab, ganttBuiltRef, pendingScrollRef, handleTabSwitch, setScheduleGateMsg, zoom,
    // Narrow layout (WS column width-0) is active only in the exact all-collapsed LOCO state —
    // the scroll-to math must use the frozen width actually rendered.
    locoNarrow: locoExpandSummary === 'none',
  })

  // Initial open scroll for the PRELOAD path: when the Schedule was built off-screen, the onBuilt
  // gate above deliberately skipped scrollInitial (the iframe had no usable layout). Run it the
  // first time the modal actually becomes visible with a completed build. builtNonce re-checks it if
  // the build lands after the modal is already shown. The one-shot ref makes this fire exactly once.
  useEffect(() => {
    if (visible && ganttBuiltRef.current && !scrolledToTodayRef.current && !pendingScrollRef.current) {
      scrolledToTodayRef.current = true
      scrollInitial()
    }
  }, [visible, builtNonce, scrollInitial])


  // Render only when on-screen, preloading offscreen, or kept alive after a build.
  // Keeping a built instance mounted (hidden) is what makes reopening the same
  // period instant — unmounting here would destroy the iframe and force a rebuild.
  if (!visible && !preloadSchedule && !keepAliveRef.current) return null

  return (
    // NO backdrop-click-to-close. The Schedule is a persistent workspace, not a transient
    // dialog: it holds unsaved edits, filters, scroll position and an expensive built
    // iframe, so a stray click on the dimmed area must never discard that context. It
    // closes only through an explicit action — the X in the header, or the caller's own
    // navigation flow.
    //
    // This also keeps floating controls honest: a click outside an open dropdown is
    // handled by that dropdown's own outside-click listener and dismisses ONLY the
    // dropdown. Previously the same click closed the list and the whole Schedule with it.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 [&_svg]:cursor-default"
      style={visible ? undefined : { position: 'fixed', top: '200vh', left: 0, pointerEvents: 'none' }}
    >
      <div
        className="relative bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '94vw', maxWidth: 1280, height: '88vh' }}
      >
        {/* ── Cabeçalho ─── */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ background: RED }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm text-white tracking-wide">
              Master Schedule — Visão em Gantt
            </span>
            {/* The scenario name used to sit here as a small white pill. It moved to the FOOTER
                (next to Fechar), where it is rendered in the Resumo Geral chart's series colours
                — red for the active scenario, gray for the compared one — so the names are
                legible and map directly onto the chart lines. See GanttModalFooter. */}
            {/* Two figures only — modelos + dias úteis. The header used to list locos, ws and FWs
                too, which crowded the title and duplicated numbers the tabs already show (locos in
                the footer, ws/FWs in Resumo Geral). The full set stays on the tooltip. */}
            {(summaryTestData || stats) && (
              <span
                className="text-[11px] leading-tight"
                style={{ color: 'rgba(255,255,255,0.72)' }}
                title={summaryTestData
                  ? `${summaryTestData.modelsCount} modelos · ${summaryTestData.locosCount} locos · ${summaryTestData.wsCount} ws · ${summaryTestData.fwsCount} FWs · ${summaryTestData.businessDaysCount} dias úteis`
                  : `${stats!.locos} locos · ${stats!.wsDistinct} ws · ${stats!.fws} FWs · ${stats!.businessDays} dias úteis`}
              >
                {summaryTestData
                  ? `${summaryTestData.modelsCount} modelos · ${summaryTestData.businessDaysCount} dias úteis`
                  : `${stats!.businessDays} dias úteis`
                }
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {/* Global LOCO-edit toolbar: Save (persist overrides — in-memory now, DB later)
                + Reset (clear all visual overrides, repaint base). Shown only when there are
                manual edits. Editing itself is already instant/local (no rebuild). Hidden in
                the read-only Original reference mode. Sits BEFORE the mode selector so the mode
                selector stays fixed on the far right of the status group. */}
            {!readOnly && (editCount > 0 || !!optimizedData) && (
              <div className="flex items-center gap-1 mr-1 pr-2 border-r border-white/25">
                <span className="text-[10px] font-semibold text-white/80 tabular-nums">
                  {editCount > 0
                    ? `${editCount} ${editCount !== 1 ? 'edições' : 'edição'}`
                    : 'Otimização'}
                </span>
                {canSave && (
                  <button
                    onClick={openSaveModal}
                    disabled={overridesSaveState === 'saving'}
                    title="Salvar edições no banco (permanente)"
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 transition-colors disabled:opacity-60"
                  >
                    <Save size={13} className="text-white" />
                    {overridesSaveState === 'saving' ? 'Salvando…'
                      : overridesSaveState === 'saved' ? 'Salvo ✓'
                      : overridesSaveState === 'error' ? 'Erro ✕'
                      : 'Salvar'}
                  </button>
                )}
                <button
                  onClick={resetAllOverrides}
                  title="Resetar todas as edições (restaura o original)"
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 transition-colors"
                >
                  <RotateCcw size={13} className="text-white" />Resetar
                </button>
              </div>
            )}
            {/* Reference mode ("Alternar Referência"): Original / Padrão / Projeção. Persisted;
                switching forces a full rebuild. Compact dropdown in the app's standard idiom.
                Kept on the FAR RIGHT of the status group; the edit/save indicators sit to its LEFT. */}
            <div className="flex items-center gap-1 mr-1 pr-2 border-r border-white/25">
              {/* Projeção actions/status, LEFT of the selector. "Atualizar referência" appends a baseline
                  VERSION (Editor+ only). "Histórico" opens the version ledger + cumulative deviation and
                  is available to EVERYONE (readers included) — they just can't re-freeze the baseline. */}
              {/* HIDDEN — three-layer model. Projeção now compares against the LIVE Standard layer, so
                  there is no snapshot to freeze and "Atualizar referência" has nothing to do; the
                  Histórico ledger it fed is meaningless against a moving baseline. Both are hidden
                  rather than deleted: the whole versioning structure (endpoints, ProjectionBaseline
                  table, stored freezes, this UI) is kept for reuse as saved VERSIONS OF THE STANDARD
                  schedule. Flip SHOW_PROJ_REF_ACTIONS to bring it back. */}
              {SHOW_PROJ_REF_ACTIONS && refMode === 'working' && (
                <>
                  {canSave && (
                    <button
                      onClick={() => setShowUpdateRefConfirm(true)}
                      disabled={projRefSaveState === 'saving'}
                      title="Congelar o schedule atual como nova referência de Projeção (nova versão; zera os desvios incrementais, preserva o histórico e o acumulado)"
                      className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 transition-colors disabled:opacity-60"
                    >
                      <RotateCcw size={13} className="text-white" />
                      {projRefSaveState === 'saving' ? 'Atualizando…' : 'Atualizar referência'}
                    </button>
                  )}
                  <button
                    onClick={() => setShowRefHistory(true)}
                    title="Histórico de referências: cada congelamento e o desvio acumulado desde a referência original"
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 transition-colors"
                  >
                    <History size={13} className="text-white" />Histórico
                  </button>
                </>
              )}
              {/* Original mode is view-only: compact indicator next to the dropdown. Shares the exact
                  visual idiom of the Projeção "Atualizar referência" action (icon + white text, no box)
                  so every mode-specific status/action next to the selector reads consistently. */}
              {readOnly && (
                <span
                  title="Modo Original: baseline importado. Somente leitura — nenhuma edição é permitida (arrastar/pan continua disponível)."
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white"
                >
                  <Lock size={13} className="text-white" />Somente leitura
                </span>
              )}
              {/* Projeção: a compact descriptor mirroring the Original "Somente leitura" idiom. */}
              {isProjection && (
                <span
                  title="Modo Projeção: plano executado — camada de simulação sobre o Padrão (desvios medidos vs. o Padrão vigente)."
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white"
                >
                  <History size={13} className="text-white" />Plano Executado
                </span>
              )}
              {/* Padrão: same descriptor idiom as Original/Projeção, so the selector always has a
                  caption next to it instead of only in the two non-default modes. */}
              {refMode === 'standard' && (
                <span
                  title="Modo Padrão: schedule vigente com as edições salvas — é a referência dos outros modos."
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white"
                >
                  <Pencil size={13} className="text-white" />Modo de visualização padrão
                </span>
              )}
              <RefModeDropdown mode={refMode} onChange={changeRefMode} />
            </div>
            <button
              onClick={() => { if (!confirm('Recarregar os dados do Gantt?')) return; load(false, true) }}
              disabled={loading}
              title="Recarregar dados"
              className="rounded p-1 hover:bg-white/20 transition-colors disabled:opacity-40"
            >
              <RefreshCw size={14} className={`text-white ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => { if (!optLoading) onClose() }} disabled={optLoading} className="rounded p-1 hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title={optLoading ? 'Otimização em andamento…' : 'Fechar'}>
              <X size={16} className="text-white" />
            </button>
          </div>
        </div>

        {/* ── Barra de abas ─── */}
        <div className="flex items-stretch bg-gray-50 border-b border-gray-200 shrink-0">
          <button
            onClick={() => handleTabSwitch(Math.max(0, activeTab - 1) as 0 | 1 | 2 | 3)}
            disabled={activeTab === 0 || loading}
            className="px-2.5 flex items-center hover:bg-gray-100 transition-colors text-gray-500 shrink-0 border-r border-gray-200 disabled:opacity-30"
            title="Aba anterior"
          >
            <ChevronLeft size={14} />
          </button>
          {TABS.map(({ i, name }) => {
            const active = activeTab === i
            // DISABLED when the loaded Tipos have no Schedule at all (GCR alone): there is
            // nothing a click could load, so it must not navigate anywhere.
            const scheduleInert = i === 3 && !scheduleApplicable
            // LOCKED (not disabled) when only the module is off: it stays clickable and
            // clicking it enables Schedule + builds on demand (handleTabSwitch).
            const scheduleLocked = i === 3 && !scheduleAvailable && !scheduleInert
            const blocked = loading || scheduleInert
            return (
              <button
                key={name}
                onClick={() => handleTabSwitch(i as 0 | 1 | 2 | 3)}
                disabled={blocked}
                title={scheduleInert
                  ? 'Os Tipos carregados não possuem schedule — nada a exibir aqui.'
                  : scheduleLocked ? 'Módulo Schedule desativado — clique para carregar' : undefined}
                className="flex-1 flex items-center justify-center gap-1.5 px-6 py-2.5 text-xs font-semibold transition-all select-none whitespace-nowrap"
                style={{
                  borderBottom:    active ? `3px solid ${RED}` : '3px solid transparent',
                  backgroundColor: active ? '#FFF5F5' : 'transparent',
                  color:           blocked ? '#9CA3AF' : scheduleLocked ? '#9CA3AF' : (active ? RED : '#6B7280'),
                  cursor:          blocked ? 'not-allowed' : 'pointer',
                  opacity:         blocked ? 0.8 : scheduleLocked ? 0.85 : 1,
                }}
              >
                {(scheduleLocked || scheduleInert) && <Lock size={11} className="shrink-0" />}
                {name}
              </button>
            )
          })}
          <button
            onClick={() => handleTabSwitch(Math.min(3, activeTab + 1) as 0 | 1 | 2 | 3)}
            // Same rule as the Schedule tab button: with nothing schedule-backed loaded, tab 3
            // is not a destination, so the last reachable tab is 2.
            disabled={loading || activeTab === 3 || (activeTab === 2 && !scheduleApplicable)}
            className="px-2.5 flex items-center hover:bg-gray-100 transition-colors text-gray-500 shrink-0 border-l border-gray-200 disabled:opacity-30"
            title="Próxima aba"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        {scheduleGateMsg && (
          <div className="px-4 py-1.5 text-[11px] border-b border-red-200 bg-red-50 text-red-700">
            {scheduleGateMsg}
          </div>
        )}

        {/* ── Conteúdo ─── */}
        <div className="flex-1 min-h-0 relative">
          {(loading || isTransitioning) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white/85 z-10" style={{ pointerEvents: 'none' }}>
              <Loader2 size={34} className="animate-spin" style={{ color: RED, animationDuration: '1.05s' }} />
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8">
              <p className="text-sm font-semibold text-center" style={{ color: RED_DK }}>{error}</p>
              <button onClick={() => load(false)} className="px-4 py-1.5 text-xs rounded text-white font-medium transition-colors" style={{ background: RED }}>
                Tentar novamente
              </button>
            </div>
          )}

          {!loading && !error && effectiveData && (
            <>
              {/* ─── Aba 0: Resumo Geral ─── */}
              <div
                ref={resumoScrollRef}
                tabIndex={0}
                style={{ outline: 'none', position: 'absolute', inset: 0, overflowY: 'auto', scrollbarGutter: 'stable', opacity: activeTab === 0 && !isTabTransitioning ? 1 : (activeTab === 0 ? 0.4 : 0), pointerEvents: activeTab === 0 ? 'auto' : 'none', transition: 'opacity 0.15s', display: activeTab === 0 ? undefined : 'none' }}
                onTransitionEnd={() => { if (activeTab === 0) resumoScrollRef.current?.focus({ preventScroll: true }) }}
                onFocusCapture={(e) => {
                  // Keep keyboard scrolling on the container — but NEVER steal focus from an
                  // interactive control (search inputs, dropdowns, buttons): yanking it back
                  // made fields like the PN search impossible to focus or type into.
                  const t = e.target as HTMLElement
                  if (t === e.currentTarget) return
                  if (t.closest('input, textarea, select, button, [contenteditable="true"]')) return
                  ;(e.currentTarget as HTMLDivElement).focus({ preventScroll: true })
                }}
              >
                {/* Mounted ONLY while this tab is active. These trees are heavy; leaving them mounted
                    (even hidden) makes them re-render/reconcile on every GanttModal render, which is
                    what degraded the Schedule tab after a summary visit. summaryTestData is held in
                    GanttModal state, so re-mounting on the next visit renders instantly. */}
                {activeTab === 0 && (
                <ResumoGeralTab
                  locoOverrides={locoOverrides}
                  summaryTestReady={summaryTestReady}
                  /* The GCR fetch is folded into the SAME "Calculando resumo…" state the
                     Schedule aggregation uses, rather than getting an indicator of its own: from
                     the reader's side both are "the numbers on this screen are not ready yet",
                     and a GCR-only load previously sat on a blank tab with nothing spinning. */
                  summaryComputing={summaryComputing}
                  summaryTestData={summaryTestData}
                  comparisonSummary={comparisonMode ? comparisonOtherSummaryCmp : refSummaryCmp}
                  chartSummaryData={chartSummaryData}
                  chartComparisonSummary={comparisonMode ? chartComparisonSummaryCmp : refChartSummaryCmp}
                  showCompareArrows={showCompareArrows}
                  summaryMode={summaryMode}
                  setSummaryMode={setSummaryMode}
                  rowMode={rowMode}
                  setRowMode={setRowMode}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  showQuarters={showQuarters}
                  setShowQuarters={setShowQuarters}
                  mergePeriods={mergePeriods}
                  setMergePeriods={setMergePeriods}
                  summaryLineTypes={summaryLineTypes}
                  setSummaryLineTypes={setSummaryLineTypes}
                  availableLineTypes={availableLineTypes}
                  loadedLineTypes={loadedLineTypes}
                  years={years}
                  quarters={quarters}
                  months={months}
                  allFws={allFws}
                  allAreas={allAreas}
                  allModels={allModels}
                  allWorkstations={allSummaryWorkstations}
                  selYears={selYears}
                  selQuarters={selQuarters}
                  selMonths={selMonths}
                  selFws={selFws}
                  selAreas={selAreas}
                  selModels={selModels}
                  selWorkstations={selWorkstations}
                  toggleYear={toggleYear}
                  toggleQuarter={toggleQuarter}
                  toggleMonth={toggleMonth}
                  toggleFw={toggleFw}
                  setSelAreas={setSelAreas}
                  setSelModels={setSelModels}
                  setSelWorkstations={setSelWorkstations}
                  conflictLocoNames={conflictLocoNames}
                  totalConflicts={totalConflicts}
                  clearFilters={clearFilters}
                  clearDateFilters={clearDateFilters}
                  clearDataFilters={clearDataFilters}
                  hasFilter={selYears.size > 0 || selQuarters.size > 0 || selMonths.size > 0 || selFws.size > 0 || selAreas.size > 0 || selModels.size > 0 || selWorkstations.size > 0}
                  handleLocoClick={handleLocoClick}
                  onLocoEdit={({ wo, taskName, linha, startMs, takt, x, y }) =>
                    setEditMenu({ x, y, target: { scope: 'loco', wo, taskName, linha, startMs, takt } })}
                  handleWsClick={handleWsClick}
                  ganttBuiltRef={ganttBuiltRef}
                  hiddenScheduleLocos={hiddenScheduleLocos}
                  comparisonMode={comparisonMode}
                  comparisonActive={comparisonActive}
                  comparisonBaseName={comparisonBaseName}
                  comparisonTargetName={comparisonTargetName}
                  scenarioName={scenarioName}
                  onSwitchScenario={onComparisonSwitch}
                />
                )}
              </div>

              {/* ─── Aba 3: Schedule Geral ─── */}
              <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: activeTab === 3 && !isTabTransitioning ? 1 : (activeTab === 3 ? 0.4 : 0), pointerEvents: activeTab === 3 ? 'auto' : 'none', transition: 'opacity 0.15s' }}>
                {/* Schedule-only filter panel now lives in the footer, to the
                    right of the LOCO search bar (see GanttModalFooter). */}
                {activeTab === 3 && !tableBuilt && (
                  <div className="absolute top-3 right-3 z-10 flex items-center gap-2 bg-white/95 rounded-lg px-3 py-1.5 shadow-md border border-gray-100" style={{ pointerEvents: 'none', minWidth: 160 }}>
                    <Loader2 size={13} className="animate-spin shrink-0" style={{ color: RED }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[11px] text-gray-500 font-medium">Montando…</span>
                        {ganttProgress > 0 && (
                          <span className="text-[10px] font-semibold tabular-nums" style={{ color: RED }}>{ganttProgress}%</span>
                        )}
                      </div>
                      <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full rounded-full transition-[width] duration-100 ease-linear" style={{ width: `${ganttProgress}%`, background: RED }} />
                      </div>
                    </div>
                  </div>
                )}
                <GanttTable
                  ref={ganttTableRef}
                  data={effectiveData}
                  overrides={displayOverrides}
                  referenceOverrides={scheduleHatchReference}
                  filteredGroups={scheduleFilteredGroups}
                  forceReloadToken={forceReloadToken}
                  buildKey={`${effectiveData.scenario_id ?? 'base'}|ref${refMode}|${effectiveData.date_info.length}|${effectiveData.groups.length}|${scheduleFilteredGroups?.length ?? 'all'}|m:${[...selSchedModels].sort().join(',')}|a:${[...selSchedAreas].sort().join(',')}|w:${[...selSchedWorkstations].sort().join(',')}|${forceReloadToken}|${displacementMap ? Object.keys(displacementMap).length : 0}|r${recoveredMap ? Object.keys(recoveredMap).length : 0}|opt${activeOptMode ?? 'none'}|hbs${hideBeforeStart ? 1 : 0}|xa${wsExpandBase ? 1 : 0}.${wsExpandBulk}|xl${locoExpandBase ? 1 : 0}.${locoExpandBulk}|hr${refMode === 'working' ? `${projBaselines.length}.${savedVersion}` : '0'}`}
                  /* Dataset identity only (no filter/visibility tokens). When this is
                     unchanged but buildKey changes, GanttTable does an in-place swap
                     instead of a blanking rebuild — so filter + show/hide changes feel
                     instant and keep scroll, while the worker still recomputes results.
                     NOTE: groups.length is deliberately EXCLUDED — line-type filtering
                     changes the visible group count but is NOT a dataset change, so it
                     must take the in-place-swap path (no "Montando…" blank). Period
                     changes still rebuild via date_info.length (different columns). */
                  structuralKey={`${effectiveData.scenario_id ?? 'base'}|ref${refMode}|${effectiveData.date_info.length}|${forceReloadToken}|opt${activeOptMode ?? 'none'}`}
                  buildEnabled={scheduleTabReady}
                  zoom={zoom}
                  wsExpand={wsExpand}
                  onWsToggle={toggleWsExpand}
                  onLocoToggle={toggleLocoExpand}
                  grabMode={ganttGrabMode}
                  moveDisabled={readOnly}
                  onMoveBlocked={notifyOriginalReadOnly}
                  moveOverLimit={!!moveMode && moveMode.pdSlack != null && (moveMode.dStart + moveMode.dFinish) > moveMode.pdSlack}
                  colorByWs={true}
                  hideBeforeStart={hideBeforeStart}
                  hidePastLocos={hidePastLocos}
                  displacementMap={displacementMap}
                  recoveredMap={recoveredMap}
                  locoMeta={locoMeta}
                  allowOverlap={allowOverlap}
                  onBuildStart={() => { setTableBuilt(false); setGanttProgress(0); ganttBuiltRef.current = false }}
                  onBuilt={() => {
                    setTableBuilt(true)
                    ganttBuiltRef.current = true
                    setBuiltNonce(n => n + 1)   // signal: a real build just completed (paints hydrated overrides)
                    keepAliveRef.current = true
                    // Tell the parent the current dataset's Schedule is now built &
                    // alive (covers both the offscreen preload and an in-modal tab
                    // switch to Schedule), so a later reopen can restore instantly.
                    onScheduleBuilt?.()
                    if (onceBuiltRef.current) { onceBuiltRef.current(); onceBuiltRef.current = null }
                    if (preloadSchedule) { onScheduleProgress?.(2); setTimeout(() => onScheduleReady?.(), 400) }
                    // First successful build WHILE VISIBLE: jump to Today (if in range) AND
                    // vertically to the first row with schedule activity, unless a pending loco/ws
                    // scroll is queued (an explicit nav target wins). Gated on `visible` so an
                    // OFF-SCREEN preload build doesn't burn the one-shot against a zero-size iframe
                    // — the becomes-visible effect below runs it once the modal is actually shown.
                    if (visible && !scrolledToTodayRef.current && !pendingScrollRef.current) {
                      scrolledToTodayRef.current = true
                      scrollInitial()
                    }
                  }}
                  onProgress={(p) => { setGanttProgress(Math.round(p * 100)); if (preloadSchedule) onScheduleProgress?.(p) }}
                  onWsClick={handleWsClick}
                  onLocoNavClick={(task, linha, wo, startMs) => handleLocoClick(task, linha, wo, startMs)}
                  onDayClick={handleDayClick}
                  onLocoEdit={({ wo, taskName, linha, startMs, takt, x, y }) => {
                    if (readOnly) return   // 'original' reference mode is read-only — no edit menu
                    setEditMenu({ x, y, target: { scope: 'loco', wo, taskName, linha, startMs, takt } })
                  }}
                  onRowEdit={({ scope, wo, taskName, linha, startMs, ws, subarea, desc, takt, x, y }) => {
                    if (readOnly) return
                    setEditMenu({ x, y, target: { scope, wo, taskName, linha, startMs, takt, ws, subarea, desc } })
                  }}
                  onSaturdayContext={({ iso, x, y }) => { if (readOnly) return; setSatMenu({ iso, x, y }) }}
                  onBoxMoveStart={startMove}
                  onBoxMoveSelect={selectMove}
                  onBoxMoveStep={stepMove}
                  onBoxMoveDuration={stepDuration}
                  onBoxMoveDurationStart={stepDurationStart}
                  onBoxMoveSatNever={toggleSatNever}
                  onBoxMoveCommit={commitMove}
                  onBoxMoveCancel={cancelMove}
                  onMoveNoteClick={openMoveNote}
                />
              </div>
            </>
          )}
        </div>

        {/* ── Rodapé ─── */}
        <GanttModalFooter
          readOnly={readOnly}
          comparisonMode={comparisonMode}
          comparisonActive={comparisonActive}
          onComparisonSwitch={onComparisonSwitch}
          comparisonBaseName={comparisonBaseName}
          comparisonTargetName={comparisonTargetName}
          scenarioName={scenarioActive ? scenarioName : undefined}
          showCompareArrows={showCompareArrows}
          onToggleCompareArrows={() => setShowCompareArrows(v => !v)}
          compareArrowsAvailable={comparisonMode || !!deviationRefSource}
          activeTab={activeTab}
          effectiveData={effectiveData}
          filteredGroups={scheduleFilteredGroups}
          filteredDateInfo={filteredDateInfo}
          summaryTestData={summaryTestData}
          exporting={exporting}
          wsExpandSummary={wsExpandSummary}
          onSetAllWsExpanded={setAllWsExpanded}
          locoExpandSummary={locoExpandSummary}
          onSetAllLocosExpanded={setAllLocosExpanded}
          ganttGrabMode={ganttGrabMode}
          setGanttGrabMode={setGanttGrabMode}
          hideBeforeStart={hideBeforeStart}
          setHideBeforeStart={setHideBeforeStart}
          hidePastLocos={hidePastLocos}
          setHidePastLocos={setHidePastLocos}
          zoom={zoom}
          zoomBusy={zoomBusy}
          setZoom={setZoom}
          setZoomBusy={setZoomBusy}
          onceBuiltRef={onceBuiltRef}
          showExportMenu={showExportMenu}
          setShowExportMenu={setShowExportMenu}
          exportMenuRef={exportMenuRef}
          handleExportSummary={handleExportSummary}
          summaryRowMode={rowMode}
          onClose={onClose}
          activeOptMode={activeOptMode}
          optLoading={optLoading}
          optError={optError}
          onOptModeChange={handleOptimizeMode}
          onOpenMode1Options={() => setShowMode1Options(true)}
          onLocoClick={handleLocoClick}
          onWsClick={handleWsClick}
          locoSearch={locoSearch}
          setLocoSearch={setLocoSearch}
          scheduleFilter={activeTab === 3 && effectiveData ? (
            <ScheduleFilterPanel
              dropUp
              allModels={allSchedModels}
              allAreas={allSchedAreas}
              allWorkstations={allWorkstations}
              selModels={selSchedModels}
              selAreas={selSchedAreas}
              selWorkstations={selSchedWorkstations}
              onToggleModel={toggleSchedModel}
              onToggleArea={toggleSchedArea}
              onToggleWorkstation={toggleSchedWorkstation}
              onClear={clearSchedFilters}
            />
          ) : undefined}
          allowOverlap={allowOverlap}
          onRestoreOriginal={() => {
            // Undo the OPTIMIZATION ONLY — restore the state as it was immediately before Otimizar ran.
            // The optimizer's output lives entirely in `optimizedData` (a whole replacement dataset; the
            // solver never writes into the override layer — it only READS it, see optScope.locoEdits).
            // So dropping optimizedData is a complete undo of the run.
            //
            // This deliberately no longer clears locoOverrides/projOverrides. Wiping them discarded the
            // planner's own manual edits, which the optimizer never touched, and it also caused the stale
            // header count: editCount is countUnsavedEdits(working, savedBaseline), which counts baseline
            // keys MISSING from working — so resetting to {} against a saved baseline reported one "edit"
            // per wiped entry and the counter never cleared. Leaving the override layer alone makes
            // editCount fall back to its true pre-optimization value on its own.
            setOptimizedData(null)
            setActiveOptMode(null)      // exits optimization mode (drives buildKey/structuralKey)
            setOptError(null)
            // Terminal/progress state too, so a later run never opens showing the previous run's tail.
            setOptLogs([]); setOptProgress(0); setOptMessage(''); setOptStatus('running')
            startTransition(() => { setTableBuilt(false) })
          }}
        />
      </div>

      {/* Optimization terminal modal */}
      {showOptTerminal && (
        <OptimizeScheduleModal
          logs={optLogs}
          progress={optProgress}
          message={optMessage}
          status={optStatus}
          error={optError}
          onCancel={() => {
            optAbortRef.current?.abort()
            setOptLoading(false)
            setOptStatus('error')
            setOptError('Otimização cancelada pelo usuário.')
          }}
          onClose={() => setShowOptTerminal(false)}
        />
      )}

      {/* Projeção: confirm freezing a new SHARED deviation reference (padronized dialog), then the
          app-password gate (Editor+ / server-validated), then the status overlay. */}
      {showUpdateRefConfirm && (
        <ConfirmDialog
          title="Atualizar referência de Projeção"
          message="Congelar o estado atual como nova versão da referência? Os desvios incrementais zeram a partir de agora."
          detail="Requer senha de administrador. A referência é compartilhada. Uma nova versão é criada — nada é sobrescrito: o histórico e o desvio acumulado (desde a referência original) permanecem em Histórico."
          confirmLabel="Atualizar"
          danger
          onConfirm={() => { setShowUpdateRefConfirm(false); setProjRefError(null); runUpdateProjectionRef() }}
          onCancel={() => setShowUpdateRefConfirm(false)}
        />
      )}
      {projRefSaveState !== 'idle' && (
        <SaveStatusOverlay
          state={projRefSaveState}
          count={0}
          error={projRefError}
          onRetry={retryUpdateProjectionRef}
          onDismiss={() => { setProjRefSaveState('idle'); setProjRefError(null) }}
        />
      )}

      {/* Projeção reference HISTORY (Option A ledger). Read-only, open to everyone (readers included):
          the versions frozen so far, the delay each absorbed, and the deviation accumulated since the
          original reference (version 0) vs. only since the last freeze. */}
      {showRefHistory && (
        <div
          className="fixed inset-0 z-[9997] flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) setShowRefHistory(false) }}
        >
          <div
            className="bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden"
            style={{ width: 'min(92vw, 560px)', maxHeight: '82vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ background: RED }}>
              <div className="flex items-center gap-2 text-white">
                <History size={15} />
                <span className="font-semibold text-sm">Histórico de Referências — Projeção</span>
              </div>
              <button onClick={() => setShowRefHistory(false)} className="rounded p-0.5 hover:bg-white/20"><X size={16} className="text-white" /></button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {projBaselines.length === 0 ? (
                <div className="text-sm text-gray-600 leading-relaxed">
                  Nenhuma referência congelada ainda. Use <span className="font-semibold">Atualizar referência</span> para
                  definir a referência original — os desvios passam a ser medidos a partir dela, e cada novo
                  congelamento vira uma versão neste histórico (sem perder as anteriores).
                </div>
              ) : (
                <>
                  {/* Two headline deviations: cumulative (vs the original reference of record) and
                      incremental (vs the latest freeze — what the Plano de Produção shows). */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    {([
                      { label: 'Acumulado (desde a original)', dev: refHistoryStats?.cumulative },
                      { label: 'Desde a última referência',    dev: refHistoryStats?.incremental },
                    ] as const).map((c) => (
                      <div key={c.label} className="rounded-lg border border-gray-200 px-3 py-2.5">
                        <div className="text-[11px] font-medium text-gray-500">{c.label}</div>
                        {refHistoryBusy && !refHistoryStats ? (
                          <div className="flex items-center gap-1.5 mt-1 text-gray-400"><Loader2 size={13} className="animate-spin" /><span className="text-[11px]">Calculando…</span></div>
                        ) : (
                          <>
                            {/* Schedule date slip (days) — the hatch grain. */}
                            <div className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: devColor(c.dev) }}>{devText(c.dev)}</div>
                            {c.dev && c.dev.deviatingWs > 0 && (
                              <div className="text-[10px] text-gray-400 mt-0.5">{c.dev.deviatingWs} workstation(s) com desvio</div>
                            )}
                            {/* Production hours redistributed (the Plano de Produção metric). */}
                            <div className="text-[11px] font-medium tabular-nums mt-1 pt-1 border-t border-gray-100 text-gray-600">{hoursText(c.dev)} <span className="text-gray-400 font-normal">movidas entre semanas</span></div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Congelamentos</div>
                  <div className="flex flex-col divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                    {/* Newest first. Version 0 = the reference of record (absorbs nothing). */}
                    {[...projBaselines].reverse().map((v) => {
                      const stat = refHistoryStats?.freezes.find(f => f.version === v.version)
                      return (
                        <div key={v.version} className="flex items-center justify-between px-3 py-2 gap-2">
                          <div className="flex flex-col min-w-0">
                            <span className="text-xs font-semibold text-gray-800 truncate">
                              {v.version === 0 ? 'Referência original' : `Versão ${v.version}`}{v.label ? ` · ${v.label}` : ''}
                            </span>
                            <span className="text-[11px] text-gray-500 truncate">
                              {fmtRefDate(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}
                            </span>
                          </div>
                          <span className="text-[11px] tabular-nums shrink-0 text-right" style={{ color: devColor(stat?.absorbed) }}>
                            {v.version === 0
                              ? '—'
                              : (refHistoryBusy && !stat
                                  ? '…'
                                  : <>absorveu {devText(stat?.absorbed)}<br /><span className="text-gray-500">{hoursText(stat?.absorbed)} movidas</span></>)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-2 leading-snug">
                    Dois olhares do mesmo desvio: <b>dias</b> = deslize de término das workstations (grão dos
                    hachurados vermelho/laranja); <b>horas movidas</b> = horas de produção que mudaram de semana
                    fiscal (métrica do Plano de Produção). Acumulado é medido contra a referência original; o
                    Plano de Produção mede contra a última referência.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Right-click edit menu. Scope depends on the row clicked + the active view mode:
          LOCO (MODELO cell) → "Editar LOCO"; WORK-mode WS row → "Editar Workstation";
          FULL-mode description row → "Editar Workstation" + "Editar Componente". */}
      {editMenu && (
        <ContextMenu
          x={editMenu.x}
          y={editMenu.y}
          onClose={() => setEditMenu(null)}
          items={
            // Each "Editar …" is followed by a contextual "Resetar …" — but only when that
            // specific item actually has an active modification (hasActiveScope). Reset clears
            // only the selected scope; siblings and global overrides are untouched.
            editMenu.target.scope === 'loco'
              ? [
                  { label: 'Editar LOCO', icon: <Pencil size={13} />, onClick: () => openEditPanelFromMenu('loco') },
                  // Insert a workstation that isn't in the source schedule (override-only, Standard/Projeção).
                  { label: 'Adicionar Workstation', icon: <Plus size={13} />, onClick: () => openAddWorkstation(editMenu.target) },
                  // Offered whenever the LOCO carries ANY override — loco-level, workstation or
                  // componente — since the reset now restores the whole locomotive to baseline.
                  ...(hasAnyLocoOverride(editMenu.target)
                    ? [{ label: 'Resetar LOCO', icon: <RotateCcw size={13} />, danger: true, onClick: () => resetLocoFromMenu(editMenu.target) }]
                    : []),
                ]
              : editMenu.target.scope === 'ws'
                ? [
                    // WS Mode (collapsed workstation row). A single editable entity → just "Editar
                    // Workstation" (routed to the sole component so the Hours section works); nothing
                    // redundant. Its reset covers both the sole-component and any WS-scope override.
                    { label: 'Editar Workstation', icon: <Pencil size={13} />, onClick: () => openWorkstationEditFromMenu() },
                    ...(hasWorkstationScope(editMenu.target)
                      ? [{ label: 'Resetar Workstation', icon: <RotateCcw size={13} />, danger: true, onClick: () => resetWorkstationFromMenu(editMenu.target) }]
                      : []),
                    // A manually-added station can be removed entirely (drops it + any edits on it).
                    ...(isAddedWs(editMenu.target)
                      ? [{ label: 'Remover Workstation', icon: <Trash2 size={13} />, danger: true, onClick: () => removeAddedWorkstation(editMenu.target) }]
                      : []),
                  ]
                // FULL-mode row. A "single editable entity" workstation (≤1 component — one real
                // component, or a lone blank-descrição row) shows ONLY "Editar Workstation" (routed to
                // the sole component so the Hours section works) — no redundant "Editar Componente". A
                // multi-component workstation additionally offers "Editar Componente" for the clicked
                // row. Resets are contextual and the swap stays so a prior Trocar remains recoverable.
                : (() => {
                    const t = editMenu.target
                    const hasDesc = (t.desc ?? '').trim() !== ''
                    const singleEntity = wsComponentCount(t) <= 1
                    return [
                      { label: 'Editar Workstation', icon: <Pencil size={13} />, onClick: () => openWorkstationEditFromMenu() },
                      ...(hasWorkstationScope(t)
                        ? [{ label: 'Resetar Workstation', icon: <RotateCcw size={13} />, danger: true, onClick: () => resetWorkstationFromMenu(t) }]
                        : []),
                      ...((!singleEntity && hasDesc)
                        ? [
                            { label: 'Editar Componente', icon: <Pencil size={13} />, onClick: () => openEditPanelFromMenu('desc') },
                            ...(hasActiveScope('desc', t)
                              ? [{ label: 'Resetar Componente', icon: <RotateCcw size={13} />, danger: true, onClick: () => resetScopeFromMenu('desc') }]
                              : []),
                          ]
                        : []),
                      // A manually-added station can be removed entirely (drops it + any edits on it).
                      ...(isAddedWs(t)
                        ? [{ label: 'Remover Workstation', icon: <Trash2 size={13} />, danger: true, onClick: () => removeAddedWorkstation(t) }]
                        : []),
                    ]
                  })()
          }
        />
      )}

      {/* Right-click a Saturday header → toggle it as a working Saturday (local; persists on Save). */}
      {satMenu && (
        <ContextMenu
          x={satMenu.x}
          y={satMenu.y}
          onClose={() => setSatMenu(null)}
          items={[
            saturdayWorkdays.includes(satMenu.iso)
              ? { label: `Remover sábado útil (${satMenu.iso.slice(8, 10)}/${satMenu.iso.slice(5, 7)})`, icon: <CalendarMinus size={13} />, danger: true, onClick: () => toggleSaturdayWorkday(satMenu.iso) }
              : { label: `Marcar sábado como dia útil (${satMenu.iso.slice(8, 10)}/${satMenu.iso.slice(5, 7)})`, icon: <CalendarPlus size={13} />, onClick: () => toggleSaturdayWorkday(satMenu.iso) },
          ]}
        />
      )}

      {/* Reverse validation — the Saturday still carries allocations, so the revert is refused and
          the blocking workstations are named. The user displaces them off the Saturday first. */}
      {satBlock && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 p-4"
             onMouseDown={() => setSatBlock(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col"
               onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <AlertTriangle size={16} className="shrink-0" style={{ color: '#F59E0B' }} />
              <h3 className="text-sm font-bold text-gray-800">Não é possível converter este sábado</h3>
            </div>
            <div className="px-4 py-3 text-[12px] text-gray-700 leading-relaxed">
              Existem alocações de workstation em{' '}
              <strong className="tabular-nums">
                {satBlock.iso.slice(8, 10)}/{satBlock.iso.slice(5, 7)}/{satBlock.iso.slice(0, 4)}
              </strong>
              . Mova ou reprograme as atividades afetadas antes de convertê-lo em dia não útil.
              <ul className="mt-2 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 divide-y divide-gray-200">
                {satBlock.locos.map(l => (
                  <li key={l} className="px-2.5 py-1.5 text-[11px] font-medium text-gray-700">{l}</li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end px-4 py-3 border-t border-gray-200 bg-gray-50">
              <button onClick={() => setSatBlock(null)}
                className="px-3 py-1.5 text-xs rounded text-white font-semibold hover:brightness-95"
                style={{ background: RED_DK }}>
                Entendi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Mode hint — shown while dragging a box with the arrow keys. */}
      {moveMode && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[9999] flex items-center gap-3 rounded-lg px-4 py-2 text-[12px] font-semibold text-white shadow-xl"
          style={{ background: '#1E3A8A' }}
        >
          <span className="font-bold">
            {moveMode.targets.length > 1
              ? `Movendo ${moveMode.targets.length} linhas`
              : `Movendo ${moveMode.targets[0]?.scope === 'desc' ? 'Componente' : 'Workstation'} ${moveMode.targets[0]?.ws ?? ''}`}
          </span>
          <span className="opacity-90 whitespace-nowrap">
            {moveMode.dStart === 0 ? '-' : `${moveMode.dStart > 0 ? '+' : ''}${moveMode.dStart}d`}
            {moveMode.durationEditable && moveMode.dFinish !== 0 ? ` · duração ${moveMode.dFinish > 0 ? '+' : ''}${moveMode.dFinish}d` : ''}
          </span>
          <span className="opacity-70">·</span>
          <span className="inline-flex items-center gap-1"><kbd className="px-1 bg-white/20 rounded">←</kbd><kbd className="px-1 bg-white/20 rounded">→</kbd> mover</span>
          {moveMode.durationEditable && (
            <span className="inline-flex items-center gap-1"><kbd className="px-1 bg-white/20 rounded">+</kbd><kbd className="px-1 bg-white/20 rounded">−</kbd> duração</span>
          )}
          <span className="inline-flex items-center gap-1"><kbd className="px-1 bg-white/20 rounded">Enter</kbd> confirmar</span>
          <span className="inline-flex items-center gap-1"><kbd className="px-1 bg-white/20 rounded">Esc</kbd> cancelar</span>
        </div>
      )}

      {/* Protection-Days crossing warning: raised the first time a Move-Mode step would push the station
          beyond the PD limit (or the LOCO finish). "Parar aqui" keeps the move at its last valid position;
          "Continuar" acknowledges the crossing and replays the held keystroke (border then turns red). */}
      {pdWarn && moveMode && (
        <MovePdWarningPrompt onContinue={pdWarnContinue} onStop={pdWarnStop} />
      )}

      {/* Post-move prompt after committing a move (Enter): "Categoria" (mandatory) + "Observação"
          (optional) + "Propagar efeitos?". Always CENTERED in the view. Modal: Sim/Não keep the move
          (and its reason), X/Esc undo it, an outside click does nothing at all — see MoveNotePrompt. */}
      {movePropPrompt && movePropPrompt.targets.length > 0 && (
        <MoveNotePrompt
          prevNotes={(scopedEditOf(movePropPrompt.targets[0]) as ScopedEdit | undefined)?.notes ?? []}
          rowCount={movePropPrompt.targets.length}
          // This row is ALREADY cascading from an earlier move, so "Não" cannot mean "no cascade" —
          // it means "don't add more". Told to the prompt so the button says what it actually does.
          propagating={!!(scopedEditOf(movePropPrompt.targets[0]) as ScopedEdit | undefined)?.propagate}
          recovery={movePropPrompt.recovery ?? false}
          // Post-PD stations are manual-only: hide the propagation controls and force "Não" — a post-PD
          // edit must never cascade (the worker already denies it the inherited cascade too).
          propagationDisabled={!!movePropPrompt.propagationDisabled}
          onResolve={resolveMoveProp}
          onCancel={cancelMoveProp}
        />
      )}

      {/* Move-description bubble — the clicked box's full reason trail. */}
      {moveNoteView && (
        <MoveNotePopover
          notes={moveNoteView.notes}
          title={moveNoteView.title}
          x={moveNoteView.x}
          y={moveNoteView.y}
          // Rewriting a reason is an EDIT: same gate as every other override authoring path — Editor+
          // (canSave) and never in the read-only 'Original' reference mode. Readers still see the trail.
          canEdit={canSave && !readOnly}
          onEdit={updateMoveNote}
          onClose={() => setMoveNoteView(null)}
        />
      )}

      {/* Save confirmation — password gate before persisting overrides to the DB. Isolated component
          so typing the password doesn't re-render this heavy modal. */}
      {savePwModal && (
        <SavePasswordModal onConfirm={confirmSaveOverrides} onClose={() => setSavePwModal(false)} />
      )}

      {/* Centered, non-blocking save feedback: saving → saved (auto-hides) / error (retry). */}
      {overridesSaveState !== 'idle' && (
        <SaveStatusOverlay state={overridesSaveState} count={savedCount} error={saveError} onRetry={retrySave} onDismiss={() => { setOverridesSaveState('idle'); setSaveError(null) }} />
      )}

      {/* Scoped edit dialog — same style as "Editar Limites". One panel, three scopes. */}
      {editPanel && (
        <div className="fixed inset-0 z-[9998]">
          <PanelLocoEdit
            title={panelView(editPanel).title}
            subtitle={panelView(editPanel).subtitle}
            takt={panelView(editPanel).takt}
            startShift={panelView(editPanel).startShift}
            finishShift={panelView(editPanel).finishShift}
            showPropagate={editPanel.scope !== 'loco'}
            propagate={panelView(editPanel).propagate ? 'local' : 'no'}
            showHours={panelView(editPanel).showHours}
            hoursTotal={panelView(editPanel).hoursTotal}
            hoursActive={panelView(editPanel).hoursActive}
            hoursDisabled={panelView(editPanel).hoursDisabled}
            hoursDisabledMsg={panelView(editPanel).hoursDisabledMsg}
            hoursAsWs={panelView(editPanel).hoursAsWs}
            accentColor={RED}
            onSave={(takt, startShift, finishShift, propagate, hoursTotal) => {
              const propOn = propagate !== 'no'
              // A manually-added station's hours are AUTHORED on its addWs entry, not scaled from a
              // routing, so they are written straight back there (see setAddedWsHours) and kept out of
              // the scoped edit — which would otherwise try to scale a possibly-zero base and no-op.
              const addedHours = hoursTotal != null && !!addedWsOf(editPanel)
              // Folded into the SAME commit (commitScopedEdits takes an explicit base) — two separate
              // writes off one stale `writeOverrides` closure would clobber each other.
              const baseMap = addedHours ? withAddedWsHours(writeOverrides, editPanel, hoursTotal!) : writeOverrides
              // Route through commitScopedEdits (explicit base) so the Global path can chain the cascade
              // onto the post-edit map; behavior is identical to applyScopedEdit for the No/Local cases.
              // "Propagar WS Única" scopes Global to the edited workstation alone — including inside
              // THIS loco (see resolveMoveProp). It declines to add propagation without revoking what
              // the station already carries.
              const singleWsGlobal = propagate === 'global' && getGlobalPropOptions().singleWs
              const propWrite = singleWsGlobal ? !!panelView(editPanel).propagate : propOn
              const next = commitScopedEdits(baseMap, [{ target: editPanel, takt, startShift, finishShift, propagate: propWrite, hoursTotal: addedHours ? null : (hoursTotal ?? null) }], true)
              if (propagate === 'global' && editPanel.ws) {
                void runGlobalCascade(next, locoKeyForTarget(editPanel), [editPanel.ws], true)
              }
            }}
            onClear={() => { clearScopedEdit(editPanel) }}
            onClose={() => setEditPanel(null)}
          />
        </div>
      )}

      {/* "Adicionar Workstation" — insert a station not in the source schedule (override-only). */}
      {addWsPanel && (
        <PanelAddWorkstation
          subtitle={`LOCO — ${addWsPanel.taskName || addWsPanel.wo}`}
          existingWsNames={existingWsNamesForLoco(addWsPanel)}
          existingAreas={existingAreasForPicker()}
          defaultStartIso={addWsPanel.startMs ? String(addWsPanel.startMs).slice(0, 10) : undefined}
          accentColor={RED}
          onSave={(entry, propagate) => { commitAddedWorkstation(addWsPanel, entry, propagate); setAddWsPanel(null) }}
          onClose={() => setAddWsPanel(null)}
        />
      )}
    </div>
  )
}
