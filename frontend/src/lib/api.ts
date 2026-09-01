import axios from 'axios'
import type { AxiosError } from 'axios'
import { getToken, refreshToken, triggerReauth, getClientId } from '@/lib/tokenStore'
import { getUnlockToken, setUnlock, clearUnlock, triggerUnlock, setLockedOut, setBlocked, setServerOffline, clearServerOffline } from '@/lib/unlockStore'
import { isServerQuiet, setServerQuiet } from '@/lib/awakeWindow'
import { API_BASE, WS_BASE } from '@/lib/apiOrigin'
import { quizSourceTag } from '@/lib/expertise'

// Internal request flag: marks background pollers' own requests (health probe, admin
// online-users / alerts) so they're excluded from the "real traffic" liveness signal
// below. Otherwise a poll would look like user activity and perpetuate itself, holding
// the backend awake and defeating the host's sleep.
declare module 'axios' {
  interface AxiosRequestConfig {
    _backgroundPoll?: boolean
  }
}

// Origem resolvida em tempo de execucao — ver lib/apiOrigin. Atras do proxy TLS estes
// dois viram origem-relativa/derivada de window.location, para que um cliente que chegou
// pelo IP nao passe a chamar o nome .local que ele nao resolve.
const API_URL = API_BASE
const WS_URL  = WS_BASE

export const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
})

// Attach Azure ID token to every request when the user is authenticated, plus the
// admin second-factor "unlock" grant (harmless on non-sensitive endpoints; required
// by downloads and exports). The server ignores the unlock header
// where it isn't needed and enforces it where it is.
api.interceptors.request.use(config => {
  // ── Quiet-mode backstop ────────────────────────────────────────────────────
  // While the admin has the server switched off, no BACKGROUND request may leave the
  // browser: every one of them resets the host's 10-minute idle timer, and the timer has
  // to run out for the container to sleep. Each poller already gates itself on
  // shouldPollNow/shouldPollOrActive; this is the net underneath, so a poller added later
  // (or one that slips past its gate on a race) cannot silently hold the server awake.
  //
  // Only _backgroundPoll traffic is dropped. A real user action — including the admin's own
  // call to switch the server back ON — must still go through, or the state would be
  // unrecoverable from inside the app.
  if (config._backgroundPoll && isServerQuiet()) {
    return Promise.reject(new axios.Cancel('server offline (quiet mode): background poll suppressed'))
  }

  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  const unlock = getUnlockToken()
  if (unlock) {
    config.headers['X-Admin-Unlock'] = unlock
  }
  // Per-browser id. Only the access-request endpoint reads it (cap of 5 submissions per
  // browser); every other route ignores it. Sent on all requests rather than only on that
  // one so the header is not itself a signal of which call is the sign-up.
  const clientId = getClientId()
  if (clientId) {
    config.headers['X-Client-Id'] = clientId
  }
  return config
})

// Routes that must NEVER take the 401 recovery path below. `/api/auth/login` answers 401 for
// a wrong password — running a token refresh over that would be nonsense, and firing the
// global reauth trigger would flip the app into "sessão expirada" while the user is simply
// typing the wrong password on the login screen. `/api/auth/refresh` is excluded because it
// IS the refresh: retrying it through refreshToken() would recurse.
function _isAuthRoute(url: string | undefined): boolean {
  const u = url ?? ''
  return u.startsWith('/api/auth/')
}

// Recoverable transient failures: no HTTP response (network drop / DNS / CORS
// preflight) or a client-side timeout abort. These are retried once after a
// short backoff so a momentary blip doesn't fail an import.
function _isTransientNetworkError(err: AxiosError): boolean {
  if (err?.response) return false                 // server answered → not a network error
  if (err?.code === 'ECONNABORTED') return true   // axios timeout
  if (err?.code === 'ERR_NETWORK') return true    // network unreachable / CORS
  // Fallback: axios surfaces bare network failures as message "Network Error"
  return (err?.message ?? '').toLowerCase().includes('network')
}

// ── Backend liveness signal, observed from real traffic (zero added requests) ──
// Every answered request — a success OR an HTTP error like 401/500 — proves the
// backend is reachable. We record the moment and notify listeners, so the header
// status dots / admin indicators can show the TRUE state when the app is actively
// used outside working hours (when idle polling is otherwise suppressed to let
// the host sleep). Background pollers' own requests are excluded (config._backgroundPoll)
// so they can't perpetuate themselves and hold the backend awake.
let _lastBackendContactAt = 0
const _contactListeners = new Set<() => void>()
export function getLastBackendContactAt(): number { return _lastBackendContactAt }
export function onBackendContact(fn: () => void): () => void {
  _contactListeners.add(fn)
  return () => { _contactListeners.delete(fn) }
}
function _noteBackendContact(config: { _backgroundPoll?: boolean } | undefined) {
  if (config?._backgroundPoll) return
  _lastBackendContactAt = Date.now()
  _contactListeners.forEach(fn => { try { fn() } catch { /* a listener error must never break the pipeline */ } })
}

// ── "Backend is not answering" flag, for pollers to stand down on ──────────────
// Set when a request gets NO response (network/DNS/CORS/timeout) or a gateway
// 502/503/504 — i.e. the server isn't there. Cleared by any answered request,
// INCLUDING an application-level 4xx/5xx: the app produced that answer, so it is
// up and the problem is elsewhere (auth, DB) — which polling cannot fix and must
// not be retried against.
//
// Why this exists: with the backend down, every background poller kept beating on
// its own timer and each beat also paid the interceptor's transient retry below,
// multiplying the failing-request log volume. Pollers now check this and skip the
// request while keeping their timers alive, so recovery is still automatic.
let _backendUnavailable = false
export function isBackendUnavailable(): boolean { return _backendUnavailable }
const GATEWAY_DOWN = [502, 503, 504]

