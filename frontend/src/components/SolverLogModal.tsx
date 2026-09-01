/**
 * SolverLogModal — live Gurobi solver log terminal.
 *
 * Mirrors the QPlainTextEdit progress dialog from the original desktop tool:
 *   - Dark terminal background with monospace log lines
 *   - Real-time progress bar
 *   - Phase lines highlighted in yellow, DONE lines in green, errors in red
 *   - On completion: success banner + "Ver Resultados" button
 *   - On error: error banner + Fechar button
 *   - Cancel button while running
 *
 * Parent is responsible for opening OptimizationResultsModal after onDone().
 */
'use client'
import { useEffect, useRef, useCallback, useMemo } from 'react'
import { X, Square, Terminal, CheckCircle, AlertTriangle } from 'lucide-react'
import type { Job, OptimizationResult } from '@/lib/api'

// ── Log line colorizer ────────────────────────────────────────────────────────

function lineClass(line: string): string {
  if (line.startsWith('[PHASE '))     return 'text-yellow-300'
  if (line.startsWith('[DONE]'))      return 'text-green-300 font-semibold'
  if (line.startsWith('[SETUP]') ||
      line.startsWith('[MODEL]'))     return 'text-cyan-300'
  if (line.startsWith('[OPTIMIZER]')) return 'text-blue-300'
  if (line.startsWith('[SOLVE'))      return 'text-purple-300'
  if (line.startsWith('[DIAG]'))      return 'text-indigo-300'
  if (line.startsWith('[RESULTS]'))  return 'text-emerald-300'
  if (line.includes('ERROR') ||
      line.includes('falhou') ||
      line.includes('Erro'))         return 'text-red-400'
  if (line.startsWith('Gurobi'))     return 'text-gray-300'
  return 'text-green-400'
}

// ── Parse phase completions from log lines ───────────────────────────────────
// Log format: "[PHASE 1] OPTIMAL  obj=0.0000  gap=0.0  t=0.5s"
// The obj/gap fields can be "inf", "nan", or any finite number depending on
// how Gurobi reports the MIP gap (e.g. when abs-gap triggers early termination).
// Use a permissive match for those fields so we never miss a completion line.

interface LivePhase {
  phase:     number
  status:    string
  runtime_s: number
}

function parseLivePhases(logs: string[]): LivePhase[] {
  // Capture: phase number, status keyword, and wall-clock runtime.
  // obj= and gap= fields are matched permissively (\S+) so non-standard values
  // like "inf" or "nan" don't prevent a phase from being marked complete.
  const DONE_RE = /^\[PHASE (\d+)\] (OPTIMAL|TIME_LIMIT|SUBOPTIMAL|INTERRUPTED|STATUS_\d+)\s+obj=\S+\s+gap=\S+\s+t=([\d.]+)s/
  const phases: LivePhase[] = []
  for (const line of logs) {
    const m = DONE_RE.exec(line)
    if (m) {
      phases.push({
        phase:     parseInt(m[1]),
        status:    m[2],
        runtime_s: parseFloat(m[3]),
      })
    }
  }
  return phases
}

