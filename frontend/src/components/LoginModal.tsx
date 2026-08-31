'use client'
import { useState } from 'react'
import Image from 'next/image'
import { Loader2, LogIn, UserPlus, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * LoginModal — overlay em tela cheia que bloqueia a interface até a autenticação.
 * Não pode ser fechado pelo usuário; some sozinho quando o login dá certo.
 *
 * Duas portas, porque com a saída do Entra ID passaram a existir duas situações
 * diferentes e antes só havia uma:
 *
 *   ENTRAR       quem já tem conta — inclusive todo mundo que existia antes da troca,
 *                com o mesmo usuário de sempre e a senha que o administrador distribuiu na
 *                migração. O campo aceita 'nome.sobrenome' OU o endereço inteiro: o servidor
 *                corta em '@' antes de procurar a conta, então as duas formas caem na mesma.
 *   CRIAR CONTA  quem não tem. Não cria nada na hora: envia uma SOLICITAÇÃO com o usuário e
 *                a senha escolhida, que um administrador aprova. Sem diretório corporativo
 *                não há mais como validar alguém antes de ele chegar aqui, e aprovação
 *                humana é o que substituiu essa validação.
 *
 * NÃO PERGUNTA E-MAIL. O endereço é derivado do usuário (<usuario>@<domínio da empresa>),
 * que era o único valor que o campo podia ter — pedi-lo de novo só criava uma forma de
 * errar e uma segunda coisa para o servidor conferir contra a primeira.
 *
 * sessionExpired — verdadeiro quando a pessoa já estava logada e a sessão foi recusada
 * pelo servidor. Mostra o aviso de expiração em vez do texto de primeiro acesso, e a aba
 * "Criar conta" fica fora: quem está nesse estado tem conta, o que falta é reautenticar.
 */

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
  const { login, requestAccess, loginError, loggingIn, isInitializing, setLoginError } = useAuth()

  const [mode, setMode] = useState<'signin' | 'signup'>('signin')

  // Entrar
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Criar conta
  const [suUser,    setSuUser]    = useState('')
  const [suPass,    setSuPass]    = useState('')
  const [suConfirm, setSuConfirm] = useState('')
  const [suBusy,    setSuBusy]    = useState(false)
  const [suError,   setSuError]   = useState<string | null>(null)
  const [suSent,    setSuSent]    = useState(false)

  const busy = loggingIn || isInitializing

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    await login(username, password)
    setPassword('')
  }

  async function submitSignUp(e: React.FormEvent) {
    e.preventDefault()
    if (suBusy) return
    setSuError(null)
    if (suPass !== suConfirm) {
      setSuError('As senhas não conferem.')
      return
    }
    setSuBusy(true)
    const result = await requestAccess({
      username: suUser.trim(),
      password: suPass,
    })
    setSuBusy(false)
    if (result.ok) {
      setSuSent(true)
      setSuPass(''); setSuConfirm('')
    } else {
      setSuError(result.error ?? 'Não foi possível enviar a solicitação.')
    }
  }

  function switchMode(next: 'signin' | 'signup') {
    setMode(next)
    setLoginError(null)
    setSuError(null)
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.60)', backdropFilter: 'blur(4px)' }}
      aria-modal="true"
      role="dialog"
      aria-label={sessionExpired ? 'Sessão expirada' : 'Acesso ao MasterPlanner'}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm my-auto overflow-hidden">

        {/* ── Cabeçalho ─────────────────────────────────────────────── */}
        <div className="px-8 py-6 flex flex-col items-center gap-2" style={{ background: RED }}>
          <Image
            src="/imagens/wab2.png"
            alt="Wabtec"
            width={140}
            height={42}
            className="object-contain brightness-0 invert"
            priority
          />
          <span className="text-white/80 text-xs font-medium tracking-widest uppercase">
            MasterPlanner
          </span>
        </div>

        {/* ── Abas ──────────────────────────────────────────────────── */}
        {!sessionExpired && (
          <div className="flex border-b border-gray-200">
            {([['signin', 'Entrar', LogIn], ['signup', 'Criar conta', UserPlus]] as const).map(
              ([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchMode(key)}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-semibold transition-colors
                    ${mode === key
                      ? 'text-[#C62828] border-b-2 border-[#C62828] bg-white'
                      : 'text-gray-500 hover:text-gray-700 border-b-2 border-transparent'}`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ),
            )}
          </div>
        )}

        {/* ── Corpo ─────────────────────────────────────────────────── */}
        <div className="px-8 py-7">

          {mode === 'signin' || sessionExpired ? (
            <form onSubmit={submitSignIn} className="flex flex-col gap-4">
              <div className="text-center space-y-1.5">
                <h2 className="text-gray-900 font-semibold text-lg">
                  {sessionExpired ? 'Sessão expirada' : 'Acesso ao sistema'}
                </h2>
                <p className="text-gray-500 text-sm leading-relaxed">
                  {sessionExpired
                    ? 'Sua sessão expirou. Entre novamente para continuar.'
                    : 'Use seu usuário e senha para entrar.'}
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
                  placeholder="ex.: nome.sobrenome"
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
                Esqueceu a senha? Um administrador pode gerar uma nova para você.
              </p>
            </form>
          ) : suSent ? (
            /* Confirmação de solicitação enviada. O que ela promete é exatamente o que o
               servidor faz: fila para aprovação. Nenhum e-mail é enviado — a verificação
               por e-mail é um passo futuro e não existe ainda. */
            <div className="flex flex-col items-center gap-4 text-center py-2">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
              <h2 className="text-gray-900 font-semibold text-lg">Solicitação enviada</h2>
              <p className="text-gray-500 text-sm leading-relaxed">
                Um administrador precisa aprovar seu acesso. Quando isso acontecer, entre com o
                usuário <span className="font-semibold text-gray-700">{suUser.trim()}</span> e a
                senha que você escolheu.
              </p>
              <button
                type="button"
                onClick={() => { setSuSent(false); switchMode('signin') }}
                className="text-sm font-semibold text-[#C62828] hover:underline"
              >
                Voltar para Entrar
              </button>
            </div>
          ) : (
            <form onSubmit={submitSignUp} className="flex flex-col gap-3.5">
              <div className="text-center space-y-1.5">
                <h2 className="text-gray-900 font-semibold text-lg">Solicitar acesso</h2>
                <p className="text-gray-500 text-sm leading-relaxed">
                  Escolha usuário e senha. O acesso passa por aprovação de um administrador.
                </p>
              </div>

              {suError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2.5">
                  <span className="text-red-500 text-base leading-none mt-0.5">⚠</span>
                  <p className="text-sm text-red-700 leading-snug">{suError}</p>
                </div>
              )}

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Usuário</FieldLabel>
                <input
                  type="text"
                  value={suUser}
                  onChange={e => setSuUser(e.target.value)}
                  placeholder="ex.: nome.sobrenome"
                  autoComplete="username"
                  disabled={suBusy}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900
                    focus:outline-none focus:ring-2 focus:ring-[#C62828]/40 focus:border-[#C62828]
                    disabled:bg-gray-50"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Senha</FieldLabel>
                <PasswordInput
                  value={suPass}
                  onChange={setSuPass}
                  autoComplete="new-password"
                  disabled={suBusy}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <FieldLabel>Confirmar senha</FieldLabel>
                <PasswordInput
                  value={suConfirm}
                  onChange={setSuConfirm}
                  autoComplete="new-password"
                  disabled={suBusy}
                />
              </label>

              <button
                type="submit"
                disabled={suBusy || !suUser.trim() || !suPass || !suConfirm}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3 mt-1
                  bg-[#C62828] hover:bg-[#B71C1C] active:bg-[#A31818]
                  disabled:opacity-60 disabled:cursor-not-allowed
                  text-white font-semibold text-sm rounded-lg transition-colors shadow-sm
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C62828]/60"
              >
                {suBusy
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Enviando…</>
                  : <><UserPlus className="w-4 h-4" /> Solicitar acesso</>}
              </button>

              <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                A senha mínima tem 8 caracteres. Ela só passa a valer depois da aprovação.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
