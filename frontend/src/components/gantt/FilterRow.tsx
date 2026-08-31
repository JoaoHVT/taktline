'use client'
import { CalendarDays, Layers, LayoutGrid } from 'lucide-react'
import { FilterBox } from './FilterBox'
import { RED_DK, MONTH_FULL_PT } from '@/lib/ganttUtils'

export function FilterRow({
  years, months, fws, selYears, selMonths, selFws, onYear, onMonth, onFw, onClear, suffix,
}: {
  years: string[]; months: string[]; fws: string[]
  selYears: Set<string>; selMonths: Set<string>; selFws: Set<string>
  onYear: (v: string) => void; onMonth: (v: string) => void; onFw: (v: string) => void
  onClear: () => void
  suffix?: React.ReactNode
}) {
  const hasAny = selYears.size > 0 || selMonths.size > 0 || selFws.size > 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <FilterBox icon={<LayoutGrid size={13} />} label="Ano" items={years} selected={selYears} onToggle={onYear} formatItem={v => v} />
      <FilterBox
        icon={<CalendarDays size={13} />} label="Mês" items={months} selected={selMonths} onToggle={onMonth}
        formatItem={ym => { const [y, m] = ym.split('-'); return `${MONTH_FULL_PT[+m - 1]} ${y}` }}
      />
      <FilterBox icon={<Layers size={13} />} label="Semana (FW)" items={fws} selected={selFws} onToggle={onFw} formatItem={v => v} />
      {hasAny && (
        <button onClick={onClear} style={{
          fontSize: 11, color: RED_DK, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer',
          textDecoration: 'underline', padding: '2px 4px',
        }}>Limpar filtros</button>
      )}
      {suffix}
    </div>
  )
}
