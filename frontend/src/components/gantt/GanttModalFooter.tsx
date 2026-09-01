'use client'
import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import type React from 'react'
import { Download, ChevronDown, Hand, Loader2, Zap, X, GitBranch, LayoutList, RefreshCw, AlertTriangle, Search, Eye, EyeOff, ArrowRightLeft, Link2 } from 'lucide-react'
import { RED, computeConflictCounts, computeConflictDetails, normWs, isConflictWsOverridden } from '@/lib/ganttUtils'
import { getMergeLocoTypes, setMergeLocoTypes, subscribeMergeLocoTypes } from '@/lib/locoMerge'
import { COMPARE_LINE } from './SummaryAreaChart'
import type { GanttData } from '@/lib/api'
import type { SummaryTestResult } from './types'
import { useConflictWs } from './useConflictWs'
import { ConflictWsModal } from './ConflictWsModal'
import { usePermissions } from '@/context/PermissionsContext'

const PURPLE = '#7B1FA2'

/**
 * One footer scenario label: the Resumo Geral chart's line swatch + the scenario's name, drawn in
 * that series' own colour. Solid red = the primary (active) series; dashed gray = the compared
 * series. Reusing the chart's exact stroke style is the whole point — the label is how you tell
 * which line on the chart is which scenario.
 */
export function ScenarioLabel({ name, color, dashed, title, maxWidth = 220 }: {
  name: string; color: string; dashed: boolean; title: string
  /** Hard cap on the NAME's width; anything longer is cut with an ellipsis so a verbose scenario
   *  name can never grow into — or overlap — the footer buttons on either side. Tighter on the
   *  Schedule tab, where the label shares the row with the whole Gantt toolbar. */
  maxWidth?: number
}) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      <svg width="16" height="6" aria-hidden="true" style={{ flexShrink: 0 }}>
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth={dashed ? 1.8 : 2.2} strokeDasharray={dashed ? '5 3' : undefined} />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 700, color, maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
    </span>
  )
}

/**
 * "Ocultar" — the two hide options, independent so every combination is reachable:
 * neither, only-before-LOCO-start, only-finished-LOCOs, or both. They answer different
 * questions (which CELLS a LOCO may draw vs. which LOCOS appear at all), so folding them
 * into one switch would make "drop finished LOCOs but keep each survivor's full bar" — and
 * its opposite — impossible to express. Together they give the focused view: only live
 * LOCOs, each drawn from its own start date.
 *
 * Neither option clamps the timeline. A LOCO that started a month ago and still has work
 * today renders in full, past columns included — that history is the context for what is
 * left. Use the calendar button in the Schedule's top-left corner to jump to today.
 *
 * The eye is filled whenever either option is on; the badge shows how many.
 */
