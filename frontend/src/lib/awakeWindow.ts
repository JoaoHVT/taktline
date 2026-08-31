// ── Working-hours gate for background pollers ────────────────────────────────
// Railway's sleep is activity-based: ANY request resets a 10-minute idle timer.
// The keepalive cron (see /keepalive) pings only during working hours so the
// backend sleeps nights and weekends.
//
// An idle poller silently defeats that. Pausing on `visibilityState` is not
// enough on its own: visibility tracks whether the tab is RENDERED, not whether
// anyone is using it, so a tab left in the foreground on a machine that never
// locks keeps polling — and keeps the backend awake — all weekend.
//
// So every background poller gates on this too. Note this only stops IDLE
// polling: real user actions still hit the API and still wake the backend at
// any hour, which is the intended behaviour.
//
// Evaluated in the browser's LOCAL time, mirroring the cron's intent
// (`*/5 11-20 * * 1-5` in UTC == 08:00–18:00 Mon–Fri at UTC−3).

export const AWAKE_START_HOUR = 8   // inclusive
export const AWAKE_END_HOUR   = 18  // exclusive

/** Pure clock check — no environment, so it stays unit-testable. */
export function isWithinAwakeWindow(now: Date = new Date()): boolean {
  const day = now.getDay()            // 0 = Sunday … 6 = Saturday
  if (day === 0 || day === 6) return false
  const hour = now.getHours()
  return hour >= AWAKE_START_HOUR && hour < AWAKE_END_HOUR
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

/** A backend that CAN'T sleep: localhost, or the LAN IP start.py writes into .env for device
 *  testing. Gating those would park the status dots on 'sleeping' at 19:00 while the server is
 *  plainly running and serving requests — the window only ever meant "let RAILWAY sleep".
 *  Unparseable → treat as local (never gate): failing open costs a poll, failing closed lies. */
export function isLocalApi(apiUrl: string = API_URL): boolean {
  let host: string
  try { host = new URL(apiUrl).hostname.replace(/^\[|\]$/g, '') } catch { return true }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  // mDNS name of a machine on this LAN (https://<pc>.local, the Caddy front door).
  // Same reasoning as the private ranges above: it can't be Railway, so it can't sleep.
  if (host.endsWith('.local')) return true
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

// ── Quiet mode: the admin switched the server off ────────────────────────────
// "Desativar Servidor" closes the app to its users, and the SERVER is what enforces that:
// while it is on, every protected route is refused for non-admins (503 + X-Server-Offline).
// Quiet mode is the client's half — it stops the background pollers from beating on an API
// that is answering nothing but refusals, which would otherwise fill the console with
// failures the user cannot act on and cannot see past the offline notice.
//
// It is a NOISE control, not the access control: nothing here decides who gets in. A client
// that ignored the flag entirely would still be refused by the server, request by request.
//
// In-flight import/solver job pollers also keep running — turn the switch on when no job is
// running, since their requests are refused like any other.
//
// Learned WITHOUT a poll of its own: `server_offline` rides along on /api/db/status, which
// the health hook already requests (see the endpoint's docstring). A dedicated poll for the
// flag would generate exactly the traffic this exists to remove.
let _serverQuiet = false
const _quietSubs = new Set<() => void>()

export function isServerQuiet(): boolean {
  return _serverQuiet
}

/** Server-authoritative. Called from wherever the offline flag is observed. */
export function setServerQuiet(value: boolean): void {
  if (value === _serverQuiet) return
  _serverQuiet = value
  _quietSubs.forEach(fn => { try { fn() } catch { /* a bad subscriber must not break the rest */ } })
}

export function subscribeServerQuiet(fn: () => void): () => void {
  _quietSubs.add(fn)
  return () => { _quietSubs.delete(fn) }
}

/** THE gate every background poller uses. Poll when the backend can't sleep anyway (local dev),
 *  or when we're inside working hours — and never while the server is deliberately off. */
export function shouldPollNow(now: Date = new Date()): boolean {
  if (_serverQuiet) return false
  return isLocalApi() || isWithinAwakeWindow(now)
}

// When the app is actively used, real API traffic keeps the backend awake regardless —
// so within this window of a genuine request we let the status/admin pollers probe for
// the TRUE state instead of parking on 'sleeping'/hidden. Kept SHORTER than the 5-min
// poll interval, so once the user goes idle, activity lapses before the next beat and
// polling stops on its own (letting Railway sleep). Background pollers' own requests are
// excluded from the activity signal (api.ts config._backgroundPoll), so this can't
// perpetuate itself.
export const RECENT_ACTIVITY_MS = 3 * 60 * 1000

/** Was there genuine (non-poll) backend traffic within RECENT_ACTIVITY_MS? Callers pass
 *  the last real contact time from api.getLastBackendContactAt(). */
export function isRecentlyActive(lastContactAt: number, now: number = Date.now()): boolean {
  return lastContactAt > 0 && now - lastContactAt < RECENT_ACTIVITY_MS
}

/** Poll gate that ALSO opens during active off-hours use: poll inside working hours (or
 *  local dev), or whenever real traffic proves the backend is currently awake.
 *
 *  Quiet mode overrides BOTH arms. The recent-activity arm especially: right after the switch
 *  is thrown there is by definition fresh traffic (the admin's own save), so without this the
 *  indicators would keep beating for another RECENT_ACTIVITY_MS and hold the server up. */
export function shouldPollOrActive(lastContactAt: number, now: number = Date.now()): boolean {
  if (_serverQuiet) return false
  return shouldPollNow(new Date(now)) || isRecentlyActive(lastContactAt, now)
}

// ── Adaptive cadence for the admin indicators ────────────────────────────────
// The live counters (online users, admin alerts) need to feel immediate WITHOUT
// reintroducing the idle polling this module exists to prevent. The split:
//
//   • ACTIVE — real user traffic within RECENT_ACTIVITY_MS proves the backend is
//     already awake and someone is watching. Polling fast here costs nothing extra:
//     the user's own requests are holding the sleep timer open regardless.
//   • IDLE — nobody is doing anything. Fall back to the slow beat, which combined
//     with the visibility + window gates is what lets Railway actually sleep.
//
// Because activity is measured from REAL traffic only (background polls are excluded
// via api.ts _backgroundPoll), the fast cadence lapses on its own ~3 min after the
// user stops — it can never sustain itself and hold the backend awake.
export const ACTIVE_POLL_MS = 30 * 1000
export const IDLE_POLL_MS   = 5 * 60 * 1000

/** How long until the next beat, given when the backend last saw real traffic. */
export function nextPollDelay(lastContactAt: number, now: number = Date.now()): number {
  return isRecentlyActive(lastContactAt, now) ? ACTIVE_POLL_MS : IDLE_POLL_MS
}
