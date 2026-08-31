/**
 * AddItemModal — "Adicionar Item por Família"
 *
 * Equivalent to AddAssemblyDialog in CapB3356103.py.
 * Filters: Área | Família | Cliente | Pesquisar
 * Table columns: Área | Cliente | Família | ITEM | DESCRIÇÃO
 *
 * No period/FW filter — shows all items from the catalog.
 */
'use client'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { X, Search, CheckSquare, Square, ChevronDown, RefreshCw, LayoutList, Star, ArrowUpDown, Plus } from 'lucide-react'
import { getItemsCatalog } from '@/lib/api'
import type { ImportItem, CatalogFilterOptions } from '@/lib/api'

// ── Multi-select checkbox dropdown (same as ImportModal) ──────────────────────

interface MultiSelectProps {
  label:        string
  options:      string[]
  selected:     Set<string>
  onChange:     (next: Set<string>) => void
  placeholder?: string
}

function MultiSelect({ label, options, selected, onChange, placeholder }: MultiSelectProps) {
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
  const summary = allSelected
    ? (placeholder ?? 'Todos')
    : selected.size === 0
      ? 'Nenhum'
      : selected.size === 1
        ? [...selected][0]
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
          onClick={() => setOpen(v => !v)}
          className="border border-gray-300 rounded px-2 py-1 text-xs text-black bg-white flex items-center gap-1 min-w-[130px] text-left hover:bg-gray-50 transition-colors"
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
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  onAdd:    (items: ImportItem[]) => void
  onClose:  () => void
}

// ── Module-level catalog cache (persists across modal opens) ──────────────────────
let _catalogCache: { items: ImportItem[]; options: CatalogFilterOptions; ts: number } | null = null
const CATALOG_CACHE_TTL = 10 * 60 * 1000  // 10 minutes

// ── Component ─────────────────────────────────────────────────────────────────

