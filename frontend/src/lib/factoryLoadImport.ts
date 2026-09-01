/**
 * factoryLoadImport — "Carga de Fábrica" as an ImportModal data source.
 *
 * ADDITIVE ADAPTER. The Simular menu offers two plan sources that share one modal:
 *
 *   Plano Mensal      → GET /api/excel-items   (monthly_demand rows, server-filtered)
 *   Carga de Fábrica  → THIS module            (the loaded schedule, filtered in-process)
 *
 * Nothing in Plano Mensal, Plano de Produção or the modal's own filtering is reimplemented
 * here. The rows come from `buildPlanoRows` — the very function the Plano de Produção grid
 * renders — so the two views can never disagree about hours, work-order granularity or the
 * per-fiscal-week quantity split. The module's whole job is to reshape those rows into the
 * `ExcelItemsResponse` contract the modal already speaks, so every existing code path in it
 * (month seeding, FW subsets, the stale-response generation counter, loading/error states)
 * keeps working untouched.
 *
 * ── SOURCE PURITY — the one rule this module exists to enforce ───────────────────────────
 * EVERY displayed field comes from the Plano de Produção rows the Gantt tab is showing. The
 * monthly plan (Plano Mensal / monthly_demand) is a DIFFERENT dataset and must never be joined
 * in: it was, and it made schedule-sourced items show a CLIENTE and FAMÍLIA belonging to some
 * unrelated monthly-plan row that merely shared a part number. The ASSEMBLY catalog is still
 * fetched, but ONLY to resolve a part number to its assembly (which is what carries WSN and
 * therefore the operations) — never to supply cliente, família or descrição.
 *
 * ── What maps to what ────────────────────────────────────────────────────────────────────
 *   FW          → pass-through (normalised to digits, the form monthly_demand.fw uses)
 *   ESCOPO      → TIPO FW      (see the note on the vocabularies below)
 *   PART NUMBER → ITEM via ASSEMBLY when mapped, else the part number itself
 *   CLIENTE     → CLIENTE      (the plan's own column, verbatim)
 *   LINHA       → FAMÍLIA      (Plano de Produção's LINHA column IS the family here)
 *   PART DESC   → DESCRIÇÃO    (Plano de Produção's DESCRIÇÃO column)
 *   QTD         → QTDE FW      (summed over the fiscal weeks in range)
 *   HH TOTAL    → hours fallback for a part number with no ASSEMBLY mapping
 *   AREA        → AREA         (verbatim; blank stays blank, the row is still imported)
 *
 * Period: the fiscal WEEK is already on the row; the MONTH is the 4-4-5 month of that week
 * (`fwToMonth445`); the YEAR comes from the loaded período's own calendar (date_info).
 *
 * ── CLIENTE ──────────────────────────────────────────────────────────────────────────────
 * The plan's own CLIENTE column, passed through. It used to be overwritten by the organisation
 * owning the row's Tipo, because the capacity workspace's Cliente filter grouped work by
 * business unit; with a single Tipo there is no such grouping left to impose, and a dropdown
 * listing exactly what the rows carry is what that filter should have offered anyway.
 *
 * ── ESCOPO vs TIPO FW ────────────────────────────────────────────────────────────────────
 * They are the same KIND of value (a process step) but not the same vocabulary. Measured on
 * the live dataset: monthly_demand.tipo_fw holds 6 values (ARMADURA, CARCAÇA, CORTE, MONTAGEM,
 * PERITAGEM, USINAGEM); locos_rout.escopo — what the Plano de Produção ESCOPO column shows —
 * holds 11 (COMPLETO, DESMONTAGEM, LAVAGEM, MONTAGEM, PAINTING, PERITAGEM, PREPARAÇÃO, TEST,
 * USINAGEM, …), overlapping in only 3. Values are therefore passed through as-is rather than
 * being forced into the monthly-plan list: a schedule-sourced import legitimately carries
 * schedule-sourced process steps, and silently dropping the other 8 would hide real work.
 * NOTE: monthly_demand ALSO has its own `escopo` column, which is something else entirely
 * (LEVE / MÉDIO / PESADO / ÚNICO — a severity). It is deliberately not involved here.
 *
 * ── PART NUMBER → ASSEMBLY coverage ──────────────────────────────────────────────────────
 * ASSEMBLY is the join key between the routing and the item master (itens_rout.assembly), but
 * Locos Rout carries only PART NUMBER. Of 1316 distinct part numbers, 41 are themselves
 * assemblies; the rest are components with no unambiguous parent (43 appear as
 * itens_rout.component, and 37 of those fan out to up to 5 assemblies each — no deterministic
 * lookup exists).
 *
 * Unresolvable part numbers are NO LONGER SKIPPED. Dropping them hid real production: the
 * period genuinely schedules that work. They are emitted as items keyed on the part number
 * itself, carrying their Plano de Produção fields and quantity, with NO wsn — which is exactly
 * what "no operations" means downstream (the assembly-details fetch finds nothing and the item
 * contributes 0 routed hours). `hhTotal` from the plan travels with them so the hours are not
 * lost either. They are still counted in `unresolvedPns` so the import tab can say how many
 * arrived without a routing.
 *
 * ── ROUTING COVERAGE ─────────────────────────────────────────────────────────────────────
 * An item whose part number resolves to no ASSEMBLY arrives with no operations and 0 routed
 * hours. That is a REPORTED state, not a hidden one: `coverage` below quantifies it and the
 * import tab shows it. Unrouted items are still imported — the work is real and the catalog is
 * what is incomplete — but they must never be mistakable for work that genuinely takes no
 * hours. When the routing master grows to cover them they resolve on their own, with no change
 * here.
 */
