/**
 * "Lembrar categoria e observação" — session memory for the Move-Mode prompt's two reason fields.
 *
 * The prompt already pre-fills from the moved BOX's own note trail, which only helps when you edit
 * the same box again. Planners routinely apply the same classification/observation across MANY
 * different boxes in one session, and re-picking both every time is the whole friction this removes:
 * with the toggle on, every new prompt opens with the last values the planner actually confirmed,
 * whatever box it is for.
 *
 * Precedence when the toggle is ON: remembered value > the box's own last note > blank. An
 * auto-detected recovery still wins over both for the category — it describes THIS move, not a
 * previous one (see MoveNotePrompt).
 *
 * Session-only, same shape and reasoning as `lib/globalPropOptions`: in memory, never persisted,
 * back to off/blank on reload. The stable-snapshot + listener-set shape is what
 * `useSyncExternalStore` needs to avoid an infinite render loop.
 */
export type MoveNoteMemory = {
  /** Is the reuse toggle on? Off ⇒ the remembered values are ignored (but kept, so re-ticking works). */
  enabled: boolean
  /** Last confirmed category, or null when the last move was saved without one. */
  category: string | null
  /** Last confirmed observation text ('' when it was left blank). */
  text: string
}

const EMPTY: MoveNoteMemory = Object.freeze({ enabled: false, category: null, text: '' })

let _snapshot: MoveNoteMemory = EMPTY
const _listeners = new Set<() => void>()

/** Current memory. Stable identity — only changes when a value actually changes. */
export function getMoveNoteMemory(): MoveNoteMemory { return _snapshot }

/** Merge a partial change; no-ops when nothing actually changed (keeps the snapshot identity stable). */
export function setMoveNoteMemory(patch: Partial<MoveNoteMemory>): void {
  const next: MoveNoteMemory = { ..._snapshot, ...patch }
  if (next.enabled === _snapshot.enabled && next.category === _snapshot.category && next.text === _snapshot.text) return
  _snapshot = next
  _listeners.forEach(l => l())
}

/**
 * Record the values a move was actually saved with. No-op while the toggle is off, so turning it on
 * later starts from the first move made AFTER it was enabled rather than from stale history.
 */
export function rememberMoveNote(category: string | null, text: string): void {
  if (!_snapshot.enabled) return
  setMoveNoteMemory({ category, text })
}

/** Subscribe to changes (for useSyncExternalStore). */
export function subscribeMoveNoteMemory(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}