export function AddItemModal({ onAdd, onClose }: Props) {
  // ── Filter state ───────────────────────────────────────────────
  const [selectedAreas,    setSelectedAreas]    = useState<Set<string>>(new Set())
  const [selectedFamilias, setSelectedFamilias] = useState<Set<string>>(new Set())
  const [selectedClientes, setSelectedClientes] = useState<Set<string>>(new Set())
  const [searchText,       setSearchText]       = useState<string>('')
  // LOCOS mode: when true shows only CLIENTE = "NEW LOCOS" items
  const [locosMode, setLocosMode] = useState(false)
  // Sort key for alphabetical ordering
  const [sortBy, setSortBy] = useState<'area' | 'cliente' | 'familia' | 'item'>('area')

  // ── Data state ─────────────────────────────────────────────────
  const [items,   setItems]   = useState<ImportItem[]>([])
  const [options, setOptions] = useState<CatalogFilterOptions>({
    areas: [], familias: [], clientes: [],
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // ── Selection state ────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // ── Load catalog from backend ──────────────────────────────────

  const load = useCallback(async () => {
    // Use cached data if still fresh (avoids redundant API call on re-open)
    const now = Date.now()
    if (_catalogCache && now - _catalogCache.ts < CATALOG_CACHE_TTL) {
      setItems(_catalogCache.items)
      setOptions(_catalogCache.options)
      setSelectedAreas(new Set(_catalogCache.options.areas))
      setSelectedFamilias(new Set(_catalogCache.options.familias))
      setSelectedClientes(new Set(_catalogCache.options.clientes))
      return
    }

    setLoading(true)
    setError(null)
    setSelected(new Set())

    try {
      const res = await getItemsCatalog()
      // Only show items with no scheduled demand (QTDE FW blank)
      const catalogItems = res.items.filter(it => !it.has_qty_fw)
      setItems(catalogItems)

      // Build option lists (exclude NEW LOCOS from normal filter columns)
      const normalItems = catalogItems.filter(it => it.cliente.toUpperCase() !== 'NEW LOCOS')
      const newOpts: CatalogFilterOptions = {
        areas:    [...new Set(catalogItems.map(it => it.area).filter(Boolean))].sort(),
        familias: [...new Set(normalItems.map(it => it.familia).filter(Boolean))].sort(),
        // Clientes excludes NEW LOCOS (shown via LOCOS toggle)
        clientes: [...new Set(normalItems.map(it => it.cliente).filter(Boolean))].sort(),
      }
      setOptions(newOpts)
      _catalogCache = { items: catalogItems, options: newOpts, ts: Date.now() }

      // Default: all selected
      setSelectedAreas(new Set(newOpts.areas))
      setSelectedFamilias(new Set(newOpts.familias))
      setSelectedClientes(new Set(newOpts.clientes))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar catálogo.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Load on mount
  useEffect(() => { load() }, [load])

  // ── Client-side filtering ──────────────────────────────────────

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase().trim()
    const base = items.filter(it => {
      // LOCOS mode: only NEW LOCOS + Área; normal mode: exclude NEW LOCOS + all filters
      if (locosMode) {
        if (it.cliente.toUpperCase() !== 'NEW LOCOS') return false
      } else {
        if (it.cliente.toUpperCase() === 'NEW LOCOS') return false
        if (selectedClientes.size > 0 && it.cliente && !selectedClientes.has(it.cliente)) return false
        // Items with no familia value are always shown (can't filter on missing data)
        if (selectedFamilias.size > 0 && it.familia && !selectedFamilias.has(it.familia)) return false
      }
      if (selectedAreas.size > 0 && !selectedAreas.has(it.area)) return false
      if (q) {
        const h = `${it.item} ${it.descricao}`.toLowerCase()
        if (!h.includes(q)) return false
      }
      return true
    })
    return base.sort((a, b) => {
      const va = (a[sortBy] ?? '').toLowerCase()
      const vb = (b[sortBy] ?? '').toLowerCase()
      return va.localeCompare(vb, 'pt-BR')
    })
  }, [items, selectedAreas, selectedFamilias, selectedClientes, searchText, locosMode, sortBy])

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

  // ── Add handler ────────────────────────────────────────────────

  const handleAdd = () => {
    onAdd(items.filter(it => selected.has(it.id)))
    onClose()
  }

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
        <div className="bg-[#D32F2F] text-white flex items-center justify-between px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <Plus size={13} className="shrink-0" />
            <span className="font-semibold text-sm tracking-wide">Adicionar item por família</span>
            <span className="text-white/50 text-xs">|</span>
            <span className="text-white/75 text-xs">Selecione os itens a adicionar</span>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/20 transition-colors" title="Fechar">
            <X size={16} />
          </button>
        </div>

        {/* ── Mode cards: Normal vs New Locos ── */}
        <div className="bg-gray-50 border-b border-gray-200 px-4 pt-3 pb-3 shrink-0">
          <div className="grid grid-cols-2 gap-3">

            {/* NORMAL */}
            <div
              onClick={() => setLocosMode(false)}
              className={`rounded-xl border-2 px-4 py-3 flex items-center gap-3 cursor-pointer select-none transition-all ${
                !locosMode
                  ? 'border-[#D32F2F] bg-red-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/80'
              }`}
            >
              <div className={`p-2 rounded-lg shrink-0 ${!locosMode ? 'bg-[#D32F2F] text-white' : 'bg-gray-100 text-gray-400'}`}>
                <LayoutList size={16} />
              </div>
              <div className="min-w-0">
                <div className={`font-bold text-xs tracking-widest ${!locosMode ? 'text-[#D32F2F]' : 'text-gray-400'}`}>NORMAL</div>
                <div className={`text-[10px] mt-0.5 ${!locosMode ? 'text-red-400' : 'text-gray-400'}`}>Todos os itens do catálogo</div>
              </div>
              {!locosMode && <div className="w-1.5 h-1.5 rounded-full bg-[#D32F2F] ml-auto shrink-0" />}
            </div>

            {/* NEW LOCOS */}
            <div
              onClick={() => setLocosMode(true)}
              className={`rounded-xl border-2 px-4 py-3 flex items-center gap-3 cursor-pointer select-none transition-all ${
                locosMode
                  ? 'border-[#D32F2F] bg-red-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/80'
              }`}
            >
              <div className={`p-2 rounded-lg shrink-0 ${locosMode ? 'bg-[#D32F2F] text-white' : 'bg-gray-100 text-gray-400'}`}>
                <Star size={16} />
              </div>
              <div className="min-w-0">
                <div className={`font-bold text-xs tracking-widest ${locosMode ? 'text-[#D32F2F]' : 'text-gray-400'}`}>NEW LOCOS</div>
                <div className={`text-[10px] mt-0.5 ${locosMode ? 'text-red-400' : 'text-gray-400'}`}>Itens exclusivos New Locos</div>
              </div>
              {locosMode && <div className="w-1.5 h-1.5 rounded-full bg-[#D32F2F] ml-auto shrink-0" />}
            </div>

          </div>
        </div>

        {/* ── Filters + Search + Sort row ── */}
        <div className="bg-white border-b border-gray-100 px-4 py-2.5 flex flex-wrap items-end gap-3 shrink-0">

          {/* Área */}
          <MultiSelect
            label="Área"
            options={options.areas}
            selected={selectedAreas}
            onChange={setSelectedAreas}
            placeholder="Todas"
          />

          {/* Cliente — hidden in New Locos mode */}
          {!locosMode && (
            <MultiSelect
              label="Cliente"
              options={options.clientes}
              selected={selectedClientes}
              onChange={setSelectedClientes}
              placeholder="Todos"
            />
          )}

          {/* Família — hidden in New Locos mode */}
          {!locosMode && (
            <MultiSelect
              label="Família"
              options={options.familias}
              selected={selectedFamilias}
              onChange={setSelectedFamilias}
              placeholder="Todas"
            />
          )}

          {/* Search bar — prominent */}
          <div className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Pesquisar item</label>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Código ou descrição..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-xs bg-white text-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-red-400 transition-colors"
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

          {/* Sort select */}
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

          {/* Refresh */}
          <div className="flex flex-col justify-end">
            <button
              onClick={load}
              disabled={loading}
              title="Recarregar catálogo"
              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white text-black hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Buscar
            </button>
          </div>
        </div>

        {/* ── Table area ── */}
        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="p-6 text-sm text-red-600 bg-red-50">{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="flex items-center justify-center h-32 gap-2 text-sm text-gray-400">
              <RefreshCw size={15} className="animate-spin text-gray-400 shrink-0" />
              Carregando catálogo...
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  {/* Select-all — big, prominent */}
                  <th className="w-14 px-2 py-1.5 text-center border-b border-gray-200">
                    <button
                      onClick={toggleAll}
                      disabled={filtered.length === 0}
                      title={allChecked ? 'Desmarcar todos' : 'Marcar todos'}
                      className={`flex flex-col items-center justify-center gap-0.5 w-10 h-10 rounded-xl mx-auto transition-all border-2 ${
                        allChecked
                          ? 'bg-[#D32F2F] border-[#D32F2F] text-white shadow-md'
                          : someChecked
                            ? 'bg-red-50 border-red-400 text-red-500'
                            : filtered.length > 0
                              ? 'bg-white border-gray-300 text-gray-400 hover:border-red-400 hover:text-red-500 hover:bg-red-50'
                              : 'bg-white border-gray-200 text-gray-300 cursor-not-allowed'
                      }`}
                    >
                      {allChecked
                        ? <CheckSquare size={20} />
                        : someChecked
                          ? <CheckSquare size={20} />
                          : <Square size={20} />}
                    </button>
                  </th>
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
                      {items.length === 0
                        ? 'Nenhum item encontrado no catálogo.'
                        : 'Nenhum item encontrado com os filtros aplicados.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((it, idx) => {
                    const checked = selected.has(it.id)
                    return (
                      <tr
                        key={it.id}
                        onClick={() => toggleOne(it.id)}
                        className={`cursor-pointer border-b border-gray-100 transition-colors ${
                          checked
                            ? 'bg-red-50 hover:bg-red-100'
                            : idx % 2 === 0
                              ? 'bg-white hover:bg-gray-50'
                              : 'bg-gray-50/50 hover:bg-gray-100'
                        }`}
                      >
                        <td className="px-2 py-1.5 text-center">
                          {checked
                            ? <CheckSquare size={14} className="text-red-600 mx-auto" />
                            : <Square      size={14} className="text-gray-300 mx-auto" />}
                        </td>
                        <td className="px-3 py-1.5 text-gray-800">{it.area}</td>
                        <td className="px-3 py-1.5 text-gray-800">{it.cliente}</td>
                        <td className="px-3 py-1.5 text-gray-800">{it.familia}</td>
                        <td className="px-3 py-1.5 font-medium text-gray-900 whitespace-nowrap">{it.item}</td>
                        <td className="px-3 py-1.5 text-gray-700 max-w-[240px] truncate" title={it.descricao}>
                          {it.descricao}
                        </td>
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
              onClick={handleAdd}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-[#D32F2F] text-white rounded-lg hover:bg-red-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              <Plus size={12} className="shrink-0" />
              Adicionar {selected.size > 0 ? `(${selected.size} itens)` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