// Response interceptor:
//   • 401 (expired/invalid/missing token) → silent refresh + retry once; if the
//     refresh can't recover, fire the global reauth trigger so the LoginModal
//     always appears (never leave the user stuck with a bare auth error).
//   • transient net/timeout → short backoff + retry once (re-auth too, in case
//     the drop coincided with an expiry the server never got to report)
// Anything still failing is rejected with the *real* cause attached so callers
// log the root issue instead of a generic "Network Error".
//
// NOTE: the backend returns 401 (not 403) for a missing/malformed Authorization
// header, so "no token yet" recovers through this exact same path. A 403 here is a
// genuine authorization failure (e.g. wrong corporate domain) and is NOT retried —
// a silent refresh can't fix it, and looping would just spin.
api.interceptors.response.use(
  response => { _backendUnavailable = false; _noteBackendContact(response.config); return response },
  async (error: unknown) => {
    const err = error as AxiosError
    const config = err?.config as (typeof err.config & { _retried?: boolean; _unlockRetried?: boolean }) | undefined

    // Any answered request proves the backend is reachable — record it (see above).
    // Gateway 502/503/504 mean the upstream isn't up yet (cold boot), so they don't
    // count; an app-level 4xx/5xx does, since the app itself produced the response.
    const answered = !!err?.response && !GATEWAY_DOWN.includes(err.response.status)
    _backendUnavailable = !answered
    if (answered) _noteBackendContact(err.config)

    // ── Deliberate shutdown ("Desativar Servidor") ───────────────────────────
    // A 503 carrying X-Server-Offline is not a cold start and not an outage: an admin has
    // closed the app, and the body is the message they wrote for the user. Flip the global
    // state so the offline notice takes over, and correct `_backendUnavailable` — the backend
    // ANSWERED, it just refused, so pollers must not be told it is unreachable and the status
    // dot must not read as a crash. Never retried: retrying is what the switch exists to stop.
    // The header must stay in the backend's CORS expose_headers or this reads as undefined and
    // the refusal degrades into a generic gateway error.
    if (
      err?.response?.status === 503 &&
      String((err.response.headers as Record<string, string> | undefined)?.['x-server-offline'] ?? '') === '1'
    ) {
      _backendUnavailable = false
      _noteBackendContact(err.config)
      const detail = (err.response.data as { detail?: string } | undefined)?.detail
      setServerOffline(typeof detail === 'string' ? detail : '')
      return Promise.reject(error)
    }

    // ── Failed-password lockout ──────────────────────────────────────────────
    // The backend flags a lockout with X-Locked-Out on a 429 (any password route).
    // Flip the global lockout state so the UI revokes access, closes password
    // dialogs, blocks further attempts, and shows the generic notice. Do NOT retry.
    const lockedOut =
      err?.response?.status === 429 &&
      String((err.response.headers as Record<string, string> | undefined)?.['x-locked-out'] ?? '') === '1'
    if (lockedOut) {
      // …exceto na tela de login. Ali o 429 significa "este navegador errou a senha cinco
      // vezes", e o estado global de lockout existe para REVOGAR a interface de quem já está
      // dentro — fecha diálogos de senha, derruba controles de admin, sobe o aviso em tela
      // cheia. Disparar isso para alguém que ainda não entrou cobre a própria tela de login
      // com um aviso que ela não consegue dispensar, e o motivo real (senha errada demais)
      // nunca chega ao formulário. A mensagem do servidor é devolvida ao chamador, que a
      // mostra no lugar certo — dentro do formulário.
      if (!_isAuthRoute(config?.url)) setLockedOut()
      return Promise.reject(error)
    }

    // ── Hard admin ban ───────────────────────────────────────────────────────
    // Any 403 carrying X-Blocked means this account was banned by an admin. Flip the
    // global blocked state so the access-denied page takes over. Never retried.
    // X-Blocked-Reason distinguishes a personal ban from the new-user lockdown, which show
    // different text. It must stay in the backend's CORS expose_headers or it reads as
    // undefined here and every denial falls back to the ban wording.
    const blocked =
      err?.response?.status === 403 &&
      String((err.response.headers as Record<string, string> | undefined)?.['x-blocked'] ?? '') === '1'
    if (blocked) {
      const reason = String(
        (err?.response?.headers as Record<string, string> | undefined)?.['x-blocked-reason'] ?? '',
      )
      setBlocked(reason === 'unregistered' ? 'unregistered' : 'banned')
      return Promise.reject(error)
    }

    // ── Admin second-factor required ─────────────────────────────────────────
    // The token is VALID but the request hit a sensitive endpoint without a valid
    // X-Admin-Unlock grant (backend flags this with the X-Admin-Unlock-Required
    // header on a 401). Do NOT run the token-refresh path — prompt for the admin
    // password via the unlock modal, then retry the request once with the grant.
    const unlockRequired =
      err?.response?.status === 401 &&
      String((err.response.headers as Record<string, string> | undefined)?.['x-admin-unlock-required'] ?? '') === '1'
    if (unlockRequired) {
      if (config && !config._unlockRetried) {
        config._unlockRetried = true
        clearUnlock() // any cached grant is invalid/expired — force a fresh prompt
        const ok = await triggerUnlock()
        if (ok) {
          const grant = getUnlockToken()
          if (grant && config.headers) config.headers['X-Admin-Unlock'] = grant
          return api(config)
        }
      }
      return Promise.reject(error) // cancelled, or already retried once
    }

    if (config && !config._retried && !_isAuthRoute(config.url)) {
      // ── 401: refresh token, then retry ──────────────────────────────────
      if (err?.response?.status === 401) {
        config._retried = true
        try {
          const ok = await refreshToken()
          if (ok) {
            const newToken = getToken()
            if (newToken && config.headers) {
              config.headers['Authorization'] = `Bearer ${newToken}`
            }
            return api(config)
          }
        } catch { /* refresh failed — fall through to reauth + reject */ }
        // Server authoritatively rejected the token and silent refresh could not
        // recover it → the session is unrecoverable without the user. Surface the
        // re-login modal globally instead of bubbling an opaque auth error.
        //
        // EXCEPT for background polls: those mount before MSAL has authenticated, so
        // their first probe 401s as a matter of course. Letting that fire the global
        // reauth trigger would pop the login modal for a status dot. A real user
        // action hitting a dead session still raises it through this same path.
        if (!config._backgroundPoll) triggerReauth()
      }
      // ── Transient network / timeout: backoff, silent re-auth, retry once ──
      else if (_isTransientNetworkError(err)) {
        config._retried = true
        await new Promise(r => setTimeout(r, 800))   // brief backoff
        try {
          // Best-effort token refresh (no-op if not needed / no refresher).
          await refreshToken()
          const newToken = getToken()
          if (newToken && config.headers) {
            config.headers['Authorization'] = `Bearer ${newToken}`
          }
        } catch { /* refresh failed — still retry the request once */ }
        return api(config)
      }
    }

    // Attach the real root cause so callers don't surface a bare "Network Error".
    if (err && !err.response) {
      const cause = err.code ? `${err.code}: ${err.message}` : err.message
      ;(err as { _rootCause?: string })._rootCause = cause || 'Falha de rede desconhecida'
    }
    return Promise.reject(error)
  },
)

