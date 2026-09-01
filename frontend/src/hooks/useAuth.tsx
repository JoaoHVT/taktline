'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  authLogin, authRefresh, type AuthSessionUser,
} from '@/lib/api'
import {
  setSession, setSessionUser, restoreSession, getSessionUser, getToken, tokenExpiryMs,
  tokenUsable, setSilentRefresher, setReauthTrigger, type SessionUser,
} from '@/lib/tokenStore'

/**
 * useAuth — a sessão única da aplicação.
 *
 * Três peças: o formulário de usuário e senha (LoginModal), lib/tokenStore guardando
 * { token, user } em localStorage, e POST /api/auth/refresh trocando um token ainda válido
 * por outro.
 *
 * A sessão é ÚNICA e vem de um contexto, e não uma cópia por chamador: com cópias
 * independentes, um 401 viraria 'reauth-required' em uma delas só — a tela de login poderia
 * nunca aparecer, ou nunca fechar depois de um login bem-sucedido.
 *
 * `tokenReady` ('pending' | 'ok' | 'reauth-required') é o sinal que a página, o cabeçalho, o
 * PermissionsProvider e os dois modais do Gantt observam para saber quando podem chamar a API.
 */

const devLog = (...args: unknown[]): void => {
  if (process.env.NODE_ENV === 'development') console.log(...args)
}

export interface AuthUser {
  name:      string
  email:     string
  username:  string
  role?:     string
}

/** Renova quando faltar menos que isto para o token expirar. */
const RENEW_MARGIN_MS = 30 * 60 * 1000     // 30 min
/** Batida do relógio que verifica a margem acima. */
const RENEW_CHECK_MS = 5 * 60 * 1000       // 5 min

function toAuthUser(u: SessionUser | AuthSessionUser | null): AuthUser | null {
  if (!u) return null
  return {
    name:  u.name || u.username,
    email: u.email || u.username,
    username: u.username,
    role: u.role,
  }
}

export type AuthContextValue = ReturnType<typeof useAuthController>

const AuthContext = createContext<AuthContextValue | null>(null)

/** Provider que detém a sessão única. Precisa ficar acima de todo consumidor de useAuth
 *  (PermissionsProvider, a página, o cabeçalho, os modais do Gantt). */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const value = useAuthController()
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Lê a sessão compartilhada. Lança se usado fora de <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

