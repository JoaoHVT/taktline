'use client'
import { useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '@/context/WorkspaceContext'
import { getCapacityStats } from '@/lib/api'
import { applyAssemblyDetailFilters } from '@/lib/assemblyDetailFilters'

export interface FooterStats {
  totalItems:          number
  demandaH:            number
  disponivelH:         number
  alocadoH:            number
  gargaloH:            number
  solverAllocH:        number | null
  solverOvertimeH:     number | null
  solverDisponH:       number | null
  solverTopPct:        number | null
  solverBottleneckQty: number | null
}

export function useFooterStats(): FooterStats {
  const {
    items, visibleItems, assemblyDetails, solverKpis, mappedDays,
    headcountMode, optWsnDisabled, optWsnIgnored,
    solverAllocByWsn, solverOtByWsn, solverWsnResults,
    filterTipo, availableTipos, filterWsn,
  } = useWorkspace()

  const [disponivelH, setDisponivelH] = useState(0)
  const [alocadoH,    setAlocadoH]    = useState(0)

  // Fetch static capacity figures once on mount (headcount/Testes data doesn't
  // change between imports, so a single fetch per session is sufficient).
  useEffect(() => {
    getCapacityStats()
      .then(res => {
        setDisponivelH(res.disponivel_h)
        setAlocadoH(res.alocado_h)
      })
      .catch(() => {
        // Silently ignore — backend may be temporarily offline; values stay 0
      })
  }, [])

  const filteredVisibleDetails = useMemo(() => {
    const map: Record<string, NonNullable<typeof assemblyDetails[string]>> = {}
    for (const item of visibleItems) {
      const detail = assemblyDetails[item.item]
      if (!detail) continue
      const filtered = applyAssemblyDetailFilters(detail, {
        filterTipo,
        availableTipos,
        filterWsn,
      })
      if (filtered) map[item.item] = filtered
    }
    return map
  }, [visibleItems, assemblyDetails, filterTipo, availableTipos, filterWsn])

  // TOTAL DE ITENS = sum of scope qtys from assembly details for visible items.
  // Assembly details are fetched for the active display period (activeMeses/activeFws),
  // so this respects the display filter and reflects the correct planning period.
  // Falls back to it.qtde_fw if assembly details are not loaded yet.
  const totalItems = useMemo(() => {
    let total = 0
    let hasAnyDetail = false
    for (const item of visibleItems) {
      const detail = filteredVisibleDetails[item.item]
      if (detail) {
        hasAnyDetail = true
        for (const scope of detail.scopes_present) {
          total += detail.scopes[scope]?.qty ?? 0
        }
      }
    }
    if (hasAnyDetail) return Math.round(total)
    // Fallback: qtde_fw from item (pre-load or no assembly data for this item)
    return Math.round(visibleItems.reduce((sum, it) => sum + (it.qtde_fw ?? 0), 0))
  }, [visibleItems, filteredVisibleDetails])

  // Raw demand per WSN — computed from VISIBLE items only so tipo/client/family
  // filters affect the WSN map (and therefore the disabled/ignored WSN reduction).
  const demandByWsn = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of visibleItems) {
      const detail = filteredVisibleDetails[item.item]
      if (!detail) continue
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const w of (scopeData.wsns || [])) {
          m[w.wsn] = (m[w.wsn] ?? 0) + w.hours
        }
      }
    }
    return m
  }, [visibleItems, filteredVisibleDetails])

  // Total demand per WSN across ALL (unfiltered) items — needed to compute the
  // tipo-demand proportion used to scale solver allocations when filtering.
  const totalDemandByWsn = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of visibleItems) {
      const detail = assemblyDetails[item.item]
      if (!detail) continue
      for (const scopeData of Object.values(detail.scopes)) {
        if (!scopeData) continue
        for (const w of (scopeData.wsns || [])) {
          m[w.wsn] = (m[w.wsn] ?? 0) + w.hours
        }
      }
    }
    return m
  }, [visibleItems, assemblyDetails])

  // DEMANDA = sum of total_h across VISIBLE items only.
  // Using visibleItems ensures that tipo/client/family filters reduce the
  // displayed demand instead of always showing the full workspace demand.
  const rawDemandaH = useMemo(() => {
    let total = 0
    for (const item of visibleItems) {
      const detail = filteredVisibleDetails[item.item]
      total += detail?.total_h ?? 0
    }
    return Math.round(total * 10) / 10
  }, [visibleItems, filteredVisibleDetails])

  // In headcount (optimization) mode, subtract demand of disabled/ignored WSNs.
  // • disabled → remove full demand
  // • ignored  → remove only unmet/gargalo hours (demand − allocated), since the
  //              covered portion is still "served" and should count toward demand.
  const demandaH = useMemo(() => {
    if (headcountMode !== 'headcount' || (optWsnDisabled.size === 0 && optWsnIgnored.size === 0)) {
      return rawDemandaH
    }
    let reduction = 0
    for (const [wsn, h] of Object.entries(demandByWsn)) {
      if (optWsnDisabled.has(wsn)) {
        reduction += h
      } else if (optWsnIgnored.has(wsn)) {
        const allocated = solverAllocByWsn?.[wsn] ?? 0
        reduction += Math.max(0, h - allocated)
      }
    }
    return Math.max(0, Math.round((rawDemandaH - reduction) * 10) / 10)
  }, [headcountMode, rawDemandaH, demandByWsn, optWsnDisabled, optWsnIgnored, solverAllocByWsn])

  // GARGALO = max(0, DEMANDA - ALOCADO)
  const gargaloH = useMemo(
    () => Math.round(Math.max(0, demandaH - alocadoH) * 10) / 10,
    [demandaH, alocadoH],
  )

  const empty = items.length === 0

  // Whether a strict tipo subset is selected (all-selected = no filter)
  const demandFilterActive = useMemo(() => {
    const tipoSubset = filterTipo.size > 0 && availableTipos.length > 0 && !availableTipos.every(t => filterTipo.has(t.toUpperCase()))
    return tipoSubset || filterWsn.size > 0
  }, [filterTipo, availableTipos, filterWsn])

  // Helper: scale a per-WSN allocation map by the tipo-demand proportion.
  // For each visible WSN:  allocation_scaled[wsn] = alloc[wsn] × (visibleDemand[wsn] / totalDemand[wsn])
  // This gives the portion of the solver's allocation that corresponds to the
  // filtered tipo's demand contribution to each WSN.
  const scaledSolverH = useMemo(() => {
    const alloc: { allocH: number; otH: number } = { allocH: 0, otH: 0 }
    if (!demandFilterActive || !solverAllocByWsn) return null
    for (const [wsn, visH] of Object.entries(demandByWsn)) {
      const totH = totalDemandByWsn[wsn] ?? 0
      if (totH <= 0) continue
      const ratio = visH / totH
      alloc.allocH += (solverAllocByWsn[wsn] ?? 0) * ratio
      alloc.otH    += (solverOtByWsn?.[wsn]  ?? 0) * ratio
    }
    return {
      allocH: Math.round(alloc.allocH * 10) / 10,
      otH:    Math.round(alloc.otH    * 10) / 10,
    }
  }, [demandFilterActive, solverAllocByWsn, solverOtByWsn, demandByWsn, totalDemandByWsn])

  // ALOCADO — filtered by tipo-demand proportion when a tipo filter is active
  const solverAllocH = useMemo(() => {
    if (!solverKpis) return null
    if (headcountMode !== 'headcount') return Math.round(solverKpis.allocatedH * 10) / 10
    if (scaledSolverH !== null) return scaledSolverH.allocH
    return Math.round(solverKpis.allocatedH * 10) / 10
  }, [solverKpis, headcountMode, scaledSolverH])

  // OVERTIME — same scaling logic
  const solverOvertimeH = useMemo(() => {
    if (!solverKpis) return null
    if (headcountMode !== 'headcount') return Math.round(solverKpis.overtimeH * 10) / 10
    if (scaledSolverH !== null) return scaledSolverH.otH
    return Math.round(solverKpis.overtimeH * 10) / 10
  }, [solverKpis, headcountMode, scaledSolverH])

  // DISPONIVEL
  //   No filter:      total allocated / (topPct/100)  — same as before
  //   Filter active:  filteredAllocH / (topPct/100)
  const solverDisponH = useMemo(() => {
    if (!solverKpis || solverKpis.topPct <= 0) return null
    if (headcountMode !== 'headcount') return null
    const baseAlloc = scaledSolverH !== null ? scaledSolverH.allocH : solverKpis.allocatedH
    return Math.round(baseAlloc * 100 / solverKpis.topPct * 10) / 10
  }, [solverKpis, headcountMode, scaledSolverH])

  // TOP (%) — filteredAlloc / filteredDispon = topPct (algebraically invariant),
  // but recompute from actuals in case of rounding.
  const solverTopPct = useMemo(() => {
    if (!solverKpis || headcountMode !== 'headcount') return null
    if (solverDisponH == null || solverDisponH <= 0 || solverAllocH == null) return null
    return Math.round((solverAllocH / solverDisponH) * 1000) / 10
  }, [solverKpis, headcountMode, solverDisponH, solverAllocH])

  // NAO ATENDIDOS — NIVEL-greedy simulation: for each bottleneck WSN serve
  // items in NIVEL order (high → low) until capacity (covered) is exhausted.
  // Partial allocation: if an item only partially fits, only the unserved units
  // are counted — this gives accurate unit counts, not inflated totals.
  // Respects disabled/ignored overrides and the current tipo/wsn filters.
  const solverBottleneckQty = useMemo(() => {
    if (!solverWsnResults) return null
    // Build nivel lookup from visible items
    const nivelMap: Record<string, number> = {}
    for (const it of visibleItems) {
      nivelMap[it.item] = parseFloat(String(it.nivel ?? '0').replace(/[^0-9.]/g, '')) || 0
    }
    // Map<itemCode, max unserved units across all bottleneck WSNs>
    const unservedMap = new Map<string, number>()
    for (const [wsn, wr] of Object.entries(solverWsnResults)) {
      if (optWsnIgnored.has(wsn) || optWsnDisabled.has(wsn)) continue
      if (wr.unmet <= 1e-4) continue
      // Collect items passing through this WSN (filtered visible items only)
      const itemsAtWsn: Array<{ item: string; nivel: number; hours: number; totalUnits: number }> = []
      for (const [itemCode, detail] of Object.entries(filteredVisibleDetails)) {
        let h = 0
        let totalUnits = 0
        for (const sd of Object.values(detail.scopes)) {
          if (!sd) continue
          for (const w of (sd.wsns ?? [])) { if (w.wsn === wsn) h += w.hours }
          totalUnits += sd.qty ?? 0
        }
        if (h <= 1e-9) continue
        itemsAtWsn.push({ item: itemCode, nivel: nivelMap[itemCode] ?? 0, hours: h, totalUnits })
      }
      // Serve highest-NIVEL items first; compute partial unserved units for overflow
      itemsAtWsn.sort((a, b) => b.nivel - a.nivel)
      let acc = 0
      for (const { item, hours, totalUnits } of itemsAtWsn) {
        if (acc >= wr.covered - 1e-4) {
          // No capacity left — fully unserved
          unservedMap.set(item, Math.max(unservedMap.get(item) ?? 0, totalUnits))
        } else if (acc + hours <= wr.covered + 1e-4) {
          // Fully served
          acc += hours
        } else {
          // Partially served — remaining capacity covers only some units
          const remaining = wr.covered - acc
          const hpu = totalUnits > 0 ? hours / totalUnits : 0
          const servedUnits = hpu > 1e-9 ? Math.floor(remaining / hpu) : 0
          const itemUnserved = Math.max(0, totalUnits - servedUnits)
          if (itemUnserved > 0)
            unservedMap.set(item, Math.max(unservedMap.get(item) ?? 0, itemUnserved))
          acc = wr.covered
        }
      }
    }
    if (unservedMap.size === 0) return null
    // Sum unserved units across all items
    let qty = 0
    for (const unservedUnits of unservedMap.values()) qty += unservedUnits
    return qty > 0 ? Math.round(qty) : null
  }, [solverWsnResults, filteredVisibleDetails, visibleItems, optWsnDisabled, optWsnIgnored])

  return {
    totalItems,
    demandaH,
    disponivelH: empty ? 0 : disponivelH,
    alocadoH:    empty ? 0 : alocadoH,
    gargaloH:    empty ? 0 : gargaloH,
    solverAllocH:        empty ? null : solverAllocH,
    solverOvertimeH:     empty ? null : solverOvertimeH,
    solverDisponH:       empty ? null : solverDisponH,
    solverTopPct:        empty ? null : solverTopPct,
    solverBottleneckQty: empty ? null : solverBottleneckQty,
  }
}
