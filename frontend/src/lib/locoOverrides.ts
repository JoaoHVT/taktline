// ── Locomotive visual-override layer ────────────────────────────────────────────────
// Editing a LOCO is a *visual/local override only*: instant, scoped to the edited LOCO,
// leaving the base GanttData untouched. Conceptually:
//
//     Original Data  +  Visual Override  =  Displayed Result
//
// This module owns the override MODEL + persistence seam (in-memory now, DB later) and the
// scalar date math the General Summary needs to display overridden Start/Finish. The actual
// Gantt cell-remap transform lives in the worker (public/gantt-table-worker.js, applyOverride
// ToGroup), since the worker is plain JS fetched from /public and can't import this module.
// No backend, no recompute:  Original Data + Visual Override = Displayed Result.
import { buildHolidaySet } from './ganttUtils'
import { api } from './api'
import type { GanttData } from './api'

// ── A single scoped edit (LOCO, Workstation, or Componente/description-row) ──────────
// The same three dimensions edit every level; `propagate` only matters for WS/Componente
// edits (cascade to SUBSEQUENT workstations). Duration is driven by `takt` (k×takt), so
// there is no separate duration field — the worker regenerates day-boxes and redistributes
// hours from the new takt-driven window.
export interface ScopedEdit {
  takt?: number            // new takt (drives takt-driven duration); undefined = keep base
  startShiftDays?: number  // ± business days (− earlier / + later)
  finishShiftDays?: number // ± business days applied to the finish
  propagate?: boolean      // WS/Componente only: shift subsequent workstations to preserve deps
  notes?: MoveNote[]       // why this box was moved — see MoveNote (newest LAST)
  satManual?: boolean      // LEGACY, persisted: authored in Move Mode. No longer grants blanket Saturday
                           // capability (older builds stamped it and a stale one re-summoned a promoted
                           // Saturday under any edited station — see satHand / satCapForEdit). Kept so
                           // existing saved overrides still load; ignored for Saturday occupancy.
  satHand?: boolean        // TRANSIENT, never persisted: the live Move-Mode preview marks the rows the
                           // planner is dragging RIGHT NOW so they may land on ANY working Saturday.
                           // Written only by paintMoveFreeze; the commit never carries it forward.
  satNever?: boolean       // PERSISTED, Move Mode (Space): "this station never occupies a Saturday".
                           // The INVERSE of every other sat field — a hard VETO, not a licence. When set,
                           // satCapForEdit short-circuits to `false` before satHand/satDays/natural are
                           // considered, so the station is laid out as if no Saturday were ever a working
                           // day: a Saturday inside its span is skipped and the box stretches past it.
                           // Deliberately outranks satHand, so a Space-flagged station cannot be dropped
                           // onto a Saturday mid-drag either. Applies to the WHOLE span, not just the
                           // landing day. A satNever-only entry (no shift) IS a real edit — see
                           // isEmptyScopedEdit.
  satDays?: string[]       // PERSISTED, NARROW Saturday licence: the exact working-Saturday ISO dates a
                           // committed Move-Mode landing occupies. Unlike the legacy blanket `satManual`
                           // it is scoped to these dates only, so promoting a DIFFERENT Saturday later
                           // grants nothing (no auto-allocation). Computed by the worker at commit
                           // (computeLandedSaturdays) so it always equals what the satHand preview showed;
                           // this is what makes a Saturday landing survive Enter. See satCapForEdit.
  swap?: boolean           // WS40↔WS50 manual swap: a pure position TRADE, not a delay/recovery —
                           // the vacated days are taken by the partner WS, so the trade itself must not
                           // paint a displacement/recovery hatch. Lives/dies with the shift like
                           // satManual; carried forward. See `swapShift` for HOW it is suppressed.
  swapShift?: { start: number; finish: number }
                           // The swap's OWN contribution to this WS's shift, recorded when the swap is
                           // performed. `startShiftDays` is cumulative (a swap composes with edits made
                           // before and after it), so the flag alone cannot say how much of the current
                           // position is "the trade" and how much is a real delay.
                           //
                           // This splits them: the hatch/delay REFERENCE for a swapped WS is
                           // base ⊕ swapShift, so the trade contributes 0 (as before) while any
                           // subsequent move is measured — and reported — normally. Previously the
                           // worker skipped swapped stations outright, which permanently exempted them
                           // from delay maths: swap, then push the WS three days late, and nothing
                           // registered. Absent on overrides saved before this existed; the worker
                           // then falls back to the edit's full shift, which is exactly the swap's
                           // contribution for a swap that has not been moved since.
  parallelStarts?: boolean // Propagation only: should stations that START ON THE SAME DAY as this one
                           // follow the shift it generates? DEFAULT ON — `undefined` and `true` both
                           // mean on, so only an explicit `false` opts out and no migration is needed
                           // for edits saved before this existed. Keeping parallel activities together
                           // is the normal expectation; a planner turns it off when the parallel work
                           // is meant to diverge. Read by the worker's applyWsEdits group pass.
  removeGaps?: boolean     // Propagation only: CONSUME the idle days downstream instead of carrying them
                           // along. Default OFF (`undefined`/`false`), so every edit saved before this
                           // existed keeps the gap-preserving cascade and no migration is needed.
                           // ON, each station after this one is packed to start the business day right
                           // after its predecessor finishes, so a delay is absorbed by the free time
                           // ahead of it before it is pushed any further. Read by applyWsEdits.
  hoursTotal?: number      // Componente-scope ONLY: new TOTAL hours for the DESCRIÇÃO, kept at the
                           // SAME duration. The worker rescales every part-number row of the
                           // Componente to this total (proportional split) — feeds the Plano de
                           // Produção item hours. Independent of takt/shift; carried forward on moves.
}

// ── Manual Saturday allocation (business rule) ─────────────────────────────────────────────
// Baseline rule: only WS40/WS50 may occupy a working Saturday. That rule is the OPTIMIZER's, and it
// stays exactly as it is — capacity, WS eligibility, automatic scheduling and scenario simulation
// are all untouched.
//
// `satManual` is the deliberate exception: a planner moving a box in Move Mode may put ANY
// workstation on a Saturday that has been registered as a working day. Because the flag lives on
// the EDIT rather than on the workstation, the permission is scoped exactly to the rows a human
// moved by hand — an optimizer-baked override never carries it (see bakeGanttDiffToOverrides), so
// replaying a saved optimization keeps the WS40/WS50-only calendar.
//
// It is set by Move Mode on every move (not only ones that land on a Saturday): the row has to be
// able to STEP onto a working Saturday for the planner to land on one at all. It is inert unless a
// working Saturday actually exists on the axis — an ordinary Saturday is off the business-day axis
// entirely. Like `notes`, it is carried forward by later edits of the same box, so a follow-up
// tweak can never silently bounce a row off the Saturday a planner put it on.

