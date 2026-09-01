'use client'
// ── User-permission layer (Reader / Editor / Admin) ──────────────────────────────────
// Resolves the logged-in user's role from the backend and exposes the derived capability
// flags the UI gates on. This ONLY controls which actions are available — it never changes
// the underlying editing/save/override workflows.
//
//   Reader (default) — view + read-only scenario work: load a scenario, see saved changes
//                      applied, compare, and run temporary what-if simulations. Everything
//                      that PERSISTS is off: no import tabs, Save disabled, no optimizer,
//                      no exports, no user management.
//   Editor           — Reader + import tabs + edit + save schedule changes + optimizer.
//   Admin            — Editor + manage users (add/remove Editors & Admins).
//
// The Reader simulation lane is deliberate: /api/gantt/scenario and /api/gantt/edit-locos
// are stateless READS (schedule + edits → freshly built GanttData in the response; nothing
// stored, no other user's view touched), so a Reader can explore a what-if but has no route
// to make it stick — persisting still requires PUT /api/gantt/overrides, which is Editor+.
//
// Resilience (the role must NOT vanish for a few seconds after a page refresh):
//   • The last confirmed {username, role} is cached in localStorage and used as the OPTIMISTIC
//     initial value, so a returning Editor/Admin keeps their UI immediately on refresh instead
//     of flashing back to Reader while the token/permission round-trip completes.
//   • The fetch fires as soon as an account exists (it does NOT wait for tokenReady==='ok'):
//     a request sent before the token is warm 401s, and the axios interceptor transparently
//     does a silent refresh + retry. Transient failures are retried here with backoff.
//   • We only ever drop to Reader on a DEFINITIVE signal — no authenticated account, or the
//     server actually returning role 'reader'. A transient/network failure keeps the last role.
//   • The backend still enforces every permission server-side, so the optimistic cache is purely
//     a UI hint — it can never grant real access.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getMyPermission, getCalendarExceptions, type UserRole } from '@/lib/api'
import { setCalendarExceptions } from '@/lib/ganttUtils'
import { setLockedOut, clearLockedOut, setBlocked, clearBlocked } from '@/lib/unlockStore'
import { useAuth } from '@/hooks/useAuth'

interface PermissionsValue {
  role:            UserRole
  username:        string
  canImport:       boolean   // access Excel/Database import tabs (Editor+)
  canSave:         boolean   // save schedule edits to the DB (Editor+)
  canManageUsers:  boolean   // open Manage Users (Admin only)
  /** Load a scenario, apply temporary LOCO edits, compare — all non-persistent. ANY role,
   *  Readers included. Gate a control on this ONLY when the action stays in the session;
   *  anything that reaches a write endpoint must gate on `canSave`/`canImport` instead. */
  canSimulate:     boolean
  /** Run the conflict/capacity optimizers (Editor+). Separate from `canSimulate`: the solver
   *  is the heaviest thing the app does and has no per-role rate limit, so it is not part of
   *  the Reader read-only lane even though its results are also session-only. */
  canOptimize:     boolean
  loading:         boolean
  refresh:         () => void
}

const PermissionsContext = createContext<PermissionsValue>({
  role: 'reader', username: '', canImport: false, canSave: false,
  canManageUsers: false, canSimulate: false, canOptimize: false,
  loading: true, refresh: () => {},
})

const CACHE_KEY = 'taktline.perm'
const VALID: UserRole[] = ['reader', 'editor', 'admin']

function localPart(email: string | undefined): string {
  return String(email || '').trim().toLowerCase().split('@')[0]
}

function readCache(): { username: string; role: UserRole } | null {
  if (typeof window === 'undefined') return null
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (v && typeof v.username === 'string' && VALID.includes(v.role)) return v
  } catch { /* ignore corrupt cache */ }
  return null
}

function writeCache(v: { username: string; role: UserRole } | null): void {
  if (typeof window === 'undefined') return
  try {
    if (v) localStorage.setItem(CACHE_KEY, JSON.stringify(v))
    else   localStorage.removeItem(CACHE_KEY)
  } catch { /* storage disabled — optimistic cache simply won't persist */ }
}

// Retry policy for the role fetch. A DEFINITIVE answer must never be retried:
//   • 401 — the axios interceptor already tried a silent refresh + one retry; another
//           attempt here can only 401 again (and re-fire the global reauth trigger).
//   • 403 — genuine authorization failure (wrong domain, hard ban). Not recoverable.
//   • 503 — the backend answered "dependency unavailable" (no DB). Polling won't fix it.
// Everything else (no response at all, 5xx) gets ONE retry. The previous 6-attempt
// exponential ladder ran on EVERY error class, so a machine that could not authenticate
// produced ~14 failing requests per mount — the reported log storm.
const MAX_ROLE_RETRIES = 1
const NO_RETRY_STATUS = [401, 403, 503]

