import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Taktline',
  description: 'Sistema de otimização de alocação de pessoas por WSN',
  icons: {
    icon: '/imagens/mark.svg',
    shortcut: '/imagens/mark.svg',
    apple: '/imagens/mark.svg',
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