// ── Move descriptions ("por que este movimento?") ─────────────────────────────────────
// A Move Mode commit may carry a free-text REASON. Reasons are HISTORY: moving the same box
// again APPENDS an entry, so a box keeps a readable trail of why it drifted over time. The
// prompt's "Override" action instead collapses the trail to the single latest reason.
//
// They ride INSIDE the existing ScopedEdit payload — schedule_override.payload_json is a
// free-form Text column — so the trail costs no extra table, no extra row and no migration.
// Both caps below are re-enforced server-side (_clean_move_notes in main.py); payload_json is
// read on every schedule load, so it has to stay small.
//
// A trail belongs to ONE box: a multi-row move stores the reason on the FIRST (topmost) row
// only, which is also the only row that renders the indicator. Clearing that row's edit drops
// its reasons with it — a reason with no move left to explain is orphaned.
export interface MoveNote {
  text: string       // the observation, plain text (escaped at render time — see esc() in the worker)
  by: string         // author (the permissions username), for the popover byline
  at: string         // ISO timestamp of the move
  category?: string  // mandatory reason classification (one of MOVE_CATEGORIES); absent on legacy notes
  pdOverLimit?: boolean // VISUAL ONLY: this move finished BEYOND the Protection-Days limit (the planner
                        // acknowledged the crossing warning — see MovePdWarningPrompt/GanttModal). Stamped
                        // fresh on the newest note of every committed move, so the corner badge reflects the
                        // CURRENT position: an over-limit move renders a more prominent red wedge; a later
                        // move back inside appends a note without it and the badge returns to normal. Never
                        // affects scheduling — the shift itself is stored/applied identically.
}
export const MOVE_NOTE_MAX_LEN = 280      // one observation
export const MOVE_NOTE_MAX_ENTRIES = 20   // trail depth; the oldest fall off first

// Mandatory move/edit classification. The prompt forces exactly ONE of these before a move can be
// saved; the free-text "Observação" stays optional. Order below is the display order (as specified).
// Mirrored server-side in main.py (_MOVE_NOTE_CATEGORIES) — the client is not the authority.
// 'Recovery Plan' is the recovery-action label: it is auto-selected (and the category becomes
// OPTIONAL) when a move reduces an existing delay — see the recovery detection in GanttModal and
// the `recovery` path in MoveNotePrompt. It is offered in the category dropdown ONLY on a recovery
// move: a delay-creating move must not be able to file a recovery plan, so MoveNotePrompt filters it
// out of the selectable list unless `recovery` is set.
export const RECOVERY_PLAN_CATEGORY = 'Recovery Plan'
// Observation auto-filled (alongside the pre-selected category) when a delay-reducing move is detected.
// Distinct from the category label so the trail records that the classification was auto-applied; the
// user may edit or clear it before saving. See the `recovery` path in MoveNotePrompt.
export const RECOVERY_PLAN_AUTO_NOTE = 'Recovery Plan Auto'
export const MOVE_CATEGORIES = [
  'Estoque', 'Máquina', 'Material', 'Mão-de-obra', 'Produção', 'Qualidade', RECOVERY_PLAN_CATEGORY,
] as const
export type MoveCategory = typeof MOVE_CATEGORIES[number]

// System-authored classification stamped on a manual WS40↔WS50 swap (never user-selectable, so
// it is intentionally NOT in MOVE_CATEGORIES). Mirrored in the server allowlist (_MOVE_NOTE_CATEGORIES
// in main.py) so the note's category survives persistence, and rendered by the SAME move-note badge/
// trail every other override uses. See the swap handler in GanttModal.
export const MANUAL_SWAP_CATEGORY = 'Manual Swap'

/** Fold a new reason into a box's trail. `override` collapses it to just this reason; `append`
 *  keeps the history. Returns undefined for an empty trail so the payload never carries a
 *  `notes: []`. Whitespace is collapsed, which also strips newlines/control characters — the
 *  trail is rendered into a `title` attribute. The category is mandatory in the prompt, so an
 *  entry is recorded even when the observation text is empty. */
export function applyMoveNote(
  prev: MoveNote[] | undefined, text: string, by: string, mode: 'append' | 'override',
  category?: string | null, pdOverLimit?: boolean,
): MoveNote[] | undefined {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MOVE_NOTE_MAX_LEN)
  const cat = String(category ?? '').trim()
  if (!clean && !cat) return prev?.length ? prev : undefined
  const entry: MoveNote = { text: clean, by: String(by ?? ''), at: new Date().toISOString() }
  if (cat) entry.category = cat
  if (pdOverLimit) entry.pdOverLimit = true
  return mode === 'override' ? [entry] : [...(prev ?? []), entry].slice(-MOVE_NOTE_MAX_ENTRIES)
}

// ── A manually-added workstation ("Adicionar Workstation") ───────────────────────────
// A workstation a planner inserted into a LOCO that does NOT exist in the source schedule. Unlike
// `ScopedEdit` (a DELTA against an existing station), this MATERIALIZES a brand-new station, so it
// carries the station's whole geometry as an ABSOLUTE anchor (a new station has no base to shift
// from). Once the worker injects it into the group (applyOverrideToGroup → _injectAddedWorkstations),
// ordinary `ws`/`desc` edits keyed by the same name compose on top of it exactly like a real station:
// Move Mode, delay, propagation, editing and reset all work with no special-casing. It is Standard/
// Projeção-only — Original mode renders base data with no override map, so it never appears there.
export interface AddedWorkstation {
  ws: string           // workstation name — also the map key (wsEditKeyOf); unique within the LOCO
  startIso: string     // absolute start date 'YYYY-MM-DD'
  durationDays: number // > 0 — business-day length
  hoursTotal: number   // ≥ 0 — spread across the day-boxes (feeds Plano de Produção)
  itemQty: number      // ≥ 0 — Plano de Produção "Qtd"
  workorder: string    // WO pattern/model → Plano de Produção "WORKORDER"
  desc?: string        // Componente label; defaults to `ws`
  subarea?: string     // optional sub-área; defaults to ''
  // ÁREA the station belongs to. Drives the Área filter in the Schedule and the área grouping in
  // Plano de Produção, exactly like a native station's `ws.area`. The dialog offers an existing área,
  // a brand-new one (just type it — an área is only ever a label on the station, so nothing has to be
  // "created" anywhere), or NONE: an empty/absent value is a real choice and keeps the station
  // unassociated, which both consumers already handle (native rows carry '' too).
  area?: string
  // "Propagar efeitos imediatamente" (creation-time, default OFF). Creating a station is an INSERTION:
  // it occupies time the schedule did not have, so the work after it CAN be pushed to clear it. The flag
  // lives HERE rather than in a ws-scope ScopedEdit because an edit carrying only `propagate` counts
  // as empty (isEmptyScopedEdit) and would be dropped on save — and the station itself never takes a
  // shift, since creation must not generate its own delay. The worker reads it off the injected
  // station and publishes the insertion push (see applyWsEdits).
  propagate?: boolean
}

