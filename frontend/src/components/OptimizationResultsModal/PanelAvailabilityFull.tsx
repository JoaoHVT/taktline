'use client'
import { useState, useMemo, useEffect } from 'react'
import { X } from 'lucide-react'
import { getPeriodDays } from '@/lib/api'
import { NumberRoller } from './NumberRoller'

type AvailTab = 'geral' | 'semanal'

export function PanelAvailabilityFull({
  person, selectedFws, mappedDays, currentValue, onSave, onClose, onClear, accentColor, textColor,
}: {
  person:       string
  selectedFws:  string[]
  mappedDays:   number | null
  currentValue: number | null
  onSave:       (v: number) => void
  onClose:      () => void
  onClear:      () => void
  accentColor:  string
  textColor?:   string
}) {
  const [tab, setTab] = useState<AvailTab>('geral')

  // ── Geral tab (percentage roller) ─────────────────────────────────────────
  const initPct = currentValue ?? 100
  const [pct, setPct] = useState<number>(initPct)

  // ── Semanal tab ────────────────────────────────────────────────────────────
  type WeekRow = { fw: string; days: number; active: boolean }
  const [weekRows,    setWeekRows]    = useState<WeekRow[]>([])
  const [weekLoading, setWeekLoading] = useState(false)
  const [weekLoadErr, setWeekLoadErr] = useState(false)
  const [weekInitted, setWeekInitted] = useState(false)

  useEffect(() => {
    if (tab !== 'semanal' || weekInitted) return
    if (selectedFws.length === 0) {
      const nFws = Math.max(1, Math.round((mappedDays ?? 5) / 5))
      setWeekRows(Array.from({ length: nFws }, (_, i) => ({ fw: `${i + 1}`, days: 5, active: true })))
      setWeekInitted(true)
      return
    }
    setWeekLoading(true)
    getPeriodDays(selectedFws)
      .then(res => {
        setWeekRows(selectedFws.map(fw => ({ fw, days: res.days_by_fw[fw] ?? 5, active: true })))
        setWeekInitted(true)
      })
      .catch(() => {
        const avg = mappedDays ? Math.round(mappedDays / selectedFws.length) : 5
        setWeekRows(selectedFws.map(fw => ({ fw, days: avg, active: true })))
        setWeekInitted(true)
        setWeekLoadErr(true)
      })
      .finally(() => setWeekLoading(false))
  }, [tab, weekInitted, selectedFws, mappedDays])

  const totalDaysBaseline = useMemo(
    () => mappedDays ?? weekRows.reduce((s, r) => s + r.days, 0),
    [mappedDays, weekRows],
  )

  const activeDays = useMemo(
    () => weekRows.filter(r => r.active).reduce((s, r) => s + r.days, 0),
    [weekRows],
  )

  const weeklyPct = useMemo(() => {
    if (totalDaysBaseline <= 0) return 100
    return Math.min(100, Math.round((activeDays / totalDaysBaseline) * 1000) / 10)
  }, [activeDays, totalDaysBaseline])

  function toggleWeek(fw: string) {
    setWeekRows(prev => prev.map(r => r.fw === fw ? { ...r, active: !r.active } : r))
  }

  function setDays(fw: string, days: number) {
    setWeekRows(prev => prev.map(r => r.fw === fw ? { ...r, days: Math.max(0, Math.min(7, days)) } : r))
  }

  const activePct = tab === 'geral' ? pct : weeklyPct

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col" style={{ width: 320, maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800">Disponibilidade</span>
            <span className="text-[11px] text-gray-500 truncate">{person}</span>
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-gray-200 shrink-0">
          {(['geral', 'semanal'] as AvailTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-xs font-semibold transition-all"
              style={{
                borderBottom:    tab === t ? `2px solid ${accentColor}` : '2px solid transparent',
                color:           tab === t ? accentColor : '#6B7280',
                backgroundColor: tab === t ? `${accentColor}10` : 'transparent',
              }}
            >
              {t === 'geral' ? 'Geral' : 'Por Semana'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {tab === 'geral' && (
            <div className="px-4 py-4 flex flex-col items-center gap-1">
              <span className="text-[11px] text-gray-500">Disponibilidade (%)</span>
              <NumberRoller value={pct} min={0} max={100} step={5} onChange={setPct} textColor={textColor} />
            </div>
          )}

          {tab === 'semanal' && (
            <div className="px-3 py-3 flex flex-col gap-2">
              {weekLoading && (
                <p className="text-xs text-gray-400 text-center py-4">Carregando semanas…</p>
              )}
              {!weekLoading && weekLoadErr && (
                <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded mb-1">
                  Não foi possível obter dias reais — usando estimativa.
                </p>
              )}
              {!weekLoading && weekRows.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">
                  Nenhuma semana disponível.<br/>
                  <span className="text-[10px]">Importe dados com período para habilitar.</span>
                </p>
              )}
              {!weekLoading && weekRows.map(row => (
                <div
                  key={row.fw}
                  className="flex items-center gap-2 p-2 rounded-lg border transition-all"
                  style={{
                    borderColor:     row.active ? `${accentColor}55` : '#E5E7EB',
                    backgroundColor: row.active ? `${accentColor}08` : '#F9FAFB',
                    opacity:         row.active ? 1 : 0.55,
                  }}
                >
                  {/* Toggle switch */}
                  <button
                    onClick={() => toggleWeek(row.fw)}
                    className="shrink-0 w-8 h-4 rounded-full transition-colors relative"
                    style={{ backgroundColor: row.active ? accentColor : '#D1D5DB' }}
                    title={row.active ? 'Desativar semana' : 'Ativar semana'}
                  >
                    <span
                      className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                      style={{ left: row.active ? '17px' : '2px' }}
                    />
                  </button>

                  {/* FW label */}
                  <span className="text-xs font-semibold flex-1" style={{ color: row.active ? accentColor : '#9CA3AF' }}>
                    FW{row.fw}
                  </span>

                  {/* Day count stepper */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setDays(row.fw, row.days - 1)}
                      disabled={!row.active || row.days <= 0}
                      className="w-5 h-5 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-xs disabled:opacity-30 disabled:pointer-events-none"
                    >−</button>
                    <span className="w-6 text-center text-xs font-semibold tabular-nums" style={{ color: row.active ? '#111827' : '#9CA3AF' }}>
                      {row.days}
                    </span>
                    <button
                      onClick={() => setDays(row.fw, row.days + 1)}
                      disabled={!row.active || row.days >= 7}
                      className="w-5 h-5 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-xs disabled:opacity-30 disabled:pointer-events-none"
                    >+</button>
                    <span className="text-[10px] text-gray-400 ml-0.5">dias</span>
                  </div>
                </div>
              ))}

              {/* Result chip */}
              {!weekLoading && weekRows.length > 0 && (
                <div
                  className="mt-1 flex items-center justify-between px-3 py-2 rounded-lg border"
                  style={{ backgroundColor: `${accentColor}10`, borderColor: `${accentColor}44` }}
                >
                  <span className="text-[11px] text-gray-600">
                    {activeDays} / {Math.round(totalDaysBaseline)} dias ativos
                  </span>
                  <span className="text-sm font-bold tabular-nums" style={{ color: accentColor }}>
                    {weeklyPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-3 py-2.5 border-t border-gray-100 shrink-0">
          <button
            onClick={() => { onClear(); onClose() }}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
          >
            Remover
          </button>
          <div className="flex gap-2 items-center">
            <span className="text-[11px] text-gray-400 tabular-nums mr-1">
              {activePct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
            </span>
            <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">
              Cancelar
            </button>
            <button
              disabled={tab === 'semanal' && weekLoading}
              onClick={() => { onSave(activePct); onClose() }}
              className="px-3 py-1.5 text-xs text-white rounded font-medium disabled:opacity-50"
              style={{ backgroundColor: accentColor }}
            >
              Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