import { getExcelItems } from '@/lib/api'
import { fwToMonth445 } from '@/lib/ganttUtils'
import { buildPlanoRows, type PlanoRow } from '@/lib/planoRows'
import type { GanttData, ImportItem, ImportFilterOptions, ExcelItemsParams, ExcelItemsResponse } from '@/lib/api'

const U = (v: unknown) => String(v ?? '').trim().toUpperCase()

// `normalizeArea` (collapsing "Propulsion - B3" → "B3" so a schedule area could be matched
// against a monthly-plan one) was DELETED with the source-purity fix above. Its only purpose was
// aligning the two datasets for a join that must not happen. The área shown is the schedule's own
// label, verbatim; nothing compares it to the monthly plan any more.

/** FW as bare digits ("FW30", "FW30.0", "30" → "30"), the form monthly_demand.fw stores and
 *  the form ImportModal's own `fmtFw` / numeric FW sort expect. */
function normalizeFw(raw: string | undefined | null): string {
  const m = /(\d+)/.exec(String(raw ?? '').trim())
  return m ? m[1] : ''
}

/** Fiscal-week ordering, taken from the schedule's own calendar: first appearance in
 *  date_info. Mirrors the order the Plano de Produção grid sorts by (summaryData.activeFws),
 *  derived here from the dataset so the adapter needs no summary payload. */
function fwOrderFrom(data: GanttData): Map<string, number> {
  const order = new Map<string, number>()
  for (const d of data.date_info) {
    if (d.fw && !order.has(d.fw)) order.set(d.fw, order.size)
  }
  return order
}

/** FW → { year, month } from the schedule calendar. The month is the 4-4-5 fiscal month
 *  (`fwToMonth445`), NOT the raw calendar month — a fiscal week straddling a month boundary
 *  otherwise lands in the wrong one. This is the same derivation the Plano de Produção date
 *  filters use via `isoFw445MonthKey`. */
function fwCalendar(data: GanttData): Map<string, { ano: number; mes: number }> {
  const cal = new Map<string, { ano: number; mes: number }>()
  for (const d of data.date_info) {
    const fw = normalizeFw(d.fw)
    if (!fw || cal.has(fw)) continue
    const ano = Number(d.iso.slice(0, 4))
    const mes = fwToMonth445(d.fw)
    if (Number.isFinite(ano) && mes >= 1 && mes <= 12) cal.set(fw, { ano, mes })
  }
  return cal
}

