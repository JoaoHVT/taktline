import type { GanttData, GanttDateInfo, GanttGroup } from '@/lib/api'
import { tipoOfLinha, isScheduleBacked } from '@/lib/tipos'

// ── Period/line windowing (SINGLE SOURCE OF TRUTH) ─────────────────────────────
// Window a raw GanttData to the active period (dateRange) + line filter. Pure so it
// is applied identically wherever the dataset is displayed: the GanttModal (active
// and compared scenario) and the Factory Load home page all window through here, so
// their aggregations stay perfectly comparable.
export function windowGanttData(
  raw: GanttData | null,
  dateRange: { from?: string; to?: string } | null,
  lineFilter: string[] | null,
): GanttData | null {
  if (!raw) return null
  const data = raw
  const parseDD = (s?: string) => {
    if (!s) return ''
    const [dd, mm, yyyy] = s.split('/')
    return yyyy && mm && dd ? `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : ''
  }
  const fromISO = parseDD(dateRange?.from)
  const toISO   = parseDD(dateRange?.to)
  // NULL means "no line filter"; an EMPTY ARRAY is a filter that matches nothing, and the two
  // are not the same thing. They used to be: `lineFilter.length > 0` treated [] as "no filter"
  // and returned every group. That is what let a selection of only non-schedule-backed Tipos
  // (GCR alone contributes no Linha, so the list comes out empty) fall through to the WHOLE
  // dataset — every Tipo's rows loaded and windowed for a user who had asked for none of them.
  const lineFilteredGroups = lineFilter
    ? data.groups.filter(g => lineFilter.includes(g.linha))
    : data.groups
  if (!fromISO && !toISO) return lineFilteredGroups === data.groups ? data : { ...data, groups: lineFilteredGroups }
  const filtDates = data.date_info.filter(d => {
    if (fromISO && d.iso < fromISO) return false
    if (toISO   && d.iso > toISO)   return false
    return true
  })
  const activeISOs = new Set(filtDates.map(d => d.iso))
  const filtGroups = lineFilteredGroups.map(g => ({
    ...g,
    workstations: g.workstations.map(wst => ({
      ...wst,
      desc_rows: wst.desc_rows.map(dr => ({
        ...dr,
        cells: Object.fromEntries(Object.entries(dr.cells).filter(([iso]) => activeISOs.has(iso)))
      })).filter(dr => Object.keys(dr.cells).length > 0)
    })).filter(wst => wst.desc_rows.length > 0)
  })).filter(g => g.workstations.length > 0)
  return { ...data, date_info: filtDates, groups: filtGroups }
}

export const RED    = '#D32F2F'
export const RED_DK = '#B71C1C'
export const RED_LT = '#FFEBEE'

export const FW_LIGHT: string[] = [
  '#DCEEFB', '#DDF3D4', '#FCE4D6', '#FFF3C4',
  '#E0D4F5', '#D4F0E8', '#FFF0CB', '#F2DFF8',
]

export const MONTH_NAMES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
export const MONTH_FULL_PT  = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return `${MONTH_NAMES_PT[+m - 1]}/${y.slice(2)}`
}

export function fmt(n: number): string { return n.toLocaleString('pt-BR') }

// ── Workstation label (SINGLE SOURCE OF TRUTH) ──────────────────────────────────
// A workstation's display label is "WS — Subárea", but when the subárea is absent OR
// identical to the WS name we show ONLY the WS name (no "fabrication — fabrication").
// This mirrors the Schedule move-mode label (GanttModal panelView), so every view —
// Schedule, Resumo Geral and the Factory Load main tab — dedups names the same way.
export function wsSubLabel(ws: string | null | undefined, sub: string | null | undefined): string {
  const w = String(ws ?? '').trim()
  const s = String(sub ?? '').trim()
  if (!s || s.toLowerCase() === w.toLowerCase()) return w
  return `${w} — ${s}`
}

// ── Takt validity (SINGLE SOURCE OF TRUTH) ──────────────────────────────────────
// A Takt is displayable ONLY when it resolves to a finite number > 0. Anything else
// — null, undefined, empty string, NaN, Infinity, non-numeric, or ≤ 0 — renders
// nothing. Every Takt display MUST gate on this so the rule is consistent everywhere.
export function validTakt(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── Canonical conflict count (SINGLE SOURCE OF TRUTH) ───────────────────────────
// A WS40/WS50 conflict is a distinct (locoA, locoB, ws) PAIR sharing the same day in
// the same target WS. This is EXACTLY the backend's _detect_conflicts definition —
// what the optimizer minimizes and what every log/result reports. Every UI surface
// (Schedule footer, General Summary header, per-model cards) MUST use this function so
// all counts agree on the same dataset+filters. Do NOT reintroduce per-cell or
// per-LOCO counting in any view — those answer different questions and caused the
// 57/54/52 discrepancy.
// The STANDARD conflict-target workstations. This is the application default that is
// restored on every reload — the session override below never persists.
export const DEFAULT_CONFLICT_WS: ReadonlySet<string> = new Set(['WS40', 'WS50'])

// ── Session-only conflict-workstation override ──────────────────────────────────
// Lets the user experiment with a DIFFERENT set of conflict-target workstations for the
// current session (right-click the Schedule Conflict Count → selection dialog). It is
// deliberately in-memory ONLY: never written to the DB / localStorage, and a full reload
// drops it so the DEFAULT_CONFLICT_WS is restored automatically. `computeConflictCounts`
// (the single source of truth for every count surface) reads `getConflictWs()`, so a
// change instantly re-derives the footer total, the Summary header, and per-model cards.
let _conflictWsOverride: Set<string> | null = null
// Stable snapshot reference so useSyncExternalStore doesn't loop (identity only changes
// when the override actually changes).
let _conflictWsSnapshot: ReadonlySet<string> = DEFAULT_CONFLICT_WS
const _conflictWsListeners = new Set<() => void>()
function _notifyConflictWs() {
  _conflictWsSnapshot = _conflictWsOverride ?? DEFAULT_CONFLICT_WS
  _conflictWsListeners.forEach(l => l())
}
/** Current effective conflict-target WS set (override when active, else the default). */
export function getConflictWs(): ReadonlySet<string> { return _conflictWsSnapshot }
/** True when a session override is active (i.e. not the standard configuration). */
export function isConflictWsOverridden(): boolean { return _conflictWsOverride !== null }
/** Apply a session override (values normalized like every other WS comparison). */
export function setConflictWs(ws: Iterable<string>): void {
  const norm = new Set<string>()
  for (const w of ws) { const n = normWs(w); if (n) norm.add(n) }
  _conflictWsOverride = norm
  _notifyConflictWs()
}
/** Drop the override — restore the standard workstation configuration. */
export function resetConflictWs(): void {
  _conflictWsOverride = null
  _notifyConflictWs()
}
/** Subscribe to override changes (for useSyncExternalStore). */
export function subscribeConflictWs(listener: () => void): () => void {
  _conflictWsListeners.add(listener)
  return () => { _conflictWsListeners.delete(listener) }
}

export function normWs(ws: string | undefined | null): string {
  return String(ws || '').trim().toUpperCase().replace(/\s+/g, '')
}
// Distinct LOCO identity — include linha so two lines sharing wo|task|start_ms are not
// merged (matches the worker's per-LOCO key).
function locoKeyOf(g: GanttGroup): string {
  return `${g.linha}||${g.wo}||${g.task_name}||${g.start_ms ?? ''}`
}

// LOCO line-type classification. Now one line: the registry (`lib/tipos.ts`) owns the
// Linha→Tipo table, and getTipoGeral (useGanttFilters.ts), the worker's _locoTypeOf and the
// backend's _tipo_geral are all views onto the same list — which is the point, because
// overlap DETECTION and overlap RENDERING disagreeing about two boxes is exactly the bug
// this classification being duplicated four times used to produce.
export const locoTypeOf = tipoOfLinha

// Type-pair overlap rule: an exactly-two-LOCO same-day TARGET_WS share is a VALID
// overlap on TYPE alone (regardless of boundary handoff) ONLY for New Locos paired
// with a different non-New-Locos type from the listed set:
//   New Locos × Overhaul, New Locos × Motor Diesel → allowed.
// Everything else (same type incl. New×New, Overhaul×Motor Diesel, any propulsion/other
// pair) is NOT allowed by type and remains subject to the boundary-handoff rule only.
export function isOverlapAllowedPair(t1: string, t2: string): boolean {
  // STRUCTURAL GATE, first and unconditional. This whole rule is about two LOCOs queueing
  // for one physical machine on one day — a claim that only means anything when both Tipos
  // put boxes on the Schedule. A Tipo whose hours come from elsewhere has no boxes and no
  // day to share, so it is excluded by the FLAG rather than by being absent from the pair
  // list below: the exclusion then holds for the next such Tipo without anyone editing this
  // function. Behaviour for the four schedule-backed Tipos is unchanged.
  if (!isScheduleBacked(t1) || !isScheduleBacked(t2)) return false
  // One must be New Locos and the OTHER must be Overhaul or Motor Diesel (different
  // types). Order-independent.
  const other = t1 === 'new_locos' ? t2 : t2 === 'new_locos' ? t1 : null
  return other === 'overhaul' || other === 'motor_diesel'
}

export interface ConflictCounts {
  /** Canonical total = number of distinct (locoA, locoB, ws) conflict pairs. */
  total: number
  /** Pairs attributed per model (g.wo). A cross-model pair is counted under BOTH
   *  models, so Σ(byModel) ≥ total. Use for per-model cards, not for re-deriving total. */
  byModel: Map<string, number>
  /** locoKey → number of pairs that LOCO participates in (per-LOCO badge). */
  byLoco: Map<string, number>
}

/** One conflicting (locoA, locoB, ws) pair — the unit the canonical total counts. */
export interface ConflictPairInfo {
  /** "lkA|lkB|ws" — stable id, deduplicated across the days the pair shares. */
  id:  string
  /** NORMALIZED workstation (normWs), i.e. the key the conflict-WS set is matched on. */
  ws:  string
  /** The workstation exactly as the group spells it — what the Schedule navigation matches
   *  on (`w.ws === ws`, raw). Never use the normalized form to navigate. */
  wsRaw: string
  /** …and its subarea, which the Schedule's row id also carries. '' when the station has none. */
  subarea: string
  /** EARLIEST day the two LOCOs share that workstation as a conflict. */
  iso: string
  /** locoKeys, sorted (a < b). */
  a:   string
  b:   string
}

/** Who a conflict locoKey belongs to — everything the Schedule navigation needs to reach it. */
export interface ConflictLocoMeta {
  key:      string
  linha:    string
  wo:       string
  taskName: string
  startMs:  string
}

/** One LOCO in the conflict list, with the workstations it actually conflicts on. */
export interface ConflictLocoEntry extends ConflictLocoMeta {
  /** Pairs this LOCO participates in — the same number the per-LOCO badge shows. */
  pairs: number
  /** Its conflicting workstations, earliest first. */
  ws: {
    ws:      string
    wsRaw:   string
    subarea: string
    iso:     string
    pairs:   number
    /** The other LOCOs' names on that workstation, for the row's subtitle. */
    partners: string[]
  }[]
}

// Boundary/half-day exemption (mirrors backend _is_boundary_share_day): a shared
// target-WS day between EXACTLY two LOCOs is valid (not a conflict) when it is the
// last day of one LOCO's occupancy on that WS and the first day of the other's.
// `allowOverlap` gates the "Permitir regras de sobreposição" test feature; when off,
// behaviour is identical to before.
//
// THE one implementation of "what is a conflict". `computeConflictCounts` (the footer badge, the
// General Summary header and the per-model cards) and `computeConflictDetails` (the footer's
// conflict list) are both projections of the pair map this returns, so a list row can never
// disagree with the number on the button that opened it.
function _conflictPairs(
  groups: GanttGroup[],
  allowOverlap: boolean,
  conflictWsOverride?: ReadonlySet<string>,
): { pairs: Map<string, ConflictPairInfo>; meta: Map<string, ConflictLocoMeta> } {
  // Effective conflict-target WS set — the session override when active, else the default.
  const conflictWs = conflictWsOverride ?? getConflictWs()
  // day||ws → Map(locoKey → model wo) of LOCOs present on that target-WS cell.
  const cellLocos = new Map<string, Map<string, string>>()
  // lk||ws → { min, max } iso span of that LOCO's occupancy on that target WS.
  const locoWsSpan = new Map<string, { min: string; max: string }>()
  // lk → line type (for the overlap type-pair rule). Same classifier as the backend.
  const locoType = new Map<string, string>()
  // lk → identity, so a caller can navigate to the LOCO behind a conflict.
  const meta = new Map<string, ConflictLocoMeta>()
  // lk||ws||iso → the station AS SPELLED by the group, plus its SUBAREA, on that day.
  //
  // Both halves matter to the caller and neither can be reconstructed from the normalized key:
  // normWs() upper-cases and strips spaces, and the subarea is not in the key at all. The Schedule's
  // row ids are `ws_<linha>_<wo>_<task>_<startMs>_<ws>_<subarea>`, so navigating with the normalized
  // WS or with a blank subarea simply finds no element and scrolls nowhere. Per DAY because one LOCO
  // can hold the same station under two subareas, and the conflict belongs to the one occupying the
  // conflicting day.
  const locoWsAt = new Map<string, { wsRaw: string; subarea: string }>()
  for (const g of groups) {
    const lk = locoKeyOf(g)
    if (!locoType.has(lk)) locoType.set(lk, locoTypeOf(g.linha))
    if (!meta.has(lk)) meta.set(lk, {
      key: lk, linha: g.linha, wo: g.wo, taskName: g.task_name, startMs: String(g.start_ms ?? ''),
    })
    for (const wst of g.workstations) {
      const wn = normWs(wst.ws)
      if (!conflictWs.has(wn)) continue
      for (const dr of wst.desc_rows) {
        for (const iso of Object.keys(dr.cells ?? {})) {
          const k = `${iso}||${wn}`
          let s = cellLocos.get(k)
          if (!s) { s = new Map(); cellLocos.set(k, s) }
          if (!s.has(lk)) s.set(lk, g.wo)
          const ak = `${lk}||${wn}||${iso}`
          if (!locoWsAt.has(ak)) locoWsAt.set(ak, { wsRaw: wst.ws, subarea: wst.subarea ?? '' })
          const sk = `${lk}||${wn}`
          const span = locoWsSpan.get(sk)
          if (!span) locoWsSpan.set(sk, { min: iso, max: iso })
          else { if (iso < span.min) span.min = iso; if (iso > span.max) span.max = iso }
        }
      }
    }
  }
  const isBoundaryShare = (iso: string, lkA: string, lkB: string, ws: string): boolean => {
    const a = locoWsSpan.get(`${lkA}||${ws}`)
    const b = locoWsSpan.get(`${lkB}||${ws}`)
    if (!a || !b) return false
    return (iso === a.max && iso === b.min) || (iso === b.max && iso === a.min)
  }
  const pairs = new Map<string, ConflictPairInfo>()   // "lkA|lkB|ws" — dedups a pair across days
  for (const [k, locos] of cellLocos) {
    if (locos.size < 2) continue
    const [iso, ws] = k.split('||')
    // Exemption applies only when EXACTLY two LOCOs share the day (3+ → conflict).
    const dayExempt = allowOverlap && locos.size === 2
    const arr = [...locos.keys()].sort()
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (dayExempt) {
          // TYPE rule: allowed cross-type pair (New Locos × Overhaul/Motor Diesel) →
          // valid regardless of boundary. BOUNDARY rule (existing): end/start handoff.
          if (isOverlapAllowedPair(locoType.get(arr[i]) ?? 'other', locoType.get(arr[j]) ?? 'other')) continue
          if (isBoundaryShare(iso, arr[i], arr[j], ws)) continue
        }
        const pairId = `${arr[i]}|${arr[j]}|${ws}`
        const prev = pairs.get(pairId)
        // A pair is ONE conflict however many days it spans; keep the EARLIEST of those days — and
        // with it the station/subarea occupying that day, which is where a click is sent.
        if (!prev || iso < prev.iso) {
          // Either participant identifies the same column; A's is taken for determinism (arr is
          // sorted), falling back to B's if A's entry is somehow missing.
          const at = locoWsAt.get(`${arr[i]}||${ws}||${iso}`) ?? locoWsAt.get(`${arr[j]}||${ws}||${iso}`)
          pairs.set(pairId, {
            id: pairId, ws, iso, a: arr[i], b: arr[j],
            wsRaw: at?.wsRaw ?? ws, subarea: at?.subarea ?? '',
          })
        }
      }
    }
  }
  return { pairs, meta }
}

export function computeConflictCounts(
  groups: GanttGroup[],
  allowOverlap = false,
  /** Conflict-target WS set. Defaults to the current session value (override or default);
   *  pass it explicitly from React memos so they recompute when the override changes. */
  conflictWsOverride?: ReadonlySet<string>,
): ConflictCounts {
  const { pairs, meta } = _conflictPairs(groups, allowOverlap, conflictWsOverride)
  const byModel = new Map<string, number>()
  const byLoco = new Map<string, number>()
  for (const p of pairs.values()) {
    // Per-model: attribute the pair to each participant's model, ONCE per model — a same-model
    // pair is one conflict for that model, not two.
    const modelsSeen = new Set<string>()
    for (const lk of [p.a, p.b]) {
      byLoco.set(lk, (byLoco.get(lk) ?? 0) + 1)
      const model = meta.get(lk)?.wo ?? ''
      if (modelsSeen.has(model)) continue
      modelsSeen.add(model)
      byModel.set(model, (byModel.get(model) ?? 0) + 1)
    }
  }
  return { total: pairs.size, byModel, byLoco }
}

/**
 * The same conflicts as `computeConflictCounts`, listed per LOCO instead of counted — what the
 * footer's conflict dropdown shows and navigates from. Σ(entry.pairs) is 2× the canonical total,
 * because every pair has two participants and appears under both.
 *
 * Ordered by the earliest conflicting day (LOCO name as tie-break): the list is read as "what goes
 * wrong first", and a chronological walk down it is a walk left-to-right through the Schedule.
 */
export function computeConflictDetails(
  groups: GanttGroup[],
  allowOverlap = false,
  conflictWsOverride?: ReadonlySet<string>,
): ConflictLocoEntry[] {
  const { pairs, meta } = _conflictPairs(groups, allowOverlap, conflictWsOverride)
  // lk → ws → accumulator
  const byLoco = new Map<string, Map<string, ConflictLocoEntry['ws'][number]>>()
  for (const p of pairs.values()) {
    for (const [lk, other] of [[p.a, p.b], [p.b, p.a]] as const) {
      let wsMap = byLoco.get(lk)
      if (!wsMap) { wsMap = new Map(); byLoco.set(lk, wsMap) }
      let w = wsMap.get(p.ws)
      if (!w) { w = { ws: p.ws, wsRaw: p.wsRaw, subarea: p.subarea, iso: p.iso, pairs: 0, partners: [] }; wsMap.set(p.ws, w) }
      w.pairs++
      // The earliest day wins, and it brings its own station spelling/subarea with it — that is the
      // day the row navigates to.
      if (p.iso < w.iso) { w.iso = p.iso; w.wsRaw = p.wsRaw; w.subarea = p.subarea }
      const name = meta.get(other)?.taskName ?? ''
      if (name && !w.partners.includes(name)) w.partners.push(name)
    }
  }
  const out: ConflictLocoEntry[] = []
  for (const [lk, wsMap] of byLoco) {
    const m = meta.get(lk)
    if (!m) continue
    const ws = [...wsMap.values()].sort((x, y) => x.iso.localeCompare(y.iso) || x.ws.localeCompare(y.ws))
    for (const w of ws) w.partners.sort((x, y) => x.localeCompare(y))
    out.push({ ...m, pairs: ws.reduce((s, w) => s + w.pairs, 0), ws })
  }
  out.sort((a, b) =>
    (a.ws[0]?.iso ?? '9999').localeCompare(b.ws[0]?.iso ?? '9999') || a.taskName.localeCompare(b.taskName))
  return out
}

// ── Easter ────────────────────────────────────────────────────────────────────
function easterDate(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day   = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(y, month - 1, day)
}

function shiftDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

function isoStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

// ── Admin calendar override delta (server-driven) ───────────────────────────────
// The RENDERING paths read holidays per-day from the server (date_info.is_holiday). A
// few self-contained client helpers (e.g. locoOverrides.shiftIsoByBusinessDays) can't
// see date_info, so they call buildHolidaySet() — which reproduces the SAME algorithmic
// base as the backend AND merges this admin override delta, fetched once from
// /api/calendar/exceptions. That keeps every calendar computation on one source of truth.
let _ovHolidays: ReadonlySet<string> = new Set()
let _ovWorking:  ReadonlySet<string> = new Set()

/** Install the admin override delta (called once after login; see api.getCalendarExceptions). */
export function setCalendarExceptions(holidays: Iterable<string>, working: Iterable<string>): void {
  _ovHolidays = new Set(holidays)
  _ovWorking  = new Set(working)
}

export function buildHolidaySet(years: Iterable<number>): Set<string> {
  const s = new Set<string>()
  ;[
    '2027-02-10',
    '2026-10-22',
    '2027-10-28',
    '2028-10-26',
  ].forEach(d => s.add(d))
  for (const y of years) {
    ;[
      `${y}-01-01`, `${y}-04-21`, `${y}-05-01`, `${y}-09-07`,
      `${y}-10-12`, `${y}-11-02`, `${y}-11-15`, `${y}-11-20`,
      `${y}-12-24`, `${y}-12-25`, `${y}-12-31`,
    ].forEach(d2 => s.add(d2))
    const e = easterDate(y)
    s.add(isoStr(shiftDays(e, -48)))
    s.add(isoStr(shiftDays(e, -47)))
    s.add(isoStr(shiftDays(e, -2)))
    s.add(isoStr(shiftDays(e, 60)))
  }
  const toAdd: string[] = []
  for (const iso of s) {
    const d = new Date(iso + 'T12:00:00')
    const dow = d.getDay()
    if (dow === 2) { const mon = new Date(d); mon.setDate(d.getDate() - 1); toAdd.push(isoStr(mon)) }
    if (dow === 4) { const fri = new Date(d); fri.setDate(d.getDate() + 1); toAdd.push(isoStr(fri)) }
  }
  toAdd.forEach(d2 => s.add(d2))
  // Admin overrides win last: add declared company holidays, drop declared working days.
  for (const iso of _ovHolidays) s.add(iso)
  for (const iso of _ovWorking)  s.delete(iso)
  return s
}

export function buildFwIndex(dateInfo: GanttDateInfo[]): Record<string, number> {
  const idx: Record<string, number> = {}
  let seq = 0
  for (const d of dateInfo) {
    if (!(d.fw in idx)) { idx[d.fw] = seq % FW_LIGHT.length; seq++ }
  }
  return idx
}

export function fwToMonth445(fw: string): number {
  const n = parseInt(fw.replace(/\D/g, ''), 10)
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

export function isoFw445MonthKey(iso: string, fw: string): string {
  const year = Number(iso.slice(0, 4))
  return `${year}-${String(fwToMonth445(fw)).padStart(2, '0')}`
}

/**
 * Fiscal quarter of a 4-4-5 month key — "2026-05" → "2026-Q2".
 *
 * A quarter is exactly three consecutive 4-4-5 months, the SAME grouping the Resumo Geral
 * table's Q columns use (`monthNum % 3 === 0` → `Q = ceil(monthNum / 3)`), so the Trimestre
 * date filter and the Q totals can never disagree about which months a quarter contains.
 */
export function monthKeyQuarter(ym: string): string {
  const year = ym.slice(0, 4)
  const month = Number(ym.slice(5, 7)) || 1
  return `${year}-Q${Math.ceil(month / 3)}`
}

/** "2026-Q2" → "Q2 2026" (display form of a quarter key). */
export function quarterLabel(qk: string): string {
  const [year, q] = qk.split('-')
  return `${q} ${year}`
}

/**
 * Today as a LOCAL ISO date (YYYY-MM-DD), matching the local calendar dates in
 * date_info[].iso. NOT toISOString() — that is UTC and would land on the wrong day
 * near midnight in a non-UTC timezone. Mirrors localTodayIso() in gantt-table-worker.js;
 * both must agree or the Today marker and the hide-past clamp would disagree by a day.
 */
export function localTodayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Column widths — must stay in sync with worker constants COL_W_PX / COL_NW_PX
export const GANTT_COL_W    = 5.5 * 16
export const GANTT_COL_NW_W = 2.4 * 16

export function ganttScrollLeft(targetIso: string, dateInfo: GanttDateInfo[], holidays: Set<string>): number {
  let left = 0
  for (const d of dateInfo) {
    if (d.iso === targetIso) return left
    left += (d.is_weekend || holidays.has(d.iso)) ? GANTT_COL_NW_W : GANTT_COL_W
  }
  return 0
}

export function absOffsetTop(el: HTMLElement): number {
  let top = 0
  let cur: HTMLElement | null = el
  while (cur) { top += cur.offsetTop; cur = cur.offsetParent as HTMLElement | null }
  return top
}
