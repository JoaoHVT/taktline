'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EXPLAINERS, type ExplainerTopic } from '@/lib/explainers'

/**
 * InfoDot — a small "?" that opens a short technical card.
 *
 * For a visitor, not an operator: the screen shows WHAT happens, and these say what is being
 * solved underneath. Content lives in `lib/explainers.ts`, which also carries the rule about
 * what may and may not go in one.
 *
 * VISIBLE BY DEFAULT, low contrast. A hidden "explain mode" toggle loses the one reader the
 * cards exist for — someone who has never seen this app and does not know to look for it.
 *
 * The card is PORTALLED to the body and positioned from the trigger's measured rect. Rendering
 * it inline is what a first version does, and it gets clipped the moment a dot lands inside a
 * scrolling panel or a table cell with `overflow: hidden` — which is most of the places worth
 * putting one. Position is clamped to the viewport so a dot near the right edge still opens a
 * fully readable card.
 */
export function InfoDot({
  topic,
  className = '',
  label,
}: {
  topic: ExplainerTopic
  className?: string
  /** Overrides the accessible name; defaults to the card's own title. */
  label?: string
}) {
  const entry = EXPLAINERS[topic]
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const cardId = useId()

  useEffect(() => {
    if (!open) return
    function place() {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const W = 320
      const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8)
      // Below the dot when there is room, above it when there is not.
      const below = window.innerHeight - r.bottom
      const top = below > 240 ? r.bottom + 8 : Math.max(8, r.top - 8 - 240)
      setPos({ top, left })
    }
    place()
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (!cardRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    // Reposition rather than follow: a card anchored to a scrolled-away dot is worse than one
    // that simply closes, so scrolling the page closes it.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', () => setOpen(false), { once: true, capture: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', place)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        aria-label={label ?? entry.title}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        className={`inline-flex items-center justify-center rounded-full border text-[10px] font-bold
          leading-none transition-colors align-middle shrink-0
          ${open
            ? 'border-[#0D9488] bg-[#0D9488] text-white'
            : 'border-gray-300 text-gray-400 hover:border-[#0D9488] hover:text-[#0D9488]'} ${className}`}
        style={{ width: 15, height: 15 }}
      >
        ?
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={entry.title}
          className="fixed z-[10000] rounded-lg border border-gray-200 bg-white shadow-xl"
          style={{ top: pos.top, left: pos.left, width: 320 }}
        >
          <div className="px-3.5 py-2 border-b border-gray-100 flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[#0D9488]">
              {entry.title}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fechar"
              className="text-gray-400 hover:text-gray-600 text-sm leading-none px-1"
            >
              ×
            </button>
          </div>
          <div className="px-3.5 py-3 flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
            {entry.body.map((p, i) => (
              <p key={i} className="text-[11.5px] leading-relaxed text-gray-600">{p}</p>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
