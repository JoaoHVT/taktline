'use client'
import type { ReactNode } from 'react'

/**
 * NightScreen — the full-page "nothing to show you right now" surface.
 *
 * It started life inside WakingServerOverlay as the cold-start screen and is now the shared
 * treatment for every dead end the app can reach: the backend is asleep, the backend was switched
 * off by an admin, the URL matches no route (404), or a render threw. Those are four different
 * causes with the SAME meaning for the person looking at it — "the app is here, this particular
 * thing is not" — so they get one screen with different copy instead of one designed screen plus
 * three framework defaults that look like a different product.
 *
 * Deliberately assetless: plain divs, no image, no SVG, no font beyond the page's own. It has to
 * paint instantly on a page whose backend is not answering, and `not-found`/`error` boundaries can
 * fire before anything else has loaded.
 *
 * NO prefers-reduced-motion block — see the long note in gantt/LocomotiveProgress.tsx. On Windows
 * that flag mirrors "Animation effects" (Settings → Accessibility → Visual effects), a display
 * preference many machines have off without asking for a still screen, and gating on it killed
 * every animation here. On this screen motion IS the message: a still sleeping locomotive with
 * three frozen Zs and a dead headlight reads as a hung app, which is exactly what the screen
 * exists to deny.
 */
export const NIGHT_CSS = `
@keyframes optvWakeFade  { from { opacity: 1 } to { opacity: 0 } }
@keyframes optvWakeIn    { from { opacity: 0 } to { opacity: 1 } }
/* The consist breathes — asleep, not stopped. */
@keyframes optvSnore     { 0%,100% { transform: translateY(0) }   50% { transform: translateY(2px) } }
/* Each Z drifts up and dissolves; the three are offset so they read as a sequence. */
@keyframes optvZzz       { 0%   { opacity: 0; transform: translate(0,4px)   scale(.7) }
                           25%  { opacity: 1 }
                           100% { opacity: 0; transform: translate(14px,-22px) scale(1.15) } }
/* Headlight sweeping the rail ahead: the only thing that says "work is happening".
   The travel runs from fully OFF the left edge to fully off the right (the element is 35% of
   the rail, so -120%/320% of its own width clears both), and it fades out before the turn.
   The old -40%→240% left it still partly visible at both ends, so every loop ended with the
   light snapping back across the rail. */
@keyframes optvRailSweep { 0%   { transform: translateX(-120%); opacity: 0 }
                           15%  { opacity: 1 }
                           85%  { opacity: 1 }
                           100% { transform: translateX(320%);  opacity: 0 } }
.optv-wake        { animation: optvWakeIn .35s ease-out both }
.optv-wake-exit   { animation: optvWakeFade .45s ease-in forwards }
.optv-wake-loco   { animation: optvSnore 2.6s ease-in-out infinite }
.optv-wake-z      { animation: optvZzz 2.6s ease-out infinite }
/* Linear: an eased sweep decelerates into the edge, which reads as a stall right where the
   loop restarts — the constant speed plus the fade is what makes the wrap invisible. */
.optv-wake-sweep  { animation: optvRailSweep 2.2s linear infinite }
`

/** Night sky: the same brand red lives on, banked down to an ember on the horizon. */
export const NIGHT_BG =
  'radial-gradient(120% 90% at 50% 115%, #3B1418 0%, #14161F 55%, #0B0D14 100%)'

/** The ghost-button treatment shared by every action on this screen. */
export const NIGHT_BTN: React.CSSProperties = {
  fontSize: 12, color: '#C7D2E8', padding: '6px 12px', borderRadius: 6,
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
  cursor: 'pointer',
}

/**
 * The sleeping consist — one locomotive + one wagon on a rail, with Zzz drifting off the cab.
 * Requires NIGHT_CSS to be on the page.
 */
export function SleepingConsist() {
  return (
    <div style={{ position: 'relative', width: 168, height: 74 }}>
      {/* Zzz — three offset copies of one keyframe. */}
      {[0, 0.85, 1.7].map((delay, i) => (
        <span
          key={i}
          className="optv-wake-z"
          style={{
            position: 'absolute', left: 104, top: 16,
            fontSize: 11 + i * 2, fontWeight: 800, color: '#93A4C8',
            animationDelay: `${delay}s`, pointerEvents: 'none',
          }}
        >z</span>
      ))}

      <div className="optv-wake-loco" style={{ position: 'absolute', left: 8, bottom: 14, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
        {/* Wagon, trailing. */}
        <div style={{ width: 44, height: 20, borderRadius: 3, background: '#4B5563' }} />
        {/* Locomotive: hood + cab, brand red. */}
        <div style={{ position: 'relative', width: 62, height: 30 }}>
          <div style={{ position: 'absolute', left: 0,  bottom: 0, width: 62, height: 20, borderRadius: 3, background: '#0D9488' }} />
          <div style={{ position: 'absolute', right: 4, bottom: 18, width: 26, height: 12, borderRadius: '3px 3px 0 0', background: '#0F766E' }} />
          {/* Headlight, dimmed — it comes up with the server, not before. */}
          <div style={{ position: 'absolute', left: 2, bottom: 8, width: 5, height: 5, borderRadius: '50%', background: '#FDE68A', opacity: 0.45 }} />
        </div>
      </div>

      {/* Rail + the light sweeping along it. */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 10, height: 2, background: '#2A3040', borderRadius: 2, overflow: 'hidden' }}>
        <div className="optv-wake-sweep" style={{ width: '35%', height: '100%', background: 'linear-gradient(90deg, transparent, #0D9488, transparent)' }} />
      </div>
    </div>
  )
}

interface NightScreenProps {
  /** Headline — the one line that says which dead end this is. */
  title:      string
  /** Body copy and any actions. */
  children?:  ReactNode
  /** Absolutely-positioned extras (the admin's Moon button, on the waking overlay). */
  corner?:    ReactNode
  /** Exit animation, for the overlay that dismisses itself once the backend answers. */
  leaving?:   boolean
  role?:      'status' | 'alert'
}

export function NightScreen({ title, children, corner, leaving = false, role = 'status' }: NightScreenProps) {
  return (
    <div
      className={leaving ? 'optv-wake-exit' : 'optv-wake'}
      role={role}
      aria-live="polite"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: NIGHT_BG,
      }}
    >
      <style>{NIGHT_CSS}</style>
      {corner}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: 24, maxWidth: 420, textAlign: 'center' }}>
        <SleepingConsist />
        <div style={{ fontSize: 16, fontWeight: 700, color: '#F3F4F6', letterSpacing: 0.2 }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  )
}
