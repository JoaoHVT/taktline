'use client'
// ── Move-description bubble ──────────────────────────────────────────────────────────────────
// Opened by clicking the note indicator on a moved box (the indicator itself is drawn by the
// worker — see moveNoteBadge in gantt-table-worker.js). Shows that box's reason trail, newest
// first, so a reader can see WHY the box drifted and who moved it.
//
// The hover tooltip already previews the latest reason for free (a native `title` on the badge);
// this bubble is the full history, and only mounts once someone actually asks for it.
//
// Entries are also EDITABLE in place (pencil → Categoria + Observação → Salvar). Correcting a
// misclassification or a typo used to mean moving the box again, which wrote a new shift and
// appended a second trail entry just to fix the first one. Editing here is metadata-only: the
// parent's updateMoveNote rewrites the stored note and cannot touch a date (see the note there).
// The affordance is gated by `canEdit` — Editor+ and not the read-only 'Original' reference mode.
import { useEffect, useRef, useState } from 'react'
import { MessageSquareText, X, Pencil, Check, ChevronDown } from 'lucide-react'
import { RED, RED_LT } from '@/lib/ganttUtils'
import { MOVE_NOTE_MAX_LEN, MOVE_CATEGORIES, RECOVERY_PLAN_CATEGORY, type MoveNote } from '@/lib/locoOverrides'

const W = 264   // bubble width; kept in sync with the clamp below

/** "há 3 dias" style is overkill here — an absolute short date reads better in a schedule. */
function fmtWhen(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })
}

