'use client'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { isStaleBuildError, reloadForStaleBuild, errorDetails } from '@/lib/staleBuild'

/**
 * AppErrorBoundary — a LOCAL, self-healing error boundary.
 *
 * Why this exists
 * ───────────────
 * `app/error.tsx` is the route boundary, and until now it was the ONLY boundary in the app. That
 * makes every throw global: `page.tsx` keeps both LayoutShells permanently mounted (a Gantt
 * dataset, its overrides, the loaded scenarios, every open modal's state all live in React state
 * inside them), so a single bad cell in a summary table replaced the whole application with the
 * night screen and `reset()` re-rendered it from INITIAL state. Nothing was recoverable — the
 * "reload and it works" the user saw is the work being thrown away, not the failure being fixed.
 *
 * Two things fix that, and this component is both:
 *
 * 1. CONTAINMENT. Wrapped around a subtree, a crash inside it takes down only that subtree. The
 *    app shell, the other app, and every other modal keep their state and stay usable.
 *
 * 2. ONE SILENT RETRY. A render that threw on a transient state (data mid-flight, a worker result
 *    that has not landed, a token being refreshed) usually succeeds on the very next attempt.
 *    React does NOT retry on its own — it commits the fallback and stops — so the first failure is
 *    retried here, once, after a frame. Nothing is drawn during that window: a transient throw is
 *    invisible instead of being a dead end. A second failure is real and gets the fallback.
 *
 * The retry budget is per boundary instance and is refilled by `resetKey` (a new dataset, a new
 * scenario) and by the user pressing "Tentar novamente" — never by a timer, so a component that
 * throws on every render can never spin.
 *
 * Before either of those, a STALE BUILD is recognised and answered with a reload: a tab left open
 * across a deploy asks for chunk filenames the server no longer has, the fetch 404s and throws
 * mid-render, and no amount of retrying inside this document can fix it. See lib/staleBuild.
 *
 * The message and the first stack frames are shown, collapsed, under "Detalhes técnicos" — the
 * full error always goes to the console as well. Withholding them is what made a reproducible
 * crash impossible to name from a user's report; `errorDetails` carries the reasoning.
 */

/** Delay before the silent retry. One frame is enough to let a pending state land; long enough
 *  that the remount is not folded into the same commit that just failed. */
const RETRY_DELAY_MS = 120
/** Silent retries per boundary instance. One: the second failure is not transient. */
const MAX_AUTO_RETRIES = 1

interface Props {
  children: ReactNode
  /** Identifies the subtree in the console line and in the fallback copy. */
  name: string
  /** Optional escape hatch beside "Tentar novamente" — e.g. closing the modal that crashed. */
  onDismiss?: () => void
  /** Label for that escape hatch. */
  dismissLabel?: string
  /** Changing this clears the error and refills the retry budget: new input is a new chance. */
  resetKey?: unknown
  /** Replaces the default panel. Receives the retry callback. */
  fallback?: (retry: () => void) => ReactNode
}

interface State {
  error: Error | null
  /** Silent retries already spent on this instance. */
  retries: number
  /** True between catching and the silent retry — renders NOTHING, so a transient throw
   *  never flashes an error panel at the user. */
  retrying: boolean
  /** A stale-build reload is under way: the document is on its way out, so draw nothing. */
  reloading: boolean
  /** "Detalhes técnicos" open. */
  showDetails: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retries: 0, retrying: false, reloading: false, showDetails: false }
  private timer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[OptVision] ${this.props.name} crashed:`, error, info.componentStack)

    // A chunk this build cannot fetch any more: nothing in this document can recover it, and
    // retrying would just throw on the same missing file. Reload onto the new build instead.
    if (isStaleBuildError(error) && reloadForStaleBuild()) {
      this.setState({ reloading: true })
      return
    }

    if (this.state.retries < MAX_AUTO_RETRIES) {
      this.setState(s => ({ retrying: true, retries: s.retries + 1 }))
      this.timer = setTimeout(() => {
        this.timer = null
        this.setState({ error: null, retrying: false })
      }, RETRY_DELAY_MS)
    }
  }

  componentDidUpdate(prev: Props) {
    // New input — drop the error and hand the subtree a full retry budget again.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.reset()
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer)
  }

  private reset = () => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.setState({ error: null, retries: 0, retrying: false, reloading: false, showDetails: false })
  }

  render() {
    const { error, retrying, reloading, showDetails } = this.state
    if (!error) return this.props.children
    // A reload or the silent retry is in flight: draw nothing at all.
    if (reloading || retrying) return null
    if (this.props.fallback) return this.props.fallback(this.reset)

    const { onDismiss, dismissLabel = 'Fechar' } = this.props
    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(17,24,39,0.45)', backdropFilter: 'blur(2px)',
        }}
        role="alert"
      >
        <div
          style={{
            background: '#fff', borderRadius: 12, padding: '22px 24px',
            maxWidth: 420, width: 'calc(100% - 48px)',
            boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <AlertTriangle size={17} color="#D32F2F" />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
              Esta parte não pôde ser exibida
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.6 }}>
            O restante do aplicativo continua carregado — nada do que você fez foi perdido.
            Tente novamente; se persistir, feche e reabra esta tela.
          </div>
          {/* Collapsed by default: whoever just wants to keep working should not have to read a
              stack trace, and whoever is reporting the crash needs exactly this text. */}
          <button
            onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
            style={{
              all: 'unset', boxSizing: 'border-box', alignSelf: 'flex-start', cursor: 'pointer',
              fontSize: 11, color: '#9CA3AF', borderBottom: '1px dotted #9CA3AF', lineHeight: 1.3,
            }}
          >
            {showDetails ? 'Ocultar detalhes técnicos' : 'Detalhes técnicos'}
          </button>
          {showDetails && (
            <pre style={{
              margin: 0, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', fontSize: 10.5, lineHeight: 1.5, color: '#4B5563',
              fontFamily: 'monospace', background: '#F9FAFB', border: '1px solid #E5E7EB',
              borderRadius: 6, padding: '8px 10px',
            }}>
              {errorDetails(error)}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
            {onDismiss && (
              <button
                onClick={() => { this.reset(); onDismiss() }}
                style={{
                  fontSize: 12, padding: '6px 12px', borderRadius: 6,
                  border: '1px solid #E5E7EB', background: '#fff', color: '#374151', cursor: 'pointer',
                }}
              >
                {dismissLabel}
              </button>
            )}
            <button
              onClick={this.reset}
              style={{
                fontSize: 12, padding: '6px 12px', borderRadius: 6,
                border: '1px solid #D32F2F', background: '#D32F2F', color: '#fff', cursor: 'pointer',
              }}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      </div>
    )
  }
}
