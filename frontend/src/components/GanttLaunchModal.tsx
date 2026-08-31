'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { X, BarChart2, Layers, Loader2, FlaskConical, GitCompare, AlertTriangle } from 'lucide-react'
import { getGanttData, postGanttScenario } from '@/lib/api'
import type { GanttData } from '@/lib/api'
import { getToken, refreshToken } from '@/lib/tokenStore'
import { LocomotiveProgress, LINE_TYPE_COLORS } from './gantt/LocomotiveProgress'
import { TIPOS, TIPO_KEYS, TIPO_NO_SCHEDULE_NOTE, DEFAULT_TIPO_KEY, anyScheduleBacked } from '@/lib/tipos'
import { SUMMARY_LINE_TYPE_MAP } from './gantt/useGanttFilters'
import { useFileDrop } from '@/lib/useFileDrop'
import { checkUploadSize } from '@/lib/uploadLimits'
import type { AxiosError } from 'axios'

// Tracks the last time Gantt data was freshly fetched — used to skip redundant silent refreshes
// This is the same module-level ref as in GanttModal; they share state via the parent's cache prop
let _ganttDataFetchedAt = 0
export { _ganttDataFetchedAt }

// ── Date input helpers ────────────────────────────────────────────────────────

export function formatDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

export function expandYear(val: string): string {
  if (val.length !== 8) return val
  const parts = val.split('/')
  if (parts.length !== 3 || parts[2].length !== 2) return val
  const [dd, mm, yy] = parts
  const yyyy = parseInt(yy, 10) <= 30 ? `20${yy}` : `19${yy}`
  return `${dd}/${mm}/${yyyy}`
}

export function ddmmToISO(dmy: string): string {
  const [dd, mm, rawYY] = dmy.split('/')
  if (!rawYY || !mm || !dd) return ''
  const yyyy = rawYY.length === 2
    ? (parseInt(rawYY, 10) <= 30 ? `20${rawYY}` : `19${rawYY}`)
    : rawYY
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

export function clampDate(val: string, min: string, max: string): string {
  if (val.length !== 10 && val.length !== 8) return val
  const iso = ddmmToISO(val)
  if (!iso) return val
  const minISO = ddmmToISO(min), maxISO = ddmmToISO(max)
  if (minISO && iso < minISO) return min
  if (maxISO && iso > maxISO) return max
  return val
}

// ── GanttLaunchModal ──────────────────────────────────────────────────────────

// Tab labels for the "resume in …" hint on the launch button — must stay in sync
// with the TABS array in GanttModal.
const TAB_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: 'Resumo Geral', 1: 'GETSA Planned', 2: 'Plano de Produção', 3: 'Schedule Geral',
}

// Flavour text shown under the locomotive band while it loads — one is picked per load so
// repeated opens read a little differently. Kept to what the app is actually doing (plus a
// couple of light railway lines), so it informs rather than just decorates. Portuguese, to
// match the rest of the modal.
const LOAD_MESSAGES = [
  'Engatando as locomotivas…',
  'Construindo o cronograma…',
  'Carregando a hierarquia de workstations…',
  'Calculando os dados de planejamento…',
  'Alinhando os vagões nos trilhos…',
  'Liberando o sinal na via…',
]
// When the heavy Schedule module is preloading we KNOW the phase, so we say so instead of
// rolling a generic line.
const SCHEDULE_MESSAGES = [
  'Preparando o Master Schedule…',
  'Construindo o Master Schedule…',
]
// Same idea for a selection that has no Schedule behind it at all (GCR alone): the wait is the
// published plan, so the caption names it instead of talking about a cronograma being built.
const GCR_MESSAGES = [
  'Carregando o plano GCR publicado…',
  'Lendo o plano de serviços…',
]
const pickMessage = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)]

