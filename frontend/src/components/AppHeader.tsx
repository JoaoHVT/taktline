/**
 * AppHeader -- replicates the MainWindow toolbar from CapB3356103.py
 *
 * Layout:
 *   LEFT:  [Adicionar] [Simular] [Otimizar] | [Cliente] [Família] [Tipo] [Limpar]
 *   RIGHT: [SearchBox] | [Headcount dropdown] [Modo dropdown] | [Resetar] [Excel] [Salvar] | [logo]
 *
 * Uses WorkspaceContext so filter/mode state is shared with the main content area.
 */
'use client'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import Image from 'next/image'
import { CheckSquare, Square, X, Search, LogOut, ChevronUp, ChevronDown as ChevronDownIcon, ChevronLeft, ChevronRight, SlidersHorizontal, RotateCcw, Save, FileSpreadsheet, Database, Zap, Trash2, Package2, CalendarDays, Boxes, Layers, LayoutGrid, Factory } from 'lucide-react'
import { ImportModal }    from '@/components/ImportModal'
import { AddItemModal }   from '@/components/AddItemModal'
import { ConfirmDialog }  from '@/components/ConfirmDialog'
import { OptimizeModal }              from '@/components/OptimizeModal'
import type { OptimizationParams }    from '@/components/OptimizeModal'
import { OptimizationResultsModal }  from '@/components/OptimizationResultsModal'
import type { WsnResultRow }          from '@/components/OptimizationResultsModal'
import { SolverLogModal }             from '@/components/SolverLogModal'
import { useBackendHealth } from '@/hooks/useBackendHealth'
import { useOptimization } from '@/hooks/useOptimization'
import { useWorkspace }   from '@/context/WorkspaceContext'
import type { ImportMeta } from '@/context/WorkspaceContext'
import type { ImportItem, OptimizationResult, PersonResultRow } from '@/lib/api'
import { getWsnPeople, getPeriodDays } from '@/lib/api'
import { SaveLoadModal }         from '@/components/SaveLoadModal'
import { encryptSession, readSessionFile } from '@/lib/sessionCrypto'
import { ExcelModal }            from '@/components/ExcelModal'
import { DbDatasetModal }        from '@/components/DbDatasetModal'
import { ImportProgressFloat }   from '@/components/ImportProgressFloat'
import { GanttModal, GanttLaunchModal } from '@/components/GanttModal'
import { AppErrorBoundary }       from '@/components/AppErrorBoundary'
import { FilterBox } from '@/components/gantt/FilterBox'
import { MONTH_NAMES_PT, quarterLabel, windowGanttData } from '@/lib/ganttUtils'
import { SCHEDULE_TIPO_KEYS, DEFAULT_TIPO_KEY, TIPO_LABEL, anyScheduleBacked } from '@/lib/tipos'
import { makeFactoryLoadLoader, factoryLoadScope } from '@/lib/factoryLoadImport'
import type { DbKey } from '@/context/ImportJobsContext'
import type { GanttData, TransactedHoursScope } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Reveal } from '@/hooks/useReveal'
import { getScheduleEnabled, setScheduleEnabled as persistScheduleEnabled, getLastGanttTab, setLastGanttTab as persistLastGanttTab } from '@/lib/ganttPrefs'
import { loadOverrides, getActiveScenario, seedOverridesFromSession, type LocoOverrideMap } from '@/lib/locoOverrides'
import { useGanttInlineMaybe } from '@/context/GanttInlineContext'
import { useFactoryLoadShare, useFactoryLoadPublisherId } from '@/context/FactoryLoadShareContext'
import { APP_NAMES } from '@/lib/appNames'
import { usePermissions } from '@/context/PermissionsContext'
import { ManageUsersModal } from '@/components/ManageUsersModal'
import { ManageCalendarModal } from '@/components/ManageCalendarModal'
import { ServerControlModal } from '@/components/ServerControlModal'
import { ChangePasswordModal } from '@/components/ChangePasswordModal'
import { ManageHeadcountModal } from '@/components/ManageHeadcountModal'
import { AdminAlertsBell } from '@/components/AdminAlertsBell'
import { OnlineUsersBadge } from '@/components/OnlineUsersBadge'
import { ContextMenu, type CtxMenuItem } from '@/components/OptimizationResultsModal/ContextMenu'
import { Users, Plus, Clock, ClipboardList, Power, KeyRound } from 'lucide-react'
import { TransactedHoursModal } from '@/components/TransactedHoursModal'
import { PlanoServicosGcrModal } from '@/components/PlanoServicosGcrModal'

// ── Session serialization helpers ────────────────────────────────────────────
// Sets aren't JSON-serializable, so filters/override sets round-trip through arrays.
const setToArr = (s: Set<string> | null | undefined): string[] => (s ? [...s] : [])
const arrToSet = (a: unknown): Set<string> => new Set(Array.isArray(a) ? (a as string[]) : [])

// The Carga de Fábrica (Gantt) slice of an exported session — everything the Factory
// Load view needs to reconstruct itself: the loaded datasets, comparison config, the
// window/filter selection, the active tab, and the live LOCO/WS/Componente edits.
interface GanttSessionSection {
  cache?:             GanttData | null
  scenarioData?:      GanttData | null
  scenarioName?:      string
  compareBase?:       GanttData | null
  compareBaseName?:   string
  compareTarget?:     GanttData | null
  compareTargetName?: string
  compareMode?:       boolean
  compareActive?:     'base' | 'target'
  dateRange?:         { from?: string; to?: string } | null
  lineFilter?:        string[] | null
  selLineTypes?:      string[]
  lastDateFrom?:      string
  lastDateTo?:        string
  openedOnce?:        boolean
  lastTab?:           0 | 1 | 2 | 3
  scheduleEnabled?:   boolean
  overridesScenario?: string
  overrides?:         LocoOverrideMap
}

// Factory Load line-type keys (Tipo filter) — all selected ⇒ no filter active.
// SCHEDULE-backed Tipos only: this filter narrows a Schedule dataset, and a Tipo with no
// Schedule behind it would both contribute nothing and inflate the "all selected" count that
// decides whether the filter is active at all.
const GANTT_ALL_LINE_TYPES = SCHEDULE_TIPO_KEYS

/** Stable fallback for the no-provider case — a literal here would be a new object on
 *  every render and would re-fire the modal's effects. */
const EMPTY_LOCO_SCOPE: TransactedHoursScope = { locos: [] }
const GANTT_LINE_TYPE_LABELS: Record<string, string> = TIPO_LABEL

// ── ToolBtn ───────────────────────────────────────────────────────────────────

function ToolBtn({
  img, label, tooltip, size = 32, onClick, active = false, disabled = false, wave = false,
}: {
  img:       string
  label:     string
  tooltip:   string
  size?:     number
  onClick?:  () => void
  active?:   boolean
  disabled?: boolean
  wave?:     boolean
}) {
  const imgPx = size <= 32 ? 18 : 24
  const h     = size <= 32 ? 40 : 48
  return (
    <button
      type="button"
      title={tooltip}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-0.5 px-2 py-0.5 rounded transition-colors
        ${disabled
          ? 'opacity-35 cursor-not-allowed'
          : active
            ? 'bg-[#D32F2F] hover:bg-[#B71C1C]'
            : `hover:bg-gray-200 active:bg-gray-300 ${wave ? 'simular-wave-btn' : ''}`}
      `}
      style={{ height: h, minWidth: 40 }}
    >
      <Image src={img} alt={label} width={imgPx} height={imgPx} className={`object-contain${wave ? ' simular-wave-icon' : ''}`} />
      <span className={`text-[9px] font-medium leading-none whitespace-nowrap ${
        active ? 'text-white'
        : wave  ? 'simular-wave-label'
        : 'text-gray-700'
      }`}>
        {label}
      </span>
    </button>
  )
}

function Sep() {
  return <div className="w-px h-8 bg-gray-400 mx-1 shrink-0" />
}

// ── ActionBtn: primary action buttons (Adicionar, Simular, Otimizar) ─────────

function ActionBtn({
  icon, label, tooltip, onClick, active = false, disabled = false, wave = false,
}: {
  icon:      ReactNode
  label:     string
  tooltip:   string
  onClick?:  () => void
  active?:   boolean
  disabled?: boolean
  wave?:     boolean
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-0.5 px-2.5 py-1 rounded transition-colors
        ${disabled
          ? 'opacity-35 cursor-not-allowed'
          : active
            ? 'bg-[#D32F2F] hover:bg-[#B71C1C]'
            : `hover:bg-gray-200 active:bg-gray-300 ${wave ? 'simular-wave-btn' : ''}`}
      `}
      style={{ height: 48, minWidth: 52 }}
    >
      <span className={`${active ? 'text-white' : wave ? 'simular-wave-icon' : 'text-gray-600'}`}>
        {icon}
      </span>
      <span className={`text-[9px] font-medium leading-none whitespace-nowrap ${
        active ? 'text-white' : wave ? 'simular-wave-label' : 'text-gray-600'
      }`}>
        {label}
      </span>
    </button>
  )
}

// ── NavBtn: navigation/utility buttons (Resetar, Salvar, Excel, Gantt, Período) ──

