'use client'
// ── Expertise dot ───────────────────────────────────────────────────────────────────
// The one-glance readout of an expertise level, on both sides of the relationship (see
// lib/expertise.ts for why the two share a scale and a palette).
//
// A workstation's REQUIREMENT is drawn hollow (a ring) and a person's HOLDING is drawn
// filled. Same colour, same position on the scale, different thing: one is a demand, the
// other a supply. Without that distinction two dots of the same colour on the same row
// would read as the same fact stated twice.
import React from 'react'
import { HelpCircle } from 'lucide-react'
import {
  asLevel, EXPERTISE_COLOR, EXPERTISE_LABEL, EXPERTISE_MEANING,
  EXPERTISE_REQUIREMENT_MEANING, type ExpertiseLevel,
} from '@/lib/expertise'

const SIZE_PX = { sm: 8, md: 10, lg: 13 } as const

export function ExpertiseDot({
  level, variant = 'holding', size = 'md', label, title, onClick, className,
}: {
  level: number | null | undefined
  /** 'holding' = a person's level (filled) · 'requirement' = a workstation's bar (ring). */
  variant?: 'holding' | 'requirement'
  size?: keyof typeof SIZE_PX
  /** Render the level name next to the dot. */
  label?: boolean
  /** Tooltip override; defaults to "<Rótulo> — <significado>" for the variant. */
  title?: string
  onClick?: () => void
  className?: string
}) {
  const lv: ExpertiseLevel = asLevel(level)
  const color = EXPERTISE_COLOR[lv]
  const px = SIZE_PX[size]
  const meaning = variant === 'requirement' ? EXPERTISE_REQUIREMENT_MEANING[lv] : EXPERTISE_MEANING[lv]
  const tip = title ?? `${EXPERTISE_LABEL[lv]} — ${meaning}`

  const dot = (
    <span
      aria-hidden
      style={{
        width: px, height: px, borderRadius: '9999px',
        // Hollow for a requirement: the ring is the bar to clear, the fill is what someone has.
        background: variant === 'requirement' ? 'transparent' : color,
        boxShadow: variant === 'requirement' ? `inset 0 0 0 2px ${color}` : undefined,
        flexShrink: 0,
      }}
    />
  )

  const content = (
    <>
      {dot}
      {label && <span className="text-[10px] font-semibold" style={{ color }}>{EXPERTISE_LABEL[lv]}</span>}
    </>
  )

  const cls = `inline-flex items-center gap-1 ${className ?? ''}`

  if (!onClick) {
    return <span className={cls} title={tip}>{content}</span>
  }
  return (
    <button type="button" title={tip} onClick={onClick}
      className={`${cls} rounded px-0.5 hover:bg-gray-200/70`}>
      {content}
    </button>
  )
}

/** The "?" beside an expertise control: opens the questionnaire, which DERIVES the level from
 *  three answers instead of it being assigned by hand. The dot next to it still sets the level
 *  directly — this is the slower, defensible path, not the only one. */
export function ExpertiseHelpButton({ onClick, className }: { onClick?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Avaliar por questionário — três perguntas derivam o nível"
      className={`p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-200/70 shrink-0 ${className ?? ''}`}
    >
      <HelpCircle size={12} />
    </button>
  )
}
