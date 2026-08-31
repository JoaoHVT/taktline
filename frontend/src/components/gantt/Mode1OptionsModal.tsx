/**
 * Mode1OptionsModal — secondary dialog shown when the user picks Otimização → Modo 1.
 * Visually a continuation of the primary "Otimizar Schedule" footer menu: same
 * width, purple title bar, body padding, and card styling.
 */
'use client'
import { useState } from 'react'
import { X, Zap, GitBranch, MoveRight, CalendarPlus, Layers } from 'lucide-react'

const PURPLE = '#7B1FA2'

// ES44 WS40↔WS50 swap is NOT a strategy — the optimizer evaluates it automatically in
// every strategy whenever it improves the solution (see schedule_conflict_optimizer.py).
export type Mode1Strategy = 'shift_full' | 'shift_conflict_only'

export interface Mode1Options {
  strategy:     Mode1Strategy
  useSaturdays: boolean
  /** "Permitir regras de sobreposição" (test): a boundary handoff on WS40/WS50 (end of
   *  one LOCO == start of another, max 2 LOCOs) is treated as valid shared-day usage and
   *  not counted/penalized as a conflict. */
  allowOverlap: boolean
}

interface StrategyCard {
  id:    Mode1Strategy
  title: string
  icon:  typeof GitBranch
}

const STRATEGIES: StrategyCard[] = [
  { id: 'shift_full',          title: 'Deslocar Início + Cronograma Completo',     icon: GitBranch },
  { id: 'shift_conflict_only', title: 'Deslocar Apenas Workstations em Conflito',  icon: MoveRight },
]

export interface Mode1OptionsModalProps {
  onCancel:  () => void
  onConfirm: (opts: Mode1Options) => void
}

export function Mode1OptionsModal({ onCancel, onConfirm }: Mode1OptionsModalProps) {
  const [strategy, setStrategy]         = useState<Mode1Strategy>('shift_full')
  const [useSaturdays, setUseSaturdays] = useState(false)
  const [allowOverlap, setAllowOverlap] = useState(false)

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[400px] overflow-hidden">
        {/* Title bar — same as primary "Otimizar Schedule" */}
        <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ background: PURPLE }}>
          <div className="flex items-center gap-2 text-white">
            <Zap size={15} />
            <span className="font-semibold text-sm tracking-wide">Otimizar Schedule — Modo 1</span>
          </div>
          <button
            onClick={onCancel}
            className="rounded p-1 transition-colors hover:bg-white/20 text-white"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col gap-2">
          <p className="text-xs text-gray-500 mb-1">Selecione a estratégia de otimização:</p>

          {STRATEGIES.map(s => {
            const Icon     = s.icon
            const isActive = strategy === s.id
            return (
              <button
                key={s.id}
                onClick={() => setStrategy(s.id)}
                className="flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors border"
                style={
                  isActive
                    ? { borderColor: PURPLE, background: PURPLE, cursor: 'pointer' }
                    : { borderColor: '#E5E7EB', cursor: 'pointer' }
                }
                onMouseEnter={e => { if (!isActive) { const el = e.currentTarget as HTMLElement; el.style.background = '#F3E5F5'; el.style.borderColor = PURPLE } }}
                onMouseLeave={e => { if (!isActive) { const el = e.currentTarget as HTMLElement; el.style.background = ''; el.style.borderColor = '#E5E7EB' } }}
              >
                <Icon size={18} style={{ color: isActive ? '#fff' : PURPLE, flexShrink: 0 }} />
                <span className="flex-1 min-w-0 text-xs font-semibold" style={{ color: isActive ? '#fff' : PURPLE }}>{s.title}</span>
                {isActive && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.25)', color: '#fff' }}>ATIVO</span>}
              </button>
            )
          })}

          {/* Saturdays checkbox — same card shape, slightly more prominent */}
          <label
            className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors mt-1"
            style={{ borderColor: PURPLE, background: useSaturdays ? PURPLE : '#F3E5F5' }}
          >
            <input
              type="checkbox"
              checked={useSaturdays}
              onChange={e => setUseSaturdays(e.target.checked)}
              className="shrink-0"
              style={{ accentColor: useSaturdays ? '#fff' : PURPLE, width: 18, height: 18 }}
            />
            <CalendarPlus size={18} style={{ color: useSaturdays ? '#fff' : PURPLE, flexShrink: 0 }} />
            <span className="flex-1 text-xs font-semibold" style={{ color: useSaturdays ? '#fff' : PURPLE }}>
              Usar Sábados Disponíveis
            </span>
          </label>

          {/* Overlap rules checkbox (test feature) — same card shape as Saturdays */}
          <label
            className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors"
            style={{ borderColor: PURPLE, background: allowOverlap ? PURPLE : '#F3E5F5' }}
          >
            <input
              type="checkbox"
              checked={allowOverlap}
              onChange={e => setAllowOverlap(e.target.checked)}
              className="shrink-0"
              style={{ accentColor: allowOverlap ? '#fff' : PURPLE, width: 18, height: 18 }}
            />
            <Layers size={18} style={{ color: allowOverlap ? '#fff' : PURPLE, flexShrink: 0 }} />
            <span className="flex-1 text-xs font-semibold" style={{ color: allowOverlap ? '#fff' : PURPLE }}>
              Permitir regras de sobreposição
            </span>
          </label>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 mt-2 pt-3" style={{ borderTop: '1px solid #E5E7EB' }}>
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors text-gray-600 hover:bg-gray-50"
              style={{ borderColor: '#D1D5DB' }}
            >
              Cancelar
            </button>
            <button
              onClick={() => onConfirm({ strategy, useSaturdays, allowOverlap })}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors"
              style={{ background: PURPLE }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#6A1B9A' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = PURPLE }}
            >
              Otimizar →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
