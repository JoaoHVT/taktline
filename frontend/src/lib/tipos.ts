/**
 * tipos.ts — the ONE registry of "Tipo Geral".
 *
 * A Tipo used to be four string literals repeated across fourteen files, a worker and two
 * Python modules, with nothing to catch a site that was missed. Adding a fifth meant finding
 * every one of them by grep and hoping. This module is the single definition; everything else
 * derives from it.
 *
 * ── The two flags, and why they are flags and not special cases ──────────────────────────
 *
 * `scheduleBacked` — the Tipo's hours come from `GanttData.groups`, i.e. from the Schedule.
 * Every scheduling rule in the app is written against that assumption: the cross-Type WS
 * overlap exemption, the same-Type routing fallback, the WS-ranking strategy for a collapsed
 * LOCO row. A Tipo whose hours come from somewhere else does not merely fail those rules —
 * it has no place in them at all. So they gate on the FLAG, structurally, rather than listing
 * the Tipos they happen to accept. A non-schedule-backed Tipo is excluded the day it is
 * registered, before anybody remembers to go and exclude it.
 *
 * `hasLoco` — the Tipo has LOCO instances. Resumo Geral's "Locos" row mode, the model groups
 * and the per-LOCO badges are all meaningless without them.
 *
 * ── The compiler net ─────────────────────────────────────────────────────────────────────
 *
 * `TipoKey` is a UNION, not `string`. Presentation maps that must cover every Tipo (labels,
 * colours, images, ordering) are declared `Record<TipoKey, …>`, so registering a new Tipo
 * turns every incomplete map into a build error instead of a blank cell found in production.
 * That is the safety net this file exists to provide — the registry alone would not give it.
 *
 * The worker (`public/gantt-table-worker.js`) is plain JS loaded by URL and cannot import
 * this. It keeps its own copy of the SCHEDULE-BACKED Tipos only, and
 * `tests/worker/tipos-parity.test.js` fails if the two lists drift. The backend mirror lives
 * in `backend/services/tipos.py`.
 */

/** Every registered Tipo. A union so an incomplete `Record<TipoKey, …>` cannot compile. */
export type TipoKey = 'new_locos' | 'overhaul' | 'motor_diesel' | 'propulsion' | 'gcr'

/** A Tipo, or the catch-all for a Linha that matches none of them. `'other'` is NOT a Tipo:
 *  it has no registry entry, it is what an unknown/absent Linha collapses to, and it matches
 *  itself so a Schedule with no Linha column keeps its fallbacks working. */
export type TipoGeral = TipoKey | 'other'

/** The two organisations the plant's work belongs to. Not a Tipo and not a client: it is the
 *  business unit that OWNS the Tipo, which is the axis Análise de Capacidade filters its
 *  "Cliente" list by (its GCM/GCR group buttons). */
export type OrgKey = 'GCM' | 'GCR'

export interface TipoDef {
  key: TipoKey
  label: string
  /** Schedule "Linha" values that classify into this Tipo. EMPTY for a Tipo that is not
   *  derived from a Linha at all — such a Tipo is stamped on a row by its SOURCE, and
   *  `tipoOfLinha` can therefore never return it. */
  linhas: readonly string[]
  scheduleBacked: boolean
  hasLoco: boolean
  /** Which organisation owns this Tipo. Declared per Tipo — rather than being a lookup table
   *  somewhere downstream — so registering a Tipo cannot leave its org unanswered. */
  org: OrgKey
}

/** Registration order. This is the order the Tipo chips are drawn in everywhere. */
export const TIPOS: readonly TipoDef[] = [
  { key: 'new_locos',    label: 'New Locos',    linhas: ['Special Line', 'Main Line'], scheduleBacked: true, hasLoco: true, org: 'GCM' },
  { key: 'overhaul',     label: 'Overhaul',     linhas: ['Overhaul'],                  scheduleBacked: true, hasLoco: true, org: 'GCR' },
  { key: 'motor_diesel', label: 'Motor Diesel', linhas: ['Motor Diesel'],              scheduleBacked: true, hasLoco: true, org: 'GCR' },
  { key: 'propulsion',   label: 'Propulsion',   linhas: ['Propulsion'],                scheduleBacked: true, hasLoco: true, org: 'GCM' },
  // GCR — the first Tipo that is not laid out on the Schedule.
  //
  // Its hours come from the published "Plano de Serviços - GCR" (see lib/gcrPlanStore), which
  // states its own área, workstation and item per fiscal week. There is no Schedule row behind
  // any of it, so:
  //   linhas: []       — a GCR row is stamped by its SOURCE, never classified from a Schedule
  //                      "Linha" column. `tipoOfLinha` therefore can never return 'gcr', which
  //                      is what keeps every Linha-driven code path from meeting it at all.
  //   scheduleBacked   — false. Excludes it STRUCTURALLY from the WS-overlap exemption, the
  //                      same-Type routing fallback and the WS-ranking strategy: those rules
  //                      are statements about boxes on a calendar, and GCR has none.
  //   hasLoco          — false. GCR plans PARTS, not locomotives. Resumo Geral's "Locos" row
  //                      mode, the model groups and every per-LOCO surface are meaningless for
  //                      it and must not offer it an always-empty section.
  //   org              — GCR. The only Tipo whose org is not a classification of a Schedule
  //                      Linha but a property of the plan it comes from.
  { key: 'gcr',          label: 'GCR',          linhas: [],                            scheduleBacked: false, hasLoco: false, org: 'GCR' },
]

