'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { PermissionsProvider } from '@/context/PermissionsContext'
import { AuthProvider } from '@/hooks/useAuth'

// AuthProvider não depende de nada acima dele além do QueryClient: a sessão é usuário +
// senha, com o token assinado pelo backend e guardado em lib/tokenStore. Fica acima de
// PermissionsProvider, que lê `tokenReady` para saber quando buscar o papel do usuário.

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10 * 1000,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {/* AuthProvider detém a sessão única e precisa ficar acima de todo consumidor de
          useAuth (PermissionsProvider, a página, o cabeçalho, os modais do Gantt). */}
      <AuthProvider>
        <PermissionsProvider>
          {children}
        </PermissionsProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
