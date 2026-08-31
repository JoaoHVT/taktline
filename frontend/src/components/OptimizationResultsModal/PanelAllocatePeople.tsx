'use client'
import React, { useMemo, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { asLevel, meetsTarget, type ExpertiseLevel } from '@/lib/expertise'
import { ExpertiseDot } from '@/components/ExpertiseDot'
import { ExpertiseSelector } from '@/components/ExpertiseSelector'

export function PanelAllocatePeople({
  title, subtitle, allItems, descMap, skilled, allocated, restricted, current, onSave, onClose, accentColor, maxSelectable,
  searchPlaceholder = 'Buscar pessoa…', emptyLabel = 'Nenhum resultado',
  levelOf, requiredLevelOf, onLevelChange,
}: {
  title:          string
  subtitle?:      string
  allItems:       string[]
  descMap?:       Record<string, string>
  skilled?:       Set<string>
  allocated?:     Set<string>
  restricted?:    Set<string>
  current:        string[]
  onSave:         (items: string[]) => void
  onClose:        () => void
  accentColor:    string
  maxSelectable?: number
  /** The list is not always people — the Headcount tab reuses this panel to allocate WORKSTATIONS to
   *  a person (the mirrored direction of the same relationship). Defaults keep every existing caller
   *  byte-identical. */
  searchPlaceholder?: string
  emptyLabel?:        string
  /** ── Expertise (optional; omit all three and this panel is byte-identical to before) ──
   *  The level the PAIR this row represents currently holds (`e[p,w]`). The panel is used in
   *  both directions, so "the pair" is (this row, the fixed other side named in the title). */
  levelOf?:         (item: string) => number | null | undefined
  /** The bar that row has to clear (`r[w]`) — drawn hollow beside the holding. */
  requiredLevelOf?: (item: string) => number | null | undefined
  /** Present ⇒ the level dot becomes a click-to-cycle control, editing in place. */
  onLevelChange?:   (item: string, level: ExpertiseLevel) => void
}) {
  const [query,    setQuery]    = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(current))
  const [pendingUnskilledConfirm, setPendingUnskilledConfirm] = useState(false)

  const unskilledSelected = useMemo(
    () => skilled != null ? Array.from(selected).filter(p => !skilled.has(p)) : [],
    [selected, skilled]
  )

  const atLimit = maxSelectable != null && selected.size >= maxSelectable

  const sorted = [...allItems].sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })
  )

  const filtered = sorted.filter(p =>
    p.toLowerCase().includes(query.toLowerCase()) ||
    (descMap?.[p] ?? '').toLowerCase().includes(query.toLowerCase())
  )

  function toggle(p: string) {
    if (!selected.has(p) && atLimit) return
    setPendingUnskilledConfirm(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  function handleSave() {
    if (unskilledSelected.length > 0) {
      setPendingUnskilledConfirm(true)
      return
    }
    onSave(Array.from(selected))
    onClose()
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl w-72 flex flex-col max-h-[70vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800">{title}</span>
            {subtitle && <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>
        <div className="px-3 py-2 border-b border-gray-100">
          <input
            autoFocus
            type="text"
            placeholder={searchPlaceholder}
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full text-xs text-black border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1"
            style={{ '--tw-ring-color': accentColor } as React.CSSProperties}
          />
        </div>
        <div className="overflow-auto flex-1 px-2 py-1">
          {filtered.length === 0
            ? <p className="text-xs text-gray-400 px-2 py-2">{emptyLabel}</p>
            : filtered.map(p => {
              const isSkilled    = skilled?.has(p)    ?? false
              const isAllocated  = allocated?.has(p)  ?? false
              const isRestricted = restricted?.has(p) ?? false
              const isChecked    = selected.has(p)
              const isDisabled   = atLimit && !isChecked
              return (
                <label key={p}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 ${isDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                  style={
                    isRestricted
                      ? { backgroundColor: '#FEF2F2', borderLeft: '2px solid #DC2626' }
                      : isSkilled
                        ? { backgroundColor: '#F0FDF4', borderLeft: '2px solid #16A34A' }
                        : { borderLeft: '2px solid transparent' }
                  }
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(p)}
                    disabled={isDisabled}
                    className="accent-current"
                    style={{ accentColor }}
                  />
                  <span className="flex flex-col min-w-0">
                    <span className={`text-xs font-medium ${isRestricted ? 'text-red-700' : isSkilled ? 'text-green-700' : 'text-gray-800'} ${isSkilled && isAllocated ? 'line-through opacity-70' : ''}`}>{p}</span>
                    {descMap?.[p] && <span className="text-[10px] text-gray-400 truncate">{descMap[p]}</span>}
                  </span>
                  {levelOf && (
                    // Clicks here must NOT reach the label — a <label> forwards any click inside
                    // it to its checkbox, so editing a level would silently toggle the allocation.
                    <span
                      className="ml-auto shrink-0 flex items-center gap-1"
                      onClick={e => { e.preventDefault(); e.stopPropagation() }}
                    >
                      {requiredLevelOf && (
                        <ExpertiseDot level={requiredLevelOf(p)} variant="requirement" size="sm" />
                      )}
                      {onLevelChange
                        ? <ExpertiseSelector value={levelOf(p)} shape="cycle" showHelp={false}
                            onChange={v => onLevelChange(p, v)} />
                        : <ExpertiseDot level={levelOf(p)} size="sm" />}
                      {requiredLevelOf && !meetsTarget(levelOf(p), requiredLevelOf(p)) && asLevel(levelOf(p)) > 0 && (
                        <AlertTriangle size={10} className="text-amber-500"
                          aria-label="Abaixo do nível alvo" />
                      )}
                    </span>
                  )}
                  {isRestricted
                    ? <span className={`shrink-0 text-[10px] font-semibold text-red-600 ${levelOf ? '' : 'ml-auto'}`}>restringida x</span>
                    : isSkilled && isAllocated
                      ? <span className={`shrink-0 text-[10px] text-gray-500 ${levelOf ? '' : 'ml-auto'}`}>ja alocada</span>
                      : isSkilled
                        ? <span className={`shrink-0 text-[10px] text-green-600 ${levelOf ? '' : 'ml-auto'}`}>skill ✓</span>
                        : null}
                </label>
              )
            })
          }
        </div>
        {atLimit && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-amber-100 bg-amber-50">
            <AlertTriangle size={11} className="text-amber-500 shrink-0" />
            <span className="text-[10px] text-amber-700 font-medium">
              Limite de {maxSelectable} pessoa{maxSelectable !== 1 ? 's' : ''} atingido
            </span>
          </div>
        )}
        {!atLimit && unskilledSelected.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-orange-100 bg-orange-50">
            <AlertTriangle size={11} className="text-orange-400 shrink-0" />
            <span className="text-[10px] text-orange-700">
              {unskilledSelected.length === 1
                ? `${unskilledSelected[0]} sem skill nesta WS`
                : `${unskilledSelected.length} pessoas sem skill nesta WS`}
            </span>
          </div>
        )}
        {pendingUnskilledConfirm ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-orange-200 bg-orange-50">
            <span className="text-[10px] text-orange-800 font-medium flex items-center gap-1">
              <AlertTriangle size={11} className="text-orange-500 shrink-0" />
              {unskilledSelected.length} sem skill — confirmar?
            </span>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => setPendingUnskilledConfirm(false)}
                className="px-2 py-1 text-[10px] border border-gray-300 rounded hover:bg-gray-100 text-gray-700"
              >Cancelar</button>
              <button
                onClick={() => { onSave(Array.from(selected)); onClose() }}
                className="px-2 py-1 text-[10px] text-white rounded font-medium bg-orange-500 hover:bg-orange-600"
              >Confirmar</button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2 px-3 py-2 border-t border-gray-100">
            <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">Cancelar</button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-xs text-white rounded font-medium"
              style={{ backgroundColor: accentColor }}
            >Salvar</button>
          </div>
        )}
      </div>
    </div>
  )
}
