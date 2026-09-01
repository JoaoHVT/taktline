'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X, ImageDown, AlertTriangle } from 'lucide-react'
import type React from 'react'

/**
 * Compact, dashboard-oriented area chart for the Resumo Geral (Área mode) tab.
 *
 * Hand-rolled SVG (no chart lib) to stay lightweight and to visually rhyme with the
 * KPI cards: a smooth monotone line in the app's primary red over a subtle gray area
 * fill, a hairline dotted line at the period average, and two X-axis anchor labels
 * (first + last period) — the expanded view labels every period instead. All data is
 * derived upstream from the (already filtered) summary table, so it tracks every
 * active filter, scenario, period and mode.
 *
 * Monthly: fills the available width, no scroll. Weekly: fixed-width buckets with
 * horizontal scroll when they overflow, preserving readability.
 *
 * The header's top-right button opens the SAME chart in a large centred overlay
 * ("full focus"), for reading a dense weekly series. The overlay renders a second
 * instance of this component with `focusView`, so there is exactly one chart
 * implementation and the two views can never drift apart.
 */

export interface SummaryAreaPoint {
  key:   string
  label: string
  value: number
}

interface SummaryAreaChartProps {
  points:      SummaryAreaPoint[]
  /** Compared scenario's Total series (comparison mode). Aligned 1:1 to `points` by index.
   *  Drawn as a dark-gray dashed line; no area fill and no average line for this series. */
  comparePoints?: SummaryAreaPoint[]
  average:     number
  /** Header eyebrow, e.g. "Horas · Mensal". */
  title:       string
  /** Formats a raw value for the average readout and hover bubble. */
  formatValue: (v: number) => string
  /** Weekly mode scrolls horizontally when buckets overflow the container. */
  scrollable:  boolean
  color:       string
  /** When provided, the title becomes a clickable metric toggle (dotted underline). */
  onToggleMetric?: () => void
  /** Click a data point to toggle that period's filter on the table (bidirectional sync). Receives
   *  the point's `key` (month key in monthly mode, fw key in weekly). Omit to disable. */
  onPointClick?: (key: string) => void
  /** Keys the user selected BY CLICKING THIS CHART (already intersected with the live date filter
   *  by the caller) — the matching points get the red band + dot. A period filtered from the Datas
   *  dropdown is deliberately NOT marked: the highlight tracks chart interaction, not the filter. */
  selectedKeys?: Set<string>
  /** Current period granularity, and a switch for it. Rendered ONLY in the expanded view (top-left
   *  corner): the compact card has no room, and the Exibição menu above it already owns the choice
   *  there — inside the overlay that menu is out of reach, so the chart carries its own. Omit either
   *  and no toggle appears. */
  viewMode?: 'mensal' | 'semanal'
  onViewModeChange?: (m: 'mensal' | 'semanal') => void
  /** Name of the scenario the RED series belongs to (the one being edited). Labelled at the end of
   *  the line in the expanded view, where there is finally room for it. */
  scenarioLabel?: string
  /** Comparison mode: name of the scenario behind the gray dashed line. Labelled the same way —
   *  naming only one of two plotted series would be worse than naming neither. */
  compareScenarioLabel?: string
  /** Internal: this instance IS the full-focus overlay copy. Fills its container, drops the
   *  card chrome and swaps the expand button for a close button. Never set by callers. */
  focusView?: boolean
  /** Internal: closes the full-focus overlay (only meaningful with `focusView`). */
  onExitFocus?: () => void
}

// Fritsch–Carlson monotone cubic — smooth but never overshoots the data (no dips
// below zero, no phantom peaks), which matters for an honest hours distribution.
export function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${pts[0].x} ${pts[0].y}`
  if (n === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  const dx: number[] = [], d: number[] = []
  for (let i = 0; i < n - 1; i++) { const h = xs[i + 1] - xs[i]; dx.push(h); d.push((ys[i + 1] - ys[i]) / h) }
  const m: number[] = new Array(n)
  m[0] = d[0]; m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0 }
    else {
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] }
    }
  }
  let path = `M ${xs[0]} ${ys[0]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]
    path += ` C ${xs[i] + h / 3} ${ys[i] + m[i] * h / 3} ${xs[i + 1] - h / 3} ${ys[i + 1] - m[i + 1] * h / 3} ${xs[i + 1]} ${ys[i + 1]}`
  }
  return path
}

