// ── Expertise levels (Análise de Capacidade) ────────────────────────────────────────
// Replaces the pure-boolean person↔workstation association with a 4-value scale, used on
// BOTH sides of the same relationship:
//
//   • per person/WS pair — how solid that person is on that workstation  (`e[p,w]`)
//   • per workstation    — the level the workstation REQUIRES            (`r[w]`)
//
// The two sit on ONE scale on purpose: a person's dot being at or past the workstation's
// dot is the eligibility read, done by eye, with no legend lookup. That is also why the
// palette runs gray → green → yellow → red instead of the usual "green = good": here the
// colour ranks POSITION ON THE SCALE, not quality. Red on a workstation means "demands the
// most"; red on a person means "supplies the most".
//
// Level semantics (Dreyfus collapsed 5→3 + a not-qualified zero — three grades are what a
// supervisor can assess without a formal instrument, five are not):
//   0  N/A         not qualified          — equivalent to the old `s[p,w] = 0`
//   1  Baixa       novice                 — does not work the station alone
//   2  Média       competent              — autonomous on routine work
//   3  Alta        proficient/expert      — full autonomy, absorbs the atypical, trains
//
// NOTE the name: `nivel` is ALREADY taken in this domain and means something else — the
// item's NIVEL field, which weights Phase 2's coverage priority in the solver
// (`nivel_weighted_demand_by_wsn`). Everything here says "expertise", never "nivel".

export type ExpertiseLevel = 0 | 1 | 2 | 3

export const EXPERTISE_LEVELS: ExpertiseLevel[] = [0, 1, 2, 3]

/** `null`/`undefined` (never assessed) reads as 0 — the same state as "not qualified". */
export function asLevel(v: number | null | undefined): ExpertiseLevel {
  const n = Math.round(Number(v ?? 0))
  return (n >= 0 && n <= 3 ? n : 0) as ExpertiseLevel
}

export const EXPERTISE_LABEL: Record<ExpertiseLevel, string> = {
  0: 'N/A',
  1: 'Baixa',
  2: 'Média',
  3: 'Alta',
}

/** What the level MEANS operationally — the tooltip line, so the colour never has to be
 *  guessed from the label alone. */
export const EXPERTISE_MEANING: Record<ExpertiseLevel, string> = {
  0: 'Não habilitado',
  1: 'Não opera sozinho — precisa de par mais experiente',
  2: 'Autonomia em rotina',
  3: 'Autonomia total — absorve o atípico e treina',
}

/** Same wording, from the WORKSTATION's side — what it ASKS FOR, which is not the same as what
 *  it accepts. The station never turns anyone away (see `meetsTarget`); the target only decides
 *  who goes there first when the solver has a choice. */
export const EXPERTISE_REQUIREMENT_MEANING: Record<ExpertiseLevel, string> = {
  0: 'Sem nível alvo — qualquer pessoa serve',
  1: 'Alvo: habilitação básica',
  2: 'Alvo: autonomia em rotina',
  3: 'Alvo: proficiência total',
}

export const EXPERTISE_COLOR: Record<ExpertiseLevel, string> = {
  0: '#9CA3AF',  // gray-400
  1: '#16A34A',  // green-600
  2: '#EAB308',  // yellow-500
  3: '#DC2626',  // red-600
}

/** Tinted background for chips/rows, same hues at low alpha. */
export const EXPERTISE_BG: Record<ExpertiseLevel, string> = {
  0: '#F3F4F6',
  1: '#F0FDF4',
  2: '#FEFCE8',
  3: '#FEF2F2',
}

/** Is this person at or above the workstation's target?
 *
 *  A READ, not a gate. Nobody is ever excluded from a workstation for being below its target —
 *  the solver prices the gap as a phase-4 preference (`EXPERTISE_SHORTFALL_WEIGHT`) and still
 *  allocates the person when there is no better candidate. A station targeting Alta whose whole
 *  crew is Média gets staffed by that crew; excluding them would leave its demand uncovered,
 *  which is the worse outcome and was the bug this rule replaced.
 *
 *  So `false` here means "below target" — a training gap to show in amber — and never
 *  "unavailable".
 *
 *  A workstation with no target (0) asks for nobody in particular, so everyone is at target.
 *  The same 0 means "not assessed" on the PERSON's side and "no target" on the STATION's; only
 *  the station's side is asked here, and conflating the two would paint every unassessed pair
 *  amber on day one. */
