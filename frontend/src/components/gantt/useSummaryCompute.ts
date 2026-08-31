import { useEffect, useRef } from 'react'
import type React from 'react'
import type { GanttData } from '@/lib/api'
import { isoFw445MonthKey, wsSubLabel } from '@/lib/ganttUtils'
import { SUMMARY_LINE_TYPE_MAP, getTipoGeral } from './useGanttFilters'
import type { SummaryTestResult, StatsResult } from './types'

export function useSummaryCompute({
  effectiveData,
  activeBizISOs,
  summaryLineTypes,
  selAreas,
  selModels,
  selLocoNames,
  selWorkstations,
  setSummaryTestData,
  setStats,
  setSummaryComputing,
  cache,
  cacheKey,
}: {
  effectiveData: GanttData | null
  activeBizISOs: Set<string> | null
  summaryLineTypes: Set<string>
  selAreas: Set<string>
  selModels: Set<string>
  selLocoNames: Set<string>
  /** Workstation filter (Resumo Geral "Dados" panel). Empty set = no filter. */
  selWorkstations?: Set<string>
  setSummaryTestData: (v: SummaryTestResult | null) => void
  setStats: (v: StatsResult | null) => void
  setSummaryComputing: (v: boolean) => void
  /** Optional memo cache of computed aggregates, keyed by `cacheKey`. Used by the
   *  scenario-comparison toggle so switching back to an already-computed
   *  scenario+filter combo commits synchronously (no null→loader→remount flash).
   *  When omitted, behaves exactly as before (single-scenario unaffected). */
  cache?: React.MutableRefObject<Map<string, { summary: SummaryTestResult; stats: StatsResult }>>
  cacheKey?: string
}) {
  // Track the dataset identity. It used to decide whether to BLANK the result: a DATASET change
  // cleared it (`setSummaryTestData(null)`) while a FILTER change kept the view on screen.
  //
  // Blanking is what produced two reported bugs, because the consuming tabs are MOUNTED ON THIS
  // VALUE (`summaryTestReady && summaryTestData && …` in GanttModal). Clearing it therefore did not
  // just empty a table — it UNMOUNTED Resumo Geral and Plano de Produção and remounted them a moment
  // later against fresh state:
  //   • editing a loco from "Resumo por Locos" flashed the whole page (the edit changes
  //     displayOverrides → a new mergedData identity → "dataset changed" → unmount → remount);
  //   • Plano de Produção lost its selected Área (and every other piece of local state) whenever an
  //     edit landed while the user was on another tab, i.e. "switching away and back resets it".
  // The recompute is rAF-chunked and always commits its result in ONE setState at the end, so keeping
  // the previous aggregate visible in the meantime costs a brief staleness and nothing else —
  // `setSummaryComputing(true)` already tells the UI a recalculation is in flight. Only the genuine
  // "no data at all" case (effectiveData null) still clears, and that one has nothing to show anyway.
  const prevDataRef = useRef<GanttData | null>(null)
  useEffect(() => {
    if (!effectiveData) {
      prevDataRef.current = null
      setSummaryTestData(null); setStats(null); setSummaryComputing(false); return
    }
    let cancelled = false
    // Instant cache hit: if this exact dataset+filter combo was already computed
    // (scenario-comparison toggle), commit it synchronously — no clearing flash, no
    // rAF recompute. The dataset identity is tracked even on a hit so a later real
    // dataset change is still detected correctly.
    if (cache && cacheKey && cache.current.has(cacheKey)) {
      const hit = cache.current.get(cacheKey)!
      prevDataRef.current = effectiveData
      setSummaryTestData(hit.summary)
      setStats(hit.stats)
      setSummaryComputing(false)
      return () => { cancelled = true }
    }
    const datasetChanged = prevDataRef.current !== effectiveData
    prevDataRef.current = effectiveData
    // New underlying data: flag the recalculation but KEEP the current aggregate mounted (see the
    // note on prevDataRef). Both a dataset change and a filter-only change now recompute in the
    // background (rAF-chunked) and commit the fresh result in one setState at the end, so there is
    // no null→loader→remount flash and the tabs' own state survives.
    if (datasetChanged) setSummaryComputing(true)

    const activeSet = activeBizISOs
    const isIsoActive = (iso: string) => !activeSet || activeSet.has(iso)

    // Working day = not a weekend AND not a holiday. Both flags come from the server's
    // admin-editable calendar (date_info), so this no longer recomputes its own holiday set.
    const monthBusinessDays: Record<string, number> = {}
    for (const d of effectiveData.date_info) {
      if (!isIsoActive(d.iso) || d.is_weekend || d.is_holiday) continue
      const ym = isoFw445MonthKey(d.iso, d.fw)
      monthBusinessDays[ym] = (monthBusinessDays[ym] ?? 0) + 1
    }

    type PnAcc  = { pn: string; desc: string; hoursByYearMonth: Record<string, number>; hoursByFw: Map<string, number>; total: number }
    type WsAcc  = { key: string; label: string; hoursByYearMonth: Record<string, number>; hoursByFw: Map<string, number>; total: number; partNumbers: Map<string, PnAcc> }
    type AreaAcc = { area: string; hoursByYearMonth: Record<string, number>; hoursByFw: Map<string, number>; total: number; locos: Set<string>; workstations: Map<string, WsAcc> }
    type LocoAcc = { loco: string; linha: string; tipoGeral: string; minISO: string; finishMS: string; hours: number; takt?: number; startMs?: string | number | null; fallback: boolean; hoursByYearMonth: Record<string, number>; hoursByFw: Map<string, number> }

    const isoToFw = new Map<string, string>()
    for (const d of effectiveData.date_info) isoToFw.set(d.iso, d.fw)
    const byArea  = new Map<string, AreaAcc>()
    const byModel = new Map<string, Map<string, LocoAcc>>()
    const models  = new Set<string>()

    let statHours = 0
    const statParts = new Set<string>()
    const statWsDistinct = new Set<string>()
    let statLocos = 0
    let statTotalItems = 0

    const activeLinhas = new Set<string>()
    for (const [key, linhas] of Object.entries(SUMMARY_LINE_TYPE_MAP))
      if (summaryLineTypes.has(key)) linhas.forEach(l => activeLinhas.add(l))
    const hasLineTypeFilter = summaryLineTypes.size < Object.keys(SUMMARY_LINE_TYPE_MAP).length

    const groups = effectiveData.groups.filter(g => {
      if (hasLineTypeFilter && !activeLinhas.has(g.linha)) return false
      if (selModels.size > 0 && !selModels.has(g.wo)) return false
      if (selLocoNames.size > 0 && !selLocoNames.has(g.task_name)) return false
      return true
    })
    let gi = 0

    const tick = () => {
      if (cancelled) return
      const tEnd = performance.now() + 12
      while (gi < groups.length && performance.now() < tEnd) {
        const g = groups[gi++]
        models.add(g.wo)
        let gHasActive = false
        let gMinISO = ''
        let gMaxISO = ''
        let gHours = 0
        const gHoursByYm: Record<string, number> = {}
        const gHoursByFw: Map<string, number> = new Map()
        for (const wst of g.workstations) {
          const areaName = (wst.area && wst.area.trim()) || 'Sem área'
          if (selAreas.size > 0 && !selAreas.has(areaName)) continue
          if (selWorkstations && selWorkstations.size > 0 && !selWorkstations.has(wst.ws)) continue
          let a = byArea.get(areaName)
          if (!a) {
            a = { area: areaName, hoursByYearMonth: {}, hoursByFw: new Map(), total: 0, locos: new Set<string>(), workstations: new Map<string, WsAcc>() }
            byArea.set(areaName, a)
          }
          a.locos.add(g.task_name)
          const wsKey = `${areaName}||${wst.ws}||${(wst.subarea && wst.subarea.trim()) || ''}`
          let ws = a.workstations.get(wsKey)
          if (!ws) {
            ws = { key: wsKey, label: wsSubLabel(wst.ws, wst.subarea), hoursByYearMonth: {}, hoursByFw: new Map(), total: 0, partNumbers: new Map<string, PnAcc>() }
            a.workstations.set(wsKey, ws)
          }
          for (const dr of wst.desc_rows) {
            let drHasActive = false
            const pnKey = `${dr.pn ?? ''}||${dr.desc ?? ''}`
            let pnAcc = ws.partNumbers.get(pnKey)
            if (!pnAcc) {
              pnAcc = { pn: dr.pn ?? '', desc: dr.desc ?? '', hoursByYearMonth: {}, hoursByFw: new Map(), total: 0 }
              ws.partNumbers.set(pnKey, pnAcc)
            }
            for (const [iso, cell] of Object.entries(dr.cells)) {
              if (!isIsoActive(iso)) continue
              const fw = isoToFw.get(iso)
              const ym = fw ? isoFw445MonthKey(iso, fw) : iso.slice(0, 7)
              const hh = Number(cell.hh || 0)
              a.hoursByYearMonth[ym]   = (a.hoursByYearMonth[ym]   ?? 0) + hh; a.total   += hh
              ws.hoursByYearMonth[ym]  = (ws.hoursByYearMonth[ym]  ?? 0) + hh; ws.total  += hh
              pnAcc.hoursByYearMonth[ym] = (pnAcc.hoursByYearMonth[ym] ?? 0) + hh; pnAcc.total += hh
              if (fw) {
                a.hoursByFw.set(fw,    (a.hoursByFw.get(fw)    || 0) + hh)
                ws.hoursByFw.set(fw,   (ws.hoursByFw.get(fw)   || 0) + hh)
                pnAcc.hoursByFw.set(fw,(pnAcc.hoursByFw.get(fw)|| 0) + hh)
                gHoursByFw.set(fw,     (gHoursByFw.get(fw)    || 0) + hh)
              }
              gHoursByYm[ym] = (gHoursByYm[ym] ?? 0) + hh
              statHours += hh; gHours += hh
              if (!gMinISO || iso < gMinISO) gMinISO = iso
              if (!gMaxISO || iso > gMaxISO) gMaxISO = iso
              if (dr.desc) statParts.add(dr.desc)
              statWsDistinct.add(wst.ws)
              gHasActive = true; drHasActive = true
            }
            if (drHasActive) statTotalItems += dr.qtd ?? 0
          }
        }
        if (gHasActive) {
          statLocos++
          let m = byModel.get(g.wo)
          if (!m) { m = new Map(); byModel.set(g.wo, m) }
          const locoInstKey = `${g.task_name}||${String(g.start_ms ?? '')}`
          const existing = m.get(locoInstKey)
          if (!existing) {
            m.set(locoInstKey, { loco: g.task_name, linha: g.linha, tipoGeral: getTipoGeral(g.linha), minISO: gMinISO, finishMS: gMaxISO, hours: gHours, takt: g.takt ?? undefined, startMs: g.start_ms ?? undefined, fallback: !!g.fallback, hoursByYearMonth: { ...gHoursByYm }, hoursByFw: new Map(gHoursByFw) })
          } else {
            if (gMinISO && (!existing.minISO || gMinISO < existing.minISO)) existing.minISO = gMinISO
            if (gMaxISO && (!existing.finishMS || gMaxISO > existing.finishMS)) existing.finishMS = gMaxISO
            existing.hours += gHours
            for (const [ym, h] of Object.entries(gHoursByYm)) existing.hoursByYearMonth[ym] = (existing.hoursByYearMonth[ym] ?? 0) + h
            for (const [fw, h] of gHoursByFw) existing.hoursByFw.set(fw, (existing.hoursByFw.get(fw) || 0) + h)
          }
        }
      }
      if (gi < groups.length) { requestAnimationFrame(tick); return }
      if (cancelled) return

      const areas = [...byArea.values()]
        .filter(a => a.total > 0)
        .sort((a, b) => b.total - a.total)
        .map(a => ({
          area: a.area, locos: a.locos.size,
          workstations: [...a.workstations.values()]
            .filter(ws => ws.total > 0)
            .sort((x, y) => y.total - x.total)
            .map(ws => ({ key: ws.key, label: ws.label, hoursByYearMonth: ws.hoursByYearMonth, hoursByFw: Object.fromEntries(ws.hoursByFw), total: ws.total, partNumbers: [...ws.partNumbers.values()].filter(p => p.total > 0).sort((a2, b2) => b2.total - a2.total).map(p => ({ pn: p.pn, desc: p.desc, hoursByYearMonth: p.hoursByYearMonth, hoursByFw: Object.fromEntries(p.hoursByFw), total: p.total })) })),
          hoursByYearMonth: a.hoursByYearMonth, hoursByFw: Object.fromEntries(a.hoursByFw), total: a.total,
        }))
      const allYms = [...new Set(areas.flatMap(a => Object.keys(a.hoursByYearMonth)))].sort()
      const yearsInData = [...new Set(allYms.map(ym => ym.slice(0, 4)))].sort()
      const fullYearYms = yearsInData.flatMap(year =>
        Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
      )
      const totalsByYearMonth = Object.fromEntries(fullYearYms.map(ym => [ym, areas.reduce((s, a) => s + (a.hoursByYearMonth[ym] ?? 0), 0)]))
      const fwBusinessDays: Record<string, number> = {}
      for (const d of effectiveData.date_info) {
        if (!isIsoActive(d.iso) || d.is_weekend || d.is_holiday) continue
        fwBusinessDays[d.fw] = (fwBusinessDays[d.fw] || 0) + 1
      }
      const activeFws = [...new Set(effectiveData.date_info.filter(d => isIsoActive(d.iso) && !d.is_weekend).map(d => d.fw))].sort()
      const statDates = activeBizISOs
        ? effectiveData.date_info.filter(d => activeBizISOs.has(d.iso))
        : effectiveData.date_info.filter(d => !d.is_weekend)
      const modelGroups = [...byModel.entries()]
        .map(([model, locoMap]) => {
          const locos = [...locoMap.values()]
            .map(acc => ({ loco: acc.loco, tipoGeral: acc.tipoGeral, linha: acc.linha, minISO: acc.minISO, finishMS: acc.finishMS, hours: acc.hours, takt: acc.takt, startMs: acc.startMs, fallback: acc.fallback, hoursByYearMonth: acc.hoursByYearMonth, hoursByFw: Object.fromEntries(acc.hoursByFw) }))
            .sort((a, b) => a.minISO.localeCompare(b.minISO))
          const modelHoursByYm: Record<string, number> = {}
          const modelHoursByFw: Record<string, number> = {}
          for (const l of locos) {
            for (const [ym, h] of Object.entries(l.hoursByYearMonth)) modelHoursByYm[ym] = (modelHoursByYm[ym] ?? 0) + h
            for (const [fw, h] of Object.entries(l.hoursByFw)) modelHoursByFw[fw] = (modelHoursByFw[fw] ?? 0) + h
          }
          return { model, locos, fallback: locos.some(l => l.fallback), totalHours: locos.reduce((s, l) => s + l.hours, 0), hoursByYearMonth: modelHoursByYm, hoursByFw: modelHoursByFw }
        })
        .sort((a, b) => b.totalHours - a.totalHours)

      // Not wrapped in startSummaryTransition — committing final result must not be
      // deferred or it can be skipped when the transition is interrupted (e.g. tab switch).
      const summaryResult: SummaryTestResult = {
        areas, monthBusinessDays, totalsByYearMonth,
        totalHours: Object.values(totalsByYearMonth).reduce((s, v) => s + v, 0),
        wsCount: areas.reduce((s, a) => s + a.workstations.length, 0),
        locosCount: new Set(groups.map(g => g.task_name)).size,
        modelsCount: models.size,
        fwsCount: new Set(effectiveData.date_info.filter(d => isIsoActive(d.iso) && !d.is_weekend).map(d => d.fw)).size,
        businessDaysCount: Object.values(monthBusinessDays).reduce((s, v) => s + v, 0),
        activeYearMonths: fullYearYms, activeFws, fwBusinessDays,
        modelGroups,
      }
      const statsResult: StatsResult = {
        businessDays: statDates.length,
        fws: new Set(statDates.map(d => d.fw)).size,
        locos: statLocos, models: models.size, wsDistinct: statWsDistinct.size,
        hours: statHours, parts: statParts.size, totalItems: statTotalItems,
      }
      // Memoize for the comparison toggle so re-displaying this scenario+filter is instant.
      if (cache && cacheKey) cache.current.set(cacheKey, { summary: summaryResult, stats: statsResult })
      setSummaryTestData(summaryResult)
      setStats(statsResult)
      setSummaryComputing(false)
    }
    requestAnimationFrame(tick)
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveData, activeBizISOs, summaryLineTypes, selAreas, selModels, selLocoNames, selWorkstations, cacheKey])
}
