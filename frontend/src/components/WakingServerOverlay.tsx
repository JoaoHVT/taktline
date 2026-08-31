'use client'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Moon } from 'lucide-react'
import { api, serverControlStatus } from '@/lib/api'
import { subscribeUnlock, isServerOffline, serverOfflineMessage } from '@/lib/unlockStore'
import { isWithinAwakeWindow, isLocalApi } from '@/lib/awakeWindow'
import { usePermissions } from '@/context/PermissionsContext'
import { NightScreen, NIGHT_BTN } from '@/components/NightScreen'

/**
 * "Acordando o servidor…" — the cold-start screen.
 *
 * Railway sleeps the backend outside working hours (see lib/awakeWindow), and the first request
 * after that has to wait out a container boot. Until now the app just sat there with inert
 * spinners, which reads as broken rather than as waiting. This shows a night-themed panel for
 * exactly that wait and gets out of the way the moment the backend answers.
 *
 * SELF-CONTAINED BY DESIGN. It owns its own single probe rather than extending useBackendHealth:
 * that hook's status dots are consumed in several places and its polling is carefully gated to let
 * Railway sleep. Nothing here touches it.
 *
 * THE PROBE. One `/api/health` on mount. It is marked `_backgroundPoll` so it never counts as
 * "real traffic" in the activity signal (api.ts) and so cannot perpetuate the health hook's
 * off-hours polling. It does reset Railway's idle timer — deliberately: the user has just opened
 * the app, so their own requests are about to do that anyway, and probing first means the wake
 * starts a moment EARLIER rather than later.
 *
 * WHEN IT SHOWS. Only if that probe is still outstanding past a threshold, so a healthy backend
 * (which answers in well under a second) never flashes it. The threshold is shorter outside the
 * awake window, where a slow answer almost certainly IS a cold start, and longer inside it, where
 * the backend is supposed to be up and a slow answer is more likely just load.
 */
const SLOW_MS_ASLEEP = 3_000     // outside working hours → a slow answer means a cold start
const SLOW_MS_AWAKE  = 8_000     // inside them → give a merely-busy backend room before crying wolf
const PROBE_TIMEOUT_MS = 120_000 // a Railway cold start can run well past any normal request timeout

// The night background, the sleeping consist and the keyframes behind them moved to
// components/NightScreen.tsx, which is now shared with the 404 and error boundaries — a URL that
// resolves to nothing and a render that threw are the same message as a backend that is not
// answering, so they get the same screen instead of three framework defaults.

