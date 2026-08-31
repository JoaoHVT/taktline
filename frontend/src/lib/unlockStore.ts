/**
 * unlockStore — module-level store for the ADMIN second-factor "unlock" grant.
 *
 * Sensitive operations (downloads, exports, Denodo, user management) require a
 * short-lived grant obtained by POSTing ADMIN_PASSWORD to /api/admin/unlock. The
 * grant is replayed in the  X-Admin-Unlock  header by the axios interceptor and
 * expires ~15 min after issue ("unlock once per session"). This is a SEPARATE
 * secret from the import password (IMPORT_PASSWORD).
 *
 * Like tokenStore, this is a plain module variable (not React state) so the axios
 * interceptor can read it synchronously. The grant is mirrored in sessionStorage
 * so a page refresh within the window keeps the session unlocked.
 */

const STORAGE_KEY = 'optvision.unlock'

let _token: string | null = null
let _expiresAt = 0 // epoch ms

function _hydrate(): void {
  if (typeof window === 'undefined') return
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const v = JSON.parse(raw)
    if (v && typeof v.token === 'string' && typeof v.expiresAt === 'number') {
      _token = v.token
      _expiresAt = v.expiresAt
    }
  } catch {
    /* corrupt entry — ignore */
  }
}
_hydrate()

/** The current unlock grant, or null if absent/expired. */
export function getUnlockToken(): string | null {
  if (!_token) return null
  if (Date.now() >= _expiresAt) {
    clearUnlock()
    return null
  }
  return _token
}

export function isUnlocked(): boolean {
  return getUnlockToken() !== null
}

/** Store a fresh grant. `expiresInSec` is the server TTL; we shave a small margin. */
export function setUnlock(token: string, expiresInSec: number): void {
  _token = token
  _expiresAt = Date.now() + Math.max(0, expiresInSec - 10) * 1000
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: _token, expiresAt: _expiresAt }))
  } catch {
    /* storage disabled — the in-memory grant still works for this tab */
  }
  _notify()
}

export function clearUnlock(): void {
  _token = null
  _expiresAt = 0
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  _notify()
}

// ── Subscriptions (optional UI reflection of locked/unlocked state) ───────────
const _subs = new Set<() => void>()
export function subscribeUnlock(fn: () => void): () => void {
  _subs.add(fn)
  return () => _subs.delete(fn)
}
function _notify(): void {
  _subs.forEach(f => {
    try {
      f()
    } catch {
      /* a bad subscriber must not break the store */
    }
  })
}

// ── Failed-password lockout ───────────────────────────────────────────────────
// When the backend signals a lockout (429 + X-Locked-Out on a password route), the
// user loses access to protected operations for this SPA session: no unlock dialog
// may open, no further attempts are allowed, and only a generic message is shown
// (the duration is intentionally never disclosed). The flag resets on a full page
// reload — by then the server-side lockout has usually expired and the next
// /permissions/me fetch restores the real role automatically.
let _lockedOut = false
let _noticeVisible = false

export function isLockedOut(): boolean {
  return _lockedOut
}

/** Flag the session as locked out and surface the generic notice. Also drops any
 *  cached unlock grant so no sensitive request can slip through. */
export function setLockedOut(): void {
  _lockedOut = true
  _noticeVisible = true
  clearUnlock() // also notifies
  _notify()
}

/** Clear the lockout (server reports it has expired). Restores normal access + hides
 *  the notice. Called when /permissions/me comes back with locked=false. */
export function clearLockedOut(): void {
  if (!_lockedOut && !_noticeVisible) return
  _lockedOut = false
  _noticeVisible = false
  _notify()
}

export function isLockoutNoticeVisible(): boolean {
  return _noticeVisible
}

