import { PhaseMetric } from '@/lib/api'

export function PhasePanel({ phases }: { phases: PhaseMetric[] }) {
  if (!phases.length) return null

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-700">Fases lexicográficas</h3>
      <div className="space-y-1">
        {phases.map((p) => (
          <div key={p.phase} className="flex items-center gap-3 text-xs text-gray-600 bg-gray-50 rounded px-3 py-2">
            <span className="font-medium text-gray-800 w-4">F{p.phase}</span>
            <span className="flex-1 truncate">{p.name}</span>
            <span className={`font-medium ${p.status === 'OPTIMAL' ? 'text-green-600' : 'text-yellow-600'}`}>
              {p.status}
            </span>
            <span>{p.runtime_s.toFixed(1)}s</span>
            {p.mip_gap !== null && (
              <span className="text-gray-400">{(p.mip_gap * 100).toFixed(2)}%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}