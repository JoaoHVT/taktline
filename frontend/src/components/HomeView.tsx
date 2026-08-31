'use client'
import { useState } from 'react'
import { CalendarRange, Gauge, KeyRound, LogOut } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ChangePasswordModal } from '@/components/ChangePasswordModal'
import { useAuth } from '@/hooks/useAuth'

interface Props {
  onOpenAnalise: () => void
  onOpenGantt:   () => void
}

interface ModuleCard {
  key:   string
  title: string
  desc:  string
  icon:  React.ReactNode
  onClick: () => void
}

/**
 * Landing screen: the modules, on a plain ground.
 *
 * Deliberately flat — the tiles are the only thing on the page, so what the app does is readable
 * before anything is opened.
 */
export function HomeView({ onOpenAnalise, onOpenGantt }: Props) {
  const { currentUser, logout } = useAuth()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [showChangePw,  setShowChangePw]  = useState(false)

  const modules: ModuleCard[] = [
    {
      key: 'analise',
      title: 'Análise de Capacidade',
      desc:  'Carga de fábrica, demanda por período e alocação da equipe pelo otimizador.',
      icon:  <Gauge size={30} strokeWidth={1.5} />,
      onClick: onOpenAnalise,
    },
    {
      key: 'schedule',
      title: 'Schedule',
      desc:  'Sequência de produção por workstation, com o resumo do período ao lado.',
      icon:  <CalendarRange size={30} strokeWidth={1.5} />,
      onClick: onOpenGantt,
    },
  ]

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black text-white">
      {/* Account cluster (top-right). Nothing else lives up here. */}
      <div className="absolute top-5 right-6 flex items-center gap-2 z-20">
        {currentUser && (
          <>
            <span className="text-xs text-white/50 mr-1">{currentUser.name || currentUser.username}</span>
            <button
              onClick={() => setShowChangePw(true)}
              title="Alterar senha"
              className="p-2 rounded-lg border border-white/15 text-white/70 hover:text-white hover:border-white/30 transition-colors"
            >
              <KeyRound size={16} />
            </button>
            <button
              onClick={() => setConfirmLogout(true)}
              title="Sair"
              className="p-2 rounded-lg border border-white/15 text-white/70 hover:text-white hover:border-white/30 transition-colors"
            >
              <LogOut size={16} />
            </button>
          </>
        )}
      </div>

      <div className="w-full h-full flex flex-col items-center justify-center px-6">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Taktline</h1>
          <p className="mt-2 text-sm text-white/50">
            Planejamento de capacidade e sequenciamento de produção.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-5 max-w-3xl">
          {modules.map(m => (
            <button
              key={m.key}
              onClick={m.onClick}
              className="group w-72 text-left p-6 rounded-xl border border-white/12 bg-white/[0.03]
                         hover:bg-white/[0.07] hover:border-white/25 transition-colors"
            >
              <div className="text-white/80 group-hover:text-white transition-colors">{m.icon}</div>
              <div className="mt-4 text-base font-semibold">{m.title}</div>
              <div className="mt-1.5 text-xs leading-relaxed text-white/45">{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {showChangePw && currentUser && (
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      )}

      {confirmLogout && currentUser && (
        <ConfirmDialog
          title="Sair da conta"
          message={`Deseja sair da conta ${currentUser.email}?`}
          detail="Você precisará fazer login novamente para continuar usando o sistema."
          confirmLabel="Sair"
          danger
          onConfirm={() => { setConfirmLogout(false); logout() }}
          onCancel={() => setConfirmLogout(false)}
        />
      )}
    </div>
  )
}
