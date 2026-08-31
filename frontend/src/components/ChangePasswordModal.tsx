'use client'
import { useState } from 'react'
import { X, KeyRound, Loader2, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * ChangePasswordModal — a pessoa troca a PRÓPRIA senha.
 *
 * Disponível para qualquer papel, Leitor incluído, e sem o segundo fator administrativo:
 * a senha do ADMIN_PASSWORD existe para ações de admin sobre a aplicação, e exigi-la aqui
 * travaria justamente quem mais precisa trocar — quem entrou com a senha que a migração do
 * Entra ID gerou e nunca escolheu.
 *
 * O servidor devolve um token novo na resposta, então a sessão continua a mesma: trocar a
 * senha não desloga ninguém nem interrompe o que estava aberto.
 */

const RED = '#D32F2F'
const MIN_LEN = 8

function PasswordField({
  label, value, onChange, autoComplete, disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete: string
  disabled?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 pr-10 text-sm text-gray-900
            focus:outline-none focus:ring-2 focus:ring-[#D32F2F]/40 focus:border-[#D32F2F]
            disabled:bg-gray-50"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow(s => !s)}
          aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </label>
  )
}

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword, currentUser, mustChangePassword } = useAuth()

  const [current, setCurrent] = useState('')
  const [next,    setNext]    = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState(false)

  const tooShort = next.length > 0 && next.length < MIN_LEN
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit = !busy && current && next.length >= MIN_LEN && next === confirm && next !== current

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const result = await changePassword(current, next)
    setBusy(false)
    if (result.ok) {
      setDone(true)
      setCurrent(''); setNext(''); setConfirm('')
    } else {
      setError(result.error ?? 'Não foi possível alterar a senha.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Alterar senha"
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">

        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4" style={{ color: RED }} />
            <h2 className="text-sm font-semibold text-gray-900">Alterar senha</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded"
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="px-6 py-8 flex flex-col items-center gap-4 text-center">
            <CheckCircle2 className="w-11 h-11 text-emerald-500" />
            <p className="text-sm text-gray-700">
              Senha alterada. Use a nova na próxima vez que entrar.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg"
              style={{ background: RED }}
            >
              Fechar
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-3.5">
            {mustChangePassword && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5">
                <p className="text-[13px] text-amber-800 leading-snug">
                  Sua senha atual foi gerada pelo sistema ou por um administrador. Defina uma
                  senha só sua.
                </p>
              </div>
            )}

            {currentUser && (
              <p className="text-[12px] text-gray-500">
                Conta: <span className="font-semibold text-gray-700">{currentUser.username}</span>
              </p>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
                <p className="text-[13px] text-red-700 leading-snug">{error}</p>
              </div>
            )}

            <PasswordField
              label="Senha atual"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              disabled={busy}
            />
            <PasswordField
              label="Nova senha"
              value={next}
              onChange={setNext}
              autoComplete="new-password"
              disabled={busy}
            />
            <PasswordField
              label="Confirmar nova senha"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              disabled={busy}
            />

            {tooShort && (
              <p className="text-[12px] text-amber-700">A senha precisa de pelo menos {MIN_LEN} caracteres.</p>
            )}
            {mismatch && (
              <p className="text-[12px] text-red-600">As senhas não conferem.</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg
                  disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                style={{ background: RED }}
              >
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando…</> : 'Alterar senha'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
