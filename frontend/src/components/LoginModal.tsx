'use client'
import { useState } from 'react'
import Image from 'next/image'
import { Loader2, LogIn, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * LoginModal — overlay em tela cheia que bloqueia a interface até a autenticação.
 * Não pode ser fechado pelo usuário; some sozinho quando o login dá certo.
 *
 * ESTA É UMA DEMONSTRAÇÃO E TEM UM ÚNICO USUÁRIO. Não há cadastro, não há lista de
 * pessoas, não há segundo fator: todo visitante entra como `dev`. A tela continua aqui
 * porque a sessão é real — o servidor emite e valida o token de verdade, e é isso que a
 * tela demonstra — mas as credenciais estão preenchidas e impressas ao lado do formulário,
 * já que esconder uma senha que está no README não protege nada e só impede a visita.
 *
 * Os campos continuam editáveis de propósito: digitar errado mostra o caminho de erro do
 * servidor, que faz parte do que há para ver.
 *
 * sessionExpired — verdadeiro quando a pessoa já estava logada e a sessão foi recusada
 * pelo servidor. Mostra o aviso de expiração em vez do texto de primeiro acesso.
 */

/** As credenciais fixas da demo. Não são segredo: estão no README e na própria tela. */
const DEMO_USER = 'dev'
const DEMO_PASSWORD = '1234'

const RED = '#C62828'

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{children}</span>
}

function PasswordInput({
  value, onChange, placeholder, autoComplete, disabled, id,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  disabled?: boolean
  id?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className="w-full border border-gray-300 rounded-lg px-3 py-2.5 pr-10 text-sm text-gray-900
          focus:outline-none focus:ring-2 focus:ring-[#C62828]/40 focus:border-[#C62828]
          disabled:bg-gray-50 disabled:text-gray-400"
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        tabIndex={-1}
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

export function LoginModal({ sessionExpired = false }: { sessionExpired?: boolean }) {
  const { login, loginError, loggingIn, isInitializing, setLoginError } = useAuth()


  // Pré-preenchidos: ver DEMO_USER acima.
  const [username, setUsername] = useState(DEMO_USER)
  const [password, setPassword] = useState(DEMO_PASSWORD)

  const busy = loggingIn || isInitializing

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    await login(username, password)
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.60)', backdropFilter: 'blur(4px)' }}
      aria-modal="true"
      role="dialog"
      aria-label={sessionExpired ? 'Sessão expirada' : 'Acesso ao Taktline'}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm my-auto overflow-hidden">

        {/* ── Cabeçalho ─────────────────────────────────────────────── */}
        <div className="px-8 py-6 flex flex-col items-center gap-2" style={{ background: RED }}>
          <Image
            src="/imagens/wab2.png"
            alt="Taktline"
            width={140}
            height={42}
            className="object-contain brightness-0 invert"
            priority
          />
          <span className="text-white/80 text-xs font-medium tracking-widest uppercase">
            Taktline
          </span>
        </div>

        {/* ── Corpo ─────────────────────────────────────────────────── */}
        <div className="px-8 py-7">

          <form onSubmit={submitSignIn} className="flex flex-col gap-4">
              <div className="text-center space-y-1.5">
                <h2 className="text-gray-900 font-semibold text-lg">
                  {sessionExpired ? 'Sessão expirada' : 'Acesso ao sistema'}
                </h2>
                <p className="text-gray-500 text-sm leading-relaxed">
                  {sessionExpired
                    ? 'Sua sessão expirou. Entre novamente para continuar.'
                    : 'Demonstração: as credenciais já estão preenchidas.'}
                </p>
              </div>

              {loginError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2.5">
                  <span className="text-red-500 text-base leading-none mt-0.5">⚠</span>
                  <p className="text-sm text-red-700 leading-snug">{loginError}</p>
                </div>
              )}

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Usuário</FieldLabel>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={DEMO_USER}
                  autoComplete="username"
                  autoFocus
                  disabled={busy}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900
                    focus:outline-none focus:ring-2 focus:ring-[#C62828]/40 focus:border-[#C62828]
                    disabled:bg-gray-50"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Senha</FieldLabel>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                  disabled={busy}
                />
              </label>

              <button
                type="submit"
                disabled={busy || !username.trim() || !password}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3
                  bg-[#C62828] hover:bg-[#B71C1C] active:bg-[#A31818]
                  disabled:opacity-60 disabled:cursor-not-allowed
                  text-white font-semibold text-sm rounded-lg transition-colors shadow-sm
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C62828]/60"
              >
                {busy
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Entrando…</>
                  : <><LogIn className="w-4 h-4" /> Entrar</>}
              </button>

              <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                Usuário <code className="text-gray-500">{DEMO_USER}</code>, senha{' '}
                <code className="text-gray-500">{DEMO_PASSWORD}</code> — conta única desta
                demonstração.
              </p>
            </form>
        </div>
      </div>
    </div>
  )
}
