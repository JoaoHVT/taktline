'use client'
import React from 'react'

export function ConfirmMini({
  message, detail, confirmLabel, onConfirm, onCancel,
}: {
  message:      string
  detail?:      string
  confirmLabel: string
  onConfirm:    () => void
  onCancel:     () => void
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl p-5 max-w-sm w-full mx-6">
        <p className="text-sm font-medium text-gray-800 mb-1">{message}</p>
        {detail && <p className="text-xs text-gray-500 mb-4">{detail}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100 text-gray-700 font-medium"
          >Cancelar</button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs bg-[#D32F2F] text-white rounded hover:bg-[#B71C1C] font-medium"
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function ToolButton({
  children, active = false, title, onClick, className: extraCls, color,
}: {
  children:   React.ReactNode
  active?:    boolean
  title?:     string
  onClick?:   () => void
  className?: string
  color?:     string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors font-medium select-none hover:opacity-80 ${extraCls ?? ''}`}
      style={active
        ? { backgroundColor: color ?? '#6B7280', borderColor: color ?? '#6B7280', color: '#fff' }
        : { borderColor: (color ?? '#9CA3AF') + '88', color: color ?? '#374151', backgroundColor: 'white' }
      }
    >
      {children}
    </button>
  )
}
