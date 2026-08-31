'use client'
/**
 * DateFilterDropdown — the shared "Datas" date filter used by both the Resumo
 * Geral and Plano de Produção tabs. A collapsed "Datas" chip expands into a
 * dropdown panel that OVERLAYS the content (absolute, no layout push) with:
 *   • a header row: title (left) + "× Limpar filtros" (right, at the TOP)
 *   • the Year / Quarter / Month / FW controls laid out HORIZONTALLY in a single row
 *
 * Owns only its open/close UI state + outside-click close; all selection state
 * lives in the parent so values persist until changed or cleared. Matches the
 * main Análise de Capacidade filter card visually.
 *
 * Trimestre (Q1–Q4) is OPTIONAL: a consumer that does not hold quarter state simply
 * omits the three quarter props and the box is not rendered, so the dropdown stays
 * drop-in for surfaces that only filter by Ano/Mês/Semana.
 */
import { useState, useEffect, useRef } from 'react'
import { CalendarDays, ChevronDown, X } from 'lucide-react'
import { FilterBox } from './FilterBox'
import { RED, RED_LT, MONTH_NAMES_PT, quarterLabel } from '@/lib/ganttUtils'

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50,
  background: '#fff', border: `1px solid ${RED}33`, borderRadius: 10,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: 10,
}
const ROW_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'nowrap',
}

export function DateFilterDropdown({
  years, months, fws, quarters,
  selYears, selMonths, selFws, selQuarters,
  onToggleYear, onToggleMonth, onToggleFw, onToggleQuarter,
  onClear,
  align = 'left',
}: {
  years: string[]; months: string[]; fws: string[]
  selYears: Set<string>; selMonths: Set<string>; selFws: Set<string>
  onToggleYear: (v: string) => void
  onToggleMonth: (v: string) => void
  onToggleFw: (v: string) => void
  onClear: () => void
  /** Fiscal-quarter keys ("2026-Q1"). Omit — together with `selQuarters`/`onToggleQuarter` —
   *  to hide the Trimestre box entirely. */
  quarters?: string[]
  selQuarters?: Set<string>
  onToggleQuarter?: (v: string) => void
  /** Which edge of the chip the panel aligns to (use 'right' when the chip sits
   *  on the right of its row so the panel doesn't overflow off-screen). */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const showQuarters = Boolean(quarters && selQuarters && onToggleQuarter)
  const count = selYears.size + selMonths.size + selFws.size + (selQuarters?.size ?? 0)
  const hasAny = count > 0
  const hot = hasAny || open

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} title={open ? 'Recolher' : 'Expandir'} style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderRadius: 8, border: `1.5px solid ${hot ? RED : '#D1D5DB'}`,
        background: hot ? RED_LT : '#F9FAFB', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, color: hot ? RED : '#374151', whiteSpace: 'nowrap',
      }}>
        <CalendarDays size={13} style={{ color: hot ? RED : '#6B7280' }} />
        Datas
        {hasAny && (
          <span style={{ marginLeft: 2, background: RED, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5 }}>{count}</span>
        )}
        <ChevronDown size={12} style={{ color: hot ? RED : '#9CA3AF', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={{ ...PANEL_STYLE, ...(align === 'right' ? { left: 'auto', right: 0 } : null) }}>
          {/* Header: title + Clear at the TOP */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Filtros de data</span>
            {hasAny && (
              <button onClick={onClear} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: RED, padding: 0, whiteSpace: 'nowrap' }}>
                <X size={13} /> Limpar filtros
              </button>
            )}
          </div>
          {/* Controls in one horizontal row */}
          <div style={ROW_STYLE}>
            <FilterBox icon={<CalendarDays size={12} />} label="Ano" items={years} selected={selYears} onToggle={onToggleYear} formatItem={y => y} />
            {showQuarters && (
              <FilterBox icon={<CalendarDays size={12} />} label="Trimestre" items={quarters!} selected={selQuarters!} onToggle={onToggleQuarter!} formatItem={quarterLabel} />
            )}
            <FilterBox icon={<CalendarDays size={12} />} label="Mês" items={months} selected={selMonths} onToggle={onToggleMonth} formatItem={m => { const [yyyy, mm] = m.split('-'); return `${MONTH_NAMES_PT[Number(mm) - 1]} ${yyyy}` }} />
            <FilterBox icon={<CalendarDays size={12} />} label="Semana" items={fws} selected={selFws} onToggle={onToggleFw} formatItem={fw => fw} alignRight={align === 'right'} />
          </div>
        </div>
      )}
    </div>
  )
}
