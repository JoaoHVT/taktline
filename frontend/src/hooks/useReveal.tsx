'use client'
// ── Reveal: the fade role-gated chrome appears with ────────────────────────────────────
// The role resolves a beat AFTER the session does (PermissionsContext fetches /api/permissions/me,
// and only the optimistic localStorage cache answers instantly). So the header paints a grey
// "reader" avatar, then the Database button, the alerts bell and the online badge all pop into
// existence at whatever moment the answer lands. Popping reads as a glitch; a short fade reads as
// the UI finishing loading.
//
// Deliberately a transition and NOT a `@keyframes` animation: Windows' "show animations" setting is
// off on at least one dev machine here, so Chrome reports `prefers-reduced-motion: reduce` and every
// keyframed animation looks dead locally while transitions keep running (see the launch band).
//
// One rAF between mount and the flip is what makes it a transition at all — set the final opacity in
// the same paint as the mount and the browser has no start value to interpolate from.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

const MS = 260

/** Opacity style that fades in one frame after `active` turns true. Call it unconditionally —
 *  it must sit above any early `return null`, hooks rules being what they are. */
export function useReveal(active = true, ms = MS): CSSProperties {
  const [on, setOn] = useState(false)
  useEffect(() => {
    // Both directions go through the frame, never a synchronous setState in the effect body —
    // that is the cascading-render lint rule, and the rAF is required for the rise anyway.
    const id = requestAnimationFrame(() => setOn(active))
    return () => cancelAnimationFrame(id)
  }, [active])
  // `transform` rides along because every element this wraps already carries Tailwind's
  // `transition-transform hover:scale-*`, and an inline `transition` shorthand would otherwise
  // replace that class outright and kill the hover lift. 150ms is Tailwind's own default.
  return { opacity: on ? 1 : 0, transition: `opacity ${ms}ms ease, transform 150ms ease` }
}

/** Wrapper for the cases where the faded element can't take a style prop of its own.
 *  `className` is on the WRAPPER, so an absolutely-positioned child hands its positioning
 *  classes up here rather than nesting a second box inside the layout. */
export function Reveal({ children, className = '', active = true, ms = MS }: {
  children:   ReactNode
  className?: string
  active?:    boolean
  ms?:        number
}) {
  const style = useReveal(active, ms)
  return <span className={className} style={style}>{children}</span>
}
