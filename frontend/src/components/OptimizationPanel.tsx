'use client'

import { useState } from 'react'

import { Play, Square, RefreshCw, ChevronDown, AlertTriangle } from 'lucide-react'

import { ProgressBar } from '@/components/ProgressBar'

import { WsnTable }    from '@/components/WsnTable'

import { PhasePanel }  from '@/components/PhasePanel'

import { StatusBadge } from '@/components/StatusBadge'

import { useOptimization } from '@/hooks/useOptimization'

import type { ExcelData, OptimizationPayload } from '@/lib/api'



interface Props {

  excelData: ExcelData

}



export function OptimizationPanel({ excelData }: Props) {

  const { job, run, cancel, isRunning, isDone, isError } = useOptimization()



  const [solver,  setSolver]  = useState<'gurobi' | 'pulp'>('gurobi')

  const [phases,  setPhases]  = useState(6)

  const [gap,     setGap]     = useState(1.0)

  const [time,    setTime]    = useState(60)

  const [topPct,  setTopPct]  = useState(90)

  const [otPct,   setOtPct]   = useState(60)



  function buildPayload(): OptimizationPayload {

    return {

      items:            [],

      top_pct:          topPct,

      ot_day_limit_pct: otPct,

      solver_backend:   solver,

      phase_limit:      phases,

      gap_pct:          gap,

      time_limit_s:     time,

    }

  }



  const wsns        = job?.result?.wsns          ?? []

  const phasesData  = job?.result?.phase_metrics ?? []

  const bottlenecks = wsns.filter(w => w.bottleneck).length

  const finalGap    = job?.result?.final_gap



  const labelClass = 'text-xs text-gray-500'

  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-600 disabled:bg-gray-50'



  return (

    <div className="space-y-6">

      {/* data context reminder */}

      <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-200">

        <span className="font-medium text-gray-700">{excelData.wsn_list.length} WSNs</span>

        <span>·</span>

        <span>{excelData.total_demand_h.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} h demanda total</span>

        <span>·</span>

        <span>{new Set(Object.values(excelData.people_by_wsn).flat()).size} pessoas</span>

      </div>



      {/* Params card */}

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">

        <p className="text-sm font-medium text-gray-700">Parâmetros da otimização</p>



        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">

          {/* Solver */}

          <div className="space-y-1">

            <label className={labelClass}>Solver</label>

            <div className="relative">

              <select

                value={solver}

                onChange={e => setSolver(e.target.value as 'gurobi' | 'pulp')}

                className={inputClass + ' appearance-none'}

                disabled={isRunning}

              >

                <option value="gurobi">Gurobi</option>

                <option value="pulp">PuLP (CBC)</option>

              </select>

              <ChevronDown size={14} className="absolute right-2 top-2.5 text-gray-400 pointer-events-none" />

            </div>

          </div>



          {/* Fases */}

          <div className="space-y-1">

            <label className={labelClass}>Fases lexicogrÃ¡ficas (1â6)</label>

            <input type="number" min={1} max={6} value={phases}

              onChange={e => setPhases(Number(e.target.value))}

              className={inputClass} disabled={isRunning} />

          </div>



          {/* Gap */}

          <div className="space-y-1">

            <label className={labelClass}>MIP gap (%)</label>

            <input type="number" min={0.1} max={100} step={0.1} value={gap}

              onChange={e => setGap(Number(e.target.value))}

              className={inputClass} disabled={isRunning} />

          </div>



          {/* Tempo */}

          <div className="space-y-1">

            <label className={labelClass}>Tempo limite (s)</label>

            <input type="number" min={5} max={3600} value={time}

              onChange={e => setTime(Number(e.target.value))}

              className={inputClass} disabled={isRunning} />

          </div>



          {/* Top % */}

          <div className="space-y-1">

            <label className={labelClass}>Jornada normal (% top)</label>

            <input type="number" min={50} max={100} step={1} value={topPct}

              onChange={e => setTopPct(Number(e.target.value))}

              className={inputClass} disabled={isRunning} />

          </div>



          {/* OT % */}

          <div className="space-y-1">

            <label className={labelClass}>Limite OT/dia (%)</label>

            <input type="number" min={0} max={100} step={1} value={otPct}

              onChange={e => setOtPct(Number(e.target.value))}

              className={inputClass} disabled={isRunning} />

          </div>

        </div>



        {/* Action buttons */}

        <div className="flex flex-wrap gap-3 pt-1">

          <button

            onClick={() => run(buildPayload())}

            disabled={isRunning}

            className="flex items-center gap-2 bg-red-700 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"

          >

            <Play size={15} />

            {isRunning ? 'Otimizando...' : 'Iniciar otimização'}

          </button>



          {isRunning && (

            <button

              onClick={cancel}

              className="flex items-center gap-2 border border-red-300 text-red-600 px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-50 transition-colors"

            >

              <Square size={15} /> Cancelar

            </button>

          )}



          {(isDone || isError) && (

            <button

              onClick={() => run(buildPayload())}

              className="flex items-center gap-2 border border-gray-300 text-gray-600 px-5 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"

            >

              <RefreshCw size={15} /> Reotimizar

            </button>

          )}



          {job && <StatusBadge status={job.status} />}

        </div>

      </div>



      {/* Progress */}

      {job && (isRunning || isDone || isError) && (

        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">

          <ProgressBar value={job.progress} message={job.message} />

          {isError && (

            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2.5">

              <AlertTriangle size={15} className="shrink-0 mt-0.5" />

              {job.error}

            </div>

          )}

        </div>

      )}



      {/* Results */}

      {isDone && job?.result && (

        <div className="space-y-4">

          {/* KPI row */}

          <div className="grid grid-cols-3 gap-4">

            {[

              { label: 'WSNs',      value: wsns.length },

              { label: 'Gargalos',  value: bottlenecks,

                extra: bottlenecks > 0 ? 'text-red-600' : 'text-green-600' },

              { label: 'MIP gap final',

                value: finalGap != null ? `${(finalGap * 100).toFixed(2)}%` : 'â' },

            ].map(card => (

              <div key={card.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">

                <p className={`text-2xl font-bold ${card.extra ?? 'text-gray-900'}`}>{card.value}</p>

                <p className="text-xs text-gray-500 mt-1">{card.label}</p>

              </div>

            ))}

          </div>



          {/* Phase panel */}

          {phasesData.length > 0 && (

            <div className="bg-white rounded-xl border border-gray-200 p-5">

              <PhasePanel phases={phasesData} />

            </div>

          )}



          {/* WSN table */}

          <div className="bg-white rounded-xl border border-gray-200 p-5">

            <p className="text-sm font-medium text-gray-700 mb-3">Alocação por WSN</p>

            <WsnTable wsns={wsns} />

          </div>

        </div>

      )}

    </div>

  )

}