export function meetsTarget(
  personLevel: number | null | undefined,
  targetLevel: number | null | undefined,
): boolean {
  const r = asLevel(targetLevel)
  if (r === 0) return true
  return asLevel(personLevel) >= r
}

/** Highest level a person holds across their workstations, and where. */
export function topLevelOf(
  levels: Record<string, number | null | undefined>,
): { level: ExpertiseLevel; wsn: string | null } {
  let best: ExpertiseLevel = 0
  let where: string | null = null
  for (const [wsn, raw] of Object.entries(levels)) {
    const lv = asLevel(raw)
    if (lv > best) { best = lv; where = wsn }
  }
  return { level: best, wsn: where }
}

/** MEAN level across a set of pairs — what the collapsed row shows.
 *
 *  The average, not the ceiling: one Alta and one Baixa is a person who is solid in one place
 *  and green in another, and "Alta" would read as a claim about them in general. Averaging says
 *  Média, which is the honest summary of the set.
 *
 *  A pair that was never assessed counts as the 0 it is — dropping unassessed pairs would make
 *  a person with one Alta and four blanks read as Alta.
 *
 *  Ties round DOWN (2.5 → Média, not Alta): the display must never overstate expertise, and a
 *  half-step up is exactly the case where the evidence does not support the higher grade.
 *  `raw` comes back with the pre-rounding value for the tooltip, so the rounding is visible
 *  rather than mysterious. */
export function averageLevelOf(
  levels: Record<string, number | null | undefined>,
): { level: ExpertiseLevel; raw: number; count: number } {
  const values: number[] = Object.values(levels).map(asLevel)
  if (values.length === 0) return { level: 0, raw: 0, count: 0 }
  const raw = values.reduce((a, b) => a + b, 0) / values.length
  return { level: Math.ceil(raw - 0.5) as ExpertiseLevel, raw, count: values.length }
}

// ── Questionário de avaliação ───────────────────────────────────────────────────────
// Three questions, three answers each, deriving the level instead of it being assigned by
// hand. The dimensions come straight out of the spec's own definition of the levels:
//
//   1 Novato      "não opera sozinho; requer par mais experiente"
//   2 Experiente  "autonomia em rotina"
//   3 Proficiente "autonomia total, absorve o atípico, TREINA"
//
// So: autonomy (the Dreyfus axis), scope covered, and being the reference for others — the
// third is what the spec uses to separate 3 from 2, and nothing else in the definition does.
//
// Answers are graded 1–3 and map onto the SAME scale as the levels, deliberately: an answer
// is not a score to be summed into an arbitrary range, it is a claim at a level.

export type QuizAnswer = 1 | 2 | 3
/** One answer per question, in QUIZ order. */
export type QuizAnswers = [QuizAnswer, QuizAnswer, QuizAnswer]

export interface QuizQuestion {
  /** Also the radio group name in the dialog, so it must be unique WITHIN a question set. */
  id: string
  /** Short name used when explaining which dimension capped the result. */
  dimension: string
  prompt: string
  /** Index 0 → answer 1, index 2 → answer 3. */
  options: string[]
}

export const EXPERTISE_QUIZ: QuizQuestion[] = [
  {
    id: 'autonomia',
    dimension: 'Autonomia',
    prompt: 'Como esta pessoa executa o trabalho desta workstation hoje?',
    options: [
      'Precisa de acompanhamento de alguém mais experiente',
      'Executa a rotina sozinha; chama apoio no caso atípico',
      'Executa sozinha, inclusive o atípico e o imprevisto',
    ],
  },
  {
    id: 'escopo',
    dimension: 'Escopo',
    prompt: 'Que parte do escopo da workstation ela cobre?',
    options: [
      'Apenas as operações mais simples',
      'A maior parte das operações de rotina',
      'Todo o escopo, incluindo variantes raras',
    ],
  },
  {
    id: 'referencia',
    dimension: 'Referência',
    prompt: 'Qual é o papel dela em relação aos colegas nesta workstation?',
    options: [
      'Recorre a outros para tirar dúvidas',
      'Tira dúvidas pontuais de colegas',
      'É a referência da workstation e treina novatos',
    ],
  },
]

