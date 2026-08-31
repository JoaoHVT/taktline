import { useMemo } from 'react'
import type { GanttData, GanttDateInfo, GanttGroup } from '@/lib/api'
import { isoFw445MonthKey, monthKeyQuarter } from '@/lib/ganttUtils'
import { TIPOS, tipoOfLinha } from '@/lib/tipos'

// Both of these now come from the Tipo registry (`lib/tipos.ts`) — they are re-exported here
// rather than moved, because a dozen modules import them from this path and the indirection
// costs nothing. The DEFINITIONS live in one place; these are views onto it.
//
// SUMMARY_LINE_TYPE_MAP is built from the SCHEDULE-BACKED Tipos only. Its callers use it two
// ways — as the Linha allowlist for a selected Tipo, and as the denominator for "is a filter
// even active" (`summaryLineTypes.size < Object.keys(SUMMARY_LINE_TYPE_MAP).length`). A Tipo
// with no Schedule behind it belongs in neither: it contributes no Linha, and counting it in
// the denominator would make a full selection look like a partial one and silently filter the
// summary down to nothing.
export const SUMMARY_LINE_TYPE_MAP: Record<string, string[]> =
  TIPOS.filter(t => t.scheduleBacked)
       .reduce((m, t) => { m[t.key] = [...t.linhas]; return m }, {} as Record<string, string[]>)

export const getTipoGeral = tipoOfLinha