// ── Tipos — Excel / Ingestão ─────────────────────────────────────


export interface HeadcountInfo {
  people: string[]
  qtde:   number
  disp:   number
  lh:     number
  turnos: number
  lm:     number
  desc:   string
}

export interface CapacityInfo {
  nome:     string
  normal_h: number
  ot_h:     number
  top_pct:  number
  disp:     number
  secao:    string
}

export interface ExcelData {
  status:           string
  message:          string
  filepath:         string
  sheets_loaded:    string[]
  filters_applied:  { ano: number | null; mes: number | null; escopo: string | null }
  demand_by_wsn:    Record<string, number>
  people_by_wsn:    Record<string, string[]>
  headcount_by_wsn: Record<string, HeadcountInfo>
  capacity_by_person: Record<string, CapacityInfo>
  wsn_list:         string[]
  total_demand_h:   number
  preview: {
    rows:   number
    sample: Record<string, unknown>[]
  }
}

// ── Tipos ────────────────────────────────────────────────────────

export interface Job {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message: string
  result: OptimizationResult | null
  error: string | null
  log?: string[]
}

export interface OptimizationResult {
  wsns:           SolverWsnResult[]
  status:         string
  message:        string
  allocations:    Record<string, Record<string, number>>
  ot_allocations: Record<string, Record<string, number>>
  phase_metrics?: PhaseMetric[]
  final_gap?:     number | null
  /** Shift info per WSN: { turnos, lm, lh } — from HeadCount sheet TURNOS/LM/LH columns */
  wsn_shift_info?: Record<string, { turnos: number; lm: number; lh: number }>
}

/** Single WSN row as returned by the Gurobi solver */
export interface SolverWsnResult {
  wsn:          string
  demand:       number
  covered:      number
  unmet:        number
  ot_h:         number
  util:         number
  bottleneck:   boolean
  people_count: number
}

/** Per-person allocation summary built from solver allocations dict */
export interface PersonResultRow {
  person:          string
  capacity_h:      number
  allocated_h:     number
  overtime_h:      number
  utilization_pct: number
  wsns:            string[]
}



export interface PhaseMetric {
  phase: number
  name: string
  status: string
  obj_val: number | null
  runtime_s: number
  mip_gap: number | null
}

export interface OptimizationPayload {
  items: Record<string, unknown>[]
  top_pct: number
  ot_day_limit_pct: number
  solver_backend: 'gurobi' | 'pulp'
  phase_limit: number
  gap_pct: number
  time_limit_s: number
  ndias?: number
  /** Fiscal weeks of the period. The server resolves them to dates to apply vacation/leave. */
  fws?: string[]
  demand_by_wsn?: Record<string, number>
  wsn_max_people?:  Record<string, number>
  wsn_max_hours?:   Record<string, number>
  wsn_max_turnos?:  Record<string, number>
  disabled_wsns?: string[]
  person_availability_pct?: Record<string, number>
  blocked_pairs?: Array<[string, string]>
  required_pair_presence?: Array<[string, string]>
  forced_pair_headcount?: Record<string, number>
  direct_pair_headcount?: Record<string, number>
  fixed_pair_ot_pct?: Record<string, number>
  max_pair_pct?: Record<string, number>
  max_pair_ot_pct?: Record<string, number>
  use_all_headcount?: boolean
  /** Apply the expertise matrix (`e[p,w]` ≥ `r[w]`) to this run. Absent/false ⇒ the solver
   *  behaves exactly as before the expertise work. */
  expertise_enabled?: boolean
}

// ── Funções de API ───────────────────────────────────────────────

export async function startOptimization(payload: OptimizationPayload) {
  const res = await api.post<{ job_id: string; status: string }>(
    '/api/optimize',
    payload,
  )
  return res.data
}

export async function getJob(job_id: string) {
  const res = await api.get<Job>(`/api/jobs/${job_id}`, {
    params: { _ts: Date.now() },
  })
  return res.data
}

export async function cancelJob(job_id: string) {
  const res = await api.delete(`/api/optimize/${job_id}`)
  return res.data
}

// ── Authenticated file download ──────────────────────────────────
// Protected download endpoints require the Azure bearer token like every other
// API call. A plain window.open / <a href> navigation does NOT send the
// Authorization header, so it would 401. Instead fetch the file as a blob through
// the authenticated `api` client (its interceptor attaches the token and handles
// the 401 refresh/retry) and trigger a client-side download from memory.
export async function downloadFile(path: string, fallbackName = 'download'): Promise<void> {
  const res = await api.get(path, { responseType: 'blob' })
  const blob = res.data as Blob
  const cd = String(res.headers?.['content-disposition'] ?? '')
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)
  const name = m ? decodeURIComponent(m[1]) : fallbackName
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── WebSocket helper ─────────────────────────────────────────────

export function connectJobWebSocket(
  job_id: string,
  onMessage: (job: Job) => void,
  onClose?: () => void,
): WebSocket {
  // The backend validates auth on the WS channel too. Browsers can't set an
  // Authorization header on a WebSocket, so the token travels as a ?token= query
  // param (backend rejects anonymous/invalid/non-Taktline connections with 1008).
  const token = getToken()
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  const ws = new WebSocket(`${WS_URL}/ws/${job_id}${qs}`)

  ws.onmessage = (e) => {
    try {
      const parsed: unknown = JSON.parse(e.data)
      if (!parsed || typeof parsed !== 'object') return
      if (typeof (parsed as { status?: unknown }).status !== 'string') return
      onMessage(parsed as Job)
    } catch {
      // ignora mensagens malformadas
    }
  }

  // keepalive a cada 20s para evitar timeout
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping')
    else clearInterval(ping)
  }, 20000)

  ws.onclose = () => {
    clearInterval(ping)
    onClose?.()
  }

  return ws
}

// ── Excel / Ingestão ─────────────────────────────────────────────



// ── Importação de itens do plano mensal ──────────────────────────

export interface ClientSegment {
  client:   string
  familia:  string
  nivel:    string
  qtde_fw:  number
  scopes:   Partial<Record<ScopeKey, number>>
}

