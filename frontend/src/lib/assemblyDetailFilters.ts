import type { AssemblyDetail, AssemblyOperationRow, AssemblyScopeData, ScopeKey } from '@/lib/api'

function normalizeKey(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
}

function isTipoSubsetActive(filterTipo: Set<string>, availableTipos: string[]): boolean {
  if (filterTipo.size === 0) return false
  if (availableTipos.length === 0) return false
  return !availableTipos.every(t => filterTipo.has(normalizeKey(t)))
}

function filterOperations(
  operations: AssemblyOperationRow[],
  applyTipo: boolean,
  filterTipo: Set<string>,
  applyWsn: boolean,
  filterWsn: Set<string>,
): AssemblyOperationRow[] {
  return operations.filter(op => {
    if (applyWsn && !filterWsn.has(op.wsn)) return false
    if (applyTipo) {
      const tipoKey = normalizeKey(op.tipo)
      if (!tipoKey || !filterTipo.has(tipoKey)) return false
    }
    return true
  })
}

function aggregateWsnsFromOperations(ops: AssemblyOperationRow[]) {
  const map = new Map<string, { hours: number; description: string }>()
  for (const op of ops) {
    if (!op.wsn) continue
    const prev = map.get(op.wsn) ?? { hours: 0, description: '' }
    prev.hours += op.hh_total
    if (!prev.description && op.desc) prev.description = op.desc
    map.set(op.wsn, prev)
  }
  return Array.from(map.entries()).map(([wsn, v]) => ({
    wsn,
    hours: v.hours,
    description: v.description,
  }))
}

export function applyAssemblyDetailFilters(
  detail: AssemblyDetail,
  params: {
    filterTipo: Set<string>
    availableTipos: string[]
    filterWsn: Set<string>
  },
): AssemblyDetail | null {
  const { filterTipo, availableTipos, filterWsn } = params
  const applyTipo = isTipoSubsetActive(filterTipo, availableTipos)
  const applyWsn = filterWsn.size > 0

  if (!applyTipo && !applyWsn) return detail

  const filteredScopes: Partial<Record<ScopeKey, AssemblyScopeData>> = {}
  const filteredScopesPresent: ScopeKey[] = []
  let totalHours = 0

  for (const scope of detail.scopes_present) {
    const sd = detail.scopes[scope]
    if (!sd) continue

    const hasOps = Array.isArray(sd.operations) && sd.operations.length > 0

    let nextOps: AssemblyOperationRow[] = sd.operations ?? []
    let nextWsns = sd.wsns ?? []
    let nextTotalH = sd.total_h
    let nextQty = sd.qty

    if (hasOps) {
      const rawFilteredOps = filterOperations(sd.operations, applyTipo, filterTipo, applyWsn, filterWsn)
      const baseOpsTotal = (sd.operations ?? []).reduce((s, op) => s + (op.hh_total ?? 0), 0)
      const currentScopeTotal = Math.max(0, sd.total_h ?? 0)
      const currentScale = baseOpsTotal > 1e-9 ? currentScopeTotal / baseOpsTotal : 0

      // Keep operation distribution, but scaled to current scope total
      // so qty edits (including qty=0) are respected.
      nextOps = rawFilteredOps.map(op => ({
        ...op,
        hh_total: (op.hh_total ?? 0) * currentScale,
      }))
      nextWsns = aggregateWsnsFromOperations(nextOps)
      nextTotalH = nextOps.reduce((s, op) => s + (op.hh_total ?? 0), 0)

      if ((sd.qty ?? 0) <= 0 || currentScopeTotal <= 1e-9) {
        nextOps = rawFilteredOps.map(op => ({ ...op, hh_total: 0 }))
        nextWsns = aggregateWsnsFromOperations(nextOps)
        nextTotalH = 0
      }

      // Derive an equivalent scope qty from the filtered operations themselves,
      // preserving proportional contribution of each tipo instead of taking max(tipo).
      // qty_eq = sum(hh_total_filtered) / sum(hh_unit_filtered)
      if (applyTipo && nextOps.length > 0) {
        let sumUnit = 0
        let sumTotal = 0
        for (const op of nextOps) {
          const hhUnit = Number(op.hh_unit ?? 0)
          if (hhUnit <= 1e-9) continue
          sumUnit += hhUnit
          sumTotal += Number(op.hh_total ?? 0)
        }
        if (sumUnit > 1e-9) {
          nextQty = Math.max(0, sumTotal / sumUnit)
        } else if (nextTotalH <= 1e-9) {
          nextQty = 0
        }
      }
    } else {
      if (applyWsn) {
        nextWsns = nextWsns.filter(w => filterWsn.has(w.wsn))
        nextTotalH = nextWsns.reduce((s, w) => s + w.hours, 0)
      }
      if ((sd.qty ?? 0) <= 0 || (sd.total_h ?? 0) <= 1e-9) {
        nextWsns = nextWsns.map(w => ({ ...w, hours: 0 }))
        nextTotalH = 0
      }
    }

    if (nextTotalH <= 1e-9 && nextWsns.length === 0) continue

    const next: AssemblyScopeData = {
      ...sd,
      qty: nextQty,
      total_h: nextTotalH,
      hours_per_unit: nextQty > 0 ? nextTotalH / nextQty : 0,
      wsns: nextWsns,
      wsn_count: nextWsns.length,
      operations: nextOps,
    }

    filteredScopes[scope] = next
    filteredScopesPresent.push(scope)
    totalHours += nextTotalH
  }

  if (filteredScopesPresent.length === 0) return null

  return {
    ...detail,
    scopes_present: filteredScopesPresent,
    scopes: filteredScopes,
    total_h: totalHours,
  }
}
