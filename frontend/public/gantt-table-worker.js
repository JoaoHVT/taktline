/* eslint-disable no-restricted-globals */

const RED = '#D32F2F'
const RED_DK = '#B71C1C'
const RED_LT = '#FFEBEE'
// Allowed-overlap border (orange): a shared target-WS cell that is a valid boundary
// handoff under the "Permitir regras de sobreposição" rule — not a true conflict.
const ORANGE = '#F57C00'
const DAY_BORDER = '1px'
const FROZEN_LEFT_PAD = 0

// ── Tipo registry — MIRROR of src/lib/tipos.ts ───────────────────────────────
// This file is plain JS served by URL and cannot import the TS registry, so it keeps its own
// copy. It lists the SCHEDULE-BACKED Tipos only, and that is not an omission: a Tipo whose
// hours do not come from the Schedule produces no groups for the worker to lay out, so it can
// never reach this file at all. `tests/worker/tipos-parity.test.js` fails the build if the two
// lists drift apart.
//
// Three separate copies of this classifier used to live in this file (_locoTypeOf,
// _tipoGeralWorker and the ranking switch). They are now one function with three names.
const WORKER_TIPOS = [
  { key: 'new_locos',    linhas: ['Special Line', 'Main Line'] },
  { key: 'overhaul',     linhas: ['Overhaul'] },
  { key: 'motor_diesel', linhas: ['Motor Diesel'] },
  { key: 'propulsion',   linhas: ['Propulsion'] },
]
const _TIPO_BY_LINHA = new Map()
for (const _t of WORKER_TIPOS) for (const _l of _t.linhas) _TIPO_BY_LINHA.set(_l.trim().toLowerCase(), _t.key)
const _SCHEDULE_TIPOS = new Set(WORKER_TIPOS.map(t => t.key))

/** Schedule "Linha" → Tipo. Must agree with tipos.tipoOfLinha, or overlap DETECTION and
 *  overlap RENDERING disagree about the same two boxes. */
function tipoOfLinha(linha) {
  return _TIPO_BY_LINHA.get(String(linha == null ? '' : linha).trim().toLowerCase()) || 'other'
}
/** True when this Tipo's hours come from the Schedule. 'other' and anything unregistered
 *  answer false — the safe direction: an unknown Tipo is not admitted to a scheduling rule. */
function isScheduleBackedTipo(tipo) { return _SCHEDULE_TIPOS.has(tipo) }
const FW_LIGHT = ['#DCEEFB', '#DDF3D4', '#FCE4D6', '#FFF3C4', '#E0D4F5', '#D4F0E8', '#FFF0CB', '#F2DFF8']
// Palette for "color by workstation" mode — 20 distinct light tones
const WS_COLORS = [
  '#DCEEFB', '#DDF3D4', '#FCE4D6', '#FFF3C4',
  '#E0D4F5', '#D4F0E8', '#FFF0CB', '#F2DFF8',
  '#FFE5EC', '#E8F5E9', '#FFF8E1', '#E3F2FD',
  '#F3E5F5', '#E0F7FA', '#FFF3E0', '#EDE7F6',
  '#FDECEA', '#E8EAF6', '#F9FBE7', '#FCE4EC',
]
const COL_NW_PX = 2.4 * 16
const COL_W_PX = 5.5 * 16
let cachedData = null
// Memoized merged+reordered groups for the last cachedData, so a surgical patchLocos
// (single-LOCO re-render) doesn't repeat the 50-200 ms merge/reorder pass.
let cachedAllGroups = null
let cachedAllGroupsFor = null
// ── FILTERS ARE VISUAL ONLY ────────────────────────────────────────────────────────────────────
// A Workstation/Área filter STRIPS stations out of the groups the main thread sends us to render
// (scheduleFilteredGroups). Scheduling must never see that stripped set: a hidden station still
// propagates its cascade to the ones after it, and a hidden PROTECTIONDAYS block still caps how far
// a move may travel. So the build also ships the UNFILTERED groups, indexed here by loco key, and
// every computation resolves overrides against those — the result is masked back down to the visible
// stations only at the very end (applyOverrideForRender / _maskToVisible).
// null when no filter is active: then the rendered groups ARE the full set and nothing is masked, so
// the unfiltered code path is byte-identical to the old behaviour.
let cachedFullByKey = null
let cachedFullFor = null
// Same memo for the computeEffective path (the summary-tab merge). Keyed by the source-data
// identity so a burst of edits — which resends the SAME effectiveData with only `overrides`
// changed — skips the 50-200 ms merge/reorder and only re-applies the edited groups.
let cachedEffBase = null
let cachedEffBaseFor = null
let cachedEffAxis = null
// View geometry of the LAST FULL BUILD while "Ocultar LOCOs concluídas" (hidePastLocos) was on:
// the trimmed axis bounds + which LOCOs survived the row filter. The DOM table's header/columns
// are fixed by that build, so a surgical patch (handlePatchLocos) MUST render its rows against
// this same axis — and when an edit would change it (a move crossing the visible boundary, or a
// row entering/leaving the hidden set), the patch is refused and the main thread does a full
// in-place rebuild instead. Rendering a patch against the full axis while the table shows a
// trimmed one is exactly what corrupted the Gantt (misaligned/overflowing rows). null while the
// last build ran without hidePastLocos.
let lastViewTrim = null
// Cancellation flag — set by the 'cancel' message, checked between chunks so the loop
// can abort cleanly even while the async build handler is suspended at an await point.
let cancelPending = false

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildFwIndex(dateInfo) {
  const idx = {}
  let seq = 0
  for (const d of dateInfo) {
    if (!(d.fw in idx)) {
      idx[d.fw] = seq % FW_LIGHT.length
      seq += 1
    }
  }
  return idx
}

// Fiscal month (1-12) of a fiscal week under the 4-4-5 pattern. MIRRORS
// ganttUtils.fwToMonth445 (Summary's mapping) — keep in sync. The Schedule header
// shows the FISCAL month of each FW, not the calendar month of its first day.
function _fwToMonth445(fw) {
  const n = parseInt(String(fw).replace(/\D/g, ''), 10)
  if (isNaN(n) || n < 1) return 1
  if (n <= 4)  return 1
  if (n <= 8)  return 2
  if (n <= 13) return 3
  if (n <= 17) return 4
  if (n <= 21) return 5
  if (n <= 26) return 6
  if (n <= 30) return 7
  if (n <= 34) return 8
  if (n <= 39) return 9
  if (n <= 43) return 10
  if (n <= 47) return 11
  return 12
}

/**
 * FISCAL year of a fiscal week, given any calendar date inside it.
 *
 * A 4-4-5 fiscal week does not respect the January 1st boundary: the last week of fiscal 2026
 * (FW52 → fiscal month 12) can run into the first days of CALENDAR 2027. Labelling it with
 * `iso.slice(0,4)` therefore printed "2027 DEZ FW52" for a week that belongs to 2026 — the year and
 * the week number described different years.
 *
 * The fiscal month implied by the FW versus the calendar month of the date resolves it: a large
 * positive gap (fiscal 12 vs calendar 1) means the week started in the PREVIOUS calendar year, and a
 * large negative gap (fiscal 1 vs calendar 12) means it belongs to the NEXT one. Half a year is the
 * threshold — no legitimate 4-4-5 skew comes anywhere near it.
 */
function _fw445FiscalYear(iso, fw) {
  const calYear = Number(iso.slice(0, 4))
  const calMonth = Number(iso.slice(5, 7))
  if (!calYear || !calMonth) return calYear
  const fiscalMonth = _fwToMonth445(fw)
  if (fiscalMonth - calMonth >= 6) return calYear - 1
  if (calMonth - fiscalMonth >= 6) return calYear + 1
  return calYear
}

function buildWsIndex(groups) {
  // Color is shared per WORKSTATION across the whole schedule (every LOCO + every view mode), so a
  // given workstation always gets one consistent color. Key by the NORMALIZED ws name (_wsNormKey)
  // so the same workstation stored with different casing/spacing in different LOCOs ("WS40" vs
  // "WS 40") still maps to a single color slot. All color lookups must normalize the same way.
  const idx = {}
  let seq = 0
  for (const g of groups) {
    for (const w of g.workstations) {
      const k = _wsNormKey(w.ws)
      if (!(k in idx)) { idx[k] = seq % WS_COLORS.length; seq += 1 }
    }
  }
  return idx
}

function mergeGroups(groups) {
  const merged = []
  const byLocoKey = new Map()
  for (const g of groups) {
    // Include start_ms so same-named LOCOs from different periods stay independent
    const locoKey = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    let target = byLocoKey.get(locoKey)
    if (!target) {
      target = {
        ...g,
        workstations: g.workstations.map(w => ({ ...w, desc_rows: [...w.desc_rows] })),
      }
      byLocoKey.set(locoKey, target)
      merged.push(target)
      continue
    }

    // Keep the earliest start_ms across all records for this LOCO
    if (g.start_ms != null) {
      const incomingSm = String(g.start_ms).slice(0, 10)
      const existingSm = target.start_ms != null ? String(target.start_ms).slice(0, 10) : null
      if (existingSm == null || incomingSm < existingSm) target.start_ms = g.start_ms
    }

    const wsMap = new Map(target.workstations.map(w => [`${w.ws}||${w.subarea ?? ''}`, w]))
    for (const wst of g.workstations) {
      const wsKey = `${wst.ws}||${wst.subarea ?? ''}`
      const existing = wsMap.get(wsKey)
      if (existing) {
        existing.desc_rows = [...existing.desc_rows, ...wst.desc_rows]
      } else {
        const clone = { ...wst, desc_rows: [...wst.desc_rows] }
        target.workstations.push(clone)
        wsMap.set(wsKey, clone)
      }
    }
  }
  return merged
}

function easterDate(y) {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(y, month - 1, day)
}

function shiftDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function isoStr(d) {
  return d.toISOString().split('T')[0]
}

// Holidays are now computed SERVER-SIDE from the admin-editable calendar and delivered
// per day on date_info (d.is_holiday). The worker no longer recomputes its own BR holiday
// calendar — it just collects the flagged days into a Set so the existing holidays.has(iso)
// checks below keep working unchanged. This is the single source of truth shared with the
// backend engine and the rest of the frontend.
function holidaySetFromDateInfo(dateInfo) {
  const holidays = new Set()
  for (const d of (dateInfo || [])) {
    if (d && d.is_holiday) holidays.add(d.iso)
  }
  return holidays
}

function safeId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '_')
}

// "WORKSTATION - SUBAREA" label for box/column text. When WS and SUBAREA are the
// same value ignoring case (e.g. "PROPULSION"/"Propulsion"), show only the WS — the
// dash form would be redundant. Display-only; never touches grouping/keys/colors.
function wsSubLabel(ws, subarea, sep) {
  const w = String(ws ?? '')
  const s = String(subarea ?? '')
  if (!s) return w
  if (w.trim().toLowerCase() === s.trim().toLowerCase()) return w
  return `${w} ${sep || '-'} ${s}`
}

// Frozen LINHA / MODELO / LOCO labels are drawn VERTICALLY (writing-mode:vertical-rl), so a
// long value's intrinsic height grows DOWN the column and can force the whole row taller than
// the standard 34px component row. Cap that height at 3× a component row (102px) and shrink the
// font when the text would overflow, so the label fits without pushing the row past the cap.
// Returns the inline style fragment to drop onto the vertical label <div> (font-size + hard cap).
const FROZEN_ROW_PX = 34            // standard component row height
const FROZEN_LABEL_MAX_H = FROZEN_ROW_PX * 3   // 102px — never let a name force more than 3 rows
const FROZEN_MIN_LOCO_H = FROZEN_ROW_PX * 3    // 102px — LOCO-mode row height; the floor a filtered LOCO keeps
function frozenLabelStyle(text, baseFontPx, availHeightPx) {
  const n = String(text == null ? '' : text).length
  // The rotated label runs DOWN the cell, so its usable length is the cell's rendered HEIGHT
  // (rowspan × row height) — NOT a fixed cap. Passing the real height lets the font scale UP as the
  // view gets taller (expanded LOCO tree) and back DOWN when compact (collapsed summary row), always
  // on a single line. `avail` is what bounds the font AND the max-height, so the text never exceeds
  // the cell it already occupies → row height is unaffected. Font is clamped to [8px, baseFontPx]:
  // baseFontPx is the STANDARD size and the hard ceiling (never larger, only shrink from it).
  const avail = (typeof availHeightPx === 'number' && availHeightPx > 0) ? availHeightPx : FROZEN_LABEL_MAX_H
  // Vertical (text-orientation:mixed) glyph advance along the column ≈ 0.6 × font-size.
  const fit = n > 0 ? avail / (n * 0.6) : baseFontPx
  const font = Math.max(8, Math.min(baseFontPx, Math.round(fit * 10) / 10))
  return `font-size:${font}px;max-height:${avail}px;overflow:hidden;line-height:1.05;white-space:nowrap`
}

// LOCO-mode (collapsed summary row) per-day workstation display — Strategy A ranking.
// For Type = New Locos, when several workstations compete on the SAME day the collapsed row
// shows only the highest-ranked one (lower index = higher priority). Workstations not in the
// list are unranked (Infinity); a day whose competing WS are ALL unranked falls back to the
// aggregate "N WS" display (Strategy B). Display-only: never touches scheduling/hours/keys.
const NEW_LOCOS_WS_PRIORITY = ['WS11', 'WS111', 'WS12', 'WS112', 'WS40', 'WS50', 'WS13', 'WS113',
                               'WS42', 'WS55', 'WS155']
// Motor Diesel has its own priority list, so that type now uses Strategy A too (it previously
// fell through to the "N WS" aggregate). Names are multi-word; the rank key strips whitespace,
// so 'DESMONTAGEM MD' and 'DESMONTAGEMMD' resolve to the same entry.
const MOTOR_DIESEL_WS_PRIORITY = ['DESMONTAGEM MD', 'PERITAGEM MD', 'MONTAGEM MD']
// Shared key normalizer — the ranks are built through it so a spaced source name can never
// silently miss its own entry (the lookup already normalized, the table did not).
const _wsRankKey = ws => String(ws == null ? '' : ws).trim().toUpperCase().replace(/\s+/g, '')
const _newLocosWsRank    = new Map(NEW_LOCOS_WS_PRIORITY.map((w, i) => [_wsRankKey(w), i]))
const _motorDieselWsRank = new Map(MOTOR_DIESEL_WS_PRIORITY.map((w, i) => [_wsRankKey(w), i]))
function newLocosWsRank(ws) {
  const k = _wsRankKey(ws)
  return _newLocosWsRank.has(k) ? _newLocosWsRank.get(k) : Infinity
}
function motorDieselWsRank(ws) {
  const k = _wsRankKey(ws)
  return _motorDieselWsRank.has(k) ? _motorDieselWsRank.get(k) : Infinity
}
// The ranking function for a LOCO type, or null when that type has none (→ Strategy B).
function wsRankFnForType(type) {
  // A ranking is a statement about the ORDER OF STATIONS a LOCO passes through on the
  // Schedule. A Tipo with no Schedule behind it has no such order, so it is refused by the
  // flag rather than by falling through the two `if`s below — same answer today, but it stays
  // correct when a Tipo is registered that would otherwise have needed a third `if`.
  if (!isScheduleBackedTipo(type)) return null
  if (type === 'new_locos')    return newLocosWsRank
  if (type === 'motor_diesel') return motorDieselWsRank
  return null
}

// Workstations allowed to operate on Saturdays BY SCHEDULING RULE. Only the conflict-resolution
// target WS (WS40/WS50) can be scheduled on a Saturday; every other WS is Saturday-blocked. This is
// the OPTIMIZER's rule and it is deliberately absolute: capacity, WS eligibility, automatic
// scheduling and simulation all read it and none of them may be relaxed.
const SAT_CAPABLE_WS = new Set(['WS40', 'WS50'])
function isSatCapableWs(ws) {
  return SAT_CAPABLE_WS.has(String(ws || '').trim().toUpperCase().replace(/\s+/g, ''))
}
// Effective capability for ONE row, given the visual override acting on it AND whether the row is
// ALREADY allocated on a Saturday.
//
// A working Saturday only makes the day AVAILABLE — registering it must never, on its own, schedule
// work there. Promoting a Saturday inserts a slot into the axis, and granting capability from the
// workstation NAME alone (WS40/WS50) meant every later edit of those stations silently absorbed it:
// an unrelated +1 cascade upstream slid WS40 from Fri onto the Saturday nobody had asked it to work.
// So on the manual-edit paths a Saturday is occupiable only when:
//   • the planner put the row there — `satManual`, set only by Move Mode on the rows a human actually
//     moved (see lib/locoOverrides.ts); or
//   • the row is a Saturday-eligible station (WS40/WS50) that ALREADY holds a Saturday allocation —
//     an optimizer/backend one, or a previously saved manual one. Re-laying such a row must keep the
//     Saturday it genuinely works, so replaying a baked optimization is unaffected.
// A user "explicitly causing work to occupy the day" is exactly case one; everything else leaves the
// Saturday empty and available.
//
// CAPABILITY IS PER-SATURDAY, NOT BLANKET. Returning a plain `true` for a row that already works ONE
// Saturday made EVERY Saturday occupiable for it, including days promoted long afterwards — so
// registering a new working day silently re-laid the row across it. What a row has earned is the right
// to keep the Saturdays it ALREADY works, so that is exactly what is granted: the list of them. A day
// nobody has allocated stays invisible to the arithmetic, which is what makes promoting a Saturday a
// strict no-op for every committed row (see also _occupiable).
//
// THE BLANKET LICENCE IS TRANSIENT (`satHand`), NOT PERSISTED. It is written ONLY by the live Move-Mode
// preview (paintMoveFreeze), on the rows a planner is dragging RIGHT NOW — precisely "the user
// explicitly causing work to occupy the day" — and it unlocks ANY workstation. It never survives into
// the saved override, so a normal re-lay never carries it.
//
// A PERSISTED `satManual` is deliberately NOT consulted here. Older builds stamped it onto committed
// edits, and granting it blanket capability meant that promoting a Saturday months later re-summoned
// it under any edited station that carried the stale flag — even a non-eligible one — pulling a
// Fri→Mon allocation nobody touched onto the new Saturday (the reported "edited locos misbehave, clean
// ones are fine"). Such a row keeps only the Saturdays it ACTUALLY occupies, via `sats`, like any
// other. (No current commit path writes satManual, so nothing is lost by ignoring it.)
//
// A PERSISTED `satDays` (string[] of ISO dates) is the durable, NARROW licence: the exact Saturdays a
// committed Move-Mode landing occupied. It bypasses the isSatCapableWs gate (a hand move may land ANY
// station on a promoted Saturday) but is scoped to those specific dates, so promoting a DIFFERENT
// Saturday later grants nothing — the auto-allocation hole a blanket persisted flag reopened. Written
// only by resolveMoveProp, from the worker's own computeLandedSaturdays measurement, so it always
// equals what the preview (satHand) showed.
//
// Returns: true (blanket) | string[] (only these Saturday ISOs) | false.
// Use this ONLY on manual-edit paths; the optimizer's own paths must keep calling isSatCapableWs.
function satCapForEdit(ws, edit, sats) {
  // HARD VETO first (Move Mode, Space): "this station never occupies a Saturday". It must outrank every
  // licence below — including satHand, the live-drag permission — or a flagged station could still be
  // dropped onto a Saturday mid-drag and only bounce off it on release. Returning false makes every
  // Saturday non-occupiable for this station, so one inside its span is SKIPPED and the box stretches
  // past it, exactly as for a station that was never Saturday-capable. See satNever in lib/locoOverrides.
  if (edit && edit.satNever) return false
  if (edit && edit.satHand) return true
  const explicit = (edit && Array.isArray(edit.satDays) && edit.satDays.length) ? edit.satDays : null
  const natural = (sats && sats.length && isSatCapableWs(ws)) ? sats : null
  if (explicit && natural) { const u = explicit.slice(); for (const s of natural) if (u.indexOf(s) < 0) u.push(s); return u }
  if (explicit) return explicit
  return natural || false
}
/** The Saturdays these desc rows ALREADY hold an allocation on (null when none). Cheap no-op when the
 *  axis carries no working Saturday at all (the overwhelmingly common case). */
function _rowsUseSaturday(rows, axis) {
  if (!rows || !rows.length) return null
  if (!axis._sat) axis._sat = axis.isos.map(isSaturdayIso)
  if (!axis._sat.some(Boolean)) return null
  let out = null
  for (const dr of rows) for (const iso in (dr.cells || {})) {
    if (isSaturdayIso(iso) && (!out || out.indexOf(iso) < 0)) (out || (out = [])).push(iso)
  }
  return out
}
/** Same, for a station's member workstation ENTRIES (see _buildStations). */
function _membersUseSaturday(members, axis) {
  let out = null
  for (const m of (members || [])) {
    const s = m && _rowsUseSaturday(m.desc_rows, axis)
    if (s) for (const iso of s) if (!out || out.indexOf(iso) < 0) (out || (out = [])).push(iso)
  }
  return out
}
// True iff the date_info entry is a Saturday (its iso falls on weekday 6, Sat).
function isSaturdayIso(iso) {
  if (!iso || iso.length < 10) return false
  // Parse as local date (yyyy-mm-dd) to avoid UTC off-by-one.
  const dt = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  return dt.getDay() === 6
}
// Red-X box shown on a working Saturday for a WS that cannot operate on Saturdays —
// makes the restriction explicit instead of looking like an unallocated empty cell.
function _satBlockedCellInner() {
  return `<div title="Workstation não opera aos sábados" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%">`
    + `<svg width="13" height="13" viewBox="0 0 16 16" style="flex-shrink:0"><path d="M3 3 L13 13 M13 3 L3 13" stroke="${RED}" stroke-width="2.2" stroke-linecap="round"/></svg>`
    + `</div>`
}

// Today's date as a LOCAL ISO string (YYYY-MM-DD) — matches the local calendar
// dates in date_info[].iso. Computed at build time so the Today marker always
// reflects the current day. NOT toISOString() (that would be UTC and could be
// off by one near midnight / in non-UTC timezones).
function localTodayIso() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildTableShell(dateInfo, holidays, fwIndex, conflictDaySet) {
  const fwSpans = []
  for (const d of dateInfo) {
    const last = fwSpans[fwSpans.length - 1]
    if (last && last.fw === d.fw) last.count += 1
    else fwSpans.push({ fw: d.fw, count: 1 })
  }
  // Pre-compute once — reused by every pushRows call (avoids O(groups × dates) recreation)
  const dateIsoSet = new Set(dateInfo.map(d => d.iso))

  // Today marker: only active when the current date falls inside the visible range.
  const _todayIso = localTodayIso()
  const todayIso = dateIsoSet.has(_todayIso) ? _todayIso : null
  const TODAY_LINE = `2px solid ${RED}`        // crisp vertical reference line
  const TODAY_TINT = '#FCE3E3'   // SOLID opaque band (no transparency → nothing bleeds through)

  const isNW = d => d.is_weekend || holidays.has(d.iso)
  const isHol = d => !d.is_weekend && holidays.has(d.iso)
  const parts = []
  // Only <html> has overflow:auto so that window.scrollTo() and window.scrollBy() scroll the
  // correct element. If body also had overflow:auto it would become the scroll container and
  // window.scrollTo() would have no visible effect (nothing overflows the viewport itself).
  // BOTH tiers are per-row expand/collapse TREES now: pushRows emits, per LOCO, EITHER its
  // one aggregated summary row (.gantt-loco-col, collapsed — the old LOCO-mode row, WS card
  // included) OR its Workstation ↔ Componente tree (per WS: summary .gantt-ws-col row or
  // Componente .gantt-desc-row rows). Only the visible rows exist in the DOM — there is no
  // global display-flip mode left, so none of the classes carries display rules anymore.
  // html.loco-collapsed survives ONLY as the narrow-layout optimization: column widths are
  // table-global, so the shared WORKSTATION column (colgroup col #4, 220px) may collapse to 0
  // ONLY when EVERY loco is collapsed (a table-global condition ↔ a table-global CSS rule).
  // The main thread toggles the class when the loco tier reaches / leaves "all collapsed";
  // the loco rows' WS summary card (.gantt-wscol-cell) is blanked so nothing bleeds out of
  // the zero-width column. In any mixed state the 220px column stays and the card is visible.
  parts.push('<style>html,body{margin:0;padding:0}html{overflow:auto}table{margin:0}td,th{box-sizing:border-box}html.loco-collapsed col:nth-child(4){width:0!important}html.loco-collapsed .gantt-wscol-cell,html.loco-collapsed .gantt-wscol-head{width:0!important;min-width:0!important;max-width:0!important;padding:0!important;border-left:0!important;border-right:0!important;box-shadow:none!important;background:transparent!important;overflow:hidden!important;visibility:hidden!important}</style>')
  parts.push('<table style="border-collapse:separate;border-spacing:0;table-layout:fixed;min-width:max-content;font-size:10px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">')
  parts.push('<colgroup>')
  parts.push('<col style="width:52px"><col style="width:88px"><col style="width:50px"><col style="width:220px">')
  for (const d of dateInfo) {
    const w = isNW(d) ? COL_NW_PX : COL_W_PX
    // Tint today's whole column so it reads as a "today" band behind every row.
    const tint = (todayIso && d.iso === todayIso) ? `;background:${TODAY_TINT}` : ''
    parts.push(`<col style="width:${w}px${tint}">`)
  }
  parts.push('</colgroup>')
  parts.push('<thead>')
  // Banner cell: only the short scroll hint remains. The long "Acesse aba Resumo Geral…"
  // text was removed — with white-space:nowrap over colspan=4 it forced a min-content
  // width wider than the frozen columns, which (with min-width:max-content on the table)
  // expanded LINHA/MODELO/LOCO in LOCO mode where the 220px WS column is collapsed.
  // overflow:hidden + no nowrap so the banner can never drive column widths.
  // "Ir para hoje" — small calendar button in the wheel-hint corner, sitting above the LOCO
  // column. Scrolls the timeline to today's column (handled on the main thread, which owns
  // the scroll engine). It targets the first column ON or AFTER today rather than today
  // itself, so it still works when today is a weekend/holiday with no rendered cell.
  // Today outside the loaded range → rendered opaque and inert, with no data attribute, so
  // the main thread's `closest('[data-today-nav]')` can never match it.
  const _firstIso = dateInfo.length ? dateInfo[0].iso : null
  const _lastIso  = dateInfo.length ? dateInfo[dateInfo.length - 1].iso : null
  const _todayInRange = _firstIso !== null && _todayIso >= _firstIso && _todayIso <= _lastIso
  const _todayTargetIso = _todayInRange
    ? (dateInfo.find(d => d.iso >= _todayIso) || dateInfo[dateInfo.length - 1]).iso
    : null
  const _calIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
  const _todayBtn = _todayInRange
    ? `<span data-today-nav="${_todayTargetIso}" title="Ir para hoje" role="button" style="display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;margin-right:8px;border:1px solid ${RED};border-radius:4px;background:#fff;color:${RED};cursor:pointer;flex-shrink:0">${_calIcon}</span>`
    : `<span title="Hoje está fora do período carregado" aria-disabled="true" style="display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;margin-right:8px;border:1px solid ${RED};border-radius:4px;background:#fff;color:${RED};cursor:default;opacity:.35;flex-shrink:0">${_calIcon}</span>`
  parts.push(`<tr style="height:26px"><th colspan="4" style="position:sticky;top:0;left:0;z-index:60;background:${RED_LT};border-top:1px solid ${RED};border-left:1px solid ${RED};border-right:1px solid ${RED};border-bottom:1px solid ${RED};color:${RED};font-weight:600;font-size:9px;text-align:left;height:26px;overflow:hidden;padding:0 10px;letter-spacing:.02em"><div style="display:flex;align-items:center;width:100%;overflow:hidden">${_todayBtn}<span style="white-space:nowrap">↑↓ Roda &nbsp;|&nbsp; Shift+Roda ↔</span></div></th>`)
  const MONTH_PT = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']
  const fwFirstIso = new Map()
  for (const d of dateInfo) { if (!fwFirstIso.has(d.fw)) fwFirstIso.set(d.fw, d.iso) }
  for (const { fw, count } of fwSpans) {
    const iso = fwFirstIso.get(fw) ?? ''
    const fwLabel = iso ? `${_fw445FiscalYear(iso, fw)} ${MONTH_PT[_fwToMonth445(fw) - 1]} ${fw}` : fw
    parts.push(`<th colspan="${count}" style="position:sticky;top:0;z-index:20;background:${RED};border-top:1px solid ${RED_DK};border-right:1px solid ${RED_DK};border-bottom:1px solid ${RED_DK};color:#fff;font-weight:700;font-size:10px;text-align:center;height:26px;white-space:nowrap;padding:0 2px">${esc(fwLabel)}</th>`)
  }
  parts.push('</tr>')
  parts.push('<tr style="height:56px">')
  // Right "border" = gradient hard-stop entirely inside the cell's own box — no cross-cell overflow,
  // so GPU compositor never causes the adjacent sticky column to visually shrink during scroll.
  const fhStyle = (left, width, zIndex) =>
    `position:sticky;top:26px;z-index:${zIndex};background:#fff;background-clip:padding-box;border-top:${DAY_BORDER} solid ${RED};border-right:${DAY_BORDER} solid ${RED};border-bottom:none;box-shadow:inset -1px 0 0 ${RED},0 1px 0 0 ${RED};color:${RED};font-weight:700;font-size:10px;text-align:center;height:56px;padding:0 4px;white-space:nowrap;left:${left}px;vertical-align:middle;width:${width}px;min-width:${width}px;max-width:${width}px`
  parts.push(`<th style="${fhStyle(FROZEN_LEFT_PAD, 52, 64)}">LINHA</th>`)
  parts.push(`<th style="${fhStyle(FROZEN_LEFT_PAD + 52, 88, 65)}">MODELO</th>`)
  parts.push(`<th style="${fhStyle(FROZEN_LEFT_PAD + 140, 50, 66)}">LOCO</th>`)
  parts.push(`<th class="gantt-wscol-head" style="${fhStyle(FROZEN_LEFT_PAD + 190, 220, 67)}">WORKSTATION</th>`)
  for (const d of dateInfo) {
    const nw = isNW(d)
    const fh = isHol(d)
    const isToday = todayIso && d.iso === todayIso
    const bg = isToday ? TODAY_TINT : (nw ? '#E5E7EB' : '#fff')
    const bc = nw ? '#D1D5DB' : RED
    const sh = nw ? '0 1px 0 0 #D1D5DB' : `0 1px 0 0 ${RED}`
    // Both-side, full-height bracket via inset box-shadow (doesn't fight border-right).
    const todayEdge = isToday ? `inset 2px 0 0 ${RED},inset -2px 0 0 ${RED},` : ''
    const todayBadge  = isToday ? `<span style="font-size:7px;color:${RED};font-weight:800;letter-spacing:.04em">HOJE</span>` : ''
    // Conflict day icon: appended after the weekday label on days that contain at least
    // one real conflict (exemption-aware set from the host). Icon-only — no count/tooltip.
    const cIcon = (conflictDaySet && conflictDaySet.has(d.iso)) ? _headerConflictIcon() : ''
    parts.push(`<th id="gantt_date_${d.iso}" data-day-nav="${esc(d.iso)}" title="Ir para o início deste dia" style="cursor:pointer;position:sticky;top:26px;z-index:20;background:${bg};border-top:${DAY_BORDER} solid ${bc};border-right:${DAY_BORDER} solid ${bc};border-bottom:none;box-shadow:${todayEdge}${sh};color:#111827;font-weight:600;font-size:9px;text-align:center;height:56px;vertical-align:middle;padding:0">${nw ? `<div style="display:flex;flex-direction:column;align-items:center;line-height:1.35"><span style="font-weight:700;font-size:9px;color:#374151">${esc(d.dow)}${cIcon}</span>${todayBadge}${fh ? `<span style="font-size:7px;color:${RED_DK};font-weight:800">FER</span>` : ''}</div>` : `<div style="display:flex;flex-direction:column;align-items:center;line-height:1.35"><span style="font-weight:800;font-size:10px;color:#111827">${esc(d.label)}</span><span style="font-size:8px;color:#6B7280;font-weight:500">${esc(d.dow)}${cIcon}</span>${todayBadge}</div>`}</th>`)
  }
  // NOTE: no global <tbody> here — the normal (LOCO-grouped) view emits ONE
  // self-contained <tbody data-loco="…"> per LOCO in pushRows, so a single LOCO can be
  // surgically re-rendered (patchLocos) without rebuilding the whole table. The flat view
  // (buildFlatTableShell) keeps its own single tbody.
  parts.push('</tr></thead>')
  return { parts, isNW, fwIndex, dateInfo, dateIsoSet, todayIso }
}

function pushRows(state, group, groupIndex, drawLocoSeparator, colorByWs, wsIndex, conflictSet, displacementSets, displacementHalf) {
  const { parts, isNW, fwIndex, dateInfo, dateIsoSet, todayIso } = state
  // Start boundary for the "hide before start" toggle (date part of start_ms).
  const startIso = (state.hideBeforeStart && group.start_ms != null) ? String(group.start_ms).slice(0, 10) : null
  // Vertical "today" highlight: both-side, full-height bracket via inset box-shadow so the
  // column is visually isolated without fighting each cell's own border-right.
  const todayBorderFor = iso => (todayIso && iso === todayIso) ? `box-shadow:inset 2px 0 0 ${RED},inset -2px 0 0 ${RED};` : ''
  // Today edges as an ABOVE-content overlay. An inset box-shadow paints in the TD's own background
  // phase, so ANY child carrying a background paints over it. Two children do:
  //   • LOCO-mode `wsBlocks` — background:<wsColor>, fills 100% → both edges lost;
  //   • WORK/FULL `hatchDiv` on a HALF-DAY box — an opaque gradient over 50% of the cell, anchored to
  //     one side → exactly ONE edge lost. With `half==='second'` the hatch sits LEFT, so the surviving
  //     right edge reads as the today line standing a whole column too far right. That was reported as
  //     "the red line shifts right after expanding": LOCO mode had this overlay, WORK/FULL did not.
  // Hence every box cell in all three modes gets the overlay. It is inert on non-today cells (returns
  // ''), so it costs one extra div per row on a single column. The TD must be position:relative for
  // this to anchor — every call site already is. pointer-events:none keeps clicks/nav intact, and it
  // is emitted BEFORE the note badge so a badge still paints above it.
  const todayOverlay = iso => (todayIso && iso === todayIso)
    ? `<div style="position:absolute;top:0;bottom:0;left:0;right:0;box-shadow:inset 2px 0 0 ${RED},inset -2px 0 0 ${RED};pointer-events:none;z-index:3"></div>`
    : ''
  const bg = groupIndex % 2 === 1 ? '#F8FAFC' : '#FFFFFF'
  const notFirstGroup = Boolean(drawLocoSeparator)
  const topBorder = `${DAY_BORDER} solid ${RED}`
  const visibleWorkstations = group.workstations
    .map(w => ({
      ...w,
      // Tag each row with its ORIGINAL index in the unfiltered desc_rows array.
      // The displacement map is keyed by this index (per-DESCRIÇÃO row), so the
      // filtered position must not be used as the lookup key.
      desc_rows: (w.desc_rows || [])
        .map((dr, origIdx) => ({ ...dr, _origIdx: origIdx }))
        .filter(dr => {
          const cells = dr?.cells || {}
          for (const iso of Object.keys(cells)) {
            if (dateIsoSet.has(iso)) return true
          }
          return false
        }),
    }))
    .filter(w => w.desc_rows.length > 0)

  // FULL mode renders ONE ROW PER UNIQUE DESCRIÇÃO within a Workstation. Records
  // that share the same WS + DESCRIÇÃO but differ only by PART NUMBER are merged
  // into a single line (hours summed per day). WORK mode (further below) still
  // aggregates ALL descrições of a WS — these stay distinct. Each box shows only
  // the DESCRIÇÃO name (2-line clamp, hours always visible). wsHasConflict() flags
  // whether a Workstation has ANY conflict so the WS column can show an icon.
  const wsHasConflict = wst => {
    if (!conflictSet) return false
    const wsNorm = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
    for (const dr of wst.desc_rows)
      for (const iso in (dr.cells || {}))
        if (conflictSet.has(`${iso}||${wsNorm}`)) return true
    return false
  }

  // Build per-WS deduplicated rows keyed by DESCRIÇÃO. Cells are summed across the
  // merged PART NUMBER rows; the half-day flag survives only when a single source
  // row allocates that day; displacement isos are unioned across the merged rows.
  const dedupedByWs = visibleWorkstations.map(w => {
    const locoWsKeyPrefix = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}||${w.ws}||${w.subarea ?? ''}`
    const byDesc = new Map()   // desc → { desc, cells, _mergedDisp }
    const order = []
    for (const dr of w.desc_rows) {
      const key = dr.desc ?? ''
      let acc = byDesc.get(key)
      if (!acc) { acc = { desc: dr.desc ?? '', cells: {}, _mergedDisp: new Set(), _mergedRecov: new Set(), _mergedDispHalf: {}, _mergedRecovHalf: {} }; byDesc.set(key, acc); order.push(key) }
      for (const [iso, cell] of Object.entries(dr.cells || {})) {
        const h = Number(cell.hh) || 0
        // Track AM/PM occupancy across merged part-number rows so a real half-day finish keeps its
        // half box; only a day with BOTH halves filled becomes a full box. (Clearing the flag on any
        // second source wrongly upgraded multi-part-number descriptions' half-days to full boxes.)
        let ex = acc.cells[iso]
        if (!ex) { ex = { hh: 0, _am: false, _pm: false }; acc.cells[iso] = ex }
        ex.hh += h
        if (cell.half === 'first') ex._am = true
        else if (cell.half === 'second') ex._pm = true
        else { ex._am = true; ex._pm = true }
      }
      const ds = displacementSets && displacementSets[`${locoWsKeyPrefix}||${dr._origIdx}`]
      if (ds) for (const iso of ds) acc._mergedDisp.add(iso)
      const rs = state.recoveredSets && state.recoveredSets[`${locoWsKeyPrefix}||${dr._origIdx}`]
      if (rs) for (const iso of rs) acc._mergedRecov.add(iso)
      const dsh = displacementHalf && displacementHalf[`${locoWsKeyPrefix}||${dr._origIdx}`]
      if (dsh) Object.assign(acc._mergedDispHalf, dsh)
      const rsh = state.recoveredHalf && state.recoveredHalf[`${locoWsKeyPrefix}||${dr._origIdx}`]
      if (rsh) Object.assign(acc._mergedRecovHalf, rsh)
      // Carry the override annotations onto the DEDUPED row. This row is rebuilt from scratch above,
      // so anything stamped by _stampEditAnnotations dies here unless it is copied — and both of
      // these decide what gets DRAWN:
      //   • _satManual: without it the row falls back to the WS40/WS50-only rule and every Saturday
      //     cell a planner placed by hand is silently dropped (the box vanishes rather than the move
      //     being refused) — the cells are correct, the renderer just discards them.
      //   • _moveNotes: without it the move-description indicator never appears in FULL mode.
      // A Componente's merged part-number rows all share ONE scoped edit (it is keyed
      // ws||subarea||desc), so every source row carries the same values — first one wins.
      if (dr._satManual) acc._satManual = true
      if (dr._moveNotes && !acc._moveNotes) acc._moveNotes = dr._moveNotes
    }
    // Finalize the half flag per day from the accumulated AM/PM occupancy.
    for (const acc of byDesc.values()) for (const iso in acc.cells) {
      const c = acc.cells[iso]
      c.half = (c._am && c._pm) ? undefined : (c._am ? 'first' : 'second')
      delete c._am; delete c._pm
    }
    return { ...w, dedupedRows: order.map(k => byDesc.get(k)) }
  })

  // Same visibility rule as always: a LOCO with no visible Componente rows in the window
  // emits nothing at all (no tbody), in any state.
  const dedupTotal = dedupedByWs.reduce((sum, w) => sum + w.dedupedRows.length, 0)
  if (dedupTotal === 0) return

  // ── Per-LOCO expand/collapse (the LOCO ↔ Workstation tier) ──────────────────────────────
  // Same model as the WS tier below, one level up: a COLLAPSED loco renders as its single
  // aggregated summary row (the old LOCO-mode row, WS summary card included — the card cell
  // always exists, so the all-collapsed narrow layout stays a pure CSS width flip on the main
  // thread); an EXPANDED loco renders its Workstation ↔ Componente tree. Only the visible
  // variant is emitted — the same rowspan rule that forced the WS tier to emit visible rows
  // only applies here too. expanded = locoExpandBase XOR membership in locoExpandExc; a
  // missing base (legacy payload) defaults to TRUE so the tree stays the default view.
  const locoTbodyKey = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}`
  const locoExpandBase = state.locoExpandBase === undefined ? true : Boolean(state.locoExpandBase)
  const locoExpanded = (state.locoExpandExc && state.locoExpandExc.has(locoTbodyKey))
    ? !locoExpandBase : locoExpandBase

  // ── Per-workstation expand/collapse (the Workstation ↔ Componente tier) ─────────────────
  // The tree emits, per workstation, EITHER its aggregated summary row (collapsed — the old
  // WORK rendering) OR its per-Componente rows (expanded — the old FULL rendering), interleaved
  // in tree order. Emitting ONLY the visible rows is what makes mixed states possible at all:
  // display:none <tr>s still count in the HTML rowspan algorithm, so the frozen
  // LINHA/MODELO/LOCO rowspans must equal the number of rows that really exist in the DOM.
  // Expansion state lives in React (GanttModal) and arrives on BOTH the build and the
  // patchLocos payloads: expanded = expandBase XOR membership in expandExc (so bulk
  // Expand/Collapse All just flips the base and clears the exceptions). Stale keys from
  // filtered-out LOCOs are harmless — they simply never match. LOCO mode stays a global
  // CSS flip and is untouched by this tier.
  const dedupByKey = new Map(dedupedByWs.map(w => [`${w.ws}||${w.subarea ?? ''}`, w]))
  const expandedOf = wst => {
    const key = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}||${wst.ws}||${wst.subarea ?? ''}`
    const exc = state.expandExc ? state.expandExc.has(key) : false
    return exc ? !state.expandBase : Boolean(state.expandBase)
  }
  // Tier plan: one entry per workstation that has VISIBLE content. A zero-HOUR WS (e.g. Protection
  // Days) still keeps its summary row — it has cells in the window, so it survives the filter and
  // matches the old WORK mode. But a WS whose every box was hidden by "Ocultar antes do início"
  // (hideBeforeStart) or clipped off the trimmed view axis has NO deduped entry (`dedupByKey`
  // is built from the visible workstations only): drop it so no empty summary row is emitted and
  // no vertical space is reserved for it — the Componente-row filter already dropped its rows;
  // this is the workstation-tier equivalent. A LOCO whose workstations are ALL dropped renders
  // nothing at all via the `dedupTotal === 0` guard above. Only WS with visible Componente rows
  // can expand.
  const tierItems = group.workstations
    .filter(wst => dedupByKey.has(`${wst.ws}||${wst.subarea ?? ''}`))
    .map(wst => {
      const dd = dedupByKey.get(`${wst.ws}||${wst.subarea ?? ''}`)
      const canExpand = Boolean(dd && dd.dedupedRows.length > 0)
      const expanded = canExpand && expandedOf(wst)
      return { wst, dd, canExpand, expanded, rows: expanded ? dd.dedupedRows.length : 1 }
    })
  const groupRows = tierItems.reduce((s, t) => s + t.rows, 0)
  const lastGroupRowIndex = groupRows - 1
  let groupRowCursor = 0
  // Minimum vertical footprint for a LOCO: a filter (e.g. one Workstation) can leave a LOCO with a
  // single visible tier row, which would otherwise collapse to one 34px strip. LOCO mode never lets a
  // LOCO be shorter than its 102px card row, so mirror that floor here: distribute FROZEN_MIN_LOCO_H
  // evenly across the surviving rows so the LOCO always occupies at least that height, uniformly. Once
  // a LOCO has 3+ rows the natural 34px stacking already clears the floor, so rowH stays FROZEN_ROW_PX
  // and dense (unfiltered) views are untouched.
  const rowH = groupRows > 0
    ? Math.max(FROZEN_ROW_PX, Math.ceil(FROZEN_MIN_LOCO_H / groupRows))
    : FROZEN_ROW_PX

  // Locked workstations: Move Mode + right-click edit are refused on Protection Days ONLY. A PD is a
  // trailing buffer and must stay fixed/non-movable (only the LOCO-finish-date change may touch it). We
  // drop the row's `data-row-edit` identity so neither the box-move handler nor the edit menu can engage
  // (WS-name navigation, which keys off the cell's own data-ws, is untouched).
  //
  // Stations AFTER the buffer (post-PD) are NOT locked here: a planner may move/resize them manually
  // (Move Mode + edit menu) AND they now PARTICIPATE in propagation like ordinary stations — the PD
  // buffer relays any delay that outgrew it (see the pdExcess path in applyWsEdits), and a post-PD
  // station's own edit can propagate downstream. Only the PD WARNING stays special: a post-PD move never
  // raises it (GanttModal.isPostPdTarget keeps pdSlack null).
  const _lockedWsKeys = new Set()
  for (const w of group.workstations)
    if (isProtectionWs(w.ws)) _lockedWsKeys.add(`${w.ws}||${w.subarea ?? ''}`)
  const isLockedWs = (ws, subarea) => _lockedWsKeys.has(`${ws}||${subarea ?? ''}`)

  // Frozen LINHA / MODELO / LOCO cells — emitted once, on the group's FIRST tier row (summary
  // or Componente alike), spanning every visible tier row of the LOCO. `topB` keeps the old
  // per-rendering top border (RED for a Componente first row, group boundary for a summary).
  const pushFrozenCells = (topB) => {
    // Available vertical run for the rotated LINHA/MODELO/LOCO labels = the rowspan cell height
    // (each visible tier row is rowH tall — normally FROZEN_ROW_PX, taller when a filter floors the
    // LOCO to FROZEN_MIN_LOCO_H). Taller cell (more expanded rows) → bigger font up to the base; single
    // collapsed row → the reduced size. Never changes the row height itself.
    const frozenAvail = groupRows * rowH
    parts.push(`<td rowspan="${groupRows}" style="position:sticky;left:${FROZEN_LEFT_PAD}px;z-index:44;background:${RED_LT};background-clip:padding-box;border-top:${topB};border-right:${DAY_BORDER} solid ${RED};border-bottom:none;box-shadow:inset -1px 0 0 ${RED};width:52px;min-width:52px;max-width:52px;vertical-align:middle;text-align:center;font-weight:700;color:#1A1A2E;font-size:16px;padding:0">${_locoToggleChevron(group, true)}<div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;width:52px;min-height:34px;padding:2px;${frozenLabelStyle(group.linha, 16, frozenAvail)}">${esc(group.linha)}</div></td>`)
    parts.push(`<td rowspan="${groupRows}" data-loco-edit="1" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-linha="${esc(group.linha)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-takt="${esc(String(group.takt ?? ''))}" title="Clique direito para editar o LOCO" style="position:sticky;left:${FROZEN_LEFT_PAD + 52}px;z-index:45;background:${RED_LT};background-clip:padding-box;border-top:${topB};border-right:${DAY_BORDER} solid ${RED};border-bottom:none;box-shadow:inset -1px 0 0 ${RED};width:88px;min-width:88px;max-width:88px;vertical-align:middle;text-align:center;font-weight:800;color:#1A1A2E;font-size:18px;padding:0">${modeloCellInner(group, state, frozenAvail)}</td>`)
    parts.push(`<td rowspan="${groupRows}" data-loco-edit="1" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-linha="${esc(group.linha)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-takt="${esc(String(group.takt ?? ''))}" title="Clique direito para editar o LOCO" style="position:sticky;left:${FROZEN_LEFT_PAD + 140}px;z-index:46;background:${RED_LT};background-clip:padding-box;border-top:${topB};border-right:${DAY_BORDER} solid ${RED};border-bottom:none;box-shadow:inset -1px 0 0 ${RED};width:50px;min-width:50px;max-width:50px;vertical-align:middle;text-align:center;font-weight:700;color:#1A1A2E;font-size:18px;padding:0"><div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;width:50px;min-height:34px;padding:2px;${frozenLabelStyle(group.task_name, 18, frozenAvail)}">${esc(group.task_name)}</div></td>`)
  }

  // One self-contained <tbody> per LOCO (stable data-loco anchor) so patchLocos can swap
  // just this LOCO's rows in the live iframe without rebuilding the table — including a
  // LOCO-tier collapse/expand toggle, which swaps tree rows ↔ the one summary row. Closed
  // at the very end of pushRows.
  parts.push(`<tbody data-loco="${esc(locoTbodyKey)}">`)

  // The Workstation ↔ Componente tree renders only while the LOCO is expanded; a collapsed
  // LOCO emits only its summary row (the `else` branch far below).
  if (locoExpanded)
  for (let ti = 0; ti < tierItems.length; ti++) {
    const { wst: rawWst, dd, canExpand, expanded } = tierItems[ti]
    const prevItem = ti > 0 ? tierItems[ti - 1] : null
    const sameWsAsPrev = Boolean(prevItem && prevItem.wst.ws === rawWst.ws)
    const wsToggleKey = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}||${rawWst.ws}||${rawWst.subarea ?? ''}`

    if (expanded) {
    // ── EXPANDED: one row per Componente (the old FULL rendering, unchanged visuals) ──
    const wst = dd
    const wsRows = wst.dedupedRows.length
    const wsLabel = wsSubLabel(wst.ws, wst.subarea, '—')
    const wsConflictIcon = wsHasConflict(wst) ? `${_warnIcon(RED, 11)} ` : ''

    for (let dIdx = 0; dIdx < wst.dedupedRows.length; dIdx++) {
      const dr = wst.dedupedRows[dIdx]
      const isFirstDesc = dIdx === 0
      // Displacement set = union of all merged PART NUMBER rows for this DESCRIÇÃO.
      const wsDispSet = dr._mergedDisp.size > 0 ? dr._mergedDisp : null
      // Early-finish recovery set (req 3): trailing weekdays this conflict WS would have used
      // had it not taken a Saturday. Rendered ORANGE, AFTER the WS block. Visual only.
      const wsRecovSet = dr._mergedRecov.size > 0 ? dr._mergedRecov : null
      // Half-day (0.5) delay/recovery boundaries: iso → which half ('first'=AM/left, 'second'=PM/right)
      // is vacated. Rendered as a HALF-width red (delay) / orange (recovery) hatch on that side.
      const wsDispHalf  = Object.keys(dr._mergedDispHalf).length  ? dr._mergedDispHalf  : null
      const wsRecovHalf = Object.keys(dr._mergedRecovHalf).length ? dr._mergedRecovHalf : null
      // Unused-Saturday placeholder span: only conflict WS (WS40/WS50) get an orange hatched
      // box on a Saturday they COULD have used but didn't. Bounded to this row's occupied span
      // (strictly between its first and last allocated day) so the box only fills an internal
      // gap and the timeline reads continuous — never trailing before/after the WS block.
      const satCapRow = isSatCapableWs(wst.ws)
      // May this row OCCUPY a working Saturday? Saturday-eligible by scheduling rule (WS40/WS50),
      // OR placed there by hand in Move Mode (_satManual). Deliberately distinct from satCapRow
      // above: that one drives the ORANGE "available Saturday the optimizer left unused" box, which
      // is an optimizer concept and must NOT start appearing on hand-moved rows.
      const satOccRow = satCapRow || dr._satManual === true
      // Occupancy span of THIS desc row (first/last allocated day). Used by two Saturday
      // placeholders, both bounded strictly inside this span (rowFirstOcc < iso < rowLastOcc)
      // so they only ever fill an internal gap — never trail before/after the row's work:
      //   • WS40/WS50 (satCapRow): orange "unused available Saturday" box.
      //   • other WS: the red-X "passed through weekend, cannot allocate Saturday" marker —
      //     ONLY when the row spans the Saturday (work before AND after it, e.g. Fri→Mon),
      //     never globally on every Saturday column or on rows with no continuity.
      const _occKeys = Object.keys(dr.cells || {}).sort()
      const rowFirstOcc = _occKeys[0]
      const rowLastOcc = _occKeys[_occKeys.length - 1]
      const isLastGroupRow = groupRowCursor === lastGroupRowIndex
      const isGroupFirstRow = groupRowCursor === 0
      // Same border language as before: WS boundaries #D1D5DB, Componente rows within a WS
      // #E5E7EB — reproduced from the tier cursor since blocks now interleave.
      const rowTopBorder = isFirstDesc
        ? ((isGroupFirstRow && notFirstGroup)
            ? `${DAY_BORDER} solid #D1D5DB`
            : (sameWsAsPrev ? 'none' : `${DAY_BORDER} solid #D1D5DB`))
        : `${DAY_BORDER} solid #E5E7EB`
      const rowBottomBorder = isLastGroupRow ? `${DAY_BORDER} solid #D1D5DB` : 'none'

      // Right-click edit identity for this FULL-mode row: carries BOTH the workstation and the
      // Componente (deduped description, identified by its `desc` text), so the menu can offer
      // "Editar Workstation" + "Editar Componente". Dropped entirely when the WS is locked
      // (Protection Days or anchored after it) so Move Mode + the edit menu cannot engage.
      const rowEditAttrs = isLockedWs(wst.ws, wst.subarea) ? '' : `data-row-edit="desc" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-ws="${esc(wst.ws)}" data-subarea="${esc(wst.subarea ?? '')}" data-desc="${esc(dr.desc ?? '')}" data-takt="${esc(String(group.takt ?? ''))}"`

      if (isGroupFirstRow) {
        parts.push(`<tr class="gantt-desc-row" ${rowEditAttrs} style="height:${rowH}px" id="loco_${safeId(group.linha)}_${safeId(group.wo)}_${safeId(group.task_name)}_${safeId(String(group.start_ms ?? ''))}">`)
        pushFrozenCells(topBorder)
      } else {
        parts.push(`<tr class="gantt-desc-row" ${rowEditAttrs} style="height:${rowH}px">`)
      }

      if (isFirstDesc) {
        const wsRowId = `ws_${safeId(group.linha)}_${safeId(group.wo)}_${safeId(group.task_name)}_${safeId(String(group.start_ms ?? ''))}_${safeId(wst.ws)}_${safeId(wst.subarea ?? '')}`
        // Down (collapse) chevron only when the workstation actually has MULTIPLE Componente rows —
        // a single-Componente WS has nothing to hide/reveal, so it shows no toggle (mirrors the
        // collapsed ▶ rule, which is likewise gated on >1 rows).
        const descChevron = wsRows > 1 ? _wsToggleChevron(wsToggleKey, true) : ''
        parts.push(`<td id="${wsRowId}" rowspan="${wsRows}" title="${esc(wsLabel)} — Clique para ir ao início desta workstation no Gantt" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-ws="${esc(wst.ws)}" data-subarea="${esc(wst.subarea ?? '')}" data-start-iso="${esc(_wsFirstIsoOf(wst))}" style="position:sticky;left:${FROZEN_LEFT_PAD + 190}px;z-index:47;background:${bg};background-clip:padding-box;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};border-right:${DAY_BORDER} solid ${RED};box-shadow:inset -1px 0 0 ${RED};cursor:pointer;vertical-align:middle;font-weight:700;color:#111827;font-size:10px;height:34px;padding:0 8px;width:220px;min-width:220px;max-width:220px">${descChevron}<div style="display:flex;align-items:center;gap:4px;overflow:hidden${descChevron ? ';margin-left:12px' : ''}">${wsConflictIcon ? `<span style="display:inline-flex;flex-shrink:0">${wsConflictIcon.trim()}</span>` : ''}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(wsLabel)}</span></div></td>`)
      }

      // Move-description indicator: drawn on this row's FIRST box and consumed there, so a row
      // carries exactly one marker no matter how many days it spans. A WS-scope reason (authored
      // on the collapsed summary row) rides on the workstation's FIRST Componente row, merged
      // chronologically with that row's own trail — expanding must never hide a commentary.
      let noteBadge = moveNoteBadge(isFirstDesc ? _mergeNotes(wst._moveNotes, dr._moveNotes) : dr._moveNotes)

      let idx = 0
      while (idx < dateInfo.length) {
        const d = dateInfo[idx]
        if (isNW(d)) {
          // Batch all consecutive non-working days (weekends + holidays) into one colspan <td>.
          // Cuts NW-day element count from O(n_nw_days) to O(n_nw_runs) per row.
          // Never batch across OR starting from today, so the Today highlight stays a single
          // day cell and its right border lands on today's own edge — not at the week's end.
          let end = idx + 1
          if (d.iso !== todayIso) {
            while (end < dateInfo.length && isNW(dateInfo[end]) && dateInfo[end].iso !== todayIso) end++
          }
          const span = end - idx
          const sa = span > 1 ? ` colspan="${span}"` : ''
          parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:#E5E7EB;border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px"></td>`)
          idx = end
          continue
        }
        // Saturday occupancy is limited to rows that may actually hold it: WS40/WS50 by scheduling
        // rule, or a row a planner put there by hand in Move Mode. Any other WS never renders an
        // allocation box on a Saturday (falls through to the red-X "cannot work" box), so it can
        // never look like the WS worked on a Saturday or feed delay calculations.
        const cell = (isSaturdayIso(d.iso) && !satOccRow) ? undefined : dr.cells[d.iso]
        if (cell) {
          const cellBg = colorByWs ? WS_COLORS[wsIndex[_wsNormKey(wst.ws)] ?? 0] : FW_LIGHT[fwIndex[d.fw] ?? 0]
          const title = dr.desc ? ` title="${esc(dr.desc)}"` : ''
          // FULL mode: show ONLY the DESCRIÇÃO name (never the WS name), clamped to
          // 2 lines with an ellipsis. Hours sit on their own non-shrinking line so
          // overflowing description text can never push them out of view.
          const topLabel = dr.desc || ''
          const topLine = `<span style="font-weight:800;font-size:9px;color:#111827;line-height:1.1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;max-width:100%;word-break:break-word">${esc(topLabel)}</span>`
          const bottomLine = `<span style="font-weight:700;font-size:9px;color:#1F2937;line-height:1.1;flex-shrink:0">${Number(cell.hh).toFixed(1)}h</span>`
          const wsNorm = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
          const isConflict = conflictSet && conflictSet.has(`${d.iso}||${wsNorm}`)
          // Allowed overlap (orange) when the cell is an exempt boundary handoff, not a
          // true conflict (red). overlapSet is empty unless the overlap rule is active.
          const isOverlap = !isConflict && state.overlapSet && state.overlapSet.has(`${d.iso}||${wsNorm}`)
          const conflictOutline = isConflict
            ? `outline:2px solid ${RED};outline-offset:-2px;z-index:1;`
            : (isOverlap ? `outline:2px solid ${ORANGE};outline-offset:-2px;z-index:1;` : '')
          const baseStyle = `${todayBorderFor(d.iso)}border-right:${DAY_BORDER} solid #C9CFD6;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px;${conflictOutline}`
          if (cell.half === 'first' || cell.half === 'second') {
            const hatchSide  = cell.half === 'first' ? 'right' : 'left'
            // The empty half is a neutral grey hatch by default. When a fractional-takt edit vacated
            // exactly this half, it becomes a RED (delay) / ORANGE (recovery) HALF box — the 0.5-day
            // counterpart of the full displacement/recovery boxes. `emptySide` names the vacated half
            // ('first'=AM/left, 'second'=PM/right) so it matches the wsDispHalf/wsRecovHalf side code.
            const emptySide  = hatchSide === 'left' ? 'first' : 'second'
            const halfIsDisp  = wsDispHalf  && wsDispHalf[d.iso]  === emptySide && !(startIso && d.iso < startIso)
            const halfIsRecov = !halfIsDisp && wsRecovHalf && wsRecovHalf[d.iso] === emptySide && !(startIso && d.iso < startIso)
            const hatchBg = halfIsDisp
              ? `repeating-linear-gradient(-45deg,${RED}22 0,${RED}22 3px,transparent 3px,transparent 9px)`
              : halfIsRecov
                ? `repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px)`
                : `repeating-linear-gradient(-45deg,rgba(0,0,0,0.08) 0,rgba(0,0,0,0.08) 2px,transparent 2px,transparent 7px)`
            const hatchBorder = halfIsDisp ? `${RED}66` : halfIsRecov ? `${ORANGE}66` : 'rgba(0,0,0,0.18)'
            const hatchTitle  = halfIsDisp ? ' title="Deslocamento (meio dia)"' : halfIsRecov ? ' title="Tempo recuperado (meio dia)"' : ''
            const hatchDiv = `<div${hatchTitle} style="position:absolute;top:0;${hatchSide}:0;width:50%;height:100%;background:${hatchBg};border-${hatchSide}:1px dashed ${hatchBorder};box-sizing:border-box;pointer-events:none"></div>`
            const contentDiv = `<div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">${topLine}${bottomLine}</div>`
            parts.push(`<td${title} class="gbx" data-iso="${esc(d.iso)}" data-hh="${Number(cell.hh) || 0}" style="${baseStyle}background:${cellBg};vertical-align:top;text-align:center;padding:0;position:relative;overflow:hidden">${hatchDiv}${contentDiv}${todayOverlay(d.iso)}${noteBadge}</td>`)
          } else {
            parts.push(`<td${title} class="gbx" data-iso="${esc(d.iso)}" data-hh="${Number(cell.hh) || 0}" style="${baseStyle}background:${cellBg};vertical-align:middle;text-align:center;padding:2px;position:relative;overflow:hidden"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;height:30px;overflow:hidden">${topLine}${bottomLine}</div>${todayOverlay(d.iso)}${noteBadge}</td>`)
          }
          noteBadge = ''
          idx += 1
          continue
        }
        // Displacement placeholder: red hatched cell for days consumed by optimization shift.
        // Suppressed when hiding pre-start content and this day is before the LOCO start.
        // A displacement box is NEVER drawn on a Saturday for a non-WS40/WS50 workstation:
        // only WS40/WS50 may have any Saturday occupancy (incl. displacement), so for any
        // other WS a Saturday falls through to the red-X "cannot work" box below — it must
        // never look like the WS worked/was-displaced on a Saturday (delay-accounting safe).
        if (
          wsDispSet && wsDispSet.has(d.iso) && !(startIso && d.iso < startIso) &&
          !(isSaturdayIso(d.iso) && !satOccRow)
        ) {
          parts.push(`<td data-iso="${esc(d.iso)}" title="Deslocamento" style="${todayBorderFor(d.iso)}background:repeating-linear-gradient(-45deg,${RED}22 0,${RED}22 3px,transparent 3px,transparent 9px);border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px;outline:1px solid ${RED}44;outline-offset:-1px;pointer-events:none"></td>`)
          idx += 1
          continue
        }
        // Unused-Saturday placeholder: ORANGE hatched box for a conflict WS (WS40/WS50) on a
        // Saturday it could have used but the optimizer left empty, inside the WS's own block.
        // Visual ONLY — distinct orange (vs red delay), no metric/delay/PD/conflict meaning.
        // `cell` is falsy here (allocated days already returned above); the day reached this
        // code so it's a visible working Saturday column (non-working Saturdays are collapsed).
        if (
          satCapRow && isSaturdayIso(d.iso) &&
          rowFirstOcc && rowLastOcc && d.iso > rowFirstOcc && d.iso < rowLastOcc &&
          !(startIso && d.iso < startIso)
        ) {
          parts.push(`<td data-iso="${esc(d.iso)}" title="Sábado disponível não utilizado" style="${todayBorderFor(d.iso)}background:repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px);border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px;outline:1px solid ${ORANGE}66;outline-offset:-1px;pointer-events:none"></td>`)
          idx += 1
          continue
        }
        // Saturday this row cannot work: explicit red-X box, ONLY in a genuine weekend-continuity
        // gap — the row has work both before AND after this Saturday (rowFirstOcc < iso <
        // rowLastOcc), i.e. it ran Fri and continues Mon and skipped the Saturday because it is not
        // Saturday-eligible. Without this span guard the X would be drawn on every Saturday working
        // column (created for WS40/WS50 orange boxes) across all rows — including unrelated LOCOs
        // with no continuity. Saturdays outside the row's span fall through to the empty-cell
        // branch below and stay blank.
        // Gated on satOccRow rather than the WS rule: a hand-moved row genuinely MAY work the
        // Saturday, so stamping "cannot work" on it would be a lie — a Saturday it simply does not
        // use falls through to an ordinary empty cell instead.
        if (
          isSaturdayIso(d.iso) && !satOccRow &&
          rowFirstOcc && rowLastOcc && d.iso > rowFirstOcc && d.iso < rowLastOcc &&
          !(startIso && d.iso < startIso)
        ) {
          parts.push(`<td data-iso="${esc(d.iso)}" style="${todayBorderFor(d.iso)}background:#F3F4F6;border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px;padding:0">${_satBlockedCellInner()}</td>`)
          idx += 1
          continue
        }
        // Early-finish recovery placeholder (req 3): ORANGE hatched box on a weekday the
        // conflict WS (WS40/WS50) would have extended into if it had not used a Saturday —
        // trailing AFTER the WS block (vs displacement, which leads before it). Cells here are
        // empty (allocated days already returned above). Visual ONLY: no delay/PD/conflict.
        if (wsRecovSet && wsRecovSet.has(d.iso) && !(startIso && d.iso < startIso)) {
          parts.push(`<td data-iso="${esc(d.iso)}" title="Tempo recuperado pelo uso de sábado — a workstation terminaria aqui sem o sábado" style="${todayBorderFor(d.iso)}background:repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px);border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px;outline:1px solid ${ORANGE}66;outline-offset:-1px;pointer-events:none"></td>`)
          idx += 1
          continue
        }
        // Empty working day: batch consecutive empty working days into one colspan <td>.
        // For sparse LOCOs (active 2 months out of 12), this collapses ~200 empty weekday
        // cells into a single element — the single biggest HTML size reduction.
        // Do not batch across displacement / recovery days — they need individual cells.
        // Also never batch across OR starting from today, so the Today highlight is a single
        // day cell whose right border lands on today's own edge (not the run's end).
        let end = idx + 1
        if (d.iso !== todayIso) {
          while (
            end < dateInfo.length &&
            !isNW(dateInfo[end]) &&
            !dr.cells[dateInfo[end].iso] &&
            !(wsDispSet && wsDispSet.has(dateInfo[end].iso)) &&
            !(wsRecovSet && wsRecovSet.has(dateInfo[end].iso)) &&
            dateInfo[end].iso !== todayIso   // never batch across today
          ) end++
        }
        const span = end - idx
        const sa = span > 1 ? ` colspan="${span}"` : ''
        parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:${bg};border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${rowBottomBorder};border-top:${rowTopBorder};height:34px"></td>`)
        idx = end
      }

      parts.push('</tr>')
      groupRowCursor += 1
    }
    continue
    }

    // ── COLLAPSED: one aggregated summary row (the old WORK rendering, unchanged visuals) ──
    // Rendered for every non-expanded workstation, zero-hour WS included (same rule the old
    // WORK mode had via group.workstations).
    const wst = rawWst
    const isGroupFirstRow = groupRowCursor === 0
    const wsLabel = wsSubLabel(wst.ws, wst.subarea, '—')
    const colTopBorder = isGroupFirstRow
      ? (notFirstGroup ? `${DAY_BORDER} solid #D1D5DB` : topBorder)
      : ((prevItem && prevItem.expanded) ? `${DAY_BORDER} solid #D1D5DB` : `${DAY_BORDER} solid #E5E7EB`)
    const colBottomBorder = groupRowCursor === lastGroupRowIndex ? `${DAY_BORDER} solid #D1D5DB` : 'none'
    const wsColId = `wsc_${safeId(group.linha)}_${safeId(group.wo)}_${safeId(group.task_name)}_${safeId(String(group.start_ms ?? ''))}_${safeId(wst.ws)}_${safeId(wst.subarea ?? '')}`

    // Aggregate hours per day across all desc_rows of this WS (only within the date filter window).
    // Track AM/PM occupancy so the WS row shows a HALF box whenever the day is truly half-occupied
    // (a genuine 0.5-day finish), and a FULL box only when both halves are filled — collapsing the
    // flag on any second source (the old rule) wrongly upgraded real half-days to full boxes.
    const aggByDay = new Map()
    for (const dr of wst.desc_rows) {
      for (const [iso, cell] of Object.entries(dr.cells || {})) {
        if (!dateIsoSet.has(iso)) continue
        let a = aggByDay.get(iso)
        if (!a) { a = { hh: 0, am: false, pm: false }; aggByDay.set(iso, a) }
        a.hh += Number(cell.hh) || 0
        if (cell.half === 'first') a.am = true
        else if (cell.half === 'second') a.pm = true
        else { a.am = true; a.pm = true }
      }
    }
    for (const a of aggByDay.values()) a.half = (a.am && a.pm) ? undefined : (a.am ? 'first' : 'second')
    // Unused-Saturday placeholder span (same rule as FULL mode): conflict WS only, bounded
    // to this WS's occupied span so the orange box fills only an internal gap.
    // Occupancy span of this WS (first/last aggregated day). Bounds both Saturday placeholders
    // to an internal gap (see FULL mode): orange for WS40/WS50, red-X weekend-continuity marker
    // for other WS — never globally, only when the WS spans the Saturday (Fri→Mon).
    const colSatCapRow = isSatCapableWs(wst.ws)
    // May this station OCCUPY a working Saturday? Same split as FULL mode: colSatCapRow (the
    // WS40/WS50 scheduling rule) keeps driving the ORANGE optimizer placeholder, while occupancy
    // also admits a station a planner moved by hand. WORK renders the station as ONE aggregated
    // row, so _satManual here means "the ws edit, or any of its Componente edits, was hand-moved".
    const colSatOccRow = colSatCapRow || wst._satManual === true
    const _colOccKeys = [...aggByDay.keys()].sort()
    const colRowFirstOcc = _colOccKeys[0]
    const colRowLastOcc = _colOccKeys[_colOccKeys.length - 1]
    // Displacement (optimization hatched box) — SAME source/logic as FULL mode, just
    // unioned to the WS level since WORK aggregates desc_rows into one WS row. The
    // displacement map is keyed per ORIGINAL desc-row index, so union every row's set.
    const colDispSet = new Set()
    const colRecovSet = new Set()
    const colDispHalf = {}, colRecovHalf = {}
    if (displacementSets || state.recoveredSets || displacementHalf || state.recoveredHalf) {
      const colDispKeyPrefix = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}||${wst.ws}||${wst.subarea ?? ''}`
      ;(wst.desc_rows || []).forEach((_dr, origIdx) => {
        const ds = displacementSets && displacementSets[`${colDispKeyPrefix}||${origIdx}`]
        if (ds) for (const iso of ds) colDispSet.add(iso)
        const rs = state.recoveredSets && state.recoveredSets[`${colDispKeyPrefix}||${origIdx}`]
        if (rs) for (const iso of rs) colRecovSet.add(iso)
        const dsh = displacementHalf && displacementHalf[`${colDispKeyPrefix}||${origIdx}`]
        if (dsh) Object.assign(colDispHalf, dsh)
        const rsh = state.recoveredHalf && state.recoveredHalf[`${colDispKeyPrefix}||${origIdx}`]
        if (rsh) Object.assign(colRecovHalf, rsh)
      })
    }
    const wsColDispSet = colDispSet.size > 0 ? colDispSet : null
    // Early-finish recovery (req 3) — ORANGE trailing placeholder, same union pattern as displacement.
    const wsColRecovSet = colRecovSet.size > 0 ? colRecovSet : null
    // Half-day (0.5) delay/recovery boundaries at the collapsed-WS level (same union pattern).
    const wsColDispHalf  = Object.keys(colDispHalf).length  ? colDispHalf  : null
    const wsColRecovHalf = Object.keys(colRecovHalf).length ? colRecovHalf : null

    const colCellStyle = `border-right:${DAY_BORDER} solid #C9CFD6;border-bottom:${colBottomBorder};border-top:${colTopBorder};height:34px;`
    // First tier row of the group carries the LOCO nav anchor + the frozen LINHA/MODELO/LOCO
    // cells spanning every visible tier row.
    const wsColRowId = isGroupFirstRow ? ` id="wsc_loco_${safeId(group.linha)}_${safeId(group.wo)}_${safeId(group.task_name)}_${safeId(String(group.start_ms ?? ''))}"` : ''

    // Right-click edit identity for this collapsed workstation row → "Editar Workstation".
    // `data-ws-multi` tells Move Mode whether this WS has >1 Componente to drill into: a FIRST +/−
    // on a multi-Componente WS auto-expands (expand-only) to reach component-level editing, but a
    // single-Componente WS has nothing to expand, so +/− edits its duration directly (Move Mode).
    const wsMulti = canExpand && dd.dedupedRows.length > 1
    // Dropped when the WS is locked (Protection Days or anchored after it) — no Move Mode / edit menu.
    const wsRowEditAttrs = isLockedWs(wst.ws, wst.subarea) ? '' : `data-row-edit="ws" data-ws-multi="${wsMulti ? '1' : '0'}" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-ws="${esc(wst.ws)}" data-subarea="${esc(wst.subarea ?? '')}" data-takt="${esc(String(group.takt ?? ''))}"`

    parts.push(`<tr class="gantt-ws-col" ${wsRowEditAttrs}${wsColRowId} style="height:${rowH}px">`)
    if (isGroupFirstRow) pushFrozenCells(colTopBorder)
    // WS name cell — same data attrs as desc row so click-to-navigate still works.
    // Conflict icon prepended (same rule as FULL) when this WS has any conflict.
    // Chevron only when the workstation has MULTIPLE Componente rows to reveal.
    const colWsConflictIcon = wsHasConflict(wst) ? `<span style="display:inline-flex;flex-shrink:0">${_warnIcon(RED, 11)}</span>` : ''
    const colChevron = (canExpand && dd.dedupedRows.length > 1) ? _wsToggleChevron(wsToggleKey, false) : ''
    // Work Mode day boxes show ONLY the workstation code (e.g. "WS42") — no description/subarea
    // suffix — to keep this dense, repeated-across-the-timeline label uncluttered. The fuller name
    // still lives in the sticky WS cell + its tooltip and in FULL mode's Componente rows.
    // (Crash-safety: `dd` is UNDEFINED for a WS whose rows are all trimmed by Hide-before-Start —
    // it must never be dereferenced on this collapsed path, which is what threw
    // "Cannot read properties of undefined (reading 'dedupedRows')".)
    const wsBoxName = wst.ws
    parts.push(`<td id="${wsColId}" title="${esc(wsLabel)} — Clique para ir ao início desta workstation no Gantt" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-ws="${esc(wst.ws)}" data-subarea="${esc(wst.subarea ?? '')}" data-start-iso="${esc(_wsFirstIsoOf(wst))}" style="position:sticky;left:${FROZEN_LEFT_PAD + 190}px;z-index:47;background:${bg};background-clip:padding-box;border-bottom:${colBottomBorder};border-top:${colTopBorder};border-right:${DAY_BORDER} solid ${RED};box-shadow:inset -1px 0 0 ${RED};cursor:pointer;vertical-align:middle;font-weight:700;color:#111827;font-size:10px;height:34px;padding:0 8px;width:220px;min-width:220px;max-width:220px">${colChevron}<div style="display:flex;align-items:center;gap:4px;overflow:hidden${colChevron ? ';margin-left:12px' : ''}">${colWsConflictIcon}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(wsLabel)}</span></div></td>`)
    // Day cells — aggregated hours for this WS
    // Move-description indicator: drawn on this row's FIRST box and consumed there (see FULL
    // mode). The aggregated row represents EVERY Componente of the WS, so its badge merges the
    // WS-scope trail with each Componente's trail — collapsing must never hide a commentary.
    // Raw part-number rows of one Componente share the SAME stamped notes array (one scoped
    // edit), so dedupe by reference to avoid multiplying entries.
    let colMergedNotes = (wst._moveNotes && wst._moveNotes.length) ? wst._moveNotes : null
    {
      const seenTrails = new Set()
      for (const dr of (wst.desc_rows || [])) {
        const n = dr._moveNotes
        if (n && n.length && !seenTrails.has(n)) { seenTrails.add(n); colMergedNotes = _mergeNotes(colMergedNotes, n) }
      }
    }
    let colNoteBadge = moveNoteBadge(colMergedNotes)
    let ci = 0
    while (ci < dateInfo.length) {
      const d = dateInfo[ci]
      if (isNW(d)) {
        // Never batch across OR starting from today (same rule as FULL mode), so the Today
        // bracket stays a single day cell in the collapsed WS row too.
        let end = ci + 1
        if (d.iso !== todayIso) {
          while (end < dateInfo.length && isNW(dateInfo[end]) && dateInfo[end].iso !== todayIso) end++
        }
        const span = end - ci
        const sa = span > 1 ? ` colspan="${span}"` : ''
        parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:#E5E7EB;border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${colBottomBorder};border-top:${colTopBorder};height:34px"></td>`)
        ci = end
        continue
      }
      // Saturday occupancy is limited to stations that may actually hold it (WS40/WS50 by rule, or
      // hand-moved in Move Mode): any other WS never renders an allocation box on a Saturday (it
      // falls through to the red-X "cannot work" box), so it can never look like the WS worked on a
      // Saturday or feed delay calculations.
      const agg = (isSaturdayIso(d.iso) && !colSatOccRow) ? undefined : aggByDay.get(d.iso)
      if (agg) {
        const cellBg = colorByWs ? WS_COLORS[wsIndex[_wsNormKey(wst.ws)] ?? 0] : FW_LIGHT[fwIndex[d.fw] ?? 0]
        // WORK mode: same text layout as FULL — WS text may wrap to 2 lines, then
        // truncates with an ellipsis; hours sit on their own non-shrinking line so
        // overflowing text can never hide them (lines 1-2 text, line 3 hours).
        const wsLine = `<span style="font-weight:800;font-size:9px;color:#111827;line-height:1.1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;max-width:100%;word-break:break-word">${esc(wsBoxName)}</span>`
        const hhLine = `<span style="font-weight:700;font-size:9px;color:#1F2937;line-height:1.1;flex-shrink:0">${agg.hh.toFixed(1)}h</span>`
        const wsNormCol = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
        const isColConflict = conflictSet && conflictSet.has(`${d.iso}||${wsNormCol}`)
        const isColOverlap = !isColConflict && state.overlapSet && state.overlapSet.has(`${d.iso}||${wsNormCol}`)
        const colConflictStyle = isColConflict
          ? `outline:2px solid ${RED};outline-offset:-2px;z-index:1;`
          : (isColOverlap ? `outline:2px solid ${ORANGE};outline-offset:-2px;z-index:1;` : '')
        if (agg.half === 'first' || agg.half === 'second') {
          const hatchSide  = agg.half === 'first' ? 'right' : 'left'
          // Empty half becomes a RED (delay) / ORANGE (recovery) half box for a 0.5-day boundary; see FULL mode.
          const emptySide  = hatchSide === 'left' ? 'first' : 'second'
          const halfIsDisp  = wsColDispHalf  && wsColDispHalf[d.iso]  === emptySide && !(startIso && d.iso < startIso)
          const halfIsRecov = !halfIsDisp && wsColRecovHalf && wsColRecovHalf[d.iso] === emptySide && !(startIso && d.iso < startIso)
          const hatchBg = halfIsDisp
            ? `repeating-linear-gradient(-45deg,${RED}22 0,${RED}22 3px,transparent 3px,transparent 9px)`
            : halfIsRecov
              ? `repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px)`
              : `repeating-linear-gradient(-45deg,rgba(0,0,0,0.08) 0,rgba(0,0,0,0.08) 2px,transparent 2px,transparent 7px)`
          const hatchBorder = halfIsDisp ? `${RED}66` : halfIsRecov ? `${ORANGE}66` : 'rgba(0,0,0,0.18)'
          const hatchTitle  = halfIsDisp ? ' title="Deslocamento (meio dia)"' : halfIsRecov ? ' title="Tempo recuperado (meio dia)"' : ''
          const hatchDiv   = `<div${hatchTitle} style="position:absolute;top:0;${hatchSide}:0;width:50%;height:100%;background:${hatchBg};border-${hatchSide}:1px dashed ${hatchBorder};box-sizing:border-box;pointer-events:none"></div>`
          const contentDiv = `<div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">${wsLine}${hhLine}</div>`
          parts.push(`<td data-iso="${esc(d.iso)}" class="gbx" data-hh="${Number(agg.hh) || 0}" style="${todayBorderFor(d.iso)}${colCellStyle}${colConflictStyle}background:${cellBg};vertical-align:top;text-align:center;padding:0;position:relative;overflow:hidden;max-width:0">${hatchDiv}${contentDiv}${todayOverlay(d.iso)}${colNoteBadge}</td>`)
          colNoteBadge = ''
          ci += 1
          continue
        }
        parts.push(`<td data-iso="${esc(d.iso)}" class="gbx" data-hh="${Number(agg.hh) || 0}" style="${todayBorderFor(d.iso)}${colCellStyle}${colConflictStyle}background:${cellBg};vertical-align:middle;text-align:center;padding:2px;position:relative;overflow:hidden;max-width:0"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;height:30px;overflow:hidden;width:100%">${wsLine}${hhLine}</div>${todayOverlay(d.iso)}${colNoteBadge}</td>`)
        colNoteBadge = ''
        ci += 1
        continue
      }
      // Displacement placeholder (optimization hatched box) — SAME rule/style as FULL:
      // a red hatched cell for days consumed by the optimization shift, suppressed before
      // the LOCO start, and never on a Saturday for a non-WS40/WS50 workstation.
      if (
        wsColDispSet && wsColDispSet.has(d.iso) && !(startIso && d.iso < startIso) &&
        !(isSaturdayIso(d.iso) && !colSatOccRow)
      ) {
        parts.push(`<td data-iso="${esc(d.iso)}" title="Deslocamento" style="${todayBorderFor(d.iso)}${colCellStyle}background:repeating-linear-gradient(-45deg,${RED}22 0,${RED}22 3px,transparent 3px,transparent 9px);outline:1px solid ${RED}44;outline-offset:-1px;pointer-events:none;max-width:0"></td>`)
        ci += 1
        continue
      }
      // Unused-Saturday placeholder (ORANGE) — conflict WS (WS40/WS50) Saturday it could have
      // used but the optimizer left empty, inside the WS block. Visual only, no metric meaning.
      if (
        colSatCapRow && isSaturdayIso(d.iso) &&
        colRowFirstOcc && colRowLastOcc && d.iso > colRowFirstOcc && d.iso < colRowLastOcc &&
        !(startIso && d.iso < startIso)
      ) {
        parts.push(`<td data-iso="${esc(d.iso)}" title="Sábado disponível não utilizado" style="${todayBorderFor(d.iso)}${colCellStyle}background:repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px);outline:1px solid ${ORANGE}66;outline-offset:-1px;pointer-events:none;max-width:0"></td>`)
        ci += 1
        continue
      }
      // Working Saturday this station can't operate → explicit red-X box, ONLY in a genuine
      // weekend-continuity gap (work before AND after this Saturday). Without the span guard the X
      // would be drawn on every Saturday working column across all WS rows. Gated on occupancy, not
      // the WS rule, so a hand-moved station is never told it "cannot" work a day it just worked.
      if (
        isSaturdayIso(d.iso) && !colSatOccRow &&
        colRowFirstOcc && colRowLastOcc && d.iso > colRowFirstOcc && d.iso < colRowLastOcc &&
        !(startIso && d.iso < startIso)
      ) {
        parts.push(`<td data-iso="${esc(d.iso)}" style="${todayBorderFor(d.iso)}${colCellStyle}background:#F3F4F6;max-width:0;padding:0">${_satBlockedCellInner()}</td>`)
        ci += 1
        continue
      }
      // Early-finish recovery placeholder (req 3) — ORANGE hatched box trailing AFTER the WS
      // block, where it would have extended without the Saturday. Visual only, no metric meaning.
      if (wsColRecovSet && wsColRecovSet.has(d.iso) && !(startIso && d.iso < startIso)) {
        parts.push(`<td data-iso="${esc(d.iso)}" title="Tempo recuperado pelo uso de sábado — a workstation terminaria aqui sem o sábado" style="${todayBorderFor(d.iso)}${colCellStyle}background:repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px);outline:1px solid ${ORANGE}66;outline-offset:-1px;pointer-events:none;max-width:0"></td>`)
        ci += 1
        continue
      }
      let end = ci + 1
      if (d.iso !== todayIso) {   // never batch across OR starting from today (Today bracket)
        while (
          end < dateInfo.length && !isNW(dateInfo[end]) && !aggByDay.has(dateInfo[end].iso) &&
          dateInfo[end].iso !== todayIso &&                           // never batch across today
          !(wsColDispSet && wsColDispSet.has(dateInfo[end].iso)) &&   // don't batch across displacement days
          !(wsColRecovSet && wsColRecovSet.has(dateInfo[end].iso))    // don't batch across recovery days
        ) end++
      }
      const span = end - ci
      const sa = span > 1 ? ` colspan="${span}"` : ''
      parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:${bg};border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${colBottomBorder};border-top:${colTopBorder};height:34px"></td>`)
      ci = end
    }
    parts.push('</tr>')
    groupRowCursor += 1
  }

  // ── Collapsed LOCO summary row (rendered INSTEAD of the tree when the LOCO is collapsed) ──
  // Single visible row per group aggregating all WS hours — the old LOCO-mode row, WS summary
  // card included. Never emitted alongside the tree rows: only the visible variant may exist
  // (display:none <tr>s still count in the HTML rowspan algorithm).
  else {
    const locoColId = `lcc_loco_${safeId(group.linha)}_${safeId(group.wo)}_${safeId(group.task_name)}_${safeId(String(group.start_ms ?? ''))}`
    const locoTopBorder = notFirstGroup ? `${DAY_BORDER} solid #D1D5DB` : topBorder
    // Aggregate hours per day; also track active WS per day
    const aggByDay = new Map()        // iso → total hh
    const wsActiveOnDay = new Map()   // iso → Set of ws labels active that day
    const wsHoursOnDay = new Map()    // iso → Map(ws → hh) for top-N WS box content
    // LOCO-level displacement set (optimization hatched box) — union of EVERY WS row's
    // displacement isos for this LOCO, since LOCO mode collapses all WS into one row.
    // Same source/logic as FULL; keyed per ORIGINAL desc-row index.
    const locoDispSet = new Set()
    const locoRecovSet = new Set()   // early-finish recovery (req 3), ORANGE trailing placeholders
    // NOTE: the collapsed LOCO-summary row aggregates hours to a single full-day value per day and has
    // no half-day cell rendering, so 0.5-day delays are shown here at whole-day granularity (the detailed
    // FULL and collapsed-WS views carry the half boxes). Nothing to union for halves at this tier.
    let totalHh = 0
    let firstIso = null
    let lastIso  = null
    for (const wst of visibleWorkstations) {
      if (displacementSets || state.recoveredSets) {
        const locoDispKeyPrefix = `${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}||${wst.ws}||${wst.subarea ?? ''}`
        ;(wst.desc_rows || []).forEach(dr => {
          const ds = displacementSets && displacementSets[`${locoDispKeyPrefix}||${dr._origIdx}`]
          if (ds) for (const iso of ds) locoDispSet.add(iso)
          const rs = state.recoveredSets && state.recoveredSets[`${locoDispKeyPrefix}||${dr._origIdx}`]
          if (rs) for (const iso of rs) locoRecovSet.add(iso)
        })
      }
      for (const dr of wst.desc_rows) {
        for (const [iso, cell] of Object.entries(dr.cells || {})) {
          const h = Number(cell.hh) || 0
          if (!aggByDay.has(iso)) aggByDay.set(iso, 0)
          aggByDay.set(iso, aggByDay.get(iso) + h)
          totalHh += h
          if (firstIso === null || iso < firstIso) firstIso = iso
          if (lastIso  === null || iso > lastIso)  lastIso  = iso
          if (!wsActiveOnDay.has(iso)) wsActiveOnDay.set(iso, new Set())
          wsActiveOnDay.get(iso).add(wst.ws || '')
          // Per-day per-WS hours (summed across desc_rows of the same WS that day).
          // Keyed by RAW ws (so WS_COLORS/wsIndex lookup stays valid); value carries
          // the displayed "WORKSTATION - SUBAREA" label for the LOCO box text.
          const rawWs = wst.ws || ''
          const wsBoxLabel = wsSubLabel(rawWs, wst.subarea, '-')
          let wm = wsHoursOnDay.get(iso); if (!wm) { wm = new Map(); wsHoursOnDay.set(iso, wm) }
          const ent = wm.get(rawWs)
          if (ent) ent.hh += h
          else wm.set(rawWs, { hh: h, label: wsBoxLabel })
        }
      }
    }
    // WS count from ALL workstations on the group (not just those with cells in date window)
    const wsCount = group.workstations.length
    // Active business days = days in aggByDay that are in the date range
    const daysActive = aggByDay.size
    // Conflict count: distinct WS of this LOCO that have a conflict on a day that
    // is ACTUALLY RENDERED (in the visible window). Must use the exact same test
    // as the red border (dateIsoSet + conflictSet over the visible cells) so the
    // summary count never diverges from the outlines — e.g. a residual conflict on
    // a day outside the window must NOT inflate the count after optimization.
    const conflictingWs = new Set()
    if (conflictSet) {
      for (const wst of visibleWorkstations) {
        const wsNorm = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
        let hit = false
        for (const dr of wst.desc_rows) {
          for (const iso of Object.keys(dr.cells || {})) {
            if (dateIsoSet.has(iso) && conflictSet.has(`${iso}||${wsNorm}`)) { hit = true; break }
          }
          if (hit) break
        }
        if (hit) conflictingWs.add(wsNorm)
      }
    }
    const conflictCount = conflictingWs.size
    // Format ISO date → DD/MM/YYYY
    const fmtIso = iso => iso && iso.length >= 10 ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '—'
    const startMsIso = group.start_ms != null && group.start_ms !== '' ? String(group.start_ms).slice(0,10) : null
    const startMsLabel = startMsIso ? fmtIso(startMsIso) : '—'
    const firstLabel = firstIso ? fmtIso(firstIso) : '—'
    const lastLabel  = lastIso  ? fmtIso(lastIso)  : '—'
    const totalHhFmt = totalHh > 0
      ? totalHh.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : '0,0'

    // Protection Days: count cells in the PROTECTIONDAYS workstation
    let pdDays = 0
    for (const wst of group.workstations) {
      const wsN = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
      if (wsN === 'PROTECTIONDAYS' || wsN === 'PROTECAO' || wsN === 'DIASDEPROTECAO' || wsN === 'PROTECTIONDAY' || wsN.includes('PROTECTION')) {
        for (const dr of wst.desc_rows)
          pdDays += Object.keys(dr.cells || {}).length
        break
      }
    }

    // Progress along the LOCO's OWN scheduled window: elapsed active days / total active days.
    // A subtle timeline bar (the user liked the "little progress line") — NOT a "vs today" callout;
    // today only sets the fill edge (0% before it starts, 100% once past the last active day).
    const nowIso = localTodayIso()
    let elapsedDays = 0
    for (const iso of aggByDay.keys()) if (iso <= nowIso) elapsedDays++
    const pct = daysActive > 0 ? Math.max(0, Math.min(100, Math.round(100 * elapsedDays / daysActive))) : 0
    const barColor = pct >= 100 ? '#22C55E' : '#94A3B8'   // green once the whole window is behind us
    // Hours delivered so far, on the SAME "elapsed" definition as the bar above: the hours of every
    // active day up to and including today. Shown next to the day count only while the loco is still
    // running — at 100% the pair would just read "130/130h" and repeat what the bar already says.
    let elapsedHh = 0
    for (const [iso, v] of aggByDay) if (iso <= nowIso) elapsedHh += (Number(v) || 0)
    const hoursProgress = pct < 100 && totalHh > 0
      ? ` · ${Math.round(elapsedHh)}/${Math.round(totalHh)}h`
      : ''

    // WS summary card — intentionally CALM and timeline-focused. Hours, Protection Days, conflicts
    // and the Schedule start date are ALL already shown (with icons) in the MODELO cell of this same
    // row, so the card no longer repeats them; it carries only what MODELO can't: the scheduled
    // window, a slim progress bar, and the day / workstation counts. 220px × 102px (3 box lines).
    const wsCell = [
      `<div style="display:flex;flex-direction:column;justify-content:center;gap:8px;padding:8px 11px;width:100%;height:100%;box-sizing:border-box">`,
        // Scheduled window (headline)
        `<div style="display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden">`,
          `<span style="font-size:12.5px;font-weight:700;color:#374151;letter-spacing:.01em">${esc(firstLabel)}</span>`,
          `<span style="font-size:10px;color:#9CA3AF">→</span>`,
          `<span style="font-size:12.5px;font-weight:700;color:#374151;letter-spacing:.01em">${esc(lastLabel)}</span>`,
        `</div>`,
        // Slim progress bar + subdued percentage
        `<div style="display:flex;align-items:center;gap:7px">`,
          `<div style="flex:1;height:5px;background:#E5E7EB;border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${barColor};border-radius:3px"></div></div>`,
          `<span style="font-size:9px;font-weight:600;color:#9CA3AF;min-width:26px;text-align:right">${pct}%</span>`,
        `</div>`,
        // Meta counts
        `<div style="font-size:10px;font-weight:500;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${daysActive} dias úteis${hoursProgress}</div>`,
      `</div>`,
    ].join('')

    const locoNavAttrs = `data-loco-nav="true" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}"`

    // Identity on the summary row itself so a double-click on any of its day boxes can resolve
    // WHICH loco to expand (Task: LOCO-mode double-click → open the WS/Componente view). These are
    // plain data-* markers read ONLY by GanttTable.onDblClick; no click/contextmenu handler keys
    // off them, so single-click behaviour on this row is unchanged.
    parts.push(`<tr class="gantt-loco-col" id="${locoColId}" data-loco-dbl="1" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}">`)
    // Right-click LOCO-edit identity for the MODELO cell (present in every mode).
    const locoEditAttrs = `data-loco-edit="1" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-linha="${esc(group.linha)}" data-start-ms="${esc(String(group.start_ms ?? ''))}" data-takt="${esc(String(group.takt ?? ''))}" title="Clique direito para editar o LOCO"`
    // Frozen LINHA / MODELO / LOCO cells — same sticky style as the expanded tree. The LINHA
    // cell carries the ▶ expand chevron (top-left corner, visible in every layout incl. the
    // all-collapsed narrow mode where the WS card column is width-0).
    parts.push(`<td style="position:sticky;left:${FROZEN_LEFT_PAD}px;z-index:44;background:${RED_LT};background-clip:padding-box;border-top:${locoTopBorder};border-right:${DAY_BORDER} solid ${RED};border-bottom:${DAY_BORDER} solid #D1D5DB;box-shadow:inset -1px 0 0 ${RED};width:52px;min-width:52px;max-width:52px;overflow:hidden;vertical-align:middle;text-align:center;font-weight:700;color:#1A1A2E;font-size:16px;padding:0">${_locoToggleChevron(group, false)}<div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;width:52px;min-height:34px;padding:2px;${frozenLabelStyle(group.linha, 16, 102)}">${esc(group.linha)}</div></td>`)
    parts.push(`<td ${locoEditAttrs} style="position:sticky;left:${FROZEN_LEFT_PAD + 52}px;z-index:45;background:${RED_LT};background-clip:padding-box;border-top:${locoTopBorder};border-right:${DAY_BORDER} solid ${RED};border-bottom:${DAY_BORDER} solid #D1D5DB;box-shadow:inset -1px 0 0 ${RED};width:88px;min-width:88px;max-width:88px;overflow:hidden;vertical-align:middle;text-align:center;font-weight:800;color:#1A1A2E;font-size:18px;padding:0">${modeloCellInner(group, state, 102)}</td>`)
    // LOCO (task_name) cell — in LOCO mode this is now the displacement/navigation
    // trigger (the WS summary column is collapsed away). Carries the same data-loco-nav
    // attrs the WS card used, so the click handler behaves identically.
    parts.push(`<td ${locoNavAttrs} data-loco-edit="1" data-takt="${esc(String(group.takt ?? ''))}" style="position:sticky;left:${FROZEN_LEFT_PAD + 140}px;z-index:46;background:${RED_LT};background-clip:padding-box;border-top:${locoTopBorder};border-right:${DAY_BORDER} solid ${RED};border-bottom:${DAY_BORDER} solid #D1D5DB;box-shadow:inset -1px 0 0 ${RED};width:50px;min-width:50px;max-width:50px;overflow:hidden;vertical-align:middle;text-align:center;font-weight:700;color:#1A1A2E;font-size:18px;padding:0;cursor:pointer"><div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;width:50px;min-height:34px;padding:2px;${frozenLabelStyle(group.task_name, 18, 102)}">${esc(group.task_name)}</div></td>`)
    // WS column — rich summary. Collapsed to 0 width in LOCO mode (gantt-wscol-cell +
    // the col:nth-child(4) rule). Keeps its nav attrs as a harmless redundancy; when
    // visible (it isn't in this experiment) the click still works.
    parts.push(`<td class="gantt-wscol-cell" ${locoNavAttrs} style="position:sticky;left:${FROZEN_LEFT_PAD + 190}px;z-index:47;background:${bg};background-clip:padding-box;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};border-right:${DAY_BORDER} solid ${RED};box-shadow:inset -1px 0 0 ${RED};vertical-align:middle;height:102px;padding:0;width:220px;min-width:220px;max-width:220px;cursor:pointer">${wsCell}</td>`)
    // Day cells — total aggregated hours for this LOCO.
    // LOCO-mode display strategy (Task 4): a type WITH a priority list uses the WS ranking
    // (Strategy A — New Locos and Motor Diesel); every other type uses the "N WS" aggregate when
    // multiple WS compete on a day (Strategy B). A day with a single active WS always renders
    // exactly as before, in either strategy.
    const wsRankFn = wsRankFnForType(_locoTypeOf(group.linha))
    let ci = 0
    while (ci < dateInfo.length) {
      const d = dateInfo[ci]
      if (isNW(d)) {
        // Never batch across OR starting from today (same rule as FULL mode), so the Today
        // bracket stays a single day cell in the LOCO row too.
        let end = ci + 1
        if (d.iso !== todayIso) {
          while (end < dateInfo.length && isNW(dateInfo[end]) && dateInfo[end].iso !== todayIso) end++
        }
        const span = end - ci
        const sa = span > 1 ? ` colspan="${span}"` : ''
        parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:#E5E7EB;border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};height:52px"></td>`)
        ci = end
        continue
      }
      const hh = aggByDay.get(d.iso)
      if (hh !== undefined) {
        const cellBg = FW_LIGHT[fwIndex[d.fw] ?? 0]
        const activeWsSet = wsActiveOnDay.get(d.iso)
        const _wsKeyOf = ws => `${d.iso}||${String(ws).trim().toUpperCase().replace(/\s+/g, '')}`
        const locoDayConflict = conflictSet && activeWsSet && [...activeWsSet].some(ws => conflictSet.has(_wsKeyOf(ws)))
        // Allowed overlap on the LOCO row only when NO active WS is a true conflict that
        // day but at least one is an allowed boundary handoff → orange, else red.
        const locoDayOverlap = !locoDayConflict && state.overlapSet && activeWsSet && [...activeWsSet].some(ws => state.overlapSet.has(_wsKeyOf(ws)))
        const locoDayConflictStyle = locoDayConflict
          ? `outline:2px solid ${RED};outline-offset:-2px;z-index:1;`
          : (locoDayOverlap ? `outline:2px solid ${ORANGE};outline-offset:-2px;z-index:1;` : '')
        // Box content (Task 4): a SINGLE full box SECTION chosen deterministically, replacing the
        // old "top-2 WS by hours" stack. Which WS shows depends on the LOCO type:
        //   • one active WS on the day → that WS (name + hours), exactly as before, either strategy;
        //   • a RANKED type (New Locos, Motor Diesel), multiple WS → the highest-ranked WS by that
        //     type's priority list (Strategy A), or, if NONE of the day's WS are ranked, the
        //     "N WS" aggregate (Strategy A fallback);
        //   • other types, multiple WS → the "N WS" aggregate + total combined hours (Strategy B).
        // A WS/area filter has already stripped non-matching workstations upstream (scheduleFilteredGroups),
        // so a filtered WS is the only competitor here and is therefore always shown — filter override.
        const wm = wsHoursOnDay.get(d.iso)
        const dayEntries = wm ? [...wm.entries()] : []   // [rawWs, { hh, label }]
        // One full-height section for a single workstation (WS colour, name + hours) — the
        // unchanged single-WS rendering, reused by both strategies.
        // Font sizes here are LOCO-mode only: these boxes are a full 52px tall (vs the packed
        // FULL-mode rows), so the text can scale up without risking a clipped second line.
        const wsSection = (ws, label, hhVal) => {
          const wsColor = WS_COLORS[wsIndex[_wsNormKey(ws)] ?? 0]
          const nameLine = `<span style="font-weight:800;font-size:11px;color:#111827;line-height:1.1;overflow:hidden;max-width:100%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;text-align:center">${esc(label)}</span>`
          const hourLine = `<span style="font-weight:700;font-size:10.5px;color:#1F2937;line-height:1.1">${Number(hhVal).toFixed(1)}h</span>`
          return `<div style="flex:1 1 0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;background:${wsColor};width:100%;box-sizing:border-box;overflow:hidden;padding:0 2px">${nameLine}${hourLine}</div>`
        }
        // Aggregate section: "N WS" + total combined hours on a neutral (day) background.
        const aggSection = (n, totalHhVal) => {
          const nLine = `<span style="font-weight:800;font-size:11.5px;color:#111827;line-height:1.1;text-align:center">${n} Workstations</span>`
          const hLine = `<span style="font-weight:700;font-size:10.5px;color:#1F2937;line-height:1.1">${Number(totalHhVal).toFixed(1)}h</span>`
          return `<div style="flex:1 1 0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:${cellBg};width:100%;box-sizing:border-box;overflow:hidden;padding:0 2px">${nLine}${hLine}</div>`
        }
        let wsBlocks = ''
        if (dayEntries.length <= 1) {
          // Zero or one WS → render exactly as today (empty, or the single WS box).
          wsBlocks = dayEntries.map(([ws, info]) => wsSection(ws, info.label, info.hh)).join('')
        } else if (wsRankFn) {
          // Strategy A: the highest-ranked competing WS wins (lowest rank index).
          let best = null, bestRank = Infinity
          for (const [ws, info] of dayEntries) {
            const r = wsRankFn(ws)
            if (r < bestRank) { bestRank = r; best = [ws, info] }
          }
          wsBlocks = (best && bestRank !== Infinity)
            ? wsSection(best[0], best[1].label, best[1].hh)
            // Fallback: no ranked WS among several → aggregate (per the confirmed decision).
            : aggSection(dayEntries.length, dayEntries.reduce((s, [, i]) => s + i.hh, 0))
        } else {
          // Strategy B: aggregate "N WS" + total combined hours.
          wsBlocks = aggSection(dayEntries.length, dayEntries.reduce((s, [, i]) => s + i.hh, 0))
        }
        // max-width:0 forces table-layout:fixed to obey the colgroup width EXACTLY
        // (same standard day width as FULL/WORK); content can never widen the box.
        parts.push(`<td data-iso="${esc(d.iso)}" data-hh="${Number(hh) || 0}" style="${todayBorderFor(d.iso)}border-right:${DAY_BORDER} solid #C9CFD6;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};height:52px;${locoDayConflictStyle}position:relative;vertical-align:top;text-align:center;padding:0;overflow:hidden;max-width:0"><div style="display:flex;flex-direction:column;align-items:stretch;justify-content:stretch;height:100%;min-height:52px;width:100%">${wsBlocks}</div>${todayOverlay(d.iso)}</td>`)
        ci += 1
        continue
      }
      // Displacement placeholder (optimization hatched box) — SAME rule/style as FULL,
      // aggregated to the LOCO row. Suppressed before the LOCO start; 52px to match the
      // LOCO row height.
      if (locoDispSet.size > 0 && locoDispSet.has(d.iso) && !(startIso && d.iso < startIso)) {
        parts.push(`<td data-iso="${esc(d.iso)}" title="Deslocamento" style="${todayBorderFor(d.iso)}border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};height:52px;background:repeating-linear-gradient(-45deg,${RED}22 0,${RED}22 3px,transparent 3px,transparent 9px);outline:1px solid ${RED}44;outline-offset:-1px;pointer-events:none;max-width:0"></td>`)
        ci += 1
        continue
      }
      // Early-finish recovery placeholder (req 3) — ORANGE, aggregated to the LOCO row. Only
      // reached on EMPTY aggregated days (occupied days returned above), so a successor WS that
      // fills the recovered span suppresses it. Visual only, no metric meaning.
      if (locoRecovSet.size > 0 && locoRecovSet.has(d.iso) && !(startIso && d.iso < startIso)) {
        parts.push(`<td data-iso="${esc(d.iso)}" title="Tempo recuperado pelo uso de sábado — a workstation terminaria aqui sem o sábado" style="${todayBorderFor(d.iso)}border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};height:52px;background:repeating-linear-gradient(-45deg,${ORANGE}33 0,${ORANGE}33 3px,transparent 3px,transparent 9px);outline:1px solid ${ORANGE}66;outline-offset:-1px;pointer-events:none;max-width:0"></td>`)
        ci += 1
        continue
      }
      let end = ci + 1
      if (d.iso !== todayIso) {   // never batch across OR starting from today (Today bracket)
        while (
          end < dateInfo.length && !isNW(dateInfo[end]) && !aggByDay.has(dateInfo[end].iso) &&
          dateInfo[end].iso !== todayIso &&                                 // never batch across today
          !(locoDispSet.size > 0 && locoDispSet.has(dateInfo[end].iso)) &&   // don't batch across displacement days
          !(locoRecovSet.size > 0 && locoRecovSet.has(dateInfo[end].iso))    // don't batch across recovery days
        ) end++
      }
      const span = end - ci
      const sa = span > 1 ? ` colspan="${span}"` : ''
      parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:${bg};border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${DAY_BORDER} solid #D1D5DB;border-top:${locoTopBorder};height:52px"></td>`)
      ci = end
    }
    parts.push('</tr>')
  }

  // Close this LOCO's <tbody> (opened right after the groupRows guard).
  parts.push('</tbody>')
}

// Detect conflicts: a Set of "${iso}||${wsNorm}" keys where two or more distinct LOCOs have
// cells on the same day in the same WS. Only the CONFLICT WORKSTATIONS are scanned.
//
// Two sets, deliberately:
//   • CONFLICT_WS_PHYSICAL — WS40/WS50, the real shared constrained resource. Read by rules that
//     model PHYSICS (the Global-cascade cross-Type exception below). Never overridable, same
//     reason SAT_CAPABLE_WS and the backend optimizer's TARGET_WS are not.
//   • CONFLICT_WS — the DETECTION set actually scanned for conflicts. Defaults to the physical
//     pair but follows the session-only override the planner picks in ConflictWsModal (right-click
//     the footer Conflict Count). The host sends it on every build/patch as payload.conflictWs, so
//     the red/orange borders, the day-header icon, the WS icon and the MODELO conflict count all
//     evaluate exactly the set that is selected — never the stale default.
const CONFLICT_WS_PHYSICAL = new Set(['WS40', 'WS50'])
let CONFLICT_WS = new Set(CONFLICT_WS_PHYSICAL)
// Adopt the host's conflict-WS selection for this message. A missing/empty list means "no override"
// and restores the default pair, so an old payload (or a reset) behaves exactly as before.
function _applyConflictWs(list) {
  const next = Array.isArray(list)
    ? list.map(w => String(w || '').trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean)
    : []
  CONFLICT_WS = next.length ? new Set(next) : new Set(CONFLICT_WS_PHYSICAL)
}
// Small inline warning triangle used as the conflict indicator.
function _warnIcon(color, size) {
  const s = size || 10
  return `<svg width="${s}" height="${s}" viewBox="0 0 16 16" style="flex-shrink:0"><path d="M8 1.5 15 14H1z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/><rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="#fff"/><circle cx="8" cy="11.6" r="0.9" fill="#fff"/></svg>`
}

// Small shield icon used as the Protection Days indicator in the MODELO column.
function _shieldIcon(color, size) {
  const s = size || 10
  return `<svg width="${s}" height="${s}" viewBox="0 0 16 16" style="flex-shrink:0"><path d="M8 1.2 13.5 3v5.2c0 3.4-2.4 5.6-5.5 6.6C4.9 13.8 2.5 11.6 2.5 8.2V3z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/></svg>`
}

// Two-arrow swap icon — marks a LOCO whose WS40↔WS50 order was swapped during
// optimization (ES44 swap, available in any strategy). Neutral gray, icon-only.
function _swapIcon(color, size) {
  const s = size || 10
  return `<svg width="${s}" height="${s}" viewBox="0 0 16 16" style="flex-shrink:0"><path d="M4 4h7l-2-2M12 12H5l2 2" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

// Clock icon — marks a LOCO that uses a Saturday allocation (a WS40/WS50 op landed on a
// Saturday during optimization). Grey, icon-only. Sits next to the swap icon.
function _clockIcon(color, size) {
  const s = size || 10
  return `<svg width="${s}" height="${s}" viewBox="0 0 16 16" style="flex-shrink:0"><circle cx="8" cy="8" r="6.2" fill="none" stroke="${color}" stroke-width="1.4"/><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

// Format a Protection Days value: drop a trailing ".0" but keep real fractions
// (0.5, 1.5, 2.5 → "0.5", "1.5", "2.5"; 5 → "5").
function _fmtPd(v) {
  const n = Math.round((Number(v) || 0) * 2) / 2   // snap to nearest 0.5
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// Inner HTML for the MODELO frozen cell: the rotated MODELO value plus, beneath it,
// a compact conflict indicator. The LOCO's official start date is shown (vertical,
// grey) to the LEFT of MODELO; the right column stacks the "+N" shift badge, the
// Protection Days indicator, and the conflict indicator (top→bottom). In optimization
// mode PD and conflicts each show an original→new comparison when their value changed.
// Purely visual — counts come from the precomputed locoMeta passed by the host.
function modeloCellInner(group, state, availHeightPx) {
  const RED_C = '#D32F2F', GRAY = '#9CA3AF', GREEN = '#15803D'
  // Available vertical run for the rotated MODELO value (see frozenLabelStyle): the cell height.
  const modeloAvail = (typeof availHeightPx === 'number' && availHeightPx > 0) ? availHeightPx : FROZEN_LABEL_MAX_H
  // Locomotive model fallback: keep the ORIGINAL model name visible and append "(FB)" when the
  // hours/parameters were resolved from another model (see gantt_builder fallback).
  const wo = esc(group.wo) + (group.fallback ? ' (FB)' : '')
  const meta = state.locoMeta
    ? state.locoMeta[`${group.linha}||${group.wo}||${group.task_name}||${group.start_ms ?? ''}`]
    : null
  const conflicts = meta ? (meta.conflicts || 0) : 0
  const BLUE = '#2563EB'
  // Protection-Days indicator colours: BLUE while buffer remains, PD_LIMIT (orange) once it is spent.
  const PD_LIMIT = '#EA580C'
  const pd     = meta ? (meta.pd || 0) : 0

  // LOCO official start date (start_ms) — NOT the first scheduled op date. Shown to the
  // LEFT of the MODELO value, same vertical bottom-to-top orientation, grey and smaller.
  // Rendered for every LOCO row when a start date exists (kept aligned/consistent).
  const startIso = group.start_ms != null && group.start_ms !== '' ? String(group.start_ms).slice(0, 10) : ''
  const startLabel = startIso.length >= 10 ? `${startIso.slice(8, 10)}/${startIso.slice(5, 7)}/${startIso.slice(0, 4)}` : ''
  const startDateText = startLabel
    ? `<div title="Início do LOCO: ${startLabel}" style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:${GRAY};flex-shrink:0">${startLabel}</div>`
    : ''

  // LOCO total hours — red, vertical (same orientation as the start date), rounded
  // (e.g. "739h"). Stacked ABOVE the start date on the LEFT of the MODELO value, same
  // vertical bottom-to-top orientation.
  const hours = meta && meta.hours ? Math.round(meta.hours) : 0
  const hoursText = hours > 0
    ? `<div title="Horas totais do LOCO" style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:${RED_C};flex-shrink:0">${hours}h</div>`
    : ''

  // Left vertical stack: hours (red) on TOP, start date (grey) BELOW — both same
  // bottom-to-top orientation. rotate(180deg) flips visual order, so to render hours
  // above the date the hours element must come SECOND in the column source order.
  const leftStack = (hoursText || startDateText)
    ? `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:34px;flex-shrink:0">${hoursText}${startDateText}</div>`
    : ''

  // Rotated MODELO value (unchanged style).
  const modeloText = `<div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);display:flex;align-items:center;justify-content:center;min-height:34px;padding:2px;${frozenLabelStyle(wo, 18, modeloAvail)}">${wo}</div>`

  // Shift/delay badge "+N": in optimization mode the LOCO's applied shift (meta.shiftDays); in the base
  // (editing) view the LOCO's delay vs the active mode's reference — the same slip the red hatches show,
  // stamped as _delayDays where the hatches are computed (build + patchLocos). Shown only when > 0.
  const shiftDays = state.isOptView
    ? ((meta && meta.shiftDays) ? meta.shiftDays : 0)
    : (group._delayDays || 0)
  const shiftBadge = shiftDays > 0
    ? `<span title="${state.isOptView ? 'Deslocado' : 'Atrasado'} ${shiftDays} dia(s)" style="font-size:9px;font-weight:800;color:${RED_C};background:#FFEBEE;border:1px solid ${RED_C}55;border-radius:4px;padding:0 3px;line-height:1.4;flex-shrink:0">+${shiftDays}</span>`
    : ''

  // Resolved-conflict check icon (replaces any "Sem conflitos" text).
  const checkIcon = `<svg width="10" height="10" viewBox="0 0 16 16" style="flex-shrink:0"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="${GREEN}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

  // Conflict indicator block — sits to the RIGHT of MODELO (not below).
  // Zero conflicts ALWAYS renders the green check in the same slot (never empty / no
  // "0 conflitos" text). Conflicts (>0) keep icon + count + comparison behavior.
  const checkBlock = `<div title="Sem conflitos" style="display:inline-flex;align-items:center;gap:2px">${checkIcon}</div>`
  const countSpan  = `<span style="font-size:9px;font-weight:800;color:${RED_C};display:inline-flex;align-items:center;gap:2px">${_warnIcon(RED_C, 9)}${conflicts}</span>`
  let conflictBlock = ''
  if (state.isOptView && meta) {
    const orig = meta.origConflicts || 0
    // Comparison labels ONLY when the optimized count differs from the original.
    if (orig !== conflicts) {
      const origLine = `<span style="font-size:8px;font-weight:700;color:${GRAY};text-decoration:line-through;line-height:1.2">${_warnIcon(GRAY, 8)} ${orig}</span>`
      const newLine = conflicts === 0
        ? checkIcon
        : `<span style="font-size:9px;font-weight:800;color:${RED_C};line-height:1.2;display:inline-flex;align-items:center;gap:2px">${_warnIcon(RED_C, 9)}${conflicts}</span>`
      conflictBlock = `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">${origLine}${newLine}</div>`
    } else {
      // Unchanged count → plain indicator (icon+count) when >0, else the check icon.
      conflictBlock = conflicts > 0 ? `<div style="display:inline-flex;align-items:center;gap:2px">${countSpan}</div>` : checkBlock
    }
  } else {
    // Base view: icon + count when >0, else the check icon (same slot).
    conflictBlock = conflicts > 0 ? `<div style="display:inline-flex;align-items:center;gap:2px">${countSpan}</div>` : checkBlock
  }

  // Protection Days indicator — shield + value, to the RIGHT of MODELO. Mirrors the
  // conflict indicator's optimization-comparison behavior, but independently: in opt
  // view, when PD changed, show original (gray, strikethrough) above the new value;
  // otherwise just the current value. Base view shows the current value when PD > 0.
  const pdSingle = (val) => `<span style="font-size:9px;font-weight:800;color:${BLUE};line-height:1.2;display:inline-flex;align-items:center;gap:2px">${_shieldIcon(BLUE, 9)}${_fmtPd(val)}</span>`
  let pdBlock = ''
  if (state.isOptView && meta) {
    const origPd = meta.origPd || 0
    if (origPd !== pd) {
      // Comparison: original above (gray, struck through), new below.
      const origLine = `<span style="font-size:8px;font-weight:700;color:${GRAY};text-decoration:line-through;line-height:1.2;display:inline-flex;align-items:center;gap:2px">${_shieldIcon(GRAY, 8)}${_fmtPd(origPd)}</span>`
      const newLine  = pd > 0 ? pdSingle(pd) : `<span style="font-size:9px;font-weight:800;color:${BLUE};line-height:1.2;display:inline-flex;align-items:center;gap:2px">${_shieldIcon(BLUE, 9)}0</span>`
      pdBlock = `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">${origLine}${newLine}</div>`
    } else if (pd > 0) {
      pdBlock = `<div style="display:inline-flex;align-items:center;gap:2px">${pdSingle(pd)}</div>`
    }
  } else if (pd > 0) {
    pdBlock = `<div style="display:inline-flex;align-items:center;gap:2px">${pdSingle(pd)}</div>`
  } else if (meta && meta.pdExhausted) {
    // AT THE LIMIT: the buffer has been consumed to exactly zero. The indicator stays visible and
    // turns ORANGE — a spent buffer is a state the planner must see, and silently hiding it (which is
    // what `pd > 0` alone did) makes "0 protection days" indistinguishable from "no buffer here".
    // Move Mode refuses to consume further while this holds; shifting back restores the days and the
    // indicator returns to blue on its own, since `pd` is recomputed from the cells every render.
    pdBlock = `<div title="Dias de Proteção esgotados — limite atingido" style="display:inline-flex;align-items:center;gap:2px"><span style="font-size:9px;font-weight:800;color:${PD_LIMIT};line-height:1.2;display:inline-flex;align-items:center;gap:2px">${_shieldIcon(PD_LIMIT, 9)}0</span></div>`
  }

  // Loco Takt — red "T{value}" pill at the TOP of the MODELO column, ABOVE the swap
  // button. Rendered ONLY when a valid Takt exists (meta.takt is set by the host only
  // for finite values > 0); null/empty/missing/invalid → nothing. Matches the Takt
  // badge style used in the Resumo Geral LOCO list.
  const takt = (meta && typeof meta.takt === 'number' && isFinite(meta.takt) && meta.takt > 0) ? meta.takt : null
  const taktBadge = takt != null
    ? `<span title="Takt do LOCO" style="font-size:9px;font-weight:700;color:${RED_C};background:#FFF0F0;border:1px solid ${RED_C};border-radius:4px;padding:0 4px;line-height:1.5;flex-shrink:0">T${takt}</span>`
    : ''

  // WS40↔WS50 swap indicator — icon-only, RED, at the TOP of the right column. Shown when the swap was
  // applied by optimization (meta.swapped, opt view) OR when a MANUAL swap override is active on this
  // LOCO in the base view (any workstation stamped _swap by applyOverrideToGroup). It clears itself when
  // the override is reverted (no _swap → no icon). Saturday-usage clock — grey, optimization view only.
  const hasManualSwap = (group.workstations || []).some(w => w && w._swap)
  const swapIconHtml = ((state.isOptView && meta && meta.swapped) || hasManualSwap)
    ? `<span title="${(state.isOptView && meta && meta.swapped) ? 'WS40 ↔ WS50 trocadas na otimização' : 'WS40 ↔ WS50 trocadas (troca manual)'}" style="display:inline-flex;align-items:center">${_swapIcon(RED_C, 11)}</span>`
    : ''
  const satIconHtml = (state.isOptView && meta && meta.usesSaturday)
    ? `<span title="LOCO usa sábado (alocação em sábado na otimização)" style="display:inline-flex;align-items:center">${_clockIcon(GRAY, 11)}</span>`
    : ''
  const swapBlock = (swapIconHtml || satIconHtml)
    ? `<div style="display:inline-flex;align-items:center;gap:2px">${swapIconHtml}${satIconHtml}</div>`
    : ''

  // Right-side column, stacked top→bottom: Takt pill (top), swap icon, displacement
  // badge (+N), then the Protection Days block, then the conflict block — so the Takt
  // sits ABOVE the swap button. Each piece keeps its own comparison/color behavior.
  const rightColumn = (taktBadge || swapBlock || shiftBadge || pdBlock || conflictBlock)
    ? `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">${taktBadge}${swapBlock}${shiftBadge}${pdBlock}${conflictBlock}</div>`
    : ''

  // Layout: left vertical stack (hours red ABOVE start date grey) to the LEFT of the
  // MODELO value; the MODELO value; then the displacement/PD/conflict column to the
  // RIGHT — all on one horizontal row, in flow (original structure/hierarchy).
  // box-sizing + overflow:hidden so the inner content NEVER widens past the 88px MODELO
  // column (icons / PD / conflicts can't push the column wider).
  return `<div style="box-sizing:border-box;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:3px;width:88px;max-width:88px;max-height:${modeloAvail}px;overflow:hidden;padding:2px 1px">${leftStack}${modeloText}${rightColumn}</div>`
}

function buildConflictSet(groups) {
  // Map: "${iso}||${wsNorm}" → Set of loco keys that have a cell there
  const dayWsLocos = new Map()
  for (const g of groups) {
    const locoKey = `${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    for (const wst of g.workstations) {
      const wsNorm = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
      if (!CONFLICT_WS.has(wsNorm)) continue
      for (const dr of wst.desc_rows) {
        for (const iso of Object.keys(dr.cells || {})) {
          const k = `${iso}||${wsNorm}`
          if (!dayWsLocos.has(k)) dayWsLocos.set(k, new Set())
          dayWsLocos.get(k).add(locoKey)
        }
      }
    }
  }
  const conflicts = new Set()
  for (const [k, locos] of dayWsLocos) {
    if (locos.size > 1) conflicts.add(k)
  }
  return conflicts
}

// Classify every shared target-WS (WS40/WS50) cell as a TRUE conflict or an ALLOWED
// overlap, and collect the ISO days that hold at least one true conflict. Mirrors the
// canonical conflict rules and the "Permitir regras de sobreposição" exemption
// (allowOverlap): a boundary handoff between EXACTLY two LOCOs (end of one == start of
// the other) on a target WS is an allowed overlap and is NOT a conflict. With 3+ LOCOs
// on a cell, or with allowOverlap off, every shared cell is a true conflict.
// Returns { conflictSet, overlapSet, conflictDaySet }:
//   conflictSet    — "${iso}||${wsNorm}" cells that are TRUE conflicts (red border / icon)
//   overlapSet     — "${iso}||${wsNorm}" cells that are ALLOWED overlaps (orange border)
//   conflictDaySet — Set of ISO dates with ≥1 true conflict (day-header icon)
// Visualization-only; does not alter any conflict calculation.
// LOCO line-type classifier — MUST mirror getTipoGeral / ganttUtils.locoTypeOf and the
// backend _loco_type, so the orange-overlap rendering agrees with detection everywhere.
// Kept as a hoisted `function`, not a `const` alias: it is called from higher up in this file
// (the LOCO-mode rank lookup), and the worker test harness reaches it off the vm context,
// where a top-level `const` does not land.
function _locoTypeOf(linha) { return tipoOfLinha(linha) }
// Type-pair overlap rule: only New Locos × Overhaul or New Locos × Motor Diesel are a
// valid overlap on TYPE alone (regardless of boundary). See ganttUtils.isOverlapAllowedPair.
function _isOverlapAllowedPair(t1, t2) {
  // Structural gate, first and unconditional — mirrors ganttUtils.isOverlapAllowedPair. The
  // rule is about two LOCOs queueing for one physical machine on one day, which only means
  // anything when both Tipos put boxes on the Schedule.
  if (!isScheduleBackedTipo(t1) || !isScheduleBackedTipo(t2)) return false
  // One must be New Locos and the OTHER Overhaul or Motor Diesel. Order-independent.
  const other = t1 === 'new_locos' ? t2 : t2 === 'new_locos' ? t1 : null
  return other === 'overhaul' || other === 'motor_diesel'
}

function classifyConflicts(groups, allowOverlap) {
  // "${iso}||${wsNorm}" → Set(locoKey) present on that target-WS cell.
  const cellLocos = new Map()
  // "${locoKey}||${wsNorm}" → { min, max } iso span (for the boundary test).
  const span = new Map()
  // locoKey → line type (for the overlap type-pair rule).
  const locoType = new Map()
  for (const g of groups) {
    const locoKey = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    if (!locoType.has(locoKey)) locoType.set(locoKey, _locoTypeOf(g.linha))
    for (const wst of g.workstations) {
      const wsNorm = String(wst.ws || '').trim().toUpperCase().replace(/\s+/g, '')
      if (!CONFLICT_WS.has(wsNorm)) continue
      for (const dr of wst.desc_rows) {
        for (const iso of Object.keys(dr.cells || {})) {
          const k = `${iso}||${wsNorm}`
          let s = cellLocos.get(k); if (!s) { s = new Set(); cellLocos.set(k, s) }
          s.add(locoKey)
          const sk = `${locoKey}||${wsNorm}`
          const sp = span.get(sk)
          if (!sp) span.set(sk, { min: iso, max: iso })
          else { if (iso < sp.min) sp.min = iso; if (iso > sp.max) sp.max = iso }
        }
      }
    }
  }
  const isBoundaryShare = (iso, ws, a, b) => {
    const A = span.get(`${a}||${ws}`), B = span.get(`${b}||${ws}`)
    if (!A || !B) return false
    return (iso === A.max && iso === B.min) || (iso === B.max && iso === A.min)
  }
  const conflictSet = new Set()
  const overlapSet = new Set()
  const conflictDaySet = new Set()
  for (const [k, locos] of cellLocos) {
    if (locos.size < 2) continue
    const sep = k.lastIndexOf('||')
    const iso = k.slice(0, sep), ws = k.slice(sep + 2)
    // Allowed overlap (orange): exactly two LOCOs that are EITHER an allowed cross-type
    // pair (New Locos × Overhaul/Motor Diesel — valid regardless of boundary) OR a
    // boundary handoff (end of one == start of the other). Only when the rule is on.
    // Everything else (3+ LOCOs, same-type non-boundary, Overhaul×Motor Diesel, etc.)
    // is a true conflict (red).
    if (allowOverlap && locos.size === 2) {
      const arr = [...locos]
      if (_isOverlapAllowedPair(locoType.get(arr[0]) || 'other', locoType.get(arr[1]) || 'other')) { overlapSet.add(k); continue }
      if (isBoundaryShare(iso, ws, arr[0], arr[1])) { overlapSet.add(k); continue }
    }
    conflictSet.add(k)
    conflictDaySet.add(iso)
  }
  return { conflictSet, overlapSet, conflictDaySet }
}

// ── Live MODEL-column metric refresh after a visual edit ──────────────────────────────────────
// After an override is applied the MODELO cell's Protection Days, Takt and Conflict Count must
// reflect the EDITED locomotive, not the host's base `locoMeta` (which is memoized on the unedited
// data). These recompute those three values from the transformed group (+ a freshly classified
// conflict set) for the edited locos ONLY — no full rebuild, untouched locos keep their values.
// Mirrors GanttModal's pdCountByLoco EXACTLY so the value never jumps on the first edit: half-day
// cells count 0.5, only in-window days count, summed across every PROTECTIONDAYS workstation.
function _locoPdCount(g, dateIsoSet) {
  let n = 0
  for (const wst of g.workstations) {
    if (!isProtectionWs(wst.ws)) continue
    const cells = wst.desc_rows
    for (const dr of cells) {
      const c = dr.cells || {}
      for (const iso in c) {
        if (dateIsoSet && !dateIsoSet.has(iso)) continue
        n += (c[iso] && c[iso].half) ? 0.5 : 1
      }
    }
  }
  return n
}
// Does this loco HAVE a Protection-Days station at all? _locoPdCount returns 0 both for a loco with no
// buffer and for one whose buffer has been fully consumed by an upstream delay — cases that must look
// completely different in the UI (nothing vs. "you are at the limit"). This tells them apart.
function _locoHasPd(g) {
  for (const wst of g.workstations) if (isProtectionWs(wst.ws)) return true
  return false
}
function _locoHasConflictWs(g) {
  for (const wst of g.workstations) if (CONFLICT_WS.has(_wsNormKey(wst.ws))) return true
  return false
}
// Number of distinct conflicting (iso||ws) CELLS this loco owns inside the window — mirrors
// GanttModal's conflictCountByLoco exactly (cell-level count, exemption-aware via the already-
// classified conflictSet) so the MODELO value matches the host and never jumps on the first edit.
function _locoConflictCount(g, conflictSet, dateIsoSet) {
  if (!conflictSet || conflictSet.size === 0) return 0
  let n = 0
  const seen = new Set()
  for (const wst of g.workstations) {
    const wsNorm = _wsNormKey(wst.ws)
    if (!CONFLICT_WS.has(wsNorm)) continue
    for (const dr of wst.desc_rows) {
      for (const iso of Object.keys(dr.cells || {})) {
        if (dateIsoSet && !dateIsoSet.has(iso)) continue
        const k = `${iso}||${wsNorm}`
        if (seen.has(k)) continue
        seen.add(k)
        if (conflictSet.has(k)) n++
      }
    }
  }
  return n
}
// Clone `baseMeta` and refresh pd / takt / conflicts for each edited loco (key → transformed group).
// Other entries are passed through untouched; the host object is never mutated.
function _refreshEditedMeta(baseMeta, editedGroups, conflictSet, dateIsoSet) {
  if (!editedGroups || editedGroups.size === 0) return baseMeta || null
  const out = baseMeta ? { ...baseMeta } : {}
  for (const [locoKey, g] of editedGroups) {
    const prev = (baseMeta && baseMeta[locoKey]) || {}
    const pd = _locoPdCount(g, dateIsoSet)
    out[locoKey] = {
      ...prev,
      pd,
      // Buffer spent to exactly zero — the LOCO is AT the Protection-Days limit. Only computed for
      // edited locos: an untouched one still has its whole buffer, so the host's base meta (which
      // carries no such flag) is correct by construction.
      pdExhausted: pd === 0 && _locoHasPd(g),
      takt: (typeof g.takt === 'number' && isFinite(g.takt) && g.takt > 0) ? g.takt : undefined,
      conflicts: _locoConflictCount(g, conflictSet, dateIsoSet),
    }
  }
  return out
}

// Inline conflict warning icon for the day-column header — appended after the weekday
// label only on days that contain a real conflict. Icon-only (no count, no tooltip).
function _headerConflictIcon() {
  return `<span style="display:inline-flex;vertical-align:middle;margin-left:2px">${_warnIcon(RED, 8)}</span>`
}

// Sort all merged groups globally by each LOCO's earliest actually-plotted workstation date.
// start_ms is NOT used as a sort key — only cell data that is rendered in the schedule counts.
// Groups from different TIPOs/MODELOs are interleaved freely — no secondary grouping.
function reorderByLoco(groups) {
  // Compute sort key once per group (avoid repeated cell iteration inside comparator)
  const keys = new Map(groups.map(g => {
    let earliest = '9999-99-99'
    for (const w of g.workstations)
      for (const dr of w.desc_rows)
        for (const iso of Object.keys(dr.cells || {}))
          if (iso < earliest) earliest = iso
    return [g, earliest]
  }))
  return [...groups].sort((a, b) => {
    const cmp = (keys.get(a) ?? '').localeCompare(keys.get(b) ?? '')
    if (cmp !== 0) return cmp
    // Stable tie-break for equal first-plotted dates: start_ms → task_name → wo
    const sm = String(a.start_ms ?? '').localeCompare(String(b.start_ms ?? ''))
    if (sm !== 0) return sm
    const tn = String(a.task_name ?? '').localeCompare(String(b.task_name ?? ''))
    if (tn !== 0) return tn
    return String(a.wo ?? '').localeCompare(String(b.wo ?? ''))
  })
}

// ── Flat / unified view: one row per LOCO, frozen LOCO column on the left ───
function buildFlatTableShell(dateInfo, holidays, fwIndex) {
  const LOCO_COL_W = 140
  const fwSpans = []
  for (const d of dateInfo) {
    const last = fwSpans[fwSpans.length - 1]
    if (last && last.fw === d.fw) last.count += 1
    else fwSpans.push({ fw: d.fw, count: 1 })
  }
  const isNW = d => d.is_weekend || holidays.has(d.iso)
  const isHol = d => !d.is_weekend && holidays.has(d.iso)
  const dateIsoSet = new Set(dateInfo.map(d => d.iso))
  const _todayIso = localTodayIso()
  const todayIso = dateIsoSet.has(_todayIso) ? _todayIso : null
  const TODAY_LINE = `2px solid ${RED}`
  const TODAY_TINT = '#FCE3E3'   // SOLID opaque band (no transparency → nothing bleeds through)
  const parts = []
  parts.push('<style>html,body{margin:0;padding:0}html{overflow:auto}table{margin:0}td,th{box-sizing:border-box}</style>')
  parts.push('<table style="border-collapse:separate;border-spacing:0;table-layout:fixed;min-width:max-content;font-size:10px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">')
  parts.push('<colgroup>')
  parts.push(`<col style="width:${LOCO_COL_W}px">`)
  for (const d of dateInfo) {
    const w = isNW(d) ? COL_NW_PX : COL_W_PX
    const tint = (todayIso && d.iso === todayIso) ? `;background:${TODAY_TINT}` : ''
    parts.push(`<col style="width:${w}px${tint}">`)
  }
  parts.push('</colgroup>')
  parts.push('<thead>')
  const MONTH_PT = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']
  const fwFirstIso = new Map()
  for (const d of dateInfo) { if (!fwFirstIso.has(d.fw)) fwFirstIso.set(d.fw, d.iso) }
  // Row 1: LOCO placeholder + FW spans
  parts.push('<tr style="height:26px">')
  parts.push(`<th style="position:sticky;top:0;left:0;z-index:60;background:${RED_LT};border-top:1px solid ${RED};border-left:1px solid ${RED};border-right:1px solid ${RED};border-bottom:1px solid ${RED};color:${RED};font-weight:700;font-size:9px;text-align:center;height:26px;white-space:nowrap;padding:0 4px;width:${LOCO_COL_W}px;min-width:${LOCO_COL_W}px;max-width:${LOCO_COL_W}px">LOCO</th>`)
  for (const { fw, count } of fwSpans) {
    const iso = fwFirstIso.get(fw) ?? ''
    const fwLabel = iso ? `${_fw445FiscalYear(iso, fw)} ${MONTH_PT[_fwToMonth445(fw) - 1]} ${fw}` : fw
    parts.push(`<th colspan="${count}" style="position:sticky;top:0;z-index:20;background:${RED};border-top:1px solid ${RED_DK};border-right:1px solid ${RED_DK};border-bottom:1px solid ${RED_DK};color:#fff;font-weight:700;font-size:10px;text-align:center;height:26px;white-space:nowrap;padding:0 2px">${esc(fwLabel)}</th>`)
  }
  parts.push('</tr>')
  // Row 2: LOCO header + Day headers
  const fhStyle = (left, width, zIndex) =>
    `position:sticky;top:26px;z-index:${zIndex};background:#fff;background-clip:padding-box;border-top:${DAY_BORDER} solid ${RED};border-right:${DAY_BORDER} solid ${RED};border-bottom:none;box-shadow:inset -1px 0 0 ${RED},0 1px 0 0 ${RED};color:${RED};font-weight:700;font-size:10px;text-align:center;height:56px;padding:0 4px;white-space:nowrap;left:${left}px;vertical-align:middle;width:${width}px;min-width:${width}px;max-width:${width}px`
  parts.push('<tr style="height:56px">')
  parts.push(`<th style="${fhStyle(0, LOCO_COL_W, 64)}">LOCO</th>`)
  for (const d of dateInfo) {
    const nw = isNW(d)
    const fh = isHol(d)
    const isToday = todayIso && d.iso === todayIso
    const bg = isToday ? TODAY_TINT : (nw ? '#E5E7EB' : '#fff')
    const bc = nw ? '#D1D5DB' : RED
    const sh = nw ? '0 1px 0 0 #D1D5DB' : `0 1px 0 0 ${RED}`
    // Both-side, full-height bracket via inset box-shadow (doesn't fight border-right).
    const todayEdge = isToday ? `inset 2px 0 0 ${RED},inset -2px 0 0 ${RED},` : ''
    const todayBadge  = isToday ? `<span style="font-size:7px;color:${RED};font-weight:800;letter-spacing:.04em">HOJE</span>` : ''
    parts.push(`<th id="gantt_date_${d.iso}" data-day-nav="${esc(d.iso)}" title="Ir para o início deste dia" style="cursor:pointer;position:sticky;top:26px;z-index:20;background:${bg};border-top:${DAY_BORDER} solid ${bc};border-right:${DAY_BORDER} solid ${bc};border-bottom:none;box-shadow:${todayEdge}${sh};color:#111827;font-weight:600;font-size:9px;text-align:center;height:56px;vertical-align:middle;padding:0">${nw ? `<div style="display:flex;flex-direction:column;align-items:center;line-height:1.35"><span style="font-weight:700;font-size:9px;color:#374151">${esc(d.dow)}</span>${todayBadge}${fh ? `<span style="font-size:7px;color:${RED_DK};font-weight:800">FER</span>` : ''}</div>` : `<div style="display:flex;flex-direction:column;align-items:center;line-height:1.35"><span style="font-weight:800;font-size:10px;color:#111827">${esc(d.label)}</span><span style="font-size:8px;color:#6B7280;font-weight:500">${esc(d.dow)}</span>${todayBadge}</div>`}</th>`)
  }
  parts.push('</tr></thead><tbody>')
  return { parts, isNW, fwIndex, dateInfo, dateIsoSet, todayIso }
}

// Flat view per LOCO: one entry per distinct LOCO. Also detects conflicts.
// A conflict requires: same day AND different LOCO AND same workstation AND same DESCRIÇÃO.
// key = "${iso}||${ws}||${desc}" → Set of loco identifiers
function buildFlatViewDataByLoco(allGroups) {
  const locoEntries = []
  const wsDayDescLocos = new Map()
  for (const g of allGroups) {
    // Composite key so same-named LOCOs from different periods stay independent
    const locoKey = `${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    const cellsByDay = new Map()
    for (const wst of g.workstations) {
      for (const dr of wst.desc_rows) {
        for (const [iso, cell] of Object.entries(dr.cells || {})) {
          if (!cellsByDay.has(iso)) cellsByDay.set(iso, [])
          cellsByDay.get(iso).push({ wst, dr, cell })
          const desc = dr.desc ?? ''
          const ck = `${iso}||${wst.ws}||${desc}`
          if (!wsDayDescLocos.has(ck)) wsDayDescLocos.set(ck, new Set())
          wsDayDescLocos.get(ck).add(locoKey)
        }
      }
    }
    if (cellsByDay.size > 0) locoEntries.push({ group: g, cellsByDay })
  }
  const conflictKeys = new Set()
  for (const [k, locos] of wsDayDescLocos) {
    if (locos.size > 1) conflictKeys.add(k)
  }
  return { locoEntries, conflictKeys }
}

// Renders one flat row per LOCO. Includes a frozen LOCO column on the left.
// Each day cell stacks all active WS ops vertically. Boxes match the normal
// view style. Conflicting (iso, ws) pairs get a red border.
function pushRowsFlatByLoco(state, locoEntry, entryIndex, colorByWs, wsIndex, conflictKeys) {
  const LOCO_COL_W = 140
  const { parts, isNW, fwIndex, dateInfo, todayIso } = state
  const todayBorderFor = iso => (todayIso && iso === todayIso) ? `box-shadow:inset 2px 0 0 ${RED},inset -2px 0 0 ${RED};` : ''
  const { group, cellsByDay } = locoEntry
  const locoLabel = group.task_name || group.wo || ''
  const rowBg = entryIndex % 2 === 0 ? '#FFFFFF' : '#F8FAFC'
  const topBorder    = entryIndex === 0 ? `${DAY_BORDER} solid ${RED}` : `${DAY_BORDER} solid #E5E7EB`
  const bottomBorder = `${DAY_BORDER} solid #D1D5DB`

  parts.push('<tr>')
  // Frozen LOCO cell — data-flat-* attrs enable click-to-scroll navigation in the host page
  parts.push(`<td data-flat-wo="${esc(group.wo)}" data-flat-task="${esc(group.task_name)}" data-flat-linha="${esc(group.linha ?? '')}" data-flat-start-ms="${esc(String(group.start_ms ?? ''))}" title="Clique para navegar até o início deste LOCO" style="position:sticky;left:0;z-index:47;background:${RED_LT};background-clip:padding-box;border-top:${topBorder};border-right:${DAY_BORDER} solid ${RED};border-bottom:${bottomBorder};box-shadow:inset -1px 0 0 ${RED};width:${LOCO_COL_W}px;min-width:${LOCO_COL_W}px;max-width:${LOCO_COL_W}px;vertical-align:middle;text-align:center;font-weight:800;color:#1A1A2E;font-size:11px;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">${esc(locoLabel)}</td>`)
  let fi = 0
  while (fi < dateInfo.length) {
    const d = dateInfo[fi]
    if (isNW(d)) {
      // Batch consecutive non-working days (never across today)
      let end = fi + 1
      while (end < dateInfo.length && isNW(dateInfo[end]) && dateInfo[end].iso !== todayIso) end++
      const span = end - fi
      const sa = span > 1 ? ` colspan="${span}"` : ''
      parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:#E5E7EB;border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${bottomBorder};border-top:${topBorder};min-height:34px"></td>`)
      fi = end
      continue
    }
    const ops = cellsByDay.get(d.iso)
    if (ops && ops.length > 0) {
      const inner = ops.map(({ wst, dr, cell }) => {
        const cellBg = colorByWs ? WS_COLORS[wsIndex[_wsNormKey(wst.ws)] ?? 0] : FW_LIGHT[fwIndex[d.fw] ?? 0]
        const topLabel = dr.desc || (wst.subarea ? wst.subarea : wst.ws)
        const isConflict = conflictKeys.has(`${d.iso}||${wst.ws}||${dr.desc ?? ''}`)
        const shadowStr = isConflict ? `box-shadow:inset 0 0 0 2px ${RED};` : ''
        const topLine    = `<span style="font-weight:800;font-size:9px;color:#111827;line-height:1.1">${esc(topLabel)}</span>`
        const bottomLine = `<span style="font-weight:700;font-size:9px;color:#1F2937;line-height:1.1">${Number(cell.hh).toFixed(1)}h</span>`
        if (cell.half === 'first' || cell.half === 'second') {
          const hatchSide  = cell.half === 'first' ? 'right' : 'left'
          const hatchDiv = `<div style="position:absolute;top:0;${hatchSide}:0;width:50%;height:100%;background:repeating-linear-gradient(-45deg,rgba(0,0,0,0.08) 0,rgba(0,0,0,0.08) 2px,transparent 2px,transparent 7px);border-${hatchSide}:1px dashed rgba(0,0,0,0.18);box-sizing:border-box;pointer-events:none"></div>`
          const contentDiv = `<div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">${topLine}${bottomLine}</div>`
          return `<div style="background:${cellBg};${shadowStr}height:34px;box-sizing:border-box;padding:0;position:relative;overflow:hidden">${hatchDiv}${contentDiv}</div>`
        }
        return `<div style="background:${cellBg};${shadowStr}height:34px;box-sizing:border-box;padding:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">${topLine}${bottomLine}</div>`
      }).join('')
      parts.push(`<td style="${todayBorderFor(d.iso)}border-right:${DAY_BORDER} solid #C9CFD6;border-bottom:${bottomBorder};border-top:${topBorder};vertical-align:top;padding:0">${inner}</td>`)
      fi += 1
      continue
    }
    // Empty working day: batch consecutive empty working days (never across today)
    let end = fi + 1
    while (end < dateInfo.length && !isNW(dateInfo[end]) && !cellsByDay.get(dateInfo[end].iso)?.length && dateInfo[end].iso !== todayIso) end++
    const span = end - fi
    const sa = span > 1 ? ` colspan="${span}"` : ''
    parts.push(`<td${sa} style="${todayBorderFor(d.iso)}background:${rowBg};border-right:${DAY_BORDER} solid #D1D5DB;border-bottom:${bottomBorder};border-top:${topBorder};height:34px"></td>`)
    fi = end
  }
  parts.push('</tr>')
}

// ── Visual-override transform (mirror of src/lib/locoOverrides.ts, JS for the worker) ──
// Bars only land on business days, so a ± "dias úteis" shift is a translation along the
// ordered business-day ISO axis. Takt re-spaces consecutive WS *starts*. Never mutates the
// base group (cells are copied), so the cached schedule stays intact.
function _bizAxis(dateInfo, holidays) {
  const isos = []
  for (const d of dateInfo) if (!d.is_weekend && !holidays.has(d.iso)) isos.push(d.iso)
  const pos = new Map()
  isos.forEach((iso, i) => pos.set(iso, i))
  return { isos, pos }
}
function _clampIdx(n, hi) { return n < 0 ? 0 : (n > hi ? hi : n) }
// Earliest plotted ISO across a workstation's (possibly overridden) desc-row cells. Used to stamp
// the WS row with its CURRENT horizontal start so click-to-navigate scrolls to the new position
// after an edit, not the original one. Empty string when the workstation has no cells.
function _wsFirstIsoOf(wst) {
  let best = ''
  for (const dr of wst.desc_rows) for (const iso in (dr.cells || {})) { if (best === '' || iso < best) best = iso }
  return best
}
function _wsSpan(ws, axis) {
  if (!ws || !ws.desc_rows) return null      // unpaired row (see _pairBaseByIdentity) → no reference
  let start = Infinity, end = -Infinity
  for (const dr of ws.desc_rows) for (const iso of Object.keys(dr.cells || {})) {
    const p = axis.pos.get(iso); if (p == null) continue
    if (p < start) start = p
    if (p > end) end = p
  }
  return start === Infinity ? null : { start, end }
}

// ── Reference ↔ edited row pairing: BY IDENTITY, never by position ────────────────────────────────
// Every delay measurement compares a workstation in the EDITED layout against the same workstation in
// the REFERENCE layout. Both used to be paired by ARRAY INDEX, on the assumption that an override can
// change a row's dates but never its position in the array.
//
// A WS40↔WS50 SWAP breaks that assumption. _reorderSwappedWs sorts the traded rows by their EFFECTIVE
// START, and the two layouts have different starts by construction: the reference holds the swap ALONE
// (base ⊕ swapShift) while the edited layout holds the swap PLUS every later move. So the moment the
// planner drags a swapped station past its partner — i.e. back toward its pre-swap position — the
// edited array flips while the reference does not, and index pairing then measured WS40 against WS50's
// reference and vice versa. That is the reported "drag WS40 through WS50 and both delay overlays
// disappear": the hatch is keyed by the EDITED row's name but was computed from a STRANGER's geometry,
// so the deltas were nonsense and the overlays landed on rows the renderer never looks them up on.
//
// Pairing by (workstation, subárea) removes the ordering from the equation entirely — the swapped
// state is then the only reference either side can use, whatever order the rows are drawn in. Repeated
// (ws, subárea) pairs are matched in occurrence order, which is stable because _reorderSwappedWs only
// ever exchanges whole traded blocks. A row with no counterpart yields null and is skipped, which is
// the honest answer: no reference means no measurable deviation (it used to hatch against whichever
// row happened to share its index).
function _wsIdentKey(w) {
  return `${String((w && w.ws) || '').trim().toUpperCase().replace(/\s+/g, '')}||${(w && w.subarea) ?? ''}`
}
function _pairBaseByIdentity(base, edited) {
  const bws = base.workstations || [], ews = edited.workstations || []
  const buckets = new Map()
  for (const w of bws) {
    const k = _wsIdentKey(w)
    const a = buckets.get(k); if (a) a.push(w); else buckets.set(k, [w])
  }
  const used = new Map()
  return ews.map(w => {
    const k = _wsIdentKey(w)
    const arr = buckets.get(k); if (!arr) return null
    const n = used.get(k) || 0
    used.set(k, n + 1)
    return arr[n] || null
  })
}

// Locomotive delay (business days) of `edited` vs a `base` (reference) layout: the LARGEST amount any
// real workstation's START moved LATER — the same slip the red delay hatches paint. Protection-Days
// buffers are excluded (a shrinking buffer is not a delay). Returns 0 when nothing slipped later
// (unchanged or recovered). Rows are paired by IDENTITY (see _pairBaseByIdentity), the same rule
// computeOverrideHatch uses, so a swapped loco reports the same slip the hatches draw.
//
// Swapped stations DO participate: the caller's reference already contains the trade
// (_swapRefOverride), so a swap contributes 0 while a swapped station that was later moved reports
// its real delay. They used to be skipped here, which silently removed them from the badge for good.
function _locoDelayDays(base, edited, axis) {
  const ews = edited.workstations || []
  const pairs = _pairBaseByIdentity(base, edited)
  let maxDelay = 0
  for (let i = 0; i < ews.length; i++) {
    const ew = ews[i]
    if (!ew || isProtectionWs(ew.ws)) continue
    const bs = _wsSpan(pairs[i], axis), es = _wsSpan(ew, axis)
    if (!bs || !es) continue
    const d = es.start - bs.start
    if (d > maxDelay) maxDelay = d
  }
  return maxDelay
}

// ── Occupiable-slot arithmetic (the two-calendar rule, client side) ──────────────────────────
// The backend keeps TWO calendars: Mon–Fri (_add_business_days) for normal workstations, and Mon–Sat
// (_add_sat_business_days) for WS40/WS50 only. The client has ONE axis, and promoting a Saturday
// inserts a slot into it — which silently made that Saturday movable/countable for EVERY workstation.
// That single fact caused both known bugs: a non-capable WS landed on the Saturday (where the renderer
// then painted the red-X over real work), and its span inflated by one, which read as a +1 delay and
// cascaded downstream through takt/propagation.
//
// The fix keeps ONE index space (full-axis indices, so cross-station ordering and cascade stay
// comparable — giving each workstation its own axis would make `placed.sort((a,b) => a.start - b.start)`
// compare incompatible numbers and misorder stations) and instead makes a Saturday slot INVISIBLE to
// rows that cannot occupy it: they never count it and never step onto it. Net effect: for a
// non-WS40/WS50 row, promoting a Saturday is a no-op — exactly the invariant the schedule needs.
function _isSatIdx(axis, i) {
  if (!axis._sat) {
    axis._sat = axis.isos.map(isSaturdayIso)   // memoized per axis build
  }
  return axis._sat[i] === true
}
/** Can a row with this capability occupy axis slot `i`? Saturdays are WS40/WS50-only.
 *  `satCapable` is true (blanket — a row being hand-placed), a LIST of Saturday ISOs the row already
 *  works (it keeps those and only those), or false. The list form is what stops a newly registered
 *  working Saturday from being absorbed by a row that never asked for it — see satCapForEdit. */
function _occupiable(axis, i, satCapable) {
  if (!_isSatIdx(axis, i)) return true
  if (satCapable === true) return true
  return !!(satCapable && satCapable.length && satCapable.indexOf(axis.isos[i]) >= 0)
}
/** Nudge `i` to the nearest occupiable slot at-or-after it (backwards at the axis tail). */
function _occNorm(axis, i, satCapable) {
  const hi = axis.isos.length - 1
  let j = _clampIdx(i, hi)
  while (j <= hi && !_occupiable(axis, j, satCapable)) j++
  if (j > hi) { j = _clampIdx(i, hi); while (j >= 0 && !_occupiable(axis, j, satCapable)) j-- }
  return _clampIdx(j, hi)
}
/** Advance `n` OCCUPIABLE slots from `from` (n signed). Slots the row cannot use are skipped, so for a
 *  non-capable row "+1 day" means the next weekday even when a working Saturday sits in between. */
function _occStep(axis, from, n, satCapable) {
  const hi = axis.isos.length - 1
  let i = _occNorm(axis, from, satCapable)
  if (!n) return i
  const step = n > 0 ? 1 : -1
  let rem = Math.abs(n)
  while (rem > 0) {
    if ((step > 0 && i >= hi) || (step < 0 && i <= 0)) break   // clamp at the axis edge
    i += step
    if (_occupiable(axis, i, satCapable)) rem--
  }
  return _clampIdx(i, hi)
}
/** Count the OCCUPIABLE slots in [lo, hi] inclusive — a row's true duration in days it can work. */
function _occCount(axis, lo, hi, satCapable) {
  if (hi < lo) return 0
  let n = 0
  for (let i = Math.max(0, lo); i <= Math.min(hi, axis.isos.length - 1); i++) {
    if (_occupiable(axis, i, satCapable)) n++
  }
  return n
}
/** Signed distance from `from` to `to` in OCCUPIABLE days — the inverse of _occStep, so
 *  _occStep(axis, from, _occSignedDelta(axis, from, to, cap), cap) === to for occupiable endpoints. */
function _occSignedDelta(axis, from, to, satCapable) {
  if (from === to) return 0
  const lo = Math.min(from, to), hi = Math.max(from, to)
  const n = Math.max(0, _occCount(axis, lo, hi, satCapable) - 1)
  return to > from ? n : -n
}
// Largest business-axis index whose ISO is ≤ `iso` (the nearest preceding business day). Used to
// fold an OFF-AXIS allocation — a Saturday cell placed by the conflict optimizer on WS40/WS50 — back
// onto the working calendar. Binary search over the ascending `axis.isos`. Falls back to index 0 when
// the date precedes the whole axis (so the work is never lost).
function _nearestBizIdxBefore(iso, axis) {
  let lo = 0, hi = axis.isos.length - 1, res = null
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (axis.isos[mid] <= iso) { res = mid; lo = mid + 1 } else hi = mid - 1 }
  return res == null ? (axis.isos.length ? 0 : null) : res
}
// `satCapable` = may this row's workstation actually OCCUPY a Saturday (WS40/WS50 only)? It gates the
// gap-closing pack below and defaults to FALSE, so any caller that doesn't opt in keeps the exact
// historical translate behaviour.
function _remapCells(cells, wsDelta, axis, satCapable = false) {
  const out = {}
  const hi = axis.isos.length - 1
  // Fast path: every cell already lives on the business axis (the normal case) — a pure whole-day
  // translate preserving the row's exact shape.
  let hasOffAxis = false
  for (const k in cells) { if (axis.pos.get(k) == null) { hasOffAxis = true; break } }
  if (!hasOffAxis) {
    // GAP-CLOSING move (mirrors the backend's _compact_block_day_map). A row's cells are laid on
    // CONSECUTIVE business days when the schedule is built, so a HOLE on the axis can only mean a
    // Saturday has since joined it (an admin working-day, or one registered by a saved
    // optimization) between two originally-adjacent cells. The hole is correct while the block sits
    // still — the Saturday simply isn't allocated — but a plain per-cell translate would carry it
    // along forever, so a block displaced THROUGH the Saturday would keep an obsolete gap it should
    // have absorbed. On a MOVE we therefore re-pack the row onto consecutive axis slots from its
    // shifted start: the working Saturday gets filled and the tail pulls in by the recovered day(s).
    // wsDelta === 0 is never compacted (nothing moved, so the gap stays), matching the backend rule.
    //
    // GATED ON satCapable: only WS40/WS50 may occupy a Saturday. For any other workstation the hole is
    // NOT an artifact — it is the Saturday it legitimately cannot work (the renderer draws the red-X
    // "cannot work" box there), so it must survive every move. Packing those rows would place a cell on
    // a Saturday that the renderer then refuses to draw, making the box silently disappear.
    const keys = Object.keys(cells).sort()
    // Re-pack a NON-CONTIGUOUS block onto consecutive OCCUPIABLE slots on a move, so a working Saturday
    // the row is LICENSED for and that sits inside its span gets FILLED rather than stepped over (which
    // would leave a hole). This covers BOTH the blanket licence (`=== true` — every slot occupiable, the
    // live satHand preview) and the narrow persisted one (`satDays`, an array — only those Saturdays, the
    // committed landing). The only difference is which slots count as occupiable, and _occStep/_occCount
    // already honour that from `satCapable`, so the same code heals both — closing the gap where a
    // committed satDays box reopened a Saturday hole the preview had filled (Enter "springs" a hole in).
    // A non-capable row (`false`) is deliberately excluded: its Saturday hole is the genuine "cannot work"
    // gap and must survive every move (the renderer draws the red-X there) — it takes the stepping path.
    if (satCapable && keys.length && wsDelta !== 0) {
      const first = axis.pos.get(keys[0])
      const last  = axis.pos.get(keys[keys.length - 1])
      // Contiguity judged in OCCUPIABLE terms: is every slot the row MAY occupy between its ends filled?
      // For `=== true` this equals the old raw `(last - first + 1) === keys.length` (all slots occupiable).
      const contiguous = _occCount(axis, first, last, satCapable) === keys.length
      if (!contiguous) {
        // Pack from the LEADING edge in the direction of motion. Moving RIGHT (wsDelta>0) the START leads:
        // step the first cell right and lay the block forward, so the trailing days absorb a licensed
        // Saturday (Wed·Thu·Fri·[–]·Mon +1 → Thu·Fri·Sat·Mon — start moved, finish held by the Saturday).
        // Moving LEFT (wsDelta<0) the FINISH leads: step the last cell left and lay the block BACKWARD,
        // so the finish pulls onto the Saturday while the start holds (…−1 → Wed·Thu·Fri·Sat, NOT the
        // whole block sliding to Tue·Wed·Thu·Fri and skipping the Saturday). Both reduce to a rigid
        // translate for a contiguous block; only a Saturday-holed row is reshaped, and only toward the
        // day the move is heading. (Confirmed rule, issue #8.)
        if (wsDelta > 0) {
          let idx = _occStep(axis, first, wsDelta, satCapable)
          for (let ki = 0; ki < keys.length; ki++) { out[axis.isos[idx]] = cells[keys[ki]]; idx = _occStep(axis, idx, 1, satCapable) }
        } else {
          let idx = _occStep(axis, last, wsDelta, satCapable)
          for (let ki = keys.length - 1; ki >= 0; ki--) { out[axis.isos[idx]] = cells[keys[ki]]; idx = _occStep(axis, idx, -1, satCapable) }
        }
        return out
      }
    }
    if (satCapable !== true) {
      // A row that cannot work a given Saturday translates over OCCUPIABLE slots, so that Saturday is
      // stepped straight over instead of being landed on (where the renderer would paint the red-X
      // over real, still-counted hours). This is what makes promoting a Saturday a no-op for it:
      // the result is identical to the same move on an axis that never had the Saturday. A row
      // licensed for specific Saturdays steps onto those and over the rest.
      for (const k in cells) {
        const p = axis.pos.get(k)
        out[axis.isos[_occStep(axis, p, wsDelta, satCapable)]] = cells[k]
      }
      return out
    }
    for (const k in cells) {
      const p = axis.pos.get(k)
      out[axis.isos[_clampIdx(p + wsDelta, hi)]] = cells[k]
    }
    return out
  }
  // WEEKEND-NORMALIZING path: the row carries an OFF-AXIS allocation (a Saturday cell from the
  // conflict optimizer on WS40/WS50). A plain translate would leave that Saturday cell fixed while the
  // rest of the block shifts — detaching it and preserving an artificial gap, and keeping work on a
  // Saturday after a move. A MOVE must return the workstation to normal working-calendar behaviour, so
  // fold every off-axis cell onto its nearest business day, translate by wsDelta, and merge hours onto
  // the destination day (no Saturday cell survives, no gap remains). Hours are preserved.
  for (const k in cells) {
    let p = axis.pos.get(k)
    if (p == null) p = _nearestBizIdxBefore(k, axis)
    if (p == null) continue
    const iso = axis.isos[_clampIdx(p + wsDelta, hi)]
    const c = cells[k]
    if (out[iso]) {
      const merged = { ...out[iso] }
      merged.hh = (Number(out[iso].hh) || 0) + (Number(c && c.hh) || 0)   // combine folded Saturday work
      delete merged.half                                                  // now a full working day
      out[iso] = merged
    } else {
      out[iso] = c
    }
  }
  return out
}
// Sum a desc-row's total hours (the invariant we preserve when redistributing across days).
function _drTotalHh(cells) {
  let t = 0
  for (const k in cells) { const c = cells[k]; if (c && typeof c.hh === 'number') t += c.hh }
  return t
}
// Scale every day-box's hours by `f`, keeping positions/shape intact (the "Horas totais" Componente
// override: same day-boxes, magnitudes rescaled). Returns a fresh cells map (never mutates input).
function _scaleCellsHh(cells, f) {
  const out = {}
  for (const k in cells) { const c = cells[k]; out[k] = { ...c, hh: (Number(c && c.hh) || 0) * f } }
  return out
}
// Evenly distribute `total` hours across `dur` consecutive business days from axis index
// `startIdx`. Same total, new daily allocation — recreates the day-boxes for the new duration.
// HALF-DAY SUPPORT: `dur` may be fractional (0.5 resolution). A row of duration N.5 renders as
// `floor(N.5)` full-day boxes plus ONE trailing HALF box (`half:'first'`, the renderer draws it as a
// half-width occupied cell), e.g. 3.5 → [Day1][Day2][Day3][Half-Day]. Hours are spread by TIME, so a
// full day carries `total/dur` and the trailing half carries `(total/dur)*0.5` — sum stays `total`.
// `startIdx` is always an integer day index (callers keep positions on the integer grid via ceil),
// only the WITHIN-day occupancy is fractional. dur ∈ [0.5, ∞); a 0.5 row no longer vanishes.
// `satCapable` (default false → Saturdays are skipped) picks the row's calendar: boxes are laid on
// consecutive OCCUPIABLE slots, so a non-WS40/WS50 row steps over a working Saturday instead of
// putting a box on it. Default-false keeps any un-updated caller on the historical Mon–Fri behaviour.
function _spreadCells(total, startIdx, dur, axis, satCapable = false) {
  const out = {}
  if (!(total > 0) || dur < 0.5) return out
  const fullDays = Math.floor(dur + 1e-6)
  const hasHalf  = (dur - fullDays) >= 0.5 - 1e-6
  const per = total / dur
  let d = 0
  for (; d < fullDays; d++) {
    const iso = axis.isos[_occStep(axis, startIdx, d, satCapable)]
    out[iso] = { hh: (out[iso] ? out[iso].hh : 0) + per }   // accumulate if clamped onto same day at edge
  }
  if (hasHalf) {
    const iso = axis.isos[_occStep(axis, startIdx, d, satCapable)]
    out[iso] = { hh: (out[iso] ? out[iso].hh : 0) + per * 0.5, half: 'first' }
  }
  return out
}
// Regenerate `dur` day-boxes for a row across a NEW window, PRESERVING the row's cell shape even when
// it carries ZERO hours. _spreadCells returns {} for a zero-hour row (nothing to distribute), which
// makes ZERO-hour rows — notably PROTECTION DAYS (buffer days, no work) — vanish on a resize. Here
// every day in [startIdx, startIdx+dur) gets a box (cloned from a representative original cell so any
// non-hh fields ride along), with the row's total hours spread evenly (0 each when total is 0).
function _spreadBoxes(cells, startIdx, dur, axis, satCapable = false) {
  const out = {}
  if (dur < 0.5) return out
  let tpl = null
  for (const k in cells) { tpl = cells[k]; break }
  const total = _drTotalHh(cells)
  const per = total > 0 ? total / dur : 0
  const fullDays = Math.floor(dur + 1e-6)
  const hasHalf  = (dur - fullDays) >= 0.5 - 1e-6
  let d = 0
  for (; d < fullDays; d++) {
    const iso = axis.isos[_occStep(axis, startIdx, d, satCapable)]
    const base = (tpl && typeof tpl === 'object') ? { ...tpl } : {}
    base.hh = (out[iso] ? out[iso].hh : 0) + per
    delete base.half
    out[iso] = base
  }
  if (hasHalf) {
    const iso = axis.isos[_occStep(axis, startIdx, d, satCapable)]
    const base = (tpl && typeof tpl === 'object') ? { ...tpl } : {}
    base.hh = (out[iso] ? out[iso].hh : 0) + per * 0.5
    base.half = 'first'
    out[iso] = base
  }
  return out
}

// ── Half-day SLOT model (for the LOCO-takt layout) ────────────────────────────────────────────
// Each business day on `axis` is two half-day SLOTS: AM = day*2, PM = day*2+1. Working in slots lets
// a successor begin in the SECOND HALF of the same day its predecessor finishes (a shared day), which
// a whole-day index cannot express. Weekend/holiday handling is preserved automatically because the
// axis already contains only business days, so consecutive slots never land on a weekend.
// Read a row's occupied slot span from its cells, honouring the existing `half` flag.
function _rowSlotSpan(dr, axis) {
  let lo = Infinity, hi = -Infinity
  for (const iso in (dr.cells || {})) {
    const day = axis.pos.get(iso); if (day == null) continue
    const c = dr.cells[iso]
    const startS = (c && c.half === 'second') ? day * 2 + 1 : day * 2     // PM-only → starts PM
    const endS   = (c && c.half === 'first')  ? day * 2     : day * 2 + 1  // AM-only → ends AM
    if (startS < lo) lo = startS
    if (endS   > hi) hi = endS
  }
  return lo === Infinity ? null : { startSlot: lo, endSlot: hi }
}
// Walk `durSlots` half-day slots from `startSlot`, SKIPPING whole days the row may not occupy.
// Returns dayIdx → { am, pm }.
//
// THIS IS WHAT KEEPS A WORKING SATURDAY OUT OF A ROW THAT CANNOT WORK ONE. The whole-day spreaders
// (_spreadCells/_spreadBoxes) step over occupiable slots via _occStep, but the SLOT grid used for
// half-day starts is a raw arithmetic walk: without this check it paints straight through a working
// Saturday. The renderer then masks that cell (isSaturdayIso && !satOccRow → red-X box), so the hours
// are INVISIBLE but still counted — "the X is drawn yet hours are allocated there", and a Fri→Mon row
// silently becomes Fri→Sat→Mon the moment a Saturday is promoted. Rows only reach this path when they
// carry a half-day (Move-Mode Shift+/−) start, which is why it hit some locos and not others.
function _slotDayMap(startSlot, durSlots, axis, satCapable) {
  const hi = axis.isos.length - 1
  const dayHas = new Map()
  let s = startSlot
  let placed = 0
  // Bounded walk: every skipped day costs at most 2 iterations, so the axis length caps it.
  const maxIter = durSlots + (hi + 1) * 2 + 4
  for (let n = 0; placed < durSlots && n < maxIter; n++) {
    const day = _clampIdx(Math.floor(s / 2), hi)
    if (!_occupiable(axis, day, satCapable)) {
      const next = (day + 1) * 2
      if (next <= s) break            // clamped onto a non-occupiable tail day — nothing left to use
      s = next
      continue
    }
    const isAM = (((s % 2) + 2) % 2) === 0
    let h = dayHas.get(day); if (!h) { h = { am: false, pm: false }; dayHas.set(day, h) }
    if (isAM) h.am = true; else h.pm = true
    placed++
    s++
  }
  return dayHas
}
/** Half-day slots actually placed by _slotDayMap (< durSlots only when the axis tail clamped). */
function _slotCount(dayHas) {
  let n = 0
  for (const [, h] of dayHas) n += (h.am ? 1 : 0) + (h.pm ? 1 : 0)
  return n
}
// Distribute `total` hours across `durSlots` half-day slots from `startSlot`. A day touched by both
// AM+PM becomes a FULL box; a day touched by a single slot becomes a HALF box (`half:'first'|'second'`,
// the existing hatched half-cell rendering). Sum of hours stays `total`.
function _spreadCellsSlots(total, startSlot, durSlots, axis, satCapable = false) {
  const out = {}
  if (!(total > 0) || durSlots < 1) return out
  const dayHas = _slotDayMap(startSlot, durSlots, axis, satCapable)
  // Divide by the slots actually placed, not the requested count, so the hours invariant holds even
  // when the walk clamped at the axis tail.
  const placed = _slotCount(dayHas)
  if (!placed) return out
  const perSlot = total / placed
  for (const [day, h] of dayHas) {
    const slots = (h.am ? 1 : 0) + (h.pm ? 1 : 0)
    const cell = { hh: perSlot * slots }
    if (slots === 1) cell.half = h.am ? 'first' : 'second'
    out[axis.isos[day]] = cell
  }
  return out
}
// Slot version of _spreadBoxes: keeps a box per touched day for ZERO-hour rows (Protection Days),
// cloning a representative cell so non-hh fields ride along; marks single-slot days as half boxes.
function _spreadBoxesSlots(cells, startSlot, durSlots, axis, satCapable = false) {
  const out = {}
  if (durSlots < 1) return out
  let tpl = null; for (const k in cells) { tpl = cells[k]; break }
  const total = _drTotalHh(cells)
  const dayHas = _slotDayMap(startSlot, durSlots, axis, satCapable)
  const placed = _slotCount(dayHas)
  if (!placed) return out
  const perSlot = total > 0 ? total / placed : 0
  for (const [day, h] of dayHas) {
    const slots = (h.am ? 1 : 0) + (h.pm ? 1 : 0)
    const base = (tpl && typeof tpl === 'object') ? { ...tpl } : {}
    base.hh = perSlot * slots
    if (slots === 1) base.half = h.am ? 'first' : 'second'; else delete base.half
    out[axis.isos[day]] = base
  }
  return out
}
// Regenerate a row's day-boxes across [startIdx, startIdx+dur). HOUR rows redistribute their hours
// (_spreadCells); ZERO-hour rows — notably PROTECTION DAYS — keep one box per day (_spreadBoxes) so
// the PD window stays visible AND its day COUNT shrinks/grows correctly. Using _spreadCells alone made
// a resized/absorbed PD row vanish (total 0 → {}), which left the displayed Protection Days stale.
function _regenRowCells(cells, startIdx, dur, axis, satCapable = false) {
  const c = cells || {}
  return _drTotalHh(c) > 0
    ? _spreadCells(_drTotalHh(c), startIdx, dur, axis, satCapable)
    : _spreadBoxes(c, startIdx, dur, axis, satCapable)
}
// SLOT version of _regenRowCells: lay a row across [startSlot, startSlot+durSlots) on the half-day slot
// grid so a FRACTIONAL (half-day) start renders a LEADING half box (`half:'second'`). The whole-day
// _regenRowCells above snaps a 0.5 shift to a full day (via _occStep), so it cannot express a box that
// begins in the afternoon — this can. Used ONLY when a Move-Mode Shift+/− produced a fractional
// startShiftDays; HOUR rows redistribute (_spreadCellsSlots), ZERO-hour rows keep a box per touched day
// (_spreadBoxesSlots), mirroring the whole-day dispatch.
function _regenRowCellsSlots(cells, startSlot, durSlots, axis, satCapable = false) {
  const c = cells || {}
  return _drTotalHh(c) > 0
    ? _spreadCellsSlots(_drTotalHh(c), startSlot, durSlots, axis, satCapable)
    : _spreadBoxesSlots(c, startSlot, durSlots, axis, satCapable)
}
// Normalize a WS name for matching (mirrors the inline normalization used elsewhere).
function _wsNormKey(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, '') }
// Protection-Days workstation matcher — same set GanttModal/locoMeta uses.
function isProtectionWs(ws) {
  const n = _wsNormKey(ws)
  return n === 'PROTECTIONDAYS' || n === 'PROTECAO' || n === 'DIASDEPROTECAO' || n === 'PROTECTIONDAY' || n.includes('PROTECTION')
}
// Group consecutive same-`ws` workstation entries into STATIONS (mirrors the renderer's
// sameWsAsPrev grouping). Each station carries its member entries and its union biz-day span.
function _buildStations(workstations, axis) {
  const stations = []
  let cur = null
  for (const ws of workstations) {
    if (!cur || cur.ws !== ws.ws) { cur = { ws: ws.ws, members: [], start: Infinity, end: -Infinity }; stations.push(cur) }
    cur.members.push(ws)
    const span = _wsSpan(ws, axis)
    if (span) { if (span.start < cur.start) cur.start = span.start; if (span.end > cur.end) cur.end = span.end }
  }
  return stations
}

// After a WS40↔WS50 swap the two blocks TRADE time slots but keep their ORIGINAL row order, so the
// block that now starts LATER can sit on the UPPER row — a visual inversion that reads as a gap between
// the two workstations. A true "exchange the records" also exchanges their rows: reorder ONLY the
// swap-flagged rows (stamped `_swap`) into effective-start order, reusing the exact array slots they
// already occupy so every OTHER row keeps its index (which also preserves computeOverrideHatch's
// base↔edited index alignment — the swap rows there are skipped anyway). Same-WS sub-área rows stay
// grouped and in order because the two blocks don't overlap in time after the swap.
function _reorderSwappedWs(group, axis) {
  if (!axis || !axis.pos) return group
  const wss = group.workstations || []
  const slots = []
  for (let i = 0; i < wss.length; i++) if (wss[i] && wss[i]._swap) slots.push(i)
  if (slots.length < 2) return group
  const startOf = (w) => {
    let lo = Infinity
    for (const dr of (w.desc_rows || [])) for (const iso in (dr.cells || {})) {
      const p = axis.pos.get(iso); if (p != null && p < lo) lo = p
    }
    return lo
  }
  const picked = slots.map(i => wss[i])
  // Stable sort by effective start; equal starts keep their current relative order.
  const order = picked.map((w, j) => ({ w, j, s: startOf(w) })).sort((a, b) => (a.s - b.s) || (a.j - b.j))
  let changed = false
  for (let j = 0; j < order.length; j++) if (order[j].w !== picked[j]) { changed = true; break }
  if (!changed) return group
  const out = wss.slice()
  slots.forEach((slot, j) => { out[slot] = order[j].w })
  return { ...group, workstations: out }
}

// ── Entry point: apply a LOCO's full (possibly nested) visual override ──────────────────────
// Layered so each scope is isolated and low-risk:
//   0) LOCO-level (whole-loco takt / start / finish)  — original transform, unchanged.
//   1) Workstation-level edits  (ov.ws)               — resize/move one station, optional cascade.
//   2) Componente/desc-row edits (ov.desc)            — resize/move one row, optional cascade.
// Each later pass rebuilds the station layout from the previous pass's cells, so the scopes
// compose. start_ms/finish_ms stay ORIGINAL throughout (stable LOCO identity).
// ── Manually-added workstations ("Adicionar Workstation") ──────────────────────────────────────
// A planner may insert a workstation that is NOT in the source schedule (see AddedWorkstation in
// lib/locoOverrides.ts). Unlike a ScopedEdit (a delta on an existing station) this MATERIALIZES a new
// station from an absolute anchor: start date + duration + hours. It is injected into the group FIRST
// (before every other override pass) so that from that point on it is an ordinary station — a ws-scope
// Move Mode shift, propagation, the Protection-Days boundary and the delay maths all treat it with
// zero special-casing, and because every consumer (Gantt render, computeEffective → Plano de Produção,
// summary math) routes through applyOverrideToGroup, the new station appears everywhere automatically.
function _buildAddedCells(startIdx, durationDays, hoursTotal, axis) {
  const cells = {}
  const days = Math.max(1, Math.round(Number(durationDays) || 0))
  const perDay = (Number(hoursTotal) || 0) / days       // even spread; 0 hours → 0-hour boxes (still drawn)
  const hi = axis.isos.length - 1
  for (let i = 0; i < days; i++) {
    const idx = Math.min(startIdx + i, hi)
    cells[axis.isos[idx]] = { hh: perDay }
  }
  return cells
}
function _injectAddedWorkstations(group, ov, axis) {
  const addWs = ov && ov.addWs
  if (!addWs || !Object.keys(addWs).length) return group
  // Axis index of a start date; snap an off-axis (weekend/holiday/out-of-range) date to the first
  // business day at or after it — same rule as `day0` in applyWsEdits.
  const startIdxOf = (iso) => {
    const s = String(iso || '').slice(0, 10)
    if (axis.pos.has(s)) return axis.pos.get(s)
    for (let i = 0; i < axis.isos.length; i++) if (axis.isos[i] >= s) return i
    return axis.isos.length - 1
  }
  const workstations = group.workstations.slice()
  for (const key of Object.keys(addWs)) {
    const a = addWs[key]
    if (!a || !a.ws || !a.startIso || !(Number(a.durationDays) > 0)) continue
    // Defensive: never shadow a station that already exists (the UI blocks duplicate names).
    if (workstations.some(w => String(w.ws) === String(a.ws))) continue
    const startIdx = startIdxOf(a.startIso)
    const qty = Number(a.itemQty) || 0
    const hours = Number(a.hoursTotal) || 0
    const wsObj = {
      // ÁREA — whatever the dialog stored (existing, brand-new, or none). It is the same field a
      // native station carries, so the Schedule's Área filter and Plano de Produção's área grouping
      // pick the new station up with no special-casing; '' keeps it unassociated, as before.
      // `_addedPropagate` = "Propagar efeitos imediatamente" (creation-time). It rides on the station
      // rather than in a ws-scope edit because a scoped edit holding only `propagate` reads as empty
      // and would be dropped on save — see AddedWorkstation.propagate in lib/locoOverrides.ts.
      ws: a.ws, subarea: a.subarea || '', area: a.area || '', _added: true,
      _addedPropagate: a.propagate === true,
      desc_rows: [{
        // PART NUMBER of a manually-added station IS its workstation name: there is no routing entry
        // to map it to, and Plano de Produção keys its planning lines on (área, linha, ITEM, WO), so a
        // blank PN would collapse every manual station of a loco into one nameless "" item row.
        desc: a.desc || a.ws, pn: a.ws, qtd: qty,
        hh_unit: qty > 0 ? hours / qty : hours,
        workorder: a.workorder || '', workorders: a.workorder ? [a.workorder] : [],
        cells: _buildAddedCells(startIdx, a.durationDays, hours, axis),
      }],
    }
    // Insert at the chronological position — before the first existing station that STARTS LATER — so
    // it lands as a new row in sequence (WS10 · WS15 · WS20) without disturbing any other row's order.
    let ins = workstations.length
    for (let i = 0; i < workstations.length; i++) {
      const span = _wsSpan(workstations[i], axis)
      if (span && span.start > startIdx) { ins = i; break }
    }
    // NEVER land INSIDE a run of same-named entries. _buildStations groups CONSECUTIVE entries sharing
    // a `ws` name into ONE station (a multi-subárea workstation is several entries), so splicing into
    // the middle of such a run SPLITS it into two independent stations: a later edit of that name then
    // moves only one half, and the halves drift apart. Walk back to the run's first entry.
    if (ins > 0 && ins < workstations.length && String(workstations[ins].ws) === String(workstations[ins - 1].ws)) {
      const nm = String(workstations[ins].ws)
      while (ins > 0 && String(workstations[ins - 1].ws) === nm) ins--
    }
    workstations.splice(ins, 0, wsObj)
  }
  return { ...group, workstations }
}

function applyOverrideToGroup(group, ov, axis) {
  if (!ov) return group
  let g = _injectAddedWorkstations(group, ov, axis)
  g = _applyLocoLevel(g, ov, axis)
  // The ws pass also has to run for a station created with "Propagar efeitos imediatamente", which
  // carries NO ws-scope edit of its own (the flag lives on the addWs entry — see AddedWorkstation.
  // propagate): without this the insertion push would never be computed and nothing downstream moved.
  const _addedProp = ov.addWs && Object.keys(ov.addWs).some(k => ov.addWs[k] && ov.addWs[k].propagate)
  if ((ov.ws && Object.keys(ov.ws).length) || _addedProp) g = applyWsEdits(g, ov.ws || {}, axis)
  if (ov.desc && Object.keys(ov.desc).length) g = applyDescEdits(g, ov.desc, axis)
  g = _stampEditAnnotations(g, ov)
  return _reorderSwappedWs(g, axis)   // swapped rows follow their new (start) order — see above
}

function _locoKeyOfGroup(g) { return `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}` }

/** The UNFILTERED counterpart of a rendered group (see cachedFullByKey), or null when no visual
 *  Workstation/Área filter is active — in which case the rendered group already IS the full one. */
function _fullGroupOf(key) {
  if (!cachedFullByKey || cachedFullFor !== cachedData) return null
  return cachedFullByKey.get(key) || null
}

/** Drop the stations a visual Workstation/Área filter is hiding, matched by ws‖subárea against the
 *  group the main thread asked us to render. A MANUALLY-ADDED station never appears in the filter's
 *  option list (it is not in the source schedule), so it can never be "selected" and always survives. */
function _maskToVisible(edited, visible, ov) {
  const keep = new Set()
  for (const w of (visible.workstations || [])) keep.add(`${w.ws}||${w.subarea ?? ''}`)
  if (ov && ov.addWs) for (const k of Object.keys(ov.addWs)) {
    const a = ov.addWs[k]; if (a && a.ws) keep.add(`${a.ws}||${a.subarea || ''}`)
  }
  const all = edited.workstations || []
  const workstations = all.filter(w => keep.has(`${w.ws}||${w.subarea ?? ''}`))
  return workstations.length === all.length ? edited : { ...edited, workstations }
}

/** applyOverrideToGroup for a group that is about to be RENDERED and may have been stripped by a
 *  visual filter: resolve the override against the FULL station list — so propagation, the
 *  Protection-Days buffer and the delay maths are identical whatever is filtered — then mask the
 *  result back down to what is actually on screen. Identity-equal to applyOverrideToGroup when no
 *  filter is active. */
function applyOverrideForRender(group, ov, axis) {
  const full = _fullGroupOf(_locoKeyOfGroup(group))
  if (!full || full === group) return ov ? applyOverrideToGroup(group, ov, axis) : group
  return _maskToVisible(ov ? applyOverrideToGroup(full, ov, axis) : full, group, ov)
}

/** The same resolved group WITHOUT the visual mask — every station the loco really has.
 *
 *  Use this for anything MEASURED rather than drawn. The masked group is missing whole stations, so a
 *  metric derived from it silently reports on a subset: a Workstation/Área filter that hides
 *  PROTECTIONDAYS made `_locoPdCount` return 0 and `_locoHasPd` false, which blanked the PD SHIELD in
 *  the MODELO column — and it stayed blank through every later patch until the filter was cleared
 *  ("PD indicator disappears and never comes back"). Takt and the conflict count had the same hole.
 *  Filters are visual only; identity-equal to applyOverrideToGroup when none is active. */
function applyOverrideFull(group, ov, axis) {
  const full = _fullGroupOf(_locoKeyOfGroup(group)) || group
  return ov ? applyOverrideToGroup(full, ov, axis) : full
}

// ── Hatch/delay REFERENCE for a locomotive (base ⊕ reference ⊕ swap trades) ──────────────────
// The delay hatch and the MODELO delay badge both measure `edited` against a REFERENCE layout:
// normally the original schedule, or the frozen Projeção baseline when one is active (refOv).
//
// A WS40↔WS50 manual swap needs a third ingredient. The trade itself is not a delay — each station
// moves into the exact slot its partner vacated — but a station that was swapped AND THEN MOVED is
// genuinely late, and used to be exempted entirely: computeOverrideHatch/_locoDelayDays skipped any
// station carrying `_swap`, so a swapped WS pushed three days late reported nothing.
//
// Folding the swap's OWN shift (`swapShift`, recorded at swap time — see lib/locoOverrides.ts) into
// the reference fixes both halves at once: the reference sits where the trade put the station, so a
// pure swap deviates by 0 exactly as before, while any LATER move is measured and hatched like any
// other delay. The swapped stations then need no special-casing downstream at all.
//
// Legacy overrides saved before `swapShift` existed carry only the flag; for those the edit's FULL
// shift is used, which IS the swap's contribution for a swap that has not been moved since — so old
// saved swaps keep hatching 0 and nothing regresses on reload.
function _swapRefOverride(ov, refOv) {
  const wsEdits = (ov && ov.ws) || null
  // A manually-added station has no row in the raw base, so the delay/recovery REFERENCE must
  // materialize it at its ANCHOR too — otherwise a freshly-added WS (which sits at its anchor with no
  // shift) would compare against "nothing" and paint a phantom delay/advance hatch. Carried WITHOUT
  // any ws/desc shift, so once the planner actually MOVES the added station the edited-vs-reference
  // delta re-appears and it hatches exactly like any other station.
  //
  // `propagate` is STRIPPED here for exactly the same reason, and it is the whole of the reported
  // "immediate propagation plots no delay boxes". The flag makes the station PUSH its followers (the
  // insertion push in applyWsEdits); leaving it on the reference made the reference push them too, so
  // the cascade the planner asked for was reproduced identically on both sides and every downstream
  // deviation measured 0 — no hatches, no delay badge, and the schedule LOOKING as though nothing had
  // propagated. The reference is "the loco as it was before this station existed"; the displacement
  // the insertion causes belongs to the EDITED side alone.
  let addWs = (ov && ov.addWs && Object.keys(ov.addWs).length) ? ov.addWs : null
  if (addWs) {
    const anchored = {}
    for (const k of Object.keys(addWs)) {
      const a = addWs[k]
      if (a && a.propagate) { const c = { ...a }; delete c.propagate; anchored[k] = c }
      else anchored[k] = a
    }
    addWs = anchored
  }
  let swaps = null
  if (wsEdits) for (const k of Object.keys(wsEdits)) {
    const e = wsEdits[k]
    if (!e || !e.swap) continue
    const s = e.swapShift
      ? { startShiftDays: e.swapShift.start, finishShiftDays: e.swapShift.finish }
      : { startShiftDays: e.startShiftDays || 0, finishShiftDays: e.finishShiftDays || 0 }
    if (!s.startShiftDays && !s.finishShiftDays) continue
    // `swap: true` rides along so the reference build reorders the traded rows the same way the
    // edited build does (_reorderSwappedWs) — otherwise reference and edited would line up their
    // workstations by different row orders and every comparison below would be against the wrong row.
    s.swap = true
    ;(swaps || (swaps = {}))[k] = s
  }
  if (!swaps && !addWs) return refOv || null
  const out = refOv ? { ...refOv } : {}
  // The added stations exist at their anchors in BOTH the reference and the edited layout.
  if (addWs) out.addWs = { ...(refOv && refOv.addWs) || {}, ...addWs }
  if (swaps) {
    // Projeção active: the swap trades layer ON TOP of the frozen reference, per WS key. A reference
    // that already pins the station wins on its own fields; the swap only supplies what it lacks.
    const ws = { ...(refOv && refOv.ws) || {} }
    for (const k of Object.keys(swaps)) ws[k] = { ...swaps[k], ...(ws[k] || {}) }
    out.ws = ws
  }
  return out
}

// ── Override → renderable annotations ────────────────────────────────────────────────────────
// Two things the RENDERER needs to know about a row that the transformed cells alone can't tell it:
//   • `_moveNotes`  — why the user moved this box (see MoveNote in lib/locoOverrides), for the
//                     corner indicator + its tooltip.
//   • `_satManual`  — the row was moved by hand in Move Mode, so it may OCCUPY a working Saturday
//                     whatever its workstation is. Without this the renderer would re-apply the
//                     WS40/WS50-only rule and hide the very cell the planner placed, or stamp a
//                     red "cannot work Saturday" X over it.
// Stamping them here means no extra plumbing: every path that displays edited data (the full build
// AND the surgical patchLocos) already routes through applyOverrideToGroup, so both pick this up.
//
// Purely additive — annotations never feed a date/scheduling transform. Runs LAST because the
// passes above rebuild rows from scratch. Each is stamped at the scope it was authored in; a
// ws-scope edit covers ALL of that station's rows (it moves the whole station), while a desc-scope
// edit covers only its own row. The workstation additionally reports `_satManual` when ANY of its
// rows has it, since WORK mode renders the station as one aggregated row.
function _stampEditAnnotations(group, ov) {
  const wsEdits = ov.ws || {}, descEdits = ov.desc || {}
  let touched = false
  const workstations = (group.workstations || []).map(w => {
    const we = wsEdits[String(w.ws ?? '')] || {}
    const wsNotes = we.notes && we.notes.length ? we.notes : null
    // The live-drag `satHand` sets it too, so the Saturday box a planner is dropping renders as an
    // occupied working day (no red "cannot work" X over it) during the preview. A COMMITTED landing
    // carries neither flag — its licence is the persisted `satDays` list — so it counts here as well,
    // or the row would render a red X over the very Saturday it occupies.
    const wsSatDays = (we.satDays && we.satDays.length) ? we.satDays : null
    const wsSat = !!we.satManual || !!we.satHand || !!wsSatDays
    const wsSwap = !!we.swap   // WS40↔WS50 trade → suppress the displacement/recovery hatch (computeOverrideHatch)
    let rowsChanged = false, anyRowSat = wsSat
    let anySatDays = wsSatDays   // the licensed dates, for the hatch's occupiable-day counting (_satDays)
    const desc_rows = (w.desc_rows || []).map(dr => {
      const de = descEdits[`${w.ws ?? ''}||${w.subarea ?? ''}||${dr.desc ?? ''}`] || {}
      const notes = de.notes && de.notes.length ? de.notes : null
      const deSatDays = (de.satDays && de.satDays.length) ? de.satDays : null
      const sat = wsSat || !!de.satManual || !!de.satHand || !!deSatDays
      if (!notes && !sat) return dr
      if (sat) anyRowSat = true
      if (deSatDays && !anySatDays) anySatDays = deSatDays
      rowsChanged = true
      const out = { ...dr }
      if (notes) out._moveNotes = notes
      if (sat) out._satManual = true
      if (wsSatDays || deSatDays) out._satDays = wsSatDays || deSatDays
      return out
    })
    if (!wsNotes && !anyRowSat && !rowsChanged && !wsSwap) return w
    touched = true
    const out = { ...w, desc_rows }
    if (wsNotes) out._moveNotes = wsNotes
    if (anyRowSat) out._satManual = true
    if (anySatDays) out._satDays = anySatDays
    if (wsSwap) out._swap = true
    return out
  })
  return touched ? { ...group, workstations } : group
}

// The indicator itself: a small red corner wedge on the FIRST box of a moved row — the same
// "this cell has a comment" marker Excel uses, which is already this audience's vocabulary and
// costs one absolutely-positioned span per annotated row (never per cell).
//   • hover → native title: the latest reason (+ how many older ones exist). Free, no listeners.
//   • click → the parent opens the full trail (GanttTable delegates on [data-move-note]; the row's
//     own data-* identity is what the parent looks the notes up by, so no text is duplicated here).
// The reason text is USER-AUTHORED, so it is escaped on the way into both the title and the DOM.
// Expand/collapse chevron for the Workstation ↔ Componente tier. Carries the full expansion
// key on data-ws-toggle; the main thread (GanttTable → GanttModal) flips that key in the
// React-owned expansion state and re-renders this LOCO's tbody via patchLocos. Clicking it
// never navigates — GanttTable tests [data-ws-toggle] before the [data-ws] nav handler.
function _wsToggleChevron(key, expanded) {
  const path = expanded ? 'M4 6 L8 10 L12 6' : 'M6 4 L10 8 L6 12'
  // Absolutely positioned in the TOP-LEFT corner of the WS cell (which is position:sticky ⇒
  // a valid containing block), matching the LOCO chevron — so the toggle sits in the SAME
  // spot before and after expanding (the expanded cell spans N rows; an inline chevron would
  // ride the vertically-centered label and jump on every toggle). The label div indents past
  // it (margin-left) so text never slides underneath on single-row cells.
  return `<span data-ws-toggle="${esc(key)}" role="button" title="${expanded ? 'Recolher Componentes' : 'Expandir Componentes'}" style="position:absolute;top:3px;left:2px;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;cursor:pointer;border:1px solid #C9CFD6;border-radius:4px;background:#fff;color:#374151;z-index:2"><svg width="9" height="9" viewBox="0 0 16 16" style="pointer-events:none"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
}

// Expand/collapse chevron for the LOCO ↔ Workstation tier. Absolutely positioned in the top-
// left corner of the frozen LINHA cell — the ONLY cell guaranteed visible in every layout,
// including the all-collapsed narrow mode where the WS column is width-0 (the LINHA cell is
// sticky ⇒ positioned ⇒ a valid containing block; its rotated text sits centered, clear of the
// corner). Identity travels on the span's own data-* attrs since the LINHA cell carries none.
// GanttTable tests [data-loco-toggle] before every navigation handler.
function _locoToggleChevron(group, expanded) {
  const path = expanded ? 'M4 6 L8 10 L12 6' : 'M6 4 L10 8 L6 12'
  const attrs = `data-loco-toggle="1" data-linha="${esc(group.linha)}" data-wo="${esc(group.wo)}" data-task="${esc(group.task_name)}" data-start-ms="${esc(String(group.start_ms ?? ''))}"`
  return `<span ${attrs} role="button" title="${expanded ? 'Recolher LOCO (linha única)' : 'Expandir LOCO (workstations)'}" style="position:absolute;top:3px;left:2px;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;cursor:pointer;border:1px solid #C9CFD6;border-radius:4px;background:#fff;color:#374151;z-index:2"><svg width="9" height="9" viewBox="0 0 16 16" style="pointer-events:none"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
}

// Merge two move-note trails chronologically (`at` is an ISO timestamp, so lexicographic order
// IS time order; entries without one sort first). The indicator must survive the expand/collapse
// tiers: a reason authored on the WS-scope edit (collapsed/WORK view) still has to show when the
// workstation is expanded, and a Componente reason still has to show on the aggregated summary
// row — so both render sites merge the scopes' trails instead of showing only their own.
function _mergeNotes(a, b) {
  if (!a || !a.length) return (b && b.length) ? b : null
  if (!b || !b.length) return a
  return [...a, ...b].sort((x, y) => String(x.at ?? '').localeCompare(String(y.at ?? '')))
}

function moveNoteBadge(notes) {
  if (!notes || !notes.length) return ''
  const older = notes.length - 1
  // Latest entry preview: "[Categoria] observação". The observation is optional now that the
  // category is mandatory, so either part may be absent (category absent only on legacy notes).
  const last = notes[notes.length - 1]
  const main = [last.category ? `[${last.category}]` : '', last.text || ''].filter(Boolean).join(' ')
  // Over-limit emphasis (VISUAL ONLY): the latest move finished BEYOND the Protection-Days limit
  // (pdOverLimit — the planner acknowledged the crossing warning). Draw a bigger, darker-red wedge
  // with a ring so a boundary override reads at a glance; a later move back inside appends a note
  // without the flag and the badge reverts to the normal small wedge. Never changes scheduling.
  const over = !!last.pdOverLimit
  const tip = `${over ? '⚠ Fora do limite de Dias de Proteção — ' : ''}${main}${older > 0 ? `  (+${older} anterior${older > 1 ? 'es' : ''})` : ''}`
  if (over) {
    return `<span data-move-note="1" title="${esc(tip)}" style="position:absolute;top:0;right:0;width:18px;height:18px;z-index:3;cursor:pointer;background:linear-gradient(225deg,${RED_DK} 0 52%,transparent 52% 100%);box-shadow:inset -2px 2px 0 0 #fff,0 0 0 1px ${RED_DK}"></span>`
  }
  return `<span data-move-note="1" title="${esc(tip)}" style="position:absolute;top:0;right:0;width:12px;height:12px;z-index:3;cursor:pointer;background:linear-gradient(225deg,${RED} 0 46%,transparent 46% 100%)"></span>`
}

// ── Edit-displacement hatch (visualization only) ─────────────────────────────────────────────
// Compares a BASE group against its override-applied version per description row and emits the SAME
// hatched-overlay maps the optimization view uses, so no new rendering is needed. Both colours hatch
// the days the bar VACATED (the renderer only hatches EMPTY days — an occupied day always wins), which
// mirrors the optimization overlay exactly:
//   • RED  (displacementSets) = the row's START moved LATER → the leading days it used to occupy
//                               [origStart .. newStart-1], now empty: it is DELAYED vs the original.
//   • ORANGE (recoveredSets)  = the row's FINISH moved EARLIER → the trailing days it used to occupy
//                               [newFinish+1 .. origFinish], now empty: it FINISHES EARLIER.
// Keyed identically to the optimization maps: `${linha||wo||task||start_ms||ws||subarea}||${origIdx}`.
// `start_ms` is invariant under overrides, and reference↔edited rows are paired by WORKSTATION IDENTITY
// (_pairBaseByIdentity) so a swapped station is always measured against ITSELF — see the note there for
// why array position cannot be trusted once a swap has been dragged past its partner.
function computeOverrideHatch(base, edited, axis, dispOut, recovOut, dispHalfOut, recovHalfOut) {
  if (!base || !edited || !base.workstations || !edited.workstations || !axis) return
  const rangeIdx = cells => {                 // [minIdx, maxIdx] of active business days, or null
    let lo = Infinity, hi = -1
    for (const iso in (cells || {})) { const p = axis.pos.get(iso); if (p != null) { if (p < lo) lo = p; if (p > hi) hi = p } }
    return hi < 0 ? null : [lo, hi]
  }
  const pairs = _pairBaseByIdentity(base, edited)
  for (let wi = 0; wi < edited.workstations.length; wi++) {
    const ew = edited.workstations[wi], bw = pairs[wi]
    if (!ew || !bw) continue
    // NOTE: swapped stations are NOT skipped here any more. The trade is neutralised by measuring
    // against a reference that already includes it (_swapRefOverride), so a pure swap still hatches
    // nothing while a swapped-THEN-MOVED station hatches its real slip. Skipping the station outright
    // exempted it from delay maths forever, which is the bug this replaces.
    // Only days this workstation could actually have WORKED count as displaced/recovered. A promoted
    // Saturday is not a delay day for a non-WS40/WS50 station — it never could have used it — so
    // including it inflated the hatch by one and read as a phantom +1 delay on the row after the one
    // straddling the Saturday. Counting occupiable days only keeps the hatch identical before and
    // after a calendar change.
    // `edited` has already been through _stampEditAnnotations, so a hand-moved station reports its
    // committed Saturday licence here as `_satDays`. It must: the hatch counts only days the row could
    // have WORKED, and for a station a planner moved onto a working Saturday that Saturday is now one of
    // them. Same rule as satCapForEdit: a WS40/WS50 station also counts a Saturday it ALREADY works in
    // the BASE (the reference the hatch measures against) — promoting the day must not change what
    // "could have been worked" for a station that never touched it.
    const cap = satCapForEdit(ew.ws, { satDays: ew._satDays }, _rowsUseSaturday(bw.desc_rows, axis))
    const prefix = `${edited.linha}||${edited.wo}||${edited.task_name}||${edited.start_ms ?? ''}||${ew.ws}||${ew.subarea ?? ''}`
    const erows = ew.desc_rows || [], brows = bw.desc_rows || []
    for (let di = 0; di < erows.length; di++) {
      const bRow = brows[di], eRow = erows[di]
      const bR = bRow && rangeIdx(bRow.cells), eR = eRow && rangeIdx(eRow.cells)
      if (!bR || !eR) continue                // appeared / disappeared / empty
      const [oStart, oFin] = bR, [eStart, eFin] = eR
      const key = `${prefix}||${di}`
      if (eStart > oStart) { const s = new Set(); for (let i = oStart; i < eStart;  i++) if (_occupiable(axis, i, cap)) s.add(axis.isos[i]); dispOut[key]  = s }  // delayed start → red leading
      if (eFin   < oFin)   { const s = new Set(); for (let i = eFin + 1; i <= oFin; i++) if (_occupiable(axis, i, cap)) s.add(axis.isos[i]); recovOut[key] = s }  // earlier finish → orange trailing
      // Half-day boundary (fractional takt). Slot model: AM = day*2, PM = day*2+1. When the delay/recovery
      // lands mid-day, ONE half of the boundary day is vacated → a HALF hatched box, NOT a full one:
      //   • delayed start ending on a PM slot (odd) ⇒ the day's AM half is vacated (side 'first', red).
      //   • earlier finish ending on an AM slot (even) ⇒ the day's PM half is vacated (side 'second', orange).
      // The boundary day is NOT in the whole-day sets above (they are exclusive of it), so no double-paint.
      // Integer takt keeps startSlot even / endSlot odd, so no half is ever emitted — behaviour unchanged.
      const bSpan = _rowSlotSpan(bRow, axis), eSpan = _rowSlotSpan(eRow, axis)
      if (dispHalfOut && bSpan && eSpan && eSpan.startSlot > bSpan.startSlot && (eSpan.startSlot % 2) === 1 && _occupiable(axis, eStart, cap)) {
        (dispHalfOut[key] || (dispHalfOut[key] = {}))[axis.isos[eStart]] = 'first'
      }
      if (recovHalfOut && bSpan && eSpan && eSpan.endSlot < bSpan.endSlot && (eSpan.endSlot % 2) === 0 && _occupiable(axis, eFin, cap)) {
        (recovHalfOut[key] || (recovHalfOut[key] = {}))[axis.isos[eFin]] = 'second'
      }
    }
  }
}

// Union an optimization hatch map (Record<key, string[]> from the main thread, may be null) with an
// override hatch map (Record<key, Set>) computed here. Returns null/the original when there's nothing
// to add, so the no-edit path is unchanged.
function _mergeHatchMaps(payloadMap, ovMap) {
  const ovKeys = Object.keys(ovMap || {})
  if (!ovKeys.length) return payloadMap || null
  const out = {}
  if (payloadMap) for (const k of Object.keys(payloadMap)) out[k] = new Set(payloadMap[k])
  for (const k of ovKeys) {
    if (out[k]) { for (const iso of ovMap[k]) out[k].add(iso) }
    else out[k] = ovMap[k]
  }
  return out
}

// ── Workstation-level edits ─────────────────────────────────────────────────────────────────
// Resize/move ONLY the edited station(s). With propagate ON, a station's net end-delta cascades
// to all SUBSEQUENT stations (gap-preserving); with propagate OFF the station moves alone (later
// stations keep their inherited position, possibly overlapping — the requested "local only"
// behaviour). PROTECTION-DAYS investigation/fix: a PD station ABSORBS inherited cascade as slack
// (shrinks its duration) so an upstream delay eats the protection buffer instead of pushing the
// LOCO Finish; only the leftover beyond the buffer (or an explicit finish edit) moves the Finish.
function applyWsEdits(group, wsEdits, axis) {
  const stations = _buildStations(group.workstations, axis)
  // ── Protection-Days boundary by SEQUENCE (array order), not date ──────────────────────────────
  // Everything after the Protection-Days block is a HARD boundary: anchored, immune to cascade. The
  // running cascade below is DATE-sorted, so a station sequenced AFTER PD that happens to START EARLIER
  // than PD by date (legacy layouts: "External ICI"/"Correction External ICI" overlapping or preceding
  // the buffer) would be reached BEFORE PD zeros the cascade and get dragged with it — sliding off the
  // buffer (seen on ES443026, pulled before PD; ES442826, pushed +2 after it). Flagging post-PD by the
  // workstations' own ORDER fixes it regardless of dates. Boundary = the LAST PD station, so a normal
  // trailing-PD loco flags nothing and is byte-identical; only locos with work sequenced after PD are
  // touched. A post-PD station still honors its OWN direct edit (item-5 manual correction) — only the
  // INHERITED cascade is denied.
  let pdLast = -1
  for (let i = 0; i < stations.length; i++) if (isProtectionWs(stations[i].ws)) pdLast = i
  if (pdLast >= 0) for (let i = pdLast + 1; i < stations.length; i++) stations[i].isPostPd = true
  // ── Sequencing reference: base ⊕ SWAP ────────────────────────────────────────────────────────
  // Everything below sequences stations — sort order, which stations are "parallel", and how much
  // displacement an edit publishes downstream. All three must read the positions the user is LOOKING
  // AT, and after a WS40↔WS50 trade those are not the base positions.
  //
  // `swapShift` is exactly the part of a station's stored shift that is the trade rather than an edit
  // (see lib/locoOverrides), so base ⊕ swapShift is the station's current pre-edit position. Sorting
  // and measuring against plain `s.start`/`s.end` instead meant a swap never reordered propagation:
  // edit the station the trade moved to the FRONT and the cascade still ran in base order, so it
  // pushed the wrong stations and the displacement it published double-counted the trade itself.
  //
  // GEOMETRY is deliberately NOT rebased — offsets, row remap deltas and durations stay measured from
  // base, because `startShiftDays` is absolute-from-base and already contains the trade. This only
  // changes ORDERING and the cascade's zero point. With no swap, swapShift is 0 and every value below
  // is identical to the old behaviour.
  for (const s of stations) {
    if (s.end < s.start) { s.seqStart = s.start; s.seqEnd = s.end; continue }   // unplaced (Infinity span)
    const e = wsEdits[s.ws] || null
    const sw = (e && e.swap && e.swapShift) ? (e.swapShift.start || 0) : 0
    const cap = satCapForEdit(s.ws, e, _membersUseSaturday(s.members, axis))
    s.seqStart = sw ? _occStep(axis, s.start, sw, cap) : s.start
    s.seqEnd   = sw ? _occStep(axis, s.end,   sw, cap) : s.end
  }
  // Cascade order: date (seqStart) WITHIN a partition, but POST-PD stations always sort AFTER the
  // pre-PD/PD stations regardless of date. This is what lets post-PD stations inherit the cascade that
  // EXITS Protection Days (pdExcess, published when PD's group is processed) instead of the raw pre-PD
  // cascade — so a delay smaller than the buffer never drags a post-PD station that merely happens to
  // START EARLIER than PD by date (the ES443026/ES442826 "External ICI" legacy layouts), while a delay
  // that OUTGREW the buffer flows through them. Ordering only drives the cascade math; the render keeps
  // the original workstation array order (xform write-back below).
  const placed = stations.filter(s => s.end >= s.start)
    .sort((a, b) => ((a.isPostPd ? 1 : 0) - (b.isPostPd ? 1 : 0)) || (a.seqStart - b.seqStart))
  if (!placed.length) return group
  const baseTakt = Number(group.takt) > 0 ? Math.round(Number(group.takt)) : null
  // ── MINIMUM DURATION: whole days unless the loco's takt is itself fractional ───────────────────
  // A workstation may be shrunk, but never into a half box nobody asked for. In a WHOLE-DAY loco
  // (integer takt, or no takt at all) the floor is ONE FULL DAY: the old floor was a flat 0.5, so
  // shrinking a row to zero produced a phantom half-day box — the reported "0.5 / 1.5 day durations
  // even though no half-day edit was performed". A loco whose takt is a half multiple (2.5) genuinely
  // works in half days, so there the floor stays 0.5. An explicit Ctrl/Cmd half-day Move-Mode edit is
  // unaffected either way — it sets a fractional shift, not a shrink past the floor.
  const _rawTakt = Number(group.takt) > 0 ? Number(group.takt) : null
  const minDur = (_rawTakt != null && !Number.isInteger(_rawTakt)) ? 0.5 : 1
  // day-0 = axis index of the LOCO start (fixed Finish reference for PRE-START stations).
  // `_day0Idx`, when present, is the reference ALREADY MOVED by a whole-loco start shift (stamped by
  // _applyLocoLevel, which runs before this pass and leaves start_ms at its base value on purpose).
  // Re-deriving it from start_ms on a shifted loco left the reference behind the geometry and
  // misclassified pre-start stations — see the comment there.
  const startIso = group.start_ms != null && group.start_ms !== '' ? String(group.start_ms).slice(0, 10) : null
  let day0 = group._day0Idx != null ? group._day0Idx : null
  if (day0 == null && startIso != null) {
    if (axis.pos.has(startIso)) day0 = axis.pos.get(startIso)
    else { for (let i = 0; i < axis.isos.length; i++) { if (axis.isos[i] >= startIso) { day0 = i; break } } }
  }

  let cascade = 0   // horizontal shift (biz-axis days) inherited by downstream stations
  // ── PARALLEL STARTS ──────────────────────────────────────────────────────────────────────────
  // `placed` is sorted by start, so stations that begin on the SAME day form a contiguous run. They
  // are processed as one GROUP: every member sees the same incoming cascade (the one accumulated
  // from strictly EARLIER starts), and the cascade an edited member produces is published only once
  // the whole group is done.
  //
  // That alone makes the result order-independent. Previously the running cascade was published
  // immediately, so whether a parallel station inherited it depended on where the stable sort left it
  // relative to the edited one — the array order, i.e. the order the workstations happened to arrive
  // in. A station listed after the edited one moved; one listed before it did not.
  //
  // On top of that, `parallelStarts` (per edit, DEFAULT ON) decides whether the group's non-edited
  // members follow the shift the edited member generated, keeping parallel activities aligned. Off,
  // they hold their ground and only genuinely later stations move.
  for (let gi = 0; gi < placed.length; ) {
    let gj = gi
    // "Parallel" means starting on the same day AS DISPLAYED, so the grouping reads seqStart too.
    // Same start day AND same PD-partition — a pre-PD and a post-PD station sharing a start day are
    // NOT parallel (they belong to different cascade phases), so the group must not straddle the boundary.
    while (gj < placed.length && placed[gj].seqStart === placed[gi].seqStart && placed[gj].isPostPd === placed[gi].isPostPd) gj++
    const groupIn = cascade      // cascade from strictly earlier starts — shared by the whole group
    let groupOut = cascade       // cascade this group publishes downstream
    let parallelOn = false       // did an edited member ask its parallel siblings to follow?
    let groupAbsorbed = false    // a Protection-Days member consumed (part of) the cascade
    let pdExcess = 0             // delay LEFT OVER after a PD buffer was fully spent — relayed downstream
  for (const s of placed.slice(gi, gj)) {
    cascade = groupIn            // order-independent: every member of the group starts from the same
                                 // inherited shift, never from a sibling's freshly-published one
    // Post-PD stations now PARTICIPATE in propagation (see the PD branch below): the buffer absorbs the
    // cascade up to its width and RELAYS any excess, so a delay that legitimately outgrew the buffer flows
    // through the stations after Protection Days as it would through any ordinary station. They no longer
    // ignore the inherited cascade. (Only the PD WARNING stays special — post-PD moves never raise it; see
    // GanttModal.) `inCascade` is what this station's GEOMETRY uses.
    // ── MANUALLY-ADDED stations are ANCHORED to the date the planner typed ────────────────────────
    // An added station (see _injectAddedWorkstations) has no base geometry: it exists only as an
    // ABSOLUTE start date, and that date is read off the schedule ON SCREEN. Letting the loco's
    // inherited cascade apply on top of it plotted the brand-new station `cascade` days later than the
    // date that was just entered — it appeared pre-delayed (and hatched a delay) the moment it was
    // created, because the hatch reference materializes it at its anchor while the render did not.
    // Its position is therefore its anchor plus its OWN edits, never an inherited displacement. It
    // still PUBLISHES propagation normally (out is measured from its anchor), so moving it cascades
    // downstream exactly like any other station.
    const isAdded = s.members.some(m => m && m._added)
    const inCascade = isAdded ? 0 : cascade
    // Durations are measured in the days THIS station can actually work: a non-WS40/WS50 station
    // straddling a promoted Saturday must still read 2 days (Fri+Mon), not 3. Counting the Saturday
    // inflated the duration, corrupted the takt multiple, and propagated as a phantom +1 downstream.
    // A station a planner moved by hand (satManual) CAN work the Saturday, so it counts it — the
    // whole point of the manual allocation is that the day is real work for that row. A WS40/WS50
    // station counts a Saturday only when it ALREADY works one (see satCapForEdit): merely promoting
    // the day must not pull the station onto it.
    const edit = wsEdits[s.ws] || null
    const satCap = satCapForEdit(s.ws, edit, _membersUseSaturday(s.members, axis))
    // MEASUREMENT capability vs POSITIONING capability. They are the same everywhere except under the
    // satNever veto, where they must differ: the veto makes Saturdays non-occupiable, so measuring the
    // station's EXISTING geometry with it would count a Saturday the row currently works as no work at
    // all — the station would SHRINK by a day instead of stretching past the Saturday, silently deleting
    // work. Measure with the capability the row actually occupies today (the veto lifted), then position
    // with `satCap` so the re-lay still skips every Saturday. Work content preserved, Saturdays avoided.
    const measCap = (edit && edit.satNever)
      ? satCapForEdit(s.ws, { ...edit, satNever: false }, _membersUseSaturday(s.members, axis))
      : satCap
    const oldDur = _occCount(axis, s.start, s.end, measCap)
    const startShift = edit && edit.startShiftDays ? edit.startShiftDays : 0

    // Size EVERY description row of the station (offset-preserving), mirroring the LOCO-level
    // transform. The edit acts on the WHOLE workstation, so it applies to ALL its rows: each row
    // keeps its offset within the station and, when takt-driven by its OWN span, resizes by its own
    // k × new-takt. The old union-span test misclassified a staggered multi-row workstation as FIXED
    // (union span not an exact takt multiple) and so a takt edit changed nothing — the reported bug.
    const plan = new Map()  // dr → { newDur, offset }
    let naturalDur = 0
    for (const m of s.members) {
      for (const dr of m.desc_rows) {
        const span = _wsSpan({ desc_rows: [dr] }, axis)
        if (!span) { plan.set(dr, { newDur: 0, offset: 0 }); continue }
        // Offset + duration in OCCUPIABLE days, for the same reason as `oldDur` above: a Saturday the
        // row cannot work must not stretch its offset within the station or its own length.
        const offset = _occCount(axis, s.start, span.start, measCap) - 1
        const rowOldDur = _occCount(axis, span.start, span.end, measCap)
        const rk = baseTakt ? rowOldDur / baseTakt : null
        const driven = rk != null && Number.isInteger(rk) && rk >= 1
        let rowNewDur = rowOldDur
        if (edit && edit.takt != null && edit.takt > 0 && driven) rowNewDur = rk * edit.takt
        // Finish shift grows/shrinks the rows that define the workstation finish.
        if (edit && edit.finishShiftDays && span.end === s.end) rowNewDur += edit.finishShiftDays
        // Floor at the loco's minimum working unit (see minDur) — a shrink may take a row down to one
        // day (or half a day in a fractional-takt loco) but never below it, and never into a half box
        // in a whole-day loco. An edit that ASKS for a fractional duration (a fractional takt, or an
        // explicit half-day finish shift) still gets it; this only stops the shrink from underflowing.
        // Protection Days never reach this floor: the PD branch below overwrites newDur with its own
        // buffer width, which stays consumable to exactly zero.
        rowNewDur = Math.max(minDur, rowNewDur)
        plan.set(dr, { newDur: rowNewDur, offset })
        if (offset + rowNewDur > naturalDur) naturalDur = offset + rowNewDur
      }
    }
    let newDur = naturalDur
    let collapse = false
    let pdNewStart = null
    // Protection Days are a BUFFER, not production work, so a PROPAGATED change RESIZES them — it never
    // shifts them. Their FINISH is anchored; the inherited cascade AND any direct start shift move only
    // the START: a delay (cascade>0 / startShift>0) pushes the start later and SHRINKS the buffer, a
    // pull-forward (<0) pulls the start earlier and GROWS it. The finish stays put while buffer remains,
    // so downstream stations don't move. Mirrors the LOCO-level PD rule (_applyLocoLevel).
    //
    // This runs even when the PD station carries an EDIT. PD is locked from Move Mode / the edit menu
    // (see _lockedWsKeys), so the committed override map never holds a PD ws-edit — the ONLY source of
    // one is Move Mode's frozen preview, which pins EVERY station (PD included) to its saved position
    // via startShiftDays (propagate OFF) so opening Move Mode changes nothing. That pin is a START pin;
    // honoring the buffer's finish anchor here reproduces the saved (possibly SPENT) buffer exactly. The
    // old `!edit` gate let the pinned PD fall through to the normal-station path, which took its BASE
    // duration back and overshot the anchored finish — "opening Move Mode expands Protection Days" (a
    // buffer already spent to 1 day reappeared at its full width). See tests/worker/move-freeze-pd.
    //
    // The buffer is consumable down to EXACTLY ZERO. It used to floor at one day, so a fully absorbed
    // buffer still rendered one protection box that no longer existed — the schedule claimed a day of
    // protection it had already spent. Zero is a legitimate state: the buffer is gone, the row shows
    // nothing (the `newDur <= 0` branch of the render loop below empties its cells), and the Protection
    // Days indicator reads 0.
    if (isProtectionWs(s.ws)) {
      const pinnedFinish = s.end
      let pdStart = _occStep(axis, s.start, cascade + startShift, satCap)
      let pdDur = _occCount(axis, pdStart, pinnedFinish, satCap)
      // _occCount already yields 0 once the start is pushed past the anchored finish (hi < lo → 0), so
      // the fully-spent case needs no clamp — only the START is normalized back onto the finish so
      // `newStart` stays a sane axis index for any consumer. The removed `pdDur < 1 → 1` line was the
      // artificial floor; nothing else was forcing a day to survive.
      if (pdDur <= 0) {
        pdDur = 0
        pdStart = pinnedFinish         // finish never moves; the row simply has no days left
      }
      pdNewStart = pdStart
      newDur = pdDur
      // The buffer absorbs the cascade UP TO its own width; any EXCESS beyond a fully-spent buffer is
      // RELAYED downstream instead of being dropped. So the stations after Protection Days stay put while
      // the buffer still has slack, but once the delay legitimately outgrows the buffer they move by the
      // leftover — propagation continues through them like any ordinary chain. `oldDur` is the base buffer
      // width (occCount of the PD span). The locally-consumed part is zeroed (hard boundary for the buffer
      // itself); the remainder is published to the group via `pdExcess`.
      pdExcess = Math.max(pdExcess, Math.max(0, (cascade + startShift) - oldDur))
      cascade = 0
      // A PD member RAN — record it as a fact here rather than letting the publish below infer it from
      // `cascade !== groupIn`. That inference is blind at zero: with no inherited cascade (groupIn 0) the
      // line above writes the 0 that was already there, so the group looked un-absorbed and `pdExcess`
      // was discarded in favour of `groupOut`. The buffer's own start shift is a real consumption source
      // (Move Mode pins every station, PD included), so its leftover must survive that case too.
      groupAbsorbed = true
      collapse = true
    }
    newDur = Math.max(0, newDur)
    // Position. A PRE-START station (finishes at/before day 0) pins its FINISH to the fixed day-0
    // reference and contracts/expands the START — Start = Finish − (Duration − 1) — so reducing its
    // duration moves the start later (toward day 0) instead of moving the finish. Post-start stations
    // pin the START as before. cascade/startShift still apply on top. PD pins its OWN finish (above).
    const isPre = day0 != null && s.end <= day0
    // ceil(newDur) = occupied COLUMN count, keeping positions integer for fractional (half-day) takt.
    const occ = Math.max(1, Math.ceil(newDur - 1e-6))
    // Positions step over OCCUPIABLE slots, so a station that cannot work Saturdays steps straight
    // over a promoted one instead of landing on it (which is how a box ended up under the red-X).
    const newStart = pdNewStart != null
      ? pdNewStart
      : (isPre
        ? _occStep(axis, _occStep(axis, s.end, -(occ - 1), satCap), inCascade + startShift, satCap)
        : _occStep(axis, s.start, inCascade + startShift, satCap))
    s.newStart = newStart
    s.newDur = newDur
    s.plan = plan
    s.collapse = collapse
    s.isPre = isPre
    s.oldDur = oldDur
    s.satCap = satCap
    s.satNever = !!(edit && edit.satNever)   // veto → re-lay even at zero delta (see the render loop)
    // Raw (un-snapped) total shift, kept so the render loop can detect a FRACTIONAL (half-day) start and
    // position on the slot grid — _occStep above rounds it to a whole day. Only meaningful for a normal
    // post-start station (PD/pre-start keep their whole-day placement); the render loop guards on that.
    s.rawShift = inCascade + startShift
    // Cascade is a DAY delta handed downstream: measure it in occupiable days between the old and new
    // finish, so a Saturday the station cannot work never contributes a phantom day to the chain.
    // A manually-added station created with "Propagar efeitos imediatamente" drives the cascade even
    // though it carries no ws-scope edit of its own (the flag lives on the station — see
    // _injectAddedWorkstations), so it enters the publish branch on that flag alone.
    const addedProp = isAdded && s.members.some(m => m && m._addedPropagate)
    // A PRE-START station propagates BACKWARD, never forward (see the predecessor cascade after this
    // loop). Its neighbours in sequence are the stations between it and day 0, and the work AT or
    // AFTER day 0 is anchored to the loco start — pushing that with a pre-start move would move day 0
    // itself, which is precisely what pinning these stations' finishes exists to prevent. So it
    // publishes nothing into the forward cascade; its displacement is relayed to its PREDECESSORS.
    if (isPre) { /* forward cascade suppressed — the backward pass below relays this move */ }
    else if ((edit && edit.propagate) || addedProp) {
      // Measured from seqEnd (base ⊕ swap), NOT the base finish: a swapped station's trade is not a
      // delay, so only the movement this EDIT adds on top of the trade may propagate. Against the base
      // finish, swapping WS50 three days earlier and then growing it by two published −1 downstream —
      // the trade leaking into the cascade with the wrong sign.
      // ── INSERTION push, for a manually-added station ("Propagar efeitos imediatamente") ────────
      // An added station never MOVED — it sits on the absolute date the planner typed (inCascade 0) —
      // so the translation measure below is 0 by construction and nothing downstream would budge.
      // Creating one is an INSERTION, not a move: it occupies time that did not exist in the schedule
      // before, so what it publishes is however far the following work must travel to CLEAR it, and
      // not a day more. A follower that already starts after it publishes 0, so creating a station in
      // free space stays a no-op — "delay should only appear if downstream is actually impacted".
      //   WS10 01→05 · WS20 06→10, insert WS15 04→07  ⇒  publishes +2; WS20 starts 08 and the rest
      //   cascade by that +2 through the ordinary machinery (PD absorption, parallel starts, post-PD
      //   anchoring, Remover gaps) with no special-casing anywhere downstream.
      // Protection Days is not a candidate follower: it is a buffer that ABSORBS the push under its
      // own rule rather than being the thing that has to clear the new station.
      const myEnd = _occStep(axis, newStart, occ - 1, satCap)
      // TRANSLATION — how far this station's own finish travelled. This is the whole story for an
      // ordinary station, and for an added one it is exactly the shift a later drag gave it (its
      // seqEnd is its anchor finish).
      let out = _occSignedDelta(axis, s.seqEnd, myEnd, satCap)
      if (addedProp) {
        // …but an added station ALSO has to be cleared, and at creation its translation is 0 by
        // construction. Take whichever is larger: the insertion push guarantees the follower clears
        // the new station, the translation guarantees a later drag still cascades. They coincide
        // whenever the drag alone already pushes far enough.
        let push = 0
        for (let fi = gj; fi < placed.length; fi++) {
          const f = placed[fi]
          if (isProtectionWs(f.ws) || f.end < f.start) continue
          const fCap = satCapForEdit(f.ws, wsEdits[f.ws] || null, _membersUseSaturday(f.members, axis))
          const fPos = _occStep(axis, f.seqStart, groupIn, fCap)
          push = Math.max(0, _occSignedDelta(axis, fPos, _occStep(axis, myEnd, 1, fCap), fCap))
          break
        }
        if (push > out) out = push
      }
      s.pubOut = out   // this station's OWN published push — marks it a DRIVER of the group (see carry below)
      // Two edited stations starting the same day compete: the LARGEST displacement wins, since the
      // downstream work has to clear both. (One edited station per group is the normal case.)
      if (Math.abs(out) > Math.abs(groupOut)) groupOut = out
      if (!edit || edit.parallelStarts !== false) parallelOn = true   // absent = ON (the default)
    }
    // `groupAbsorbed` is set directly by the Protection-Days branch above (it is the only thing in this
    // body that writes `cascade`; an edited station publishes through `groupOut` instead). It MUST survive
    // the group's publish below — otherwise `cascade = groupOut` would overwrite the buffer's boundary and
    // relay the delay straight past Protection Days into work that is anchored.
  }
    // When a PD member absorbed the cascade, publish its LEFTOVER (pdExcess) rather than dropping to 0,
    // so a delay that outgrew the buffer keeps propagating through the post-PD stations. A buffer with
    // slack to spare leaves pdExcess 0 → downstream stays anchored exactly as before.
    cascade = groupAbsorbed ? pdExcess : groupOut
    // Carry the group's carried members along by the extra displacement, so stations that started
    // together still start together. Only the DRIVER — the propagating station whose own edit produced
    // this group's push (pubOut === groupOut) — is exempt: its newStart already reflects that push, so
    // carrying it too would double-count. Protection Days are exempt as well (finish anchored; only
    // absorption may move their start).
    //
    // A station is exempt ONLY as a driver, NOT merely because it carries some edit. A station with its
    // OWN passive edit (no propagate, or a smaller push than the winner) was being DISPLAYED at its
    // carried position; excluding it from the carry the moment it is edited drops it back toward base —
    // that was the "an edited workstation reverts when I touch another one" bug. It must ride the carry
    // and keep its own edit on top (see tests/worker/parallel-carry-edit.test.js).
    const extra = groupOut - groupIn
    if (parallelOn && extra) {
      for (const s of placed.slice(gi, gj)) {
        if (isProtectionWs(s.ws)) continue   // PD finish anchored (only absorption may move its start)
        if (s.members.some(m => m && m._added)) continue   // anchored to its typed date — see inCascade above
        if (s.pubOut != null && s.pubOut === groupOut) continue   // the driver — already placed by its own edit
        s.newStart = _occStep(axis, s.newStart, extra, s.satCap)
        s.rawShift = (s.rawShift || 0) + extra
      }
    }
    gi = gj
  }

  // ── "Remover gaps futuros" (opt-in propagation mode, ScopedEdit.removeGaps) ────────────────────
  // The DEFAULT cascade TRANSLATES the downstream stations by a fixed delta, so the idle days between
  // them travel along untouched: WS40 +2 pushes WS50 +2 and the 2-day gap between them survives.
  //
  // With this on, the cascade PACKS them instead — every station after the edited one starts on the
  // first business day after its predecessor finishes. The free time ahead of a delay is therefore
  // CONSUMED by it before anything is pushed any further (a 2-day gap fully absorbs a 2-day slip, so
  // WS50 does not move at all), and once the gaps are spent the remainder keeps cascading normally.
  // Stations stay sequential, which is the whole point of the option.
  //
  // Two kinds of station are passed OVER rather than packed, because neither is an idle gap:
  //   • Protection Days — a deliberate buffer whose FINISH is anchored and whose start only moves by
  //     absorption (the branch above already decided its geometry; packing it would fight that rule).
  //   • a manually-added station — anchored to the absolute date the planner typed (see inCascade).
  // Both still BOUND what follows them, so the packing simply resumes after their finish.
  // A PRE-START station is never a gap driver: its forward cascade is deliberately suppressed (see
  // above — it propagates BACKWARD, to its predecessors), so it must not trigger a forward packing
  // either. Reading it as the driver packed the WHOLE loco tight against day 0 and dragged every
  // station after it EARLIER, from an edit whose documented contract is that nothing downstream moves.
  const isGapDriver = (s) => { const e = wsEdits[s.ws]; return !!(e && e.propagate && e.removeGaps && !s.isPre) }
  const gapDriver = placed.findIndex(isGapDriver)
  if (gapDriver >= 0) {
    const endOf = (s) => (s.newDur > 0
      ? _occStep(axis, s.newStart, Math.max(1, Math.ceil(s.newDur - 1e-6)) - 1, s.satCap)
      : s.newStart)
    // ── PARALLEL STARTS ARE NOT A GAP ────────────────────────────────────────────────────────────
    // Two stations that begin on the SAME DAY are running in parallel on purpose, and one of them
    // finishing later than the other is not idle time between them — there is no gap to remove. They
    // are therefore passed over exactly like Protection Days and manually-added stations: not moved,
    // not separated, not merged, their relationship left as the planner set it. (The grouping below
    // packs same-start stations together, which keeps them aligned but still SLIDES the pair; the
    // requirement is that Remover gaps not touch them at all.) They still BOUND what follows, so a
    // genuine gap AFTER the parallel block is still closed.
    // Judged on the CURRENT starts — what is on screen once the ordinary cascade has run — and taken
    // before any packing, so a station that is merely packed onto another's start day is unaffected.
    const startsShared = new Map()
    for (const s of placed) {
      if (s.newDur <= 0) continue
      startsShared.set(s.newStart, (startsShared.get(s.newStart) || 0) + 1)
    }
    const isParallel = (s) => (startsShared.get(s.newStart) || 0) > 1
    // ── EVERY DRIVER IS AN ANCHOR, NOT ONLY THE FIRST ONE ────────────────────────────────────────
    // `gapDriver` is the FIRST station carrying the option, and only that one was exempt from the
    // packing below. But a loco routinely holds several: the flag is STICKY per workstation (see
    // writeScopedEdit — `removeGaps ?? ws[k].removeGaps`), so every station ever moved with the option
    // keeps it, and one Move-Mode selection of several rows stamps it on all of them at once. Any
    // driver AFTER the first was then treated as ordinary downstream work and packed tight against its
    // predecessor — its own move erased, landing BEFORE the position it was just dragged to, with the
    // stations after it packed onto that wrong finish. So the station the planner had just moved was
    // the one thing gap removal was allowed to overwrite.
    //
    // A driver is where the planner put it, full stop. It is passed over exactly like Protection Days,
    // an added station or a parallel pair — not moved, only BOUNDING what follows (the packing resumes
    // after its finish), so genuine gaps downstream of it are still closed.
    const isAnchor = (s) => s.isPre || isGapDriver(s)
    // Packing starts after the furthest finish among the first driver and everything before it.
    let prevEnd = null
    for (let i = 0; i <= gapDriver; i++) { const e = endOf(placed[i]); if (prevEnd === null || e > prevEnd) prevEnd = e }
    for (let i = gapDriver + 1; i < placed.length; ) {
      // Same grouping rule as the cascade above: stations that START TOGETHER are packed together, so
      // parallel activities stay aligned instead of being strung out one after another.
      let j = i
      while (j < placed.length && placed[j].seqStart === placed[i].seqStart && placed[j].isPostPd === placed[i].isPostPd) j++
      let groupEnd = prevEnd
      for (const s of placed.slice(i, j)) {
        if (isProtectionWs(s.ws)) {
          // Protection Days are NOT packed onto prevEnd like production work (that would move a buffer
          // whose finish is anchored), but a recovered gap AHEAD of the buffer must REGROW it — this is
          // the "Remover gaps restores consumed Protection Days" requirement. Pull the START back toward
          // the packed work but never earlier than its base start (the buffer can't exceed its original
          // width) and never past its anchored finish; recompute the width. When the delay outlives the
          // gaps the packed position stays LATER than the base start, so the buffer stays shrunk — the
          // math is one expression either way (max of the two). Downstream still bounds off its anchored
          // finish (endOf), so a post-PD station keeps packing right after the deadline.
          if (prevEnd != null) {
            const pinnedFinish = s.end                       // the anchored deadline (base PD finish)
            const packed = _occStep(axis, prevEnd, 1, s.satCap)
            const pdStart = Math.max(s.start, packed)        // never grow past base start, never overlap work
            const pdDur = Math.max(0, _occCount(axis, pdStart, pinnedFinish, s.satCap))
            const nStart = pdDur <= 0 ? pinnedFinish : pdStart
            const delta = _occSignedDelta(axis, s.newStart, nStart, s.satCap)
            if (delta || pdDur !== s.newDur) { s.newStart = nStart; s.newDur = pdDur; s.rawShift = (s.rawShift || 0) + delta }
          }
          const e = endOf(s); if (groupEnd === null || e > groupEnd) groupEnd = e
          continue
        }
        const skip = s.members.some(m => m && m._added) || s.newDur <= 0 || isParallel(s) || isAnchor(s)
        if (!skip && prevEnd != null) {
          const packed = _occStep(axis, prevEnd, 1, s.satCap)
          const delta = _occSignedDelta(axis, s.newStart, packed, s.satCap)
          if (delta) { s.newStart = packed; s.rawShift = (s.rawShift || 0) + delta }
        }
        const e = endOf(s); if (groupEnd === null || e > groupEnd) groupEnd = e
      }
      prevEnd = groupEnd
      i = j
    }
  }

  // Backward (predecessor) cascade — the ONLY propagation a PRE-START station has.
  //
  // These stations run BEFORE the loco's day 0 and pin their FINISH to it, so their sequence points
  // the other way: the work that depends on one of them is the work BEFORE it, not after. Whatever
  // moves its START — a duration change (finish pinned, so the start travels) or a plain position
  // move — therefore propagates to its PREDECESSORS, shifting the whole pre-start chain by the same
  // delta so it compresses/expands toward day 0 with its gaps and order intact.
  //
  // It used to be gated on `newDur !== oldDur`, i.e. duration changes only, while a pure move fell
  // through to the FORWARD cascade and delayed the stations after it — pushing day-0 work with a
  // pre-start edit. The forward publish is now suppressed for these stations (see above) and this
  // pass handles both kinds of movement.
  for (const s of placed) {
    const edit = wsEdits[s.ws] || null
    if (!edit || !edit.propagate || !s.isPre) continue
    // Measured and re-applied in OCCUPIABLE days, per predecessor: a raw index shift would drag a
    // non-WS40/WS50 predecessor onto a promoted Saturday it cannot work.
    const dStart = _occSignedDelta(axis, s.start, s.newStart, s.satCap)
    if (!dStart) continue
    for (const p of placed) {
      if (p === s || p.seqStart >= s.seqStart) continue   // only earlier (predecessor) stations, as displayed
      // A Protection-Days station is NOT draggable: its finish is anchored and only its START moves,
      // by absorption (the block above). Translating it rigidly here contradicted that rule and slid
      // the whole buffer sideways — which opens exactly the artificial gap between Protection Days and
      // the station after it that this cascade was never meant to create. The buffer keeps whatever
      // absorption already decided; a predecessor chain compresses around it, not through it.
      if (isProtectionWs(p.ws)) continue
      p.newStart = _occStep(axis, p.newStart, dStart, p.satCap)
    }
  }

  const xform = new Map()
  for (const s of placed) for (const m of s.members) xform.set(m, s)
  const workstations = group.workstations.map(ws => {
    const s = xform.get(ws)
    if (!s) return ws
    if (s.newDur <= 0) return { ...ws, desc_rows: ws.desc_rows.map(dr => ({ ...dr, cells: {} })) }
    if (s.collapse) {
      // Spread every row across the (shrunk) station window — PD slack absorption. PD rows carry zero
      // hours, so use _regenRowCells (keeps a box per day) — else the absorbed PD would vanish.
      return { ...ws, desc_rows: ws.desc_rows.map(dr => ({ ...dr, cells: _regenRowCells(dr.cells, s.newStart, s.newDur, axis, s.satCap) })) }
    }
    // The station delta in OCCUPIABLE days, matching what _remapCells now steps in. Measuring it as a
    // raw index difference would double-count a skipped Saturday (the station steps over it, then the
    // cells would step over it AGAIN) and overshoot the move by a day.
    const delta = _occSignedDelta(axis, s.start, s.newStart, s.satCap)
    return {
      ...ws,
      desc_rows: ws.desc_rows.map(dr => {
        const p = s.plan && s.plan.get(dr)
        if (!p) return dr
        const span = _wsSpan({ desc_rows: [dr] }, axis)
        const rowOldDur = span ? _occCount(axis, span.start, span.end, s.satCap) : 0
        // HALF-DAY (PM) start → position on the SLOT grid so the LEADING half renders (whole-day
        // _occStep/_regenRowCells below can only place a TRAILING half). The trigger is an ODD start
        // slot: a half-integer station shift (Move-Mode Shift+/−) lands the start on a PM slot. The old
        // `rawShift*2` non-integer test never fired for a ±0.5 shift (0.5·2 = 1 is an integer), so the
        // leading half was snapped to a whole day. Integer shifts keep an even start slot + whole-day
        // path; PD/pre-start stations keep their whole-day placement.
        const stSlot = s.start * 2 + Math.round(s.rawShift * 2) + Math.round(p.offset) * 2
        if (s.rawShift != null && !s.isPre && !s.collapse && ((((stSlot % 2) + 2) % 2) === 1)) {
          return { ...dr, cells: _regenRowCellsSlots(dr.cells, stSlot, Math.max(1, Math.round(p.newDur * 2)), axis, s.satCap) }
        }
        if (p.newDur !== rowOldDur) {
          // Resized row → regenerate day-boxes across its new duration, anchored at the station's
          // new start plus the row's offset (keeps row order/alignment to the workstation timeline).
          // _regenRowCells so a zero-hour PD row keeps its boxes (correct count) instead of vanishing.
          // p.newDur is already floored at the loco's minimum working unit (see minDur), so this can no
          // longer manufacture the half box a flat `Math.max(0.5, …)` used to produce from a row shrunk
          // to zero. A row with NO span at all keeps newDur 0 and never reaches here (0 === rowOldDur).
          if (p.newDur <= 0) return { ...dr, cells: {} }
          return { ...dr, cells: _regenRowCells(dr.cells, _occStep(axis, s.newStart, p.offset, s.satCap), p.newDur, axis, s.satCap) }
        }
        // Same-duration row → translate by the station delta (offset preserved, all rows move).
        //
        // EXCEPT under the satNever VETO with nothing moving. Flagging a station that ALREADY sits on a
        // working Saturday changes no measurement: satCap is false on BOTH sides, so the row's old and
        // new durations are equally 2 (the Saturday counts for neither) and delta is 0 — the verbatim
        // copy below would keep the Saturday cell the veto exists to remove. Regenerate instead, which
        // re-lays the row over occupiable days only and pushes it past the Saturday.
        //
        // Deliberately scoped to `s.satNever` rather than "any cell on a non-occupiable day": an
        // ordinary non-Saturday-capable station holding a Saturday allocation (an optimizer/backend
        // one) must keep it untouched — promoting a Saturday may never re-lay a row on its own. That
        // invariant is what tests/worker/working-saturday-availability.test.js protects.
        if (!delta && s.satNever) return { ...dr, cells: _regenRowCells(dr.cells, _occStep(axis, s.newStart, p.offset, s.satCap), p.newDur, axis, s.satCap) }
        return { ...dr, cells: delta ? _remapCells(dr.cells, delta, axis, s.satCap) : { ...dr.cells } }
      }),
    }
  })
  return { ...group, workstations }
}

// ── Componente (description-row) edits ────────────────────────────────────────────────────────
// A "Componente" is the deduped description the user sees in FULL mode: the renderer groups raw
// desc_rows by their `desc` text within a workstation (ws + subarea). An edit targets ws||subarea||
// desc, so ALL raw rows that merge into that Componente are resized/moved together (union span),
// keeping them synchronized. Sibling Componentes of the same workstation are never touched.
// Propagate ON shifts SUBSEQUENT stations (later workstations) by the Componente's net end-delta.
function applyDescEdits(group, descEdits, axis) {
  const baseTakt = Number(group.takt) > 0 ? Math.round(Number(group.takt)) : null
  // Same minimum working unit as applyWsEdits: one whole day, or half a day only in a loco whose takt
  // is itself fractional. Stops a Componente shrink from underflowing into a phantom half box.
  const _rawTakt = Number(group.takt) > 0 ? Number(group.takt) : null
  const minDur = (_rawTakt != null && !Number.isInteger(_rawTakt)) ? 0.5 : 1
  const stations = _buildStations(group.workstations, axis)
  const memberStation = new Map()
  for (const st of stations) for (const m of st.members) memberStation.set(m, st)

  // day-0 = axis index of the LOCO start (fixed Finish reference for PRE-START Componentes), mirrors
  // the same computation in applyWsEdits so WS-level and Componente-level edits agree.
  // `_day0Idx` (stamped by _applyLocoLevel) already accounts for a whole-loco start shift; start_ms
  // does not, and using it alone on a shifted loco misclassified pre-start rows — see applyWsEdits.
  const startIso = group.start_ms != null && group.start_ms !== '' ? String(group.start_ms).slice(0, 10) : null
  let day0 = group._day0Idx != null ? group._day0Idx : null
  if (day0 == null && startIso != null) {
    if (axis.pos.has(startIso)) day0 = axis.pos.get(startIso)
    else { for (let i = 0; i < axis.isos.length; i++) { if (axis.isos[i] >= startIso) { day0 = i; break } } }
  }

  // Build Componentes: ws||subarea||desc → { members:[{ws,dIdx}], start, end, stationStart }.
  const comps = new Map()
  for (const ws of group.workstations) {
    const st = memberStation.get(ws)
    ws.desc_rows.forEach((dr, dIdx) => {
      const key = `${ws.ws}||${ws.subarea ?? ''}||${dr.desc ?? ''}`
      let c = comps.get(key)
      if (!c) { c = { members: [], start: Infinity, end: -Infinity, stationStart: Infinity }; comps.set(key, c) }
      c.members.push({ ws, dIdx })
      const span = _wsSpan({ desc_rows: [dr] }, axis)
      if (span) { if (span.start < c.start) c.start = span.start; if (span.end > c.end) c.end = span.end }
      if (st && st.start < c.stationStart) c.stationStart = st.start
    })
  }

  // Transform each edited Componente's rows; collect propagate sources.
  const newCellsFor = new Map()   // ws-entry → Map(dIdx → new cells)
  const newUnitFor = new Map()    // ws-entry → Map(dIdx → new hh_unit): "Horas totais" scales the
                                  // per-UNIT hours so Plano keeps QTY fixed (qty = hh/hh_unit) — see below.
  const propagateFrom = []        // { afterStart, delta }
  for (const key in descEdits) {
    const edit = descEdits[key]
    if (!edit || (edit.takt == null && !edit.startShiftDays && !edit.finishShiftDays && edit.hoursTotal == null)) continue
    const c = comps.get(key)
    if (!c || c.end < c.start) continue
    // "Horas totais" (Componente-scope hours override — DURATION UNCHANGED): rescale the whole
    // Componente's hours to the entered total, split across ITS PART-NUMBER rows in proportion to
    // their current share and then across each row's day-boxes. baseTotal is summed here, BEFORE the
    // resize passes below (which preserve each row's own total), so the factor is stable regardless of
    // any co-applied takt/shift. Zero-hour Componentes (baseTotal 0) can't be scaled → left untouched
    // (the panel disables the field), so a change never fabricates hours on a Protection-Day row.
    let hhFactor = null
    if (edit.hoursTotal != null && edit.hoursTotal >= 0) {
      let baseTotal = 0
      for (const m of c.members) baseTotal += _drTotalHh(m.ws.desc_rows[m.dIdx].cells)
      if (baseTotal > 0) hhFactor = edit.hoursTotal / baseTotal
    }
    // Every member of a Componente shares one workstation name (the key is ws||subarea||desc), so its
    // Saturday capability is uniform. Duration/positions are measured in the days it can actually work
    // — see the same rule in applyWsEdits, including the manual (Move Mode) Saturday allowance.
    const cap = c.members.length
      ? satCapForEdit(c.members[0].ws.ws, edit,
          c.members.reduce((acc, m) => {
            const s = _rowsUseSaturday([m.ws.desc_rows[m.dIdx]], axis)
            if (s) for (const iso of s) if (acc.indexOf(iso) < 0) acc.push(iso)
            return acc
          }, []))
      : false
    const oldDur = _occCount(axis, c.start, c.end, cap)
    const k = baseTakt ? oldDur / baseTakt : null
    const driven = k != null && Number.isInteger(k) && k >= 1
    let newDur = oldDur
    // Takt-driven Componente → k × new takt (existing). FIXED Componente (duration is not a takt
    // multiple) → the entered value is the absolute new DURATION in days, so a direct edit can resize
    // a fixed row (e.g. 1 → 3) instead of being ignored.
    if (edit.takt != null && edit.takt > 0) newDur = driven ? k * edit.takt : edit.takt
    if (edit.finishShiftDays) newDur += edit.finishShiftDays
    newDur = Math.max(minDur, newDur)
    const occ = Math.max(1, Math.ceil(newDur - 1e-6))   // occupied COLUMN count → integer positions
    const startShift = edit.startShiftDays || 0
    // A PRE-START Componente (finishes at/before day 0) pins its FINISH to the fixed day-0 reference and
    // resizes by moving the START — expansion backward, contraction forward — so a duration change never
    // opens a gap before day 0. Post-start Componentes keep pinning the START (unchanged). A pure move
    // (newDur === oldDur) reduces to c.start + startShift in both branches, so moves are unaffected.
    const isPre = day0 != null && c.end <= day0
    const newStart = isPre
      ? _occStep(axis, _occStep(axis, c.end, -(occ - 1), cap), startShift, cap)
      : _occStep(axis, c.start, startShift, cap)
    // HALF-DAY (PM) start → lay the row on the SLOT grid so the LEADING half renders (whole-day
    // _occStep/_regenRowCells can only ever place a TRAILING half). The trigger is an ODD start slot:
    // startShift is measured in days, so a half-integer shift (±0.5, ±1.5 …) lands the start on a PM
    // slot. The old `startShift*2` non-integer test never fired for these (0.5·2 = 1 is an integer),
    // so the leading half was silently snapped to a whole day — the Shift+/− bug. Contained to Move-Mode
    // Shift+/− (the only source of a half-integer startShiftDays); integer edits keep an even start slot
    // and their exact whole-day path. Pre-start Componentes keep whole-day placement (finish pinned to day 0).
    const startSlot = c.start * 2 + Math.round(startShift * 2)
    const durSlots = Math.max(1, Math.round(newDur * 2))
    const startFrac = !isPre && ((((startSlot % 2) + 2) % 2) === 1)
    if (edit.propagate) propagateFrom.push({ afterStart: c.stationStart, delta: _occSignedDelta(axis, c.end, _occStep(axis, newStart, occ - 1, cap), cap) })
    for (const m of c.members) {
      let perWs = newCellsFor.get(m.ws); if (!perWs) { perWs = new Map(); newCellsFor.set(m.ws, perWs) }
      const dr = m.ws.desc_rows[m.dIdx]
      const cells = startFrac
        ? _regenRowCellsSlots(dr.cells, startSlot, durSlots, axis, cap)
        : (newDur !== oldDur)
          ? _regenRowCells(dr.cells, newStart, newDur, axis, cap)   // zero-hour PD rows keep their boxes (count stays accurate)
          : _remapCells(dr.cells, _occSignedDelta(axis, c.start, newStart, cap), axis, cap)
      // Rescale to the requested Componente total AFTER positioning (positions preserved, hours only).
      perWs.set(m.dIdx, hhFactor != null ? _scaleCellsHh(cells, hhFactor) : cells)
      // "Horas totais" changes hours-per-UNIT, NOT quantity — the physical part count is fixed. Scale
      // hh_unit by the same factor so Plano de Produção (qty = hh / hh_unit) keeps QTY put while the unit
      // and the total move. Rows with no hh_unit (legacy) stay 0 → Plano already falls back to static qty.
      if (hhFactor != null) {
        const baseUnit = Number(dr.hh_unit) || 0
        if (baseUnit > 0) {
          let perWsU = newUnitFor.get(m.ws); if (!perWsU) { perWsU = new Map(); newUnitFor.set(m.ws, perWsU) }
          perWsU.set(m.dIdx, baseUnit * hhFactor)
        }
      }
    }
  }

  // Protection-Days station starts (ascending) — the HARD BOUNDARIES a propagation may not cross.
  const pdStarts = stations.filter(s => isProtectionWs(s.ws)).map(s => s.start).sort((a, b) => a - b)

  // Apply edited-row cells, then cascade SUBSEQUENT stations (translate their cells) by max delta.
  const workstations = group.workstations.map(ws => {
    const st = memberStation.get(ws)
    let cascade = 0
    // Pick the most-binding propagate delta (largest MAGNITUDE), so a backward move (negative delta)
    // pulls successors EARLIER just as a forward move pushes them later — propagation is symmetric.
    // HARD BOUNDARY: if a Protection-Days station sits between the edit source and this station, this
    // station is BEYOND the buffer and must stay anchored — skip the cascade for it entirely. The PD
    // station itself (st.start === boundary) is NOT skipped: it absorbs the cascade below.
    if (st) for (const p of propagateFrom) {
      if (st.start <= p.afterStart) continue
      const boundary = pdStarts.find(pd => pd > p.afterStart)
      if (boundary != null && st.start > boundary) continue   // past Protection Days → fixed
      if (Math.abs(p.delta) > Math.abs(cascade)) cascade = p.delta
    }
    const perWs = newCellsFor.get(ws)
    if (!perWs && !cascade) return ws
    // Protection Days are a BUFFER: a propagated cascade RESIZES them (FINISH anchored, START moves —
    // shrink on a delay, grow on a pull-forward) instead of shifting them sideways. Only when PD is a
    // downstream cascade target (not the edited Componente itself). Mirrors the WS-edit / LOCO PD rule.
    // Overflow beyond the buffer is DROPPED (finish pinned), never relayed — stations after PD stay put.
    if (cascade && !perWs && st && isProtectionWs(ws.ws)) {
      const pdCap = isSatCapableWs(ws.ws)
      let pdStart = _occStep(axis, st.start, cascade, pdCap)
      const pdDur = _occCount(axis, pdStart, st.end, pdCap)
      // Buffer consumable to EXACTLY ZERO, matching applyWsEdits: a spent buffer renders NO days rather
      // than the one box the old `pdDur < 1 → 1` floor kept alive. Emitted as empty cells directly —
      // _regenRowCells spreads over a duration and is not meaningful at zero.
      const desc_rows = pdDur <= 0
        ? ws.desc_rows.map(dr => ({ ...dr, cells: {} }))
        : ws.desc_rows.map(dr => ({ ...dr, cells: _regenRowCells(dr.cells, pdStart, pdDur, axis, pdCap) }))
      return { ...ws, desc_rows }
    }
    const perWsU = newUnitFor.get(ws)
    const desc_rows = ws.desc_rows.map((dr, dIdx) => {
      let cells = (perWs && perWs.has(dIdx)) ? perWs.get(dIdx) : dr.cells
      if (cascade) cells = _remapCells(cells, cascade, axis, isSatCapableWs(ws.ws))
      // Carry the rescaled per-unit hours (Plano keeps qty fixed, shows the new hh_unit).
      const newUnit = perWsU && perWsU.has(dIdx) ? perWsU.get(dIdx) : null
      if (newUnit != null) return { ...dr, cells, hh_unit: newUnit }
      return cells === dr.cells ? dr : { ...dr, cells }
    })
    return { ...ws, desc_rows }
  })
  return { ...group, workstations }
}

// LOCO-level edit (whole-loco takt / start / finish) — the original transform, unchanged.
function _applyLocoLevel(group, ov, axis) {
  if (!ov) return group
  const takt = ov.takt
  const startShift = ov.startShiftDays || 0
  const finishShift = ov.finishShiftDays || 0
  if (takt == null && !startShift && !finishShift) return group

  // Base takt is NOT rounded — rounding a fractional base (e.g. a LOCO previously set to 3.5) would
  // corrupt the takt-driven test below so some rows are misclassified as FIXED and never get their
  // half-day. Keep the true value and use a tolerant integer check on the multiple.
  const oldTakt = Number(group.takt) > 0 ? Number(group.takt) : null
  const taktChanged = takt != null && takt > 0 && oldTakt != null && Math.abs(takt - oldTakt) > 1e-9

  // Index of the LAST Protection-Days station in the workstation ARRAY (sequence, not date) —
  // the same boundary applyWsEdits uses for `isPostPd`. Everything after it is anchored against a
  // whole-loco start shift. A normal trailing-PD loco has nothing after it, so it is unaffected.
  let pdLastIdx = -1
  for (let i = 0; i < group.workstations.length; i++) if (isProtectionWs(group.workstations[i].ws)) pdLastIdx = i

  // ── The day-0 reference MOVES with a whole-loco start shift ───────────────────────────────────
  // `start_ms` is the loco's stable identity and is deliberately kept ORIGINAL by this pass (see the
  // note at the takt branch's return) — the visual move lives entirely in the regenerated cells. But
  // applyWsEdits / applyDescEdits run AFTERWARDS on the shifted geometry and re-derive day 0 from that
  // same untouched `start_ms`, so on a shifted loco their reference sat `startShift` days BEHIND what
  // they were measuring. A PRE-START station translated to the right of the stale reference was then
  // misclassified as post-start, and shrinking it pinned its START instead of its FINISH: the box slid
  // one day LEFT into the space it had just freed, on save, after the live preview (which paints from
  // per-station pins with the loco-level shift stripped, so it still classified correctly) had shown
  // it holding position. Stamp the SHIFTED reference on the returned group so every later pass
  // classifies against the schedule actually on screen.
  const _startIso0 = group.start_ms != null && group.start_ms !== '' ? String(group.start_ms).slice(0, 10) : null
  let _day0Base = null
  if (_startIso0 != null) {
    if (axis.pos.has(_startIso0)) _day0Base = axis.pos.get(_startIso0)
    else { for (let i = 0; i < axis.isos.length; i++) { if (axis.isos[i] >= _startIso0) { _day0Base = i; break } } }
  }
  // Stepped in OCCUPIABLE days, like the translation itself (_remapCells), so a promoted Saturday the
  // work steps over does not desynchronize the reference from the stations it classifies.
  const _day0Out = _day0Base == null ? null : (startShift ? _occStep(axis, _day0Base, startShift, false) : _day0Base)

  // ── No takt change → horizontal translation by startShift (cells keep their shape). ──
  // EXCEPTION: Protection Days are a BUFFER anchored to the LOCO finish (the committed deadline), not
  // production work. A start-date shift moves their START with the upstream work but PINS their FINISH
  // to the original finish reference, so a LATER start CONSUMES protection (buffer shrinks) and an
  // EARLIER start GROWS it — the finish/end date stays put instead of being relayed onward. The
  // displayed Protection-Days total is cell-derived (_locoPdCount), so resizing the cells here updates
  // it automatically.
  if (!taktChanged) {
    // ── PD OVER-CONSUMPTION IS RELAYED DOWNSTREAM (mirror of applyWsEdits' `pdExcess`) ───────────
    // The buffer absorbs the loco shift only UP TO ITS OWN WIDTH. Anything beyond that is a genuine
    // delay and must move the work sequenced after it, exactly like the WS-level cascade does. Post-PD
    // stations used to be pinned at `rowShift = 0` unconditionally, so a shift that outgrew the buffer
    // left them standing while the upstream work slid straight into them — the reported "boxes advance
    // and collide with the previous box". Capacity is the UNION span of the PD block (what the planner
    // sees as "the buffer"), which for the ordinary single-row PD is identical to applyWsEdits' `oldDur`.
    // Only a LATER start consumes; a pull-forward grows the buffer and relays nothing.
    let pdExcess = 0
    if (pdLastIdx >= 0 && startShift > 0) {
      let lo = Infinity, hi = -Infinity
      for (const w of group.workstations) {
        if (!isProtectionWs(w.ws)) continue
        for (const dr of w.desc_rows) {
          const ss = _rowSlotSpan(dr, axis)
          if (!ss) continue
          if (ss.startSlot < lo) lo = ss.startSlot
          if (ss.endSlot   > hi) hi = ss.endSlot
        }
      }
      // Slots are half-days; the buffer is a whole-day quantity, so round the day width to stay on the
      // whole-day grid _remapCells steps in (a fractional shift would smear the relayed rows).
      if (lo !== Infinity) pdExcess = Math.max(0, startShift - Math.round((hi - lo + 1) / 2))
    }
    const workstations = group.workstations.map((ws, wi) => {
      const pd = isProtectionWs(ws.ws)
      // POST-PD STATIONS ARE ANCHORED — up to the buffer's capacity. A whole-loco start shift is an
      // INHERITED move for anything sequenced after the buffer, and the PD boundary denies exactly that
      // (same rule, same array-order test as applyWsEdits' `isPostPd`): the buffer absorbs upstream
      // movement so the work beyond it keeps its committed dates. Without this a loco-level
      // Início/Término edit dragged post-PD stations along, sliding them off the buffer. Once the shift
      // OUTGROWS the buffer, the leftover (`pdExcess`) does move them — a spent buffer protects nothing.
      const rowShift = (pdLastIdx >= 0 && wi > pdLastIdx) ? pdExcess : startShift
      return {
        ...ws,
        desc_rows: ws.desc_rows.map(dr => {
          if (!rowShift) return { ...dr, cells: { ...dr.cells } }
          if (pd) {
            const ss = _rowSlotSpan(dr, axis)
            if (ss) {
              let newStartSlot = ss.startSlot + rowShift * 2        // start follows the work
              // Finish PINNED to ss.endSlot, and the buffer is consumable to EXACTLY ZERO: the moment the
              // later start clears the anchored finish there is no protection left, so the row renders
              // NOTHING. This used to clamp the start back onto the finish and then floor the width at one
              // whole day, so a fully-spent buffer kept rendering a protection box that no longer existed —
              // the phantom gap ahead of the post-PD workstation, and a day of protection the schedule had
              // already spent. applyWsEdits had the identical floor removed for the same reason; this is the
              // LOCO-level half of that fix. Zero remaining ⟺ newStartSlot === endSlot + 1, which is exactly
              // the boundary tested here, so a buffer with any slack left is untouched.
              if (newStartSlot > ss.endSlot) return { ...dr, cells: {} }
              let newDurSlots = ss.endSlot - newStartSlot + 1
              // WHOLE-DAY buffer: never render an AM/PM sliver. A partial final day is rounded UP onto the
              // whole finish day (both slots), which keeps the anchored end date. Zero is handled above, so
              // this can no longer manufacture a box out of a spent buffer.
              if (newDurSlots < 2) { newStartSlot = (ss.endSlot >> 1) * 2; newDurSlots = 2 }
              const cells = _drTotalHh(dr.cells) > 0
                ? _spreadCellsSlots(_drTotalHh(dr.cells), newStartSlot, newDurSlots, axis)
                : _spreadBoxesSlots(dr.cells, newStartSlot, newDurSlots, axis)
              return { ...dr, cells }
            }
          }
          return { ...dr, cells: _remapCells(dr.cells, rowShift, axis, isSatCapableWs(ws.ws)) }
        }),
      }
    })
    const next = { ...group, workstations }
    if (_day0Out != null) next._day0Idx = _day0Out
    if (takt != null && takt > 0) next.takt = takt
    return next
  }

  // ── Takt changed → reposition + resize at the DESCRIPTION-ROW level. Each description row is an
  // INDEPENDENT scheduling task: rows of the same workstation are NOT necessarily parallel — e.g. one
  // row at day 0 and another at day 0 + takt form a dependency chain — so every row is classified and
  // placed by its OWN business-day span. A row is takt-driven iff its duration is an exact positive
  // multiple of the old takt (k≥1 ⇒ duration = k × new takt); otherwise it is FIXED and keeps its
  // duration. Positioning is relative to the FIXED day-0 reference (start_ms):
  //   • start == day 0 → ANCHORED at day 0 (finish moves with the new duration). Parallel day-0 rows
  //     all stay at day 0 and never go negative.
  //   • start  < day 0 → PRE-START: cascade BACKWARD (finish pinned, start grows/shrinks back) so a
  //     pre-start row can never push day 0 earlier.
  //   • start  > day 0 → DEPENDENCY-DRIVEN: start = the UPDATED finish of its binding predecessor (the
  //     latest-finishing row that ends before it starts) + the original gap. So a predecessor's
  //     duration change moves its successors dynamically. Formula: predNewEnd + (start − predOldEnd).
  // The loco start shift (Início) is added uniformly at the end (it moves the whole loco, day 0 incl.).
  // All view modes (Full/Work/Loco) read these regenerated cells, so the fix applies in every mode.
  let day0 = _day0Base

  // One task per description row that has cells. Everything is tracked in HALF-DAY SLOTS so a
  // successor can begin in the second half of the day its predecessor finishes (shared day). A row's
  // duration in days is slots/2; the takt-driven test is unchanged (integer rows give integer k).
  const tasks = []
  for (let wi = 0; wi < group.workstations.length; wi++) {
    const ws = group.workstations[wi]
    const pd = isProtectionWs(ws.ws)
    const postPd = pdLastIdx >= 0 && wi > pdLastIdx      // anchored against the loco start shift
    for (const dr of ws.desc_rows) {
      const ss = _rowSlotSpan(dr, axis)
      if (!ss) continue
      const oldDurSlots = ss.endSlot - ss.startSlot + 1
      const oldDurDays = oldDurSlots / 2
      const rk = oldDurDays / oldTakt
      const rkR = Math.round(rk)
      const driven = Math.abs(rk - rkR) < 1e-6 && rkR >= 1     // tolerant: float-safe takt-multiple test
      const newDurDays = driven ? rkR * takt : oldDurDays
      const newDurSlots = Math.max(1, Math.round(newDurDays * 2))
      tasks.push({
        dr, pd, postPd,
        satCap: isSatCapableWs(ws.ws),      // may this row occupy a Saturday? (gates gap-closing packs)
        start: ss.startSlot >> 1,           // day index, kept for the day0 fallback below
        startSlot: ss.startSlot, endSlot: ss.endSlot,
        oldDurSlots, newDurSlots, newStartSlot: undefined,
      })
    }
  }
  if (day0 == null) { day0 = tasks.length ? Math.min.apply(null, tasks.map(t => t.start)) : 0 }
  const _day0Slot = day0 * 2
  const byStart = tasks.slice().sort((a, b) => (a.startSlot - b.startSlot) || (a.endSlot - b.endSlot))

  // Pass 1 — PRE-START rows (start < day 0): backward cascade, closest-to-day-0 first. Positions are
  // computed in the unshifted (day-0) frame; startShift is applied uniformly afterwards. Symmetric to
  // the forward pass: each row pins its FINISH to its BINDING SUCCESSOR (the row that genuinely starts
  // AFTER it ends — the earliest such), preserving the original gap. A row with no successor (the one
  // nearest day 0, AND every row that merely runs in PARALLEL with another, i.e. overlaps it) pins its
  // own original finish. This avoids chaining overlapping/parallel rows as if sequential — the cause
  // of the runaway where parallel pre-start rows drifted ever further out.
  const preTasks = byStart.filter(t => t.startSlot < _day0Slot).sort((a, b) => b.endSlot - a.endSlot)  // closest to day 0 first
  for (const t of preTasks) {
    let succ = null
    for (const p of preTasks) {
      if (p === t || p.newStartSlot === undefined) continue
      if (p.startSlot > t.endSlot && (!succ || p.startSlot < succ.startSlot)) succ = p
    }
    const newEndSlot = succ ? succ.newStartSlot - (succ.startSlot - t.endSlot) : t.endSlot
    t.newStartSlot = newEndSlot - t.newDurSlots + 1
  }

  // Pass 2 — day-0 anchors + forward dependency cascade (start >= day 0), in start order. A binding
  // predecessor (end < t.start) sorts before t, so its newStart is already set when we read it.
  for (const t of byStart) {
    if (t.startSlot < _day0Slot) continue
    if (t.startSlot === _day0Slot) { t.newStartSlot = _day0Slot }
    else {
      let pred = null
      for (const p of byStart) {
        if (p === t || p.newStartSlot === undefined) continue
        if (p.endSlot < t.startSlot && (!pred || p.endSlot > pred.endSlot)) pred = p
      }
      if (pred) {
        // Successor starts at the slot following the predecessor's LAST occupied slot, preserving the
        // ORIGINAL slot-gap. When that gap was 1 slot (back-to-back) and the predecessor now finishes
        // mid-day (e.g. takt 3.5 → ends Day-3 AM), the successor starts Day-3 PM — the SAME day, second
        // half — instead of being pushed to Day 4. Integer-takt rows keep whole-day gaps unchanged.
        const predLastSlot = pred.newStartSlot + pred.newDurSlots - 1
        t.newStartSlot = predLastSlot + (t.startSlot - pred.endSlot)
      } else {
        // No predecessor → anchored to day 0 by a fixed gap. When that gap is an exact takt multiple
        // (Start = day0 + k·takt) the START reference is TAKT-DRIVEN, so rescale it with the new takt;
        // otherwise keep the original start. Computed in slots (day0Slot + k·takt·2).
        const gapDays = (t.startSlot - _day0Slot) / 2
        const gk = oldTakt ? gapDays / oldTakt : null
        const gkR = gk != null ? Math.round(gk) : null
        t.newStartSlot = (gapDays > 0 && gkR != null && Math.abs(gk - gkR) < 1e-6 && gkR >= 1)
          ? _day0Slot + Math.round(gkR * takt * 2)
          : t.startSlot
      }
    }
  }

  // Apply the loco start shift (Início moves the whole loco, day 0 included): days → slots. Rows
  // sequenced AFTER the Protection-Days buffer are EXEMPT — the buffer absorbs upstream movement, so
  // a whole-loco shift must not drag them off it (same boundary rule as applyWsEdits' `isPostPd`).
  if (startShift) for (const t of tasks) if (t.newStartSlot !== undefined && !t.postPd) t.newStartSlot += startShift * 2

  // Protection Days pin their FINISH to the original finish reference (the committed deadline): the takt
  // change AND the start shift move their START (consuming/growing the buffer), but the finish stays put
  // so neither relays the move onto the LOCO end date. Computed AFTER the start shift so a later start
  // eats protection instead of dragging the anchored finish forward. Span = pinnedFinishSlot − newStart
  // + 1 (clamped ≥1); the displayed Protection-Days total is cell-derived, so it refreshes automatically.
  for (const t of tasks) if (t.pd && t.newStartSlot !== undefined) {
    if (t.newStartSlot > t.endSlot) t.newStartSlot = t.endSlot   // buffer consumed → pin to the anchored finish
    t.newDurSlots = t.endSlot - t.newStartSlot + 1
    // WHOLE-DAY FLOOR — see the same guard in the no-takt-change branch above: the old
    // `Math.max(1, …)` floored at one SLOT, i.e. a fractional half-day Protection-Days box.
    if (t.newDurSlots < 2) { t.newStartSlot = (t.endSlot >> 1) * 2; t.newDurSlots = 2 }
  }

  // Regenerate cells per row. Resized (duration changed) OR moved by a HALF-day (odd slot delta, which
  // a whole-day translate cannot express) → respread across the new slot window. A pure whole-day move
  // (even delta, same duration) → translate, preserving the row's exact internal shape and half flags.
  const cellsByDr = new Map()
  for (const t of tasks) {
    if (t.newStartSlot === undefined) continue
    const slotDelta = t.newStartSlot - t.startSlot
    if (t.newDurSlots !== t.oldDurSlots || (slotDelta % 2) !== 0) {
      const cells = t.dr.cells || {}
      // Zero-hour rows (Protection Days) would be dropped by _spreadCellsSlots; _spreadBoxesSlots keeps
      // a box per day so PD stays visible with its new Start/Finish/Duration. Hour rows use the former.
      cellsByDr.set(t.dr, _drTotalHh(cells) > 0
        ? _spreadCellsSlots(_drTotalHh(cells), t.newStartSlot, t.newDurSlots, axis)
        : _spreadBoxesSlots(cells, t.newStartSlot, t.newDurSlots, axis))
    } else {
      // slotDelta is a RAW slot difference; _remapCells steps OCCUPIABLE days, so convert rather than
      // pass it straight through — otherwise a row that skips a Saturday would skip it twice.
      cellsByDr.set(t.dr, _remapCells(t.dr.cells, _occSignedDelta(axis, t.startSlot >> 1, t.newStartSlot >> 1, t.satCap), axis, t.satCap))
    }
  }
  const workstations = group.workstations.map(ws => ({
    ...ws,
    desc_rows: ws.desc_rows.map(dr => cellsByDr.has(dr) ? { ...dr, cells: cellsByDr.get(dr) } : { ...dr, cells: { ...dr.cells } }),
  }))

  const next = { ...group, workstations }
  if (_day0Out != null) next._day0Idx = _day0Out
  // IMPORTANT: keep start_ms/finish_ms ORIGINAL — they are the LOCO's stable identity
  // (<tbody data-loco> key, data-start-ms, row ids) used to find/swap this row on the next
  // edit. The visual move is carried entirely by the regenerated/translated `cells`.
  next.takt = takt
  return next
}

// Surgical single-LOCO re-render: rebuild ONLY the <tbody data-loco> blocks for the given
// overrides, against the cached schedule. No shell, no other LOCOs, no global conflict
// recompute (visual-only). Returns [{ locoKey, html }] for the main thread to swap in place.
function handlePatchLocos(payload, post) {
  if (!cachedData) { post({ type: 'patched', results: [] }); return }
  const data = cachedData
  const dateInfo = data.date_info || []
  const holidays = holidaySetFromDateInfo(dateInfo)
  const fwIndex = buildFwIndex(dateInfo)
  const colorByWs = Boolean(payload.colorByWs)
  const hideBeforeStart = Boolean(payload.hideBeforeStart)
  const hidePastLocos = Boolean(payload.hidePastLocos)
  const overrides = payload.overrides || {}
  // Projeção delay-hatch baseline (empty in Padrão/Original): each edited WS hatches its deviation from
  // the REFERENCE position, matching the build path, so live edits in Projeção read against the reference.
  const refOverrides = payload.referenceOverrides || {}
  // The FULL live override map (touched + untouched locos) — needed to reproduce the trimmed
  // view axis when hidePastLocos is on, since the trim depends on EVERY visible loco's cells.
  const allOverrides = payload.allOverrides || overrides
  const axis = _bizAxis(dateInfo, holidays)

  // Reuse memoized merged groups when possible (avoids the 50-200 ms merge on every edit).
  const allGroups = (cachedAllGroupsFor === data && cachedAllGroups)
    ? cachedAllGroups
    : (cachedAllGroups = reorderByLoco(mergeGroups(data.groups || [])), cachedAllGroupsFor = data, cachedAllGroups)
  // key → { group, idx }. idx (position in render order) preserves row striping + the
  // inter-LOCO separator border so a swapped row looks identical to a full rebuild.
  const byKey = new Map()
  allGroups.forEach((g, idx) => byKey.set(`${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`, { group: g, idx }))

  const wsIndex = colorByWs ? buildWsIndex(allGroups) : {}
  const allowOverlap = Boolean(payload.allowOverlap)
  // Session-only conflict-WS selection (ConflictWsModal). Must be adopted BEFORE any conflict
  // work below — classifyConflicts / _locoHasConflictWs / _locoConflictCount all read it.
  _applyConflictWs(payload.conflictWs)

  // Transform every edited loco up-front (full cells) so we can (a) refresh its MODEL-column metrics
  // and (b) re-detect conflicts against the OTHER locos at their NEW positions. Surgical: only the
  // edited locos are recomputed; everything else is the cached base.
  const editedFull = new Map()
  for (const locoKey of Object.keys(overrides)) {
    const entry = byKey.get(locoKey)
    if (entry) editedFull.set(locoKey, applyOverrideForRender(entry.group, overrides[locoKey], axis))
  }
  // MEASURED (not drawn) counterpart: the same locos with NO visual mask, for the MODELO-column
  // metrics below. A filter that hides PROTECTIONDAYS must not blank the PD shield — see
  // applyOverrideFull. Only built when a filter is actually active; otherwise it IS editedFull.
  let editedMeta = editedFull
  if (cachedFullByKey && cachedFullFor === data) {
    editedMeta = new Map()
    for (const locoKey of Object.keys(overrides)) {
      const entry = byKey.get(locoKey)
      if (entry) editedMeta.set(locoKey, applyOverrideFull(entry.group, overrides[locoKey], axis))
    }
  }

  // ── "Ocultar LOCOs concluídas" (hidePastLocos): render against the TRIMMED axis ─────────────
  // The DOM table's columns were trimmed by the last full build (see the blank-column trim in the
  // build path). A patched <tbody> must produce exactly that column count/order or the whole grid
  // misaligns. Reproduce the build's trim from the FULL live override map; if the result no longer
  // matches what the DOM shows (lastViewTrim) — the edit moved cells across the visible boundary,
  // or flipped a LOCO in/out of the hidden row set — a tbody swap cannot stay consistent, so we
  // refuse the patch and ask the main thread for a full (in-place, scroll-preserving) rebuild.
  // The DOM table's columns were trimmed by the last full build whenever EITHER "Ocultar LOCOs
  // concluídas" (hidePastLocos) OR "Ocultar antes do início" (hideBeforeStart) is on (see the
  // build-path trim). A patched <tbody> must produce exactly that column count/order and only for
  // rows that actually render, or the grid misaligns — so reproduce the build's trim + survivor
  // set from the FULL live override map, and refuse (needsRebuild) if it no longer matches
  // lastViewTrim (an edit crossed the visible boundary, or flipped a row in/out of the view).
  let viewDateInfo = dateInfo
  let viewFwIndex  = fwIndex
  let survivorKeys = null
  const viewTrimActive = hidePastLocos || hideBeforeStart
  if (viewTrimActive) {
    const todayIso = localTodayIso()
    survivorKeys = new Set()
    let minIso = null, maxIso = null
    for (const g of allGroups) {
      const k = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
      const ov = allOverrides[k]
      const eg = editedFull.get(k) || ((ov && Object.keys(ov).length) ? applyOverrideForRender(g, ov, axis) : g)
      // hidePastLocos: a LOCO with no activity today or later is dropped entirely (same rule as
      // the build path). Evaluated over its REAL cells, before the before-start clip.
      if (hidePastLocos) {
        let recent = false
        outer: for (const w of (eg.workstations || [])) {
          for (const dr of (w.desc_rows || [])) {
            for (const iso in (dr.cells || {})) if (iso >= todayIso) { recent = true; break outer }
          }
        }
        if (!recent) continue
      }
      // Span over the VISIBLE cells (hideBeforeStart-clipped, like the build's renderGroups), so
      // both paths derive the same [minIso, maxIso]. A row with no visible cell emits no tbody, so
      // it is NOT a survivor (matches the build's renderGroups-non-empty filter).
      const startIso = (hideBeforeStart && eg.start_ms != null) ? String(eg.start_ms).slice(0, 10) : null
      let vMin = null, vMax = null
      for (const w of (eg.workstations || [])) {
        for (const dr of (w.desc_rows || [])) {
          for (const iso in (dr.cells || {})) {
            if (startIso && iso < startIso) continue
            if (vMin === null || iso < vMin) vMin = iso
            if (vMax === null || iso > vMax) vMax = iso
          }
        }
      }
      if (vMin === null) continue
      survivorKeys.add(k)
      if (minIso === null || vMin < minIso) minIso = vMin
      if (maxIso === null || vMax > maxIso) maxIso = vMax
    }
    if (minIso !== null) {
      const clamped = dateInfo.filter(d => d.iso >= minIso && d.iso <= maxIso)
      if (clamped.length) { viewDateInfo = clamped; viewFwIndex = buildFwIndex(clamped) }
    }
    const firstIso = viewDateInfo.length ? viewDateInfo[0].iso : null
    const lastIso  = viewDateInfo.length ? viewDateInfo[viewDateInfo.length - 1].iso : null
    let stale = !lastViewTrim || lastViewTrim.for !== data ||
      lastViewTrim.hideBeforeStart !== hideBeforeStart ||
      lastViewTrim.hidePastLocos !== hidePastLocos ||
      lastViewTrim.firstIso !== firstIso || lastViewTrim.lastIso !== lastIso
    if (!stale) {
      for (const k of Object.keys(overrides)) {
        if (!byKey.has(k)) continue
        if (survivorKeys.has(k) !== lastViewTrim.survivorKeys.has(k)) { stale = true; break }
      }
    }
    if (stale) { post({ type: 'patched', results: [], needsRebuild: true }); return }
  }
  // Conflicts only need re-detection when an edited loco touches a conflict WS (WS40/WS50) — moving a
  // non-target loco can't change the conflict landscape, so we keep the host's set/meta (cheap path).
  const conflictRelevant = [...editedFull.values()].some(_locoHasConflictWs)
  let conflictSet = null, overlapSet = new Set(), conflictDaySet = null
  if (conflictRelevant) {
    const groupsForConflict = allGroups.map(g =>
      editedFull.get(`${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`) || g)
    const cc = classifyConflicts(groupsForConflict, allowOverlap)
    conflictSet = cc.conflictSet; overlapSet = cc.overlapSet; conflictDaySet = cc.conflictDaySet
  }

  // Shell on the VIEW axis (trimmed when hidePastLocos is on), so every patched row emits the
  // same columns the DOM table shows — never the full axis against a trimmed header.
  const state = buildTableShell(viewDateInfo, holidays, viewFwIndex, conflictDaySet)
  state.overlapSet = overlapSet
  state.recoveredSets = payload.recoveredMap || null
  // Refresh PD / Takt / Conflict Count for the edited locos (clone — never mutate the host payload).
  // Conflict count uses the freshly classified set when relevant; untouched locos keep their values.
  state.locoMeta = _refreshEditedMeta(payload.locoMeta, editedMeta, conflictRelevant ? conflictSet : null, state.dateIsoSet)
  state.isOptView = !!(payload.locoMeta && Object.values(payload.locoMeta).some(m => m && m.origConflicts !== undefined))
  state.hideBeforeStart = hideBeforeStart
  // Workstation ↔ Componente expansion state (see pushRows). A patched tbody must render with
  // the SAME expansion the caller wants shown — including a toggle patch, whose only change IS
  // this state.
  state.expandBase = Boolean(payload.expandBase)
  state.expandExc = Array.isArray(payload.expandExceptions) && payload.expandExceptions.length
    ? new Set(payload.expandExceptions) : null
  // LOCO ↔ Workstation tier (see pushRows): missing base (legacy payload) defaults to
  // expanded, so the tree stays the default view.
  state.locoExpandBase = payload.locoExpandBase === undefined ? true : Boolean(payload.locoExpandBase)
  state.locoExpandExc = Array.isArray(payload.locoExpandExceptions) && payload.locoExpandExceptions.length
    ? new Set(payload.locoExpandExceptions) : null

  const renderConflictSet = conflictSet || new Set()
  const results = []
  for (const locoKey of Object.keys(overrides)) {
    const entry = byKey.get(locoKey)
    if (!entry) continue
    // Row hidden by "Ocultar LOCOs concluídas": the DOM has no tbody for it (survivorship is
    // guaranteed unchanged by the staleness check above) — nothing to patch.
    if (survivorKeys && !survivorKeys.has(locoKey)) continue
    // Hatch base = the reference position (Projeção: refOv present) or the original schedule (else),
    // with any WS40↔WS50 trade folded in so the swap itself reads as 0 deviation — see _swapRefOverride.
    const refOv = _swapRefOverride(overrides[locoKey], refOverrides[locoKey])
    const base = refOv ? applyOverrideForRender(entry.group, refOv, axis) : entry.group
    let g = editedFull.get(locoKey)
    // Edit-displacement hatch for THIS loco (red = finishes later, orange = finishes earlier than the
    // base), merged with any optimization hatch — same overlay the build path produces.
    const ovDisp = {}, ovRecov = {}, ovDispHalf = {}, ovRecovHalf = {}
    computeOverrideHatch(base, g, axis, ovDisp, ovRecov, ovDispHalf, ovRecovHalf)
    // MODELO delay badge: stamp this edited LOCO's slip vs the hatch reference (0 → no stamp). `g` is a
    // fresh applyOverrideToGroup result here, but spread anyway so the later hideBeforeStart clone keeps it.
    const _delay = _locoDelayDays(base, g, axis)
    if (_delay > 0) g = { ...g, _delayDays: _delay }
    const dispSets = _mergeHatchMaps(payload.displacementMap, ovDisp)
    state.recoveredSets = _mergeHatchMaps(payload.recoveredMap, ovRecov)
    state.recoveredHalf = ovRecovHalf
    if (hideBeforeStart) {
      const startIso = g.start_ms != null ? String(g.start_ms).slice(0, 10) : null
      if (startIso) {
        g = {
          ...g,
          workstations: g.workstations.map(w => ({
            ...w,
            desc_rows: w.desc_rows.map(dr => {
              const cells = dr.cells || {}
              const kept = {}
              for (const iso in cells) if (iso >= startIso) kept[iso] = cells[iso]
              return { ...dr, cells: kept }
            }),
          })),
        }
      }
    }
    state.parts.length = 0
    // idx preserves stripe color; drawLocoSeparator = idx > 0 keeps the LOCO top border.
    pushRows(state, g, entry.idx, entry.idx > 0, colorByWs, wsIndex, renderConflictSet, dispSets, ovDispHalf)
    results.push({ locoKey, html: state.parts.join('') })
  }
  post({ type: 'patched', results })
}

// ── Global propagation cascade (manual edit → "Propagar efeitos: Global") ──────────────────────
// After a manual edit is confirmed with GLOBAL propagation, Local propagation first runs inside the
// edited locomotive (unchanged). Global then follows ONLY the EDITED workstation (WS40→WS40→WS40…, or
// WS50→WS50…, etc.) through the SUBSEQUENT locomotives of the same Type — and, for New Locos, the same
// production line (Main↔Main, Special↔Special, never crossed):
//   • Take the same-stream locos that OCCUPY the edited WS, ordered by that WS's start day.
//   • For each loco AFTER the edited one, compare its edited-WS window to the nearest preceding
//     ALREADY-UPDATED loco's SAME WS. Overlap ⇒ move its WS start to prevLast + 1 business day, CAPPED
//     by that loco's Protection Days (partial ok; PD=0 ⇒ no move). Then evaluate the next loco against
//     THIS one's updated WS. Cascade sequentially.
//   • PULL (recovery): when there is NO overlap and this loco's edited WS is CURRENTLY DELAYED vs its
//     reference, move it earlier by min(delay, slack-to-predecessor) — never past its reference and
//     never onto the predecessor. On-time locos are never pulled.
//
// PURE: returns moves = [{ key, shift, ws }] for the EDITED WS (ws = that loco's OWN raw workstation
// string, so the caller keys the override correctly). The main thread commits each as a WS-scope
// `startShiftDays` + `propagate:true` on that WS — reusing the existing Local propagation so the WS
// and everything downstream INSIDE that loco shifts (earlier workstations stay put). Never mutates
// worker state. Only cascades when the edited WS is one of the ranked/constrained WS.
// KNOWN LIMITATION: windows are read on the Mon–Fri business axis (_bizAxis, same space the delay
// hatches use), so a WS40/WS50 op parked on a promoted Saturday is not counted in its window.
function _normWsKey(ws) { return String(ws || '').trim().toUpperCase().replace(/\s+/g, '') }

function _tipoGeralWorker(linha) { return tipoOfLinha(linha) }

// First/last business-axis slot window for ONE workstation (matched by normalized name) of a
// (possibly overridden) group, plus that loco's OWN raw ws string for that workstation.
function _wsWindowOf(group, wsNorm, axis) {
  let first = Infinity, last = -Infinity, rawWs = null
  for (const ws of (group.workstations || [])) {
    if (_normWsKey(ws.ws) !== wsNorm) continue
    const span = _wsSpan(ws, axis)
    if (!span) continue
    if (rawWs == null) rawWs = String(ws.ws ?? '')
    if (span.start < first) first = span.start
    if (span.end > last) last = span.end
  }
  return first === Infinity ? null : { first, last, rawWs }
}

// ── Intra-locomotive floor for a cross-loco PULL ─────────────────────────────────────────────────
// Global propagation may pull a delayed workstation EARLIER to close a gap against the preceding
// LOCO. That is an inter-loco constraint only, and on its own it is not sufficient: the workstation
// also has to fit inside its OWN locomotive's sequence. Loco 1's WS12 ending on day 10 says nothing
// about whether loco 2's WS12 can start on day 11 — if another station in loco 2 runs through day 14,
// it cannot.
//
// This returns the earliest slot the workstation may occupy WITHOUT colliding with its own loco's
// preceding work: the latest end among that loco's other stations that finish BEFORE it starts, plus
// one. A station that already OVERLAPS the workstation's window is deliberately ignored — it coexists
// with it today, so it is not a sequencing boundary this pull would newly violate.
//
// The caller takes max(inter-loco floor, this) as the final allowed start.
function _innerEarliestStart(group, wsNorm, wsFirst, axis) {
  let prevEnd = -Infinity
  for (const ws of (group.workstations || [])) {
    if (_normWsKey(ws.ws) === wsNorm) continue     // the workstation being moved is not its own bound
    const span = _wsSpan(ws, axis)
    if (!span) continue
    if (span.end < wsFirst && span.end > prevEnd) prevEnd = span.end
  }
  return prevEnd === -Infinity ? -Infinity : prevEnd + 1
}

function _locoPdCountWorker(group) {
  let pd = 0
  for (const ws of (group.workstations || [])) {
    if (!isProtectionWs(ws.ws)) continue
    for (const dr of (ws.desc_rows || [])) pd += Object.keys(dr.cells || {}).length
  }
  return pd
}

function computeGlobalCascade(payload) {
  const editedKey = payload.editedKey
  const editedWs = _normWsKey(payload.editedWs)
  // Gate: ANY workstation may cascade cross-loco, not just the ranked ones. The rank list
  // (NEW_LOCOS_WS_PRIORITY) no longer restricts eligibility — it stays only as the LOCO-mode
  // display priority. The cascade is inherently self-limiting: a loco that does not occupy the
  // edited WS is skipped below, so an unranked WS simply cascades across the locos that use it.
  if (!editedKey || !editedWs) return { moves: [], wsLocos: [] }
  // "Propagar Adiantamento" sub-option — see the PULL branch below.
  const advance = Boolean(payload.advance)
  const overrides = payload.overrides || {}          // CURRENT overrides for every loco (edited included)
  const refOverrides = payload.referenceOverrides || {}   // reference/on-time baseline (delay calc)
  // Compute on the FULL, unfiltered dataset the caller passes in — NEVER the (possibly filtered)
  // cachedData the renderer uses. A WS/area/period filter strips workstations (Protection Days
  // included) from cachedData.groups, which would zero every loco's PD and silently refuse every
  // push. The filter is purely visual; propagation must ignore it. Falls back to cachedData only
  // when the caller sent nothing (e.g. a legacy payload).
  const rawGroups = Array.isArray(payload.groups) ? payload.groups : ((cachedData && cachedData.groups) || [])
  const dateInfo = Array.isArray(payload.dateInfo) ? payload.dateInfo : ((cachedData && cachedData.date_info) || [])
  if (!rawGroups.length) return { moves: [], wsLocos: [] }
  const holidays = holidaySetFromDateInfo(dateInfo)
  const axis = _bizAxis(dateInfo, holidays)

  const allGroups = reorderByLoco(mergeGroups(rawGroups))
  const byKey = new Map()
  for (const g of allGroups) byKey.set(`${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`, g)

  const editedBase = byKey.get(editedKey)
  if (!editedBase) return { moves: [], wsLocos: [] }
  const editedType = _tipoGeralWorker(editedBase.linha)
  const editedLine = editedBase.linha
  // Which locos share a propagation stream with the edited one?
  //
  // Normal workstations: SAME TYPE only, and for New Locos also the same line (Main Line → Main
  // Line, Special Line → Special Line). A workstation is a per-stream resource, so a delay in one
  // stream says nothing about another.
  //
  // Conflict workstations (WS40/WS50) are the documented exception: they are ONE physically shared
  // constrained resource that every stream queues for, so their cascade crosses BOTH Type and the
  // Main↔Special line split. Anything else would model two independent WS40s that do not exist.
  // PHYSICAL set on purpose: this exception exists because WS40/WS50 is ONE machine every stream
  // queues for. The session-only detection override is a highlighting choice and must not silently
  // widen a propagation rule across Types.
  const isConflictWs = CONFLICT_WS_PHYSICAL.has(editedWs)
  const sameStream = (linha) => {
    if (isConflictWs) return true
    const t = _tipoGeralWorker(linha)
    return t === editedType && (editedType !== 'new_locos' || linha === editedLine)
  }

  // One entry per same-stream loco that OCCUPIES the edited WS. first/last = current WS window (its
  // override applied); refFirst = reference WS start (delay/pull bound); pd = Protection Days; ws = the
  // loco's OWN raw workstation string (for keying the override).
  const locos = []
  for (const g of allGroups) {
    const key = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
    if (key !== editedKey && !sameStream(g.linha)) continue
    const ov = overrides[key] || null
    const cur = ov ? applyOverrideToGroup(g, ov, axis) : g
    const win = _wsWindowOf(cur, editedWs, axis)
    if (!win) continue   // this loco doesn't use the edited WS → not part of THIS WS's cascade
    const refOv = refOverrides[key] || null
    const ref = refOv ? applyOverrideToGroup(g, refOv, axis) : g
    const refWin = _wsWindowOf(ref, editedWs, axis)
    locos.push({
      key, first: win.first, last: win.last, refFirst: refWin ? refWin.first : null,
      pd: _locoPdCountWorker(cur), hasPd: _locoHasPd(cur), ws: win.rawWs,
      innerEarliest: _innerEarliestStart(cur, editedWs, win.first, axis),
    })
  }

  // Order by the edited WS's start day; process everything AFTER the edited loco sequentially, always
  // comparing to the most-recently-updated loco (predLast).
  locos.sort((a, b) => a.first - b.first || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const editedIdx = locos.findIndex(l => l.key === editedKey)
  if (editedIdx < 0) return { moves: [], wsLocos: [] }

  const moves = []
  let predLast = locos[editedIdx].last   // seed: the edited loco's (post-edit) WS end
  for (let i = editedIdx + 1; i < locos.length; i++) {
    const c = locos[i]
    let shift = 0
    if (c.first <= predLast) {
      // Overlap → forward push to prevLast + 1 business day, capped by Protection Days (partial ok).
      //
      // The cap only applies to a loco that HAS a Protection-Days station: the buffer is what may be
      // consumed, so a full buffer bounds the push and a consumed one (pd === 0 with a station) still
      // blocks it. A loco whose routing defines NO buffer at all is a different case entirely — the
      // Propulsion/B3 families carry WS71 and no Protection Days row, so `Math.min(required, 0)` made
      // Global propagation a guaranteed no-op for that whole stream: the overlap was computed
      // correctly and then clamped away. There is no buffer to protect there, and two locos cannot
      // occupy one workstation on the same day, so the push runs uncapped.
      const required = (predLast + 1) - c.first
      shift = c.hasPd ? Math.min(required, c.pd) : required
    } else if (advance) {
      // "Propagar Adiantamento": no overlap ⇒ close the gap outright. The successor's workstation
      // lands on the first day after its predecessor's, whether or not it is late against any
      // reference — that is the whole point of the option: an ADVANCE propagates forward the same
      // way a delay propagates backward. The intra-loco floor still bounds it (a cross-loco pull
      // may never produce an internally invalid loco), so a station whose own loco is still busy
      // up to that day stays where it is.
      const allowedStart = Math.max(predLast + 1, c.innerEarliest)
      const slack = c.first - allowedStart
      if (slack > 0) shift = -slack
    } else if (c.refFirst != null) {
      // Gap → PULL a currently-delayed loco earlier by min(delay, slack), never past its reference.
      const delay = c.first - c.refFirst
      if (delay > 0) {
        // Final Allowed Start = max(inter-loco constraint, intra-loco constraint). The inter-loco
        // floor alone would happily advance this workstation onto days its OWN loco still has work on
        // (see _innerEarliestStart) — the slot being free in the PRECEDING loco says nothing about
        // this one. Taking the max keeps the locomotive's internal sequence valid, which is a hard
        // requirement: a cross-loco optimisation must never produce an internally invalid loco.
        const allowedStart = Math.max(predLast + 1, c.innerEarliest)
        const slack = c.first - allowedStart
        const pull = Math.min(delay, slack)
        if (pull > 0) shift = -pull
      }
    }
    if (shift !== 0) { c.first += shift; c.last += shift; moves.push({ key: c.key, shift, ws: c.ws }) }
    predLast = c.last   // this loco (moved or not) becomes the predecessor for the next
  }

  // `wsLocos` = every same-stream loco that RUNS the edited workstation, moved or not, with that
  // loco's own raw ws string. The cascade itself only reports locos that need to shift; "Propagar
  // Duração" has to reach all of them (a loco whose position is already fine still adopts the new
  // duration), so the full membership is reported separately rather than inferred from `moves`.
  const wsLocos = locos.filter(l => l.key !== editedKey).map(l => ({ key: l.key, ws: l.ws }))
  return { moves, wsLocos }
}

self.onmessage = async event => {
  const { type, payload } = event.data || {}
  if (type === 'cancel') { cancelPending = true; return }
  if (type === 'patchLocos' && payload) {
    const buildId = payload.buildId
    const post = (msg) => self.postMessage({ ...msg, buildId })
    try { handlePatchLocos(payload, post) }
    catch (e) { post({ type: 'patched', results: [], error: e instanceof Error ? e.message : String(e) }) }
    return
  }
  // Global-propagation cascade for a manual edit (see computeGlobalCascade). Returns shift deltas;
  // the main thread commits them as loco-scope overrides. Purely additive; touches no build state.
  if (type === 'computeGlobalCascade' && payload) {
    const reqId = payload.reqId
    try {
      const { moves, wsLocos } = computeGlobalCascade(payload)
      self.postMessage({ type: 'globalCascadeComputed', reqId, moves, wsLocos })
    } catch (e) {
      self.postMessage({ type: 'globalCascadeComputed', reqId, moves: [], wsLocos: [], error: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  // Compute the OVERRIDE-MERGED schedule as DATA (not HTML) for the non-Schedule tabs (General
  // Summary / Gets Planned / Production Plan), so they reflect saved edits exactly like the Schedule
  // view. Reuses the SAME merge engine the renderer uses (mergeGroups + applyOverrideToGroup) — one
  // implementation, guaranteed parity. Purely additive: does not touch build/patch state.
  if (type === 'computeEffective' && payload) {
    const reqId = payload.reqId
    try {
      const data = payload.data || {}
      const overrides = payload.overrides || {}
      // Memoize the expensive merge+reorder+axis by source-data identity. During an editing burst
      // the SAME effectiveData object is sent repeatedly (only `overrides` changes), so this skips
      // the 50-200 ms mergeGroups/reorder and re-applies only the edited groups each time.
      if (cachedEffBaseFor !== data) {
        const dateInfo = data.date_info || []
        const holidays = holidaySetFromDateInfo(dateInfo)
        cachedEffAxis = _bizAxis(dateInfo, holidays)
        cachedEffBase = reorderByLoco(mergeGroups(data.groups || []))
        cachedEffBaseFor = data
      }
      const axis = cachedEffAxis
      const groups = cachedEffBase.map(g => {
        const ov = overrides[`${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`]
        return ov ? applyOverrideToGroup(g, ov, axis) : g
      })
      self.postMessage({ type: 'effectiveComputed', reqId, data: { ...data, groups } })
    } catch (e) {
      self.postMessage({ type: 'effectiveComputed', reqId, error: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  // ── Move-Mode FROZEN-PREVIEW geometry ─────────────────────────────────────────────────────────
  // Return, per workstation of ONE loco, the ABSOLUTE start pin (occupiable days from its base start)
  // that reproduces the loco's CURRENTLY DISPLAYED position, plus the Protection-Days slack. Computed
  // here — against `cachedData` with the SAME merge/axis/override engine handlePatchLocos renders with —
  // so the pins are measured on the EXACT base the freeze will be drawn on. The old path measured them
  // on the main thread against `effectiveData` (a separately-windowed copy); once a loco had an override
  // the two bases diverged and every pinned station drifted on open. See GanttModal.computeMovedLocoState.
  if (type === 'computeFreezeGeom' && payload) {
    const reqId = payload.reqId
    try {
      const locoKey = String(payload.locoKey || '')
      const override = payload.override || null
      const movedWs = Array.isArray(payload.movedWs) ? payload.movedWs : []
      if (!cachedData) { self.postMessage({ type: 'freezeGeomComputed', reqId, geom: [], pdSlack: null }); return }
      const data = cachedData
      const dateInfo = data.date_info || []
      const holidays = holidaySetFromDateInfo(dateInfo)
      const axis = _bizAxis(dateInfo, holidays)
      const allGroups = (cachedAllGroupsFor === data && cachedAllGroups)
        ? cachedAllGroups
        : (cachedAllGroups = reorderByLoco(mergeGroups(data.groups || [])), cachedAllGroupsFor = data, cachedAllGroups)
      const baseVis = allGroups.find(g => `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}` === locoKey)
      if (!baseVis) { self.postMessage({ type: 'freezeGeomComputed', reqId, geom: [], descGeom: [], pdSlack: null }); return }
      // FILTERS ARE VISUAL ONLY — measure on the UNFILTERED station list. A Workstation/Área filter
      // strips stations out of the rendered group, PROTECTIONDAYS included, and the Protection-Days
      // limit then silently disappeared ("PD stops working when the PD box is not visible"). The pins
      // are keyed by station name, so pinning a station the filter hides costs nothing — the render
      // masks it out again (applyOverrideForRender).
      const baseG = _fullGroupOf(locoKey) || baseVis
      const ov = override && Object.keys(override).length ? override : null
      const savedG = ov ? applyOverrideToGroup(baseG, ov, axis) : baseG
      // The freeze pins are measured base→resolved. A manually-added station has no row in the raw
      // base, so materialize it at its ANCHOR in the base too: its pin then reads anchor→anchor+shift
      // = the shift, identical to a real station (otherwise baseStartOf returns null and the added WS
      // is skipped → no pin → it springs back on drag).
      const baseGInj = (ov && ov.addWs && Object.keys(ov.addWs).length)
        ? _injectAddedWorkstations(baseG, { addWs: ov.addWs }, axis) : baseG
      const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
      const firstIdx = (w) => { let m = Infinity; for (const dr of w.desc_rows) for (const iso in (dr.cells || {})) { const p = axis.pos.get(iso); if (p != null && p < m) m = p } return m === Infinity ? null : m }
      // ── ONE PIN PER STATION, not per workstation ENTRY ────────────────────────────────────────────
      // _buildStations groups CONSECUTIVE entries sharing a `ws` name into a single STATION whose start
      // is the MIN over its members, and applyWsEdits applies wsEdits[ws] (name-keyed) to that whole
      // station. Emitting one pin per ENTRY therefore wrote several pins under the same key and the LAST
      // one won — so a multi-subárea / staggered station was pinned to a row that is not its start and
      // the whole block jumped as soon as a drag began, inflating the recorded shift. Aggregate by name
      // (ignoring subárea, exactly like _buildStations) and pin the MINIMUM.
      const minByName = (group) => {
        const m = new Map()
        for (const w of group.workstations) {
          const nm = String(w.ws ?? '')
          const s = firstIdx(w); if (s == null) continue
          const cur = m.get(nm); if (cur == null || s < cur) m.set(nm, s)
        }
        return m
      }
      const baseStarts = minByName(baseGInj)
      const savedStarts = minByName(savedG)
      // Saturday capability is measured on the BASE, station by station, exactly as applyWsEdits does
      // (see satCapForEdit): a pin measured with a different calendar than the one the re-lay uses would
      // land the station a slot off. Aggregated by NAME because a station is all its same-named entries.
      const usesSatByName = (() => {
        const m = new Map()
        for (const w of baseGInj.workstations) {
          const nm = String(w.ws ?? '')
          if (m.get(nm)) continue
          m.set(nm, _rowsUseSaturday(w.desc_rows, axis))
        }
        return m
      })()
      const satCapOf = (nm, edit) => satCapForEdit(nm, edit, usesSatByName.get(String(nm)) || null)
      const baseFinishOf = (ws) => {
        let m = -Infinity
        for (const w of baseGInj.workstations) {
          if (norm(w.ws) !== norm(ws)) continue
          for (const dr of w.desc_rows) for (const iso in (dr.cells || {})) { const p = axis.pos.get(iso); if (p != null && p > m) m = p }
        }
        return m === -Infinity ? null : m
      }
      // Per-station absolute start pin, in OCCUPIABLE days from base (the unit applyWsEdits' startShiftDays
      // uses). Occupiable stepping honours the station's own satCap so a hand-moved (satManual) row is
      // measured the same way it will be re-placed.
      const geom = []
      const seenWs = new Set()
      for (const w of savedG.workstations) {
        const nm = String(w.ws ?? '')
        if (seenWs.has(nm)) continue
        seenWs.add(nm)
        const s = savedStarts.get(nm)
        if (s == null) {
          // A FULLY-CONSUMED Protection-Days buffer has NO cells in the resolved schedule. Skipping it
          // would leave the freeze with no pin for it, so the pinned (propagate-off) repaint re-derives it
          // WITHOUT the upstream cascade that spent it — and it springs back to full base width: the "PD
          // grows back to its original size after it hit zero" bug. Pin it COLLAPSED instead: a startShift
          // equal to the base buffer's occupiable width steps its start one slot PAST its anchored finish,
          // so applyWsEdits' PD branch (pinnedFinish = base finish, dur = occCount(start, finish)) yields 0.
          if (isProtectionWs(nm)) {
            const bs0 = baseStarts.get(nm)
            const bf0 = baseFinishOf(nm)
            if (bs0 != null && bf0 != null) {
              const satCap0 = satCapOf(nm, null)
              geom.push({ ws: nm, subarea: '', absStart: _occCount(axis, bs0, bf0, satCap0) })
            }
          }
          continue
        }
        const bs = baseStarts.get(nm); if (bs == null) continue
        const edit = ov && ov.ws ? ov.ws[nm] : null
        const satCap = satCapOf(nm, edit)
        geom.push({ ws: nm, subarea: '', absStart: _occSignedDelta(axis, bs, s, satCap) })
      }
      // ── PER-COMPONENTE PINS ───────────────────────────────────────────────────────────────────────
      // The station pins above hold each WORKSTATION put, but they do NOT hold its individual
      // Componente rows: applyWsEdits re-lays every desc_row at stationStart + its BASE offset inside
      // the station. So a Componente the planner had moved WITHIN its workstation snapped back to that
      // base offset the instant any drag began, and its siblings were dragged by whatever the (minimum-
      // row) station pin happened to be — the reported "moving one component repositions the others",
      // "previously applied delays are re-applied" and "editing one workstation affects components in
      // others". Fix: pin every Componente too.
      //
      // A Componente pin is measured against the render the STATION pins alone produce (pinnedG below,
      // = the freeze at delta 0 with desc start shifts stripped, exactly what paintMoveFreeze builds),
      // so `absStart` is precisely the residual that reproduces the CURRENT DISPLAY. Solving for the
      // pin this way — rather than deriving it arithmetically — keeps it exact through pre-start
      // stations, half-day slots, PD collapse and Saturday capability.
      const pinOv = {}
      if (ov && ov.addWs) pinOv.addWs = ov.addWs
      const pinWs = {}
      for (const g of geom) {
        const prev = (ov && ov.ws && ov.ws[g.ws]) ? { ...ov.ws[g.ws] } : {}
        prev.propagate = false
        if (g.absStart) prev.startShiftDays = g.absStart; else delete prev.startShiftDays
        pinWs[g.ws] = prev
      }
      pinOv.ws = pinWs
      if (ov && ov.desc) {
        const d = {}
        for (const k of Object.keys(ov.desc)) { const e = { ...ov.desc[k], propagate: false }; delete e.startShiftDays; d[k] = e }
        pinOv.desc = d
      }
      // Componente identity = ws‖subárea‖desc — the same key applyDescEdits and descEditKeyOf use.
      const compStarts = (group) => {
        const m = new Map()
        for (const w of group.workstations) for (const dr of (w.desc_rows || [])) {
          const key = `${w.ws}||${w.subarea ?? ''}||${dr.desc ?? ''}`
          for (const iso in (dr.cells || {})) {
            const p = axis.pos.get(iso); if (p == null) continue
            const cur = m.get(key); if (cur == null || p < cur) m.set(key, p)
          }
        }
        return m
      }
      const pinnedComp = compStarts(applyOverrideToGroup(baseG, pinOv, axis))
      const savedComp = compStarts(savedG)
      const descGeom = []
      for (const [key, sv] of savedComp) {
        const pv = pinnedComp.get(key)
        if (pv == null || pv === sv) continue          // already reproduced by the station pin
        const bar = key.indexOf('||')
        const wsName = key.slice(0, bar)
        const rest = key.slice(bar + 2)
        const bar2 = rest.indexOf('||')
        const abs = _occSignedDelta(axis, pv, sv, satCapOf(wsName, ov && ov.desc ? ov.desc[key] : null))
        if (abs) descGeom.push({ ws: wsName, subarea: rest.slice(0, bar2), desc: rest.slice(bar2 + 2), absStart: abs })
      }
      // Protection-Days slack = the buffer's REMAINING CAPACITY — how many more occupiable days the
      // cascade can absorb before it overflows the deadline — assigned UNIFORMLY to every pre-PD row.
      //
      // Why uniform, not per-row distance-to-deadline: propagation pushes EVERY station after the moved
      // one (by array order) by the same delta, PD's start included, so moving ANY pre-PD station by D
      // consumes D of the buffer one-for-one — WS10 far upstream spends PD exactly as fast as WS13 sitting
      // against it (verified: WS10 +3 → PD 5→2, +5 → 0). The old finish→deadline distance counted the
      // intervening stations' own work and idle gaps as extra room, so an upstream station reported a much
      // larger limit (WS10 → 14) and could be dragged days PAST the deadline into post-PD work with no
      // warning — the reported "keep moving to the visual end of the PD boxes". The rule the planners want
      // is delay-count == available Protection Days, for ANY workstation, so the limit is the SAME buffer
      // capacity everywhere. Prior consumption is already baked in because it is read off savedG (the
      // current committed schedule): a half-spent buffer leaves half its days.
      //
      //   • deadline  = the fixed base PD finish (never moves as the buffer is spent).
      //   • remainingPD = occupiable width of the buffer STILL PRESENT in savedG (its current start → the
      //     deadline); 0 when fully consumed. Measured in OCCUPIABLE steps, the unit the move deltas use,
      //     so a promoted Saturday or holiday in the buffer cannot shift the limit by a day.
      //   • POST-PD rows are omitted (past the buffer, no limit — boundary by ARRAY ORDER, as applyWsEdits).
      //     A pre-PD Componente shares its station's uniform limit; the host takes the MIN over the current
      //     selection, so growing/shrinking it mid-move re-derives the limit synchronously.
      let pdSlack = null
      let pdSlackByRow = null
      {
        let deadline = null   // fixed base PD finish (the committed deadline; never moves as PD is spent)
        let pdName = null
        for (const w of baseG.workstations) {
          if (!isProtectionWs(w.ws)) continue
          if (pdName === null) pdName = String(w.ws ?? '')
          for (const dr of w.desc_rows) for (const iso in (dr.cells || {})) { const p = axis.pos.get(iso); if (p != null && (deadline === null || p > deadline)) deadline = p }
        }
        if (deadline !== null) {
          let lastPd = -1
          savedG.workstations.forEach((w, i) => { if (isProtectionWs(w.ws)) lastPd = i })
          // Earliest PD cell STILL present after prior consumption (PD is spent from its start, finish
          // anchored), so [curPdStart .. deadline] is exactly the buffer that is left.
          const pdCap = satCapOf(pdName, ov && ov.ws ? ov.ws[pdName] : null)
          let curPdStart = null
          for (const w of savedG.workstations) {
            if (!isProtectionWs(w.ws)) continue
            for (const dr of w.desc_rows) for (const iso in (dr.cells || {})) { const p = axis.pos.get(iso); if (p != null && (curPdStart === null || p < curPdStart)) curPdStart = p }
          }
          const remainingPD = curPdStart === null ? 0 : Math.max(0, _occCount(axis, curPdStart, deadline, pdCap))
          pdSlackByRow = {}
          savedG.workstations.forEach((w, i) => {
            if (i > lastPd || isProtectionWs(w.ws)) return
            const nm = String(w.ws ?? '')
            for (const dr of (w.desc_rows || [])) {
              let has = false; for (const _k in (dr.cells || {})) { has = true; break }
              if (!has) continue
              pdSlackByRow[`${norm(nm)}||${w.subarea ?? ''}||${dr.desc ?? ''}`] = remainingPD
            }
            pdSlackByRow[norm(nm)] = remainingPD
          })
          // Legacy single value = the tightest limit among the rows selected at move start (all equal now).
          if (movedWs.length) {
            for (const w of movedWs) {
              if (!w) continue
              const v = pdSlackByRow[norm(w)]
              if (v != null && (pdSlack === null || v < pdSlack)) pdSlack = v
            }
          }
        }
      }
      self.postMessage({ type: 'freezeGeomComputed', reqId, geom, descGeom, pdSlack, pdSlackByRow })
    } catch (e) {
      self.postMessage({ type: 'freezeGeomComputed', reqId, geom: [], descGeom: [], pdSlack: null, pdSlackByRow: null, error: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  // ── Which working Saturdays does a COMMITTED move land on? ────────────────────────────────────
  // At commit the host knows the shifts it is about to persist but NOT which promoted Saturdays the
  // moved rows occupy — that is a slot-grid placement fact only the worker can answer. It grants the
  // moved stations a TRANSIENT satHand (reproducing the preview landing exactly), applies the override,
  // and reads back the Saturday ISOs each moved row's cells occupy. The host stamps those onto the
  // committed edit as `satDays`, so the box keeps its Saturday through Enter without any station gaining
  // a blanket licence (see satCapForEdit). Empty (the common case: no working Saturday on the axis, or
  // the move never touched one) → nothing to persist.
  if (type === 'computeLandedSaturdays' && payload) {
    const reqId = payload.reqId
    try {
      const locoKey = String(payload.locoKey || '')
      const override = payload.override || null
      const movedWs = Array.isArray(payload.movedWs) ? payload.movedWs.filter(Boolean).map(w => String(w)) : []
      const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
      if (!cachedData || !override || !movedWs.length) { self.postMessage({ type: 'landedSaturdaysComputed', reqId, sat: {} }); return }
      const data = cachedData
      const dateInfo = data.date_info || []
      // Cheap exit: no promoted Saturday anywhere on the business axis → no landing possible.
      if (!dateInfo.some(d => d && d.is_weekend === false && isSaturdayIso(d.iso))) { self.postMessage({ type: 'landedSaturdaysComputed', reqId, sat: {} }); return }
      const axis = _bizAxis(dateInfo, holidaySetFromDateInfo(dateInfo))
      const baseG = _fullGroupOf(locoKey)
      if (!baseG) { self.postMessage({ type: 'landedSaturdaysComputed', reqId, sat: {} }); return }
      const movedSet = new Set(movedWs.map(norm))
      // Reproduce the preview landing: grant the moved stations (and their Componente edits) satHand so
      // the boxes occupy every promoted Saturday in their span, exactly as the drag showed on screen.
      const ov = structuredClone(override)
      if (ov.ws) for (const k of Object.keys(ov.ws)) if (movedSet.has(norm(k))) ov.ws[k] = { ...ov.ws[k], satHand: true }
      if (ov.desc) for (const k of Object.keys(ov.desc)) { if (movedSet.has(norm(String(k).split('||')[0]))) ov.desc[k] = { ...ov.desc[k], satHand: true } }
      const g = applyOverrideToGroup(baseG, ov, axis)
      const sat = {}
      const add = (key, days) => { if (!days || !days.length) return; const cur = sat[key] || (sat[key] = []); for (const iso of days) if (cur.indexOf(iso) < 0) cur.push(iso) }
      for (const w of (g.workstations || [])) {
        const nm = norm(w.ws)
        if (!movedSet.has(nm)) continue
        for (const dr of (w.desc_rows || [])) {
          const days = _rowsUseSaturday([dr], axis)   // the promoted Saturdays this row now occupies
          if (!days) continue
          add(nm, days)                                                       // station-level key
          add(`${nm}||${w.subarea ?? ''}||${dr.desc ?? ''}`, days)            // Componente-level key
        }
      }
      self.postMessage({ type: 'landedSaturdaysComputed', reqId, sat })
    } catch (e) {
      self.postMessage({ type: 'landedSaturdaysComputed', reqId, sat: {}, error: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  if (type !== 'build' || !payload) return
  cancelPending = false // Reset for each new build

  // The worker is now PERSISTENT (reused across builds, not terminated per build).
  // Stamp every outbound message with this build's id so the main thread can drop
  // late messages from a superseded build that were already in flight when a newer
  // build started. `post` replaces every prior `self.postMessage` call in this build.
  const buildId = payload.buildId
  const post = (msg) => self.postMessage({ ...msg, buildId })

  const apiBaseUrl = String(payload.apiBaseUrl || '')
  const token = String(payload.token || '')
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/gantt/data`
  const forceReload = Boolean(payload.forceReload)

  // Use pre-fetched data from the main thread (avoids a redundant network request)
  if (payload.preloadedData && !forceReload) {
    cachedData = payload.preloadedData
  }

  try {
    if (!cachedData || forceReload) {
      // Announce that we're working so the main thread can open the iframe document
      // immediately, while the network fetch is still in flight.
      post({ type: 'start' })
      post({ type: 'progress', progress: 0 })
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        throw new Error(`Falha ao carregar o Gantt (${res.status})`)
      }
      cachedData = await res.json()
    } else {
      // Data already available — open the document immediately so the iframe
      // shows feedback before the synchronous setup work starts.
      post({ type: 'start' })
      post({ type: 'progress', progress: 0 })
    }

    // Yield so the main thread can process 'start' and open the iframe document
    // before we begin the CPU-intensive synchronous preparation below.
    // Announce 2 % first so the bar leaves 0 % before the heavy sync block runs.
    post({ type: 'progress', progress: 0.02 })
    await new Promise(r => setTimeout(r, 0))
    if (cancelPending) return

    const data = cachedData
    const dateInfo = data.date_info || []
    // mergeGroups + reorderByLoco can be 50-200 ms for large datasets — yield after.
    const allGroups = reorderByLoco(mergeGroups(data.groups || []))
    // Memoize for surgical patchLocos re-renders against this same data.
    cachedAllGroups = allGroups
    cachedAllGroupsFor = data
    // UNFILTERED station list (sent only while a Workstation/Área filter is active), indexed by loco
    // key. Every scheduling computation resolves against these so a purely visual filter can never
    // change propagation, delays or the Protection-Days limit — see cachedFullByKey.
    if (payload.fullGroups) {
      cachedFullByKey = new Map()
      for (const g of reorderByLoco(mergeGroups(payload.fullGroups))) cachedFullByKey.set(_locoKeyOfGroup(g), g)
      cachedFullFor = data
    } else {
      cachedFullByKey = null
      cachedFullFor = null
    }

    // merge/reorder done — this is the first big sync phase. Report it so the bar
    // reflects real progress through setup instead of sitting at 0 until 5 %.
    post({ type: 'progress', progress: 0.06 })
    await new Promise(r => setTimeout(r, 0))
    if (cancelPending) return

    const holidays = holidaySetFromDateInfo(dateInfo)
    const fwIndex = buildFwIndex(dateInfo)
    const flatView  = Boolean(payload.flatView)
    const colorByWs = Boolean(payload.colorByWs)
    // "Permitir regras de sobreposição": when the active optimization ran with overlap
    // rules on, a boundary handoff (end of one LOCO == start of another, max 2 LOCOs) on
    // WS40/WS50 is an ALLOWED overlap — not a conflict. Drives the exemption-aware day-
    // header icon and the orange (vs red) border for allowed overlaps. Visualization-only.
    const allowOverlap = Boolean(payload.allowOverlap)
    // Session-only conflict-WS selection (ConflictWsModal) — adopted before classifyConflicts runs.
    _applyConflictWs(payload.conflictWs)
    const wsIndex   = (colorByWs || flatView) ? buildWsIndex(allGroups) : {}

    // ── "Hide before LOCO start" toggle (visualization only) ──────────────────
    // Drop every cell dated BEFORE the LOCO's own start (start_ms, sliced to a
    // YYYY-MM-DD date) from the rendered groups. Conflict detection, displacement,
    // locoMeta and wsIndex all keep using the UNFILTERED `allGroups`, so only what
    // is drawn before the start boundary changes — never the underlying data/logic.
    const hideBeforeStart = Boolean(payload.hideBeforeStart)
    // Apply active visual overrides so a FULL build reflects the SAME edited state as the surgical
    // patchLocos path. Without this, any rebuild (tab switch, reopen) renders base data and the
    // schedule reverts even though the override map is still active. Visual-only: conflicts/wsIndex/
    // locoMeta stay on the BASE groups (mirrors patchLocos, which renders with an empty overlapSet).
    const buildOverrides = payload.overrides || {}
    // Projeção delay-hatch baseline (empty in Padrão/Original): each WS hatches its deviation from the
    // REFERENCE position, not the original schedule, so a loco sitting at the frozen reference hatches 0.
    const buildRefOverrides = payload.referenceOverrides || {}
    const hasBuildOverrides = Object.keys(buildOverrides).length > 0
    const hasRefOverrides = Object.keys(buildRefOverrides).length > 0
    const ovAxis = (hasBuildOverrides || hasRefOverrides) ? _bizAxis(dateInfo, holidays) : null
    // Edit-displacement hatch accumulated while applying overrides (red = later finish, orange = earlier).
    const ovDisp = {}, ovRecov = {}, ovDispHalf = {}, ovRecovHalf = {}
    const effGroups = (hasBuildOverrides || hasRefOverrides)
      ? allGroups.map(g => {
          const key = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
          const ov = buildOverrides[key]
          if (!ov && !buildRefOverrides[key]) return g
          // Display is ALWAYS the current override applied (absolute position); base data when unedited.
          // Resolved on the UNFILTERED station list and masked back to the visible one, so a hidden
          // station still drives its cascade — see applyOverrideForRender.
          const edited = ov ? applyOverrideForRender(g, ov, ovAxis) : g
          // Hatch base = the reference position (Projeção: refOv present) or the original (refOv absent →
          // Padrão/Original keep the exact prior behaviour: computeOverrideHatch(g, edited)), plus any
          // WS40↔WS50 trade so the swap itself deviates by 0 — see _swapRefOverride.
          const refOv = _swapRefOverride(ov, buildRefOverrides[key])
          const hatchBase = refOv ? applyOverrideForRender(g, refOv, ovAxis) : g
          computeOverrideHatch(hatchBase, edited, ovAxis, ovDisp, ovRecov, ovDispHalf, ovRecovHalf)
          // MODELO delay badge: stamp the LOCO's slip vs the hatch reference (0 → no stamp). Cloned so
          // the shared cached `g` is never mutated when the loco is unedited-but-behind-a-reference.
          const delay = _locoDelayDays(hatchBase, edited, ovAxis)
          return delay > 0 ? { ...edited, _delayDays: delay } : edited
        })
      : allGroups

    // ── "Hide columns before today" → also drop LOCOs that are entirely in the past ──
    // A LOCO with no activity today or later has nothing to show once the axis starts at
    // today, so it would render as an empty row. Drop the row outright and the Schedule
    // shows only active and future work.
    //
    // Filtering AFTER the override pass above is what makes this correct: an edit can move
    // a LOCO that ended yesterday into next week (keep it) or push a future LOCO into the
    // past (drop it). Deciding from the base data would get both cases backwards.
    //
    // "Any activity today or later" is evaluated over the LOCO's real cells, so a LOCO that
    // started last week and is still running survives — only its past COLUMNS are hidden
    // (by the axis clamp), never the row. Visual-only: conflicts / wsIndex / locoMeta keep
    // using the unfiltered `allGroups`, exactly like hideBeforeStart.
    const hidePastLocos = Boolean(payload.hidePastLocos)
    const activeGroups = hidePastLocos
      ? (() => {
          const todayIso = localTodayIso()
          return effGroups.filter(g => {
            for (const w of (g.workstations || [])) {
              for (const dr of (w.desc_rows || [])) {
                for (const iso in (dr.cells || {})) if (iso >= todayIso) return true
              }
            }
            return false
          })
        })()
      : effGroups

    const renderGroups = hideBeforeStart
      ? activeGroups.map(g => {
          const startIso = g.start_ms != null ? String(g.start_ms).slice(0, 10) : null
          if (!startIso) return g   // no known start → nothing to hide
          return {
            ...g,
            workstations: g.workstations.map(w => ({
              ...w,
              desc_rows: w.desc_rows.map(dr => {
                const cells = dr.cells || {}
                const kept = {}
                for (const iso in cells) if (iso >= startIso) kept[iso] = cells[iso]
                return { ...dr, cells: kept }
              }),
            })),
          }
        })
      : activeGroups

    // ── Blank-column trim (rides along with "Ocultar LOCOs concluídas") ──────────────
    // Dropping finished LOCOs leaves their past columns with nothing in them. Trim the axis
    // to the span the SURVIVING rows actually occupy, so those empty days disappear.
    //
    // The span — not "today" — is the boundary, and that difference is the whole point: a
    // LOCO that started a month ago and is still running keeps every one of its past
    // columns, because they hold its cells. Only days no visible LOCO touches are removed.
    // Computed from renderGroups, so it also accounts for cells hidden by hideBeforeStart:
    // with both options on, the axis opens exactly at the earliest visible LOCO start.
    //
    // Trimming rather than filtering-out-every-blank-day keeps the calendar continuous —
    // weekends, holidays and internal gaps inside the span still render. And it is applied
    // ONLY to the view axis: `ovAxis` above (the override/business-day math) deliberately
    // stays on the full dateInfo, so hiding something can never change where a LOCO lands.
    // The trim now also fires for "Ocultar antes do início" (hideBeforeStart) on its own, not
    // only alongside "Ocultar LOCOs concluídas" (hidePastLocos): once the pre-start cells are
    // clipped from renderGroups, the leading (and trailing) columns no visible LOCO touches are
    // empty, so they are trimmed away too — the same box+row+column hiding the hide-columns
    // feature already does. Both flags feed the SAME renderGroups-derived [minIso, maxIso] span,
    // so the axis opens exactly at the earliest visible cell whichever combination is active.
    const viewTrimActive = hidePastLocos || hideBeforeStart
    let viewDateInfo = dateInfo
    let viewFwIndex  = fwIndex
    if (viewTrimActive) {
      let minIso = null, maxIso = null
      for (const g of renderGroups) {
        for (const w of (g.workstations || [])) {
          for (const dr of (w.desc_rows || [])) {
            for (const iso in (dr.cells || {})) {
              if (minIso === null || iso < minIso) minIso = iso
              if (maxIso === null || iso > maxIso) maxIso = iso
            }
          }
        }
      }
      if (minIso !== null) {
        const clamped = dateInfo.filter(d => d.iso >= minIso && d.iso <= maxIso)
        // Never blank the grid: if the trim leaves nothing, keep the full axis.
        if (clamped.length) { viewDateInfo = clamped; viewFwIndex = buildFwIndex(clamped) }
      }
    }
    // Record this build's view geometry for surgical patches (see lastViewTrim above): the axis
    // the DOM table will actually show + the surviving row set. Patches compare against this to
    // stay aligned or to request a full rebuild when an edit changes either. The survivor set is
    // the groups that actually emit a tbody — those with ≥1 VISIBLE cell after both filters — so
    // build and patch classify rows identically.
    lastViewTrim = viewTrimActive
      ? {
          for: data,
          hideBeforeStart,
          hidePastLocos,
          firstIso: viewDateInfo.length ? viewDateInfo[0].iso : null,
          lastIso:  viewDateInfo.length ? viewDateInfo[viewDateInfo.length - 1].iso : null,
          survivorKeys: new Set(renderGroups
            .filter(g => (g.workstations || []).some(w => (w.desc_rows || []).some(dr => Object.keys(dr.cells || {}).length > 0)))
            .map(g => `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`)),
        }
      : null

    // Setup complete (holidays/fwIndex/wsIndex/render filtering done) — announce 10 %.
    // The per-row loop below scales into [0.10, 0.92]; the remaining 0.92→1.0 is the
    // iframe parse/load tail, reported by the main thread on the iframe 'load' event.
    post({ type: 'progress', progress: 0.10 })
    // Emit row-loop progress at most ~every 60 ms (time-based) instead of every Nth
    // group, so the bar advances smoothly regardless of group size/count.
    const ROW_LOOP_LO = 0.10, ROW_LOOP_HI = 0.92
    let _lastProgressTs = 0
    const emitRowProgress = (frac) => {
      const now = Date.now()
      if (now - _lastProgressTs < 60 && frac < 1) return
      _lastProgressTs = now
      post({ type: 'progress', progress: ROW_LOOP_LO + (ROW_LOOP_HI - ROW_LOOP_LO) * frac })
    }

    if (flatView) {
      // ── Flat / unified view: one row per LOCO, ops stacked by day ──
      const flatShell   = buildFlatTableShell(viewDateInfo, holidays, viewFwIndex)
      // Render from renderGroups (start-boundary applied); conflictKeys still
      // come from the unfiltered data so detection is unaffected.
      const flatRender = buildFlatViewDataByLoco(renderGroups)
      const locoEntries = flatRender.locoEntries
      const conflictKeys = hideBeforeStart ? buildFlatViewDataByLoco(allGroups).conflictKeys : flatRender.conflictKeys
      const FLAT_CHUNK  = 12
      for (let i = 0; i < locoEntries.length; i++) {
        pushRowsFlatByLoco(flatShell, locoEntries[i], i, colorByWs, wsIndex, conflictKeys)
        if ((i + 1) % FLAT_CHUNK === 0 || i === locoEntries.length - 1) {
          if (flatShell.parts.length > 0) {
            post({ type: 'chunk', html: flatShell.parts.join('') })
            flatShell.parts.length = 0
            // Yield to the worker event loop so pending 'cancel' messages can be processed
            // and the main thread has time to write the chunk before the next one arrives.
            await new Promise(r => setTimeout(r, 0))
            if (cancelPending) return
          }
        }
        emitRowProgress(locoEntries.length ? (i + 1) / locoEntries.length : 1)
      }
      flatShell.parts.push('</tbody></table>')
      post({ type: 'chunk', html: flatShell.parts.join('') })
      post({
        type: 'done',
        pageInfo: {
          dayOffset: 0, dayWindow: viewDateInfo.length, totalDays: viewDateInfo.length, renderedDays: viewDateInfo.length,
          groupOffset: 0, groupWindow: locoEntries.length, totalGroups: locoEntries.length, renderedGroups: locoEntries.length,
        },
      })
    } else {
      // ── Normal view: rows grouped by LOCO ──
      // Classify shared target-WS cells into true conflicts (red) vs allowed overlaps
      // (orange, only when the overlap rule is on), and the day set for the header icon.
      // This O(groups × days) scan used to be a SILENT gap that froze the bar at 10 %.
      // Bracket it with progress (0.11 → 0.14) so the bar keeps moving through it.
      // Detect conflicts on the EDITED groups when manual overrides are active, so the MODELO conflict
      // count and the day-cell outlines reflect where the locos actually are now (not the base import).
      // No overrides → unchanged base/optimization behaviour.
      const { conflictSet, overlapSet, conflictDaySet } = classifyConflicts(hasBuildOverrides ? effGroups : allGroups, allowOverlap)
      // Merge the optimization hatch (from the main thread) with the edit-displacement hatch computed
      // above, so manual edits show the SAME red(later)/orange(earlier) overlay as optimization shifts.
      const displacementSets = _mergeHatchMaps(payload.displacementMap, ovDisp)
      // Half-day (0.5) delay/recovery boundaries from fractional-takt edits. Optimization shifts are
      // whole-day, so these come solely from the override pass — no payload map to merge.
      const displacementHalf = ovDispHalf
      const state = buildTableShell(viewDateInfo, holidays, viewFwIndex, conflictDaySet)
      state.overlapSet = overlapSet
      // Early-finish recovery boxes (req 3): ORANGE trailing placeholders keyed exactly like
      // displacementMap. Read off state by pushRows. Visual only — never a delay/PD/conflict.
      state.recoveredSets = _mergeHatchMaps(payload.recoveredMap, ovRecov)
      state.recoveredHalf = ovRecovHalf
      // MODELO-column indicators (visual only). Opt view = any entry carries an
      // original-conflict count (GanttModal only sets it in optimization mode).
      state.locoMeta = payload.locoMeta || null
      state.isOptView = !!(state.locoMeta && Object.values(state.locoMeta).some(m => m && m.origConflicts !== undefined))
      // Reflect the EDITED state in the MODELO metrics on a full rebuild too, so a tab switch / reopen
      // keeps the PD / Takt / Conflict Count the user saw after editing — not the original import values.
      if (hasBuildOverrides) {
        const editedMap = new Map()
        // MEASURED on the UNFILTERED loco (applyOverrideFull): effGroups are masked for rendering, so
        // a Workstation/Área filter hiding PROTECTIONDAYS would report the loco as having no buffer and
        // blank its PD shield. Same hole as the patch path — filters are visual only.
        const masked = !!(cachedFullByKey && cachedFullFor === data)
        for (let i = 0; i < effGroups.length; i++) {
          const g = effGroups[i]
          const k = `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
          if (!buildOverrides[k]) continue
          // effGroups is a 1:1 map over allGroups, so allGroups[i] is this loco's unedited source.
          editedMap.set(k, masked ? applyOverrideFull(allGroups[i], buildOverrides[k], ovAxis) : g)
        }
        state.locoMeta = _refreshEditedMeta(state.locoMeta, editedMap, conflictSet, state.dateIsoSet)
      }
      // When hiding pre-start content, also suppress displacement placeholders
      // dated before each LOCO's start (pushRows reads this off state).
      state.hideBeforeStart = hideBeforeStart
      // Workstation ↔ Componente expansion state (see pushRows): base XOR exceptions.
      // Sent on every build so rebuilds (filters / Compare / optimization) preserve it.
      state.expandBase = Boolean(payload.expandBase)
      state.expandExc = Array.isArray(payload.expandExceptions) && payload.expandExceptions.length
        ? new Set(payload.expandExceptions) : null
      // LOCO ↔ Workstation tier: missing base (legacy payload) defaults to expanded (tree).
      state.locoExpandBase = payload.locoExpandBase === undefined ? true : Boolean(payload.locoExpandBase)
      state.locoExpandExc = Array.isArray(payload.locoExpandExceptions) && payload.locoExpandExceptions.length
        ? new Set(payload.locoExpandExceptions) : null
      const GROUPS_PER_CHUNK = 6
      let prevLocoKey = ''
      for (let i = 0; i < renderGroups.length; i++) {
        const locoKey = `${renderGroups[i].linha}||${renderGroups[i].wo}||${renderGroups[i].task_name}||${renderGroups[i].start_ms ?? ''}`
        const drawLocoSeparator = i > 0 && locoKey !== prevLocoKey
        pushRows(state, renderGroups[i], i, drawLocoSeparator, colorByWs, wsIndex, conflictSet, displacementSets, displacementHalf)
        prevLocoKey = locoKey
        if ((i + 1) % GROUPS_PER_CHUNK === 0) {
          post({ type: 'chunk', html: state.parts.join('') })
          state.parts.length = 0
          // Yield to allow 'cancel' processing and give the main thread time to write this chunk.
          await new Promise(r => setTimeout(r, 0))
          if (cancelPending) return
        }
        emitRowProgress(renderGroups.length ? (i + 1) / renderGroups.length : 1)
      }
      // Each LOCO already closed its own <tbody> in pushRows; only the table closes here.
      state.parts.push('</table>')
      post({ type: 'chunk', html: state.parts.join('') })
      post({
        type: 'done',
        pageInfo: {
          dayOffset: 0, dayWindow: viewDateInfo.length, totalDays: viewDateInfo.length, renderedDays: viewDateInfo.length,
          groupOffset: 0, groupWindow: allGroups.length, totalGroups: allGroups.length, renderedGroups: allGroups.length,
        },
      })
    }

  } catch (error) {
    cachedData = null
    post({
      type: 'error',
      message: error instanceof Error ? error.message : 'Falha ao montar o Gantt.',
    })
  }
}
