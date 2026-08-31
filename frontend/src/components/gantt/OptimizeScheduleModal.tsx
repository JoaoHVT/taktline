/**
 * OptimizeScheduleModal — dark terminal for Schedule Modo 1 optimization.
 * Mirrors SolverLogModal layout: dark bg, colored log lines, model stats card,
 * phase strip, progress bar. Consumes SSE events from the streaming endpoint.
 */
'use client'
import { useEffect, useRef, useMemo } from 'react'
import { X, Square, Terminal, CheckCircle, AlertTriangle } from 'lucide-react'

// ── Log line colorizer (same rules as SolverLogModal) ────────────────────────

function lineClass(line: string): string {
  if (line.startsWith('[PHASE '))     return 'text-yellow-300'
  if (line.startsWith('[DONE]'))      return 'text-green-300 font-semibold'
  if (line.startsWith('[SETUP]') ||
      line.startsWith('[MODEL]'))     return 'text-cyan-300'
  if (line.startsWith('[OPTIMIZER]')) return 'text-blue-300'
  if (line.startsWith('[RESULTS]'))  return 'text-emerald-300'
  if (line.includes('ERROR') ||
      line.includes('falhou') ||
      line.includes('Erro'))         return 'text-red-400'
  if (line.startsWith('Gurobi'))     return 'text-gray-300'
  return 'text-green-400'
}

// ── Parse phase completions ───────────────────────────────────────────────────

interface LivePhase {
  phase:     number
  status:    string
  runtime_s: number
}

function parseLivePhases(logs: string[]): LivePhase[] {
  const DONE_RE = /^\[PHASE (\d+)\] (OPTIMAL|TIME_LIMIT|SUBOPTIMAL|INTERRUPTED|STATUS_\d+)\s+obj=\S+\s+gap=\S+\s+t=([\d.]+)s/
  const phases: LivePhase[] = []
  for (const line of logs) {
    const m = DONE_RE.exec(line)
    if (m) phases.push({ phase: parseInt(m[1]), status: m[2], runtime_s: parseFloat(m[3]) })
  }
  return phases
}

function parseCurrentPhase(logs: string[], completedPhases: Set<number>): number | null {
  const START_RE = /^\[PHASE (\d+)\] (?!OPTIMAL|TIME_LIMIT|SUBOPTIMAL|INTERRUPTED|STATUS_)/
  let current: number | null = null
  for (const line of logs) {
    const m = START_RE.exec(line)
    if (m) {
      const n = parseInt(m[1])
      if (!completedPhases.has(n)) current = n
    }
  }
  return current
}

// ── Parse model stats from [SETUP]/[MODEL] lines ─────────────────────────────

interface OptSummary {
  modelos?:     number
  locos?:       number
  wsAlvo?:      string
  conflitos?:   number
  clusters?:    number
  variaveis?:   number
  restricoes?:  number
  pdDisp?:      number
}