export interface ImportItem {
  id:        string
  item:      string
  descricao: string
  familia:   string
  area:      string
  cliente:   string
  tipo:      string
  tipo_fw:     string[]
  qtde_fw:     number
  /** Carga de Fábrica source only: `qtde_fw` broken down per TIPO/ESCOPO. The TIPOs of one item
   *  are concurrent process steps on the SAME units, so these values SUM TO MORE than
   *  `qtde_fw` by design (5 peritagem + 5 montagem = 5 units, not 10). Supplied to
   *  `getAssemblyDetailsForDemand` so each operation type is scaled by its own demand. */
  tipoQty?:    Record<string, number>
  wsn:         string
  /** Whether a routing exists for this code — true when it appears in the ASSEMBLY column of
   *  the routing master, which is the key /api/assembly-details/explicit resolves operations
   *  and hours by. Supplied by /api/excel-items. NOT the same thing as having a WSN: in the
   *  split-table world the plan rows that produce this record carry no WSN at all, so WSN is
   *  blank on plenty of fully routed items. */
  has_routing?: boolean
  nivel?:      string
  clients?:    ClientSegment[]
  has_qty_fw?: boolean
  /** Origin of this item: 'simular' = imported via period import; 'adicionar' = added from catalog */
  source?: 'simular' | 'adicionar'
  /** Carga de Fábrica source only: Plano de Produção HH TOTAL for this item in range. Carries the
   *  work of a part number that has no ASSEMBLY routing, which would otherwise read as 0 hours. */
  planHours?:  number
  /** Carga de Fábrica source only: false when the part number resolved to no ASSEMBLY in the
   *  routing master, i.e. the item lands with no operations and 0 routed hours. Mirrors the
   *  catalog entry's `has_routing`; it is deliberately NOT derived from `wsn` (see above). */
  hasRouting?: boolean
  /** Which import produced this item. 'factoryLoad' means its quantities come from the loaded
   *  schedule, NOT from the monthly plan — so its hours must be resolved with
   *  `getAssemblyDetailsForDemand`, which takes the qty from the item instead of looking it up
   *  in plan rows that do not exist for it. Absent = monthly plan / catalog. */
  origin?: 'factoryLoad'
}

export interface ImportFilterOptions {
  anos:     number[]
  meses:    number[]
  fws:      string[]
  familias: string[]
  clientes: string[]
}

export interface ExcelItemsParams {
  ano?:   number
  mes?:   number
  meses?: number[]    // multi-month (overrides mes when length > 1)
  fw?:    string      // semanal: single FW required
  fws?:   string[]    // mensal: selected FWs (omit = all)
  mode?:  'anual' | 'mensal' | 'semanal'
}

export interface ExcelItemsResponse {
  status:         string
  message:        string
  filters:        { ano: number | null; mes: number | null; fw: string | null; mode: string }
  filter_options: ImportFilterOptions
  /** Maps numeric month (2, 3, 4…) → sorted list of FW strings for that month.
   *  Built on the backend after the ANO filter, before the MES filter —
   *  identical logic to _list_available_fw_values() in the original desktop tool. */
  mes_fw_map:     Record<number, string[]>
  items:          ImportItem[]
}

export async function getExcelItems(
  params?: ExcelItemsParams,
): Promise<ExcelItemsResponse> {
  const res = await api.get<ExcelItemsResponse>('/api/excel-items', {
    params: {
      ...(params?.ano  != null ? { ano:  params.ano }  : {}),
      // multi-month takes priority over single month
      ...(params?.meses && params.meses.length > 1
        ? { meses: params.meses.join(',') }
        : params?.mes != null
          ? { mes: params.mes }
          : {}),
      ...(params?.fw            ? { fw:   params.fw }   : {}),
      ...(params?.fws && params.fws.length > 0 ? { fws: params.fws.join(',') } : {}),
      ...(params?.mode          ? { mode: params.mode } : {}),
    },
  })
  return res.data
}

// ── Catálogo de itens (sem filtro de período) ─────────────────────

export interface CatalogFilterOptions {
  areas:    string[]
  familias: string[]
  clientes: string[]
}

export interface CatalogItemsResponse {
  status:         string
  message:        string
  filter_options: CatalogFilterOptions
  items:          ImportItem[]   // same shape, qtde_fw=0 and wsn=''
}

export async function getItemsCatalog(params?: {
  areas?:    string[]
  familias?: string[]
  clientes?: string[]
}): Promise<CatalogItemsResponse> {
  const res = await api.get<CatalogItemsResponse>('/api/items-catalog', {
    params: {
      ...(params?.areas    && params.areas.length    > 0 ? { areas:    params.areas.join(',')    } : {}),
      ...(params?.familias && params.familias.length > 0 ? { familias: params.familias.join(',') } : {}),
      ...(params?.clientes && params.clientes.length > 0 ? { clientes: params.clientes.join(',') } : {}),
    },
  })
  return res.data
}

// ── Assembly details (per-scope breakdown) ────────────────────────

export type ScopeKey = 'LEVE' | 'MEDIO' | 'PESADO' | 'UNICO'

export interface AssemblyWsnEntry {
  wsn:          string
  hours:        number
  description?: string
}

export interface AssemblyOperationRow {
  n:          number
  component:  string
  comp_desc?: string
  op:         string
  op_desc?:   string
  tipo:       string
  wsn:        string
  desc:       string
  hh_unit:    number
  hh_total:   number
}

export interface AssemblyScopeData {
  total_h:        number
  qty:            number
  hours_per_unit: number
  wsn_count:      number
  wsns:           AssemblyWsnEntry[] | undefined
  operations:     AssemblyOperationRow[]
}

export interface AssemblyDetail {
  item:           string
  descricao:      string
  scopes_present: ScopeKey[]
  total_h:        number
  scopes:         Partial<Record<ScopeKey, AssemblyScopeData>>
}

export interface AssemblyDetailsResponse {
  status:  string
  message: string
  items:   AssemblyDetail[]
}

export async function getAssemblyDetails(params: {
  items: string[]
  mes?:  number
  fws?:  string[]
  mode?: 'anual' | 'mensal' | 'semanal'
  tipo_filter?: string
}): Promise<AssemblyDetailsResponse> {
  const res = await api.get<AssemblyDetailsResponse>('/api/assembly-details', {
    params: {
      items: params.items.join(','),
      ...(params.mes  != null                             ? { mes:  params.mes }              : {}),
      ...(params.fws && params.fws.length > 0             ? { fws:  params.fws.join(',') }    : {}),
      ...(params.mode                                      ? { mode: params.mode === 'anual' ? 'mensal' : params.mode } : {}),
      ...(params.tipo_filter && params.tipo_filter !== 'TODOS' ? { tipo_filter: params.tipo_filter } : {}),
    },
  })
  return res.data
}

