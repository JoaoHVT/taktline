'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { SlidersHorizontal, CheckSquare, Square, X, Package2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { LayoutShell }    from '@/components/LayoutShell'
import { WorkspaceProvider, useWorkspace } from '@/context/WorkspaceContext'
import { GanttInlineProvider, useGanttInlineMaybe } from '@/context/GanttInlineContext'
import { FactoryLoadShareProvider } from '@/context/FactoryLoadShareContext'
import { FactoryLoadHome } from '@/components/FactoryLoadHome'
import { AssemblyBlock } from '@/components/AssemblyBlock'
import { LoginModal }    from '@/components/LoginModal'
import { LockoutOverlay } from '@/components/LockoutOverlay'
import { BlockedOverlay } from '@/components/BlockedOverlay'
import { HomeView }      from '@/components/HomeView'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { getAssemblyDetails, getAssemblyDetailsForDemand } from '@/lib/api'
import type { AssemblyDetailsResponse } from '@/lib/api'
import { applyAssemblyDetailFilters } from '@/lib/assemblyDetailFilters'

import type { ScopeKey } from '@/lib/api'

// ── Month label map ────────────────────────────────────────────────────────────

const MES_LABELS: Record<number, string> = {
  1: 'Janeiro', 2: 'Fevereiro', 3: 'Março',    4: 'Abril',
  5: 'Maio',    6: 'Junho',     7: 'Julho',     8: 'Agosto',
  9: 'Setembro', 10: 'Outubro', 11: 'Novembro', 12: 'Dezembro',
}

function fmtFw(raw: string): string {
  const m = raw.trim().match(/(\d+)/)
  return m ? `FW${m[1]}` : raw.trim()
}

// ── MesFwInfoBox + filter button ─────────────────────────────────────────────

interface MesFwInfoBoxProps {
  importMeta:  NonNullable<ReturnType<typeof useWorkspace>['importMeta']>
  activeMeses: Set<number>
  activeFws:   Set<string>
  onChangeMeses: (next: Set<number>) => void
  onChangeFws:   (next: Set<string>) => void
}

