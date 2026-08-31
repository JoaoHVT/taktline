/**
 * AppFooter — replicates the red KPI status bar from CapB3356103.py MainWindow.
 * Background: WAB_RED (#D32F2F), white text, height ~56px.
 *
 * Mode (Skill / Headcount) is driven by the header’s Headcount dropdown
 * via WorkspaceContext.headcountMode. No local toggle here.
 */
'use client'
import { Circle, AlertTriangle } from 'lucide-react'
import { useWorkspace } from '@/context/WorkspaceContext'
import { useFooterStats } from '@/hooks/useFooterStats'
import { useGanttInlineMaybe } from '@/context/GanttInlineContext'
import { tallySummaryStatuses, todayIsoLocal, type LocoStatus } from '@/components/gantt/locoStatus'
import { APP_NAMES } from '@/lib/appNames'

/** Per-status footer card (Factory Load) — same visual pattern as `Stat`
 *  (label on top, value below) with a colored status icon beside the label.
 *  Counts stay "—" until the status logic lands. */
function StatusStat({ icon, label, value, colorClass }: {
  icon: React.ReactNode; label: string; value: string | number; colorClass: string
}) {
  return (
    <div className="flex flex-col items-center px-3 py-0.5 min-w-[80px]">
      <span className={`flex items-center gap-1 text-[10px] uppercase tracking-wide leading-tight whitespace-nowrap ${colorClass}`}>
        {icon}
        {label}
      </span>
      <span className="text-sm font-bold text-white leading-tight tabular-nums">{value}</span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center px-3 py-0.5 min-w-[80px]">
      <span className="text-[10px] text-red-200 uppercase tracking-wide leading-tight whitespace-nowrap">
        {label}
      </span>
      <span className="text-sm font-bold text-white leading-tight tabular-nums">{value}</span>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 })
}