export function WakingServerOverlay() {
  const [phase, setPhase] = useState<'idle' | 'waking' | 'leaving'>('idle')

  // ── Deliberate shutdown ────────────────────────────────────────────────────────────
  // When an admin has switched the app off, this panel stops being a transient "please
  // wait" and becomes the standing notice: their message replaces the waking copy and the
  // overlay does not leave on its own.
  //
  // TWO WAYS IN, because the switch can be flipped at either moment:
  //   • this component asks on mount (checkOffline), for a user arriving with it already on;
  //   • the axios interceptor flips unlockStore's serverOffline on the first 503 +
  //     X-Server-Offline, for a session that was already open when an admin flipped it. The
  //     server is what denies the request; this only decides what the user is shown instead.
  //
  // NO POLLING, on purpose. Recovery is a manual retry (or a reload) — user-initiated. There
  // is nothing to poll for: while the switch is on the server refuses every route anyway, so a
  // timer here would only produce failures the user cannot act on.
  const [offlineMsg, setOfflineMsg] = useState<string | null>(null)
  /** Optional picture/GIF the admin attached to the message, loaded straight from their link.
   *  Dropped on a load failure (`imgBroken`) rather than left as a broken-image glyph: the notice
   *  still has to read as a deliberate message, not as a second thing that is also broken. */
  const [offlineImg, setOfflineImg] = useState('')
  const [imgBroken, setImgBroken] = useState(false)
  // Server-confirmed adminness, independent of PermissionsContext — see `canOperate` below.
  const [serverAdmin, setServerAdmin] = useState(false)
  const { role } = usePermissions()

  const checkOffline = useCallback(() => {
    // Authenticated call: it 401s before sign-in completes, which is fine — the normal
    // waking panel covers that window and the check re-runs on the next load.
    serverControlStatus()
      .then(s => {
        setOfflineMsg(s.offline ? (s.message || 'Servidor indisponível no momento.') : null)
        setOfflineImg(s.offline ? (s.imageUrl || '') : '')
        setImgBroken(false)
        // `lockdownNewUsers` is omitted for every non-admin (see the endpoint), so its mere
        // presence IS the server saying "you are an admin" — at no extra request.
        setServerAdmin(s.lockdownNewUsers !== undefined)
      })
      .catch(() => { /* not signed in yet, or backend unreachable: stay silent */ })
  }, [])

  useEffect(() => {
    // A local backend cannot sleep, so the WAKING panel would only ever be wrong there —
    // but it can still be marked offline, so the switch check runs either way.
    if (isLocalApi()) { checkOffline(); return }
    let done = false
    const slowAfter = isWithinAwakeWindow() ? SLOW_MS_AWAKE : SLOW_MS_ASLEEP
    const slowTimer = setTimeout(() => { if (!done) setPhase('waking') }, slowAfter)

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(slowTimer)
      // Only animate out if we actually showed something; otherwise stay silent.
      setPhase(p => (p === 'waking' ? 'leaving' : 'idle'))
      // The backend answered (or failed) — now ask whether it is deliberately off. Running
      // it here rather than in parallel keeps the cold-start path to a single request.
      checkOffline()
    }
    // Resolve on failure too: an unreachable backend is the status dot's job to report, and a
    // "waking" panel that never leaves would be worse than no panel at all.
    api.get('/api/health', { timeout: PROBE_TIMEOUT_MS, _backgroundPoll: true })
      .then(finish).catch(finish)

    return () => { done = true; clearTimeout(slowTimer) }
  }, [checkOffline])

  // Unmount once the exit animation has played — never while the app is deliberately off,
  // where the panel is the standing notice rather than a transient wait.
  useEffect(() => {
    if (phase !== 'leaving' || offlineMsg !== null || isServerOffline()) return
    const t = setTimeout(() => setPhase('idle'), 500)
    return () => clearTimeout(t)
  }, [phase, offlineMsg])

  // The interceptor's view of the same switch, for a session that was already open when it was
  // flipped (see the note above). Its message is the 503 body — the admin's own text.
  const pushedOffline = useSyncExternalStore(subscribeUnlock, isServerOffline, () => false)
  const pushedMsg     = useSyncExternalStore(subscribeUnlock, serverOfflineMessage, () => '')

  // Once the interceptor reports it, ask the status route for the full notice: it is exempt from
  // the shutdown gate, so it still answers, and it is the only source of the optional image.
  useEffect(() => { if (pushedOffline && offlineMsg === null) checkOffline() }, [pushedOffline, offlineMsg, checkOffline])

  const offline = offlineMsg !== null || pushedOffline
  const shownMsg = offlineMsg ?? (pushedMsg || 'Servidor indisponível no momento.')

  // WHO GETS THE WAY BACK IN. This overlay is the only surface an admin has once the app is
  // switched off, so the gate on the button must not be able to fail closed. `role` comes from
  // PermissionsContext, which falls back to a localStorage cache and stays 'reader' whenever
  // /api/permissions/me fails or was never run on this machine — an admin on a fresh browser
  // would then see no button at all and could only recover through the database directly.
  // So either signal opens it, and the server enforces the actual write regardless
  // (POST /api/server-control is admin + ADMIN_PASSWORD).
  const canOperate = role === 'admin' || serverAdmin

  if (phase === 'idle' && !offline) return null

  return (
    <NightScreen
      title={offline ? 'Servidor indisponível' : 'Acordando o servidor…'}
      leaving={phase === 'leaving' && !offline}
      corner={
        <>

        </>
      }
    >
      {offline ? (
        <>
          {/* Admin-authored text, rendered as TEXT — never as HTML. */}
          <div style={{ fontSize: 12.5, color: '#9AA6BF', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
            {shownMsg}
          </div>

          {/* The optional picture/GIF, below the message. Loaded from the admin's link by the
              viewer's browser — the app neither stores nor proxies it (CSP img-src carries an
              `https:` allowance for exactly this). `no-referrer` keeps the third-party host from
              learning which page the request came from. Capped in both axes so a large or very
              tall image cannot push the "Tentar novamente" button off a small screen. */}
          {offlineImg !== '' && !imgBroken && (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote host by design
            <img
              src={offlineImg}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setImgBroken(true)}
              style={{
                maxWidth: '100%', maxHeight: '32vh', objectFit: 'contain',
                borderRadius: 8, border: '1px solid rgba(255,255,255,0.10)',
              }}
            />
          )}
          <button onClick={() => window.location.reload()} style={NIGHT_BTN}>
            Tentar novamente
          </button>
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: '#9AA6BF', lineHeight: 1.65 }}>
          Isto pode levar um minuto.<br />
          Se demorar muito, atualize a página em instantes.
        </div>
      )}
    </NightScreen>
  )
}
