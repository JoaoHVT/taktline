export type PnRow = {
  pn: string
  desc: string
  hoursByYearMonth: Record<string, number>
  hoursByFw: Record<string, number>
  total: number
}

export type SummaryAreaRow = {
  area: string
  locos: number
  workstations: {
    key: string
    label: string
    hoursByYearMonth: Record<string, number>
    hoursByFw: Record<string, number>
    total: number
    partNumbers: PnRow[]
  }[]
  hoursByYearMonth: Record<string, number>
  hoursByFw: Record<string, number>
  total: number
}

export type LocoRow = {
  loco: string
  linha: string
  tipoGeral: string
  minISO: string
  finishMS: string
  hours: number
  takt?: number
  startMs?: string | number | null
  /** Model resolved via the locomotive-model fallback ⇒ display "(FB)". */
  fallback?: boolean
  hoursByYearMonth: Record<string, number>
  hoursByFw: Record<string, number>
}

export type ModelGroup = {
  model: string
  locos: LocoRow[]
  /** Any loco in the group used a fallback model ⇒ display "(FB)". */
  fallback?: boolean
  totalHours: number
  hoursByYearMonth: Record<string, number>
  hoursByFw: Record<string, number>
}

export type SummaryTestResult = {
  areas: SummaryAreaRow[]
  monthBusinessDays: Record<string, number>
  totalsByYearMonth: Record<string, number>
  totalHours: number
  wsCount: number
  locosCount: number
  modelsCount: number
  fwsCount: number
  businessDaysCount: number
  activeYearMonths: string[]
  activeFws: string[]
  fwBusinessDays: Record<string, number>
  modelGroups: ModelGroup[]
}

export type StatsResult = {
  businessDays: number
  fws: number
  locos: number
  models: number
  wsDistinct: number
  hours: number
  parts: number
  totalItems: number
}
