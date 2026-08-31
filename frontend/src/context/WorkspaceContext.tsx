/**
 * WorkspaceContext
 *
 * Central shared state for the main workspace.
 * Mirrors the state owned by MainWindow in CapB3356103.py.
 */
'use client'
import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import type React from 'react'
import type { ImportItem, AssemblyDetail } from '@/lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Metadata captured at import time (from ImportModal). */
export interface ImportMeta {
  mode:         'anual' | 'mensal' | 'semanal'
  mes:          number | null          // primary month (null when multi-month)
  meses:        number[]               // all selected months ([] = all months)
  selectedFws:  string[]               // FWs the user had ticked
  allFwsForMes: string[]               // all available FWs for the selected period
  mesFwMap?:    Record<number, string[]> // FWs available per month (for display cross-filter)
}

export interface WorkspaceState {
  /** All items loaded into the workspace (un-filtered). */
  items:         ImportItem[]
  filterClient:  Set<string>
  filterFamily:  Set<string>
  filterTipo:    Set<string>   // empty set = all types
  filterWsn:     Set<string>   // empty set = all workstations

  /** Items after applying all active filters. */
  visibleItems:  ImportItem[]

  /** Available option sets derived from the loaded items. */
  availableClientes:  string[]
  availableFamilias:  string[]
  availableTipos:     string[]

  /** Metadata from last import (null until first import). */
  importMeta:    ImportMeta | null

  /** Assembly scope/hours details fetched after import (keyed by item code). */
  assemblyDetails:    Record<string, AssemblyDetail>
  assemblyLoading:    boolean

  /** WSN → people mapping fetched from /api/wsn-people. */
  peopleByWsn: Record<string, string[]>

  /** Display modes — single-select, no backend call needed for filter UI. */
  headcountMode: 'skill' | 'headcount'
  viewMode:      'semanal' | 'mensal'

  /** Item code currently highlighted (scroll+flash) in the main list. */
  highlightedItem: string | null

  addItems:           (newItems: ImportItem[], meta?: ImportMeta) => void
  /** Append catalog items to existing workspace without resetting anything. Deduplicates by item code. */
  mergeItems:         (newItems: ImportItem[]) => void
  removeItem:         (itemCode: string) => void
  clearItems:         () => void
  setFilterClient:    (f: Set<string>) => void
  setFilterFamily:    (f: Set<string>) => void
  setFilterTipo:      (t: Set<string>) => void
  setFilterWsn:       (w: Set<string>) => void
  resetFilters:       () => void
  setHeadcountMode:   (m: 'skill' | 'headcount') => void
  setViewMode:        (m: 'semanal' | 'mensal') => void
  setHighlightedItem: (code: string | null) => void
  setAssemblyDetails: React.Dispatch<React.SetStateAction<Record<string, AssemblyDetail>>>
  setAssemblyLoading: (loading: boolean) => void
  setPeopleByWsn:     (map: Record<string, string[]>) => void
  /** Total mapped days for the current import period. */
  mappedDays:         number | null
  setMappedDays:      (d: number | null) => void
  /** KPIs from the last successful solver run (null until first solve). */
  solverKpis: { allocatedH: number; overtimeH: number; distinctPeople: number; topPct: number } | null
  setSolverKpis: (kpis: { allocatedH: number; overtimeH: number; distinctPeople: number; topPct: number } | null) => void
  /** Per-WSN allocated and overtime hours from the last solver run (for tipo-filtered footer). */
  solverAllocByWsn: Record<string, number> | null
  solverOtByWsn:    Record<string, number> | null
  setSolverAllocByWsn: (m: Record<string, number> | null) => void
  setSolverOtByWsn:    (m: Record<string, number> | null) => void

  /** WSN overrides set in OptimizationResultsModal — persisted for footer demand reduction. */
  optWsnDisabled: Set<string>
  optWsnIgnored:  Set<string>
  setOptWsnDisabled: (s: Set<string>) => void
  setOptWsnIgnored:  (s: Set<string>) => void

  /** Per-WSN item quantity for bottleneck WSNs from the last solver run.
   * Used by the footer to compute NAO ATENDIDOS, adjusting for ignored/disabled WSNs. */
  solverBottleneckByWsn: Record<string, number> | null
  setSolverBottleneckByWsn: (m: Record<string, number> | null) => void
  /** Per-WSN demand/covered/unmet from the last solver run.
   * Used by page.tsx to compute NIVEL-based bottleneckItemCodes. */
  solverWsnResults: Record<string, { demand: number; covered: number; unmet: number }> | null
  setSolverWsnResults: (m: Record<string, { demand: number; covered: number; unmet: number }> | null) => void
}