export function useGanttFilters({
  effectiveData,
  summaryTestReady,
  selYears,
  selQuarters,
  selMonths,
  selFws,
  selAreas,
  selModels,
  selLocoNames,
  summaryLineTypes,
  selSchedModels,
  selSchedAreas,
  selSchedWorkstations,
}: {
  effectiveData: GanttData | null
  summaryTestReady: boolean
  selYears: Set<string>
  /** Fiscal-quarter keys ("2026-Q1"). A quarter is a COARSER month filter: it narrows the
   *  Mês/Semana option lists and the active business-day set exactly like a month does.
   *  Optional so a caller with no quarter state behaves as before. */
  selQuarters?: Set<string>
  selMonths: Set<string>
  selFws: Set<string>
  selAreas: Set<string>
  selModels: Set<string>
  selLocoNames: Set<string>
  summaryLineTypes: Set<string>
  // Schedule-tab-only filters (independent from the Resumo Geral filters above).
  selSchedModels?: Set<string>
  selSchedAreas?: Set<string>
  selSchedWorkstations?: Set<string>
}) {
  const years = useMemo(() => {
    if (!summaryTestReady || !effectiveData) return []
    const s = new Set<string>()
    for (const d of effectiveData.date_info) if (!d.is_weekend) s.add(d.iso.slice(0, 4))
    return [...s].sort()
  }, [effectiveData, summaryTestReady])

  // Quarter options — every fiscal quarter present in the (year-narrowed) timeline.
  const quarters = useMemo(() => {
    if (!summaryTestReady || !effectiveData) return []
    const s = new Set<string>()
    for (const d of effectiveData.date_info) {
      if (d.is_weekend) continue
      if (selYears.size > 0 && !selYears.has(d.iso.slice(0, 4))) continue
      s.add(monthKeyQuarter(isoFw445MonthKey(d.iso, d.fw)))
    }
    return [...s].sort()
  }, [effectiveData, summaryTestReady, selYears])

  const months = useMemo(() => {
    if (!summaryTestReady || !effectiveData) return []
    const hasQ = (selQuarters?.size ?? 0) > 0
    const s = new Set<string>()
    for (const d of effectiveData.date_info) {
      if (d.is_weekend) continue
      if (selYears.size > 0 && !selYears.has(d.iso.slice(0, 4))) continue
      const ym = isoFw445MonthKey(d.iso, d.fw)
      if (hasQ && !selQuarters!.has(monthKeyQuarter(ym))) continue
      s.add(ym)
    }
    return [...s].sort()
  }, [effectiveData, summaryTestReady, selYears, selQuarters])

  const allFws = useMemo(() => {
    if (!summaryTestReady || !effectiveData) return []
    const hasQ = (selQuarters?.size ?? 0) > 0
    return [...new Set(effectiveData.date_info.filter(d => {
      if (d.is_weekend) return false
      if (selYears.size > 0 && !selYears.has(d.iso.slice(0, 4))) return false
      const ym = isoFw445MonthKey(d.iso, d.fw)
      if (hasQ && !selQuarters!.has(monthKeyQuarter(ym))) return false
      if (selMonths.size > 0 && !selMonths.has(ym)) return false
      return true
    }).map(d => d.fw))]
  }, [effectiveData, summaryTestReady, selYears, selQuarters, selMonths])

  // ── Resumo Geral option lists ────────────────────────────────────────────────
  // Each is a UNION of the two hour sources the tab shows: the Schedule's groups (narrowed by
  // the Tipo filter through their Linha) and the published GCR plan (already gated on the Tipo
  // by its caller). `effectiveData` may be null — that is the GCR-only load, where the plan is
  // the whole rollup and an early return here would leave the tab with no filters at all.
  const allAreas = useMemo(() => {
    const totalTypes = Object.keys(SUMMARY_LINE_TYPE_MAP).length
    const hasLineFilter = summaryLineTypes.size < totalTypes
    const allowedLinhas = new Set<string>()
    if (hasLineFilter) {
      for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
        if (summaryLineTypes.has(key)) linhas.forEach(l => allowedLinhas.add(l))
    }
    const s = new Set<string>()
    for (const g of effectiveData?.groups ?? []) {
      if (hasLineFilter && !allowedLinhas.has(g.linha)) continue
      for (const w of g.workstations)
        s.add((w.area && w.area.trim()) || 'Sem área')
    }
    // A área both sources name adds ONE option, not two: `gcrAreaOf` trims exactly as the
    // Schedule branch above does, and the merge files the hours under that same string.
    return [...s].sort()
  }, [effectiveData, summaryLineTypes])

  const allModels = useMemo(() => {
    const totalTypes = Object.keys(SUMMARY_LINE_TYPE_MAP).length
    const hasLineFilter = summaryLineTypes.size < totalTypes
    const allowedLinhas = new Set<string>()
    if (hasLineFilter) {
      for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
        if (summaryLineTypes.has(key)) linhas.forEach(l => allowedLinhas.add(l))
    }
    const s = new Set<string>()
    for (const g of effectiveData?.groups ?? []) {
      if (hasLineFilter && !allowedLinhas.has(g.linha)) continue
      if (g.wo) s.add(g.wo)
    }
    // The plan's WORKORDER is the same kind of identifier as the Schedule's `wo`, which is what
    // this list holds. Blank ones are skipped, exactly as a group without a `wo` is.
    return [...s].sort()
  }, [effectiveData, summaryLineTypes])

  const allLocoNames = useMemo(() => {
    if (!effectiveData) return []
    return [...new Set(effectiveData.groups.map(g => g.task_name))].sort()
  }, [effectiveData])

  // ── Schedule-tab filter option lists (full, unfiltered — the Schedule panel
  //    is independent from the Resumo Geral filters). ──────────────────────────
  const allSchedModels = useMemo(() => {
    if (!effectiveData) return []
    return [...new Set(effectiveData.groups.map(g => g.wo).filter(Boolean))].sort()
  }, [effectiveData])

  const allSchedAreas = useMemo(() => {
    if (!effectiveData) return []
    const s = new Set<string>()
    for (const g of effectiveData.groups)
      for (const w of g.workstations) s.add((w.area && w.area.trim()) || 'Sem área')
    return [...s].sort()
  }, [effectiveData])

  const allWorkstations = useMemo(() => {
    if (!effectiveData) return []
    const s = new Set<string>()
    for (const g of effectiveData.groups)
      for (const w of g.workstations) if (w.ws) s.add(w.ws)
    return [...s].sort()
  }, [effectiveData])

  /**
   * The Resumo Geral Workstation list: `allWorkstations` plus the GCR plan's Linhas.
   *
   * SEPARATE from `allWorkstations`, which the Schedule tab's panel uses, and that separation is
   * the point. The Schedule has no GCR rows, so a GCR Linha offered there is an option that can
   * only ever empty the Gantt. Resumo Geral shows both sources in one table and needs both
   * vocabularies — this is the Área/Modelo split (`allAreas` vs `allSchedAreas`) applied to the
   * one axis that did not have it yet.
   */
  const allSummaryWorkstations = useMemo(() => {
    const s = new Set<string>(allWorkstations)
    return [...s].sort()
  }, [allWorkstations])

  const availableLineTypes = useMemo(() => {
    if (!effectiveData) return new Set<string>()
    const present = new Set<string>()
    for (const g of effectiveData.groups) {
      const tipo = getTipoGeral(g.linha)
      if (tipo !== 'other') present.add(tipo)
    }
    return present
  }, [effectiveData])

  const activeBizISOs = useMemo<Set<string> | null>(() => {
    if (!summaryTestReady || !effectiveData) return null
    const hasY = selYears.size > 0, hasM = selMonths.size > 0, hasF = selFws.size > 0
    const hasQ = (selQuarters?.size ?? 0) > 0
    if (!hasY && !hasQ && !hasM && !hasF) return null
    return new Set(effectiveData.date_info.filter(d => {
      if (d.is_weekend) return false
      if (hasY && !selYears.has(d.iso.slice(0, 4))) return false
      const ym = isoFw445MonthKey(d.iso, d.fw)
      if (hasQ && !selQuarters!.has(monthKeyQuarter(ym))) return false
      if (hasM && !selMonths.has(ym)) return false
      if (hasF && !selFws.has(d.fw)) return false
      return true
    }).map(d => d.iso))
  }, [effectiveData, selYears, selQuarters, selMonths, selFws, summaryTestReady])

  // Same restriction as activeBizISOs but IGNORING the month selection, so the Resumo
  // Geral distribution chart can keep showing the full timeline while the rest of the
  // dashboard reacts to the selected month. Year/FW (and the data filters applied inside
  // the summary compute) still narrow it, so the chart tracks the current scope — only
  // the month click no longer collapses it. null = no year/fw filter → whole timeline.
  const activeBizISOsChart = useMemo<Set<string> | null>(() => {
    if (!summaryTestReady || !effectiveData) return null
    const hasY = selYears.size > 0, hasF = selFws.size > 0
    const hasQ = (selQuarters?.size ?? 0) > 0
    if (!hasY && !hasQ && !hasF) return null
    return new Set(effectiveData.date_info.filter(d => {
      if (d.is_weekend) return false
      if (hasY && !selYears.has(d.iso.slice(0, 4))) return false
      if (hasQ && !selQuarters!.has(monthKeyQuarter(isoFw445MonthKey(d.iso, d.fw)))) return false
      if (hasF && !selFws.has(d.fw)) return false
      return true
    }).map(d => d.iso))
  }, [effectiveData, selYears, selQuarters, selFws, summaryTestReady])

  const filteredDateInfo = useMemo<GanttDateInfo[] | undefined>(() => {
    if (!effectiveData || !activeBizISOs) return undefined
    const sorted = [...activeBizISOs].sort()
    if (sorted.length === 0) return undefined
    const lo = sorted[0], hi = sorted[sorted.length - 1]
    return effectiveData.date_info.filter(d => d.iso >= lo && d.iso <= hi)
  }, [effectiveData, activeBizISOs])

  const filteredGroups = useMemo<GanttGroup[] | undefined>(() => {
    if (!effectiveData) return undefined
    const hasDateFilter = Boolean(activeBizISOs)
    const hasLineTypeFilter = summaryLineTypes.size < Object.keys(SUMMARY_LINE_TYPE_MAP).length
    const hasAreaFilter = selAreas.size > 0
    const hasModelFilter = selModels.size > 0
    const hasLocoFilter = selLocoNames.size > 0
    if (!hasDateFilter && !hasLineTypeFilter && !hasAreaFilter && !hasModelFilter && !hasLocoFilter) return undefined

    const allowedLinhas = new Set<string>()
    if (hasLineTypeFilter) {
      for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
        if (summaryLineTypes.has(key)) linhas.forEach(l => allowedLinhas.add(l))
    }

    return effectiveData.groups
      .filter(g => {
        if (hasLineTypeFilter && !allowedLinhas.has(g.linha)) return false
        if (hasModelFilter && !selModels.has(g.wo)) return false
        if (hasLocoFilter && !selLocoNames.has(g.task_name)) return false
        return true
      })
      .map(g => ({
        ...g,
        workstations: g.workstations
          .filter(wst => {
            if (!hasAreaFilter) return true
            const areaName = (wst.area && wst.area.trim()) || 'Sem área'
            return selAreas.has(areaName)
          })
          .map(wst => ({
            ...wst,
            desc_rows: hasDateFilter && activeBizISOs
              ? wst.desc_rows.filter(dr => Object.keys(dr.cells).some(iso => activeBizISOs.has(iso)))
              : wst.desc_rows,
          }))
          .filter(wst => wst.desc_rows.length > 0),
      }))
      .filter(g => g.workstations.length > 0)
  }, [effectiveData, activeBizISOs, summaryLineTypes, selAreas, selModels, selLocoNames])

  const scheduleFilteredGroups = useMemo<GanttGroup[] | undefined>(() => {
    if (!effectiveData) return undefined
    const hasLineTypeFilter = summaryLineTypes.size < Object.keys(SUMMARY_LINE_TYPE_MAP).length
    const hasLocoFilter   = selLocoNames.size > 0
    const hasModelFilter  = (selSchedModels?.size ?? 0) > 0
    const hasAreaFilter   = (selSchedAreas?.size ?? 0) > 0
    const hasWsFilter     = (selSchedWorkstations?.size ?? 0) > 0
    if (!hasLineTypeFilter && !hasLocoFilter && !hasModelFilter && !hasAreaFilter && !hasWsFilter)
      return undefined
    const allowedLinhas = new Set<string>()
    if (hasLineTypeFilter) {
      for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
        if (summaryLineTypes.has(key)) linhas.forEach(l => allowedLinhas.add(l))
    }
    return effectiveData.groups
      .filter(g => {
        if (hasLineTypeFilter && !allowedLinhas.has(g.linha)) return false
        if (hasLocoFilter && !selLocoNames.has(g.task_name)) return false
        if (hasModelFilter && !selSchedModels!.has(g.wo)) return false
        return true
      })
      // Area / Workstation filter at the workstation level (drop non-matching WS).
      .map(g => (!hasAreaFilter && !hasWsFilter)
        ? g
        : {
            ...g,
            workstations: g.workstations.filter(wst => {
              if (hasWsFilter && !selSchedWorkstations!.has(wst.ws)) return false
              if (hasAreaFilter) {
                const areaName = (wst.area && wst.area.trim()) || 'Sem área'
                if (!selSchedAreas!.has(areaName)) return false
              }
              return true
            }),
          })
      .filter(g => g.workstations.length > 0)
  }, [effectiveData, summaryLineTypes, selLocoNames, selSchedModels, selSchedAreas, selSchedWorkstations])

  return {
    years,
    quarters,
    months,
    allFws,
    allAreas,
    allModels,
    allLocoNames,
    allSchedModels,
    allSchedAreas,
    allWorkstations,
    allSummaryWorkstations,
    availableLineTypes,
    activeBizISOs,
    activeBizISOsChart,
    filteredDateInfo,
    filteredGroups,
    scheduleFilteredGroups,
  }
}
