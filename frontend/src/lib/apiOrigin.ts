/**
 *  Where the API lives — resolved AT RUNTIME rather than baked into the bundle.
 *
 *  The demo ships as ONE origin: the Next server serves the pages and forwards /api to the
 *  backend on loopback (see next.config.ts `rewrites`). So every HTTP call goes out RELATIVE
 *  and reaches the backend whatever address the browser used to get here — a container port, a
 *  tunnel, a reverse proxy in front — with nothing recompiled.
 *
 *  The absolute base below is the fallback for the split deployment: `next dev` on :3000 and
 *  uvicorn on :8000 as two separate servers, which is what a contributor runs locally.
 *
 *  The WebSocket is the one thing that cannot be relative. It needs a scheme and an authority,
 *  and a Next rewrite does NOT forward a protocol upgrade — so a socket derived from the page's
 *  own origin would point at the Next server, which serves no /ws, and the optimizer's progress
 *  stream would never connect. It therefore uses the configured absolute URL unless the page is
 *  demonstrably behind something that proxies the upgrade too.
 */

/** Set at build time when the app is served single-origin (the container does this). */
const SAME_ORIGIN = process.env.NEXT_PUBLIC_SAME_ORIGIN === '1'

/** The absolute base. Still the truth for a split dev deployment, and what useBackendHealth
 *  reads to decide whether the backend is local. Do not build requests from it — use API_BASE. */
export const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
export const CONFIGURED_WS_URL  = process.env.NEXT_PUBLIC_WS_URL  || 'ws://localhost:8000'

/** '' when single-origin: axios and fetch then resolve every path against the current origin. */
export const API_BASE =
  SAME_ORIGIN && typeof window !== 'undefined' ? '' : CONFIGURED_API_URL

/** Origins that terminate TLS in front of the app AND proxy the WebSocket upgrade. Comma
 *  separated; empty in the default container, where the port test below is enough. */
const GATEWAY_ORIGINS = (process.env.NEXT_PUBLIC_ORIGINS || '')
  .split(',')
  .map(o => o.trim().replace(/\/$/, ''))
  .filter(Boolean)

/** Did this tab arrive through such a gateway?
 *
 *  An empty port keeps the intent open-ended: a new name pointed at this host arrives on the
 *  scheme's default port and is treated as single-origin without a rebuild. What falls through
 *  is a tab carrying an explicit port that is not listed — in practice the frontend's own dev
 *  port, which is exactly the case that must use the absolute URL. */
function behindGateway(): boolean {
  if (typeof window === 'undefined') return false
  if (GATEWAY_ORIGINS.includes(window.location.origin)) return true
  return window.location.port === ''
}

/** Derived from the PAGE's protocol, never a fixed scheme: ws:// on an https page is blocked
 *  as mixed content. */
export const WS_BASE =
  SAME_ORIGIN && typeof window !== 'undefined' && behindGateway()
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : CONFIGURED_WS_URL
