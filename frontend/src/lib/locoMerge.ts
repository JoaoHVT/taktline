'use client'
/**
 * "Unir locos duplicadas" — an OPTIONAL consolidation of one physical locomotive that the
 * schedule carries under two Tipos.
 *
 * The problem it solves
 * ────────────────────
 * One serial can be planned twice: `MX1022` under New Locos and `B3#MX1022` under
 * Propulsion. The tag is artificial — added only because the schedule cannot hold two rows
 * of the same name — so the two rows are the same locomotive, and every consolidation that
 * counts locos or splits hours by Tipo reports it as two.
 *
 * What the merge does
 * ───────────────────
 * Contested serials (present under 2+ Tipos) fold into ONE entry under the Tipo with the
 * largest TOTAL hours. The winner is decided from the type totals, NOT per locomotive — the
 * requirement is explicit about it: if New Locos totals more than Propulsion, then EVERY
 * contested loco lands under New Locos, whatever the split on any individual one. Hours,
 * workstations, part numbers and quantities of the losing side come along; the target's own
 * START stays the displayed start.
 *
 * Total hours never change. The merge only moves attribution between Tipos/models, which is
 * why the Área side of a summary needs no transform at all.
 *
 * SCOPE — deliberately narrow. These are pure functions applied at the point of DISPLAY, by
 * the two consolidations that opted in (Resumo Geral and the Carga de Fábrica home tree).
 * `SummaryTestResult` is shared with Plano Externo and Plano de Produção, and `GanttData`
 * feeds the Schedule worker, so nothing here may mutate its input — every object a caller
 * could still be holding is cloned before it is touched. The Schedule, Production Planning
 * and the detailed views therefore keep seeing the unmerged truth.
 */
import type { GanttData } from './api'
import type { LocoRow, ModelGroup, SummaryTestResult } from '@/components/gantt/types'

/** The artificial display tag (`B3#…`) the schedule prepends to disambiguate a serial that
 *  exists under two Tipos. Must stay in step with `_DISPLAY_TAG_RE` in
 *  backend/services/transacted_hours.py and `serialOf` in FactoryLoadHome. */
const DISPLAY_TAG_RE = /^[A-Z0-9]{1,4}#/

/**
 * The SERIAL behind a display name — the identity two Tipos can disagree about.
 *
 * Normalization, in order: upper-case, drop a leading `B3#`-style tag, then drop EVERY
 * non-alphanumeric character. That last step is what makes `B3#MX10-22`, `MX10 22` and
 * `MX1022` one locomotive: the two Tipos are maintained in different sheets and the same
 * serial is punctuated differently in each, so matching on the tag alone left real duplicates
 * unmerged. Only separators are removed — no digits, letters or ordering are touched, so two
 * genuinely different serials cannot collapse into one.
 *
 * This is the MATCHING key only. The surviving row keeps the winner's real `task_name`, because
 * that string is what the Schedule navigation and the `locoOverrides` keys are built from — a
 * cleaned-up display name would break both.
 */
export function locoSerialOf(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(DISPLAY_TAG_RE, '')
    .replace(/[^A-Z0-9]/g, '')
}

// ── The toggle ────────────────────────────────────────────────────────────────
// Session-only, shared by every surface that honours the merge, so the Resumo Geral chip and
// the home-page chip are the same switch rather than two that can disagree. Not persisted:
// the merged view is a way of LOOKING at the data, and a mode that silently survives a reload
// would have the user reading consolidated numbers without having asked for them.

let mergeOn = false
const listeners = new Set<() => void>()

