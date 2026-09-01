/**
 * ImportModal — "Simular demanda do plano mensal"
 *
 * Equivalent to open_alert_flow() in the original desktop tool.
 * Filter bar order: Mensal/Semanal | Ano | Mês | FW | Cliente | Família | Pesquisar
 * Table columns: Área | Cliente | Família | ITEM | DESCRIÇÃO
 */
'use client'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { X, RefreshCw, CheckSquare, Square, ChevronDown, Play, Calendar, CalendarDays, CalendarRange, AlertTriangle, Search, ArrowUpDown } from 'lucide-react'
import { getExcelItems } from '@/lib/api'
import { ProgressBar } from '@/components/ProgressBar'
import type { ImportMeta } from '@/context/WorkspaceContext'
import type { ImportItem, ImportFilterOptions, ExcelItemsParams, ExcelItemsResponse } from '@/lib/api'
import type { FactoryLoadCoverage, FactoryLoadResult } from '@/lib/factoryLoadImport'

// ── Helpers ────────────────────────────────────────────────────────────────────

const MES_LABELS: Record<number, string> = {
  1: 'Janeiro', 2: 'Fevereiro', 3: 'Março',    4: 'Abril',
  5: 'Maio',    6: 'Junho',     7: 'Julho',    8: 'Agosto',
  9: 'Setembro', 10: 'Outubro', 11: 'Novembro', 12: 'Dezembro',
}

/**
 * Blank bucket for the Área / Cliente / Família filters.
 *
 * An item can legitimately carry an EMPTY value in any of those three: a part number with no
 * Item Rout mapping has no área, and one outside the item master has no família/cliente. Every
 * filter here is seeded with "all options" and then tested with `selected.has(it.x)`, so a blank
 * value matched nothing and the row silently disappeared from the table — the row was imported
 * and then hidden one layer later. Blanks get their own explicit option instead: visible by
 * default like any other value, and still deselectable if the user wants only mapped rows.
 */
const BLANK_OPT = '(vazias)'
/** Filter key of a field: its trimmed value, or the blank bucket. */
const fkey = (v: unknown) => String(v ?? '').trim() || BLANK_OPT
/** Sorted distinct values of `pick` over `list`, with the blank bucket appended last if present. */
function optsWithBlank(list: ImportItem[], pick: (it: ImportItem) => unknown): string[] {
  const named = new Set<string>()
  let blank = false
  for (const it of list) {
    const v = String(pick(it) ?? '').trim()
    if (v) named.add(v); else blank = true
  }
  const out = [...named].sort()
  return blank ? [...out, BLANK_OPT] : out
}

/** Server-supplied filter_options plus the blank bucket for whichever of cliente/família the
 *  items actually leave empty. The options list and the "all selected" seed must agree, or the
 *  `selected.size === options.x.length` comparisons driving the cascade handlers misfire. */
function augmentOpts(opts: ImportFilterOptions, list: ImportItem[]): ImportFilterOptions {
  const hasBlank = (pick: (it: ImportItem) => unknown) =>
    list.some(it => !String(pick(it) ?? '').trim())
  return {
    ...opts,
    clientes: hasBlank(it => it.cliente) ? [...opts.clientes, BLANK_OPT] : opts.clientes,
    familias: hasBlank(it => it.familia) ? [...opts.familias, BLANK_OPT] : opts.familias,
  }
}

/** Normalise FW value → "FW14" format — handles "14", "14.0", "FW14", "FW14.0" */
function fmtFw(raw: string): string {
  const m = raw.trim().match(/(\d+)/)
  if (m) return `FW${m[1]}`
  return raw.trim()
}

// ── Multi-select checkbox dropdown ────────────────────────────────────────────

interface MultiSelectProps {
  label:       string
  options:     string[]
  selected:    Set<string>
  onChange:    (next: Set<string>) => void
  placeholder?: string
  fmt?:        (v: string) => string
  disabled?:   boolean
}