// ── The ASSEMBLY catalog ──────────────────────────────────────────────────────────────────
// The plan's item master, fetched once per session. It supplies BOTH the set of valid ASSEMBLY
// codes (so a part number can be recognised as one) and the descriptive metadata the capacity
// workspace needs downstream and the schedule simply does not hold: DESCRIÇÃO, FAMÍLIA,
// CLIENTE, TIPO, WSN, NÍVEL. Without this join the imported items would have no WSN and the
// assembly-details fetch keyed on `item` would find nothing.
// Cached with the SAME 5-minute TTL ImportModal already uses for /api/excel-items responses,
// so a base-data re-import is picked up on its own without anything having to invalidate it.
const CATALOG_TTL = 5 * 60 * 1000
let _catalog: { at: number; p: Promise<Map<string, ImportItem>> } | null = null

async function loadCatalog(): Promise<Map<string, ImportItem>> {
  if (!_catalog || Date.now() - _catalog.at >= CATALOG_TTL) {
    const p = getExcelItems({})
      .then(res => new Map(res.items.map(it => [U(it.item), it])))
      .catch(err => { _catalog = null; throw err })   // failed attempt must not be cached
    _catalog = { at: Date.now(), p }
  }
  return _catalog.p
}

/** One row's fiscal period, from the Schedule calendar.
 *
 *  Rows used to be able to carry their own `year`/`month` — a second source stated the 4-4-5
 *  month of each of its weeks, and the calendar built from the loaded `date_info` had no entry
 *  for a week outside the window. Every row now comes from the Schedule, so the calendar is
 *  the only source, and a fiscal week straddling a month boundary lands exactly where
 *  `fwToMonth445` puts it. */
function rowPeriod(
  row: PlanoRow,
  cal: Map<string, { ano: number; mes: number }>,
): { ano: number; mes: number } | undefined {
  return cal.get(normalizeFw(row.fw))
}

// ── Params → FW predicate ─────────────────────────────────────────────────────────────────
// Mirrors the server-side filter contract of /api/excel-items so ImportModal's existing calls
// narrow this source exactly as they narrow the monthly plan: `fw` is the single required week
// in Semanal mode, `fws` an explicit subset (absent = all), `mes`/`meses` the month selection,
// `ano` the year.
// Returns TWO predicates, and the split matters:
//
//   itemFw   — the full filter; decides which rows become ITEMS.
//   optionFw — the YEAR filter only; decides which rows feed the FILTER DROPDOWNS.
//
// They must not be the same predicate. Deriving the dropdown contents from the rows that
// survived the month/FW filter makes the filter narrow ITSELF: pick month 8 and the Mês list
// collapses to [8], leaving no way back to any other month. /api/excel-items avoids this by
// computing filter_options from an ANO-only query (`all_rows`) that is deliberately separate
// from the item query; this mirrors that split exactly.
type Period = { ano: number; mes: number } | undefined

function makeFwFilters(params: ExcelItemsParams): {
  itemFw: (fw: string, per: Period) => boolean
  optionFw: (fw: string, per: Period) => boolean
} {
  const single = params.fw != null ? normalizeFw(params.fw) : null
  const subset = params.fws && params.fws.length > 0
    ? new Set(params.fws.map(normalizeFw))
    : null
  const meses = params.meses && params.meses.length > 0
    ? new Set(params.meses.map(Number))
    : params.mes != null ? new Set([Number(params.mes)]) : null

  // A fiscal week that can be placed in NO period — neither by the row itself nor by the
  // calendar — cannot satisfy a year or month filter, and fails CLOSED rather than slipping
  // past an active one. `per` is resolved by `rowPeriod`, which is what keeps a fiscal week
  // outside the loaded window placeable at all.
  const optionFw = (fw: string, per: Period) => {
    if (!fw) return false
    if (params.ano == null) return true
    return !!per && per.ano === Number(params.ano)
  }

  const itemFw = (fw: string, per: Period) => {
    if (!optionFw(fw, per)) return false
    if (single != null && fw !== single) return false
    if (subset && !subset.has(fw)) return false
    if (meses && (!per || !meses.has(per.mes))) return false
    return true
  }

  return { itemFw, optionFw }
}

