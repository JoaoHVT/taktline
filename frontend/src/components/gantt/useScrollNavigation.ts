import type { GanttData } from '@/lib/api'
import { animateScrollTo } from './smoothScroll'

function getIframeDoc(): Document | null {
  const frame = document.querySelector('iframe[title="Gantt Schedule"]') as HTMLIFrameElement | null
  return frame?.contentWindow?.document ?? null
}

// Frozen (left, sticky) column layout width in CSS px before any zoom scaling.
// Tree (any LOCO expanded): LINHA(52) + MODELO(88) + LOCO(50) + WORKSTATION(220) = 410.
// Narrow layout (every LOCO collapsed): the WORKSTATION column is width-0 → 190.
// The scroll-to math MUST use the actual rendered frozen width, otherwise it
// subtracts a phantom 220px (WS column that isn't there) → horizontal misalignment.
const FROZEN_W_FULL = 410
const FROZEN_W_LOCO = 190

/**
 * Compute the scroll target that brings `el` just right of the frozen column /
 * vertically centered in the viewport — accurate at ANY zoom and ANY distance.
 *
 * Coordinate space (settled empirically against the grab-pan handler, which writes
 * `clientX` deltas straight into `scrollLeft` and pans correctly at every zoom):
 * under CSS `zoom` on the scrolling element, BOTH `getBoundingClientRect()` and
 * `scrollLeft`/`scrollTop`/`clientHeight` — and the value consumed by
 * `scrollTo({left,top})` — live in the SAME rendered (zoomed) px space. So the whole
 * computation stays in rendered px: no ÷z on the rect (that mixed spaces and made the
 * error grow with the element's distance from the viewport's left edge).
 *
 * The math is a pure DELTA from the current scroll, so it is distance-independent:
 * element's current rendered-left = rect.left; we want it at the frozen block's right
 * edge = frozenW·z (rendered) → newScroll = scrollLeft + (rect.left − frozenW·z). The
 * frozen block is scaled by z because it occupies frozenW·z rendered px on screen.
 */
function _rectScrollTarget(
  el: HTMLElement,
  scrollEl: HTMLElement,
  z: number,
  frozenW: number,
): { left: number; top: number } {
  const rect = el.getBoundingClientRect()
  // All rendered (zoomed) px: rect, scroll*, clientHeight, and the scrollTo target.
  const left = Math.max(0, scrollEl.scrollLeft + rect.left - frozenW * z)
  const top  = Math.max(0, scrollEl.scrollTop  + rect.top  - (scrollEl.clientHeight - rect.height) / 2)
  return { left, top }
}

/**
 * Earliest-date VISIBLE rendered day box within ONE locomotive's tbody, among the rows a caller
 * accepts. This is how navigation respects active hide filters ("Ocultar antes do início" / hidden
 * columns / hidden rows): hidden boxes are trimmed out of the DOM or have zero size, so they can
 * never be chosen — the result is always real, visible content, never the empty gap a full-dataset
 * iso scan would target. Scoped to the matching `tbody[data-loco]` so the scan stays cheap.
 *
 *   locoKey  — `linha||wo||task||start_ms` (matches the worker's data-loco, raw not safe()-encoded).
 *   rowMatch — predicate over each row's dataset; return true to consider that row's boxes.
 */
function _firstVisibleBoxInLoco(
  doc: Document,
  locoKey: string,
  rowMatch: (ds: DOMStringMap) => boolean,
): HTMLElement | null {
  let tbody: HTMLElement | null = null
  // Match by attribute VALUE (locoKey can contain CSS-special chars → avoid selectors).
  doc.querySelectorAll('tbody[data-loco]').forEach(tb => {
    if (tb.getAttribute('data-loco') === locoKey) tbody = tb as HTMLElement
  })
  if (!tbody) return null
  let best: HTMLElement | null = null
  let bestLeft = Infinity
  ;(tbody as HTMLElement).querySelectorAll('tr').forEach(tr => {
    if (!rowMatch((tr as HTMLElement).dataset)) return
    ;(tr as HTMLElement).querySelectorAll('td[data-iso]').forEach(cell => {
      const el = cell as HTMLElement
      if (el.dataset.hh == null) return              // only real day boxes (skip empty/placeholder cells)
      const r = el.getBoundingClientRect()
      if (r.height <= 0 || r.width <= 0) return        // skip hidden/zero-size cells (hide filters)
      if (r.left < bestLeft) { bestLeft = r.left; best = el }
    })
  })
  return best
}

