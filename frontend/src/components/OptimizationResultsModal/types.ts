import type { OptimizationParams } from '@/components/OptimizeModal'
import type { PersonResultRow } from '@/lib/api'

// ── Override types ────────────────────────────────────────────────────────────

export interface WsnOverrides {
  disabledWsns:      Set<string>
  ignoredBottlenecks: Set<string>
  forcedPeople:      Record<string, string[]>   // wsn → forced people list
  maxPeople:         Record<string, number>      // wsn → max headcount
  maxHours:          Record<string, number>      // wsn → max weekly hours
  maxTurnos:         Record<string, number>      // wsn → max shifts (1–3 override)
}

export interface PersonOverrides {
  disabledPeople:    Set<string>
  forcedToWsn:       Record<string, string[]>   // person → wsn list
  availability:      Record<string, number>     // person → pct (0-100)
}

// ── Row types ─────────────────────────────────────────────────────────────────

export interface WsnResultRow {
  wsn:             string
  desc:            string
  demand_h:        number
  allocated_h:     number
  overtime_h:      number
  utilization_pct: number
  headcount:       number
  bottleneck?:     boolean
  item_qty?:       number
}

export type ViewMode = 'wsn' | 'person'
export type SortMode  = 'demand' | 'alpha'
export type ToolMode  = 'restrict' | 'fix' | null

// ── Shift info ────────────────────────────────────────────────────────────────

export interface WsnShiftInfo {
  turnos: number   // number of shifts (0 = no constraint)
  lm:     number   // max people per shift (0 = no constraint)
  lh:     number   // max hours per shift (0 = no constraint)
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface OptimizationResultsModalProps {
  params?:        OptimizationParams | null
  statusLabel?:   string
  rows?:          WsnResultRow[]
  peopleByWsn?:   Record<string, string[]>
  personRows?:    PersonResultRow[]
  mappedDays?:    number | null
  allocations?:   Record<string, Record<string, number>>
  otAllocations?: Record<string, Record<string, number>>
  /** Shift info per WSN from HeadCount sheet columns TURNOS/LM/LH. */
  wsnShiftInfo?:  Record<string, WsnShiftInfo>
  /** Expertise level per WSN → person NAME (`e[p,w]`), and the bar each WSN sets (`r[w]`).
   *  Display only here — the run either applied them or it did not, and that is decided in
   *  the params, not in this screen. */
  expertise?:     Record<string, Record<string, number>>
  requiredLevel?: Record<string, number>
  isSkillMatrix?: boolean
  /** Fiscal weeks in the current import period (for per-week availability). */
  selectedFws?:   string[]
  /** Initial disabled WSN set (persisted from context). */
  initialDisabledWsns?: Set<string>
  /** Initial ignored bottleneck WSN set (persisted from context). */
  initialIgnoredWsns?:  Set<string>
  /** Initial WSN max people map (persisted from context). */
  initialWsnMaxPeople?: Record<string, number>
  /** Initial WSN max hours map (persisted from context). */
  initialWsnMaxHours?: Record<string, number>
  /** Initial WSN max turnos map (persisted from context). */
  initialWsnMaxTurnos?: Record<string, number>
  /** Initial disabled people set (persisted from context). */
  initialDisabledPeople?: Set<string>
  /** Initial person availability map (persisted from context). */
  initialPersonAvailability?: Record<string, number>
  /** Initial restricted pair cards (wsn::person), persisted across modal reopen. */
  initialRestrictedCards?: Set<string>
  /** Initial fixed pair cards (wsn::person), persisted across modal reopen. */
  initialFixedCards?: Set<string>
  /** Called whenever disabled WSN set changes so parent can persist it. */
  onDisabledWsnsChange?: (s: Set<string>) => void
  /** Called whenever ignored WSN set changes so parent can persist it. */
  onIgnoredWsnsChange?:  (s: Set<string>) => void
  /** Called whenever wsn max people map changes so parent can persist it. */
  onWsnMaxPeopleChange?: (m: Record<string, number>) => void
  /** Called whenever wsn max hours map changes so parent can persist it. */
  onWsnMaxHoursChange?: (m: Record<string, number>) => void
  /** Called whenever wsn max turnos map changes so parent can persist it. */
  onWsnMaxTurnosChange?: (m: Record<string, number>) => void
  /** Called whenever disabled people set changes so parent can persist it. */
  onDisabledPeopleChange?: (s: Set<string>) => void
  /** Called whenever person availability map changes so parent can persist it. */
  onPersonAvailabilityChange?: (m: Record<string, number>) => void
  /** Called whenever restricted cards set changes so parent can persist it. */
  onRestrictedCardsChange?: (s: Set<string>) => void
  /** Called whenever fixed cards set changes so parent can persist it. */
  onFixedCardsChange?: (s: Set<string>) => void
  /** Toggle between Optimization and Skill Matrix display mode. */
  onToggleSkillMatrix?: () => void
  onClose:        () => void
  onRecalculate?: (params: OptimizationParams, overrides: {
    disabledWsnDemand:  Record<string, number>   // 0 for each disabled WSN
    wsnMaxPeople:       Record<string, number>
    wsnMaxHours:        Record<string, number>
    wsnMaxTurnos:       Record<string, number>
    personAvailability: Record<string, number>   // person → pct (0-100)
    disabledPeople:     string[]                 // people to override with 0% availability
    blockedPairs:       Array<[string, string]>  // [wsn, person]
    requiredPairs:      Array<[string, string]>  // [wsn, person]
    forcedPairHeadcount: Record<string, number>  // "wsn|person" → pct
    directPairHeadcount: Record<string, number>  // "wsn|person" → pct
    fixedPairOtPct:      Record<string, number>  // "wsn|person" → pct
    maxPairPct:          Record<string, number>  // "wsn|person" → pct
    maxPairOtPct:        Record<string, number>  // "wsn|person" → pct
  }) => void
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export const VIEW_COLOR: Record<ViewMode, string> = {
  wsn:    '#D32F2F',
  person: '#2E7D32',
}
export const VIEW_BG_LIGHT: Record<ViewMode, string> = {
  wsn:    '#FFEBEE',
  person: '#F0FDF4',
}
export const VIEW_LABEL: Record<ViewMode, string> = {
  wsn:    'Por Workstation',
  person: 'Por Pessoa',
}
