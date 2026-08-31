// ── Home view preference ──────────────────────────────────────────────────────
// Which Home rendering the user last chose: the classic split view (default) or the
// experimental premium showcase. Same shape as lib/ganttPrefs.ts, plus a subscription so
// `useSyncExternalStore` can read it — that is what keeps the value out of an effect and
// still gives the server a stable `false` to prerender.

const SHOWCASE_KEY = 'optvision.home.showcase'

const listeners = new Set<() => void>()

export function getHomeShowcase(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SHOWCASE_KEY) === '1'
  } catch {
    return false
  }
}

export function setHomeShowcase(on: boolean): void {
  try {
    window.localStorage.setItem(SHOWCASE_KEY, on ? '1' : '0')
  } catch { /* private mode — the choice just won't survive the reload */ }
  listeners.forEach(l => l())
}

export function subscribeHomeShowcase(cb: () => void): () => void {
  listeners.add(cb)
  // `storage` only fires in OTHER tabs, so the local set above notifies the listeners directly.
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

// Server snapshot — always the classic view, so the prerender never depends on localStorage.
export const homeShowcaseServerSnapshot = (): boolean => false
