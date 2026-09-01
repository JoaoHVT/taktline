/**
 * Production-plan row model.
 *
 * Extracted from the Plano de Produção grid so the capacity/factory-load view can build the same
 * planning lines without the grid itself: one line per (FW, area, workstation, item, work order,
 * model, loco).
 */
import type { GanttData } from '@/lib/api'
import { locoTypeOf } from '@/lib/ganttUtils'
import type { TipoGeral } from '@/lib/tipos'

export interface PlanoRow {
  fw:          string
  area:        string   // ws.area value → shown in AREA column
  linha:       string   // ws.ws + desc (joined) → internal identity for keys/sorting
  desc:        string   // raw description (ws.subarea/descrição) → identity only; no column shows it
  wsName:      string   // raw workstation name (ws.ws) → shown in LOCAL column + Local filter
  loco:        string   // group.task_name → identifies the LOCO for the deviation details
  item:        string   // part number
  workorder:   string   // LOCO-WORKSTATION & DESCRIÇÃO
  cliente:     string   // MODELO (group.wo)
  hhUnit:      number   // original HH UNIT from Locos Rout — identical on every FW of a PN
  qtd:         number   // units produced in THIS FW (a PN spanning weeks splits its qty)
  hhTotal:     number   // hhUnit * qtd (= sum of daily hh in this FW)
  // ── Straight from the 'Locos Rout' source columns, shown verbatim ─────────────────────
  // PART DESC → DESCRIÇÃO column · ESCOPO → ESCOPO column · LINHA → LINHA column.
  // Nothing is derived here: a blank source value renders as an empty cell, never a fallback.
  partDesc:    string   // PART DESC
  escopo:      string   // ESCOPO
  linhaSrc:    string   // LINHA (the routing sheet's own column, not the loco's Schedule line)
  /** Tipo Geral of the row's source: the Schedule Linha's classification for a Schedule row,
   *  `'gcr'` for a published-plan row (stamped by source — see `tipos.ts`). `'other'` when the
   *  Linha matches no registered Tipo.
   *
   *  Carried on the row because it cannot be recovered downstream: the row keeps the LOCO and
   *  the MODELO, never the Schedule Linha it was classified from. The capacity import reads it
   *  to file each item under the organisation that owns its Tipo. */
  tipo:        TipoGeral
  /** This row came from the published GCR plan, not from the Schedule.
   *
   *  The two sources produce the SAME row shape — that is why they can share this grid — but
   *  they are not comparable in one respect: a Schedule row has a base scenario to deviate
   *  FROM, and a GCR row does not. It is a plan, not a schedule; there is no unedited version
   *  of it to measure against. So the flag exists to keep GCR rows out of the deviation strip,
   *  where they would otherwise read as hours that appeared from nowhere.
   *
   *  Optional: every Schedule-built row leaves it undefined, so nothing about them changes. */
  gcr?:        true
  /** The row's own FISCAL period, carried by GCR rows only.
   *
   *  A Schedule row's period is looked up from `fwToMonth`, derived from the loaded
   *  `date_info` — and a GCR week can fall outside the Schedule's window entirely, or there
   *  may be no Schedule loaded at all. The plan already knows which 4-4-5 month each of its
   *  weeks belongs to, so the row carries it instead of the grid re-deriving it. */
  year?:       number
  month?:      number
}

/**
 * A published GCR plan row in this grid's shape.
 *
 * The field mapping is the plan's own vocabulary, stated by the plan itself. HorasGCR carries
 * BOTH columns and the plan keeps them apart, so this grid does too — the two were crossed here,
 * which put the LOCAL under the LINHA header and the Linha under LOCAL:
 *     área → AREA · LOCAL → LOCAL · Linha → LINHA · item → ITEM
 *
 * `loco` is EMPTY and stays empty — GCR plans parts, and there is no locomotive to name.
 * `displayWorkorder` already renders a blank loco as the bare work order, so the WORKORDER
 * column reads `MRS-GMG192-DATA` rather than a stray leading dash.
 */