/** "Nice" round tick values from 0 up to (and including the last step below) `top`.
 *  Used only by the expanded view's Y axis — a raw `top/4` split would print labels like
 *  "1.237 h", which read as data rather than as a scale. */
export function niceTicks(top: number, count = 4): number[] {
  if (!(top > 0) || !Number.isFinite(top)) return [0]
  const raw = top / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

const PAD_COMPACT = { l: 10, r: 10, t: 10, b: 15 }
/** Focus view: more room, because every label inside grew with it (see `S` below). */
const PAD_FOCUS   = { l: 16, r: 16, t: 14, b: 26 }
const MIN_BUCKET = 26   // px per weekly bucket before we start scrolling

/** Dark gray — the COMPARED scenario's Total line (dashed). Exported so the footer's scenario
 *  labels use the exact colour of the series they name (see GanttModalFooter). */
export const COMPARE_LINE = '#4B5563'

// ── PNG export (expanded view only) ─────────────────────────────────────────────────────────
/**
 * Font stack BAKED INTO the exported SVG.
 *
 * An <svg> rasterised through an <img> is its own document: the page's stylesheet never reaches
 * it, and a webfont the page loaded (Inter, via next/font) is not available to it at all. Naming
 * Inter here would silently fall through to each browser's default serif, so the PNG would not
 * look like the chart it was taken from. These are faces the host OS ships, so the image comes
 * out the same wherever it is opened.
 */
const EXPORT_FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
/** Rasterise at 2×: the PNG lands in a deck or a report and gets zoomed, and a 1× capture of a
 *  chart made of hairlines and 9px type is unreadable the moment it is scaled up. */
const EXPORT_SCALE = 2
/** Strip above the chart for the eyebrow + the three readouts. Those live in HTML, NOT in the
 *  <svg>, so they are redrawn onto the canvas — a chart image without its total, average and
 *  unit is a picture of a shape. */
const EXPORT_HEADER_H = 34

/** Filename stem: the metric being shown plus the day it was taken, both of which are the things
 *  someone needs when three of these are sitting in a downloads folder. */
function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  return `taktline-${slug || 'grafico'}-${stamp}.png`
}