/**
 * Collapse an item's per-(FW, ESCOPO) quantities into the two numbers the capacity workspace
 * needs, which are NOT the same number:
 *
 *   qty     — how many UNITS the item represents. Within one fiscal week the ESCOPOs are
 *             concurrent steps on the same units, so the week contributes the LARGEST of them,
 *             not their sum; distinct weeks are independent batches and do add up. This mirrors
 *             `_aggregate_qty` on the backend (max per FW, summed across FWs), which is how the
 *             monthly plan has always counted the very same thing.
 *   tipoQty — how many units each ESCOPO applies to, summed across weeks. This is what lets the
 *             hours resolve as 5 × HH(peritagem) + 5 × HH(montagem) instead of
 *             10 × (HH(peritagem) + HH(montagem)).
 *
 * A blank ESCOPO still counts toward `qty` (it is real production) but carries no tipo, so it
 * stays out of `tipoQty` — downstream that is exactly "applies to every operation".
 */
function splitQty(byFw: Map<string, Map<string, number>> | undefined): {
  qty: number
  tipoQty: Record<string, number>
} {
  const tipoQty: Record<string, number> = {}
  let qty = 0
  for (const byTipo of byFw?.values() ?? []) {
    let fwMax = 0
    for (const [tipo, q] of byTipo) {
      if (q > fwMax) fwMax = q
      if (tipo) tipoQty[tipo] = (tipoQty[tipo] ?? 0) + q
    }
    qty += fwMax
  }
  for (const t of Object.keys(tipoQty)) tipoQty[t] = Math.round(tipoQty[t] * 100) / 100
  return { qty, tipoQty }
}

// ── Result ────────────────────────────────────────────────────────────────────────────────

/**
 * How much of what is being imported actually carries a routing.
 *
 * Exists because an unrouted item is INDISTINGUISHABLE from a routed one that happens to need
 * no hours: both arrive with operations resolving to nothing and 0 h. Without this the plan
 * areas the catalog does not cover (~2/3 of the plan's hours) would read as work that costs
 * nothing, which is worse than their previous absence — absence is at least visible.
 *
 * Hours are the PLAN's (`hhTotal`), not routed hours: for an unrouted item that is the only
 * figure that exists, and it is the one that says how much is at stake.
 */
export interface FactoryLoadCoverage {
  routedItems: number
  unroutedItems: number
  routedHours: number
  unroutedHours: number
}

export interface FactoryLoadResult extends ExcelItemsResponse {
  /** Routing coverage of THIS result, after the active filters. See FactoryLoadCoverage. */
  coverage: FactoryLoadCoverage
  /** Distinct part numbers that carry production in range but resolve to no ASSEMBLY. They ARE
   *  imported (with their plan hours and no operations) — this list only reports how many. */
  unresolvedPns: string[]
  /** Distinct part numbers that did resolve to an ASSEMBLY (they carry operations). */
  resolvedPns: string[]
  /** The LAUNCH scope of the loaded Carga de Fábrica period, for display in the import tab.
   *  Deliberately the launch scope, NOT the Plano de Produção tab's in-grid Datas/Área
   *  filters: those live in component-local state inside PlanoMensalTab and are not readable
   *  from here. `areas` is derived, since the launch dialog selects LINES, not areas — the
   *  areas are whatever the chosen lines actually work in. */
  scope: {
    /** Every area present in the loaded dataset, verbatim. */
    areas: string[]
    /** Locomotive lines present ("Main Line", "Propulsion", …). */
    linhas: string[]
    /** Fiscal weeks the loaded period spans, and its ISO date bounds. */
    fws: string[]
    from: string
    to: string
  }
}

/** Launch scope of a loaded dataset: what the period covers, independent of any filter the
 *  user then applies inside the modal. Cheap — walks date_info once and the group/WS headers,
 *  never the day cells. */
