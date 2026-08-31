'use client'
// ── Multi-series line chart (Build Plan → Análises Gráficas) ──────────────────────────
// Same visual language as Resumo Geral's SummaryAreaChart — hand-rolled SVG, monotone-cubic
// lines, hairline gridlines with round tick values, muted uppercase eyebrow, hover guide with a
// dark bubble — but for N series instead of one-plus-a-comparison, because this chart plots two
// different quantities (locos and kits) and, in comparison mode, both again for the other
// scenario. The curve maths and the tick rounding are IMPORTED from that chart rather than
// re-derived, so the two read as one family and can never drift apart.
//
// No area fill here on purpose: four overlapping fills would be mud, and the point of this chart
// is comparing shapes, not reading a volume.
import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { smoothPath, niceTicks } from './SummaryAreaChart'

export interface LineSeries {
  key:    string
  label:  string
  color:  string
  /** Dashed = a compared scenario's series, solid = the active one. Same convention as the
   *  Resumo Geral chart and the footer's scenario labels. */
  dashed: boolean
  /** One value per label, aligned 1:1 by index. */
  values: number[]
}

const PAD = { r: 10, t: 12, b: 18 }
/** Left padding is the widest Y label plus a gutter — hard-coding it would either clip "1.200"
 *  or waste a third of a small frame on "8". */
const PAD_L_MIN = 12
/** Horizontal inset of the plotted line inside the padded area. The first point used to sit
 *  exactly ON the Y axis and the last exactly on the right edge, which read as the first period
 *  being outside the frame — the chart looked like it began at the SECOND label. The inset costs
 *  a few pixels of curve and puts the opening period visibly inside the chart. */
const X_INSET = 8
/** Estimated px width of one label character at the 9px axis font, and the clear gap two labels
 *  must keep between them. Character-count estimates rather than measured text: the labels are
 *  short fixed-shape tokens ("jan/26", "S12"), and measuring would cost a layout pass per frame. */
const CH_PX = 5.2
const LABEL_GAP = 8