export function GanttLaunchModal({
  onClose, onOpen, ganttCache, onDataLoaded,
  schedulePreloading = false, scheduleProgress = 0,
  initialFrom = '', initialTo = '',
  initialLineTypes, onLineTypesChange,
  persistedScenarioData = null, persistedScenarioName = '',
  onScenarioChange, tokenReady,
  onCompareConfirm,
  comparisonActive = false, comparisonBaseName = '', comparisonTargetName = '',
  onComparisonRemove,
  scheduleEnabled = false, onScheduleEnabledChange, lastTab = 0,
}: {
  onClose:             () => void
  onOpen:              (tab: 0 | 1 | 2 | 3, dateFrom?: string, dateTo?: string, lineFilter?: string[], scenarioOverride?: GanttData | null, scenarioOverrideName?: string) => void
  ganttCache?:         GanttData | null
  onDataLoaded?:       (d: GanttData) => void
  schedulePreloading?: boolean
  scheduleProgress?:   number
  initialFrom?:        string
  initialTo?:          string
  initialLineTypes?:   string[]
  onLineTypesChange?:  (types: string[]) => void
  persistedScenarioData?: GanttData | null
  persistedScenarioName?: string
  onScenarioChange?:   (data: GanttData | null, name: string) => void
  tokenReady?: 'pending' | 'ok' | 'reauth-required'
  loadedFrom?: string
  loadedTo?: string
  /** Confirm callback for the scenario-comparison flow. Hands the parent two fully
   *  resolved scenarios (Base + Target) plus the period/line selection so it can load
   *  both into memory and open the Gantt in comparison mode (Resumo Geral). */
  onCompareConfirm?: (
    baseData: GanttData, baseName: string,
    targetData: GanttData, targetName: string,
    lineFilter: string[] | undefined, dateFrom?: string, dateTo?: string,
  ) => void
  /** Comparison mode is armed (two scenarios loaded). Shows the status block below the
   *  action buttons with the Base/Target names and a Remove action. */
  comparisonActive?: boolean
  comparisonBaseName?: string
  comparisonTargetName?: string
  /** Clears both comparison scenarios and returns to the single-scenario workflow. */
  onComparisonRemove?: () => void
  /** Whether the heavy Schedule module is loaded / its tab is accessible (persisted). */
  scheduleEnabled?: boolean
  /** Toggle the Schedule module on/off (persisted by the parent). */
  onScheduleEnabledChange?: (enabled: boolean) => void
  /** Tab the user last viewed — the launch button re-opens here (defaults to Resumo Geral). */
  lastTab?: 0 | 1 | 2 | 3
}) {
  const [dateFrom, setDateFrom] = useState(initialFrom)
  const [dateTo,   setDateTo]   = useState(initialTo)
  // Year quick-filter: when set, the period inputs are filled with that year's full
  // available range. Cleared (→ '') whenever the user edits the period manually.
  const [selYear,  setSelYear]  = useState('')
  const [loadingFor,   setLoadingFor]   = useState<0 | 1 | 2 | 3 | null>(null)
  const [loadProgress, setLoadProgress] = useState(0)
  const [launchError,  setLaunchError]  = useState<string | null>(null)
  const [cacheLoading, setCacheLoading] = useState(!ganttCache && !persistedScenarioData)
  const bgFetchRef = useRef<Promise<GanttData | null> | null>(null)

  function extractErrorMessage(err: unknown): string {
    const fallback = 'Falha ao carregar dados do Gantt.'
    const ax = err as AxiosError<{ detail?: string }>
    const detail = ax?.response?.data?.detail
    if (detail && typeof detail === 'string' && detail.trim()) return detail
    const msg = ax?.message
    if (msg && typeof msg === 'string' && msg.trim()) return msg
    return fallback
  }

  // DEFAULT: New Locos alone. It used to be every schedule-backed Tipo, which made the standard
  // open the most expensive one there is — four Tipos laid out before the user had asked for
  // anything — and put the heavy-load warning on screen for a selection nobody made. New Locos is
  // the line this app is opened for; the rest are one click away. A remembered selection
  // (`initialLineTypes`) still wins: this is only what a first open starts from.
  const [selLineTypes, setSelLineTypes] = useState<Set<string>>(
    () => new Set<string>(initialLineTypes?.length ? initialLineTypes : [DEFAULT_TIPO_KEY]))
  const [scenarioData,    setScenarioData]    = useState<GanttData | null>(persistedScenarioData ?? null)
  const [scenarioName,    setScenarioName]    = useState<string>(persistedScenarioName ?? '')
  const [scenarioLoading, setScenarioLoading] = useState(false)
  const [scenarioError,   setScenarioError]   = useState<string | null>(null)
  const scenarioInputRef = useRef<HTMLInputElement>(null)

  // ── Comparar Cenário (Base + Target) ────────────────────────────────────────
  type CompareSlot = { useDb: boolean; data: GanttData | null; name: string; loading: boolean; error: string | null }
  const emptySlot = (useDb: boolean): CompareSlot => ({ useDb, data: null, name: '', loading: false, error: null })
  const [showCompare, setShowCompare] = useState(false)
  // Default per confirmed decision: Base = Database, Target = upload.
  const [cmpBase,   setCmpBase]   = useState<CompareSlot>(() => emptySlot(true))
  const [cmpTarget, setCmpTarget] = useState<CompareSlot>(() => emptySlot(false))
  const cmpBaseInputRef   = useRef<HTMLInputElement>(null)
  const cmpTargetInputRef = useRef<HTMLInputElement>(null)

  function isAuthError(err: unknown): boolean {
    const status = (err as AxiosError)?.response?.status
    return status === 401 || status === 403
  }

  async function handleCompareUpload(which: 'base' | 'target', file: File) {
    const setSlot = which === 'base' ? setCmpBase : setCmpTarget
    // 40 MB ceiling, matching the server's. Checked before the request so the refusal is
    // immediate instead of a 413 arriving at the end of the upload — see lib/uploadLimits.
    const tooBig = checkUploadSize(file)
    if (tooBig) { setSlot(s => ({ ...s, loading: false, error: tooBig })); return }
    setSlot(s => ({ ...s, loading: true, error: null }))
    try {
      // The axios interceptor already performs silent reauth + retry on a 401, so a
      // successful upload "just works" even across a token expiry.
      const data = await postGanttScenario(file)
      setSlot(s => ({ ...s, data, name: file.name, loading: false, error: null }))
    } catch (err: unknown) {
      // Never surface a token/auth error inside Compare. If reauth genuinely failed,
      // the app-level re-login (driven by tokenReady) handles it on the previous Gantt
      // screen; here we just clear the spinner so the user can retry after re-auth —
      // their other scenario selection is preserved.
      if (isAuthError(err)) {
        setSlot(s => ({ ...s, loading: false, error: null }))
        return
      }
      setSlot(s => ({ ...s, data: null, name: '', loading: false, error: extractErrorMessage(err) }))
    }
  }

  // A slot is "ready" when it has a resolved source: DB (cache present) or an upload.
  const slotReady = (s: CompareSlot) => s.useDb ? !!ganttCache : !!s.data

  function resolveSlot(s: CompareSlot): { data: GanttData; name: string } | null {
    if (s.useDb) return ganttCache ? { data: ganttCache, name: 'Banco de dados' } : null
    return s.data ? { data: s.data, name: s.name } : null
  }

  function handleCompareConfirm() {
    if (!compareValid) return
    const b = resolveSlot(cmpBase)
    const t = resolveSlot(cmpTarget)
    if (!b || !t) return
    const allLinhas = Object.values(LINE_TYPE_MAP).flat()
    const activeLinhas = Object.entries(LINE_TYPE_MAP)
      .filter(([key]) => selLineTypes.has(key))
      .flatMap(([, linhas]) => linhas)
    const lineFilter = activeLinhas.length < allLinhas.length ? activeLinhas : undefined
    onCompareConfirm?.(b.data, b.name, t.data, t.name, lineFilter, dateFrom || undefined, dateTo || undefined)
    setShowCompare(false)
  }

  // Tipo → the Schedule Linhas it asks the backend for. Straight off the registry, so this
  // and the summary's own line-type map cannot state different Linhas for the same Tipo.
  const LINE_TYPE_MAP: Record<string, string[]> = SUMMARY_LINE_TYPE_MAP

  // ── Is there a Schedule to load at all? ─────────────────────────────────────
  // A Tipo with no Schedule behind it (GCR) contributes no Linha and therefore no groups. With
  // ONLY such Tipos selected the Schedule module would build over an empty set: the toggle would
  // be on, several seconds and a lot of memory would go into the heavy module, and the tab it
  // unlocked would open blank. So the toggle is disabled and reads as off for that selection —
  // the user's stored preference is untouched and returns the moment a schedule-backed Tipo is
  // picked again.
  const scheduleApplicable = anyScheduleBacked(selLineTypes)
  const scheduleOn = scheduleEnabled && scheduleApplicable

  /** THREE OR MORE Tipos at once AND the Schedule module on — see the speech bubble beside the
   *  chips. The threshold is `>= 3`, not `> 3`: the third Tipo is already where the Schedule build
   *  starts costing real time and memory, so the advice has to arrive before the fourth. */
  const heavyLoadWarning = scheduleOn && selLineTypes.size >= 3

  // ── Heavy-load bubble placement ─────────────────────────────────────────────
  // The advice used to be a banner INSIDE the modal body, which pushed the launch controls down
  // and stretched the card every time it appeared. It is now a comment balloon anchored OUTSIDE
  // the card, beside the Tipos row it is talking about, so showing it changes no layout at all.
  // The card is `overflow-hidden`, so this cannot be an absolute child of it — the bubble is
  // `position: fixed`, measured off the Tipos row (the overlay itself never scrolls).
  const typesRowRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [bubble, setBubble] = useState<{ top: number; left: number; side: 'right' | 'left' } | null>(null)
  const BUBBLE_W = 236
  const BUBBLE_GAP = 14
  useEffect(() => {
    if (!heavyLoadWarning) { setBubble(null); return }
    const row = typesRowRef.current
    if (!row) return
    const measure = () => {
      const r = row.getBoundingClientRect()
      // Prefer the right of the card; flip to the left when the viewport has no room there, so a
      // narrow window never pushes the advice off screen.
      const fitsRight = r.right + BUBBLE_GAP + BUBBLE_W <= window.innerWidth - 8
      setBubble({
        top: r.top + r.height / 2,
        left: fitsRight ? r.right + BUBBLE_GAP : Math.max(8, r.left - BUBBLE_GAP - BUBBLE_W),
        side: fitsRight ? 'right' : 'left',
      })
    }
    measure()
    // The card grows and shrinks with the error banners and the loading band above this row, and
    // the modal is centred, so anything that changes its height moves the anchor.
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    if (cardRef.current) ro.observe(cardRef.current)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [heavyLoadWarning])

  function toggleLineType(key: string) {
    if (selLineTypes.has(key) && selLineTypes.size <= 1) return
    const n = new Set(selLineTypes)
    n.has(key) ? n.delete(key) : n.add(key)
    setSelLineTypes(n)
    onLineTypesChange?.([...n])
  }

  useEffect(() => {
    if (ganttCache) return
    let cancelled = false
    const p: Promise<GanttData | null> = getGanttData()
      .then(d => { if (!cancelled) { _ganttDataFetchedAt = Date.now(); onDataLoaded?.(d) }; return d })
      .catch((err: unknown) => { if (!cancelled) setLaunchError(extractErrorMessage(err)); return null as GanttData | null })
    bgFetchRef.current = p
    p.finally(() => { bgFetchRef.current = null; if (!cancelled) setCacheLoading(false) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const _prevTokenRef = useRef(tokenReady)
  useEffect(() => {
    const prev = _prevTokenRef.current
    _prevTokenRef.current = tokenReady
    if (tokenReady !== 'ok' || prev === 'ok') return
    if (!ganttCache && launchError && !bgFetchRef.current) {
      setLaunchError(null)
      setCacheLoading(true)
      const p: Promise<GanttData | null> = getGanttData()
        .then(d => { _ganttDataFetchedAt = Date.now(); onDataLoaded?.(d); return d })
        .catch((err: unknown) => { setLaunchError(extractErrorMessage(err)); return null as GanttData | null })
      bgFetchRef.current = p
      p.finally(() => { bgFetchRef.current = null; setCacheLoading(false) })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenReady])

  useEffect(() => {
    if (loadingFor === null) return
    const interval = setInterval(() => {
      setLoadProgress(p => p < 85 ? Math.min(85, p + (85 - p) * 0.07 + 0.5) : p)
    }, 80)
    return () => clearInterval(interval)
  }, [loadingFor])

  // Drag & drop targets — each funnels into the same upload handler as its button,
  // so validation, progress and error handling are shared.
  const XLS_EXT = ['.xlsx', '.xls']
  const scenarioDrop = useFileDrop({
    onFile:   f => { void handleScenarioUpload(f) },
    accept:   XLS_EXT,
    disabled: scenarioLoading || loadingFor !== null,
    onReject: setScenarioError,
  })
  const cmpBaseDrop = useFileDrop({
    onFile:   f => { void handleCompareUpload('base', f) },
    accept:   XLS_EXT,
    disabled: cmpBase.loading,
    onReject: msg => setCmpBase(s => ({ ...s, error: msg })),
  })
  const cmpTargetDrop = useFileDrop({
    onFile:   f => { void handleCompareUpload('target', f) },
    accept:   XLS_EXT,
    disabled: cmpTarget.loading,
    onReject: msg => setCmpTarget(s => ({ ...s, error: msg })),
  })

  async function handleScenarioUpload(file: File) {
    const tooBig = checkUploadSize(file)
    if (tooBig) { setScenarioError(tooBig); return }
    setScenarioLoading(true); setScenarioError(null)
    try {
      const data = await postGanttScenario(file)
      setScenarioData(data); setScenarioName(file.name)
      onScenarioChange?.(data, file.name)
    } catch (err: unknown) {
      setScenarioError(extractErrorMessage(err))
      setScenarioData(null); setScenarioName('')
      onScenarioChange?.(null, '')
    } finally { setScenarioLoading(false) }
  }

  const fromISO = ddmmToISO(expandYear(dateFrom))
  const toISO   = ddmmToISO(expandYear(dateTo))
  const periodValid = Boolean(fromISO && toISO && fromISO <= toISO)

  // Comparar Cenário validity — independent from the period. The period can be defined
  // (or changed) before or after confirming; order does not matter. Confirm needs only
  // two valid, distinct-source scenarios.
  const cmpBothDb = cmpBase.useDb && cmpTarget.useDb
  const compareValid = slotReady(cmpBase) && slotReady(cmpTarget) && !cmpBothDb
    && !cmpBase.loading && !cmpTarget.loading

  // The launch button restores the user's last working tab. When Schedule is off (or the
  // last tab WAS Schedule), fall back to Resumo Geral so we never open an inaccessible tab.
  const targetTab: 0 | 1 | 2 | 3 = scheduleOn ? lastTab : (lastTab === 3 ? 0 : lastTab)

  async function handleOpen(tab: 0 | 1 | 2 | 3) {
    if (loadingFor !== null || !periodValid) return
    setLaunchError(null); setLoadingFor(tab); setLoadProgress(0)
    if (!getToken()) {
      const refreshed = await refreshToken()
      if (!refreshed || !getToken()) {
        setLoadingFor(null); setLoadProgress(0)
        setLaunchError('Sessão não autenticada. Faça login novamente.')
        return
      }
    }
    const allLinhas = Object.values(LINE_TYPE_MAP).flat()
    const activeLinhas = Object.entries(LINE_TYPE_MAP)
      .filter(([key]) => selLineTypes.has(key))
      .flatMap(([, linhas]) => linhas)
    const lineFilter = activeLinhas.length < allLinhas.length ? activeLinhas : undefined

    // ── The GCR plan is part of THIS load, so it is waited for HERE ────────────────
    // Its hours do not come from the Schedule, so the offscreen Schedule preload — the wait the
    // locomotive band normally covers — never included them, and a GCR-only selection has no
    // preload at all. The result was a launch that closed at once and then fetched the plan
    // behind an already-open modal, with nothing spinning. Start it now, in PARALLEL with the
    // Gantt data, and hold the band until it lands. `primeGcrSummary` parks the promise for the
    // modal to take, so waiting here costs no second request.
    // Wait on it only when nothing else already does. With the Schedule module on, the offscreen
    // build holds the band for far longer than this fetch and the plan lands inside that wait —
    // blocking on it first would only push the build back by the plan's own load time.

    if (scenarioData) {
      setLoadProgress(60)
      await new Promise<void>(r => setTimeout(r, 80))
      setLoadProgress(100)
      onOpen(tab, dateFrom || undefined, dateTo || undefined, lineFilter, scenarioData, scenarioName)
      await new Promise<void>(r => setTimeout(r, 200))
      setLoadingFor(null)
      return
    }
    let resolved: GanttData | null = ganttCache ?? null
    if (!resolved && bgFetchRef.current) resolved = await bgFetchRef.current
    if (resolved) {
      setLoadProgress(55)
      await new Promise<void>(r => setTimeout(r, 80))
      setLoadProgress(100)
      onOpen(tab, dateFrom || undefined, dateTo || undefined, lineFilter, undefined, undefined)
      await new Promise<void>(r => setTimeout(r, 200))
      setLoadingFor(null)
      return
    }
    try {
      const d = await getGanttData()
      _ganttDataFetchedAt = Date.now()
      onDataLoaded?.(d)
      setLoadProgress(100)
      onOpen(tab, dateFrom || undefined, dateTo || undefined, lineFilter, undefined, undefined)
      setTimeout(() => setLoadingFor(null), 200)
    } catch (err: unknown) {
      setLoadingFor(null); setLoadProgress(0)
      setLaunchError(extractErrorMessage(err))
    }
  }

  const displayData = scenarioData ?? ganttCache
  const firstDate = useMemo(() => {
    if (!displayData) return ''
    const isos = displayData.date_info.filter(d => !d.is_weekend).map(d => d.iso).sort()
    const iso = isos[0]
    return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''
  }, [displayData])
  const lastDate = useMemo(() => {
    if (!displayData) return ''
    const isos = displayData.date_info.filter(d => !d.is_weekend).map(d => d.iso).sort()
    const iso = isos[isos.length - 1]
    return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''
  }, [displayData])

  // Years present in the dataset (business days only), ascending — populates the year
  // quick-filter dropdown.
  const availableYears = useMemo(() => {
    if (!displayData) return [] as string[]
    const ys = new Set<string>()
    for (const d of displayData.date_info) if (!d.is_weekend) ys.add(d.iso.slice(0, 4))
    return [...ys].sort()
  }, [displayData])

  // First/last business day within a given year, as dd/mm/yyyy (the year's full range).
  function yearRange(year: string): { from: string; to: string } | null {
    if (!displayData) return null
    const isos = displayData.date_info
      .filter(d => !d.is_weekend && d.iso.slice(0, 4) === year)
      .map(d => d.iso).sort()
    if (isos.length === 0) return null
    const toBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
    return { from: toBR(isos[0]), to: toBR(isos[isos.length - 1]) }
  }

  // Fill the period inputs with a whole year's available range (or clear → custom).
  function applyYear(year: string) {
    setSelYear(year)
    if (!year) return
    const r = yearRange(year)
    if (r) { setDateFrom(r.from); setDateTo(r.to) }
  }

  // ── Locomotive band (single loading indicator for the whole modal) ──────────────
  // Two distinct phases feed ONE band under the header:
  //   • period/scenario fetch — nothing measures it, so the loco just crosses on a loop.
  //   • launch / schedule preload — a real percentage exists, so the loco tracks it.
  // The percentage phase takes priority when both are somehow live, since a measured
  // position is always more informative than a loop.
  // The launch fetch IS determinate, and deliberately so. `loadProgress` is not just the 0 → 55/60
  // → 100 sequence around the awaits: the effect above tickers it asymptotically toward 85 every
  // 80ms for as long as `loadingFor` is set, so the head loco crawls forward the whole fetch and
  // the rail fills behind it. That motion is INLINE (`left` + a 100ms transition), which is the
  // only reason this band still moves at all.
  //
  // It was briefly narrowed to `schedulePreloading` alone, which handed the launch phase to the
  // indeterminate CROSSING KEYFRAME instead — and that keyframe does not run: everything the
  // `<style>` block in LocomotiveProgress drives (the crossing loop, the "Carregando…" letter wave,
  // the smoke) sits still, while everything inline (this band in determinate mode, the Tailwind
  // spinners) keeps moving. So the narrowing turned a working launch band into a frozen one. The
  // keyframe path is a separate, pre-existing bug — it only ever showed in `cacheLoading`, which is
  // short and skipped entirely once `ganttCache` is populated, so nobody saw it.
  const bandDeterminate = loadingFor !== null || schedulePreloading
  const bandIndeterminate = cacheLoading || scenarioLoading
  const bandVisible = bandDeterminate || bandIndeterminate

  // Does the consist represent the SELECTION? Only once a launch is under way — before that (the
  // period/scenario fetch) no Tipo has been requested yet and there is nothing for a per-type train
  // to stand for, so that phase keeps the single generic loco.
  //
  // Currently the same condition as `bandDeterminate`, and kept separate on purpose: one is "what
  // does the train STAND FOR", the other is "how does it MOVE". They were briefly split and the
  // split is what made the difference legible — if the crossing loop is ever fixed and used for the
  // launch, the consist must not follow the movement mode back to a single red locomotive.
  const bandConsist = loadingFor !== null || schedulePreloading

  // One locomotive per line type actually being loaded, in the fixed order the type buttons
  // use so the consist doesn't reshuffle between loads.
  //
  // EVERY selected Tipo, not just the schedule-backed ones. The consist represents what is
  // being loaded, and a Tipo whose hours come from somewhere other than the Schedule (GCR) is
  // still being loaded — filtering it out left a GCR-only launch with an empty consist, which
  // fell back to the generic single red loco and said nothing about what was actually loading.
  const bandColors = TIPO_KEYS
    .filter(k => selLineTypes.has(k))
    .map(k => LINE_TYPE_COLORS[k])

  // Message shown under the band. Rolled ONCE when a load begins (not per render, or it would
  // flicker every frame) and frozen for that load. The Schedule preload gets a phase-specific
  // line; everything else gets a random one from the pool.
  const [loadMsg, setLoadMsg] = useState('')
  useEffect(() => {
    if (!bandVisible) return
    setLoadMsg(pickMessage(
      schedulePreloading ? SCHEDULE_MESSAGES : !scheduleApplicable ? GCR_MESSAGES : LOAD_MESSAGES))
    // Re-roll only when a NEW phase starts, not on progress ticks.
  }, [bandVisible, schedulePreloading, scheduleApplicable])

  // Keep the band mounted briefly after loading ends so it can slide+fade out (item 3), instead
  // of vanishing in one frame and snapping the instruction text into place. Pure presentation:
  // pointer-transparent throughout, so it can never delay or block the revealed controls.
  //
  // bandExiting flips to true DURING RENDER (not in an effect) the moment bandVisible goes
  // false, so bandMounted (below) never has a render where it is false in between — the old
  // effect-based version let one commit through with bandMounted=false, unmounting
  // LocomotiveProgress and discarding its rolled scenery, then remounted it with a FRESH
  // random theme just as the exit CSS started — the scene visibly swapped mid fall-away.
  const [bandExiting, setBandExiting] = useState(false)
  const prevBandVisible = useRef(bandVisible)
  if (bandVisible !== prevBandVisible.current) {
    prevBandVisible.current = bandVisible
    if (!bandVisible) setBandExiting(true)   // just finished loading → play the exit once
    else setBandExiting(false)               // a fresh load cancels any in-flight exit
  }
  useEffect(() => {
    if (!bandExiting) return
    const t = setTimeout(() => setBandExiting(false), 420)
    return () => clearTimeout(t)
  }, [bandExiting])
  const bandMounted = bandVisible || bandExiting

  // ── WHAT THE FALLING BAND SHOWS ───────────────────────────────────────────────────────────
  // The exit is a REPLAY of the load that just finished, not a new phase — but every input the
  // strip reads is derived from "is something loading", and they all go false in the SAME render
  // that starts the fall:
  //   • `bandDeterminate` → false, so `indeterminate` flips true: the head loco stops being
  //     positioned at its percentage and is handed to the crossing keyframe, which snaps it back
  //     to the left edge and starts a fresh run while the band is sliding away.
  //   • `bandConsist` → false, so `colors` goes undefined and the consist the user was watching
  //     collapses to the single generic red locomotive.
  // Both land mid-fall, which is exactly the "it swaps animation right at the fall" report — the
  // same class as the theme re-roll fixed above, in the props rather than in the mount.
  //
  // So freeze the last LIVE values and feed those to the strip for the length of the exit. Held
  // in a ref and written only while `bandVisible`, so the frozen copy is always the final frame
  // of the load and a new load overwrites it before the next exit can read it.
  const bandLivePercent = schedulePreloading ? scheduleProgress : loadProgress
  const bandFrozen = useRef({ determinate: true, colors: [] as string[], percent: 100 })
  if (bandVisible) {
    bandFrozen.current = {
      determinate: bandDeterminate,
      colors: bandConsist ? bandColors : [],
      percent: bandLivePercent,
    }
  }
  const bandShown = bandVisible
    ? { determinate: bandDeterminate, colors: bandConsist ? bandColors : [], percent: bandLivePercent }
    : bandFrozen.current

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      {/* 420. The card used to be 460 purely so the five Tipo chips could each hold their label
          on ONE line — "Motor Diesel" is what set that floor. Letting the two-word labels wrap
          instead gives those 40px back: `items-stretch` on the chip row already matches the
          heights, so a wrapped label costs a slightly taller row and nothing else. */}
      <div ref={cardRef} className="bg-white rounded-lg shadow-2xl flex flex-col w-[420px] max-w-[94vw] overflow-hidden relative">
        <div className="bg-[#D32F2F] text-white flex items-center justify-between px-4 py-2.5 shrink-0 relative">
          <div className="flex items-center gap-2">
            <BarChart2 size={15} />
            <span className="font-semibold text-sm tracking-wide">Abrir Master Schedule Gantt</span>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/20 transition-colors" title="Fechar"><X size={16} /></button>
          {/* The modal's single loading indicator, for BOTH phases. It rides ON TOP of the body
              below — which is disabled and dimmed while loading — so the dead seconds read as
              "working" rather than "frozen". Anchored at top:100% of the header, so it overlays
              without shifting any layout, and is pointer-transparent so it can never intercept a
              click. The paragraph it covers is hidden for the duration (see below), so nothing is
              ever obscured. On completion it slides down and fades (optv-band-exit), letting the
              instruction line underneath surface instead of snapping in. */}
          {bandMounted && (
            <div
              className={bandExiting ? 'optv-band-exit' : undefined}
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                pointerEvents: 'none', background: '#fff',
                // No top padding: this band's white background butts straight onto the red
                // header, and 2px of it above the strip read as a thin white line over the
                // loading label. The strip reserves its own room above the track.
                borderBottom: '1px solid #F3F4F6', padding: '0 12px 0',
              }}
            >
              <style>{`
                @keyframes optvBandExit {
                  from { transform: translateY(0);    opacity: 1; }
                  to   { transform: translateY(150%); opacity: 0; }
                }
                .optv-band-exit { animation: optvBandExit 0.42s cubic-bezier(.4,0,1,1) forwards; }
                /* No reduced-motion block — see the long note in LocomotiveProgress: on Windows the
                   flag is a display preference, not a request for a still screen, and gating on it
                   is what removed the fall-away here (the band just vanished) along with every
                   other animation in this band. */
              `}</style>
              <LocomotiveProgress
                indeterminate={!bandShown.determinate}
                percent={bandShown.percent}
                colors={bandShown.colors.length ? bandShown.colors : undefined}
              />
              {/* Loading caption, riding just below the track INSIDE the (absolute) band — so it
                  adds no row to the body and reserves no space: it exists only while the band does,
                  and slides away with it. */}
              <div style={{ fontSize: 10, fontStyle: 'italic', color: '#6B7280', padding: '0 2px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {loadMsg}
              </div>
            </div>
          )}
        </div>
        <div className="p-4 flex flex-col gap-3">
          {/* Hidden while the locomotive band is up — the band (with its loading caption) overlays
              exactly this line, so showing both would render the text unreadable underneath it.
              `visibility` (not an unmount) keeps the paragraph's height reserved, so the modal never
              resizes or reflows as loading starts and stops, and it is the text the band slides
              away to reveal on completion. */}
          <p className="text-xs text-gray-500" style={{ visibility: bandVisible ? 'hidden' : 'visible' }}>
            Defina o período e abra o Master Schedule. O Schedule é carregado apenas quando ativado abaixo.
          </p>
          {tokenReady === 'reauth-required' && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-2 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin shrink-0" />
              Sessão expirada — aguardando reautenticação…
            </div>
          )}
          {launchError && tokenReady !== 'reauth-required' && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2">{launchError}</div>
          )}
          <div className={`flex flex-col gap-2 relative${cacheLoading ? ' cursor-wait' : ''}`}>
            {/* Single launch button — loads the app and re-opens the user's last working
                tab (Resumo Geral by default). Schedule loading is no longer a launch
                destination; it is controlled by the toggle below. */}
            <button
              onClick={() => handleOpen(targetTab)}
              disabled={loadingFor !== null || schedulePreloading || scenarioLoading || cacheLoading || !periodValid || tokenReady === 'reauth-required'}
              title={!periodValid ? 'Selecione um período válido para continuar.' : tokenReady === 'reauth-required' ? 'Aguardando reautenticação…' : undefined}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-left relative overflow-hidden border-2 border-[#D32F2F] bg-[#FFF5F5] hover:bg-[#FFECEC]${(cacheLoading || !periodValid || tokenReady === 'reauth-required') ? ' cursor-not-allowed' : ''}`}
            >
              {(loadingFor !== null || schedulePreloading)
                ? <Loader2 size={18} className="animate-spin" style={{ color: '#D32F2F', flexShrink: 0 }} />
                : <BarChart2 size={18} style={{ color: '#D32F2F', flexShrink: 0 }} />
              }
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-800">Resumo Geral</div>
                <div className="text-xs text-gray-500">
                  {schedulePreloading
                    ? `Preparando Schedule… ${Math.round(scheduleProgress)}%`
                    : loadingFor !== null
                      ? 'Restaurando visualização…'
                      : targetTab === 0
                        ? 'Tabela resumo por área, mês e workstation'
                        : `Retomar em: ${TAB_LABELS[targetTab]}`}
                </div>
              </div>
              {(loadingFor !== null || schedulePreloading) && (
                <div className="absolute inset-x-0 bottom-0 h-1.5 bg-gray-200">
                  <div className="h-full bg-[#D32F2F] transition-[width] duration-100" style={{ width: `${schedulePreloading ? scheduleProgress : loadProgress}%` }} />
                </div>
              )}
            </button>

            {/* Schedule toggle — decoupled from navigation. ON loads the heavy Schedule
                module and makes its tab accessible; OFF keeps the lightweight load. The
                choice is remembered across sessions. */}
            {/* Disabled — not hidden — when nothing in the selection has a Schedule. A control
                that vanishes leaves the user wondering where the Schedule went; one that is
                visibly off and says why answers it. `scheduleOn` drives the whole appearance,
                so the switch reads OFF for a GCR-only selection while the stored preference is
                left untouched underneath. */}
            <button
              type="button"
              role="switch"
              aria-checked={scheduleOn}
              onClick={() => { if (scheduleApplicable) onScheduleEnabledChange?.(!scheduleEnabled) }}
              disabled={loadingFor !== null || schedulePreloading || !scheduleApplicable}
              title={!scheduleApplicable
                ? 'Os Tipos selecionados não possuem schedule — nada a carregar.'
                : scheduleEnabled ? 'Schedule será carregado — clique para desativar' : 'Schedule não será carregado — clique para ativar'}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-colors text-left${
                scheduleOn
                  ? ' border-[#D32F2F] bg-[#D32F2F]/5'
                  : ' border-dashed border-gray-300 bg-white hover:border-gray-400'
              }${(loadingFor !== null || schedulePreloading || !scheduleApplicable) ? ' opacity-60 cursor-not-allowed' : ''}`}
            >
              <Layers size={17} style={{ color: scheduleOn ? '#D32F2F' : '#9CA3AF', flexShrink: 0 }} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold ${scheduleOn ? 'text-[#B71C1C]' : 'text-gray-600'}`}>Schedule</div>
                {/* ONE line, always. The "no schedule" wording was the longest of the three and
                    wrapped onto a second line, which grew the button and pushed the row beside it
                    around for that selection alone. Shortened to fit and clipped rather than
                    wrapped; the full sentence is on the button's own title. */}
                <div className="text-[11px] text-gray-500 truncate">
                  {!scheduleApplicable
                    ? 'Indisponível — Tipos sem schedule'
                    : scheduleEnabled ? 'Carregar módulo Schedule (aba disponível)' : 'Não carregar — modo leve'}
                </div>
              </div>
              {/* Switch track */}
              <span
                className="relative shrink-0 rounded-full transition-colors"
                style={{ width: 40, height: 22, background: scheduleOn ? '#D32F2F' : '#D1D5DB' }}
              >
                <span
                  className="absolute top-0.5 rounded-full bg-white shadow transition-all"
                  style={{ width: 18, height: 18, left: scheduleOn ? 20 : 2 }}
                />
              </span>
            </button>
          </div>
          {/* EQUAL chips, always. `flex-1` alone did not deliver that: flex-basis is 0 but the
              automatic `min-width: auto` floors every item at its own min-content width, so
              "Motor Diesel" claimed more room than "GCR" and the row came out ragged. `min-w-0`
              removes that floor, which is what makes the five widths identical; `items-stretch`
              (the flex default, stated here because it is load-bearing) then matches their
              heights when one label wraps to a second line. */}
          <div ref={typesRowRef} className={`flex gap-1.5 items-stretch${(cacheLoading || scenarioLoading) ? ' pointer-events-none opacity-50 cursor-wait' : ''}`}>
            {TIPOS.map(({ key, label }) => {
              const active = selLineTypes.has(key)
              const noSchedule = TIPO_NO_SCHEDULE_NOTE[key]
              return (
                // `relative` so the warning marker can sit ABOVE the chip without taking part
                // in the flex row — the chips are `flex-1` and an inline icon would make the
                // one that has it narrower than the rest.
                <button key={key} onClick={() => toggleLineType(key)}
                  title={noSchedule}
                  className={`relative flex-1 min-w-0 px-1 py-1.5 text-[11px] leading-tight rounded border-2 font-semibold transition-colors ${active ? 'border-[#D32F2F] bg-[#D32F2F] text-white' : 'border-gray-300 bg-white text-gray-400 hover:border-gray-400'}`}
                >
                  {noSchedule && (
                    <span
                      title={noSchedule}
                      aria-label={noSchedule}
                      // Top-LEFT corner, not centred over the label: a wrapped two-line label
                      // reaches the top edge, and a centred marker sat on top of its first word.
                      className="absolute -top-1.5 -left-1.5 flex items-center justify-center rounded-full shadow"
                      style={{ width: 15, height: 15, background: '#F59E0B', color: '#fff' }}
                    >
                      <AlertTriangle size={9} strokeWidth={3} />
                    </span>
                  )}
                  {label}
                </button>
              )
            })}
          </div>
          <div className={`rounded-lg overflow-hidden${(cacheLoading || scenarioLoading) ? ' pointer-events-none opacity-60 cursor-wait' : ''}`} style={{ border: `1.5px solid ${!periodValid ? '#D32F2F' : '#E5E7EB'}`, transition: 'border-color 0.15s' }}>
            <div className="px-3 py-2 border-b flex items-center justify-between gap-2" style={{ background: !periodValid ? '#FFF5F5' : '#F9FAFB', borderColor: !periodValid ? '#FECACA' : '#F3F4F6' }}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1 shrink-0" style={{ color: !periodValid ? '#D32F2F' : '#6B7280' }}>
                  Período obrigatório <span style={{ color: '#D32F2F', fontWeight: 800 }}>*</span>
                </span>
                {availableYears.length > 0 && (
                  <select
                    value={selYear}
                    onChange={e => applyYear(e.target.value)}
                    disabled={cacheLoading || scenarioLoading}
                    title="Carregar o ano inteiro disponível"
                    className="text-[10px] font-semibold rounded cursor-pointer disabled:cursor-wait"
                    style={{
                      border: `1px solid ${selYear ? '#D32F2F' : '#D1D5DB'}`,
                      color: selYear ? '#D32F2F' : '#6B7280',
                      background: selYear ? '#FFF5F5' : '#fff',
                      padding: '1px 4px', outline: 'none',
                    }}
                  >
                    <option value="">Ano…</option>
                    {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                )}
              </div>
              {(cacheLoading || scenarioLoading)
                ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Loader2 size={10} className="animate-spin" style={{ color: '#D32F2F' }} /><span style={{ fontSize: 10, color: '#D32F2F', fontWeight: 600 }}>Carregando...</span></span>
                : firstDate && lastDate && <span className="text-[10px] text-gray-400">{firstDate} – {lastDate}</span>
              }
            </div>
            <div className="px-3 py-2.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <input type="checkbox" title="Usar primeira data disponível" checked={!!firstDate && dateFrom === firstDate} onChange={e => { setSelYear(''); setDateFrom(e.target.checked ? firstDate : '') }} style={{ accentColor: '#D32F2F', cursor: 'pointer', width: 14, height: 14, flexShrink: 0 }} />
                <input type="text" placeholder="De: dd/mm/aaaa" value={dateFrom} maxLength={10}
                  onChange={e => { setSelYear(''); setDateFrom(formatDateInput(e.target.value)) }}
                  onBlur={() => { const v = expandYear(dateFrom); if (v !== dateFrom) setDateFrom(v); if (v.length >= 8) setDateFrom(clampDate(v, firstDate, lastDate)) }}
                  className="min-w-0 flex-1 text-xs text-gray-900 text-center rounded px-1.5 py-1.5 focus:outline-none tabular-nums"
                  style={{ border: `1px solid ${!fromISO && dateFrom.length > 0 ? '#FCA5A5' : '#D1D5DB'}`, outline: 'none' }}
                  onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px #D32F2F55' }}
                  onBlurCapture={e => { e.currentTarget.style.boxShadow = '' }}
                />
                <span className="text-gray-400 text-xs shrink-0">–</span>
                <input type="text" placeholder="Até: dd/mm/aaaa" value={dateTo} maxLength={10}
                  onChange={e => { setSelYear(''); setDateTo(formatDateInput(e.target.value)) }}
                  onBlur={() => { const v = expandYear(dateTo); if (v !== dateTo) setDateTo(v); if (v.length >= 8) setDateTo(clampDate(v, firstDate, lastDate)) }}
                  className="min-w-0 flex-1 text-xs text-gray-900 text-center rounded px-1.5 py-1.5 focus:outline-none tabular-nums"
                  style={{ border: `1px solid ${!toISO && dateTo.length > 0 ? '#FCA5A5' : '#D1D5DB'}`, outline: 'none' }}
                  onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px #D32F2F55' }}
                  onBlurCapture={e => { e.currentTarget.style.boxShadow = '' }}
                />
                <input type="checkbox" title="Usar última data disponível" checked={!!lastDate && dateTo === lastDate} onChange={e => { setSelYear(''); setDateTo(e.target.checked ? lastDate : '') }} style={{ accentColor: '#D32F2F', cursor: 'pointer', width: 14, height: 14, flexShrink: 0 }} />
              </div>
              {!periodValid && <p className="text-[10px] font-medium" style={{ color: '#D32F2F' }}>Selecione um período válido para continuar.</p>}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              {/* Also a drop target: dropping an .xlsx here runs the same upload as clicking. */}
              <button onClick={() => scenarioInputRef.current?.click()} disabled={scenarioLoading || loadingFor !== null}
                title="Clique para escolher um arquivo ou arraste o .xlsx até aqui"
                {...scenarioDrop.dropProps}
                className={`flex items-center justify-center gap-2 flex-1 px-3 py-2 text-xs rounded-lg border border-dashed font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  scenarioDrop.dragging
                    ? 'border-[#D32F2F] bg-[#FFF5F5] text-[#D32F2F]'
                    : 'border-gray-300 hover:border-[#D32F2F] hover:bg-[#FFF5F5] text-gray-500 hover:text-[#D32F2F]'}`}
              >
                {scenarioLoading
                  ? <><Loader2 size={13} className="animate-spin" /> Carregando…</>
                  : scenarioDrop.dragging
                    ? <><FlaskConical size={13} /> Solte o arquivo aqui</>
                    : <><FlaskConical size={13} /> Simular Cenário</>}
              </button>
              <button
                onClick={() => setShowCompare(true)}
                disabled={loadingFor !== null || scenarioLoading}
                className="flex items-center justify-center gap-2 flex-1 px-3 py-2 text-xs rounded-lg border border-dashed border-gray-300 hover:border-[#D32F2F] hover:bg-[#FFF5F5] text-gray-500 hover:text-[#D32F2F] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <GitCompare size={13} /> Comparar Cenário
              </button>
            </div>
            <input ref={scenarioInputRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={e => { const file = e.target.files?.[0]; if (file) handleScenarioUpload(file); e.target.value = '' }}
            />
            {!comparisonActive && scenarioData && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                <FlaskConical size={13} style={{ color: '#D97706', flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-amber-700">Cenário ativo</div>
                  <div className="text-[11px] text-amber-600 truncate" title={scenarioName}>{scenarioName}</div>
                </div>
                <button onClick={() => { setScenarioData(null); setScenarioName(''); setScenarioError(null); onScenarioChange?.(null, '') }}
                  className="text-[11px] text-amber-600 hover:text-amber-800 font-medium whitespace-nowrap px-1 py-0.5 rounded hover:bg-amber-100 transition-colors" title="Remover cenário e voltar ao Schedule padrão"
                >✕ Remover</button>
              </div>
            )}
            {/* Comparison armed: two scenarios loaded — mirrors the single-scenario status block. */}
            {comparisonActive && (
              <div className="flex items-start gap-2 px-3 py-2 bg-[#FFF5F5] border border-[#FECACA] rounded-lg">
                <GitCompare size={13} style={{ color: '#D32F2F', flexShrink: 0, marginTop: 1 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-[#D32F2F]">Cenários carregados e prontos para comparação</div>
                  <div className="text-[11px] text-gray-600 truncate" title={comparisonBaseName}><span className="font-semibold">Base:</span> {comparisonBaseName || '—'}</div>
                  <div className="text-[11px] text-gray-600 truncate" title={comparisonTargetName}><span className="font-semibold">Target:</span> {comparisonTargetName || '—'}</div>
                </div>
                <button onClick={() => onComparisonRemove?.()}
                  className="text-[11px] text-[#D32F2F] hover:text-[#B71C1C] font-medium whitespace-nowrap px-1 py-0.5 rounded hover:bg-[#FFECEC] transition-colors" title="Remover cenários e voltar ao fluxo de cenário único"
                >✕ Remover</button>
              </div>
            )}
            {scenarioError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">{scenarioError}</div>}
          </div>
        </div>
      </div>

      {/* Heavy-load advice — a comment balloon pointing at the Tipos row from OUTSIDE the card.
          Three or more Tipos WITH the Schedule module on is the one combination that reliably makes
          the launch slow and memory-hungry: every extra Tipo multiplies the rows the worker has to
          lay out, and only the Schedule build pays that cost. Advisory, never blocking — the planner
          may genuinely need all of them, so it names the two cheaper routes and leaves the button
          enabled. Pointer-transparent: it must never intercept a click meant for the chips behind it. */}
      {heavyLoadWarning && bubble && (
        <div
          role="status"
          style={{
            position: 'fixed', top: bubble.top, left: bubble.left, width: BUBBLE_W,
            transform: 'translateY(-50%)', zIndex: 61, pointerEvents: 'none',
          }}
        >
          <div
            className="text-[11px] text-amber-900 flex items-start gap-2"
            style={{
              position: 'relative', background: '#FFFBEB', border: '1px solid #FCD34D',
              borderRadius: 10, padding: '8px 10px', boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
            }}
          >
            <AlertTriangle size={13} className="shrink-0 mt-px" style={{ color: '#B45309' }} />
            <span>
              <strong className="font-semibold">Carregamento pesado.</strong>{' '}
              {selLineTypes.size} tipos com o Schedule ativo levam bem mais tempo e memória para montar.
              Carregue menos tipos de cada vez, ou desative o Schedule para abrir em modo leve.
            </span>
            {/* Tail: two stacked squares rotated 45°, the back one carrying the border colour, so the
                balloon's outline continues around the point instead of showing a seam. */}
            <span style={{
              position: 'absolute', top: '50%', width: 10, height: 10, transform: 'translateY(-50%) rotate(45deg)',
              background: '#FFFBEB',
              ...(bubble.side === 'right'
                ? { left: -6, borderLeft: '1px solid #FCD34D', borderBottom: '1px solid #FCD34D' }
                : { right: -6, borderRight: '1px solid #FCD34D', borderTop: '1px solid #FCD34D' }),
            }} />
          </div>
        </div>
      )}
    </div>

    {/* ── Comparar Cenário ─────────────────────────────────────────────────── */}
    {showCompare && (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) setShowCompare(false) }}>
        <div className="bg-white rounded-lg shadow-2xl flex flex-col w-[520px] max-w-[94vw] overflow-hidden relative">
          <div className="bg-[#D32F2F] text-white flex items-center justify-between px-4 py-2.5 shrink-0">
            <div className="flex items-center gap-2">
              <GitCompare size={15} />
              <span className="font-semibold text-sm tracking-wide">Comparar Cenário</span>
            </div>
            <button onClick={() => setShowCompare(false)} className="rounded p-1 hover:bg-white/20 transition-colors" title="Fechar"><X size={16} /></button>
          </div>
          <div className="p-3 flex flex-col gap-2.5">
            {/* Base + Target side by side. */}
            <div className="grid grid-cols-2 gap-2.5">
              {([
                { key: 'base'   as const, label: 'Base',   slot: cmpBase,   setSlot: setCmpBase,   inputRef: cmpBaseInputRef,   drop: cmpBaseDrop   },
                { key: 'target' as const, label: 'Target', slot: cmpTarget, setSlot: setCmpTarget, inputRef: cmpTargetInputRef, drop: cmpTargetDrop },
              ]).map(({ key, label, slot, setSlot, inputRef, drop }) => {
                const ready = slotReady(slot)
                return (
                  <div key={key} className="rounded-lg overflow-hidden flex flex-col h-full" style={{ border: `1.5px solid ${ready ? '#E5E7EB' : '#FECACA'}` }}>
                    {/* ONE header line for both cards: the Base / Target label plus the "Banco de
                        dados" source toggle sitting right next to it. Keeping the toggle up here is
                        what lets the body below always be a single block of the same height, so the
                        two cards never end up one line taller than each other. */}
                    <div className="px-2.5 py-1.5 border-b flex items-center justify-between gap-1.5 h-[30px]" style={{ background: ready ? '#F9FAFB' : '#FFF5F5', borderColor: ready ? '#F3F4F6' : '#FECACA' }}>
                      <span className="text-[11px] font-bold uppercase tracking-wide shrink-0" style={{ color: ready ? '#6B7280' : '#D32F2F' }}>
                        {label} <span style={{ color: '#D32F2F', fontWeight: 800 }}>*</span>
                      </span>
                      {ready ? (
                        <span className="text-[11px] font-semibold text-emerald-600">✓</span>
                      ) : (
                        <label className="flex items-center gap-1 cursor-pointer select-none min-w-0" title="Usa o banco de dados com o período e tipos atuais">
                          <input
                            type="checkbox"
                            checked={slot.useDb}
                            onChange={e => setSlot(s => ({ ...s, useDb: e.target.checked, error: null }))}
                            style={{ accentColor: '#D32F2F', cursor: 'pointer', width: 12, height: 12, flexShrink: 0 }}
                          />
                          <span className="text-[10.5px] text-gray-700 truncate">Banco de dados</span>
                        </label>
                      )}
                    </div>
                    {/* Body — exactly ONE block, stretched over the two lines the source picker
                        used to take: the loaded scenario, the DB source, or the Excel drop zone. */}
                    <div className="px-2.5 py-2 flex flex-col gap-1.5 flex-1">
                      {ready ? (
                        // Loaded — show ONLY the scenario card + a remove (✕) to change it.
                        slot.useDb ? (
                          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#FFF5F5] border border-[#FECACA] rounded flex-1 min-h-[44px]">
                            <BarChart2 size={13} style={{ color: '#D32F2F', flexShrink: 0 }} />
                            <span className="text-[11px] text-gray-600 truncate flex-1">Banco de dados</span>
                            <button onClick={() => setSlot(s => ({ ...s, useDb: false, error: null }))}
                              className="text-[11px] text-[#D32F2F] hover:text-[#b71c1c] font-medium px-0.5 rounded hover:bg-[#FFE5E5]" title="Remover / trocar cenário">✕</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded flex-1 min-h-[44px]">
                            <FlaskConical size={12} style={{ color: '#D97706', flexShrink: 0 }} />
                            <span className="text-[11px] text-amber-700 truncate flex-1" title={slot.name}>{slot.name}</span>
                            <button onClick={() => setSlot(s => ({ ...s, data: null, name: '', error: null }))}
                              className="text-[11px] text-amber-600 hover:text-amber-800 font-medium px-0.5 rounded hover:bg-amber-100" title="Remover / trocar cenário">✕</button>
                          </div>
                        )
                      ) : slot.useDb ? (
                        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#FFF5F5] border border-[#FECACA] rounded flex-1 min-h-[44px]">
                          <BarChart2 size={13} style={{ color: '#D32F2F', flexShrink: 0 }} />
                          <span className="text-[11px] text-gray-600 truncate">Carregando…</span>
                        </div>
                      ) : (
                        <>
                          {/* Drop target as well as a picker — same handler either way. */}
                          <button
                            onClick={() => inputRef.current?.click()}
                            disabled={slot.loading}
                            title="Clique para escolher um arquivo ou arraste o .xlsx até aqui"
                            {...drop.dropProps}
                            className={`flex items-center justify-center gap-1.5 w-full flex-1 min-h-[44px] px-2 py-1.5 text-xs rounded-md border border-dashed font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                              drop.dragging
                                ? 'border-[#D32F2F] bg-[#FFF5F5] text-[#D32F2F]'
                                : 'border-gray-300 hover:border-[#D32F2F] hover:bg-[#FFF5F5] text-gray-500 hover:text-[#D32F2F]'}`}
                          >
                            {slot.loading
                              ? <><Loader2 size={13} className="animate-spin" /> Carregando…</>
                              : drop.dragging
                                ? <><FlaskConical size={13} /> Solte aqui</>
                                : <><FlaskConical size={13} /> Importar Excel</>}
                          </button>
                          <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleCompareUpload(key, f); e.target.value = '' }}
                          />
                          {slot.error && <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{slot.error}</div>}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            {cmpBothDb && (
              <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                Os dois não podem usar o banco de dados — os dados seriam idênticos. Importe um Excel em pelo menos um.
              </div>
            )}
            {!periodValid && !cmpBothDb && (
              <div className="text-[10px] text-gray-500">
                O período pode ser definido depois — a comparação o aplicará automaticamente aos dois cenários.
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setShowCompare(false)}
                className="flex-1 px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium transition-colors">
                Cancelar
              </button>
              <button onClick={handleCompareConfirm} disabled={!compareValid}
                className="flex-1 px-3 py-1.5 text-sm rounded-md text-white font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#D32F2F' }}>
                Concluir
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
