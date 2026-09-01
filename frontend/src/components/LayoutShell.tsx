/**
 * LayoutShell — outer shell that wraps every page.
 * Structure mirrors the MainWindow layout from the original desktop tool:
 *
 *   ┌─────────────────────────────────────┐
 *   │  AppHeader (gray toolbar + logo)    │  fixed top
 *   ├─────────────────────────────────────┤
 *   │  children  (white scrollable area)  │  flex-1
 *   ├─────────────────────────────────────┤
 *   │  AppFooter (red KPI bar)            │  fixed bottom
 *   └─────────────────────────────────────┘
 */
'use client'
import { AppHeader } from '@/components/AppHeader'
import { AppFooter } from '@/components/AppFooter'

interface Props {
  children:      React.ReactNode
  onGoHome?:     () => void
  /** Switches to the other app (header button, left of Home). */
  onSwitchApp?:  () => void
  mode?:         'analise' | 'gantt'
}

export function LayoutShell({ children, onGoHome, onSwitchApp, mode }: Props) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white">
      <AppHeader onGoHome={onGoHome} onSwitchApp={onSwitchApp} mode={mode} />
      <main className="flex-1 overflow-y-auto bg-white">
        {children}
      </main>
      <AppFooter mode={mode} />
    </div>
  )
}
