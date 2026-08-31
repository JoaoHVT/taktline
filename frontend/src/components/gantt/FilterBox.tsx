'use client'
import { useState, useEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { RED, RED_LT } from '@/lib/ganttUtils'

export function FilterBox({
  icon, label, items, selected, onToggle, formatItem, dropUp = false, alignRight = false,
}: {
  icon: React.ReactNode; label: string
  items: string[]; selected: Set<string>
  onToggle: (v: string) => void
  formatItem: (v: string) => string
  /** Open the options list upward (above the button) instead of downward.
   *  Used when the FilterBox sits in the footer near the bottom of the viewport. */
  dropUp?: boolean
  /** Anchor the options list to the button's RIGHT edge (grows leftward) instead
   *  of the left edge. Use for the rightmost box in a row so the list stays inside
   *  the parent/window instead of overflowing off the right side. */
  alignRight?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])
  const count = selected.size
  return (
    <div ref={ref} style={{ position: 'relative', userSelect: 'none' }}>
      <button onClick={() => setOpen(v => !v)} style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderRadius: 8, border: `1.5px solid ${count > 0 ? RED : '#D1D5DB'}`,
        background: count > 0 ? RED_LT : '#F9FAFB', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, color: count > 0 ? RED : '#374151',
        minWidth: 130, whiteSpace: 'nowrap',
      }}>
        <span style={{ color: count > 0 ? RED : '#6B7280', display: 'flex' }}>{icon}</span>
        {label}
        {count > 0 && (
          <span style={{
            marginLeft: 4, background: RED, color: '#fff', borderRadius: 10,
            fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5,
          }}>{count}</span>
        )}
        <ChevronDown size={12} style={{ marginLeft: 'auto', color: count > 0 ? RED : '#9CA3AF', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          ...(dropUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
          ...(alignRight ? { right: 0 } : { left: 0 }), zIndex: 50,
          background: '#fff', border: `1px solid ${RED}33`, borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 180, maxHeight: 280,
          overflowY: 'auto', padding: '6px 0',
        }}>
          {/* "Selecionar todos" toggle: if not everything is selected, select all
              missing items; if all are already selected, clear them. Implemented by
              flipping only the items that need to change via the existing onToggle,
              so the parent's selection state stays the single source of truth. */}
          {items.length > 0 && (() => {
            const allSelected = items.every(v => selected.has(v))
            const toggleAll = () => {
              if (allSelected) items.forEach(v => onToggle(v))           // deselect all
              else items.forEach(v => { if (!selected.has(v)) onToggle(v) }) // select missing
            }
            return (
              <>
                <button onClick={toggleAll} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '5px 14px', background: allSelected ? RED_LT : 'transparent',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontSize: 11, fontWeight: 700, color: allSelected ? RED : '#374151',
                }}>
                  <span style={{
                    width: 14, height: 14, border: `1.5px solid ${allSelected ? RED : '#D1D5DB'}`,
                    borderRadius: 3, background: allSelected ? RED : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    {allSelected && <svg width="9" height="9" viewBox="0 0 9 9"><polyline points="1,5 3.5,7.5 8,1.5" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </span>
                  Selecionar todos
                </button>
                <div style={{ height: 1, background: '#F3F4F6', margin: '4px 0' }} />
              </>
            )
          })()}
          {items.map(v => {
            const on = selected.has(v)
            return (
              <button key={v} onClick={() => onToggle(v)} style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '5px 14px', background: on ? RED_LT : 'transparent',
                border: 'none', cursor: 'pointer', textAlign: 'left',
                fontSize: 11, fontWeight: on ? 700 : 400, color: on ? RED : '#374151',
              }}>
                <span style={{
                  width: 14, height: 14, border: `1.5px solid ${on ? RED : '#D1D5DB'}`,
                  borderRadius: 3, background: on ? RED : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {on && <svg width="9" height="9" viewBox="0 0 9 9"><polyline points="1,5 3.5,7.5 8,1.5" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </span>
                {formatItem(v)}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
