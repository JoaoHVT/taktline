'use client'
// ── Expertise selector ──────────────────────────────────────────────────────────────
// Four-state picker for an expertise level. Two shapes, same value:
//
//   • 'segmented' — all four options visible at once, for a form field where the scale
//     itself has to be legible (workstation dialog: "which bar am I setting?").
//   • 'cycle'     — one dot that advances 0→1→2→3→0 on click, for dense lists where a
//     four-button group per row would out-weigh the row (the per-person chips).
//
// The cycle shape is only safe because the scale is short and wraps: every value is at
// most three clicks away and nothing is destroyed on the way past it.
import React from 'react'
import {
  asLevel, EXPERTISE_BG, EXPERTISE_COLOR, EXPERTISE_LABEL, EXPERTISE_LEVELS,
  EXPERTISE_MEANING, EXPERTISE_REQUIREMENT_MEANING, type ExpertiseLevel,
} from '@/lib/expertise'
import { ExpertiseDot, ExpertiseHelpButton } from '@/components/ExpertiseDot'

export function ExpertiseSelector({
  value, onChange, variant = 'holding', shape = 'segmented', showHelp = true, onHelp, disabled,
}: {
  value: number | null | undefined
  onChange: (level: ExpertiseLevel) => void
  variant?: 'holding' | 'requirement'
  shape?: 'segmented' | 'cycle'
  showHelp?: boolean
  onHelp?: () => void
  disabled?: boolean
}) {
  const lv: ExpertiseLevel = asLevel(value)
  const meaningOf = (l: ExpertiseLevel) =>
    variant === 'requirement' ? EXPERTISE_REQUIREMENT_MEANING[l] : EXPERTISE_MEANING[l]

  if (shape === 'cycle') {
    return (
      <span className="inline-flex items-center gap-0.5">
        <ExpertiseDot
          level={lv}
          variant={variant}
          size="md"
          title={`${EXPERTISE_LABEL[lv]} — ${meaningOf(lv)} (clique para alterar)`}
          onClick={disabled ? undefined : () => onChange(((lv + 1) % 4) as ExpertiseLevel)}
        />
        {showHelp && <ExpertiseHelpButton onClick={onHelp} />}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center rounded border border-gray-300 overflow-hidden">
        {EXPERTISE_LEVELS.map(l => {
          const active = l === lv
          return (
            <button
              key={l}
              type="button"
              disabled={disabled}
              onClick={() => onChange(l)}
              title={meaningOf(l)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold border-r border-gray-200 last:border-r-0 transition-colors ${
                active ? '' : 'text-gray-500 hover:bg-gray-50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              style={active
                ? { background: EXPERTISE_BG[l], color: EXPERTISE_COLOR[l] }
                : undefined}
            >
              <ExpertiseDot level={l} variant={variant} size="sm" title="" />
              {EXPERTISE_LABEL[l]}
            </button>
          )
        })}
      </div>
      {showHelp && <ExpertiseHelpButton onClick={onHelp} />}
    </div>
  )
}
