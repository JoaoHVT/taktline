'use client'
// ── Save confirmation — password gate before persisting schedule overrides ───────────────────
// Self-contained so typing the password re-renders ONLY this small modal, never the (heavy) GanttModal
// — that re-render storm was the source of the stutter while entering the password. On submit it hands
// the password to the parent (fire-and-forget) which closes this dialog and drives the centered
// SaveStatusOverlay (saving → saved/error). Failures (incl. wrong password) surface there, with a
// "Tentar novamente" action that reopens this dialog.
import { useState } from 'react'
import { Lock, Eye, EyeOff, AlertCircle, Save } from 'lucide-react'
import { RED } from '@/lib/ganttUtils'

export function SavePasswordModal({ onConfirm, onClose, title, message }: {
  onConfirm: (password: string) => void
  onClose: () => void
  /** Header text. Defaults to the schedule wording this dialog was written for; a second
   *  caller (publishing the GCR plan) passes its own, because a dialog that says "alterações
   *  no schedule" while publishing a plan is telling the user the wrong thing about what the
   *  password is authorizing. */
  title?: string
  message?: string
}) {
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [sent,     setSent]     = useState(false)

  function submit() {
    const pw = password.trim()
    if (!pw) { setError('Digite a senha.'); return }
    if (sent) return
    setSent(true)            // guard against a double-submit before the parent unmounts this
    onConfirm(pw)            // parent closes this dialog and shows the centered saving/saved/error feedback
  }

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !sent) onClose() }}
    >
      <div
        className="relative bg-white rounded-lg shadow-2xl w-[360px] max-w-[92vw] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: RED }}>
          <Lock size={14} className="text-white shrink-0" />
          <span className="font-semibold text-sm text-white">
            {title ?? 'Confirmar alterações no schedule'}
          </span>
        </div>
        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="text-xs text-gray-600">
            {message ?? 'Digite sua senha para salvar as modificações do schedule.'}
          </p>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Senha</label>
            <div className="relative flex items-center">
              <style>{`input.no-native-reveal::-ms-reveal, input.no-native-reveal::-ms-clear { display: none !important; }`}</style>
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => { setPassword(e.target.value); if (error) setError(null) }}
                placeholder="Digite a senha…"
                autoComplete="new-password"
                autoFocus
                disabled={sent}
                className="no-native-reveal w-full border border-gray-300 rounded-lg px-3 py-2 pr-9 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#D32F2F] focus:border-[#D32F2F] disabled:opacity-50"
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); submit() }
                  else if (e.key === 'Escape' && !sent) { e.preventDefault(); onClose() }
                }}
              />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-2.5 text-gray-400 hover:text-gray-600" tabIndex={-1}>
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {error && (
              <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                <AlertCircle size={12} className="shrink-0" />{error}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={sent}
              className="px-3 py-1.5 rounded text-[12px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={sent || !password.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-semibold text-white disabled:opacity-50"
              style={{ background: RED }}
            >
              <Save size={13} />Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
