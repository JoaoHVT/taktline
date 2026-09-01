/**
 * tokenStore — module-level store for the current session token.
 * Updated by useAuth after each login / token renewal.
 * Read by the axios interceptor in api.ts to attach Authorization headers.
 *
 * This is intentionally a simple module variable (not React state) so it
 * can be read synchronously inside the axios interceptor without hooks.
 *
 * The token is issued by the backend (POST /api/auth/login, signed HS256), and NOTHING ELSE
 * remembers the session — so persisting it is this module's job. Without that, every page
 * refresh would be a new login.
 *
 * localStorage and not sessionStorage: the app is opened across several tabs at once, and a
 * per-tab session would ask for the password in each one.
 */

const STORAGE_KEY = 'taktline.session'

export interface SessionUser {
  username: string
  email: string
  name: string
  role?: string
}

let _token: string | null = null
let _user: SessionUser | null = null

// Listeners notified when a token first appears (or is replaced). The health poll mounts
// before the user has signed in, so its first DB probe is guaranteed to 401; without this
// signal it would sit on a stale 'offline' until the next beat.
const _tokenListeners = new Set<(token: string | null) => void>()

/** Subscribe to token changes. Returns an unsubscribe function. */
export function onTokenChange(fn: (token: string | null) => void): () => void {
  _tokenListeners.add(fn)
  return () => { _tokenListeners.delete(fn) }
}

export function setToken(token: string | null): void {
  const changed = _token !== token
  _token = token
  if (!changed) return
  _tokenListeners.forEach(fn => {
    try { fn(token) } catch { /* a listener error must never break auth */ }
  })
}

export function getToken(): string | null {
  return _token
}

// ── Persisted session ────────────────────────────────────────────────────────
// One localStorage entry holding { token, user }. Both halves are written together
// because a token without the user (or the reverse) is a half-restored session that
// renders as "logged in" with no name, or as "logged out" while requests still carry
// a valid token.

/** Decoded `exp` of a JWT, in ms — or null when absent/unreadable. Decode only:
 *  verifying the signature is the server's job and the client cannot do it anyway. */
export function tokenExpiryMs(token: string | null): number | null {
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** True while the token exists and stays valid for at least `marginMs` more. */
export function tokenUsable(token: string | null, marginMs = 30_000): boolean {
  const exp = tokenExpiryMs(token)
  return exp !== null && exp - Date.now() > marginMs
}

export function getSessionUser(): SessionUser | null {
  return _user
}

/** Store (and persist) the whole session. `null` clears it — that is the logout path. */
export function setSession(token: string | null, user: SessionUser | null): void {
  _user = token ? user : null
  setToken(token)          // notifies listeners (health poll, permissions fetch)
  try {
    if (token && user) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }))
    else               localStorage.removeItem(STORAGE_KEY)
  } catch { /* private mode / storage disabled — the session still works in-memory */ }
}

/** Update only the remembered user (e.g. after a role refresh) without touching the token. */
export function setSessionUser(user: SessionUser | null): void {
  _user = user
  try {
    if (_token && user) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: _token, user }))
  } catch { /* ignore */ }
}

/**
 * Restore the persisted session on startup. Returns it, or null when there is nothing
 * usable to restore.
 *
 * An EXPIRED token is discarded here rather than restored and left for the first request
 * to reject: restoring it would paint the app as signed-in for a moment and then bounce
 * the user to the login screen, which reads as a crash rather than as an expiry.
 */
export function restoreSession(): { token: string; user: SessionUser } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { token?: string; user?: SessionUser }
    const token = typeof parsed?.token === 'string' ? parsed.token : ''
    const user = parsed?.user
    if (!token || !user?.username || !tokenUsable(token, 0)) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    _user = user
    setToken(token)
    return { token, user }
  } catch {
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    return null
  }
}

// ── Per-browser id (X-Client-Id) ─────────────────────────────────────────────
// A random opaque id, created once per browser and sent on every request. It exists for
// ONE thing: the server-side cap of 5 access requests per browser. It is not an identity
// and is never treated as one — it is client-supplied and a user can clear it in two
// clicks; the server's per-IP counter is what backs it up.
const CLIENT_ID_KEY = 'taktline.clientId'

export function getClientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(CLIENT_ID_KEY, id)
    }
    return id
  } catch {
    return ''
  }
}

// ── Silent refresh callback ──────────────────────────────────────────────────
// Registered by useAuth after mount. Called by the axios 401 interceptor to
// silently acquire a new token without user interaction.

let _refresher: (() => Promise<void>) | null = null

export function setSilentRefresher(fn: () => Promise<void>): void {
  _refresher = fn
}

// ── Reauth trigger ───────────────────────────────────────────────────────────
// Registered by useAuth. Called by the API layer (axios interceptor + raw-fetch
// stream path) when the SERVER authoritatively rejected the token (401) AND a
// silent refresh could not recover it. This is what guarantees the re-login modal
// always appears instead of leaving the user stuck with a bare auth error.
//
// It is intentionally only fired on a server 401 + failed refresh (never on a
// merely transient client-side refresh hiccup), so a network blip cannot nuke a
// still-valid session. If a later periodic/visibility silent refresh succeeds, it
// flips the session back to 'ok' and the modal auto-dismisses — self-healing.
let _reauthTrigger: (() => void) | null = null

export function setReauthTrigger(fn: () => void): void {
  _reauthTrigger = fn
}

/** Force the app into the "must re-authenticate" state (shows the LoginModal). */
export function triggerReauth(): void {
  _reauthTrigger?.()
}

// A single in-flight refresh shared by all concurrent callers. When several Gantt
// requests expire at once (period selection + type loading + data fetch), they would
// otherwise each fire their own refresh — stampeding and racing. The
// first caller starts the refresh; everyone else awaits the same promise.
let _refreshInFlight: Promise<boolean> | null = null

/**
 * Attempt a silent token refresh. Returns true if a new token was stored,
 * false if the refresh failed or no refresher is registered. Concurrent calls
 * are coalesced into one underlying silent acquisition.
 */
export async function refreshToken(): Promise<boolean> {
  if (!_refresher) return false
  if (_refreshInFlight) return _refreshInFlight
  _refreshInFlight = (async () => {
    try {
      await _refresher!()
      return !!_token
    } catch {
      return false
    }
  })()
  try {
    return await _refreshInFlight
  } finally {
    _refreshInFlight = null
  }
}
