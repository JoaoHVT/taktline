import { ClientProviders } from '@/lib/ClientProviders'
import { WakingServerOverlay } from '@/components/WakingServerOverlay'

/**
 * Layout for all main app routes.
 *
 * The cold-start overlay lives HERE rather than in LayoutShell: page.tsx keeps BOTH LayoutShells
 * permanently mounted (hidden with display:none to preserve their state), so a shell-level mount
 * would fire the probe twice and — worse — be display:none'd on the Home landing view, which is
 * exactly the screen the app opens on. At this level it mounts once and always paints.
 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClientProviders>
      <WakingServerOverlay />
      {children}
    </ClientProviders>
  )
}