export function getMergeLocoTypes(): boolean {
  return mergeOn
}
export function setMergeLocoTypes(v: boolean): void {
  if (v === mergeOn) return
  mergeOn = v
  listeners.forEach(l => l())
}
export function subscribeMergeLocoTypes(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ── The decision ──────────────────────────────────────────────────────────────

/** Which Tipo each contested serial belongs to after the merge. Serials present under a
 *  single Tipo are absent — nothing about them changes. */
export type MergePlan = Map<string, string>

/**
 * Decide the target Tipo of every contested serial.
 *
 * Type totals come from the SAME entries the caller is about to display, so the winner
 * reflects what is on screen (filters included) rather than a hidden global figure. A tie is
 * broken alphabetically, so the merged view cannot flip between renders.
 */
export function buildMergePlan(entries: { serial: string; tipo: string; hours: number }[]): MergePlan {
  const typeTotals = new Map<string, number>()
  const tiposBySerial = new Map<string, Set<string>>()
  for (const e of entries) {
    if (!e.serial || !e.tipo) continue
    typeTotals.set(e.tipo, (typeTotals.get(e.tipo) ?? 0) + e.hours)
    let s = tiposBySerial.get(e.serial)
    if (!s) { s = new Set(); tiposBySerial.set(e.serial, s) }
    s.add(e.tipo)
  }
  const plan: MergePlan = new Map()
  for (const [serial, tipos] of tiposBySerial) {
    if (tipos.size < 2) continue
    let best = ''
    let bestHours = -1
    for (const t of [...tipos].sort()) {
      const h = typeTotals.get(t) ?? 0
      if (h > bestHours) { bestHours = h; best = t }
    }
    if (best) plan.set(serial, best)
  }
  return plan
}

// ── Resumo Geral: merge an already-aggregated summary ─────────────────────────

function rebuiltGroup(mg: ModelGroup, locos: LocoRow[]): ModelGroup {
  const ym: Record<string, number> = {}
  const fw: Record<string, number> = {}
  for (const l of locos) {
    for (const [k, h] of Object.entries(l.hoursByYearMonth)) ym[k] = (ym[k] ?? 0) + h
    for (const [k, h] of Object.entries(l.hoursByFw)) fw[k] = (fw[k] ?? 0) + h
  }
  return {
    ...mg,
    locos: [...locos].sort((a, b) => a.minISO.localeCompare(b.minISO)),
    fallback: locos.some(l => !!l.fallback),
    totalHours: locos.reduce((s, l) => s + l.hours, 0),
    hoursByYearMonth: ym,
    hoursByFw: fw,
  }
}

/**
 * Fold contested serials in a computed summary into their target Tipo's row.
 *
 * Only `modelGroups` is rewritten — that one list drives the Tipo rows of the hours view, the
 * loco cards, "Resumo por Locos" and the Locos KPI alike. `areas` is left exactly as it was:
 * an area's hours are the same hours whichever Tipo owns the locomotive, so transforming it
 * would be a no-op that only risks disagreeing with the untouched grand total.
 *
 * Returns the input unchanged when no serial is contested, so an unaffected dataset does not
 * pay for a new object graph (and referential equality keeps the consumers' memos warm).
 */
export function mergeSummaryLocoTypes(summary: SummaryTestResult): SummaryTestResult {
  const entries: { serial: string; tipo: string; hours: number }[] = []
  for (const mg of summary.modelGroups)
    for (const l of mg.locos)
      entries.push({ serial: locoSerialOf(l.loco), tipo: l.tipoGeral || 'other', hours: l.hours })
  const plan = buildMergePlan(entries)
  if (plan.size === 0) return summary

  // The row every contested serial folds INTO: within the winning Tipo, the instance carrying
  // the most hours (ties → the earlier start, so the choice is stable).
  const targetRow = new Map<string, LocoRow>()
  for (const mg of summary.modelGroups) {
    for (const l of mg.locos) {
      const serial = locoSerialOf(l.loco)
      if (plan.get(serial) !== (l.tipoGeral || 'other')) continue
      const cur = targetRow.get(serial)
      if (!cur || l.hours > cur.hours || (l.hours === cur.hours && l.minISO < cur.minISO)) targetRow.set(serial, l)
    }
  }

  // Clones the folding writes into. The source rows belong to a cached aggregate that Plano de
  // Produção and Plano Externo still read — mutating one would merge THEIR numbers too.
  const clones = new Map<LocoRow, LocoRow>()
  for (const row of targetRow.values())
    clones.set(row, { ...row, hoursByYearMonth: { ...row.hoursByYearMonth }, hoursByFw: { ...row.hoursByFw } })

  // Pass 1 — decide each group's surviving rows and fold the losers into the clones. Totals
  // cannot be rebuilt yet: a clone can still gain hours from a group processed later.
  const kept: LocoRow[][] = summary.modelGroups.map(mg => {
    const out: LocoRow[] = []
    for (const l of mg.locos) {
      const serial = locoSerialOf(l.loco)
      const target = plan.has(serial) ? targetRow.get(serial) : undefined
      if (!target) { out.push(l); continue }          // serial not contested — untouched
      const clone = clones.get(target)!
      if (target === l) { out.push(clone); continue } // this row IS the target
      clone.hours += l.hours
      for (const [k, h] of Object.entries(l.hoursByYearMonth)) clone.hoursByYearMonth[k] = (clone.hoursByYearMonth[k] ?? 0) + h
      for (const [k, h] of Object.entries(l.hoursByFw)) clone.hoursByFw[k] = (clone.hoursByFw[k] ?? 0) + h
      // Start (minISO/startMs/takt) stays the target's, as specified. Finish extends: the
      // merged locomotive really does carry work until the later of the two.
      if (l.finishMS > clone.finishMS) clone.finishMS = l.finishMS
      clone.fallback = !!clone.fallback || !!l.fallback
    }
    return out
  })

  // Pass 2 — rebuild the model totals from the rows that survived.
  const modelGroups = summary.modelGroups
    .map((mg, i) => ({ mg, locos: kept[i] }))
    .filter(x => x.locos.length > 0)
    .map(x => rebuiltGroup(x.mg, x.locos))
    .sort((a, b) => b.totalHours - a.totalHours)

  const serials = new Set<string>()
  for (const mg of modelGroups) for (const l of mg.locos) serials.add(locoSerialOf(l.loco))

  return {
    ...summary,
    modelGroups,
    locosCount: serials.size,
    modelsCount: new Set(modelGroups.map(mg => mg.model)).size,
  }
}

// ── Carga de Fábrica home tree: merge the raw groups ─────────────────────────

/**
 * Re-badge the losing Tipo's groups so a contested serial builds as ONE locomotive.
 *
 * The home tree keys a locomotive instance by `task_name || start_ms` and reads its Tipo from
 * `linha`, so adopting the winner's `linha` + `wo` + `task_name` + `start_ms` is all it takes:
 * the existing build then accumulates both sides into a single node, under the winner's model,
 * with the winner's start date — no change to the tree code itself.
 *
 * `tipoOf` is injected rather than imported to keep this file free of the filter hook (and of
 * any import cycle through it). `activeBizISOs` restricts the hour count to the loaded/filtered
 * days, matching what the caller is displaying; null counts everything.
 *
 * Groups are shallow-copied — `workstations` is shared by reference, which is safe because
 * nothing here (or downstream of it) writes to that tree.
 */
export function mergeGanttLocoTypes(
  data: GanttData,
  tipoOf: (linha: string) => string,
  activeBizISOs: Set<string> | null,
): GanttData {
  const hoursOf = (g: GanttData['groups'][number]): number => {
    let h = 0
    for (const wst of g.workstations)
      for (const dr of wst.desc_rows)
        for (const [iso, cell] of Object.entries(dr.cells)) {
          if (activeBizISOs && !activeBizISOs.has(iso)) continue
          h += Number(cell.hh || 0)
        }
    return h
  }
  const groupHours = new Map<GanttData['groups'][number], number>()
  const entries: { serial: string; tipo: string; hours: number }[] = []
  for (const g of data.groups) {
    const h = hoursOf(g)
    groupHours.set(g, h)
    entries.push({ serial: locoSerialOf(g.task_name), tipo: tipoOf(g.linha) || 'other', hours: h })
  }
  const plan = buildMergePlan(entries)
  if (plan.size === 0) return data

  // The instance whose identity the merged locomotive adopts: most hours inside the winning
  // Tipo (ties → the earlier start_ms, so the adopted start date is stable).
  type Group = GanttData['groups'][number]
  const winner = new Map<string, { ref: Group; hours: number }>()
  for (const g of data.groups) {
    const serial = locoSerialOf(g.task_name)
    if (plan.get(serial) !== (tipoOf(g.linha) || 'other')) continue
    const h = groupHours.get(g) ?? 0
    const cur = winner.get(serial)
    if (!cur || h > cur.hours || (h === cur.hours && String(g.start_ms ?? '') < String(cur.ref.start_ms ?? ''))) {
      winner.set(serial, { ref: g, hours: h })
    }
  }

  const groups = data.groups.map(g => {
    const serial = locoSerialOf(g.task_name)
    if (!plan.has(serial)) return g
    const w = winner.get(serial)
    // Identity by REFERENCE, not by name: a contested serial can carry the same task_name under
    // two Tipos (the `B3#` tag is not guaranteed), and a name comparison left those unmerged.
    if (!w || w.ref === g) return g
    return { ...g, linha: w.ref.linha, wo: w.ref.wo, task_name: w.ref.task_name, start_ms: w.ref.start_ms }
  })
  return { ...data, groups }
}