function joinWsDesc(ws: string, desc: string, joiner: string): string {
  const w = (ws ?? '').toString()
  const d = (desc ?? '').toString()
  if (!d.trim()) return w
  if (w.trim().toLowerCase() === d.trim().toLowerCase()) return w
  return `${w}${joiner}${d}`
}
// WORKORDER display = LOCO-WORKORDER (e.g. MX104227-WO01). DISPLAY ONLY — the internal `row.workorder`
// value (allocation / grouping / hours keys) is never touched. A blank Work Order stays blank: no
// fallback, and never the locomotive on its own. The concatenation happens only when a real WO exists.
function displayWorkorder(loco: string, workorder: string): string {
  const lo = (loco ?? '').toString().trim()
  const wo = (workorder ?? '').toString().trim()
  if (!wo) return lo
  return lo ? `${lo}-${wo}` : wo
}
// Production-sequence key for a work order: its numeric part (WO01 → 1, WO10 → 10). Lower =
// earlier in the build sequence. Drives BOTH the week allocation (a lower WO must fill an
// earlier-or-equal week — WO04 can never precede WO01) AND the WORKORDER column ordering. Blank
// or unparseable work orders sort last (+∞) but keep their relative order via a stable tiebreak.
function woSeq(workorder: string): number {
  const m = /\d+/.exec((workorder ?? '').toString())
  return m ? parseInt(m[0], 10) : Number.POSITIVE_INFINITY
}

// A single work-order unit within a desc-row: the backend's per-WO breakdown entry, or the
// desc-row itself when it carries just one (possibly blank) work order.
interface WoUnit {
  workorder: string; qtd: number; hh_unit: number; cells: Record<string, { hh: number }>
  part_desc?: string; escopo?: string; rout_linha?: string
}

