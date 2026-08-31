/**
 * ConflictWsModal — session-only override of the conflict-target workstations.
 *
 * Opened by right-clicking the Schedule "Conflict Count". Lets the user move workstations
 * between an "Available" list and a "Selected" (conflict-target) list, then Apply. The
 * selection drives `computeConflictCounts` for the rest of the session via the in-memory
 * override in lib/ganttUtils — it is NEVER persisted, so a reload restores the default.
 *
 * Interaction mirrors the app's other transfer/selection dialogs: click an item to move it
 * between the two lists, search to filter, and a coloured chrome consistent with the other
 * Schedule dialogs (Mode1OptionsModal / loco-edit menus).
 */
'use client'
import { useMemo, useState } from 'react'
import { X, Search, RotateCcw, ArrowRight, ArrowLeft, AlertTriangle } from 'lucide-react'
import { RED, normWs, getConflictWs, setConflictWs, resetConflictWs, DEFAULT_CONFLICT_WS } from '@/lib/ganttUtils'

export interface ConflictWsModalProps {
  /** All workstations available in the current Schedule (normalized, e.g. "WS40"). */
  allWorkstations: string[]
  onClose: () => void
}

export function ConflictWsModal({ allWorkstations, onClose }: ConflictWsModalProps) {
  // Normalize + de-dupe the available set, keeping the default conflict WS present even if
  // (edge case) they aren't in the current Schedule, so the user can always toggle them.
  const options = useMemo(() => {
    const s = new Set<string>()
    for (const w of allWorkstations) { const n = normWs(w); if (n) s.add(n) }
    for (const w of DEFAULT_CONFLICT_WS) s.add(w)
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [allWorkstations])

  // Local working selection — initialized from the current effective override/default.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const cur = getConflictWs()
    return new Set(options.filter(w => cur.has(w)))
  })
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const available = options.filter(w => !selected.has(w) && (!q || w.toLowerCase().includes(q)))
  const chosen = options.filter(w => selected.has(w) && (!q || w.toLowerCase().includes(q)))

  const move = (w: string, into: boolean) =>
    setSelected(prev => { const n = new Set(prev); if (into) n.add(w); else n.delete(w); return n })

  const isDefault = selected.size === DEFAULT_CONFLICT_WS.size && [...DEFAULT_CONFLICT_WS].every(w => selected.has(w))

  function apply() { setConflictWs(selected); onClose() }
  function reset() { resetConflictWs(); onClose() }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[560px] max-w-[94vw] overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ background: RED }}>
          <div className="flex items-center gap-2 text-white">
            <AlertTriangle size={15} />
            <span className="font-semibold text-sm tracking-wide">Workstations de Conflito — Sessão</span>
          </div>
          <button onClick={onClose} className="rounded p-1 transition-colors hover:bg-white/20 text-white" title="Fechar (Cancelar)">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-3">
          <p className="text-xs text-gray-500 leading-relaxed">
            Personalize quais workstations contam como conflito <strong>apenas nesta sessão</strong>. As
            alterações não são salvas e são descartadas ao recarregar a página. Clique em uma workstation
            para movê-la entre as listas.
          </p>

          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar workstation…"
              className="pl-8 pr-3 py-1.5 text-sm text-black placeholder-gray-600 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#D32F2F] w-full"
            />
          </div>

          {/* Two lists */}
          <div className="grid grid-cols-2 gap-3">
            <ListPanel
              title="Disponíveis"
              count={available.length}
              items={available}
              emptyLabel="Nenhuma workstation disponível"
              onItem={w => move(w, true)}
              trailing={<ArrowRight size={13} className="text-gray-300 group-hover:text-[#D32F2F]" />}
            />
            <ListPanel
              title="Selecionadas (conflito)"
              count={chosen.length}
              items={chosen}
              emptyLabel="Nenhuma selecionada"
              highlight
              onItem={w => move(w, false)}
              leading={<ArrowLeft size={13} className="text-red-200 group-hover:text-[#D32F2F]" />}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-2 mt-1 pt-3" style={{ borderTop: '1px solid #E5E7EB' }}>
            <button
              onClick={reset}
              title="Restaurar a configuração padrão (WS40, WS50) e remover o override da sessão"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors text-gray-600 hover:bg-gray-50"
              style={{ borderColor: '#D1D5DB' }}
            >
              <RotateCcw size={13} /> Restaurar padrão
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors text-gray-600 hover:bg-gray-50"
                style={{ borderColor: '#D1D5DB' }}
              >
                Cancelar
              </button>
              <button
                onClick={apply}
                disabled={selected.size === 0}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: RED }}
                title={selected.size === 0 ? 'Selecione ao menos uma workstation' : (isDefault ? 'Aplicar (equivale ao padrão)' : 'Aplicar seleção da sessão')}
              >
                Aplicar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ListPanel({ title, count, items, emptyLabel, onItem, highlight, leading, trailing }: {
  title: string; count: number; items: string[]; emptyLabel: string
  onItem: (w: string) => void; highlight?: boolean
  leading?: React.ReactNode; trailing?: React.ReactNode
}) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden" style={{ borderColor: highlight ? '#FECACA' : '#E5E7EB' }}>
      <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between"
        style={{ background: highlight ? '#FFF0F0' : '#F9FAFB', color: highlight ? RED : '#6B7280', borderBottom: `1px solid ${highlight ? '#FECACA' : '#E5E7EB'}` }}>
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </div>
      <div className="overflow-y-auto" style={{ height: 220 }}>
        {items.length === 0 ? (
          <div className="text-[11px] text-gray-400 text-center py-6">{emptyLabel}</div>
        ) : items.map(w => (
          <button
            key={w}
            onClick={() => onItem(w)}
            className="group w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left border-b transition-colors hover:bg-red-50"
            style={{ borderColor: '#F1F3F5', color: '#374151' }}
          >
            <span className="flex items-center gap-2 min-w-0">{leading}<span className="truncate font-medium">{w}</span></span>
            {trailing}
          </button>
        ))}
      </div>
    </div>
  )
}