/** Derive the level from the three answers.
 *
 *  NOT an average and NOT a sum. Two rules, both taken from the level definitions:
 *
 *  1. `min(autonomia, escopo)` — expertise is bounded by its weakest of the two operational
 *     dimensions. Someone autonomous on a third of the scope is not autonomous on the
 *     workstation, and full scope under supervision is still supervised. Averaging would let
 *     one strong answer cover a weak one, which is exactly the "frágil no chão de fábrica"
 *     the whole feature exists to stop.
 *
 *  2. Being the reference only decides the LAST step, and only downwards: `3` requires
 *     "autonomia total, absorve o atípico, treina", so someone who clears both operational
 *     dimensions but is not yet a reference lands on Experiente. It can never RAISE a level —
 *     mentoring without autonomy is not proficiency, and the min already said so.
 *
 *  The rule returns what limited it, because a derived grade nobody can explain is a grade
 *  nobody trusts.
 *
 *  Level 0 is unreachable here on purpose: the questionnaire is only asked about a pair that
 *  EXISTS, and "not qualified" is the absence of the link, not an answer. */
export function levelFromAnswers(
  answers: QuizAnswers,
): { level: ExpertiseLevel; limitedBy: string | null } {
  const [autonomia, escopo, referencia] = answers
  const base = Math.min(autonomia, escopo) as ExpertiseLevel
  if (base === 3 && referencia < 3) {
    return { level: 2, limitedBy: 'Referência' }
  }
  if (base === 3) return { level: 3, limitedBy: null }
  const limitedBy = autonomia <= escopo ? 'Autonomia' : 'Escopo'
  return { level: base, limitedBy }
}

// ── Questionário do nível ALVO da workstation ───────────────────────────────────────
// The mirror of the one above, on the other side of the same scale. Where the person quiz asks
// what someone CAN do, this one asks what the work DEMANDS.
//
// That flip changes the combination rule, and the change is the point: capabilities are bounded
// by the weakest dimension (a person autonomous on a third of the scope is not autonomous on the
// station), so the person quiz takes a MIN. Demands are set by the strongest (a station that is
// either intrinsically hard OR has nobody to spare is a demanding station), so this one takes a
// MAX. Averaging either would let one comfortable answer excuse a hard one.
//
// The first two questions are PROVISIONAL — deliberate placeholders, to be reviewed against how
// the areas actually talk about their stations. The third is not a judgement at all: it reads
// the crew size already stored on the workstation.

export const WS_EXPERTISE_QUIZ: QuizQuestion[] = [
  {
    id: 'complexidade',
    dimension: 'Complexidade',
    prompt: 'Que tipo de trabalho esta workstation exige?',
    options: [
      'Operações padronizadas, com roteiro fixo',
      'Rotina com decisões pontuais no meio do processo',
      'Ajuste e diagnóstico constantes — cada unidade pede julgamento',
    ],
  },
  {
    id: 'semelhanca',
    dimension: 'Semelhança',
    prompt: 'Quanto o trabalho daqui se parece com o de outras workstations?',
    options: [
      'Muito — quem opera outras estações se adapta rápido',
      'Em parte — uma fatia do método é só desta estação',
      'Pouco — o método é próprio e não se aprende em outra estação',
    ],
  },
  {
    id: 'equipe',
    dimension: 'Equipe',
    prompt: 'Quantas pessoas sustentam esta workstation?',
    options: [
      '5 ou mais — a carga se distribui e há cobertura de sobra',
      '3 ou 4 — margem estreita para faltas',
      '1 ou 2 — sem cobertura se faltar alguém',
    ],
  },
]