/**
 * Same breakdown, but WE supply the demand.
 *
 * `getAssemblyDetails` looks the quantities up in the monthly-plan rows for the requested
 * mês/FWs. Carga de Fábrica items come from the loaded schedule and have no such rows, so that
 * route drops them ("no demand rows in this period") and they render with no operations and
 * zero hours. Here the qty and the ESCOPO values travel with the request; hours, WSNs and
 * operations still resolve through the identical ASSEMBLY lookup on the backend.
 *
 * `qty` is the UNIT count; `tipoQty` says how many of those units each ESCOPO applies to, and
 * legitimately sums to more than `qty` (concurrent steps on the same units). Sending only the
 * total made every matched operation use it, which doubled the hours of a multi-ESCOPO item.
 */
export async function getAssemblyDetailsForDemand(params: {
  items: { item: string; qty: number; tipos?: string[]; tipoQty?: Record<string, number> }[]
}): Promise<AssemblyDetailsResponse> {
  const res = await api.post<AssemblyDetailsResponse>('/api/assembly-details/explicit', {
    items: params.items.map(it => ({
      item:  it.item,
      qty:   it.qty,
      tipos: it.tipos,
      ...(it.tipoQty && Object.keys(it.tipoQty).length > 0 ? { tipo_qty: it.tipoQty } : {}),
    })),
  })
  return res.data
}

// ── Capacity stats (footer KPIs) ─────────────────────────────────

export interface CapacityStats {
  status:       string
  disponivel_h: number
  alocado_h:    number
}

export async function getCapacityStats(): Promise<CapacityStats> {
  const res = await api.get<CapacityStats>('/api/capacity-stats')
  return res.data
}

// ── WSN → People mapping ────────────────────────────────

export interface WsnPeopleResponse {
  status:        string
  people_by_wsn: Record<string, string[]>
  /** `e[p,w]` per WSN → person NAME → level, from the same roster snapshot as the names
   *  above. Absent when the DB is unavailable (Excel-only dev path). */
  expertise?:      Record<string, Record<string, number>>
  /** `r[w]` per WSN. Only WSNs with a bar actually set appear. */
  required_level?: Record<string, number>
}

export async function getWsnPeople(): Promise<WsnPeopleResponse> {
  const res = await api.get<WsnPeopleResponse>('/api/wsn-people')
  return res.data
}

export interface PeriodDaysResponse {
  status:     string
  total_days: number
  days_by_fw: Record<string, number>
}

export async function getPeriodDays(fws: string[]): Promise<PeriodDaysResponse> {
  const res = await api.get<PeriodDaysResponse>('/api/period-days', {
    params: { fws: fws.join(',') },
  })
  return res.data
}

// ── Gurobi availability check ───────────────────────────────

export interface GurobiCheckResult {
  available: boolean
  version:   string | null
  message:   string
}

export async function checkGurobi(): Promise<GurobiCheckResult> {
  const res = await api.get<GurobiCheckResult>('/api/gurobi-check')
  return res.data
}

// ── DB import ─────────────────────────────────────────────────────────────────














// ── Gantt ─────────────────────────────────────────────────────────────────────

export interface GanttDateInfo {
  iso:         string
  label:       string
  dow:         string
  fw:          string
  is_weekend:  boolean
  // Non-working day that is a holiday (weekday public/company holiday, or a working
  // day converted to a day off) — distinct from a plain weekend. Computed server-side
  // from the admin-editable calendar, so the frontend no longer recomputes holidays.
  is_holiday?: boolean
}

export interface GanttWorkstation {
  ws:        string
  subarea?:  string
  area?:     string
  desc_rows: GanttDescRow[]
}

export interface GanttDescRow {
  desc:  string
  pn?:   string
  /** Total quantity for this part number: the SUM over every source rout row behind this
   *  desc-row (one PN can be listed several times with its own QTD each). */
  qtd?:  number
  /** Original per-unit hours (HH UNIT) straight from Locos Rout, never re-derived from
   *  `cells`. `hh_unit × qtd` reconstructs this row's scheduled hours. */
  hh_unit?: number
  /** WORKORDER from Locos Rout for this routing item (blank when the source cell is empty). */
  workorder?: string
  /** Display-only: every distinct WORKORDER for this part number, in source order.
   *  Used by the Plano de Produção view to show the WO progression across the
   *  scheduled production days. Empty/absent → fall back to `workorder`. */
  workorders?: string[]
  cells: Record<string, { hh: number }>
  /** Per-WORKORDER partition of this desc-row — present only when the row spans more than
   *  one work order. Each entry carries that WO's own quantity, per-unit hours and daily
   *  cells (Σ over entries reconstructs `qtd` / `cells` exactly). The Plano de Produção view
   *  renders one planning line per entry; a blank `workorder` ("") is its own line and stays
   *  blank. Absent → the desc-row is a single work order (or blank), described by the fields
   *  above. */
  wo_breakdown?: {
    workorder: string; qtd: number; hh_unit: number; cells: Record<string, { hh: number }>
    /** Per-WORK-ORDER copies of the three pass-through columns below — an item sharing a work
     *  order across several ESCOPOs keeps each line's own value. Absent when the source is blank. */
    part_desc?: string; escopo?: string; rout_linha?: string
  }[]
  /** ── Plano de Produção pass-through, straight from 'Locos Rout' ────────────────────────
   *  Consumed ONLY by the Plano de Produção grid; no scheduling figure derives from them.
   *  Absent when the source cell is blank — the grid then shows an empty cell (no fallback).
   *  `rout_linha` is the routing sheet's LINHA and is deliberately NOT the group's `linha`
   *  (the Schedule's line/type), which is a different value with a different meaning. */
  part_desc?:  string
  escopo?:     string
  rout_linha?: string
}

export interface GanttGroup {
  wo:           string
  task_name:    string
  linha:        string
  finish_ms?:   string
  /** Contratual — the CONTRACTUAL finish date (ISO), straight from the Schedule-MS import. An
   *  independent field: nothing in the scheduling maths reads it and no override moves it. Empty
   *  or absent when the loco has no contractual date. */
  contract_ms?: string
  start_ms?:    string | number | null
  takt?:        number
  /** Locomotive model fallback: true when this model had no routing and borrowed another
   *  model's hours/params. `wo` keeps the ORIGINAL name; the UI appends "(FB)" for display. */
  fallback?:       boolean
  /** The model whose routing/parameters were actually used when `fallback` is true. */
  fallback_model?: string
  workstations: GanttWorkstation[]
}

