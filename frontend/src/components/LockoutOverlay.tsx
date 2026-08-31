'use client'
// ── Failed-password lockout notice ────────────────────────────────────────────
// Globally mounted. When the backend signals a lockout (429 + X-Locked-Out), the
// axios interceptor flips the global lockout flag; this overlay then shows a GENERIC
// message — no duration, no retry time, no countdown, no indication of whether the
// block is temporary or permanent. It also forces a permissions refresh so the UI
// immediately drops the (now server-revoked) Editor/Admin privileges to Reader.
import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { ShieldAlert } from 'lucide-react'
import { subscribeUnlock, isLockedOut, isLockoutNoticeVisible, hideLockoutNotice } from '@/lib/unlockStore'
import { usePermissions } from '@/context/PermissionsContext'

const RED = '#D32F2F'

export function LockoutOverlay() {
  const locked  = useSyncExternalStore(subscribeUnlock, isLockedOut, () => false)
  const visible = useSyncExternalStore(subscribeUnlock, isLockoutNoticeVisible, () => false)
  const { refresh } = usePermissions()

  // On lockout, re-fetch permissions: the server now resolves this user as Reader for
  // the lockout window, so the privileged UI (import tabs, Save, Manage Users) hides.
  useEffect(() => {
    if (locked) refresh()
  }, [locked, refresh])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60">
      <div className="relative bg-white rounded-lg shadow-2xl w-[380px] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: RED }}>
          <ShieldAlert size={15} className="text-white shrink-0" />
          <span className="font-semibold text-sm text-white">Acesso bloqueado</span>
        </div>
        <div className="px-4 py-4 flex flex-col gap-4">
          <p className="text-sm text-gray-700 leading-relaxed">
            Acesso a esta operação foi revogado. Contate um administrador se você
            acredita que isso é um engano.
          </p>
          <div className="flex justify-end">
            <button
              onClick={hideLockoutNotice}
              className="px-3 py-1.5 rounded text-[12px] font-semibold text-white"
              style={{ background: RED }}
            >
              Entendi
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
