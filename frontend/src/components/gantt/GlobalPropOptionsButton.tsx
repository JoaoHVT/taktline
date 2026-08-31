'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { RED } from '@/lib/ganttUtils'
import { setGlobalPropOptions, type GlobalPropOptions } from '@/lib/globalPropOptions'
import { useGlobalPropOptions } from './useGlobalPropOptions'

/**
 * Arrow button + popover carrying the GLOBAL propagation sub-options. Sits directly against the
 * "Global" control in BOTH places that offer it — the Move-Mode prompt and the edit panel's
 * segmented control — and both read the same session store, so a choice made in one is in force
 * in the other. Nothing here triggers propagation; it only configures the next Global run.
 *
 * The panel is deliberately plain checkboxes rather than a menu: the three options combine freely,
 * and the duration⇒WS-única dependency has to be VISIBLE (the implied row stays ticked and locked
 * while duration is on) rather than silently applied behind a menu. Only the option NAMES are
 * rendered — the full explanation of each one lives in its tooltip, so the menu stays compact.
 *
 * A numeric badge on the arrow reports how many sub-options are active, so a configured Global is
 * never mistaken for a plain one while the panel is closed.
 */
const OPTS: { id: keyof GlobalPropOptions; label: string; hint: string }[] = [
  {
    id: 'advance',
    label: 'Propagar Adiantamento',
    hint: 'Ao adiantar um WS, os LOCOs seguintes também avançam — cada um começa no primeiro dia útil após o anterior. Sem isto, só o atraso propaga.',
  },
  {
    id: 'singleWs',
    label: 'Propagar WS Única',
    hint: 'Move apenas o WS editado — no LOCO editado e em cada LOCO seguinte. As workstations posteriores dentro do LOCO não acompanham.',
  },
  {
    id: 'duration',
    label: 'Propagar Duração',
    hint: 'Aplica a mesma mudança de duração do WS editado (ex.: 4 → 3 dias) ao mesmo WS dos demais LOCOs. Ativa "Propagar WS Única" automaticamente.',
  },
]

/** Panel box, in px. Both are needed BEFORE the panel exists, to decide where to put it (and to
 *  keep it inside the viewport), so they are fixed rather than measured. `PANEL_H` is the height
 *  the three rows + header + footer actually occupy; the panel is not allowed to exceed it. */
const PANEL_W = 218
const PANEL_H = 168