export function factoryLoadScope(
  data: GanttData | null,
): FactoryLoadResult['scope'] {
  if (!data) return { areas: [], linhas: [], fws: [], from: '', to: '' }
  const areas = new Set<string>()
  const linhas = new Set<string>()
  for (const g of data.groups) {
    if (g.linha) linhas.add(g.linha)
    for (const ws of g.workstations) {
      const a = String(ws.area ?? '').trim()
      if (a) areas.add(a)
    }
  }
  const isos = data.date_info.map(d => d.iso).filter(Boolean).sort()
  const fws = [...new Set(data.date_info.map(d => normalizeFw(d.fw)).filter(Boolean))]
  return {
    areas:  [...areas].sort(),
    linhas: [...linhas].sort(),
    fws:    fws.sort((a, b) => Number(a) - Number(b)),
    from:   isos[0] ?? '',
    to:     isos[isos.length - 1] ?? '',
  }
}

/**
 * Build the ImportModal payload for a schedule dataset.
 *
 * `data` must already be windowed to the active period / line filter (the caller passes what
 * the Gantt is actually showing), so the quantities here match the Plano de Produção grid.
 *
 * A published plan would deliberately NOT be windowed the same way: it is keyed
 * by fiscal week and área, has no calendar dates and belongs to no Linha, so the launch scope
 * has nothing to narrow it BY. The filters in `params` still apply to it — through the row's own
 * fiscal period — which is the narrowing that means something for a plan.
 */
