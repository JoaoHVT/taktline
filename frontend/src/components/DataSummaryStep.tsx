import { BarChart2, Users, Clock, Layers, RotateCcw } from 'lucide-react'

import type { ExcelData } from '@/lib/api'



interface Props {

  data:    ExcelData

  onReset: () => void

}



function StatCard({ icon, label, value, sub }: {

  icon:  React.ReactNode

  label: string

  value: string | number

  sub?:  string

}) {

  return (

    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3">

      <div className="mt-0.5 text-red-700">{icon}</div>

      <div>

        <p className="text-2xl font-bold text-gray-900">{value}</p>

        <p className="text-xs font-medium text-gray-600 mt-0.5">{label}</p>

        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}

      </div>

    </div>

  )

}



export function DataSummaryStep({ data, onReset }: Props) {

  const { demand_by_wsn, people_by_wsn, capacity_by_person, wsn_list, total_demand_h } = data



  const uniquePeople = new Set(Object.values(people_by_wsn).flat()).size



  // build demand rows sorted by demand desc

  const demandRows = wsn_list

    .map(wsn => ({

      wsn,

      demand:  demand_by_wsn[wsn] ?? 0,

      people:  people_by_wsn[wsn]?.length ?? 0,

      pct:     total_demand_h > 0 ? ((demand_by_wsn[wsn] ?? 0) / total_demand_h) * 100 : 0,

    }))

    .sort((a, b) => b.demand - a.demand)



  const filters = data.filters_applied

  const filterDesc = [

    filters.ano    ? `Ano ${filters.ano}`    : null,

    filters.mes    ? `Mês ${filters.mes}`    : null,

    filters.escopo ? `Escopo ${filters.escopo}` : null,

  ].filter(Boolean).join(' · ') || 'Sem filtros'



  return (

    <div className="space-y-6">

      {/* summary bar */}

      <div className="flex items-center justify-between">

        <div>

          <p className="text-xs text-gray-400">

            <span className="font-medium text-gray-600">{data.sheets_loaded.join(', ')}</span>

            {' · '}

            {filterDesc}

            {' · '}

            {data.preview.rows.toLocaleString('pt-BR')} linhas brutas

          </p>

          <p className="text-sm text-green-700 font-medium mt-0.5">{data.message}</p>

        </div>

        <button

          onClick={onReset}

          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"

        >

          <RotateCcw size={12} /> Reimportar

        </button>

      </div>



      {/* KPI cards */}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

        <StatCard

          icon={<Layers size={20} />}

          label="WSNs com demanda"

          value={wsn_list.length}

        />

        <StatCard

          icon={<Clock size={20} />}

          label="Demanda total"

          value={`${total_demand_h.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} h`}

        />

        <StatCard

          icon={<Users size={20} />}

          label="Pessoas únicas"

          value={uniquePeople}

          sub={`${Object.keys(capacity_by_person).length} com capacidade mapeada`}

        />

        <StatCard

          icon={<BarChart2 size={20} />}

          label="Média por WSN"

          value={`${wsn_list.length ? (total_demand_h / wsn_list.length).toFixed(0) : 0} h`}

        />

      </div>



      {/* WSN demand table */}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

        <div className="px-4 py-3 border-b border-gray-100">

          <p className="text-sm font-medium text-gray-700">Demanda por WSN</p>

        </div>

        <div className="overflow-y-auto max-h-72">

          <table className="min-w-full divide-y divide-gray-100 text-sm">

            <thead className="bg-gray-50 sticky top-0">

              <tr>

                {['WSN', 'Demanda (h)', 'Pessoas', '% do total', ''].map(h => (

                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">

                    {h}

                  </th>

                ))}

              </tr>

            </thead>

            <tbody className="divide-y divide-gray-50">

              {demandRows.map(row => (

                <tr key={row.wsn} className="hover:bg-gray-50">

                  <td className="px-4 py-2.5 font-medium text-gray-900">{row.wsn}</td>

                  <td className="px-4 py-2.5 text-gray-700">{row.demand.toFixed(1)}</td>

                  <td className="px-4 py-2.5 text-gray-500">{row.people}</td>

                  <td className="px-4 py-2.5 text-gray-500">{row.pct.toFixed(1)}%</td>

                  <td className="px-4 py-2.5 w-32">

                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">

                      <div

                        className="h-1.5 bg-red-600 rounded-full"

                        style={{ width: `${row.pct}%` }}

                      />

                    </div>

                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      </div>

    </div>

  )

}

