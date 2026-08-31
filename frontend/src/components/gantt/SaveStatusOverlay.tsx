'use client'
// ── Save status overlay ──────────────────────────────────────────────────────────────────────
// Centered, NON-blocking feedback for the schedule-override save: a spinner while persisting, a green
// confirmation once the DB write actually resolves, or a red failure with a retry. The wrapper is
// pointer-events-none (so it never blocks interaction with the rest of the UI); only the card itself
// is interactive — and only in the error state, for the "Tentar novamente" button. Self-contained and
// tiny, so toggling it never re-renders the heavy schedule.
import { Loader2, CheckCircle2, XCircle, RotateCcw, X } from 'lucide-react'
import { RED } from '@/lib/ganttUtils'

export function SaveStatusOverlay({ state, count, error, onRetry, onDismiss }: {
  state: 'saving' | 'saved' | 'error'
  count: number
  error: string | null
  onRetry: () => void
  /** Dismiss the overlay. Available on the resolved (saved/error) states so the user is never
   *  trapped by a message that has no close affordance (the error state does not auto-hide). */
  onDismiss: () => void
}) {
  // A message that has resolved (success or failure) can always be closed manually.
  const dismissible = state === 'saved' || state === 'error'
  return (
    <div className="fixed inset-0 z-[9990] flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto relative bg-white rounded-xl shadow-2xl border border-gray-200 pl-5 pr-8 py-4 flex items-center gap-3 min-w-[260px] max-w-[92%]">
        {dismissible && (
          <button
            onClick={onDismiss}
            aria-label="Fechar"
            title="Fechar"
            className="absolute top-2 right-2 rounded p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <X size={15} />
          </button>
        )}
        {state === 'saving' && (
          <>
            <Loader2 size={22} className="animate-spin shrink-0" style={{ color: RED }} />
            <span className="text-sm font-semibold text-gray-700">Salvando alterações…</span>
          </>
        )}

        {state === 'saved' && (
          <>
            <CheckCircle2 size={22} className="shrink-0" style={{ color: '#2E7D32' }} />
            <span className="text-sm font-semibold text-gray-800">
              {count > 0
                ? `${count} ediç${count === 1 ? 'ão' : 'ões'} salva${count === 1 ? '' : 's'} com sucesso`
                : 'Alterações salvas com sucesso'}
            </span>
          </>
        )}

        {state === 'error' && (
          <div className="flex items-start gap-3">
            <XCircle size={22} className="shrink-0 mt-0.5" style={{ color: RED }} />
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-gray-800">Falha ao salvar as alterações</span>
              {error && <span className="text-xs text-gray-600">{error}</span>}
              <button
                onClick={onRetry}
                className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-semibold text-white"
                style={{ background: RED }}
              >
                <RotateCcw size={13} />Tentar novamente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