export function buildFactoryLoadItems(
  data: GanttData,
  catalog: Map<string, ImportItem>,
  params: ExcelItemsParams = {},
): FactoryLoadResult {
  const cal = cachedCalendar(data)
  const { all: rows } = cachedRows(data)
  const { itemFw, optionFw } = makeFwFilters(params)

  // One output item per ASSEMBLY, matching /api/excel-items which aggregates by `item`.
  const items = new Map<string, ImportItem>()
  const tipoFwByItem = new Map<string, Set<string>>()
  // key → FW → ESCOPO → qty. Kept split rather than accumulated into one total because an
  // item's ESCOPOs are CONCURRENT process steps on the same units, not additive demand — see
  // `splitQty` below, which is where the two numbers the importer needs come out of it.
  const qtyByItemFwTipo = new Map<string, Map<string, Map<string, number>>>()
  const hoursByItem = new Map<string, number>()
  const resolved = new Set<string>()
  const unresolved = new Set<string>()
  /**
   * Whether each output item has a ROUTING, decided the same way the hours request resolves
   * one: the code exists in the routing master's ASSEMBLY column (`has_routing` off the
   * catalog entry).
   *
   * This used to be read off `it.wsn`, and that was wrong. The catalog comes from
   * /api/excel-items, whose frame is the vertical union of the two normalized uploads: the
   * routing rows carry ASSEMBLY and no period, the plan rows carry ITEM and no WSN. The
   * per-item aggregation there runs after `dropna(subset=[ITEM])`, which drops every routing
   * row — so `wsn` is blank on items that are fully routed, and the tab flagged them "sem
   * roteiro" while the load resolved their operations and hours correctly. WSN stays on the
   * item (it is still the routing handle downstream); it is just not the coverage signal.
   */
  const routedByItem = new Map<string, boolean>()

  // Filter options come from `optionFw` (year only) — NOT from the rows that survived the
  // month/FW filter. See makeFwFilters: deriving them from the surviving rows makes the month
  // dropdown collapse to the single selected month and locks the user out of every other one.
  const anos = new Set<number>()
  const meses = new Set<number>()
  const fws = new Set<string>()
  const familias = new Set<string>()
  const clientes = new Set<string>()
  const mesFwMap: Record<number, string[]> = {}
  const mesFwSets = new Map<number, Set<string>>()

  for (const row of rows) {
    const fw = normalizeFw(row.fw)
    // The row's period, from the Schedule calendar.
    const per = rowPeriod(row, cal)
    if (!optionFw(fw, per)) continue

    const pn = U(row.item)
    if (!pn) continue
    // AREA travels verbatim and a BLANK area is kept. An item whose workstation carries no área
    // (no Item Rout mapping) is still real production and must be listed — with the área cell
    // simply empty. Dropping those rows is what made whole areas/items disappear from the tab.
    const rowArea = String(row.area ?? '').trim()

    // ASSEMBLY resolution decides the ITEM KEY and whether operations exist — nothing else.
    // The catalog is NOT consulted for cliente/família/descrição: those belong to Plano de
    // Produção and joining them across the two datasets is the bug this module now prevents.
    const asm = catalog.get(pn)
    // Does THIS row's part number have a routing? By ASSEMBLY membership in the routing
    // master (`has_routing`), never by WSN — see routedByItem for why.
    const rowRouted = asm ? (asm.has_routing ?? !!asm.wsn) : false

    // ── Filter-dropdown contents: every value reachable in the selected YEAR ──────────
    fws.add(fw)
    if (per) {
      anos.add(per.ano)
      meses.add(per.mes)
      const set = mesFwSets.get(per.mes) ?? new Set<string>()
      set.add(fw)
      mesFwSets.set(per.mes, set)
    }
    // FAMÍLIA is the plan's LINHA column, CLIENTE its own CLIENTE column — the dropdowns list
    // exactly what the rows carry, so filtering can never offer a value from the monthly plan.
    const familia = String(row.linhaSrc ?? '').trim()
    // CLIENTE is the plan's own column. It used to be overridden by the organisation owning
    // the row's Tipo; with a single Tipo there is no such grouping left to impose, and the
    // dropdown listing exactly what the rows carry is the behaviour that was wanted anyway.
    const cliente = String(row.cliente ?? '').trim()
    if (familia) familias.add(familia)
    if (cliente) clientes.add(cliente)

    // ── Items: only the rows the FULL filter keeps ────────────────────────────────────
    if (!itemFw(fw, per)) continue
    if (asm) resolved.add(pn); else unresolved.add(pn)

    // One output item per ASSEMBLY when the part number maps, else per PART NUMBER.
    const key = asm ? U(asm.item) : pn
    if (!items.has(key)) {
      items.set(key, {
        id:        asm ? asm.item : pn,
        item:      asm ? asm.item : pn,
        // Every displayed field below is Plano de Produção's own.
        descricao: row.partDesc ?? '',
        familia,
        cliente,
        area:      rowArea,
        tipo:      String(row.escopo ?? '').trim(),
        // WSN is the routing HANDLE the capacity workspace carries downstream. It is NOT the
        // test for whether a routing exists — see routedByItem below, which is what the
        // coverage report counts.
        wsn:       asm?.wsn ?? '',
        nivel:     asm?.nivel,
        tipo_fw:   [],
        qtde_fw:   0,
        source:    'simular',
      })
    }
    // Routed once ⇒ routed. An assembly reached by several rows only needs ONE of them to
    // have resolved through the catalog for its operations to exist.
    if (!routedByItem.get(key)) routedByItem.set(key, rowRouted)
    const escopo = String(row.escopo ?? '').trim().toUpperCase()
    if (escopo) (tipoFwByItem.get(key) ?? tipoFwByItem.set(key, new Set()).get(key)!).add(escopo)
    // Quantity is accumulated per (FW, ESCOPO) and only collapsed at emit time. Summing it
    // here — which is what this did — counted every process step as its own batch of units:
    // 5 PERITAGEM + 5 MONTAGEM of one part number became 10 whole items, and the hours
    // doubled with them.
    const byFw = qtyByItemFwTipo.get(key) ?? qtyByItemFwTipo.set(key, new Map()).get(key)!
    const byTipo = byFw.get(fw) ?? byFw.set(fw, new Map()).get(fw)!
    byTipo.set(escopo, (byTipo.get(escopo) ?? 0) + (Number.isFinite(row.qtd) ? row.qtd : 0))
    // Plan hours, kept per item so an unmapped part number still carries the work it represents
    // instead of reading as zero everywhere.
    hoursByItem.set(key, (hoursByItem.get(key) ?? 0) + (Number.isFinite(row.hhTotal) ? row.hhTotal : 0))

  }

  const out: ImportItem[] = []
  const coverage: FactoryLoadCoverage = {
    routedItems: 0, unroutedItems: 0, routedHours: 0, unroutedHours: 0,
  }
  for (const [key, it] of items) {
    // QTDE FW is SUMMED across the fiscal weeks in range — a part built over three weeks
    // contributes its whole quantity, and re-narrowing the FW filter re-narrows the sum.
    // (The monthly-plan endpoint keeps a single row's value instead; there, one item/FW pair
    // is one row, so there is nothing to add up.) WITHIN a week the ESCOPOs do not add up:
    // see `splitQty`.
    const { qty, tipoQty } = splitQty(qtyByItemFwTipo.get(key))
    const hh = hoursByItem.get(key) ?? 0
    // Routing existence by ASSEMBLY — the key the hours request resolves by. See routedByItem.
    const routed = routedByItem.get(key) ?? false
    if (routed) { coverage.routedItems++;   coverage.routedHours   += hh }
    else        { coverage.unroutedItems++; coverage.unroutedHours += hh }
    out.push({
      ...it,
      tipo_fw: [...(tipoFwByItem.get(key) ?? [])].sort(),
      qtde_fw: Math.round(qty * 100) / 100,
      // The per-ESCOPO breakdown of that quantity, travelling with the item so the hours
      // request can scale each operation type by its own demand.
      tipoQty,
      has_qty_fw: qty > 0,
      planHours: Math.round(hh * 100) / 100,
      hasRouting: routed,
      // Marks the hours pipeline: these quantities are the schedule's, so the capacity tab must
      // resolve operations/hours from them rather than from monthly-plan rows that do not exist
      // for this item. Without it the item lands with a routing but no operations and 0 h.
      origin: 'factoryLoad',
    })
  }
  out.sort((a, b) => a.item.localeCompare(b.item))

  for (const [mes, set] of mesFwSets) {
    mesFwMap[mes] = [...set].sort((a, b) => Number(a) - Number(b))
  }

  const filter_options: ImportFilterOptions = {
    anos:     [...anos].sort((a, b) => b - a),
    meses:    [...meses].sort((a, b) => a - b),
    fws:      [...fws].sort((a, b) => Number(a) - Number(b)),
    familias: [...familias].sort(),
    clientes: [...clientes].sort(),
  }

  return {
    status: 'ok',
    message: '',
    filters: {
      ano: params.ano ?? null,
      mes: params.mes ?? null,
      fw:  params.fw != null ? normalizeFw(params.fw) : null,
      mode: params.mode ?? 'mensal',
    },
    filter_options,
    mes_fw_map: mesFwMap,
    items: out,
    unresolvedPns: [...unresolved].sort(),
    resolvedPns: [...resolved].sort(),
    coverage,
    scope: factoryLoadScope(data),
  }
}