function MultiSelect({ label, options, selected, onChange, placeholder, fmt, disabled }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const allSelected = options.length > 0 && options.every(o => selected.has(o))
  const display = fmt ?? ((v: string) => v)
  const summary = allSelected
    ? (placeholder ?? 'Todos')
    : selected.size === 0
      ? 'Nenhum'
      : selected.size === 1
        ? display([...selected][0])
        : `${selected.size} selecionados`

  const toggle = (opt: string) => {
    const next = new Set(selected)
    if (next.has(opt)) next.delete(opt)
    else               next.add(opt)
    onChange(next)
  }

  const toggleAll = () => onChange(allSelected ? new Set() : new Set(options))

  return (
    <div className="relative" ref={ref}>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</label>
        <button
          type="button"
          onClick={() => !disabled && setOpen(v => !v)}
          disabled={disabled}
          className={`border rounded px-2 py-1 text-xs bg-white flex items-center gap-1 min-w-[130px] text-left transition-colors ${disabled ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60' : 'border-gray-300 text-black hover:bg-gray-50'}`}
        >
          <span className="flex-1 truncate">{summary}</span>
          <ChevronDown size={12} className="text-gray-400 shrink-0" />
        </button>
      </div>

      {open && options.length > 0 && (
        <div className="absolute top-full mt-0.5 z-30 bg-white border border-gray-300 rounded shadow-lg min-w-[170px] max-h-52 overflow-y-auto">
          <div
            className="px-2 py-1.5 border-b border-gray-200 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-xs font-medium text-black"
            onClick={toggleAll}
          >
            {allSelected
              ? <CheckSquare size={12} className="text-red-600 shrink-0" />
              : <Square      size={12} className="text-gray-400 shrink-0" />}
            {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
          </div>
          {options.map(opt => (
            <div
              key={opt}
              className="px-2 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 text-xs text-black"
              onClick={() => toggle(opt)}
            >
              {selected.has(opt)
                ? <CheckSquare size={12} className="text-red-600 shrink-0" />
                : <Square      size={12} className="text-gray-400 shrink-0" />}
              {display(opt)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Module-level cache for Excel items API responses ──────────────────────────
type ImportCacheVal = {
  items:          ImportItem[]
  filter_options: ImportFilterOptions
  mes_fw_map:     Record<number, string[]>
  ts:             number
}
const _importCache = new Map<string, ImportCacheVal>()
const IMPORT_CACHE_TTL = 5 * 60 * 1000  // 5 minutes

function _cacheKey(params: ExcelItemsParams): string {
  return JSON.stringify({
    m:   params.mode   ?? null,
    a:   params.ano    ?? null,
    ms:  params.mes    ?? null,
    mss: params.meses  ?? null,
    fw:  params.fw     ?? null,
    fws: params.fws    ?? null,
  })
}

async function cachedGetExcelItems(params: ExcelItemsParams) {
  const key    = _cacheKey(params)
  const cached = _importCache.get(key)
  if (cached && Date.now() - cached.ts < IMPORT_CACHE_TTL) {
    return { ...cached, status: 'ok', message: '', filters: { ano: null, mes: null, fw: null, mode: params.mode ?? 'mensal' } }
  }
  const res = await getExcelItems(params)
  _importCache.set(key, {
    items:          res.items,
    filter_options: res.filter_options,
    mes_fw_map:     res.mes_fw_map ?? {},
    ts:             Date.now(),
  })
  return res
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  onImport: (items: ImportItem[], meta: ImportMeta) => void
  onClose:  () => void
  /** Data source driving the modal. 'planoMensal' (default) fetches monthly-plan items on
   *  mount. 'factoryLoad' reuses the exact same UI, fed by `sourceLoader` instead of the
   *  monthly-plan endpoint; with no loader supplied it stays inactive (no fetch, empty
   *  table/filters, empty-state messaging) exactly as before. */
  source?: 'planoMensal' | 'factoryLoad'
  /** Replaces the /api/excel-items call with a caller-supplied producer of the SAME response
   *  shape (see lib/factoryLoadImport). It is awaited inside the normal `load()`, so month
   *  seeding, FW subsets, the stale-response guard and the loading/error states all behave
   *  identically no matter which source is active. Omit for the monthly plan. */
  sourceLoader?: (params: ExcelItemsParams) => Promise<ExcelItemsResponse>
  /** Scope of the injected source, shown as a read-only strip so the user can see WHICH areas
   *  and period the listed items come from. Omit for the monthly plan (which has no such
   *  scope — it is queried per filter, not loaded as a period). */
  sourceScope?: { areas: string[]; linhas: string[]; from: string; to: string } | null
}

/** The coverage block a Carga de Fábrica response carries. Read off the response rather than
 *  passed as a prop: it describes THE RESULT (it moves with every filter change), so it has to
 *  travel with the result. Absent on a monthly-plan response, which has no routing gap to
 *  report — every one of its items came from the catalog in the first place. */
const coverageOf = (res: ExcelItemsResponse): FactoryLoadCoverage | null =>
  (res as Partial<FactoryLoadResult>).coverage ?? null

const nHours = (v: number) => Math.round(v).toLocaleString('pt-BR')

/** dd/mm — enough to read a period at a glance without widening the title bar. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}/${m[2]}` : iso
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImportModal({ onImport, onClose, source = 'planoMensal', sourceLoader, sourceScope }: Props) {
  const isFactoryLoad = source === 'factoryLoad'
  // Single fetch seam: the injected source when one is given, the monthly-plan endpoint
  // otherwise. Every call site below goes through here, so neither branch can drift.
  const fetchItems = useCallback(
    (params: ExcelItemsParams) => sourceLoader ? sourceLoader(params) : cachedGetExcelItems(params),
    [sourceLoader],
  )
  // ── Filter state ───────────────────────────────────────────────
  const [mode, setMode] = useState<'anual' | 'mensal' | 'semanal'>('mensal')
  const [ano,           setAno]           = useState<number | null>(null)
  const [selectedMeses, setSelectedMeses] = useState<Set<number>>(new Set())
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set())

  // FW: semanal = single required; mensal/anual = multi-select (all by default)
  const [fwSemanal,   setFwSemanal]   = useState<string>('')
  const [selectedFws, setSelectedFws] = useState<Set<string>>(new Set())

  // Multi-select cliente / família (all by default after load)
  const [selectedClientes, setSelectedClientes] = useState<Set<string>>(new Set())
  const [selectedFamilias, setSelectedFamilias] = useState<Set<string>>(new Set())

  // Free-text search + sort key over the LOADED items. Purely client-side, applied on top of
  // the dropdown filters — the same pair the "Adicionar" tab has, which this tab was missing:
  // a Carga de Fábrica period can list hundreds of items and the dropdowns alone cannot find
  // one by code. Deliberately NOT part of the request params: neither narrows the fetch, so
  // typing must never trigger a reload.
  const [searchText, setSearchText] = useState('')
  const [sortBy, setSortBy] = useState<'area' | 'cliente' | 'familia' | 'item'>('area')

  // ── Data state ─────────────────────────────────────────────────
  const [items,   setItems]   = useState<ImportItem[]>([])
  const [options, setOptions] = useState<ImportFilterOptions>({
    anos: [], meses: [], fws: [], familias: [], clientes: [],
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  /** Routing coverage of the loaded result — Carga de Fábrica only; the monthly plan does not
   *  report one and this stays null there, hiding the strip. */
  const [coverage, setCoverage] = useState<FactoryLoadCoverage | null>(null)

  // ── Selection state ────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // ── Month→FW map (populated once on initial load, no extra API calls) ─────
  // Mirrors _list_available_fw_values() in the original desktop tool: the backend groups
  // the DataFrame by month and returns FW lists per month in one go.
  const [mesFwMap, setMesFwMap] = useState<Record<number, string[]>>({})

  // Generation counter: prevents stale in-flight responses from overwriting newer state.
  // Incremented on every load() call; responses from older calls are silently dropped.
  const loadGenRef = useRef(0)

  // Sorted union of all FWs across all months (used when no months selected)
  const allFwsComputed = useMemo(() => {
    const seen = new Set<string>()
    const merged: string[] = []
    Object.values(mesFwMap).forEach(fws =>
      fws.forEach(fw => { if (!seen.has(fw)) { seen.add(fw); merged.push(fw) } })
    )
    return merged.sort((a, b) => Number(a) - Number(b))
  }, [mesFwMap])

  /** Union of FWs for a given set of months (sorted numerically). */
  function fwsForMeses(mesesSet: Set<number>): string[] {
    if (mesesSet.size === 0) return allFwsComputed
    const seen = new Set<string>()
    const merged: string[] = []
    for (const m of [...mesesSet].sort((a, b) => a - b)) {
      for (const fw of (mesFwMap[m] ?? [])) {
        if (!seen.has(fw)) { seen.add(fw); merged.push(fw) }
      }
    }
    return merged.sort((a, b) => Number(a) - Number(b))
  }

  // ── Load items from backend ────────────────────────────────────
  /**
   * Main fetch.  Accepts optional overrides for ano/mes so callers can pass
   * freshly-changed values before React state has re-rendered (avoids stale-
   * closure issues with useCallback).
   */
  const load = useCallback(async (opts?: {
    fwsSel?:          Set<string>
    anoParam?:        number | null
    mesesParam?:      Set<number>
    fwSemanalParam?:  string
  }) => {
    const myGen = ++loadGenRef.current   // stamp this request
    const effectiveAno       = opts?.anoParam       !== undefined ? opts.anoParam       : ano
    const effectiveMeses     = opts?.mesesParam     !== undefined ? opts.mesesParam     : selectedMeses
    const effectiveFwSemanal = opts?.fwSemanalParam !== undefined ? opts.fwSemanalParam : fwSemanal

    setLoading(true)
    setError(null)
    setSelected(new Set())

    try {
      const params: ExcelItemsParams = { mode: mode === 'anual' ? 'mensal' : mode }
      if (effectiveAno != null) params.ano = effectiveAno

      // Single month → mes param; multi-month → meses param; 0 months → no filter
      if (effectiveMeses.size === 1) {
        params.mes = [...effectiveMeses][0]
      } else if (effectiveMeses.size > 1) {
        params.meses = [...effectiveMeses].sort((a, b) => a - b)
      }

      if (mode === 'semanal') {
        if (effectiveFwSemanal) params.fw = effectiveFwSemanal
      } else {
        const curFwsSel = opts?.fwsSel ?? selectedFws
        // All FWs for the effective period (union across selected months)
        const allFwsForPeriod = fwsForMeses(effectiveMeses)
        if (allFwsForPeriod.length > 0 && curFwsSel.size > 0 && curFwsSel.size < allFwsForPeriod.length) {
          params.fws = [...curFwsSel]
        }
      }

      const res = await fetchItems(params)
      if (loadGenRef.current !== myGen) return  // stale response, discard

      const newOpts = augmentOpts(res.filter_options, res.items)
      const newMap  = (res.mes_fw_map ?? {}) as Record<number, string[]>
      setMesFwMap(newMap)

      // Seed defaults on first load: select the latest month only.
      const seedAno  = effectiveAno
      let seedMeses  = effectiveMeses
      let didSeed    = false
      if (seedMeses.size === 0 && newOpts.meses.length > 0) {
        const latestMes = newOpts.meses[newOpts.meses.length - 1]
        seedMeses = new Set([latestMes])
        setSelectedMeses(seedMeses)
        didSeed = true
      }

      // Compute FW list for seeded/effective months
      const computedFwsForMeses = (mSet: Set<number>): string[] => {
        if (mSet.size === 0) return newOpts.fws
        const seen = new Set<string>()
        const merged: string[] = []
        for (const m of [...mSet].sort((a, b) => a - b)) {
          for (const fw of (newMap[m] ?? [])) {
            if (!seen.has(fw)) { seen.add(fw); merged.push(fw) }
          }
        }
        return merged.sort((a, b) => Number(a) - Number(b))
      }

      const fwsToUse = computedFwsForMeses(seedMeses)
      setOptions({ ...newOpts, fws: fwsToUse })
      if (opts?.fwsSel === undefined) {
        setSelectedFws(new Set(fwsToUse))
      }
      setSelectedClientes(new Set(newOpts.clientes))
      setSelectedFamilias(new Set(newOpts.familias))

      if (didSeed) {
        const seededParams: ExcelItemsParams = { mode: mode === 'anual' ? 'mensal' : mode }
        if (seedAno != null) seededParams.ano = seedAno
        if (seedMeses.size === 1) seededParams.mes = [...seedMeses][0]
        const seededRes = await fetchItems(seededParams)
        if (loadGenRef.current !== myGen) return  // stale, discard
        setItems(seededRes.items)
        // Update clientes/familias to reflect the seeded month (not all months)
        const seedOpts = augmentOpts(seededRes.filter_options, seededRes.items)
        setOptions(prev => ({ ...prev, clientes: seedOpts.clientes, familias: seedOpts.familias }))
        setSelectedClientes(new Set(seedOpts.clientes))
        setSelectedFamilias(new Set(seedOpts.familias))
        // From the SEEDED response, not the first one: coverage describes the items on screen,
        // and after seeding those are the seeded month's.
        setCoverage(coverageOf(seededRes))
      } else {
        setItems(res.items)
        setCoverage(coverageOf(res))
      }

    } catch (e: unknown) {
      if (loadGenRef.current !== myGen) return  // stale error, discard
      setError(e instanceof Error ? e.message : 'Erro ao carregar itens.')
    } finally {
      if (loadGenRef.current === myGen) setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ano, selectedMeses, fwSemanal, fetchItems])

  // Load on mount only — one fetch, then every filter change re-enters load() itself.
  // A factoryLoad source with no loader supplied still stays empty (empty table + empty-state
  // messaging) rather than falling back to monthly-plan items.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isFactoryLoad || sourceLoader) load() }, [])

  // When mode changes reset FW state
  const handleModeChange = (m: 'anual' | 'mensal' | 'semanal') => {
    setMode(m)
    setFwSemanal('')
    setSelectedFws(new Set(options.fws))
    // mensal forces single month — trim to the most recent if multiple were selected
    if (m === 'mensal' && selectedMeses.size > 1) {
      setSelectedMeses(new Set([Math.max(...selectedMeses)]))
    }
  }

  // When year changes reload everything (mes_fw_map may differ per year)
  const handleAnoChange = (v: string) => {
    const newAno = v ? Number(v) : null
    setAno(newAno)
    setSelectedMeses(new Set())
    setSelectedFws(new Set())
    load({ anoParam: newAno, mesesParam: new Set() })
  }

  // When semanal FW changes auto-reload so items reflect the selected week
  const handleFwSemanalChange = (v: string) => {
    setFwSemanal(v)
    if (v) load({ fwSemanalParam: v })
  }

  // (The per-week subset filter was removed from the bar — `selectedFws` now only ever follows
  // the selected months, maintained by handleMesesChange / the initial seeding in `load`.)

  // When month selection changes: update FW list (union of all selected months) and reload
  const handleMesesChange = (next: Set<number>) => {
    setSelectedMeses(next)
    const newFwList = fwsForMeses(next)
    setOptions(prev => ({ ...prev, fws: newFwList }))
    const newFwSel = new Set(newFwList)
    setSelectedFws(newFwSel)
    setFwSemanal('')
    load({ mesesParam: next, fwsSel: newFwSel })
  }

  // ── Cross-filtered cliente ⇔ familia options (instant, no API call) ──────────
  // Available clients: only clients that have items matching the selected families
  const availableClientesModal = useMemo(() => {
    if (selectedFamilias.size === 0 || selectedFamilias.size === options.familias.length) {
      return options.clientes
    }
    return options.clientes.filter(c =>
      items.some(it => fkey(it.cliente) === c && selectedFamilias.has(fkey(it.familia)))
    )
  }, [items, options.clientes, options.familias.length, selectedFamilias])

  // Available families: only families that have items matching the selected clients
  const availableFamiliasModal = useMemo(() => {
    if (selectedClientes.size === 0 || selectedClientes.size === options.clientes.length) {
      return options.familias
    }
    return options.familias.filter(f =>
      items.some(it => fkey(it.familia) === f && selectedClientes.has(fkey(it.cliente)))
    )
  }, [items, options.familias, options.clientes.length, selectedClientes])

  // Auto-clean stale selections when cross-filtered options shrink
  useEffect(() => {
    if (selectedClientes.size === 0) return
    const opts = new Set(availableClientesModal)
    const next = new Set([...selectedClientes].filter(c => opts.has(c)))
    if (next.size !== selectedClientes.size) setSelectedClientes(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableClientesModal])

  useEffect(() => {
    if (selectedFamilias.size === 0) return
    const opts = new Set(availableFamiliasModal)
    const next = new Set([...selectedFamilias].filter(f => opts.has(f)))
    if (next.size !== selectedFamilias.size) setSelectedFamilias(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableFamiliasModal])

  // Cascade clear: removing all clients also clears the family filter,
  // so "defilter cliente" doesn't leave a stale family selection active.
  const handleClientesChange = (next: Set<string>) => {
    setSelectedClientes(next)
    if (next.size === 0 || next.size === options.clientes.length) {
      setSelectedFamilias(new Set(options.familias))
    }
  }

  const handleFamiliasChange = (next: Set<string>) => {
    setSelectedFamilias(next)
    if (next.size === 0 || next.size === options.familias.length) {
      setSelectedClientes(new Set(options.clientes))
    }
  }

  // ── Client-side filtering ──────────────────────────────────────

  // Blank área is a real bucket, not a value to drop: an item with no Item Rout mapping has no
  // área and must still be listed (with the cell empty), so it needs an option to be matched by.
  const availableAreas = useMemo(() => optsWithBlank(items, it => it.area), [items])

  // Auto-select all areas whenever items (re)load
  useEffect(() => {
    setSelectedAreas(new Set(availableAreas))
  }, [availableAreas])

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    const base = items.filter(it => {
      // Matched through `fkey`, so a blank value tests against the blank bucket instead of
      // failing every option and vanishing from the table.
      if (selectedAreas.size > 0 && !selectedAreas.has(fkey(it.area))) return false
      if (selectedFamilias.size > 0 && !selectedFamilias.has(fkey(it.familia))) return false
      if (selectedClientes.size > 0 && !selectedClientes.has(fkey(it.cliente)))  return false
      // Free text over the columns the table actually shows, same as the "Adicionar" tab.
      if (q && !(
        it.item.toLowerCase().includes(q) ||
        (it.descricao ?? '').toLowerCase().includes(q) ||
        (it.area ?? '').toLowerCase().includes(q) ||
        (it.cliente ?? '').toLowerCase().includes(q) ||
        (it.familia ?? '').toLowerCase().includes(q)
      )) return false
      return true
    })
    // Sorted copy — `items` itself is never reordered, so the source order stays available.
    return [...base].sort((a, b) => {
      const va = (a[sortBy] ?? '').toString().toLowerCase()
      const vb = (b[sortBy] ?? '').toString().toLowerCase()
      const cmp = va.localeCompare(vb, 'pt-BR')
      // Ties fall back to the item code so the order is stable rather than input-dependent.
      return cmp !== 0 ? cmp : a.item.localeCompare(b.item, 'pt-BR')
    })
  }, [items, selectedAreas, selectedFamilias, selectedClientes, searchText, sortBy])

  // ── Selection helpers ──────────────────────────────────────────

  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    const allVis = filtered.every(it => selected.has(it.id))
    setSelected(prev => {
      const next = new Set(prev)
      filtered.forEach(it => allVis ? next.delete(it.id) : next.add(it.id))
      return next
    })
  }

  const allChecked  = filtered.length > 0 && filtered.every(it => selected.has(it.id))
  const someChecked = filtered.some(it => selected.has(it.id))

  // ── Import handler ─────────────────────────────────────────────

  const handleImport = () => {
    const mesesArr    = [...selectedMeses].sort((a, b) => a - b)
    const allFwsForMes = fwsForMeses(selectedMeses)
    const meta: ImportMeta = {
      mode,
      mes:  mesesArr.length === 1 ? mesesArr[0] : null,
      meses: mesesArr,
      selectedFws:  mode === 'semanal' ? (fwSemanal ? [fwSemanal] : []) : [...selectedFws],
      allFwsForMes,
      mesFwMap,
    }
    onImport(items.filter(it => selected.has(it.id)), meta)
    onClose()
  }

  // ── Semanal requires a FW before searching ─────────────────────
  const canSearch = mode !== 'semanal' || !!fwSemanal

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '82vw', maxWidth: 860, height: '78vh' }}
      >

        {/* Title bar */}
        <div className="bg-[#0D9488] text-white flex items-center justify-between px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <Play size={13} fill="white" className="shrink-0" />
            <span className="font-semibold text-sm tracking-wide">{isFactoryLoad ? 'Simular carga de fábrica' : 'Simular plano'}</span>
            <span className="text-white/50 text-xs">|</span>
            <span className="text-white/75 text-xs">{isFactoryLoad && !sourceLoader
              ? 'Fonte de dados ainda não conectada'
              : isFactoryLoad
                ? 'Itens do período carregado no Schedule'
                : 'Selecione o período e os itens a importar'}</span>
          </div>
          {/* Scope strip: the LAUNCH scope of the loaded Carga de Fábrica period (areas + dates),
              so it is clear what the list below is drawn from. Read-only — the filters beneath
              narrow within this scope, they never widen it. */}
          {sourceScope && sourceScope.areas.length > 0 && (
            <div className="hidden md:flex items-center gap-2 min-w-0 mr-2" title={
              `Linhas: ${sourceScope.linhas.join(', ') || '—'}\nÁreas: ${sourceScope.areas.join(', ')}`
            }>
              <span className="text-white/60 text-[10px] uppercase tracking-wide shrink-0">Escopo</span>
              <span className="text-white/90 text-[11px] tabular-nums shrink-0">
                {shortDate(sourceScope.from)}–{shortDate(sourceScope.to)}
              </span>
              <span className="text-white/40 text-xs shrink-0">·</span>
              <span className="text-white/90 text-[11px] truncate">
                {sourceScope.areas.length <= 2
                  ? sourceScope.areas.join(', ')
                  : `${sourceScope.areas.length} áreas`}
              </span>
            </div>
          )}
          <button onClick={onClose} className="rounded p-1 hover:bg-white/20 transition-colors" title="Fechar">
            <X size={16} />
          </button>
        </div>

        {/* ── Mode + Period cards ── */}
        <div className="bg-gray-50 border-b border-gray-200 px-4 pt-3 pb-3 shrink-0">
          <div className="grid grid-cols-3 gap-3">

            {/* ANUAL */}
            <div
              onClick={() => handleModeChange('anual')}
              className={`rounded-xl border-2 px-3 pt-2.5 pb-3 transition-all cursor-pointer select-none ${
                mode === 'anual'
                  ? 'border-[#0D9488] bg-red-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/80'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <Calendar size={14} className={mode === 'anual' ? 'text-[#0D9488]' : 'text-gray-400'} />
                <span className={`font-bold text-xs tracking-widest ${mode === 'anual' ? 'text-[#0D9488]' : 'text-gray-400'}`}>ANUAL</span>
                {mode === 'anual' && <div className="w-1.5 h-1.5 rounded-full bg-[#0D9488] ml-auto shrink-0" />}
              </div>
              <p className={`text-[10px] mb-2 ${mode === 'anual' ? 'text-red-400' : 'text-gray-400'}`}>Por ano fiscal</p>
              <div className="relative" onClick={e => e.stopPropagation()}>
                <select
                  value={ano ?? ''}
                  onChange={e => handleAnoChange(e.target.value)}
                  disabled={loading || mode !== 'anual'}
                  className={`w-full appearance-none border rounded-lg px-2.5 py-1.5 text-xs pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-400 transition-colors ${
                    mode !== 'anual'
                      ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                      : loading
                        ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                        : 'border-gray-300 text-black hover:border-gray-400'
                  }`}
                >
                  <option value="">Todos os anos</option>
                  {options.anos.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* MENSAL */}
            <div
              onClick={() => handleModeChange('mensal')}
              className={`rounded-xl border-2 px-3 pt-2.5 pb-3 transition-all cursor-pointer select-none ${
                mode === 'mensal'
                  ? 'border-[#0D9488] bg-red-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/80'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <CalendarDays size={14} className={mode === 'mensal' ? 'text-[#0D9488]' : 'text-gray-400'} />
                <span className={`font-bold text-xs tracking-widest ${mode === 'mensal' ? 'text-[#0D9488]' : 'text-gray-400'}`}>MENSAL</span>
                {mode === 'mensal' && <div className="w-1.5 h-1.5 rounded-full bg-[#0D9488] ml-auto shrink-0" />}
              </div>
              <p className={`text-[10px] mb-2 ${mode === 'mensal' ? 'text-red-400' : 'text-gray-400'}`}>Por mês do plano</p>
              <div className="relative" onClick={e => e.stopPropagation()}>
                <select
                  value={[...selectedMeses][0] ?? ''}
                  onChange={e => {
                    const v = e.target.value
                    const next = v ? new Set([Number(v)]) : new Set<number>()
                    handleMesesChange(next)
                  }}
                  disabled={loading || mode !== 'mensal'}
                  className={`w-full appearance-none border rounded-lg px-2.5 py-1.5 text-xs pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-400 transition-colors ${
                    mode !== 'mensal'
                      ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                      : loading
                        ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                        : 'border-gray-300 text-black hover:border-gray-400'
                  }`}
                >
                  <option value="">Todos os meses</option>
                  {options.meses.map(m => (
                    <option key={m} value={m}>{String(m).padStart(2, '0')} {MES_LABELS[m] ?? m}</option>
                  ))}
                </select>
                <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* SEMANAL */}
            <div
              onClick={() => handleModeChange('semanal')}
              className={`rounded-xl border-2 px-3 pt-2.5 pb-3 transition-all cursor-pointer select-none ${
                mode === 'semanal'
                  ? 'border-[#0D9488] bg-red-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/80'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <CalendarRange size={14} className={mode === 'semanal' ? 'text-[#0D9488]' : 'text-gray-400'} />
                <span className={`font-bold text-xs tracking-widest ${mode === 'semanal' ? 'text-[#0D9488]' : 'text-gray-400'}`}>SEMANAL</span>
                {mode === 'semanal' && <div className="w-1.5 h-1.5 rounded-full bg-[#0D9488] ml-auto shrink-0" />}
              </div>
              <p className={`text-[10px] mb-2 ${mode === 'semanal' ? 'text-red-400' : 'text-gray-400'}`}>Por semana fiscal</p>
              <div className="relative" onClick={e => e.stopPropagation()}>
                <select
                  value={fwSemanal}
                  onChange={e => handleFwSemanalChange(e.target.value)}
                  disabled={loading || mode !== 'semanal'}
                  className={`w-full appearance-none border rounded-lg px-2.5 py-1.5 text-xs pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-400 transition-colors ${
                    mode !== 'semanal'
                      ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                      : loading
                        ? 'border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
                        : !fwSemanal
                          ? 'border-red-300 text-black hover:border-red-400'
                          : 'border-gray-300 text-black hover:border-gray-400'
                  }`}
                >
                  <option value="">Selecione a FW</option>
                  {options.fws.map(f => (
                    <option key={f} value={f}>{fmtFw(f)}</option>
                  ))}
                </select>
                <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

          </div>
        </div>

        {/* ── Filters row ── */}
        <div className="bg-white border-b border-gray-100 px-4 py-2 flex flex-wrap items-end gap-3 shrink-0">

          {/* No FW/weeks multi-select here. The period is already chosen upstream (Ano + Mês, or
              the single week in Semanal mode), so a second weeks filter in this bar only offered
              a way to desynchronise the two. `selectedFws` stays at "every week of the selected
              months", which is what the query and the main tab's week list both expect. */}

          {/* Área */}
          <MultiSelect
            label="Área"
            options={availableAreas}
            selected={selectedAreas}
            onChange={setSelectedAreas}
            placeholder="Todas"
            disabled={loading}
          />

          {/* Cliente */}
          <MultiSelect
            label="Cliente"
            options={availableClientesModal}
            selected={selectedClientes}
            onChange={handleClientesChange}
            placeholder="Todos"
            disabled={loading}
          />

          {/* Família */}
          <MultiSelect
            label="Família"
            options={availableFamiliasModal}
            selected={selectedFamilias}
            onChange={handleFamiliasChange}
            placeholder="Todas"
            disabled={loading}
          />

          {/* Search — client-side over the loaded items, never a refetch. Mirrors the
              "Adicionar" tab's field so the two item pickers behave the same way. */}
          <div className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Pesquisar item</label>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Código, descrição, área…"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="w-full border border-gray-300 rounded-lg pl-8 pr-7 py-1.5 text-xs bg-white text-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-red-400 transition-colors"
              />
              {searchText && (
                <button
                  onClick={() => setSearchText('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title="Limpar"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Sort */}
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide flex items-center gap-1">
              <ArrowUpDown size={10} />
              Ordenar
            </label>
            <div className="relative">
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as 'area' | 'cliente' | 'familia' | 'item')}
                className="appearance-none border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs pr-7 bg-white text-black focus:outline-none focus:ring-1 focus:ring-red-400 min-w-[110px] hover:border-gray-400 transition-colors"
              >
                <option value="area">Área</option>
                <option value="cliente">Cliente</option>
                <option value="familia">Família</option>
                <option value="item">Item</option>
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>

          <div className="ml-auto flex items-end">
            <button
              onClick={() => load()}
              disabled={loading || !canSearch}
              title={!canSearch ? 'Selecione uma FW para o modo Semanal' : 'Recarregar dados'}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white text-black hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Buscar
            </button>
          </div>
        </div>

        {/* ── Routing coverage ──
            MANDATORY companion to the import, not a nicety. An item with no
            ASSEMBLY in the routing master imports with the plan's hours but no workstation and
            no operations, so it contributes 0 h to the capacity model — and on the grid that is
            indistinguishable from work that genuinely takes no time. Measured on the live plan,
            that is roughly two thirds of its hours (Propulsion B3 maps; WGS & Transit, Motor
            Diesel B2 and Labs B1 do not), so shipping the import without saying so would be
            worse than the omission it replaces: silence about absent work is at least visible
            as absence, whereas zeros read as a fact.

            Stated as HOURS first because that is the size of what is not being modelled, and by
            ÁREA because that is what makes it actionable — it names which part of the catalog
            is missing. It is a report, not a blocker: the work is real, the items import, and
            when the routing master grows to cover those áreas they resolve with no code change
            and this strip shrinks on its own. */}
        {coverage && coverage.unroutedItems > 0 && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 flex items-start gap-2">
            <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-px" />
            <div className="min-w-0 text-[11px] leading-snug text-amber-900">
              <span className="font-semibold">
                {coverage.unroutedItems.toLocaleString('pt-BR')} item(ns) sem roteiro
              </span>
              {' · '}{nHours(coverage.unroutedHours)} h do plano
              <span className="text-amber-700">
                {' '}— importados sem workstation e sem operações, contribuindo 0 h à capacidade.
              </span>
            </div>
          </div>
        )}

        {/* ── Table area ──
            overflow-x-hidden with a table-fixed layout below: every column has a declared
            width and its content truncates, so the table can never be wider than the modal.
            It used to be `overflow-auto` over an auto-layout table whose nowrap cells (Área's
            "Propulsion - B3", long descriptions) pushed it past the viewport, which put a
            horizontal scrollbar under the list by default — with the Descrição column parked
            off-screen. Vertical scrolling is unchanged. */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {error ? (
            <div className="p-6 text-sm text-red-600 bg-red-50">{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 px-10">
              <div className="flex items-center gap-2">
                <img src="/imagens/mark.svg" alt="" width={20} height={20} className="animate-spin" />
                <p className="text-sm text-gray-500">Carregando itens...</p>
              </div>
              <ProgressBar indeterminate className="w-full max-w-xs" />
            </div>
          ) : (
            <table className="w-full table-fixed text-xs border-collapse">
              {/* Fixed layout needs the widths declared once, here, rather than inferred from
                  content — that inference is what made the table overflow. Descrição takes the
                  remainder and every cell truncates. */}
              <colgroup>
                <col style={{ width: 56 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 190 }} />
                <col />
              </colgroup>
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  {/* Select-all — big, prominent */}
                  <th className="w-14 px-2 py-1.5 text-center border-b border-gray-200">
                    <button
                      onClick={loading ? undefined : toggleAll}
                      disabled={loading || filtered.length === 0}
                      title={allChecked ? 'Desmarcar todos' : 'Selecionar todos'}
                      className={`flex flex-col items-center justify-center gap-0.5 w-10 h-10 rounded-xl mx-auto transition-all border-2 ${
                        allChecked
                          ? 'bg-[#0D9488] border-[#0D9488] text-white shadow-md'
                          : someChecked
                            ? 'bg-red-50 border-red-400 text-red-500'
                            : filtered.length > 0
                              ? 'bg-white border-gray-300 text-gray-400 hover:border-red-400 hover:text-red-500 hover:bg-red-50 simular-wave-btn'
                              : 'bg-white border-gray-200 text-gray-300 cursor-not-allowed'
                      }`}
                    >
                      {allChecked
                        ? <CheckSquare size={20} />
                        : someChecked
                          ? <CheckSquare size={20} />
                          : <Square size={20} className={filtered.length > 0 ? 'simular-wave-label' : ''} />}
                    </button>
                  </th>
                  {/* Wider than the other label columns and never wrapping: schedule-sourced
                      áreas are full labels ("Propulsion - B3"), which the auto-layout column
                      broke over two lines. */}
                  <th className="px-3 py-2 text-left font-semibold text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap">Área</th>
                  <th className="px-3 py-2 text-left font-semibold text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap">Cliente</th>
                  <th className="px-3 py-2 text-left font-semibold text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap">Família</th>
                  <th className="px-3 py-2 text-left font-semibold text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap">Item</th>
                  <th className="px-3 py-2 text-left font-semibold text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200">Descrição</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-gray-400 text-xs">
                      {isFactoryLoad && !sourceLoader
                        ? 'Fonte de dados da Carga de Fábrica ainda não disponível.'
                        : items.length === 0
                          ? mode === 'semanal' && !fwSemanal
                            ? 'Selecione uma FW e clique em Buscar.'
                            : 'Clique em Buscar para carregar os dados.'
                          : 'Nenhum item encontrado com os filtros aplicados.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((it, idx) => {
                    const checked = selected.has(it.id)
                    return (
                      <tr
                        key={it.id}
                        onClick={loading ? undefined : () => toggleOne(it.id)}
                        className={`border-b border-gray-100 transition-colors ${
                          loading ? 'cursor-not-allowed opacity-60' :
                          checked
                            ? 'cursor-pointer bg-red-50 hover:bg-red-100'
                            : idx % 2 === 0
                              ? 'cursor-pointer bg-white hover:bg-gray-50'
                              : 'cursor-pointer bg-gray-50/50 hover:bg-gray-100'
                        }`}
                      >
                        <td className="px-2 py-1.5 text-center">
                          {checked
                            ? <CheckSquare size={14} className="text-red-600 mx-auto" />
                            : <Square      size={14} className="text-gray-300 mx-auto" />}
                        </td>
                        <td className="px-3 py-1.5 text-gray-800 whitespace-nowrap truncate" title={it.area}>{it.area}</td>
                        <td className="px-3 py-1.5 text-gray-800 whitespace-nowrap truncate" title={it.cliente}>{it.cliente}</td>
                        <td className="px-3 py-1.5 text-gray-800 whitespace-nowrap truncate" title={it.familia}>{it.familia}</td>
                        <td className="px-3 py-1.5 font-medium text-gray-900 whitespace-nowrap truncate" title={it.item}>
                          {it.item}
                          {/* An item with no routing resolves to no operations and 0 h, which
                              on its own is indistinguishable from work that genuinely costs
                              nothing. The tag is the difference. Only ever set by the Carga de
                              Fábrica source; the monthly plan leaves `hasRouting` undefined. */}
                          {it.hasRouting === false && (
                            <span
                              title="Sem ASSEMBLY no cadastro de roteiro: o item é importado com as horas do plano, mas sem workstation e sem operações (0 h roteirizadas)."
                              className="ml-1.5 align-middle rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-200"
                            >
                              sem roteiro
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap truncate" title={it.descricao}>{it.descricao}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 bg-gray-50 px-4 py-2.5 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-500">
            {selected.size > 0
              ? `${selected.size} de ${filtered.length} selecionado${selected.size !== 1 ? 's' : ''}`
              : `${filtered.length} item${filtered.length !== 1 ? 's' : ''} exibido${filtered.length !== 1 ? 's' : ''}`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs border border-gray-300 rounded-lg bg-white text-black hover:bg-gray-100 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleImport}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-[#0D9488] text-white rounded-lg hover:bg-red-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              <Play size={12} fill="white" className="shrink-0" />
              Simular {selected.size > 0 ? `(${selected.size} itens)` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