export function AppFooter({ mode }: { mode?: 'analise' | 'gantt' }) {
  const { headcountMode } = useWorkspace()
  const {
    totalItems, demandaH, disponivelH, alocadoH, gargaloH,
    solverAllocH, solverOvertimeH, solverDisponH, solverTopPct, solverBottleneckQty,
  } = useFooterStats()

  // Factory Load KPIs (gantt mode) — same summary pipeline as the Resumo Geral,
  // computed in GanttInlineContext under the header's Filtros/Datas filters.
  const ganttInline = useGanttInlineMaybe()

  const isSkill = headcountMode === 'skill'
  const dash    = '—'

  const topVal   = isSkill ? dash : (solverTopPct   != null ? `${fmt(solverTopPct)}%` : dash)
  const demVal   = fmt(demandaH)
  const allocVal = isSkill ? dash : (solverAllocH   != null ? fmt(solverAllocH)       : dash)
  const otVal    = isSkill ? dash : (solverOvertimeH != null ? fmt(solverOvertimeH)    : dash)
  const dispVal  = solverDisponH != null ? fmt(solverDisponH) : dash
  const gargVal  = isSkill
    ? dash
    : (solverAllocH != null ? fmt(Math.max(0, demandaH - solverAllocH)) : dash)

  // ── Factory Load footer KPIs (gantt mode) — IDENTICAL formulas to the Resumo
  // Geral header cards; live-update as the header filters change the summary.
  const summary = ganttInline?.summaryTestData ?? null
  const ganttActiveMonths = summary ? Object.values(summary.totalsByYearMonth).filter(h => h > 0).length : 0
  const ganttTotalHours   = summary?.totalHours ?? null
  const ganttAvgPerMonth  = summary && ganttActiveMonths > 0 ? summary.totalHours / ganttActiveMonths : (summary ? 0 : null)
  const ganttAvgPerDay    = summary && summary.businessDaysCount > 0 ? summary.totalHours / summary.businessDaysCount : (summary ? 0 : null)
  const ganttTotalLocos   = summary ? summary.modelGroups.reduce((s, mg) => s + mg.locos.length, 0) : null
  const gVal = (v: number | null) => (v != null ? fmt(v) : dash)

  // Left status bar (gantt mode) — per-locomotive status tallies over the SAME
  // filtered summary the main-tab hierarchy uses, so the footer counts always match
  // the "icon + qty" chips shown on the Tipo/Modelo cards.
  const statusCounts = summary ? tallySummaryStatuses(summary.modelGroups, todayIsoLocal()) : null
  const sVal = (s: LocoStatus) => (statusCounts ? fmt(statusCounts[s]) : dash)

  return (
    // `overflow-x-auto` + `shrink-0` groups: the KPI cards are fixed-width and non-wrapping, so
    // on a narrow viewport the flex row used to compress them until the values collided with
    // their neighbours. Scrolling the bar keeps every card readable at its designed size.
    <footer className="bg-[#D32F2F] flex items-center px-4 shrink-0 relative overflow-x-auto" style={{ minHeight: 56 }}>
      {/* Which app you are in. Absolutely centred rather than placed in the flex flow: the KPI
          groups on either side have different widths, so a flow-centred label would sit
          off-centre and drift as values change. Non-interactive, so it never eats a click
          meant for a KPI behind it, and hidden on narrow screens where the KPIs need the room. */}
      {mode && (
        <span
          className="hidden lg:flex absolute left-1/2 -translate-x-1/2 pointer-events-none select-none
                     items-center rounded-full bg-black/15 px-4 py-1
                     text-[13px] font-bold uppercase tracking-[0.16em] text-white whitespace-nowrap"
        >
          {APP_NAMES[mode]}
        </span>
      )}
      {mode === 'gantt' && (
        <>
          {/* Left status cards — one per locomotive status, mirroring the metric
              cards on the right. Counts arrive with the future status logic. */}
          <div className="flex items-center divide-x divide-red-400 shrink-0">
            <StatusStat icon={<Circle size={10} fill="currentColor" />}  label="Standby"  value={sVal('standby')}  colorClass="text-gray-300" />
            <StatusStat icon={<AlertTriangle size={11} />} label="Em dia"   value={sVal('em_dia')}   colorClass="text-green-300" />
            <StatusStat icon={<AlertTriangle size={11} />} label="Em risco" value={sVal('em_risco')} colorClass="text-orange-300" />
            <StatusStat icon={<AlertTriangle size={11} />} label="Atraso"   value={sVal('atraso')}   colorClass="text-red-300" />
          </div>

          {/* Stretch */}
          <div className="flex-1" />

          {/* Right KPIs — all summary metrics consolidated together
              (same calculations as the Resumo Geral cards) */}
          <div className="flex items-center divide-x divide-red-400 shrink-0">
            <Stat label="LOCOS (qtde)"     value={gVal(ganttTotalLocos)} />
            <Stat label="HORAS TOTAIS (h)" value={gVal(ganttTotalHours)} />
            <Stat label="MEDIA / MES (h)"  value={gVal(ganttAvgPerMonth)} />
            <Stat label="MEDIA / DIA (h)"  value={gVal(ganttAvgPerDay)} />
          </div>
        </>
      )}
      {mode !== 'gantt' && (
        <>
          {/* Left KPIs */}
          <div className="flex items-center divide-x divide-red-400 shrink-0">
            <Stat label="TOTAL DE ITENS (qtde)" value={totalItems} />
            <Stat label="NAO ATENDIDOS (qtde)"  value={solverBottleneckQty ?? (isSkill ? '—' : 0)} />
          </div>

          {/* Stretch */}
          <div className="flex-1" />

          {/* Right KPIs */}
          <div className="flex items-center divide-x divide-red-400 shrink-0">
            <Stat label="TOP (%)"        value={topVal} />
            <Stat label="DEMANDA (h)"    value={demVal} />
            <Stat label="ALOCADO (h)"    value={allocVal} />
            <Stat label="OVERTIME (h)"   value={otVal} />
            <Stat label="DISPONIVEL (h)" value={dispVal} />
            <Stat label="GARGALO (h)"    value={gargVal} />
          </div>
        </>
      )}
    </footer>
  )
}
