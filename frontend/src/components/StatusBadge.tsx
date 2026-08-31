const config = {
  queued:    { label: 'Na fila',    color: 'bg-gray-100 text-gray-700' },
  running:   { label: 'Rodando',    color: 'bg-blue-100 text-blue-700' },
  done:      { label: 'Concluído',  color: 'bg-green-100 text-green-700' },
  error:     { label: 'Erro',       color: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelado',  color: 'bg-yellow-100 text-yellow-700' },
} as const

type Status = keyof typeof config

export function StatusBadge({ status }: { status: string }) {
  const c = config[status as Status] ?? config.queued
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${c.color}`}>
      {c.label}
    </span>
  )
}