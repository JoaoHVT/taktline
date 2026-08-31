'use client'
// ── Admin unlock modal (second factor) ────────────────────────────────────────
// Globally mounted. It registers a handler with unlockStore; the axios interceptor
// calls triggerUnlock() when a sensitive request (download / export / Denodo / user
// management) hits a 401 with X-Admin-Unlock-Required. The user enters ADMIN_PASSWORD
// once; the grant is cached ~15 min ("unlock once per session") and replayed on
// subsequent sensitive requests. Separate from the import password (IMPORT_PASSWORD).
import { useEffect, useRef, useState } from 'react'
import { Lock, Eye, EyeOff, AlertCircle, Loader2, ShieldAlert } from 'lucide-react'
import { unlockAdmin } from '@/lib/api'
import { registerUnlockHandler, isLockedOut } from '@/lib/unlockStore'

const RED = '#D32F2F'

export function UnlockModal() {
  const [open, setOpen]         = useState(false)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [busy, setBusy]         = useState(false)
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => {
    registerUnlockHandler(
      () =>
        new Promise<boolean>(resolve => {
          resolverRef.current = resolve
          setPassword('')
          setError(null)
          setShowPw(false)
          setBusy(false)
          setOpen(true)
        }),
    )
    return () => registerUnlockHandler(null)
  }, [])

  const finish = (ok: boolean) => {
    setOpen(false)
    const r = resolverRef.current
    resolverRef.current = null
    r?.(ok)
  }

  const submit = async () => {
    const pw = password.trim()
    if (!pw) {
      setError('Digite a senha administrativa.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unlockAdmin(pw)
      finish(true)
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      // Lockout tripped (this or a prior attempt): the interceptor already set the
      // global lockout + notice. Close this dialog — no further attempts allowed.
      if (status === 429 && isLockedOut()) {
        finish(false)
        return
      }
      setError(
        status === 429
          ? detail || 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
          : status === 403
            ? detail || 'Senha administrativa incorreta.'
            : status === 503
              ? detail || 'Recurso administrativo não configurado no servidor.'
              : detail || 'Falha ao desbloquear. Tente novamente.',
      )
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      // MUST be the top-most layer: this is the global second factor and can be triggered by an
      // action taken from INSIDE another modal (e.g. saving a fiscal-week change from the Calendar
      // modal, which sits at z-[10000]–z-[10002]). If it rendered below, the caller's request would
      // hang forever waiting for an unlock the user can't reach ("Salvando" stuck). z-[10100] beats
      // every other modal/overlay in the app.
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/50"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !busy) finish(false)
      }}
    >
      <div
        className="relative bg-white rounded-lg shadow-2xl w-[360px] max-w-[92vw] overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: RED }}>
          <ShieldAlert size={15} className="text-white shrink-0" />
          <span className="font-semibold text-sm text-white">Desbloqueio administrativo</span>
        </div>
        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="text-xs text-gray-600">
            Esta ação é sensível e exige a <strong>senha administrativa</strong>. O acesso
            fica liberado por ~15&nbsp;minutos e depois volta a bloquear automaticamente.
          </p>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Senha administrativa</label>
            <div className="relative flex items-center">
              <style>{`input.no-native-reveal::-ms-reveal, input.no-native-reveal::-ms-clear { display: none !important; }`}</style>
              <Lock size={13} className="absolute left-2.5 text-gray-400" />
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => {
                  setPassword(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="Digite a senha…"
                autoComplete="new-password"
                autoFocus
                disabled={busy}
                className="no-native-reveal w-full border border-gray-300 rounded-lg pl-8 pr-9 py-2 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#D32F2F] focus:border-[#D32F2F] disabled:opacity-50"
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  } else if (e.key === 'Escape' && !busy) {
                    e.preventDefault()
                    finish(false)
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-2.5 text-gray-400 hover:text-gray-600"
                tabIndex={-1}
              >
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {error && (
              <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                <AlertCircle size={12} className="shrink-0" />
                {error}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => finish(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-[12px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={busy || !password.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-semibold text-white disabled:opacity-50"
              style={{ background: RED }}
            >
              {busy ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Desbloqueando…
                </>
              ) : (
                'Desbloquear'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
