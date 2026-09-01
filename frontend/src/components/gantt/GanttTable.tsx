'use client'
import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import type { GanttData, GanttDateInfo, GanttGroup } from '@/lib/api'
import { api } from '@/lib/api'
import { getToken } from '@/lib/tokenStore'
import { RED_DK, localTodayIso } from '@/lib/ganttUtils'
import type { LocoOverrideMap, LocoVisualOverride } from '@/lib/locoOverrides'
import { useConflictWs } from './useConflictWs'
import { animateScrollBy } from './smoothScroll'

/**
 * Horizontal scroll delta that centres `cell` in its own iframe viewport.
 *
 * Must NOT be written with offsetLeft/offsetWidth. Zoom is applied as CSS `zoom` on the
 * iframe's documentElement — which is also the scroll container — and under `zoom` the
 * offset* properties report UNZOOMED layout values while scrolling happens in the ZOOMED
 * viewport space. Mixing the two lands short or long by the zoom factor, and the error
 * grows with distance from the left edge, so it looks fine near the start of the timeline
 * and badly wrong further out.
 *
 * getBoundingClientRect() and window.innerWidth are both in zoom-adjusted viewport pixels,
 * as is window.scrollBy — so every term here shares one coordinate space and the result is
 * correct at any zoom level, with no factor to keep in sync. This matches how the rest of
 * this file already handles zoom (Move Mode anchors off getBoundingClientRect; the wheel
 * handler scrolls via the window).
 */
function centerDeltaFor(cell: HTMLElement, w: Window): number {
  const r = cell.getBoundingClientRect()
  return r.left + r.width / 2 - w.innerWidth / 2
}

// Cache-busting version for the /public worker (not handled by Next HMR). Bump this on
// every change to gantt-table-worker.js so browsers fetch the new worker instead of a
// stale cached copy. yyyymmddN.
const WORKER_VERSION = '2026090101'

/** Expansion state of the Schedule tree, BOTH tiers. Workstation ↔ Componente: `base` is the
 *  bulk default (Expand All = true / Collapse All = false); `exceptions` holds the individually
 *  toggled keys (`linha||wo||task||start_ms||ws||subarea`) — a WS is expanded iff
 *  `base XOR exceptions.has(key)`. LOCO ↔ Workstation: same model one level up (`locoBase`
 *  defaults to true — the tree is the default view; `locoExceptions` keys are
 *  `linha||wo||task||start_ms`). A collapsed LOCO renders as its single summary row. */
export type WsExpandState = {
  base: boolean; exceptions: ReadonlySet<string>
  locoBase: boolean; locoExceptions: ReadonlySet<string>
}

/** True when the LOCO tier is exactly "all collapsed" (base=false, no exceptions) — the only
 *  state in which the narrow layout (WS column width-0, `loco-collapsed` class) may apply.
 *  Column widths are table-global, so the class is legal only under a table-global condition.
 *  Applied to the iframe root ONLY when the DOM actually matches (after a build finalize or a
 *  patch swap), never eagerly from a state change — the old rows would break under width 0. */
function locoNarrowOf(ex: WsExpandState | undefined): boolean {
  return !!ex && !ex.locoBase && ex.locoExceptions.size === 0
}

/** Result of one Global-propagation cascade request.
 *  `moves`   — the locos that must SHIFT, with the delta in business days.
 *  `wsLocos` — every same-stream loco that RUNS the edited workstation, moved or not. "Propagar
 *              Duração" needs the full membership: a loco already sitting in the right place still
 *              adopts the new duration, so it never appears in `moves`. */
export type GanttGlobalCascade = {
  moves:   { key: string; shift: number; ws: string }[]
  wsLocos: { key: string; ws: string }[]
}

/** Imperative API exposed via ref: surgically re-render only the given LOCOs' rows in the
 *  live iframe (visual override), with no full rebuild. Pass `{ [locoKey]: {} }` to render
 *  a LOCO back to its base (empty override). `expand` overrides the wsExpand PROP for this
 *  patch — callers toggling expansion pass the freshly computed state here, because the prop
 *  is still one render stale when the toggle handler runs. */
export interface GanttTableHandle {
  patchLocos: (overrides: LocoOverrideMap, expand?: WsExpandState) => void
  /** Compute the override-MERGED schedule as DATA (not HTML) using the worker's own merge engine,
   *  so the non-Schedule tabs reflect saved edits with guaranteed parity. Resolves to the merged
   *  GanttData, or the input data unchanged if the worker isn't ready / errors. */
  computeEffective: (data: GanttData, overrides: LocoOverrideMap) => Promise<GanttData>
  /** Global propagation: given the edited loco's key + the EDITED workstation and the CURRENT full
   *  override map, compute the cross-loco delay/recovery cascade in the worker — following ONLY that
   *  WS through subsequent same-Type / same-line locos (PD-bounded for locos that HAVE a buffer).
   *  Resolves to `moves` — { key (locoKey), shift (business days), ws (that loco's raw WS string) }
   *  the caller commits as WS-scope shifts — plus `wsLocos`, every same-stream loco that RUNS that
   *  workstation (moved or not), which is what "Propagar Duração" applies to. Empty if the worker
   *  isn't ready / errors. `referenceOverrides` is the active mode's baseline (for the delay/pull
   *  bound); `advance` is the "Propagar Adiantamento" sub-option (close gaps, not just delays). */
  computeGlobalCascade: (editedKey: string, editedWs: string, overrides: LocoOverrideMap, referenceOverrides: LocoOverrideMap, advance?: boolean) => Promise<GanttGlobalCascade>
  /** Move-Mode frozen-preview geometry for ONE loco, measured in the worker against the SAME base the
   *  renderer draws (the UNFILTERED station list, so a visual filter can't move the pins or drop the
   *  Protection-Days limit) so the pins reproduce the displayed positions exactly. Resolves to each
   *  WORKSTATION's absolute start pin (`geom`) PLUS each COMPONENTE's residual pin (`descGeom` — what
   *  the station pin alone does not reproduce, i.e. a row moved inside its workstation), and the
   *  Protection-Days slack for the given moved workstations. Empty geom / null slack if the worker
   *  isn't ready or the loco is gone. `override` is the loco's committed visual override; `movedWs`
   *  the selection's raw WS strings. */
  computeFreezeGeom: (locoKey: string, override: LocoVisualOverride | null | undefined, movedWs: (string | undefined)[]) => Promise<GanttFreezeGeom>
  /** Which working Saturdays a COMMITTED move lands on. Given the loco's about-to-be-persisted override
   *  and the moved workstations' raw WS strings, the worker reproduces the preview landing (transient
   *  satHand) and reports the promoted-Saturday ISO dates each moved row occupies — keyed by norm(ws)
   *  (station) AND `norm(ws)||subarea||desc` (Componente). The host stamps these as `satDays` on the
   *  committed edit so the Saturday survives Enter without any blanket licence. Empty when the axis has
   *  no working Saturday or the move touched none. */
  computeLandedSaturdays: (locoKey: string, override: LocoVisualOverride | null | undefined, movedWs: (string | undefined)[]) => Promise<Record<string, string[]>>
}

/** Move-Mode freeze pins: one per workstation (`geom`) + the per-Componente residuals (`descGeom`). */
export type GanttFreezeGeom = {
  geom: { ws: string; subarea: string; absStart: number }[]
  descGeom: { ws: string; subarea: string; desc: string; absStart: number }[]
  pdSlack: number | null
  /** Protection-Days slack per SELECTABLE ROW, so a selection that grows or shrinks mid-move is always
   *  policed by its own rows: keyed by normalized WS name for a workstation row and
   *  `WS||subarea||desc` for a Componente row. Post-PD rows are absent (they have no limit).
   *  null when the loco has no buffer at all. See GanttModal.pdSlackForTargets. */
  pdSlackByRow: Record<string, number> | null
}

/** One selectable row in Move Mode (a collapsed workstation summary row, or an expanded
 *  description/Componente row). Identity matches the rendered row's data-* attributes. */
export type GanttMoveRow = { scope: 'ws' | 'desc'; wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string; desc: string; takt: number | null }

/** Build a Move-Mode row descriptor from a rendered row's data-* attributes. Module-level so
 *  BOTH the iframe interaction bindings and the post-patch retarget path (which run in
 *  different closures) share one implementation. */
function rowDescriptorOf(r: HTMLElement): GanttMoveRow {
  const taktRaw = r.dataset.takt
  return {
    scope: r.dataset.rowEdit === 'desc' ? 'desc' : 'ws',
    wo: r.dataset.wo ?? '', taskName: r.dataset.task ?? '', linha: r.dataset.linha ?? '',
    startMs: r.dataset.startMs ?? '', ws: r.dataset.ws ?? '',
    subarea: r.dataset.subarea ?? '', desc: r.dataset.desc ?? '',
    takt: taktRaw != null && taktRaw !== '' && Number.isFinite(Number(taktRaw)) ? Number(taktRaw) : null,
  }
}