/** Index of the auto-filled question inside `WS_EXPERTISE_QUIZ`. */
export const WS_QUIZ_CREW_INDEX = 2

/** The crew answer, read off the workstation instead of asked.
 *
 *  Bands: 1–2 people → Alta, 3–4 → Média, 5+ → Baixa. Fewer people on a station means each one
 *  carries more of it and an absence has nowhere to go — the same work is a bigger risk with two
 *  people than with ten.
 *
 *  `null` when there is no crew number to read. An unanswered question is the honest state; a
 *  guessed band would be indistinguishable from a measured one. */
export function crewAnswerFor(crew: number | null | undefined): QuizAnswer | null {
  const n = Number(crew)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n <= 2) return 3
  if (n <= 4) return 2
  return 1
}

/** Derive a workstation's target level from the three answers.
 *
 *  `max` of the three, for the reason in the block comment above: each answer is a claim about
 *  how much the station demands, and the largest demand is the one the station has. A trivial
 *  station held up by two people still demands its people be good, because there is nobody to
 *  cover them — which is exactly what the crew band says.
 *
 *  Returns which dimension(s) set the level, because a derived target nobody can explain is a
 *  target nobody will maintain. */
export function wsLevelFromAnswers(
  answers: QuizAnswers,
): { level: ExpertiseLevel; drivenBy: string } {
  const level = Math.max(...answers) as ExpertiseLevel
  const drivenBy = WS_EXPERTISE_QUIZ
    .filter((_, i) => answers[i] === level)
    .map(q => q.dimension)
    .join(' e ')
  return { level, drivenBy }
}

// ── Versão do questionário ──────────────────────────────────────────────────────────
// What survives a change to the questions is the LEVEL, never the answers.
//
// The level is the record: it is what the solver reads, what the screen shows, and what
// supervision agreed to. The answers are only the reasoning that produced it once, and reasoning
// stated in questions that no longer exist cannot be replayed — prefilling a revised
// questionnaire with answers given to DIFFERENT questions would silently attribute positions
// nobody took.
//
// So every stored assessment carries the version of the question set that produced it. Bump this
// whenever a question, an option or the derivation rule changes. Old assessments keep their
// level, keep saying they came from a questionnaire, and simply stop pre-filling — reopening one
// asks the current questions on a blank form.
export const EXPERTISE_QUIZ_VERSION = 1

/** The `expertise_source` written for a questionnaire assessment. */
export const quizSourceTag = (): string => `quiz@${EXPERTISE_QUIZ_VERSION}`

/** Were these answers given to the question set now on screen? Legacy rows stored a bare
 *  `quiz` before versioning existed; they are treated as v1, which is what they are. */
export function answersAreCurrent(source: string | null | undefined): boolean {
  const s = String(source ?? '').trim().toLowerCase()
  if (s === 'quiz') return EXPERTISE_QUIZ_VERSION === 1
  const m = /^quiz@(\d+)$/.exec(s)
  return !!m && Number(m[1]) === EXPERTISE_QUIZ_VERSION
}

/** Was this level derived from a questionnaire at all, of any version? */
export function isQuizSource(source: string | null | undefined): boolean {
  return /^quiz(@\d+)?$/.test(String(source ?? '').trim().toLowerCase())
}

/** Where a stored level came from. `quiz` also carries the answers, so an assessment can be
 *  reopened and revised instead of re-done from memory — while its version still matches. */
export type ExpertiseSource = 'manual' | 'quiz'

/** Person-name → level map for one workstation, read off the workstation's `expertise` field
 *  with its `people` list as the authority on WHO is linked. A linked person with no stored
 *  level is 0, not absent — "linked but never assessed" must still render a dot. */
export function levelsForWorkstation(
  people: string[],
  expertise: Record<string, number> | null | undefined,
): Record<string, ExpertiseLevel> {
  const out: Record<string, ExpertiseLevel> = {}
  for (const name of people) out[name] = asLevel(expertise?.[name])
  return out
}