export function AnalysisLineChart({
  title, labels, series, formatValue = v => String(v), emptyText = 'Sem dados no período',
  onTitleClick, titleHint,
}: {
  /** Muted eyebrow, e.g. "Locos iniciadas × kits em fluxo · Mensal". */
  title: string
  labels: string[]
  series: LineSeries[]
  formatValue?: (v: number) => string
  emptyText?: string
  /** Optional: makes the eyebrow a BUTTON that switches what the frame shows (Build Plan uses it to
   *  flip one chart between the per-period and the cumulative reading, instead of drawing two).
   *  The caller owns the state and the title — this only turns the label into the control. */
  onTitleClick?: () => void
  /** Tooltip for that control: what the click will switch TO. */
  titleHint?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = labels.length
  const maxVal = useMemo(
    () => Math.max(0, ...series.flatMap(s => s.values.filter(Number.isFinite))),
    [series],
  )
  const hasData = n > 0 && series.length > 0 && maxVal > 0
  // Headroom so a peak never touches the frame; whole numbers only — these are counts, so a
  // fractional tick ("2,5 locos") would be a lie about the data.
  const scale = Math.max(1, Math.ceil(maxVal * 1.12))
  const yTicks = useMemo(() => niceTicks(scale).filter(v => Number.isInteger(v)), [scale])
  const padL = Math.max(PAD_L_MIN, Math.max(...yTicks.map(v => formatValue(v).length), 1) * 5.6 + 8)

  // Plot area, inset on both sides (see X_INSET). `plotL`/`plotR` are the x of the FIRST and
  // LAST points; everything that maps an index to an x — the curve, the hover hit test, the
  // labels — goes through them, so the three can never disagree about where a period sits.
  const plotL = padL + X_INSET
  const plotR = Math.max(plotL + 1, box.w - PAD.r - X_INSET)
  const drawW = Math.max(1, plotR - plotL)
  const drawH = Math.max(1, box.h - PAD.t - PAD.b)
  const baseY = PAD.t + drawH
  const xAt = (i: number) => (n <= 1 ? plotL + drawW / 2 : plotL + (i / (n - 1)) * drawW)
  const yAt = (v: number) => PAD.t + drawH * (1 - v / scale)

  // A single period has no segment to draw, so its level is a flat line across the frame — the
  // same rule the Resumo Geral chart follows, and it reads as "this is the level" instead of as
  // an empty chart.
  const pathOf = (s: LineSeries) => {
    const pts = s.values.map((v, i) => ({ x: xAt(i), y: yAt(Number.isFinite(v) ? v : 0) }))
    if (pts.length === 1) return `M ${plotL} ${pts[0].y} L ${plotR} ${pts[0].y}`
    return smoothPath(pts)
  }

  // X labels: first and last always, plus as many evenly-spaced ones as actually fit.
  const labelPx = useMemo(() => Math.max(...labels.map(l => l.length), 1) * CH_PX, [labels])
  const xStep = useMemo(() => {
    if (n <= 2) return 1
    return Math.max(1, Math.ceil((labelPx + LABEL_GAP) / (drawW / (n - 1))))
  }, [labelPx, n, drawW])

  const idxFromX = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left
    const i = n <= 1 ? 0 : Math.round(((px - plotL) / drawW) * (n - 1))
    return Math.min(n - 1, Math.max(0, i))
  }

  /** Is the evenly-spaced label at index `i` clear of the two that are ALWAYS drawn?
   *
   *  `xStep` spaces the middle labels from each other, but the first and last are anchored to the
   *  frame edges (start / end), so they run a FULL label width inward while a middle one runs only
   *  half a width outward. One step of clearance is therefore not enough at either end, which is
   *  exactly where the weekly labels were colliding — the first two and the last two. These
   *  compare real pixel spans instead, so the rule holds whatever the label lengths are. */
  const clearOfEnds = (i: number) => {
    const cx = xAt(i)
    return cx - labelPx / 2 >= padL + labelPx + LABEL_GAP
        && cx + labelPx / 2 <= box.w - PAD.r - labelPx - LABEL_GAP
  }

  const hoverIdx = hover != null && hover < n ? hover : null

  return (
    <div style={{
      border: '1.5px solid #E5E7EB', borderRadius: 10, background: '#fff',
      display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
      padding: '7px 10px 5px', gap: 2, boxSizing: 'border-box',
    }}>
      {/* Eyebrow + legend, in the KPI-card idiom of the Resumo Geral chart. The legend swatch is the
          series' own stroke (dash included), which is how the reader tells four lines apart. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
        {onTitleClick ? (
          // The eyebrow doubles as the view switch. Deliberately still an eyebrow and not a button
          // bar: it names what the frame is showing, and clicking a name to get the other reading is
          // the whole control. The chevron is what says it is clickable at all.
          <button
            onClick={onTitleClick}
            title={titleHint}
            style={{
              all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
              fontSize: 11.5, color: '#6B7280', fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              borderBottom: '1px dashed #D1D5DB', lineHeight: 1.5,
            }}
          >
            {title}
            <ChevronsUpDown size={13} style={{ color: '#9CA3AF', flexShrink: 0 }} />
          </button>
        ) : (
          <span style={{
            fontSize: 10, color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {title}
          </span>
        )}
        {/* Sized for a chart that now owns the whole panel rather than a quarter of it: at the old
            9.5px the legend was reading as a caption on a frame four times its former size. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {series.map(s => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title={s.label}>
              <svg width="20" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="20" y2="4" stroke={s.color} strokeWidth={s.dashed ? 2 : 2.6} strokeDasharray={s.dashed ? '5 3' : undefined} />
              </svg>
              <span style={{ fontSize: 11.5, color: s.color, fontWeight: 700, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.label}
              </span>
            </span>
          ))}
        </span>
      </div>

      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {box.w > 0 && (hasData ? (
          <svg
            width={box.w} height={box.h} style={{ display: 'block' }}
            onPointerMove={e => setHover(idxFromX(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onPointerLeave={() => setHover(null)}
          >
            {/* Y axis — round integer ticks with a hairline each, under the series. */}
            {yTicks.map(v => {
              const y = yAt(v)
              return (
                <g key={`yt-${v}`} pointerEvents="none">
                  <line x1={padL} y1={y} x2={box.w - PAD.r} y2={y} stroke="#F1F3F5" strokeWidth={1} />
                  <text x={padL - 5} y={y + 3} textAnchor="end" fontSize={9} fill="#9CA3AF" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatValue(v)}
                  </text>
                </g>
              )
            })}

            {/* Dashed (compared) series first, so the active scenario's solid lines sit on top. */}
            {[...series].sort((a, b) => Number(b.dashed) - Number(a.dashed)).map(s => (
              <path
                key={s.key} d={pathOf(s)} fill="none" stroke={s.color}
                strokeWidth={s.dashed ? 1.5 : 1.9}
                strokeDasharray={s.dashed ? '5 3' : undefined}
                strokeLinejoin="round" strokeLinecap="round"
              />
            ))}

            {/* X labels on the baseline of the bottom padding. Drawn BEFORE the hover group: SVG
                paints in document order, so with the labels last they came out on top of the
                tooltip bubble and printed through it. */}
            {n === 1 ? (
              <text x={xAt(0)} y={box.h - 4} fontSize={9} fill="#9CA3AF" textAnchor="middle">{labels[0]}</text>
            ) : (
              labels.map((l, i) => {
                const isFirst = i === 0, isLast = i === n - 1
                if (!isFirst && !isLast && (i % xStep !== 0 || !clearOfEnds(i))) return null
                return (
                  <text
                    key={`${l}-${i}`}
                    x={isFirst ? padL : isLast ? box.w - PAD.r : xAt(i)}
                    y={box.h - 4} fontSize={9} fill="#9CA3AF"
                    textAnchor={isFirst ? 'start' : isLast ? 'end' : 'middle'}
                  >
                    {l}
                  </text>
                )
              })
            )}

            {/* Hover: one guide line, a marker on every series, and a bubble listing them all — with
                four lines crossing, reading a period off the curves alone is guesswork. */}
            {hoverIdx != null && (() => {
              const x = xAt(hoverIdx)
              const rows = series.map(s => ({
                label: s.label, color: s.color,
                y: yAt(Number.isFinite(s.values[hoverIdx]) ? s.values[hoverIdx] : 0),
                text: formatValue(s.values[hoverIdx] ?? 0),
              }))
              // Bubble geometry scales with the type inside it — the widths are character-count
              // estimates, so bumping the font without bumping these clips the longest row.
              const ROW_H = 16
              const bubbleW = Math.max(112, Math.max(
                ...rows.map(r => `${r.label}  ${r.text}`.length * 6 + 34),
                labels[hoverIdx].length * 6.2 + 16,
              ))
              const bubbleH = 18 + rows.length * ROW_H + 8
              const placeRight = x < box.w / 2
              const bx = placeRight
                ? Math.min(box.w - bubbleW - 2, x + 10)
                : Math.max(2, x - bubbleW - 10)
              const by = Math.min(box.h - bubbleH - 2, Math.max(PAD.t, Math.min(...rows.map(r => r.y)) - bubbleH / 2))
              return (
                <g pointerEvents="none">
                  <line x1={x} y1={PAD.t} x2={x} y2={baseY} stroke="#9CA3AF" strokeWidth={0.75} strokeOpacity={0.5} />
                  {rows.map(r => <circle key={r.label} cx={x} cy={r.y} r={3.2} fill="#fff" stroke={r.color} strokeWidth={1.8} />)}
                  <g transform={`translate(${bx} ${by})`}>
                    <rect width={bubbleW} height={bubbleH} rx={6} fill="#1F2937" />
                    <text x={bubbleW / 2} y={13} textAnchor="middle" fontSize={10} fill="#9CA3AF">{labels[hoverIdx]}</text>
                    {rows.map((r, ri) => {
                      const y = 18 + ri * ROW_H + 11
                      return (
                        <g key={r.label}>
                          <circle cx={10} cy={y - 4} r={3} fill={r.color} />
                          <text x={19} y={y} fontSize={10.5} fill="#D1D5DB">{r.label}</text>
                          <text x={bubbleW - 8} y={y} textAnchor="end" fontSize={11.5} fontWeight="700" fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{r.text}</text>
                        </g>
                      )
                    })}
                  </g>
                </g>
              )
            })()}

          </svg>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 10, color: '#CBD5E1', fontWeight: 500 }}>{emptyText}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
