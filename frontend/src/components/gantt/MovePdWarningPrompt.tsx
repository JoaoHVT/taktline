'use client'
// ── Protection-Days crossing warning ──────────────────────────────────────────────────────────
// Raised the FIRST time a Move-Mode keystroke would push the selected station BEYOND the Protection-
// Days limit (the LOCO's finish buffer). Protection Days are no longer a hard wall: the planner may
// deliberately cross them, but only after acknowledging this warning.
//
//   • Parar aqui — keep Move Mode active, leave the station at its last valid position, do not advance.
//                  The user may continue moving elsewhere; a later attempt re-raises this warning.
//   • Continuar  — acknowledge the crossing and replay the held keystroke. From then on the move runs
//                  unrestricted and its border turns RED while outside the allowed range (blue again if
//                  pulled back inside). Saving/propagating still works; the edit is flagged in red.
//
// Same modal contract as MoveNotePrompt: a small CENTERED card that closes only on an explicit choice
// (or Esc = Parar aqui). An outside click is inert BY DESIGN — resolving it as a choice on mousedown
// would let the following click land on the Schedule backdrop and take the whole window down.
import { AlertTriangle } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { RED, RED_LT, RED_DK } from '@/lib/ganttUtils'

export function MovePdWarningPrompt({ onContinue, onStop }: {
  onContinue: () => void   // acknowledge + replay the held keystroke (crossing allowed from here)
  onStop: () => void       // stay at the last valid position, keep Move Mode active
}) {
  const swallow = (e: SyntheticEvent) => { e.preventDefault(); e.stopPropagation() }
  return (
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={swallow}
        onClick={swallow}
        onContextMenu={swallow}
      />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] w-[340px] rounded-xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onStop() } }}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200" style={{ background: RED_LT }}>
          <AlertTriangle size={16} className="shrink-0" style={{ color: RED }} />
          <h3 className="text-sm font-bold" style={{ color: RED_DK }}>Limite de Dias de Proteção</h3>
        </div>
        <div className="px-4 py-3 text-[12px] text-gray-700 leading-relaxed">
          Você ultrapassou o limite de <strong>Dias de Proteção</strong>. Deseja continuar?
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50">
          {/* Autofocused so opening the warning pulls keyboard focus OUT of the Schedule iframe (whose
              own key handler would otherwise keep stepping the move). "Parar aqui" is the SAFE default:
              Enter on it stops, matching Esc. Crossing the limit requires an explicit Continuar click. */}
          <button
            type="button"
            autoFocus
            onClick={onStop}
            className="px-3 py-1.5 text-xs rounded font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-100"
          >
            Parar aqui
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="px-3 py-1.5 text-xs rounded text-white font-semibold hover:brightness-95"
            style={{ background: RED }}
          >
            Continuar
          </button>
        </div>
      </div>
    </>
  )
}
