'use client'
import React, { useState, useEffect, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, Download, CalendarDays, ListChecks, CheckSquare, Square, Percent } from 'lucide-react'
import type { AssemblyDetail, AssemblyOperationRow, ScopeKey } from '@/lib/api'
import { SCOPE_COLOR, SCOPE_LABEL } from '@/lib/assemblyConstants'

const SCOPE_BG_LIGHT: Record<ScopeKey, string> = {
  LEVE:   '#E8F5E9',
  MEDIO:  '#FFF3E0',
  PESADO: '#FFEBEE',
  UNICO:  '#F3E5F5',
}

function fmt2(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
function fmt1(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function buildRows(detail: AssemblyDetail, scope: ScopeKey, activeWsnFilter?: Set<string>): AssemblyOperationRow[] {
  const sd = detail.scopes[scope]
  if (!sd) return []
  const hasWsnFilter = !!activeWsnFilter && activeWsnFilter.size > 0
  if (sd.operations && sd.operations.length > 0) {
    return hasWsnFilter
      ? sd.operations.filter(op => activeWsnFilter.has(op.wsn))
      : sd.operations
  }
  const filteredWsns = hasWsnFilter
    ? (sd.wsns ?? []).filter(w => activeWsnFilter.has(w.wsn))
    : (sd.wsns ?? [])
  return filteredWsns.map((w, i) => ({
    n: i + 1, component: '', op: '', tipo: '',
    wsn: w.wsn, desc: w.description ?? '',
    hh_unit: 0, hh_total: w.hours,
  }))
}

function TotalsRow({ allRows, enabledRows, scopeColor, extraLeadCol = false }: {
  allRows: AssemblyOperationRow[]; enabledRows: AssemblyOperationRow[]
  scopeColor: string; extraLeadCol?: boolean
}) {
  const totalHhUnit  = enabledRows.reduce((s, r) => s + r.hh_unit,  0)
  const totalHhTotal = enabledRows.reduce((s, r) => s + r.hh_total, 0)
  const nOps  = allRows.length
  const nComp = new Set(allRows.map(r => r.component).filter(Boolean)).size
  const disabledCount = allRows.length - enabledRows.length
  return (
    <tr className="text-xs font-semibold border-t-2"
        style={{ backgroundColor: scopeColor + '22', borderTopColor: scopeColor }}>
      <td colSpan={extraLeadCol ? 5 : 4} className="px-3 py-2 text-left text-gray-700 whitespace-nowrap">
        TOTAL — {nOps} opera{nOps === 1 ? 'ção' : 'ções'}
        {nComp > 0 && <> | {nComp} componente{nComp !== 1 ? 's' : ''}</>}
        {disabledCount > 0 && (
          <span className="ml-2 font-normal" style={{ color: scopeColor }}>
            ({disabledCount} desativ.)
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-center tabular-nums" style={{ color: scopeColor }}>
        {totalHhUnit > 0 ? fmt2(totalHhUnit) : '—'}
      </td>
      <td className="px-3 py-2 text-center tabular-nums font-bold" style={{ color: scopeColor }}>
        {totalHhTotal > 0 ? fmt1(totalHhTotal) : '—'}
      </td>
    </tr>
  )
}

function ParcialRangeCell({ from, to, color, onChange }: {
  from: number; to: number; color: string
  onChange: (from: number, to: number) => void
}) {
  const clamp   = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
  const barRef  = useRef<HTMLDivElement>(null)
  const dragRef = useRef<'from' | 'to' | null>(null)
  const fromRef = useRef(from); fromRef.current  = from
  const toRef   = useRef(to);   toRef.current    = to
  const cbRef   = useRef(onChange); cbRef.current = onChange

  useEffect(() => {
    function getBarPct(clientX: number): number {
      const bar = barRef.current
      if (!bar) return 0
      const rect = bar.getBoundingClientRect()
      return Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)))
    }
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return
      const pct = getBarPct(e.clientX)
      if (dragRef.current === 'from') cbRef.current(Math.min(pct, toRef.current), toRef.current)
      else                            cbRef.current(fromRef.current, Math.max(pct, fromRef.current))
    }
    function onUp() { dragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  return (
    <div className="flex items-center gap-1 px-1 py-0.5 select-none">
      <input
        type="number" min={0} max={100}
        value={from}
        onChange={e => { const v = clamp(Number(e.target.value)); onChange(v, Math.max(v, to)) }}
        className="w-9 text-center border rounded text-[11px] py-0.5 tabular-nums focus:outline-none bg-white"
        style={{ borderColor: color + '88', color: '#374151' }}
      />
      <span className="text-gray-400 text-[10px] select-none">→</span>
      <input
        type="number" min={0} max={100}
        value={to}
        onChange={e => { const v = clamp(Number(e.target.value)); onChange(Math.min(from, v), v) }}
        className="w-9 text-center border rounded text-[11px] py-0.5 tabular-nums focus:outline-none bg-white"
        style={{ borderColor: color + '88', color: '#374151' }}
      />
      <span className="text-gray-400 text-[10px] select-none">%</span>
      {/* Drag bar with handles — ml-1.5 gives space between % label and left handle */}
      <div ref={barRef} className="relative flex-1 h-4 flex items-center ml-1.5 pr-2" style={{ minWidth: 44 }}>
        <div className="absolute inset-x-0 h-1 rounded-full" style={{ right: 8, backgroundColor: color + '22' }} />
        <div
          className="absolute h-1 rounded-full"
          style={{ left: `${from}%`, right: `calc(${100 - to}% + 8px)`, backgroundColor: color + 'AA' }}
        />
        <div
          className="absolute w-3 h-3 rounded-full border-2 bg-white shadow-sm cursor-ew-resize"
          style={{ left: `${from}%`, top: '50%', transform: 'translate(-50%, -50%)', borderColor: color, zIndex: 2 }}
          onMouseDown={e => { e.preventDefault(); dragRef.current = 'from' }}
        />
        <div
          className="absolute w-3 h-3 rounded-full border-2 bg-white shadow-sm cursor-ew-resize"
          style={{ left: `${to}%`, top: '50%', transform: 'translate(-50%, -50%)', borderColor: color, zIndex: 2 }}
          onMouseDown={e => { e.preventDefault(); dragRef.current = 'to' }}
        />
      </div>
    </div>
  )
}

function fmtFw(raw: string): string {
  const m = raw.trim().match(/(\d+)/)
  return m ? `FW${m[1]}` : raw.trim()
}

function exportToExcel(detail: AssemblyDetail, scope: ScopeKey, rows: AssemblyOperationRow[]) {
  const scopeLabel = SCOPE_LABEL[scope]
  const header = ['N°', 'Componente', 'Comp. Desc.', 'Workstation', 'WS Desc.', 'Tipo', 'Operação', 'Op. Desc.', 'HH/Unit', 'HH Total']
  const dataRows = rows.map(r => [
    r.n, r.component, r.comp_desc ?? '', r.wsn, r.desc, r.tipo,
    r.op, r.op_desc ?? '', r.hh_unit, r.hh_total,
  ])
  const csv = [header, ...dataRows]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\n')
  const bom = '\uFEFF'
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `${detail.item}_${scopeLabel}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

interface Props {
  detail: AssemblyDetail
  onClose: () => void
  /** scope → set of disabled 0-based operation row indices */
  disabledOps?: Record<string, Set<number>>
  onToggleOp?:  (scope: ScopeKey, opIdx: number) => void
  /** Bulk-replace the disabled set for a scope (from ops-selector panel). */
  onSetScopeOps?: (scope: ScopeKey, disabled: Set<number>) => void
  /** wsn → total allocated hours from last solver run (for scope distribution) */
  allocByWsn?: Record<string, number> | null
  /** Active workstation filter from main toolbar. */
  activeWsnFilter?: Set<string>
  /** True for items added via "Adicionar" catalog — shows planning controls. */
  isAdicionarItem?: boolean
  /** scope → selected FW week (for "adicionar" items). */
  weekPlan?: Record<string, string>
  onWeekChange?: (scope: ScopeKey, fw: string) => void
  /** Available FW weeks from the current import period. */
  availableFws?: string[]
}

export function AssemblyDetailModal({ detail, onClose, disabledOps, onToggleOp, onSetScopeOps, allocByWsn, activeWsnFilter, isAdicionarItem, weekPlan, onWeekChange, availableFws }: Props) {
  const scopes = detail.scopes_present as ScopeKey[]
  const [activeScope, setActiveScope] = useState<ScopeKey>(scopes[0])
  const [fading, setFading] = useState(false)

  // Context menu state: position + which row was right-clicked
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rowIdx: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  // Popover state for the planning controls (adicionar items only)
  const [weekPopover,  setWeekPopover]  = useState(false)
  const [opsPopover,   setOpsPopover]   = useState(false)
  // drag-select state for ops panel
  const [dragging,     setDragging]     = useState(false)
  const [dragValue,    setDragValue]    = useState<boolean | null>(null) // true=enable, false=disable
  // Parcial planning mode: UI-only, no backend connection
  const [parcialMode,  setParcialMode]  = useState(false)
  const [parcialPlan,  setParcialPlan]  = useState<
    Partial<Record<ScopeKey, Record<string, Record<string, { from: number; to: number }>>>>
  >({})
  const [selectedFwsForParcial, setSelectedFwsForParcial] = useState<Set<string>>(() => new Set<string>())

  // Reset selection when available FWs change
  const fwsKeyRef = useRef((availableFws ?? []).join(','))
  if (fwsKeyRef.current !== (availableFws ?? []).join(',')) {
    fwsKeyRef.current = (availableFws ?? []).join(',')
    setSelectedFwsForParcial(new Set<string>())
  }
  const weekPopRef = useRef<HTMLDivElement>(null)
  const opsPopRef  = useRef<HTMLDivElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && ctxRef.current.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  // Close week popover on outside click.
  // opsPopover is an inline table column — only the button toggles it, not outside clicks.
  useEffect(() => {
    if (!weekPopover) return
    const handler = (e: MouseEvent) => {
      if (weekPopRef.current && weekPopRef.current.contains(e.target as Node)) return
      setWeekPopover(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [weekPopover])

  // End drag-select on global mouseup
  useEffect(() => {
    if (!dragging) return
    const handler = () => setDragging(false)
    document.addEventListener('mouseup', handler)
    return () => document.removeEventListener('mouseup', handler)
  }, [dragging])

  // Active scope's disabled set
  const currentDisabled: Set<number> = disabledOps?.[activeScope] ?? new Set()

  function changeScope(s: ScopeKey) {
    if (s === activeScope || fading) return
    setWeekPopover(false)
    setOpsPopover(false)
    setFading(true)
    setTimeout(() => { setActiveScope(s); setFading(false) }, 120)
  }
  function stepScope(dir: 1 | -1) {
    const idx = scopes.indexOf(activeScope)
    changeScope(scopes[(idx + dir + scopes.length) % scopes.length])
  }

  // Keyboard arrow keys: left/right to navigate scopes
  useEffect(() => {
    if (scopes.length <= 1) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const dir: 1 | -1 = e.key === 'ArrowLeft' ? -1 : 1
      const idx = scopes.indexOf(activeScope)
      const next = scopes[(idx + dir + scopes.length) % scopes.length]
      changeScope(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeScope, scopes, fading])

  const sd            = detail.scopes[activeScope]
  const rows          = buildRows(detail, activeScope, activeWsnFilter)
  const activeColor   = SCOPE_COLOR[activeScope]
  const activeBgLight = SCOPE_BG_LIGHT[activeScope]
  const tiposInScope  = (() => {
    const byTipo = [...new Set(rows.map(r => r.tipo).filter(Boolean))]
    if (byTipo.length > 0) return byTipo
    // fallback: no tipo field in data — use WSN names as dimension
    const byWsn = [...new Set(rows.map(r => r.wsn).filter(Boolean))]
    return byWsn.length > 0 ? byWsn : ['Geral']
  })()
  const fwsForParcial = availableFws ?? []
  const isWeeklyMode           = fwsForParcial.length === 1
  const displayedFwsForParcial = isWeeklyMode
    ? fwsForParcial
    : fwsForParcial.filter(fw => selectedFwsForParcial.has(fw))

  function getParcialRange(scope: ScopeKey, fw: string, tipo: string) {
    return parcialPlan[scope]?.[fw]?.[tipo] ?? { from: 0, to: 100 }
  }
  function setParcialRange(scope: ScopeKey, fw: string, tipo: string, range: { from: number; to: number }) {
    const fwIdx = fwsForParcial.indexOf(fw)
    setParcialPlan(prev => {
      const scopePlan = prev[scope] ?? {}
      const prevRange = scopePlan[fw]?.[tipo]
      let cascadedScope: typeof scopePlan = {
        ...scopePlan,
        [fw]: { ...(scopePlan[fw] ?? {}), [tipo]: range },
      }
      // Cascade: if `to` changed, unconditionally propagate to ALL subsequent FWs
      if (fwIdx >= 0 && prevRange?.to !== range.to) {
        for (let i = fwIdx + 1; i < fwsForParcial.length; i++) {
          const nextFw    = fwsForParcial[i]
          const nextRange = cascadedScope[nextFw]?.[tipo] ?? { from: 0, to: 100 }
          cascadedScope = {
            ...cascadedScope,
            [nextFw]: {
              ...(cascadedScope[nextFw] ?? {}),
              [tipo]: { from: range.to, to: Math.max(nextRange.to, range.to) },
            },
          }
        }
      }
      return { ...prev, [scope]: cascadedScope }
    })
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[94vw] max-w-6xl h-[88vh] overflow-hidden">

        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0"
             style={{ backgroundColor: activeColor, transition: 'background-color 0.15s' }}>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm text-white tracking-wide leading-tight truncate">
              Detalhe — {detail.item}
            </span>
            {detail.descricao && (
              <span className="text-[11px] text-white/80 truncate leading-tight">{detail.descricao}</span>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 ml-3 hover:bg-white/20 transition-colors shrink-0" title="Fechar">
            <X size={16} className="text-white" />
          </button>
        </div>

        {/* Scope navigation bar */}
        <div className="flex items-stretch bg-gray-100 border-b border-gray-300 shrink-0">
          {scopes.length > 1 && (
            <button onClick={() => stepScope(-1)}
                    className="w-10 shrink-0 flex items-center justify-center text-gray-500 hover:text-gray-800 hover:bg-gray-200 transition-colors border-r border-gray-300"
                    title="Escopo anterior">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="flex flex-1 items-stretch overflow-x-auto">
            {scopes.map(s => {
              const isActive = s === activeScope
              const col = SCOPE_COLOR[s]
              return (
                <button key={s} onClick={() => changeScope(s)}
                        className="flex-1 flex flex-col items-center justify-center px-4 py-2 text-xs font-semibold transition-all border-r border-gray-300 last:border-r-0 select-none whitespace-nowrap"
                        style={{
                          borderBottom:    isActive ? `3px solid ${col}` : '3px solid transparent',
                          backgroundColor: isActive ? activeBgLight : 'transparent',
                          color:           isActive ? col : '#6b7280',
                        }}
                        title={SCOPE_LABEL[s]}>
                  <span className="inline-block w-2.5 h-2.5 rounded-full mb-0.5"
                        style={{ backgroundColor: col, opacity: isActive ? 1 : 0.4 }} />
                  {SCOPE_LABEL[s]}
                </button>
              )
            })}
          </div>
          {scopes.length > 1 && (
            <button onClick={() => stepScope(1)}
                    className="w-10 shrink-0 flex items-center justify-center text-gray-500 hover:text-gray-800 hover:bg-gray-200 transition-colors border-l border-gray-300"
                    title="Próximo escopo">
              <ChevronRight size={18} />
            </button>
          )}
        </div>

        {/* Scope info bar */}
        <div className="px-4 py-1.5 flex items-center gap-4 text-xs shrink-0"
             style={{ backgroundColor: activeBgLight, transition: 'background-color 0.15s' }}>
          {sd && (() => {
            // % from allocations.json: scope qty / total item qty
            // (backend already applied allocations.json pct to compute each scope's qty)
            const totalQty = detail.scopes_present.reduce((s, sc) => s + (detail.scopes[sc]?.qty ?? 0), 0)
            const scopeAllocShare = totalQty > 0 ? (sd.qty / totalQty) * 100 : null
            const selectedFw = weekPlan?.[activeScope]
            const allOpsCount = rows.length
            const disabledCount = currentDisabled.size
            return (
              <>
                <span className="font-bold flex items-center gap-1.5" style={{ color: activeColor }}>
                  {SCOPE_LABEL[activeScope]}
                  {scopeAllocShare != null && (
                    <span
                      className="tabular-nums font-semibold"
                      style={{ color: activeColor + 'BB', fontSize: 11 }}
                      title="Distribuição de alocação deste item neste escopo"
                    >
                      {scopeAllocShare.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                    </span>
                  )}
                </span>
                <span className="text-gray-500">Qtde: <strong className="text-gray-800">{Math.round(sd.qty)}</strong></span>
                <span className="text-gray-500">Total: <strong className="text-gray-800">{fmt1(sd.total_h)} h</strong></span>
                <span className="text-gray-500">HH/Item: <strong className="text-gray-800">{fmt1(sd.hours_per_unit)}</strong></span>
                <span className="text-gray-500">WSNs: <strong className="text-gray-800">{sd.wsn_count}</strong></span>
                <span className="text-gray-500">Operações: <strong className="text-gray-800">{rows.length}</strong></span>

                {/* Planning controls — week selector for all items, ops for all, parcial only for adicionar */}
                {(!!onToggleOp || (availableFws?.length ?? 0) > 0 || isAdicionarItem) ? (
                  <div className="ml-auto flex items-center gap-1.5 shrink-0">

                    {/* ── Week selector: only for adicionar items ── */}
                    {(availableFws?.length ?? 0) > 0 && isAdicionarItem && (
                    <div className="relative" ref={weekPopRef}>
                      {/* isAdicionarItem + multiple FWs → multi-select checkboxes by default */}
                      {/* simular items or single FW → single-select */}
                      {(() => {
                        const multiCheckMode = isAdicionarItem && !isWeeklyMode
                        return (
                          <button
                            onClick={() => {
                              setWeekPopover(v => !v)
                              setOpsPopover(false)
                              if (!multiCheckMode) setParcialMode(false)
                            }}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors"
                            style={{
                              borderColor: activeColor + '88',
                              color: multiCheckMode
                                ? (selectedFwsForParcial.size > 0 ? activeColor : activeColor + 'AA')
                                : (selectedFw ? activeColor : activeColor + 'AA'),
                              backgroundColor: weekPopover ? activeBgLight : 'transparent',
                            }}
                            title={multiCheckMode ? 'Selecionar semanas' : 'Selecionar semana de execução'}
                          >
                            <CalendarDays size={11} />
                            {multiCheckMode
                              ? (selectedFwsForParcial.size > 0 ? `${selectedFwsForParcial.size} sem.` : 'Semanas')
                              : (selectedFw ? fmtFw(selectedFw) : 'Semana')}
                          </button>
                        )
                      })()}
                      {weekPopover && (() => {
                        const multiCheckMode = isAdicionarItem && !isWeeklyMode
                        return (
                          <div
                            className="absolute top-full mt-1 right-0 z-[100] bg-white rounded-lg shadow-xl border overflow-hidden"
                            style={{ borderColor: activeColor + '55', minWidth: 150 }}
                          >
                            <div className="px-3 py-1.5 border-b text-[11px] font-semibold"
                                 style={{ borderColor: activeColor + '33', color: activeColor }}>
                              {multiCheckMode ? 'Semanas' : 'Defina semana'}
                            </div>
                            {multiCheckMode ? (
                              /* Multi-select checkboxes for adicionar items */
                              <div className="py-1 max-h-52 overflow-y-auto">
                                <button
                                  className="w-full text-left px-3 py-1.5 text-[10px] text-gray-400 hover:bg-gray-50 transition-colors"
                                  onClick={() => setSelectedFwsForParcial(
                                    selectedFwsForParcial.size === fwsForParcial.length
                                      ? new Set()
                                      : new Set(fwsForParcial)
                                  )}
                                >
                                  {selectedFwsForParcial.size === fwsForParcial.length ? '— Desmarcar todas' : '✔ Selecionar todas'}
                                </button>
                                {fwsForParcial.map(fw => (
                                  <label
                                    key={fw}
                                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50 transition-colors select-none"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedFwsForParcial.has(fw)}
                                      onChange={() => setSelectedFwsForParcial(prev => {
                                        const n = new Set(prev)
                                        if (n.has(fw)) n.delete(fw); else n.add(fw)
                                        return n
                                      })}
                                      className="shrink-0"
                                      style={{ accentColor: activeColor }}
                                    />
                                    <span
                                      className="text-[11px] font-medium"
                                      style={{ color: selectedFwsForParcial.has(fw) ? activeColor : '#374151' }}
                                    >
                                      {fmtFw(fw)}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              /* Single-select for simular items and single-FW adicionar */
                              <div className="py-1 max-h-52 overflow-y-auto">
                                {selectedFw && (
                                  <button
                                    className="w-full text-left px-3 py-1.5 text-[11px] text-gray-400 hover:bg-gray-50 transition-colors"
                                    onClick={() => { onWeekChange?.(activeScope, ''); setWeekPopover(false) }}
                                  >
                                    — Limpar seleção
                                  </button>
                                )}
                                {(availableFws ?? []).map(fw => (
                                  <button
                                    key={fw}
                                    className="w-full text-left px-3 py-1.5 text-[11px] font-medium transition-colors"
                                    style={{
                                      color: fw === selectedFw ? activeColor : '#374151',
                                      backgroundColor: fw === selectedFw ? activeBgLight : undefined,
                                      fontWeight: fw === selectedFw ? 700 : undefined,
                                    }}
                                    onMouseEnter={e => { if (fw !== selectedFw) (e.currentTarget as HTMLButtonElement).style.backgroundColor = activeBgLight }}
                                    onMouseLeave={e => { if (fw !== selectedFw) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '' }}
                                    onClick={() => { onWeekChange?.(activeScope, fw); setWeekPopover(false) }}
                                  >
                                    {fmtFw(fw)}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                    )}

                    {/* ── Operations selector — toggles inline checkbox column in table ── */}
                    <div className="relative" ref={opsPopRef}>
                      <button
                        onClick={() => { setOpsPopover(v => !v); setWeekPopover(false); setParcialMode(false) }}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors"
                        style={{
                          borderColor: activeColor + '88',
                          color: opsPopover ? activeColor : (disabledCount > 0 ? activeColor : activeColor + 'AA'),
                          backgroundColor: opsPopover ? activeBgLight : 'transparent',
                        }}
                        title={opsPopover ? 'Salvar seleção e fechar' : 'Selecionar operações a executar'}
                      >
                        <ListChecks size={11} />
                        {opsPopover
                          ? 'Salvar'
                          : disabledCount > 0
                            ? `${allOpsCount - disabledCount}/${allOpsCount} ops`
                            : 'Operações'}
                      </button>
                    </div>

                    {/* ── Parcial mode toggle ─────────────────── */}
                    {isAdicionarItem && (
                    <button
                      onClick={() => { setParcialMode(v => !v); setWeekPopover(false); setOpsPopover(false) }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors"
                      style={{
                        borderColor: activeColor + '88',
                        color: parcialMode ? activeColor : activeColor + 'AA',
                        backgroundColor: parcialMode ? activeBgLight : 'transparent',
                      }}
                      title={parcialMode ? 'Fechar planejamento parcial' : 'Definir execução parcial por semana e tipo'}
                    >
                      <Percent size={11} />
                      Parcial
                    </button>
                    )}

                  </div>
                ) : null}
              </>
            )
          })()}
        </div>

        {/* Table / Parcial panel */}
        <div className="flex-1 overflow-auto"
             style={{ opacity: fading ? 0 : 1, transition: 'opacity 0.12s ease' }}>
          {parcialMode && isAdicionarItem ? (
            /* ── Parcial planning panel ───────────────────────────────────────── */
            <div className="p-4 space-y-3">
              {/* Instruction box */}
              <div
                className="p-3 rounded-lg border text-[11px] text-gray-600 leading-relaxed"
                style={{ borderColor: activeColor + '44', backgroundColor: activeColor + '0B' }}
              >
                <strong style={{ color: activeColor }}>Planejamento Parcial</strong>
                {' — '}Defina o intervalo de execução (%) por tipo de operação para cada semana.
                {' '}A extremidade da barra pode ser arrastada para ajustar o intervalo.
                {' '}Ao definir o fim de uma semana, as seguintes já começam nesse ponto.
                {!isWeeklyMode && ' Use o botão “Semanas” para filtrar quais semanas exibir.'}
              </div>

              {fwsForParcial.length === 0 ? (
                <div className="text-center py-10 text-sm text-gray-400">
                  Nenhuma semana disponível. Selecione um período ao importar os dados.
                </div>
              ) : displayedFwsForParcial.length === 0 ? (
                <div className="text-center py-6 text-sm text-gray-400">
                  Selecione ao menos uma semana acima.
                </div>
              ) : tiposInScope.length === 0 ? (
                <div className="text-center py-10 text-sm text-gray-400">
                  Sem tipos de operação definidos para este escopo.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border" style={{ borderColor: activeColor + '33' }}>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr style={{ backgroundColor: activeColor + '18' }}>
                        <th
                          className="px-2 py-2 font-semibold whitespace-nowrap border-b border-r text-left"
                          style={{ borderColor: activeColor + '33', color: activeColor, width: '1%' }}
                        >
                          Semana
                        </th>
                        {tiposInScope.map(tipo => (
                          <th
                            key={tipo}
                            className="px-2 py-2 text-left font-semibold whitespace-nowrap border-b border-r last:border-r-0"
                            style={{ borderColor: activeColor + '33', minWidth: 240 }}
                          >
                            <span className="block text-[11px]" style={{ color: activeColor }}>{tipo}</span>
                            <span className="block text-[9px] font-normal text-gray-400 tracking-wide mt-0.5">De % → Até % · arraste as extremidades da barra</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedFwsForParcial.map((fw, fwIdx) => (
                        <tr key={fw} style={{ backgroundColor: fwIdx % 2 === 0 ? '#ffffff' : activeColor + '07' }}>
                          <td
                            className="px-2 py-1.5 font-semibold text-center border-b border-r whitespace-nowrap text-xs"
                            style={{ borderColor: activeColor + '22', color: activeColor }}
                          >
                            {fmtFw(fw)}
                          </td>
                          {tiposInScope.map(tipo => {
                            const range = getParcialRange(activeScope, fw, tipo)
                            return (
                              <td
                                key={tipo}
                                className="px-2 py-1.5 border-b border-r last:border-r-0"
                                style={{ borderColor: activeColor + '22' }}
                              >
                                <ParcialRangeCell
                                  from={range.from}
                                  to={range.to}
                                  color={activeColor}
                                  onChange={(f, t) => setParcialRange(activeScope, fw, tipo, { from: f, to: t })}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Sem dados para este escopo no período selecionado.
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10" style={{ backgroundColor: activeBgLight }}>
                <tr>
                  {opsPopover && (
                    <th className="w-6 px-1 py-2 text-center border-b-2"
                        style={{ borderBottomColor: activeColor }}>
                      {/* select-all toggle */}
                      <div
                        className="inline-flex cursor-pointer"
                        title="Alternar todas"
                        onClick={() => {
                          const allDisabled = currentDisabled.size === rows.length
                          onSetScopeOps?.(activeScope, allDisabled ? new Set() : new Set(rows.map((_, i) => i)))
                        }}
                      >
                        {currentDisabled.size === 0
                          ? <CheckSquare size={12} style={{ color: activeColor }} />
                          : currentDisabled.size === rows.length
                            ? <Square size={12} className="text-gray-300" />
                            : <CheckSquare size={12} style={{ color: activeColor, opacity: 0.5 }} />}
                      </div>
                    </th>
                  )}
                  <th className="w-8 px-2 py-2 text-center font-semibold text-gray-600 border-b-2 whitespace-nowrap"
                      style={{ borderBottomColor: activeColor }}>N°</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b-2 whitespace-nowrap"
                      style={{ minWidth: 150, borderBottomColor: activeColor }}>Workstation — Desc.</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b-2 whitespace-nowrap"
                      style={{ borderBottomColor: activeColor }}>Tipo</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b-2 w-full"
                      style={{ borderBottomColor: activeColor }}>Operação — Desc.</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b-2 whitespace-nowrap"
                      style={{ borderBottomColor: activeColor }}>HH/Unit</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-600 border-b-2 whitespace-nowrap"
                      style={{ borderBottomColor: activeColor }}>HH Total</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Group rows by component for header dividers
                  const items: React.ReactNode[] = []
                  let lastComp: string | null = undefined as unknown as null
                  rows.forEach((row, idx) => {
                    const comp = row.component || ''
                    const isDisabled = currentDisabled.has(idx)
                    if (comp !== lastComp) {
                      lastComp = comp
                      if (comp) {
                        items.push(
                          <tr key={`ch-${idx}`}
                              style={{ backgroundColor: activeColor + '18', borderTop: idx > 0 ? `2px solid ${activeColor}55` : undefined }}>
                            <td colSpan={opsPopover ? 7 : 6} className="px-3 py-1.5">
                              <span className="font-semibold font-mono text-[11px]" style={{ color: activeColor }}>{comp}</span>
                              {row.comp_desc && <span className="text-[11px] text-gray-500 ml-1.5">— {row.comp_desc}</span>}
                            </td>
                          </tr>
                        )
                      }
                    }
                    const rowBg = isDisabled ? '#F0F0F0' : (idx % 2 === 0 ? '#FFFFFF' : '#F9FAFB')
                    items.push(
                      <tr key={idx}
                          className={`border-b border-gray-100 group ${isDisabled ? 'cursor-pointer' : 'cursor-context-menu'}`}
                          style={{ backgroundColor: rowBg, opacity: isDisabled ? 0.45 : 1 }}
                          title={isDisabled ? 'Operação desativada — clique com botão direito para reativar' : 'Clique com botão direito para desativar'}
                          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, rowIdx: idx }) }}>
                        {opsPopover && (
                          <td
                            className="px-1 py-1.5 text-center select-none"
                            onMouseDown={e => {
                              e.preventDefault()
                              const newEnabled = isDisabled // toggling: if disabled → enable, if enabled → disable
                              setDragging(true)
                              setDragValue(newEnabled)
                              const next = new Set(currentDisabled)
                              if (newEnabled) next.delete(idx); else next.add(idx)
                              onSetScopeOps?.(activeScope, next)
                            }}
                            onMouseEnter={() => {
                              if (!dragging || dragValue === null) return
                              const next = new Set(currentDisabled)
                              if (dragValue) next.delete(idx); else next.add(idx)
                              onSetScopeOps?.(activeScope, next)
                            }}
                          >
                            {isDisabled
                              ? <Square size={12} className="inline text-gray-300 cursor-pointer" />
                              : <CheckSquare size={12} className="inline cursor-pointer" style={{ color: activeColor }} />}
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-center text-gray-400 tabular-nums text-[11px]">{row.n}</td>
                        <td className="px-3 py-1.5 text-gray-800 whitespace-nowrap">
                          {row.wsn
                            ? <><span className="font-semibold">{row.wsn}</span>
                                {row.desc && <span className="text-gray-400 ml-1">— {row.desc}</span>}
                              </>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-1.5 text-center text-gray-600 whitespace-nowrap">
                          {row.tipo || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          {row.op
                            ? <><span className="font-semibold text-gray-700">{row.op}</span>
                                {row.op_desc && <span className="text-gray-400 ml-1">— {row.op_desc}</span>}
                              </>
                            : row.op_desc
                              ? <span className="text-gray-600">{row.op_desc}</span>
                              : row.desc
                                ? <span className="text-gray-600">{row.desc}</span>
                                : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-1.5 text-center tabular-nums">
                          {row.hh_unit > 0
                            ? <span style={{ color: activeColor, textDecoration: isDisabled ? 'line-through' : undefined }}>{fmt2(row.hh_unit)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-1.5 text-center tabular-nums font-semibold">
                          {row.hh_total > 0
                            ? <span style={{ color: activeColor, textDecoration: isDisabled ? 'line-through' : undefined }}>{fmt1(row.hh_total)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    )
                  })
                  return items
                })()}
                <TotalsRow
                  allRows={rows}
                  enabledRows={rows.filter((_, i) => !currentDisabled.has(i))}
                  scopeColor={activeColor}
                  extraLeadCol={opsPopover}
                />
              </tbody>
            </table>
          )}
        </div>

        {/* Footer bar */}
        <div className="border-t px-4 py-2 flex items-center justify-end gap-2 shrink-0"
             style={{ borderTopColor: activeColor + '55', backgroundColor: activeBgLight }}>
          <button
            onClick={() => exportToExcel(detail, activeScope, rows)}
            className="px-3 py-1.5 text-xs rounded border font-medium flex items-center gap-1.5 hover:bg-gray-100 transition-colors"
            style={{ borderColor: activeColor + '88', color: activeColor }}
            title="Exportar para Excel (CSV)">
            <Download size={12} />
            Exportar
          </button>
          <button onClick={onClose}
                  className="px-4 py-1.5 text-xs text-white rounded hover:opacity-90 transition-opacity font-medium"
                  style={{ backgroundColor: activeColor }}>
            Fechar
          </button>
        </div>

        {/* Context menu — appears on right-click of an operation row */}
        {ctxMenu && (
          <div
            ref={ctxRef}
            className="fixed z-[200] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[190px]"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
          >
            <div className="px-3 py-1 border-b border-gray-100 mb-0.5">
              <span className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold">Operação #{ctxMenu.rowIdx + 1}</span>
            </div>
            {currentDisabled.has(ctxMenu.rowIdx) ? (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-green-700 hover:bg-green-50 transition-colors text-left"
                onClick={() => { onToggleOp?.(activeScope, ctxMenu.rowIdx); setCtxMenu(null) }}
              >
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                Reativar operação
              </button>
            ) : (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors text-left"
                onClick={() => { onToggleOp?.(activeScope, ctxMenu.rowIdx); setCtxMenu(null) }}
              >
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                Desativar operação
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
