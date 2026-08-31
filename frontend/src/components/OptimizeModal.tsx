/**
 * OptimizeModal — two-step optimization launcher.
 *
 * Step 1 (mode select): "Rodar Solver" | "Estado Atual" | Cancelar
 * Step 2 (params):      TOP %, GAP %, Tempo (s), Fases (1–6)
 *
 * Mirrors _prompt_optimization_execution_parameters() from CapB3356103.py.
 * Defaults: TOP 90 %, GAP 2 %, Tempo 60 s, Fases 6.
 */
'use client'
import { useState } from 'react'
import {
  X, Play, BarChart2, ChevronLeft, AlertTriangle, ChevronDown, ChevronUp, GraduationCap,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OptimizationParams {
  top_pct:                    number   // 1..100
  optimization_gap_pct:       number   // 0.1..100
  optimization_time_limit_s:  number   // 1..3600
  optimization_phase_limit:   number   // 1..6
  optimization_ot_max_hours:  number   // 0 = sem limite
  use_all_headcount:          boolean  // edited in the results screen (ParamsPanel)
  /** Expertise mapping (`e[p,w]` vs `r[w]`) applied to THIS run. Off ⇒ the person↔workstation
   *  relationship stays the boolean it has always been and the run is the old one, unchanged.
   *  Levels are registered in the Headcount tab; see lib/expertise.ts. */
  expertise_enabled:          boolean
}

type Step = 'mode' | 'confirm' | 'params'

/**
 * One-line résumé of each lexicographic phase, mirroring the objective names in
 * backend/services/optimizer.py (`phase_plan`). Rendered for the LAST selected
 * phase so the user knows what the extra phase buys. Consumed by ParamsPanel
 * (Otimização → Parâmetros → Avançados, 4th block).
 *
 * With `use_all_headcount` on, the backend both flips phase 5's objective AND runs it
 * BEFORE the balance phase — see PHASE_DESCRIPTIONS_ALL_HEADCOUNT. These strings describe
 * the stage at each POSITION, so they follow the swap.
 */
export const PHASE_DESCRIPTIONS: Record<number, string> = {
  1: 'Cobrir toda a demanda',
  2: 'Priorizar WSNs difíceis',
  3: 'Reduzir overtime e picos',
  4: 'Equilibrar carga entre pessoas',
  5: 'Menos pessoas e pares abertos',
  6: 'Suavizar utilização',
}

/** Overrides applied when `use_all_headcount` is on: activation runs in the 4th position and
 *  the load balancing in the 5th, over the people it just activated. */
export const PHASE_DESCRIPTIONS_ALL_HEADCOUNT: Record<number, string> = {
  ...PHASE_DESCRIPTIONS,
  4: 'Usar o máximo de pessoas',
  5: 'Equilibrar carga entre todos',
}

// ── NumberField helper ────────────────────────────────────────────────────────

function NumberField({
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
    <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-100 last:border-0">
      <div className="flex flex-col min-w-0">
        <span className="text-sm text-gray-800 font-medium">{label}</span>
        {hint && <span className="text-[11px] text-gray-400 leading-tight">{hint}</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, parseFloat((value - step).toFixed(decimals))))}
          className="w-6 h-6 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-sm select-none"
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
          className="w-16 text-center text-sm font-semibold text-gray-900 border border-gray-300 rounded py-0.5 focus:outline-none focus:ring-1 focus:ring-[#D32F2F] tabular-nums"
        />
        <button
          type="button"
          onClick={() => onChange(Math.min(max, parseFloat((value + step).toFixed(decimals))))}
          className="w-6 h-6 rounded border border-gray-300 bg-white hover:bg-gray-100 flex items-center justify-center text-gray-600 font-bold text-sm select-none"
        >+</button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  onClose:           () => void
  onRunSolver:       (params: OptimizationParams) => void
  onEstadoAtual?:    () => void
  hasPreviousResult?: boolean
}

