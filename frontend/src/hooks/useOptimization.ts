import { useState, useRef, useCallback, useEffect } from 'react'
import axios from 'axios'
import {
  startOptimization,
  getJob,
  cancelJob,
  connectJobWebSocket,
  type Job,
  type OptimizationPayload,
} from '@/lib/api'

const ACTIVE_JOB_KEY = 'taktline_active_job_id'

const TERMINAL_STATES = new Set<string>(['done', 'error', 'cancelled'])

export function useOptimization() {
  const [jobId,   setJobId]   = useState<string | null>(null)
  const [job,     setJob]     = useState<Job | null>(null)
  const [loading, setLoading] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollFailuresRef = useRef(0)
  const activeJobIdRef = useRef<string | null>(null)
  // Tracks whether the current run has reached a terminal state.
  // Used to prevent stale HTTP poll responses from reverting the UI
  // after the WebSocket already delivered done/error/cancelled.
  const reachedTerminalRef = useRef(false)

  const clearPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const setActiveJobId = useCallback((id: string | null) => {
    try {
      if (id) window.sessionStorage.setItem(ACTIVE_JOB_KEY, id)
      else window.sessionStorage.removeItem(ACTIVE_JOB_KEY)
    } catch {
      // Ignore storage errors.
    }
  }, [])

  const getActiveJobId = useCallback((): string | null => {
    try {
      return window.sessionStorage.getItem(ACTIVE_JOB_KEY)
    } catch {
      return null
    }
  }, [])

  function formatErr(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const detail = err.response?.data?.detail
      if (typeof detail === 'string' && detail.trim()) return detail
      if (typeof err.message === 'string' && err.message.trim()) return err.message
    }
    if (err instanceof Error && err.message) return err.message
    return String(err)
  }

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) return
    const tick = async () => {
      if (activeJobIdRef.current !== id) return
      try {
        const data = await getJob(id)
        if (activeJobIdRef.current !== id) return
        if (!data || typeof data.status !== 'string') return

        pollFailuresRef.current = 0

        // Guard: never regress from a terminal state (done/error/cancelled) to
        // a non-terminal one. This prevents stale in-flight HTTP responses from
        // overwriting the terminal state that was already delivered by the WS.
        if (reachedTerminalRef.current && !TERMINAL_STATES.has(data.status)) return

        setJob(data)
        if (TERMINAL_STATES.has(data.status)) {
          reachedTerminalRef.current = true
          clearPolling()
          setLoading(false)
        }
      } catch (err) {
        if (activeJobIdRef.current !== id) return

        pollFailuresRef.current += 1
        if (pollFailuresRef.current >= 8) {
          clearPolling()
          setJob(prev => ({
            status: 'error',
            progress: prev?.progress ?? 0,
            message: 'Falha ao acompanhar progresso do job.',
            result: prev?.result ?? null,
            error: formatErr(err),
            log: prev?.log ?? [],
          }))
          setLoading(false)
        }
      }
    }

    // First read immediately to avoid waiting for interval and to reduce
    // chances of staying in the queued/initial state in cloud environments.
    void tick()

    pollRef.current = setInterval(async () => {
      await tick()
    }, 1500)
  }, [clearPolling])

  const attachToJob = useCallback((id: string) => {
    clearPolling()
    wsRef.current?.close()
    pollFailuresRef.current = 0

    activeJobIdRef.current = id
    setJobId(id)
    setActiveJobId(id)
    setLoading(true)
    setJob(prev => ({
      status: prev?.status ?? 'queued',
      progress: prev?.progress ?? 0,
      message: prev?.message ?? 'Reconectando ao job em execução...',
      result: prev?.result ?? null,
      error: prev?.error ?? null,
      log: prev?.log ?? [],
    }))

    // Start HTTP polling immediately.
    startPolling(id)

    let wsReceivedMessage = false
    wsRef.current = connectJobWebSocket(
      id,
      (data) => {
        if (activeJobIdRef.current !== id) return
        if (!data || typeof data.status !== 'string') return

        // Same regression guard for WebSocket messages (belt-and-suspenders)
        if (reachedTerminalRef.current && !TERMINAL_STATES.has(data.status)) return

        // First WS message → stop concurrent HTTP polling.
        // Both ran in parallel initially to handle environments where WS may not
        // connect.  Once WS is active it's faster and more reliable; keeping the
        // poll alive can push stale progress values (e.g. Phase 4's 78%) after
        // the WS has already advanced to Phase 5's 88%, animating the bar
        // backward.
        if (!wsReceivedMessage) {
          clearPolling()
        }
        wsReceivedMessage = true
        setJob(data)
        if (TERMINAL_STATES.has(data.status)) {
          reachedTerminalRef.current = true
          setLoading(false)
        }
      },
      () => {
        if (activeJobIdRef.current !== id) return
        // WS closed unexpectedly.  If job is not done, fall back to polling.
        if (!reachedTerminalRef.current) startPolling(id)
      },
    )
  }, [clearPolling, setActiveJobId, startPolling])

  const run = useCallback(async (payload: OptimizationPayload) => {
    clearPolling()
    wsRef.current?.close()
    pollFailuresRef.current = 0
    activeJobIdRef.current = null
    reachedTerminalRef.current = false
    setJobId(null)
    setActiveJobId(null)

    setLoading(true)
    setJob({
      status: 'queued',
      progress: 0,
      message: 'Enviando job para o backend...',
      result: null,
      error: null,
      log: [],
    })

    try {
      const { job_id } = await startOptimization(payload)
      setJob({
        status: 'queued',
        progress: 2,
        message: 'Job criado. Conectando ao stream de progresso...',
        result: null,
        error: null,
        log: [],
      })
      attachToJob(job_id)
    } catch (err) {
      setJob({
        status: 'error',
        progress: 0,
        message: 'Falha ao iniciar otimização.',
        result: null,
        error: formatErr(err),
        log: [],
      })
      setLoading(false)
      setActiveJobId(null)
    }
  }, [attachToJob, clearPolling, setActiveJobId])

  const cancel = useCallback(async () => {
    if (!jobId) return
    try {
      await cancelJob(jobId)
    } catch {
      // Ignore cancel errors; local UI will still stop streaming.
    }
    wsRef.current?.close()
    clearPolling()
    activeJobIdRef.current = null
    reachedTerminalRef.current = false
    setJobId(null)
    setLoading(false)
    setActiveJobId(null)
  }, [jobId, clearPolling, setActiveJobId])

  useEffect(() => {
    return () => {
      wsRef.current?.close()
      clearPolling()
    }
  }, [clearPolling])

  const isRunning = loading && job?.status === 'running'
  const isDone    = job?.status === 'done'
  const isError   = job?.status === 'error'

  return { job, jobId, run, attachToJob, getActiveJobId, cancel, isRunning, isDone, isError }
}