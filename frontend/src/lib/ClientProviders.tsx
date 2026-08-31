'use client'
import dynamic from 'next/dynamic'

// dynamic + ssr:false is only valid inside a Client Component.
// This wrapper lives here so layout.tsx (a Server Component) can safely import it.
const ProvidersInner = dynamic(
  () => import('@/lib/providers').then(mod => ({ default: mod.Providers })),
  { ssr: false, loading: () => null },
)

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return <ProvidersInner>{children}</ProvidersInner>
}