function useAuthController() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [loginError,  setLoginError]  = useState<string | null>(null)
  const [loggingIn,   setLoggingIn]   = useState(false)
  // 'pending'         — ainda restaurando a sessão gravada (primeiro render)
  // 'ok'              — token válido guardado, OU ninguém logado (estado limpo)
  // 'reauth-required' — o servidor recusou a sessão e a renovação não recuperou
  const [tokenReady,  setTokenReady]  = useState<'pending' | 'ok' | 'reauth-required'>('pending')

  // Verdadeiro durante todo o login interativo. Toda renovação em segundo plano se
  // recolhe enquanto isto estiver marcado: enquanto o usuário digita a senha, uma
  // renovação que falhe não pode escrever 'reauth-required' por cima do que ele está fazendo.
  const loggingInRef = useRef(false)

  const applySession = useCallback((token: string, user: AuthSessionUser | SessionUser) => {
    setSession(token, {
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
    })
    setCurrentUser(toAuthUser(user))
    setTokenReady('ok')
  }, [])

  const clearSession = useCallback(() => {
    setSession(null, null)
    setCurrentUser(null)
    setTokenReady('ok')     // sem conta = estado limpo, não sessão expirada
  }, [])

  // ── Restaurar a sessão gravada no primeiro render ──────────────────────────
  // Nada além deste módulo reconstrói a sessão, então ela é lida do tokenStore:
  // se este efeito não rodar, um F5 vira uma tela de login. Um token já expirado é
  // descartado dentro de restoreSession, e não restaurado para morrer na primeira chamada.
  useEffect(() => {
    const restored = restoreSession()
    if (restored) {
      setCurrentUser(toAuthUser(restored.user))
      setTokenReady('ok')
      devLog('[useAuth] sessão restaurada:', restored.user.username)
    } else {
      setTokenReady('ok')
    }
  }, [])

  // ── Renovação silenciosa ───────────────────────────────────────────────────
  // Um único caminho, usado tanto pelo interceptor no 401 quanto pelo relógio periódico.
  // Só falha de verdade quando o SERVIDOR recusa (401/403): sem resposta (rede caindo,
  // servidor dormindo) o token guardado continua valendo até expirar sozinho, então
  // derrubar a sessão nesse caso trocaria uma oscilação de rede por um re-login.
  const silentRefresh = useCallback(async (where: string): Promise<void> => {
    if (loggingInRef.current) {
      devLog(`[useAuth] ${where}: ignorado — login interativo em andamento`)
      return
    }
    if (!getToken()) return
    try {
      const result = await authRefresh()
      applySession(result.token, result.user)
      devLog(`[useAuth] ${where}: token renovado`)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 401 || status === 403) {
        console.warn(`[useAuth] ${where}: sessão recusada pelo servidor (${status})`)
        setSession(null, null)
        setTokenReady('reauth-required')
      } else {
        console.warn(`[useAuth] ${where}: falha transitória na renovação (sessão mantida):`, err)
      }
      throw err
    }
  }, [applySession])

  const silentRefreshRef = useRef(silentRefresh)
  useEffect(() => { silentRefreshRef.current = silentRefresh }, [silentRefresh])

  // Registra a renovação usada pelo interceptor do axios no 401.
  useEffect(() => {
    setSilentRefresher(() => silentRefreshRef.current('interceptor-refresh'))
  }, [])

  // Registra o gatilho global de reautenticação: disparado pela camada de API SÓ quando o
  // servidor respondeu 401 E a renovação não recuperou. Descarta o token ruim para que
  // nenhuma outra chamada o reenvie, mas MANTÉM `currentUser`, que é o que faz a tela
  // aparecer como "Sessão expirada" com o nome de quem estava logado, e não como um login novo.
  useEffect(() => {
    setReauthTrigger(() => {
      setSession(null, null)
      setTokenReady('reauth-required')
    })
  }, [])

  // ── Renovação periódica ────────────────────────────────────────────────────
  // Só renova perto do fim (RENEW_MARGIN_MS). Uma renovação a cada batida seria uma
  // requisição autenticada a cada poucos minutos por aba aberta — que é exatamente o
  // tráfego que impede o servidor de dormir (ver lib/awakeWindow).
  useEffect(() => {
    if (!currentUser) return
    const tick = () => {
      const token = getToken()
      if (!token) return
      const exp = tokenExpiryMs(token)
      if (exp === null) return
      if (exp - Date.now() < RENEW_MARGIN_MS) {
        silentRefreshRef.current('periodic-refresh').catch(() => { /* tratado dentro */ })
      }
    }
    const id = setInterval(tick, RENEW_CHECK_MS)
    return () => clearInterval(id)
  }, [currentUser])

  // ── Renovar ao voltar para a aba ───────────────────────────────────────────
  // Uma aba que ficou horas em segundo plano volta com o token perto do fim (ou já vencido).
  // Renovar aqui evita que a primeira ação do usuário depois da pausa seja um 401.
  useEffect(() => {
    if (!currentUser) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const token = getToken()
      if (!token) return
      if (!tokenUsable(token, RENEW_MARGIN_MS)) {
        silentRefreshRef.current('visibility-refresh').catch(() => { /* tratado dentro */ })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [currentUser])

  // ── Login ──────────────────────────────────────────────────────────────────
  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    const user = (username || '').trim()
    if (!user || !password) {
      setLoginError('Informe usuário e senha.')
      return false
    }
    setLoginError(null)
    setLoggingIn(true)
    loggingInRef.current = true
    try {
      const result = await authLogin(user, password)
      applySession(result.token, result.user)
      devLog('[useAuth] login concluído:', result.user.username)
      return true
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (!status) {
        // Sem resposta: rede, DNS ou o servidor ainda acordando. Dizer "usuário ou senha
        // inválidos" aqui mandaria o usuário conferir uma senha que está certa.
        setLoginError('Não foi possível falar com o servidor. Verifique a conexão e tente novamente.')
      } else if (typeof detail === 'string' && detail) {
        setLoginError(detail)
      } else if (status === 401) {
        setLoginError('Usuário ou senha inválidos.')
      } else {
        setLoginError('Não foi possível entrar. Tente novamente.')
      }
      return false
    } finally {
      loggingInRef.current = false
      setLoggingIn(false)
    }
  }, [applySession])

  // ── Troca da própria senha ─────────────────────────────────────────────────
  // ── Logout ─────────────────────────────────────────────────────────────────
  // Puramente local: o token é auto-contido e assinado, não há sessão do lado do servidor
  // para encerrar. Apagar a cópia guardada é o que encerra a sessão neste navegador; o token
  // já emitido continua tecnicamente válido até expirar, que é a contrapartida conhecida de
  // um token sem estado. Uma revogação imediata existe e é outra coisa: excluir ou bloquear
  // a conta, que o servidor confere a cada requisição.
  const logout = useCallback(async () => {
    devLog('[useAuth] logout')
    clearSession()
  }, [clearSession])

  const isAuthenticated = !!currentUser

  return useMemo(
    () => ({
      isAuthenticated,
      currentUser,
      loginError,
      loggingIn,
      // Mantido para os consumidores que já liam este par: aqui não existe mais uma
      // inicialização assíncrona de biblioteca externa para esperar, então o botão de
      // entrar nunca precisa ficar desabilitado por causa dela.
      isInitializing: tokenReady === 'pending',
      tokenReady,
      login,
      logout,
      setLoginError,
    }),
    [isAuthenticated, currentUser, loginError, loggingIn, tokenReady, login, logout],
  )
}
