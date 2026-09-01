'use client'
// ── DateRangeCalendar — click-click date-range picker (start day, then end day) ─────
// A real calendar-grid widget (month view, Monday-anchored week, prev/next navigation)
// for picking a date range purely by clicking days — no typed/native date inputs. Built
// for the Headcount tab's vacation/leave picker; self-contained (no backend calendar
// dependency, unlike ManageCalendarModal's MonthCard which needs the admin calendar API).
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Trash2, CalendarPlus, X } from 'lucide-react'

const RED = '#0D9488'
const DOW_PT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
const MONTHS_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                   'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

function iso(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${(m + 1).toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`
}
function mondayWeekday(y: number, m: number, d: number): number {
  return (new Date(y, m, d).getDay() + 6) % 7   // 0=Mon .. 6=Sun
}
function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate()
}

/** One already-registered range. `id` identifies it to the caller's remove handler. */
export interface CalendarPeriod {
  id?: number
  start: string
  end: string
  label?: string
}

interface Props {
  /** ISO 'YYYY-MM-DD' or null for each end. The range currently being PICKED. */
  start: string | null
  end: string | null
  onChange: (start: string | null, end: string | null) => void
  /** Periods ALREADY saved for this subject, rendered as pre-marked days so reopening the picker
   *  shows what exists instead of a blank calendar. Inclusive ISO ranges; may be non-contiguous. */
  periods?: CalendarPeriod[]
  /** When given, clicking a day INSIDE a registered period opens a small menu offering to remove
   *  that period (or to start a new range from that day instead). Omitted ⇒ a saved day just
   *  starts a new range, as before. */
  onRemovePeriod?: (period: CalendarPeriod) => void
  /** Section accent (selection + saved-period marks). Defaults to the app red; the Headcount
   *  people section passes Otimização's "Por Pessoa" green so the calendar matches its host. */
  accentColor?: string
  /** Light companion tint of `accentColor`, used for the in-range / saved-day cell fills. */
  accentBg?: string
}

/** 'YYYY-MM-DD' → 'DD/MM' for the compact menu header. */
function brief(d: string): string {
  const [, m, day] = d.split('-')
  return `${day}/${m}`
}

export function DateRangeCalendar({
  start, end, onChange, periods, onRemovePeriod,
  accentColor = RED, accentBg = '#F0FDFA',
}: Props) {
  const today = new Date()
  // Open on whatever the user most likely wants to see: the range being picked, else the FIRST
  // already-saved period (so a person with vacation in July doesn't open on the current month with
  // nothing visible), else today.
  const anchor = start ?? (periods && periods.length > 0
    ? periods.reduce((a, p) => (p.start < a ? p.start : a), periods[0].start)
    : null)
  const initial = anchor ? new Date(anchor + 'T00:00:00') : today
  const [viewYear, setViewYear] = useState(initial.getFullYear())
  const [viewMonth, setViewMonth] = useState(initial.getMonth())

  function shiftMonth(delta: number) {
    let m = viewMonth + delta
    let y = viewYear
    if (m < 0) { m = 11; y -= 1 }
    else if (m > 11) { m = 0; y += 1 }
    setViewMonth(m); setViewYear(y)
  }

  // Day-menu for a click that landed inside a registered period. Anchored to the clicked cell,
  // `fixed` so it escapes the dialog's scroll container.
  const [dayMenu, setDayMenu] = useState<{ day: string; period: CalendarPeriod; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!dayMenu) return
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-daymenu]')) setDayMenu(null)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setDayMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [dayMenu])
  // A period removed elsewhere (the dialog's own list) must not leave a menu pointing at it —
  // derived, not synced: the menu renders only while its period is still in `periods`.
  const livePeriod = dayMenu ? periods?.find(p => p.id === dayMenu.period.id) ?? null : null
  const openMenu = dayMenu && livePeriod ? { ...dayMenu, period: livePeriod } : null

  function pick(day: string) {
    if (!start || (start && end)) {
      // Nothing picked yet, or a full range already exists → start a fresh range.
      onChange(day, null)
    } else if (day < start) {
      // Clicked before the current start → that becomes the new start.
      onChange(day, null)
    } else {
      onChange(start, day)
    }
  }

  const lead = mondayWeekday(viewYear, viewMonth, 1)
  const total = daysInMonth(viewYear, viewMonth)
  // Always render a fixed 6-row grid (42 cells) so the calendar's height never changes when
  // navigating between months — a 4-row Feb and a 6-row Aug would otherwise reflow the dialog.
  const trail = 42 - lead - total

  return (
    <div className="border border-gray-200 rounded-lg p-2.5 bg-white w-full">
      <div className="flex items-center justify-between mb-1.5">
        <button type="button" onClick={() => shiftMonth(-1)} className="p-0.5 rounded hover:bg-gray-100 text-gray-500">
          <ChevronLeft size={14} />
        </button>
        <span className="text-[11px] font-semibold text-gray-900">{MONTHS_PT[viewMonth]} {viewYear}</span>
        <button type="button" onClick={() => shiftMonth(1)} className="p-0.5 rounded hover:bg-gray-100 text-gray-500">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {DOW_PT.map(d => (
          <div key={d} className="text-[9px] text-gray-400 text-center font-semibold pb-0.5">{d}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: total }, (_, i) => i + 1).map(day => {
          const d = iso(viewYear, viewMonth, day)
          const isStart = d === start
          const isEnd = d === end
          const inRange = !!start && !!end && d > start && d < end
          // An already-SAVED period this day falls inside. Kept visually distinct from the range being
          // picked: the pick is solid red (the active thing), a saved period is a tinted cell with an
          // underline accent — so both can show at once without one reading as the other. Saved days
          // stay clickable, since adding another period is the point.
          const saved = periods?.find(p => d >= p.start && d <= p.end)
          const opensMenu = !!saved && !!onRemovePeriod
          let cls = 'text-gray-700 hover:bg-gray-100'
          if (isStart || isEnd) cls = 'text-white'
          else if (inRange || saved) cls = 'hover:brightness-95'
          return (
            <button
              key={d}
              type="button"
              data-daymenu={opensMenu ? '' : undefined}
              onClick={e => {
                if (!opensMenu) { pick(d); return }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setDayMenu(cur => cur && cur.day === d
                  ? null
                  : { day: d, period: saved!, x: r.left, y: r.bottom + 4 })
              }}
              title={saved
                ? `${d} · férias: ${saved.label ?? `${saved.start} → ${saved.end}`}${opensMenu ? ' — clique para remover' : ''}`
                : d}
              className={`relative aspect-square rounded text-[10px] font-medium flex items-center justify-center transition-all ${cls}`}
              style={{
                background: (isStart || isEnd) ? accentColor : inRange ? accentBg : saved ? accentBg : undefined,
                color: (isStart || isEnd) ? undefined : (inRange || saved) ? accentColor : undefined,
                boxShadow: saved && !isStart && !isEnd && !inRange ? `inset 0 -2px 0 ${accentColor}` : undefined,
              }}
            >
              {day}
            </button>
          )
        })}
        {Array.from({ length: trail }, (_, i) => <div key={`t${i}`} />)}
      </div>

      {/* Clicking inside a registered period asks what to do with it, rather than silently
          starting a new range on top of it (the old behaviour) or deleting on a single click. */}
      {openMenu && (
        <div
          data-daymenu
          className="fixed z-[10000] rounded-md border border-gray-200 bg-white shadow-xl py-1"
          style={{ left: Math.min(openMenu.x, window.innerWidth - 208), top: openMenu.y, width: 200 }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1 border-b border-gray-100">
            <span className="text-[10px] font-semibold text-gray-500 truncate">
              Férias {brief(openMenu.period.start)} → {brief(openMenu.period.end)}
            </span>
            <button type="button" onClick={() => setDayMenu(null)} className="shrink-0 rounded p-0.5 hover:bg-gray-100">
              <X size={11} className="text-gray-400" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => { onRemovePeriod?.(openMenu.period); setDayMenu(null) }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[#0D9488] hover:bg-red-50 text-left"
          >
            <Trash2 size={12} className="shrink-0" />Remover férias
          </button>
          <button
            type="button"
            onClick={() => { pick(openMenu.day); setDayMenu(null) }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-gray-700 hover:bg-gray-100 text-left"
          >
            <CalendarPlus size={12} className="shrink-0 text-gray-400" />Iniciar novo período aqui
          </button>
        </div>
      )}
      {/* Only shown when there IS something saved to explain — the underline accent is otherwise
          a marking with no referent. */}
      {periods && periods.length > 0 && (
        <div className="flex items-center gap-3 pt-1.5 mt-1 border-t border-gray-100">
          <span className="flex items-center gap-1 text-[9px] text-gray-500">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: accentBg, boxShadow: `inset 0 -2px 0 ${accentColor}` }} />
            Já cadastrado
          </span>
          <span className="flex items-center gap-1 text-[9px] text-gray-500">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: accentColor }} />
            Nova seleção
          </span>
        </div>
      )}
    </div>
  )
}
