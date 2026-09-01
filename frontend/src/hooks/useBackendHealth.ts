'use client'
import { useCallback, useEffect, useState, useRef } from 'react'
import { api, getLastBackendContactAt, onBackendContact } from '@/lib/api'
import { onTokenChange } from '@/lib/tokenStore'
import { isServerOffline } from '@/lib/unlockStore'
import { shouldPollNow, isRecentlyActive, isServerQuiet, setServerQuiet, subscribeServerQuiet } from '@/lib/awakeWindow'
import { CONFIGURED_API_URL } from '@/lib/apiOrigin'

// 'sleeping' is derived from the CLOCK, not detected — the host exposes no way to
// ask whether a service is asleep. It means "outside working hours and no recent
// activity, so we've stopped polling and the backend is expected to be asleep".
// The one refinement: if the app is ACTIVELY used off-hours, real user traffic has
// already woken the backend (see api.ts getLastBackendContactAt), so we probe for
// the TRUE status instead of showing 'sleeping'. Once that activity lapses we stop
// probing again, so the backend can sleep — the dot stays cheap.
// It is never shown against a LOCAL backend (see shouldPollNow → isLocalApi): a
// local server doesn't sleep, so 'sleeping' there would be plainly false rather
// than merely imprecise.
export type BackendStatus = 'checking' | 'online' | 'offline' | 'sleeping'
export type DbStatus     = 'checking' | 'online' | 'offline' | 'sleeping'

interface BackendHealth {
  status:   BackendStatus
  dbStatus: DbStatus
  apiUrl:   string
  lastChecked: Date | null
}

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min, só com a aba visível (deixa o backend dormir)

// /api/db/status requires auth, and this hook mounts BEFORE there is a token, so the
// first probe of a session reliably 401s. Two consequences are handled below:
//   • A 401/403 means "we can't see the DB yet", NOT "the DB is down" — the dot stays
//     'checking' rather than lying 'offline'.
//   • The moment a token lands we re-probe (onTokenChange), instead of leaving a stale
//     dot until the next 5-min beat. That wait was the whole "DB shows OFFLINE for ages
//     while DB features work fine" symptom.
const DB_PROBE_TIMEOUT_MS = 15_000  // NullPool → each probe may open a fresh TLS
                                    // connection to the connection pooler; 5s under-cut
                                    // that and produced false OFFLINE readings.
const HEALTH_TIMEOUT_MS = 10_000    // was 3s — a busy/cold backend that answers real
                                    // requests in 4-8s was being reported OFFLINE.
// Real user traffic answered this recently ⇒ the backend is demonstrably up, whatever
// a probe says (a probe can time out while heavy real requests are being served).
const RECENT_TRAFFIC_MS = 60_000

function isAuthError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  return status === 401 || status === 403
}

