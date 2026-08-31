'use client'
import { useMemo, Fragment } from 'react'
import { VIEW_COLOR } from './types'
import { fmt1, fmt0, fmtPct } from './utils'
import type { WsnResultRow, WsnOverrides, ToolMode, WsnShiftInfo } from './types'
import { asLevel, EXPERTISE_LABEL } from '@/lib/expertise'
import { ExpertiseDot } from '@/components/ExpertiseDot'

/**
 * Professional person silhouette icon for shift indicators.
 * shiftIdx 0 = dark/black fill, 1 = white with dark stroke, 2+ = gray
 */
function ShiftIcon({ shiftIdx }: { shiftIdx: number }) {
  const configs = [
    { fill: '#374151', stroke: 'none' },
    { fill: '#FFFFFF', stroke: '#6B7280' },
    { fill: '#9CA3AF', stroke: 'none' },
  ]
  const { fill, stroke } = configs[Math.min(shiftIdx, 2)]
  const sw = stroke !== 'none' ? 1.2 : 0
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }} aria-label={`Turno ${shiftIdx + 1}`}>
      <circle cx="7" cy="4.5" r="2.8" fill={fill} stroke={stroke} strokeWidth={sw} />
      <path d="M1 14 Q1 8.5 7 8.5 Q13 8.5 13 14" fill={fill} stroke={stroke} strokeWidth={sw} />
    </svg>
  )
}

/**
 * Assigns a 0-based shift index to each card in the sorted allocation list.
 * Cards are ordered by allocH desc (as rendered). The first `lm` cards belong
 * to shift 0, the next `lm` to shift 1, etc. If lm=0, all are in shift 0.
 */
function getShiftIndex(cardIndex: number, lm: number): number {
  if (lm <= 0) return 0
  return Math.floor(cardIndex / lm)
}