export interface GanttData {
  date_info:   GanttDateInfo[]
  fw_map:      Record<string, string>
  groups:      GanttGroup[]
  // Per-year fiscal-week label offsets (year → signed shift), non-zero only. Lets client code
  // derive override-aware FW labels for dates OUTSIDE date_info (e.g. out-of-window kit dates)
  // without re-inventing fiscal weeks. Absent/empty ⇒ default calendar (no override).
  fw_offsets?: Record<string, number>
  total_items?: number
  scenario_id?: string
  /** Mode-1 optimization metadata, embedded by the optimize stream on the result. */
  _optimization?: {
    /** LOCO keys "wo||task_name" whose WS40↔WS50 order the optimizer swapped
     *  (MX10 swap is evaluated automatically in every strategy). */
    swapped_locos?: string[]
    /** True when this optimization ran with "Permitir regras de sobreposição" — a
     *  boundary handoff on WS40/WS50 (max 2 LOCOs) is not counted as a conflict. */
    allow_overlap?: boolean
    [k: string]: unknown
  }
}

export async function getGanttData(): Promise<GanttData> {
  const res = await api.get<GanttData>('/api/gantt/data')
  return res.data
}


/** One manual LOCO edit (session-only). Absent fields = leave unchanged.
 *  takt: nova duração (0,5–15, passos de 0,5; decimais preservados) · startShift/finishShift: dias úteis −10..+10. */
export interface LocoEdit {
  wo:           string
  task_name:    string
  takt?:        number | null
  start_shift?: number | null
  finish_shift?: number | null
}

/** Apply the FULL accumulated set of manual LOCO edits over the base schedule and
 *  return the rebuilt GanttData. Stateless/session-only — resend every edit each call. */
export async function editLocos(edits: LocoEdit[]): Promise<GanttData> {
  try {
    const res = await api.post<GanttData>('/api/gantt/edit-locos', { edits }, { timeout: 120000 })
    return res.data
  } catch (err: unknown) {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    if (detail) throw new Error(detail)
    throw err
  }
}



export interface OptStreamEvent {
  type: 'log' | 'result' | 'error'
  msg?: string
  progress?: number
  message?: string
  data?: GanttData
  meta?: Record<string, unknown>
  detail?: string
}

export interface OptScopeFilter {
  /** WO keys currently loaded (back-compat coarse filter). */
  lineFilter?: string[]
  /** Exact LOCO keys "wo||task_name" visible in the Schedule. */
  locoKeys?: string[]
  /** Visible window start, ISO yyyy-mm-dd. */
  dateFrom?: string
  /** Visible window end, ISO yyyy-mm-dd. */
  dateTo?: string
  /** Client "Today" (ISO yyyy-mm-dd). Workstations before it are immutable for the
   *  optimizer (historical schedule preserved). Defaults to the local date. */
  today?: string
  /** Modo 1 shift strategy: whole LOCO, or only conflicting WS + successors. The MX10
   *  WS40↔WS50 swap is NOT a strategy — the optimizer evaluates it automatically in both. */
  strategy?: 'shift_full' | 'shift_conflict_only'
  /** Allow scheduling WS40/WS50 of conflicting LOCOs on Saturdays. */
  useSaturdays?: boolean
  /** "Permitir regras de sobreposição" (test): a boundary handoff on WS40/WS50 (end of
   *  one LOCO == start of another, max 2 LOCOs) is not counted/penalized as a conflict. */
  allowOverlap?: boolean
  /** Manual LOCO edits (session-only). The optimizer applies these FIRST and optimizes
   *  the resulting edited schedule — manual edits are the new baseline. */
  locoEdits?: LocoEdit[]
}

export async function optimizeGanttConflictsStreaming(
  onEvent: (evt: OptStreamEvent) => void,
  scope?: OptScopeFilter,
): Promise<GanttData> {
  const payload: Record<string, unknown> = {}
  if (scope?.lineFilter && scope.lineFilter.length > 0) payload.line_filter = scope.lineFilter
  if (scope?.locoKeys && scope.locoKeys.length > 0)     payload.loco_filter = scope.locoKeys
  if (scope?.dateFrom)                                  payload.date_from = scope.dateFrom
  if (scope?.dateTo)                                    payload.date_to = scope.dateTo
  // Always send "Today" so the optimizer freezes any Workstation plotted before it
  // (historical schedule stays exactly as loaded). Use the LOCAL date so it matches the
  // Schedule's Today highlight (worker localTodayIso, also local). Caller may override.
  {
    const _t = scope?.today ?? (() => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })()
    payload.today = _t
  }
  if (scope?.strategy)                                  payload.strategy = scope.strategy
  if (scope?.useSaturdays != null)                      payload.use_saturdays = scope.useSaturdays
  if (scope?.allowOverlap != null)                      payload.allow_overlap = scope.allowOverlap
  if (scope?.locoEdits && scope.locoEdits.length > 0)   payload.loco_edits = scope.locoEdits
  const body = JSON.stringify(payload)

  // Raw fetch bypasses the axios `api` interceptor, so it needs its OWN 401
  // detect → silent refresh → retry-once recovery (same contract as the axios
  // interceptor). The request payload is identical on retry, so all caller-side
  // selections/filters/period are preserved — we only re-attach a fresh token.
  // Loop guard: the refresh+retry happens at most ONCE (single linear path, no
  // recursion); a still-401, or a refresh that genuinely failed, falls through to
  // the error branch below and surfaces the real cause to the caller.
  const doFetch = (): Promise<Response> => {
    const token = getToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(`${API_URL}/api/gantt/optimize-conflicts/stream`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(180000),
    })
  }

  let res = await doFetch()
  if (res.status === 401) {
    // Token expired/invalid (incl. after a long idle). Try a single silent refresh
    // through the MSAL refresher registered by useAuth, then retry the request once.
    const refreshed = await refreshToken().catch(() => false)
    if (refreshed && getToken()) {
      res = await doFetch()
    }
    // Still rejected after the refresh attempt → unrecoverable silently. Trigger the
    // global re-login modal (same contract as the axios interceptor) so the user is
    // never stranded; the streaming caller still gets the HTTP error below to clear
    // its own spinner.
    if (res.status === 401) triggerReauth()
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const json = trimmed.slice(5).trim()
      if (!json) continue
      let evt: OptStreamEvent
      try { evt = JSON.parse(json) } catch { continue }
      onEvent(evt)
      if (evt.type === 'error') throw new Error(evt.msg ?? 'Erro desconhecido na otimização.')
      if (evt.type === 'result' && evt.data) return evt.data
    }
  }

  throw new Error('Stream encerrado sem resultado.')
}