function MesFwInfoBox({ importMeta, activeMeses, activeFws, onChangeMeses, onChangeFws }: MesFwInfoBoxProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const { meses, selectedFws, allFwsForMes } = importMeta
  const mesFwMap = importMeta.mesFwMap ?? {}

  const isSemanalMode = importMeta.mode === 'semanal'

  // FWs to show in the FW column: restricted to those belonging to the currently-active months.
  // When no month filter is active (activeMeses is empty), show all imported FWs.
  // In semanal mode, always lock to only the imported FW(s) — no filtering allowed.
  const fwsForActiveMeses = useMemo(() => {
    if (isSemanalMode) return selectedFws
    if (activeMeses.size === 0 || Object.keys(mesFwMap).length === 0) return allFwsForMes
    const seen = new Set<string>()
    const merged: string[] = []
    for (const m of [...activeMeses].sort((a, b) => a - b)) {
      for (const fw of (mesFwMap[m] ?? [])) {
        if (!seen.has(fw)) { seen.add(fw); merged.push(fw) }
      }
    }
    return merged.sort((a, b) => Number(a) - Number(b))
  }, [mesFwMap, activeMeses, allFwsForMes, isSemanalMode, selectedFws])

  // Auto-clean activeFws when the FW list for the active months changes
  useEffect(() => {
    if (activeFws.size === 0) return
    const valid = new Set(fwsForActiveMeses)
    const next  = new Set([...activeFws].filter(fw => valid.has(fw)))
    if (next.size !== activeFws.size) onChangeFws(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fwsForActiveMeses])

  // Build display label for months (use activeMeses for display when filtered)
  const displayMeses = activeMeses.size > 0 ? [...activeMeses].sort((a, b) => a - b) : meses
  const mesLabel = displayMeses.length === 0
    ? 'Todos'
    : displayMeses
        .map(m => `${String(m).padStart(2, '0')} ${MES_LABELS[m] ?? m}`)
        .join(', ')

  // Build FW display label. A long period lists a week per column of text and pushed the rest of
  // the header off screen, so at most MAX_FW_LABEL weeks are named and the remainder collapses
  // into "…" (the full list stays available in the filter dropdown and the title attribute).
  const MAX_FW_LABEL = 5
  const displayFwList = activeFws.size > 0 ? [...activeFws] : selectedFws
  const fwLabelFull = displayFwList.map(fmtFw).join(', ')
  let fwLabel: string
  if (allFwsForMes.length === 0 || displayFwList.length === 0) {
    fwLabel = 'Sem FWs'
  } else if (displayFwList.length === allFwsForMes.length) {
    fwLabel = 'Todas FWs'
  } else if (displayFwList.length === 1) {
    fwLabel = fmtFw(displayFwList[0])
  } else if (displayFwList.length > MAX_FW_LABEL) {
    fwLabel = `${displayFwList.slice(0, MAX_FW_LABEL).map(fmtFw).join(', ')} …`
  } else {
    fwLabel = fwLabelFull
  }

  // Determine what the filter dropdown can offer
  const canFilterMes = meses.length > 1
  const canFilterFw  = fwsForActiveMeses.length > 1
  const filterEnabled = canFilterMes || canFilterFw

  // Whether any filter is active
  const isFiltered = (activeMeses.size > 0 && activeMeses.size < meses.length)
    || (activeFws.size > 0 && activeFws.size < fwsForActiveMeses.length)

  return (
    <div className="relative flex items-center gap-1" ref={ref}>
      {/* Info badge */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#0D9488]/10 border border-[#0D9488]/30 rounded text-xs text-[#0F766E] font-medium select-none shrink-0">
        <span className="font-semibold">{mesLabel}</span>
        <span className="text-[#0D9488]/50">|</span>
        <span title={fwLabel !== fwLabelFull ? fwLabelFull : undefined}>{fwLabel}</span>
      </div>

      {/* Filter button */}
      {filterEnabled && (
        <button
          type="button"
          title="Filtrar meses / semanas exibidos"
          onClick={() => setOpen(v => !v)}
          className={`p-1 rounded transition-colors ${
            isFiltered
              ? 'bg-[#0D9488]/15 text-[#0F766E] border border-[#0D9488]/30'
              : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
          }`}
        >
          <SlidersHorizontal size={12} />
        </button>
      )}

      {/* Filter dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded shadow-xl text-xs">
          <div className="px-2.5 py-1.5 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Filtro de exibição</span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 hover:bg-gray-100">
              <X size={10} className="text-gray-400" />
            </button>
          </div>

          {/* Two-column layout when both filters are available; single column otherwise */}
          <div className={canFilterMes && canFilterFw ? 'flex' : ''}>

            {canFilterMes && (
              <div className={canFilterFw ? 'min-w-[130px] border-r border-gray-100 max-h-[220px] overflow-y-auto' : 'min-w-[160px] max-h-[220px] overflow-y-auto'}>
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Meses</div>
                {/* "Todos" shortcut */}
                <div
                  className="px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-black"
                  onClick={() => { onChangeMeses(new Set()); setOpen(false) }}
                >
                  {activeMeses.size === 0
                    ? <CheckSquare size={12} className="text-[#0D9488] shrink-0" />
                    : <Square size={12} className="text-gray-400 shrink-0" />}
                  Todos
                </div>
                {meses.map(m => (
                  <div
                    key={m}
                    className="px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-black"
                    onClick={() => {
                      const next = new Set(activeMeses)
                      if (next.has(m)) next.delete(m); else next.add(m)
                      // If all months selected, treat as "no filter"
                      onChangeMeses(next.size === meses.length ? new Set() : next)
                    }}
                  >
                    {(activeMeses.size === 0 || activeMeses.has(m))
                      ? <CheckSquare size={12} className="text-[#0D9488] shrink-0" />
                      : <Square size={12} className="text-gray-400 shrink-0" />}
                    {String(m).padStart(2, '0')} {MES_LABELS[m] ?? m}
                  </div>
                ))}
              </div>
            )}

            {canFilterFw && (
              <div className="min-w-[90px] max-h-[220px] overflow-y-auto">
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Semanas</div>
                {/* "Todas" shortcut */}
                <div
                  className="px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-black"
                  onClick={() => { onChangeFws(new Set()); setOpen(false) }}
                >
                  {activeFws.size === 0
                    ? <CheckSquare size={12} className="text-[#0D9488] shrink-0" />
                    : <Square size={12} className="text-gray-400 shrink-0" />}
                  Todas
                </div>
                {fwsForActiveMeses.map(fw => (
                  <div
                    key={fw}
                    className="px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-black"
                    onClick={() => {
                      const next = new Set(activeFws)
                      if (next.has(fw)) next.delete(fw); else next.add(fw)
                      onChangeFws(next.size === fwsForActiveMeses.length ? new Set() : next)
                    }}
                  >
                    {(activeFws.size === 0 || activeFws.has(fw))
                      ? <CheckSquare size={12} className="text-[#0D9488] shrink-0" />
                      : <Square size={12} className="text-gray-400 shrink-0" />}
                    {fmtFw(fw)}
                  </div>
                ))}
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  )
}

// ── MainContent ────────────────────────────────────────────────────────────────

function MainContent({ mode }: { mode?: 'analise' | 'gantt' }) {
  const {
    visibleItems, items, highlightedItem, setHighlightedItem,
    importMeta, assemblyDetails, assemblyLoading,
    setAssemblyDetails, setAssemblyLoading, removeItem,
    filterTipo, availableTipos, filterWsn,
    solverBottleneckByWsn, optWsnDisabled, optWsnIgnored, solverWsnResults,
  } = useWorkspace()

  // Factory Load: dataset loaded via the Gantt launch flow (null in Capacity mode,
  // where no GanttInlineProvider is mounted, and until a period is loaded).
  const ganttInline = useGanttInlineMaybe()

  // ── Display period filter (subset of what was imported) ───────────
  // activeMeses: empty = no filter (all imported months); non-empty = only those months
  // activeFws:   empty = no filter (all imported FWs);    non-empty = only those FWs
  const [activeMeses, setActiveMeses] = useState<Set<number>>(new Set())
  const [activeFws,   setActiveFws]   = useState<Set<string>>(new Set())

  // Reset display filter whenever a new import happens
  useEffect(() => {
    setActiveMeses(new Set())
    setActiveFws(new Set())
  }, [importMeta])

  const blockRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [flashItem, setFlashItem] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const editFlashTimerRef = useRef<number | null>(null)
  const editIdleTimerRef = useRef<number | null>(null)
  const editAnchorTopRef = useRef<Record<string, number>>({})
  const smoothScrollRafRef = useRef<number | null>(null)

  const getScrollContainer = useCallback((): HTMLElement => {
    return document.querySelector('main.overflow-y-auto') as HTMLElement
      || (document.scrollingElement as HTMLElement)
      || document.documentElement
  }, [])

  const cancelSmoothScroll = useCallback(() => {
    if (smoothScrollRafRef.current != null) {
      window.cancelAnimationFrame(smoothScrollRafRef.current)
      smoothScrollRafRef.current = null
    }
  }, [])

  const smoothScrollItemToCenter = useCallback((el: HTMLElement) => {
    const scroller = getScrollContainer()
    if (!scroller) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const startY = scroller.scrollTop
    const maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const targetY = Math.max(
      0,
      Math.min(maxY, startY + (rect.top - scrollerRect.top) - ((scroller.clientHeight - rect.height) / 2)),
    )
    const distance = targetY - startY

    if (Math.abs(distance) < 1) return
    // No `prefers-reduced-motion` jump-cut here: on Windows the flag mirrors "Animation effects",
    // a display preference rather than a request for a still screen, so honoring it teleported the
    // list for users who never asked — and a jump loses the sense of WHERE the item came from,
    // which is the whole point of scrolling to it. Same call as the rest of the app; see the note
    // in components/gantt/LocomotiveProgress.tsx.

    // Duration scales with travel distance so long jumps do not look like teleports.
    const duration = Math.max(240, Math.min(1400, Math.abs(distance) * 0.65))
    const easeInOutCubic = (t: number) =>
      t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2

    cancelSmoothScroll()
    let startTs: number | null = null
    const step = (ts: number) => {
      if (startTs == null) startTs = ts
      const progress = Math.min(1, (ts - startTs) / duration)
      const y = startY + distance * easeInOutCubic(progress)
      scroller.scrollTop = y
      if (progress < 1) {
        smoothScrollRafRef.current = window.requestAnimationFrame(step)
      } else {
        smoothScrollRafRef.current = null
      }
    }
    smoothScrollRafRef.current = window.requestAnimationFrame(step)
  }, [cancelSmoothScroll, getScrollContainer])

  // Disabled operations: item → scope → set of 0-based operation-row indices.
  // Kept local to MainContent because it's purely display state that doesn't
  // need to reach the global context (assemblyDetails is mutated on toggle).
  const [disabledOps, setDisabledOps] = useState<Record<string, Record<string, Set<number>>>>({})

  // Week plan for "adicionar" items: itemId → scope → selected FW week string.
  const [weekPlan, setWeekPlan] = useState<Record<string, Record<string, string>>>({})

  function handleWeekChange(itemId: string, scope: ScopeKey, fw: string) {
    setWeekPlan(prev => ({
      ...prev,
      [itemId]: { ...(prev[itemId] ?? {}), [scope]: fw },
    }))
  }

  /** Bulk-set the disabled ops for a scope (used by the ops-selector panel). */
  function handleSetScopeOps(itemCode: string, scope: ScopeKey, disabled: Set<number>) {
    setDisabledOps(prev => ({
      ...prev,
      [itemCode]: { ...(prev[itemCode] ?? {}), [scope]: new Set(disabled) },
    }))
  }

  // Fetch assembly details when items or display filter changes
  useEffect(() => {
    if (items.length === 0) {
      setAssemblyDetails({})
      setDisabledOps({})
      return
    }

    let cancelled = false
    setAssemblyLoading(true)
    // Carga de Fábrica items carry their OWN quantities (from the loaded schedule) and have no
    // monthly-plan rows for those fiscal weeks, so the period-filtered route drops them and they
    // arrive with no operations and 0 h. They are resolved through the explicit-demand route
    // instead — same ASSEMBLY lookup, qty + ESCOPO supplied by the item. A workspace can hold
    // both kinds at once (Adicionar/Append), so both calls run and their results merge.
    const planItems = items.filter(it => it.origin !== 'factoryLoad')
    const flItems   = items.filter(it => it.origin === 'factoryLoad')
    const itemCodes = planItems.map(it => it.item)

    // Determine effective FWs: activeFws filter takes priority over importMeta selection
    const effectiveFws = activeFws.size > 0
      ? [...activeFws]
      : (importMeta?.selectedFws ?? [])

    // Always send FWs when available so the backend filters by the FW column,
    // not the MES column. The previous logic only forwarded fws when they were
    // a strict subset of allFwsForMes, falling back to mes-only filtering for
    // the "all FWs selected" case. Because FWs can span calendar-month
    // boundaries, the MES column can disagree with FW membership, causing
    // MENSAL totals to differ from the sum of individual SEMANAL FW calls.
    const fwsParam = effectiveFws.length > 0 ? effectiveFws : undefined

    // Use the month filter only as a last resort when no FW list is available
    // (e.g. anual mode before any FW selection). When fwsParam is set, FW-based
    // filtering is sufficient and consistent with the SEMANAL per-FW behaviour.
    const effectiveMes = fwsParam != null ? undefined : (
      activeMeses.size === 1
        ? [...activeMeses][0]
        : (activeMeses.size === 0 ? (importMeta?.mes ?? undefined) : undefined)
    )

    const EMPTY_DETAILS: AssemblyDetailsResponse = { status: 'ok', message: '', items: [] }
    Promise.all([
      itemCodes.length > 0
        ? getAssemblyDetails({
            items: itemCodes,
            mes:   effectiveMes,
            fws:   fwsParam,
            mode:  importMeta?.mode ?? 'mensal',
          })
        : Promise.resolve(EMPTY_DETAILS),
      flItems.length > 0
        ? getAssemblyDetailsForDemand({
            items: flItems.map(it => ({
              item:  it.item,
              qty:   Number(it.qtde_fw) || 0,
              // The schedule's ESCOPO values select which operations apply (they map onto the
              // routing's TIPO column). Ignored server-side when none of them match.
              tipos: it.tipo_fw ?? [],
              // …and how many units each of those ESCOPOs covers, so an item carrying two of
              // them is 5 units through both steps rather than 10 whole items.
              tipoQty: it.tipoQty,
            })),
          })
        : Promise.resolve(EMPTY_DETAILS),
    ])
      .then(([planRes, flRes]) => {
        if (cancelled) return
        const res = { items: [...planRes.items, ...flRes.items] }
        const map: Record<string, typeof res.items[0]> = {}
        for (const d of res.items) {
          const scopes = { ...d.scopes }
          for (const scope of d.scopes_present) {
            const sd = scopes[scope]
            if (!sd) continue
            scopes[scope] = {
              ...sd,
              __import_qty: (sd as { __import_qty?: number }).__import_qty ?? sd.qty,
            } as typeof sd
          }
          map[d.item] = { ...d, scopes }
        }
        // A part number with NO ASSEMBLY mapping returns no detail row, and every consumer keys
        // on `assemblyDetails[item]` — so it would be imported and then silently vanish from the
        // tab. Carga de Fábrica items carry `hasRouting: false` in exactly that case, and they
        // are real scheduled production that must stay listed. They get a placeholder detail:
        // their own quantity, NO operations and 0 routed hours (there is no WSN to route to).
        // `planHours` rides along on the item for the day Plano de Produção hours are wired in
        // as the alternative source.
        // Scoped to `hasRouting === false` on purpose: a mapped item that returns no row is a
        // legitimate period miss (the FW/mês filter excluded it) and must keep disappearing.
        for (const it of items) {
          if (map[it.item] || it.hasRouting !== false) continue
          const qty = Number(it.qtde_fw) || 0
          map[it.item] = {
            item:           it.item,
            descricao:      it.descricao ?? '',
            scopes_present: ['UNICO'],
            total_h:        0,
            scopes: {
              UNICO: {
                total_h: 0, qty, hours_per_unit: 0,
                wsn_count: 0, wsns: [], operations: [],
              },
            },
          }
        }
        setAssemblyDetails(map)
      })
      .catch(err => {
        if (!cancelled) console.error('[assembly-details]', err)
      })
      .finally(() => {
        if (!cancelled) setAssemblyLoading(false)
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, importMeta, activeMeses, activeFws])

  /**
   * When the user edits a qty in an AssemblyBlock, recompute that item's
   * total_h and WSN hours in context so DEMANDA in the footer updates.
   * Solver KPIs (DISPONIVEL, ALOCADO) are independent and remain unchanged.
   */
  function handleQtysChange(itemCode: string, newQtys: Record<ScopeKey, number>) {
    const currentEl = blockRefs.current[itemCode]
    if (currentEl) {
      editAnchorTopRef.current[itemCode] = currentEl.getBoundingClientRect().top
    }
    setEditingItem(itemCode)
    if (editIdleTimerRef.current) window.clearTimeout(editIdleTimerRef.current)
    editIdleTimerRef.current = window.setTimeout(() => setEditingItem(null), 280)

    setAssemblyDetails(prev => {
      const detail = prev[itemCode]
      if (!detail) return prev
      const newScopes = { ...detail.scopes }
      const EPS = 1e-9
      let newTotalH = 0

      for (const scope of detail.scopes_present) {
        const sd = detail.scopes[scope]
        if (!sd) continue

        const newQty = newQtys[scope] ?? 0
        const prevQty = sd.qty ?? 0
        const importQty = (sd as { __import_qty?: number }).__import_qty ?? prevQty

        if (newQty === prevQty) {
          newScopes[scope] = sd
          newTotalH += sd.total_h ?? 0
          continue
        }

        const opsRaw = (sd.operations ?? []).map(op => ({
          ...op,
          __base_hh_total: (op as { __base_hh_total?: number }).__base_hh_total ?? op.hh_total,
        }))
        const baseOpsUnitH = opsRaw.reduce((s, op) => s + (op.hh_unit ?? 0), 0)

        const wsnsRaw = (sd.wsns ?? []).map(w => ({
          ...w,
          __base_hours: (w as { __base_hours?: number }).__base_hours ?? w.hours,
        }))

        const baseHpu =
          (sd as { __base_hpu?: number }).__base_hpu
          ?? (sd.hours_per_unit > EPS
            ? sd.hours_per_unit
            : (baseOpsUnitH > EPS
              ? baseOpsUnitH
              : (prevQty > 0 ? ((sd.total_h ?? 0) / prevQty) : 0)))

        const newScopeH = baseHpu * newQty

        let newOperations = opsRaw
        let newWsns = wsnsRaw

        if (opsRaw.length > 0) {
          const baseOpsTotal = opsRaw.reduce((s, op) => s + ((op.__base_hh_total as number) || 0), 0)
          const opScale = baseOpsTotal > EPS ? newScopeH / baseOpsTotal : 0
          newOperations = opsRaw.map(op => ({
            ...op,
            hh_total: ((op.__base_hh_total as number) || 0) * opScale,
          }))

          const acc = new Map<string, { hours: number; description: string }>()
          for (const op of newOperations) {
            if (!op.wsn) continue
            const prevW = acc.get(op.wsn) ?? { hours: 0, description: op.desc || '' }
            prevW.hours += op.hh_total
            if (!prevW.description && op.desc) prevW.description = op.desc
            acc.set(op.wsn, prevW)
          }

          newWsns = wsnsRaw.map(w => {
            const hit = acc.get(w.wsn)
            return {
              ...w,
              hours: hit?.hours ?? 0,
              description: hit?.description || w.description,
            }
          })
        } else {
          const baseWsnTotal = wsnsRaw.reduce((s, w) => s + (((w as { __base_hours?: number }).__base_hours) ?? 0), 0)
          const wsScale = baseWsnTotal > EPS ? newScopeH / baseWsnTotal : 0
          newWsns = wsnsRaw.map(w => ({
            ...w,
            hours: (((w as { __base_hours?: number }).__base_hours) ?? 0) * wsScale,
          }))
        }

        const hasOps = opsRaw.length > 0
        const newTotalByOps = newOperations.reduce((s, op) => s + (op.hh_total ?? 0), 0)
        const newTotalByWsn = newWsns.reduce((s, w) => s + (w.hours ?? 0), 0)
        const normalizedScopeH = hasOps ? newTotalByOps : newTotalByWsn
        const displayWsnCount = hasOps
          ? new Set(newOperations.map(op => op.wsn).filter(Boolean)).size
          : newWsns.filter(w => (w.hours ?? 0) > EPS).length

        newScopes[scope] = {
          ...sd,
          total_h: normalizedScopeH,
          qty: newQty,
          hours_per_unit: baseHpu,
          wsn_count: displayWsnCount,
          wsns: newWsns,
          operations: newOperations,
          __base_hpu: baseHpu,
          __import_qty: importQty,
        } as typeof sd

        newTotalH += normalizedScopeH
      }

      return { ...prev, [itemCode]: { ...detail, total_h: newTotalH, scopes: newScopes } }
    })
  }

  // While the user edits qty, keep the item centered even when resorting moves it.
  useEffect(() => {
    if (!editingItem) return
    const t = window.setTimeout(() => {
      const el = blockRefs.current[editingItem]
      if (!el) return
      const prevTop = editAnchorTopRef.current[editingItem]
      const nextTop = el.getBoundingClientRect().top
      const moved = prevTop != null && Math.abs(nextTop - prevTop) > 20

      if (moved) {
        setFlashItem(editingItem)
        if (editFlashTimerRef.current) window.clearTimeout(editFlashTimerRef.current)
        editFlashTimerRef.current = window.setTimeout(() => setFlashItem(null), 700)
      }
      editAnchorTopRef.current[editingItem] = nextTop
    }, 60)
    return () => window.clearTimeout(t)
  }, [editingItem, assemblyDetails])

  useEffect(() => () => {
    cancelSmoothScroll()
    if (editFlashTimerRef.current) window.clearTimeout(editFlashTimerRef.current)
    if (editIdleTimerRef.current) window.clearTimeout(editIdleTimerRef.current)
  }, [cancelSmoothScroll])

  /**
   * Toggle an individual operation row disabled/enabled.
   * Mutates assemblyDetails so WSN hours, scope totals and the footer demand
   * update automatically without a backend roundtrip.
   */
  function handleToggleOp(itemCode: string, scope: ScopeKey, opIdx: number) {
    // Compute new disabled set synchronously to avoid stale-closure issues
    // when we use the value inside the setAssemblyDetails updater below.
    const prevSet = disabledOps[itemCode]?.[scope] ?? new Set<number>()
    const newSet  = new Set(prevSet)
    if (newSet.has(opIdx)) newSet.delete(opIdx); else newSet.add(opIdx)

    setDisabledOps(prev => ({
      ...prev,
      [itemCode]: { ...(prev[itemCode] ?? {}), [scope]: newSet },
    }))

    setAssemblyDetails(prev => {
      const detail = prev[itemCode]
      if (!detail) return prev
      const sd = detail.scopes[scope]
      if (!sd) return prev

      let newTotalH: number
      let newHpu:    number
      let newWsns:   { wsn: string; hours: number; description?: string }[]
      let newWsnCount: number

      if (sd.operations && sd.operations.length > 0) {
        // Operation-level granularity: recompute WSN hours from active ops only
        const wsnAcc = new Map<string, { hours: number; description: string }>()
        for (const [idx, op] of sd.operations.entries()) {
          if (!op.wsn || newSet.has(idx)) continue
          const ex = wsnAcc.get(op.wsn) ?? { hours: 0, description: op.desc || '' }
          ex.hours += op.hh_total
          if (!ex.description && op.desc) ex.description = op.desc
          wsnAcc.set(op.wsn, ex)
        }
        newWsns     = [...wsnAcc.entries()].map(([wsn, d]) => ({ wsn, hours: d.hours, description: d.description }))
        newTotalH   = sd.operations.filter((_, i) => !newSet.has(i)).reduce((s, op) => s + op.hh_total, 0)
        newWsnCount = newWsns.length
      } else {
        // WSN-level rows (fallback when no operations data): disable whole WSN
        newWsns     = (sd.wsns ?? []).filter((_, i) => !newSet.has(i))
        newTotalH   = newWsns.reduce((s, w) => s + w.hours, 0)
        newWsnCount = newWsns.length
      }

      newHpu = sd.qty > 0 ? newTotalH / sd.qty : 0

      const newSd = { ...sd, total_h: newTotalH, hours_per_unit: newHpu, wsns: newWsns, wsn_count: newWsnCount }
      const newScopes = { ...detail.scopes, [scope]: newSd }

      // Recompute item-level total_h across all scopes
      let itemTotalH = 0
      for (const s of detail.scopes_present) {
        itemTotalH += s === scope ? newTotalH : (detail.scopes[s]?.total_h ?? 0)
      }

      return { ...prev, [itemCode]: { ...detail, scopes: newScopes, total_h: itemTotalH } }
    })
  }

  // Scroll to and flash the highlighted item when it changes
  useEffect(() => {
    const el = highlightedItem ? blockRefs.current[highlightedItem] : null
    if (el) {
      smoothScrollItemToCenter(el)
      setFlashItem(highlightedItem)
      const t = setTimeout(() => {
        setFlashItem(null)
        setHighlightedItem(null)
      }, 2000)
      return () => clearTimeout(t)
    }
  }, [highlightedItem, setHighlightedItem, smoothScrollItemToCenter])

  const filteredDetailsByItem = useMemo(() => {
    const out: Record<string, typeof assemblyDetails[string]> = {}
    for (const item of visibleItems) {
      const detail = assemblyDetails[item.item]
      if (!detail) continue
      const filtered = applyAssemblyDetailFilters(detail, {
        filterTipo,
        availableTipos,
        filterWsn,
      })
      if (filtered) out[item.item] = filtered
    }
    return out
  }, [visibleItems, assemblyDetails, filterTipo, availableTipos, filterWsn])

  // Order visible items by filtered total_h (highest demand first), then alphabetical
  const displayedItems = [...visibleItems]
    .filter(it => assemblyLoading || !!filteredDetailsByItem[it.item])
    .sort((a, b) => {
      const ha = filteredDetailsByItem[a.item]?.total_h ?? 0
      const hb = filteredDetailsByItem[b.item]?.total_h ?? 0
      if (hb !== ha) return hb - ha
      return a.item.localeCompare(b.item)
    })

  const isFiltered = displayedItems.length !== items.length

  // WSNs that are bottlenecks after last optimization (excluding ignored/disabled overrides)
  // Still used by footer/useFooterStats for NAO ATENDIDOS count
  const bottleneckWsns = useMemo(() => {
    if (!solverBottleneckByWsn) return new Set<string>()
    const s = new Set<string>()
    for (const wsn of Object.keys(solverBottleneckByWsn)) {
      if (!optWsnDisabled.has(wsn) && !optWsnIgnored.has(wsn)) s.add(wsn)
    }
    return s
  }, [solverBottleneckByWsn, optWsnDisabled, optWsnIgnored])

  // Item codes that won't be fully served — NIVEL greedy simulation per bottleneck WSN.
  // Returns a Map<itemCode, unservedUnits> where unservedUnits is computed with partial
  // allocation: items are served highest-NIVEL first; if remaining capacity only covers
  // some units, only those units are marked as unserved (not the item's full quantity).
  const bottleneckItemCodes = useMemo<Map<string, number> | null>(() => {
    if (!solverWsnResults) return null
    const unservedMap = new Map<string, number>()
    for (const [wsn, wr] of Object.entries(solverWsnResults)) {
      if (optWsnDisabled.has(wsn) || optWsnIgnored.has(wsn)) continue
      if (wr.unmet <= 1e-4) continue
      // Collect items that pass through this WSN with their NIVEL, hours and total units
      const itemsAtWsn: Array<{ item: string; nivel: number; hours: number; totalUnits: number }> = []
      for (const [itemCode, detail] of Object.entries(assemblyDetails)) {
        let h = 0
        let totalUnits = 0
        for (const sd of Object.values(detail.scopes)) {
          if (!sd) continue
          for (const w of (sd.wsns ?? [])) { if (w.wsn === wsn) h += w.hours }
          totalUnits += sd.qty ?? 0
        }
        if (h <= 1e-9) continue
        const raw = String(items.find(it => it.item === itemCode)?.nivel ?? '0')
        const nivel = parseFloat(raw.replace(/[^0-9.]/g, '')) || 0
        itemsAtWsn.push({ item: itemCode, nivel, hours: h, totalUnits })
      }
      // Sort by NIVEL desc (higher priority served first)
      itemsAtWsn.sort((a, b) => b.nivel - a.nivel)
      let acc = 0
      for (const { item, hours, totalUnits } of itemsAtWsn) {
        if (acc >= wr.covered - 1e-4) {
          // No capacity left — fully unserved
          unservedMap.set(item, Math.max(unservedMap.get(item) ?? 0, totalUnits))
        } else if (acc + hours <= wr.covered + 1e-4) {
          // Fully served — consume capacity
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
    return unservedMap.size > 0 ? unservedMap : null
  }, [solverWsnResults, assemblyDetails, items, optWsnDisabled, optWsnIgnored])

  // Factory Load main page (Phase 1): once a period is loaded and the Gantt was
  // opened, the page is populated (left half) with the planned-production overview.
  if (mode === 'gantt' && ganttInline?.data) {
    return <FactoryLoadHome />
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-gray-400 select-none" style={{ height: '100%' }}>
        <div className="w-24 h-24 rounded-full border-2 border-dashed border-gray-300 bg-white flex items-center justify-center shadow-sm">
          {mode === 'gantt' ? (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
              <line x1="8" y1="14" x2="13" y2="14"/>
              <line x1="8" y1="18" x2="16" y2="18"/>
            </svg>
          ) : (
            <Package2 size={34} className="text-gray-300" />
          )}
        </div>
        {mode === 'gantt' ? (
          <>
            <p className="text-2xl font-semibold text-gray-800 leading-tight">Master Schedule</p>
            <p className="text-base md:text-lg text-gray-400 leading-relaxed text-center max-w-[720px]">
              Clique no botão <span className="font-semibold text-[#0D9488]">Gantt</span> na barra de ferramentas para definir um período e visualizar o Master Schedule.
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold text-gray-800 leading-tight">Nenhum item carregado</p>
            <p className="text-base md:text-lg text-gray-400 leading-relaxed text-center max-w-[720px]">
              Use o botão <span className="font-semibold text-[#0D9488]">Simular</span> na barra de ferramentas para importar novos itens.
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      {/* Info bar: month/FW badge + item count */}
      <div className="flex items-center gap-3 mb-4">
        {importMeta && (
          <MesFwInfoBox
            importMeta={importMeta}
            activeMeses={activeMeses}
            activeFws={activeFws}
            onChangeMeses={setActiveMeses}
            onChangeFws={setActiveFws}
          />
        )}
        <p className="text-sm text-gray-700">
          <span className="font-semibold">{displayedItems.length}</span>
          {isFiltered && (
            <span className="text-gray-400"> de {items.length}</span>
          )}
          {' '}item{displayedItems.length !== 1 ? 's' : ''} importado{displayedItems.length !== 1 ? 's' : ''}.
          {isFiltered && (
            <span className="text-gray-400 ml-1">(filtrado)</span>
          )}
        </p>
        {assemblyLoading && (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <img src="/imagens/mark.svg" alt="" width={16} height={16} className="animate-spin" />
            Carregando dados…
          </span>
        )}
      </div>

      {/* Assembly blocks — one per item, sorted by demand */}
      <div className="flex flex-col gap-3">
        {displayedItems.map(it => {
          const detail = filteredDetailsByItem[it.item]

          // Show skeleton while assembly details are loading.
          // Once loading finishes, items not returned by the backend (no data
          // for the selected period) are hidden rather than left as grey boxes.
          if (!detail) {
            if (assemblyLoading) {
              return (
                <div
                  key={it.id}
                  ref={el => {
                    blockRefs.current[it.id] = el
                    blockRefs.current[it.item] = el
                  }}
                  className="h-[140px] rounded-lg border border-gray-200 bg-gray-50 animate-pulse"
                />
              )
            }
            return null   // item not in spreadsheet at all
          }

          return (
            <div
              key={it.id}
              ref={el => {
                blockRefs.current[it.id] = el
                blockRefs.current[it.item] = el
              }}
            >
              {(() => {
                // For "adicionar" items, override scope qtys to 1 in MEDIO (or UNICO)
                // so they don't inherit the real demand qty of the same item code.
                let effectiveDetail = detail
                const scopePriority: ScopeKey[] = ['MEDIO', 'UNICO', 'PESADO', 'LEVE']
                const targetScope = scopePriority.find(s => detail.scopes_present.includes(s as ScopeKey)) as ScopeKey
                if (it.source === 'adicionar') {
                  const overriddenScopes = {} as typeof detail.scopes
                  for (const sc of detail.scopes_present) {
                    const sd = detail.scopes[sc]
                    const active = sc === targetScope
                    overriddenScopes[sc] = {
                      ...sd,
                      qty: active ? 1 : 0,
                      total_h: active ? (sd?.hours_per_unit ?? 0) : 0,
                    } as typeof sd
                  }
                  effectiveDetail = { ...detail, scopes: overriddenScopes }
                }

                // Baseline = exactly what "Resetar quantidades" would write back. The block
                // compares it against the live qtys and only offers the reset button when the
                // user actually moved something away from the imported values.
                const baselineQtys: Record<ScopeKey, number> = { LEVE: 0, MEDIO: 0, PESADO: 0, UNICO: 0 }
                if (importMeta !== null) {
                  if (it.source === 'adicionar') {
                    if (targetScope) baselineQtys[targetScope] = 1
                  } else {
                    const sourceDetail = assemblyDetails[it.item]
                    for (const scope of sourceDetail?.scopes_present ?? []) {
                      const sd = sourceDetail?.scopes[scope]
                      if (!sd) continue
                      const importQty = (sd as { __import_qty?: number }).__import_qty
                      const q = Number(importQty ?? sd.qty ?? 0)
                      baselineQtys[scope] = Number.isFinite(q) ? Math.max(0, q) : 0
                    }
                  }
                }
                return (
              <AssemblyBlock
                detail={effectiveDetail}
                highlighted={flashItem === it.id || flashItem === it.item}
                catalogMode={importMeta === null}
                fallbackDescricao={it.descricao}
                cliente={it.cliente}
                familia={it.familia}
                nivel={it.nivel}
                clients={it.clients}
                onQtysChange={handleQtysChange}
                onResetQtys={
                  it.source === 'adicionar' || assemblyDetails[it.item]
                    ? () => handleQtysChange(it.item, baselineQtys)
                    : undefined
                }
                baselineQtys={baselineQtys}
                onRemove={() => removeItem(it.item)}
                disabledOps={disabledOps[it.item]}
                onToggleOp={(scope, opIdx) => handleToggleOp(it.item, scope as ScopeKey, opIdx)}
                activeWsnFilter={filterWsn}
                isAdicionarItem={it.source === 'adicionar'}
                weekPlan={weekPlan[it.id] ?? {}}
                onWeekChange={(scope, fw) => handleWeekChange(it.id, scope as ScopeKey, fw)}
                availableFws={importMeta?.mode === 'semanal'
                  ? (importMeta?.selectedFws ?? [])
                  : (importMeta?.allFwsForMes ?? [])}
                onSetScopeOps={(scope, disabled) => handleSetScopeOps(it.item, scope as ScopeKey, disabled)}
                bottleneckUnservedQty={bottleneckItemCodes ?? undefined}
              />
                )
              })()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── App-level navigation ─────────────────────────────────────────────────────
// 'home' → landing page, 'analise' → Capacity app, 'gantt' → Factory Load app.
// Both app instances stay mounted (hidden via CSS) so their state is preserved
// when the user navigates back to home and then returns to an app.
type AppView = 'home' | 'analise' | 'gantt'

// Where each view sits on ONE horizontal axis, which is the only input the page turn needs.
// It is not arbitrary: both Home views put Capacity on the LEFT and Factory Load on the RIGHT,
// so this ordering is what the user is already looking at when they click. Deriving the
// direction from it means every switch turns toward where the destination lives, the return
// trip always mirrors the trip in, and on the showcase Home the half that expands under the
// click leaves in the same direction the page then turns.
const VIEW_AXIS: Record<AppView, number> = { analise: 0, home: 1, gantt: 2 }

export default function Home() {
  const { isAuthenticated, tokenReady } = useAuth()
  const sessionExpired = isAuthenticated && tokenReady === 'reauth-required'

  const [currentView, setCurrentView] = useState<AppView>('home')

  // ── Page slide ─────────────────────────────────────────────────────────────
  // Every view change animates: Home → app (forward, page turns left), app ↔ app via the
  // train button, and the Home button back out (reverse, page turns right).
  //
  // `display` cannot be animated, so for the length of the switch BOTH shells become real
  // boxes — `position: fixed; inset: 0` — and one translates in while the other translates
  // out. Making each a viewport-sized fixed box is what keeps this safe: a transformed
  // ancestor becomes the containing block for its `position: fixed` descendants (every modal,
  // popover and overlay in the app), and a viewport-sized box anchors them exactly where the
  // viewport would. The inline transform is then removed completely on landing, so nothing is
  // left anchored to a transformed ancestor once the slide is over.
  type Slide = { from: AppView; to: AppView; dir: 1 | -1 }
  const [slide, setSlide] = useState<Slide | null>(null)
  const [slideRunning, setSlideRunning] = useState(false)
  const slideTimerRef = useRef<number | null>(null)

  useEffect(() => () => { if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current) }, [])

  const goToApp = useCallback((to: AppView) => {
    if (currentView === to || slide) return   // already there, or a switch is in flight
    // The `prefers-reduced-motion` shortcut that used to cut straight to `setCurrentView` is gone:
    // on Windows that flag mirrors "Animation effects", a display preference, so it snapped the app
    // switch for users who never asked for it — and the turn direction is what tells you whether
    // you went deeper or came back out. See components/gantt/LocomotiveProgress.tsx.
    // The turn follows the layout, not a depth metaphor. Treating Home as "outermost" sent BOTH
    // apps out to the same side, so opening Capacity — the module drawn on the left — turned the
    // page as if it lived on the right, against the half that had just expanded under the cursor.
    const dir: 1 | -1 = VIEW_AXIS[to] > VIEW_AXIS[currentView] ? 1 : -1
    setSlide({ from: currentView, to, dir })
  }, [currentView, slide])

  // Kick the transition one frame after both shells are laid out at their start positions —
  // setting the start and end transform in the same frame would skip the animation entirely.
  useEffect(() => {
    if (!slide || slideRunning) return
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setSlideRunning(true)))
    return () => cancelAnimationFrame(raf)
  }, [slide, slideRunning])

  const finishSlide = useCallback(() => {
    if (!slide) return
    if (slideTimerRef.current) { window.clearTimeout(slideTimerRef.current); slideTimerRef.current = null }
    setCurrentView(slide.to)
    setSlide(null)
    setSlideRunning(false)
  }, [slide])

  // `transitionend` is the primary signal; the timer is the safety net for the cases where it
  // never fires (background tab, interrupted compositor) and would otherwise strand both
  // shells mid-slide.
  useEffect(() => {
    if (!slideRunning) return
    slideTimerRef.current = window.setTimeout(finishSlide, 600)
    return () => { if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current) }
  }, [slideRunning, finishSlide])

  // Transition events BUBBLE, and the shells contain plenty of transformed descendants (the
  // locomotive icon's own nudge, for one). Without the target check, a hover animation inside
  // the header would land the page slide early.
  const onSlideEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return
    finishSlide()
  }, [finishSlide])

  // ── The three view subtrees, built ONCE ─────────────────────────────────────────────────
  //
  // Both app shells stay mounted for the whole session, so React re-renders BOTH of them on
  // every render of this component — and a view switch renders it three times (setSlide,
  // setSlideRunning, finishSlide). With a period loaded that is three full reconciliations of
  // a populated Carga de Fábrica tree plus the Capacity one, all of it landing in the frames
  // where the Home showcase is driving its springs on a rAF loop, which is why the stutter only
  // appears once the apps HOLD DATA: with nothing loaded these trees are an empty-state card.
  //
  // Freezing each subtree in a `useMemo` makes the returned element IDENTICAL across those
  // renders, and React bails out of re-rendering a child whose element is reference-equal. The
  // wrapper <div> around it still gets its new style (display/transform), which is the only
  // thing the slide actually needs to change. Providers inside keep re-rendering their own
  // consumers normally — nothing about data flow changes, only the re-render that changed
  // nothing gets skipped.
  //
  // This needs the handlers to be stable, and `goToApp` is not: it closes over `currentView`
  // and `slide`, so it is a new function on exactly the renders being optimised away. The ref
  // indirection below gives each shell a callback identity that never changes while still
  // calling the current implementation.
  const goToAppRef = useRef(goToApp)
  useEffect(() => { goToAppRef.current = goToApp }, [goToApp])
  const goHome    = useCallback(() => goToAppRef.current('home'),    [])
  const goAnalise = useCallback(() => goToAppRef.current('analise'), [])
  const goGantt   = useCallback(() => goToAppRef.current('gantt'),   [])

  const homeSubtree = useMemo(() => (
    <AppErrorBoundary name="Home">
      <HomeView onOpenAnalise={goAnalise} onOpenGantt={goGantt} />
    </AppErrorBoundary>
  ), [goAnalise, goGantt])

  const analiseSubtree = useMemo(() => (
    <WorkspaceProvider>
      {/* Per-app boundary. A crash inside one app must not take the other one — nor the
          datasets, overrides and scenarios both of them are holding in state — down with it;
          only a failure above this point reaches app/error.tsx. */}
      <AppErrorBoundary name="Análise de Capacidade">
        <LayoutShell onGoHome={goHome} onSwitchApp={goGantt} mode="analise">
          <MainContent mode="analise" />
        </LayoutShell>
      </AppErrorBoundary>
    </WorkspaceProvider>
  ), [goHome, goGantt])

  const ganttSubtree = useMemo(() => (
    <WorkspaceProvider>
      <GanttInlineProvider>
        <AppErrorBoundary name="Carga de Fábrica">
          <LayoutShell onGoHome={goHome} onSwitchApp={goAnalise} mode="gantt">
            <MainContent mode="gantt" />
          </LayoutShell>
        </AppErrorBoundary>
      </GanttInlineProvider>
    </WorkspaceProvider>
  ), [goHome, goAnalise])

  /** Wrapper style for one view: `display` toggling when idle, a slide track mid-switch.
   *  Mid-slide no `display` is set at all, so the div falls back to `block` — `contents`
   *  would discard the box the transform needs. */
  const appStyle = (view: AppView): CSSProperties => {
    // Home is a plain block; the app shells are `contents` so LayoutShell's flex column
    // still measures against the viewport rather than this wrapper.
    const idle = view === 'home' ? 'block' : 'contents'
    if (!slide) return { display: currentView === view ? idle : 'none' }
    const isFrom = slide.from === view
    const isTo   = slide.to === view
    if (!isFrom && !isTo) return { display: 'none' }
    const offset = isFrom
      ? (slideRunning ? -100 * slide.dir : 0)
      : (slideRunning ? 0 : 100 * slide.dir)
    return {
      position: 'fixed',
      inset: 0,
      overflow: 'hidden',
      zIndex: isTo ? 2 : 1,
      transform: `translateX(${offset}%)`,
    }
  }

  return (
    // Both apps below are permanently mounted, so each has its OWN AppHeader with its own
    // Gantt state. This provider is the only thing spanning them: the Carga de Fábrica header
    // publishes the loaded dataset here and the Capacity header reads it, which is what makes
    // "Simular → Carga de Fábrica" reachable at all. It must stay ABOVE both app divs.
    <FactoryLoadShareProvider>
      {/* Login modal blocks the entire UI until authenticated */}
      {(!isAuthenticated || sessionExpired) && <LoginModal sessionExpired={sessionExpired} />}


      {/* Failed-password lockout — generic notice + UI privilege revocation */}
      <LockoutOverlay />

      {/* Hard admin ban — full-screen access-denied page (server-authoritative) */}
      <BlockedOverlay />

      {/* ── Home landing page ──────────────────────────────────── */}
      <div
        className={slide ? 'app-slide' : undefined}
        style={appStyle('home')}
        onTransitionEnd={onSlideEnd}
      >
        {homeSubtree}
      </div>

      {/* ── Análise de Capacidade app ──────────────────────────── */}
      {/* Always mounted; hidden when not active to preserve state */}
      <div
        className={slide ? 'app-slide' : undefined}
        style={appStyle('analise')}
        onTransitionEnd={onSlideEnd}
      >
        {analiseSubtree}
      </div>

      {/* ── Carga de Fábrica app ───────────────────────────────── */}
      {/* Always mounted; hidden when not active to preserve state */}
      <div
        className={slide ? 'app-slide' : undefined}
        style={appStyle('gantt')}
        onTransitionEnd={onSlideEnd}
      >
        {ganttSubtree}
      </div>
    </FactoryLoadShareProvider>
  )
}