export function useBackendHealth(): BackendHealth {
  const [status,   setStatus]   = useState<BackendStatus>('checking')
  const [dbStatus, setDbStatus] = useState<DbStatus>('checking')
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Consecutive DB-probe failures — one blip must not flip a working DB to OFFLINE.
  const dbFailsRef = useRef(0)
  // Single-flight guard. check() is reachable from FOUR independent triggers — the
  // interval tick, the visibility handler, the real-traffic nudge and onTokenChange —
  // and a token landing mid-beat fired a second /api/health + /api/db/status pair
  // concurrently with the first. Overlapping probes also fought over dbFailsRef, so
  // two in-flight misses could count as "two consecutive" and flip a healthy DB to
  // OFFLINE. Dropping the overlapping call is correct: the in-flight one answers it.
  const inFlightRef = useRef(false)

  // So para EXIBIR — o tooltip do ponto de status. As sondas nao usam este valor: elas
  // saem pelo cliente `api`, que ja resolve a origem em tempo de execucao (lib/apiOrigin).
  // Deliberadamente o valor CONFIGURADO e nao a origem da aba: window.location so existe
  // no navegador, e um valor que difere entre o HTML do servidor e o da hidratacao vira
  // divergencia de hidratacao num atributo `title` — ruido de console a troco de nada.
  const apiUrl = CONFIGURED_API_URL

  // useCallback with an empty dep list: the body touches only refs, setState setters and
  // module-level helpers, so this identity is stable for the hook's lifetime and the effect
  // below can list it as a dependency without ever re-subscribing.
  const check = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      await probe()
    } finally {
      inFlightRef.current = false
    }

  // The probe pair itself. Only ever called through check(), which serializes it.
  async function probe() {
    // These probes are background polls: excluded from the "real traffic" liveness
    // signal (config._backgroundPoll) so they never look like activity and perpetuate
    // themselves — otherwise the off-hours activity path below would keep re-probing
    // and hold the host awake.
    // 1. Backend liveness
    let backendOnline = false
    try {
      await api.get('/api/health', { timeout: HEALTH_TIMEOUT_MS, _backgroundPoll: true })
      backendOnline = true
      setStatus('online')
    } catch {
      // False-negative guard: if REAL traffic was answered moments ago, the backend is
      // provably up — the probe just lost a race (timeout under load, transient blip).
      // Only report OFFLINE when there's no recent evidence of life.
      if (Date.now() - getLastBackendContactAt() < RECENT_TRAFFIC_MS) {
        setStatus('online')
        setLastChecked(new Date())
        return                    // skip the DB probe this beat; keep previous DB dot
      }
      setStatus('offline')
      setDbStatus('offline') // backend down → DB unreachable too
      dbFailsRef.current = 0
      setLastChecked(new Date())
      return
    }

    // 2. DB status (only if backend is online)
    if (backendOnline) {
      try {
        const res = await api.get<{ available: boolean; server_offline?: boolean }>('/api/db/status', {
          timeout: DB_PROBE_TIMEOUT_MS, _backgroundPoll: true,
        })
        // Mutes this tab's polling when the server is switched off, on a response that is
        // already being fetched — no extra request. This is now the ADMIN's discovery path:
        // a non-admin's /api/db/status is itself refused while the switch is on (503 +
        // X-Server-Offline), and the interceptor picks the switch up from that refusal
        // instead. See lib/awakeWindow (quiet mode) and the /api/db/status docstring.
        setServerQuiet(!!res.data.server_offline)
        if (res.data.available) {
          dbFailsRef.current = 0
          setDbStatus('online')
        } else {
          // Damping: a single unavailable reading right after boot (cold pool) is
          // normal; require two consecutive misses before showing OFFLINE.
          dbFailsRef.current += 1
          setDbStatus(prev => (dbFailsRef.current >= 2 ? 'offline' : (prev === 'online' ? 'online' : 'checking')))
        }
      } catch (err) {
        // Not yet authenticated (or not permitted) tells us nothing about the DB
        // itself — stay 'checking' and wait for the token, rather than reporting a
        // false OFFLINE that would then persist for a full poll interval.
        // A refusal by the shutdown switch is the same kind of non-answer: the server declined
        // to talk to this user, which says nothing about the database. Reporting DB OFFLINE
        // there would put a red fault dot on a deliberate, announced shutdown.
        if (isAuthError(err) || isServerOffline()) {
          setDbStatus(prev => (prev === 'online' ? 'online' : 'checking'))
        } else {
          dbFailsRef.current += 1
          setDbStatus(prev => (dbFailsRef.current >= 2 ? 'offline' : (prev === 'online' ? 'online' : 'checking')))
        }
      }
    }

    setLastChecked(new Date())
  }
  }, [])

  useEffect(() => {
    function stopPolling() {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    // One beat of the poll. Outside working hours it normally touches no network —
    // it just parks the UI on 'sleeping'. The exception: if real user traffic has
    // recently reached the backend, it's demonstrably awake, so we probe for the
    // true dots instead. Letting the timer keep running (rather than tearing it
    // down) is what makes polling resume by itself at 08:00 on Monday, with no
    // extra clock-watching machinery.
    function tick() {
      // Quiet mode (admin switched the server off) is checked FIRST and takes no network
      // path at all — not even the recent-activity probe below, which would otherwise fire
      // for RECENT_ACTIVITY_MS after the switch and hold the idle timer open. Parking the
      // dots on 'sleeping' is also the honest reading: that is exactly where the server is
      // headed once the last request ages out.
      if (isServerQuiet()) {
        setStatus('sleeping')
        setDbStatus('sleeping')
        return
      }
      if (!shouldPollNow()) {
        if (isRecentlyActive(getLastBackendContactAt())) check()
        else { setStatus('sleeping'); setDbStatus('sleeping') }
        return
      }
      check()
    }
    function startPolling() {
      if (timerRef.current) return
      tick()
      timerRef.current = setInterval(tick, POLL_INTERVAL_MS)
    }
    // Two gates, and both are load-bearing:
    //  • visible   — a backgrounded/forgotten tab that keeps hitting /api/health
    //    resets the host's sleep timer and keeps the backend awake 24/7 (memory
    //    billed continuously).
    //  • in-window — visibility alone does NOT cover a tab left in the
    //    FOREGROUND on a machine that never locks: that polls straight through
    //    the weekend. See lib/awakeWindow.ts.
    // Only idle polling is suppressed; real user actions still wake the backend
    // at any hour.
    function handleVisibility() {
      if (document.visibilityState === 'visible') startPolling()
      else stopPolling()
    }

    // Off-hours responsiveness: when real user traffic reaches the backend outside the
    // window, probe promptly (debounced) so the dots flip from 'sleeping' to the true
    // status right away instead of waiting up to a full interval. Inside the window the
    // interval already covers it; background probes don't fire this (they're excluded
    // from the contact signal), so it can't loop.
    let lastNudgeAt = 0
    const unsubContact = onBackendContact(() => {
      if (document.visibilityState !== 'visible') return
      if (isServerQuiet()) return          // the switch is off: no probe, at any hour
      if (shouldPollNow()) return
      const now = Date.now()
      if (now - lastNudgeAt < 30_000) return
      lastNudgeAt = now
      check()
    })

    // The DB probe needs a token; this hook mounts before there is one. Re-probe as
    // soon as one lands (and on every later refresh) so the DB dot resolves in seconds
    // instead of waiting out a 5-min beat it can't possibly have passed.
    const unsubToken = onTokenChange(token => {
      if (!token) return
      if (document.visibilityState !== 'visible') return
      if (isServerQuiet()) return
      check()
    })

    // Quiet mode flipping is worth an immediate beat in BOTH directions: entering it parks
    // the dots on 'sleeping' at once instead of leaving them stale for up to 5 minutes, and
    // leaving it (the admin switched the server back on in this tab) resumes the real probe
    // without waiting out the interval.
    const unsubQuiet = subscribeServerQuiet(() => {
      if (document.visibilityState !== 'visible') return
      tick()
    })

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      unsubContact()
      unsubToken()
      unsubQuiet()
      stopPolling()
    }
  }, [check])

  return { status, dbStatus, apiUrl, lastChecked }
}