export function GlobalPropOptionsButton({ disabled = false, align = 'right', variant = 'standalone' }: {
  /** Mirrors the Global button's own disabled state so the pair reads as one control. */
  disabled?: boolean
  /** Which edge the panel hangs from — the prompt anchors right, the panel control left. */
  align?: 'left' | 'right'
  /** `inset` renders the arrow INSIDE the red "Global" button (transparent, white chevron, hairline
   *  divider on its left). `standalone` keeps the bordered red-on-white chip used where there is no
   *  Global button to sit inside (the edit panel's segmented control). */
  variant?: 'standalone' | 'inset'
}) {
  const opts = useGlobalPropOptions()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  /** Viewport coords of the portalled panel — see the note on PANEL_W below. */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  // Count of active sub-options — drives the badge and the "modified" affordance. `duration` implies
  // `singleWs` and both are stored as true, so an implied option is counted: the badge reports how
  // many rules are IN FORCE, which is what the user is checking for.
  const activeCount = Number(opts.advance) + Number(opts.singleWs) + Number(opts.duration)
  const active = activeCount > 0
  const inset = variant === 'inset'

  // Outside-click. The panel is PORTALLED, so `ref` no longer contains it — a click on a
  // checkbox would count as "outside" and close the panel before the change landed. The panel
  // is therefore identified by its own data attribute.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null
      if (t?.closest('[data-globalprop-panel]')) return
      if (ref.current && !ref.current.contains(t as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Place the panel in VIEWPORT coordinates, measured off the arrow itself.
  //
  // It used to be an `absolute` child of this button's wrapper, which put it at the mercy of
  // every ancestor: inside the Move-Mode prompt the Global label + arrow share a
  // `rounded overflow-hidden` box, and that box CLIPPED the panel away entirely — the reported
  // "clicking the arrow shows nothing". Fixed positioning through a portal also means the panel
  // can never be pushed outside the visible area: it flips below the arrow when there is no room
  // above, and is clamped to the viewport on both axes.
  //
  // Measured in the CLICK handler and re-measured from scroll/resize events — never
  // synchronously inside an effect body, which is a cascading render (and a lint error).
  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const above = r.top - PANEL_H - 6
    setAt({
      left: Math.max(8, Math.min(
        align === 'right' ? r.right - PANEL_W : r.left,
        window.innerWidth - PANEL_W - 8,
      )),
      // Prefer above (where it has always opened); drop below only when it would clip the top.
      top: above >= 8 ? above : Math.min(window.innerHeight - PANEL_H - 8, r.bottom + 6),
    })
  }, [align])

  // Keep it pinned to the arrow while the page moves under it.
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  return (
    <div className={inset ? 'relative flex self-stretch' : 'relative'} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        // Measure BEFORE opening (the rect is available right here), so the panel's first frame is
        // already in the right place. No state updater does the measuring — an updater must stay pure.
        onClick={() => { if (open) { setOpen(false); setAt(null) } else { place(); setOpen(true) } }}
        title={active
          ? `Opções da propagação Global — ${activeCount} ativa${activeCount > 1 ? 's' : ''}`
          : 'Opções da propagação Global'}
        aria-label="Opções da propagação Global"
        // `justify-center` + a fixed content box keeps the chevron (and its badge) fully INSIDE the
        // button at every state: nothing is positioned absolutely and nothing overflows, so the arrow
        // can never render outside the Global button it lives in.
        className={inset
          ? 'flex items-center justify-center gap-1 self-stretch px-1.5 transition-colors disabled:opacity-50 focus:outline-none'
          : 'flex items-center justify-center gap-1 rounded border px-1.5 py-1 transition-colors disabled:opacity-50 focus:outline-none'}
        style={inset
          ? { background: 'transparent', color: '#fff', borderLeft: '1px solid rgba(255,255,255,0.45)' }
          : active
            ? { background: RED, borderColor: RED, color: '#fff' }
            : { background: '#FFF', borderColor: RED, color: RED }}
      >
        <ChevronDown size={12} className="shrink-0" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        {/* Active-rule counter — same idea as a filter badge. Absent at zero. */}
        {active && (
          <span
            className="shrink-0 rounded-full text-[9px] font-bold leading-none"
            style={inset
              ? { background: '#fff', color: RED, padding: '2px 4px' }
              : { background: RED, color: '#fff', padding: '2px 4px' }}
          >
            {activeCount}
          </span>
        )}
      </button>

      {/* Portalled to <body>: z-index alone could not save it from an ancestor's overflow, and the
          Move-Mode prompt that hosts this control is itself at z 9997+ — so the panel sits above
          that, in viewport coordinates. */}
      {open && at && typeof document !== 'undefined' && createPortal(
        <div
          data-globalprop-panel
          className="bg-white border border-gray-300 rounded-lg shadow-xl p-2"
          style={{ position: 'fixed', left: at.left, top: at.top, width: PANEL_W, maxHeight: PANEL_H, zIndex: 10002 }}
        >
          <div className="px-1 pb-1.5 text-[11px] font-semibold text-gray-800">Opções da propagação Global</div>
          <div className="flex flex-col gap-0.5">
            {OPTS.map(o => {
              // "Propagar WS Única" is implied by duration: keep it visibly ticked and lock it, so
              // the dependency is legible instead of surprising when the user tries to untick it.
              const implied = o.id === 'singleWs' && opts.duration
              return (
                <label
                  key={o.id}
                  title={o.hint}
                  className={`flex items-center gap-2 rounded px-1.5 py-1.5 ${implied ? 'cursor-default' : 'cursor-pointer hover:bg-gray-50'}`}
                >
                  <input
                    type="checkbox"
                    className="shrink-0"
                    style={{ accentColor: RED }}
                    checked={opts[o.id]}
                    disabled={implied}
                    onChange={e => setGlobalPropOptions({ [o.id]: e.target.checked } as Partial<GlobalPropOptions>)}
                  />
                  <span className="min-w-0 text-[11px] font-semibold text-gray-800">{o.label}</span>
                </label>
              )
            })}
          </div>
          <div className="mt-1 border-t border-gray-100 pt-1.5 px-1 text-[10px] text-gray-400">
            Válido apenas nesta sessão — recarregar restaura o Global padrão.
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
