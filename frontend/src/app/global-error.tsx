'use client'
import { useEffect, useState } from 'react'
import { NightScreen, NIGHT_BTN } from '@/components/NightScreen'
import { isStaleBuildError, reloadForStaleBuild, errorDetails } from '@/lib/staleBuild'

/**
 * Root-layout error boundary — the last resort.
 *
 * `error.tsx` sits INSIDE the root layout, so it cannot catch a failure in the layout itself; that
 * lands here, and this file has to supply its own <html>/<body> because the layout that normally
 * provides them is the thing that threw. Same night screen as everywhere else.
 *
 * No `reset` retry offered: whatever broke the root layout will almost certainly break it again on
 * a re-render, so a full reload is the only honest recovery — and when the cause is a STALE BUILD
 * (a tab left open across a deploy, asking for chunk filenames the server no longer has) that
 * reload is the actual fix, so it happens by itself. Same detection and same loop guard as
 * `error.tsx`; see lib/staleBuild.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [stale] = useState(() => isStaleBuildError(error))
  const [reloading, setReloading] = useState(stale)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => { console.error('[Taktline] root error:', error) }, [error])
  useEffect(() => {
    // Declined → a reload was already tried and did not help, so this is something else.
    if (stale && !reloadForStaleBuild()) setReloading(false)
  }, [stale])

  // The document is on its way out: render the shell with nothing in it rather than flashing a
  // dead end the user never gets to read.
  if (reloading) return <html lang="pt-BR"><body style={{ margin: 0 }} /></html>

  return (
    <html lang="pt-BR">
      <body style={{ margin: 0 }}>
        <NightScreen title="Algo deu errado" role="alert">
          <div style={{ fontSize: 12.5, color: '#9AA6BF', lineHeight: 1.65 }}>
            O aplicativo não pôde ser iniciado.<br />
            Atualize a página para tentar novamente.
          </div>
          <button onClick={() => window.location.reload()} style={NIGHT_BTN}>
            Atualizar a página
          </button>
          <button
            onClick={() => setShowDetails(v => !v)}
            style={{ ...NIGHT_BTN, fontSize: 10.5, padding: '3px 8px', opacity: 0.75 }}
          >
            {showDetails ? 'Ocultar detalhes técnicos' : 'Detalhes técnicos'}
          </button>
          {showDetails && (
            <pre style={{
              margin: 0, maxWidth: 'min(680px, 88vw)', maxHeight: 180, overflow: 'auto',
              textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontSize: 10.5, lineHeight: 1.5, color: '#8C99B4', fontFamily: 'monospace',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 6, padding: '8px 10px',
            }}>
              {errorDetails(error, error.digest)}
            </pre>
          )}
        </NightScreen>
      </body>
    </html>
  )
}