export function MoveNotePopover({ notes, title, x, y, canEdit = false, onEdit, onClose }: {
  notes: MoveNote[]
  title: string              // the box this trail belongs to, e.g. "WS11-Handrail"
  x: number; y: number       // anchor point in PARENT viewport coords (badge's top-right)
  canEdit?: boolean          // may the viewer rewrite an entry? (Editor+ and not read-only)
  onEdit?: (index: number, category: string | null, text: string) => void   // index into `notes`
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Index (into `notes`) of the entry being edited, plus its working values. null = nobody editing.
  const [editing, setEditing] = useState<number | null>(null)
  const [draftCat, setDraftCat] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [catOpen, setCatOpen] = useState(false)

  // Esc closes. (Outside clicks are handled by the transparent catcher below, which also covers
  // the iframe — clicks inside it never reach a parent-document listener.)
  // While an entry is open for editing Esc backs out of the EDITOR first, so a stray Esc can't
  // discard the bubble and the in-progress correction in one keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (editing !== null) { setEditing(null); setCatOpen(false); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  // Clamp into the viewport so a badge near an edge still shows the whole bubble.
  const left = Math.max(8, Math.min(x + 8, (typeof window !== 'undefined' ? window.innerWidth : 1920) - W - 8))
  const top  = Math.max(8, y - 8)

  const ordered = notes.map((n, i) => ({ n, i })).reverse()   // newest first; `i` = index in `notes`

  function beginEdit(index: number) {
    setEditing(index)
    setDraftCat(notes[index].category ?? null)
    setDraftText(notes[index].text ?? '')
    setCatOpen(false)
  }
  function commitEdit() {
    if (editing === null) return
    // Same rule as applyMoveNote: an entry with neither classification nor observation carries no
    // information, so an empty-empty save is refused rather than silently blanking the card.
    if (!draftCat && !draftText.trim()) return
    onEdit?.(editing, draftCat, draftText)
    setEditing(null)
    setCatOpen(false)
  }

  // 'Recovery Plan' stays selectable only where it is already the entry's classification: it means a
  // move REDUCED a delay, which is a property of the move, not something a later correction can
  // assert. Same reasoning as the prompt's availableCategories filter.
  const categoriesFor = (current: string | null) =>
    MOVE_CATEGORIES.filter(c => c !== RECOVERY_PLAN_CATEGORY || current === RECOVERY_PLAN_CATEGORY)

  return (
    <>
      <div className="fixed inset-0 z-[9998]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        ref={ref}
        className="fixed z-[9999] rounded-xl border border-gray-200/80 shadow-2xl overflow-hidden backdrop-blur-md"
        style={{ left, top, width: W, background: 'rgba(255,255,255,0.94)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-200/70" style={{ background: 'rgba(249,250,251,0.8)' }}>
          <MessageSquareText size={12} className="shrink-0" style={{ color: RED }} />
          <span className="text-[11px] font-bold text-black truncate flex-1" title={title}>{title}</span>
          {ordered.length > 1 && (
            <span className="text-[9px] font-semibold text-gray-500 shrink-0">{ordered.length} registros</span>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 shrink-0" aria-label="Fechar">
            <X size={12} />
          </button>
        </div>
        {/* overflow-y stays auto for the trail, but an open Categoria list needs to escape the row —
            it is rendered INLINE (pushing the rows below) rather than floating, so the bubble never
            has to trade its scrolling for the dropdown. */}
        <div className="max-h-[220px] overflow-y-auto px-3 py-2 flex flex-col gap-2">
          {ordered.map(({ n, i }, pos) => {
            const isEditing = editing === i
            return (
              <div
                key={`${n.at}-${i}`}
                className="pl-2 border-l-2 group"
                style={{ borderColor: pos === 0 ? RED : '#E5E7EB' }}
              >
                {isEditing ? (
                  <>
                    {/* Categoria — same chip-and-list language as the post-move prompt. */}
                    <div style={{ position: 'relative', userSelect: 'none' }} className="mb-1">
                      <button
                        type="button"
                        onClick={() => setCatOpen(v => !v)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', width: '100%',
                          borderRadius: 6, border: `1.5px solid ${draftCat ? RED : '#D1D5DB'}`,
                          background: draftCat ? RED_LT : '#F9FAFB', cursor: 'pointer',
                          fontSize: 10, fontWeight: 700, color: draftCat ? RED : '#9CA3AF',
                        }}
                      >
                        {draftCat ?? 'Sem categoria'}
                        <ChevronDown size={10} style={{ marginLeft: 'auto', transform: catOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                      </button>
                      {catOpen && (
                        <div className="mt-1 rounded-md border bg-white" style={{ borderColor: `${RED}33` }}>
                          {categoriesFor(n.category ?? null).map(cat => {
                            const on = draftCat === cat
                            return (
                              <button
                                key={cat}
                                type="button"
                                // Clicking the active row clears it: an observation-only note is legal
                                // (the trail keeps the entry while either field survives).
                                onClick={() => { setDraftCat(on ? null : cat); setCatOpen(false) }}
                                style={{
                                  display: 'block', width: '100%', padding: '3px 10px', textAlign: 'left',
                                  background: on ? RED_LT : 'transparent', border: 'none', cursor: 'pointer',
                                  fontSize: 10, fontWeight: on ? 700 : 400, color: on ? RED : '#374151',
                                }}
                              >
                                {cat}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    <input
                      type="text"
                      value={draftText}
                      maxLength={MOVE_NOTE_MAX_LEN}
                      onChange={e => setDraftText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit() } }}
                      placeholder="Observação"
                      autoFocus
                      autoComplete="off"
                      className="w-full border border-gray-300 rounded-md px-1.5 py-1 text-[11px] text-black placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#0D9488] focus:border-[#0D9488]"
                    />
                    <div className="mt-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={commitEdit}
                        disabled={!draftCat && !draftText.trim()}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-white disabled:opacity-40"
                        style={{ background: RED }}
                      >
                        <Check size={10} /> Salvar
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditing(null); setCatOpen(false) }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200"
                      >
                        Cancelar
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-1">
                      <div className="flex-1 min-w-0">
                        {/* Mandatory classification chip (absent on legacy notes saved before categories). */}
                        {n.category && (
                          <span
                            className="inline-block mb-0.5 px-1.5 py-[1px] rounded border text-[9px] font-bold uppercase tracking-wide"
                            style={{ borderColor: `${RED}55`, color: RED, background: '#F0FDFA' }}
                          >
                            {n.category}
                          </span>
                        )}
                        {n.text && <p className="text-[11px] leading-snug text-black break-words">{n.text}</p>}
                      </div>
                      {canEdit && onEdit && (
                        <button
                          type="button"
                          onClick={() => beginEdit(i)}
                          title="Editar categoria/observação (não move a barra)"
                          aria-label="Editar este registro"
                          className="shrink-0 p-0.5 rounded text-gray-300 hover:text-gray-700 hover:bg-gray-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 text-[9px] text-gray-500 truncate">
                      {[n.by, fmtWhen(n.at)].filter(Boolean).join(' · ')}
                    </p>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
