'use client'
// ── Access denied (blocked account) ───────────────────────────────────────────
// Globally mounted. When an admin bans this account, the backend returns 403 + X-Blocked
// (and /permissions/me reports blocked=true), flipping the global blocked flag. This
// overlay then takes over the WHOLE screen with a permanent access-denied page — it is
// NOT dismissible (unlike the transient lockout notice) and blocks all app content behind
// it. It self-heals only when the server later reports the account unblocked. A permissions
// refresh is forced so any privileged UI is dropped immediately as well.
//
// TWO CASES, ONE SCREEN. 'banned' is a revoked account and says so. 'unregistered' changed
// meaning with the Entra ID removal: it used to be the new-user lockdown (an identity the
// corporate directory had authenticated but that had no roster row). Nobody is auto-registered
// any more, so a token can only name an unknown account when that account was DELETED while
// its session was still open — and the honest thing to tell that person is that the account is
// gone and how to come back, not that the server is unavailable.
import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { Ban } from 'lucide-react'
import { subscribeUnlock, isBlocked, blockedReason } from '@/lib/unlockStore'
import { usePermissions } from '@/context/PermissionsContext'

const RED = '#D32F2F'

const COPY = {
  banned: {
    title: 'Acesso revogado',
    lead: 'O acesso desta conta ao aplicativo foi revogado por um administrador.',
    hint: 'Se você acredita que isso é um engano, entre em contato com um administrador do sistema. '
        + 'Não é possível carregar o aplicativo enquanto o acesso estiver revogado.',
  },
  unregistered: {
    title: 'Conta não encontrada',
    lead: 'Esta conta não está mais registrada no sistema.',
    hint: 'Saia e entre novamente. Se você não tiver mais acesso, use "Criar conta" na tela de '
        + 'login para solicitar acesso a um administrador.',
  },
} as const

export function BlockedOverlay() {
  const blocked = useSyncExternalStore(subscribeUnlock, isBlocked, () => false)
  const reason = useSyncExternalStore(subscribeUnlock, blockedReason, () => 'banned' as const)
  const { refresh } = usePermissions()

  // On block, re-fetch permissions so the rest of the UI also treats this account as
  // stripped of access (the server already denies every request).
  useEffect(() => {
    if (blocked) refresh()
  }, [blocked, refresh])

  if (!blocked) return null

  const copy = COPY[reason] ?? COPY.banned

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative bg-white rounded-lg shadow-2xl w-[440px] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3" style={{ background: RED }}>
          <Ban size={16} className="text-white shrink-0" />
          <span className="font-semibold text-sm text-white">{copy.title}</span>
        </div>
        <div className="px-5 py-5 flex flex-col gap-3">
          <p className="text-sm text-gray-800 leading-relaxed">{copy.lead}</p>
          <p className="text-[13px] text-gray-500 leading-relaxed">{copy.hint}</p>
        </div>
      </div>
    </div>
  )
}