export function SummaryAreaChart(props: SummaryAreaChartProps) {
  const { points, comparePoints, average, title, formatValue, scrollable, color, onToggleMetric, onPointClick, selectedKeys, viewMode, onViewModeChange, scenarioLabel, compareScenarioLabel, focusView = false, onExitFocus } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  // Full-focus overlay (owned by the INLINE instance only — the overlay copy never opens another).
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setFocused(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])
  // Stable per-instance gradient id (lazy state, not a ref read during render).
  const [gradId] = useState(() => `sac-${Math.random().toString(36).slice(2, 9)}`)
  // PNG export (expanded view only). `exportState` drives the button alone — there is no toast
  // in this component and a failure here loses nothing, so it reports itself where the click
  // happened and clears on its own.
  const svgRef = useRef<SVGSVGElement>(null)
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'error'>('idle')
  useEffect(() => {
    if (exportState !== 'error') return
    const t = setTimeout(() => setExportState('idle'), 4000)
    return () => clearTimeout(t)
  }, [exportState])

  // ── Scale for the full-focus copy ───────────────────────────────────────────
  // The overlay is ~4× the inline card's area, and every glyph in here is a hard-coded SVG
  // font size, so unscaled the expanded chart came out as the same tiny 8–10px type floating
  // in a huge frame. `s()` scales type, radii and the tooltip's geometry; `sw()` scales stroke
  // widths on a gentler curve — a line that grew 1.7× would read as a band, not a series.
  const S = focusView ? 1.7 : 1
  const s = (v: number) => Math.round(v * S * 10) / 10
  const sw = (v: number) => Math.round(v * (focusView ? 1.35 : 1) * 100) / 100

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ignore a hover index left over from a previous (shorter) series.
  const hoverIdx = hover != null && hover < points.length ? hover : null

  // Compared series is aligned 1:1 by index; ignore it if its length doesn't match (stale).
  const cmp = comparePoints && comparePoints.length === points.length ? comparePoints : null
  const maxVal = Math.max(average, ...points.map(p => p.value), ...(cmp ? cmp.map(p => p.value) : []), 0)
  const hasData = points.length > 0 && maxVal > 0
  // Legend readouts: total of the plotted series (red line) + period average (dotted line).
  const total = points.reduce((s, p) => s + p.value, 0)
  const compareTotal = cmp ? cmp.reduce((s, p) => s + p.value, 0) : null

  // ── Y axis (expanded view only) ─────────────────────────────────────────────
  // The compact card has no room for a value axis (it reads the totals from the legend), but the
  // expanded view is meant to be READ, so it gets round tick values. Their widest label decides the
  // left padding — hard-coding it would either clip "12.500 h" or waste a gutter on "50 h".
  const scale = maxVal * 1.12 || 1
  const yTicks = focusView && hasData ? niceTicks(scale) : []
  const yTickW = yTicks.length
    ? Math.max(...yTicks.map(v => formatValue(v).length)) * s(9) * 0.62 + s(8)
    : 0
  const PAD = focusView ? { ...PAD_FOCUS, l: PAD_FOCUS.l + yTickW } : PAD_COMPACT
  const minBucket = focusView ? Math.round(MIN_BUCKET * S) : MIN_BUCKET

  // Drawing surface. Weekly may exceed the wrapper width (→ scroll); monthly fills it.
  const contentW = scrollable
    ? Math.max(box.w, points.length * minBucket + PAD.l + PAD.r)
    : box.w
  const svgH  = box.h
  const drawW = Math.max(1, contentW - PAD.l - PAD.r)
  const drawH = Math.max(1, svgH - PAD.t - PAD.b)
  const baseY = PAD.t + drawH
  const n = points.length
  const xAt = (i: number) => n <= 1 ? PAD.l + drawW / 2 : PAD.l + (i / (n - 1)) * drawW
  const yAt = (v: number) => PAD.t + drawH * (1 - v / scale)

  // Expanded view labels EVERY period on the X axis. How many actually fit is geometry, so it is
  // measured rather than assumed: widest label × an average glyph width, plus breathing room,
  // against the real spacing between two points. 1 = label everything (the monthly case at any
  // sane width); >1 only when a dense series (53 weekly buckets) would print labels on top of
  // each other, and then it thins evenly instead.
  const xLabelW = focusView && n > 1
    ? Math.max(...points.map(p => p.label.length)) * s(9) * 0.62 + s(8)
    : 0
  const xTickStep = xLabelW > 0 ? Math.max(1, Math.ceil(xLabelW / (drawW / (n - 1)))) : 1

  // A single plotted period (one month / one week selected with "Unir períodos" on) has no second
  // point to draw a segment between, so `smoothPath` degenerates to a bare `M x y` — an empty-looking
  // chart. It is rendered as a FLAT line spanning the full width at that value instead (area fill
  // included), which reads as "this is the level for the whole period" rather than as no data.
  const flatPath = (y: number) => `M ${PAD.l} ${y} L ${contentW - PAD.r} ${y}`
  const flatArea = (y: number) => `${flatPath(y)} L ${contentW - PAD.r} ${baseY} L ${PAD.l} ${baseY} Z`
  const single = n === 1

  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.value) }))
  const linePath = single ? flatPath(coords[0].y) : smoothPath(coords)
  const areaPath = single
    ? flatArea(coords[0].y)
    : coords.length
      ? `${smoothPath(coords)} L ${coords[coords.length - 1].x} ${baseY} L ${coords[0].x} ${baseY} Z`
      : ''
  const avgY = yAt(average)
  // Compared scenario: just the Total line (no area, no average).
  const compareCoords = cmp ? cmp.map((p, i) => ({ x: xAt(i), y: yAt(p.value) })) : null
  const compareLinePath = compareCoords
    ? (single ? flatPath(compareCoords[0].y) : smoothPath(compareCoords))
    : ''

  const idxFromX = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left
    const idx = n <= 1 ? 0 : Math.round(((px - PAD.l) / drawW) * (n - 1))
    return Math.min(n - 1, Math.max(0, idx))
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!hasData || n === 0) return
    setHover(idxFromX(e.clientX, e.currentTarget.getBoundingClientRect()))
  }
  // Click a point → toggle that period's filter on the table (re-click clears it). Bidirectional sync.
  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!onPointClick || !hasData || n === 0) return
    const p = points[idxFromX(e.clientX, e.currentTarget.getBoundingClientRect())]
    if (p) onPointClick(p.key)
  }

  // ── Export the expanded chart as a PNG ────────────────────────────────────────────────────
  //
  // The live <svg> IS the chart, so it is cloned and rasterised rather than redrawn: there is
  // one drawing implementation and the image cannot drift from what the user is looking at.
  //
  // Three things the clone has to be corrected for, all of them because an <svg> inside an
  // <img> is a separate document that inherits nothing from this page:
  //   • `xmlns` — without it the serialised markup is not a parseable SVG document and the
  //     <img> refuses to load it.
  //   • `font-family` — see EXPORT_FONT. Every glyph in here sets only a SIZE and inherits the
  //     family from the page, which does not follow the clone.
  //   • `[data-export-skip]` — the hover guide, marker and value bubble are a pointer state,
  //     not part of the chart. They are stripped instead of waiting for the hover to clear,
  //     because `setHover(null)` is async and the click that starts this may land first.
  //
  // The whole series is exported, not the visible slice: in weekly mode the surface is wider
  // than the scroll container, and a screenshot of a scrolled chart is exactly what this button
  // exists to replace.
  //
  // The chart is drawn 2× and the header strip is composed straight onto the canvas, so the PNG
  // carries the metric name, the total, the compared total and the average — the numbers that
  // make the shape mean something — instead of an unlabelled curve.
  async function exportPng() {
    const svg = svgRef.current
    if (!svg || exportState === 'busy') return
    setExportState('busy')
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement
      clone.querySelectorAll('[data-export-skip]').forEach(el => el.remove())
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(contentW))
      clone.setAttribute('height', String(svgH))
      clone.setAttribute('font-family', EXPORT_FONT)
      clone.removeAttribute('style')       // `cursor: pointer` is meaningless in an image

      // data: URL, not blob: — a data URL can never taint the canvas, so `toBlob` below is
      // guaranteed to be readable whatever the browser's cross-origin rules decide about the
      // temporary object URL.
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
      const img = new Image()
      await new Promise<void>((ok, fail) => {
        img.onload = () => ok()
        img.onerror = () => fail(new Error('SVG could not be rasterised'))
        img.src = svgUrl
      })

      const W = Math.max(1, Math.round(contentW))
      const chartH = Math.max(1, Math.round(svgH))
      const H = chartH + EXPORT_HEADER_H
      const canvas = document.createElement('canvas')
      canvas.width = W * EXPORT_SCALE
      canvas.height = H * EXPORT_SCALE
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D context unavailable')
      ctx.scale(EXPORT_SCALE, EXPORT_SCALE)
      // Opaque white: a PNG with an alpha background turns into a black rectangle the moment it
      // is pasted onto a dark slide.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, W, H)

      // Header strip — same content, order and colours as the on-screen one.
      const midY = EXPORT_HEADER_H / 2
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.font = `600 11px ${EXPORT_FONT}`
      ctx.fillStyle = '#9CA3AF'
      ctx.fillText(title.toUpperCase(), 14, midY)

      // Laid out right-to-left from the right edge, so the readouts keep the same order on the
      // image as on screen however many of them there are (the compared total is conditional).
      ctx.textAlign = 'right'
      let rx = W - 14
      const readout = (text: string, stroke: string, dash: number[]) => {
        ctx.font = `700 11px ${EXPORT_FONT}`
        ctx.fillStyle = stroke
        ctx.fillText(text, rx, midY)
        rx -= ctx.measureText(text).width + 5
        ctx.save()
        ctx.setLineDash(dash)
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(rx - 14, midY)
        ctx.lineTo(rx, midY)
        ctx.stroke()
        ctx.restore()
        rx -= 14 + 12
      }
      readout(formatValue(average), '#9CA3AF', [2, 2])
      if (compareTotal != null) readout(formatValue(compareTotal), COMPARE_LINE, [3, 2])
      readout(formatValue(total), color, [])

      // Hairline between the strip and the chart, matching the gridline tone.
      ctx.fillStyle = '#F1F3F5'
      ctx.fillRect(0, EXPORT_HEADER_H - 1, W, 1)

      ctx.drawImage(img, 0, EXPORT_HEADER_H, W, chartH)

      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
      if (!blob) throw new Error('PNG encoding failed')

      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = exportFileName(title)
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoked on the next task, not immediately: Safari reads the href after the click returns.
      setTimeout(() => URL.revokeObjectURL(href), 0)
      setExportState('idle')
    } catch (err) {
      console.error('[Taktline] chart PNG export failed:', err)
      setExportState('error')
    }
  }

  return (
    <div
      style={focusView
        ? {
            flex: '1 1 auto', width: '100%', minWidth: 0, minHeight: 0, boxSizing: 'border-box',
            background: '#fff', padding: '10px 16px 8px', display: 'flex', flexDirection: 'column', gap: 6,
          }
        : {
            flex: '1 1 320px', minWidth: 300, minHeight: 96, alignSelf: 'stretch', boxSizing: 'border-box',
            border: '1.5px solid #E5E7EB', borderRadius: 10, background: '#fff',
            padding: '7px 12px 5px', display: 'flex', flexDirection: 'column', gap: 2,
          }}
    >
      {/* Two header labels: mode eyebrow (left) + average readout (right). The expanded view puts a
          Mensal/Semanal switch ahead of the eyebrow, in the extreme top-left corner. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
        {/* Left group: the switch keeps the corner, the eyebrow stays beside it instead of drifting
            into the middle (three loose children under space-between would spread apart). */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: s(6), minWidth: 0 }}>
        {focusView && viewMode && onViewModeChange && (
          // Segmented pair, not a single label button: the app's standard for a view-mode switch,
          // and it says which mode is active without the reader having to guess whether the label
          // names the current view or the one a click would bring.
          <span style={{ display: 'inline-flex', border: '1px solid #E5E7EB', borderRadius: 6, overflow: 'hidden', flexShrink: 0, marginRight: s(4) }}>
            {(['mensal', 'semanal'] as const).map(m => {
              const active = viewMode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { if (!active) onViewModeChange(m) }}
                  title={m === 'mensal' ? 'Ver por mês' : 'Ver por semana fiscal'}
                  style={{
                    all: 'unset', boxSizing: 'border-box', cursor: active ? 'default' : 'pointer',
                    padding: `${s(2)}px ${s(8)}px`, fontSize: s(9.5), fontWeight: 700,
                    letterSpacing: '0.03em', textTransform: 'uppercase', lineHeight: 1.6,
                    background: active ? color : '#fff', color: active ? '#fff' : '#9CA3AF',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#F3F4F6' }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = '#fff' }}
                >
                  {m === 'mensal' ? 'Mensal' : 'Semanal'}
                </button>
              )
            })}
          </span>
        )}
        {onToggleMetric ? (
          <button
            type="button"
            onClick={onToggleMetric}
            title="Alternar métrica: Horas ↔ Horas/dia"
            style={{
              all: 'unset', boxSizing: 'border-box',
              fontSize: s(10), color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer',
              borderBottom: '1px dotted #9CA3AF', lineHeight: 1.4,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = color; e.currentTarget.style.borderBottomColor = color }}
            onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; e.currentTarget.style.borderBottomColor = '#9CA3AF' }}
          >
            {title}
          </button>
        ) : (
          <span style={{ fontSize: s(10), color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </span>
        )}
        </span>
        {/* Legend — red solid line = total of the plotted series (left), dotted line =
            period average (right). Each readout is formatted via formatValue, so its unit label
            (h / U.E. / h/d / U/d) always tracks the current view mode and metric. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: s(10), flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: s(4) }} title="Total do período exibido">
            <svg width={s(14)} height={s(6)} aria-hidden="true"><line x1="0" y1={s(3)} x2={s(14)} y2={s(3)} stroke={color} strokeWidth={sw(1.8)} /></svg>
            <span style={{ fontSize: s(10), color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatValue(total)}</span>
          </span>
          {compareTotal != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: s(4) }} title="Total do cenário comparado">
              <svg width={s(14)} height={s(6)} aria-hidden="true"><line x1="0" y1={s(3)} x2={s(14)} y2={s(3)} stroke={COMPARE_LINE} strokeWidth={sw(1.6)} strokeDasharray="3 2" /></svg>
              <span style={{ fontSize: s(10), color: COMPARE_LINE, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatValue(compareTotal)}</span>
            </span>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: s(4) }} title="Média do período exibido">
            <svg width={s(14)} height={s(6)} aria-hidden="true"><line x1="0" y1={s(3)} x2={s(14)} y2={s(3)} stroke="#9CA3AF" strokeWidth={sw(1.2)} strokeDasharray="2 2" /></svg>
            <span style={{ fontSize: s(10), color: '#9CA3AF', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatValue(average)}</span>
          </span>
          {/* Export as PNG — expanded view ONLY. The compact card is 96px tall and its image would
              be a thumbnail nobody can read; the expanded one is the view that is worth taking
              away. Also gated on `hasData`: there is no chart to rasterise otherwise. */}
          {focusView && hasData && (
            <button
              type="button"
              onClick={() => { void exportPng() }}
              disabled={exportState === 'busy'}
              title={exportState === 'error'
                ? 'Falha ao gerar o PNG — veja o console'
                : 'Baixar este gráfico como PNG'}
              aria-label="Baixar gráfico como PNG"
              style={{
                all: 'unset', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center', width: s(20), height: s(20), borderRadius: 5,
                cursor: exportState === 'busy' ? 'progress' : 'pointer',
                color: exportState === 'error' ? '#D32F2F' : '#9CA3AF',
                opacity: exportState === 'busy' ? 0.5 : 1, flexShrink: 0,
              }}
              onMouseEnter={e => { if (exportState === 'idle') { e.currentTarget.style.color = color; e.currentTarget.style.background = '#F3F4F6' } }}
              onMouseLeave={e => { if (exportState === 'idle') { e.currentTarget.style.color = '#9CA3AF'; e.currentTarget.style.background = 'transparent' } }}
            >
              {exportState === 'error' ? <AlertTriangle size={s(14)} /> : <ImageDown size={s(14)} />}
            </button>
          )}
          {/* Top-right control: expand into the full-focus overlay (inline view) / close it. */}
          <button
            type="button"
            onClick={() => (focusView ? onExitFocus?.() : setFocused(true))}
            title={focusView ? 'Fechar (Esc)' : 'Expandir gráfico'}
            aria-label={focusView ? 'Fechar gráfico expandido' : 'Expandir gráfico'}
            style={{
              all: 'unset', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', width: s(20), height: s(20), borderRadius: 5, cursor: 'pointer',
              color: '#9CA3AF', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = color; e.currentTarget.style.background = '#F3F4F6' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; e.currentTarget.style.background = 'transparent' }}
          >
            {focusView ? <X size={s(14)} /> : <Maximize2 size={13} />}
          </button>
        </span>
      </div>

      {/* Chart surface. Weekly scrolls when buckets overflow. */}
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, overflowX: scrollable ? 'auto' : 'hidden', overflowY: 'hidden' }}>
        {box.w > 0 && (
          hasData ? (
            <svg
              ref={svgRef}
              width={contentW} height={svgH}
              style={{ display: 'block', cursor: onPointClick ? 'pointer' : 'default' }}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onClick={onClick}
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#9CA3AF" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#9CA3AF" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Y axis — expanded view only: round tick values (see `niceTicks`) with a hairline
                  gridline each, drawn UNDER the series so they never compete with it. The compact
                  card has no room and keeps reading its figures from the legend. */}
              {yTicks.map(v => {
                const y = yAt(v)
                return (
                  <g key={`yt-${v}`} pointerEvents="none">
                    <line x1={PAD.l} y1={y} x2={contentW - PAD.r} y2={y} stroke="#F1F3F5" strokeWidth={sw(1)} />
                    <text x={PAD.l - s(6)} y={y + s(3)} textAnchor="end" fontSize={s(9)} fill="#9CA3AF" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatValue(v)}
                    </text>
                  </g>
                )
              })}

              {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}

              {/* Selected-period highlight (table date filter ↔ chart sync): a soft vertical band +
                  a solid dot on each point whose key is in `selectedKeys`, so the active month/week
                  reads the same in both the chart and the table. */}
              {selectedKeys && selectedKeys.size > 0 && points.map((p, i) => selectedKeys.has(p.key) && coords[i] ? (
                <g key={`sel-${p.key}`} pointerEvents="none">
                  <line x1={coords[i].x} y1={PAD.t} x2={coords[i].x} y2={baseY} stroke={color} strokeWidth={n <= 1 ? drawW : Math.max(s(6), drawW / Math.max(1, n - 1) * 0.7)} strokeOpacity="0.12" strokeLinecap="round" />
                  <circle cx={coords[i].x} cy={coords[i].y} r={s(3.2)} fill={color} stroke="#fff" strokeWidth={sw(1.2)} />
                </g>
              ) : null)}

              {/* Average — thin dotted horizontal reference (current scenario only). */}
              <line x1={PAD.l} y1={avgY} x2={contentW - PAD.r} y2={avgY} stroke="#9CA3AF" strokeWidth={sw(1)} strokeDasharray="2 3" />

              {/* Compared scenario's Total line — dark gray dashed, drawn under the red line. */}
              {compareLinePath && <path d={compareLinePath} fill="none" stroke={COMPARE_LINE} strokeWidth={sw(1.6)} strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" />}

              {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={sw(1.8)} strokeLinejoin="round" strokeLinecap="round" />}

              {/* Series names, expanded view only — the compact card has no room and reads its
                  figures from the legend. Anchored at the END of each line, where the series stops
                  and nothing else is drawn, with a white halo (paintOrder) so a name that lands on a
                  gridline stays readable. Red = the scenario in play; the gray dashed one is named
                  too whenever a comparison is loaded, so neither line is left unlabelled. The red
                  label rides ABOVE its line and the gray one BELOW, which keeps them apart on the
                  periods where the two scenarios agree. */}
              {focusView && hasData && (scenarioLabel || (compareScenarioLabel && compareCoords)) && (() => {
                const endX = single ? contentW - PAD.r : coords[coords.length - 1].x
                const clampY = (y: number) => Math.min(baseY - s(3), Math.max(PAD.t + s(9), y))
                const items: { text: string; y: number; fill: string; weight: number }[] = []
                if (scenarioLabel) items.push({ text: scenarioLabel, y: clampY(coords[coords.length - 1].y - s(9)), fill: color, weight: 700 })
                if (compareScenarioLabel && compareCoords) {
                  items.push({ text: compareScenarioLabel, y: clampY(compareCoords[compareCoords.length - 1].y + s(14)), fill: COMPARE_LINE, weight: 600 })
                }
                return (
                  <g pointerEvents="none">
                    {items.map(it => (
                      <text
                        key={`${it.fill}-${it.text}`}
                        x={endX - s(3)} y={it.y} textAnchor="end"
                        fontSize={s(9.5)} fontWeight={it.weight} fill={it.fill}
                        stroke="#fff" strokeWidth={s(3)} paintOrder="stroke"
                        strokeLinejoin="round"
                      >
                        {it.text}
                      </text>
                    ))}
                  </g>
                )
              })()}

              {/* Hover guide + dot(s) + value bubble. In comparison mode the tooltip lists both
                  scenarios (each with its own colour swatch) and a marker sits on each line. */}
              {hoverIdx != null && coords[hoverIdx] && (() => {
                const c = coords[hoverIdx]
                const p = points[hoverIdx]
                const cc = compareCoords ? compareCoords[hoverIdx] : null
                const cp = cmp ? cmp[hoverIdx] : null
                const curStr = formatValue(p.value)
                const cmpStr = cp ? formatValue(cp.value) : null
                // Two rows (Atual / Comparado) when comparing, otherwise the single value.
                const rows = cp
                  ? [{ label: 'Atual', val: curStr, dot: color }, { label: 'Comparado', val: cmpStr!, dot: COMPARE_LINE }]
                  : null
                // Every figure here is scaled, not just the fonts: the bubble is sized FROM the
                // text metrics, so scaling the type without the box would overflow it.
                const rowTextW = rows
                  ? Math.max(...rows.map(r => `${r.label}  ${r.val}`.length)) * s(5.0) + s(22)
                  : curStr.length * s(6.2) + s(14)
                const bubbleW = Math.max(s(56), Math.max(rowTextW, p.label.length * s(4.8) + s(10)))
                // Extra breathing room (~one line) between the month/date label and the value
                // section, so the readouts never crowd or visually overlap the label.
                const LABEL_GAP = s(9)
                const ROW_H = s(12)
                const bubbleH = rows ? s(14) + LABEL_GAP + rows.length * ROW_H + s(4) : s(20) + LABEL_GAP
                // Float the bubble to the SIDE of the guide line (the side with more room) so it
                // never sits on top of the markers/line, and ride it vertically next to the point.
                const GAP = s(12)
                const placeRight = c.x < contentW / 2
                const bx = placeRight
                  ? Math.min(contentW - bubbleW - 2, c.x + GAP)
                  : Math.max(2, c.x - bubbleW - GAP)
                // Center vertically on the higher of the two points, clamped inside the surface.
                const anchorY = cc ? Math.min(c.y, cc.y) : c.y
                const by = Math.min(svgH - bubbleH - 2, Math.max(PAD.t, anchorY - bubbleH / 2))
                return (
                  // data-export-skip: a pointer state, not part of the chart — stripped from the
                  // PNG clone (see exportPng).
                  <g pointerEvents="none" data-export-skip="">
                    <line x1={c.x} y1={PAD.t} x2={c.x} y2={baseY} stroke={color} strokeWidth={sw(0.75)} strokeOpacity="0.4" />
                    {/* Compared-line marker (gray) drawn first, current marker (red) on top. */}
                    {cc && <circle cx={cc.x} cy={cc.y} r={s(3)} fill="#fff" stroke={COMPARE_LINE} strokeWidth={sw(1.6)} />}
                    <circle cx={c.x} cy={c.y} r={s(3)} fill="#fff" stroke={color} strokeWidth={sw(1.6)} />
                    <g transform={`translate(${bx} ${by})`}>
                      <rect width={bubbleW} height={bubbleH} rx={s(5)} fill="#1F2937" />
                      <text x={bubbleW / 2} y={s(10)} textAnchor="middle" fontSize={s(8)} fill="#9CA3AF">{p.label}</text>
                      {rows
                        ? rows.map((r, ri) => {
                            const ry = s(14) + LABEL_GAP + ri * ROW_H + s(8)
                            return (
                              <g key={r.label}>
                                <circle cx={s(9)} cy={ry - s(3)} r={s(2.6)} fill={r.dot} />
                                <text x={s(16)} y={ry} fontSize={s(8.5)} fill="#D1D5DB">{r.label}</text>
                                <text x={bubbleW - s(6)} y={ry} textAnchor="end" fontSize={s(9)} fontWeight="700" fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{r.val}</text>
                              </g>
                            )
                          })
                        : <text x={bubbleW / 2} y={s(16) + LABEL_GAP} textAnchor="middle" fontSize={s(9)} fontWeight="700" fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{curStr}</text>}
                    </g>
                  </g>
                )
              })()}

              {/* X-axis labels, on the baseline of the bottom padding (which grew with the type,
                  PAD_FOCUS.b).
                    • Compact card: just the two anchors — first + last. There is no room for more.
                    • Expanded view: EVERY period, since the whole point of expanding is to read the
                      series period by period. `xTickStep` (computed above from the widest label vs
                      the actual spacing) is 1 whenever they all fit, which is the normal monthly
                      case; a dense weekly series thins out instead of overprinting itself. The
                      first and last are anchored start/end so they cannot be clipped by the edges. */}
              {focusView && n > 1 ? (
                points.map((p, i) => {
                  const isFirst = i === 0, isLast = i === n - 1
                  if (!isFirst && !isLast && i % xTickStep !== 0) return null
                  // Drop a thinned label that would collide with the always-drawn last one.
                  if (!isLast && !isFirst && (n - 1 - i) < xTickStep) return null
                  return (
                    <text
                      key={p.key}
                      x={isFirst ? PAD.l : isLast ? contentW - PAD.r : xAt(i)}
                      y={svgH - s(4)}
                      fontSize={s(9)}
                      fill="#9CA3AF"
                      textAnchor={isFirst ? 'start' : isLast ? 'end' : 'middle'}
                    >
                      {p.label}
                    </text>
                  )
                })
              ) : single ? (
                // One period: the label belongs under the middle of the flat line, not pinned to
                // the left edge where it would read as the start of a range.
                <text x={PAD.l + drawW / 2} y={svgH - s(4)} fontSize={s(9)} fill="#9CA3AF" textAnchor="middle">{points[0].label}</text>
              ) : (
                <>
                  <text x={PAD.l} y={svgH - s(4)} fontSize={s(9)} fill="#9CA3AF" textAnchor="start">{points[0].label}</text>
                  <text x={contentW - PAD.r} y={svgH - s(4)} fontSize={s(9)} fill="#9CA3AF" textAnchor="end">{points[n - 1].label}</text>
                </>
              )}
            </svg>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: s(10), color: '#CBD5E1', fontWeight: 500 }}>Sem dados no período</span>
            </div>
          )
        )}
      </div>

      {/* ── Full-focus overlay ─────────────────────────────────────────────────────────────
          Portalled to <body>: the Resumo Geral sits inside the Gantt modal's scroll
          containers, so an in-tree `position: fixed` would be clipped/offset by them.
          zIndex 9996 puts it above the modal (z-60) but below the Move-Mode prompts (9997+). */}
      {!focusView && focused && typeof document !== 'undefined' && createPortal(
        <div
          onClick={e => { if (e.target === e.currentTarget) setFocused(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9996, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div style={{
            width: 'min(1400px, 94vw)', height: 'min(760px, 86vh)', background: '#fff',
            borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <SummaryAreaChart {...props} focusView onExitFocus={() => setFocused(false)} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
