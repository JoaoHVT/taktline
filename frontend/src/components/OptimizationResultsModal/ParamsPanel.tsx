'use client'
import { useState } from 'react'
import { RotateCcw, ChevronUp, ChevronDown, GraduationCap } from 'lucide-react'
import type { OptimizationParams } from '@/components/OptimizeModal'
import { PHASE_DESCRIPTIONS, PHASE_DESCRIPTIONS_ALL_HEADCOUNT } from '@/components/OptimizeModal'

// Compact field with label/hint on the LEFT and the stepper inline on the RIGHT.
function CompactField({
  label, hint, value, onChange, min, max, step, decimals,
}: {
  label:    string
  hint?:    string
  value:    number
  onChange: (v: number) => void
  min:      number
  max:      number
  step:     number
  decimals: number
}) {
  return (
    <div className="flex items-center justify-center gap-2.5 min-w-0">
      <div className="flex flex-col min-w-0 text-right">
        <span className="text-xs text-gray-800 font-medium truncate">{label}</span>
        {hint && <span className="text-[10px] text-gray-400 leading-tight truncate">{hint}</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, parseFloat((value - step).toFixed(decimals))))}
          className="w-5 h-5 shrink-0 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-xs select-none"
        >−</button>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v)) onChange(Math.min(max, Math.max(min, parseFloat(v.toFixed(decimals)))))
          }}
          className="w-12 text-center text-xs font-semibold text-gray-900 border border-gray-300 rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-[#0D9488] tabular-nums"
        />
        <button
          type="button"
          onClick={() => onChange(Math.min(max, parseFloat((value + step).toFixed(decimals))))}
          className="w-5 h-5 shrink-0 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-xs select-none"
        >+</button>
      </div>
    </div>
  )
}