export function OptimizeModal({ onClose, onRunSolver, onEstadoAtual, hasPreviousResult }: Props) {
  const [step, setStep] = useState<Step>('mode')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Param state — mirrors CapB3356103.py defaults
  const [topPct,    setTopPct]    = useState(90.0)
  const [gapPct,    setGapPct]    = useState(2.0)
  const [timeLimit, setTimeLimit] = useState(60.0)
  const [phases,    setPhases]    = useState(6)
  const [otMax,     setOtMax]     = useState(0)   // 0 = sem limite
  // Defaults OFF: with it off the run is bit-for-bit the run this app has always produced, so
  // turning expertise on is always a deliberate act and never a silent change of results.
  const [expertise, setExpertise] = useState(false)

  function handleRunSolver() {
    onRunSolver({
      top_pct:                    topPct,
      optimization_gap_pct:       gapPct,
      optimization_time_limit_s:  timeLimit,
      optimization_phase_limit:   phases,
      optimization_ot_max_hours:  otMax,
      use_all_headcount:          false,  // toggled later in the results screen
      expertise_enabled:          expertise,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[92vw] max-w-sm overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#D32F2F] shrink-0">
          {step === 'params' ? (
            <button
              onClick={() => setStep(hasPreviousResult ? 'confirm' : 'mode')}
              className="rounded p-1 hover:bg-white/20 transition-colors text-white"
              title="Voltar"
            >
              <ChevronLeft size={16} />
            </button>
          ) : step === 'confirm' ? (
            <button
              onClick={() => setStep('mode')}
              className="rounded p-1 hover:bg-white/20 transition-colors text-white"
              title="Voltar"
            >
              <ChevronLeft size={16} />
            </button>
          ) : (
            <div className="w-6" />
          )}
          <span className="font-semibold text-sm text-white tracking-wide">
            {step === 'mode' ? 'Otimização' : step === 'confirm' ? 'Confirmar Otimização' : 'Parâmetros do Solver'}
          </span>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-white/20 transition-colors"
            title="Cancelar"
          >
            <X size={16} className="text-white" />
          </button>
        </div>

        {/* ── Step 1: Mode selection ──────────────────────────────────────── */}
        {step === 'mode' && (
          <div className="flex flex-col gap-3 px-5 py-5">
            <p className="text-xs text-gray-500 leading-relaxed">
              Escolha como deseja prosseguir com a otimização de alocação.
            </p>

            {/* Rodar Solver */}
            <button
              onClick={() => hasPreviousResult ? setStep('confirm') : setStep('params')}
              className={`flex items-center gap-3 px-4 py-3.5 rounded-lg border-2 transition-colors text-left group ${
                hasPreviousResult
                  ? 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                  : 'border-[#D32F2F] bg-red-50 hover:bg-red-100'
              }`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                hasPreviousResult ? 'bg-gray-200' : 'bg-[#D32F2F]'
              }`}>
                <Play size={14} className={hasPreviousResult ? 'text-gray-600 ml-0.5' : 'text-white ml-0.5'} />
              </div>
              <div>
                <div className={`text-sm font-semibold ${hasPreviousResult ? 'text-gray-700' : 'text-gray-900'}`}>Rodar Solver</div>
                <div className={`text-[11px] leading-tight ${hasPreviousResult ? 'text-gray-400' : 'text-gray-500'}`}>
                  Configurar parâmetros e iniciar a otimização
                </div>
              </div>
            </button>

            {/* Estado Atual */}
            <button
              onClick={() => { onEstadoAtual?.(); onClose() }}
              className={`flex items-center gap-3 px-4 py-3.5 rounded-lg border-2 transition-colors text-left group ${
                hasPreviousResult
                  ? 'border-[#D32F2F] bg-red-50 hover:bg-red-100'
                  : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
              }`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                hasPreviousResult ? 'bg-[#D32F2F]' : 'bg-gray-200'
              }`}>
                <BarChart2 size={14} className={hasPreviousResult ? 'text-white' : 'text-gray-600'} />
              </div>
              <div>
                <div className={`text-sm font-semibold ${hasPreviousResult ? 'text-gray-900' : 'text-gray-700'}`}>Estado Atual</div>
                <div className={`text-[11px] leading-tight ${hasPreviousResult ? 'text-gray-500' : 'text-gray-400'}`}>
                  Visualizar métricas sem rodar o solver
                </div>
              </div>
            </button>

            {/* Cancel */}
            <button
              onClick={onClose}
              className="mt-1 text-xs text-gray-400 hover:text-gray-600 transition-colors self-center underline underline-offset-2"
            >
              Cancelar
            </button>
          </div>
        )}

        {/* ── Step 1b: Confirm re-run ─────────────────────────────────────── */}
        {step === 'confirm' && (
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
              <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-amber-800">Substituir otimização anterior?</span>
                <span className="text-xs text-amber-700 leading-relaxed">
                  Já existe um resultado de otimização salvo. Rodar o solver novamente irá substituí-lo.
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setStep('params')}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-[#D32F2F] bg-red-50 hover:bg-red-100 transition-colors text-left"
              >
                <div className="w-7 h-7 rounded-full bg-[#D32F2F] flex items-center justify-center shrink-0">
                  <Play size={12} className="text-white ml-0.5" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Sim, rodar novamente</div>
                  <div className="text-[11px] text-gray-500 leading-tight">Continuar para os parâmetros do solver</div>
                </div>
              </button>
              <button
                onClick={() => setStep('mode')}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
              >
                <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                  <ChevronLeft size={14} className="text-gray-600" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-700">Voltar</div>
                  <div className="text-[11px] text-gray-400 leading-tight">Cancelar e voltar ao menu</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Params ─────────────────────────────────────────────── */}
        {step === 'params' && (
          <div className="flex flex-col px-5 py-4 gap-0">

            <p className="text-[11px] text-gray-400 leading-relaxed mb-3">
              Defina o TOP%, o overtime máximo e (opcionalmente) os parâmetros avançados.
            </p>

            <NumberField
              label="TOP (%)"
              hint="Produtividade"
              value={topPct}
              onChange={setTopPct}
              min={1} max={100} step={1} decimals={1}
            />
            <NumberField
              label="OT Máx. (h)"
              hint="0 = sem limite"
              value={otMax}
              onChange={v => setOtMax(Math.round(v))}
              min={0} max={9999} step={1} decimals={0}
            />

            {/* Habilitar Expertise — NOT under "avançadas", and not a row like the numbers
                above: it changes WHO may be allocated at all, which is a different order of
                decision from a gap or a time limit. Card treatment, and the card itself
                carries the state — muted grey when off, accented and tinted when on — so
                whether the run will respect expertise is readable without finding the
                checkbox. */}
            <label
              className={`mt-2 flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border-2 cursor-pointer select-none transition-colors ${
                expertise
                  ? 'border-[#D32F2F] bg-[#FEF2F2]'
                  : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors"
                  style={{ background: expertise ? '#D32F2F' : '#E5E7EB' }}
                >
                  <GraduationCap size={14} className={expertise ? 'text-white' : 'text-gray-500'} />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className={`text-sm font-semibold ${expertise ? 'text-gray-900' : 'text-gray-500'}`}>
                    Habilitar Expertise
                  </span>
                  <span className={`text-[11px] leading-tight truncate ${expertise ? 'text-[#D32F2F]' : 'text-gray-400'}`}>
                    Prioriza nível alvo de expertise
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="checkbox"
                  checked={expertise}
                  onChange={e => setExpertise(e.target.checked)}
                  style={{ accentColor: '#D32F2F', width: 16, height: 16 }}
                />
                <span className={`grid text-[11px] font-semibold ${expertise ? 'text-[#D32F2F]' : 'text-gray-400'}`}>
                  <span aria-hidden className="col-start-1 row-start-1 invisible">Desativado</span>
                  <span className="col-start-1 row-start-1">{expertise ? 'Ativado' : 'Desativado'}</span>
                </span>
              </div>
            </label>

            {/* Advanced toggle */}
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center justify-between gap-2 mt-3 mb-1 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-xs font-semibold text-gray-500 hover:bg-gray-100 transition-colors"
            >
              <span>OPÇÕES AVANÇADAS</span>
              {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {/* Collapsible advanced section */}
            {showAdvanced && (
              <div className="border border-gray-200 rounded-lg px-3 py-2 mb-2 bg-gray-50 flex flex-col gap-1">

                <NumberField
                  label="GAP (%)"
                  hint="MIP gap por fase"
                  value={gapPct}
                  onChange={setGapPct}
                  min={0.1} max={100} step={0.1} decimals={1}
                />
                <NumberField
                  label="Tempo (s)"
                  hint="Máx. por fase"
                  value={timeLimit}
                  onChange={setTimeLimit}
                  min={1} max={3600} step={5} decimals={0}
                />

                {/* Fases — full-width row, same style as GAP/Tempo above */}
                <NumberField
                  label="Fases"
                  hint="Cumulativo (1–6)"
                  value={phases}
                  onChange={v => setPhases(Math.min(6, Math.max(1, Math.round(v))))}
                  min={1} max={6} step={1} decimals={0}
                />

                {/* Phase visualizer */}
                <div className="flex items-center gap-1 mt-1 mb-0.5">
                  {Array.from({ length: 6 }, (_, i) => i + 1).map(f => (
                    <div
                      key={f}
                      className="flex-1 h-1.5 rounded-full transition-colors"
                      style={{ backgroundColor: f <= phases ? '#D32F2F' : '#E5E7EB' }}
                    />
                  ))}
                </div>
                {/* Fase 1 · o que a fase selecionada faz · Fase 6 */}
                <div className="flex items-baseline justify-between gap-2 text-[10px] text-gray-400 mb-1">
                  <span className="shrink-0">Fase 1</span>
                  <span
                    className="min-w-0 flex-1 text-center truncate text-gray-500"
                    title={`Fase ${phases}: ${PHASE_DESCRIPTIONS[phases]}`}
                  >
                    {PHASE_DESCRIPTIONS[phases]}
                  </span>
                  <span className="shrink-0">Fase 6</span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 justify-end mt-2">
              <button
                onClick={() => setStep('mode')}
                className="px-4 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 transition-colors text-gray-700 font-medium"
              >
                Voltar
              </button>
              <button
                onClick={handleRunSolver}
                className="px-5 py-1.5 text-xs text-white rounded hover:opacity-90 transition-opacity font-semibold flex items-center gap-1.5"
                style={{ backgroundColor: '#D32F2F' }}
              >
                <Play size={11} className="ml-0.5" />
                Iniciar
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
