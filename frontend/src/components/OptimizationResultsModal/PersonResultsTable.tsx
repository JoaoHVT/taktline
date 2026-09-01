'use client'
import { useMemo, Fragment } from 'react'
import type { PersonResultRow } from '@/lib/api'
import { VIEW_COLOR } from './types'
import { fmt1, fmt0, fmtPct } from './utils'
import type { PersonOverrides, SortMode, ToolMode, WsnShiftInfo } from './types'
import { asLevel, EXPERTISE_LABEL } from '@/lib/expertise'
import { ExpertiseDot } from '@/components/ExpertiseDot'

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

function getShiftIndex(cardIndex: number, lm: number): number {
  if (lm <= 0) return 0
  return Math.floor(cardIndex / lm)
}

export function PersonTable({
  peopleByWsn, personRows, wsnDescMap, expertise = {}, requiredLevel = {}, color, bgLight, expanded, onToggle, mappedDays, topPct, allocations, otAllocations,
  personOverrides, allWsns, onContextMenuPerson, sortMode, isSkillMatrix, onNavigateToWsn,
  activeToolMode, restrictedCards, fixedCards, showRestricted, onCardPaintDown, onCardPaintEnter, onRestrictAllByPerson, onCardContextMenu,
  wsnShiftInfo,
}: {
  peopleByWsn:         Record<string, string[]>
  personRows?:         PersonResultRow[]
  wsnDescMap:          Record<string, string>
  /** `e[p,w]` per WSN → person, and the bar each WSN sets. Display only. */
  expertise?:          Record<string, Record<string, number>>
  requiredLevel?:      Record<string, number>
  color:               string
  bgLight:             string
  expanded:            Set<string>
  onToggle:            (person: string) => void
  mappedDays:          number | null
  topPct:              number
  allocations?:        Record<string, Record<string, number>>
  otAllocations?:      Record<string, Record<string, number>>
  personOverrides:     PersonOverrides
  allWsns:             string[]
  onContextMenuPerson: (e: React.MouseEvent, person: string) => void
  sortMode:            SortMode
  isSkillMatrix?:      boolean
  onNavigateToWsn?:    (wsn: string) => void
  activeToolMode?:      ToolMode
  restrictedCards?:     Set<string>
  fixedCards?:          Set<string>
  showRestricted?:      boolean
  onCardPaintDown?:     (wsn: string, person: string) => void
  onCardPaintEnter?:    (wsn: string, person: string) => void
  onRestrictAllByPerson?: (person: string) => void
  onCardContextMenu?:   (e: React.MouseEvent, wsn: string, person: string) => void
  wsnShiftInfo?:        Record<string, WsnShiftInfo>
}) {
  const wsnsByPerson = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const [wsn, people] of Object.entries(peopleByWsn)) {
      for (const p of people) {
        if (!map[p]) map[p] = []
        if (!map[p].includes(wsn)) map[p].push(wsn)
      }
    }
    return map
  }, [peopleByWsn])

  const capacityH: number | null = (mappedDays != null && mappedDays > 0)
    ? 8.8 * (topPct / 100) * mappedDays
    : null

  const hasRealData = personRows != null && personRows.length > 0

  const allPersons = useMemo(() => {
    const baseSet = new Set<string>()
    if (hasRealData) { for (const r of personRows!) baseSet.add(r.person) }
    for (const p of Object.keys(wsnsByPerson)) baseSet.add(p)
    for (const p of Object.keys(personOverrides.forcedToWsn)) baseSet.add(p)
    for (const p of Object.keys(personOverrides.availability)) baseSet.add(p)
    for (const p of personOverrides.disabledPeople) baseSet.add(p)
    for (const key of restrictedCards ?? []) { const parts = key.split('::'); if (parts[1]) baseSet.add(parts[1]) }
    for (const key of fixedCards ?? []) { const parts = key.split('::'); if (parts[1]) baseSet.add(parts[1]) }
    const base = Array.from(baseSet)
    return [...base].sort((a, b) => {
      if (sortMode === 'alpha')
        return a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })
      const ad = personRows?.find(r => r.person === a)?.allocated_h ?? 0
      const bd = personRows?.find(r => r.person === b)?.allocated_h ?? 0
      if (ad !== bd) return bd - ad
      return (wsnsByPerson[b]?.length ?? 0) - (wsnsByPerson[a]?.length ?? 0)
    })
  }, [hasRealData, personRows, wsnsByPerson, sortMode, personOverrides.forcedToWsn, personOverrides.availability, personOverrides.disabledPeople, restrictedCards, fixedCards])

  const personDataMap = useMemo(() => {
    if (!hasRealData) return null
    const m: Record<string, PersonResultRow> = {}
    for (const r of personRows!) m[r.person] = r
    return m
  }, [hasRealData, personRows])

  if (allPersons.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 select-none">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" opacity="0.3">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
        <span className="text-sm font-medium text-gray-500">Nenhuma pessoa mapeada</span>
        <span className="text-xs text-gray-400">Importe os dados do Excel para mapear pessoas por workstation.</span>
      </div>
    )
  }

  const thCls = `px-3 py-2 font-semibold text-gray-600 border-b-2 whitespace-nowrap text-xs`

  const totalCapacity  = capacityH != null ? capacityH * allPersons.length : null
  const totalAllocated = hasRealData ? allPersons.reduce((s, p) => s + (personDataMap?.[p]?.allocated_h ?? 0), 0) : null
  const totalOvertime  = hasRealData ? allPersons.reduce((s, p) => s + (personDataMap?.[p]?.overtime_h ?? 0),  0) : null
  const avgUtil        = hasRealData && allPersons.length > 0
    ? allPersons.reduce((s, p) => s + (personDataMap?.[p]?.utilization_pct ?? 0), 0) / allPersons.length
    : null

  return (
    <table className="w-full text-xs border-collapse">
      <thead className="sticky top-0 z-10" style={{ backgroundColor: bgLight }}>
        <tr>
          <th className={`${thCls} text-left w-full`} style={{ minWidth: 180, borderBottomColor: color }}>
            Pessoa
          </th>
          {!isSkillMatrix && <th className={`${thCls} text-center`} style={{ minWidth: 100, borderBottomColor: color }}>
            Capacidade (h)
          </th>}
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
            Workstations
          </th>
        </tr>
      </thead>
      <tbody>
        {allPersons.map((person, i) => {
          // When Ocultar is active, hide both restricted cards and deactivated people
          if (!showRestricted && personOverrides.disabledPeople.has(person)) return null
          const data = personDataMap?.[person]
          const personWsnCardsRaw = allocations != null
            ? Object.entries(allocations)
                .filter(([, people]) => person in people)
                .map(([wsn, people]) => ({ wsn, allocH: people[person], otH: otAllocations?.[wsn]?.[person] ?? 0 }))
                .sort((a, b) => b.allocH - a.allocH)
            : null
          const personWsnCards = personWsnCardsRaw && personWsnCardsRaw.length > 0 ? personWsnCardsRaw : null
          const wsnsFromData = data?.wsns ?? []
          const wsns = personWsnCards
            ? personWsnCards.map(c => c.wsn)
            : (wsnsFromData.length > 0
                ? [...wsnsFromData].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
                : (wsnsByPerson[person] ?? []).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })))
          const displayWsns = isSkillMatrix
            ? (wsnsByPerson[person] ?? []).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }))
            : wsns
          const isPersonDisabled = personOverrides.disabledPeople.has(person)
          const isExpanded = expanded.has(person)
          const rowBg      = i % 2 === 0 ? '#FFFFFF' : '#FAFAFA'
          const capH       = isPersonDisabled ? null : (data?.capacity_h ?? capacityH)
          const allocH     = isPersonDisabled ? null : (data?.allocated_h ?? (hasRealData ? 0 : null))
          const otH        = isPersonDisabled ? null : (data?.overtime_h  ?? (hasRealData ? 0 : null))
          const utilPct    = isPersonDisabled ? null : (data?.utilization_pct ?? (hasRealData ? 0 : null))
          const isUnallocated = !isPersonDisabled && allocations != null && allocH === 0
          const utilColor  = utilPct == null ? '#9CA3AF'
            : utilPct > 100 ? '#0D9488'
            : utilPct > 85  ? '#E65100'
            : '#1B5E20'
          const allRestrictedForPerson = wsns.length > 0 && wsns.every(w => restrictedCards?.has(`${w}::${person}`) ?? false)
          const rowClickTitle = activeToolMode === 'restrict'
            ? (allRestrictedForPerson
              ? `Remover todas as restrições de ${person}`
              : `Restringir ${person} em todas as workstations alocadas`)
            : (displayWsns.length > 0 ? (isExpanded ? 'Recolher WSNs' : `Expandir — ${displayWsns.length} WSN${displayWsns.length !== 1 ? 's' : ''}`) : undefined)
          const handleRowPrimaryClick = () => {
            if (activeToolMode === 'restrict') { onRestrictAllByPerson?.(person); return }
            if (displayWsns.length > 0) onToggle(person)
          }

          return (
            <Fragment key={person}>
              <tr
                data-row-key={person}
                style={{ backgroundColor: rowBg, opacity: personOverrides.disabledPeople.has(person) ? 0.45 : 1 }}
                className="border-b border-gray-100 last:border-0 hover:brightness-95 transition-all"
                onContextMenu={e => { e.preventDefault(); onContextMenuPerson(e, person) }}
              >
                <td
                  className="px-3 py-2 font-semibold whitespace-nowrap select-none"
                  style={{ color, cursor: activeToolMode === 'restrict' ? undefined : (displayWsns.length > 0 ? 'pointer' : 'default') }}
                  onClick={handleRowPrimaryClick}
                  title={rowClickTitle}
                >
                  <span className="inline-flex items-center gap-1">
                    {displayWsns.length > 0 && (
                      <span className="text-[9px] text-gray-400 w-2.5 shrink-0">
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    )}
                    {isUnallocated && (
                      <img src="/imagens/warning.png" alt="Não alocada" style={{ width: 11, height: 11, opacity: 0.85, flexShrink: 0 }} />
                    )}
                    {person}
                    {personOverrides.disabledPeople.has(person) && (
                      <span className="ml-1 text-[9px] font-normal text-gray-400 border border-gray-300 px-1 py-0.5 rounded">desativada</span>
                    )}
                    {(personOverrides.forcedToWsn[person]?.length ?? 0) > 0 && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: '#E3F2FD', color: '#1565C0' }}>
                        forçada ({personOverrides.forcedToWsn[person].length} WSN)
                      </span>
                    )}
                    {personOverrides.availability[person] != null && !personOverrides.disabledPeople.has(person) && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: '#FFF8E1', color: '#E65100' }}>
                        {personOverrides.availability[person]}% disp.
                      </span>
                    )}
                  </span>
                </td>
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums">
                  {capH != null
                    ? <strong style={{ color }}>{fmt1(capH)}</strong>
                    : <span className="text-gray-400">—</span>}
                </td>}
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-semibold"
                    style={{ color: allocH != null ? '#1B5E20' : '#9CA3AF' }}>
                  {allocH != null ? fmt1(allocH) : <span className="text-gray-400">—</span>}
                </td>}
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums"
                    style={{ color: otH != null && otH > 0 ? '#B45309' : '#9CA3AF' }}>
                  {otH != null && otH > 0 ? fmt1(otH) : <span className="text-gray-400">—</span>}
                </td>}
                {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: utilColor }}>
                  {utilPct != null ? fmtPct(utilPct) : <span className="text-gray-400">—</span>}
                </td>}
                <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: isPersonDisabled ? '#9CA3AF' : color }}>
                  {isPersonDisabled ? <span className="text-gray-400">—</span> : displayWsns.length}
                </td>
              </tr>

              {isExpanded && (
                <tr style={{ backgroundColor: rowBg }}>
                  <td colSpan={isSkillMatrix ? 2 : 6} className="px-3 pb-2 pt-0">
                    <div className="ml-7 flex flex-wrap gap-2 pt-1.5 pb-0.5">
                      {(!isSkillMatrix && personWsnCards)
                        ? personWsnCards.map(c => {
                          const cardKey        = `${c.wsn}::${person}`
                          const isCardRestrict = restrictedCards?.has(cardKey) ?? false
                          const isCardFixed    = fixedCards?.has(cardKey) ?? false
                          if (!showRestricted && isCardRestrict) return null
                          const pctOfPerson = allocH && allocH > 0 ? c.allocH / allocH * 100 : null
                          const hpd         = topPct > 0 ? 8.8 * (topPct / 100) : 8.8
                          const daysEq      = c.allocH / hpd
                          return (
                            <div
                              key={c.wsn}
                              className="flex flex-col px-2 py-1 rounded"
                              style={{
                                backgroundColor: isCardRestrict ? '#F5F5F5' : bgLight,
                                border: isCardFixed ? `2px solid ${color}` : `1px solid ${color}33`,
                                minWidth: 120,
                                opacity: isCardRestrict ? 0.45 : 1,
                                cursor: activeToolMode ? 'crosshair' : (onNavigateToWsn ? 'pointer' : 'default'),
                              }}
                              title={activeToolMode
                                ? (activeToolMode === 'restrict'
                                  ? (isCardRestrict ? `Clique para remover restrição de ${c.wsn}` : `Restringir ${c.wsn}`)
                                  : (isCardFixed ? `Clique para remover fixação de ${c.wsn}` : `Fixar ${c.wsn}`))
                                : (onNavigateToWsn ? `Duplo clique para ver ${c.wsn} na aba Workstation` : undefined)
                              }
                              onMouseDown={e => { e.preventDefault(); onCardPaintDown?.(c.wsn, person) }}
                              onMouseEnter={() => onCardPaintEnter?.(c.wsn, person)}
                              onDoubleClick={() => onNavigateToWsn?.(c.wsn)}
                              onContextMenu={e => { e.preventDefault(); onCardContextMenu?.(e, c.wsn, person) }}
                            >
                              <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color }}>
                                {/* Mirrored: the bar this station sets (hollow) next to what
                                    this person brings to it (filled). */}
                                <ExpertiseDot level={requiredLevel[c.wsn]} variant="requirement" size="sm" />
                                <ExpertiseDot
                                  level={expertise[c.wsn]?.[person]}
                                  size="sm"
                                  title={`${person} em ${c.wsn}: ${EXPERTISE_LABEL[asLevel(expertise[c.wsn]?.[person])]}`
                                    + ` · alvo ${EXPERTISE_LABEL[asLevel(requiredLevel[c.wsn])]}`}
                                />
                                {c.wsn}{wsnDescMap[c.wsn] ? ` — ${wsnDescMap[c.wsn]}` : ''}
                                {(() => {
                                  const si = wsnShiftInfo?.[c.wsn]
                                  if (!si || si.turnos <= 0 || si.lm <= 0 || !allocations) return null
                                  const sortedPeople = Object.entries(allocations[c.wsn] ?? {})
                                    .sort(([, a], [, b]) => (b as number) - (a as number))
                                    .map(([p]) => p)
                                  const personIdx = sortedPeople.indexOf(person)
                                  if (personIdx < 0) return null
                                  return <ShiftIcon shiftIdx={getShiftIndex(personIdx, si.lm)} />
                                })()}
                              </span>
                              <span className="text-[10px] text-gray-400">
                                Alocado: {fmt1(c.allocH)}h{c.otH > 0 && <> | OT: {fmt1(c.otH)}h</>}
                              </span>
                              <span className="text-[10px] text-gray-400 leading-tight mt-0.5">
                                {pctOfPerson != null ? `${pctOfPerson.toFixed(0)}% do total · ` : ''}{daysEq.toFixed(1)} dias
                              </span>
                            </div>
                          )
                        })
                        : displayWsns.map(w => (
                          (() => {
                            const cardKey        = `${w}::${person}`
                            const isCardRestrict = restrictedCards?.has(cardKey) ?? false
                            const isCardFixed    = fixedCards?.has(cardKey) ?? false
                            if (!showRestricted && isCardRestrict) return null
                            return (
                          <span
                            key={w}
                            className="text-[11px] px-2 py-0.5 rounded font-medium select-none"
                            style={{
                              backgroundColor: isCardRestrict ? '#F5F5F5' : bgLight,
                              color,
                              border: isCardFixed ? `2px solid ${color}` : `1px solid ${color}55`,
                              opacity: isCardRestrict ? 0.45 : 1,
                              cursor: activeToolMode ? 'crosshair' : 'default',
                            }}
                            title={activeToolMode
                              ? (activeToolMode === 'restrict'
                                ? (isCardRestrict ? `Clique para remover restrição de ${w}` : `Restringir ${w}`)
                                : (isCardFixed ? `Clique para remover fixação de ${w}` : `Fixar ${w}`))
                              : undefined
                            }
                            onMouseDown={e => { e.preventDefault(); onCardPaintDown?.(w, person) }}
                            onMouseEnter={() => onCardPaintEnter?.(w, person)}
                            onContextMenu={e => { e.preventDefault(); onCardContextMenu?.(e, w, person) }}
                          >
                            {w}{wsnDescMap[w] ? ` — ${wsnDescMap[w]}` : ''}
                          </span>
                            )
                          })()
                        ))
                      }
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}

        {allPersons.length > 0 && (
          <tr className="border-t-2 text-xs font-semibold" style={{ borderTopColor: color, backgroundColor: bgLight }}>
            <td className="px-3 py-2 text-left text-gray-700">
              TOTAL — {allPersons.length} pessoa{allPersons.length !== 1 ? 's' : ''}
            </td>
            {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums">
              {totalCapacity != null
                ? <strong style={{ color }}>{fmt1(totalCapacity)}</strong>
                : <span className="text-gray-400">—</span>}
            </td>}
            {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums font-bold" style={{ color: totalAllocated != null ? '#1B5E20' : '#9CA3AF' }}>
              {totalAllocated != null ? fmt1(totalAllocated) : '—'}
            </td>}
            {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums" style={{ color: totalOvertime != null && totalOvertime > 0 ? '#B45309' : '#9CA3AF' }}>
              {totalOvertime != null && totalOvertime > 0 ? fmt1(totalOvertime) : '—'}
            </td>}
            {!isSkillMatrix && <td className="px-3 py-2 text-center tabular-nums" style={{ color: VIEW_COLOR.person }}>
              {avgUtil != null ? fmtPct(avgUtil) : '—'}
            </td>}
            <td className="px-3 py-2 text-center tabular-nums" style={{ color }}>
              {hasRealData
                ? personRows!.reduce((s, r) => s + r.wsns.length, 0)
                : Object.keys(wsnsByPerson).length}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