function parseSummary(logs: string[]): OptSummary {
  const s: OptSummary = {}
  // New format: "[SETUP] Modelos=6  LOCOs=135  WS_alvo=WS40,WS50 ..."
  const SETUP_RE     = /\[SETUP\] Modelos=(\d+)\s+LOCOs=(\d+)\s+WS_alvo=([\w,]+)/
  // Back-compat with the old "[SETUP] LOCOs=N  WS_alvo=..." format.
  const SETUP_OLD_RE = /\[SETUP\] LOCOs=(\d+)\s+WS_alvo=([\w,]+)/
  const MODEL1_RE = /\[MODEL\] Conflitos: (\d+)\s+Clusters: (\d+)/
  const MODEL2_RE = /\[MODEL\] Total — Variáveis: (\d+)\s+Restrições: (\d+)/
  const PD_RE     = /\[MODEL\] Protection Days disponíveis: (\d+)/
  for (const line of logs) {
    let m = SETUP_RE.exec(line)
    if (m) { s.modelos = parseInt(m[1]); s.locos = parseInt(m[2]); s.wsAlvo = m[3] }
    else {
      m = SETUP_OLD_RE.exec(line)
      if (m) { s.locos = parseInt(m[1]); s.wsAlvo = m[2] }
    }
    m = MODEL1_RE.exec(line)
    if (m) { s.conflitos = parseInt(m[1]); s.clusters = parseInt(m[2]) }
    m = MODEL2_RE.exec(line)
    if (m) { s.variaveis = parseInt(m[1]); s.restricoes = parseInt(m[2]) }
    m = PD_RE.exec(line)
    if (m) { s.pdDisp = parseInt(m[1]) }
  }
  return s
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ summary }: { summary: OptSummary }) {
  if (!Object.keys(summary).length) return null
  const items: { label: string; value: string | number }[] = []
  if (summary.modelos    != null) items.push({ label: 'Modelos',     value: summary.modelos })
  if (summary.locos      != null) items.push({ label: 'LOCOs',       value: summary.locos })
  if (summary.wsAlvo     != null) items.push({ label: 'WS alvo',     value: summary.wsAlvo })
  if (summary.conflitos  != null) items.push({ label: 'Conflitos',   value: summary.conflitos })
  if (summary.clusters   != null) items.push({ label: 'Clusters',    value: summary.clusters })
  if (summary.variaveis  != null) items.push({ label: 'Variáveis',   value: summary.variaveis.toLocaleString() })
  if (summary.restricoes != null) items.push({ label: 'Restrições',  value: summary.restricoes.toLocaleString() })
  if (summary.pdDisp     != null) items.push({ label: 'PD disp.',    value: `${summary.pdDisp} LOCOs` })
  return (
    <div className="mx-4 mt-2 mb-2 rounded-lg border border-white/10 bg-[#1a1a2e] px-3 py-2.5 shrink-0">
      <p className="text-[9px] uppercase tracking-widest text-white/40 font-semibold mb-2">Modelo — Modo 1</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {items.map(it => (
          <div key={it.label} className="flex items-baseline gap-1">
            <span className="text-[10px] text-white/40">{it.label}:</span>
            <span className="text-[11px] font-semibold tabular-nums text-cyan-300">{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Phase Strip ───────────────────────────────────────────────────────────────

const TOTAL_PHASES = 5  // Load, Detect, Solve, Verify, Rebuild

function PhaseStrip({ livePhases, currentPhase }: { livePhases: LivePhase[]; currentPhase: number | null }) {
  const phaseMap = new Map(livePhases.map(p => [p.phase, p]))
  return (
    <div className="flex items-center gap-1 px-4 py-1.5 bg-[#1a1a2e] border-t border-white/10 shrink-0 overflow-x-auto">
      {Array.from({ length: TOTAL_PHASES }, (_, i) => i + 1).map((phase, idx) => {
        const m = phaseMap.get(phase)
        const isRunning = !m && phase === currentPhase
        const labels = ['Load', 'Detect', 'Solve', 'Verify', 'Build']
        return (
          <div key={phase} className="flex items-center gap-1 whitespace-nowrap">
            {idx > 0 && <span className="text-white/20 text-[10px]">›</span>}
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors${isRunning ? ' animate-pulse' : ''}`}
              style={{
                backgroundColor: m
                  ? (m.status === 'OPTIMAL' ? '#1B5E20' : m.status === 'TIME_LIMIT' ? '#E65100' : '#555')
                  : isRunning ? '#1a3a5c' : '#2a2a40',
                color: m ? '#fff' : isRunning ? '#60a5fa' : '#666',
              }}
            >
              {labels[idx]}
            </span>
            {m && <span className="text-[10px] text-white/50">{m.runtime_s.toFixed(1)}s</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface OptimizeScheduleModalProps {
  logs:      string[]
  progress:  number
  message:   string
  status:    'running' | 'done' | 'error'
  error?:    string | null
  onCancel:  () => void
  onClose:   () => void
}

export function OptimizeScheduleModal({
  logs,
  progress,
  message,
  status,
  error,
  onCancel,
  onClose,
}: OptimizeScheduleModalProps) {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  const isRunning = status === 'running'
  const isDone    = status === 'done'
  const isError   = status === 'error'

  const parsedPhases = useMemo(() => parseLivePhases(logs), [logs])
  const livePhasesRef = useRef<Map<number, LivePhase>>(new Map())
  for (const p of parsedPhases) livePhasesRef.current.set(p.phase, p)
  const livePhases = Array.from(livePhasesRef.current.values()).sort((a, b) => a.phase - b.phase)
  const completedSet = useMemo(() => new Set(Array.from(livePhasesRef.current.keys())), [livePhases])  // eslint-disable-line react-hooks/exhaustive-deps
  const currentPhase = isRunning ? parseCurrentPhase(logs, completedSet) : null

  const liveSummary = useMemo(() => parseSummary(logs), [logs])
  const summaryRef = useRef<OptSummary>({})
  if (Object.keys(liveSummary).length > 0) {
    summaryRef.current = { ...liveSummary, ...summaryRef.current }
  }
  const summary = summaryRef.current

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70">
      <div
        className="flex flex-col bg-[#0f0f23] rounded-xl shadow-2xl border border-white/10 overflow-hidden"
        style={{ width: '88vw', maxWidth: 860, height: '78vh' }}
      >

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#1a1a2e] shrink-0 border-b border-white/10">
          <div className="flex items-center gap-2 text-white">
            <Terminal size={15} className="text-green-400" />
            <span className="font-semibold text-sm">Schedule Optimizer — Modo 1</span>
            {isRunning && (
              <span className="flex items-center gap-1 text-[11px] text-yellow-300 ml-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-ping" />
                Executando...
              </span>
            )}
          </div>
          {!isRunning && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
              title="Fechar"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="px-4 pt-2.5 pb-2 bg-[#1a1a2e] shrink-0">
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-[11px] text-white/60 font-mono flex-1 truncate">{message || 'Inicializando...'}</span>
            <span className="text-xs font-bold text-white tabular-nums">{progress}%</span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-1.5">
            <div
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                backgroundColor: isDone ? '#4CAF50' : isError ? '#EF4444' : '#D32F2F',
              }}
            />
          </div>
        </div>

        {/* Phase strip */}
        <PhaseStrip livePhases={livePhases} currentPhase={currentPhase} />

        {/* Summary card */}
        <SummaryCard summary={summary} />

        {/* Log terminal */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed"
          style={{ backgroundColor: '#0d0d0d' }}
        >
          <div className="px-4 py-3">
            {logs.length === 0 && (
              <span className="text-gray-600 italic">Aguardando saída do solver...</span>
            )}
            {logs.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap break-all ${lineClass(line)}`}>
                {line}
              </div>
            ))}
            {isRunning && logs.length > 0 && (
              <div className="text-gray-500 animate-pulse mt-1">▌</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-3 border-t border-white/10 bg-[#1a1a2e]">

          {isDone && (
            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-center gap-2 bg-green-900/40 border border-green-700/50 rounded-lg px-3 py-2">
                <CheckCircle size={16} className="text-green-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-green-300">Otimização concluída!</p>
                  <p className="text-[11px] text-green-500 mt-0.5">Schedule atualizado com o resultado otimizado.</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="px-5 py-2 bg-[#D32F2F] hover:bg-[#B71C1C] text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                Ver Schedule →
              </button>
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-start gap-2 bg-red-900/40 border border-red-700/50 rounded-lg px-3 py-2">
                <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-300">{error ?? 'Erro durante a otimização.'}</p>
              </div>
              <button
                onClick={onClose}
                className="px-4 py-2 border border-white/20 text-white/70 hover:text-white hover:bg-white/10 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              >
                Fechar
              </button>
            </div>
          )}

          {isRunning && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-white/40 font-mono">
                {logs.length} linhas &nbsp;·&nbsp; {progress}% concluído
              </span>
              <button
                onClick={onCancel}
                className="flex items-center gap-2 px-4 py-2 border border-red-700/60 text-red-400 hover:bg-red-900/30 rounded-lg text-sm font-medium transition-colors"
              >
                <Square size={13} />
                Cancelar
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