function NavBtn({
  icon, label, tooltip, onClick, active = false, disabled = false, tone = 'neutral', className = '',
}: {
  icon:      ReactNode
  label:     string
  tooltip:   string
  onClick?:  () => void
  active?:   boolean
  disabled?: boolean
  tone?:     'neutral' | 'red' | 'green' | 'amber'
  /** Extra classes on the button — the hook motion styles hang off (see .loco-btn). */
  className?: string
}) {
  const toneClass = tone === 'red'
    ? 'hover:bg-red-50 hover:text-[#C62828]'
    : tone === 'green'
      ? 'hover:bg-green-50 hover:text-[#2E7D32]'
      : tone === 'amber'
        ? 'hover:bg-amber-50 hover:text-[#D97706]'
        : 'hover:bg-gray-200 active:bg-gray-300'

  return (
    <button
      type="button"
      title={tooltip}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-0.5 px-2 py-0.5 rounded transition-colors
        ${disabled
          ? 'opacity-35 cursor-not-allowed'
          : active
            ? 'bg-[#D32F2F] hover:bg-[#B71C1C]'
            : toneClass
        } ${className}`}
      style={{ height: 40, minWidth: 40 }}
    >
      <span className={active ? 'text-white' : 'text-gray-600'}>{icon}</span>
      <span className={`text-[9px] font-medium leading-none whitespace-nowrap ${active ? 'text-white' : 'text-gray-600'}`}>
        {label}
      </span>
    </button>
  )
}

/**
 * Half-locomotive — the app-switch mark.
 *
 * Deliberately cropped by the far edge of the viewBox: lamp and nose are drawn, the body and
 * roof run off-frame. The half you cannot see is the app you are not in. Stroked (not filled)
 * at the same weight as the Home glyph beside it so the pair reads as one set.
 *
 * `facing` must match the direction the page slides on press, so the loco leads the motion
 * instead of fighting it. Mirrored inside the SVG (not on the element) to leave the element's
 * own transform free for the hover/press motion in globals.css.
 */
function HalfLocoIcon({ size = 18, facing = 'left' }: { size?: number; facing?: 'left' | 'right' }) {
  return (
    <svg
      className="loco-icon"
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <g transform={facing === 'right' ? 'translate(24 0) scale(-1 1)' : undefined}>
        {/* hood → cab → roof leaving the frame */}
        <path d="M2.5 16.5v-5a2 2 0 0 1 2-2H9l2.6-4.2H23" />
        {/* underframe */}
        <path d="M2.5 16.5H23" />
        {/* cab pillar + window sill */}
        <path d="M13.6 5.3v4.2H23" />
        {/* headlight slot at the nose */}
        <path d="M2.5 13h3.4" />
        <circle cx="7" cy="19" r="1.7" />
        <circle cx="16" cy="19" r="1.7" />
      </g>
    </svg>
  )
}

// ── FilterDropdown: multi-select inline list (Cliente, Família) ───────────────

interface FilterDropdownProps {
  label:       string
  options:     string[]
  selected:    Set<string>
  onChange:    (next: Set<string>) => void
  img:         string
  emptyMsg?:   string
  /** When true, shows the GCM / GCR group-select buttons. See `clientOrg`. */
  gcmGcr?:     boolean
  /** When true, renders a compact text-only trigger (for use inside filter panel) */
  panelMode?:  boolean
}

/**
 * Which organisation a CLIENTE option belongs to.
 *
 * The list holds two kinds of value. Monthly-plan clients are client codes, split by the
 * long-standing convention that GCM's are short (up to four letters) and everyone else's are
 * not — a heuristic, but the only signal that data carries. Carga de Fábrica items instead
 * STATE their org, because it is derived from the Tipo (see `lib/factoryLoadImport`), so the
 * literal values are matched first: `'GCR'` is three characters and the length rule alone would
 * file it under GCM, which is the exact opposite of what it says.
 */
function clientOrg(option: string): 'gcm' | 'gcr' {
  const v = option.trim()
  const up = v.toUpperCase()
  if (up === 'GCM') return 'gcm'
  if (up === 'GCR') return 'gcr'
  return v.length <= 4 ? 'gcm' : 'gcr'
}

function FilterDropdown({ label, options, selected, onChange, img, emptyMsg, gcmGcr, panelMode }: FilterDropdownProps) {
  const [open,        setOpen]        = useState(false)
  const [activeGroup, setActiveGroup] = useState<'gcm' | 'gcr' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const isActive = selected.size > 0 && selected.size < options.length

  // Auto-clean stale selections when options change (cross-filter effect):
  // when the family filter restricts available clients, deselect clients no longer available.
  useEffect(() => {
    if (selected.size === 0) return
    const optSet = new Set(options)
    const hasStale = [...selected].some(s => !optSet.has(s))
    if (hasStale) onChange(new Set([...selected].filter(s => optSet.has(s))))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keep activeGroup in sync: if selection no longer matches the group, clear it
  useEffect(() => {
    if (!gcmGcr || activeGroup === null) return
    const expected = new Set(options.filter(o => clientOrg(o) === activeGroup))
    const matches = expected.size === selected.size && [...expected].every(o => selected.has(o))
    if (!matches) setActiveGroup(null)
  }, [selected, options, activeGroup, gcmGcr])

  const gcmOptions = gcmGcr ? options.filter(o => clientOrg(o) === 'gcm') : []
  const gcrOptions = gcmGcr ? options.filter(o => clientOrg(o) === 'gcr') : []

  const allSelected = options.length > 0 && options.every(o => selected.has(o))
  const toggleOne   = (opt: string) => {
    const next = new Set(selected)
    if (next.has(opt)) next.delete(opt); else next.add(opt)
    onChange(next)
    if (gcmGcr) setActiveGroup(null)
  }
  const toggleAll = () => {
    onChange(allSelected ? new Set() : new Set(options))
    if (gcmGcr) setActiveGroup(null)
  }

  const handleGroupClick = (group: 'gcm' | 'gcr') => {
    if (activeGroup === group) {
      setActiveGroup(null)
      onChange(new Set())
    } else {
      setActiveGroup(group)
      onChange(new Set(options.filter(o => clientOrg(o) === group)))
    }
  }

  const tooltipText = !isActive
    ? `${label}: Todos`
    : `${label}: ${[...selected].sort().join(', ')}`

  const selectedCountLabel = `${selected.size} selecionado${selected.size === 1 ? '' : 's'}`

  return (
    <div className="relative" ref={ref}>
      {panelMode ? (
        <button
          type="button"
          title={tooltipText}
          onClick={() => options.length > 0 && setOpen(v => !v)}
          className={`flex items-center justify-between gap-2 min-w-[130px] px-2.5 py-1.5 rounded border text-xs transition-colors ${
            isActive
              ? 'border-[#D32F2F] bg-[#D32F2F]/5 text-[#B71C1C] font-semibold'
              : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          <span className="truncate max-w-[90px]">
            {isActive ? selectedCountLabel : 'Todos'}
          </span>
          <ChevronDownIcon size={11} className="text-gray-400 shrink-0" />
        </button>
      ) : (
        <ToolBtn
          img={img}
          label={label}
          tooltip={tooltipText}
          size={32}
          active={isActive}
          onClick={() => options.length > 0 && setOpen(v => !v)}
        />
      )}
      {open && (
        <div className="absolute top-full left-0 mt-0.5 z-50 bg-white border border-gray-300 rounded shadow-xl min-w-[180px] max-h-64 overflow-y-auto">
          <div className="px-2.5 py-1.5 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 hover:bg-gray-100">
              <X size={11} className="text-gray-400" />
            </button>
          </div>
          {options.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-400">{emptyMsg ?? 'Sem opções disponíveis'}</div>
          ) : (
            <>
              {/* GCM / GCR group toggles (Cliente filter) */}
              {gcmGcr && (gcmOptions.length > 0 || gcrOptions.length > 0) && (
                <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-gray-100">
                  {gcmOptions.length > 0 && (
                    <button
                      onClick={() => handleGroupClick('gcm')}
                      title={`GCM — itens GCM e clientes com até 4 letras (${gcmOptions.length})`}
                      className="flex-1 py-0.5 rounded text-[10px] font-bold border transition-colors"
                      style={activeGroup === 'gcm'
                        ? { backgroundColor: '#D32F2F', color: 'white', borderColor: '#D32F2F' }
                        : { backgroundColor: 'white',   color: '#D32F2F', borderColor: '#D32F2F' }}
                    >GCM</button>
                  )}
                  {gcrOptions.length > 0 && (
                    <button
                      onClick={() => handleGroupClick('gcr')}
                      title={`GCR — demais clientes (${gcrOptions.length})`}
                      className="flex-1 py-0.5 rounded text-[10px] font-bold border transition-colors"
                      style={activeGroup === 'gcr'
                        ? { backgroundColor: '#D32F2F', color: 'white', borderColor: '#D32F2F' }
                        : { backgroundColor: 'white',   color: '#D32F2F', borderColor: '#D32F2F' }}
                    >GCR</button>
                  )}
                </div>
              )}
              <div
                className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs font-medium text-black"
                onClick={toggleAll}
              >
                {allSelected
                  ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
                  : <Square      size={12} className="text-gray-400 shrink-0" />}
                {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
              </div>
              {options.map(opt => (
                <div
                  key={opt}
                  className="px-2.5 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs text-black"
                  onClick={() => toggleOne(opt)}
                >
                  {selected.has(opt)
                    ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
                    : <Square      size={12} className="text-gray-400 shrink-0" />}
                  <span className="truncate">{opt}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── TipoDropdown: multi-select checkbox list ──────────────────────────────────────

function TipoDropdown({ options, selected, onChange, panelMode }: {
  options:    string[]
  selected:   Set<string>
  onChange:   (s: Set<string>) => void
  panelMode?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isActive = selected.size > 0 && selected.size < options.length

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const allSelected = options.length > 0 && options.every(o => selected.has(o.toUpperCase()))
  const tooltipText = selected.size === 0 || allSelected
    ? 'Tipo FW: Todos'
    : `Tipo FW: ${[...selected].sort().join(', ')}`

  const selectedCountLabel = `${selected.size} selecionado${selected.size === 1 ? '' : 's'}`

  const toggleOne = (opt: string) => {
    const key  = opt.toUpperCase()
    const next = new Set(selected)
    if (next.has(key)) next.delete(key); else next.add(key)
    onChange(next)
  }
  const toggleAll = () => onChange(allSelected ? new Set() : new Set(options.map(o => o.toUpperCase())))

  return (
    <div className="relative" ref={ref}>
      {panelMode ? (
        <button
          type="button"
          title={tooltipText}
          onClick={() => options.length > 0 && setOpen(v => !v)}
          className={`flex items-center justify-between gap-2 min-w-[130px] px-2.5 py-1.5 rounded border text-xs transition-colors ${
            isActive
              ? 'border-[#D32F2F] bg-[#D32F2F]/5 text-[#B71C1C] font-semibold'
              : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          <span className="truncate max-w-[90px]">
            {isActive ? selectedCountLabel : 'Todos'}
          </span>
          <ChevronDownIcon size={11} className="text-gray-400 shrink-0" />
        </button>
      ) : (
        <ToolBtn
          img="/imagens/setin.png"
          label="Tipo"
          tooltip={tooltipText}
          size={32}
          active={isActive}
          onClick={() => options.length > 0 && setOpen(v => !v)}
        />
      )}
      {open && (
        <div className="absolute top-full left-0 mt-0.5 z-50 bg-white border border-gray-300 rounded shadow-xl min-w-[160px] max-h-64 overflow-y-auto">
          <div className="px-2.5 py-1.5 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Tipo FW</span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 hover:bg-gray-100">
              <X size={11} className="text-gray-400" />
            </button>
          </div>
          <div
            className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs font-medium text-black"
            onClick={toggleAll}
          >
            {allSelected
              ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
              : <Square      size={12} className="text-gray-400 shrink-0" />}
            {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
          </div>
          {options.map(v => {
            const key   = v.toUpperCase()
            const isSel = selected.has(key)
            return (
              <div
                key={v}
                className="px-2.5 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs text-black"
                onClick={() => toggleOne(v)}
              >
                {isSel
                  ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
                  : <Square      size={12} className="text-gray-400 shrink-0" />}
                {v}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── WsnDropdown: multi-select workstation list with bottleneck highlight ─────

function WsnDropdown({ options, selected, onChange, bottleneckWsns, panelMode }: {
  options:         { wsn: string; description: string }[]
  selected:        Set<string>
  onChange:        (s: Set<string>) => void
  bottleneckWsns?: Set<string>
  panelMode?:      boolean
}) {
  const [open, setOpen] = useState(false)
  const [activeGargalos, setActiveGargalos] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isActive = selected.size > 0 && selected.size < options.length

  const bottleneckOptions = bottleneckWsns && bottleneckWsns.size > 0
    ? options.filter(o => bottleneckWsns.has(o.wsn))
    : []

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const allSelected = options.length > 0 && options.every(o => selected.has(o.wsn))
  const tooltipText = selected.size === 0 || allSelected
    ? 'Station: Todas'
    : `Station: ${[...selected].sort().join(', ')}`

  const selectedCountLabel = `${selected.size} selecionada${selected.size === 1 ? '' : 's'}`

  // Keep activeGargalos in sync: clear if selection no longer matches the bottleneck set
  useEffect(() => {
    if (!activeGargalos || bottleneckOptions.length === 0) return
    const matches = bottleneckOptions.length === selected.size && bottleneckOptions.every(o => selected.has(o.wsn))
    if (!matches) setActiveGargalos(false)
  }, [selected, bottleneckOptions, activeGargalos])

  const toggleOne = (opt: string) => {
    const next = new Set(selected)
    if (next.has(opt)) next.delete(opt); else next.add(opt)
    onChange(next)
  }
  const toggleAll = () => onChange(allSelected ? new Set() : new Set(options.map(o => o.wsn)))

  const handleGargalosClick = () => {
    if (activeGargalos) {
      setActiveGargalos(false)
      onChange(new Set())
    } else {
      setActiveGargalos(true)
      onChange(new Set(bottleneckOptions.map(o => o.wsn)))
    }
  }

  return (
    <div className="relative" ref={ref}>
      {panelMode ? (
        <button
          type="button"
          title={tooltipText}
          onClick={() => options.length > 0 && setOpen(v => !v)}
          className={`flex items-center justify-between gap-2 min-w-[130px] px-2.5 py-1.5 rounded border text-xs transition-colors ${
            isActive
              ? 'border-[#D32F2F] bg-[#D32F2F]/5 text-[#B71C1C] font-semibold'
              : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          <span className="truncate max-w-[90px]">
            {isActive ? selectedCountLabel : 'Todos'}
          </span>
          <ChevronDownIcon size={11} className="text-gray-400 shrink-0" />
        </button>
      ) : (
        <button
          type="button"
          title={tooltipText}
          onClick={() => options.length > 0 && setOpen(v => !v)}
          className={`flex flex-col items-center justify-center gap-0.5 px-2 py-0.5 rounded transition-colors ${
            isActive ? 'bg-[#D32F2F] hover:bg-[#B71C1C]' : 'hover:bg-gray-200 active:bg-gray-300'
          }`}
          style={{ height: 40, minWidth: 40 }}
        >
          <Image src="/imagens/team.png" alt="Station" width={18} height={18} className="object-contain" />
          <span className={`text-[9px] font-medium leading-none whitespace-nowrap ${isActive ? 'text-white' : 'text-gray-700'}`}>
            Station
          </span>
        </button>
      )}
      {open && (
        <div className="absolute top-full left-0 mt-0.5 z-50 bg-white border border-gray-300 rounded shadow-xl min-w-[230px] max-h-72 overflow-y-auto">
          <div className="px-2.5 py-1.5 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Station</span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 hover:bg-gray-100">
              <X size={11} className="text-gray-400" />
            </button>
          </div>
          {options.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-400">Nenhuma workstation disponível</div>
          ) : (
            <>
              {bottleneckOptions.length > 0 && (
                <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-gray-100">
                  <button
                    onClick={handleGargalosClick}
                    title={`Gargalos — workstations com gargalo (${bottleneckOptions.length})`}
                    className="flex-1 py-0.5 rounded text-[10px] font-bold border transition-colors"
                    style={activeGargalos
                      ? { backgroundColor: '#D32F2F', color: 'white', borderColor: '#D32F2F' }
                      : { backgroundColor: 'white',   color: '#D32F2F', borderColor: '#D32F2F' }}
                  >Gargalos</button>
                </div>
              )}
              <div
                className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs font-medium text-black"
                onClick={toggleAll}
              >
                {allSelected
                  ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
                  : <Square      size={12} className="text-gray-400 shrink-0" />}
                {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
              </div>
              {options.map(opt => {
                const isSel = selected.has(opt.wsn)
                const isBottleneck = bottleneckWsns?.has(opt.wsn)
                return (
                  <div
                    key={opt.wsn}
                    className="px-2.5 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-gray-50 text-xs text-black"
                    onClick={() => toggleOne(opt.wsn)}
                  >
                    {isSel
                      ? <CheckSquare size={12} className="text-[#D32F2F] shrink-0" />
                      : <Square      size={12} className="text-gray-400 shrink-0" />}
                    <div className="min-w-0 flex flex-col">
                      <span className="truncate inline-flex items-center gap-1" title={isBottleneck ? 'WSN gargalo após otimização' : undefined}>
                        <span className={isBottleneck ? 'font-semibold text-[#C62828] modo-wave-label' : ''}>{opt.wsn}</span>
                        {isBottleneck && (
                          <img src="/imagens/warning.png" alt="Gargalo" style={{ width: 11, height: 11, opacity: 0.85 }} />
                        )}
                      </span>
                      {opt.description && (
                        <span className="truncate text-[10px] text-gray-500 leading-tight">
                          {opt.description}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── SearchBox: autocomplete search over loaded items ──────────────────────────

function SearchBox({ items, onSelect, disabled = false }: {
  items:    ImportItem[]
  onSelect: (code: string) => void
  /** True while the item details are still loading — the box is unusable until then. */
  disabled?: boolean
}) {
  const [query,       setQuery]       = useState('')
  const [suggestions, setSuggestions] = useState<ImportItem[]>([])
  const [open,        setOpen]        = useState(false)
  const [flashDone,   setFlashDone]   = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Auto-clear when all items are removed, and while loading — in both cases there is
  // nothing left to match against, so any in-flight query/dropdown must go.
  useEffect(() => {
    if (items.length === 0 || disabled) {
      setQuery('')
      setSuggestions([])
      setOpen(false)
      setFlashDone(false)
    }
  }, [items.length, disabled])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    setFlashDone(false)
    if (!q.trim()) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const qn = normalize(q)
    const matches = items
      .filter(it =>
        normalize(it.item).includes(qn) ||
        normalize(it.descricao).includes(qn)
      )
      .slice(0, 12)
    setSuggestions(matches)
    setOpen(matches.length > 0)
  }, [items])

  const pick = (it: ImportItem) => {
    const desc = it.source === 'adicionar'
      ? `${it.descricao ? it.descricao + ' ' : ''}(manual)`
      : it.descricao
    setQuery(`${it.item} — ${desc}`)
    setOpen(false)
    setFlashDone(true)
    onSelect(it.id)
    // clear flash indicator after 2s
    setTimeout(() => setFlashDone(false), 2000)
  }

  const clear = () => {
    setQuery('')
    setSuggestions([])
    setOpen(false)
    setFlashDone(false)
  }

  return (
    <div className="relative" ref={ref}>
      <div
        className={`flex items-center border rounded transition-all ${
          disabled
            ? 'border-gray-200 bg-gray-100 cursor-not-allowed'
            : flashDone
              ? 'border-green-500 ring-1 ring-green-400 bg-green-50'
              : 'border-gray-300 bg-white focus-within:ring-1 focus-within:ring-blue-400'
        }`}
        title={disabled ? 'Carregando dados... aguarde' : undefined}
      >
        <Search size={12} className={`ml-2 shrink-0 ${disabled ? 'text-gray-300' : flashDone ? 'text-green-600' : 'text-gray-400'}`} />
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          disabled={disabled}
          placeholder={disabled ? 'Carregando dados...' : 'Pesquisar item ou descrição...'}
          className={`w-[270px] xl:w-[335px] px-1.5 py-1 text-xs bg-transparent focus:outline-none ${
            disabled
              ? 'text-gray-400 placeholder-gray-400 cursor-not-allowed'
              : 'text-gray-900 placeholder-gray-400'
          }`}
        />
        {/* Fixed-width right zone: clear btn + found indicator — same width always to prevent resize */}
        <div className="w-[72px] flex items-center justify-end pr-1 shrink-0">
          {flashDone && (
            <span className="text-[9px] text-green-600 font-semibold whitespace-nowrap">✓ encontrado</span>
          )}
          {query && !flashDone && (
            <button onClick={clear} className="p-0.5 rounded hover:bg-gray-100">
              <X size={10} className="text-gray-400" />
            </button>
          )}
        </div>
      </div>
      {open && !disabled && (
        <div className="absolute top-full left-0 mt-0.5 z-50 bg-white border border-gray-300 rounded shadow-xl w-full max-h-56 overflow-y-auto">
          {suggestions.map(it => (
            <div
              key={it.id}
              className="px-3 py-2 flex flex-col cursor-pointer hover:bg-blue-50 border-b border-gray-100 last:border-0"
              onClick={() => pick(it)}
            >
              <span className="text-xs font-semibold text-gray-900">{it.item}</span>
              <span className="text-[10px] text-gray-500 truncate">
                {it.descricao}
                {it.source === 'adicionar' && (
                  <span className="text-gray-400"> (manual)</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ConfirmOpts ───────────────────────────────────────────────────────────────

type ConfirmOpts = {
  title:         string
  message:       string
  detail?:       string
  confirmLabel?: string
  danger?:       boolean
  onConfirm:     () => void
}

// ── Headcount and View mode option lists ──────────────────────────────────────

// ── AppHeader ─────────────────────────────────────────────────────────────────

interface AppHeaderProps {
  onGoHome?: () => void
  /** Switches to the other app. Omit to hide the switch button. */
  onSwitchApp?: () => void
  mode?:     'analise' | 'gantt'
}

export function AppHeader({ onGoHome, onSwitchApp, mode }: AppHeaderProps = {}) {
  // Name of the app the switch button leads to — used in its tooltip so the control says
  // where it goes, not just that it moves.
  const otherAppName = mode === 'gantt' ? APP_NAMES.analise : APP_NAMES.gantt
  // The loco faces the way the incoming page arrives from. page.tsx brings Carga de Fábrica in
  // from the right and Capacidade back in from the left, so the mark mirrors with the destination.
  const switchFacing: 'left' | 'right' = mode === 'gantt' ? 'left' : 'right'
  const [locoDeparting, setLocoDeparting] = useState(false)
  const { job: solverJob, run: runSolver, cancel: cancelSolver } = useOptimization()
  const { currentUser, logout, tokenReady } = useAuth()
  // Factory Load main page bridge (null in Capacity mode — no provider mounted there).
  const ganttInline = useGanttInlineMaybe()
  const { canImport, canManageUsers, role } = usePermissions()
  // Headcount management is scoped to the "Análise de Capacidade" app only (mode="analise") —
  // not shown in Factory Load / Gantt (mode="gantt"). Role gate = Editor+; no second-factor
  // unlock is required just to open/view the tab (only mutations require it, server-side).
  // Headcount editing is Editor+ and only meaningful in Análise de Capacidade. Now reached
  // through the "+" menu; kept as a named flag because the modal's own render still gates
  // on it (the "+" entry alone must not be the only thing standing between a wrong app and
  // an open Headcount editor).
  const canShowHeadcountMenu = canImport && mode === 'analise'
  // Avatar circle tint by permission level (same palette as Manage Users):
  // Reader → grey, Editor → amber, Admin → red. Initials stay unchanged.
  const roleBadgeColor = role === 'admin' ? '#D32F2F' : role === 'editor' ? '#D97706' : '#9CA3AF'
  const [showManageUsers, setShowManageUsers] = useState(false)
  const [showManageCalendar, setShowManageCalendar] = useState(false)
  const [showServerControl, setShowServerControl] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showManageHeadcount, setShowManageHeadcount] = useState(false)
  const [userMenu, setUserMenu] = useState<{ x: number; y: number } | null>(null)
  // "+" extras menu beside the avatar (Editor+). Kept separate from `userMenu` so the
  // avatar's own right-click menu keeps its admin-only item set unchanged.
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null)
  const [showTransactedHours, setShowTransactedHours] = useState(false)
  const [showPlanoServicosGcr, setShowPlanoServicosGcr] = useState(false)

  // Opening this screen costs nothing and writes nothing: it reads the stored snapshot's
  // status and, on demand, queries Denodo with the user's OWN credentials. So no password
  // is asked for here — Editor+ (already checked on the "+" button) is the gate to reach
  // it. The password that matters is the IMPORT_PASSWORD inside the modal, which is what
  // authorizes the WRITE, and it is joined there by the admin second factor on the save
  // endpoint. Reaching the screen has never been permission to save, and now it does not
  // pretend to be.
  function openTransactedHours() {
    // Belt-and-braces: the menu item is already disabled without a loaded period, but the
    // modal has no date picker to fall back on, so opening it unscoped would be meaningless.
    if (!transactedHoursReady) return
    setShowTransactedHours(true)
  }

  const [showImport,        setShowImport]        = useState(false)
  // Which data source the simulation modal (ImportModal) reads from: the monthly plan
  // (default) or the Carga de Fábrica period. 'factoryLoad' opens the same modal with the
  // data layer intentionally inactive for now (empty state) — see ImportModal `source`.
  const [importSource,      setImportSource]      = useState<'planoMensal' | 'factoryLoad'>('planoMensal')
  const [showAddItem,       setShowAddItem]       = useState(false)
  const [showOptimize,      setShowOptimize]      = useState(false)
  const [showSolverLog,     setShowSolverLog]     = useState(false)
  const [showOptResults,    setShowOptResults]    = useState(false)
  const [showSaveLoad,      setShowSaveLoad]      = useState(false)
  const [showExcel,         setShowExcel]         = useState(false)
  const [excelInitialDb,    setExcelInitialDb]    = useState<DbKey | undefined>(undefined)
  // Secure in-app dataset viewer/editor (repurposed from the old "Download Bases" area).
  const [showDbViewer,      setShowDbViewer]      = useState(false)
  const [dbViewerInitial,   setDbViewerInitial]   = useState<DbKey | undefined>(undefined)
  // Datasets each app may import/download:
  //   Factory Load (gantt)      → Schedule + Locos Rout
  //   Capacity Analysis (analise) → Itens Rout + Plano Prod (two normalized files
  //     uploaded independently; they replace the legacy combined 'Discretizado')
  const importDbScope: DbKey[] = mode === 'gantt'
    ? ['schedule', 'locos_rout']
    : ['itens_rout', 'plano_prod']
  const [showGantt,          setShowGantt]          = useState(false)
  const [showGanttLaunch,    setShowGanttLaunch]    = useState(false)
  const [ganttInitialTab,    setGanttInitialTab]    = useState<0 | 1 | 2 | 3>(0)
  // Schedule loading is decoupled from navigation: a persisted toggle decides whether the
  // heavy Schedule module is loaded / its tab is accessible. Default OFF (lightweight).
  const [scheduleEnabled,    setScheduleEnabled]    = useState<boolean>(() => getScheduleEnabled())
  // The tab the user last viewed — the launch button re-opens here (defaults to Resumo Geral).
  const [lastGanttTab,       setLastGanttTab]       = useState<0 | 1 | 2 | 3>(() => getLastGanttTab())
  const [ganttCache,          setGanttCache]          = useState<GanttData | null>(null)
  const [ganttScenarioData,   setGanttScenarioData]   = useState<GanttData | null>(null)
  const [ganttScenarioName,   setGanttScenarioName]   = useState<string>('')
  // ── Comparar Cenário: two scenarios in memory, one shown at a time ───────────
  const [compareBase,       setCompareBase]       = useState<GanttData | null>(null)
  const [compareBaseName,   setCompareBaseName]   = useState<string>('')
  const [compareTarget,     setCompareTarget]     = useState<GanttData | null>(null)
  const [compareTargetName, setCompareTargetName] = useState<string>('')
  const [compareMode,       setCompareMode]       = useState(false)
  const [compareActive,     setCompareActive]     = useState<'base' | 'target'>('base')
  const [ganttDateRange,      setGanttDateRange]      = useState<{ from?: string; to?: string } | null>(null)
  const [ganttLineFilter,     setGanttLineFilter]     = useState<string[] | null>(null)
  // One Tipo by default — see DEFAULT_TIPO_KEY. This has to agree with the launch modal's own
  // initial state, or the pipeline below would gate on a different selection from the one the
  // chips are showing.
  const [ganttSelLineTypes,   setGanttSelLineTypes]   = useState<string[]>([DEFAULT_TIPO_KEY])
  const [ganttSchedulePreloading, setGanttSchedulePreloading] = useState(false)
  const [ganttScheduleProgress,   setGanttScheduleProgress]   = useState(0)
  const [ganttLastDateFrom,   setGanttLastDateFrom]   = useState('')
  const [ganttLastDateTo,     setGanttLastDateTo]     = useState('')
  // Incremented each time a new period is loaded — used as React key to fully remount GanttModal
  const [ganttLoadKey,        setGanttLoadKey]        = useState(0)
  // True after the user loaded a period AND opened the Gantt at least once — gates the
  // Factory Load main page population (published to GanttInlineContext below).
  const [ganttOpenedOnce,     setGanttOpenedOnce]     = useState(false)
  // The Tipo selection the CURRENT load was opened with — committed in the launch modal's
  // onOpen, never live. `ganttSelLineTypes` above tracks the modal's checkboxes as the user
  // ticks them, and publishing that to the main page made every tick republish a snapshot
  // for a load that had not happened yet: the page re-derived and flashed its loading state,
  // and ticking GCR fired a plan fetch the user might undo a second later. The page mirrors
  // what is LOADED; the modal owns what is being chosen.
  const [ganttLoadedLineTypes, setGanttLoadedLineTypes] = useState<string[]>([DEFAULT_TIPO_KEY])

  // Publish the ACTIVE Gantt dataset (base / scenario / active comparison side) + the
  // selected period to the Factory Load main page behind the modal. Republishes on
  // scenario switches and period reloads so the page always mirrors the Gantt.
  const ganttInlinePublish = ganttInline?.publish
  // The ACTIVE dataset: base, a loaded scenario, or the side currently shown in comparison.
  const ganttActiveData = compareMode
    ? (compareActive === 'base' ? compareBase : compareTarget)
    : (ganttScenarioData ?? ganttCache)
  useEffect(() => {
    if (!ganttInlinePublish) return
    ganttInlinePublish({
      data: ganttOpenedOnce ? ganttActiveData : null,
      dateRange: ganttDateRange,
      lineFilter: ganttLineFilter,
      // The Tipo KEYS, not just the Linhas: a Tipo with no Schedule behind it (GCR) puts
      // nothing in `lineFilter`, so that list cannot tell the page whether it was selected.
      lineTypes: ganttOpenedOnce ? ganttLoadedLineTypes : null,
    })
  }, [ganttInlinePublish, ganttOpenedOnce, ganttActiveData, ganttDateRange, ganttLineFilter, ganttLoadedLineTypes])

  // Is the "Horas Transacionadas" entry usable? The snapshot is scoped to the period
  // already loaded for the Gantt (the modal offers no date picker of its own), so with no
  // period there is no scope to pull — and at least one Tipo must be selected or the
  // hours would have nothing to be read against. Both start empty/'' and are set when a
  // Gantt is opened, so this is false on a fresh session and true once one is loaded.
  const transactedHoursReady =
    ganttLastDateFrom.trim().length > 0 &&
    ganttLastDateTo.trim().length > 0 &&
    ganttSelLineTypes.length > 0

  // The Schedule module is worth loading only when something in the selection is actually laid
  // out on a Schedule. The user's stored ON/OFF preference is NOT overwritten by this — it is
  // read through it, so the preference returns intact the moment a schedule-backed Tipo is
  // selected again. Everything downstream (the offscreen preload, the Schedule tab lock inside
  // GanttModal) gates on this value rather than on the raw toggle.
  const scheduleActive = scheduleEnabled && anyScheduleBacked(ganttSelLineTypes)

  // Contents of the "+" menu, scoped to the current app. Both entries are Editor+; the
  // outer render already checks canImport, so nothing here re-tests the role.
  const plusMenuItems: CtxMenuItem[] = [
    ...(mode === 'gantt' ? [{
      label: 'Horas Transacionadas',
      icon: <Clock size={14} />,
      disabled: !transactedHoursReady,
      title: transactedHoursReady
        ? 'Carregar horas transacionadas do Denodo para o período carregado'
        : 'Carregue um período e ao menos um Tipo na aba principal para habilitar.',
      onClick: () => openTransactedHours(),
    }, {
      // Reads local Excel files only — no Denodo, no database, nothing persisted — so it
      // needs neither a loaded period nor the ADMIN second factor that gates the entry
      // above. Editor+ (already checked on the "+" button) is the whole gate.
      label: 'Plano de Serviços - GCR',
      icon: <ClipboardList size={14} />,
      title: 'Carregar as planilhas ForecastGCR e HorasGCR',
      onClick: () => setShowPlanoServicosGcr(true),
    }] : []),
    ...(mode === 'analise' ? [{
      label: 'Editar Headcount',
      icon: <Factory size={14} />,
      onClick: () => setShowManageHeadcount(true),
    }] : []),
  ]

  // ── "Carga de Fábrica" as a Simular source ───────────────────────────────────
  // Feeds ImportModal from the loaded schedule instead of /api/excel-items. The dataset is the
  // SAME active scenario the Gantt shows, windowed through the shared `windowGanttData` so the
  // quantities match the Plano de Produção grid exactly rather than the unwindowed period.
  //
  // It comes through FactoryLoadShareContext, NOT from this instance's own state, and that is
  // the whole point: page.tsx mounts one AppHeader per app, so the Gantt states above belong to
  // the Carga de Fábrica header while the Simular menu is rendered by the Capacity one. Reading
  // `ganttCache` / `ganttOpenedOnce` here gated the menu on flags the rendering instance could
  // never set — the entry point was permanently disabled however much was loaded. Each header
  // publishes what it has and reads whatever the other published.
  const factoryLoadShare = useFactoryLoadShare()
  const factoryLoadPublishId = useFactoryLoadPublisherId()
  const factoryLoadPublish = factoryLoadShare.publish
  // The published GCR plan rides along with the dataset. Taken from GanttInlineContext, which
  // already loads it for the Carga de Fábrica main page and only when 'gcr' is in the Tipo
  // selection — so this adds no fetch and cannot offer a plan the user did not load. Null in
  // the Capacity instance (no provider there), which is correct: that header publishes nothing.
  const ganttInlineGcrRows = ganttInline?.gcrRows ?? null
  useEffect(() => {
    factoryLoadPublish(factoryLoadPublishId, {
      data: ganttOpenedOnce ? ganttActiveData : null,
      dateRange: ganttDateRange,
      lineFilter: ganttLineFilter,
      gcrRows: ganttOpenedOnce ? ganttInlineGcrRows : null,
    })
  }, [factoryLoadPublish, factoryLoadPublishId, ganttOpenedOnce, ganttActiveData, ganttDateRange,
      ganttLineFilter, ganttInlineGcrRows])

  const factoryLoadData = useMemo(
    () => windowGanttData(factoryLoadShare.data, factoryLoadShare.dateRange, factoryLoadShare.lineFilter),
    [factoryLoadShare.data, factoryLoadShare.dateRange, factoryLoadShare.lineFilter],
  )
  // The plan is NOT windowed like the Schedule dataset above: `windowGanttData` narrows by
  // period and LINHA, and a published plan has neither — its rows are keyed by fiscal week and
  // área. Filtering it through the launch scope would silently drop every week outside the
  // loaded window, which is exactly the failure the row-level period fallback fixes.
  const factoryLoadGcrRows = factoryLoadShare.gcrRows
  const factoryLoadLoader = useMemo(
    () => makeFactoryLoadLoader(factoryLoadData, factoryLoadGcrRows),
    [factoryLoadData, factoryLoadGcrRows],
  )
  // Ready = a período is loaded AND the Gantt was opened at least once — the publisher only
  // sends `data` when both hold, so this single check covers both. Its items ARE that período's
  // Plano de Produção; offering the option earlier would promise a source that does not exist.
  const factoryLoadReady = !!factoryLoadShare.data
  const ganttProgressValRef    = useRef(0)
  const ganttProgressRafRef    = useRef<number | null>(null)
  const ganttProgressTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // ── Schedule restore/rebuild gating ──────────────────────────────────────────
  // A dataset "signature" = the period + scenario the Schedule is built for. The
  // rebuild decision must compare against what is actually BUILT in the mounted
  // GanttModal, NOT against the staged selection state (ganttScenarioData /
  // ganttLastDate*), which other handlers mutate before onOpen runs — that stale
  // comparison was why adding/removing a scenario blanked & rebuilt inside Schedule.
  // `types` is the line-type/Tipo selection folded into the signature. It belongs here for the
  // same reason period and scenario do: a Tipo change produces a DIFFERENT Schedule and forces a
  // full worker rebuild. While it was excluded, changing only the Tipo counted as "same as built",
  // so the modal opened instantly onto a Schedule tab that was still rebuilding — the empty view
  // that filled in a moment later. Order-insensitive so a reordered selection is not a new dataset.
  type GanttSig = { from: string; to: string; scenario: GanttData | null; types: string }
  const ganttTypesSig = (lineFilter: string[] | null | undefined): string =>
    lineFilter && lineFilter.length ? [...lineFilter].sort().join('|') : '*'
  const ganttMountedSigRef = useRef<GanttSig | null>(null)   // dataset currently mounted/configured
  const ganttBuiltSigRef   = useRef<GanttSig | null>(null)   // dataset whose Schedule iframe is built & alive
  const [showSimulateMenu,  setShowSimulateMenu]  = useState(false)
  const [noItemsWarning,    setNoItemsWarning]    = useState(false)
  const [filtersOpen,       setFiltersOpen]       = useState(false)
  // Factory Load "Datas" header button (gantt mode) — separate panel from Filtros.
  const [dateFiltersOpen,   setDateFiltersOpen]   = useState(false)
  const [optParams,         setOptParams]         = useState<OptimizationParams | null>(null)
  const [optStatusLabel,    setOptStatusLabel]    = useState<string | undefined>(undefined)
  // Home now navigates without a prompt; the state comes back with the dialog at the bottom.
  // const [showHomeConfirm,   setShowHomeConfirm]   = useState(false)
  const [optRows,           setOptRows]           = useState<WsnResultRow[]>([])
  const [optPersonRows,     setOptPersonRows]     = useState<PersonResultRow[] | undefined>(undefined)
  const [optAllocations,    setOptAllocations]    = useState<Record<string, Record<string, number>> | undefined>(undefined)
  const [optOtAllocations,  setOptOtAllocations]  = useState<Record<string, Record<string, number>> | undefined>(undefined)
  const [optWsnShiftInfo,   setOptWsnShiftInfo]   = useState<Record<string, { turnos: number; lm: number; lh: number }> | undefined>(undefined)
  // Expertise for the results screen, loaded alongside the WSN→people roster it annotates.
  // Local rather than in WorkspaceContext: it is read by exactly one modal, is refreshed from
  // the same call as the names, and nothing else in the workspace has an opinion about it.
  const [wsnExpertise,      setWsnExpertise]      = useState<Record<string, Record<string, number>>>({})
  const [wsnRequiredLevel,  setWsnRequiredLevel]  = useState<Record<string, number>>({})
  const [confirmOpts,            setConfirmOpts]            = useState<ConfirmOpts | null>(null)
  const [pendingImport,          setPendingImport]          = useState<{ items: ImportItem[]; meta: ImportMeta } | null>(null)
  const [lastSolverRows,         setLastSolverRows]         = useState<WsnResultRow[]>([])
  const [lastSolverPersonRows,   setLastSolverPersonRows]   = useState<PersonResultRow[] | undefined>(undefined)
  const [lastSolverAllocations,  setLastSolverAllocations]  = useState<Record<string, Record<string, number>> | undefined>(undefined)
  const [lastSolverOtAlloc,      setLastSolverOtAlloc]      = useState<Record<string, Record<string, number>> | undefined>(undefined)
  const [lastSolverShiftInfo,    setLastSolverShiftInfo]    = useState<Record<string, { turnos: number; lm: number; lh: number }> | undefined>(undefined)
  const [lastSolverLabel,        setLastSolverLabel]        = useState<string | undefined>(undefined)
  const [isSkillMatrix,          setIsSkillMatrix]          = useState(false)
  const [optWsnMaxPeople,        setOptWsnMaxPeople]        = useState<Record<string, number>>({})
  const [optWsnMaxHours,         setOptWsnMaxHours]         = useState<Record<string, number>>({})
  const [optWsnMaxTurnos,        setOptWsnMaxTurnos]        = useState<Record<string, number>>({})
  const [optPersonAvailability,  setOptPersonAvailability]  = useState<Record<string, number>>({})
  const [optDisabledPeople,      setOptDisabledPeople]      = useState<Set<string>>(new Set())
  const [optRestrictedCards,     setOptRestrictedCards]     = useState<Set<string>>(new Set())
  const [optFixedCards,          setOptFixedCards]          = useState<Set<string>>(new Set())

  const [statusHovered, setStatusHovered] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  const filtersRef = useRef<HTMLDivElement>(null)
  const dateFiltersRef = useRef<HTMLDivElement>(null)
  const simulateRef = useRef<HTMLDivElement>(null)

  // Close status panel when user clicks outside it
  useEffect(() => {
    if (!statusHovered) return
    const handler = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusHovered(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [statusHovered])

  // Close filters panel when user clicks outside it
  useEffect(() => {
    if (!filtersOpen) return
    const handler = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setFiltersOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filtersOpen])

  // Close the Datas panel when user clicks outside it
  useEffect(() => {
    if (!dateFiltersOpen) return
    const handler = (e: MouseEvent) => {
      if (dateFiltersRef.current && !dateFiltersRef.current.contains(e.target as Node)) {
        setDateFiltersOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dateFiltersOpen])

  // Close simulate panel when user clicks outside it
  useEffect(() => {
    if (!showSimulateMenu) return
    const handler = (e: MouseEvent) => {
      if (simulateRef.current && !simulateRef.current.contains(e.target as Node)) {
        setShowSimulateMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSimulateMenu])

  const { status, dbStatus, apiUrl } = useBackendHealth()
  const {
    items,
    visibleItems,
    filterClient, setFilterClient,
    filterFamily, setFilterFamily,
    filterTipo,   setFilterTipo,
    filterWsn,    setFilterWsn,
    addItems, clearItems, mergeItems,
    availableClientes, availableFamilias, availableTipos,
    headcountMode, setHeadcountMode,
    viewMode,      setViewMode,
    setHighlightedItem,
    assemblyDetails, setAssemblyDetails,
    assemblyLoading,
    importMeta,
    peopleByWsn,
    setPeopleByWsn,
    mappedDays,
    setMappedDays,
    setSolverKpis,
    solverKpis,
    solverAllocByWsn, setSolverAllocByWsn,
    solverOtByWsn, setSolverOtByWsn,
    solverBottleneckByWsn, setSolverBottleneckByWsn,
    optWsnDisabled, optWsnIgnored,
    setOptWsnDisabled, setOptWsnIgnored,
    solverWsnResults, setSolverWsnResults,
  } = useWorkspace()

  /** Build a WSN → description map from loaded assembly details. */
  function buildWsnDescMap(): Record<string, string> {
    const m: Record<string, string> = {}
    for (const detail of Object.values(assemblyDetails)) {
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const w of (scopeData.wsns || [])) {
          if (!m[w.wsn] && w.description) m[w.wsn] = w.description
        }
      }
    }
    return m
  }

  /** Aggregate demand (h) per WSN from all loaded assembly details — mirrors the main window. */
  function buildDemandByWsn(): Record<string, number> {
    const m: Record<string, number> = {}
    for (const detail of Object.values(assemblyDetails)) {
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const w of (scopeData.wsns || [])) {
          m[w.wsn] = (m[w.wsn] ?? 0) + w.hours
        }
      }
    }
    return m
  }

  /** Build WsnResultRow[] from solver result. */
  function buildWsnRowsFromResult(
    result: OptimizationResult,
    params: OptimizationParams,
    days: number | null,
    descMap: Record<string, string>,
  ): WsnResultRow[] {
    // Build wsn → total item quantity map (each item counted once per WSN — max across scopes
    // avoids double-counting the same item when multiple scopes visit the same WSN).
    const wsnItemMap: Record<string, Record<string, number>> = {}
    for (const detail of Object.values(assemblyDetails)) {
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const wsnEntry of (scopeData.wsns ?? [])) {
          if (!wsnItemMap[wsnEntry.wsn]) wsnItemMap[wsnEntry.wsn] = {}
          wsnItemMap[wsnEntry.wsn][detail.item] = Math.max(
            wsnItemMap[wsnEntry.wsn][detail.item] ?? 0,
            scopeData.qty,
          )
        }
      }
    }
    const wsnTotalQtyMap: Record<string, number> = {}
    for (const [wsn, itemMap] of Object.entries(wsnItemMap)) {
      wsnTotalQtyMap[wsn] = Object.values(itemMap).reduce((s, q) => s + q, 0)
    }

    return result.wsns.map(w => {
      const allocated  = w.covered
      const ndias      = days && days > 0 ? days : 1
      const hcCalc     = allocated / (8.8 * (params.top_pct / 100) * ndias)
      const totalQty   = wsnTotalQtyMap[w.wsn] ?? 0
      return {
        wsn:             w.wsn,
        desc:            descMap[w.wsn] ?? '',
        demand_h:        w.demand,
        allocated_h:     allocated,
        overtime_h:      w.ot_h ?? 0,
        utilization_pct: w.util,
        headcount:       Math.round(hcCalc * 10) / 10,
        bottleneck:      w.bottleneck,
        item_qty:        totalQty,
      }
    })
  }

  /** Build PersonResultRow[] from solver allocations. */
  function buildPersonRowsFromResult(
    result: OptimizationResult,
    params: OptimizationParams,
    days: number | null,
  ): PersonResultRow[] {
    const data: Record<string, { total: number; ot: number; wsns: Set<string> }> = {}
    for (const [wsn, personHours] of Object.entries(result.allocations ?? {})) {
      for (const [person, hours] of Object.entries(personHours)) {
        if (!data[person]) data[person] = { total: 0, ot: 0, wsns: new Set() }
        data[person].total += hours
        data[person].wsns.add(wsn)
      }
    }
    for (const [wsn, personOt] of Object.entries(result.ot_allocations ?? {})) {
      for (const [person, otH] of Object.entries(personOt)) {
        if (!data[person]) data[person] = { total: 0, ot: 0, wsns: new Set() }
        data[person].ot += otH
        data[person].wsns.add(wsn)
      }
    }
    // Keep all skilled people visible in "Por Pessoa", even with 0h allocation.
    for (const people of Object.values(peopleByWsn)) {
      for (const person of people ?? []) {
        if (!data[person]) data[person] = { total: 0, ot: 0, wsns: new Set() }
      }
    }
    const capH = days && days > 0 && params.top_pct > 0
      ? 8.8 * (params.top_pct / 100) * days
      : 0
    return Object.entries(data).map(([person, d]) => ({
      person,
      capacity_h:      Math.round(capH * 10) / 10,
      allocated_h:     Math.round(d.total * 10) / 10,
      overtime_h:      Math.round(d.ot   * 10) / 10,
      utilization_pct: capH > 0 ? Math.round((d.total / capH) * 1000) / 10 : 0,
      wsns:            Array.from(d.wsns).sort(),
    })).sort((a, b) => b.allocated_h - a.allocated_h)
  }

  /** Aggregate demand (h) per WSN from all loaded assembly details. */
  function buildWsnRows(): WsnResultRow[] {
    const wsnMap = new Map<string, { desc: string; demand_h: number }>()
    for (const detail of Object.values(assemblyDetails)) {
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const w of (scopeData.wsns || [])) {
          const cur = wsnMap.get(w.wsn) ?? { desc: '', demand_h: 0 }
          cur.demand_h += w.hours
          if (!cur.desc && w.description) cur.desc = w.description
          wsnMap.set(w.wsn, cur)
        }
      }
    }
    return Array.from(wsnMap.entries()).map(([wsn, d]) => ({
      wsn,
      desc:            d.desc,
      demand_h:        d.demand_h,
      allocated_h:     0,
      overtime_h:      0,
      utilization_pct: 0,
      headcount:       0,
    }))
  }

  /** Fetch people_by_wsn from backend (lazy, once per session). */
  async function ensurePeopleByWsn() {
    if (Object.keys(peopleByWsn).length > 0) return
    try {
      const res = await getWsnPeople()
      if (res.status === 'ok') {
        setPeopleByWsn(res.people_by_wsn)
        setWsnExpertise(res.expertise ?? {})
        setWsnRequiredLevel(res.required_level ?? {})
      }
    } catch {
      // silently ignore — person view will show empty state
    }
  }

  // When all items are removed, reset local solver state so the Otimizar
  // button starts pulsing again and the footer shows clean dashes.
  useEffect(() => {
    if (items.length === 0) {
      setLastSolverRows([])
      setLastSolverPersonRows(undefined)
      setLastSolverAllocations(undefined)
      setLastSolverOtAlloc(undefined)
      setLastSolverLabel(undefined)
      setOptWsnDisabled(new Set())
      setOptWsnIgnored(new Set())
      setOptRestrictedCards(new Set())
      setOptFixedCards(new Set())
      setOptDisabledPeople(new Set())
      setSolverAllocByWsn(null)
      setSolverOtByWsn(null)
      setHeadcountMode('skill')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  // The Filtros panel is a sibling of the (now disabled) toggle, so it would float on after the
  // last item is removed. Close it — in analise only; gantt gates on its own data.
  useEffect(() => {
    if (mode !== 'gantt' && items.length === 0) setFiltersOpen(false)
  }, [mode, items.length])

  /** Fiscal weeks of the imported period — same selection `fetchMappedDays` counts. Sent with
   *  the solver payload so the server can resolve real dates: `ndias` is only the count, and
   *  vacation ranges can only be intersected against actual dates. */
  const periodFws: string[] = importMeta
    ? (importMeta.mode === 'mensal' ? importMeta.allFwsForMes : importMeta.selectedFws) ?? []
    : []

  /** Fetch mapped days for current period FWs. */
  async function fetchMappedDays(meta: ImportMeta) {
    try {
      const fws = meta.mode === 'mensal' ? meta.allFwsForMes : meta.selectedFws
      if (!fws || fws.length === 0) return
      const res = await getPeriodDays(fws)
      if (res.status === 'ok') setMappedDays(res.total_days)
    } catch {
      // silently ignore
    }
  }

  // Items visible in the current period — used by the search bar so results
  // only match items actually displayed in the main tab (respects FW filter).
  const searchableItems = useMemo(() => {
    if (assemblyLoading || importMeta === null) return visibleItems
    return visibleItems.filter(it => it.source === 'adicionar' || assemblyDetails[it.item] != null)
  }, [visibleItems, assemblyDetails, assemblyLoading, importMeta])

  /**
   * Called when user clicks "Importar" in the modal.
   * If items are already loaded, show the Add/Replace dialog instead of
   * immediately replacing — the user may want to merge periods.
   */
  function handleImport(newItems: ImportItem[], meta: ImportMeta) {
    setShowImport(false)
    if (items.length > 0) {
      // Existing items in workspace → ask user: Adicionar or Substituir
      setPendingImport({ items: newItems, meta })
    } else {
      // Empty workspace → replace directly (default behaviour)
      addItems(newItems, meta)
      fetchMappedDays(meta)
    }
  }

  /** "Substituir" — replaces the workspace with the new import (default). */
  function handleImportSubstitui() {
    if (!pendingImport) return
    setPendingImport(null)
    addItems(pendingImport.items, pendingImport.meta)
    fetchMappedDays(pendingImport.meta)
  }

  /** "Adicionar" — merges the new import with the existing workspace. */
  function handleImportAdditivo() {
    if (!pendingImport) return
    const { items: newItems, meta: newMeta } = pendingImport
    setPendingImport(null)

    // Merge items: new items replace existing items with the same code,
    // genuinely new items are appended.
    const existingByCode = new Map(items.map(it => [it.item, it]))
    for (const it of newItems) existingByCode.set(it.item, it)
    const mergedItems = Array.from(existingByCode.values())

    // Merge importMeta: union of months, FWs, and mesFwMap entries.
    const prevMeta = importMeta
    let mergedMeta: ImportMeta
    if (!prevMeta) {
      mergedMeta = newMeta
    } else {
      const allMeses = Array.from(
        new Set([...prevMeta.meses, ...newMeta.meses])
      ).sort((a, b) => a - b)
      const mergedSelectedFws = Array.from(
        new Set([...prevMeta.selectedFws, ...newMeta.selectedFws])
      ).sort((a, b) => Number(a) - Number(b))
      const allFwsForMes = Array.from(
        new Set([...prevMeta.allFwsForMes, ...newMeta.allFwsForMes])
      ).sort((a, b) => Number(a) - Number(b))
      const mergedMesFwMap: Record<number, string[]> = {
        ...(prevMeta.mesFwMap ?? {}),
        ...(newMeta.mesFwMap ?? {}),
      }
      mergedMeta = {
        mode:          newMeta.mode,
        mes:           allMeses.length === 1 ? allMeses[0] : null,
        meses:         allMeses,
        selectedFws:   mergedSelectedFws,
        allFwsForMes:  allFwsForMes,
        mesFwMap:      mergedMesFwMap,
      }
    }

    addItems(mergedItems, mergedMeta)
    fetchMappedDays(mergedMeta)
  }

  function handleAdd(newItems: ImportItem[]) {
    setShowAddItem(false)
    mergeItems(newItems)
  }

  /** Guard: if no items or assembly still loading, show warning instead of opening optimize modal. */
  function handleOpenOptimize() {
    if (items.length === 0) {
      setNoItemsWarning(true)
      setTimeout(() => setNoItemsWarning(false), 3000)
      return
    }
    if (assemblyLoading) return
    setShowOptimize(true)
  }

  /** Whether headcount (optimization) mode is available — requires a solver run. */
  const hasOptResult = lastSolverRows.length > 0

  // Workstation options listed from the current main-tab assembly data.
  const availableWsns = (() => {
    const map = new Map<string, string>()
    for (const detail of Object.values(assemblyDetails)) {
      for (const scope of detail.scopes_present) {
        for (const w of (detail.scopes[scope]?.wsns ?? [])) {
          if (!map.has(w.wsn)) map.set(w.wsn, w.description ?? '')
          else if (!map.get(w.wsn) && w.description) map.set(w.wsn, w.description)
        }
      }
    }
    const wsnSortKey = (wsn: string): [number, string] => {
      const m = String(wsn || '').match(/(?:ws\.?\s*)?(\d+)/i)
      const n = m ? Number.parseInt(m[1], 10) : Number.POSITIVE_INFINITY
      return [Number.isFinite(n) ? n : Number.POSITIVE_INFINITY, String(wsn || '').toLowerCase()]
    }
    return Array.from(map.entries())
      .map(([wsn, description]) => ({ wsn, description }))
      .sort((a, b) => {
        const [an, ak] = wsnSortKey(a.wsn)
        const [bn, bk] = wsnSortKey(b.wsn)
        if (an !== bn) return an - bn
        return ak.localeCompare(bk, 'pt-BR', { sensitivity: 'base' })
      })
  })()

  // After optimization, mark bottleneck WSNs in the workstation filter list.
  const bottleneckWsns = new Set(
    (lastSolverRows || []).filter(r => !!r.bottleneck).map(r => r.wsn),
  )

  const hasActiveFilters =
    (filterClient.size > 0 && filterClient.size < availableClientes.length) ||
    (filterFamily.size > 0 && filterFamily.size < availableFamilias.length) ||
    (filterTipo.size > 0 && filterTipo.size < availableTipos.length) ||
    (filterWsn.size > 0 && filterWsn.size < availableWsns.length)

  const activeClientCount = filterClient.size > 0 && filterClient.size < availableClientes.length ? filterClient.size : 0
  const activeFamilyCount = filterFamily.size > 0 && filterFamily.size < availableFamilias.length ? filterFamily.size : 0
  const activeTipoCount   = filterTipo.size > 0 && filterTipo.size < availableTipos.length ? filterTipo.size : 0
  const activeWsnCount    = filterWsn.size > 0 && filterWsn.size < availableWsns.length ? filterWsn.size : 0
  const activeFilterGroups = Number(activeClientCount > 0) + Number(activeFamilyCount > 0) + Number(activeTipoCount > 0) + Number(activeWsnCount > 0)

  function clearAllFilters() {
    setFilterClient(new Set())
    setFilterFamily(new Set())
    setFilterTipo(new Set())
    setFilterWsn(new Set())
  }

  // Capacity (analise) Filtros gate — mirrors ganttFiltersReady below. With no items in the
  // main tab every option list is empty, so the control stays dead instead of opening onto
  // nothing.
  const analiseFiltersReady = !assemblyLoading && items.length > 0

  // ── Factory Load (gantt mode) filters — state lives in GanttInlineContext ────
  // The header owns the filter UI (Filtros + Datas buttons); the main content
  // (hierarchy) and the footer KPIs react to the same shared state.
  const ganttFiltersReady = !!ganttInline?.effectiveData
  const ganttLineTypeFiltered = !!ganttInline && ganttInline.summaryLineTypes.size < GANTT_ALL_LINE_TYPES.length
  const ganttDataFilterGroups = ganttInline
    ? Number(ganttInline.selModels.size > 0) + Number(ganttInline.selAreas.size > 0)
      + Number(ganttInline.selWorkstations.size > 0) + Number(ganttLineTypeFiltered)
    : 0
  const ganttDateFilterCount = ganttInline
    ? ganttInline.selYears.size + ganttInline.selQuarters.size + ganttInline.selMonths.size + ganttInline.selFws.size
    : 0
  /** Toggle one value in a context Set-state (FilterBox onToggle adapter). */
  const ganttToggle = (set?: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    set?.(prev => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n })
  function clearGanttDataFilters() {
    ganttInline?.clearDataFilters()
    ganttInline?.setSummaryLineTypes(new Set(GANTT_ALL_LINE_TYPES))
  }

  // Filtros button badge/highlight: capacity filters in analise mode, Factory Load
  // data filters (Modelo/Área/Workstation/Tipo) in gantt mode.
  const filtrosActiveGroups = mode === 'gantt' ? ganttDataFilterGroups : activeFilterGroups
  const filtrosHasActive    = mode === 'gantt' ? ganttDataFilterGroups > 0 : hasActiveFilters

  useEffect(() => {
    if (filterWsn.size === 0) return
    const optionSet = new Set(availableWsns.map(o => o.wsn))
    const next = new Set([...filterWsn].filter(w => optionSet.has(w)))
    if (next.size !== filterWsn.size) setFilterWsn(next)
  }, [availableWsns, filterWsn, setFilterWsn])

  function askLimpar() {
    if (items.length === 0) return
    setConfirmOpts({
      title:        'Limpar lista de itens',
      message:      `Todos os ${items.length} itens carregados serão removidos da aba principal.`,
      detail:       'Os filtros ativos também serão resetados. Esta ação não pode ser desfeita.',
      confirmLabel: 'Sim, limpar',
      danger:       true,
      onConfirm:    () => { setConfirmOpts(null); clearItems() },
    })
  }

  // ── "Limpar" in Carga de Fábrica (gantt mode) ────────────────────────────────
  // Same button, tone and confirm flow as the capacity app's Limpar, but the thing it empties
  // is the loaded Factory Load session: datasets (base/cenário/comparação), the period, the
  // line filter and the inline Datas/Filtros panels — back to the untouched main page.
  // NOT cleared: schedule edits saved in the DB (that is "Resetar cronograma", a different,
  // password-gated action) — reloading a period brings them back.
  const ganttHasData = !!(ganttCache || ganttScenarioData || compareBase || compareTarget)
  function clearGanttSession() {
    setGanttCache(null)
    setGanttScenarioData(null); setGanttScenarioName('')
    setCompareMode(false); setCompareActive('base')
    setCompareBase(null);   setCompareBaseName('')
    setCompareTarget(null); setCompareTargetName('')
    setGanttDateRange(null); setGanttLineFilter(null)
    setGanttLastDateFrom(''); setGanttLastDateTo('')
    setGanttOpenedOnce(false)          // ⇒ the publish effect pushes `data: null` to the page
    setShowGantt(false)
    clearGanttDataFilters()
    ganttInline?.clearDateFilters()
    ganttBuiltSigRef.current = null
    ganttMountedSigRef.current = null
    setGanttLoadKey(k => k + 1)        // remount the modal against the empty state
  }

  function askLimparGantt() {
    if (!ganttHasData) return
    setConfirmOpts({
      title:        'Limpar Carga de Fábrica',
      message:      'O período carregado, os cenários e a comparação serão descartados da aba principal.',
      detail:       'Os filtros ativos também serão resetados. As edições salvas do cronograma não são apagadas.',
      confirmLabel: 'Sim, limpar',
      danger:       true,
      onConfirm:    () => { setConfirmOpts(null); clearGanttSession() },
    })
  }

  function askResetar() {
    setConfirmOpts({
      title:        'Resetar sessão',
      message:      'Todos os dados carregados nesta sessão serão descartados e a página será recarregada.',
      detail:       'Esta ação não pode ser desfeita. Deseja continuar?',
      confirmLabel: 'Sim, resetar',
      danger:       true,
      onConfirm:    () => { setConfirmOpts(null); window.location.reload() },
    })
  }

  // 'sleeping' = outside working hours (08:00–18:00, seg–sex), so the health poll is paused
  // to let Railway sleep the backend. A hollow dot reads as "dormant" even in the collapsed
  // view, where only the dots render and a second shade of grey would be indistinguishable
  // from 'online'. Stays in palette — no green.
  const statusConfig = {
    checking: { dot: 'bg-yellow-400 animate-pulse', short: '...', tip: `Conectando ao backend em ${apiUrl}` },
    online:   { dot: 'bg-gray-400',                short: 'On',  tip: `Backend conectado em ${apiUrl}` },
    offline:  { dot: 'bg-red-500 animate-pulse',   short: 'Off', tip: `Backend inacessível em ${apiUrl} — rode: uvicorn main:app --reload --port 8000` },
    sleeping: { dot: 'bg-transparent border border-gray-500', short: 'Zzz', tip: 'Backend dormindo — fora do horário (08:00–18:00, seg–sex). Qualquer ação acorda o servidor.' },
  }[status]

  const dbStatusConfig = {
    checking: { dot: 'bg-yellow-400 animate-pulse', short: '...' },
    online:   { dot: 'bg-gray-400',                short: 'On'  },
    offline:  { dot: 'bg-red-500 animate-pulse',   short: 'Off' },
    sleeping: { dot: 'bg-transparent border border-gray-500', short: 'Zzz' },
  }[dbStatus]

  return (
    <>
      {/* `flex-wrap` is the small-screen guard: this toolbar is a single row of fixed-width
          control groups, and without wrapping the browser squeezes them past their content
          until labels and panels overlap. Wrapping keeps every control at its designed size
          and moves the overflow to a second line instead. Above ~1280px nothing wraps, so
          wide screens are untouched. */}
      <header className="bg-[#E0E0E0] border-b border-gray-400 flex flex-wrap items-center gap-0.5 px-2 py-1 shrink-0 relative">

        {/* Left: main action buttons */}
        <div className="flex items-center gap-0.5">
          {/* Gantt mode: show a single prominent Gantt launch button */}
          {mode === 'gantt' ? (
            <ActionBtn
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                  <line x1="8" y1="14" x2="13" y2="14"/>
                  <line x1="8" y1="18" x2="16" y2="18"/>
                </svg>
              }
              label="Gantt"
              tooltip="Definir período e visualizar o Master Schedule"
              active
              onClick={() => setShowGanttLaunch(true)}
            />
          ) : (
            <>
            <div className="relative" ref={simulateRef}>
              <ActionBtn
                icon={<Package2 size={20} />}
                label="Simular"
                tooltip={assemblyLoading ? 'Carregando dados... aguarde' : 'Abrir opções de simulação'}
                active={items.length === 0 && !assemblyLoading}
                disabled={assemblyLoading}
                onClick={() => setShowSimulateMenu(v => !v)}
              />
              {showSimulateMenu && (
                <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-xl min-w-[260px] p-2">
                  <button
                    type="button"
                    onClick={() => { setShowSimulateMenu(false); setShowAddItem(true) }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left hover:bg-gray-100 transition-colors"
                  >
                    <Image src="/imagens/package-box.png" alt="Import Manual" width={18} height={18} className="object-contain" />
                    <div>
                      <p className="text-xs font-semibold text-gray-800">Import Manual</p>
                      <p className="text-[11px] text-gray-500">Adicionar itens individuais</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowSimulateMenu(false); setImportSource('planoMensal'); setShowImport(true) }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left hover:bg-gray-100 transition-colors"
                  >
                    <Image src="/imagens/boxes.png" alt="Plano Mensal" width={18} height={18} className="object-contain" />
                    <div>
                      <p className="text-xs font-semibold text-gray-800">Plano Mensal</p>
                      <p className="text-[11px] text-gray-500">Simular demanda do plano</p>
                    </div>
                  </button>
                  {/* Carga de Fábrica — there is NO independent data path here: the items are the
                      Plano de Produção of the período the Gantt is showing. So the entry point
                      stays disabled until that período exists AND the user has actually opened the
                      Gantt (ganttOpenedOnce) — before that there is no Plano de Produção to pull,
                      and enabling it would imply a source that does not exist yet. */}
                  <button
                    type="button"
                    disabled={!factoryLoadReady}
                    title={factoryLoadReady
                      ? 'Simular a partir do Plano de Produção da Carga de Fábrica'
                      : 'Carregue o Schedule e abra o Gantt na Carga de Fábrica para habilitar'}
                    onClick={() => { if (!factoryLoadReady) return; setShowSimulateMenu(false); setImportSource('factoryLoad'); setShowImport(true) }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left transition-colors ${factoryLoadReady ? 'hover:bg-gray-100' : 'opacity-50 cursor-not-allowed'}`}
                  >
                    {/* Factory glyph — Plano Mensal already owns boxes.png; the two entries
                        used the SAME icon, so the source was unreadable at a glance. */}
                    <Factory size={18} className={factoryLoadReady ? 'text-[#D32F2F]' : 'text-gray-400'} />
                    <div>
                      <p className="text-xs font-semibold text-gray-800">Carga de Fábrica</p>
                      <p className="text-[11px] text-gray-500">Simular a carga de fábrica</p>
                    </div>
                  </button>
                </div>
              )}
            </div>
            <div className="relative">
              <ActionBtn
                icon={<Zap size={20} />}
                label="Otimizar"
                tooltip={
                  items.length === 0
                    ? 'Adicione itens antes de otimizar'
                    : assemblyLoading
                      ? 'Carregando dados dos itens... aguarde'
                      : 'Otimizar alocação'
                }
                active={items.length > 0 && !hasOptResult && !assemblyLoading}
                disabled={assemblyLoading}
                onClick={handleOpenOptimize}
              />
              {noItemsWarning && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-50 pointer-events-none">
                  <div className="bg-[#B71C1C] text-white text-[10px] font-semibold px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap flex items-center gap-1.5">
                    <span>⚠️</span>
                    <span>Adicione itens primeiro</span>
                    <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-0 h-0" style={{ borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '6px solid #B71C1C' }} />
                  </div>
                </div>
              )}
            </div>
            </>
          )}
        </div>

        <Sep />

        {/* Factory Load "Datas" button (gantt mode) — placed BEFORE Filtros (swapped
            per UX request). Date-range filters in their own panel, kept separate from
            the general Filtros panel. */}
        {mode === 'gantt' && (
          <div ref={dateFiltersRef} className="relative">
            <div className={`flex items-center transition-opacity ${!ganttFiltersReady ? 'opacity-40 pointer-events-none' : ''}`}>
              <button
                type="button"
                onClick={() => setDateFiltersOpen(v => !v)}
                title={!ganttFiltersReady ? 'Carregue um período pelo botão Gantt para filtrar' : undefined}
                className={`w-[104px] flex items-center justify-between px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                  dateFiltersOpen
                    ? 'bg-[#D32F2F] text-white hover:bg-[#B71C1C]'
                    : ganttDateFilterCount > 0
                      ? 'bg-[#D32F2F]/10 text-[#B71C1C] hover:bg-[#D32F2F]/20'
                      : 'text-gray-600 hover:bg-gray-200'
                }`}
                style={{ height: 40 }}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <CalendarDays size={14} />
                  <span>Datas</span>
                  {ganttDateFilterCount > 0 && (
                    <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full text-[10px] font-bold px-1 ${
                      dateFiltersOpen ? 'bg-white/20 text-white' : 'bg-[#D32F2F] text-white'
                    }`}>
                      {ganttDateFilterCount}
                    </span>
                  )}
                </span>
                {dateFiltersOpen ? <ChevronUp size={12} /> : <ChevronDownIcon size={12} />}
              </button>
            </div>
            {dateFiltersOpen && ganttInline && (
              <div className="absolute top-full left-0 mt-1 z-40 bg-white rounded-lg shadow-xl border border-gray-200 px-5 py-3.5">
                <div className="flex items-center justify-between mb-3 gap-6">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Filtros de data</p>
                  {ganttDateFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => ganttInline.clearDateFilters()}
                      className="text-[12px] text-[#C62828] font-semibold hover:text-[#B71C1C] inline-flex items-center gap-1"
                      title="Limpar filtros de data"
                    >
                      <X size={12} />
                      Limpar filtros
                    </button>
                  )}
                </div>
                <div className="flex items-start gap-3">
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1.5">Ano</p>
                    <FilterBox icon={<CalendarDays size={12}/>} label="Ano" items={ganttInline.years} selected={ganttInline.selYears} onToggle={ganttToggle(ganttInline.setSelYears)} formatItem={y => y} />
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1.5">Trimestre</p>
                    <FilterBox icon={<CalendarDays size={12}/>} label="Trimestre" items={ganttInline.quarters} selected={ganttInline.selQuarters} onToggle={ganttToggle(ganttInline.setSelQuarters)} formatItem={quarterLabel} />
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1.5">Mês</p>
                    <FilterBox icon={<CalendarDays size={12}/>} label="Mês" items={ganttInline.months} selected={ganttInline.selMonths} onToggle={ganttToggle(ganttInline.setSelMonths)} formatItem={m => { const [yyyy, mm] = m.split('-'); return `${MONTH_NAMES_PT[Number(mm) - 1]} ${yyyy}` }} />
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 mb-1.5">Semana</p>
                    <FilterBox icon={<CalendarDays size={12}/>} label="Semana" items={ganttInline.allFws} selected={ganttInline.selFws} onToggle={ganttToggle(ganttInline.setSelFws)} formatItem={fw => fw} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Left: filter toggle + collapsible panel */}
        <div ref={filtersRef} className="relative">
          <div className={`flex items-center gap-0.5 transition-opacity ${(mode === 'gantt' ? !ganttFiltersReady : !analiseFiltersReady) ? 'opacity-40 pointer-events-none' : ''}`}>
            <button
              type="button"
              onClick={() => setFiltersOpen(v => !v)}
              title={
                mode === 'gantt'
                  ? (!ganttFiltersReady ? 'Carregue um período pelo botão Gantt para filtrar' : undefined)
                  : (items.length === 0 ? 'Carregue itens para filtrar' : undefined)
              }
              className={`w-[112px] flex items-center justify-between px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                filtersOpen
                  ? 'bg-[#D32F2F] text-white hover:bg-[#B71C1C]'
                  : filtrosHasActive
                    ? 'bg-[#D32F2F]/10 text-[#B71C1C] hover:bg-[#D32F2F]/20'
                    : 'text-gray-600 hover:bg-gray-200'
              }`}
              style={{ height: 40 }}
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <SlidersHorizontal size={14} />
                <span>Filtros</span>
                {filtrosActiveGroups > 0 && (
                  <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full text-[10px] font-bold px-1 ${
                    filtersOpen ? 'bg-white/20 text-white' : 'bg-[#D32F2F] text-white'
                  }`}>
                    {filtrosActiveGroups}
                  </span>
                )}
              </span>
              {filtersOpen ? <ChevronUp size={12} /> : <ChevronDownIcon size={12} />}
            </button>
            {mode !== 'gantt' ? (
            <NavBtn
              icon={<Trash2 size={16} />}
              label="Limpar"
              tooltip={assemblyLoading ? 'Carregando dados... aguarde' : items.length === 0 ? 'Nenhum item para remover' : `Remover todos os ${items.length} itens`}
              disabled={assemblyLoading || items.length === 0}
              tone="red"
              onClick={askLimpar}
            />
            ) : (
            <NavBtn
              icon={<Trash2 size={16} />}
              label="Limpar"
              tooltip={ganttHasData ? 'Descartar o período e os cenários carregados' : 'Nada carregado para limpar'}
              disabled={!ganttHasData}
              tone="red"
              onClick={askLimparGantt}
            />
            )}
          </div>
          {filtersOpen && (
            <div className="absolute top-full left-0 mt-1 z-40 bg-white rounded-lg shadow-xl border border-gray-200 px-5 py-3.5">
              <div className="flex items-center justify-between mb-3 gap-6">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Filtros de visualização</p>
                {filtrosActiveGroups > 0 && (
                  <button
                    type="button"
                    onClick={mode === 'gantt' ? clearGanttDataFilters : clearAllFilters}
                    className="text-[12px] text-[#C62828] font-semibold hover:text-[#B71C1C] inline-flex items-center gap-1"
                    title="Limpar todos os filtros"
                  >
                    <X size={12} />
                    Limpar filtros
                  </button>
                )}
              </div>
              {/* Factory Load (gantt) filters — Modelo / Área / Workstation + Tipo.
                  State lives in GanttInlineContext: the page hierarchy and the footer
                  KPIs update immediately with every change. */}
              {mode === 'gantt' && ganttInline && (
                <div className="flex flex-col gap-3">
                  {/* Tipo selector — the entire first section: full panel width, buttons
                      evenly distributed, above all other filters. */}
                  <div className="flex items-stretch gap-1.5 w-full">
                    {GANTT_ALL_LINE_TYPES.map(key => {
                      const active  = ganttInline.summaryLineTypes.has(key)
                      const hasData = ganttInline.availableLineTypes.has(key)
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={!hasData}
                          title={!hasData ? `${GANTT_LINE_TYPE_LABELS[key]} não foi carregado neste período` : undefined}
                          onClick={() => { if (!hasData) return; ganttToggle(ganttInline.setSummaryLineTypes)(key) }}
                          className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold whitespace-nowrap text-center transition-colors border-[1.5px] ${
                            active && hasData
                              ? 'bg-[#D32F2F] border-[#D32F2F] text-white'
                              : hasData
                                ? 'bg-[#FFF8F8] border-[#FECACA] text-[#F87171]'
                                : 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed opacity-60'
                          }`}
                        >
                          {GANTT_LINE_TYPE_LABELS[key]}
                        </button>
                      )
                    })}
                  </div>
                  <div className="h-px bg-gray-100" />
                  {/* Remaining data filters below the type selector */}
                  <div className="flex items-start gap-3">
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 mb-1.5">Modelo</p>
                      <FilterBox icon={<Boxes size={12}/>} label="Modelo" items={ganttInline.allModels} selected={ganttInline.selModels} onToggle={ganttToggle(ganttInline.setSelModels)} formatItem={m => m} />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 mb-1.5">Área</p>
                      <FilterBox icon={<Layers size={12}/>} label="Área" items={ganttInline.allAreas} selected={ganttInline.selAreas} onToggle={ganttToggle(ganttInline.setSelAreas)} formatItem={a => a} />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 mb-1.5">Workstation</p>
                      <FilterBox icon={<LayoutGrid size={12}/>} label="Workstation" items={ganttInline.allWorkstations} selected={ganttInline.selWorkstations} onToggle={ganttToggle(ganttInline.setSelWorkstations)} formatItem={w => w} alignRight />
                    </div>
                  </div>
                </div>
              )}
              {mode !== 'gantt' && (
              <div className="flex items-start gap-5">
                <div>
                  <p className="text-[10px] font-medium text-gray-500 mb-1.5">Cliente</p>
                  <FilterDropdown
                    panelMode
                    label="Cliente"
                    img="/imagens/filter.png"
                    options={availableClientes}
                    selected={filterClient}
                    onChange={setFilterClient}
                    emptyMsg="Nenhum item carregado"
                    gcmGcr
                  />
                </div>
                <div>
                  <p className="text-[10px] font-medium text-gray-500 mb-1.5">Família</p>
                  <FilterDropdown
                    panelMode
                    label="Família"
                    img="/imagens/filter2.png"
                    options={availableFamilias}
                    selected={filterFamily}
                    onChange={setFilterFamily}
                    emptyMsg="Nenhum item carregado"
                  />
                </div>
                <div>
                  <p className="text-[10px] font-medium text-gray-500 mb-1.5">Tipo</p>
                  <TipoDropdown
                    panelMode
                    options={availableTipos}
                    selected={filterTipo}
                    onChange={setFilterTipo}
                  />
                </div>
                <div>
                  <p className="text-[10px] font-medium text-gray-500 mb-1.5">Station</p>
                  <WsnDropdown
                    panelMode
                    options={availableWsns}
                    selected={filterWsn}
                    onChange={setFilterWsn}
                    bottleneckWsns={hasOptResult ? bottleneckWsns : new Set()}
                  />
                </div>
              </div>
              )}
            </div>
          )}
        </div>

        {/* Stretch */}
        <div className="flex-1" />

        {/* Right: search — hidden in gantt mode */}
        {mode !== 'gantt' && (
          <SearchBox items={searchableItems} onSelect={code => setHighlightedItem(code)} disabled={assemblyLoading} />
        )}

        {/* App switch — jumps straight to the other app, no confirmation: both apps stay
            mounted, so nothing is lost and a prompt would only stand between the user and a
            move they can undo by clicking again. Sits left of Home; the two form the
            navigation pair. */}
        {onSwitchApp && (
          <NavBtn
            icon={<HalfLocoIcon facing={switchFacing} />}
            label="Trocar"
            tooltip={`Abrir ${otherAppName}`}
            className={`loco-btn ${switchFacing === 'right' ? 'loco-btn--rtl' : ''} ${locoDeparting ? 'loco-departing' : ''}`}
            onClick={() => {
              // Rebound plays on the button while the page slides underneath it. Cleared by a
              // timer rather than onAnimationEnd so a second press always re-triggers it.
              setLocoDeparting(true)
              window.setTimeout(() => setLocoDeparting(false), 420)
              onSwitchApp()
            }}
          />
        )}

        {/* Home button — shown when onGoHome is provided. Navigates STRAIGHT to Home, no
            confirmation: like "Trocar" beside it, all three shells stay mounted, so leaving an
            app costs nothing and the move is undone by clicking back in. The prompt is kept
            commented (below, and the dialog near the end of this file) rather than deleted.
              onClick={() => setShowHomeConfirm(true)} */}
        {onGoHome && (
          <NavBtn
            icon={
              // `home-icon` carries the hover/press motion; see .home-btn in globals.css. Same
              // spring, duration and press-squash as the loco beside it — only the axis differs,
              // because Home is not a direction on screen.
              <svg className="home-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
            }
            label="Home"
            tooltip="Voltar à página inicial"
            className="home-btn"
            onClick={onGoHome}
          />
        )}


        <Sep />

        {/* Right: quick icon buttons */}
        <div className="flex items-center gap-0.5">
          <NavBtn icon={<RotateCcw size={16} />} label="Resetar" tooltip={assemblyLoading ? 'Carregando dados... aguarde' : 'Recarregar planilha'} disabled={assemblyLoading} tone="red" onClick={askResetar} />
          <NavBtn icon={<Save size={16} />} label="Salvar" tooltip={assemblyLoading ? 'Carregando dados... aguarde' : 'Salvar/carregar sessão'} disabled={assemblyLoading} tone="red" onClick={() => setShowSaveLoad(true)} />
          {/* Editor+ only, and the role can land a beat after the header paints — so it fades in
              instead of popping into the middle of a settled row of buttons. `inline-flex` keeps
              the wrapper the button's own box inside this flex row. */}
          {canImport && (
            <Reveal className="inline-flex">
              <NavBtn icon={<Database size={16} className="text-[#D97706]" />} label="Database" tooltip={assemblyLoading ? 'Carregando dados... aguarde' : 'Banco de dados'} disabled={assemblyLoading} tone="amber" onClick={() => setShowExcel(true)} />
            </Reveal>
          )}
        </div>

        <Sep />

        {/* User info + logout */}
        {currentUser && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Avatar + admin notification badge. `relative` anchors the badge/panel so they
                overlay the avatar without shifting any surrounding header element. */}
            <div className="relative shrink-0">
              {/* User avatar circle — Admins CLICK it to open the admin menu (usuários,
                  calendário, servidor). It used to be a right-click: an affordance nobody finds
                  unless told, on the one control that is the way in to every admin surface. Left
                  click is also what the same bubble does on Home, so the two agree.
                  The right-click is kept as a second way in, since it is what admins have in their
                  fingers — it opens the same menu rather than the browser's.
                  `transition-colors`: grey is BOTH "Leitor" and "the role hasn't come back yet",
                  so this bubble repaints the moment /api/permissions/me answers. Tweening the
                  colour reads as the lookup finishing, not as the account changing under you. */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center select-none transition-colors duration-500 ${canManageUsers ? 'cursor-pointer' : ''}`}
                style={{ backgroundColor: roleBadgeColor }}
                title={canManageUsers
                  ? `${currentUser.email} — clique para gerenciar usuários e calendário`
                  : currentUser.email}
                onClick={canManageUsers ? (e => { e.stopPropagation(); setUserMenu({ x: e.clientX, y: e.clientY }) }) : undefined}
                onContextMenu={canManageUsers ? (e => { e.preventDefault(); setUserMenu({ x: e.clientX, y: e.clientY }) }) : undefined}
              >
                <span className="text-white text-[11px] font-bold leading-none">
                  {(() => {
                    const parts = currentUser.name.trim().split(/\s+/)
                    if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
                    return parts[0].slice(0, 2).toUpperCase()
                  })()}
                </span>
              </div>
              {/* Admin-only notification indicator (unacknowledged security events). */}
              {canManageUsers && <AdminAlertsBell />}
              {/* Admin-only online-users indicator (top-right of the avatar, opposite the alerts badge). */}
              {canManageUsers && <OnlineUsersBadge />}
              {/* Extra functionalities ("+"), Editor+ only. Pinned to the avatar's BOTTOM-right,
                  directly under OnlineUsersBadge (-top-1.5 -right-1.5) and sharing its exact
                  geometry — 14px circle, slate-500, white glyph, white ring + shadow, hover
                  lift. Same right offset means the two stack on one vertical axis; anything
                  close-but-different at this size reads as a rendering bug, not a control.
                  Fixed 14×14 (no px-1): the badge's padding is there to fit 1–3 digits, and a
                  single glyph doesn't need it.

                  ALWAYS shown for Editor+ — never gated on whether a period is loaded. The
                  gate lives on the menu ITEM instead, so the feature stays discoverable and
                  the button can't flicker in and out as the Gantt loads. */}
              {canImport && (
                // The positioning classes live on the Reveal wrapper, not on the button: nesting a
                // second box inside the absolute one would be the thing that shifts the badge off
                // the avatar's corner.
                <Reveal className="absolute -bottom-1 -right-1 z-20">
                  <button
                    type="button"
                    onClick={e => setPlusMenu({ x: e.clientX, y: e.clientY })}
                    title="Funcionalidades adicionais"
                    aria-label="Funcionalidades adicionais"
                    className="w-[11px] h-[11px] rounded-full flex items-center
                               justify-center text-white leading-none shadow ring-1 ring-white cursor-pointer
                               transition-transform hover:scale-110
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: '#6B7280' }}
                  >
                    <Plus size={8} strokeWidth={4} />
                  </button>
                </Reveal>
              )}
            </div>
            <div className="flex flex-col items-start leading-tight">
              <span className="text-[9px] text-gray-500 font-medium">Olá,</span>
              <span
                className="text-[11px] text-gray-800 font-semibold max-w-[150px] whitespace-nowrap overflow-hidden"
                style={{ textOverflow: 'ellipsis' }}
                title={currentUser.email}
              >
                {(() => {
                  const parts = currentUser.name.trim().split(/\s+/)
                  // Show first + last name (both full words, no truncation mid-word)
                  if (parts.length <= 2) return currentUser.name
                  return `${parts[0]} ${parts[parts.length - 1]}`
                })()}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmOpts({
                title:        'Sair da conta',
                message:      `Deseja sair da conta ${currentUser.email}?`,
                detail:       'Você precisará fazer login novamente para continuar usando o sistema.',
                confirmLabel: 'Sair',
                danger:       true,
                onConfirm:    () => { setConfirmOpts(null); logout() },
              })}
              title={`Sair (${currentUser.email})`}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-gray-600
                hover:bg-red-50 hover:text-[#C62828] transition-colors border border-gray-300 hover:border-red-300"
            >
              <LogOut size={12} />
              <span>Sair</span>
            </button>
          </div>
        )}

        <Sep />

        {/* Right: logo + status tab (status sits in the right padding, expands over logo on hover) */}
        <div className="relative flex items-center shrink-0 pl-1 pr-6">
          <Image
            src="/imagens/wab2.png"
            alt="Wabtec logo"
            height={40}
            width={120}
            className="object-contain"
            style={{ width: 'auto', height: 'auto' }}
            priority
          />

          {/* Status tab — click to expand/collapse, positioned over logo */}
          <div
            ref={statusRef}
            className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer select-none"
            style={{ zIndex: statusHovered ? 50 : 10 }}
            onClick={() => setStatusHovered(v => !v)}
            title={!statusHovered ? `${statusConfig.tip} | DB: ${dbStatusConfig.short}` : undefined}
          >
            <div
              className={`overflow-hidden rounded transition-all duration-200 ease-out ${
                statusHovered
                  ? 'shadow-[0_3px_12px_rgba(0,0,0,0.25)]'
                  : ''
              }`}
              style={{
                width:      statusHovered ? 96 : 18,
                background: statusHovered ? 'rgba(238,238,238,0.96)' : 'transparent',
              }}
            >
              {statusHovered ? (
                /* ── Expanded panel ── */
                <div className="flex flex-col gap-[3px] px-[6px] py-[5px]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-[5px]">
                      <span className={`block w-2 h-2 rounded-full shrink-0 ${statusConfig.dot}`} />
                      <span className="text-[10px] font-semibold text-gray-800 whitespace-nowrap leading-none">{statusConfig.short}</span>
                    </div>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap leading-none">Backend</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-[5px]">
                      <span className={`block w-2 h-2 rounded-full shrink-0 ${dbStatusConfig.dot}`} />
                      <span className="text-[10px] font-semibold text-gray-800 whitespace-nowrap leading-none">{dbStatusConfig.short}</span>
                    </div>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap leading-none">Database</span>
                  </div>
                </div>
              ) : (
                /* ── Collapsed: two dots only, no text ── */
                <div className="flex flex-col items-center gap-[3px] px-[3px] py-[5px]">
                  <span className={`block w-2 h-2 rounded-full ${statusConfig.dot}`} />
                  <span className={`block w-2 h-2 rounded-full ${dbStatusConfig.dot}`} />
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {showImport && (
        <ImportModal
          source={importSource}
          sourceLoader={importSource === 'factoryLoad' ? factoryLoadLoader : undefined}
          sourceScope={importSource === 'factoryLoad'
            ? factoryLoadScope(factoryLoadData, factoryLoadGcrRows)
            : undefined}
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* Add-or-Replace dialog — shown when importing while items already exist */}
      {pendingImport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) setPendingImport(null) }}
        >
          <div className="bg-white rounded-lg shadow-2xl w-[380px] overflow-hidden">
            <div className="bg-[#D32F2F] text-white px-4 py-2.5 flex items-center justify-between">
              <span className="font-semibold text-sm">Importar itens</span>
              <button
                onClick={() => setPendingImport(null)}
                className="rounded p-1 hover:bg-white/20 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-700 mb-1">
                Já existem itens carregados na área de trabalho.
              </p>
              <p className="text-xs text-gray-500">
                Deseja <span className="font-semibold text-gray-700">adicionar</span> os novos itens
                ao período existente, ou <span className="font-semibold text-gray-700">substituir</span> tudo
                pelo novo import?
              </p>
            </div>
            <div className="px-5 pb-4 flex justify-end gap-2">
              <button
                onClick={() => setPendingImport(null)}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded bg-white text-gray-700 hover:bg-gray-100 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleImportSubstitui}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded bg-white text-gray-700 hover:bg-gray-100 transition-colors"
              >
                Substituir
              </button>
              <button
                onClick={handleImportAdditivo}
                className="px-4 py-1.5 text-xs bg-[#D32F2F] text-white rounded hover:bg-red-800 transition-colors font-medium"
              >
                Adicionar
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddItem && (
        <AddItemModal
          onAdd={handleAdd}
          onClose={() => setShowAddItem(false)}
        />
      )}

      {showExcel && canImport && (
        <ExcelModal
          onClose={() => { setShowExcel(false); setExcelInitialDb(undefined) }}
          onOpenViewer={(key) => { setDbViewerInitial(key); setShowDbViewer(true) }}
          initialDb={excelInitialDb}
          allowedDbs={importDbScope}
        />
      )}

      {showDbViewer && canImport && (
        <DbDatasetModal
          allowedDbs={importDbScope}
          initialDb={dbViewerInitial}
          onClose={() => { setShowDbViewer(false); setDbViewerInitial(undefined) }}
        />
      )}

      {/* Avatar right-click menu. Deixou de ser exclusivo de admin porque ganhou uma entrada
          que é de TODO usuário: "Alterar Senha". Com o login local, quem entra pela primeira
          vez está usando a senha que a migração do Entra ID gerou, e um Leitor não teria por
          onde substituí-la se este menu continuasse fechado para ele. As três entradas
          administrativas seguem condicionadas a `canManageUsers`, e cada modal é re-checado
          no ponto de montagem — o menu decide o que é oferecido, não o que é permitido. */}
      {userMenu && (canManageUsers || !!currentUser) && (
        <ContextMenu
          x={userMenu.x}
          y={userMenu.y}
          items={[
            ...(currentUser ? [{
              label: 'Alterar Senha',
              icon: <KeyRound size={14} />,
              onClick: () => setShowChangePw(true),
            }] : []),
            ...(canManageUsers ? [
              {
                label: 'Gerenciar Usuários',
                icon: <Users size={14} />,
                onClick: () => setShowManageUsers(true),
              },
              {
                label: 'Gerenciar Calendário',
                icon: <CalendarDays size={14} />,
                onClick: () => setShowManageCalendar(true),
              },
              {
                label: 'Controle do Servidor',
                icon: <Power size={14} />,
                onClick: () => setShowServerControl(true),
              },
            ] : []),
          ]}
          onClose={() => setUserMenu(null)}
        />
      )}

      {/* "+" extras menu (Editor+). Contents are PER-APP: each entry acts on data that only
          one app has loaded, so showing it in the other would offer an action with nothing
          to act on.
            • Carga de Fábrica  → Horas Transacionadas
            • Análise de Capac. → Editar Headcount (moved off the avatar's right-click menu,
              which is now Admin-only again)
          Horas Transacionadas is LISTED but disabled until a period and at least one Tipo
          are loaded — the snapshot is scoped to exactly that period, so with nothing loaded
          there is no scope to pull. Disabled rather than hidden keeps it discoverable and
          lets the tooltip say what is missing. */}
      {plusMenu && canImport && plusMenuItems.length > 0 && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          items={plusMenuItems}
          onClose={() => setPlusMenu(null)}
        />
      )}

      {showTransactedHours && canImport && mode === 'gantt' && transactedHoursReady && (
        <TransactedHoursModal
          onClose={() => setShowTransactedHours(false)}
          loadedFrom={ganttLastDateFrom}
          loadedTo={ganttLastDateTo}
          // Both sides of this cross the tree through GanttInlineContext: the page publishes
          // which locos it renders, and receives back the prévia's rollup to display before
          // anything is written.
          locos={ganttInline?.mainLocoNames ?? EMPTY_LOCO_SCOPE}
          onRollup={r => ganttInline?.setPendingRollup(r)}
        />
      )}

      {showPlanoServicosGcr && canImport && mode === 'gantt' && (
        <PlanoServicosGcrModal onClose={() => setShowPlanoServicosGcr(false)} />
      )}

      {showManageUsers && canManageUsers && (
        <ManageUsersModal onClose={() => setShowManageUsers(false)} />
      )}

      {showManageCalendar && canManageUsers && (
        <ManageCalendarModal onClose={() => setShowManageCalendar(false)} />
      )}

      {showServerControl && canManageUsers && (
        <ServerControlModal onClose={() => setShowServerControl(false)} />
      )}

      {showChangePw && currentUser && (
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      )}

      {showManageHeadcount && canShowHeadcountMenu && (
        <ManageHeadcountModal onClose={() => setShowManageHeadcount(false)} />
      )}

      <ImportProgressFloat
        allowedDbs={importDbScope}
        onOpenModal={(dbKey) => { setExcelInitialDb(dbKey); setShowExcel(true) }}
      />

      {showGanttLaunch && (
        <GanttLaunchModal
          onClose={() => { setShowGanttLaunch(false); setGanttSchedulePreloading(false); setGanttScheduleProgress(0); ganttProgressValRef.current = 0; if (ganttProgressTickerRef.current) { clearInterval(ganttProgressTickerRef.current); ganttProgressTickerRef.current = null } }}
          onOpen={(tab, dateFrom, dateTo, lineFilter, scenarioOverride, scenarioOverrideName) => {
            // A period is loaded and the Gantt is opening — the Factory Load main page
            // behind the modal may now be populated (see the publish effect above). The Tipo
            // selection is COMMITTED here, at the open, not while the user is still ticking it.
            setGanttOpenedOnce(true)
            setGanttLoadedLineTypes(ganttSelLineTypes)
            // In comparison mode, opening WITHOUT a single-scenario override means the user
            // is (re)defining the period for the already-loaded comparison. Period and
            // scenario selection are independent: keep both scenarios + comparison mode and
            // just re-window them. Only "Simular" (a scenarioOverride) exits comparison.
            if (compareMode && !scenarioOverride) {
              setGanttLastDateFrom(dateFrom || ''); setGanttLastDateTo(dateTo || '')
              setGanttDateRange(dateFrom || dateTo ? { from: dateFrom, to: dateTo } : null)
              setGanttLineFilter(lineFilter ?? null)
              setGanttInitialTab(0)   // Comparison opens on Resumo Geral; the Schedule tab is now reachable per-scenario from there
              setGanttLoadKey(k => k + 1)
              ganttBuiltSigRef.current = null
              ganttMountedSigRef.current = { from: dateFrom || '', to: dateTo || '', scenario: (compareActive === 'base' ? compareBase : compareTarget), types: ganttTypesSig(lineFilter) }
              setShowGanttLaunch(false)
              setShowGantt(true)
              return
            }
            // Normal single-scenario open must leave comparison mode (backward compat).
            if (compareMode) { setCompareMode(false); setCompareBase(null); setCompareTarget(null); setCompareBaseName(''); setCompareTargetName('') }
            // Requested dataset signature (period + scenario). Compare against what the
            // Schedule is actually BUILT for, so scenario add/remove and period switches
            // are correctly detected — and never blank-rebuild inside the open Schedule.
            const reqSig: GanttSig = {
              from: dateFrom || '',
              to:   dateTo   || '',
              scenario: scenarioOverride ?? null,
              types: ganttTypesSig(lineFilter),
            }
            const built = ganttBuiltSigRef.current
            const sameAsBuilt = !!built
              && built.from === reqSig.from
              && built.to   === reqSig.to
              && built.types === reqSig.types
              && built.scenario === reqSig.scenario   // object identity (base = null)

            // Always apply the latest selection state so the new line filter (and
            // period/scenario) take effect even when the dataset is unchanged.
            // Previously these lived inside an "unchanged" guard, so changing only line
            // types left a STALE lineFilter applied → empty/blank results.
            if (scenarioOverride) {
              setGanttScenarioData(scenarioOverride)
              setGanttScenarioName(scenarioOverrideName || '')
            } else {
              setGanttScenarioData(null)
              setGanttScenarioName('')
            }
            setGanttLastDateFrom(dateFrom || '')
            setGanttLastDateTo(dateTo || '')
            setGanttDateRange(dateFrom || dateTo ? { from: dateFrom, to: dateTo } : null)
            setGanttLineFilter(lineFilter ?? null)

            // The mounted modal now reflects the requested dataset.
            ganttMountedSigRef.current = reqSig

            // Only remount (full rebuild) when the dataset itself changed — period, scenario OR
            // the Tipo selection. A Tipo change used to be excluded here, which meant it skipped
            // the preload branch below and dropped the user straight into a Schedule tab that was
            // still building (the empty-then-populate flash). It is a different dataset; treat it
            // like one and let the offscreen build own the wait.
            if (!sameAsBuilt) {
              setGanttLoadKey(k => k + 1)
              // The previous build is being discarded — no Schedule is alive until the
              // new one finishes building.
              ganttBuiltSigRef.current = null
            }

            setGanttInitialTab(tab)
            // Schedule toggle drives the loading pipeline (navigation always flows through the
            // Resumo Geral button). When Schedule is ON and the dataset is new/changed, run the
            // EXACT same offscreen build the old "Schedule Geral" button used — full Schedule
            // ready before the modal opens — then land on the target (last) tab. When Schedule
            // is OFF (lightweight) or the dataset is already built (Schedule iframe still alive),
            // open immediately: with Schedule off there is nothing heavy to wait for, and an
            // already-built dataset is alive in the iframe, so neither can flash an empty view.
            // `scheduleActive`, not the raw toggle: a selection of Tipos that are not laid out
            // on the Schedule (GCR alone) has no groups to build, so the heavy module must not
            // be preloaded for it. Without this, opening GCR on its own spent the full Schedule
            // build on an empty set and then unlocked a tab that rendered blank.
            const preloadSchedule = scheduleActive && !sameAsBuilt
            if (!preloadSchedule) {
              setShowGanttLaunch(false)
              setShowGantt(true)
            } else {
              // Build OFFSCREEN with progress on the launch button; the modal opens only when
              // onScheduleReady fires. The user stays on this screen until Schedule is ready.
              ganttProgressValRef.current = 0
              setGanttSchedulePreloading(true)
              setGanttScheduleProgress(0)
            }
          }}
          initialFrom={ganttLastDateFrom}
          initialTo={ganttLastDateTo}
          initialLineTypes={ganttSelLineTypes}
          onLineTypesChange={setGanttSelLineTypes}
          ganttCache={ganttCache}
          onDataLoaded={setGanttCache}
          schedulePreloading={ganttSchedulePreloading}
          scheduleProgress={ganttScheduleProgress}
          persistedScenarioData={ganttScenarioData}
          persistedScenarioName={ganttScenarioName}
          onScenarioChange={(d, name) => { setGanttScenarioData(d); setGanttScenarioName(name) }}
          tokenReady={tokenReady}
          loadedFrom={ganttLastDateFrom}
          loadedTo={ganttLastDateTo}
          scheduleEnabled={scheduleEnabled}
          onScheduleEnabledChange={(enabled) => { setScheduleEnabled(enabled); persistScheduleEnabled(enabled) }}
          lastTab={lastGanttTab}
          onCompareConfirm={(baseData, baseName, targetData, targetName) => {
            // "Concluir": load BOTH scenarios into memory and arm comparison mode, but do
            // NOT open the Gantt yet. The compare sub-modal closes and the user returns to
            // this launch screen to define/confirm the period, then opens the comparison via
            // Resumo Geral (the period is applied to both scenarios in onOpen above).
            setCompareBase(baseData);     setCompareBaseName(baseName)
            setCompareTarget(targetData); setCompareTargetName(targetName)
            setCompareActive('base')      // Base shown first
            setCompareMode(true)
            // Single-scenario state must not interfere with comparison mode.
            setGanttScenarioData(null); setGanttScenarioName('')
          }}
          comparisonActive={compareMode}
          comparisonBaseName={compareBaseName}
          comparisonTargetName={compareTargetName}
          onComparisonRemove={() => {
            // Clear both scenarios, exit comparison mode, return to the single-scenario flow.
            setCompareMode(false)
            setCompareBase(null); setCompareTarget(null)
            setCompareBaseName(''); setCompareTargetName('')
            setCompareActive('base')
          }}
        />
      )}

      {/* The Gantt/Carga de Fábrica modal is where nearly all of this application's compute
          lives (summary rollups, GCR merges, scenario comparisons, the Schedule worker), so it is
          also where a render is most likely to throw. Contained here it costs the modal and
          nothing else: the two app shells, their loaded datasets and every other modal stay
          mounted, and "Fechar" returns the user to a working app instead of to app/error.tsx.
          `resetKey` is the load key — a new dataset is a clean slate for the boundary too. */}
      <AppErrorBoundary
        name="Gantt"
        resetKey={ganttLoadKey}
        onDismiss={() => setShowGantt(false)}
      >
        <GanttModal
          key={ganttLoadKey}
          visible={showGantt}
          tokenReady={tokenReady}
          onClose={() => setShowGantt(false)}
          initialData={compareMode ? (compareActive === 'base' ? compareBase : compareTarget) : (ganttScenarioData ?? ganttCache)}
          onDataLoaded={setGanttCache}
          initialTab={ganttInitialTab}
          /* The EFFECTIVE value, not the stored preference — see scheduleActive. With only
             non-schedule-backed Tipos loaded the module was never built, so the tab must be
             locked rather than opening onto nothing. */
          scheduleEnabled={scheduleActive}
          onScheduleEnabledChange={(enabled) => { setScheduleEnabled(enabled); persistScheduleEnabled(enabled) }}
          onTabChange={(t) => { setLastGanttTab(t); persistLastGanttTab(t) }}
          dateRange={ganttDateRange}
          lineFilter={ganttLineFilter}
          initialLineTypeKeys={ganttSelLineTypes}
          scenarioActive={compareMode ? true : !!ganttScenarioData}
          scenarioName={compareMode ? (compareActive === 'base' ? compareBaseName : compareTargetName) : (ganttScenarioName || undefined)}
          comparisonMode={compareMode}
          comparisonActive={compareActive}
          comparisonOtherData={compareMode ? (compareActive === 'base' ? compareTarget : compareBase) : null}
          comparisonBaseName={compareBaseName}
          comparisonTargetName={compareTargetName}
          onComparisonSwitch={() => setCompareActive(a => (a === 'base' ? 'target' : 'base'))}
          preloadSchedule={ganttSchedulePreloading}
          onScheduleBuilt={() => {
            // The Schedule iframe for the currently mounted dataset is now built & alive
            // (whether via offscreen preload or an in-modal tab switch). Record it so a
            // later reopen of this exact period+scenario restores instantly.
            ganttBuiltSigRef.current = ganttMountedSigRef.current
          }}
          onScheduleProgress={(p) => {
            if (p >= 2) {
              // Built sentinel (onBuilt) — animate smoothly to 100%
              if (ganttProgressTickerRef.current) { clearInterval(ganttProgressTickerRef.current); ganttProgressTickerRef.current = null }
              ganttProgressValRef.current = 100
              setGanttScheduleProgress(100)
              return
            }
            // Worker progress (0–1) maps to 2–90% so the bar grows continuously.
            // Start at 2% so users see immediate movement even before the first chunk.
            const target = 2 + Math.min(88, p * 88)
            if (target > ganttProgressValRef.current) {
              ganttProgressValRef.current = target
              // Batch React state updates via rAF to avoid excessive renders
              if (!ganttProgressRafRef.current) {
                ganttProgressRafRef.current = requestAnimationFrame(() => {
                  setGanttScheduleProgress(Math.round(ganttProgressValRef.current))
                  ganttProgressRafRef.current = null
                })
              }
            }
          }}
          onScheduleReady={() => {
            if (ganttProgressTickerRef.current) { clearInterval(ganttProgressTickerRef.current); ganttProgressTickerRef.current = null }
            setGanttSchedulePreloading(false)
            setGanttScheduleProgress(0)
            setShowGanttLaunch(false)
            setShowGantt(true)
          }}
        />
      </AppErrorBoundary>

      {confirmOpts && (
        <ConfirmDialog
          title={confirmOpts.title}
          message={confirmOpts.message}
          detail={confirmOpts.detail}
          confirmLabel={confirmOpts.confirmLabel}
          danger={confirmOpts.danger}
          onConfirm={confirmOpts.onConfirm}
          onCancel={() => setConfirmOpts(null)}
        />
      )}

      {showSaveLoad && (
        <SaveLoadModal
          onClose={() => setShowSaveLoad(false)}
          onSave={async (filename: string, password: string) => {
            // Serialise the FULL working session (Capacity workspace + Carga de Fábrica
            // Gantt state + live LOCO/WS/Componente edits), encrypt it with the user's
            // password (AES-256-GCM), then trigger a browser download of the ciphertext.
            const sessionData = {
              version: 2,
              exportedAt: new Date().toISOString(),
              // ── Capacity workspace (top-level; v1-compatible) ──
              items,
              importMeta,
              assemblyDetails,
              headcountMode,
              viewMode,
              mappedDays,
              solverKpis,
              lastSolverRows,
              // Active filters (Cliente / Família / Tipo / Station).
              filters: {
                client: setToArr(filterClient),
                family: setToArr(filterFamily),
                tipo:   setToArr(filterTipo),
                wsn:    setToArr(filterWsn),
              },
              // Per-WSN solver footer state + WSN overrides (Sets → arrays).
              workspaceSolver: {
                allocByWsn:      solverAllocByWsn,
                otByWsn:         solverOtByWsn,
                bottleneckByWsn: solverBottleneckByWsn,
                wsnResults:      solverWsnResults,
                optWsnDisabled:  setToArr(optWsnDisabled),
                optWsnIgnored:   setToArr(optWsnIgnored),
                peopleByWsn,
              },
              // Full solver result set + optimizer overrides from the results modal.
              capacityOpt: {
                lastSolverPersonRows,
                lastSolverAllocations,
                lastSolverOtAlloc,
                lastSolverShiftInfo,
                lastSolverLabel,
                isSkillMatrix,
                optWsnMaxPeople,
                optWsnMaxHours,
                optWsnMaxTurnos,
                optPersonAvailability,
                optDisabledPeople:  setToArr(optDisabledPeople),
                optRestrictedCards: setToArr(optRestrictedCards),
                optFixedCards:      setToArr(optFixedCards),
              },
              // ── Carga de Fábrica (Gantt) ──
              gantt: {
                cache:             ganttCache,
                scenarioData:      ganttScenarioData,
                scenarioName:      ganttScenarioName,
                compareBase,       compareBaseName,
                compareTarget,     compareTargetName,
                compareMode,       compareActive,
                dateRange:         ganttDateRange,
                lineFilter:        ganttLineFilter,
                selLineTypes:      ganttSelLineTypes,
                lastDateFrom:      ganttLastDateFrom,
                lastDateTo:        ganttLastDateTo,
                openedOnce:        ganttOpenedOnce,
                lastTab:           lastGanttTab,
                scheduleEnabled,
                // Live Gantt edits (visual overrides) for the active scenario.
                overridesScenario: getActiveScenario(),
                overrides:         loadOverrides(),
              } satisfies GanttSessionSection,
            }
            const encrypted = await encryptSession(sessionData, password)
            const blob = new Blob([encrypted], { type: 'application/json' })
            const url  = URL.createObjectURL(blob)
            const a    = document.createElement('a')
            a.href     = url
            a.download = `${filename}.json`
            a.click()
            URL.revokeObjectURL(url)
          }}
          onLoad={async (raw, password) => {
            // Decrypt (if encrypted) + validate schema/size/version. Throws a
            // user-facing SessionError which SaveLoadModal surfaces inline.
            const parsed = await readSessionFile(raw, password)
            const logFail = (stage: string, err: unknown) =>
              console.error(`[session-restore] ${stage} failed:`, err)

            // ── Capacity workspace ──────────────────────────────────────────────
            try {
              // NOTE: an empty array is truthy — guard on length so loading a
              // Gantt-only session does NOT wipe the current Capacity workspace.
              const hasItems = Array.isArray(parsed.items) && parsed.items.length > 0
              if (hasItems) {
                // addItems() resets filters + assemblyDetails as a side effect, so it
                // MUST run first; the restores below then override those resets.
                addItems(parsed.items as ImportItem[], (parsed.importMeta as ImportMeta) ?? undefined)
                if (parsed.assemblyDetails) setAssemblyDetails(parsed.assemblyDetails as Parameters<typeof setAssemblyDetails>[0])
                const f = parsed.filters as { client?: unknown; family?: unknown; tipo?: unknown; wsn?: unknown } | undefined
                if (f) {
                  setFilterClient(arrToSet(f.client))
                  setFilterFamily(arrToSet(f.family))
                  setFilterTipo(arrToSet(f.tipo))
                  setFilterWsn(arrToSet(f.wsn))
                }
              }
              if (parsed.headcountMode)  setHeadcountMode(parsed.headcountMode as 'skill' | 'headcount')
              if (parsed.viewMode)       setViewMode(parsed.viewMode as 'semanal' | 'mensal')
              if (parsed.mappedDays != null) setMappedDays(parsed.mappedDays as number)
              if (parsed.solverKpis)     setSolverKpis(parsed.solverKpis as Parameters<typeof setSolverKpis>[0])
              if (parsed.lastSolverRows) setLastSolverRows(parsed.lastSolverRows as WsnResultRow[])
            } catch (e) { logFail('capacity', e) }

            // ── Capacity solver footer + optimizer overrides ────────────────────
            try {
              const ws = parsed.workspaceSolver as {
                allocByWsn?: Record<string, number> | null
                otByWsn?: Record<string, number> | null
                bottleneckByWsn?: Record<string, number> | null
                wsnResults?: Record<string, { demand: number; covered: number; unmet: number }> | null
                optWsnDisabled?: unknown; optWsnIgnored?: unknown
                peopleByWsn?: Record<string, string[]>
              } | undefined
              if (ws) {
                if (ws.allocByWsn !== undefined)      setSolverAllocByWsn(ws.allocByWsn ?? null)
                if (ws.otByWsn !== undefined)         setSolverOtByWsn(ws.otByWsn ?? null)
                if (ws.bottleneckByWsn !== undefined) setSolverBottleneckByWsn(ws.bottleneckByWsn ?? null)
                if (ws.wsnResults !== undefined)      setSolverWsnResults(ws.wsnResults ?? null)
                setOptWsnDisabled(arrToSet(ws.optWsnDisabled))
                setOptWsnIgnored(arrToSet(ws.optWsnIgnored))
                if (ws.peopleByWsn) setPeopleByWsn(ws.peopleByWsn)
              }
              const co = parsed.capacityOpt as Record<string, unknown> | undefined
              if (co) {
                if (co.lastSolverPersonRows !== undefined) setLastSolverPersonRows(co.lastSolverPersonRows as PersonResultRow[] | undefined)
                if (co.lastSolverAllocations !== undefined) setLastSolverAllocations(co.lastSolverAllocations as Record<string, Record<string, number>> | undefined)
                if (co.lastSolverOtAlloc !== undefined) setLastSolverOtAlloc(co.lastSolverOtAlloc as Record<string, Record<string, number>> | undefined)
                if (co.lastSolverShiftInfo !== undefined) setLastSolverShiftInfo(co.lastSolverShiftInfo as Record<string, { turnos: number; lm: number; lh: number }> | undefined)
                if (co.lastSolverLabel !== undefined) setLastSolverLabel(co.lastSolverLabel as string | undefined)
                if (typeof co.isSkillMatrix === 'boolean') setIsSkillMatrix(co.isSkillMatrix)
                if (co.optWsnMaxPeople) setOptWsnMaxPeople(co.optWsnMaxPeople as Record<string, number>)
                if (co.optWsnMaxHours)  setOptWsnMaxHours(co.optWsnMaxHours as Record<string, number>)
                if (co.optWsnMaxTurnos) setOptWsnMaxTurnos(co.optWsnMaxTurnos as Record<string, number>)
                if (co.optPersonAvailability) setOptPersonAvailability(co.optPersonAvailability as Record<string, number>)
                setOptDisabledPeople(arrToSet(co.optDisabledPeople))
                setOptRestrictedCards(arrToSet(co.optRestrictedCards))
                setOptFixedCards(arrToSet(co.optFixedCards))
              }
            } catch (e) { logFail('capacity-opt', e) }

            // ── Carga de Fábrica (Gantt) ────────────────────────────────────────
            try {
              const g = parsed.gantt as GanttSessionSection | undefined
              if (g) {
                setGanttCache((g.cache as GanttData) ?? null)
                setGanttScenarioData((g.scenarioData as GanttData) ?? null)
                setGanttScenarioName(typeof g.scenarioName === 'string' ? g.scenarioName : '')
                setCompareBase((g.compareBase as GanttData) ?? null)
                setCompareBaseName(typeof g.compareBaseName === 'string' ? g.compareBaseName : '')
                setCompareTarget((g.compareTarget as GanttData) ?? null)
                setCompareTargetName(typeof g.compareTargetName === 'string' ? g.compareTargetName : '')
                setCompareMode(!!g.compareMode)
                setCompareActive(g.compareActive === 'target' ? 'target' : 'base')
                setGanttDateRange(g.dateRange ?? null)
                setGanttLineFilter(Array.isArray(g.lineFilter) ? g.lineFilter : null)
                // A saved workspace stores ONE Tipo list — it was saved from a loaded session,
                // so it is both the modal's selection and the committed one. Restore both, or a
                // workspace restored with `openedOnce` true publishes a null selection and the
                // page loses the Tipos (GCR's card included) that the save was showing.
                if (Array.isArray(g.selLineTypes)) {
                  setGanttSelLineTypes(g.selLineTypes)
                  setGanttLoadedLineTypes(g.selLineTypes)
                }
                setGanttLastDateFrom(typeof g.lastDateFrom === 'string' ? g.lastDateFrom : '')
                setGanttLastDateTo(typeof g.lastDateTo === 'string' ? g.lastDateTo : '')
                setGanttOpenedOnce(!!g.openedOnce)
                if (g.lastTab != null) { setLastGanttTab(g.lastTab); persistLastGanttTab(g.lastTab) }
                if (typeof g.scheduleEnabled === 'boolean') { setScheduleEnabled(g.scheduleEnabled); persistScheduleEnabled(g.scheduleEnabled) }
                // Re-install the live Gantt edits AUTHORITATIVELY so a later DB hydrate
                // can't overwrite what the session captured.
                seedOverridesFromSession(
                  typeof g.overridesScenario === 'string' ? g.overridesScenario : '',
                  (g.overrides as LocoOverrideMap) ?? {},
                )
                // Remount the Gantt modal against the restored dataset and reset the
                // build/mount signatures so the Schedule rebuilds cleanly on next open.
                ganttBuiltSigRef.current = null
                ganttMountedSigRef.current = null
                setGanttLoadKey(k => k + 1)
              }
            } catch (e) { logFail('gantt', e) }
          }}
        />
      )}

      {showOptimize && (
        <OptimizeModal
          onClose={() => setShowOptimize(false)}
          hasPreviousResult={lastSolverRows.length > 0}
          onRunSolver={(params: OptimizationParams) => {
            try {
              window.sessionStorage.removeItem('optvision_active_job_id')
            } catch {
              // Ignore storage errors.
            }
            setOptParams(params)
            ensurePeopleByWsn()
            setShowOptimize(false)
            setShowOptResults(false)
            // Clear all persistent overrides — fresh run starts with a clean slate
            setOptWsnDisabled(new Set())
            setOptWsnIgnored(new Set())
            setOptWsnMaxPeople({})
            setOptWsnMaxHours({})
            setOptWsnMaxTurnos({})
            setOptPersonAvailability({})
            setOptDisabledPeople(new Set())
            runSolver({
              items: items.map(it => it as unknown as Record<string, unknown>),
              top_pct:          params.top_pct,
              ot_day_limit_pct: 60,
              solver_backend:   'gurobi',
              phase_limit:      params.optimization_phase_limit,
              gap_pct:          params.optimization_gap_pct,
              time_limit_s:     params.optimization_time_limit_s,
              ndias:            mappedDays ?? 5,
              fws:              periodFws.length > 0 ? periodFws : undefined,
              demand_by_wsn:    buildDemandByWsn(),
              use_all_headcount: params.use_all_headcount,
              expertise_enabled: params.expertise_enabled,
            })
            setShowSolverLog(true)
          }}
          onEstadoAtual={() => {
            ensurePeopleByWsn()
            setShowOptimize(false)
            if (headcountMode === 'headcount' && lastSolverRows.length > 0) {
              setOptStatusLabel(lastSolverLabel ?? 'Última Otimização')
              setOptRows(lastSolverRows)
              setOptPersonRows(lastSolverPersonRows)
              setOptAllocations(lastSolverAllocations)
              setOptOtAllocations(lastSolverOtAlloc)
              setOptWsnShiftInfo(lastSolverShiftInfo)
              setIsSkillMatrix(false)
            } else {
              setOptStatusLabel('Estado Atual')
              // Merge bottleneck info from last solver run into skill matrix rows
              const baseRows = buildWsnRows()
              const bWsns = new Set(lastSolverRows.filter(r => r.bottleneck).map(r => r.wsn))
              const bItemQty: Record<string, number> = {}
              for (const r of lastSolverRows) { if (r.bottleneck) bItemQty[r.wsn] = r.item_qty ?? 0 }
              setOptRows(bWsns.size > 0
                ? baseRows.map(r => ({ ...r, bottleneck: bWsns.has(r.wsn), item_qty: bItemQty[r.wsn] ?? 0 }))
                : baseRows)
              setOptPersonRows(undefined)
              setOptAllocations(undefined)
              setOptOtAllocations(undefined)
              setOptWsnShiftInfo(undefined)
              setIsSkillMatrix(headcountMode === 'skill')
            }
            setShowOptResults(true)
          }}
        />
      )}

      {showSolverLog && optParams && (
        <SolverLogModal
          job={solverJob}
          onClose={() => setShowSolverLog(false)}
          onCancelRunning={() => {
            void cancelSolver()
            setShowSolverLog(false)
          }}
          onDone={(result: OptimizationResult) => {
            const descMap     = buildWsnDescMap()
            const wsnRows     = buildWsnRowsFromResult(result, optParams, mappedDays, descMap)

            // Inject ghost rows for disabled WSNs so user can still see and re-enable them.
            // They appear with their original demand but zero allocation (shown as bottleneck).
            const fullDemand  = buildDemandByWsn()
            const resultWsns  = new Set(wsnRows.map(r => r.wsn))
            for (const wsn of optWsnDisabled) {
              if (!resultWsns.has(wsn)) {
                wsnRows.push({
                  wsn,
                  desc:            descMap[wsn] ?? '',
                  demand_h:        fullDemand[wsn] ?? 0,
                  allocated_h:     0,
                  overtime_h:      0,
                  utilization_pct: 0,
                  headcount:       0,
                  bottleneck:      true,
                })
              }
            }
            const personRows  = buildPersonRowsFromResult(result, optParams, mappedDays)
            const phases      = result.phase_metrics?.length ?? 0
            const gapStr      = result.final_gap != null
              ? ` — MIP: ${Math.round(result.final_gap * 100)}%`
              : ''
            setOptRows(wsnRows)
            setOptPersonRows(personRows)
            setOptAllocations(result.allocations ?? {})
            setOptOtAllocations(result.ot_allocations ?? {})
            setOptWsnShiftInfo(result.wsn_shift_info ?? undefined)
            const solverLabel = `TOP: ${optParams.top_pct}% — GAP: ${optParams.optimization_gap_pct}%${gapStr}`
            setOptStatusLabel(solverLabel)
            setLastSolverRows(wsnRows)
            setLastSolverPersonRows(personRows)
            setLastSolverAllocations(result.allocations ?? {})
            setLastSolverOtAlloc(result.ot_allocations ?? {})
            setLastSolverShiftInfo(result.wsn_shift_info ?? undefined)
            setLastSolverLabel(solverLabel)
            setIsSkillMatrix(false)
            // Auto-switch to headcount (optimization) mode in main window
            setHeadcountMode('headcount')
            // Store KPIs in context so AppFooter can display them
            const alloc      = result.allocations ?? {}
            const otAlloc    = result.ot_allocations ?? {}
            const people     = new Set<string>()
            let   allocH     = 0
            let   overtimeH  = 0
            for (const [, pMap] of Object.entries(alloc)) {
              for (const [p, h] of Object.entries(pMap)) { people.add(p); allocH += h }
            }
            for (const pMap of Object.values(otAlloc)) {
              for (const h of Object.values(pMap)) overtimeH += h
            }
            // Per-WSN totals for tipo-filtered footer KPIs
            const allocByWsn: Record<string, number> = {}
            const otByWsn:    Record<string, number> = {}
            for (const [wsn, pMap] of Object.entries(alloc)) {
              allocByWsn[wsn] = Object.values(pMap as Record<string, number>).reduce((s, h) => s + h, 0)
            }
            for (const [wsn, pMap] of Object.entries(otAlloc)) {
              otByWsn[wsn] = Object.values(pMap as Record<string, number>).reduce((s, h) => s + h, 0)
            }
            setSolverAllocByWsn(allocByWsn)
            setSolverOtByWsn(otByWsn)
            setSolverKpis({ allocatedH: allocH, overtimeH, distinctPeople: people.size, topPct: optParams.top_pct })
            // Build per-WSN bottleneck item-qty map (for footer NAO ATENDIDOS)
            const bByWsn: Record<string, number> = {}
            for (const r of wsnRows) {
              if (r.bottleneck && (r.item_qty ?? 0) > 0) bByWsn[r.wsn] = r.item_qty ?? 0
            }
            setSolverBottleneckByWsn(Object.keys(bByWsn).length > 0 ? bByWsn : null)
            // Build per-WSN demand/covered/unmet map for NIVEL-based bottleneck on main tab
            const wsnResultsMap: Record<string, { demand: number; covered: number; unmet: number }> = {}
            for (const w of result.wsns) {
              if (w.bottleneck && w.unmet > 0)
                wsnResultsMap[w.wsn] = { demand: w.demand, covered: w.covered, unmet: w.unmet }
            }
            setSolverWsnResults(Object.keys(wsnResultsMap).length > 0 ? wsnResultsMap : null)
            setShowSolverLog(false)
            setShowOptResults(true)
          }}
        />
      )}

      {showOptResults && (
        <OptimizationResultsModal
          params={optParams}
          statusLabel={optStatusLabel}
          rows={optRows}
          peopleByWsn={peopleByWsn}
          personRows={optPersonRows}
          mappedDays={mappedDays}
          selectedFws={importMeta?.selectedFws ?? []}
          allocations={optAllocations}
          otAllocations={optOtAllocations}
          wsnShiftInfo={optWsnShiftInfo}
          expertise={wsnExpertise}
          requiredLevel={wsnRequiredLevel}
          isSkillMatrix={isSkillMatrix}
          onToggleSkillMatrix={() => {
            const next = !isSkillMatrix
            setIsSkillMatrix(next)
            setHeadcountMode(next ? 'skill' : 'headcount')
          }}
          initialDisabledWsns={optWsnDisabled}
          initialIgnoredWsns={optWsnIgnored}
          initialWsnMaxPeople={optWsnMaxPeople}
          initialWsnMaxHours={optWsnMaxHours}
          initialWsnMaxTurnos={optWsnMaxTurnos}
          initialPersonAvailability={optPersonAvailability}
          initialDisabledPeople={optDisabledPeople}
          initialRestrictedCards={optRestrictedCards}
          initialFixedCards={optFixedCards}
          onDisabledWsnsChange={setOptWsnDisabled}
          onIgnoredWsnsChange={setOptWsnIgnored}
          onWsnMaxPeopleChange={setOptWsnMaxPeople}
          onWsnMaxHoursChange={setOptWsnMaxHours}
          onWsnMaxTurnosChange={setOptWsnMaxTurnos}
          onPersonAvailabilityChange={setOptPersonAvailability}
          onDisabledPeopleChange={setOptDisabledPeople}
          onRestrictedCardsChange={setOptRestrictedCards}
          onFixedCardsChange={setOptFixedCards}
          onClose={() => setShowOptResults(false)}
          onRecalculate={(params, overrides) => {
            setOptParams(params)
            setOptPersonAvailability(overrides.personAvailability)  // clean: no 0s for disabled people
            setShowOptResults(false)
            // Compute demand the same way as the first run, then strip disabled WSNs.
            const disabledSet = new Set(Object.keys(overrides.disabledWsnDemand))
            const fullDemand  = buildDemandByWsn()
            const demand: Record<string, number> = {}
            for (const [wsn, h] of Object.entries(fullDemand)) {
              if (!disabledSet.has(wsn)) demand[wsn] = h
            }
            runSolver({
              items:            items.map(it => it as unknown as Record<string, unknown>),
              top_pct:          params.top_pct,
              ot_day_limit_pct: 60,
              solver_backend:   'gurobi',
              phase_limit:      params.optimization_phase_limit,
              gap_pct:          params.optimization_gap_pct,
              time_limit_s:     params.optimization_time_limit_s,
              ndias:            mappedDays ?? 5,
              fws:              periodFws.length > 0 ? periodFws : undefined,
              demand_by_wsn:   Object.keys(demand).length > 0 ? demand : undefined,
              wsn_max_people:  Object.keys(overrides.wsnMaxPeople).length > 0 ? overrides.wsnMaxPeople : undefined,
              wsn_max_hours:   Object.keys(overrides.wsnMaxHours).length > 0  ? overrides.wsnMaxHours  : undefined,
              wsn_max_turnos:  Object.keys(overrides.wsnMaxTurnos).length > 0 ? overrides.wsnMaxTurnos : undefined,
              person_availability_pct: (() => {
                const merged = { ...overrides.personAvailability }
                for (const p of overrides.disabledPeople) merged[p] = 0
                return Object.keys(merged).length > 0 ? merged : undefined
              })(),
              blocked_pairs: overrides.blockedPairs.length > 0 ? overrides.blockedPairs : undefined,
              required_pair_presence: overrides.requiredPairs.length > 0 ? overrides.requiredPairs : undefined,
              forced_pair_headcount: Object.keys(overrides.forcedPairHeadcount).length > 0 ? overrides.forcedPairHeadcount : undefined,
              direct_pair_headcount: Object.keys(overrides.directPairHeadcount).length > 0 ? overrides.directPairHeadcount : undefined,
              fixed_pair_ot_pct: Object.keys(overrides.fixedPairOtPct).length > 0 ? overrides.fixedPairOtPct : undefined,
              max_pair_pct: Object.keys(overrides.maxPairPct).length > 0 ? overrides.maxPairPct : undefined,
              max_pair_ot_pct: Object.keys(overrides.maxPairOtPct).length > 0 ? overrides.maxPairOtPct : undefined,
              use_all_headcount: params.use_all_headcount,
              expertise_enabled: params.expertise_enabled,
            })
            setShowSolverLog(true)
          }}
        />
      )}

      {/* Home navigation confirmation — REMOVED, kept commented.
          The Home button navigates directly now (see the NavBtn above): nothing is lost by
          leaving an app, so the prompt only stood between the user and a one-click move.
          Restore by uncommenting this block and putting `onClick={() => setShowHomeConfirm(true)}`
          back on the button.

      {showHomeConfirm && onGoHome && (
        <ConfirmDialog
          title="Voltar ao início"
          message="Deseja voltar à página inicial?"
          detail="O progresso desta sessão será preservado — você pode retornar a qualquer momento."
          confirmLabel="Sim, voltar"
          cancelLabel="Cancelar"
          onConfirm={() => { setShowHomeConfirm(false); onGoHome() }}
          onCancel={() => setShowHomeConfirm(false)}
        />
      )}
      */}
    </>
  )
}