// A LOCO's override is the LOCO-level edit (top-level fields, unchanged) PLUS optional finer
// per-workstation (`ws`) and per-description-row (`desc`) edits. Editing one level never
// touches the others' base unless propagation explicitly cascades.
export interface LocoVisualOverride {
  takt?: number            // LOCO-level new takt/duration; undefined = keep base
  startShiftDays?: number  // LOCO-level ± business days applied to the whole LOCO
  finishShiftDays?: number // LOCO-level ± business days applied to the finish only
  ws?: Record<string, ScopedEdit>    // key = wsEditKeyOf(ws) — a workstation/station
  desc?: Record<string, ScopedEdit>  // key = descEditKeyOf(ws, subarea, desc) — one Componente
  addWs?: Record<string, AddedWorkstation>  // key = wsEditKeyOf(ws) — a manually-inserted station
}

/** True when a manually-added workstation carries no usable geometry (so callers can drop it). */
export function isEmptyAddedWs(a: AddedWorkstation | undefined): boolean {
  if (!a) return true
  return !a.ws || !a.startIso || !(a.durationDays > 0)
}

// Keyed by the same stable LOCO identity the worker/iframe uses: linha||wo||task||start_ms.
export type LocoOverrideMap = Record<string, LocoVisualOverride>

export function locoKeyOf(g: { linha: string; wo: string; task_name: string; start_ms?: string | number | null }): string {
  return `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
}

// Scoped-edit keys. The UI and the worker MUST derive these identically so an edit written
// by the panel matches the workstation/row the worker re-renders.
export function wsEditKeyOf(ws: string): string {
  return String(ws ?? '')
}
// A "Componente" is the deduped description row the user sees in FULL mode (the renderer groups
// raw desc_rows by their `desc` text within a workstation), so identity = ws + subarea + desc.
export function descEditKeyOf(ws: string, subarea: string | null | undefined, desc: string | null | undefined): string {
  return `${ws ?? ''}||${subarea ?? ''}||${desc ?? ''}`
}

/** True when a scoped edit carries no actual change. */
export function isEmptyScopedEdit(ov: ScopedEdit | undefined): boolean {
  if (!ov) return true
  const { takt, startShiftDays, finishShiftDays, hoursTotal, swap, swapShift } = ov
  // `propagate` alone (with no dimension change) is not an edit — and neither is `notes`: a
  // reason exists to explain a move, so it lives and dies with the move it describes. `hoursTotal`
  // IS a real edit (it rescales the Componente's hours even with no position change).
  //
  // A WS40↔WS50 SWAP is a real change too, even at a net-zero shift. The two stations trade slots, so
  // their shifts are equal and opposite (+4 / −4); anything that later drives one of them back to a net
  // 0 — a Global-propagation recovery pull is the usual way — left an entry holding only the swap
  // markers. Treating that as empty DELETED the entry, and with it the trade: the station re-rendered
  // from base, i.e. back in its PRE-SWAP slot, while its partner stayed put. That is the "editing and
  // propagating makes a swapped workstation revert to its pre-swap reference" report. An UN-swap still
  // collapses to empty as before, because it clears `swap`/`swapShift` explicitly (see unswapItem).
  //
  // `satNever` is a real change for the same reason: it is a standing geometry constraint the planner
  // set by hand (Space in Move Mode). It routinely carries NO shift — flagging a station that does not
  // currently touch a Saturday is the normal, preventive use — so collapsing it to empty would drop the
  // veto on save and let a later edit slide the box onto a Saturday the planner had ruled out.
  if (swap || swapShift || ov.satNever) return false
  return takt == null && !startShiftDays && !finishShiftDays && hoursTotal == null
}

/** True when the override carries no actual change at any level (so callers can drop it). */
export function isEmptyOverride(ov: LocoVisualOverride | undefined): boolean {
  if (!ov) return true
  const { takt, startShiftDays, finishShiftDays, ws, desc, addWs } = ov
  const locoEmpty = takt == null && !startShiftDays && !finishShiftDays
  const wsEmpty = !ws || Object.values(ws).every(isEmptyScopedEdit)
  const descEmpty = !desc || Object.values(desc).every(isEmptyScopedEdit)
  // A manually-added workstation is a real change even with no ws/desc edit on it — it brings a whole
  // station into being, so an override that only carries addWs must NOT be dropped.
  const addEmpty = !addWs || Object.values(addWs).every(isEmptyAddedWs)
  return locoEmpty && wsEmpty && descEmpty && addEmpty
}

// ── scalar date helper (for the General Summary's displayed Start/Finish/Duration) ──
// Self-contained business-day shift (skips weekends + holidays), so the summary can shift a
// displayed start/finish date without needing the Gantt's date_info axis. Mirrors how the
// worker translates bars along business days.
function _isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function shiftIsoByBusinessDays(iso: string | number | null | undefined, n: number): string | null {
  if (iso == null || iso === '') return null
  const s = String(iso).slice(0, 10)
  if (s.length < 10) return s
  if (!n) return s
  const y = Number(s.slice(0, 4))
  const holidays = buildHolidaySet([y - 1, y, y + 1])
  const d = new Date(s + 'T12:00:00')
  const step = n > 0 ? 1 : -1
  let remaining = Math.abs(n)
  while (remaining > 0) {
    d.setDate(d.getDate() + step)
    const dow = d.getDay()
    if (dow === 0 || dow === 6) continue
    if (holidays.has(_isoOf(d))) continue
    remaining--
  }
  return _isoOf(d)
}

/** INCLUSIVE business-day span between two ISO dates — the exact inverse of
 *  `shiftIsoByBusinessDays(start, n - 1)`, so a station starting and ending on the same working day
 *  is 1 day long. Weekends and holidays are skipped by the same rule as the shift above. Returns
 *  null when either date is unusable or `end` falls before `start`; a non-working `end` counts the
 *  working days up to it (it is snapped back by the loop's own filter). */
export function businessDaysBetweenIso(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  const s = String(startIso ?? '').slice(0, 10)
  const e = String(endIso ?? '').slice(0, 10)
  if (s.length < 10 || e.length < 10 || e < s) return null
  const y = Number(s.slice(0, 4))
  const holidays = buildHolidaySet([y - 1, y, y + 1, Number(e.slice(0, 4))])
  const d = new Date(s + 'T12:00:00')
  const stop = new Date(e + 'T12:00:00')
  let n = 0
  // Cap the walk so a wild date can never spin: ~10 years of days is far beyond any real station.
  for (let guard = 0; d <= stop && guard < 4000; guard++) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6 && !holidays.has(_isoOf(d))) n++
    d.setDate(d.getDate() + 1)
  }
  return n > 0 ? n : null
}

// ── persistence seam (in-memory today; future DB) ───────────────────────────────────
// Save/Load go through here only. Today they keep a module-level snapshot (survives tab
// remounts within a session); the future DB write/read replaces the bodies, nothing else.
let _snapshot: LocoOverrideMap = {}
// True once we've pulled the persisted (DB) overrides for this page load. After that the in-memory
// snapshot governs same-session reopens, so unsaved live edits aren't clobbered by a refetch.
let _dbHydrated = false

// ── Active scenario identity ─────────────────────────────────────────────────────────
// All persistence (load/save/reset) is scoped to ONE scenario so each imported scenario keeps its
// own edits and they never leak across scenarios. The key is the scenario NAME ('' = the base DB
// schedule). Switching scenarios resets the hydration state so the next load pulls THAT scenario's
// saved overrides instead of reusing the previous one's.
let _activeScenario = ''
export function getActiveScenario(): string { return _activeScenario }
export function setActiveScenario(key: string | null | undefined): void {
  const next = key || ''
  if (next === _activeScenario) return
  _activeScenario = next
  _snapshot = {}
  _savedBaseline = {}
  _dbHydrated = false
  _satWorkdays = []
  _satHydrated = false
  // The Projeção layer is per-scenario too — leaving it behind would stack one scenario's
  // simulation on top of another's operational plan.
  _projSnapshot = {}
  _projSavedBaseline = {}
  _projHydrated = false
}

// ── Saved baseline (the DB-persisted reference state) ────────────────────────────────
// The "saved baseline" is the override map currently persisted in the database. UNSAVED edits are
// the diff between the live working map and THIS baseline — not the original imported schedule — so
// the edit counter returns to 0 right after a successful save, and Reset reverts only unsaved edits
// (already-saved ones are kept). Module-scoped so it survives a modal close/reopen within a page
// load, exactly like _snapshot. Updated on hydrate (DB read), save (DB write), and clear.
let _savedBaseline: LocoOverrideMap = {}
export function getSavedBaseline(): LocoOverrideMap {
  return JSON.parse(JSON.stringify(_savedBaseline))
}

// `notes` is part of the signature: a move description is a persisted change, so writing one must
// register as an unsaved edit (otherwise the footer count stays 0 and Save never lights up).
function _scopedSig(e: ScopedEdit): string {
  return JSON.stringify([
    e.takt ?? null, e.startShiftDays ?? 0, e.finishShiftDays ?? 0, !!e.propagate,
    (e.notes ?? []).map(n => `${n.at}|${n.category ?? ''}|${n.text}`), !!e.satManual,
    // The Saturday VETO is persisted and changes geometry, so toggling it must light up Save.
    !!e.satNever,
    // `swap` and `hoursTotal` are persisted changes too: a pure "Horas totais" edit (no shift) or a
    // swap must register as UNSAVED, or the footer count stays 0 and the close-warning never fires.
    // `swapShift` rides along for the same reason — it is what the delay maths reads (see ScopedEdit).
    !!e.swap, e.hoursTotal ?? null, e.swapShift ? [e.swapShift.start, e.swapShift.finish] : null,
    // Normalized to the effective value (absent = ON) so toggling it off and back on is not counted
    // as an unsaved change against a map that simply never stored the field.
    e.parallelStarts !== false,
    // The committed Saturday licence is a persisted change: a move that gains/loses a landed Saturday
    // must count as unsaved. Sorted so order can't spuriously flip the signature.
    (e.satDays ?? []).slice().sort(),
  ])
}
/** Signature of a manually-added workstation — every geometry field that a save persists, so an edit
 *  to any of them counts as an unsaved change (mirrors _clean_added_ws on the server). */
function _addedWsSig(a: AddedWorkstation): string {
  return JSON.stringify([
    a.ws ?? '', a.startIso ?? '', a.durationDays ?? 0, a.hoursTotal ?? 0,
    a.itemQty ?? 0, a.workorder ?? '', a.desc ?? '', a.subarea ?? '', a.area ?? '', a.propagate === true,
  ])
}
/** Flatten a map to per-OBJECT signatures (`locoKey|scope|scopeKey` → JSON), dropping no-op scopes,
 *  so two maps can be diffed object-by-object. */
function _flattenSignatures(map: LocoOverrideMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const [locoKey, ov] of Object.entries(map || {})) {
    if (!ov) continue
    if (ov.takt != null || ov.startShiftDays || ov.finishShiftDays)
      out.set(`${locoKey}|loco`, JSON.stringify([ov.takt ?? null, ov.startShiftDays ?? 0, ov.finishShiftDays ?? 0]))
    if (ov.ws)   for (const [k, e] of Object.entries(ov.ws))   if (!isEmptyScopedEdit(e)) out.set(`${locoKey}|ws|${k}`,   _scopedSig(e))
    if (ov.desc) for (const [k, e] of Object.entries(ov.desc)) if (!isEmptyScopedEdit(e)) out.set(`${locoKey}|desc|${k}`, _scopedSig(e))
    // A manually-added workstation is its own persisted object — adding/editing/removing one must
    // register as an unsaved edit so the footer count moves and the close-guard fires.
    if (ov.addWs) for (const [k, a] of Object.entries(ov.addWs)) if (!isEmptyAddedWs(a)) out.set(`${locoKey}|addws|${k}`, _addedWsSig(a))
  }
  return out
}
/** Number of UNSAVED edits = edited objects that DIFFER between the working map and the saved
 *  baseline (added, removed, or modified). Equals 0 exactly when working === saved. */
export function countUnsavedEdits(working: LocoOverrideMap, baseline: LocoOverrideMap): number {
  const w = _flattenSignatures(working)
  const b = _flattenSignatures(baseline)
  let n = 0
  for (const k of new Set<string>([...w.keys(), ...b.keys()])) if (w.get(k) !== b.get(k)) n++
  return n
}

export function snapshotOverrides(map: LocoOverrideMap): void {
  _snapshot = JSON.parse(JSON.stringify(map))
}

// ── Session restore seam ──────────────────────────────────────────────────────
// Loading an exported session must re-install the Gantt edits (LOCO/WS/Componente
// overrides) that were live when the session was saved — WITHOUT a later DB hydrate
// silently overwriting them. We therefore install the map as BOTH the working
// snapshot and the saved baseline for the given scenario, and mark hydration DONE so
// hydrateOverridesFromDb() returns this map instead of round-tripping to the DB.
// The session is treated as the authoritative "saved" state (edit counter starts at 0).
export function seedOverridesFromSession(scenario: string | null | undefined, map: LocoOverrideMap): void {
  _activeScenario = scenario || ''
  const clone = JSON.parse(JSON.stringify(map || {}))
  _snapshot = clone
  _savedBaseline = JSON.parse(JSON.stringify(clone))
  _dbHydrated = true
}

/** Merge two override maps: `base` (e.g. the DB-loaded overrides) underneath `over` (e.g. edits the
 *  user made before the async load resolved), with `over` winning per LOCO field and per ws/desc key.
 *  Used so a fresh-load hydrate NEVER discards already-saved overrides even if the user started
 *  editing first — both survive, and the next save persists the union (not just the latest edit). */
export function mergeOverrideMaps(base: LocoOverrideMap, over: LocoOverrideMap): LocoOverrideMap {
  const out: LocoOverrideMap = JSON.parse(JSON.stringify(base || {}))
  for (const [k, ov] of Object.entries(over || {})) {
    const b = out[k]
    out[k] = b
      ? { ...b, ...ov, ws: { ...(b.ws ?? {}), ...(ov.ws ?? {}) }, desc: { ...(b.desc ?? {}), ...(ov.desc ?? {}) }, addWs: { ...(b.addWs ?? {}), ...(ov.addWs ?? {}) } }
      : ov
  }
  return out
}

export function loadOverrides(): LocoOverrideMap {
  return JSON.parse(JSON.stringify(_snapshot))
}

// ── Projeção reference snapshot (Schedule Mode 3 "Projeção") ───────────────────────────────────
// A FROZEN copy of the standard override map — the deviation baseline a planner set with "Atualizar
// referência". Mode 3 measures the current schedule against THIS, not against the live-moving saved
// baseline (if it tracked every Save the projection would always read ~0 — the whole point).
//
// It is itself a LocoOverrideMap, so it is stored SHARED in the DB (schedule_override table, reserved
// Projeção namespace on the server) exactly like the base overrides: Editor+ writes it, everyone
// reads it. Per scenario. An empty map = no reference frozen yet.
export async function hydrateProjectionRefFromDb(scenario: string): Promise<LocoOverrideMap> {
  try {
    const res = await api.get<LocoOverrideMap>('/api/gantt/projection-ref', { params: { scenario } })
    return (res.data && typeof res.data === 'object') ? res.data : {}
  } catch {
    return {}   // offline / no DB → no reference (callers fall back to the saved standard)
  }
}
export async function saveProjectionRefToDb(scenario: string, map: LocoOverrideMap, password: string): Promise<void> {
  // Editor+ only, same application password as the override save — both validated server-side BEFORE
  // any write, so a wrong password (403) persists nothing.
  await api.put('/api/gantt/projection-ref', { overrides: map, password, scenario })
}

// ── Projeção reference VERSION HISTORY (Option A: versioned baselines + absorption ledger) ────────
// Each "Atualizar referência" freeze APPENDS a version instead of overwriting, so the accumulated
// delay history is never lost. INCREMENTAL deviation is measured against the LATEST version (as before);
// CUMULATIVE deviation is measured against version 0 (the first freeze = the reference of record).
// Editor+ appends; everyone reads. Per scenario. Supersedes the single-snapshot endpoints above (which
// stay in sync server-side for back-compat and are adopted as version 0 when no versions exist yet).
export interface ProjectionBaseline {
  version:   number
  label:     string | null
  createdAt: string | null   // ISO timestamp; null for a legacy snapshot adopted as version 0
  createdBy: string | null
  overrides: LocoOverrideMap
}
export async function hydrateProjectionBaselinesFromDb(scenario: string): Promise<ProjectionBaseline[]> {
  try {
    const res = await api.get<{ versions?: unknown }>('/api/gantt/projection-baselines', { params: { scenario } })
    const raw = Array.isArray(res.data?.versions) ? res.data!.versions : []
    return raw
      .map((v): ProjectionBaseline | null => {
        if (!v || typeof v !== 'object') return null
        const o = v as Record<string, unknown>
        if (typeof o.version !== 'number') return null
        return {
          version:   o.version,
          label:     typeof o.label === 'string' ? o.label : null,
          createdAt: typeof o.created_at === 'string' ? o.created_at : null,
          createdBy: typeof o.created_by === 'string' ? o.created_by : null,
          overrides: (o.overrides && typeof o.overrides === 'object') ? o.overrides as LocoOverrideMap : {},
        }
      })
      .filter((v): v is ProjectionBaseline => v !== null)
      .sort((a, b) => a.version - b.version)
  } catch {
    return []   // offline / no DB → no history (callers fall back to the saved standard)
  }
}
export async function saveProjectionBaselineToDb(scenario: string, map: LocoOverrideMap, label?: string): Promise<number> {
  // Editor+ AND the ADMIN second factor (backend require_editor_unlock) — NOT the import password. The
  // X-Admin-Unlock grant auto-attaches via the api interceptor; a missing/expired grant returns 401 and
  // the interceptor prompts for ADMIN_PASSWORD and retries. Appends a new version; returns its index.
  const res = await api.put<{ version?: number }>('/api/gantt/projection-baselines', { overrides: map, scenario, label: label ?? null })
  return typeof res.data?.version === 'number' ? res.data.version : 0
}

// ── Bake an optimization result into ordinary overrides ("save after optimize") ──────────────
// The conflict optimizer only DISPLACES whole LOCOs/workstations or SWAPS WS40↔WS50 — both are pure
// business-day repositioning, exactly what the override layer stores. So the optimizer's result over
// the base schedule is expressible as per-workstation start/finish day-shifts, and "save after
// optimize" persists it through the SAME proven override path instead of a re-run — readers reload it
// as a plain saved schedule with no solver and no indicators.

/** Diff an OPTIMIZED schedule against its BASE, per workstation, into start/finish business-day
 *  shifts keyed to the ORIGINAL loco identity (so they apply to base data on reload). The override
 *  key is the ws alone, so all sub-areas of a ws move together (the optimizer shifts a ws uniformly).
 *  Off-axis Saturday cells (WS40/WS50 recovery) fold to the nearest business day here — unless that
 *  Saturday is a registered workday, in which case it is already on the base axis and kept in place. */
export function bakeGanttDiffToOverrides(base: GanttData, opt: GanttData): LocoOverrideMap {
  // Business-day axis of the BASE schedule (what overrides reload onto): weekends + holidays excluded.
  const axis = base.date_info.filter(d => !d.is_weekend && !d.is_holiday).map(d => d.iso).sort()
  const idxOf = new Map<string, number>(axis.map((iso, i) => [iso, i]))
  // Nearest business-day index at or before `iso` (folds a Saturday onto the preceding workday).
  const idxAtOrBefore = (iso: string): number => {
    const exact = idxOf.get(iso); if (exact != null) return exact
    let lo = 0, hi = axis.length - 1, ans = 0
    while (lo <= hi) { const m = (lo + hi) >> 1; if (axis[m] <= iso) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans
  }
  const delta = (from: string, to: string): number => idxAtOrBefore(to) - idxAtOrBefore(from)

  // Combined first/last allocated ISO across every desc_row of every workstation sharing `wsKey`
  // (the override key is the ws alone). Returns [first, last] or null when the ws has no cells.
  const wsSpan = (g: GanttData['groups'][number], wsKey: string): [string, string] | null => {
    let first: string | undefined, last: string | undefined
    for (const w of g.workstations) {
      if (wsEditKeyOf(w.ws) !== wsKey) continue
      for (const dr of w.desc_rows) for (const iso of Object.keys(dr.cells)) {
        if (first == null || iso < first) first = iso
        if (last  == null || iso > last)  last  = iso
      }
    }
    return first != null && last != null ? [first, last] : null
  }

  const optByKey = new Map<string, GanttData['groups'][number]>()
  for (const g of opt.groups) optByKey.set(`${g.wo}||${g.task_name}`, g)

  const map: LocoOverrideMap = {}
  for (const bg of base.groups) {
    const og = optByKey.get(`${bg.wo}||${bg.task_name}`)
    if (!og) continue
    const wsKeys = new Set<string>()
    for (const w of bg.workstations) wsKeys.add(wsEditKeyOf(w.ws))
    const wsEdits: Record<string, ScopedEdit> = {}
    for (const wsKey of wsKeys) {
      const bs = wsSpan(bg, wsKey); const os = wsSpan(og, wsKey)
      if (!bs || !os) continue
      const startShiftDays  = delta(bs[0], os[0])
      const finishShiftDays = delta(bs[1], os[1])
      if (!startShiftDays && !finishShiftDays) continue
      const e: ScopedEdit = {}
      if (startShiftDays)  e.startShiftDays  = startShiftDays
      if (finishShiftDays) e.finishShiftDays = finishShiftDays
      wsEdits[wsKey] = e
    }
    if (Object.keys(wsEdits).length) map[locoKeyOf(bg)] = { ws: wsEdits }
  }
  return map
}

/** Add two scoped shifts (business-day shifts stack; takt = the manual one wins; propagate OR-s;
 *  move descriptions follow the manual edit, since the optimizer never authors one). */
function _addScoped(a: ScopedEdit | undefined, b: ScopedEdit | undefined): ScopedEdit {
  const out: ScopedEdit = {}
  const s = (a?.startShiftDays ?? 0) + (b?.startShiftDays ?? 0)
  const f = (a?.finishShiftDays ?? 0) + (b?.finishShiftDays ?? 0)
  if (s) out.startShiftDays = s
  if (f) out.finishShiftDays = f
  const takt = b?.takt ?? a?.takt
  if (takt != null) out.takt = takt
  if (a?.propagate || b?.propagate) out.propagate = true
  // Rebuilt from scratch like every other field, so notes must be carried explicitly or a
  // "save after optimize" would silently discard why the user moved a box.
  const notes = b?.notes ?? a?.notes
  if (notes?.length) out.notes = notes
  // Same for the manual-Saturday permission — `a` is the optimizer's baked shift, which never
  // grants it, so this only ever carries the planner's own Move Mode edit forward.
  if (a?.satManual || b?.satManual) out.satManual = true
  // The Saturday VETO is authored only by hand (Space in Move Mode); the optimizer bake never sets it.
  // Carry it forward or a save-after-optimize would silently lift a constraint the planner set.
  if (a?.satNever || b?.satNever) out.satNever = true
  // The committed Saturday licence (satDays) is authored only by manual moves; carry it forward (manual
  // wins) or a save-after-optimize would drop the working-Saturday landing a planner placed by hand.
  const satDays = (b?.satDays && b.satDays.length) ? b.satDays : (a?.satDays && a.satDays.length ? a.satDays : null)
  if (satDays) out.satDays = satDays
  // The manual layer may carry a WS40↔WS50 swap marker or a Componente "Horas totais" override; the
  // optimizer bake never authors either, so carry them forward (manual wins) or a save-after-optimize
  // would silently drop the swap's no-hatch flag / the component's rescaled hours.
  if (a?.swap || b?.swap) out.swap = true
  const swapShift = b?.swapShift ?? a?.swapShift
  if (swapShift) out.swapShift = swapShift
  const hoursTotal = b?.hoursTotal ?? a?.hoursTotal
  if (hoursTotal != null) out.hoursTotal = hoursTotal
  // Opting OUT of parallel propagation is the deliberate choice, so it survives the merge: if either
  // layer turned it off, the sum stays off. (ON is the default and needs no field.)
  if (a?.parallelStarts === false || b?.parallelStarts === false) out.parallelStarts = false
  return out
}

// ── Working-Saturday set (per scenario) ──────────────────────────────────────────────────────
// A saved optimization that used "Usar Sábados" places WS40/WS50 work on Saturdays. Overrides live
// on the business-day axis, which normally excludes Saturdays — so to RETAIN those placements we
// register the used Saturdays as working days for the scenario. The client then flips date_info to
// mark them is_weekend=false (applySaturdayWorkdays) so they join the axis and the baked overrides
// land on them. Persisted per scenario in the SAME editor + app-password lane as the overrides.
let _satWorkdays: string[] = []
let _satHydrated = false

const _SAT_WS = new Set(['WS40', 'WS50'])
const _wsNorm = (s: string): string => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
const _isSaturdayIso = (iso: string): boolean => new Date(`${iso}T00:00:00Z`).getUTCDay() === 6

/** Pull the scenario's working-Saturday set ONCE per load (cached after). Falls back to the cache on
 *  failure so a transient error never drops registered Saturdays. */
export async function hydrateSaturdayWorkdays(): Promise<string[]> {
  if (_satHydrated) return [..._satWorkdays]
  try {
    const res = await api.get<string[]>('/api/gantt/saturday-workdays', { params: { scenario: _activeScenario } })
    _satWorkdays = Array.isArray(res.data) ? res.data.filter(s => typeof s === 'string') : []
    _satHydrated = true
    return [..._satWorkdays]
  } catch {
    return [..._satWorkdays]
  }
}
/** Persist the scenario's working-Saturday set (Editor/Admin + app password, validated server-side). */
export async function saveSaturdayWorkdays(dates: string[], password: string): Promise<void> {
  await api.put('/api/gantt/saturday-workdays', { dates, password, scenario: _activeScenario })
  _satWorkdays = [...dates]
  _satHydrated = true
}

/** Flip is_weekend→false for the registered working Saturdays so they join the business-day axis.
 *  Non-mutating; returns the SAME reference when nothing changes (keeps upstream memoization stable). */
export function applySaturdayWorkdays(data: GanttData | null, saturdays: string[]): GanttData | null {
  if (!data || !saturdays || saturdays.length === 0) return data
  const set = new Set(saturdays)
  let changed = false
  const date_info = data.date_info.map(d => {
    if (set.has(d.iso) && d.is_weekend) { changed = true; return { ...d, is_weekend: false } }
    return d
  })
  return changed ? { ...data, date_info } : data
}

/** ISO Saturday dates that WS40/WS50 ops occupy in an optimized schedule (i.e. the Saturdays the
 *  optimizer USED). Baking registers exactly these — nothing global — so they persist on reload. */
export function collectOptimizerSaturdays(opt: GanttData | null): string[] {
  if (!opt) return []
  const out = new Set<string>()
  for (const g of opt.groups) for (const w of g.workstations) {
    if (!_SAT_WS.has(_wsNorm(w.ws))) continue
    for (const dr of w.desc_rows) for (const iso of Object.keys(dr.cells)) {
      if (_isSaturdayIso(iso)) out.add(iso)
    }
  }
  return [...out].sort()
}

/** Fold live MANUAL overrides (authored relative to the OPTIMIZED view) on top of the BAKED
 *  base→optimized shifts. Since base ⊕ baked = optimized, the manual edits then apply exactly as they
 *  did on screen, so base ⊕ result = optimized ⊕ manual = the final displayed schedule. ws-scope
 *  shifts ADD (they stack on the baked shift); loco- and desc-scope edits (and takt) carry as-is —
 *  they're already relative to the optimized positions the baked ws-shift reproduces. */
export function combineBakedWithManual(baked: LocoOverrideMap, manual: LocoOverrideMap): LocoOverrideMap {
  const out: LocoOverrideMap = JSON.parse(JSON.stringify(baked || {}))
  for (const [locoKey, mov] of Object.entries(manual || {})) {
    if (!mov) continue
    const r = (out[locoKey] ??= {})
    // loco-scope: baked never sets these, so this is just the manual loco shift (kept relative to opt).
    const ls = _addScoped(
      { startShiftDays: r.startShiftDays, finishShiftDays: r.finishShiftDays, takt: r.takt },
      { startShiftDays: mov.startShiftDays, finishShiftDays: mov.finishShiftDays, takt: mov.takt },
    )
    r.takt = ls.takt; r.startShiftDays = ls.startShiftDays; r.finishShiftDays = ls.finishShiftDays
    if (mov.ws) { r.ws ??= {}; for (const [k, e] of Object.entries(mov.ws)) r.ws[k] = _addScoped(r.ws[k], e) }
    if (mov.desc) r.desc = { ...(r.desc ?? {}), ...JSON.parse(JSON.stringify(mov.desc)) }
  }
  for (const k of Object.keys(out)) if (isEmptyOverride(out[k])) delete out[k]
  return out
}

// ── DB persistence (base schedule) ───────────────────────────────────────────────────
// The schedule_override table is a pure DELTA store: Original Data + Override = Effective.
// These calls never touch the source schedule. The merge into the final schedule happens on
// the client (the worker's applyOverrideToGroup), so the original data stays untouched.

// ── Hydration retry budget, per error class ──────────────────────────────────────────────
// A flat 6-attempt exponential ladder used to run on EVERY failure, and each of those attempts
// additionally paid the axios interceptor's own refresh/transient retry. When an endpoint failed
// PERMANENTLY (the projection-overrides 500 from the NUL-byte scenario_id) that was ~12 identical
// failing requests per page load, per hydrator — the reported 500/503 log storm.
//
//   401 → the token may genuinely still be warming up right after a page load (MSAL not ready, so
//         even the interceptor's silent refresh can fail). Worth a couple of tries, no more.
//   403 → authoritative authorization failure. Never retried.
//   5xx → the server answered and failed. Retrying cannot change that.
//   no response (network/timeout) → one retry, for a genuine blip.
// Failing here is SAFE by design: `_dbHydrated` stays false, so a later call retries and a save
// still re-hydrates before writing — it can never delete rows this page load didn't read.
function _hydrateAttempts(err: unknown): number {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status === 401) return 3
  if (typeof status === 'number') return 1   // 403 or any other answered error: no retry
  return 2                                   // no response at all: one retry
}

/** Pull the saved base-schedule overrides ONCE per page load, mirror them into the in-memory
 *  snapshot, and return them. Later calls return the current snapshot with no network round-trip
 *  (so same-session unsaved edits survive a modal reopen, as before). Falls back to the in-memory
 *  snapshot if the DB/endpoint is unavailable. */
export async function hydrateOverridesFromDb(): Promise<LocoOverrideMap> {
  if (_dbHydrated) return loadOverrides()
  // CRITICAL: we mark `_dbHydrated` only on SUCCESS. Caching a failed (empty) load would make the
  // next save believe there are no prior overrides and DELETE them all (the save mirrors the full
  // map) — which is exactly the "only one row survives / edits don't persist" bug. On failure we
  // leave `_dbHydrated` false and `_savedBaseline` untouched so a later call can still load, and a
  // save can't wipe unread rows.
  let budget = 3   // upper bound; narrowed by the first error's class (see _hydrateAttempts)
  for (let attempt = 0; attempt < budget; attempt++) {
    try {
      const res = await api.get<LocoOverrideMap>('/api/gantt/overrides', { params: { scenario: _activeScenario } })
      const map = (res.data && typeof res.data === 'object') ? res.data : {}
      _snapshot = JSON.parse(JSON.stringify(map))
      _savedBaseline = JSON.parse(JSON.stringify(map))   // the DB state is the saved baseline
      _dbHydrated = true
      return JSON.parse(JSON.stringify(_snapshot))
    } catch (err) {
      budget = Math.min(budget, _hydrateAttempts(err))
      if (attempt + 1 >= budget) break
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt))
    }
  }
  return loadOverrides()   // transient failure persisted — do NOT mark hydrated; allow a later retry
}

/** Persist the current override map (the Save action) — incremental upsert/delete server-side.
 *  Requires the application import password (IMPORT_PASSWORD), validated server-side BEFORE any
 *  write: a wrong password rejects (403) and persists nothing. The in-memory snapshot is only
 *  updated AFTER a successful write, so a rejected save leaves the local state untouched. */
export async function saveOverridesToDb(map: LocoOverrideMap, password: string): Promise<void> {
  // Safety against the "save wipes the DB" failure mode: the server save mirrors the FULL posted map
  // (upsert present, delete absent). If we never successfully loaded the DB state (slow/failed token
  // on this page load), persisting the bare working map would DELETE every override we hadn't read.
  // So if not yet hydrated, pull the current DB state first and merge the working edits ON TOP — the
  // save then persists the UNION, never dropping previously-saved overrides. (No-op once hydrated.)
  let toSave = map
  if (!_dbHydrated) {
    const dbNow = await hydrateOverridesFromDb()
    toSave = mergeOverrideMaps(dbNow, map)
  }
  await api.put('/api/gantt/overrides', { overrides: toSave, password, scenario: _activeScenario })
  _snapshot = JSON.parse(JSON.stringify(toSave))
  _savedBaseline = JSON.parse(JSON.stringify(toSave))   // what we just persisted is the new baseline
  _dbHydrated = true
}

// ── Projeção OVERRIDE LAYER (three-layer model: Original → Standard → Projeção) ────────────────
// A SECOND, independent LocoOverrideMap stacked on top of the standard one:
//     Standard = Original + standard overrides      (deviation reference: Original)
//     Projeção = Standard + THESE overrides         (deviation reference: the LIVE Standard)
//
// Composition is `mergeOverrideMaps(standard, projection)` — a per-OBJECT replace, not an addition.
// That is the correct operator because `startShiftDays` is absolute-from-base: a Projeção edit states
// where the object should sit, so an object Projeção never touched transparently inherits Standard,
// and one it did touch is fully described by its own entry. It also means a later Standard edit to an
// object Projeção has already overridden stays masked in Projeção — which is exactly "each layer
// inherits only from the layer immediately beneath it".
//
// Kept as its own snapshot/baseline/hydration triple (not a variant of the standard ones) so the two
// layers have fully independent unsaved-edit counters and saves: a simulation can never be published
// into the operational plan by accident.
let _projSnapshot: LocoOverrideMap = {}
let _projSavedBaseline: LocoOverrideMap = {}
let _projHydrated = false

export function loadProjOverrides(): LocoOverrideMap {
  return JSON.parse(JSON.stringify(_projSnapshot))
}
export function getProjSavedBaseline(): LocoOverrideMap {
  return JSON.parse(JSON.stringify(_projSavedBaseline))
}
export function snapshotProjOverrides(map: LocoOverrideMap): void {
  _projSnapshot = JSON.parse(JSON.stringify(map))
}

/** Pull the saved Projeção layer ONCE per page load. Same retry/no-cache-on-failure contract as
 *  hydrateOverridesFromDb — caching a failed (empty) load would make the next save believe the layer
 *  was empty and DELETE every stored projection edit. */
export async function hydrateProjOverridesFromDb(): Promise<LocoOverrideMap> {
  if (_projHydrated) return loadProjOverrides()
  let budget = 3   // same per-error-class budget as hydrateOverridesFromDb (see _hydrateAttempts)
  for (let attempt = 0; attempt < budget; attempt++) {
    try {
      const res = await api.get<LocoOverrideMap>('/api/gantt/projection-overrides', { params: { scenario: _activeScenario } })
      const map = (res.data && typeof res.data === 'object') ? res.data : {}
      _projSnapshot = JSON.parse(JSON.stringify(map))
      _projSavedBaseline = JSON.parse(JSON.stringify(map))
      _projHydrated = true
      return JSON.parse(JSON.stringify(_projSnapshot))
    } catch (err) {
      budget = Math.min(budget, _hydrateAttempts(err))
      if (attempt + 1 >= budget) break
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt))
    }
  }
  return loadProjOverrides()   // transient failure — do NOT mark hydrated; allow a later retry
}

/** Persist the Projeção layer. Mirrors saveOverridesToDb, including the un-hydrated union guard that
 *  stops a save from deleting rows this page load never managed to read. */
export async function saveProjOverridesToDb(map: LocoOverrideMap, password: string): Promise<void> {
  let toSave = map
  if (!_projHydrated) {
    const dbNow = await hydrateProjOverridesFromDb()
    toSave = mergeOverrideMaps(dbNow, map)
  }
  await api.put('/api/gantt/projection-overrides', { overrides: toSave, password, scenario: _activeScenario })
  _projSnapshot = JSON.parse(JSON.stringify(toSave))
  _projSavedBaseline = JSON.parse(JSON.stringify(toSave))
  _projHydrated = true
}

/** Clear all saved base-schedule overrides (the global Reset). */
export async function clearSavedOverrides(): Promise<void> {
  _snapshot = {}
  _savedBaseline = {}
  _dbHydrated = true
  await api.delete('/api/gantt/overrides', { params: { scenario: _activeScenario } })
}
