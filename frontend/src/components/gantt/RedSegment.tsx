'use client'
/**
 * RedSegment — the small red segmented toggle used for view-mode switching
 * (e.g. Mensal / Semanal) across the Gantt modal tabs. Extracted so Resumo Geral,
 * GETSA Planned and any other tab share ONE implementation and look identical.
 *
 * `red` lets callers pass their local accent (GETSA receives RED as a prop); it
 * defaults to the shared ganttUtils RED so existing call-sites need not change.
 */
import { RED as DEFAULT_RED } from '@/lib/ganttUtils'

export function RedSegment<T extends string>({
  options, value, onChange, red = DEFAULT_RED, disabled, titleFor,
}: {
  options: readonly { key: T; label: string }[]
  value: T
  onChange: (v: T) => void
  red?: string
  /** Options that cannot be chosen right now. They stay VISIBLE and greyed rather than being
   *  dropped from the list: a toggle that silently loses an option reads as a rendering fault,
   *  and the user has no way to ask why it went. Pair with `titleFor` to say why. */
  disabled?: readonly T[]
  /** Tooltip per option — the place to explain a disabled one. */
  titleFor?: (key: T) => string | undefined
}) {
  return (
    <div style={{ display: 'flex', border: `1.5px solid ${red}`, borderRadius: 8, overflow: 'hidden' }}>
      {options.map(o => {
        const off = disabled?.includes(o.key) ?? false
        const active = value === o.key && !off
        return (
          <button key={o.key}
            onClick={() => { if (!off) onChange(o.key) }}
            disabled={off}
            title={titleFor?.(o.key)}
            style={{
              flex: 1, padding: '6px 14px', fontSize: 11, fontWeight: 700, border: 'none',
              cursor: off ? 'not-allowed' : 'pointer',
              background: active ? red : off ? '#F9FAFB' : '#fff',
              color: active ? '#fff' : off ? '#D1D5DB' : red,
              whiteSpace: 'nowrap', transition: 'all 0.12s',
            }}>{o.label}</button>
        )
      })}
    </div>
  )
}
