'use client'
import React, { useRef, useEffect } from 'react'

export interface CtxMenuItem {
  label:     string
  icon?:     React.ReactNode
  danger?:   boolean
  green?:    boolean
  orange?:   boolean
  /** Greyed out and non-clicking, but still LISTED — an action the user can't take yet
   *  stays discoverable, and `title` says what's missing. Hiding it instead would leave
   *  no trace that the feature exists. */
  disabled?: boolean
  /** Native tooltip. Its main use is explaining a `disabled` item. */
  title?:    string
  onClick:   () => void
}

export function ContextMenu({
  x, y, items, onClose,
}: {
  x:       number
  y:       number
  items:   CtxMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Small delay so the right-click that opened the menu doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 50)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed',
    top:  y,
    left: x,
    zIndex: 9999,
  }

  return (
    <>
      {/* Full-viewport click catcher. The Gantt renders inside an <iframe>, and a click
          inside that iframe fires on the iframe's document — it never reaches the parent
          `document` the mousedown listener above is bound to. This transparent overlay
          sits in the PARENT document on top of the iframe, so a click ANYWHERE outside the
          menu (including over the Gantt) closes it. Sits just below the menu (z-9998 < 9999)
          so menu-item clicks still land. */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 9998 }}
        onMouseDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div ref={ref} style={style}
        className="bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[190px]"
      >
        {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          title={item.title}
          // A disabled item must not close the menu either: the tooltip explaining WHY it
          // is unavailable is only readable while the menu stays open.
          onClick={item.disabled ? undefined : () => { item.onClick(); onClose() }}
          className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors select-none
            ${item.disabled ? 'text-gray-300 cursor-not-allowed'
            : item.danger  ? 'text-red-600 hover:bg-red-50'
            : item.green   ? 'text-green-700 hover:bg-green-50'
            : item.orange  ? 'text-orange-600 hover:bg-orange-50'
            : 'text-gray-700 hover:bg-gray-100'}` }
        >
          {item.icon && <span className={`shrink-0 ${item.disabled ? 'opacity-40' : 'opacity-70'}`}>{item.icon}</span>}
          {item.label}
        </button>
        ))}
      </div>
    </>
  )
}