// ── Context ───────────────────────────────────────────────────────────────────

const WorkspaceContext = createContext<WorkspaceState | null>(null)

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return ctx
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [items,            setItems]            = useState<ImportItem[]>([])
  const [filterClient,     setFilterClientState] = useState<Set<string>>(new Set())
  const [filterFamily,     setFilterFamilyState] = useState<Set<string>>(new Set())
  const [filterTipo,       setFilterTipo]       = useState<Set<string>>(new Set())
  const [filterWsn,        setFilterWsn]        = useState<Set<string>>(new Set())

  // Cascade clear: clearing one of client↔family also clears the other, so
  // "defilter client" doesn't leave a stale family filter active.
  const setFilterClient = useCallback((f: Set<string>) => {
    setFilterClientState(f)
    if (f.size === 0) setFilterFamilyState(new Set())
  }, [])
  const setFilterFamily = useCallback((f: Set<string>) => {
    setFilterFamilyState(f)
    if (f.size === 0) setFilterClientState(new Set())
  }, [])
  const [importMeta,       setImportMeta]       = useState<ImportMeta | null>(null)
  const [assemblyDetails,  setAssemblyDetails]  = useState<Record<string, AssemblyDetail>>({})
  const [assemblyLoading,  setAssemblyLoading]  = useState<boolean>(false)
  const [peopleByWsn,      setPeopleByWsn]      = useState<Record<string, string[]>>({})
  const [mappedDays,        setMappedDays]        = useState<number | null>(null)
  const [headcountMode,    setHeadcountMode]    = useState<'skill' | 'headcount'>('skill')
  const [viewMode,         setViewMode]         = useState<'semanal' | 'mensal'>('semanal')
  const [highlightedItem,  setHighlightedItem]  = useState<string | null>(null)
  const [solverKpis,       setSolverKpis]       = useState<{ allocatedH: number; overtimeH: number; distinctPeople: number; topPct: number } | null>(null)
  const [solverAllocByWsn,      setSolverAllocByWsn]      = useState<Record<string, number> | null>(null)
  const [solverOtByWsn,         setSolverOtByWsn]         = useState<Record<string, number> | null>(null)
  const [solverBottleneckByWsn, setSolverBottleneckByWsn] = useState<Record<string, number> | null>(null)
  const [solverWsnResults,      setSolverWsnResults]      = useState<Record<string, { demand: number; covered: number; unmet: number }> | null>(null)
  const [optWsnDisabled,        setOptWsnDisabled]        = useState<Set<string>>(new Set())
  const [optWsnIgnored,         setOptWsnIgnored]         = useState<Set<string>>(new Set())

  // ── Derived option lists (cross-filtered by the other active filter) ──────
  // availableClientes: only clients that have items matching selected families
  const availableClientes = useMemo(() => {
    const base = filterFamily.size === 0
      ? items
      : items.filter(it => filterFamily.has(it.familia))
    return sorted(new Set(base.map(it => it.cliente).filter(Boolean)))
  }, [items, filterFamily])

  // availableFamilias: only families that have items matching selected clients
  const availableFamilias = useMemo(() => {
    const base = filterClient.size === 0
      ? items
      : items.filter(it => filterClient.has(it.cliente))
    return sorted(new Set(base.map(it => it.familia).filter(Boolean)))
  }, [items, filterClient])

  const availableTipos = useMemo(() =>
    sorted(new Set(items.flatMap(it => it.tipo_fw).filter(Boolean))),
  [items])

  // ── Filtered view ─────────────────────────────────────────────────────────
  const visibleItems = useMemo(() => {
    const clientSet = filterClient
    const familySet = filterFamily
    // Treat “all tipos selected” as “no tipo filter” so items with empty tipo_fw
    // (which can never match any specific tipo) are not incorrectly hidden.
    const allTiposSelected = filterTipo.size > 0 &&
      availableTipos.length > 0 &&
      availableTipos.every(t => filterTipo.has(t.toUpperCase()))
    return items.filter(it => {
      if (clientSet.size > 0 && !clientSet.has(it.cliente)) return false
      if (familySet.size > 0 && !familySet.has(it.familia)) return false
      // Only apply tipo filter when a strict subset is selected, and only for
      // items that actually declare tipos (items with no tipo_fw are always shown).
      if (!allTiposSelected && filterTipo.size > 0 && it.tipo_fw.length > 0 &&
          !it.tipo_fw.some(t => filterTipo.has(t.toUpperCase()))) return false
      return true
    })
  }, [items, filterClient, filterFamily, filterTipo, availableTipos])

  // ── Mutations ─────────────────────────────────────────────────────────────
  /** Replace all items; mirrors open_alert_flow result being applied */
  const addItems = useCallback((newItems: ImportItem[], meta?: ImportMeta) => {
    setItems(newItems)
    setFilterClient(new Set())
    setFilterFamily(new Set())
    setFilterTipo(new Set())
    setFilterWsn(new Set())
    setHighlightedItem(null)
    setAssemblyDetails({})
    if (meta) {
      // Normalize: old saved sessions may not have the `meses` field (added later)
      const normalizedMeta: ImportMeta = {
        ...meta,
        meses: meta.meses ?? (meta.mes != null ? [meta.mes] : []),
      }
      setImportMeta(normalizedMeta)
      setViewMode(normalizedMeta.mode === 'anual' ? 'mensal' : normalizedMeta.mode)
    } else {
      // Catalog add (no meta): clear any previous import period so assembly details
      // are fetched without a month filter, showing the item's full demand data.
      setImportMeta(null)
    }
  }, [])

  /** Append catalog items from "Adicionar" without resetting filters or assembly details. */
  const mergeItems = useCallback((newItems: ImportItem[]) => {
    setItems(prev => {
      const existingIds = new Set(prev.map(it => it.id))
      const tagged = newItems.map(it => {
        // If the id already exists (same item already in workspace), generate a unique id
        // so the block is a separate entry. The item code stays the same for backend lookup.
        const needsNewId = existingIds.has(it.id)
        const newId = needsNewId
          ? `${it.id}_adicionar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`
          : it.id
        return { ...it, id: newId, source: 'adicionar' as const }
      })
      return [...prev, ...tagged]
    })
  }, [])

  const clearItems = useCallback(() => {
    setItems([])
    setFilterClient(new Set())
    setFilterFamily(new Set())
    setFilterTipo(new Set())
    setFilterWsn(new Set())
    setImportMeta(null)
    setHighlightedItem(null)
    setAssemblyDetails({})
    setPeopleByWsn({})
    setMappedDays(null)
    setSolverKpis(null)           // reset footer KPIs so footer shows — instead of stale values
    setSolverAllocByWsn(null)     // reset per-WSN allocation data
    setSolverOtByWsn(null)
    setSolverBottleneckByWsn(null)  // reset unmet item count
    setSolverWsnResults(null)
  }, [setSolverKpis])

  const removeItem = useCallback((itemCode: string) => {
    setItems(prev => prev.filter(it => it.item !== itemCode))
    setAssemblyDetails(prev => {
      const next = { ...prev }
      delete next[itemCode]
      return next
    })
  }, [])

  const resetFilters = useCallback(() => {
    setFilterClient(new Set())
    setFilterFamily(new Set())
    setFilterTipo(new Set())
    setFilterWsn(new Set())
  }, [])

  return (
    <WorkspaceContext.Provider value={{
      items,
      filterClient,
      filterFamily,
      filterTipo,
      filterWsn,
      visibleItems,
      availableClientes,
      availableFamilias,
      availableTipos,
      importMeta,
      assemblyDetails,
      assemblyLoading,
      peopleByWsn,
      mappedDays,
      headcountMode,
      viewMode,
      highlightedItem,
      addItems,
      mergeItems,
      removeItem,
      clearItems,
      setFilterClient,
      setFilterFamily,
      setFilterTipo,
      setFilterWsn,
      resetFilters,
      setHeadcountMode,
      setViewMode,
      setHighlightedItem,
      setAssemblyDetails,
      setAssemblyLoading,      setPeopleByWsn,      setMappedDays,
      solverKpis,
      setSolverKpis,
      solverAllocByWsn,
      solverOtByWsn,
      setSolverAllocByWsn,
      setSolverOtByWsn,
      optWsnDisabled,
      optWsnIgnored,
      setOptWsnDisabled,
      setOptWsnIgnored,
      solverBottleneckByWsn,
      setSolverBottleneckByWsn,      solverWsnResults,
      setSolverWsnResults,    }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sorted(set: Set<string>): string[] {
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
}
