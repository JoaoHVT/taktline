'use client'
/**
 * Stale-build detection — the deploy that breaks the tab you already have open.
 *
 * THE FAILURE. Every build hashes its JavaScript chunks into new filenames. A tab that was
 * loaded before a deploy is still running the OLD document, so the moment it asks for a chunk
 * it has not fetched yet — a `next/dynamic` component, a lazy `import()`, a route chunk — it
 * asks for a filename the server no longer has. The request 404s and the browser throws
 * `ChunkLoadError` / "Failed to fetch dynamically imported module", right in the middle of a
 * render. That is a render-phase throw, so it lands in an error boundary and takes the app down.
 *
 * WHY IT LOOKS LIKE THE ERROR PAGE IS BROKEN. It hits everybody the same way, regardless of
 * role, on whatever action happens to need the missing chunk first — so it reads as "many normal
 * actions suddenly land on the error page". It is transient in the only sense that matters to the
 * person seeing it: reloading fixes it permanently, which is exactly the reported "it would have
 * worked". And it starts the moment a deploy goes out, which is why it arrived with the release
 * that also introduced the custom error screens: the screens made it VISIBLE (before them the
 * same crash produced Next's bare production error page), they did not cause it.
 *
 * THE RESPONSE. A night screen is the wrong answer to "your tab is running last week's code".
 * There is nothing for the user to decide and nothing to retry in-place — the code that has to
 * run is not in this document. Reloading fetches the new HTML, the new chunk names, and the app
 * comes back working, so that is what happens automatically.
 *
 * WHAT PROTECTS AGAINST A LOOP. If a reload does not fix it, the error was never a stale build
 * (a genuinely missing asset, an offline network, a broken deploy) and reloading again would
 * spin the browser forever. The attempt is stamped in `sessionStorage`; a second stale-build
 * error inside the window below declines to reload and lets the error screen render instead.
 * sessionStorage and not a module variable, precisely because the reload wipes module state.
 */

const RELOAD_STAMP_KEY = 'taktline.staleBuildReloadAt'
/** A reload that fixed the problem is followed by no second error at all, so anything inside
 *  this window is evidence the reload did NOT help. Generous enough to cover a slow cold start
 *  behind the new document. */
const RELOAD_COOLDOWN_MS = 60_000

/**
 * Does this error mean "the file this build asked for is not on the server any more"?
 *
 * Matched on the shapes browsers and bundlers actually produce — webpack/Turbopack's
 * `ChunkLoadError`, and the native ESM messages, which differ per engine (Chrome, Firefox and
 * Safari each word it differently). Deliberately narrow: everything here names a FAILED MODULE
 * FETCH and nothing else, because the consequence of a match is a page reload.
 */
export function isStaleBuildError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined
  const name = typeof e?.name === 'string' ? e.name : ''
  const msg = typeof e?.message === 'string' ? e.message : ''
  return (
    name === 'ChunkLoadError' ||
    /loading chunk \S+ failed/i.test(msg) ||
    /loading css chunk \S+ failed/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg)
  )
}

/**
 * Reload once for a stale build. Returns true when a reload is under way — the caller should
 * then render NOTHING rather than an error screen the user would see flash and vanish.
 *
 * Returns false when a reload has already been tried recently (see the loop note above) or when
 * `sessionStorage` is unavailable, in which case the caller falls back to its normal error UI.
 */
export function reloadForStaleBuild(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()))
  } catch {
    // Private mode / storage disabled: without the stamp there is no loop protection, so do
    // not reload at all. A visible error screen beats a browser stuck in a refresh cycle.
    return false
  }
  window.location.reload()
  return true
}

/**
 * Human-readable identity of a caught error, for the "Detalhes técnicos" panel.
 *
 * The message used to be withheld here on the grounds that it can carry a backend detail
 * string. That reasoning does not survive contact with the problem it created: the backend
 * already scrubs its own details before they leave it (see the error scrubbing in main.py), the
 * app is behind authentication and reachable only by a signed-in account, and with nothing but an opaque
 * `digest` on screen a crash reported by a user is not diagnosable at all — which is precisely
 * how a reproducible failure went a full day without a name. The stack is trimmed to its first
 * frames: that is where the throwing component is, and the rest is bundler noise.
 */
export function errorDetails(err: unknown, digest?: string): string {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error'
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  const stack = typeof e?.stack === 'string' ? e.stack : ''
  const frames = stack
    .split('\n')
    .filter(l => /\s+at\s/.test(l))
    .slice(0, 4)
    .map(l => l.trim())
  return [
    `${name}: ${msg}`,
    ...(digest ? [`digest: ${digest}`] : []),
    ...frames,
  ].join('\n')
}