export function makeScrollNavigation({
  effectiveData,
  activeTab,
  ganttBuiltRef,
  pendingScrollRef,
  handleTabSwitch,
  setScheduleGateMsg,
  zoom = 1,
  locoNarrow = false,
}: {
  effectiveData: GanttData | null
  activeTab: number
  ganttBuiltRef: React.MutableRefObject<boolean>
  pendingScrollRef: React.MutableRefObject<(() => void) | null>
  handleTabSwitch: (tab: 0 | 1 | 2 | 3) => void
  setScheduleGateMsg: (msg: string | null) => void
  zoom?: number
  /** True when every LOCO is collapsed (the narrow layout): the WORKSTATION column is
   *  width-0, so the frozen block is 190px instead of 410. */
  locoNarrow?: boolean
}) {
  // The iframe is scaled with CSS `zoom` on documentElement. Navigation uses
  // getBoundingClientRect() (always rendered px) so it is correct at any zoom —
  // only the frozen-column offset needs the zoom factor. Falls back to 1.
  const z = zoom && zoom > 0 ? zoom : 1
  // The narrow all-collapsed layout drops the WORKSTATION column → narrower frozen block.
  // Use the matching frozen width so scroll-to targets exclude the (absent) WS column.
  const frozenW = locoNarrow ? FROZEN_W_LOCO : FROZEN_W_FULL
  function handleLocoClick(taskName: string, linha?: string, modelWo?: string, startMs?: string | number | null) {
    if (!ganttBuiltRef.current) {
      setScheduleGateMsg('Volte na aba anterior, defina o período e carregue a aba Schedule.')
      return
    }
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_')
    const locoId     = `loco_${safe(linha ?? '')}_${safe(modelWo ?? '')}_${safe(taskName)}_${safe(String(startMs ?? ''))}`
    const locoColId  = `wsc_loco_${safe(linha ?? '')}_${safe(modelWo ?? '')}_${safe(taskName)}_${safe(String(startMs ?? ''))}`
    const locoLocoId = `lcc_loco_${safe(linha ?? '')}_${safe(modelWo ?? '')}_${safe(taskName)}_${safe(String(startMs ?? ''))}`

    function findLocoRow(doc: Document): HTMLElement | null {
      const elDesc  = doc.getElementById(locoId)     as HTMLElement | null
      const elWsCol = doc.getElementById(locoColId)  as HTMLElement | null
      const elLcCol = doc.getElementById(locoLocoId) as HTMLElement | null
      const visible = (el: HTMLElement | null) => el && el.getBoundingClientRect().height > 0 ? el : null
      return visible(elLcCol) ?? visible(elWsCol) ?? elDesc
    }

    function scrollToLoco(attempt = 0) {
      const doc = getIframeDoc()
      if (!doc) {
        if (attempt < 30) window.setTimeout(() => scrollToLoco(attempt + 1), 80)
        return
      }
      const win = doc.defaultView
      if (!win) return
      const scrollEl = (doc.scrollingElement ?? doc.documentElement) as HTMLElement

      const sourceGroups = effectiveData?.groups ?? []
      const smKey = (startMs != null && startMs !== '') ? String(startMs).slice(0, 10) : null
      const allDates: string[] = []
      for (const g of sourceGroups) {
        if (g.task_name !== taskName) continue
        if (linha && g.linha !== linha) continue
        if (modelWo && g.wo !== modelWo) continue
        if (smKey && g.start_ms != null && g.start_ms !== '' && String(g.start_ms).slice(0, 10) !== smKey) continue
        for (const wst of g.workstations)
          for (const dr of wst.desc_rows)
            for (const iso of Object.keys(dr.cells)) allDates.push(iso)
      }
      allDates.sort()
      const firstIso = allDates[0] ?? null

      const trEl = findLocoRow(doc)
      if (!trEl) {
        if (attempt < 30) {
          window.setTimeout(() => scrollToLoco(attempt + 1), 80)
        } else if (firstIso) {
          const dateEl = doc.getElementById(`gantt_date_${firstIso}`) as HTMLElement | null
          if (dateEl) {
            animateScrollTo(win, { left: _rectScrollTarget(dateEl, scrollEl, z, frozenW).left })
          }
        }
        return
      }

      const tdEl = (trEl.querySelector('td') as HTMLElement | null) ?? trEl
      const targetTop = _rectScrollTarget(tdEl, scrollEl, z, frozenW).top

      // Horizontal target — respect active hide filters: scroll to the LOCO's FIRST VISIBLE rendered
      // box (any of its rows), never to the full-dataset first iso, which can be a column hidden by
      // "Ocultar antes do início". Falls back to the iso scan only when no rendered box is found.
      const locoKey = `${linha ?? ''}||${modelWo ?? ''}||${taskName}||${String(startMs ?? '')}`
      const locoBox = _firstVisibleBoxInLoco(doc, locoKey, () => true)

      let targetLeft = scrollEl.scrollLeft
      if (locoBox) {
        targetLeft = _rectScrollTarget(locoBox, scrollEl, z, frozenW).left
      } else if (firstIso) {
        const dateEl = doc.getElementById(`gantt_date_${firstIso}`) as HTMLElement | null
        if (dateEl) targetLeft = _rectScrollTarget(dateEl, scrollEl, z, frozenW).left
      }
      animateScrollTo(win, { top: targetTop, left: targetLeft })
    }

    if (activeTab === 3) { scrollToLoco(0); return }
    pendingScrollRef.current = () => scrollToLoco(0)
    handleTabSwitch(3)
  }

  function handleWsClick(wo: string, taskName: string, ws: string, subarea?: string, linha?: string, startMs?: string) {
    if (!ganttBuiltRef.current) {
      setScheduleGateMsg('Volte na aba anterior, defina o período e carregue a aba Schedule.')
      return
    }
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_')
    const id    = `ws_${safe(linha ?? '')}_${safe(wo)}_${safe(taskName)}_${safe(startMs ?? '')}_${safe(ws)}_${safe(subarea ?? '')}`
    const colId = `wsc_${safe(linha ?? '')}_${safe(wo)}_${safe(taskName)}_${safe(startMs ?? '')}_${safe(ws)}_${safe(subarea ?? '')}`

    function _scrollToWsInIframe(attempt = 0) {
      const doc = getIframeDoc()
      if (!doc) {
        if (attempt < 30) window.setTimeout(() => _scrollToWsInIframe(attempt + 1), 80)
        return
      }
      const elDesc = doc.getElementById(id)    as HTMLElement | null
      const elCol  = doc.getElementById(colId) as HTMLElement | null
      // Collapsed LOCO: its workstation rows don't exist in the DOM (the tree emits only the
      // visible variant), so fall back to the LOCO's own anchor row. Safe against races: the
      // loco row and the ws rows come from the same tbody write, so if the loco row exists
      // the ws rows genuinely aren't there (not merely "not written yet").
      //
      // BOTH loco anchors are tried. `lcc_loco_` is the collapsed-LOCO variant; the WORK/FULL tree
      // emits `wsc_loco_` instead, so checking only the former left this function with nothing to
      // scroll to whenever the WS id missed in an expanded view — and a caller that got the ws or
      // subarea even slightly wrong (the normalized WS name, a blank subarea) then produced a click
      // that silently did nothing at all. A LOCO-level scroll is a far better failure mode.
      const locoSuffix = `${safe(linha ?? '')}_${safe(wo)}_${safe(taskName)}_${safe(startMs ?? '')}`
      const elLoco = (doc.getElementById(`lcc_loco_${locoSuffix}`)
        ?? doc.getElementById(`wsc_loco_${locoSuffix}`)) as HTMLElement | null
      const target = (elCol && elCol.getBoundingClientRect().height > 0 ? elCol : null) ?? elDesc ?? elLoco
      if (!target) {
        if (attempt < 30) window.setTimeout(() => _scrollToWsInIframe(attempt + 1), 80)
        return
      }

      // Prefer the workstation's CURRENT rendered start (stamped on the row by the worker), so after a
      // duration/Takt edit moves the workstation we scroll to its NEW horizontal position. The
      // effectiveData scan holds the ORIGINAL cells and is only a fallback when the attribute is absent.
      const sourceGroups = effectiveData?.groups ?? []
      const smKey = (startMs != null && startMs !== '') ? String(startMs).slice(0, 10) : null
      const allDates: string[] = []
      for (const g of sourceGroups) {
        if (g.wo !== wo || g.task_name !== taskName) continue
        if (linha != null && linha !== '' && g.linha !== linha) continue
        if (smKey && g.start_ms != null && g.start_ms !== '' && String(g.start_ms).slice(0, 10) !== smKey) continue
        const matchedWst = g.workstations.find(w => w.ws === ws && (subarea == null || subarea === '' || (w.subarea ?? '') === subarea))
        if (!matchedWst) continue
        for (const dr of matchedWst.desc_rows)
          for (const iso of Object.keys(dr.cells)) allDates.push(iso)
      }
      allDates.sort()

      const win = doc.defaultView
      if (!win) return
      const scrollEl = (doc.scrollingElement ?? doc.documentElement) as HTMLElement

      const targetTop = _rectScrollTarget(target, scrollEl, z, frozenW).top

      // Horizontal target — respect active hide filters. Prefer the workstation's FIRST VISIBLE
      // rendered box in the DOM: with "Ocultar antes do início" a WS keeps pre-start columns that
      // other LOCOs still occupy, so a full-dataset iso scan (or a data-start-iso stamped from
      // untrimmed cells) would land on a column where THIS ws's box is hidden — empty space. The
      // rendered box can't be hidden, so it always lands on visible content. Falls back to the
      // collapsed-LOCO summary row's first visible box, then to the iso scan (races / no filters).
      const locoKey = `${linha ?? ''}||${wo}||${taskName}||${startMs ?? ''}`
      const wsBox = _firstVisibleBoxInLoco(doc, locoKey, ds =>
        (ds.rowEdit === 'ws' || ds.rowEdit === 'desc')
          ? (ds.ws === ws && (subarea == null || subarea === '' || (ds.subarea ?? '') === subarea))
          : true)   // collapsed-LOCO summary row (no data-row-edit) → its aggregated boxes

      let targetLeft = scrollEl.scrollLeft
      if (wsBox) {
        targetLeft = _rectScrollTarget(wsBox, scrollEl, z, frozenW).left
      } else {
        const domStartIso = target.dataset.startIso
        const firstIso = (domStartIso && domStartIso.length >= 10) ? domStartIso : (allDates[0] ?? null)
        const dateEl = firstIso ? (doc.getElementById(`gantt_date_${firstIso}`) as HTMLElement | null) : null
        if (dateEl) targetLeft = _rectScrollTarget(dateEl, scrollEl, z, frozenW).left
      }
      animateScrollTo(win, { top: targetTop, left: targetLeft })
    }

    if (activeTab === 3) { _scrollToWsInIframe(0); return }
    pendingScrollRef.current = () => _scrollToWsInIframe(0)
    handleTabSwitch(3)
  }

  /**
   * Scroll the Schedule horizontally so the clicked DAY column lands just right of the frozen
   * block — the SAME engine, coordinate space and target element the workstation navigation uses
   * (it already scrolls to `gantt_date_<iso>` via `_rectScrollTarget().left`), so it stays accurate
   * at any zoom, view mode, virtualization or scroll state. Smooth, like the workstation experience.
   * Retries while the iframe finishes writing; if we somehow land here off the Schedule tab, it
   * defers through the same pending-scroll + tab-switch path as the workstation/LOCO handlers.
   */
  function handleDayClick(iso: string) {
    if (!iso) return
    if (!ganttBuiltRef.current) {
      setScheduleGateMsg('Volte na aba anterior, defina o período e carregue a aba Schedule.')
      return
    }
    function scrollToDay(attempt = 0) {
      const doc = getIframeDoc()
      if (!doc) {
        if (attempt < 30) window.setTimeout(() => scrollToDay(attempt + 1), 80)
        return
      }
      const win = doc.defaultView
      if (!win) return
      const scrollEl = (doc.scrollingElement ?? doc.documentElement) as HTMLElement
      const dateEl = doc.getElementById(`gantt_date_${iso}`) as HTMLElement | null
      if (!dateEl) {
        if (attempt < 30) window.setTimeout(() => scrollToDay(attempt + 1), 80)
        return
      }
      // Horizontal target: the day column, just right of the frozen block (same as WS/today nav).
      const left = _rectScrollTarget(dateEl, scrollEl, z, frozenW).left
      // Vertical target — the plotted box the view should center on, chosen by priority:
      //   1) the NEAREST rendered box in this day's column whose plotted hours are > 0
      //      (`data-hh`, stamped by the worker on every FULL/WORK/LOCO day box);
      //   2) fallback: the nearest rendered box even if its hours are 0.
      // "Nearest" = smallest vertical distance from the current viewport center, so the
      // displacement is minimal. Candidate collection, validity checks (rendered, height
      // > 0) and the `_rectScrollTarget().top` scroll engine are unchanged.
      let candidates = Array.from(doc.querySelectorAll(`td.gbx[data-iso="${iso}"]`)) as HTMLElement[]
      if (candidates.length === 0) {
        candidates = (Array.from(doc.querySelectorAll(`td[data-iso="${iso}"]`)) as HTMLElement[])
          .filter(el => (el.textContent ?? '').trim().length > 0)
      }
      const hhOf = (el: HTMLElement): number => {
        const raw = el.dataset.hh
        if (raw != null && raw !== '') {
          const n = Number(raw.replace(',', '.'))
          if (Number.isFinite(n)) return n
        }
        // Markup without data-hh (stale iframe HTML): parse the rendered "X.Xh" text.
        const m = (el.textContent ?? '').match(/(\d+(?:[.,]\d+)?)\s*h\b/i)
        return m ? Number(m[1].replace(',', '.')) : 0
      }
      const viewportCenter = scrollEl.clientHeight / 2
      const nearest = (els: HTMLElement[]): HTMLElement | null => {
        let best: HTMLElement | null = null
        let bestDist = Infinity
        for (const el of els) {
          const r = el.getBoundingClientRect()
          if (r.height <= 0) continue         // skip collapsed/hidden cells
          const dist = Math.abs(r.top + r.height / 2 - viewportCenter)
          if (dist < bestDist) { bestDist = dist; best = el }
        }
        return best
      }
      const targetBox = nearest(candidates.filter(el => hhOf(el) > 0)) ?? nearest(candidates)
      const top = targetBox ? _rectScrollTarget(targetBox, scrollEl, z, frozenW).top : scrollEl.scrollTop
      animateScrollTo(win, { left, top })
    }
    if (activeTab === 3) { scrollToDay(0); return }
    pendingScrollRef.current = () => scrollToDay(0)
    handleTabSwitch(3)
  }

  /**
   * Scroll the Gantt horizontally so TODAY's column is just right of the frozen
   * column. No-op if today is outside the rendered range (the date header won't
   * exist). Retries while the iframe finishes writing. Smooth by default; pass
   * behavior:'auto' for the initial jump so it lands instantly on open.
   */
  function scrollToToday(behavior: ScrollBehavior = 'auto', attempt = 0) {
    const d = new Date()
    const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const doc = getIframeDoc()
    if (!doc) {
      if (attempt < 30) window.setTimeout(() => scrollToToday(behavior, attempt + 1), 80)
      return
    }
    const win = doc.defaultView
    if (!win) return
    const scrollEl = (doc.scrollingElement ?? doc.documentElement) as HTMLElement
    const dateEl = doc.getElementById(`gantt_date_${todayIso}`) as HTMLElement | null
    if (!dateEl) {
      // Header not written yet, or today is out of range. Retry a few times then give up.
      if (attempt < 20) window.setTimeout(() => scrollToToday(behavior, attempt + 1), 80)
      return
    }
    win.scrollTo({ left: _rectScrollTarget(dateEl, scrollEl, z, frozenW).left, behavior })
  }

  /**
   * Initial open scroll: horizontally to TODAY (same target as scrollToToday) AND vertically to
   * the FIRST row that carries schedule activity — the topmost rendered day box with plotted
   * hours (`data-hh` > 0, stamped by the worker on every FULL/WORK/LOCO day box). The row is
   * parked just below the sticky header (26px banner + 56px date header = 82 CSS px, scaled by
   * zoom) so it reads like the first work item is already selected. Retries while the iframe
   * finishes writing; if no activity box is ever found it still applies the horizontal jump.
   */
  function scrollInitial(attempt = 0) {
    const d = new Date()
    const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const doc = getIframeDoc()
    if (!doc) {
      if (attempt < 30) window.setTimeout(() => scrollInitial(attempt + 1), 80)
      return
    }
    const win = doc.defaultView
    if (!win) return
    const scrollEl = (doc.scrollingElement ?? doc.documentElement) as HTMLElement

    // Topmost rendered day box with hours > 0 (any view mode carries data-hh). `anyLaidOut` tracks
    // whether the grid is measurable yet at all — used to distinguish "DOM not ready, retry" from
    // "rendered, but genuinely no activity (nothing to scroll to)".
    // Topmost VISIBLE day box with plotted hours (data-hh > 0). Per the spec, hours are the ONLY
    // vertical trigger — a zero-hour day (e.g. Protection-Days buffer) is never a scroll target; if
    // the schedule has no hours at all we fall back to a horizontal-only jump below.
    const boxes = Array.from(doc.querySelectorAll('td[data-hh]')) as HTMLElement[]
    let firstBox: HTMLElement | null = null
    let bestAbsTop = Infinity
    let anyLaidOut = false
    for (const el of boxes) {
      const r = el.getBoundingClientRect()
      if (r.height <= 0) continue                 // skip collapsed/hidden cells
      anyLaidOut = true
      const raw = el.dataset.hh
      const hh = raw != null && raw !== '' ? Number(raw.replace(',', '.')) : 0
      if (!(hh > 0)) continue
      const absTop = scrollEl.scrollTop + r.top    // absolute document position
      if (absTop < bestAbsTop) { bestAbsTop = absTop; firstBox = el }
    }

    const dateEl = doc.getElementById(`gantt_date_${todayIso}`) as HTMLElement | null
    // Nothing measurable yet (grid still being written/laid out, and today's header absent) → retry.
    if (!anyLaidOut && !dateEl) {
      if (attempt < 30) window.setTimeout(() => scrollInitial(attempt + 1), 80)
      return
    }

    const left = dateEl ? _rectScrollTarget(dateEl, scrollEl, z, frozenW).left : scrollEl.scrollLeft
    if (!firstBox) {
      // Apply the horizontal jump now. No hours box was found. This is EITHER (a) the hours cells
      // just haven't laid out this frame — even though some box already measured (anyLaidOut) — OR
      // (b) the schedule genuinely has no plotted hours. Distinguishing them statically isn't
      // reliable (the earlier "vertical never moves" bug was giving up here too soon), so keep
      // retrying a bounded number of extra frames for an hours box before settling on horizontal-only.
      win.scrollTo({ left, top: scrollEl.scrollTop, behavior: 'auto' })
      if (attempt < 12) window.setTimeout(() => scrollInitial(attempt + 1), 80)
      return
    }
    // Park the first-activity row just under the sticky header rather than centering it, so rows
    // above it aren't scrolled off unnecessarily on open.
    const HEADER_H = 82
    const r = firstBox.getBoundingClientRect()
    const top = Math.max(0, scrollEl.scrollTop + r.top - HEADER_H * z)
    win.scrollTo({ left, top, behavior: 'auto' })
    // Re-assert on the next couple of frames. The vertical position otherwise "doesn't stick":
    // a late reflow (fonts/zoom settling after the iframe write) or the build-finalize horizontal
    // scroll can reset scrollTop between this call and paint. Re-entry recomputes `top` from the
    // box's CURRENT rect, so the target stays correct even if layout shifted; bounded to 2 frames
    // (idempotent — a stable layout re-applies the same position, so it's a no-op once settled).
    if (attempt < 2) win.requestAnimationFrame(() => scrollInitial(attempt + 1))
  }

  return { handleLocoClick, handleWsClick, scrollToToday, scrollInitial, handleDayClick }
}