// ── Hard admin ban (blocked account) ──────────────────────────────────────────
// Distinct from the transient lockout: a blocked account is denied the WHOLE app by an
// admin (server 403 + X-Blocked). It is server-authoritative and persists until an admin
// unblocks — the frontend shows a permanent access-denied page and self-heals only when
// /permissions/me later reports blocked=false.
// TWO reasons reach this state and they are NOT the same message:
//   'banned'       — an admin revoked this specific account.
//   'unregistered' — new-user lockdown is on and this identity has no roster row, so it is
//                    denied without being registered as Reader. It must not be told that a
//                    roster or a role even exists; it sees a generic unavailability notice.
// The server decides which, via X-Blocked-Reason (and blockedReason on /permissions/me).
export type BlockedReason = 'banned' | 'unregistered'

let _blocked = false
let _blockedReason: BlockedReason = 'banned'

export function isBlocked(): boolean {
  return _blocked
}

export function blockedReason(): BlockedReason {
  return _blockedReason
}

/** Flag the session as blocked (denies the app). Drops any unlock grant defensively. */
export function setBlocked(reason: BlockedReason = 'banned'): void {
  // Not an early return on `_blocked` alone: the reason can change without the flag changing
  // (an admin bans an account that was already denied by the lockdown), and the overlay text
  // must follow it.
  if (_blocked && _blockedReason === reason) return
  _blocked = true
  _blockedReason = reason
  clearUnlock() // also notifies
  _notify()
}

/** Clear the block (server reports blocked=false, i.e. an admin unblocked the account). */
export function clearBlocked(): void {
  if (!_blocked) return
  _blocked = false
  _blockedReason = 'banned'
  _notify()
}

// ── Deliberate shutdown ("Desativar Servidor") ────────────────────────────────
// The admin switch that closes the app to its users. The server enforces it (503 +
// X-Server-Offline on every protected route for non-admins); this flag is only how the
// interceptor tells the UI, so a session ALREADY OPEN when the switch is flipped swaps to
// the notice on its next request instead of scattering failed-request errors.
//
// The message is the server's, carried in the 503 body — never composed here, because it is
// what the admin wrote for exactly this moment. Admins never reach this state: they are exempt
// server-side, which is what keeps the way back in open.
let _serverOffline = false
let _serverOfflineMsg = ''

export function isServerOffline(): boolean {
  return _serverOffline
}

export function serverOfflineMessage(): string {
  return _serverOfflineMsg
}

/** Flag the session as denied by the shutdown switch, with the admin's message. */
export function setServerOffline(message: string): void {
  const msg = (message || '').trim()
  if (_serverOffline && _serverOfflineMsg === msg) return
  _serverOffline = true
  _serverOfflineMsg = msg
  _notify()
}

/** Clear it (the switch was turned back off — e.g. the admin just saved). */
export function clearServerOffline(): void {
  if (!_serverOffline) return
  _serverOffline = false
  _serverOfflineMsg = ''
  _notify()
}

/** Re-show the generic lockout message (e.g. the user retried a protected action). */
export function showLockoutNotice(): void {
  _noticeVisible = true
  _notify()
}

/** Dismiss the notice. The lockout itself stays in effect (dialogs remain blocked). */
export function hideLockoutNotice(): void {
  _noticeVisible = false
  _notify()
}

// ── Unlock prompt trigger (the modal registers the handler) ───────────────────
// The handler shows the UnlockModal and resolves true once the grant is stored,
// or false if the user cancels. Mirrors tokenStore's reauth trigger.
let _handler: (() => Promise<boolean>) | null = null
export function registerUnlockHandler(fn: (() => Promise<boolean>) | null): void {
  _handler = fn
}

let _inFlight: Promise<boolean> | null = null
/**
 * Ensure the session is unlocked, prompting via the modal if needed. Concurrent
 * callers (several sensitive requests failing at once) share ONE modal/promise.
 * Resolves true when unlocked, false if cancelled or no handler is mounted.
 */
export function triggerUnlock(): Promise<boolean> {
  // Locked out → never open the password dialog; show the generic notice instead.
  if (isLockedOut()) { showLockoutNotice(); return Promise.resolve(false) }
  if (isUnlocked()) return Promise.resolve(true)
  if (_inFlight) return _inFlight
  if (!_handler) return Promise.resolve(false)
  _inFlight = _handler().finally(() => {
    _inFlight = null
  })
  return _inFlight
}