export interface GanttTableProps {
  data: GanttData
  filteredDateInfo?: GanttDateInfo[]
  filteredGroups?: GanttGroup[]
  forceReloadToken?: number
  buildEnabled?: boolean
  /** Stable string key that changes only when the data content actually changes.
   *  When provided, the build effect uses this instead of object identity for data/filteredGroups.
   *  Prevents spurious rebuilds when parent re-creates objects with same content. */
  buildKey?: string
  /** Subset of buildKey identifying the underlying DATASET (scenario, date span,
   *  group count, opt mode, forceReload) — i.e. everything EXCEPT filter/visibility
   *  selections. When this is unchanged between two builds but buildKey changed, the
   *  rebuild is filter/visibility-only: GanttTable then performs an IN-PLACE update
   *  (build the new HTML in the background, keep the old view + scroll on screen,
   *  swap in one shot) instead of blanking the iframe and streaming. No "Montando…"
   *  flash; results are still recomputed by the worker so numbers stay identical. */
  structuralKey?: string
  zoom?: number
  onBuildStart?: () => void
  onBuilt?:      () => void
  onProgress?:   (p: number) => void
  onWsClick?:       (wo: string, taskName: string, ws: string, subarea?: string, linha?: string, startMs?: string) => void
  onFlatLocoClick?: (wo: string, taskName: string, linha: string) => void
  onLocoNavClick?:  (taskName: string, linha?: string, wo?: string, startMs?: string) => void
  /** Click on a day-column header (`gantt_date_<iso>`) → navigate to the start of that day. */
  onDayClick?:      (iso: string) => void
  /** Right-click on a LOCO's MODELO cell → open the "Editar LOCO" context menu.
   *  x/y are in PARENT-window viewport coords (iframe offset already applied). */
  onLocoEdit?:      (info: { wo: string; taskName: string; linha: string; startMs: string; takt: number | null; x: number; y: number }) => void
  /** Right-click on a workstation row (WORK mode) or a description row (FULL mode) → open the
   *  scoped edit menu. scope='ws' offers "Editar Workstation"; scope='desc' offers both
   *  "Editar Workstation" and "Editar Componente". x/y in PARENT-window viewport coords. */
  onRowEdit?:       (info: { scope: 'ws' | 'desc'; wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string; desc: string; takt: number | null; x: number; y: number }) => void
  /** Right-click on a SATURDAY day-column header → open the "toggle working Saturday" menu. Fired only
   *  for Saturday headers; the parent owns whether it is currently registered. x/y in parent coords. */
  onSaturdayContext?: (info: { iso: string; x: number; y: number }) => void
  /** Double-click on a workstation/component box → enter "Move Mode". Reports the INITIAL selection
   *  (the clicked row, as a 1-element array). GanttTable owns the row ordering + contiguous multi-row
   *  selection (DOM-driven); it highlights and gates the arrow/+/− keys internally. */
  onBoxMoveStart?:  (rows: GanttMoveRow[]) => void
  /** Up/Down (expand) or Ctrl+Up/Down (shrink) changed the contiguous multi-row selection while Move
   *  Mode is active. Reports the FULL current selection (≥1 row, same LOCO, contiguous, in order). */
  onBoxMoveSelect?: (rows: GanttMoveRow[]) => void
  /** While Move Mode is active: Arrow Left = −1 business day, Arrow Right = +1 (rigid move, all
   *  selected rows). `step` is the magnitude in days (default 1); Ctrl/Cmd+Arrow passes 0.5 for
   *  half-day displacement. */
  onBoxMoveStep?:   (dir: -1 | 1, step?: number) => void
  /** While moving: "+" = increase duration by 1 business day, "−" = decrease by 1 (all selected).
   *  Edits the LAST box (finish edge). `step` is the magnitude in days (default 1); Ctrl/Cmd+"+"/"−"
   *  passes 0.5 for half-day precision. */
  onBoxMoveDuration?: (dir: -1 | 1, step?: number) => void
  /** While moving: Shift+"+"/"−" edits the FIRST box (start edge) instead of the finish — grows/
   *  shrinks the front while the finish stays put. `step` matches onBoxMoveDuration (Ctrl → 0.5). */
  onBoxMoveDurationStart?: (dir: -1 | 1, step?: number) => void
  /** Space in Move Mode: toggle the selected station's "never occupy a Saturday" veto (satNever). */
  onBoxMoveSatNever?: () => void
  /** Enter while moving → commit. `pos` is the moved box's screen position (parent-viewport
   *  coords) so the parent can anchor a lightweight propagate prompt near the selection. */
  onBoxMoveCommit?: (pos?: { x: number; y: number }) => void
  /** Escape while moving → cancel/revert. */
  onBoxMoveCancel?: () => void
  /** Click on a workstation row's expand/collapse chevron ([data-ws-toggle]). The parent owns
   *  the expansion state; it flips this key and patches the LOCO. */
  onWsToggle?: (info: { wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string }) => void
  /** Click on a LOCO's expand/collapse chevron ([data-loco-toggle], on the frozen LINHA cell).
   *  Same contract as onWsToggle, one tier up: the parent flips the LOCO key and patches. */
  onLocoToggle?: (info: { wo: string; taskName: string; linha: string; startMs: string }) => void
  /** Click on a moved box's note indicator (the red corner wedge) → open its move-description
   *  trail. Reports the row's identity, NOT the text: the parent already holds the override map
   *  the reasons live in, so it looks them up itself. x/y in PARENT-window viewport coords. */
  onMoveNoteClick?: (info: { scope: 'ws' | 'desc'; wo: string; taskName: string; linha: string; startMs: string; ws: string; subarea: string; desc: string; x: number; y: number }) => void
  /** Active visual overrides. Applied during a FULL build so a rebuild (tab switch / reopen) shows
   *  the edited state, not base data. Read from a ref at build time — NOT a build dependency, so a
   *  live edit re-patches via patchLocos instead of triggering a full rebuild. */
  overrides?: LocoOverrideMap
  /** Projeção-mode delay-hatch baseline: the frozen projection reference overrides. The worker
   *  measures each WS's delay/recovery hatch from THIS baseline instead of the original schedule, so
   *  a loco sitting at the reference hatches zero. Empty ({}) in Padrão/Original → the worker keeps
   *  its original behaviour (hatch vs the untouched base). Read from a ref at build/patch time. */
  referenceOverrides?: LocoOverrideMap
  /** Workstation ↔ Componente expansion state. Read from a ref at build/patch time — NOT a
   *  build dependency, so an individual chevron toggle re-renders via patchLocos while bulk
   *  Expand/Collapse All rebuilds through a buildKey change made by the parent. */
  wsExpand?: WsExpandState
  flatView?:        boolean
  colorByWs?:       boolean
  grabMode?:        boolean
  /** Original (read-only) mode: block Move Mode entirely — double-clicking a box does not start a move
   *  (grab/pan still works, it is separate). `onMoveBlocked` fires so the parent can tell the user why. */
  moveDisabled?:    boolean
  onMoveBlocked?:   () => void
  /** True while the active Move-Mode selection sits BEYOND the Protection-Days limit (the planner
   *  acknowledged the crossing warning — see GanttModal/MovePdWarningPrompt). Switches the selection
   *  glow from blue to red; back inside the limit returns it to blue. Visual only. */
  moveOverLimit?:   boolean
  /** Map of "locoKey||wsKey" → array of ISO date strings to show as red hatched displacement placeholders.
   *  locoKey = "linha||wo||task_name||start_ms", wsKey = "ws||subarea".
   *  Only rendered on valid business days already present in date_info. */
  displacementMap?: Record<string, string[]>
  /** Map of "locoKey||wsKey||descRowIdx" → array of ISO date strings to show as ORANGE hatched
   *  early-finish recovery placeholders, trailing AFTER the WS block (vs displacement, which
   *  leads before it). Marks where a conflict WS (WS40/WS50) would have extended had it not used
   *  a Saturday. Purely informational — never a delay/PD/conflict and feeds no metric. */
  recoveredMap?: Record<string, string[]>
  /** Per-LOCO MODELO-column indicators (conflict count, original conflicts, net shift).
   *  Keyed by "linha||wo||task_name||start_ms". Visual-only; no recompute. */
  locoMeta?: Record<string, { conflicts: number; origConflicts?: number; shiftDays?: number; pd?: number; origPd?: number; hours?: number }>
  /** When true, hide every Operation/Workstation cell dated before each LOCO's own start
   *  (start_ms). Visualization only — no data/conflict/displacement recompute. */
  hideBeforeStart?: boolean
  /** When true, drop every LOCO with no activity today or later. The timeline itself is NOT
   *  clamped: a LOCO that started a month ago but is still running renders in full, past
   *  columns included, because that history is context for the work still to come — only
   *  LOCOs that are entirely finished disappear.
   *  Independent of hideBeforeStart, and designed to combine with it: turn both on and the
   *  surviving LOCOs render from their own start date onward. */
  hidePastLocos?: boolean
  /** True when the active optimization ran with "Permitir regras de sobreposição": a
   *  boundary handoff on WS40/WS50 (max 2 LOCOs) is an allowed overlap, not a conflict.
   *  Drives the exemption-aware day-header icon and the orange (vs red) overlap border. */
  allowOverlap?: boolean
}

