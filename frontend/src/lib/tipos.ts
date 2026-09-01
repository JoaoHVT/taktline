/**
 * tipos.ts — the ONE registry of "Tipo Geral".
 *
 * A Tipo used to be four string literals repeated across fourteen files, a worker and two
 * Python modules, with nothing to catch a site that was missed. Adding a fifth meant finding
 * every one of them by grep and hoping. This module is the single definition; everything else
 * derives from it.
 *
 * ── This demo registers exactly one Tipo ─────────────────────────────────────────────────
 *
 * The source system carried several, split further by an owning business unit. Both are gone:
 * a demo with invented data has no honest way to say what a second Tipo would MEAN, and naming
 * one anyway would be the real taxonomy wearing a generic label — which is worse than not
 * having it, because a reader would take it for a real distinction.
 *
 * The registry itself stays, because it is the mechanism and not the data. It is still the
 * single classifier, `TipoKey` is still a union, and the `Record<TipoKey, …>` maps below still
 * fail to compile if a Tipo is added without covering it.
 *
 * The two flags are what registering a second Tipo would have to answer, so they are kept and
 * still gate the rules structurally rather than by listing Tipos:
 *
 * `scheduleBacked` — the Tipo's hours come from `GanttData.groups`, i.e. from the Schedule.
 * Every scheduling rule in the app is written against that assumption: the cross-Tipo WS
 * overlap exemption, the same-Tipo routing fallback, the WS-ranking strategy for a collapsed
 * LOCO row. A Tipo whose hours come from somewhere else does not merely fail those rules — it
 * has no place in them at all.
 *
 * `hasLoco` — the Tipo has LOCO instances. Resumo Geral's "Locos" row mode, the model groups
 * and the per-LOCO badges are all meaningless without them.
 *
 * The worker (`public/gantt-table-worker.js`) is plain JS loaded by URL and cannot import
 * this, so it keeps its own copy of the SCHEDULE-BACKED Tipos. The backend mirror lives in
 * `backend/services/tipos.py`. All three must agree, or overlap DETECTION and overlap
 * RENDERING disagree about the same two boxes.
 */

/** Every registered Tipo. A union so an incomplete `Record<TipoKey, …>` cannot compile. */
export type TipoKey = 'montagem'

/** A Tipo, or the catch-all for a Linha that matches none of them. `'other'` is NOT a Tipo:
 *  it has no registry entry, it is what an unknown/absent Linha collapses to, and it matches
 *  itself so a Schedule with no Linha column keeps its fallbacks working. */
export type TipoGeral = TipoKey | 'other'

export interface TipoDef {
  key: TipoKey
  label: string
  /** Schedule "Linha" values that classify into this Tipo. */
  linhas: readonly string[]
  scheduleBacked: boolean
  hasLoco: boolean
}

/** Registration order. This is the order the Tipo chips are drawn in everywhere. */
export const TIPOS: readonly TipoDef[] = [
  // Two Linhas, one Tipo: the lines are parallel streams of the same kind of work, which is
  // exactly what a Linha is for. They stay distinct because the per-stream rules read them —
  // a delay on one line does not propagate to the other.
  { key: 'montagem', label: 'Montagem', linhas: ['Linha 1', 'Linha 2'], scheduleBacked: true, hasLoco: true },
]

export const TIPO_KEYS: readonly TipoKey[] = TIPOS.map(t => t.key)

/** Keys of the Tipos whose hours come from the Schedule. This — not `TIPO_KEYS` — is what a
 *  Schedule-side default (the launch screen's initial selection, a filter's "all") should be
 *  built from: selecting a Tipo with no Schedule behind it would ask the Gantt for groups
 *  that do not exist. */
export const SCHEDULE_TIPO_KEYS: readonly TipoKey[] = TIPOS.filter(t => t.scheduleBacked).map(t => t.key)

/** What a FIRST open starts selected on, before the user has expressed a preference. */
export const DEFAULT_TIPO_KEY: TipoKey = 'montagem'

/** True when at least one of the selected Tipos is laid out on the Schedule.
 *
 *  The gate for anything that needs Schedule GROUPS to exist: loading the heavy Schedule
 *  module, opening its tab. A selection of only non-schedule-backed Tipos has no boxes on any
 *  calendar, so those surfaces have nothing to render and must say so rather than open empty.
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
 *  turns a set of selected Tipos into the set of Linhas to keep. */
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
 * direction: an unknown Tipo is not admitted to a scheduling rule by default.
 */
export function isScheduleBacked(tipo: string | undefined | null): boolean {
  return _BY_KEY.get(String(tipo ?? ''))?.scheduleBacked === true
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
