/**
 * Sub-options for GLOBAL propagation ("Propagar Global" → the arrow next to the button).
 *
 * Three independent modifiers on the cross-loco cascade, combinable in any mix:
 *
 *  • `advance`  — "Propagar Adiantamento". Base Global only reacts to a DELAY (a workstation
 *                 pushed later, overlapping the same workstation on the next loco, which then
 *                 gets pushed clear). With this on, the reverse also propagates: a workstation
 *                 moved EARLIER pulls the following locos' same workstation up behind it, each
 *                 landing on the next valid day after its predecessor. Without it, a loco is
 *                 only ever pulled back toward a reference it is currently late against, and an
 *                 on-time loco never moves.
 *
 *  • `singleWs` — "Propagar WS Única". Restricts the cascade to the edited workstation ALONE on
 *                 each downstream loco. By default every cascaded move also carries Local
 *                 propagation, so the stations after it inside that loco follow; with this on the
 *                 workstation moves by itself and nothing else in the loco is touched.
 *
 *  • `duration` — "Propagar Duração". A duration change on the edited workstation (WS71 4 days →
 *                 3) is applied to that same workstation on every other loco that runs it. Implies
 *                 `singleWs`: a duration is a property of that one workstation, so propagating it
 *                 is scoped to the workstation by definition. The setter enforces that — turning
 *                 `duration` on turns `singleWs` on, and turning `singleWs` off turns `duration` off,
 *                 so an inconsistent pair is not representable.
 *
 * Session-only, exactly like the conflict-WS override in `ganttUtils`: in memory, never persisted,
 * back to all-off on reload. The store shape (stable snapshot + listener set) is what
 * `useSyncExternalStore` needs to avoid an infinite render loop.
 */
export type GlobalPropOptions = {
  advance: boolean
  singleWs: boolean
  duration: boolean
}

const ALL_OFF: GlobalPropOptions = Object.freeze({ advance: false, singleWs: false, duration: false })

let _snapshot: GlobalPropOptions = ALL_OFF
const _listeners = new Set<() => void>()

/** Current options. Stable identity — only changes when a value actually changes. */
export function getGlobalPropOptions(): GlobalPropOptions { return _snapshot }

/** True when any sub-option is active (drives the "modified" affordance on the arrow button). */
export function isGlobalPropOptionsActive(): boolean {
  return _snapshot.advance || _snapshot.singleWs || _snapshot.duration
}

/**
 * Merge a partial change. Applies the duration⇒singleWs dependency in BOTH directions so the
 * caller never has to think about it, and no-ops when nothing actually changed (keeps the
 * snapshot identity stable for memo dependencies).
 */
export function setGlobalPropOptions(patch: Partial<GlobalPropOptions>): void {
  const next: GlobalPropOptions = { ..._snapshot, ...patch }
  if (patch.duration === true) next.singleWs = true
  if (patch.singleWs === false) next.duration = false
  if (next.advance === _snapshot.advance && next.singleWs === _snapshot.singleWs && next.duration === _snapshot.duration) return
  _snapshot = next
  _listeners.forEach(l => l())
}

/** Back to all-off (the plain Global behavior). */
export function resetGlobalPropOptions(): void {
  if (_snapshot === ALL_OFF) return
  _snapshot = ALL_OFF
  _listeners.forEach(l => l())
}

/** Subscribe to changes (for useSyncExternalStore). */
export function subscribeGlobalPropOptions(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}