/** True when a request failed because the caller aborted it (e.g. ESC during a long
 *  load) — callers treat this as a silent cancel, never as an error to display. */
export function isRequestCancelled(err: unknown): boolean {
  return axios.isCancel(err)
}

/** Extract a friendly message from an axios error (FastAPI `detail` field). */
function warehouseErrorMessage(err: unknown, fallback: string): string {
  const ax = err as AxiosError<{ detail?: string }>
  const detail = ax?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  const root = (err as { _rootCause?: string })?._rootCause
  if (root) return root
  return fallback
}







// ── Horas Transacionadas — load & persist (phase 1) ──────────────────────────
// Pull the actual-hours snapshot from the warehouse once and store it in our own DB, so the
// display layer works in sessions with no warehouse access.
//
// Both preview and save require the ADMIN unlock grant (sent automatically by the request
// interceptor once the user has unlocked); save additionally carries IMPORT_PASSWORD as
// `importPassword`. Two different secrets — do not collapse them.



export interface TransactedHoursStatus {
  has_data:     boolean
  /** False while a database still holds only the pre-snapshot relational batch. */
  snapshot?:    boolean
  /** Snapshot version — echo it back as `baseVersion` on save so a publish that happened
   *  meanwhile is refused (409) instead of silently overwritten. 0 = no snapshot yet. */
  version?:     number
  batch_id?:    number
  created_at?:  string | null
  created_by?:  string
  start_date?:  string | null
  end_date?:    string | null
  orgs?:        string[]
  row_count?:   number
  total_hours?: number
  txn_count?:   number
  truncated?:   boolean
}


/**
 * One locomotive the rollup may attribute hours to.
 *
 * `name` is the DISPLAY name and may carry an artificial disambiguation tag (`B3#…`) that
 * exists only because the schedule cannot hold two locos of the same name; the server
 * strips it before comparing against a work order, and keys the response by the name as
 * sent. `tipo` + `ws` + `items` are the evidence used ONLY when the same serial is planned
 * under two Tipos — then the row goes to whichever Tipo's routing really contains the
 * workstation/part number it was booked against, instead of to whoever matched first.
 */
export interface LocoScope {
  name: string
  tipo?: string
  /** Workstation codes in this loco's routing, upper-cased. */
  ws?: string[]
  /** "WORKSTATION||PART NUMBER" pairs in this loco's routing, upper-cased. */
  items?: string[]
}

/** Rollup scope: the locos, plus the workstation vocabulary of each Tipo (the last
 *  tie-break when a serial collides and neither loco's own routing has the station). */
export interface TransactedHoursScope {
  locos: LocoScope[]
  typeWs?: Record<string, string[]>
}



export interface TransactedHoursLocoItem {
  workstation: string
  part_number: string
  hours:       number
}

export interface TransactedHoursLoco {
  hours:           number
  workorder_count: number
  /** (workstation, part number) breakdown — the grain needed to place hours booked
   *  against a station/item pair that was never in the plan. */
  items:           TransactedHoursLocoItem[]
}

export interface TransactedHoursRollup {
  has_data:   boolean
  /** True when this came from a prévia that has NOT been written to the database. The
   *  display must say so — a pending number is visually identical to a stored one. */
  pending?:   boolean
  batch?:     TransactedHoursStatus | null
  locos:      Record<string, TransactedHoursLoco>
  /** Hours no loco in scope claimed. A large bucket here means the work-order prefix rule
   *  is wrong — the difference between "few hours logged" and "matching is broken". It also
   *  now holds rows whose serial is planned under two Tipos where NEITHER Tipo's routing
   *  has the workstation: refusing to pick is what stops one Tipo swallowing the other's. */
  unmatched?: { workorders: number; hours: number; sample: string[] }
  /** Awarded, but the serial exists under more than one Tipo and both routings could take
   *  the row. Included in the per-loco totals; reported so the collision can be fixed. */
  ambiguous?: { workorders: number; hours: number; sample: string[] }
}




// ── Logística: the shared stored base ────────────────────────────────────────
// The tab normally reads a workbook that never leaves the browser. An Admin can publish one
// of those workbooks as the base everyone opens on; these two calls are that feature's whole
// server surface.






// ── SQL Server direct-access PoC (experimental) ─────────
// Feasibility test: connect DIRECTLY to the Taktline warehouse via pytds and read
// the "Horas Transacionadas" columns, bypassing the warehouse. Diagnostics only.






// ── In-app dataset viewer / targeted editor ───────────────────────────────────
// Editor+ role AND the admin second factor are enforced server-side
// (require_editor_unlock). The X-Admin-Unlock grant auto-attaches via the request
// interceptor; a missing/expired grant returns 401 (X-Admin-Unlock-Required) and the
// response interceptor surfaces the unlock modal. The export path is gated a second
// time by the shared application password (IMPORT_PASSWORD), prompted per download and
// never cached — see exportDbDataset.







/** Pull the JSON `detail` out of an axios error whose body came back as a Blob
 *  (responseType: 'blob'), falling back to the error's own message. */
async function blobErrorDetail(err: unknown): Promise<string | null> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { detail?: string }
      if (parsed?.detail) return parsed.detail
    } catch {
      /* not JSON — fall through to the generic message */
    }
  }
  return err instanceof Error && err.message ? err.message : null
}

// ── Autenticação própria (substituiu o Azure AD / Entra ID) ───────────────────
// Três rotas SEM token — login, solicitação de acesso e renovação — mais a troca de senha,
// que já exige sessão. Nenhuma delas passa pela recuperação de 401 do interceptor (ver
// _isAuthRoute): um 401 aqui significa "senha errada", não "sessão morta".

export interface AuthSessionUser {
  username: string
  email: string
  name: string
  role: UserRole
}

export interface AuthLoginResult {
  token: string
  expiresIn: number
  user: AuthSessionUser
}

/** Entra com usuário + senha. O usuário pode vir como 'nome.sobrenome' ou como e-mail completo —
 *  o servidor normaliza para a parte antes do '@', que é a chave do cadastro. */
