/**
 * ConfirmDialog — padronized yes/no dialog
 *
 * Usage:
 *   <ConfirmDialog
 *     title="Resetar sessão"
 *     message="Os dados não salvos serão perdidos."
 *     onConfirm={() => doReset()}
 *     onCancel={() => setOpen(false)}
 *     danger
 *   />
 */
'use client'
import { X, AlertTriangle, Info } from 'lucide-react'

interface Props {
  title:          string
  message:        string
  detail?:        string           // optional secondary detail line
  onConfirm:      () => void
  onCancel:       () => void
  confirmLabel?:  string
  cancelLabel?:   string
  /** Red confirm button + warning icon (destructive actions). Default: false (blue). */
  danger?:        boolean
}

export function ConfirmDialog({
  title,
  message,
  detail,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirmar',
  cancelLabel  = 'Cancelar',
  danger       = false,
}: Props) {
  const Icon = danger ? AlertTriangle : Info

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[400px] overflow-hidden">

        {/* Title bar */}
        <div className="bg-[#0D9488] text-white flex items-center justify-between px-4 py-2.5">
          <span className="font-semibold text-sm tracking-wide">{title}</span>
          <button
            onClick={onCancel}
            className="rounded p-1 hover:bg-white/20 transition-colors"
            title="Fechar"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 flex gap-3.5 items-start">
          <Icon
            size={22}
            className={`shrink-0 mt-0.5 ${danger ? 'text-red-500' : 'text-blue-500'}`}
          />
          <div>
            <p className="text-sm text-gray-800 leading-relaxed">{message}</p>
            {detail && (
              <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{detail}</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-xs border border-gray-300 rounded bg-white text-gray-700 hover:bg-gray-100 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-1.5 text-xs rounded text-white font-medium transition-colors ${
              danger
                ? 'bg-[#0D9488] hover:bg-[#0F766E]'
                : 'bg-[#1565C0] hover:bg-[#0D47A1]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>

      </div>
    </div>
  )
}
