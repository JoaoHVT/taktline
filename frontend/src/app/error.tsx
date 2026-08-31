'use client'
import { useEffect, useState } from 'react'
import { NightScreen, NIGHT_BTN } from '@/components/NightScreen'
import { isStaleBuildError, reloadForStaleBuild, errorDetails } from '@/lib/staleBuild'

/**
 * Render-error boundary — the same night screen as the 404 and the cold start.
 *
 * Next's default error page is an unstyled stack trace in development and a bare "something went
 * wrong" line in production; both read as a different application. A user who hits this has no
 * action available except "try again" or "go home", so that is all the screen offers.
 *
 * ── LAST RESORT, NOT FIRST RESPONSE ──────────────────────────────────────────────────────────
 * This boundary sits at the route segment, so it replaces the ENTIRE application: `page.tsx` keeps
 * both LayoutShells permanently mounted and every dataset, override map, scenario and open modal
 * lives in React state inside them. Landing here therefore costs the user all of it, and `reset()`
 * re-renders from initial state rather than from where they were. That is far too heavy a response
 * to a render that threw once on a transient state.
 *
 * Four things now stand between a failure and this screen, in the order they are tried:
 *
 *  1. SUBTREE CONTAINMENT. Each app shell, the Home view and the Gantt modal are wrapped in
 *     `components/AppErrorBoundary`, which contains the crash and leaves everything else mounted.
 *     Only a failure ABOVE those, or in the shell itself, reaches this file at all.
 *
 *  2. STALE BUILD → RELOAD. A tab left open across a deploy asks for chunk filenames the server
 *     no longer has; the fetch 404s and throws mid-render. There is nothing to show and nothing to
 *     retry in place — the code that has to run is not in this document — so the page reloads
 *     itself once and comes back on the new build. See lib/staleBuild for the loop guard and for
 *     why this is the likeliest thing behind "normal actions started landing on the error page".
 *
 *  3. ONE SILENT RETRY. React commits the fallback on the first throw and never re-attempts, so a
 *     genuinely transient failure (data mid-flight, a token being refreshed) dead-ends on a render
 *     that would have succeeded a frame later. The first error therefore draws NOTHING and calls
 *     `reset()` — invisible when it works. The cooldown below lives at module scope because this
 *     component REMOUNTS for each error and component state cannot remember the attempt; a second
 *     failure inside the window skips the retry, so a deterministic error can never spin.
 *
 *  4. Only then, this screen.
 *
 * `error.digest` is the server-side correlation id. The message and the first stack frames are
 * behind "Detalhes técnicos" — see the note on `errorDetails` for why they are no longer hidden.
 */

/** Delay before the silent retry — one frame is enough for a pending state to land. */
const RETRY_DELAY_MS = 120
/** Two failures inside this window are not a transient state; stop retrying and show the screen. */
const RETRY_COOLDOWN_MS = 15_000

let lastAutoRetry = 0

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // Classification is decided ONCE, on mount, in priority order — the ACT it implies happens in
  // an effect, never in a render initializer: `reloadForStaleBuild` navigates, and React may run
  // an initializer more than once. A remount caused by a retry failing sees the module/session
  // stamps and falls through to the screen.
  const [stale] = useState(() => isStaleBuildError(error))
  const [reloading, setReloading] = useState(stale)
  const [retrying] = useState(() => !stale && Date.now() - lastAutoRetry > RETRY_COOLDOWN_MS)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => { console.error('[OptVision] render error:', error) }, [error])

  useEffect(() => {
    // Declined (a reload was already tried and did not help) → this is not a stale build after
    // all, so stop hiding and show the screen.
    if (stale && !reloadForStaleBuild()) setReloading(false)
  }, [stale])

  useEffect(() => {
    if (!retrying) return
    lastAutoRetry = Date.now()
    const t = setTimeout(reset, RETRY_DELAY_MS)
    return () => clearTimeout(t)
  }, [retrying, reset])

  // Reload in flight, or a retry in flight — paint nothing, so neither ever flashes a dead end.
  if (reloading || retrying) return null

  return (
    <NightScreen title="Algo deu errado" role="alert">
      <div style={{ fontSize: 12.5, color: '#9AA6BF', lineHeight: 1.65 }}>
        A página não pôde ser carregada.<br />
        Tente novamente — se persistir, atualize a página em instantes.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={reset} style={NIGHT_BTN}>Tentar novamente</button>
        <button onClick={() => { window.location.reload() }} style={NIGHT_BTN}>Atualizar a página</button>
        <button onClick={() => { window.location.href = '/' }} style={NIGHT_BTN}>Voltar ao início</button>
      </div>
      {/* Collapsed by default: the person who just wants back into the app should not have to
          read a stack trace, and the person reporting the failure needs exactly this text. */}
      <button
        onClick={() => setShowDetails(v => !v)}
        style={{ ...NIGHT_BTN, fontSize: 10.5, padding: '3px 8px', opacity: 0.75 }}
      >
        {showDetails ? 'Ocultar detalhes técnicos' : 'Detalhes técnicos'}
      </button>
      {showDetails && (
        <pre style={{
          margin: 0, maxWidth: 'min(680px, 88vw)', maxHeight: 180, overflow: 'auto',
          textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontSize: 10.5, lineHeight: 1.5, color: '#8C99B4', fontFamily: 'monospace',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 6, padding: '8px 10px',
        }}>
          {errorDetails(error, error.digest)}
        </pre>
      )}
    </NightScreen>
  )
}
