/**
 * Own-loop smooth scrolling for the Schedule iframe.
 *
 * WHY THIS EXISTS — `scrollTo({ behavior: 'smooth' })` is NOT reliable animation.
 * Chromium (Chrome AND Edge) silently degrades a programmatic smooth scroll to an instant
 * jump in at least two states the user never connects to this app:
 *
 *   1. `prefers-reduced-motion: reduce`. On Windows that flag mirrors Settings →
 *      Accessibility → Visual effects → "Animation effects", which people turn off for
 *      perceived speed, not for a vestibular condition. It is OFF on at least one machine
 *      here — see the long note in `gantt/LocomotiveProgress.tsx`, which cost a full
 *      debugging session for the same root cause on the launch band.
 *   2. `edge://flags/#smooth-scrolling` (`chrome://flags/#smooth-scrolling`) set to
 *      Disabled, or the browser launched with `--disable-smooth-scrolling`.
 *
 * In both, every navigation in the Schedule (LOCO / workstation / day header / "Ir para
 * hoje") teleports instead of gliding, which reads as a broken app rather than a setting:
 * the timeline is 200+ columns wide, so an instant jump gives no sense of WHERE the view
 * travelled, which was the whole point of animating it.
 *
 * Driving the scroll from rAF ourselves makes the behaviour identical for every user and
 * every browser setting. Deliberately NOT gated on `prefers-reduced-motion`, for the reason
 * above and consistent with the rest of this codebase: one short, single-direction,
 * user-initiated displacement, cancelled the moment the user touches the surface.
 */

type Pos = { left?: number; top?: number }

const running = new WeakMap<Window, () => void>()

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
// Ease-in-out cubic — starts and lands soft, which is what the native animation approximates.
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Cancel whatever animation is running in `win` (a new nav, or the user grabbing the surface). */
export function cancelScrollAnimation(win: Window): void {
  running.get(win)?.()
}

/**
 * Animate `win`'s scroll position to an ABSOLUTE target, in the same rendered (zoomed) px
 * space `_rectScrollTarget` / `scrollTo` already use. Omitted axes keep their current value.
 */
export function animateScrollTo(win: Window, to: Pos): void {
  const doc = win.document
  const el = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
  if (!el) return

  cancelScrollAnimation(win)

  const maxLeft = Math.max(0, el.scrollWidth  - el.clientWidth)
  const maxTop  = Math.max(0, el.scrollHeight - el.clientHeight)
  const fromLeft = el.scrollLeft
  const fromTop  = el.scrollTop
  const toLeft = to.left != null ? clamp(to.left, 0, maxLeft) : fromLeft
  const toTop  = to.top  != null ? clamp(to.top,  0, maxTop)  : fromTop
  const dx = toLeft - fromLeft
  const dy = toTop  - fromTop

  // Sub-pixel move: nothing to animate, and a 1px "glide" only adds latency.
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
    el.scrollLeft = toLeft
    el.scrollTop  = toTop
    return
  }

  // Distance-scaled duration so a neighbouring column is quick and a jump across the year
  // still reads as travel rather than a cut.
  const dist = Math.max(Math.abs(dx), Math.abs(dy))
  const duration = clamp(200 + dist * 0.22, 240, 620)

  let raf = 0
  let done = false
  const stop = () => {
    if (done) return
    done = true
    if (raf) win.cancelAnimationFrame(raf)
    win.removeEventListener('wheel', stop)
    win.removeEventListener('touchstart', stop)
    win.removeEventListener('mousedown', stop)
    win.removeEventListener('keydown', stop)
    if (running.get(win) === stop) running.delete(win)
  }
  running.set(win, stop)

  // Any user input wins immediately — the grab-pan handler writes scrollLeft straight from
  // mousemove deltas, so an animation still ticking would fight it frame for frame.
  win.addEventListener('wheel', stop, { passive: true })
  win.addEventListener('touchstart', stop, { passive: true })
  win.addEventListener('mousedown', stop, { passive: true })
  win.addEventListener('keydown', stop, { passive: true })

  const t0 = win.performance.now()
  const step = (now: number) => {
    // The iframe document is rewritten on every full rebuild; a stale animation must not
    // keep writing into a detached element.
    if (done || win.document !== doc || !el.isConnected) { stop(); return }
    const p = clamp((now - t0) / duration, 0, 1)
    const k = ease(p)
    el.scrollLeft = fromLeft + dx * k
    el.scrollTop  = fromTop  + dy * k
    if (p >= 1) { stop(); return }
    raf = win.requestAnimationFrame(step)
  }
  raf = win.requestAnimationFrame(step)
}

/** Animate a RELATIVE displacement (the `scrollBy` shape). */
export function animateScrollBy(win: Window, by: Pos): void {
  const doc = win.document
  const el = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
  if (!el) return
  animateScrollTo(win, {
    left: by.left != null ? el.scrollLeft + by.left : undefined,
    top:  by.top  != null ? el.scrollTop  + by.top  : undefined,
  })
}