function HideMenu({
  hideBeforeStart, setHideBeforeStart, hidePastLocos, setHidePastLocos,
}: {
  hideBeforeStart: boolean
  setHideBeforeStart: (fn: (v: boolean) => boolean) => void
  hidePastLocos: boolean
  setHidePastLocos: (fn: (v: boolean) => boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const activeCount = (hideBeforeStart ? 1 : 0) + (hidePastLocos ? 1 : 0)
  const on = activeCount > 0

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Compact labels — one short, scannable phrase each; the full explanation lives in the
  // title tooltip. "Ocultar concluídas" drops content before Today, "Ocultar pre-início" drops
  // content before each LOCO's start_ms. Ordered concluídas-then-pre-início to match how the pair reads.
  const rows = [
    {
      key: 'today',
      checked: hidePastLocos,
      toggle: () => setHidePastLocos(v => !v),
      label: 'Ocultar concluídas',
      title: 'Remove LOCOs sem atividade a partir de hoje. LOCOs em andamento seguem visíveis por completo.',
    },
    {
      key: 'loco',
      checked: hideBeforeStart,
      toggle: () => setHideBeforeStart(v => !v),
      label: 'Ocultar pre-início',
      title: 'Esconde operações/workstations anteriores ao início (start_ms) de cada LOCO.',
    },
  ]

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Opções de ocultar"
        className="flex h-7 items-center justify-center gap-0.5 rounded border px-1 transition-colors hover:bg-red-50"
        style={{ borderColor: on ? RED : '#D1D5DB', color: on ? RED : '#6B7280', background: on ? '#F0FDFA' : undefined }}
      >
        {on ? <EyeOff size={14} /> : <Eye size={14} />}
        {/* Fixed-width slot: reserved whether or not a count shows, so the button keeps ONE
            standard size (the with-number size) and never jumps when a filter is toggled. */}
        <span style={{ width: 7, textAlign: 'center', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
          {activeCount > 0 ? activeCount : ''}
        </span>
        <ChevronDown size={10} style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60, width: 172,
            background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8,
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)', padding: 4,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', padding: '6px 8px 4px', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Ocultar
          </div>
          {rows.map(r => (
            <button
              key={r.key}
              onClick={r.toggle}
              title={r.title}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '4px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
                background: r.checked ? '#F0FDFA' : 'transparent',
              }}
              onMouseEnter={e => { if (!r.checked) e.currentTarget.style.background = '#F9FAFB' }}
              onMouseLeave={e => { if (!r.checked) e.currentTarget.style.background = 'transparent' }}
            >
              <span
                style={{
                  width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                  border: `1.5px solid ${r.checked ? RED : '#CBD5E1'}`,
                  background: r.checked ? RED : '#fff',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {r.checked && (
                  <svg width="9" height="9" viewBox="0 0 16 16">
                    <path d="M3 8.5 L6.5 12 L13 4.5" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              {/* Just the compact label; the full explanation is on the row's title tooltip. */}
              <span style={{ minWidth: 0, fontSize: 12, fontWeight: 600, color: r.checked ? RED : '#374151' }}>{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


const OTIMIZAR_MODES = [
  {
    id: 1,
    icon: GitBranch,
    title: 'Modo 1',
    description: 'Otimizar workstations conflitantes',
    detail: 'Otimiza automaticamente workstations conflitantes buscando reduzir conflitos e melhorar o fluxo do cronograma.',
  },
  {
    id: 2,
    icon: LayoutList,
    title: 'Modo 2',
    description: 'Reformulação do Master Schedule',
    detail: 'Reformula o Master Schedule completo aplicando otimização global sobre todas as workstations e períodos.',
  },
] as const

type OtimizarMode = typeof OTIMIZAR_MODES[number]

interface GanttModalFooterProps {
  /** 'original' reference mode: read-only. Suppresses Move Mode + the optimizer trigger. */
  readOnly?: boolean
  activeTab: 0 | 1 | 2 | 3
  effectiveData: GanttData | null
  filteredGroups: GanttData['groups'] | undefined
  filteredDateInfo: GanttData['date_info'] | undefined
  summaryTestData: SummaryTestResult | null
  exporting: boolean
  /** Aggregate Workstation ↔ Componente expansion state, drives which bulk button reads as
   *  active: 'all' → FULL, 'none' → WORK, 'mixed' → neither. */
  wsExpandSummary: 'all' | 'none' | 'mixed'
  /** Bulk expand/collapse every workstation (the former FULL/WORK global modes). */
  onSetAllWsExpanded: (expanded: boolean) => void
  /** Aggregate LOCO ↔ Workstation expansion state: 'none' (all collapsed) is the former
   *  LOCO mode (narrow layout); 'all' means the tree is fully open at the LOCO tier. */
  locoExpandSummary: 'all' | 'none' | 'mixed'
  /** Bulk expand/collapse every LOCO (the former LOCO global mode = collapse all). */
  onSetAllLocosExpanded: (expanded: boolean) => void
  ganttGrabMode: boolean
  setGanttGrabMode: (fn: (v: boolean) => boolean) => void
  hideBeforeStart: boolean
  setHideBeforeStart: (fn: (v: boolean) => boolean) => void
  hidePastLocos: boolean
  setHidePastLocos: (fn: (v: boolean) => boolean) => void
  zoom: number
  zoomBusy: boolean
  setZoom: (fn: (v: number) => number) => void
  setZoomBusy: (v: boolean) => void
  onceBuiltRef: React.MutableRefObject<(() => void) | null>
  showExportMenu: boolean
  setShowExportMenu: (fn: (v: boolean) => boolean) => void
  exportMenuRef: React.RefObject<HTMLDivElement | null>
  handleExportSummary: (level: 'area' | 'subarea' | 'itens' | 'tipo' | 'modelo' | 'loco') => void
  /** Active Resumo Geral hierarchy: 'area' → Área/Subárea/Itens, 'locos' → Tipo/Modelo/Loco. */
  summaryRowMode: 'area' | 'locos'
  onClose: () => void
  activeOptMode: 1 | 2 | 3 | null
  optLoading: boolean
  optError: string | null
  onOptModeChange: (mode: 1 | 2 | 3) => void
  onOpenMode1Options: () => void
  onRestoreOriginal: () => void
  onLocoClick: (taskName: string, linha?: string, modelWo?: string, startMs?: string | number | null) => void
  /** Scroll the Schedule to one WORKSTATION of one LOCO — the Gantt's own navigation, reused by the
   *  conflict list so a row lands on the conflicting station and not merely on the LOCO. */
  onWsClick: (wo: string, taskName: string, ws: string, subarea?: string, linha?: string, startMs?: string) => void
  /** Persisted LOCO search text — lifted to GanttModal so it survives tab switches
   *  and footer remounts. Only cleared by an explicit user action (X / Escape). */
  locoSearch: string
  setLocoSearch: (v: string) => void
  /** Schedule-only filter panel, rendered to the right of the LOCO search bar
   *  (Schedule tab). Its dropdowns open upward so they stay above the footer. */
  scheduleFilter?: React.ReactNode
  /** True when the active optimization ran with "Permitir regras de sobreposição":
   *  a boundary handoff (end of one LOCO = start of another, max 2 LOCOs) on WS40/WS50
   *  is not counted as a conflict. Keeps the footer count identical to the header. */
  allowOverlap?: boolean
  /** Scenario-comparison mode: shows the "Trocar Cenário" switch button next to Export.
   *  Toggles the active scenario (Base ↔ Target) instantly. */
  comparisonMode?: boolean
  comparisonActive?: 'base' | 'target'
  onComparisonSwitch?: () => void
  /** Names of the two compared scenarios — rendered as the footer's scenario labels (comparison
   *  mode only). This footer is the SINGLE place a scenario is identified; the modal header no
   *  longer carries a name pill. */
  comparisonBaseName?: string
  comparisonTargetName?: string
  /** Standard (non-comparison) mode label: the loaded scenario's name, or undefined for the live
   *  database. Shown in the same red as the chart's primary series. */
  scenarioName?: string
  /** Show/Hide the ±5% comparison arrows in Resumo Geral (UI-only; default ON). */
  showCompareArrows?: boolean
  onToggleCompareArrows?: () => void
  /** Whether a comparison is active at all — scenario-compare OR the single-scenario mode-reference
   *  deviation (Padrão/Projeção). Gates the visibility of the show/hide-variations toggle so it also
   *  appears in a normal Schedule session when there are deviations to reveal. */
  compareArrowsAvailable?: boolean
}

export function GanttModalFooter({
  readOnly = false,
  activeTab,
  effectiveData,
  filteredGroups,
  filteredDateInfo,
  summaryTestData,
  exporting,
  wsExpandSummary, onSetAllWsExpanded,
  locoExpandSummary, onSetAllLocosExpanded,
  ganttGrabMode, setGanttGrabMode,
  hideBeforeStart, setHideBeforeStart,
  hidePastLocos, setHidePastLocos,
  zoom, zoomBusy, setZoom, setZoomBusy,
  onceBuiltRef,
  showExportMenu, setShowExportMenu,
  exportMenuRef,
  handleExportSummary,
  summaryRowMode,
  onClose,
  activeOptMode,
  optLoading,
  optError,
  onOptModeChange,
  onOpenMode1Options,
  onRestoreOriginal,
  onLocoClick,
  onWsClick,
  locoSearch,
  setLocoSearch,
  scheduleFilter,
  allowOverlap = false,
  comparisonMode = false,
  comparisonActive = 'base',
  onComparisonSwitch,
  comparisonBaseName,
  comparisonTargetName,
  scenarioName,
  showCompareArrows = true,
  onToggleCompareArrows,
  compareArrowsAvailable = false,
}: GanttModalFooterProps) {
  const { canOptimize } = usePermissions()   // Editor/Admin may run the solver; Readers may not
  // "Unir locos" — the shared session switch (lib/locoMerge), also read by ResumoGeralTab and the
  // Carga de Fábrica home tree, so all three always show the same picture of a contested serial.
  const mergeLocos = useSyncExternalStore(subscribeMergeLocoTypes, getMergeLocoTypes, getMergeLocoTypes)
  const [otimizarHovered,  setOtimizarHovered]  = useState(false)
  const [arrowsHovered,    setArrowsHovered]    = useState(false)
  const [mergeHovered,     setMergeHovered]     = useState(false)
  const [switchHovered,    setSwitchHovered]    = useState(false)
  const [showOtimizarMenu, setShowOtimizarMenu] = useState(false)
  const [zoomInput,        setZoomInput]        = useState<string>('')
  const [zoomFocused,      setZoomFocused]      = useState(false)
  const [locoSearchOpen,   setLocoSearchOpen]   = useState(false)
  const prevOptLoadingRef = useRef(false)
  const locoSearchRef     = useRef<HTMLDivElement>(null)
  const locoInputRef      = useRef<HTMLInputElement>(null)

  // Build deduplicated LOCO list from active groups
  const locoList = useMemo(() => {
    const groups = filteredGroups ?? effectiveData?.groups ?? []
    const seen = new Set<string>()
    const result: { taskName: string; linha: string; wo: string; startMs: string | number | null }[] = []
    for (const g of groups) {
      const key = `${g.task_name}||${g.wo}||${g.start_ms ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push({ taskName: g.task_name, linha: g.linha, wo: g.wo, startMs: g.start_ms ?? null })
      }
    }
    return result
  }, [effectiveData, filteredGroups])

  const locoResults = useMemo(() => {
    const q = locoSearch.trim().toLowerCase()
    if (!q) return []
    return locoList.filter(l =>
      l.taskName.toLowerCase().includes(q) ||
      l.wo.toLowerCase().includes(q) ||
      l.linha.toLowerCase().includes(q)
    ).slice(0, 10)
  }, [locoSearch, locoList])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!locoSearchOpen) return
    function onDown(e: MouseEvent) {
      if (locoSearchRef.current && !locoSearchRef.current.contains(e.target as Node)) {
        // Only close the dropdown — keep the typed/selected LOCO so the search
        // persists across navigation, refreshes and tab switches.
        setLocoSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [locoSearchOpen])

  // Conflicts in the CURRENTLY active Schedule (post-optimization if optimized).
  // Canonical pair count (lib/ganttUtils) — identical definition to the General Summary
  // header/per-model so all views agree on the same dataset. When a Schedule filter is
  // active, filteredGroups narrows the set; with no filter it equals effectiveData.groups
  // (so the footer and the header total match exactly).
  // Session conflict-WS override — included in the deps so the count recomputes live when
  // the user applies/resets a custom workstation set from the right-click dialog.
  const conflictWs = useConflictWs()
  const conflictCount = useMemo(() => {
    if (!effectiveData) return 0
    return computeConflictCounts(filteredGroups ?? effectiveData.groups, allowOverlap, conflictWs).total
  }, [effectiveData, filteredGroups, allowOverlap, conflictWs])

  // ── The conflict list behind the count ─────────────────────────────────────────────────────
  // Same dataset, same definition (both are projections of one pair map in ganttUtils), so a row
  // here can never disagree with the number on the button that opened it. Computed only while the
  // dropdown is open — it is a full scan of the Schedule, and nothing shows it when it is closed.
  const [conflictListOpen, setConflictListOpen] = useState(false)
  const conflictBoxRef = useRef<HTMLDivElement>(null)
  const conflictDetails = useMemo(() => {
    if (!conflictListOpen || !effectiveData) return []
    return computeConflictDetails(filteredGroups ?? effectiveData.groups, allowOverlap, conflictWs)
  }, [conflictListOpen, effectiveData, filteredGroups, allowOverlap, conflictWs])
  // A conflict resolved while the list is open (an edit, a filter, a new conflict-WS set) can empty
  // it. The panel is therefore gated on the COUNT as well as on the flag — derived, not synced
  // through an effect, so an emptied list simply stops rendering instead of costing a second pass.
  const conflictListShown = conflictListOpen && conflictCount > 0
  useEffect(() => {
    if (!conflictListOpen) return
    function onDown(e: MouseEvent) {
      if (conflictBoxRef.current && !conflictBoxRef.current.contains(e.target as Node)) setConflictListOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setConflictListOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [conflictListOpen])

  // Distinct workstations present in the current Schedule (normalized) — feeds the
  // right-click "conflict workstations" selection dialog.
  const scheduleWorkstations = useMemo(() => {
    const s = new Set<string>()
    for (const g of effectiveData?.groups ?? []) {
      for (const w of g.workstations) { const n = normWs(w.ws); if (n) s.add(n) }
    }
    return [...s]
  }, [effectiveData])
  const [conflictWsDialogOpen, setConflictWsDialogOpen] = useState(false)
  const conflictWsOverridden = isConflictWsOverridden()

  // Auto-close panel when optimization finishes without error
  useEffect(() => {
    if (prevOptLoadingRef.current && !optLoading && !optError) {
      setShowOtimizarMenu(false)
    }
    prevOptLoadingRef.current = optLoading
  }, [optLoading, optError])

  function applyZoomInput(raw: string) {
    const pct = parseFloat(raw)
    if (isNaN(pct)) { setZoomInput(''); return }
    const clamped = Math.min(150, Math.max(50, pct))
    const snapped = Math.round(clamped / 10) * 10
    if (zoomBusy) return
    setZoomBusy(true)
    setTimeout(() => {
      setZoom(() => snapped / 100)
      const t = setTimeout(() => setZoomBusy(false), 3000)
      const clear = () => { clearTimeout(t); setZoomBusy(false) }
      onceBuiltRef.current = clear
    }, 0)
    setZoomInput('')
  }

  // ── Scenario identification, one definition for all four tabs ──────────────────────────────────
  // In comparison mode both scenarios are named (Base first, always, so the two never swap places
  // under the user); otherwise the single active source is named — the loaded scenario, or the live
  // database. Rendered twice below: centred on Resumo Geral / Plano Externo / Plano, and in-flow on the
  // Schedule, whose footer has no free centre to sit in.
  const scenarioItems = comparisonMode
    ? [
        { key: 'base',   label: 'Base',   name: comparisonBaseName   || 'Base',   active: comparisonActive === 'base' },
        { key: 'target', label: 'Target', name: comparisonTargetName || 'Target', active: comparisonActive === 'target' },
      ]
    : [{ key: 'db', label: 'Database', name: scenarioName || 'Database', active: true }]
  const scenarioTitle = (it: { label: string; name: string; active: boolean }) => comparisonMode
    ? `Cenário ${it.label}: ${it.name} — ${it.active ? 'ativo (linha vermelha)' : 'comparado (linha cinza tracejada)'}`
    : `Fonte de dados: ${it.name}`

  return (
    <>
    <style>{`input[type=number].zoom-input::-webkit-inner-spin-button,input[type=number].zoom-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}`}</style>

    {/* Session conflict-workstation selection dialog (right-click the Conflict Count). */}
    {conflictWsDialogOpen && (
      <ConflictWsModal allWorkstations={scheduleWorkstations} onClose={() => setConflictWsDialogOpen(false)} />
    )}

    {/* Optimization menu modal */}
    {showOtimizarMenu && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
        onClick={e => { if (!optLoading && e.target === e.currentTarget) setShowOtimizarMenu(false) }}
      >
        <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[400px] overflow-hidden">
          {/* Title bar */}
          <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ background: PURPLE }}>
            <div className="flex items-center gap-2 text-white">
              <Zap size={15} />
              <span className="font-semibold text-sm tracking-wide">Otimizar Schedule</span>
            </div>
            <button
              onClick={() => { if (!optLoading) setShowOtimizarMenu(false) }}
              disabled={optLoading}
              className="rounded p-1 transition-colors hover:bg-white/20 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              title={optLoading ? 'Otimização em andamento…' : 'Fechar'}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="p-4 flex flex-col gap-2">
            {/* Loading indicator — terminal modal (OptimizeScheduleModal) shows full logs */}
            {optLoading && (
              <div className="flex items-center gap-2 py-6 justify-center">
                <Loader2 size={20} className="animate-spin shrink-0" style={{ color: PURPLE }} />
                <span className="text-sm font-medium" style={{ color: PURPLE }}>Otimizando schedule…</span>
              </div>
            )}

            {!optLoading && (
              <>
                <p className="text-xs text-gray-500 mb-1">Selecione o modo de otimização:</p>
                {optError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 mb-1">
                    {optError}
                  </div>
                )}
                {OTIMIZAR_MODES.map(mode => {
                  const Icon = mode.icon
                  const isActive = activeOptMode === mode.id
                  const disabled = mode.id === 2
                  return (
                    <button
                      key={mode.id}
                      disabled={disabled}
                      onClick={() => { if (mode.id === 1) onOpenMode1Options(); else onOptModeChange(mode.id) }}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors border"
                      style={
                        disabled
                          ? { borderColor: '#E5E7EB', background: '#F9FAFB', cursor: 'not-allowed', opacity: 0.5 }
                          : isActive
                            ? { borderColor: PURPLE, background: PURPLE, cursor: 'pointer' }
                            : { borderColor: '#E5E7EB', cursor: 'pointer' }
                      }
                      onMouseEnter={e => { if (!disabled && !isActive) { const el = e.currentTarget as HTMLElement; el.style.background = '#F3E5F5'; el.style.borderColor = PURPLE } }}
                      onMouseLeave={e => { if (!disabled && !isActive) { const el = e.currentTarget as HTMLElement; el.style.background = ''; el.style.borderColor = '#E5E7EB' } }}
                    >
                      <Icon size={18} style={{ color: isActive ? '#fff' : disabled ? '#9CA3AF' : PURPLE, flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold" style={{ color: isActive ? '#fff' : disabled ? '#9CA3AF' : PURPLE }}>{mode.title}</div>
                        <div className="text-xs mt-0.5" style={{ color: isActive ? '#E9D5FF' : '#6B7280' }}>{mode.description}</div>
                      </div>
                      {isActive && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.25)', color: '#fff' }}>ATIVO</span>}
                    </button>
                  )
                })}

                {/* Restaurar visão inicial — separated */}
                <div style={{ borderTop: '1px solid #E5E7EB', marginTop: 4, paddingTop: 8 }}>
                  <button
                    onClick={() => { onRestoreOriginal(); setShowOtimizarMenu(false) }}
                    disabled={activeOptMode === null}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg text-left w-full transition-colors border"
                    style={
                      activeOptMode === null
                        ? { borderColor: '#E5E7EB', background: '#F9FAFB', cursor: 'not-allowed', opacity: 0.4 }
                        : { borderColor: '#D1D5DB', cursor: 'pointer' }
                    }
                    onMouseEnter={e => { if (activeOptMode !== null) { const el = e.currentTarget as HTMLElement; el.style.background = '#F3F4F6'; el.style.borderColor = '#6B7280' } }}
                    onMouseLeave={e => { if (activeOptMode !== null) { const el = e.currentTarget as HTMLElement; el.style.background = ''; el.style.borderColor = '#D1D5DB' } }}
                  >
                    <RefreshCw size={18} style={{ color: '#6B7280', flexShrink: 0 }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-gray-600">Restaurar visão inicial</div>
                      <div className="text-xs text-gray-400 mt-0.5">Volta ao cronograma original sem otimização</div>
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )}
    <div className="relative shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-t border-gray-200 bg-gray-50">
      {/* ── Scenario identification — every tab, two placements ───────────────────────────
          Same treatment as the main app's footer app-name label (AppFooter): the control
          groups on either side have different, changing widths, so a flow-centred label
          would sit off-centre and drift. `pointer-events-none` on the wrapper keeps it from
          eating a click meant for a control behind it; the labels themselves re-enable
          pointer events so their tooltips still work.
          This is the SINGLE place a scenario is named — the modal header's name pill is gone.
          Colours mirror the Resumo Geral chart's two series, so a label and its line always
          match: the ACTIVE scenario is the solid red line, the compared one the dashed gray
          line — "Trocar Cenário" swaps both together. Base is always listed first so the two
          names never change position under the user. */}
      {/* CENTRED variant — Resumo Geral, Plano Externo and Plano de Produção. All three have a free
          footer centre (a short status span on the left, Exportar/Fechar on the right), so the label
          can be absolutely centred there. The Schedule tab is excluded: its footer is a full toolbar
          from edge to edge, so it gets the in-flow variant a few lines below instead. */}
      {activeTab !== 3 && (
        <div
          className="hidden lg:flex absolute left-1/2 -translate-x-1/2 pointer-events-none select-none items-center"
          style={{ gap: 14, maxWidth: '46%' }}
        >
          {scenarioItems.map(it => (
            <span key={it.key} style={{ pointerEvents: 'auto', minWidth: 0 }}>
              <ScenarioLabel
                name={it.name}
                color={it.active ? RED : COMPARE_LINE}
                dashed={!it.active}
                title={scenarioTitle(it)}
              />
            </span>
          ))}
        </div>
      )}
      {activeTab === 3 && effectiveData ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div ref={locoSearchRef} style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: 28, border: `1px solid ${locoSearchOpen ? RED : '#D1D5DB'}`, borderRadius: 6, background: '#fff', padding: '0 8px', transition: 'border-color .15s' }}>
            <Search size={12} style={{ color: locoSearchOpen ? RED : '#9CA3AF', flexShrink: 0 }} />
            <input
              ref={locoInputRef}
              type="text"
              placeholder="Buscar LOCO…"
              value={locoSearch}
              onFocus={() => setLocoSearchOpen(true)}
              onChange={e => { setLocoSearch(e.target.value); setLocoSearchOpen(true) }}
              onKeyDown={e => {
                if (e.key === 'Escape') { setLocoSearchOpen(false); setLocoSearch(''); locoInputRef.current?.blur() }
                if (e.key === 'Enter' && locoResults.length === 1) {
                  const r = locoResults[0]
                  onLocoClick(r.taskName, r.linha, r.wo, r.startMs)
                  // Keep the selected LOCO in the box — only close the dropdown.
                  setLocoSearchOpen(false)
                }
              }}
              style={{ width: 110, fontSize: 11, border: 'none', outline: 'none', background: 'transparent', color: '#374151' }}
            />
            {locoSearch && (
              <button onClick={() => { setLocoSearch(''); locoInputRef.current?.focus() }} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: '#9CA3AF', display: 'flex', alignItems: 'center' }}>
                <X size={11} />
              </button>
            )}
          </div>
          {locoSearchOpen && locoResults.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 60, minWidth: 180, maxHeight: 260, overflowY: 'auto' }}>
              {locoResults.map((r, i) => (
                <button
                  key={i}
                  onMouseDown={e => { e.preventDefault(); onLocoClick(r.taskName, r.linha, r.wo, r.startMs); setLocoSearchOpen(false); setLocoSearch(r.taskName) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', cursor: 'pointer', borderBottom: i < locoResults.length - 1 ? '1px solid #F3F4F6' : 'none' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#F0FDFA' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: RED }}>{r.taskName}</span>
                  <span style={{ fontSize: 10, color: '#9CA3AF', marginLeft: 5 }}>{r.wo}</span>
                </button>
              ))}
            </div>
          )}
          {locoSearchOpen && locoSearch.trim() && locoResults.length === 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 60, minWidth: 180, padding: '8px 10px' }}>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>Nenhum resultado</span>
            </div>
          )}
        </div>
        {scheduleFilter}
        {/* Hide (Ocultar) — sits to the RIGHT of the Filters button, in the same toolbar group. */}
        <HideMenu
          hideBeforeStart={hideBeforeStart}
          setHideBeforeStart={setHideBeforeStart}
          hidePastLocos={hidePastLocos}
          setHidePastLocos={setHidePastLocos}
        />
        </div>
      ) : (
        <span className="text-[10px] text-gray-400">
          {effectiveData
            ? `${(filteredGroups ?? effectiveData.groups).length} locos · ${(filteredDateInfo ?? effectiveData.date_info).length} dias`
            : '—'}
        </span>
      )}
      {/* IN-FLOW variant — Schedule tab only. Deliberately NOT centred: the centre is occupied by the
          Gantt toolbar, so the label takes whatever slack is left between the search/filter group and
          the controls on the right. `flex:1 1 auto` + `minWidth:0` + `overflow:hidden` means it yields
          that space back first — it shrinks (and the name ellipsises) before any control is squeezed,
          and disappears entirely on a narrow viewport rather than pushing a button off the row. */}
      {activeTab === 3 && effectiveData && (
        <div
          className="hidden xl:flex select-none items-center"
          style={{ gap: 12, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', paddingLeft: 6 }}
        >
          {scenarioItems.map(it => (
            <span key={it.key} style={{ minWidth: 0 }}>
              <ScenarioLabel
                name={it.name}
                color={it.active ? RED : COMPARE_LINE}
                dashed={!it.active}
                title={scenarioTitle(it)}
                maxWidth={comparisonMode ? 110 : 150}
              />
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        {activeTab === 3 && (
          <>
            {/* Conflict summary — same style as the LOCO Workstation summary cards.
                LEFT-click opens the list of the LOCOs behind the number (upwards: the footer is at
                the bottom of the window, the same reason the LOCO search drops up).
                RIGHT-click still opens the session conflict-workstation selection dialog. */}
            <div ref={conflictBoxRef} style={{ position: 'relative', flexShrink: 0 }}>
            <div
              onClick={() => { if (conflictCount > 0) setConflictListOpen(v => !v) }}
              onContextMenu={e => { e.preventDefault(); setConflictListOpen(false); setConflictWsDialogOpen(true) }}
              title={`${conflictCount > 0
                ? `${conflictCount} conflito(s) no Schedule ativo`
                : 'Nenhum conflito no Schedule ativo'}`
                + (conflictWsOverridden ? ` · WS de conflito personalizadas: ${[...conflictWs].join(', ')}` : ' (WS40/WS50)')
                + (conflictCount > 0 ? '\nClique para listar as locomotivas em conflito' : '')
                + '\nClique direito para personalizar as workstations de conflito (sessão)'}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                height: 28, padding: '0 9px', borderRadius: 6,
                border: `1px solid ${conflictCount > 0 ? RED : '#86EFAC'}`,
                background: conflictCount > 0 ? (conflictListOpen ? '#FFE2E2' : '#F0FDFA') : '#F0FDF4',
                whiteSpace: 'nowrap', cursor: conflictCount > 0 ? 'pointer' : 'context-menu',
              }}
            >
              <AlertTriangle size={13} style={{ color: conflictCount > 0 ? RED : '#16A34A', flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: conflictCount > 0 ? RED : '#16A34A' }}>
                {conflictCount} conflito{conflictCount !== 1 ? 's' : ''}
              </span>
              {conflictWsOverridden && (
                <span title="Workstations de conflito personalizadas nesta sessão" style={{ fontSize: 9, fontWeight: 800, color: '#B45309', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '0 4px', lineHeight: '14px' }}>
                  WS*
                </span>
              )}
              {conflictCount > 0 && (
                <ChevronDown size={11} style={{ color: RED, flexShrink: 0, transform: conflictListOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              )}
            </div>
            {conflictListShown && (
              // Upwards, anchored to the button's LEFT edge: the footer sits at the bottom of the
              // window and this button is in its right-hand group, so a downward or right-anchored
              // panel would leave the viewport.
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
                background: '#fff', border: '1px solid #E5E7EB', borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.16)', zIndex: 60,
                minWidth: 300, maxWidth: 400, maxHeight: 320, overflowY: 'auto',
              }}>
                <div style={{
                  position: 'sticky', top: 0, background: '#FFF1F1', borderBottom: '1px solid #CCFBF1',
                  padding: '5px 9px', fontSize: 9.5, fontWeight: 800, color: '#B91C1C',
                  letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                }}>
                  {conflictDetails.length} loco{conflictDetails.length !== 1 ? 's' : ''} em conflito · clique para ir à WS
                </div>
                {conflictDetails.map(d => (
                  <div key={d.key} style={{ borderTop: '1px solid #F5F5F5' }}>
                    {d.ws.map((w, wi) => (
                      <button
                        key={`${d.key}||${w.ws}`}
                        onClick={() => {
                          // BOTH the raw spelling and the subarea, never the normalized WS and never
                          // a blank subarea: the Schedule's row id is
                          // `ws_<linha>_<wo>_<task>_<startMs>_<ws>_<subarea>`, so either substitution
                          // matches no element and the click silently scrolls nowhere.
                          onWsClick(d.wo, d.taskName, w.wsRaw, w.subarea, d.linha, d.startMs)
                          setConflictListOpen(false)
                        }}
                        title={`Ir para ${d.taskName} · ${w.ws} (${w.iso.split('-').reverse().join('/')})`
                          + (w.partners.length ? `\nEm conflito com: ${w.partners.join(', ')}` : '')}
                        style={{
                          all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
                          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px',
                          borderTop: wi === 0 ? undefined : '1px dashed #F1F1F1',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#F0FDFA' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={{
                          fontSize: 9, fontWeight: 800, color: '#fff', background: RED,
                          borderRadius: 4, padding: '1px 5px', flexShrink: 0, lineHeight: '14px',
                        }}>
                          {w.ws}
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {d.taskName}
                            <span style={{ fontWeight: 500, color: '#9CA3AF' }}> · {d.wo}</span>
                          </span>
                          <span style={{ fontSize: 9.5, color: '#9CA3AF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {w.iso.split('-').reverse().join('/')}
                            {w.partners.length ? ` · com ${w.partners.join(', ')}` : ''}
                          </span>
                        </span>
                        <span style={{ fontSize: 10, fontWeight: 800, color: RED, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                          {w.pairs}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            </div>
            <div style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />
            {/* "Detalhe" — the former FULL/WORK/LOCO modes are really THREE STOPS on one ordered
                granularity axis (coarse→fine): LOCO (1 row/LOCO) ▸ WORK (1 row/Workstation) ▸ FULL
                (1 row/Componente). They're a view of the two expand/collapse tiers, so a per-row
                chevron can leave the tree in a hybrid state matching no preset — surfaced as the
                MISTO badge instead of the old "nothing highlighted" ambiguity. Bulk handlers/logic
                are unchanged; this block only reorders coarse→fine and restyles (tinted active pill). */}
            {(() => {
              const levels = [
                { key: 'loco', label: 'LOCO', title: 'Recolher todas as LOCOs (uma linha por LOCO)', active: locoExpandSummary === 'none', onClick: () => onSetAllLocosExpanded(false) },
                { key: 'ws',   label: 'WORK', title: 'Recolher todas as workstations (uma linha por Workstation)', active: locoExpandSummary === 'all' && wsExpandSummary === 'none', onClick: () => onSetAllWsExpanded(false) },
                { key: 'full', label: 'FULL', title: 'Expandir tudo (uma linha por Componente)', active: locoExpandSummary === 'all' && wsExpandSummary === 'all', onClick: () => onSetAllWsExpanded(true) },
              ] as const
              // MISTO = the tree matches none of the three presets (a chevron opened/closed a single row).
              const misto = !levels.some(l => l.active)
              return (
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #D1D5DB', borderRadius: 6, overflow: 'hidden', height: 28 }}>
                    {levels.map(({ key, label, title, active, onClick }, i) => (
                      <button
                        key={key}
                        onClick={onClick}
                        title={title}
                        style={{ height: '100%', padding: '0 9px', fontSize: 11, fontWeight: active ? 700 : 500, background: active ? '#F0FDFA' : '#fff', color: active ? RED : '#6B7280', border: 'none', borderLeft: i > 0 ? '1px solid #D1D5DB' : 'none', cursor: 'pointer', transition: 'background 0.1s, color 0.1s', whiteSpace: 'nowrap' }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Absolutely positioned so appearing/disappearing never shifts the footer row. */}
                  {misto && (
                    <span
                      title="Estado misto: a árvore não corresponde a um preset. Clique LOCO/WORK/FULL para redefinir."
                      style={{ position: 'absolute', top: -7, right: -8, fontSize: 8, fontWeight: 800, letterSpacing: 0.3, color: '#B45309', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '1px 4px', lineHeight: 1, pointerEvents: 'none' }}
                    >
                      MISTO
                    </span>
                  )}
                </div>
              )
            })()}
            {/* Grab/pan tool — available in EVERY mode (Original included): it only scrolls the view,
                it never edits. (Editing = double-click a box → Move Mode, which is blocked in Original.) */}
            <button
              onClick={() => setGanttGrabMode(v => !v)}
              title={ganttGrabMode ? 'Desativar arrastar' : 'Arrastar para mover a visualização (click e segure)'}
              className="flex h-7 w-7 items-center justify-center rounded border transition-colors hover:bg-red-50"
              style={{ borderColor: ganttGrabMode ? RED : '#D1D5DB', color: ganttGrabMode ? RED : '#6B7280', background: ganttGrabMode ? '#F0FDFA' : undefined }}
            >
              <Hand size={14} />
            </button>
            <div style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />
            <button
              onClick={() => {
                if (zoomBusy) return
                setZoomBusy(true)
                setTimeout(() => {
                  setZoom(prev => Math.min(1.5, Math.round((prev + 0.1) * 10) / 10))
                  const t = setTimeout(() => setZoomBusy(false), 3000)
                  const clear = () => { clearTimeout(t); setZoomBusy(false) }
                  onceBuiltRef.current = clear
                }, 0)
              }}
              disabled={zoom >= 1.5 || zoomBusy}
              title="Aumentar zoom"
              className="flex h-7 w-7 items-center justify-center rounded border text-[20px] font-semibold leading-none transition-colors hover:bg-gray-100 disabled:opacity-40"
              style={{ borderColor: RED + 'AA', color: RED }}
            >
              {zoomBusy ? <Loader2 size={13} className="animate-spin" /> : '+'}
            </button>
            <div
              title="Zoom (%)"
              style={{
                display: 'flex', alignItems: 'center',
                height: 28, borderRadius: 5,
                border: `1px solid ${zoomFocused ? RED : RED + 'AA'}`,
                background: '#fff', overflow: 'hidden',
                opacity: zoomBusy ? 0.4 : 1,
              }}
            >
              <input
                type="number"
                min={50}
                max={150}
                step={10}
                value={zoomFocused ? zoomInput : Math.round(zoom * 100)}
                onFocus={() => { setZoomFocused(true); setZoomInput(String(Math.round(zoom * 100))) }}
                onBlur={() => { setZoomFocused(false); applyZoomInput(zoomInput) }}
                onChange={e => setZoomInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() } }}
                disabled={zoomBusy}
                className="zoom-input"
                style={{
                  width: 30, height: '100%', textAlign: 'right', fontSize: 11, fontWeight: 600,
                  border: 'none', color: RED, background: 'transparent',
                  outline: 'none', padding: '0 0 0 4px',
                  appearance: 'textfield',
                }}
              />
              <span style={{ fontSize: 11, fontWeight: 600, color: RED, paddingRight: 5, userSelect: 'none' }}>%</span>
            </div>
            <button
              onClick={() => {
                if (zoomBusy) return
                setZoomBusy(true)
                setTimeout(() => {
                  setZoom(prev => Math.max(0.5, Math.round((prev - 0.1) * 10) / 10))
                  const t = setTimeout(() => setZoomBusy(false), 3000)
                  const clear = () => { clearTimeout(t); setZoomBusy(false) }
                  onceBuiltRef.current = clear
                }, 0)
              }}
              disabled={zoom <= 0.5 || zoomBusy}
              title="Diminuir zoom"
              className="flex h-7 w-7 items-center justify-center rounded border text-[20px] font-semibold leading-none transition-colors hover:bg-gray-100 disabled:opacity-40"
              style={{ borderColor: RED + 'AA', color: RED }}
            >
              {zoomBusy ? <Loader2 size={13} className="animate-spin" /> : '-'}
            </button>
            <div style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />
            {/* Optimizer — Editor+ only. Readers get the read-only lane (load / compare /
                temporary edits); the solver is excluded from it, and the backend rejects
                /api/gantt/optimize-conflicts for them. Hiding the button keeps the UI from
                offering an action that can only end in a 403. */}
            {canOptimize && !readOnly && (
            <button
              onClick={() => setShowOtimizarMenu(true)}
              onMouseEnter={() => setOtimizarHovered(true)}
              onMouseLeave={() => setOtimizarHovered(false)}
              title={optLoading ? 'Otimizando… (clique para ver progresso)' : 'Otimizar workstations conflitantes'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, padding: 0,
                border: `1px solid ${optLoading ? PURPLE : activeOptMode !== null ? PURPLE : otimizarHovered ? PURPLE : '#D1D5DB'}`,
                borderRadius: 7,
                background: optLoading ? PURPLE : activeOptMode !== null ? PURPLE : otimizarHovered ? '#F3E5F5' : '#fff',
                color: optLoading ? '#fff' : activeOptMode !== null ? '#fff' : otimizarHovered ? PURPLE : '#6B7280',
                cursor: 'pointer', flexShrink: 0,
                transition: 'border-color .15s, background .15s, color .15s',
              }}
            >
              {optLoading ? <Loader2 size={15} className="animate-spin" /> : <Zap size={16} />}
            </button>
            )}
            {/* The Kits launcher used to sit here. Kits planning is no longer a window of its own:
                both of its surfaces live in the Build Plan window (Logs de Consumo tab, and the
                Kits Schedule view of the Build Schedule tab), so a second entry point would open a
                duplicate of screens that already have a home. */}
          </>
        )}
        {/* Trocar Cenário — comparison mode only. Same icon-only square style as the
            Otimizar/Kits action buttons; toggles Base ↔ Target instantly. */}
        {comparisonMode && (
          <button
            onClick={() => onComparisonSwitch?.()}
            onMouseEnter={() => setSwitchHovered(true)}
            onMouseLeave={() => setSwitchHovered(false)}
            title={`Trocar Cenário (ativo: ${comparisonActive === 'base' ? 'Base' : 'Target'})`}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, padding: 0,
              border: `1px solid ${switchHovered ? RED : '#D1D5DB'}`,
              borderRadius: 7,
              background: switchHovered ? '#F0FDFA' : '#fff',
              color: switchHovered ? RED : '#6B7280',
              cursor: 'pointer', flexShrink: 0,
              transition: 'border-color .15s, background .15s, color .15s',
            }}
          >
            <ArrowRightLeft size={16} />
          </button>
        )}
        {/* "Unir locos" — Resumo Geral only. Icon-only square in the same 30×30 idiom as the
            arrows toggle it sits left of: both are view switches for this tab, so they read as a
            pair. One serial planned under two Tipos (MX1022 + B3#MX1022) counts once, under
            the Tipo with the most total hours. */}
        {activeTab === 0 && (
          <button
            onClick={() => setMergeLocoTypes(!mergeLocos)}
            onMouseEnter={() => setMergeHovered(true)}
            onMouseLeave={() => setMergeHovered(false)}
            aria-pressed={mergeLocos}
            // Same brevity as "Ocultar setas de comparação": name the action, nothing else.
            title={mergeLocos ? 'Separar locos duplicadas' : 'Unir locos duplicadas'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, padding: 0,
              border: `1px solid ${mergeLocos || mergeHovered ? RED : '#D1D5DB'}`,
              borderRadius: 7,
              background: mergeLocos || mergeHovered ? '#F0FDFA' : '#fff',
              color: mergeLocos || mergeHovered ? RED : '#6B7280',
              cursor: 'pointer', flexShrink: 0,
              transition: 'border-color .15s, background .15s, color .15s',
            }}
          >
            <Link2 size={16} />
          </button>
        )}
        {/* Show/Hide comparison arrows — shown whenever a comparison is active (scenario-compare OR
            the single-scenario mode-reference deviation). UI-only: never affects calculations or
            exports. Default ON (visible). */}
        {activeTab === 0 && compareArrowsAvailable && onToggleCompareArrows && (
          <button
            onClick={() => onToggleCompareArrows()}
            onMouseEnter={() => setArrowsHovered(true)}
            onMouseLeave={() => setArrowsHovered(false)}
            title={showCompareArrows ? 'Ocultar setas de comparação' : 'Mostrar setas de comparação'}
            aria-pressed={showCompareArrows}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, padding: 0,
              border: `1px solid ${showCompareArrows ? RED : arrowsHovered ? RED : '#D1D5DB'}`,
              borderRadius: 7,
              background: showCompareArrows ? '#F0FDFA' : arrowsHovered ? '#F0FDFA' : '#fff',
              color: showCompareArrows ? RED : arrowsHovered ? RED : '#6B7280',
              cursor: 'pointer', flexShrink: 0,
              transition: 'border-color .15s, background .15s, color .15s',
            }}
          >
            {showCompareArrows ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        )}
        {activeTab === 0 ? (
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu(v => !v)}
              disabled={exporting || !summaryTestData}
              title="Exportar Resumo Geral para Excel"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border font-medium transition-colors hover:bg-gray-100 disabled:opacity-40"
              style={{ borderColor: RED + 'AA', color: RED }}
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Exportar
              <ChevronDown size={11} style={{ marginLeft: 1, transform: showExportMenu ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
            </button>
            {showExportMenu && (
              <div className="absolute right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden min-w-[110px]">
                {/* Options mirror the active Summary hierarchy:
                    Área mode → Área / Subárea / Itens; Loco mode → Tipo / Modelo / Loco. */}
                {(summaryRowMode === 'locos'
                  ? ([
                      { key: 'tipo',   label: 'Tipo' },
                      { key: 'modelo', label: 'Modelo' },
                      { key: 'loco',   label: 'Loco' },
                    ] as const)
                  : ([
                      { key: 'area',    label: 'Área' },
                      { key: 'subarea', label: 'Subárea' },
                      { key: 'itens',   label: 'Itens' },
                    ] as const)
                ).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => { handleExportSummary(opt.key); setShowExportMenu(() => false) }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 transition-colors"
                    style={{ color: RED }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <button
          onClick={() => { if (!optLoading) onClose() }}
          disabled={optLoading}
          title={optLoading ? 'Otimização em andamento…' : undefined}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-white rounded font-medium transition-colors hover:bg-[#0F766E] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: RED }}
        >
          Fechar
        </button>
      </div>
    </div>
    </>
  )
}