/** Tipos with no Schedule, and the reason to show the reader. Drives the warning marker on the
 *  Tipo picker: selecting GCR is legitimate, but the Schedule tab will have nothing for it, and
 *  finding that out after a load is worse than being told before one. */
export const TIPO_NO_SCHEDULE_NOTE: Partial<Record<TipoKey, string>> = {
  gcr: 'GCR não possui schedule',
}

export const TIPO_KEYS: readonly TipoKey[] = TIPOS.map(t => t.key)

/** Keys of the Tipos whose hours come from the Schedule. This — not `TIPO_KEYS` — is what a
 *  Schedule-side default (the launch screen's initial selection, a filter's "all") should be
 *  built from: selecting a Tipo with no Schedule behind it would ask the Gantt for groups
 *  that do not exist. */
export const SCHEDULE_TIPO_KEYS: readonly TipoKey[] = TIPOS.filter(t => t.scheduleBacked).map(t => t.key)

/** What a FIRST open starts selected on, before the user has expressed a preference.
 *
 *  One Tipo, not all of them. Defaulting to every schedule-backed Tipo made the standard open
 *  the most expensive one available — four Tipos laid out, the heavy-load advice already on
 *  screen — for a selection nobody had made. New Locos is the line this app exists for; the
 *  others are one click away. A remembered selection always wins over this. */
export const DEFAULT_TIPO_KEY: TipoKey = 'new_locos'

/** True when at least one of the selected Tipos is laid out on the Schedule.
 *
 *  The gate for anything that needs Schedule GROUPS to exist: loading the heavy Schedule
 *  module, opening its tab, the Build Plan window. A selection of only non-schedule-backed
 *  Tipos (GCR alone) has no boxes on any calendar, so those surfaces have nothing to render
 *  and must say so rather than open empty.
 *
 *  An EMPTY selection answers TRUE: that is "no Tipo filter", the long-standing meaning of an
 *  empty set throughout the filter code, and it must keep behaving exactly as it always has. */
export function anyScheduleBacked(tipos: Iterable<string>): boolean {
  let seen = false
  for (const t of tipos) { seen = true; if (isScheduleBacked(t)) return true }
  return !seen
}

export const TIPO_LABEL: Record<TipoKey, string> =
  TIPOS.reduce((m, t) => { m[t.key] = t.label; return m }, {} as Record<TipoKey, string>)

/** Tipo → the Linhas that classify into it. Consumed by the summary line-type filter, which
 *  turns a set of selected Tipos into the set of Linhas to keep. A Tipo with no Linhas
 *  contributes none, which is correct: its rows are not selected by Linha. */
export const TIPO_LINHAS: Record<TipoKey, readonly string[]> =
  TIPOS.reduce((m, t) => { m[t.key] = t.linhas; return m }, {} as Record<TipoKey, readonly string[]>)

const _BY_LINHA = new Map<string, TipoKey>()
for (const t of TIPOS) for (const l of t.linhas) _BY_LINHA.set(l.trim().toLowerCase(), t.key)

const _BY_KEY = new Map<string, TipoDef>(TIPOS.map(t => [t.key, t]))

/**
 * Classify a Schedule "Linha" into its Tipo. The single classifier — `ganttUtils.locoTypeOf`,
 * `useGanttFilters.getTipoGeral`, the worker's `_locoTypeOf`/`_tipoGeralWorker` and the
 * backend's `_tipo_geral` all have to agree with this, or overlap DETECTION and overlap
 * RENDERING disagree about the same two boxes.
 *
 * Case- and whitespace-insensitive: the Linha reaches us from a spreadsheet column.
 */
export function tipoOfLinha(linha: string | undefined | null): TipoGeral {
  return _BY_LINHA.get(String(linha ?? '').trim().toLowerCase()) ?? 'other'
}

/**
 * True when this Tipo's hours come from the Schedule.
 *
 * `'other'` and any unregistered string answer FALSE. That is deliberate and it is the safe
 * direction: an unknown Tipo is not admitted to a scheduling rule by default. Note this does
 * NOT change existing behaviour for `'other'` — every rule guarded by this flag already
 * excluded `'other'` explicitly.
 */
export function isScheduleBacked(tipo: string | undefined | null): boolean {
  return _BY_KEY.get(String(tipo ?? ''))?.scheduleBacked === true
}

export const TIPO_ORG: Record<TipoKey, OrgKey> =
  TIPOS.reduce((m, t) => { m[t.key] = t.org; return m }, {} as Record<TipoKey, OrgKey>)

/**
 * The organisation that owns this Tipo — `'GCM'` or `'GCR'`.
 *
 * `'other'` and any unregistered value answer `null`, NOT a default org. An unclassified Linha
 * is not evidence of belonging to either unit, and stamping it with one would silently file
 * unknown work under a real organisation's capacity. Callers keep their own source value in
 * that case.
 */
export function orgOfTipo(tipo: string | undefined | null): OrgKey | null {
  return _BY_KEY.get(String(tipo ?? ''))?.org ?? null
}

/** True when this Tipo has LOCO instances. Gates the "Locos" row mode and everything keyed
 *  per-LOCO. Unregistered / `'other'` answer FALSE, same reasoning as above. */
export function tipoHasLoco(tipo: string | undefined | null): boolean {
  return _BY_KEY.get(String(tipo ?? ''))?.hasLoco === true
}

/** Label for display; falls back to the raw key so an unknown value is visible rather than
 *  rendering as an empty chip. */
export function tipoLabel(tipo: string): string {
  return _BY_KEY.get(tipo)?.label ?? tipo
}
