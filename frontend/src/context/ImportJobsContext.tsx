'use client'
/**
 * ImportJobsContext — global registry for background DB import jobs.
 *
 * Keeps polling active job status even while ExcelModal is closed or
 * the user navigates to a different tab. At most one active job per
 * DbKey (discretizado | schedule | locos_rout).
 */
import { createContext, useContext, useRef, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  importExcelToDb,
  importScheduleToDb,
  importLocosRoutToDb,
  importItensRoutToDb,
  importPlanoProdToDb,
  importHeadcountToDb,
  getDbImportStatus,
  cancelDbImport,
} from '@/lib/api'
import type { DbImportMode } from '@/lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

export type DbKey = 'discretizado' | 'schedule' | 'locos_rout' | 'itens_rout' | 'plano_prod' | 'headcount'

/**
 * Viewer-only datasets: they exist in the backend's _DB_DATASETS registry and can be
 * explored/edited, but they are NOT importable — there is no file and no sheet behind them.
 * Kept OUT of `DbKey` on purpose: that type is the import surface (ExcelModal tabs, job
 * tracking, ImportProgressFloat), and widening it would put a tab in the Importação flow
 * for something no one can upload.
 *
 * `itens_rout_locus` is a four-column window onto itens_rout — LOCUS/COMP1/FAMILIA2/QTDE
 * LOCUS, the per-locomotive quantities that scale New Locos hours. Same rows, different
 * question, so it reads as its own table.
 */
export type DbViewerOnlyKey = 'itens_rout_locus'
export type DbViewerKey = DbKey | DbViewerOnlyKey

export const DB_META: Record<DbViewerKey, { label: string; desc: string; sheet: string }> = {
  discretizado: { label: 'Discretizado',  desc: 'Demanda mensal',       sheet: 'Discretizado'  },
  schedule:     { label: 'Schedule - MS', desc: 'Programação de linha', sheet: 'Schedule - MS' },
  locos_rout:   { label: 'Locos Rout',    desc: 'Roteiro de locos',     sheet: 'Locos Rout'    },
  itens_rout:   { label: 'Itens Rout',    desc: 'Roteiro de itens',     sheet: 'Itens Rout'    },
  plano_prod:   { label: 'Plano Prod',    desc: 'Plano de produção',    sheet: 'Plano Prod'    },
  headcount:    { label: 'HeadCount',     desc: 'Workstations/pessoas', sheet: 'HeadCount'     },
  itens_rout_locus: { label: 'Itens Rout · Locus', desc: 'Qtd. por loco (New Locos)', sheet: 'Itens Rout' },
}

/** Viewer tables derived from an importable base, shown alongside it in DbDatasetModal. */
export const DB_VIEWER_EXTRAS: Partial<Record<DbKey, DbViewerOnlyKey[]>> = {
  itens_rout: ['itens_rout_locus'],
}

export type JobStatus = 'uploading' | 'success' | 'error' | 'cancelled'

export interface ImportJob {
  jobId:        string
  dbKey:        DbKey
  fileName:     string
  /** How this job was started — 'append' keeps the existing base. */
  mode:         DbImportMode
  status:       JobStatus
  logs:         string[]
  progress:     number | null   // 0-100, null = indeterminate
  phase:        string
  resultDetail: string | null
  /** True once the user clicks Cancel and before the job reaches a terminal state. */
  cancelling:   boolean
}

interface ImportJobsContextType {
  /** Map of at most 3 jobs (one per DbKey). */
  jobs:         Partial<Record<DbKey, ImportJob>>
  startImport:  (dbKey: DbKey, file: File, password: string, mode?: DbImportMode) => Promise<void>
  cancelJob:    (dbKey: DbKey) => Promise<void>
  dismissJob:   (dbKey: DbKey) => void
  /** Whether a specific db is currently uploading (blocks starting another for the same db). */
  isUploading:  (dbKey: DbKey) => boolean
}

// ── Context ───────────────────────────────────────────────────────────────────

const ImportJobsContext = createContext<ImportJobsContextType | null>(null)