export async function authLogin(username: string, password: string): Promise<AuthLoginResult> {
  const res = await api.post<AuthLoginResult>('/api/auth/login', { username, password })
  return res.data
}

/** Renova o token de uma sessão ainda válida. Usado pelo interceptor no 401 e pela
 *  renovação periódica; falha (401/403) significa que a sessão acabou de verdade. */
export async function authRefresh(): Promise<AuthLoginResult> {
  const res = await api.post<AuthLoginResult>('/api/auth/refresh', {})
  return res.data
}


// ── User permissions (Reader / Editor / Admin) ────────────────────────────────
export type UserRole = 'reader' | 'editor' | 'admin'

export interface MyPermission {
  username: string
  role: UserRole
  locked?: boolean
  blocked?: boolean
  /** Why access is denied — 'banned' (admin revoked this account) vs 'unregistered'
   *  (the account no longer exists on the roster: it was deleted while signed in).
   *  Drives which message is shown. */
  blockedReason?: 'banned' | 'unregistered' | null
  email?: string
  /** The account still uses a password somebody else chose (migration or admin reset). */
}

// Concurrent callers share ONE in-flight request. PermissionsProvider re-runs its fetch on
// account change, token change and manual refresh, and those can overlap (a token landing
// while the first fetch is still out) — each duplicate additionally paid the interceptor's
// 401 refresh+retry, so /api/permissions/me arrived in bursts. Coalescing removes the burst
// without changing any caller.
let _myPermInFlight: Promise<MyPermission> | null = null

/** Resolve the current user's role (Reader is the default for anyone not explicitly listed).
 *  `locked` = within a failed-password lockout; `blocked` = hard admin ban (access denied). */
export function getMyPermission(): Promise<MyPermission> {
  if (_myPermInFlight) return _myPermInFlight
  _myPermInFlight = api
    .get<MyPermission>('/api/permissions/me')
    .then(res => res.data)
    .finally(() => { _myPermInFlight = null })
  return _myPermInFlight
}
















// ── Admin-editable working calendar (Manage Calendar) ─────────────────────────





/** Read the admin override delta (holiday/working dates). Any authenticated user —
 *  the frontend merges it into its base calendar so client-side business-day helpers
 *  honor admin edits. */
export async function getCalendarExceptions(): Promise<{ holidays: string[]; working: string[] }> {
  const res = await api.get<{ status: string; holidays: string[]; working: string[] }>(
    '/api/calendar/exceptions',
  )
  return { holidays: res.data.holidays ?? [], working: res.data.working ?? [] }
}

/**
 * The working calendar for a date range, in the SAME row shape `GanttData.date_info` carries.
 * Any authenticated user.
 *
 * This is the period AXIS for a surface that has no Schedule behind it. Every axis in the app
 * — activeYearMonths, activeFws, monthBusinessDays, fwBusinessDays, the fiscal-week ordering —
 * is derived from `date_info`; without one, a surface holding real hours renders empty. The
 * GCR plan is the first such surface.
 *
 * Not `getCalendar`, which is Admin-only and returns the override rows behind the Manage
 * Calendar screen. This returns only the computed calendar.
 */
export async function calendarDateInfo(from: string, to: string): Promise<{
  date_info: GanttDateInfo[]
  fw_offsets: Record<string, number>
}> {
  const res = await api.get<{ status: string; date_info: GanttDateInfo[]; fw_offsets: Record<string, number> }>(
    '/api/calendar/date-info', { params: { from, to } },
  )
  return { date_info: res.data.date_info ?? [], fw_offsets: res.data.fw_offsets ?? {} }
}




// ── Headcount / Workstation management (Editor+ · second factor) ────────────────────
// Centralizes WS + people + capacity limits (Step 1: tab + CRUD + import + persistence
// only — not yet wired in as the capacity-calc source, see ManageHeadcountModal).

export interface HeadcountWorkstation {
  id:           number
  wsn:          string
  area:         string
  desc:         string
  hour_limit:   number | null
  people_limit: number | null
  qtde:         number | null
  turnos:       number | null
  people:       string[]
  /** Expertise level this workstation REQUIRES (`r[w]`, 0–3; 0/null = not set).
   *  See lib/expertise.ts. */
  required_level?: number | null
  /** CLIENT-SIDE working copy of the questionnaire answers per person NAME, parsed out of
   *  `expertise_meta[name].answers` on load. The server never sends this key — it exists so an
   *  unsaved assessment travels with the draft (and its undo history) and is replayed on Save
   *  together with the level it produced. */
  expertise_answers?: Record<string, number[]>
  /** CLIENT-SIDE working copy of the questionnaire answers behind `required_level`, parsed out
   *  of `required_meta.answers` on load — same role `expertise_answers` plays for the pairs. */
  required_answers?: number[]
  /** Provenance of `required_level`: who set it, when, and with which answers. Absent on a
   *  workstation whose target was never recorded. */
  required_meta?: {
    source: string; answers: string; updated_at: string | null; updated_by: string
  }
  /** Provenance of each stored level, keyed by person NAME: who assessed it, when, how, and
   *  (for the questionnaire) with which answers. Absent for pairs never assessed. */
  expertise_meta?: Record<string, {
    source: string; answers: string; updated_at: string | null; updated_by: string
  }>
  /** Expertise level each linked person HOLDS here (`e[p,w]`), keyed by person NAME —
   *  the same key `people` uses, so both sides of the relationship read off one field.
   *  A linked person missing from this map has never been assessed (= level 0). */
  expertise?:   Record<string, number>
  updated_at:   string | null
  updated_by:   string
}

export interface HeadcountLeave {
  id:         number
  person_id:  number
  start_date: string
  end_date:   string
  note:       string
}

export interface HeadcountPerson {
  id:         number
  name:       string
  /** Home area (B1/B2/B3/WGS), mirroring the workstation's. '' when unset. */
  area:       string
  active:     boolean
  leaves:     HeadcountLeave[]
  updated_at: string | null
}

export interface HeadcountResponse {
  status:       string
  workstations: HeadcountWorkstation[]
  people:       HeadcountPerson[]
}

/** Full workstation + people + vacation snapshot. Editor+ · second factor. */
export async function getHeadcount(): Promise<HeadcountResponse> {
  const res = await api.get<HeadcountResponse>('/api/headcount')
  return res.data
}

















// ── Admin notification feed (SecurityEvent trail → header badge) ──────────────






// ── Admin second factor ("unlock") ────────────────────────────────────────────
