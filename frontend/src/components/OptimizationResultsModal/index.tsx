'use client'
import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, ArrowUpDown, Settings, RotateCcw, Download, ChevronLeft, ChevronRight, Ban, Lock, Eye, EyeOff } from 'lucide-react'
import type { OptimizationParams } from '@/components/OptimizeModal'
import {
  VIEW_COLOR, VIEW_BG_LIGHT, VIEW_LABEL,
  type ViewMode, type SortMode, type ToolMode,
  type WsnOverrides, type PersonOverrides, type OptimizationResultsModalProps, type WsnShiftInfo,
} from './types'
import { fmt1, fmt0, fmtPct, downloadCsv } from './utils'
import { ParamsPanel } from './ParamsPanel'
import { ContextMenu, type CtxMenuItem } from './ContextMenu'
import { PanelAllocatePeople } from './PanelAllocatePeople'
import { PanelLimites } from './NumberRoller'
import { PanelAvailabilityFull } from './PanelAvailabilityFull'
import { PanelPairRules } from './PanelPairRules'
import { ConfirmMini, ToolButton } from './ConfirmMini'
import { WsnTable } from './WsnResultsTable'
import { PersonTable } from './PersonResultsTable'

export type { WsnResultRow, WsnOverrides, PersonOverrides, OptimizationResultsModalProps } from './types'