export function useImportJobs() {
  const ctx = useContext(ImportJobsContext)
  if (!ctx) throw new Error('useImportJobs must be used inside ImportJobsProvider')
  return ctx
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseProgress(logs: string[]): { progress: number | null; phase: string } {
  let current = 0, total = 0, phase = 'Preparando importação…'
  for (const line of logs) {
    const m = line.match(/(\d+)\/(\d+) linhas processadas/)
    if (m) {
      current = parseInt(m[1])
      total   = parseInt(m[2])
      phase   = `Importando para staging — ${current.toLocaleString('pt-BR')} / ${total.toLocaleString('pt-BR')}`
    } else if (line.includes('[CANCEL]')) {
      phase = 'Cancelado'
    } else if (line.includes('[OK]')) {
      phase = 'Concluído!'
    } else if (line.includes('[APPLY]')) {
      phase = 'Aplicando atualização…'
    } else if (line.includes('[VALIDATE]')) {
      phase = 'Validando dados…'
    } else if (line.includes('[STAGE]')) {
      phase = 'Importando para staging…'
    } else if (line.includes('[PREPARE]') || line.includes('Criando') || line.includes('limpando') || line.includes('Limpando')) {
      phase = 'Preparando importação…'
    } else if (line.includes('Lendo') || line.includes('planilha') || line.includes('arquivo')) {
      phase = 'Lendo planilha Excel…'
    }
  }
  const progress = total > 0 ? Math.round(current / total * 100) : null
  return { progress, phase }
}

async function callImportApi(dbKey: DbKey, file: File, password: string, mode: DbImportMode) {
  if (dbKey === 'discretizado') return importExcelToDb(file, password, mode)
  if (dbKey === 'schedule')     return importScheduleToDb(file, password, mode)
  if (dbKey === 'locos_rout')   return importLocosRoutToDb(file, password, mode)
  if (dbKey === 'itens_rout')   return importItensRoutToDb(file, password, mode)
  if (dbKey === 'headcount')    return importHeadcountToDb(file, password, mode)
  return importPlanoProdToDb(file, password, mode)
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function ImportJobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Partial<Record<DbKey, ImportJob>>>({})
  // jobId → dbKey map for polling (jobs might have been dismissed but polling still running)
  const pollingRef = useRef<Partial<Record<DbKey, ReturnType<typeof setInterval>>>>({})

  const stopPolling = useCallback((dbKey: DbKey) => {
    const iv = pollingRef.current[dbKey]
    if (iv != null) { clearInterval(iv); delete pollingRef.current[dbKey] }
  }, [])

  // Clean up on unmount
  useEffect(() => () => {
    for (const iv of Object.values(pollingRef.current)) {
      if (iv != null) clearInterval(iv)
    }
  }, [])

  const startImport = useCallback(async (dbKey: DbKey, file: File, password: string, mode: DbImportMode = 'replace') => {
    // Prevent duplicate upload for same db
    const existing = jobs[dbKey]
    if (existing?.status === 'uploading') return

    const { progress, phase } = parseProgress([])
    const initialJob: ImportJob = {
      jobId:        '',
      dbKey,
      fileName:     file.name,
      mode,
      status:       'uploading',
      logs:         [],
      progress,
      phase,
      resultDetail: null,
      cancelling:   false,
    }
    setJobs(prev => ({ ...prev, [dbKey]: initialJob }))

    let jobId: string
    try {
      const res = await callImportApi(dbKey, file, password, mode)
      jobId = res.job_id
    } catch (err: unknown) {
      const detail = (() => {
        // Server answered with an error body → use its detail.
        if (err && typeof err === 'object' && 'response' in err && (err as { response?: unknown }).response) {
          const r = (err as { response?: { data?: { detail?: string } } }).response
          if (r?.data?.detail) return r.data.detail
        }
        // No HTTP response → expose the real network root cause set by the
        // axios interceptor instead of a generic "Network Error".
        const rootCause = (err as { _rootCause?: string })?._rootCause
        if (rootCause) return `Falha de rede: ${rootCause}`
        return err instanceof Error ? err.message : 'Erro desconhecido'
      })()
      setJobs(prev => ({
        ...prev,
        [dbKey]: { ...initialJob, status: 'error', phase: 'Falha', resultDetail: detail },
      }))
      return
    }

    // Update job with the assigned jobId
    setJobs(prev => ({
      ...prev,
      [dbKey]: { ...(prev[dbKey] ?? initialJob), jobId },
    }))

    // Start polling
    stopPolling(dbKey)
    // Consecutive status-poll failures. The catch below used to swallow errors forever, so a
    // backend that died mid-import left this 2s interval hammering /status indefinitely (and
    // every beat also paid the axios transient retry). Bounded like useOptimization's poller:
    // ~30s of uninterrupted failure ends the poll and surfaces an error instead of looping.
    let pollFails = 0
    const MAX_POLL_FAILS = 15
    const iv = setInterval(async () => {
      try {
        const s = await getDbImportStatus(jobId)
        pollFails = 0
        const { progress: prog, phase } = parseProgress(s.logs)

        if (s.status === 'done') {
          stopPolling(dbKey)
          const detail = s.result?.message ?? `${s.result?.rows ?? '?'} linhas importadas.`
          setJobs(prev => ({
            ...prev,
            [dbKey]: prev[dbKey]
              ? { ...prev[dbKey]!, status: 'success', logs: s.logs, progress: 100, phase: 'Concluído!', resultDetail: detail }
              : prev[dbKey],
          }))
        } else if (s.status === 'error') {
          stopPolling(dbKey)
          setJobs(prev => ({
            ...prev,
            [dbKey]: prev[dbKey]
              ? { ...prev[dbKey]!, status: 'error', logs: s.logs, progress: null, phase: 'Erro', resultDetail: s.error ?? 'Erro desconhecido' }
              : prev[dbKey],
          }))
        } else if (s.status === 'cancelled') {
          stopPolling(dbKey)
          setJobs(prev => ({
            ...prev,
            [dbKey]: prev[dbKey]
              ? { ...prev[dbKey]!, status: 'cancelled', logs: s.logs, progress: null, phase: 'Cancelado', resultDetail: 'Importação cancelada.' }
              : prev[dbKey],
          }))
        } else {
          // still running — but if the user already requested cancel, keep the
          // "Cancelando…" feedback visible instead of letting it flicker back.
          setJobs(prev => {
            const j = prev[dbKey]
            if (!j) return prev
            return {
              ...prev,
              [dbKey]: j.cancelling
                ? { ...j, logs: s.logs, progress: null, phase: 'Cancelando…' }
                : { ...j, logs: s.logs, progress: prog, phase },
            }
          })
        }
      } catch {
        // Transient poll errors are ignored (the import itself is still running server-side),
        // but only up to MAX_POLL_FAILS in a row — see above.
        pollFails += 1
        if (pollFails >= MAX_POLL_FAILS) {
          stopPolling(dbKey)
          setJobs(prev => ({
            ...prev,
            [dbKey]: prev[dbKey]
              ? { ...prev[dbKey]!, status: 'error', progress: null, phase: 'Erro',
                  resultDetail: 'Perdeu contato com o servidor durante a importação. Recarregue para ver o estado final.' }
              : prev[dbKey],
          }))
        }
      }
    }, 2000)
    pollingRef.current[dbKey] = iv
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, stopPolling])

  const cancelJob = useCallback(async (dbKey: DbKey) => {
    const job = jobs[dbKey]
    // Ignore if no active job, already finished, or a cancel is already pending
    // (prevents repeated clicks firing duplicate cancel requests).
    if (!job || job.status !== 'uploading' || !job.jobId || job.cancelling) return
    // Immediately reflect cancel request in UI — don't wait for API round-trip
    setJobs(prev => ({
      ...prev,
      [dbKey]: prev[dbKey]
        ? { ...prev[dbKey]!, cancelling: true, phase: 'Cancelando…', progress: null }
        : prev[dbKey],
    }))
    try {
      await cancelDbImport(job.jobId)
    } catch {
      // Cancel request itself failed — clear the pending flag so the user can retry.
      setJobs(prev => ({
        ...prev,
        [dbKey]: prev[dbKey] && prev[dbKey]!.status === 'uploading'
          ? { ...prev[dbKey]!, cancelling: false, phase: 'Falha ao cancelar — tente novamente' }
          : prev[dbKey],
      }))
    }
  }, [jobs])

  const dismissJob = useCallback((dbKey: DbKey) => {
    stopPolling(dbKey)
    setJobs(prev => {
      const next = { ...prev }
      delete next[dbKey]
      return next
    })
  }, [stopPolling])

  const isUploading = useCallback((dbKey: DbKey) => {
    return jobs[dbKey]?.status === 'uploading'
  }, [jobs])

  return (
    <ImportJobsContext.Provider value={{ jobs, startImport, cancelJob, dismissJob, isUploading }}>
      {children}
    </ImportJobsContext.Provider>
  )
}