// ── Per-dataset memoisation ───────────────────────────────────────────────────────────────
// `buildPlanoRows` walks every group × workstation × desc-row × work-order × day, so it must
// not re-run on each filter change. Keyed by dataset IDENTITY (the windowed GanttData object),
// which is exactly how the Plano de Produção grid memoises its own call.
let _rowsKey: GanttData | null = null
let _rowsVal: ReturnType<typeof buildPlanoRows> | null = null
function cachedRows(data: GanttData) {
  if (!_rowsVal || _rowsKey !== data) {
    _rowsVal = buildPlanoRows(data, fwOrderFrom(data))
    _rowsKey = data
  }
  return _rowsVal
}

let _calKey: GanttData | null = null
let _calVal: Map<string, { ano: number; mes: number }> | null = null
function cachedCalendar(data: GanttData) {
  if (_calKey !== data || !_calVal) {
    _calKey = data
    _calVal = fwCalendar(data)
  }
  return _calVal
}

/**
 * The loader ImportModal calls in place of `/api/excel-items`.
 *
 * Same signature and same response contract, so the modal's fetch lifecycle is unchanged:
 * it is awaited inside the existing `load()`, its failures land in the existing error state,
 * and the existing generation counter still discards stale responses.
 */
export function makeFactoryLoadLoader(
  data: GanttData | null,
) {
  return async (params: ExcelItemsParams): Promise<FactoryLoadResult> => {
    if (!data) throw new Error('Nenhum período carregado na Carga de Fábrica.')
    const catalog = await loadCatalog()
    return buildFactoryLoadItems(data, catalog, params)
  }
}