export const GanttTable = forwardRef<GanttTableHandle, GanttTableProps>(function GanttTable({
  data, filteredDateInfo, filteredGroups, forceReloadToken = 0,
  buildEnabled = true, buildKey, structuralKey, zoom = 1,
  onBuildStart, onBuilt, onProgress,
  onWsClick, onFlatLocoClick, onLocoNavClick, onDayClick, onLocoEdit, onRowEdit, onSaturdayContext,
  onBoxMoveStart, onBoxMoveSelect, onBoxMoveStep, onBoxMoveDuration, onBoxMoveDurationStart, onBoxMoveSatNever, onBoxMoveCommit, onBoxMoveCancel,
  onWsToggle, onLocoToggle,
  onMoveNoteClick,
  overrides, referenceOverrides, wsExpand,
  flatView = false, colorByWs = false, grabMode = false, moveDisabled = false, onMoveBlocked,
  moveOverLimit = false,
  displacementMap, recoveredMap, locoMeta, hideBeforeStart = false, hidePastLocos = false,
  allowOverlap = false,
}: GanttTableProps, ref) {
  // The timeline is never clamped by the hide options — a still-running LOCO that started a
  // month ago keeps its past columns, since that history is the context for the work left.
  // "Ocultar LOCOs concluídas" removes whole ROWS instead (in the worker, after overrides
  // are applied); "Ocultar antes do início da LOCO" trims each surviving LOCO's cells to its
  // own start. Combining them shows only live LOCOs, each from its start date onward.
  const date_info = filteredDateInfo ?? data.date_info
  const groups    = filteredGroups    ?? data.groups

  // Session-only conflict-WS selection (right-click the footer Conflict Count → ConflictWsModal).
  // Read from the store rather than taken as a prop so the RENDERED conflict borders can never
  // diverge from the counts the same store drives. The snapshot identity is stable, so it only
  // triggers a rebuild when the planner actually changes the selection.
  const conflictWs = useConflictWs()
  const conflictWsList = useMemo(() => [...conflictWs], [conflictWs])

  const iframeRef          = useRef<HTMLIFrameElement>(null)
  const scrollRef          = useRef<HTMLDivElement>(null)
  const workerRef          = useRef<Worker | null>(null)
  // Lazily spawn the persistent worker, from ANY entry point — not just the build effect.
  //
  // The worker used to be created inside that effect, which returns early on `!buildEnabled`. The
  // Schedule chart is deliberately not built when its tab is off, so with Schedule disabled the worker
  // never existed and `computeEffective` — a PURE data RPC that needs no build state at all — silently
  // resolved with its INPUT. Every non-Schedule tab (Resumo Geral, Plano Externo, Plano de Produção) therefore
  // rendered the untouched DB plan with zero overrides applied and showed no deviations, while loading
  // the Schedule tab once created the worker as a side effect and "fixed" it for the rest of the session.
  // Creating the worker on demand decouples the override/scenario computation from the chart's render
  // gate: the merge runs on load whether or not the Schedule chart is ever drawn.
  // Cache-bust query: the worker lives in /public and is NOT handled by Next HMR, so browsers keep
  // serving the OLD worker after it changes. Bump WORKER_VERSION whenever gantt-table-worker.js changes.
  const ensureWorker = useCallback((): Worker => {
    if (!workerRef.current) workerRef.current = new Worker(`/gantt-table-worker.js?v=${WORKER_VERSION}`)
    return workerRef.current
  }, [])
  const requestIdRef       = useRef(0)
  // Monotonic build id. The worker is persistent (reused across builds); it stamps
  // every outbound message with the buildId it was given, and the handler drops any
  // message whose buildId !== the current one — so late messages from a superseded
  // build can't corrupt the current iframe.
  const buildIdRef         = useRef(0)
  // Previous structuralKey + whether any build has completed, used to decide if a
  // rebuild is filter/visibility-only (→ in-place swap, no blank/flash).
  const prevStructuralKeyRef = useRef<string | undefined>(undefined)
  const hasBuiltOnceRef      = useRef(false)
  const onBuildStartRef    = useRef(onBuildStart)
  const onBuiltRef         = useRef(onBuilt)
  const onProgressRef      = useRef(onProgress)
  const iframeCleanupRef   = useRef<null | (() => void)>(null)
  // Set by bindIframeInteractions; lets the grabMode effect toggle text-selection
  // suppression in the iframe live when grab mode flips on/off.
  const grabSelectRef      = useRef<null | ((on: boolean) => void)>(null)
  const forceReloadTokenRef = useRef(forceReloadToken)
  const grabModeRef        = useRef(grabMode)
  const moveDisabledRef    = useRef(moveDisabled)
  const moveOverLimitRef   = useRef(moveOverLimit)
  const onMoveBlockedRef   = useRef(onMoveBlocked)
  const zoomRef            = useRef(zoom)
  const onWsClickRef       = useRef(onWsClick)
  const onFlatLocoClickRef = useRef(onFlatLocoClick)
  const onLocoNavRef       = useRef(onLocoNavClick)
  const onDayClickRef      = useRef(onDayClick)
  const onLocoEditRef      = useRef(onLocoEdit)
  const onRowEditRef       = useRef(onRowEdit)
  const onSaturdayContextRef = useRef(onSaturdayContext)
  const onBoxMoveStartRef  = useRef(onBoxMoveStart)
  const onBoxMoveSelectRef = useRef(onBoxMoveSelect)
  const onBoxMoveStepRef   = useRef(onBoxMoveStep)
  const onBoxMoveDurationRef = useRef(onBoxMoveDuration)
  const onBoxMoveDurationStartRef = useRef(onBoxMoveDurationStart)
  const onBoxMoveSatNeverRef = useRef(onBoxMoveSatNever)
  const onBoxMoveCommitRef = useRef(onBoxMoveCommit)
  const onBoxMoveCancelRef = useRef(onBoxMoveCancel)
  const onWsToggleRef      = useRef(onWsToggle)
  const onLocoToggleRef    = useRef(onLocoToggle)
  const onMoveNoteClickRef = useRef(onMoveNoteClick)
  // Active Move-Mode selection, owned here (DOM is the source of truth for row order + LOCO
  // boundary). `rows` is every selectable row of the clicked LOCO in document/visual order;
  // [lo,hi] is the contiguous selection (inclusive). null = Move Mode off. Mirrored in a ref so the
  // once-bound iframe handlers always read the current value. `durationEditable` = FULL/desc only.
  const moveSelRef = useRef<{ rows: GanttMoveRow[]; lo: number; hi: number; durationEditable: boolean } | null>(null)
  // Set by bindIframeInteractions; lets patchLocos re-apply the glow after a tbody swap.
  const applyMoveHighlightRef = useRef<null | ((doc: Document) => void)>(null)
  // Latest render context the surgical patch needs (kept in a ref so the imperative
  // patchLocos closure always sends current values without re-creating the handle).
  const patchPropsRef = useRef({ colorByWs, hideBeforeStart, hidePastLocos, displacementMap, recoveredMap, locoMeta, allowOverlap, conflictWs: conflictWsList })
  patchPropsRef.current = { colorByWs, hideBeforeStart, hidePastLocos, displacementMap, recoveredMap, locoMeta, allowOverlap, conflictWs: conflictWsList }
  // Bumped when the worker REFUSES a surgical patch (needsRebuild): with "Ocultar LOCOs
  // concluídas" on, an edit that crosses the trimmed-axis boundary (or hides/reveals a row)
  // can't be expressed as a tbody swap — the header/columns themselves must change. Included
  // in the build-effect deps, so the bump triggers a full rebuild; structuralKey is unchanged,
  // so it takes the IN-PLACE path (scroll preserved, no blank/flash) and reads the current
  // override map from overridesRef.
  const [patchRebuildNonce, setPatchRebuildNonce] = useState(0)
  // Current overrides, read at build time so a rebuild applies them (NOT a build dep — live edits
  // patch surgically instead of rebuilding). Assigned in render so it is always up to date.
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  // FULL, unfiltered dataset (data.groups / data.date_info), read at cascade time. The Schedule build
  // renders the FILTERED groups (scheduleFilteredGroups), which strip non-selected workstations —
  // including PROTECTIONDAYS. computeGlobalCascade must NOT see that stripped set (it would read 0
  // protection days and refuse every push), so the cascade computes on this full set instead. A WS/
  // area/period filter is purely visual; it must never change propagation or any other logic.
  const fullDataRef = useRef(data)
  fullDataRef.current = data
  // Projeção delay-hatch baseline (frozen projection reference), same ref pattern as overridesRef:
  // read at build/patch time so the worker hatches deviation from the reference, not the original.
  const referenceOverridesRef = useRef(referenceOverrides)
  referenceOverridesRef.current = referenceOverrides
  // Current Workstation ↔ Componente expansion state — same ref pattern (and reasons) as
  // overridesRef: chevron toggles patch surgically; every rebuild reads the fresh value.
  const wsExpandRef = useRef(wsExpand)
  wsExpandRef.current = wsExpand
  // Patch-response correlation id. Negative + decrementing so it can never collide with a
  // build's positive buildId (the build's onmessage drops mismatched ids and ignores
  // 'patched' anyway).
  const patchIdRef = useRef(0)
  // Correlation id for computeEffective requests (separate from patch ids; decrements independently).
  const effIdRef = useRef(0)
  // Correlation id for computeGlobalCascade requests (its own decrementing counter).
  const cascIdRef = useRef(0)
  // Correlation id for computeFreezeGeom (Move-Mode frozen preview) requests.
  const freezeIdRef = useRef(0)

  useEffect(() => { onBuildStartRef.current    = onBuildStart    }, [onBuildStart])
  useEffect(() => { onBuiltRef.current         = onBuilt         }, [onBuilt])
  useEffect(() => { onProgressRef.current      = onProgress      }, [onProgress])
  useEffect(() => { onWsClickRef.current       = onWsClick       }, [onWsClick])
  useEffect(() => { onFlatLocoClickRef.current = onFlatLocoClick }, [onFlatLocoClick])
  useEffect(() => { onLocoNavRef.current       = onLocoNavClick  }, [onLocoNavClick])
  useEffect(() => { onDayClickRef.current       = onDayClick      }, [onDayClick])
  useEffect(() => { onLocoEditRef.current      = onLocoEdit      }, [onLocoEdit])
  useEffect(() => { onRowEditRef.current        = onRowEdit        }, [onRowEdit])
  useEffect(() => { onSaturdayContextRef.current = onSaturdayContext }, [onSaturdayContext])
  useEffect(() => { moveDisabledRef.current     = moveDisabled     }, [moveDisabled])
  // Track the over-limit flag AND repaint the glow the moment it flips (blue↔red), so a step that
  // crosses / uncrosses the Protection-Days limit recolours the border even without a selection change.
  useEffect(() => {
    moveOverLimitRef.current = moveOverLimit
    const doc = iframeRef.current?.contentDocument
    if (doc) applyMoveHighlightRef.current?.(doc)
  }, [moveOverLimit])
  useEffect(() => { onMoveBlockedRef.current     = onMoveBlocked     }, [onMoveBlocked])
  useEffect(() => { onBoxMoveStartRef.current   = onBoxMoveStart   }, [onBoxMoveStart])
  useEffect(() => { onBoxMoveSelectRef.current  = onBoxMoveSelect  }, [onBoxMoveSelect])
  useEffect(() => { onBoxMoveStepRef.current    = onBoxMoveStep    }, [onBoxMoveStep])
  useEffect(() => { onBoxMoveDurationRef.current = onBoxMoveDuration }, [onBoxMoveDuration])
  useEffect(() => { onBoxMoveDurationStartRef.current = onBoxMoveDurationStart }, [onBoxMoveDurationStart])
  useEffect(() => { onBoxMoveSatNeverRef.current = onBoxMoveSatNever }, [onBoxMoveSatNever])
  useEffect(() => { onBoxMoveCommitRef.current  = onBoxMoveCommit  }, [onBoxMoveCommit])
  useEffect(() => { onBoxMoveCancelRef.current  = onBoxMoveCancel  }, [onBoxMoveCancel])
  useEffect(() => { onWsToggleRef.current       = onWsToggle       }, [onWsToggle])
  useEffect(() => { onLocoToggleRef.current     = onLocoToggle     }, [onLocoToggle])
  useEffect(() => { onMoveNoteClickRef.current  = onMoveNoteClick  }, [onMoveNoteClick])
  useEffect(() => { zoomRef.current            = zoom            }, [zoom])

  // NOTE: there is no global view-mode CSS effect anymore. Both tiers are worker-rendered
  // rows; the `loco-collapsed` narrow layout is synced to the DOM at build finalize and
  // patch-apply time (see locoNarrowOf), never eagerly from a prop change.

  useEffect(() => {
    const frame = iframeRef.current
    const doc = frame?.contentWindow?.document
    if (!doc?.documentElement || !doc.body) return
    doc.documentElement.style.zoom = String(zoom)
    doc.body.style.zoom = ''
  }, [zoom])

  useEffect(() => {
    grabModeRef.current = grabMode
    const frame = iframeRef.current
    const doc = frame?.contentWindow?.document
    if (!doc) return
    const cursor = grabMode ? 'grab' : ''
    if (doc.documentElement) doc.documentElement.style.cursor = cursor
    if (doc.body) doc.body.style.cursor = cursor
    // Suppress/restore text selection in the iframe as grab mode flips, so panning
    // never highlights text and normal mode keeps selection available.
    grabSelectRef.current?.(grabMode)
  }, [grabMode])

  useEffect(() => {
    let effectCancelled = false
    const currentRequestId = ++requestIdRef.current
    const currentBuildId = ++buildIdRef.current
    const shouldForceReload = forceReloadToken !== forceReloadTokenRef.current
    forceReloadTokenRef.current = forceReloadToken

    if (!buildEnabled) return

    // Persistent worker: reuse the existing instance instead of new/terminate per
    // build (saves worker spawn + script parse on every filter/option change). Tell
    // any in-flight prior build to abort; its late messages are dropped by buildId.
    // It may already exist without any build having run — computeEffective spawns it on
    // demand so the override merge works with the Schedule chart disabled (see ensureWorker).
    const existing = workerRef.current
    if (existing) existing.postMessage({ type: 'cancel' })
    const worker = ensureWorker()

    // In-place update = a rebuild where the underlying DATASET is unchanged and only
    // filter/visibility selections changed, AND we already have content on screen.
    // For these we keep the current iframe visible (no blank, scroll preserved) and
    // buffer the new HTML, swapping it in one shot at 'done'. Falls back to the
    // streaming path when structuralKey is not provided.
    const inPlace =
      structuralKey !== undefined &&
      hasBuiltOnceRef.current &&
      prevStructuralKeyRef.current === structuralKey
    prevStructuralKeyRef.current = structuralKey
    // Buffer for in-place builds; chunks are concatenated and written once at done.
    let inPlaceBuffer = ''
    // Scroll position captured at swap time so the new document lands where the user was.
    let savedScrollLeft = 0, savedScrollTop = 0

    if (iframeCleanupRef.current) { iframeCleanupRef.current(); iframeCleanupRef.current = null }

    // Only blank the iframe for a full (non-in-place) build. In-place keeps the old
    // content visible until the freshly built HTML is ready to swap.
    if (!inPlace) {
      const _resetDoc = iframeRef.current?.contentDocument
      if (_resetDoc) {
        _resetDoc.open()
        _resetDoc.write('<!DOCTYPE html><html><body style="margin:0"></body></html>')
        _resetDoc.close()
      }
    }

    // Suppress the "Montando…" overlay for in-place updates (onBuildStart drives it).
    if (!inPlace) onBuildStartRef.current?.()

    const bindIframeInteractions = (doc: Document) => {
      if (iframeCleanupRef.current) return

      if (doc.documentElement) {
        doc.documentElement.style.zoom = String(zoomRef.current)
        doc.body.style.zoom = ''
        // Narrow layout iff the loco tier is all-collapsed — the rows in this fresh document
        // were rendered from the same state, so the class always matches the DOM here.
        doc.documentElement.classList.toggle('loco-collapsed', locoNarrowOf(wsExpandRef.current))
      }
      // While grab mode is on, the iframe behaves like a panning surface, not a text
      // document: suppress text selection entirely so a drag never highlights cell/
      // label/header text. Toggled here (initial bind) and in the grabMode effect.
      const setGrabSelect = (on: boolean) => {
        const val = on ? 'none' : ''
        for (const node of [doc.documentElement, doc.body]) {
          if (!node) continue
          node.style.userSelect = val
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(node.style as any).webkitUserSelect = val
        }
      }
      if (grabModeRef.current) {
        if (doc.documentElement) doc.documentElement.style.cursor = 'grab'
        if (doc.body) doc.body.style.cursor = 'grab'
        setGrabSelect(true)
      }
      // Belt-and-suspenders: even with user-select:none, some browsers still fire a
      // selectstart/dragstart at gesture start. Cancel both while grab mode is active
      // so focus/selection never lands on rendered text during a pan.
      const onSelectStart = (e: Event) => { if (grabModeRef.current) e.preventDefault() }
      const onDragStart   = (e: Event) => { if (grabModeRef.current) e.preventDefault() }

      const onWheel = (e: WheelEvent) => {
        if (!e.shiftKey) return
        e.preventDefault()
        const w = doc.defaultView
        if (!w) return
        w.scrollTo({ left: Math.max(0, w.scrollX + e.deltaY), behavior: 'auto' })
      }

      const onClick = (e: MouseEvent) => {
        // Move-description indicator (the red corner wedge on a moved box) → open its trail.
        // Must be tested BEFORE the .gbx guard below, since the wedge lives inside a box and
        // that guard returns early for anything in one.
        const noteBadge = (e.target as HTMLElement).closest('[data-move-note]') as HTMLElement | null
        if (noteBadge && onMoveNoteClickRef.current) {
          const row = noteBadge.closest('[data-row-edit]') as HTMLElement | null
          if (row?.dataset.wo) {
            e.preventDefault(); e.stopPropagation()
            const r = noteBadge.getBoundingClientRect()
            const fr = iframeRef.current?.getBoundingClientRect()
            onMoveNoteClickRef.current({
              scope: row.dataset.rowEdit === 'desc' ? 'desc' : 'ws',
              wo: row.dataset.wo ?? '', taskName: row.dataset.task ?? '', linha: row.dataset.linha ?? '',
              startMs: row.dataset.startMs ?? '', ws: row.dataset.ws ?? '',
              subarea: row.dataset.subarea ?? '', desc: row.dataset.desc ?? '',
              x: (fr?.left ?? 0) + r.right, y: (fr?.top ?? 0) + r.bottom,
            })
            return
          }
        }
        // Workstation expand/collapse chevron → flip the tier for that WS. Tested BEFORE the
        // [data-ws] navigation handler below, since the chevron lives inside the WS label cell.
        const wsToggle = (e.target as HTMLElement).closest('[data-ws-toggle]') as HTMLElement | null
        if (wsToggle) {
          e.preventDefault(); e.stopPropagation()
          const cell = wsToggle.closest('[data-ws]') as HTMLElement | null
          if (cell?.dataset.wo && onWsToggleRef.current) {
            onWsToggleRef.current({
              wo: cell.dataset.wo ?? '', taskName: cell.dataset.task ?? '', linha: cell.dataset.linha ?? '',
              startMs: cell.dataset.startMs ?? '', ws: cell.dataset.ws ?? '', subarea: cell.dataset.subarea ?? '',
            })
          }
          return
        }
        // LOCO expand/collapse chevron (frozen LINHA cell) → flip the LOCO tier. The chevron
        // span carries its own identity attrs (the LINHA cell has none). Tested before every
        // navigation handler, like the WS chevron.
        const locoToggle = (e.target as HTMLElement).closest('[data-loco-toggle]') as HTMLElement | null
        if (locoToggle) {
          e.preventDefault(); e.stopPropagation()
          if (locoToggle.dataset.wo && onLocoToggleRef.current) {
            onLocoToggleRef.current({
              wo: locoToggle.dataset.wo ?? '', taskName: locoToggle.dataset.task ?? '',
              linha: locoToggle.dataset.linha ?? '', startMs: locoToggle.dataset.startMs ?? '',
            })
          }
          return
        }

        // ── Boxes are Move-Mode ONLY: never navigate from a .gbx ──────────────────────────
        // A double-click on a box opens Move Mode (onDblClick), but the browser always fires
        // two `click` events BEFORE `dblclick` — so without this guard the schedule scrolls
        // out from under the user, twice, before Move Mode even opens. There is no way to
        // know from click #1 that a second is coming, so the only way to make double-click
        // land exclusively on Move Mode is for a box to not navigate at all.
        // Navigation is unaffected everywhere else: the row label, day headers, LOCO cells,
        // and any non-box part of the row all still navigate.
        // Scoped to exactly what onDblClick accepts (a .gbx inside [data-row-edit], with a
        // handler wired) so a box Move Mode would IGNORE stays navigable instead of going inert.
        const moveBox = (e.target as HTMLElement).closest('.gbx') as HTMLElement | null
        if (moveBox && moveBox.closest('[data-row-edit]') && onBoxMoveStartRef.current) return

        // "Ir para hoje" button (wheel-hint corner) → centre the timeline on today's column.
        // Handled here rather than through a parent callback because the scroll engine lives
        // in this document; this is the same centring the fresh-load path applies. The worker
        // only emits the attribute when today is inside the loaded range, so a disabled button
        // simply never matches here.
        const todayNavBtn = (e.target as HTMLElement).closest('[data-today-nav]') as HTMLElement | null
        if (todayNavBtn) {
          const iso = todayNavBtn.dataset.todayNav ?? ''
          const cell = iso ? (doc.getElementById(`gantt_date_${iso}`) as HTMLElement | null) : null
          const w = doc.defaultView
          if (cell && w) animateScrollBy(w, { left: centerDeltaFor(cell, w) })
          return
        }

        // Day-column header click → navigate to the start of that day (same scroll engine as WS/LOCO).
        const dayNavCell = (e.target as HTMLElement).closest('[data-day-nav]') as HTMLElement | null
        if (dayNavCell) {
          const iso = dayNavCell.dataset.dayNav ?? ''
          if (iso) onDayClickRef.current?.(iso)
          return
        }
        const locoNavCell = (e.target as HTMLElement).closest('[data-loco-nav]') as HTMLElement | null
        if (locoNavCell) {
          const task    = locoNavCell.dataset.task    ?? ''
          const linha   = locoNavCell.dataset.linha   ?? ''
          const wo      = locoNavCell.dataset.wo      ?? ''
          const startMs = locoNavCell.dataset.startMs ?? ''
          if (task) onLocoNavRef.current?.(task, linha || undefined, wo || undefined, startMs || undefined)
          return
        }
        // Navigate ONLY when the click lands on the frozen WORKSTATION label cell (a <td data-ws>),
        // never on the rest of the row. The WS/desc <tr> ALSO carries data-ws (for Move Mode), so a
        // click on a timeline cell / box / delay area / expanded content resolves `closest('[data-ws]')`
        // to the <tr> — those must NOT auto-scroll. Requiring the match to be a <td> scopes navigation
        // to the WORKSTATION column exactly like the LOCO column (data-loco-nav, only ever on <td>),
        // making WORK / FULL / MISTO behave like LOCO mode and killing accidental jumps.
        const wsCell = (e.target as HTMLElement).closest('[data-ws]') as HTMLElement | null
        if (wsCell && wsCell.tagName === 'TD') {
          const wo      = wsCell.dataset.wo      ?? ''
          const task    = wsCell.dataset.task    ?? ''
          const ws      = wsCell.dataset.ws      ?? ''
          const subarea = wsCell.dataset.subarea ?? ''
          const linha   = wsCell.dataset.linha   ?? ''
          const startMs = wsCell.dataset.startMs ?? ''
          if (wo && task && ws) onWsClickRef.current?.(wo, task, ws, subarea || undefined, linha || undefined, startMs || undefined)
          return
        }
        const locoCell = (e.target as HTMLElement).closest('[data-flat-wo]') as HTMLElement | null
        if (locoCell) {
          const wo    = locoCell.dataset.flatWo    ?? ''
          const task  = locoCell.dataset.flatTask  ?? ''
          const linha = locoCell.dataset.flatLinha ?? ''
          if (task) onFlatLocoClickRef.current?.(wo, task, linha)
        }
      }

      const onContextMenu = (e: MouseEvent) => {
        const tgt = e.target as HTMLElement
        // e.clientX/Y are relative to the iframe viewport; add the iframe's offset in the
        // parent so the fixed-position menu lands under the cursor.
        const rect = iframeRef.current?.getBoundingClientRect()
        const x = (rect?.left ?? 0) + e.clientX
        const y = (rect?.top  ?? 0) + e.clientY
        const taktOf = (raw: string | undefined) =>
          raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null

        // LOCO edit (MODELO cell, present in every mode).
        const editCell = tgt.closest('[data-loco-edit]') as HTMLElement | null
        if (editCell && onLocoEditRef.current) {
          e.preventDefault()
          const wo = editCell.dataset.wo ?? ''
          if (wo) onLocoEditRef.current({
            wo, taskName: editCell.dataset.task ?? '', linha: editCell.dataset.linha ?? '',
            startMs: editCell.dataset.startMs ?? '', takt: taktOf(editCell.dataset.takt), x, y,
          })
          return
        }

        // Workstation / Componente edit (WORK-mode WS row or FULL-mode description row).
        const rowCell = tgt.closest('[data-row-edit]') as HTMLElement | null
        if (rowCell && onRowEditRef.current) {
          e.preventDefault()
          const wo = rowCell.dataset.wo ?? ''
          if (wo) onRowEditRef.current({
            scope: (rowCell.dataset.rowEdit === 'desc' ? 'desc' : 'ws'),
            wo, taskName: rowCell.dataset.task ?? '', linha: rowCell.dataset.linha ?? '',
            startMs: rowCell.dataset.startMs ?? '', ws: rowCell.dataset.ws ?? '',
            subarea: rowCell.dataset.subarea ?? '', desc: rowCell.dataset.desc ?? '',
            takt: taktOf(rowCell.dataset.takt), x, y,
          })
          return
        }

        // Right-click a SATURDAY day-column HEADER → toggle it as a working Saturday. Header cells
        // carry data-day-nav="<iso>" (left-click navigates); only Saturdays offer the toggle, so a
        // normal weekday/weekend header right-click is a no-op (default menu).
        const dayHead = tgt.closest('[data-day-nav]') as HTMLElement | null
        if (dayHead && onSaturdayContextRef.current) {
          const iso = dayHead.dataset.dayNav ?? ''
          if (iso && new Date(`${iso}T00:00:00Z`).getUTCDay() === 6) {
            e.preventDefault()
            onSaturdayContextRef.current({ iso, x, y })
          }
        }
      }

      // ── Move Mode ───────────────────────────────────────────────────────────────────────
      // Double-click a workstation/component BOX (.gbx) → ask the parent to enter Move Mode for
      // that row. Arrow keys then nudge it ±1 business day (parent applies the same startShift
      // override used by manual edits). The glow highlight is a pure CSS hook re-applied after
      // every surgical patch (which replaces the row's <tbody>).

      // Inject the glow style once per document (survives patchLocos tbody swaps).
      if (!doc.getElementById('gantt-move-style')) {
        const st = doc.createElement('style')
        st.id = 'gantt-move-style'
        st.textContent =
          // The schedule is a read-only grid driven by clicks (navigate / right-click edit /
          // double-click Move Mode). Browser text selection serves no purpose here and a click or
          // double-click otherwise paints the OS blue word-selection highlight — which fights the
          // Move-Mode interaction. Disable selection document-wide (grab mode already does this
          // inline; this makes it the default too).
          'html,body{-webkit-user-select:none;-ms-user-select:none;user-select:none}' +
          '.gantt-move-glow{outline:2px solid #2563EB!important;outline-offset:-2px;position:relative;z-index:6!important;' +
          'box-shadow:0 6px 16px rgba(37,99,235,.5);animation:gmPulse 1.1s ease-in-out infinite}' +
          '@keyframes gmPulse{0%,100%{box-shadow:0 4px 10px rgba(37,99,235,.4)}50%{box-shadow:0 9px 22px rgba(37,99,235,.65)}}' +
          // Over-limit variant: the selection is beyond the Protection-Days limit (planner acknowledged
          // the crossing warning). Same pulse, RED outline/shadow — a deliberate "you are past the
          // boundary" signal that returns to blue automatically when pulled back inside.
          '.gantt-move-glow-over{outline:2px solid #DC2626!important;outline-offset:-2px;position:relative;z-index:6!important;' +
          'box-shadow:0 6px 16px rgba(220,38,38,.5);animation:gmPulseOver 1.1s ease-in-out infinite}' +
          '@keyframes gmPulseOver{0%,100%{box-shadow:0 4px 10px rgba(220,38,38,.45)}50%{box-shadow:0 9px 22px rgba(220,38,38,.7)}}'
        ;(doc.head || doc.documentElement).appendChild(st)
      }

      const selectedRows = (): GanttMoveRow[] => {
        const s = moveSelRef.current
        return s ? s.rows.slice(s.lo, s.hi + 1) : []
      }

      // Paint the glow on every SELECTED row's boxes (clears any previous glow first). Re-resolves
      // rows from the live DOM by their data-* identity, so it survives patchLocos tbody swaps.
      const applyMoveHighlight = (d: Document) => {
        d.querySelectorAll('.gantt-move-glow, .gantt-move-glow-over').forEach(el => el.classList.remove('gantt-move-glow', 'gantt-move-glow-over'))
        // Blue while within the Protection-Days limit, red once beyond it (the planner acknowledged
        // the crossing). Chosen per-repaint from the live flag so a step across / back flips the colour.
        const glowClass = moveOverLimitRef.current ? 'gantt-move-glow-over' : 'gantt-move-glow'
        for (const t of selectedRows()) {
          // A ws-scope selection covers the WHOLE workstation, whatever its rendering: its
          // aggregated summary row while collapsed, or EVERY Componente row of that WS when
          // the user expands it mid-move (the ws edit moves them all together, so they must
          // all glow). Only one of the two variants exists in the DOM at a time, so matching
          // both selectors can never double-paint.
          const selector = t.scope === 'ws'
            ? 'tr[data-row-edit="ws"], tr[data-row-edit="desc"]'
            : 'tr[data-row-edit="desc"]'
          d.querySelectorAll(selector).forEach(tr => {
            const ds = (tr as HTMLElement).dataset
            if (ds.linha !== t.linha || ds.wo !== t.wo || ds.task !== t.taskName || ds.startMs !== t.startMs) return
            if ((ds.ws ?? '') !== t.ws || (ds.subarea ?? '') !== t.subarea) return
            if (t.scope === 'desc' && (ds.desc ?? '') !== t.desc) return
            tr.querySelectorAll('.gbx').forEach(td => (td as HTMLElement).classList.add(glowClass))
          })
        }
      }
      applyMoveHighlightRef.current = applyMoveHighlight

      // Report the current selection to the parent and repaint the glow (used by every selection
      // change: Up/Down expand, Ctrl+Up/Down shrink).
      const emitSelection = () => {
        if (!moveSelRef.current) return
        onBoxMoveSelectRef.current?.(selectedRows())
        applyMoveHighlight(doc)
      }

      const onDblClick = (e: MouseEvent) => {
        const box = (e.target as HTMLElement).closest('.gbx') as HTMLElement | null
        if (!box) {
          // LOCO mode: a double-click on a collapsed locomotive's day box expands THAT loco into
          // its Workstation/Componente view — never Move Mode. Scoped to the day cells (data-iso)
          // of the collapsed summary row (tr.gantt-loco-col), so the frozen label/nav/edit cells
          // keep their own single-click handlers. Routes through the same surgical single-loco
          // toggle the chevron uses, so the scroll position is preserved.
          const locoRow = (e.target as HTMLElement).closest('tr.gantt-loco-col') as HTMLElement | null
          const dayCell = (e.target as HTMLElement).closest('td[data-iso]') as HTMLElement | null
          if (locoRow && dayCell && locoRow.dataset.wo && onLocoToggleRef.current) {
            e.preventDefault()
            try { doc.defaultView?.getSelection?.()?.removeAllRanges() } catch { /* noop */ }
            onLocoToggleRef.current({
              wo: locoRow.dataset.wo ?? '', taskName: locoRow.dataset.task ?? '',
              linha: locoRow.dataset.linha ?? '', startMs: locoRow.dataset.startMs ?? '',
            })
          }
          return
        }
        const row = box.closest('[data-row-edit]') as HTMLElement | null
        if (!row || !onBoxMoveStartRef.current) return
        e.preventDefault()
        // Original (read-only) mode: block Move Mode entirely — never enter the move (don't set
        // moveSelRef / highlight). Tell the parent so it can explain why. Pan/grab is unaffected.
        if (moveDisabledRef.current) { onMoveBlockedRef.current?.(); return }
        // Clearing the text selection a double-click would create.
        try { doc.defaultView?.getSelection?.()?.removeAllRanges() } catch { /* noop */ }
        if (!(row.dataset.wo)) return
        const scope: 'ws' | 'desc' = row.dataset.rowEdit === 'desc' ? 'desc' : 'ws'
        // Each <tbody data-loco> holds ALL view modes' rows (FULL desc + WORK ws + LOCO), with CSS
        // hiding the inactive ones. Restrict candidates to the clicked row's scope so the selection
        // is exactly the rows VISIBLE in the current mode, in document (= visual) order.
        const tbody = row.closest('tbody[data-loco]') as HTMLElement | null
        const rowEls = tbody ? (Array.from(tbody.querySelectorAll(`[data-row-edit="${scope}"]`)) as HTMLElement[]) : [row]
        const rows = rowEls.map(rowDescriptorOf)
        const idx = Math.max(0, rowEls.indexOf(row))
        // Every selectable row is duration-editable, workstation rows included: +/− on a COLLAPSED
        // workstation resizes the whole workstation directly (mirrors startMove). No auto-expand.
        moveSelRef.current = { rows, lo: idx, hi: idx, durationEditable: true }
        onBoxMoveStartRef.current(rows.slice(idx, idx + 1))
        applyMoveHighlight(doc)
      }

      // Arrow/Enter/Escape only act while a move is active; otherwise let the keys pass through.
      const onMoveKey = (e: KeyboardEvent) => {
        const sel = moveSelRef.current
        if (!sel) return
        // ←/→ move the selection one business day (whole-day only). Modifier keys are reserved
        // EXCLUSIVELY for the +/− partial-day side (Ctrl = end box, Shift = start box); they add
        // nothing to the arrows, so Ctrl/Shift+←/→ behave identically to a bare arrow — no half-day
        // displacement and no special navigation.
        if (e.key === 'ArrowLeft')  { e.preventDefault(); onBoxMoveStepRef.current?.(-1, 1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); onBoxMoveStepRef.current?.(1,  1); return }
        // Up/Down grow the contiguous selection (Down = add the row BELOW, Up = add the row ABOVE);
        // Ctrl reverses it (Ctrl+Down removes the bottom row, Ctrl+Up removes the top row). Bounded
        // to the LOCO's own rows and to ≥1 selected row.
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (e.ctrlKey || e.metaKey) { if (sel.hi > sel.lo) { sel.hi -= 1; emitSelection() } }
          else if (sel.hi < sel.rows.length - 1) { sel.hi += 1; emitSelection() }
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (e.ctrlKey || e.metaKey) { if (sel.lo < sel.hi) { sel.lo += 1; emitSelection() } }
          else if (sel.lo > 0) { sel.lo -= 1; emitSelection() }
          return
        }
        // Duration: "+"/"=" grow, "-"/"_" shrink (covers main row, shifted "+", and the numpad).
        // Modifiers pick which EDGE and precision:
        //   • Ctrl/Cmd  → LAST box (finish), half-day (±0.5) fine-adjust.
        //   • Shift     → FIRST box (start edge), half-day — grows/shrinks the front, finish stays put.
        //     (On most layouts "+" IS Shift+"=", so a plain "+"/"_" naturally lands here; Ctrl wins
        //      when both are held, so Ctrl+"+" stays a LAST-box edit exactly as the user asked.)
        //   • neither   → LAST box, whole business day (the existing "=" / numpad grow-shrink).
        // Duration editing works on Componente AND workstation rows, so a COLLAPSED workstation
        // resizes in place — no auto-expand, and the change covers the whole workstation rather
        // than only its first Componente.
        {
          const isPlus  = e.key === '+' || e.key === '=' || e.key === 'Add'
          const isMinus = e.key === '-' || e.key === '_' || e.key === 'Subtract'
          if (isPlus || isMinus) {
            const ctrl = e.ctrlKey || e.metaKey
            const editFirst = !ctrl && e.shiftKey     // Shift (without Ctrl) targets the FIRST box
            const durStep = (ctrl || editFirst) ? 0.5 : 1
            const dir: -1 | 1 = isPlus ? 1 : -1
            if (sel.durationEditable) {
              e.preventDefault()
              if (editFirst) onBoxMoveDurationStartRef.current?.(dir, durStep)
              else onBoxMoveDurationRef.current?.(dir, durStep)
              return
            }
          }
        }
        // SPACE toggles the selected station's "never occupy a Saturday" veto (satNever). Bare Space
        // only — a modifier combination is left alone so it can never collide with a browser shortcut.
        // preventDefault is essential: Space is the page-scroll key, and without it the Gantt would
        // jump a screenful on every toggle. `e.code` is checked too, so the toggle still works on
        // layouts where `e.key` for the space bar is not a plain ' '.
        if ((e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          onBoxMoveSatNeverRef.current?.()
          return
        }
        if (e.key === 'Enter')      {
          e.preventDefault()
          // Anchor the propagate prompt at the LAST glowing box (the row's right edge), converted
          // to parent-viewport coords (iframe offset + zoomed rect, matching the contextmenu math).
          const glow = doc.querySelectorAll('.gantt-move-glow')
          const box = glow.length ? (glow[glow.length - 1] as HTMLElement) : null
          let pos: { x: number; y: number } | undefined
          if (box) {
            const r = box.getBoundingClientRect()
            const fr = iframeRef.current?.getBoundingClientRect()
            pos = { x: (fr?.left ?? 0) + r.right, y: (fr?.top ?? 0) + r.top }
          }
          moveSelRef.current = null      // end Move Mode locally; parent shows the propagate prompt
          applyMoveHighlight(doc)
          onBoxMoveCommitRef.current?.(pos)
          return
        }
        if (e.key === 'Escape')     { e.preventDefault(); moveSelRef.current = null; applyMoveHighlight(doc); onBoxMoveCancelRef.current?.(); return }
      }

      let isPanning = false, didDrag = false
      let panStartX = 0, panStartY = 0, panScrollLeft = 0, panScrollTop = 0
      // Scroll element cached at gesture start; the pending target is applied at most
      // once per animation frame (rAF-coalesced) so a burst of sub-frame mousemove
      // events triggers ONE layout/paint per frame instead of several — the fix for
      // grab-mode stutter on this large sticky-column table.
      let panScrollEl: HTMLElement | null = null
      let rafId = 0
      let pendingLeft = 0, pendingTop = 0
      const getScrollEl = (): HTMLElement => (doc.scrollingElement ?? doc.documentElement) as HTMLElement

      const applyPan = () => {
        rafId = 0
        if (!isPanning || !panScrollEl) return
        panScrollEl.scrollLeft = pendingLeft
        panScrollEl.scrollTop  = pendingTop
      }

      const onMousedown = (e: MouseEvent) => {
        if (!grabModeRef.current || e.button !== 0) return
        isPanning = true; didDrag = false
        panStartX = e.clientX; panStartY = e.clientY
        panScrollEl = getScrollEl()
        panScrollLeft = panScrollEl.scrollLeft; panScrollTop = panScrollEl.scrollTop
        pendingLeft = panScrollLeft; pendingTop = panScrollTop
        if (doc.documentElement) doc.documentElement.style.cursor = 'grabbing'
        if (doc.body) doc.body.style.cursor = 'grabbing'
        // Drop any pre-existing selection so the pan starts on a clean surface.
        try { doc.defaultView?.getSelection?.()?.removeAllRanges() } catch { /* noop */ }
        // Do NOT preventDefault — that would kill the click event for simple clicks.
        // onClickCapture suppresses clicks only when didDrag is true; selection is
        // already blocked by user-select:none + the selectstart/dragstart handlers.
      }

      const onMousemove = (e: MouseEvent) => {
        if (!isPanning) return
        const dx = e.clientX - panStartX, dy = e.clientY - panStartY
        if (!didDrag && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) didDrag = true
        // Only compute + queue here; the actual scroll write happens once per frame.
        pendingLeft = Math.max(0, panScrollLeft - dx)
        pendingTop  = Math.max(0, panScrollTop  - dy)
        if (!rafId) rafId = (doc.defaultView ?? window).requestAnimationFrame(applyPan)
      }

      const onMouseup = () => {
        if (!isPanning) return
        isPanning = false
        if (rafId) { (doc.defaultView ?? window).cancelAnimationFrame(rafId); rafId = 0 }
        // Final write so the view lands exactly on the last queued position.
        if (panScrollEl) { panScrollEl.scrollLeft = pendingLeft; panScrollEl.scrollTop = pendingTop }
        panScrollEl = null
        const cursor = grabModeRef.current ? 'grab' : ''
        if (doc.documentElement) doc.documentElement.style.cursor = cursor
        if (doc.body) doc.body.style.cursor = cursor
      }

      const onClickCapture = (e: MouseEvent) => {
        if (didDrag) { e.stopPropagation(); e.preventDefault(); didDrag = false }
      }

      // If the cursor leaves the iframe mid-drag (mouseup lands elsewhere), end the
      // pan so it can't get stuck panning or leave a pending rAF alive.
      const onMouseleave = () => { if (isPanning) onMouseup() }

      doc.addEventListener('wheel', onWheel, { passive: false })
      doc.addEventListener('click', onClick)
      doc.addEventListener('contextmenu', onContextMenu)
      doc.addEventListener('dblclick', onDblClick)
      doc.addEventListener('keydown', onMoveKey)
      // Also listen on the parent window: after a patch swap focus may sit in the parent doc,
      // so the iframe-level keydown wouldn't fire. moveSelRef gates it either way.
      window.addEventListener('keydown', onMoveKey)
      doc.addEventListener('mousedown', onMousedown)
      doc.addEventListener('mousemove', onMousemove)
      doc.addEventListener('mouseup', onMouseup)
      doc.addEventListener('mouseleave', onMouseleave)
      doc.addEventListener('click', onClickCapture, true)
      doc.addEventListener('selectstart', onSelectStart)
      doc.addEventListener('dragstart', onDragStart)
      // Close parent popovers when the Schedule is clicked.
      // Every dropdown in the app (Ocultar, Filtros, Datas, the header menus…) closes via
      // document.addEventListener('mousedown') + `!ref.contains(e.target)` on the PARENT
      // document. This Schedule lives in an iframe, and a press inside it never produces a
      // mousedown out there — so an open menu just sat there while the user clicked the
      // grid behind it. Forwarding one synthetic press to the parent makes all of them
      // close, with no per-component wiring to keep in sync as menus are added.
      //
      // Dispatched on document.body so `e.target` stays an Element (handlers cast it to a
      // Node and call contains(); body is never inside a popover, so every ref check reads
      // "outside" and closes). Capture phase, so it still fires if an inner handler stops
      // propagation; purely additive — the real event is neither cancelled nor modified.
      const onForwardPressToParent = () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      }
      doc.addEventListener('mousedown', onForwardPressToParent, true)
      // Expose the selection toggle so the grabMode effect can flip it live.
      grabSelectRef.current = setGrabSelect
      iframeCleanupRef.current = () => {
        if (rafId) { (doc.defaultView ?? window).cancelAnimationFrame(rafId); rafId = 0 }
        isPanning = false; panScrollEl = null
        grabSelectRef.current = null
        if (applyMoveHighlightRef.current === applyMoveHighlight) applyMoveHighlightRef.current = null
        doc.removeEventListener('wheel', onWheel)
        doc.removeEventListener('click', onClick)
        doc.removeEventListener('contextmenu', onContextMenu)
        doc.removeEventListener('dblclick', onDblClick)
        doc.removeEventListener('keydown', onMoveKey)
        window.removeEventListener('keydown', onMoveKey)
        doc.removeEventListener('mousedown', onMousedown)
        doc.removeEventListener('mousemove', onMousemove)
        doc.removeEventListener('mouseup', onMouseup)
        doc.removeEventListener('mouseleave', onMouseleave)
        doc.removeEventListener('click', onClickCapture, true)
        doc.removeEventListener('selectstart', onSelectStart)
        doc.removeEventListener('dragstart', onDragStart)
        doc.removeEventListener('mousedown', onForwardPressToParent, true)
      }
      // A fresh build wipes the document → re-apply the glow if a move is still active.
      applyMoveHighlight(doc)
    }

    worker.onmessage = event => {
      if (requestIdRef.current !== currentRequestId) return
      // Persistent worker: ignore late messages from a superseded build (its buildId
      // won't match the current one). Guards against a cancelled build's in-flight
      // 'chunk'/'done' corrupting the iframe of the build that replaced it.
      if (event.data?.buildId !== currentBuildId) return
      const { type, html, message } = event.data || {}

      if (type === 'start') {
        if (effectCancelled) return
        // In-place: don't touch the live document yet — keep old content on screen.
        if (inPlace) { inPlaceBuffer = '<!DOCTYPE html>'; return }
        const frame = iframeRef.current; if (!frame) return
        const doc = frame.contentDocument; if (!doc) return
        doc.open(); doc.write('<!DOCTYPE html>'); return
      }
      if (type === 'chunk') {
        if (effectCancelled) return
        // In-place: accumulate; the swap happens once at 'done'.
        if (inPlace) { inPlaceBuffer += String(html ?? ''); return }
        const frame = iframeRef.current; if (!frame) return
        const doc = frame.contentDocument; if (!doc) return
        doc.write(String(html ?? '')); return
      }
      if (type === 'progress') {
        onProgressRef.current?.(event.data.progress ?? 0); return
      }
      if (type === 'done') {
        if (effectCancelled) return
        const frame = iframeRef.current; if (!frame) return
        const doc = frame.contentDocument; if (!doc) return
        onProgressRef.current?.(0.95)

        // In-place swap: capture the current scroll, replace the whole document with
        // the buffered HTML in one shot, then restore scroll so the view doesn't jump.
        if (inPlace) {
          const win = frame.contentWindow
          const sel = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
          savedScrollLeft = sel?.scrollLeft ?? 0
          savedScrollTop  = sel?.scrollTop  ?? 0
          // Re-binding the iframe interactions requires the old listeners gone first.
          if (iframeCleanupRef.current) { iframeCleanupRef.current(); iframeCleanupRef.current = null }
          doc.open(); doc.write(inPlaceBuffer); doc.close()
          inPlaceBuffer = ''
        }

        let calledBack = false
        const finalize = () => {
          if (calledBack || effectCancelled) return
          calledBack = true
          onProgressRef.current?.(1)
          hasBuiltOnceRef.current = true
          const finalDoc = frame.contentWindow?.document
          if (finalDoc) {
            bindIframeInteractions(finalDoc)
            finalDoc.documentElement?.classList.toggle('loco-collapsed', locoNarrowOf(wsExpandRef.current))
            // Restore the pre-swap scroll position for in-place updates.
            if (inPlace) {
              const restoreEl = (finalDoc.scrollingElement ?? finalDoc.documentElement) as HTMLElement | null
              if (restoreEl) {
                restoreEl.scrollLeft = savedScrollLeft
                restoreEl.scrollTop  = savedScrollTop
              }
            } else {
              // Fresh period load (open / structural change): if Today falls inside the
              // loaded range, center the timeline horizontally on it instead of opening at
              // the far-left start. When Today is out of range no cell exists → no scroll
              // change (normal beginning-of-timeline behavior is preserved).
              // Same zoom-safe centring as the "Ir para hoje" button — bindIframeInteractions
              // above has already applied the zoom to this document, so offset-based maths
              // here would mis-centre at any zoom other than 1.
              const w = frame.contentWindow
              const cell = finalDoc.getElementById(`gantt_date_${localTodayIso()}`) as HTMLElement | null
              if (w && cell) w.scrollBy({ left: centerDeltaFor(cell, w), behavior: 'auto' })
            }
          }
          onBuiltRef.current?.()
        }
        frame.addEventListener('load', finalize, { once: true })
        const poll = () => {
          if (calledBack) return
          if ((frame.contentDocument?.readyState as string) === 'complete') { finalize(); return }
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
        if (!inPlace) doc.close()
        // Persistent worker — do NOT terminate; it stays alive for the next build.
        return
      }
      if (type === 'error') {
        if (effectCancelled) return
        const frame = iframeRef.current
        if (frame?.contentDocument) {
          frame.contentDocument.open()
          frame.contentDocument.write(`<div style="font-family:sans-serif;padding:16px;color:${RED_DK};font-size:12px;font-weight:600">${String(message ?? 'Falha ao montar o Gantt.')}</div>`)
          frame.contentDocument.close()
        }
        onBuiltRef.current?.()
        // Persistent worker — keep it alive even after an error so the next build
        // reuses it (cachedData was cleared worker-side, so it will refetch).
      }
    }

    worker.postMessage({
      type: 'build',
      payload: {
        buildId: currentBuildId,
        apiBaseUrl: api.defaults.baseURL ?? '',
        token: getToken(),
        forceReload: shouldForceReload,
        preloadedData: { ...data, date_info, groups },
        // FILTERS ARE VISUAL ONLY: `groups` above may have had stations stripped by a Workstation/
        // Área filter. Ship the UNFILTERED groups alongside so the worker resolves propagation, the
        // delay maths and the Protection-Days limit against every station and masks only the render
        // (see cachedFullByKey / applyOverrideForRender). null when nothing is filtered.
        fullGroups: filteredGroups ? data.groups : null,
        flatView,
        colorByWs,
        displacementMap: displacementMap ?? null,
        recoveredMap: recoveredMap ?? null,
        locoMeta: locoMeta ?? null,
        hideBeforeStart,
        // Row-level hide: the worker drops LOCOs with no activity today or later. Decided
        // there because it must run AFTER overrides are applied — an edit can move a
        // finished LOCO into the future, or push a future one into the past.
        hidePastLocos,
        allowOverlap,
        conflictWs: conflictWsList,
        overrides: overridesRef.current ?? {},
        referenceOverrides: referenceOverridesRef.current ?? {},
        // Expansion state, both tiers (base XOR exceptions) — from the ref, so every
        // rebuild (filters / Compare / optimization / needsRebuild fallback) preserves it.
        expandBase: wsExpandRef.current?.base ?? false,
        expandExceptions: wsExpandRef.current ? [...wsExpandRef.current.exceptions] : [],
        locoExpandBase: wsExpandRef.current?.locoBase ?? true,
        locoExpandExceptions: wsExpandRef.current ? [...wsExpandRef.current.locoExceptions] : [],
      },
    })

    return () => {
      effectCancelled = true
      // Persistent worker: tell it to abort this build but keep the instance alive
      // for the next one. The buildId guard drops any messages still in flight.
      // Actual termination happens only on component unmount (separate effect).
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'cancel' })
      }
      if (iframeCleanupRef.current) {
        iframeCleanupRef.current()
        iframeCleanupRef.current = null
      }
    }
  // When buildKey is provided, use it instead of data/filteredGroups object identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, buildKey !== undefined
    ? [buildKey, forceReloadToken, buildEnabled, flatView, colorByWs, displacementMap, recoveredMap, locoMeta, hideBeforeStart, hidePastLocos, allowOverlap, conflictWsList, patchRebuildNonce]
    : [data, filteredDateInfo, filteredGroups, forceReloadToken, buildEnabled, flatView, colorByWs, displacementMap, recoveredMap, locoMeta, hideBeforeStart, hidePastLocos, allowOverlap, conflictWsList, patchRebuildNonce])

  // Terminate the persistent worker only when the component unmounts (the per-build
  // cleanup above just sends 'cancel' and keeps it alive for reuse).
  useEffect(() => () => {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = 0
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) { e.preventDefault(); el.scrollLeft += e.deltaY }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [date_info])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      // Only the frozen WORKSTATION label cell (<td data-ws>) navigates — not the row <tr data-ws>
      // (which would fire for timeline/box/expanded-content clicks). Mirrors the iframe handler.
      const cell = (e.target as HTMLElement).closest('[data-ws]') as HTMLElement | null
      if (!cell || cell.tagName !== 'TD') return
      const wo      = cell.dataset.wo      ?? ''
      const task    = cell.dataset.task    ?? ''
      const ws      = cell.dataset.ws      ?? ''
      const subarea = cell.dataset.subarea ?? ''
      const linha   = cell.dataset.linha   ?? ''
      const startMs = cell.dataset.startMs ?? ''
      if (wo && task && ws) onWsClickRef.current?.(wo, task, ws, subarea || undefined, linha || undefined, startMs || undefined)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Surgical visual patch: ask the (persistent) worker to re-render ONLY the given LOCOs'
  // <tbody data-loco> blocks against the cached schedule, then swap them into the live
  // iframe in place — no full rebuild, scroll preserved. Used by manual LOCO edits so a
  // single edit is instant and LOCO-scoped.
  useImperativeHandle(ref, (): GanttTableHandle => ({
    patchLocos: (overrides: LocoOverrideMap, expand?: WsExpandState) => {
      const worker = workerRef.current
      const frame = iframeRef.current
      if (!worker || !frame || !overrides || Object.keys(overrides).length === 0) return
      const patchId = --patchIdRef.current
      // Expansion state for this patch: the explicit arg wins (a toggle handler passes the
      // freshly computed state — the prop/ref is one render stale at that moment). Hoisted
      // above onMsg because the narrow-layout class is synced from it after the swap.
      const ex = expand ?? wsExpandRef.current
      const onMsg = (e: MessageEvent) => {
        const d = e.data
        if (!d || d.type !== 'patched' || d.buildId !== patchId) return
        worker.removeEventListener('message', onMsg)
        // Worker refused the patch: with "Ocultar LOCOs concluídas" on, this edit changes the
        // trimmed axis or the hidden-row set — a tbody swap would misalign against the DOM's
        // header. Trigger a full in-place rebuild instead (scroll kept, overrides re-applied).
        if (d.needsRebuild) { setPatchRebuildNonce(n => n + 1); return }
        const doc = frame.contentDocument
        if (!doc) return
        const results: { locoKey: string; html: string }[] = d.results || []
        if (results.length === 0) return
        // Preserve scroll across the swap (replacing a tbody can nudge layout).
        const sel = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
        const sl = sel?.scrollLeft ?? 0, st = sel?.scrollTop ?? 0
        const byKey = new Map(results.map(r => [r.locoKey, r.html]))
        // Match by attribute value (locoKey may contain CSS-special chars → avoid selectors).
        doc.querySelectorAll('tbody[data-loco]').forEach(tb => {
          const key = tb.getAttribute('data-loco')
          const html = key != null ? byKey.get(key) : undefined
          if (html) (tb as HTMLElement).outerHTML = html
        })
        // Sync the narrow layout to the state this patch was rendered with: a LOCO-tier
        // toggle can enter/leave "all collapsed" (e.g. expanding one loco out of the compact
        // view restores the 220px WS column). Toggled BEFORE the scroll restore so the
        // restored offsets land on the final layout.
        doc.documentElement?.classList.toggle('loco-collapsed', locoNarrowOf(ex))
        if (sel) { sel.scrollLeft = sl; sel.scrollTop = st }
        // The swapped tbody is fresh HTML → re-apply the Move-Mode glow to the active row.
        applyMoveHighlightRef.current?.(doc)
      }
      worker.addEventListener('message', onMsg)
      const p = patchPropsRef.current
      // FULL live override map = the (possibly stale-by-one-render) `overrides` prop with this
      // patch's fresh entries folded on top ({} = cleared → removed). The worker needs the whole
      // map — not just the touched locos — to reproduce the hidePastLocos-trimmed axis, whose
      // bounds depend on EVERY visible loco's cells.
      const allOverrides: LocoOverrideMap = { ...(overridesRef.current ?? {}) }
      for (const [k, v] of Object.entries(overrides)) {
        if (!v || Object.keys(v).length === 0) delete allOverrides[k]
        else allOverrides[k] = v
      }
      worker.postMessage({
        type: 'patchLocos',
        payload: {
          buildId: patchId,
          overrides,
          allOverrides,
          referenceOverrides: referenceOverridesRef.current ?? {},
          colorByWs: p.colorByWs,
          hideBeforeStart: p.hideBeforeStart,
          hidePastLocos: p.hidePastLocos,
          displacementMap: p.displacementMap ?? null,
          recoveredMap: p.recoveredMap ?? null,
          locoMeta: p.locoMeta ?? null,
          allowOverlap: p.allowOverlap,
          conflictWs: p.conflictWs,
          expandBase: ex?.base ?? false,
          expandExceptions: ex ? [...ex.exceptions] : [],
          locoExpandBase: ex?.locoBase ?? true,
          locoExpandExceptions: ex ? [...ex.locoExceptions] : [],
        },
      })
    },
    computeEffective: (data: GanttData, overrides: LocoOverrideMap) => new Promise<GanttData>((resolve) => {
      // Spawned on demand, NOT taken from a build: this RPC is a pure function of (data, overrides) in
      // the worker and needs no build state, so it must answer even when the Schedule chart is disabled
      // and no build has ever run. Reading workerRef directly meant it resolved with its own input in
      // that case — the summary tabs silently lost every override. See ensureWorker.
      const worker = data ? ensureWorker() : null
      if (!worker || !data) { resolve(data); return }
      const reqId = --effIdRef.current
      let settled = false
      const finish = (out: GanttData) => { if (settled) return; settled = true; worker.removeEventListener('message', onMsg); resolve(out) }
      const onMsg = (e: MessageEvent) => {
        const d = e.data
        if (!d || d.type !== 'effectiveComputed' || d.reqId !== reqId) return
        finish(d.error ? data : (d.data as GanttData))
      }
      worker.addEventListener('message', onMsg)
      // Safety net: never leave the promise hanging if the worker is busy/unresponsive.
      setTimeout(() => finish(data), 8000)
      worker.postMessage({ type: 'computeEffective', payload: { reqId, data, overrides: overrides ?? {} } })
    }),
    computeGlobalCascade: (editedKey: string, editedWs: string, overrides: LocoOverrideMap, referenceOverrides: LocoOverrideMap, advance = false) => new Promise<GanttGlobalCascade>((resolve) => {
      const worker = workerRef.current
      const EMPTY: GanttGlobalCascade = { moves: [], wsLocos: [] }
      if (!worker || !editedKey || !editedWs) { resolve(EMPTY); return }
      const reqId = --cascIdRef.current
      let settled = false
      const finish = (out: GanttGlobalCascade) => { if (settled) return; settled = true; worker.removeEventListener('message', onMsg); resolve(out) }
      const onMsg = (e: MessageEvent) => {
        const d = e.data
        if (!d || d.type !== 'globalCascadeComputed' || d.reqId !== reqId) return
        finish(d.error ? EMPTY : { moves: d.moves ?? [], wsLocos: d.wsLocos ?? [] })
      }
      worker.addEventListener('message', onMsg)
      // Safety net: never leave the promise hanging if the worker is busy/unresponsive.
      setTimeout(() => finish(EMPTY), 8000)
      // Send the FULL, unfiltered groups + date_info so the cascade sees every workstation
      // (Protection Days included) regardless of any active WS/area/period filter.
      const full = fullDataRef.current
      worker.postMessage({ type: 'computeGlobalCascade', payload: { reqId, editedKey, editedWs, advance, overrides: overrides ?? {}, referenceOverrides: referenceOverrides ?? {}, groups: full?.groups ?? null, dateInfo: full?.date_info ?? null } })
    }),
    computeFreezeGeom: (locoKey: string, override: LocoVisualOverride | null | undefined, movedWs: (string | undefined)[]) =>
      new Promise<GanttFreezeGeom>((resolve) => {
        const worker = workerRef.current
        const EMPTY: GanttFreezeGeom = { geom: [], descGeom: [], pdSlack: null, pdSlackByRow: null }
        if (!worker || !locoKey) { resolve(EMPTY); return }
        const reqId = --freezeIdRef.current
        let settled = false
        const finish = (out: GanttFreezeGeom) => { if (settled) return; settled = true; worker.removeEventListener('message', onMsg); resolve(out) }
        const onMsg = (e: MessageEvent) => {
          const d = e.data
          if (!d || d.type !== 'freezeGeomComputed' || d.reqId !== reqId) return
          finish(d.error ? EMPTY : { geom: (d.geom ?? []), descGeom: (d.descGeom ?? []), pdSlack: (d.pdSlack ?? null), pdSlackByRow: (d.pdSlackByRow ?? null) })
        }
        worker.addEventListener('message', onMsg)
        setTimeout(() => finish(EMPTY), 8000)
        worker.postMessage({ type: 'computeFreezeGeom', payload: { reqId, locoKey, override: override ?? null, movedWs: movedWs ?? [] } })
      }),
    computeLandedSaturdays: (locoKey: string, override: LocoVisualOverride | null | undefined, movedWs: (string | undefined)[]) =>
      new Promise<Record<string, string[]>>((resolve) => {
        const worker = workerRef.current
        if (!worker || !locoKey) { resolve({}); return }
        const reqId = --freezeIdRef.current
        let settled = false
        const finish = (out: Record<string, string[]>) => { if (settled) return; settled = true; worker.removeEventListener('message', onMsg); resolve(out) }
        const onMsg = (e: MessageEvent) => {
          const d = e.data
          if (!d || d.type !== 'landedSaturdaysComputed' || d.reqId !== reqId) return
          finish(d.error || !d.sat ? {} : (d.sat as Record<string, string[]>))
        }
        worker.addEventListener('message', onMsg)
        setTimeout(() => finish({}), 8000)
        worker.postMessage({ type: 'computeLandedSaturdays', payload: { reqId, locoKey, override: override ?? null, movedWs: movedWs ?? [] } })
      }),
    // `ensureWorker` is a stable useCallback([]) — listed to satisfy exhaustive-deps without making
    // the handle identity churn (it never changes, so the handle is still built once).
  }), [ensureWorker])

  return (
    <div ref={scrollRef} className="overflow-auto w-full h-full select-none">
      <iframe
        ref={iframeRef}
        title="Gantt Schedule"
        className="w-full h-full border-0"
        style={{ background: '#fff' }}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  )
})
