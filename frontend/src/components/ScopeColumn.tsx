'use client'
import type { ScopeKey } from '@/lib/api'
import { SCOPE_COLOR, SCOPE_LABEL, NO_ARROWS } from '@/lib/assemblyConstants'

interface ScopeColumnProps {
  scope:          ScopeKey
  qty:            number
  hours:          number
  onQtyChange:    (newQty: number) => void
}

/**
 * One column in the AssemblyBlock left panel.
 *
 * Top → bottom:
 *   1. Coloured scope label
 *   2. Qty control  (− [n] +, no browser arrows)
 *   3. Total-hours  (read-only, recalculates from qty)
 */
export function ScopeColumn({ scope, qty, hours, onQtyChange }: ScopeColumnProps) {
  const color = SCOPE_COLOR[scope]

  return (
    <div className="flex flex-col gap-1" style={{ minWidth: 148, width: 'max-content' }}>

      {/* Scope label */}
      <div
        className="text-white text-xs font-bold py-1 px-3 rounded text-center whitespace-nowrap select-none"
        style={{ backgroundColor: color }}
      >
        {SCOPE_LABEL[scope]}
      </div>

      {/* Qty control: − [n] + */}
      <div className="flex items-stretch border border-gray-300 rounded overflow-hidden h-8">
        <button
          className="px-2.5 text-gray-600 hover:bg-gray-100 active:bg-gray-200 border-r border-gray-300 text-sm font-bold select-none leading-none"
          onClick={() => onQtyChange(Math.round(qty) - 1)}
        >
          −
        </button>
        <input
          type="number"
          min={0}
          value={Math.round(qty)}
          onChange={e => {
            const v = parseInt(e.target.value, 10)
            onQtyChange(isNaN(v) ? 0 : v)
          }}
          className="flex-1 w-12 text-center text-sm font-mono font-semibold text-gray-800 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-blue-400 bg-white"
          style={NO_ARROWS}
        />
        <button
          className="px-2.5 text-gray-600 hover:bg-gray-100 active:bg-gray-200 border-l border-gray-300 text-sm font-bold select-none leading-none"
          onClick={() => onQtyChange(Math.round(qty) + 1)}
        >
          +
        </button>
      </div>

      {/* Total hours (read-only) */}
      <div
        className="text-[11px] font-bold py-1 px-3 rounded border-2 text-center whitespace-nowrap select-none"
        style={{ borderColor: color, backgroundColor: '#fff', color: '#111' }}
      >
        {Math.round(hours)} h
      </div>

    </div>
  )
}