export function WsnTable({
  rows, color, bgLight, peopleByWsn, expertise = {}, requiredLevel = {}, expanded, onToggle, allocations, otAllocations,
  mappedDays, topPct, wsnOverrides, onContextMenuWsn, isSkillMatrix, onNavigateToPerson,
  activeToolMode, restrictedCards, fixedCards, showRestricted, onCardPaintDown,
  onCardPaintEnter, onRestrictAllByWsn, onCardContextMenu, wsnShiftInfo,
}: {
  rows:              WsnResultRow[]
  color:             string
  bgLight:           string
  peopleByWsn:       Record<string, string[]>
  /** `e[p,w]` per WSN → person, and the bar each WSN sets. Display only. */
  expertise?:        Record<string, Record<string, number>>
  requiredLevel?:    Record<string, number>
  expanded:          Set<string>
  onToggle:          (wsn: string) => void
  allocations?:      Record<string, Record<string, number>>
  otAllocations?:    Record<string, Record<string, number>>
  mappedDays?:       number | null
  topPct?:           number
  wsnOverrides:      WsnOverrides
  onContextMenuWsn:  (e: React.MouseEvent, wsn: string) => void
  isSkillMatrix?:    boolean
  onNavigateToPerson?: (person: string) => void
  activeToolMode?:    ToolMode
  restrictedCards?:   Set<string>
  fixedCards?:        Set<string>
  showRestricted?:    boolean
  onCardPaintDown?:   (wsn: string, person: string) => void
  onCardPaintEnter?:  (wsn: string, person: string) => void
  onRestrictAllByWsn?: (wsn: string) => void
  onCardContextMenu?: (e: React.MouseEvent, wsn: string, person: string) => void
  /** Shift info per WSN: turnos / lm / lh from HeadCount sheet */
  wsnShiftInfo?:      Record<string, WsnShiftInfo>
}) {
  const personTotals = useMemo(() => {
    if (!allocations) return {} as Record<string, number>
    const m: Record<string, number> = {}
    for (const people of Object.values(allocations)) {
      for (const [p, h] of Object.entries(people as Record<string, number>)) {
        m[p] = (m[p] ?? 0) + h
      }
    }
    return m
  }, [allocations])

  const wsnAllocTotals = useMemo(() => {
    if (!allocations) return {} as Record<string, number>
    const m: Record<string, number> = {}
    for (const [wsn, people] of Object.entries(allocations)) {
      m[wsn] = Object.values(people as Record<string, number>).reduce((s, v) => s + v, 0)
    }
    return m
  }, [allocations])

  const grandAllocTotal = useMemo(
    () => Object.values(wsnAllocTotals).reduce((s, v) => s + v, 0),
    [wsnAllocTotals]
  )

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 select-none">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-30">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <span className="text-sm">Nenhum dado de workstation disponível</span>
        <span className="text-[11px] text-gray-300">Execute o solver ou carregue uma simulação para visualizar os resultados.</span>
      </div>
    )
  }

  const thCls = `px-3 py-2 font-semibold text-gray-600 border-b-2 whitespace-nowrap text-xs`

  return (
    <table className="w-full text-xs border-collapse" style={{ cursor: activeToolMode ? 'crosshair' : undefined }}>
      <thead className="sticky top-0 z-10" style={{ backgroundColor: bgLight }}>
        <tr>
          <th className={`${thCls} text-left`} style={{ minWidth: 120, borderBottomColor: color }}>
            Workstation
          </th>
          <th className={`${thCls} text-left w-full`} style={{ borderBottomColor: color }}>
            Descrição
          </th>
          <th className={`${thCls} text-center`} style={{ minWidth: 100, borderBottomColor: color }}>
            Demanda (h)
          </th>
          {!isSkillMatrix && <th className={`${thCls} text-center`} style={{ minWidth: 100, borderBottomColor: color }}>
            Alocado (h)
          </th>}
          {!isSkillMatrix && <th className={`${thCls} text-center`} style={{ minWidth: 100, borderBottomColor: color }}>
            Overtime (h)
          </th>}
          {!isSkillMatrix && <th className={`${thCls} text-center`} style={{ minWidth: 110, borderBottomColor: color }}>
            Utilização (%)
          </th>}
          <th className={`${thCls} text-center`} style={{ minWidth: 90, borderBottomColor: color }}>
            {isSkillMatrix ? 'Pessoas (qtde)' : 'Headcount'}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const isBottleneck = !!r.bottleneck
          const isDisabled   = wsnOverrides.disabledWsns.has(r.wsn)
          const isIgnored    = wsnOverrides.ignoredBottlenecks.has(r.wsn)
          const hasForcedPpl = (wsnOverrides.forcedPeople[r.wsn]?.length ?? 0) > 0
          const hasMaxPpl    = wsnOverrides.maxPeople[r.wsn] != null
          const hasMaxHrs    = wsnOverrides.maxHours[r.wsn]  != null
          const rowBg = isDisabled ? '#F5F5F5'
            : isBottleneck && !isIgnored ? '#FFF3F3'
            : i % 2 === 0 ? '#FFFFFF' : '#FAFAFA'
          const rowOpacity = isDisabled ? 0.45 : isIgnored ? 0.6 : 1
          const dispDemand  = isDisabled ? null : r.demand_h
          const dispAlloc   = isDisabled ? null : r.allocated_h
          const dispOT      = isDisabled ? null : r.overtime_h
          const dispUtil    = isDisabled ? null : r.utilization_pct
          const utilColor =
            dispUtil == null ? '#9CA3AF'
            : dispUtil > 100 ? '#C62828'
            : dispUtil > 85 ? '#E65100'
            : '#1B5E20'
          const allocForWsn    = allocations?.[r.wsn]
          const hasAlloc       = allocForWsn != null && Object.keys(allocForWsn).length > 0
          const allocatedCards = hasAlloc
            ? Object.entries(allocForWsn)
                .map(([person, allocH]) => ({ person, allocH, otH: otAllocations?.[r.wsn]?.[person] ?? 0 }))
                .sort((a, b) => b.allocH - a.allocH)
            : null
          const people         = hasAlloc
            ? allocatedCards!.map(c => c.person)
            : (peopleByWsn[r.wsn] ?? [])
          const displayPeople  = isSkillMatrix ? (peopleByWsn[r.wsn] ?? []) : people
          const skilledPeople = new Set<string>([
            ...(peopleByWsn[r.wsn] ?? []),
            ...Object.keys(allocations?.[r.wsn] ?? {}),
          ])
          const allRestrictedForWsn = skilledPeople.size > 0 && [...skilledPeople].every(p => restrictedCards?.has(`${r.wsn}::${p}`) ?? false)
          const isExpanded = expanded.has(r.wsn)
          const rowLabel = `${r.wsn} - ${r.desc || 'sem descrição'}`
          const rowClickTitle = activeToolMode === 'restrict'
            ? (allRestrictedForWsn
              ? `Remover todas as restrições de ${rowLabel}`
              : `Restringir todas as pessoas de ${rowLabel}`)
            : (displayPeople.length > 0 ? (isExpanded ? 'Recolher pessoas' : `Expandir — ${displayPeople.length} pessoa${displayPeople.length !== 1 ? 's' : ''}`) : undefined)
          const handleRowPrimaryClick = () => {
            if (activeToolMode === 'restrict') { onRestrictAllByWsn?.(r.wsn); return }
            if (displayPeople.length > 0) onToggle(r.wsn)
          }

          return (
            <Fragment key={`${r.wsn}-${i}`}>
              <tr
                data-row-key={r.wsn}
                style={{ backgroundColor: rowBg, opacity: rowOpacity }}
                className="border-b border-gray-100 last:border-0 hover:brightness-95 transition-all"
                onContextMenu={e => { e.preventDefault(); onContextMenuWsn(e, r.wsn) }}
              >
                <td
                  className="px-3 py-2 font-semibold whitespace-nowrap select-none"
                  style={{ color: isBottleneck && !isIgnored && !isDisabled ? '#C62828' : color, cursor: activeToolMode === 'restrict' ? undefined : (displayPeople.length > 0 ? 'pointer' : 'default') }}
                  onClick={handleRowPrimaryClick}
                  title={rowClickTitle}
                >
                  <span className="inline-flex items-center gap-1">
                    {displayPeople.length > 0 && (
                      <span className="text-[9px] text-gray-400 w-2.5 shrink-0">
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    )}
                    {r.wsn}
                    {isBottleneck && !isIgnored && !isDisabled && (
                      <span className="ml-1 inline-flex items-center justify-center px-1 py-0.5 rounded shrink-0"
                            style={{ backgroundColor: '#FFCDD2' }}>
                        <img src="/imagens/warning.png" alt="Gargalo" style={{ width: 12, height: 12 }} />
                      </span>
                    )}
                    {isIgnored && (
                      <span className="ml-1 text-[9px] font-normal text-gray-400 border border-gray-300 px-1 py-0.5 rounded">ignorado</span>
                    )}
                    {isDisabled && (
                      <span className="ml-1 text-[9px] font-normal text-gray-400 border border-gray-300 px-1 py-0.5 rounded">desativada</span>
                    )}
                    {hasForcedPpl && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: '#E3F2FD', color: '#1565C0' }}>
                        {wsnOverrides.forcedPeople[r.wsn].length}p forçada{wsnOverrides.forcedPeople[r.wsn].length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {hasMaxPpl && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: '#FFF8E1', color: '#E65100' }}>
                        máx {wsnOverrides.maxPeople[r.wsn]}p/turno
                      </span>
                    )}
                    {hasMaxHrs && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: '#FBE9E7', color: '#BF360C' }}>
                        máx {wsnOverrides.maxHours[r.wsn]!.toFixed(1)} h
                      </span>
                    )}
                  </span>
                </td>
                <td
                  className="px-3 py-2 text-gray-700"
                  style={{ opacity: isDisabled || isIgnored ? 0.6 : 1 }}
                  onClick={activeToolMode === 'restrict' ? handleRowPrimaryClick : undefined}
                  title={activeToolMode === 'restrict' ? rowClickTitle : undefined}
                >
                  <span>{r.desc || '—'}</span>
                  {isExpanded && (() => {
                    const si = wsnShiftInfo?.[r.wsn]
                    if (!si || si.turnos <= 0) return null
                    return (
                      <span className="ml-2 text-[9px] text-gray-400">
                        <span className="font-semibold" style={{ color: '#C62828' }}>{si.turnos} turno{si.turnos !== 1 ? 's' : ''}</span>
                        {si.lm > 0 && <span> · máx {si.lm} pessoa{si.lm !== 1 ? 's' : ''}/turno</span>}
                        {si.lh > 0 && <span> · máx {si.lh.toFixed(1)} h/turno</span>}
                      </span>
                    )
                  })()}
                </td>
                <td className="px-3 py-2 text-center tabular-nums text-gray-800">
                  {dispDemand != null ? fmt1(dispDemand) : <span className="text-gray-400">—</span>}
                </td>
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-semibold"
                    style={{ color: dispAlloc == null ? '#9CA3AF' : isBottleneck && !isIgnored && !isDisabled ? '#C62828' : '#1B5E20' }}>
                  {dispAlloc != null ? fmt1(dispAlloc) : <span className="text-gray-400">—</span>}
                </td>}
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums"
                    style={{ color: dispOT != null && dispOT > 0 ? '#B45309' : '#9CA3AF' }}>
                  {dispOT != null && dispOT > 0 ? fmt1(dispOT) : <span className="text-gray-400">—</span>}
                </td>}
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-semibold"
                    style={{ color: utilColor }}>
                  {dispUtil != null ? fmtPct(dispUtil) : <span className="text-gray-400">—</span>}
                </td>}
                <td className="px-3 py-2 text-center tabular-nums font-semibold text-gray-800">
                  {isSkillMatrix
                    ? (() => { const cnt = peopleByWsn[r.wsn]?.length ?? 0; return cnt > 0 ? fmt0(cnt) : <span className="text-gray-400">—</span> })()
                    : isDisabled ? <span className="text-gray-400">—</span> : (() => {
                    const capH = mappedDays && mappedDays > 0 && topPct && topPct > 0
                      ? 8.8 * (topPct / 100) * mappedDays
                      : null
                    if (capH && capH > 0) {
                      const hc = r.allocated_h / capH
                      return hc > 0 ? fmt1(hc) : '—'
                    }
                    const p = (allocations?.[r.wsn] != null ? Object.keys(allocations![r.wsn]).length : null)
                      ?? (peopleByWsn[r.wsn]?.length ?? 0)
                    return p > 0 ? fmt0(p) : r.headcount > 0 ? fmt0(r.headcount) : '—'
                  })()
                  }
                </td>
              </tr>

              {isExpanded && (
                <tr style={{ backgroundColor: rowBg, opacity: rowOpacity }}>
                  <td colSpan={isSkillMatrix ? 4 : 7} className="px-3 pb-2 pt-0">

                    <div className="ml-7 flex flex-wrap gap-2 pt-0 pb-0.5">
                      {(!isSkillMatrix && allocatedCards)
                        ? allocatedCards.map((c, cardIdx) => {
                          const si          = wsnShiftInfo?.[r.wsn]
                          const lm          = si?.lm ?? 0
                          const turnos      = si?.turnos ?? 0
                          const sIdx        = (turnos > 0 && lm > 0) ? getShiftIndex(cardIdx, lm) : -1
                          const cardKey        = `${r.wsn}::${c.person}`
                          const isCardRestrict = restrictedCards?.has(cardKey) ?? false
                          const isCardFixed    = fixedCards?.has(cardKey) ?? false
                          if (!showRestricted && isCardRestrict) return null
                          return (
                          <div
                            key={c.person}
                            className="flex flex-col px-2 py-1 rounded transition-all select-none"
                            style={{
                              backgroundColor: isCardRestrict ? '#F5F5F5' : bgLight,
                              border: isCardFixed ? `2px solid ${color}` : `1px solid ${color}33`,
                              minWidth: 120,
                              opacity: isCardRestrict ? 0.45 : 1,
                              cursor: activeToolMode ? 'crosshair' : (onNavigateToPerson ? 'pointer' : 'default'),
                            }}
                            title={activeToolMode
                              ? (activeToolMode === 'restrict'
                                ? (isCardRestrict ? `Clique para remover restrição de ${c.person}` : `Restringir ${c.person}`)
                                : (isCardFixed    ? `Clique para remover fixação de ${c.person}`   : `Fixar ${c.person}`))
                              : (onNavigateToPerson ? `Duplo clique para ver ${c.person} na aba Pessoas` : undefined)
                            }
                            onMouseDown={e => { e.preventDefault(); onCardPaintDown?.(r.wsn, c.person) }}
                            onMouseEnter={() => onCardPaintEnter?.(r.wsn, c.person)}
                            onDoubleClick={() => { if (!activeToolMode) onNavigateToPerson?.(c.person) }}
                            onContextMenu={e => { e.preventDefault(); onCardContextMenu?.(e, r.wsn, c.person) }}
                          >
                            <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: isCardRestrict ? '#9CA3AF' : color }}>
                              {/* Level this person holds HERE, beside the hours they were
                                  given: the card is the one place both facts meet, and a
                                  station covered entirely by low-autonomy people is exactly
                                  what reads as fine on the numbers alone. */}
                              <ExpertiseDot
                                level={expertise[r.wsn]?.[c.person]}
                                size="sm"
                                title={`${c.person} — ${EXPERTISE_LABEL[asLevel(expertise[r.wsn]?.[c.person])]}`
                                  + ` · alvo da ${r.wsn}: ${EXPERTISE_LABEL[asLevel(requiredLevel[r.wsn])]}`}
                              />
                              {c.person}
                              {sIdx >= 0 && (
                                <ShiftIcon shiftIdx={sIdx} />
                              )}
                            </span>
                            <span className="text-[10px] text-gray-400">
                              Alocado: {fmt1(c.allocH)}h{c.otH > 0 && <> | OT: {fmt1(c.otH)}h</>}
                            </span>
                            {(() => {
                              const total = personTotals[c.person] ?? 0
                              const pct   = total > 0 ? c.allocH / total * 100 : null
                              const hpd   = topPct && topPct > 0 ? 8.8 * (topPct / 100) : 8.8
                              const days  = c.allocH / hpd
                              return (
                                <span className="text-[10px] text-gray-400 leading-tight mt-0.5">
                                  {pct != null ? `${pct.toFixed(0)}% do total · ` : ''}{days.toFixed(1)} dias
                                </span>
                              )
                            })()}
                          </div>
                          )
                        })
                        : displayPeople.map(p => (
                          <span
                            key={p}
                            className="text-[11px] px-2 py-0.5 rounded font-medium"
                            style={{ backgroundColor: bgLight, color, border: `1px solid ${color}55` }}
                            onContextMenu={e => { e.preventDefault(); onCardContextMenu?.(e, r.wsn, p) }}
                          >
                            {p}
                          </span>
                        ))
                      }
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}

        {rows.length > 0 && (() => {
          const activeRows = rows.filter(r => !wsnOverrides.disabledWsns.has(r.wsn))
          const td = activeRows.reduce((s, r) => s + r.demand_h,    0)
          const ta = activeRows.reduce((s, r) => s + r.allocated_h, 0)
          const to = activeRows.reduce((s, r) => s + r.overtime_h,  0)
          const au = activeRows.length ? activeRows.reduce((s, r) => s + r.utilization_pct, 0) / activeRows.length : 0
          const th = (() => {
            const capH = mappedDays && mappedDays > 0 && topPct && topPct > 0
              ? 8.8 * (topPct / 100) * mappedDays : null
            if (capH && capH > 0) return activeRows.reduce((s, r) => s + r.allocated_h / capH, 0)
            return activeRows.reduce((s, r) => {
              const p = (peopleByWsn[r.wsn] ?? []).length
              return s + (p > 0 ? p : r.headcount)
            }, 0)
          })()
          const disabledCount = rows.length - activeRows.length
          return (
            <tr className="border-t-2 text-xs font-semibold" style={{ borderTopColor: color, backgroundColor: bgLight }}>
              <td colSpan={2} className="px-3 py-2 text-left text-gray-700">
                TOTAL — {activeRows.length} workstation{activeRows.length !== 1 ? 's' : ''}
                {disabledCount > 0 && <span className="ml-1.5 text-[10px] font-normal text-gray-400">({disabledCount} desativ.)</span>}
              </td>
              <td className="px-3 py-2 text-center tabular-nums text-gray-800">{fmt1(td)}</td>
              {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-bold" style={{ color: '#1B5E20' }}>{fmt1(ta)}</td>}
              {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums" style={{ color: to > 0 ? '#B45309' : '#9CA3AF' }}>
                {to > 0 ? fmt1(to) : '—'}
              </td>}
              {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums" style={{ color: VIEW_COLOR.wsn }}>{fmtPct(au)}</td>}
              <td className="px-3 py-2 text-center tabular-nums text-gray-800">
                {isSkillMatrix
                  ? (() => { const u = new Set<string>(); for (const r of rows) for (const p of (peopleByWsn[r.wsn] ?? [])) u.add(p); return u.size > 0 ? fmt0(u.size) : '—' })()
                  : th > 0 ? fmt1(th) : '—'}
              </td>
            </tr>
          )
        })()}
      </tbody>
    </table>
  )
}
