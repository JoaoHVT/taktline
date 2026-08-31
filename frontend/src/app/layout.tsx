import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'MasterPlanner - Wabtec Optimization Tool',
  description: 'Sistema de otimização de alocação de pessoas por WSN',
  icons: {
    icon: '/imagens/wab1.png',
    shortcut: '/imagens/wab1.png',
    apple: '/imagens/wab1.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={inter.className}>
        {children}
      </body>
    </html>
  )
}