'use client'
/**
 * ScheduleFilterPanel — compact, collapsible filter panel shown ONLY on the
 * Schedule tab. Reuses the same FilterBox component + visual language as the
 * Factory Load (Resumo Geral) filter row, so the interaction model is identical.
 *
 * Collapsed by default: a single "Filtros" chip. Clicking it reveals three
 * FilterBox dropdowns — Modelo, Área, Workstation — plus a "Limpar" action.
 * Selections are owned by the parent (GanttModal) so they persist across tab
 * switches / rebuilds until the user changes or clears them.
 */
import { useState, useEffect, useRef } from 'react'
import { SlidersHorizontal, Boxes, Layers, LayoutGrid, X } from 'lucide-react'
import { FilterBox } from './FilterBox'
import { RED, RED_LT, RED_DK } from '@/lib/ganttUtils'

export function ScheduleFilterPanel({
  allModels, allAreas, allWorkstations,
  selModels, selAreas, selWorkstations,
  onToggleModel, onToggleArea, onToggleWorkstation,
  onClear, dropUp = false,
}: {
  allModels: string[]; allAreas: string[]; allWorkstations: string[]
  selModels: Set<string>; selAreas: Set<string>; selWorkstations: Set<string>
  onToggleModel: (v: string) => void
  onToggleArea: (v: string) => void
  onToggleWorkstation: (v: string) => void
  onClear: () => void
  /** When true, the panel sits in the footer: the toggle chip expands the
   *  FilterBox row upward and each FilterBox opens its options upward too. */
  dropUp?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeCount = selModels.size + selAreas.size + selWorkstations.size
  const hasAny = activeCount > 0

  // Close the panel when clicking outside it (same model as FilterBox). A click on
  // a FilterBox option inside the panel stays within rootRef, so it won't close.
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // The three FilterBoxes + Limpar action, shared by both layouts.
  const boxes = (
    <>
      <FilterBox
        icon={<Boxes size={13} />} label="Modelo" dropUp={dropUp}
        items={allModels} selected={selModels} onToggle={onToggleModel} formatItem={v => v}
      />
      <FilterBox
        icon={<Layers size={13} />} label="Área" dropUp={dropUp}
        items={allAreas} selected={selAreas} onToggle={onToggleArea} formatItem={v => v}
      />
      <FilterBox
        icon={<LayoutGrid size={13} />} label="Workstation" dropUp={dropUp}
        items={allWorkstations} selected={selWorkstations} onToggle={onToggleWorkstation} formatItem={v => v}
      />
      {hasAny && (
        <button
          onClick={onClear}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 11, color: RED_DK, fontWeight: 600, background: 'none',
            border: 'none', cursor: 'pointer', padding: '2px 4px',
          }}
        >
          <X size={11} /> Limpar filtros
        </button>
      )}
    </>
  )

  const chip = (
    <button
      onClick={() => setOpen(v => !v)}
      title={open ? 'Recolher filtros' : 'Expandir filtros'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderRadius: 8, border: `1.5px solid ${hasAny || open ? RED : '#D1D5DB'}`,
        background: hasAny || open ? RED_LT : '#F9FAFB', cursor: 'pointer',
        fontSize: 12, fontWeight: 600, color: hasAny || open ? RED : '#374151',
        whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <SlidersHorizontal size={13} style={{ color: hasAny || open ? RED : '#6B7280' }} />
      Filtros
      {hasAny && (
        <span style={{
          marginLeft: 2, background: RED, color: '#fff', borderRadius: 10,
          fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5,
        }}>{activeCount}</span>
      )}
    </button>
  )

  // Footer layout: chip stays in the row; the expanded FilterBox row floats
  // upward in a popover so it stays fully visible above the bottom bar.
  if (dropUp) {
    return (
      <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
        {chip}
        {open && (
          <div style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60,
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10,
            boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: '8px 10px',
            maxWidth: '80vw',
          }}>
            {boxes}
          </div>
        )}
      </div>
    )
  }

  // Inline layout (original floating placement): chip + boxes in one wrapping row.
  return (
    <div ref={rootRef} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {chip}
      {open && boxes}
    </div>
  )
}
