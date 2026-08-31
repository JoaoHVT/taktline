import { SolverWsnResult } from '@/lib/api'

export function WsnTable({ wsns }: { wsns: SolverWsnResult[] }) {
  if (!wsns.length) return null

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {['WSN', 'Demanda (h)', 'Alocado (h)', 'Não atendido (h)', 'Util (%)', 'OT (h)', 'Status'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {wsns.map((row) => (
            <tr
              key={row.wsn}
              className={row.bottleneck ? 'bg-red-50' : undefined}
            >
              <td className="px-4 py-3 font-medium text-gray-900">{row.wsn}</td>
              <td className="px-4 py-3 text-gray-700">{row.demand.toFixed(1)}</td>
              <td className="px-4 py-3 text-gray-700">{row.covered.toFixed(1)}</td>
              <td className={`px-4 py-3 font-medium ${row.bottleneck ? 'text-red-600' : 'text-gray-700'}`}>
                {row.unmet.toFixed(1)}
              </td>
              <td className="px-4 py-3 text-gray-700">{row.util.toFixed(1)}</td>
              <td className="px-4 py-3 text-gray-700">{row.ot_h.toFixed(1)}</td>
              <td className="px-4 py-3">
                {row.bottleneck ? (
                  <span className="text-xs font-medium text-red-600">Gargalo</span>
                ) : (
                  <span className="text-xs font-medium text-green-600">OK</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}