export function ParamsPanel({
  params, onChange, onReset, accentColor,
}: {
  params:      OptimizationParams
  onChange:    (p: OptimizationParams) => void
  onReset:     () => void
  accentColor: string
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Description of the LAST selected phase (Phase 5's objective inverts when
  // "usar todo o headcount" is on, so the table is picked per flag).
  const phaseLimit = Math.min(6, Math.max(1, Math.round(params.optimization_phase_limit)))
  const phaseDescription = (
    params.use_all_headcount ? PHASE_DESCRIPTIONS_ALL_HEADCOUNT : PHASE_DESCRIPTIONS
  )[phaseLimit]

  return (
    <div className="border-b border-gray-200 bg-gray-50/80 px-4 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
          Parâmetros da Otimização
        </span>
        <button
          onClick={onReset}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800 transition-colors border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-100"
          title="Restaurar valores anteriores"
        >
          <RotateCcw size={10} />
          Resetar
        </button>
      </div>

      {/* Parâmetros row — 4 columns: OT · TOP · Headcount · (livre), divided */}
      <div className="border border-gray-200 rounded-lg px-2 py-2 mb-2 bg-white">
        <div className="grid grid-cols-4 items-center divide-x divide-gray-200">
          <div className="px-2">
            <CompactField
              label="OT Máx. (h)"
              hint="0 = sem limite"
              value={params.optimization_ot_max_hours}
              onChange={v => onChange({ ...params, optimization_ot_max_hours: Math.round(v) })}
              min={0} max={9999} step={1} decimals={0}
            />
          </div>
          <div className="px-2">
            <CompactField
              label="TOP (%)"
              hint="Produtividade"
              value={params.top_pct}
              onChange={v => onChange({ ...params, top_pct: v })}
              min={1} max={100} step={1} decimals={1}
            />
          </div>
          {/* Usar todo o Headcount Disponível — centered like the others */}
          <div className="px-2">
            <label className="flex items-center justify-center gap-2.5 min-w-0 cursor-pointer select-none">
              <div className="flex flex-col min-w-0 text-right">
                <span className="text-xs text-gray-800 font-medium truncate">Headcount</span>
                <span className="text-[10px] text-gray-400 leading-tight truncate">Usar todo disponível</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="checkbox"
                  checked={params.use_all_headcount}
                  onChange={e => onChange({ ...params, use_all_headcount: e.target.checked })}
                  className="shrink-0"
                  style={{ accentColor, width: 15, height: 15 }}
                />
                {/* "Ativado"/"Desativado" have different widths, so swapping them
                    resized this block and nudged the whole (centered) label. Both
                    strings are stacked in one grid cell: the hidden one reserves
                    the widest width, so the layout never moves. */}
                <span className="grid text-[11px] text-gray-500">
                  <span aria-hidden className="col-start-1 row-start-1 invisible">Desativado</span>
                  <span className="col-start-1 row-start-1">
                    {params.use_all_headcount ? 'Ativado' : 'Desativado'}
                  </span>
                </span>
              </div>
            </label>
          </div>
          {/* Habilitar Expertise — mirrors the launcher's toggle so a re-run from here can flip
              it without going back through OptimizeModal, and carries the same two visual
              states (muted off / accented on). Stacked-label trick as on the Headcount switch
              beside it, for the same reason: no width jump when the word changes. */}
          <div className="px-2">
            <label
              className={`flex items-center justify-center gap-2.5 min-w-0 cursor-pointer select-none rounded-lg border-2 px-2 py-1 transition-colors ${
                params.expertise_enabled ? '' : 'border-transparent'
              }`}
              style={params.expertise_enabled
                ? { borderColor: accentColor, background: `${accentColor}12` }
                : undefined}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <GraduationCap
                  size={13}
                  className="shrink-0"
                  style={{ color: params.expertise_enabled ? accentColor : '#9CA3AF' }}
                />
                <div className="flex flex-col min-w-0 text-right">
                  <span className={`text-xs font-semibold truncate ${params.expertise_enabled ? 'text-gray-900' : 'text-gray-500'}`}>
                    Habilitar Expertise
                  </span>
                  <span className="text-[10px] leading-tight truncate"
                        style={{ color: params.expertise_enabled ? accentColor : '#9CA3AF' }}>
                    Prioriza o nível alvo da WS
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="checkbox"
                  checked={params.expertise_enabled}
                  onChange={e => onChange({ ...params, expertise_enabled: e.target.checked })}
                  className="shrink-0"
                  style={{ accentColor, width: 15, height: 15 }}
                />
                <span className="grid text-[11px] font-semibold"
                      style={{ color: params.expertise_enabled ? accentColor : '#9CA3AF' }}>
                  <span aria-hidden className="col-start-1 row-start-1 invisible">Desativado</span>
                  <span className="col-start-1 row-start-1">
                    {params.expertise_enabled ? 'Ativado' : 'Desativado'}
                  </span>
                </span>
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        className="flex items-center justify-between gap-2 mt-2 mb-1 w-full px-2 py-1.5 rounded-lg bg-gray-100 border border-gray-200 text-[10px] font-semibold text-gray-500 hover:bg-gray-200 transition-colors"
      >
        <span>AVANÇADO</span>
        {showAdvanced ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>

      {showAdvanced && (
        <div className="border border-gray-200 rounded-lg px-2 py-2 mb-1 bg-white">
          {/* Avançado row — 4 columns: GAP · Tempo · Fases · descrição da fase */}
          <div className="grid grid-cols-4 items-center divide-x divide-gray-200">
            <div className="px-2">
              <CompactField
                label="GAP (%)"
                hint="MIP gap por fase"
                value={params.optimization_gap_pct}
                onChange={v => onChange({ ...params, optimization_gap_pct: v })}
                min={0.1} max={100} step={0.1} decimals={1}
              />
            </div>
            <div className="px-2">
              <CompactField
                label="Tempo (s)"
                hint="Máx. por fase"
                value={params.optimization_time_limit_s}
                onChange={v => onChange({ ...params, optimization_time_limit_s: v })}
                min={1} max={3600} step={5} decimals={0}
              />
            </div>
            <div className="px-2">
              <CompactField
                label="Fases"
                hint="Cumulativo (1–6)"
                value={params.optimization_phase_limit}
                onChange={v => onChange({ ...params, optimization_phase_limit: Math.min(6, Math.max(1, Math.round(v))) })}
                min={1} max={6} step={1} decimals={0}
              />
            </div>
            {/* 4th block — o que a ÚLTIMA fase selecionada faz */}
            <div className="px-2 min-w-0">
              <div className="flex flex-col min-w-0 text-center">
                <span className="text-xs text-gray-800 font-medium truncate">
                  Fase {phaseLimit}
                </span>
                <span
                  className="text-[10px] text-gray-400 leading-tight line-clamp-2"
                  title={phaseDescription}
                >
                  {phaseDescription}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Phase strip */}
      <div className="flex items-center gap-1 mt-2.5">
        {Array.from({ length: 6 }, (_, i) => i + 1).map(f => (
          <div
            key={f}
            className="flex-1 h-1 rounded-full transition-colors"
            style={{ backgroundColor: f <= params.optimization_phase_limit ? accentColor : '#E5E7EB' }}
          />
        ))}
      </div>
    </div>
  )
}
