'use client'
// ── Questionários de expertise ──────────────────────────────────────────────────────
// Two dialogs, one shell, because they are the same instrument pointed at opposite sides of the
// same scale:
//
//   • ExpertiseQuizDialog    — a PERSON's level on a workstation (`e[p,w]`)
//   • WsExpertiseQuizDialog  — a WORKSTATION's target level      (`r[w]`)
//
// The point of either is not to save clicks. "Esta pessoa é nível 2" is a judgement two
// supervisors will make differently; "executa a rotina sozinha, chama apoio no atípico" is an
// observation they will agree on. Same for the station: "exige Alta" is an opinion, "cada
// unidade pede julgamento e só duas pessoas sabem fazer" is a description.
//
// The rules that turn answers into a level live in lib/expertise.ts (levelFromAnswers,
// wsLevelFromAnswers) and are shown live as they are applied — a derived grade with no visible
// reason is one nobody can argue with, which in an assessment tool is a defect.
import React, { useState } from 'react'
import { X, GraduationCap, ArrowRight, Wand2 } from 'lucide-react'
import {
  EXPERTISE_COLOR, EXPERTISE_LABEL, EXPERTISE_MEANING, EXPERTISE_REQUIREMENT_MEANING,
  EXPERTISE_QUIZ, WS_EXPERTISE_QUIZ, WS_QUIZ_CREW_INDEX,
  crewAnswerFor, levelFromAnswers, wsLevelFromAnswers,
  type ExpertiseLevel, type QuizAnswer, type QuizAnswers, type QuizQuestion,
} from '@/lib/expertise'
import { ExpertiseDot } from '@/components/ExpertiseDot'

// ── Shell ───────────────────────────────────────────────────────────────────────────

