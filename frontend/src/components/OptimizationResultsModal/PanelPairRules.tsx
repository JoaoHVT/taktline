'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { NumberRoller } from './NumberRoller'

export function PanelPairRules({
  wsn, person, desc, accentColor,
  directPct, fixedOtPct, maxPct, maxOtPct,
  onSave, onClear, onClose,
}: {
  wsn:         string
  person:      string
  desc?:       string
  accentColor: string
  directPct:   number | null
  fixedOtPct:  number | null
  maxPct:      number | null
  maxOtPct:    number | null
  onSave: (vals: { directPct: number | null; fixedOtPct: number | null; maxPct: number | null; maxOtPct: number | null }) => void
  onClear: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'allocate' | 'limit'>('allocate')

  const [directEnabled,  setDirectEnabled]  = useState(directPct  !== null)
  const [directVal,      setDirectVal]      = useState<number>(directPct  ?? 100)
  const [fixedOtEnabled, setFixedOtEnabled] = useState(fixedOtPct !== null)
  const [fixedOtVal,     setFixedOtVal]     = useState<number>(fixedOtPct ?? 0)
  const [maxEnabled,     setMaxEnabled]     = useState(maxPct     !== null)
  const [maxVal,         setMaxVal]         = useState<number>(maxPct     ?? 100)
  const [maxOtEnabled,   setMaxOtEnabled]   = useState(maxOtPct   !== null)
  const [maxOtVal,       setMaxOtVal]       = useState<number>(maxOtPct   ?? 0)

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col" style={{ width: 360, maxHeight: '82vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-800">Editar par de alocação</span>
            <span className="text-[11px] text-gray-500 truncate">{person} → {wsn}{desc ? ` — ${desc}` : ''}</span>
          </div>
          <button onClick={onClose} className="rounded p-0.5 hover:bg-gray-100 shrink-0 ml-2"><X size={14} /></button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-gray-200 shrink-0">
          {(['allocate', 'limit'] as const).map(t => (
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
              {t === 'allocate' ? 'Alocar' : 'Limitar'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-5">
          {tab === 'allocate' && (
            <div className="flex gap-6 justify-center">
              {/* Hrs normais */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setDirectEnabled(e => !e)}
                    className="shrink-0 w-8 h-4 rounded-full transition-colors relative"
                    style={{ backgroundColor: directEnabled ? accentColor : '#D1D5DB' }}
                  >
                    <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                      style={{ left: directEnabled ? '17px' : '2px' }} />
                  </button>
                  <span className="text-[11px] font-medium whitespace-nowrap"
                    style={{ color: directEnabled ? '#374151' : '#9CA3AF' }}>Hrs normais</span>
                </div>
                <div style={{ opacity: directEnabled ? 1 : 0.3, pointerEvents: directEnabled ? 'auto' : 'none' }}>
                  <NumberRoller value={directVal} min={0} max={150} step={5} onChange={setDirectVal} textColor={directEnabled ? accentColor : undefined} />
                </div>
                <span className="text-[11px] tabular-nums font-semibold"
                  style={{ color: directEnabled ? accentColor : '#D1D5DB' }}>
                  {directEnabled ? `${directVal}%` : '—'}
                </span>
              </div>
              <div className="w-px bg-gray-200 self-stretch" />
              {/* Hrs extras */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setFixedOtEnabled(e => !e)}
                    className="shrink-0 w-8 h-4 rounded-full transition-colors relative"
                    style={{ backgroundColor: fixedOtEnabled ? accentColor : '#D1D5DB' }}
                  >
                    <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                      style={{ left: fixedOtEnabled ? '17px' : '2px' }} />
                  </button>
                  <span className="text-[11px] font-medium whitespace-nowrap"
                    style={{ color: fixedOtEnabled ? '#374151' : '#9CA3AF' }}>Hrs extras</span>
                </div>
                <div style={{ opacity: fixedOtEnabled ? 1 : 0.3, pointerEvents: fixedOtEnabled ? 'auto' : 'none' }}>
                  <NumberRoller value={fixedOtVal} min={0} max={150} step={5} onChange={setFixedOtVal} textColor={fixedOtEnabled ? accentColor : undefined} />
                </div>
                <span className="text-[11px] tabular-nums font-semibold"
                  style={{ color: fixedOtEnabled ? accentColor : '#D1D5DB' }}>
                  {fixedOtEnabled ? `${fixedOtVal}%` : '—'}
                </span>
              </div>
            </div>
          )}

          {tab === 'limit' && (
            <div className="flex gap-6 justify-center">
              {/* Hrs normais */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setMaxEnabled(e => !e)}
                    className="shrink-0 w-8 h-4 rounded-full transition-colors relative"
                    style={{ backgroundColor: maxEnabled ? accentColor : '#D1D5DB' }}
                  >
                    <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                      style={{ left: maxEnabled ? '17px' : '2px' }} />
                  </button>
                  <span className="text-[11px] font-medium whitespace-nowrap"
                    style={{ color: maxEnabled ? '#374151' : '#9CA3AF' }}>Hrs normais</span>
                </div>
                <div style={{ opacity: maxEnabled ? 1 : 0.3, pointerEvents: maxEnabled ? 'auto' : 'none' }}>
                  <NumberRoller value={maxVal} min={0} max={150} step={5} onChange={setMaxVal} textColor={maxEnabled ? accentColor : undefined} />
                </div>
                <span className="text-[11px] tabular-nums font-semibold"
                  style={{ color: maxEnabled ? accentColor : '#D1D5DB' }}>
                  {maxEnabled ? `${maxVal}%` : '—'}
                </span>
              </div>
              <div className="w-px bg-gray-200 self-stretch" />
              {/* Hrs extras */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setMaxOtEnabled(e => !e)}
                    className="shrink-0 w-8 h-4 rounded-full transition-colors relative"
                    style={{ backgroundColor: maxOtEnabled ? accentColor : '#D1D5DB' }}
                  >
                    <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all"
                      style={{ left: maxOtEnabled ? '17px' : '2px' }} />
                  </button>
                  <span className="text-[11px] font-medium whitespace-nowrap"
                    style={{ color: maxOtEnabled ? '#374151' : '#9CA3AF' }}>Hrs extras</span>
                </div>
                <div style={{ opacity: maxOtEnabled ? 1 : 0.3, pointerEvents: maxOtEnabled ? 'auto' : 'none' }}>
                  <NumberRoller value={maxOtVal} min={0} max={150} step={5} onChange={setMaxOtVal} textColor={maxOtEnabled ? accentColor : undefined} />
                </div>
                <span className="text-[11px] tabular-nums font-semibold"
                  style={{ color: maxOtEnabled ? accentColor : '#D1D5DB' }}>
                  {maxOtEnabled ? `${maxOtVal}%` : '—'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 px-3 py-2.5 border-t border-gray-100 shrink-0">
          <button
            onClick={() => { onClear(); onClose() }}
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700"
          >Limpar regras</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700">Cancelar</button>
            <button
              onClick={() => {
                onSave({
                  directPct:  directEnabled  ? directVal  : null,
                  fixedOtPct: fixedOtEnabled ? fixedOtVal : null,
                  maxPct:     maxEnabled     ? maxVal     : null,
                  maxOtPct:   maxOtEnabled   ? maxOtVal   : null,
                })
                onClose()
              }}
              className="px-3 py-1.5 text-xs text-white rounded font-medium"
              style={{ backgroundColor: accentColor }}
            >Salvar</button>
          </div>
        </div>

      </div>
    </div>
  )
}