export function OptimizationResultsModal({
  params,
  statusLabel,
  rows = [],
  peopleByWsn = {},
  personRows,
  mappedDays,
  allocations,
  otAllocations,
  wsnShiftInfo,
  expertise = {},
  requiredLevel = {},
  isSkillMatrix = false,
  selectedFws = [],
  initialDisabledWsns,
  initialIgnoredWsns,
  initialWsnMaxPeople,
  initialWsnMaxHours,
  initialWsnMaxTurnos,
  initialPersonAvailability,
  initialDisabledPeople,
  initialRestrictedCards,
  initialFixedCards,
  onDisabledWsnsChange,
  onIgnoredWsnsChange,
  onWsnMaxPeopleChange,
  onWsnMaxHoursChange,
  onWsnMaxTurnosChange,
  onPersonAvailabilityChange,
  onDisabledPeopleChange,
  onRestrictedCardsChange,
  onFixedCardsChange,
  onToggleSkillMatrix,
  onClose,
  onRecalculate,
}: OptimizationResultsModalProps) {
  const defaultParams: OptimizationParams = {
    top_pct:                    90,
    optimization_gap_pct:       2,
    optimization_time_limit_s:  60,
    optimization_phase_limit:   6,
    optimization_ot_max_hours:  0,
    use_all_headcount:          false,
    expertise_enabled:          false,
  }

  const [viewMode,        setViewMode]        = useState<ViewMode>('wsn')
  const [sortMode,        setSortMode]        = useState<SortMode>('demand')
  const [showParams,      setShowParams]      = useState(false)
  const [editParams,      setEditParams]      = useState<OptimizationParams>(params ?? defaultParams)
  const [savedParams]                         = useState<OptimizationParams>(params ?? defaultParams)
  const [fading,          setFading]          = useState(false)
  const [expandedWsns,    setExpandedWsns]    = useState<Set<string>>(new Set())
  const [expandedPersons, setExpandedPersons] = useState<Set<string>>(new Set())
  const [confirmAction,   setConfirmAction]   = useState<null | 'recalculate' | 'reset' | 'reset_overrides'>(null)
  const [scrollTarget,    setScrollTarget]    = useState<string | null>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // ── Override state ──────────────────────────────────────────────────────────
  type CtxTarget =
    | { type: 'wsn';    wsn:    string; isBottleneck: boolean; x: number; y: number }
    | { type: 'person'; person: string;                         x: number; y: number }
    | { type: 'pair';   wsn: string; person: string;           x: number; y: number }

  const [ctxMenu,             setCtxMenu]             = useState<CtxTarget | null>(null)
  const [disabledWsns,        setDisabledWsns]        = useState<Set<string>>(initialDisabledWsns ?? new Set())
  const [ignoredBottlenecks,  setIgnoredBottlenecks]  = useState<Set<string>>(initialIgnoredWsns  ?? new Set())
  const [wsnForcedPeople,     setWsnForcedPeople]     = useState<Record<string, string[]>>({})
  const [wsnMaxPeople,        setWsnMaxPeople]        = useState<Record<string, number>>(initialWsnMaxPeople ?? {})
  const [wsnMaxHours,         setWsnMaxHours]         = useState<Record<string, number>>(initialWsnMaxHours  ?? {})
  const [wsnMaxTurnos,        setWsnMaxTurnos]        = useState<Record<string, number>>(initialWsnMaxTurnos ?? {})
  const [disabledPeople,      setDisabledPeople]      = useState<Set<string>>(initialDisabledPeople ?? new Set())
  const [personForcedWsn,     setPersonForcedWsn]     = useState<Record<string, string[]>>({})
  const [personAvailability,  setPersonAvailability]  = useState<Record<string, number>>(initialPersonAvailability ?? {})
  const [directPairHeadcount, setDirectPairHeadcount] = useState<Record<string, number>>({})
  const [fixedPairOtPct,      setFixedPairOtPct]      = useState<Record<string, number>>({})
  const [maxPairPct,          setMaxPairPct]          = useState<Record<string, number>>({})
  const [maxPairOtPct,        setMaxPairOtPct]        = useState<Record<string, number>>({})
  const [overridePanel, setOverridePanel] = useState<
    | { kind: 'allocatePeopleToWsn'; wsn: string }
    | { kind: 'limitesForWsn';       wsn: string }
    | { kind: 'allocatePersonToWsn'; person: string }
    | { kind: 'availabilityByWeek';  person: string }
    | { kind: 'editPairRules'; wsn: string; person: string }
    | null
  >(null)

  // ── Paint tool state ────────────────────────────────────────────────────────
  const [activeToolMode,  setActiveToolMode]  = useState<ToolMode>(null)
  const [restrictedCards, setRestrictedCards] = useState<Set<string>>(initialRestrictedCards ?? new Set())
  const [fixedCards,      setFixedCards]      = useState<Set<string>>(initialFixedCards ?? new Set())
  const [showRestricted,  setShowRestricted]  = useState(true)
  const [wsnSwaps,        setWsnSwaps]        = useState<Record<string, Array<{ removed: string; added: string; hours: number }>>>({})
  const [toastMsg,        setToastMsg]        = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (toastMsg) {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      toastTimerRef.current = setTimeout(() => setToastMsg(null), 6000)
    }
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }
  }, [toastMsg])
  const isDraggingRef = useRef(false)
  const dragActionRef = useRef<'add' | 'remove'>('add')
  const wsnOverrides: WsnOverrides = {
    disabledWsns,
    ignoredBottlenecks,
    forcedPeople: wsnForcedPeople,
    maxPeople:    wsnMaxPeople,
    maxHours:     wsnMaxHours,
    maxTurnos:    wsnMaxTurnos,
  }
  const personOverrides: PersonOverrides = {
    disabledPeople,
    forcedToWsn:  personForcedWsn,
    availability: personAvailability,
  }

  const allPersonNames = useMemo(() => {
    const s = new Set<string>()
    for (const ppl of Object.values(peopleByWsn)) for (const p of ppl) s.add(p)
    if (personRows) for (const r of personRows) s.add(r.person)
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
  }, [peopleByWsn, personRows])

  const allWsnKeys = useMemo(
    () => [...rows.map(r => r.wsn)].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })),
    [rows]
  )

  const handleCtxWsn = useCallback((e: React.MouseEvent, wsn: string) => {
    const isBottleneck = rows.find(r => r.wsn === wsn)?.bottleneck ?? false
    setCtxMenu({ type: 'wsn', wsn, isBottleneck: !!isBottleneck, x: e.clientX, y: e.clientY })
  }, [rows])

  const handleCtxPerson = useCallback((e: React.MouseEvent, person: string) => {
    setCtxMenu({ type: 'person', person, x: e.clientX, y: e.clientY })
  }, [])

  const handleCtxPair = useCallback((e: React.MouseEvent, wsn: string, person: string) => {
    setCtxMenu({ type: 'pair', wsn, person, x: e.clientX, y: e.clientY })
  }, [])

  const color   = VIEW_COLOR[viewMode]
  const bgLight = VIEW_BG_LIGHT[viewMode]

  function changeView(v: ViewMode) {
    if (v === viewMode || fading) return
    setFading(true)
    setTimeout(() => { setViewMode(v); setFading(false) }, 120)
  }

  useEffect(() => {
    const VIEWS: ViewMode[] = ['wsn', 'person']
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const i = VIEWS.indexOf(viewMode)
      changeView(e.key === 'ArrowLeft'
        ? VIEWS[(i - 1 + VIEWS.length) % VIEWS.length]
        : VIEWS[(i + 1) % VIEWS.length]
      )
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [viewMode, fading]) // eslint-disable-line react-hooks/exhaustive-deps

  const sortedRows = [...rows].sort((a, b) =>
    sortMode === 'demand'
      ? b.demand_h - a.demand_h
      : a.wsn.localeCompare(b.wsn, 'pt-BR', { numeric: true, sensitivity: 'base' })
  )

  const allPersonKeys = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const [wsn, people] of Object.entries(peopleByWsn)) {
      for (const p of people) {
        if (!map[p]) map[p] = []
        if (!map[p].includes(wsn)) map[p].push(wsn)
      }
    }
    return Object.keys(map)
  }, [peopleByWsn])

  const effectiveMappedDays: number | null = mappedDays ?? null

  const effectiveAllocations = useMemo(() => {
    if (!allocations || Object.keys(wsnSwaps).length === 0) return allocations
    const result: Record<string, Record<string, number>> = { ...allocations }
    for (const [wsn, swaps] of Object.entries(wsnSwaps)) {
      if (!swaps?.length) continue
      const base = { ...(allocations[wsn] ?? {}) }
      for (const s of swaps) {
        if (s.removed) delete base[s.removed]
        if (s.hours > 0) base[s.added] = s.hours
      }
      result[wsn] = base
    }
    return result
  }, [allocations, wsnSwaps])

  const effectiveOtAllocations = useMemo(() => {
    if (!otAllocations || Object.keys(wsnSwaps).length === 0) return otAllocations
    const result: Record<string, Record<string, number>> = { ...otAllocations }
    for (const [wsn, swaps] of Object.entries(wsnSwaps)) {
      if (!swaps?.length) continue
      const base = { ...(otAllocations[wsn] ?? {}) }
      for (const s of swaps) {
        if (s.removed) delete base[s.removed]
      }
      result[wsn] = base
    }
    return result
  }, [otAllocations, wsnSwaps])

  const allExpandKeys  = viewMode === 'wsn' ? sortedRows.map(r => r.wsn) : allPersonKeys
  const expandedSet    = viewMode === 'wsn' ? expandedWsns : expandedPersons
  const allExpanded    = allExpandKeys.length > 0 && allExpandKeys.every(k => expandedSet.has(k))

  useEffect(() => { onDisabledWsnsChange?.(disabledWsns) }, [disabledWsns])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onIgnoredWsnsChange?.(ignoredBottlenecks) }, [ignoredBottlenecks]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onWsnMaxPeopleChange?.(wsnMaxPeople) }, [wsnMaxPeople])    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onWsnMaxHoursChange?.(wsnMaxHours) }, [wsnMaxHours])       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onWsnMaxTurnosChange?.(wsnMaxTurnos) }, [wsnMaxTurnos])    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onPersonAvailabilityChange?.(personAvailability) }, [personAvailability]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onDisabledPeopleChange?.(disabledPeople) }, [disabledPeople]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRestrictedCardsChange?.(restrictedCards) }, [restrictedCards]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFixedCardsChange?.(fixedCards) }, [fixedCards]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleExpandAll() {
    if (viewMode === 'wsn') {
      setExpandedWsns(allExpanded ? new Set() : new Set(allExpandKeys))
    } else {
      setExpandedPersons(allExpanded ? new Set() : new Set(allExpandKeys))
    }
  }

  function navigateToPerson(person: string) {
    setExpandedPersons(prev => new Set([...prev, person]))
    setScrollTarget(person)
    if (viewMode !== 'person') changeView('person')
  }

  function navigateToWsn(wsn: string) {
    setExpandedWsns(prev => new Set([...prev, wsn]))
    setScrollTarget(wsn)
    if (viewMode !== 'wsn') changeView('wsn')
  }

  useEffect(() => {
    if (!scrollTarget || fading) return
    const timer = setTimeout(() => {
      const el = tableContainerRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(scrollTarget)}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.transition = 'outline 0s'
        el.style.outline = '2px solid currentColor'
        el.style.outlineOffset = '-2px'
        setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 1000)
      }
      setScrollTarget(null)
    }, 160)
    return () => clearTimeout(timer)
  }, [scrollTarget, fading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function up() { isDraggingRef.current = false }
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [])

  function onCardPaintDown(wsn: string, person: string) {
    if (!activeToolMode) return
    isDraggingRef.current = true
    const key = `${wsn}::${person}`
    if (activeToolMode === 'restrict') {
      const isAlready = restrictedCards.has(key)
      dragActionRef.current = isAlready ? 'remove' : 'add'
      setFixedCards(prev => { const n = new Set(prev); n.delete(key); return n })
      setRestrictedCards(prev => { const n = new Set(prev); if (isAlready) n.delete(key); else n.add(key); return n })
    } else {
      const isAlready = fixedCards.has(key)
      dragActionRef.current = isAlready ? 'remove' : 'add'
      setRestrictedCards(prev => { const n = new Set(prev); n.delete(key); return n })
      setFixedCards(prev => { const n = new Set(prev); if (isAlready) n.delete(key); else n.add(key); return n })
    }
  }

  function onCardPaintEnter(wsn: string, person: string) {
    if (!activeToolMode || !isDraggingRef.current) return
    const key = `${wsn}::${person}`
    if (activeToolMode === 'restrict') {
      if (dragActionRef.current === 'add') setFixedCards(prev => { const n = new Set(prev); n.delete(key); return n })
      setRestrictedCards(prev => { const n = new Set(prev); if (dragActionRef.current === 'add') n.add(key); else n.delete(key); return n })
    } else {
      if (dragActionRef.current === 'add') setRestrictedCards(prev => { const n = new Set(prev); n.delete(key); return n })
      setFixedCards(prev => { const n = new Set(prev); if (dragActionRef.current === 'add') n.add(key); else n.delete(key); return n })
    }
  }

  function onRestrictAllByWsn(wsn: string) {
    if (activeToolMode !== 'restrict') return
    const skilled = new Set<string>([
      ...(peopleByWsn[wsn] ?? []),
      ...Object.keys(allocations?.[wsn] ?? {}),
    ])
    if (skilled.size === 0) return
    const allRestricted = [...skilled].every(person => restrictedCards.has(`${wsn}::${person}`))
    if (allRestricted) {
      setRestrictedCards(prev => { const n = new Set(prev); for (const person of skilled) n.delete(`${wsn}::${person}`); return n })
      return
    }
    setFixedCards(prev => { const n = new Set(prev); for (const person of skilled) n.delete(`${wsn}::${person}`); return n })
    setRestrictedCards(prev => { const n = new Set(prev); for (const person of skilled) n.add(`${wsn}::${person}`); return n })
  }

  function onRestrictAllByPerson(person: string) {
    if (activeToolMode !== 'restrict') return
    const wsns = new Set<string>([
      ...Object.entries(allocations ?? {}).filter(([, people]) => person in people).map(([wsn]) => wsn),
      ...Object.entries(peopleByWsn).filter(([, people]) => people.includes(person)).map(([wsn]) => wsn),
    ])
    if (wsns.size === 0) return
    const allRestricted = [...wsns].every(wsn => restrictedCards.has(`${wsn}::${person}`))
    if (allRestricted) {
      setRestrictedCards(prev => { const n = new Set(prev); for (const wsn of wsns) n.delete(`${wsn}::${person}`); return n })
      return
    }
    setFixedCards(prev => { const n = new Set(prev); for (const wsn of wsns) n.delete(`${wsn}::${person}`); return n })
    setRestrictedCards(prev => { const n = new Set(prev); for (const wsn of wsns) n.add(`${wsn}::${person}`); return n })
  }

  function resetAllOptimizationEffects() {
    setActiveToolMode(null)
    setShowRestricted(true)
    setRestrictedCards(new Set())
    setFixedCards(new Set())
    setDisabledWsns(new Set())
    setIgnoredBottlenecks(new Set())
    setWsnForcedPeople({})
    setWsnMaxPeople({})
    setWsnMaxHours({})
    setWsnMaxTurnos({})
    setDisabledPeople(new Set())
    setPersonForcedWsn({})
    setPersonAvailability({})
    setDirectPairHeadcount({})
    setFixedPairOtPct({})
    setMaxPairPct({})
    setMaxPairOtPct({})
    setOverridePanel(null)
    setCtxMenu(null)
  }

  function toggleWsn(wsn: string) {
    setExpandedWsns(prev => { const next = new Set(prev); if (next.has(wsn)) next.delete(wsn); else next.add(wsn); return next })
  }

  function togglePerson(person: string) {
    setExpandedPersons(prev => { const next = new Set(prev); if (next.has(person)) next.delete(person); else next.add(person); return next })
  }

  const totalDemand = rows.reduce((s, r) => {
    if (disabledWsns.has(r.wsn)) return s
    if (ignoredBottlenecks.has(r.wsn)) return s + r.demand_h - Math.max(0, r.demand_h - r.allocated_h)
    return s + r.demand_h
  }, 0)
  const totalAllocated    = rows.reduce((s, r) => s + r.allocated_h, 0)
  const totalOvertime     = rows.reduce((s, r) => s + r.overtime_h,  0)
  const bottleneckCount    = rows.filter(r => r.bottleneck && !disabledWsns.has(r.wsn) && !ignoredBottlenecks.has(r.wsn)).length
  const bottleneckItemQty  = rows.filter(r => r.bottleneck && !disabledWsns.has(r.wsn) && !ignoredBottlenecks.has(r.wsn)).reduce((s, r) => s + (r.item_qty ?? 0), 0)
  const deltaHours        = totalDemand - totalAllocated

  const headcountCount = useMemo(() => {
    if (allocations) {
      const s = new Set<string>()
      for (const people of Object.values(allocations)) for (const p of Object.keys(people)) s.add(p)
      return s.size
    }
    const s = new Set<string>()
    for (const people of Object.values(peopleByWsn)) for (const p of people) s.add(p)
    return s.size
  }, [allocations, peopleByWsn])

  const wsnDescMap = useMemo(
    () => Object.fromEntries(rows.map(r => [r.wsn, r.desc])),
    [rows]
  )

  return (
    <>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-lg shadow-2xl flex flex-col w-[94vw] max-w-6xl h-[88vh] overflow-hidden">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-4 py-2.5 shrink-0"
          style={{ backgroundColor: color, transition: 'background-color 0.15s' }}
        >
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm text-white tracking-wide leading-tight">
              Resultado da Otimização
            </span>
            {statusLabel && (
              <span className="text-[11px] text-white/80 leading-tight truncate">{statusLabel}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 ml-3 hover:bg-white/20 transition-colors shrink-0"
            title="Fechar"
          >
            <X size={16} className="text-white" />
          </button>
        </div>

        {/* ── View mode toggle ─────────────────────────────────────────────── */}
        <div className="flex items-stretch bg-gray-100 border-b border-gray-300 shrink-0">
          <button
            onClick={() => { const vs: ViewMode[] = ['wsn','person']; const i = vs.indexOf(viewMode); changeView(vs[(i-1+vs.length)%vs.length]) }}
            className="px-2.5 flex items-center hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700 shrink-0 border-r border-gray-300"
            title="Vista anterior (←)"
          >
            <ChevronLeft size={14} />
          </button>
          {(['wsn', 'person'] as ViewMode[]).map(v => {
            const isActive = v === viewMode
            const col = VIEW_COLOR[v]
            const bg  = VIEW_BG_LIGHT[v]
            return (
              <button
                key={v}
                onClick={() => changeView(v)}
                className="flex-1 flex flex-col items-center justify-center px-4 py-2 text-xs font-semibold transition-all border-r border-gray-300 last:border-r-0 select-none whitespace-nowrap"
                style={{
                  borderBottom:    isActive ? `3px solid ${col}` : '3px solid transparent',
                  backgroundColor: isActive ? bg : 'transparent',
                  color:           isActive ? col : '#6b7280',
                }}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full mb-0.5"
                  style={{ backgroundColor: col, opacity: isActive ? 1 : 0.4 }}
                />
                {VIEW_LABEL[v]}
              </button>
            )
          })}
          <button
            onClick={() => { const vs: ViewMode[] = ['wsn','person']; const i = vs.indexOf(viewMode); changeView(vs[(i+1)%vs.length]) }}
            className="px-2.5 flex items-center hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700 shrink-0 border-l border-gray-300"
            title="Próxima vista (→)"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* ── Toolbar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-200 shrink-0 bg-white">
          <ToolButton
            active={showParams}
            title="Editar parâmetros da otimização"
            onClick={() => setShowParams(v => !v)}
            color={color}
          >
            <Settings size={12} />
            Parâmetros
          </ToolButton>

          <ToolButton
            title="Recalcular com os parâmetros atuais"
            onClick={() => setConfirmAction('recalculate')}
            color={color}
          >
            <RefreshCw size={12} />
            Recalcular
          </ToolButton>

          <ToolButton
            title={allExpanded ? 'Recolher todas as linhas' : 'Expandir todas as linhas'}
            active={allExpanded}
            onClick={handleExpandAll}
            color={color}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
            {allExpanded ? 'Recolher' : 'Expandir'}
          </ToolButton>

          <ToolButton
            title={sortMode === 'demand' ? 'Ordenando por demanda — clique para ordenar alfabético' : 'Ordenando alfabético — clique para ordenar por demanda'}
            onClick={() => setSortMode(v => v === 'demand' ? 'alpha' : 'demand')}
            className="min-w-[138px] justify-center"
            color={color}
          >
            <ArrowUpDown size={12} />
            {sortMode === 'demand' ? 'Ordenar: Demanda' : 'Ordenar: Alfabética'}
          </ToolButton>

          <div className="ml-auto flex items-center gap-1 pl-2 border-l border-gray-200">
            <ToolButton
              active={activeToolMode === 'restrict'}
              title={activeToolMode === 'restrict' ? 'Modo restringir ativo — clique para sair' : 'Clique ou arraste sob cards para restringi-las na wsn'}
              onClick={() => setActiveToolMode(v => v === 'restrict' ? null : 'restrict')}
              color={color}
            >
              <Ban size={11} />
              Restringir
            </ToolButton>
            <ToolButton
              active={activeToolMode === 'fix'}
              title={activeToolMode === 'fix' ? 'Modo fixar ativo — clique para sair' : 'Clique ou arraste sob cards para forçar alocação máxima na wsn'}
              onClick={() => setActiveToolMode(v => v === 'fix' ? null : 'fix')}
              color={color}
            >
              <Lock size={11} />
              Fixar
            </ToolButton>
            <ToolButton
              active={!showRestricted}
              title={showRestricted ? 'Ocultar cards restritos e pessoas desativadas' : 'Exibir cards restritos e pessoas desativadas'}
              onClick={() => setShowRestricted(v => !v)}
              className="min-w-[86px] justify-center"
              color={color}
            >
              {showRestricted ? <Eye size={11} /> : <EyeOff size={11} />}
              {showRestricted ? 'Ocultar' : 'Exibir'}
            </ToolButton>
            <ToolButton
              title="Resetar efeitos locais (restringir, fixar, disponibilidade e limites)"
              onClick={() => setConfirmAction('reset_overrides')}
              color={color}
            >
              <RotateCcw size={11} />
              Resetar
            </ToolButton>
          </div>
        </div>

        {showParams && (
          <ParamsPanel
            params={editParams}
            onChange={setEditParams}
            onReset={() => setConfirmAction('reset')}
            accentColor={color}
          />
        )}

        {/* ── Info bar ────────────────────────────────────────────────────── */}
        <div
          className="px-4 py-1.5 flex items-center gap-3 text-xs shrink-0 flex-wrap"
          style={{ backgroundColor: bgLight, transition: 'background-color 0.15s' }}
        >
          <span
            className="font-bold whitespace-nowrap shrink-0"
            style={{ color, transition: 'color 0.15s', minWidth: 116 }}
          >
            {VIEW_LABEL[viewMode]}
          </span>
          <span className="text-gray-500 whitespace-nowrap">
            Workstations: <strong className="text-gray-800">{rows.length}</strong>
          </span>
          {headcountCount > 0 && (
            <span className="text-gray-500 whitespace-nowrap">
              Headcount: <strong className="text-gray-800">{fmt0(headcountCount)}</strong>
            </span>
          )}
          {effectiveMappedDays != null && effectiveMappedDays > 0 && (
            <span className="text-gray-500 whitespace-nowrap">
              Dias: <strong className="text-gray-800">{Math.round(effectiveMappedDays)}</strong>
            </span>
          )}
          {rows.length > 0 && <span className="h-3.5 w-px bg-gray-300 shrink-0" />}
          {rows.length > 0 && (
            <>
              <span className="text-gray-500 whitespace-nowrap">
                Demanda: <strong className="text-gray-800">{fmt1(totalDemand)} h</strong>
              </span>
              {!isSkillMatrix && <span className="text-gray-500 whitespace-nowrap">
                Alocado: <strong className="text-gray-800">{fmt1(totalAllocated)} h</strong>
              </span>}
              {!isSkillMatrix && <span className="whitespace-nowrap font-semibold" style={{ color: deltaHours > 0.05 ? '#C62828' : '#1B5E20' }}>
                Δ {deltaHours > 0.05 ? `−${fmt1(deltaHours)}` : '0,0'} h
              </span>}
              {!isSkillMatrix && totalOvertime > 0 && (
                <span className="font-semibold whitespace-nowrap" style={{ color: '#B45309' }}>
                  OT: {fmt1(totalOvertime)} h
                </span>
              )}
              {!isSkillMatrix && <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap"
                    style={{ color: bottleneckCount > 0 ? '#C62828' : '#1B5E20' }}>
                {bottleneckCount > 0
                  ? <img src="/imagens/warning.png" alt="" style={{ width: 11, height: 11, opacity: 0.85 }} />
                  : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                }
                {bottleneckCount} gargalo{bottleneckCount !== 1 ? 's' : ''}
              </span>}
            </>
          )}
          {editParams && rows.length > 0 && (
            <span className="ml-auto text-gray-400 border-l border-gray-200 pl-3 whitespace-nowrap">
              TOP: <strong className="text-gray-600">{editParams.top_pct}%</strong>
              <span className="mx-1.5">|</span>
              GAP: <strong className="text-gray-600">{editParams.optimization_gap_pct}%</strong>
              <span className="mx-1.5">|</span>
              Fases: <strong className="text-gray-600">{editParams.optimization_phase_limit}</strong>
            </span>
          )}
        </div>

        {/* ── Table / content ─────────────────────────────────────────────── */}
        <div
          ref={tableContainerRef}
          className="flex-1 overflow-auto"
          style={{ opacity: fading ? 0 : 1, transition: 'opacity 0.12s ease' }}
        >
          {viewMode === 'wsn' ? (
            <WsnTable
              rows={sortedRows}
              color={color}
              bgLight={bgLight}
              peopleByWsn={peopleByWsn}
              expanded={expandedWsns}
              onToggle={toggleWsn}
              allocations={effectiveAllocations}
              otAllocations={effectiveOtAllocations}
              wsnShiftInfo={wsnShiftInfo}
              expertise={expertise}
              requiredLevel={requiredLevel}
              mappedDays={effectiveMappedDays}
              topPct={editParams?.top_pct ?? 90}
              wsnOverrides={wsnOverrides}
              onContextMenuWsn={handleCtxWsn}
              isSkillMatrix={isSkillMatrix}
              onNavigateToPerson={navigateToPerson}
              activeToolMode={activeToolMode}
              restrictedCards={restrictedCards}
              fixedCards={fixedCards}
              showRestricted={showRestricted}
              onCardPaintDown={onCardPaintDown}
              onCardPaintEnter={onCardPaintEnter}
              onRestrictAllByWsn={onRestrictAllByWsn}
              onCardContextMenu={handleCtxPair}
            />
          ) : (
            <PersonTable
              peopleByWsn={peopleByWsn}
              personRows={personRows}
              wsnDescMap={wsnDescMap}
              color={color}
              bgLight={bgLight}
              expanded={expandedPersons}
              onToggle={togglePerson}
              mappedDays={effectiveMappedDays}
              topPct={editParams?.top_pct ?? 90}
              allocations={effectiveAllocations}
              otAllocations={effectiveOtAllocations}
              personOverrides={personOverrides}
              allWsns={allWsnKeys}
              onContextMenuPerson={handleCtxPerson}
              sortMode={sortMode}
              isSkillMatrix={isSkillMatrix}
              onNavigateToWsn={navigateToWsn}
              activeToolMode={activeToolMode}
              restrictedCards={restrictedCards}
              fixedCards={fixedCards}
              showRestricted={showRestricted}
              onCardPaintDown={onCardPaintDown}
              onCardPaintEnter={onCardPaintEnter}
              onRestrictAllByPerson={onRestrictAllByPerson}
              onCardContextMenu={handleCtxPair}
              wsnShiftInfo={wsnShiftInfo}
              expertise={expertise}
              requiredLevel={requiredLevel}
            />
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2 border-t border-gray-200 bg-gray-50">
          {onToggleSkillMatrix && (
            <button
              title={isSkillMatrix ? 'Modo atual: Matriz de Skill — clique para Otimização' : 'Modo atual: Otimização — clique para Matriz de Skill'}
              onClick={onToggleSkillMatrix}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border font-medium transition-colors hover:bg-gray-100"
              style={{ borderColor: color + '88', color: color }}
            >
              {isSkillMatrix ? 'Matriz de Skill' : 'Otimização'}
            </button>
          )}
          <button
            title="Exportar resultados para CSV"
            onClick={() => {
              const topPct = editParams?.top_pct ?? 90
              const capH   = mappedDays && mappedDays > 0 ? 8.8 * (topPct / 100) * mappedDays : null
              if (viewMode === 'wsn') {
                const headers = ['Workstation', 'Descrição', 'Demanda (h)', 'Alocado (h)', 'Overtime (h)', 'Utilização (%)', 'Headcount']
                const csvRows: (string | number | null)[][] = []
                for (const r of sortedRows) {
                  const hc = capH && capH > 0 ? r.allocated_h / capH : (peopleByWsn[r.wsn]?.length ?? r.headcount)
                  csvRows.push([r.wsn, r.desc, r.demand_h, r.allocated_h, r.overtime_h, r.utilization_pct, hc])
                  const allocForWsn = allocations?.[r.wsn]
                  if (allocForWsn) {
                    const cards = Object.entries(allocForWsn)
                      .map(([p, allocH]) => ({ p, allocH, otH: otAllocations?.[r.wsn]?.[p] ?? 0 }))
                      .sort((a, b) => b.allocH - a.allocH)
                    for (const c of cards) {
                      csvRows.push([`  ↳ ${c.p}`, '', null, c.allocH, c.otH, null, null])
                    }
                  }
                }
                downloadCsv('resultados_workstation.csv', headers, csvRows)
              } else {
                const headers = ['Pessoa', 'Capacidade (h)', 'Alocado (h)', 'Overtime (h)', 'Utilização (%)', 'Workstations']
                const csvRows: (string | number | null)[][] = []
                const allP = personRows?.map(r => r.person)
                  ?? Object.keys(Object.fromEntries(
                      Object.entries(peopleByWsn).flatMap(([, ppl]) => ppl.map(p => [p, true]))
                    )).sort()
                for (const person of allP) {
                  const data    = personRows?.find(r => r.person === person)
                  const pCapH   = capH
                  const pAlloc  = data?.allocated_h ?? null
                  const pOt     = data?.overtime_h  ?? null
                  const pUtil   = data?.utilization_pct ?? null
                  const wsnCards = allocations != null
                    ? Object.entries(allocations)
                        .filter(([, ppl]) => person in ppl)
                        .map(([wsn, ppl]) => ({ wsn, allocH: ppl[person], otH: otAllocations?.[wsn]?.[person] ?? 0 }))
                        .sort((a, b) => b.allocH - a.allocH)
                    : null
                  const wsnCount = wsnCards ? wsnCards.length : (data?.wsns.length ?? 0)
                  csvRows.push([person, pCapH, pAlloc, pOt, pUtil, wsnCount])
                  if (wsnCards) {
                    for (const c of wsnCards) {
                      csvRows.push([`  ↳ ${c.wsn}${wsnDescMap[c.wsn] ? ' — ' + wsnDescMap[c.wsn] : ''}`, null, c.allocH, c.otH, null, null])
                    }
                  }
                }
                downloadCsv('resultados_pessoas.csv', headers, csvRows)
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border font-medium transition-colors hover:bg-gray-100"
            style={{ borderColor: color + '88', color: color }}
          >
            <Download size={12} />
            Exportar
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-white rounded font-medium transition-colors"
            style={{ backgroundColor: color }}
          >
            Fechar
          </button>
        </div>

        {/* ── Confirm overlay ──────────────────────────────────────────────── */}
        {confirmAction === 'recalculate' && (
          <ConfirmMini
            message="Recalcular otimização?"
            detail="O solver será executado novamente com os parâmetros e overrides atuais."
            confirmLabel="Recalcular"
            onConfirm={() => {
              const disabledWsnDemand: Record<string, number> = {}
              for (const wsn of disabledWsns) disabledWsnDemand[wsn] = 0

              const blockedPairs: Array<[string, string]> = []
              const requiredPairs: Array<[string, string]> = []
              for (const key of restrictedCards) {
                if (fixedCards.has(key)) continue
                const [wsn, person] = key.split('::')
                if (!wsn || !person) continue
                blockedPairs.push([wsn, person])
              }

              const forcedPairHeadcount: Record<string, number> = {}
              for (const key of fixedCards) {
                const [wsn, person] = key.split('::')
                if (!wsn || !person) continue
                requiredPairs.push([wsn, person])
                forcedPairHeadcount[`${wsn}|${person}`] = 100
              }

              const directPairHeadcountPayload: Record<string, number> = {}
              for (const [k, v] of Object.entries(directPairHeadcount)) {
                const [wsn, person] = k.split('::')
                if (!wsn || !person) continue
                directPairHeadcountPayload[`${wsn}|${person}`] = v
              }

              const fixedPairOtPctPayload: Record<string, number> = {}
              for (const [k, v] of Object.entries(fixedPairOtPct)) {
                const [wsn, person] = k.split('::')
                if (!wsn || !person) continue
                fixedPairOtPctPayload[`${wsn}|${person}`] = v
              }

              const maxPairPctPayload: Record<string, number> = {}
              for (const [k, v] of Object.entries(maxPairPct)) {
                const [wsn, person] = k.split('::')
                if (!wsn || !person) continue
                maxPairPctPayload[`${wsn}|${person}`] = v
              }

              const maxPairOtPctPayload: Record<string, number> = {}
              for (const [k, v] of Object.entries(maxPairOtPct)) {
                const [wsn, person] = k.split('::')
                if (!wsn || !person) continue
                maxPairOtPctPayload[`${wsn}|${person}`] = v
              }

              onRecalculate?.(editParams, {
                disabledWsnDemand,
                wsnMaxPeople:       wsnMaxPeople,
                wsnMaxHours:        wsnMaxHours,
                wsnMaxTurnos:       wsnMaxTurnos,
                personAvailability: personAvailability,
                disabledPeople:     [...disabledPeople],
                blockedPairs,
                requiredPairs,
                forcedPairHeadcount,
                directPairHeadcount: directPairHeadcountPayload,
                fixedPairOtPct: fixedPairOtPctPayload,
                maxPairPct: maxPairPctPayload,
                maxPairOtPct: maxPairOtPctPayload,
              })
              // After recalculating with disabled people, default to hidden state
              if (disabledPeople.size > 0) setShowRestricted(false)
              setConfirmAction(null)
            }}
            onCancel={() => setConfirmAction(null)}
          />
        )}
        {confirmAction === 'reset' && (
          <ConfirmMini
            message="Resetar parâmetros?"
            detail="Os valores serão restaurados para os parâmetros originais desta sessão."
            confirmLabel="Resetar"
            onConfirm={() => { setEditParams(savedParams); setConfirmAction(null) }}
            onCancel={() => setConfirmAction(null)}
          />
        )}
        {confirmAction === 'reset_overrides' && (
          <ConfirmMini
            message="Resetar efeitos locais?"
            detail="As restrições, fixações, disponibilidades e limites definidos localmente serão removidos."
            confirmLabel="Resetar"
            onConfirm={() => { resetAllOptimizationEffects(); setConfirmAction(null) }}
            onCancel={() => setConfirmAction(null)}
          />
        )}

        {/* ── Inline override panels ─────────────────────────────────────── */}
        {overridePanel?.kind === 'allocatePeopleToWsn' && (() => {
          const skilled = new Set(peopleByWsn[overridePanel.wsn] ?? [])
          const allocMap = effectiveAllocations?.[overridePanel.wsn] ?? {}
          const otMap = effectiveOtAllocations?.[overridePanel.wsn] ?? {}
          const allocated = new Set<string>()
          for (const [person, hrs] of Object.entries(allocMap)) {
            if ((Number(hrs) || 0) > 0.01) allocated.add(person)
          }
          for (const [person, hrs] of Object.entries(otMap)) {
            if ((Number(hrs) || 0) > 0.01) allocated.add(person)
          }
          const restricted = new Set<string>()
          const keyPrefix = `${overridePanel.wsn}::`
          for (const key of restrictedCards) {
            if (!key.startsWith(keyPrefix)) continue
            restricted.add(key.slice(keyPrefix.length))
          }
          const fixedInWsn = new Set<string>()
          for (const key of fixedCards) {
            if (!key.startsWith(keyPrefix)) continue
            fixedInWsn.add(key.slice(keyPrefix.length))
          }
          const allPeopleForWsnPanel = Array.from(new Set([
            ...allPersonNames,
            ...Array.from(skilled),
            ...Array.from(allocated),
            ...Array.from(restricted),
            ...Array.from(fixedInWsn),
            ...(wsnForcedPeople[overridePanel.wsn] ?? []),
          ])).sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
          const si = wsnShiftInfo?.[overridePanel.wsn]
          const maxSelectable = wsnMaxPeople[overridePanel.wsn]
            ?? (si && si.lm > 0 ? si.lm * Math.max(1, si.turnos) : undefined)
          return (
            <PanelAllocatePeople
              title={`Alocar pessoas → ${overridePanel.wsn}`}
              subtitle={wsnDescMap[overridePanel.wsn] || undefined}
              allItems={allPeopleForWsnPanel}
              skilled={skilled}
              allocated={allocated}
              restricted={restricted}
              current={wsnForcedPeople[overridePanel.wsn] ?? []}
              accentColor={VIEW_COLOR.wsn}
              maxSelectable={maxSelectable}
              onSave={ppl => {
                const wsn = overridePanel.wsn
                const prev = wsnForcedPeople[wsn] ?? []

                // Respect max people limit: keep existing forced, then add new ones up to limit.
                const maxPpl = wsnMaxPeople[wsn]
                let finalPpl = ppl
                if (maxPpl != null && ppl.length > maxPpl) {
                  const prevSet = new Set(prev)
                  const kept    = ppl.filter(p => prevSet.has(p))
                  const newOnes = ppl.filter(p => !prevSet.has(p))
                  const slots   = Math.max(0, maxPpl - kept.length)
                  finalPpl = [...kept, ...newOnes.slice(0, slots)]
                }

                setWsnForcedPeople(prevMap => ({ ...prevMap, [wsn]: finalPpl }))
                // Un-restrict anyone being explicitly added
                setRestrictedCards(prevSet => {
                  const n = new Set(prevSet)
                  for (const person of finalPpl) n.delete(`${wsn}::${person}`)
                  return n
                })
                // Fix new people; un-fix those removed from the forced list
                setFixedCards(prevSet => {
                  const n = new Set(prevSet)
                  for (const person of prev)     n.delete(`${wsn}::${person}`)
                  for (const person of finalPpl) n.add(`${wsn}::${person}`)
                  return n
                })
                // Visual swap: immediately preview the new allocation
                const baseAlloc = allocations?.[wsn] ?? {}
                const baseVisible = Object.entries(baseAlloc).filter(([, h]) => (h ?? 0) > 0.01)
                const inBase = new Set(baseVisible.map(([p]) => p))
                const newPeople = finalPpl.filter(p => !inBase.has(p))
                const newSwaps: Array<{ removed: string; added: string; hours: number }> = []
                const alreadyRemoved = new Set<string>()
                for (const newPerson of newPeople) {
                  const candidates = baseVisible
                    .filter(([p]) =>
                      !finalPpl.includes(p) &&
                      !fixedCards.has(`${wsn}::${p}`) &&
                      !alreadyRemoved.has(p)
                    )
                    .sort((a, b) => a[1] - b[1])
                  if (candidates.length > 0) {
                    const [removedPerson, removedHrs] = candidates[0]
                    newSwaps.push({ removed: removedPerson, added: newPerson, hours: removedHrs })
                    alreadyRemoved.add(removedPerson)
                  } else {
                    const avg = baseVisible.length > 0
                      ? baseVisible.reduce((s, [, h]) => s + h, 0) / baseVisible.length : 0
                    if (avg > 0) newSwaps.push({ removed: '', added: newPerson, hours: avg })
                  }
                }
                setWsnSwaps(prev => {
                  const updated = { ...prev }
                  if (newSwaps.length > 0) updated[wsn] = newSwaps
                  else delete updated[wsn]
                  return updated
                })
              }}
              onClose={() => setOverridePanel(null)}
            />
          )
        })()}
        {overridePanel?.kind === 'limitesForWsn' && (
          <PanelLimites
            title={`Limites — ${overridePanel.wsn}`}
            subtitle={wsnDescMap[overridePanel.wsn] || undefined}
            maxPeople={wsnMaxPeople[overridePanel.wsn] ?? null}
            maxHours={wsnMaxHours[overridePanel.wsn] ?? null}
            maxTurnos={wsnMaxTurnos[overridePanel.wsn] ?? null}
            topPct={editParams.top_pct}
            accentColor={VIEW_COLOR.wsn}
            textColor={VIEW_COLOR.wsn}
            onSave={(people, hours, turnos) => {
              const wsn = overridePanel.wsn
              setWsnMaxPeople(prev => { const n = { ...prev }; if (people != null) n[wsn] = people; else delete n[wsn]; return n })
              setWsnMaxHours(prev => { const n = { ...prev }; if (hours != null) n[wsn] = hours; else delete n[wsn]; return n })
              setWsnMaxTurnos(prev => { const n = { ...prev }; if (turnos != null) n[wsn] = turnos; else delete n[wsn]; return n })
            }}
            onClear={() => {
              const wsn = overridePanel.wsn
              setWsnMaxPeople(prev => { const n = { ...prev }; delete n[wsn]; return n })
              setWsnMaxHours(prev => { const n = { ...prev }; delete n[wsn]; return n })
              setWsnMaxTurnos(prev => { const n = { ...prev }; delete n[wsn]; return n })
            }}
            onClose={() => setOverridePanel(null)}
          />
        )}
        {overridePanel?.kind === 'allocatePersonToWsn' && (() => {
          const skilled = new Set(
            Object.entries(peopleByWsn)
              .filter(([, ppl]) => ppl.includes(overridePanel.person))
              .map(([wsn]) => wsn)
          )
          const selectedPerson = overridePanel.person
          const allocWsns = new Set<string>()
          for (const [wsn, pMap] of Object.entries(allocations ?? {})) {
            if ((Number((pMap ?? {})[selectedPerson]) || 0) > 0.01) allocWsns.add(wsn)
          }
          for (const [wsn, pMap] of Object.entries(otAllocations ?? {})) {
            if ((Number((pMap ?? {})[selectedPerson]) || 0) > 0.01) allocWsns.add(wsn)
          }
          const restrictedWsns = new Set<string>()
          for (const key of restrictedCards) {
            const [wsn, person] = key.split('::')
            if (person === selectedPerson && wsn) restrictedWsns.add(wsn)
          }
          const fixedWsns = new Set<string>()
          for (const key of fixedCards) {
            const [wsn, person] = key.split('::')
            if (person === selectedPerson && wsn) fixedWsns.add(wsn)
          }
          const allWsnsForPerson = Array.from(new Set([
            ...allWsnKeys,
            ...Array.from(skilled),
            ...Array.from(allocWsns),
            ...Array.from(restrictedWsns),
            ...Array.from(fixedWsns),
            ...(personForcedWsn[selectedPerson] ?? []),
          ])).sort((a, b) =>
            a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })
          )
          return (
            <PanelAllocatePeople
              title={`Alocar ${overridePanel.person} → workstations`}
              allItems={allWsnsForPerson}
              descMap={wsnDescMap}
              skilled={skilled}
              allocated={allocWsns}
              restricted={restrictedWsns}
              current={personForcedWsn[overridePanel.person] ?? []}
              accentColor={VIEW_COLOR.person}
              onSave={wsns => {
                const person = overridePanel.person
                const prev = personForcedWsn[person] ?? []
                setPersonForcedWsn(prevMap => ({ ...prevMap, [person]: wsns }))
                setRestrictedCards(prevSet => {
                  const n = new Set(prevSet)
                  for (const wsn of wsns) n.delete(`${wsn}::${person}`)
                  return n
                })
                setFixedCards(prevSet => {
                  const n = new Set(prevSet)
                  for (const wsn of prev) n.delete(`${wsn}::${person}`)
                  for (const wsn of wsns) n.add(`${wsn}::${person}`)
                  return n
                })
              }}
              onClose={() => setOverridePanel(null)}
            />
          )
        })()}
        {overridePanel?.kind === 'availabilityByWeek' && (
          <PanelAvailabilityFull
            person={overridePanel.person}
            selectedFws={selectedFws}
            mappedDays={mappedDays ?? null}
            currentValue={personAvailability[overridePanel.person] ?? null}
            accentColor={VIEW_COLOR.person}
            textColor={VIEW_COLOR.person}
            onSave={v  => setPersonAvailability(prev => ({ ...prev, [overridePanel.person]: v }))}
            onClear={() => setPersonAvailability(prev => { const n = { ...prev }; delete n[overridePanel.person]; return n })}
            onClose={() => setOverridePanel(null)}
          />
        )}
        {overridePanel?.kind === 'editPairRules' && (
          <PanelPairRules
            wsn={overridePanel.wsn}
            person={overridePanel.person}
            desc={wsnDescMap[overridePanel.wsn] || undefined}
            accentColor={viewMode === 'wsn' ? VIEW_COLOR.wsn : VIEW_COLOR.person}
            directPct={directPairHeadcount[`${overridePanel.wsn}::${overridePanel.person}`] ?? null}
            fixedOtPct={fixedPairOtPct[`${overridePanel.wsn}::${overridePanel.person}`] ?? null}
            maxPct={maxPairPct[`${overridePanel.wsn}::${overridePanel.person}`] ?? null}
            maxOtPct={maxPairOtPct[`${overridePanel.wsn}::${overridePanel.person}`] ?? null}
            onSave={({ directPct, fixedOtPct, maxPct, maxOtPct }) => {
              const key = `${overridePanel.wsn}::${overridePanel.person}`
              setDirectPairHeadcount(prev => { const n = { ...prev }; if (directPct == null) delete n[key]; else n[key] = directPct; return n })
              setFixedPairOtPct(prev => { const n = { ...prev }; if (fixedOtPct == null) delete n[key]; else n[key] = fixedOtPct; return n })
              setMaxPairPct(prev => { const n = { ...prev }; if (maxPct == null) delete n[key]; else n[key] = maxPct; return n })
              setMaxPairOtPct(prev => { const n = { ...prev }; if (maxOtPct == null) delete n[key]; else n[key] = maxOtPct; return n })
            }}
            onClear={() => {
              const key = `${overridePanel.wsn}::${overridePanel.person}`
              setDirectPairHeadcount(prev => { const n = { ...prev }; delete n[key]; return n })
              setFixedPairOtPct(prev => { const n = { ...prev }; delete n[key]; return n })
              setMaxPairPct(prev => { const n = { ...prev }; delete n[key]; return n })
              setMaxPairOtPct(prev => { const n = { ...prev }; delete n[key]; return n })
            }}
            onClose={() => setOverridePanel(null)}
          />
        )}

        {/* ── Toast notification ─────────────────────────────────────────── */}
        {toastMsg && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-start gap-2 px-4 py-2.5 rounded-lg shadow-lg text-xs text-white max-w-sm"
               style={{ backgroundColor: '#B45309' }}>
            <span className="flex-1">{toastMsg}</span>
            <button onClick={() => setToastMsg(null)} className="shrink-0 ml-2 opacity-80 hover:opacity-100">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </div>

    {/* ── Context menus (rendered outside modal card to avoid overflow clipping) */}
    {ctxMenu?.type === 'wsn' && (() => {
      const { wsn, isBottleneck, x, y } = ctxMenu
      const isDisabled  = disabledWsns.has(wsn)
      const isIgnored   = ignoredBottlenecks.has(wsn)
      const checkIcon = <img src="/imagens/checked.png" alt="" style={{ width: 12, height: 12 }} />
      const warnIcon  = <img src="/imagens/warning.png" alt="" style={{ width: 12, height: 12 }} />
      const items: CtxMenuItem[] = [
        {
          label:  isDisabled ? 'Reativar workstation' : 'Desativar workstation',
          green:  isDisabled,
          danger: !isDisabled,
          onClick: () => {
            if (isDisabled) {
              setDisabledWsns(prev => { const n = new Set(prev); n.delete(wsn); return n })
            } else {
              setDisabledWsns(prev => { const n = new Set(prev); n.add(wsn); return n })
              setIgnoredBottlenecks(prev => { const n = new Set(prev); n.delete(wsn); return n })
            }
          },
        },
        ...(isBottleneck ? [{
          label:  isIgnored ? 'Restaurar gargalo' : 'Ignorar gargalo',
          icon:   isIgnored ? warnIcon : checkIcon,
          onClick: () => {
            if (isIgnored) {
              setIgnoredBottlenecks(prev => { const n = new Set(prev); n.delete(wsn); return n })
            } else {
              setIgnoredBottlenecks(prev => { const n = new Set(prev); n.add(wsn); return n })
              setDisabledWsns(prev => { const n = new Set(prev); n.delete(wsn); return n })
            }
          },
        }] : []),
        {
          label:   'Alocar pessoas',
          onClick: () => setOverridePanel({ kind: 'allocatePeopleToWsn', wsn }),
        },
        {
          label:   (wsnMaxPeople[wsn] != null || wsnMaxHours[wsn] != null || wsnMaxTurnos[wsn] != null) ? 'Editar Limites' : 'Definir Limites',
          orange:  wsnMaxPeople[wsn] != null || wsnMaxHours[wsn] != null || wsnMaxTurnos[wsn] != null,
          onClick: () => setOverridePanel({ kind: 'limitesForWsn', wsn }),
        },
      ]
      return <ContextMenu x={x} y={y} items={items} onClose={() => setCtxMenu(null)} />
    })()}
    {ctxMenu?.type === 'person' && (() => {
      const { person, x, y } = ctxMenu
      const isDisabled = disabledPeople.has(person)
      const items: CtxMenuItem[] = [
        {
          label:  isDisabled ? 'Reativar pessoa' : 'Desativar pessoa',
          green:  isDisabled,
          danger: !isDisabled,
          onClick: () => setDisabledPeople(prev => { const n = new Set(prev); if (n.has(person)) n.delete(person); else n.add(person); return n }),
        },
        {
          label:   'Alocar a uma workstation',
          onClick: () => setOverridePanel({ kind: 'allocatePersonToWsn', person }),
        },
        {
          label:   personAvailability[person] != null ? 'Editar disponibilidade' : 'Definir disponibilidade',
          orange:  personAvailability[person] != null,
          onClick: () => setOverridePanel({ kind: 'availabilityByWeek', person }),
        },
      ]
      return <ContextMenu x={x} y={y} items={items} onClose={() => setCtxMenu(null)} />
    })()}
    {ctxMenu?.type === 'pair' && (() => {
      const { wsn, person, x, y } = ctxMenu
      const items: CtxMenuItem[] = [
        {
          label: 'Editar',
          onClick: () => setOverridePanel({ kind: 'editPairRules', wsn, person }),
        },
      ]
      return <ContextMenu x={x} y={y} items={items} onClose={() => setCtxMenu(null)} />
    })()}
    </>
  )
}
