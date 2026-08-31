'use client'
// ── Post-move prompt: "why?" + "propagate?" ──────────────────────────────────────────────────
// Shown once a Move Mode operation is committed (Enter). Three things in one small centered card,
// each on its own dedicated row (no dead space between them):
//   • Categoria — a MANDATORY reason classification (exactly one of MOVE_CATEGORIES), picked
//     from a full-width dropdown. The move cannot be saved (Sim/Não stay blocked) until one
//     is chosen.
//   • Observação — an optional free-text note for the move, stored as history on the moved box
//     (see MoveNote in lib/locoOverrides). "Override" flips this save from APPEND (keep the trail)
//     to REPLACE (only the latest reason survives).
//   • Propagar efeitos? — footer row: the question on the same line as its Sim/Não answers,
//     pre-existing meaning unchanged.
//
// Self-contained for the same reason as SavePasswordModal: the observation text lives HERE, so
// typing re-renders only this card and never the (heavy) GanttModal.
//
// The card is MODAL and closes only on an explicit choice: Sim / Não / X (cancel) / Esc (= X).
// An outside click is inert BY DESIGN — it used to resolve as "Não", which unmounted the overlay on
// mousedown and let the following click land on the Schedule backdrop (GanttModal's `e.target ===
// e.currentTarget` close), taking the whole Schedule window down with it.
import { useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react'
import { ChevronDown, MessageSquarePlus, Tags, History, Repeat, Pin, X } from 'lucide-react'
import { RED, RED_LT } from '@/lib/ganttUtils'
import { MOVE_NOTE_MAX_LEN, MOVE_CATEGORIES, RECOVERY_PLAN_CATEGORY, RECOVERY_PLAN_AUTO_NOTE, type MoveNote, type MoveCategory } from '@/lib/locoOverrides'
import { GlobalPropOptionsButton } from './GlobalPropOptionsButton'
import { getMoveNoteMemory, setMoveNoteMemory, rememberMoveNote, subscribeMoveNoteMemory } from '@/lib/moveNoteMemory'

export type MoveNoteMode = 'append' | 'override'

// Propagation choice for a committed move:
//   • 'no'     — move the edited row(s) alone (no cascade).
//   • 'local'  — the pre-existing "Sim": cascade WITHIN the edited locomotive only.
//   • 'global' — Local, PLUS ripple the delay/recovery through the subsequent locomotives that use
//                the SAME workstation (PD-bounded). Same Type / same line, except WS40+WS50 which
//                cross both as one shared resource. See GanttModal.runGlobalCascade.
export type PropagateMode = 'no' | 'local' | 'global'

export function MoveNotePrompt({ prevNotes, rowCount, recovery = false, propagating = false, propagationDisabled = false, onResolve, onCancel }: {
  prevNotes: MoveNote[]          // the trail already on the moved box (may be empty)
  rowCount: number               // rows in the committed selection (for the subtitle)
  propagationDisabled?: boolean  // post-PD selection: hide the propagation controls entirely and save
                                 // with a single "Confirmar" that resolves as "Não" — a post-PD station
                                 // is manual-only and must never cascade (see GanttModal.isPostPdTarget)
  propagating?: boolean          // the row was ALREADY cascading before this move — "Não" declines to
                                 // add propagation, it does not revoke what is already there (a move
                                 // is not the place to silently un-cascade earlier work; use the edit
                                 // panel). Only relabels the button, never changes the answer sent.
  recovery?: boolean             // the move reduces an existing delay → pre-fill "Recovery Plan" and
                                 // make the category OPTIONAL (the user may confirm, edit, or clear it)
  onResolve: (propagate: PropagateMode, text: string, mode: MoveNoteMode, category: MoveCategory | null, parallelStarts: boolean, removeGaps: boolean) => void
  onCancel: () => void           // X / Esc — undo the move entirely, keeping nothing
}) {
  // ── Last-observation reuse ────────────────────────────────────────────────────────────────────
  // Editing the same box repeatedly almost always repeats the same classification/observation, so the
  // prompt opens pre-filled with the LATEST entry of this box's own trail (`prevNotes` is the anchor
  // row's trail, newest LAST). Only ever a starting point: both fields stay fully editable, and an
  // empty trail leaves them blank exactly as before.
  //
  // Two categories are deliberately NOT reused, because neither is user-selectable in this state and
  // reusing one would pre-fill a value the dropdown cannot show or re-pick:
  //   • 'Manual Swap'   — system-authored by the WS40↔WS50 swap; never in MOVE_CATEGORIES.
  //   • 'Recovery Plan' — only offered on a recovery move (see availableCategories below), so on a
  //                       delay-CREATING move it must not carry over from an earlier recovery.
  const lastNote = prevNotes.length ? prevNotes[prevNotes.length - 1] : null
  // ── "Lembrar" — cross-box session memory (lib/moveNoteMemory) ─────────────────────────────────
  // With the toggle on, the prompt opens with the values the LAST move was confirmed with, whatever
  // box that was, so a run of moves sharing one reason needs no re-picking. Read once per mount and
  // used only for the initial state: the fields stay fully editable afterwards, and re-ticking the
  // toggle mid-prompt must not overwrite what the planner is currently typing.
  const memory = useSyncExternalStore(subscribeMoveNoteMemory, getMoveNoteMemory, getMoveNoteMemory)
  const [remember, setRemember] = useState(memory.enabled)
  const [initialMemory] = useState(memory)
  const memCategory: MoveCategory | null = initialMemory.enabled && initialMemory.category
    && (MOVE_CATEGORIES as readonly string[]).includes(initialMemory.category)
    && (initialMemory.category !== RECOVERY_PLAN_CATEGORY || recovery)
      ? initialMemory.category as MoveCategory
      : null
  const reusableCategory: MoveCategory | null = (() => {
    const cat = lastNote?.category
    if (!cat) return null
    if (cat === RECOVERY_PLAN_CATEGORY) return recovery ? RECOVERY_PLAN_CATEGORY : null
    return (MOVE_CATEGORIES as readonly string[]).includes(cat) ? cat as MoveCategory : null
  })()
  // A recovery move keeps its auto-classification precedence: the detected "Recovery Plan" wins over
  // whatever the box was last classified as, since it describes THIS move, not the previous one.
  // Otherwise the remembered value wins over the box's own trail — it is the more recent decision.
  const [category, setCategory] = useState<MoveCategory | null>(
    recovery ? RECOVERY_PLAN_CATEGORY : (memCategory ?? reusableCategory),
  )
  const [missingCat, setMissingCat] = useState(false)   // a save was attempted without a category
  // Categoria dropdown open state + anchor. Outside-click closing is wired through the card's
  // own onMouseDown (and the backdrop's swallow) because both stopPropagation — a document-level
  // listener (the FilterBox pattern) would never hear those clicks.
  const [catOpen, setCatOpen] = useState(false)
  const catRef = useRef<HTMLDivElement>(null)
  const closeCatIfOutside = (e: SyntheticEvent) => {
    if (catOpen && catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false)
  }
  // Same reuse for the observation. The auto-note only ever describes an auto-detected recovery, so it
  // is never carried forward as a "last observation" on an ordinary move.
  const lastText = lastNote && lastNote.text !== RECOVERY_PLAN_AUTO_NOTE ? lastNote.text : ''
  const memText = initialMemory.enabled ? initialMemory.text : ''
  const [text, setText] = useState(recovery ? RECOVERY_PLAN_AUTO_NOTE : (memText || lastText))
  const [override, setOverride] = useState(false)
  // "Propagar inícios paralelos" — default ON (see ScopedEdit.parallelStarts). Only relevant when the
  // answer is Local/Global; it rides along on "Não" too and is simply never read there.
  const [parallelStarts, setParallelStarts] = useState(true)
  // "Remover gaps futuros" — default OFF (see ScopedEdit.removeGaps). Qualifies the same Local/Global
  // answers as the option above: with it on, the cascade CONSUMES the idle days downstream (each
  // station packs in right after its predecessor) instead of carrying the gaps along.
  const [removeGaps, setRemoveGaps] = useState(false)
  // "Recovery Plan" is ONLY meaningful when the move reduces an existing delay: on a recovery move it
  // is auto-classified (and stays listed so the user can re-pick it after clearing). On a delay-CREATING
  // (or otherwise non-recovery) move it must NOT be offered — you can't file a recovery plan for a delay
  // you are causing. So it is dropped from the selectable list unless this is a recovery move.
  const availableCategories = recovery
    ? MOVE_CATEGORIES
    : MOVE_CATEGORIES.filter(cat => cat !== RECOVERY_PLAN_CATEGORY)
  const [sent, setSent] = useState(false)
  const prevCount = prevNotes.length
  // What the save will do with the existing trail (append / replace / which row carries it). Empty
  // when there is nothing to say, and then not rendered at all.
  const noteHint = override && prevCount > 0
    ? `Substitui ${prevCount === 1 ? 'o registro anterior' : `os ${prevCount} registros anteriores`}.`
    : prevCount > 0
      ? `Adiciona ao histórico (${prevCount} ${prevCount === 1 ? 'anterior' : 'anteriores'}).`
      : rowCount > 1 ? `Registrada na primeira das ${rowCount} linhas movidas.` : ''

  // Single exit point for the two ANSWERS (Sim / Não); both keep the typed observation.
  // The category is MANDATORY except on a recovery move, where it is optional (and pre-filled): a
  // non-recovery attempt without a category only lights up the Categoria row.
  function resolve(propagate: PropagateMode) {
    if (sent) return
    if (!category && !recovery) { setMissingCat(true); return }
    setSent(true)
    // Record what this move was actually CONFIRMED with, so the next prompt can reuse it. Written
    // here (not on every keystroke) so an abandoned edit never becomes the remembered value; the
    // store itself no-ops while the toggle is off.
    rememberMoveNote(category, text)
    onResolve(propagate, text, override ? 'override' : 'append', category, parallelStarts, removeGaps)
  }

  // X / Esc — the move is undone, so the classification/observation describe nothing and are
  // dropped with it.
  function cancel() {
    if (sent) return
    setSent(true)
    onCancel()
  }

  // Swallow every stray pointer event: inert here, and never relayed to the Schedule modal beneath.
  // A backdrop press also folds the Categoria dropdown, mirroring outside-click behavior.
  const swallow = (e: SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); if (catOpen) setCatOpen(false) }

  return (
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={swallow}
        onClick={swallow}
        onContextMenu={swallow}
      />
      {/* overflow must stay VISIBLE so the Categoria dropdown can float past the card edge;
          the footer carries its own rounded-b to keep the corners clean. */}
      <div
        // 380px, not the original 320: the Categoria dropdown spans the card, and the card had to be
        // wide enough for the footer's "Propagar efeitos?" + Não · Local · Global(+arrow badge) to sit
        // on ONE row (~335px of content). At 320 that row wrapped and the arrow hung outside the card.
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] w-[380px] rounded-xl bg-white shadow-2xl border border-gray-200"
        onMouseDown={(e) => { e.stopPropagation(); closeCatIfOutside(e) }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() } }}
      >
        <div className="px-4 pt-3 pb-3 flex flex-col gap-1">
          {/* ── Categoria (mandatory, exactly one) — dedicated row: label + full-width dropdown ── */}
          <div className="flex items-center justify-between gap-2">
            <span
              className="flex items-center gap-1.5 text-[12px] font-semibold"
              style={{ color: missingCat && !category && !recovery ? RED : '#000' }}
            >
              <Tags size={13} className="shrink-0" style={{ color: RED }} />
              Categoria
              <span className="text-[10px] font-semibold" style={{ color: missingCat && !category && !recovery ? RED : '#9CA3AF' }}>
                {recovery
                  ? 'plano de recuperação · opcional'
                  : missingCat && !category ? 'obrigatória — selecione uma' : 'obrigatória'}
              </span>
            </span>
            <button
              type="button"
              onClick={cancel}
              disabled={sent}
              title="Cancelar o movimento"
              aria-label="Cancelar o movimento"
              className="-mr-1 -mt-0.5 p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
            >
              <X size={14} />
            </button>
          </div>
          {/* Full-width single-select dropdown in the application's filter visual language
              (FilterBox): chip-style trigger with rotating chevron, floating list with
              red-accented active row. Red accent once chosen; red border on a blocked save. */}
          <div ref={catRef} style={{ position: 'relative', userSelect: 'none' }}>
            <button
              type="button"
              onClick={() => setCatOpen(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', width: '100%',
                borderRadius: 8, border: `1.5px solid ${category ? RED : (missingCat && !recovery) ? RED : '#D1D5DB'}`,
                background: category ? RED_LT : '#F9FAFB', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, color: category ? RED : '#9CA3AF', whiteSpace: 'nowrap',
              }}
            >
              {category ?? 'Selecione uma categoria…'}
              <ChevronDown size={12} style={{ marginLeft: 'auto', color: category ? RED : '#9CA3AF', transform: catOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
            </button>
            {catOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
                background: '#fff', border: `1px solid ${RED}33`, borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', padding: '6px 0',
              }}>
                {availableCategories.map(cat => {
                  const on = category === cat
                  return (
                    <button
                      key={cat}
                      type="button"
                      // On a recovery move the category is optional, so clicking the active row
                      // clears it (lets the user "continue without anything"); otherwise it selects.
                      onClick={() => { setCategory(recovery && on ? null : cat); setMissingCat(false); setCatOpen(false) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '5px 14px', background: on ? RED_LT : 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                        fontSize: 11, fontWeight: on ? 700 : 400, color: on ? RED : '#374151',
                      }}
                    >
                      {cat}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Recovery hint: this move reduces an existing delay, so it was auto-classified. */}
          {recovery && (
            <p className="text-[10px] leading-tight mt-0.5" style={{ color: '#059669' }}>
              Recuperação de atraso detectada — “Recovery Plan” pré-preenchido. Edite ou remova antes de confirmar.
            </p>
          )}

          {/* ── Observação (optional free text — the pre-existing description field) ── */}
          <div className="flex items-center justify-between gap-2 mt-1.5">
            <label htmlFor="move-note-input" className="flex items-center gap-1.5 text-[12px] font-semibold text-black">
              <MessageSquarePlus size={13} className="shrink-0" style={{ color: RED }} />
              Observação
              <span className="text-[10px] font-semibold text-gray-400">opcional</span>
            </label>
            {/* "Lembrar" — reuse this move's Categoria + Observação on the NEXT prompt, for any box
                (lib/moveNoteMemory). Toggling it does not touch what is on screen now: it decides
                whether the values confirmed here are carried forward, and whether the next prompt
                opens pre-filled from them. Session-only. */}
            <button
              type="button"
              onClick={() => { const next = !remember; setRemember(next); setMoveNoteMemory({ enabled: next }) }}
              disabled={sent}
              title={remember
                ? 'Lembrar ativo — a categoria e a observação confirmadas aqui serão pré-preenchidas no próximo movimento'
                : 'Lembrar a última categoria e observação e pré-preencher o próximo movimento com elas'}
              aria-pressed={remember}
              className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold transition-colors disabled:opacity-40"
              style={remember
                ? { background: RED, borderColor: RED, color: '#FFF' }
                : { background: '#F9FAFB', borderColor: '#E5E7EB', color: '#6B7280' }}
            >
              <Pin size={10} />
              Lembrar
            </button>
            {prevCount > 0 && (
              <button
                type="button"
                onClick={() => setOverride(v => !v)}
                title={override
                  ? `Substitui ${prevCount === 1 ? 'o registro anterior' : `os ${prevCount} registros anteriores`}`
                  : 'Manter o histórico e adicionar este registro'}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold transition-colors"
                style={override
                  ? { background: RED, borderColor: RED, color: '#FFF' }
                  : { background: '#F9FAFB', borderColor: '#E5E7EB', color: '#6B7280' }}
              >
                {override ? <Repeat size={10} /> : <History size={10} />}
                {override ? 'Override' : `${prevCount}`}
              </button>
            )}
          </div>

          <input
            id="move-note-input"
            type="text"
            value={text}
            maxLength={MOVE_NOTE_MAX_LEN}
            onChange={e => setText(e.target.value)}
            // Enter resolves as "Não" — the same key that committed the move, and the same answer
            // the old prompt gave it (its "Não" button was the autofocused default). The move and
            // the observation are saved either way; only propagation is declined. Without a
            // category the attempt is blocked inside resolve() and only lights up the Categoria row.
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolve('no') } }}
            placeholder="Por que este movimento?"
            autoFocus
            autoComplete="off"
            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-[12px] text-black placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#D32F2F] focus:border-[#D32F2F]"
          />

          {/* History hint. Rendered ONLY when it says something: it used to reserve `min-h-[13px]`
              plus the column's own gap even when empty (the common case — no earlier note, single
              row), which read as dead space hanging under the Observação field. */}
          {noteHint && (
            <p className="text-[10px] leading-tight text-gray-500">{noteHint}</p>
          )}
        </div>

        {/* Post-PD station: no propagation is possible — it is anchored past the buffer. Replace the whole
            "Propagar efeitos?" block with a single Confirmar that saves the manual edit (resolves "Não"). */}
        {propagationDisabled ? (
          <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-gray-50 rounded-b-xl border-t border-gray-100">
            <span className="text-[10px] leading-tight text-gray-500 min-w-0 flex-1">Pós-Dias de Proteção · sem propagação</span>
            <button
              className="px-3 py-1 rounded text-[12px] font-semibold text-white disabled:opacity-50 shrink-0"
              style={{ background: RED, opacity: !category && !recovery ? 0.55 : undefined }}
              disabled={sent}
              title={!category && !recovery ? 'Selecione uma categoria primeiro' : 'Salvar o movimento manual'}
              onClick={() => resolve('no')}
            >
              Confirmar
            </button>
          </div>
        ) : (
        <>
        {/* ── "Propagar efeitos?" — the question sits on the SAME row as its Não / Local / Global
            answers. Local = cascade WITHIN this loco (the former "Sim"); Global = Local PLUS ripple the
            edited workstation's delay/recovery through subsequent same-line locos (see GanttModal). ── */}
        {/* The two propagation QUALIFIERS share ONE row above the answers: both only have an effect
            once Local or Global is chosen, and both are irrelevant to "Não". The labels are kept
            terse ("Inícios paralelos" / "Remover gaps") so the pair fits the card on a single
            line — the full meaning lives in each one's tooltip.
              • Inícios paralelos — default ON: keeping activities that start together aligned is the
                normal expectation; a planner unticks it when the parallel work is meant to diverge.
              • Remover gaps — default OFF, so propagation keeps its long-standing gap-preserving
                behaviour unless asked. */}
        {/* Layout: the row is split into two EQUAL halves (flex-1 + basis-0), each option centred in
            its own half and separated by a hairline divider, so the two read as two distinct settings
            rather than one pair of checkboxes. Same single row, same height, same padding — only the
            horizontal distribution changes. */}
        <div className="flex items-stretch px-4 pt-2.5 border-t border-gray-100 bg-gray-50">
          <label
            className="flex-1 basis-0 flex items-center justify-center gap-1.5 text-[12px] text-gray-700 select-none cursor-pointer whitespace-nowrap"
            title="Propagar inícios paralelos — workstations que começam no MESMO dia acompanham o deslocamento propagado, mantendo o alinhamento das atividades paralelas."
          >
            <input
              type="checkbox"
              className="accent-red-600 shrink-0"
              checked={parallelStarts}
              disabled={sent}
              onChange={(e) => setParallelStarts(e.target.checked)}
            />
            Inícios paralelos
          </label>
          <span aria-hidden className="w-px self-center h-3.5 bg-gray-200 shrink-0" />
          <label
            className="flex-1 basis-0 flex items-center justify-center gap-1.5 text-[12px] text-gray-700 select-none cursor-pointer whitespace-nowrap"
            title="Remover gaps futuros — as workstations seguintes passam a começar logo após a anterior: o tempo livre à frente absorve o atraso antes de ele ser empurrado adiante. Não afeta workstations que começam no mesmo dia."
          >
            <input
              type="checkbox"
              className="accent-red-600 shrink-0"
              checked={removeGaps}
              disabled={sent}
              onChange={(e) => setRemoveGaps(e.target.checked)}
            />
            Remover gaps
          </label>
        </div>

        {/* ONE row: question left, answers right (Não · Local · Global+arrow). The card's 380px is
            sized for exactly this. `flex-wrap` stays as a safety net — a longer label or a bigger
            badge drops the answers onto their own line inside the card rather than pushing the arrow
            outside it — and `ml-auto` keeps them right-aligned whichever line they end up on. */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 py-2.5 mt-1 bg-gray-50 rounded-b-xl">
          <span className="text-[12px] font-semibold text-gray-800 whitespace-nowrap shrink-0">Propagar efeitos?</span>
          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            <button
              className="px-2.5 py-1 rounded text-[12px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 border border-gray-200 disabled:opacity-50"
              style={{ opacity: !category && !recovery ? 0.55 : undefined }}
              disabled={sent}
              title={!category && !recovery
                ? 'Selecione uma categoria primeiro'
                : propagating
                  ? 'Não adicionar propagação (esta linha já propaga de um movimento anterior)'
                  : 'Mover apenas a(s) linha(s) editada(s)'}
              onClick={() => resolve('no')}
            >
              Não
            </button>
            <button
              className="px-2.5 py-1 rounded text-[12px] font-semibold border disabled:opacity-50"
              style={{ background: '#FFF', color: RED, borderColor: RED, opacity: !category && !recovery ? 0.55 : undefined }}
              disabled={sent}
              title={!category && !recovery ? 'Selecione uma categoria primeiro' : 'Propagar dentro deste LOCO'}
              onClick={() => resolve('local')}
            >
              Local
            </button>
            {/* Global + its sub-options arrow as ONE button: the arrow lives INSIDE the red Global
                button (shared background, no gap, hairline divider), so it is always fully within the
                button's bounds and vertically aligned with the "Global" label. `items-stretch` +
                `overflow-hidden` on the shared shell is what keeps the divider and the arrow flush
                with the button's rounded edges. Two hit targets, one control: the label runs the
                propagation, the arrow opens the sub-options (see GlobalPropOptionsButton). */}
            <div
              className="flex items-stretch rounded overflow-hidden"
              style={{ background: RED, opacity: !category && !recovery ? 0.55 : undefined }}
            >
              <button
                className="px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
                disabled={sent}
                title={!category && !recovery ? 'Selecione uma categoria primeiro' : 'Propagar por este WS nos LOCOs seguintes'}
                onClick={() => resolve('global')}
              >
                Global
              </button>
              <GlobalPropOptionsButton disabled={sent} align="right" variant="inset" />
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </>
  )
}