function isDefinitiveAuthFailure(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' && NO_RETRY_STATUS.includes(status)
}

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, tokenReady } = useAuth()
  // Depend on a STABLE primitive, never on the currentUser object. The reason predates the
  // The identity object is rebuilt on some renders, so `currentUser`
  // got a fresh identity even with the same account signed in, and each of the effects below
  // re-fired — a fresh /api/permissions/me + calendar fetch — on any incidental auth event) and
  // survives it: useAuth now rebuilds `currentUser` on every token renewal, which is the same
  // hazard with a different cause. `username` is the account's stable key in the local system,
  // username is the stable key; email is the fallback.
  const accountKey = currentUser?.username ?? currentUser?.email ?? ''
  const cached = readCache()
  const [role,     setRole]     = useState<UserRole>(cached?.role ?? 'reader')
  const [username, setUsername] = useState(cached?.username ?? '')
  const [loading,  setLoading]  = useState(true)
  const [nonce,    setNonce]    = useState(0)

  const refresh = useCallback(() => setNonce(n => n + 1), [])

  // Load the admin calendar override delta once per authenticated session and install it
  // into the shared base calendar (ganttUtils), so client-side business-day helpers honor
  // admin edits. Best-effort: a failure just leaves the algorithmic base (pre-edit) calendar.
  useEffect(() => {
    if (!accountKey) { setCalendarExceptions([], []); return }
    let cancelled = false
    getCalendarExceptions()
      .then(x => { if (!cancelled) setCalendarExceptions(x.holidays, x.working) })
      .catch(() => { /* keep the algorithmic base calendar */ })
    return () => { cancelled = true }
  }, [accountKey, tokenReady])

  useEffect(() => {
    // No authenticated account → definitively Reader (logged out / fresh). Clear the cache so a
    // later different user can't inherit this role optimistically.
    if (!accountKey) {
      setRole('reader'); setUsername(''); setLoading(false); writeCache(null)
      return
    }

    // If the optimistic (cached) role belongs to a DIFFERENT account than the one now logged in,
    // don't trust it — fall back to Reader until the server confirms this account's role.
    const expected = localPart(currentUser?.email)
    const c = readCache()
    if (c && c.username && c.username !== expected) {
      setRole('reader'); setUsername('')
    }

    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)

    const run = () => {
      getMyPermission()
        .then(p => {
          if (cancelled) return
          setRole(p.role)
          setUsername(p.username)
          setLoading(false)
          writeCache({ username: p.username, role: p.role })
          // Server-authoritative lockout: reflect it in the global store so the notice
          // survives reloads and self-heals when the lockout expires (locked=false).
          if (p.locked) setLockedOut()
          else          clearLockedOut()
          // Server-authoritative denial: drives the access-denied page; self-heals on unblock.
          // blockedReason picks the wording — a personal ban and the new-user lockdown are the
          // same screen but not the same message.
          if (p.blocked) setBlocked(p.blockedReason === 'unregistered' ? 'unregistered' : 'banned')
          else           clearBlocked()
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // 401/403/503 are DEFINITIVE (see isDefinitiveAuthFailure): stop here, keeping the
          // optimistic/last-known role. We never downgrade to Reader on a failure — and we never
          // hammer the endpoint either. A real recovery re-triggers this effect through tokenReady
          // (a fresh token) or an explicit refresh().
          if (isDefinitiveAuthFailure(err)) { setLoading(false); return }
          attempt += 1
          // Transient only (no response at all, or a 5xx): token still warming up right after a
          // refresh, brief network blip. ONE retry, then give up gracefully.
          if (attempt <= MAX_ROLE_RETRIES) {
            timer = setTimeout(run, 700 * attempt)
          } else {
            setLoading(false)   // give up gracefully, keeping the last-known role
          }
        })
    }
    run()

    return () => { cancelled = true; if (timer) clearTimeout(timer) }
    // tokenReady is a dep so a fresh token (pending→ok, or reauth recovery) re-triggers the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- accountKey is currentUser's stable identity
  }, [accountKey, tokenReady, nonce])

  // Memoized so the value object's identity only changes when a flag actually changes. This provider
  // wraps the whole app; an unmemoized value would hand every consumer a new object on any incidental
  // re-render (an auth event bubbling through a parent), forcing needless re-renders.
  const value = useMemo<PermissionsValue>(() => ({
    role,
    username,
    canImport:      role === 'editor' || role === 'admin',
    canSave:        role === 'editor' || role === 'admin',
    canManageUsers: role === 'admin',
    // Any authenticated role, Readers included — the backing endpoints persist nothing.
    canSimulate:    true,
    canOptimize:    role === 'editor' || role === 'admin',
    loading,
    refresh,
  }), [role, username, loading, refresh])

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>
}

export function usePermissions(): PermissionsValue {
  return useContext(PermissionsContext)
}