function QuizDialogShell({
  title, subtitle, questions, derive, meanings, variant, accent,
  initialAnswers, auto, applyLabel, onCancel, onApply,
}: {
  title: string
  subtitle: React.ReactNode
  questions: QuizQuestion[]
  derive: (a: QuizAnswers) => { level: ExpertiseLevel; note: string | null }
  meanings: Record<ExpertiseLevel, string>
  variant: 'holding' | 'requirement'
  accent: string
  /** Answers from a previous assessment — reopening REVISES rather than restarting, which is
   *  what makes a periodic review cycle cheap. Taken loosely typed and validated here: it comes
   *  from stored JSON, so the shape is a claim, not a guarantee. */
  initialAnswers?: number[] | null
  /** One question answered from data instead of asked. Still overridable: the reading can be
   *  stale or the number can be wrong, and a control the user cannot correct is a control they
   *  stop trusting. The badge says which state it is in. */
  auto?: { index: number; value: QuizAnswer | null; source: string } | null
  applyLabel: string
  onCancel: () => void
  onApply: (level: ExpertiseLevel, answers: QuizAnswers) => void
}) {
  // Partial until every question is answered: no default selection, because a pre-selected
  // middle option is an answer nobody gave that still produces a grade. The auto-filled one is
  // the exception — it is not a default, it is a reading.
  const [answers, setAnswers] = useState<(QuizAnswer | null)[]>(() => {
    const ok = Array.isArray(initialAnswers) && initialAnswers.length === questions.length
      && initialAnswers.every(v => v === 1 || v === 2 || v === 3)
    const base: (QuizAnswer | null)[] = ok
      ? (initialAnswers as QuizAnswer[]).slice()
      : questions.map(() => null)
    if (auto && auto.value != null && base[auto.index] == null) base[auto.index] = auto.value
    return base
  })

  const complete = answers.every(a => a != null)
  const result = complete ? derive(answers as QuizAnswers) : null

  return (
    <div data-hc-dialog
         className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
         onClick={onCancel}>
      <div className="bg-white rounded-lg shadow-2xl border border-gray-200 w-[520px] max-w-[94vw] max-h-[88vh] flex flex-col overflow-hidden"
           onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <GraduationCap size={16} style={{ color: accent }} className="shrink-0" />
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-gray-800">{title}</span>
              <span className="text-[11px] text-gray-500 truncate">{subtitle}</span>
            </div>
          </div>
          <button onClick={onCancel} className="rounded p-1 hover:bg-gray-100 shrink-0">
            <X size={15} className="text-gray-500" />
          </button>
        </div>

        <div className="overflow-auto flex-1 px-4 py-3 flex flex-col gap-4">
          {questions.map((q, qi) => {
            const isAuto  = auto?.index === qi
            const filled  = isAuto && auto?.value != null
            const changed = filled && answers[qi] !== auto?.value
            return (
              <div key={q.id} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wide shrink-0"
                        style={{ color: accent }}>{q.dimension}</span>
                  <span className="text-[12px] text-gray-700">{q.prompt}</span>
                </div>
                {isAuto && (
                  <span className="flex items-center gap-1 text-[10px] text-gray-500 -mt-0.5">
                    <Wand2 size={10} className="shrink-0" style={{ color: accent }} />
                    {filled
                      ? (changed
                          // Covers both "the user just clicked another band" and "a stored answer
                          // disagrees with today's data" — the honest statement is the same, and
                          // guessing which one it is would sometimes be wrong.
                          ? `Difere da leitura atual (${auto!.source}), que aponta ` +
                            `"${questions[qi].options[(auto!.value as number) - 1]}".`
                          : `Preenchido pela ${auto!.source}.`)
                      : 'Sem dado de equipe nesta workstation — responda à mão.'}
                  </span>
                )}
                <div className="flex flex-col gap-1">
                  {q.options.map((opt, oi) => {
                    const value = (oi + 1) as QuizAnswer
                    const picked = answers[qi] === value
                    return (
                      <label key={opt}
                        className={`flex items-start gap-2 px-2.5 py-1.5 rounded-lg border-2 cursor-pointer transition-colors ${
                          picked ? '' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'}`}
                        style={picked ? { borderColor: accent, background: `${accent}0F` } : undefined}
                      >
                        <input
                          type="radio"
                          name={q.id}
                          checked={picked}
                          onChange={() => setAnswers(prev => {
                            const next = [...prev]
                            next[qi] = value
                            return next
                          })}
                          className="mt-0.5 shrink-0"
                          style={{ accentColor: accent }}
                        />
                        <span className={`text-[12px] leading-snug ${picked ? 'text-gray-900 font-medium' : 'text-gray-600'}`}>
                          {opt}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Result strip — live, and it explains itself. */}
        <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 shrink-0 flex items-center gap-3">
          {result ? (
            <>
              <ExpertiseDot level={result.level} variant={variant} size="lg" />
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[12px] font-semibold" style={{ color: EXPERTISE_COLOR[result.level] }}>
                  {EXPERTISE_LABEL[result.level]}
                </span>
                <span className="text-[10px] text-gray-500 leading-tight">
                  {meanings[result.level]}
                  {result.note && ` · ${result.note}`}
                </span>
              </div>
            </>
          ) : (
            <span className="text-[11px] text-gray-400 flex-1">
              Responda às três perguntas para ver o nível resultante.
            </span>
          )}
          <div className="flex gap-2 shrink-0">
            <button onClick={onCancel}
              className="px-3 py-1.5 rounded text-xs font-semibold text-gray-600 hover:bg-gray-200">
              Cancelar
            </button>
            <button
              disabled={!result}
              onClick={() => result && onApply(result.level, answers as QuizAnswers)}
              className={`px-3 py-1.5 rounded text-xs font-semibold text-white ${result ? '' : 'opacity-40 cursor-not-allowed'}`}
              style={{ background: accent }}
            >
              {applyLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Person × workstation ────────────────────────────────────────────────────────────

export function ExpertiseQuizDialog({
  personName, wsn, wsDesc, initialAnswers, accent = '#0D9488', onCancel, onApply,
}: {
  personName: string
  wsn: string
  wsDesc?: string
  initialAnswers?: number[] | null
  accent?: string
  onCancel: () => void
  onApply: (level: number, answers: QuizAnswers) => void
}) {
  return (
    <QuizDialogShell
      title="Avaliar expertise"
      subtitle={<>
        {personName} <ArrowRight size={9} className="inline mx-0.5 mb-px" /> {wsn}
        {wsDesc ? ` — ${wsDesc}` : ''}
      </>}
      questions={EXPERTISE_QUIZ}
      derive={a => {
        const r = levelFromAnswers(a)
        return { level: r.level, note: r.limitedBy ? `limitado por: ${r.limitedBy}` : null }
      }}
      meanings={EXPERTISE_MEANING}
      variant="holding"
      accent={accent}
      initialAnswers={initialAnswers}
      applyLabel="Aplicar nível"
      onCancel={onCancel}
      onApply={onApply}
    />
  )
}

// ── Workstation target ──────────────────────────────────────────────────────────────

export function WsExpertiseQuizDialog({
  wsn, wsDesc, crew, crewSource, initialAnswers, accent = '#7C3AED', onCancel, onApply,
}: {
  wsn: string
  wsDesc?: string
  /** Crew size behind the auto-filled third question. `null` leaves it unanswered. */
  crew: number | null
  /** Which field the number came from, named in the badge so a surprising answer can be traced
   *  back to the data instead of read as the dialog inventing one. */
  crewSource: string
  /** Answers from the last time this target was derived. They WIN over the automatic crew
   *  reading — the stored one is what someone decided, the reading is only a suggestion for a
   *  blank form — and the badge says so when the two disagree. */
  initialAnswers?: number[] | null
  accent?: string
  onCancel: () => void
  onApply: (level: ExpertiseLevel, answers: QuizAnswers) => void
}) {
  return (
    <QuizDialogShell
      title="Definir nível alvo"
      subtitle={<>{wsn}{wsDesc ? ` — ${wsDesc}` : ''}</>}
      questions={WS_EXPERTISE_QUIZ}
      derive={a => {
        const r = wsLevelFromAnswers(a)
        return { level: r.level, note: `definido por: ${r.drivenBy}` }
      }}
      meanings={EXPERTISE_REQUIREMENT_MEANING}
      variant="requirement"
      accent={accent}
      initialAnswers={initialAnswers}
      auto={{ index: WS_QUIZ_CREW_INDEX, value: crewAnswerFor(crew), source: crewSource }}
      applyLabel="Aplicar alvo"
      onCancel={onCancel}
      onApply={onApply}
    />
  )
}