/** Returns the phase number currently being optimized (started but not yet completed). */
function parseCurrentPhase(logs: string[], completedPhases: Set<number>): number | null {
  // Start line: "[PHASE 3] Minimizar overtime total..." (no OPTIMAL/STATUS keyword)
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

// ── Parse solver start summary from log lines ────────────────────────────────

interface SolverSummary {
  wsns?:       number
  pessoas?:    number
  fases?:      number
  gap?:        string
  limite?:     string
  pares?:      number
  variaveis?:  number
  restricoes?: number
}

function parseSolverSummary(logs: string[]): SolverSummary {
  const summary: SolverSummary = {}
  const SETUP_RE  = /\[SETUP\] WSNs=(\d+)\s+Pessoas=(\d+)\s+Fases=(\d+)\s+Gap=([\d.]+)%\s+Limite=([\d.]+)s/
  const PAIRS_RE  = /\[SETUP\] Pares qualificados: (\d+)/
  const MODEL_RE  = /\[MODEL\] Total — Variáveis: (\d+)\s+Restrições: (\d+)/
  for (const line of logs) {
    let m = SETUP_RE.exec(line)
    if (m) {
      summary.wsns    = parseInt(m[1])
      summary.pessoas = parseInt(m[2])
      summary.fases   = parseInt(m[3])
      summary.gap     = m[4] + '%'
      summary.limite  = m[5] + 's'
    }
    m = PAIRS_RE.exec(line)
    if (m) summary.pares = parseInt(m[1])
    m = MODEL_RE.exec(line)
    if (m) {
      summary.variaveis  = parseInt(m[1])
      summary.restricoes = parseInt(m[2])
    }
  }
  return summary
}

// ── Solver Summary Card ───────────────────────────────────────────────────────

function SummaryCard({ summary }: { summary: SolverSummary }) {
  const hasAny = Object.keys(summary).length > 0
  if (!hasAny) return null

  const items: { label: string; value: string | number; color?: string }[] = []
  if (summary.wsns       != null) items.push({ label: 'WSNs',         value: summary.wsns })
  if (summary.pessoas    != null) items.push({ label: 'Pessoas',       value: summary.pessoas })
  if (summary.pares      != null) items.push({ label: 'Pares válidos', value: summary.pares })
  if (summary.fases      != null) items.push({ label: 'Fases',         value: summary.fases })
  if (summary.variaveis  != null) items.push({ label: 'Variáveis',     value: summary.variaveis.toLocaleString() })
  if (summary.restricoes != null) items.push({ label: 'Restrições',    value: summary.restricoes.toLocaleString() })
  if (summary.gap        != null) items.push({ label: 'Gap alvo',      value: summary.gap })
  if (summary.limite     != null) items.push({ label: 'Limite/fase',   value: summary.limite })

  return (
    <div className="mx-4 mt-2 mb-2 rounded-lg border border-white/10 bg-[#1a1a2e] px-3 py-2.5 shrink-0">
      <p className="text-[9px] uppercase tracking-widest text-white/40 font-semibold mb-2">Resumo da Otimização</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {items.map(it => (
          <div key={it.label} className="flex items-baseline gap-1">
            <span className="text-[10px] text-white/40">{it.label}:</span>
            <span className={`text-[11px] font-semibold tabular-nums ${it.color ?? 'text-cyan-300'}`}>{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── PhaseStrip ────────────────────────────────────────────────────────────────

function PhaseStrip({
  metrics,
  livePhases,
  totalPhases,
  currentPhase,
}: {
  metrics:      { phase: number; name: string; status: string; runtime_s: number }[]
  livePhases:   LivePhase[]
  totalPhases:  number
  currentPhase: number | null
}) {
  // Prefer final metrics (from result), fall back to live-parsed phases
  const display = metrics.length > 0 ? metrics : livePhases
  const phaseMap = new Map(display.map(m => [m.phase, m]))
  const n = Math.max(totalPhases, display.reduce((mx, m) => Math.max(mx, m.phase), 0))

  // Always render so the strip takes a stable slot in the layout from the start.
  return (
    <div className="flex items-center gap-1 px-4 py-1.5 bg-[#1a1a2e] border-t border-white/10 shrink-0 overflow-x-auto">
      {Array.from({ length: n }, (_, i) => i + 1).map((phase, idx) => {
        const m = phaseMap.get(phase)
        const isRunning = !m && phase === currentPhase
        return (
          <div key={phase} className="flex items-center gap-1 whitespace-nowrap">
            {idx > 0 && <span className="text-white/20 text-[10px]">›</span>}
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors${isRunning ? ' animate-pulse' : ''}`}
              style={{
                backgroundColor: m
                  ? (m.status === 'OPTIMAL'    ? '#1B5E20'
                   : m.status === 'TIME_LIMIT' ? '#E65100'
                   : '#555')
                  : isRunning ? '#1a3a5c' : '#2a2a40',
                color: m ? '#fff' : isRunning ? '#60a5fa' : '#666',
              }}
            >
              F{phase}
            </span>
            {m && <span className="text-[10px] text-white/50">{m.runtime_s.toFixed(1)}s</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  job:            Job | null
  onClose:        () => void
  onCancelRunning: () => void
  onDone:         (result: OptimizationResult) => void
}

export function SolverLogModal({ job, onClose, onCancelRunning, onDone }: Props) {
  const logRef  = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  const logs = job?.log ?? []
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  const isDone      = job?.status === 'done'
  const isError     = job?.status === 'error' || job?.status === 'cancelled'
  const isRunning   = !isDone && !isError
  const phaseData   = (job?.result?.phase_metrics ?? []) as { phase: number; name: string; status: string; runtime_s: number }[]
  const progress    = job?.progress ?? 0
  const message     = job?.message ?? 'Inicializando...'

  // Live parsing
  const parsedPhases = useMemo(() => parseLivePhases(logs), [logs])
  const liveSummary  = useMemo(() => parseSolverSummary(logs), [logs])
  const totalPhases  = liveSummary.fases ?? 6

  // Accumulate completed phases — once a phase is seen it is never removed, even
  // if the backend log buffer truncates early lines (which drops Phase 1/2 from logs).
  const livePhasesRef = useRef<Map<number, LivePhase>>(new Map())
  for (const p of parsedPhases) {
    livePhasesRef.current.set(p.phase, p)
  }
  const livePhases = Array.from(livePhasesRef.current.values()).sort((a, b) => a.phase - b.phase)

  // Current running phase (started but not yet completed) — only relevant while running
  const completedSet = useMemo(() => new Set(Array.from(livePhasesRef.current.keys())), [livePhases])
  const currentPhase = isRunning ? parseCurrentPhase(logs, completedSet) : null

  // Persist summary — merge strategy: new data fills empty fields, but fields we
  // already have are NEVER overwritten.  This survives log truncation where the
  // early [SETUP] line (wsns/pessoas) is lost but the [MODEL] line remains.
  const summaryRef = useRef<SolverSummary>({})
  if (Object.keys(liveSummary).length > 0) {
    summaryRef.current = { ...liveSummary, ...summaryRef.current }
  }
  const summary = summaryRef.current

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  const handleCancel = useCallback(() => {
    onCancelRunning()
  }, [onCancelRunning])

  const handleViewResults = useCallback(() => {
    if (job?.result) onDone(job.result)
  }, [job, onDone])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70">
      <div
        className="flex flex-col bg-[#0f0f23] rounded-xl shadow-2xl border border-white/10 overflow-hidden"
        style={{ width: '88vw', maxWidth: 860, height: '78vh' }}
      >

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#1a1a2e] shrink-0 border-b border-white/10">
          <div className="flex items-center gap-2 text-white">
            <Terminal size={15} className="text-green-400" />
            <span className="font-semibold text-sm">Gurobi Solver — Log de Execução</span>
            {isRunning && (
              <span className="flex items-center gap-1 text-[11px] text-yellow-300 ml-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-ping" />
                Executando...
              </span>
            )}
          </div>
          {!isRunning && (
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
              title="Fechar"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* ── Progress bar ─────────────────────────────────────────────────── */}
        <div className="px-4 pt-2.5 pb-2 bg-[#1a1a2e] shrink-0">
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-[11px] text-white/60 font-mono flex-1 truncate">{message}</span>
            <span className="text-xs font-bold text-white tabular-nums">{progress}%</span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-1.5">
            <div
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                backgroundColor: isDone ? '#4CAF50' : isError ? '#EF4444' : '#0D9488',
              }}
            />
          </div>
        </div>

        {/* ── Phase strip (updates live as phases complete) ────────────── */}
        <PhaseStrip metrics={phaseData} livePhases={livePhases} totalPhases={totalPhases} currentPhase={currentPhase} />

        {/* ── Solver start summary — pinned above log (never scrolls away) ── */}
        <SummaryCard summary={summary} />

        {/* ── Log terminal ─────────────────────────────────────────────────── */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed"
          style={{ backgroundColor: '#0d0d0d' }}
        >
          {/* Log lines */}
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
          </div>{/* end px-4 py-3 */}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="shrink-0 px-4 py-3 border-t border-white/10 bg-[#1a1a2e]">

          {/* Done */}
          {isDone && job?.result && (
            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-center gap-2 bg-green-900/40 border border-green-700/50 rounded-lg px-3 py-2">
                <CheckCircle size={16} className="text-green-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-green-300">Otimização concluída com sucesso!</p>
                  {phaseData.length > 0 && (
                    <p className="text-[11px] text-green-500 mt-0.5">
                      {phaseData.length} fase{phaseData.length !== 1 ? 's' : ''} executadas
                      {job.result.final_gap != null && (
                        <> &nbsp;·&nbsp; GAP final: {(job.result.final_gap * 100).toFixed(3)}%</>
                      )}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={handleViewResults}
                className="px-5 py-2 bg-[#0D9488] hover:bg-[#0F766E] text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                Ver Resultados →
              </button>
            </div>
          )}

          {/* Error */}
          {isError && (
            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-start gap-2 bg-red-900/40 border border-red-700/50 rounded-lg px-3 py-2">
                <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-300">
                  {job?.error ?? job?.message ?? 'Erro durante a otimização.'}
                </p>
              </div>
              <button
                onClick={handleClose}
                className="px-4 py-2 border border-white/20 text-white/70 hover:text-white hover:bg-white/10 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              >
                Fechar
              </button>
            </div>
          )}

          {/* Running */}
          {isRunning && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-white/40 font-mono">
                {logs.length} linhas &nbsp;·&nbsp; {progress}% concluído
              </span>
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 border border-red-700/60 text-red-400 hover:bg-red-900/30 rounded-lg text-sm font-medium transition-colors"
              >
                <Square size={13} />
                Cancelar Solver
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
