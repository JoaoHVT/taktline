'use client'
import { useEffect, useState } from 'react'
import { Maximize2, Trash2, PackagePlus } from 'lucide-react'
import type { AssemblyDetail, ClientSegment, ScopeKey } from '@/lib/api'
import { ScopeColumn } from './ScopeColumn'
import { AssemblyDetailModal } from './AssemblyDetailModal'
import { ConfirmDialog } from './ConfirmDialog'
import { useWorkspace } from '@/context/WorkspaceContext'

// ── AssemblyBlock ─────────────────────────────────────────────────────────────
// Mirrors PyQt5 AssemblyWidget from the original desktop tool.
//
// Layout:
//   LEFT  (flex-3): name bar (item + description)  +  scope columns
//   RIGHT (fixed 315px ≈ +43%): Visao Geral summary panel
//
// catalogMode: when true (item added via "Adicionar", no period selected),
//   quantities are initialised to 0 so no demand data is applied.

export function AssemblyBlock({
  detail,
  onQtysChange,
  highlighted,
  catalogMode = false,
  fallbackDescricao = '',
  cliente = '',
  familia = '',
  nivel = '',
  clients = [],
  onRemove,
  onResetQtys,
  baselineQtys,
  disabledOps,
  onToggleOp,
  activeWsnFilter,
  isAdicionarItem = false,
  weekPlan,
  onWeekChange,
  availableFws,
  onSetScopeOps,
  bottleneckUnservedQty,
}: {
  detail:              AssemblyDetail
  onQtysChange?:       (item: string, qtys: Record<ScopeKey, number>) => void
  highlighted?:        boolean
  catalogMode?:        boolean
  fallbackDescricao?:  string
  cliente?:            string
  familia?:            string
  nivel?:              string
  clients?:            ClientSegment[]
  onRemove?:           () => void
  onResetQtys?:        () => void
  /** Imported (original) qty per scope — the reset button only shows when the live qtys differ. */
  baselineQtys?:       Record<ScopeKey, number>
  /** scope → set of disabled 0-based operation row indices for this item */
  disabledOps?:        Record<string, Set<number>>
  onToggleOp?:         (scope: string, opIdx: number) => void
  /** Active workstation filter from the header. */
  activeWsnFilter?:    Set<string>
  /** Map of item code → unserved units from last solver run (NIVEL greedy). */
  bottleneckUnservedQty?: Map<string, number>
  /** True when this item was added via "Adicionar" catalog (not from period import). */
  isAdicionarItem?:    boolean
  /** Per-scope selected FW week for planning (adicionar items only). */
  weekPlan?:           Record<string, string>
  onWeekChange?:       (scope: string, fw: string) => void
  /** Available FW weeks from the current import period. */
  availableFws?:       string[]
  /** Bulk-set the disabled ops for a scope from the ops-selector panel. */
  onSetScopeOps?:      (scope: string, disabled: Set<number>) => void
}) {
  // ── Qty state — one per scope ──────────────────────────────────────────────
  // catalogMode: always start at 0 (no period selected, no demand to apply).
  // simular mode: seed from backend scope.qty (can be fractional).
  // The main card displays rounded-up units, but hour/WSN calculations use
  // the exact fractional quantity from the backend.
  const [qtys, setQtys] = useState<Record<ScopeKey, number>>(() => {
    const r: Record<ScopeKey, number> = { LEVE: 0, MEDIO: 0, PESADO: 0, UNICO: 0 }
    if (!catalogMode) {
      for (const s of detail.scopes_present) {
        const q = Number(detail.scopes[s]?.qty ?? 0)
        r[s] = Number.isFinite(q) ? Math.max(0, q) : 0
      }
    }
    return r
  })

  // ── Copy feedback + modal state ──────────────────────────────────────────
  const [copied,      setCopied]      = useState(false)
  const [showDetail,  setShowDetail]  = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const { solverAllocByWsn } = useWorkspace()

  useEffect(() => {
    setQtys(prev => {
      const next = { ...prev }
      for (const scope of detail.scopes_present) {
        const q = Number(detail.scopes[scope]?.qty ?? 0)
        next[scope] = Number.isFinite(q) ? Math.max(0, q) : 0
      }
      return next
    })
  }, [detail])

  // Auto-assign the single available FW for "adicionar" items in semanal mode
  useEffect(() => {
    if (!isAdicionarItem || !availableFws || availableFws.length !== 1) return
    const singleFw = availableFws[0]
    for (const scope of detail.scopes_present) {
      if (!weekPlan?.[scope]) {
        onWeekChange?.(scope, singleFw)
      }
    }
  // Only run when the item/availableFws change, not on every weekPlan update
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdicionarItem, availableFws, detail.scopes_present])

  // ── Per-client hours: sum over scopes of (hpu × client_scope_qty) ──────────
  function getClientHours(seg: ClientSegment): number {
    return detail.scopes_present.reduce((sum, scope) => {
      const sd = detail.scopes[scope]
      if (!sd) return sum
      const clientQty = seg.scopes[scope] ?? 0
      if (clientQty === 0) return sum
      const hpu = sd.hours_per_unit ?? 0
      return sum + (hpu > 0 ? hpu * clientQty : 0)
    }, 0)
  }

  // ── Derived totals ─────────────────────────────────────────────────────────
  function getScopeHours(scope: ScopeKey): number {
    const sd  = detail.scopes[scope]
    if (!sd) return 0
    const qty = qtys[scope] ?? 0
    if (qty === 0) return 0
    const hpu = sd.hours_per_unit ?? 0
    return hpu > 0 ? hpu * qty : sd.total_h
  }

  const totalQty = detail.scopes_present.reduce((s, sc) => s + (qtys[sc] ?? 0), 0)
  const totalQtyDisplay = detail.scopes_present.reduce((s, sc) => s + Math.ceil(qtys[sc] ?? 0), 0)
  const totalH   = detail.scopes_present.reduce((s, sc) => s + getScopeHours(sc), 0)
  const hPerItem = totalQty > 0 ? totalH / totalQty : 0

  // ── WSN summary (hours scaled by current qty / original qty) ──────────────
  const wsnMap = new Map<string, { hours: number; description: string }>()
  const hasWsnFilter = !!activeWsnFilter && activeWsnFilter.size > 0
  for (const scope of detail.scopes_present) {
    const sd = detail.scopes[scope]
    if (!sd) continue
    const origQty = sd.qty ?? 0
    const currQty = qtys[scope] ?? 0
    const factor  = origQty > 0 ? currQty / origQty : (currQty > 0 ? 1 : 0)
    for (const w of sd.wsns ?? []) {
      if (hasWsnFilter && !activeWsnFilter.has(w.wsn)) continue
      const existing = wsnMap.get(w.wsn)
      const hours    = w.hours * factor
      if (hours <= 1e-9) continue
      if (existing) {
        existing.hours += hours
      } else {
        wsnMap.set(w.wsn, { hours, description: w.description ?? '' })
      }
    }
  }

  // ── Reset availability ────────────────────────────────────────────────────
  // Only offer "Resetar quantidades" once the user actually moved a qty away from
  // the imported baseline; with no baseline supplied, fall back to always offering it.
  const qtysChanged = baselineQtys
    ? detail.scopes_present.some(sc => Math.abs((qtys[sc] ?? 0) - (baselineQtys[sc] ?? 0)) > 1e-6)
    : true
  const canReset = !!onResetQtys && qtysChanged

  // Whether this item has unserved units (capacity insufficient at a bottleneck WSN)
  const bottleneckUnserved = bottleneckUnservedQty?.get(detail.item) ?? 0
  const isBottleneckItem = bottleneckUnserved > 0

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleQtyChange(scope: ScopeKey, newQty: number) {
    const next = { ...qtys, [scope]: Math.max(0, newQty) }
    setQtys(next)
    onQtysChange?.(detail.item, next)
  }

  function handleCopy() {
    navigator.clipboard?.writeText(detail.item).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const badgeBg = totalH > 0 ? '#D32F2F' : '#9E9E9E'

  // Effective description: prefer detail.descricao, fall back to import item description
  const displayDesc = detail.descricao || fallbackDescricao

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <div
      className={`flex gap-4 rounded-lg border p-3 transition-all ${
        highlighted
          ? 'border-blue-400 ring-2 ring-blue-300 bg-blue-50/30'
          : 'border-gray-200 bg-white'
      }`}
    >
      {/* ══ LEFT: name bar + scope columns ═════════════════════════════════ */}
      <div className="flex flex-col gap-2 flex-[3] min-w-0">

        {/* Top name bar: item code + description + total geral badge (matching height) */}
        <div className="flex items-stretch gap-2 min-w-0">
          <div
            className={`flex flex-row items-stretch border rounded cursor-pointer select-none transition-colors min-w-0 flex-1 overflow-hidden ${
              copied
                ? 'bg-green-50 border-green-400 ring-1 ring-green-300'
                : 'bg-[#f7f7f7] border-gray-300 hover:bg-gray-100'
            }`}
            title="Clique para copiar o código"
            onClick={handleCopy}
          >
            {/* Item code + description */}
            <div className="flex flex-col px-2.5 py-1.5 min-w-0 flex-1">
              <span className="text-sm font-bold text-gray-900 leading-tight break-all flex items-center gap-1.5">
                {detail.item}
                {isAdicionarItem && (
                  <span title="Item adicionado manualmente via catálogo">
                    <PackagePlus size={13} className="shrink-0 text-gray-400" />
                  </span>
                )}
                {isBottleneckItem && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded shrink-0"
                    style={{ backgroundColor: '#FFCDD2' }}
                    title="Este item não será totalmente atendido (capacidade insuficiente na workstation gargalo)"
                  >
                    <img src="/imagens/warning.png" alt="Gargalo" style={{ width: 11, height: 11 }} />
                    {bottleneckUnserved > 0 && (
                      <span className="text-[9px] font-bold tabular-nums" style={{ color: '#C62828' }}>
                        {bottleneckUnserved}un
                      </span>
                    )}
                  </span>
                )}
                {copied && (
                  <span className="ml-1 text-xs font-normal text-green-600">✓ copiado</span>
                )}
              </span>
              {displayDesc && (
                <span className="text-xs text-gray-500 leading-tight mt-0.5">
                  {displayDesc}{isAdicionarItem && <span className="text-gray-400"> (manual)</span>}
                </span>
              )}
            </div>
            {/* Client info — right section inside the same box */}
            {clients.filter(seg => (seg.qtde_fw ?? 0) > 0).length >= 2 ? (
              <div className="flex flex-row divide-x divide-gray-200 border-l border-gray-300 shrink-0">
                {clients
                  .filter(seg => (seg.qtde_fw ?? 0) > 0)
                  .map(seg => {
                    const clientH = getClientHours(seg)
                    return (
                      <div key={seg.client} className="flex flex-col justify-center px-3 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 leading-tight">
                          <span className="text-[11px] font-bold text-gray-900">{seg.client}</span>
                          {seg.nivel && (
                            <span className="text-[11px] font-semibold text-gray-500">{seg.nivel}</span>
                          )}
                        </div>
                        {seg.familia && (
                          <span className="text-[11px] text-gray-500 leading-tight mt-0.5">{seg.familia.toUpperCase()}</span>
                        )}
                      </div>
                    )
                  })
                }
              </div>
            ) : (cliente || familia || nivel) ? (
              <div className="flex flex-col justify-center px-3 py-1.5 border-l border-gray-300 shrink-0 whitespace-nowrap">
                <div className="flex items-center gap-1.5 leading-tight">
                  {cliente && (
                    <span className="text-[11px] font-bold text-gray-900">{cliente}</span>
                  )}
                  {nivel && (
                    <span className="text-[11px] font-semibold text-gray-500">{nivel}</span>
                  )}
                </div>
                {familia && (
                  <span className="text-[11px] text-gray-500 leading-tight mt-0.5">{familia.toUpperCase()}</span>
                )}
              </div>
            ) : null}
          </div>
          {/* Total Geral badge — same height as the gray name box via self-stretch */}
          <div
            className="shrink-0 flex items-center justify-center px-3 rounded select-none text-white text-[11px] font-bold whitespace-nowrap"
            style={{ backgroundColor: badgeBg }}
          >
            TOTAL GERAL: {Math.round(totalH)} h
          </div>
        </div>

        {/* Scope columns — aggregated */}
        <div className="flex flex-row flex-wrap gap-3 items-start">
          {detail.scopes_present.map(scope => (
            <ScopeColumn
              key={scope}
              scope={scope}
              qty={Math.ceil(qtys[scope] ?? 0)}
              hours={getScopeHours(scope)}
              onQtyChange={v => handleQtyChange(scope, v)}
            />
          ))}
        </div>
      </div>

      {/* ══ RIGHT: Visao Geral — fixed width so all blocks align ════════════ */}
      {/* Width increased ~43%: 220px → 315px */}
      <div className="flex flex-col gap-2 border-l border-gray-200 pl-3 w-[315px] shrink-0 text-[11px] font-mono text-gray-700">
        <div className="text-[10px] font-sans font-semibold uppercase tracking-wider text-gray-400 flex items-center justify-between">
          <span>Visão Geral</span>
          <div className="flex items-center gap-0.5">
            {canReset && (
              <button
                onClick={() => setShowResetConfirm(true)}
                title="Resetar quantidades para o valor importado"
                className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors"
              >
                <img src="/imagens/reload.png" alt="Resetar" width={12} height={12} className="grayscale opacity-60" />
              </button>
            )}
            <button
              onClick={() => setShowDetail(true)}
              title="Ver detalhe por escopo"
              className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-700 transition-colors"
            >
              <Maximize2 size={12} />
            </button>
            {onRemove && (
              <button
                onClick={() => setShowConfirm(true)}
                title="Remover este item"
                className="p-0.5 rounded hover:bg-red-100 text-gray-400 hover:text-red-600 transition-colors"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="space-y-0.5">
          <div>Itens: <span className="font-semibold text-gray-900">{totalQtyDisplay}</span></div>
          <div>Horas/Item: <span className="font-semibold text-gray-900">{hPerItem.toFixed(2)}</span></div>
        </div>

        {wsnMap.size > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-wider text-gray-400 mb-1">
              WSNs
            </div>
            <div className="space-y-0.5 max-h-[58px] overflow-y-auto pr-1">
              {[...wsnMap.entries()]
                .sort((a, b) => b[1].hours - a[1].hours || a[0].localeCompare(b[0]))
                .map(([wsn, info]) => (
                  <div key={wsn} className="leading-tight truncate">
                    <span className="font-semibold text-gray-800">{wsn}</span>
                    {info.description && (
                      <span className="text-gray-500"> - {info.description}</span>
                    )}
                    <span className="text-gray-500 ml-1">({Math.round(info.hours)} h)</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>

    {showDetail && (
      <AssemblyDetailModal
        detail={detail}
        onClose={() => setShowDetail(false)}
        disabledOps={disabledOps}
        onToggleOp={onToggleOp}
        onSetScopeOps={onSetScopeOps}
        allocByWsn={solverAllocByWsn}
        activeWsnFilter={activeWsnFilter}
        isAdicionarItem={isAdicionarItem}
        weekPlan={weekPlan}
        onWeekChange={onWeekChange}
        availableFws={availableFws}
      />
    )}

    {showConfirm && (
      <ConfirmDialog
        title="Remover item"
        message={`Remover "${detail.item}" da lista?`}
        detail="O item será removido da área de trabalho. Esta ação pode ser desfeita reimportando."
        confirmLabel="Sim, remover"
        danger
        onConfirm={() => { setShowConfirm(false); onRemove?.() }}
        onCancel={() => setShowConfirm(false)}
      />
    )}

    {showResetConfirm && (
      <ConfirmDialog
        title="Resetar quantidades"
        message={`Resetar as quantidades de "${detail.item}" para os valores importados originais?`}
        detail="As alterações manuais deste item serão descartadas."
        confirmLabel="Sim, resetar"
        danger
        onConfirm={() => { setShowResetConfirm(false); onResetQtys?.() }}
        onCancel={() => setShowResetConfirm(false)}
      />
    )}
  </>
  )
}