// ── Row builder ───────────────────────────────────────────────────────────────
// Extracted from the component so the SAME construction can run over the current
// (edited) schedule and over the untouched Base Scenario. The Planning Impact Summary
// compares the two, and it is only trustworthy if both sides are built by identical
// logic — re-implementing a "lighter" base pass is how the two silently drift apart.
// Exported for the SAME reason it was extracted from the component: the Carga de Fábrica
// import adapter must see EXACTLY the rows this grid shows (identical FW apportioning, WO
// granularity and merge keys), and re-implementing a "lighter" pass is how the two silently
// drift apart. Read-only reuse — the grid's own call sites and behaviour are untouched.
export function buildPlanoRows(
  data: GanttData,
  fwOrder: Map<string, number>,
): { all: PlanoRow[]; byArea: Map<string, PlanoRow[]> } {
  // Accumulate into a map keyed by (fw, area, workstation, item, workorder, cliente, LOCO) so
  // duplicate combinations merge. Area is in the key so rows never merge across areas. The
  // WORKORDER is now part of the identity at full granularity: EACH work order is its own
  // planning line (PN123|WO01, PN123|WO02, …) instead of every WO collapsing into one row.
  // MODELO = group.wo  |  LOCO = group.task_name  (matches Schedule Geral columns).
  // LOCO is in the key too: work-order numbers (WO01, …) are REUSED across locomotives of the
  // same model, which share routing (same WS/PN), so without the loco two units would collapse
  // into one row and DOUBLE the quantity (WO01 qty 1 → qty 2). The WORKORDER column is displayed
  // as LOCO-WORKORDER, so each loco's WO is genuinely its own line.
  const merged = new Map<string, PlanoRow>()

  // The loaded period's own edges. A work order whose days reach either of them very likely
  // continues outside the window, where `gantt_builder._filter_records` has already dropped
  // the day records — see the clipped-WO note in the Propulsion block below, which is the only
  // consumer.
  const _isos = data.date_info.map(d => d.iso).filter(Boolean).sort()
  const firstIso = _isos[0] ?? ''
  const lastIso  = _isos[_isos.length - 1] ?? ''
  const touchesWindowEdge = (cells: Record<string, { hh: number }> | undefined): boolean => {
    if (!cells) return false
    for (const iso of Object.keys(cells)) {
      if (iso === firstIso || iso === lastIso) return true
    }
    return false
  }

  for (const group of data.groups) {
    // Type of this locomotive line (Propulsion / New Locos / …). Propulsion gets the
    // whole-work-order allocation below (sequence-preserving, integer, no cross-week split).
    const tipo = locoTypeOf(group.linha)
    const isPropulsion = tipo === 'propulsion'
    for (const ws of group.workstations) {
      const area = ws.area ?? ''      // AREA: the area value for this workstation
      for (const dr of ws.desc_rows) {
        // LINHA: workstation name + description (what was previously WORKSTATION)
        const linha = joinWsDesc(ws.ws, dr.desc ?? '', '-')
        // ITEM: part number. String-coerced: PNs arrive from API JSON and a purely
        // numeric PN would otherwise land here as a number — which used to make the
        // PN search's .toLowerCase() throw and silently break the whole filter pass.
        const item = String(dr.pn ?? '')
        // CLIENTE: MODELO (group.wo) for this specific row
        const cliente = group.wo

        // Expand into one WORK ORDER unit per line. The backend supplies a per-WO breakdown
        // (each WO's own qty/hours/cells) whenever a part number carries several work orders;
        // otherwise the desc-row is a single (possibly blank) work order described by its own
        // fields. EVERY work order is kept — none is dropped — and a blank WORKORDER stays
        // blank: no fallback identifier is synthesized (source data shown exactly as-is).
        const units: WoUnit[] = (dr.wo_breakdown && dr.wo_breakdown.length > 0)
          ? dr.wo_breakdown
          : [{ workorder: dr.workorders?.[0] ?? dr.workorder ?? '', qtd: dr.qtd ?? 0, hh_unit: dr.hh_unit ?? 0, cells: dr.cells }]

        // Order the work orders by PRODUCTION SEQUENCE (WO number ascending) BEFORE allocating.
        // A lower-numbered WO must always be placed in an earlier-or-equal week than a higher one —
        // WO04 can never land in a week before WO01 — so the sequence, not the raw per-day
        // assignment (which an edit can reshuffle), governs which week each WO fills. The stable
        // tiebreak keeps blank / same-number work orders in their original relative order.
        const orderedUnits = units
          .map((u, i) => ({ u, i }))
          .sort((a, b) => (woSeq(a.u.workorder) - woSeq(b.u.workorder)) || (a.i - b.i))
          .map(x => x.u)
        const rowHours = Object.values(dr.cells).reduce((s, c) => s + c.hh, 0)
        const woHours  = orderedUnits.map(u => Object.values(u.cells).reduce((s, c) => s + c.hh, 0))
        const totalWo  = woHours.reduce((s, h) => s + h, 0)

        // A multi-WO row is ALWAYS laid out sequentially along the row's CURRENT cells, in the WO
        // order above: each WO consumes one contiguous slice of the scheduled hours sized by its own
        // source hours, filling the earliest weeks first. A WO whose slice sits inside ONE fiscal
        // week stays WHOLE there; only the single WO whose slice straddles a week boundary is split.
        // This guarantees the sequence (WO01 before WO04), keeps integer quantities, and keeps the
        // per-FW hours reconciled with the live schedule (the slices partition the cells exactly).
        // A single (no-breakdown) WO is mapped straight from its own cells — order is trivial there.
        //
        // ── THE SEQUENCE RUNS OVER WORK ORDERS, NOT OVER UNITS ────────────────────────
        // A unit is a (WORKORDER, ESCOPO) bucket, so ONE work order carrying both "Montagem" and
        // "Peritagem" arrives as TWO units with the SAME workorder. Those two are not a production
        // sequence — they are one work order seen through two scopes, and the backend spreads every
        // source row across the workstation's own days (`hh_dia = hh_total / duracao`), so both
        // scopes run over the same span and must cross a fiscal-week boundary TOGETHER. Slicing per
        // UNIT handed the first scope the early hours and the second the late ones, so exactly ONE
        // of them straddled the boundary and got split while the other landed whole in a single
        // week. Group by work order, lay the GROUPS out sequentially, then share each group's
        // weekly hours among its scopes in proportion to their own hours — a week that splits a
        // work order now splits every scope of it by the same ratio.
        const woGroups: number[][] = []                 // work order → its unit indices, in sequence
        {
          const gix = new Map<string, number>()
          orderedUnits.forEach((u, ui) => {
            const k = u.workorder ?? ''
            let gi = gix.get(k)
            if (gi === undefined) { gi = woGroups.length; gix.set(k, gi); woGroups.push([]) }
            woGroups[gi].push(ui)
          })
        }
        const groupHours = woGroups.map(g => g.reduce((s, ui) => s + woHours[ui], 0))
        const multiWo = orderedUnits.length > 1 && totalWo > 0
        const seqFwHh: Record<number, Record<string, number>> = {}
        if (multiWo) {
          const cells = Object.entries(dr.cells)
            .map(([iso, c]) => ({ iso, fw: data.fw_map[iso], hh: c.hh }))
            .filter((c): c is { iso: string; fw: string; hh: number } => !!c.fw)
            .sort((a, b) => a.iso.localeCompare(b.iso))
          const scale = rowHours / totalWo            // source-hours → current-timeline hours
          let cumSrc = 0
          const bounds = groupHours.map(h => {        // each WO's [start,end) slice on the timeline
            const start = cumSrc * scale
            cumSrc += h
            return { start, end: cumSrc * scale }
          })
          let pos = 0
          const grpFwHh: Record<number, Record<string, number>> = {}
          for (const cell of cells) {
            const cs = pos, ce = pos + cell.hh
            pos = ce
            for (let gi = 0; gi < bounds.length; gi++) {
              const ov = Math.min(ce, bounds[gi].end) - Math.max(cs, bounds[gi].start)
              if (ov > 1e-9) { const m = (grpFwHh[gi] ??= {}); m[cell.fw] = (m[cell.fw] ?? 0) + ov }
            }
          }
          // Split each work order's weekly hours among its scopes. A single-scope work order (the
          // normal case) takes the whole share, so this is a no-op there. With no source hours to
          // weigh by, the scopes divide the slice evenly rather than one of them swallowing it.
          woGroups.forEach((g, gi) => {
            const m = grpFwHh[gi] ?? {}
            const tot = groupHours[gi]
            for (const ui of g) {
              const w = tot > 1e-9 ? woHours[ui] / tot : 1 / g.length
              const out: Record<string, number> = {}
              for (const [fw, hh] of Object.entries(m)) out[fw] = hh * w
              seqFwHh[ui] = out
            }
          })
        }

        // Per-WO hours-by-FW, one map per work order in production-sequence order. A multi-WO
        // row reads from the sequential lay-out above; a single WO reads straight from its cells.
        const unitFwHh: Record<string, number>[] = orderedUnits.map((unit, ui) => {
          if (multiWo) return { ...(seqFwHh[ui] ?? {}) }
          const m: Record<string, number> = {}
          for (const [iso, cell] of Object.entries(unit.cells)) {
            const fw = data.fw_map[iso]
            if (fw) m[fw] = (m[fw] ?? 0) + cell.hh
          }
          return m
        })

        // ── Propulsion: whole work orders, never split across weeks ──────────────────
        // For Type = Propulsion three planning rules override the exact schedule split (small
        // divergences from Schedule/Resumo Geral are accepted, by design):
        //   1) SEQUENCE — a lower-numbered WO never lands in a later week than a higher one;
        //   2) INTEGER  — a WO keeps its whole quantity (no fractional units);
        //   3) NO SPLIT — 100% of a WO goes to ONE week (the one holding most of its hours).
        // Collapse each WO to its majority week (greatest hours ≈ most days), then re-pair the
        // chosen weeks — sorted chronologically — with the WOs in ascending number order. That
        // preserves how many WOs land in each week while guaranteeing the sequence, matching
        // "FW1: WO01,WO02 · FW2: WO03,WO04". Each WO then has a single FW carrying all its hours,
        // so the qty apportionment below yields the whole integer quantity in that one week.
        if (isPropulsion) {
          const chosen = unitFwHh.map((m, ui) => {
            const entries = Object.entries(m)
            if (entries.length === 0) return null
            let best = entries[0]
            for (const e of entries) {
              if (e[1] > best[1] + 1e-9 ||
                  (Math.abs(e[1] - best[1]) < 1e-9 &&
                   (fwOrder.get(e[0]) ?? 1e9) < (fwOrder.get(best[0]) ?? 1e9))) best = e
            }
            const visible = entries.reduce((s, [, h]) => s + h, 0)
            // ── A work order clipped by the loaded period ────────────────────────────────
            // The period filter (`gantt_builder._filter_records`) drops DAYS outside the
            // window, but QTD and HH UNIT ride on every surviving day record, so a WO that
            // straddles the edge keeps its WHOLE quantity while only the days inside the
            // window keep hours. Under rule 2 the qty apportionment below then awards the
            // whole unit against a fraction of its work: the row reads QTDE 1 · HH TOTAL
            // 5,37 against an HH UNIT of 21,50, and the item's total falls short of
            // QTDE × HH UNIT — which is exactly the gap Análise de Capacidade reports,
            // since it prices the QUANTITY through the routing master.
            //
            // Rules 2 and 3 already say a Propulsion WO is ATOMIC — whole quantity, one
            // week — so its hours are its source hours, and a window that cuts the calendar
            // must not cut the work content. Restored only when the WO actually touches the
            // window's edge, so a "Horas totais" override (which legitimately rescales the
            // cells and leaves HH UNIT alone) is never overwritten mid-period.
            const srcHours = (orderedUnits[ui].qtd ?? 0) * (orderedUnits[ui].hh_unit ?? 0)
            const clipped = srcHours > visible + 0.01 && touchesWindowEdge(orderedUnits[ui].cells)
            return { fw: best[0], hours: clipped ? srcHours : visible }
          })
          // ONE SLOT PER WORK ORDER, NOT PER UNIT. Rule 3 says a work order occupies ONE week,
          // and the (WORKORDER, ESCOPO) buckets of a work order ARE that work order — handing each
          // scope its own slot split a single WO across weeks (Montagem in one, Peritagem in the
          // next), breaking the very rule this block exists to enforce. Each group votes for its
          // week with its own hours, and every scope of it then rides that one week.
          const grpFw = woGroups.map(g => {
            const tally: Record<string, number> = {}
            for (const ui of g) { const c = chosen[ui]; if (c) tally[c.fw] = (tally[c.fw] ?? 0) + c.hours }
            const entries = Object.entries(tally)
            if (entries.length === 0) return null
            let best = entries[0]
            for (const e of entries) {
              if (e[1] > best[1] + 1e-9 ||
                  (Math.abs(e[1] - best[1]) < 1e-9 &&
                   (fwOrder.get(e[0]) ?? 1e9) < (fwOrder.get(best[0]) ?? 1e9))) best = e
            }
            return best[0]
          })
          const slots = grpFw
            .filter((f): f is string => f != null)
            .sort((a, b) => (fwOrder.get(a) ?? 1e9) - (fwOrder.get(b) ?? 1e9))
          let si = 0
          woGroups.forEach((g, gi) => {
            const fw = grpFw[gi] != null ? slots[si++] : null
            for (const ui of g) {
              const c = chosen[ui]
              unitFwHh[ui] = (fw && c) ? { [fw]: c.hours } : {}
            }
          })
        }

        // ── Every OTHER type: the same clipped work order, restored in place ─────────────
        // The window cut is not a Propulsion phenomenon — `gantt_builder._filter_records` drops
        // days outside the loaded period for every line. What differs is only WHERE the loss
        // shows: a Propulsion WO collapses to one week (handled above), while any other type
        // keeps whichever weeks survived. QTD and HH UNIT ride on every surviving day record, so
        // the WO keeps its WHOLE quantity against a fraction of its hours, and the row reads e.g.
        // QTDE 1 · HH UNIT 22 · HH TOTAL 5 — the FW53 rows at the tail of the loaded range are
        // the usual case, since that is where the calendar runs out. Análise de Capacidade prices
        // the QUANTITY through the routing master, so that shortfall is exactly the divergence it
        // reports between the two views.
        //
        // A part number's work content is a property of the part, not of the period the user
        // happened to load, so the WO's hours are scaled back up to `qtd × hh_unit`. The surviving
        // weeks keep their PROPORTIONS — nothing is moved into a week the schedule never used, and
        // the quantity apportionment below (a ratio of the same hours) is unchanged by a uniform
        // factor. Gated on the WO actually touching a window edge, for the same reason as above:
        // a "Horas totais" override legitimately rescales the cells while leaving HH UNIT alone,
        // and must not be overwritten mid-period.
        if (!isPropulsion) {
          for (let ui = 0; ui < unitFwHh.length; ui++) {
            const m = unitFwHh[ui]
            const visible = Object.values(m).reduce((s, h) => s + h, 0)
            if (visible <= 0) continue
            const srcHours = (orderedUnits[ui].qtd ?? 0) * (orderedUnits[ui].hh_unit ?? 0)
            if (srcHours <= visible + 0.01) continue
            if (!touchesWindowEdge(orderedUnits[ui].cells)) continue
            const k = srcHours / visible
            for (const fw of Object.keys(m)) m[fw] *= k
          }
        }

        orderedUnits.forEach((unit, ui) => {
          const workorder = unit.workorder ?? ''
          // Pass-through columns: prefer the WORK ORDER's own values (a desc-row spanning several
          // work orders can carry a different ESCOPO on each), falling back to the desc-row's.
          // Blank stays blank at every level — no placeholder is ever synthesized.
          const partDesc = unit.part_desc  ?? dr.part_desc  ?? ''
          const escopo   = unit.escopo     ?? dr.escopo     ?? ''
          const linhaSrc = unit.rout_linha ?? dr.rout_linha ?? ''
          // Original per-unit hours from Locos Rout, carried per work order. Older payloads
          // omit it — the qty fallback below keeps those rendering rather than collapsing.
          const hhUnitSrc = unit.hh_unit ?? 0

          // Hours per FW for this work order (Propulsion: a single majority week; otherwise the
          // sequential lay-out for a multi-WO row, or the single WO's own cells).
          const fwHh = unitFwHh[ui]

          // This work order's TOTAL scheduled hours across all the FWs it touches. The QUANTITY
          // is split across those weeks IN PROPORTION to each week's hours share and normalized
          // so the sum equals the Locos Rout quantity EXACTLY — never more (the old
          // hhTotal/hh_unit formula inflated qty whenever a schedule edit changed the hours, and
          // with hh_unit missing it repeated the full qty in every week), never less. A WO that
          // spans e.g. 3 of 4 working days in FW30 therefore gets ~75% of its qty there and ~25%
          // in FW31, matching the Schedule, instead of dumping everything into the first week.
          const unitQtd = unit.qtd ?? 0
          const unitHhTot = Object.values(fwHh).reduce((s, h) => s + h, 0)

          for (const [fw, hhTotalFw] of Object.entries(fwHh)) {
            // ESCOPO joins the identity so an item that shares one work order across several
            // scopes keeps a line PER SCOPE instead of collapsing into one. When every source row
            // agrees on the scope (the normal case) this is a no-op — the key is unchanged.
            const rowKey = `${fw}||${area}||${linha}||${item}||${workorder}||${cliente}||${group.task_name}||${escopo}`
            // HH UNIT is the source's per-unit hours and is NEVER recomputed here. The weekly
            // hours (hhTotalFw) stay exactly as scheduled; QTDE is the source qty apportioned by
            // this week's hours share, so Σ qtd over the weeks == Locos Rout qty and, in the
            // unedited case, HH TOTAL == HH UNIT × QTDE still holds row-by-row.
            const qtdFw = unitHhTot > 0 ? unitQtd * (hhTotalFw / unitHhTot) : unitQtd
            const existing = merged.get(rowKey)
            if (existing) {
              // Same (fw + area + linha + item + cliente + workorder + loco): accumulate hours
              // and quantity. HH UNIT is a property of the part, so it is carried, not summed.
              existing.hhTotal += hhTotalFw
              existing.qtd    += qtdFw
            } else {
              merged.set(rowKey, { fw, area, linha, desc: dr.desc ?? '', wsName: ws.ws, loco: group.task_name, item, workorder, cliente, hhUnit: hhUnitSrc, qtd: qtdFw, hhTotal: hhTotalFw, partDesc, escopo, linhaSrc, tipo })
            }
          }
        })
      }
    }
  }

  // Drop items with no hours (e.g. qtd 0 → hhTotal 0, or empty FWs): they carry
  // no production and shouldn't appear in the grid.
  const all = [...merged.values()].filter(r => r.hhTotal > 0).sort((a, b) =>
    ((fwOrder.get(a.fw) ?? 999) - (fwOrder.get(b.fw) ?? 999)) ||
    a.area.localeCompare(b.area, 'pt-BR') ||
    a.linha.localeCompare(b.linha, 'pt-BR') ||
    a.loco.localeCompare(b.loco, 'pt-BR') ||
    // WORKORDER column reads in production sequence within each loco (WO01, WO02, …), never WO04
    // before WO01. Numeric-part order first, then the raw string as a stable final tiebreak.
    (woSeq(a.workorder) - woSeq(b.workorder)) ||
    a.workorder.localeCompare(b.workorder, 'pt-BR'),
  )
  // Bucket by area (preserves the sorted order within each bucket).
  const byArea = new Map<string, PlanoRow[]>()
  for (const r of all) {
    const bucket = byArea.get(r.area)
    if (bucket) bucket.push(r)
    else byArea.set(r.area, [r])
  }
  return { all, byArea }
}

// Identity of a piece of WORK, independent of WHEN it is scheduled. The impact summary
// diffs current vs base per this key: `fw` is deliberately excluded — a move changes the
// week, and that shift is exactly what we are measuring. `workorder` is excluded too, so
// the deviation aggregates at the part-number level (all WOs of a PN together), matching
// how the strip has always reported movement.
