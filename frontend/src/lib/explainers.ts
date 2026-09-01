/**
 * explainers.ts — the content behind every `<InfoDot />`.
 *
 * Audience: an engineer or a recruiter who opened the demo, not an operator who works here.
 * They can see WHAT the screen does; what they cannot see is what is being solved underneath.
 *
 * ── The content rule ─────────────────────────────────────────────────────────────────────
 * Generic technique, plus THIS demo's model. Nothing else.
 *
 * Textbook framing is fine and is the point — "lexicographic multi-objective MILP", "coverage
 * is a soft constraint" — because that is what makes the app legible as engineering. What must
 * never appear: operational policy, tuned objective weights, protection-day policy, station
 * layouts, or any reasoning that only makes sense at one particular plant. Free text is the
 * easiest place in a codebase to leak those by accident, which is why the rule is written here
 * rather than assumed.
 *
 * A card that cannot be written without naming a real practice should not be written.
 */

export interface Explainer {
  title: string
  /** Paragraphs. Kept as an array so the card never has to parse markup. */
  body: string[]
}

export const EXPLAINERS = {
  home: {
    title: 'O que é isto',
    body: [
      'Uma demonstração pública de uma ferramenta de planejamento de fábrica: um cronograma de montagem, a carga que ele gera por estação e um otimizador que decide quem trabalha onde.',
      'Os dados são gerados e não representam nenhuma fábrica real — 26 workstations, 28 pessoas, dois modelos e um ano de plano. A estrutura é real; os nomes e os números não.',
    ],
  },

  takt: {
    title: 'Takt e o cronograma',
    body: [
      'Cada modelo percorre uma sequência fixa de estações. O takt é o intervalo entre duas unidades entrando na linha: com takt 2, uma locomotiva começa a cada 2 dias úteis, e cada estação segura a unidade por um número de takts definido na rota.',
      'A duração de uma operação é escrita em função do takt ("Takt", "2 Takt"), e não em dias fixos. Mudar o takt reposiciona a linha inteira sem reescrever nenhuma rota — que é a razão de ele existir como parâmetro em vez de como data.',
    ],
  },

  propagation: {
    title: 'Propagação de um atraso',
    body: [
      'Mover uma estação levanta a pergunta de o que mais deveria se mover. Três respostas são oferecidas: nada (só a caixa arrastada), local (as estações seguintes da mesma unidade) e global (também as unidades seguintes da mesma linha).',
      'Uma workstation é um recurso por fluxo: um atraso na Linha 1 não diz nada sobre a Linha 2, e por isso a propagação não atravessa linhas. A exceção são as estações compartilhadas, que são uma máquina só pela qual os dois fluxos passam — ali o atraso atravessa, porque fisicamente é o mesmo recurso.',
    ],
  },

  protection: {
    title: 'Dias de proteção',
    body: [
      'O bloco final de cada unidade é um buffer entre o fim da montagem e a data de entrega. Ele não é trabalho: é a folga que absorve os atrasos anteriores.',
      'Por isso ele encolhe antes de qualquer outra coisa se mover. Um atraso consome o buffer primeiro e só empurra a data de entrega quando o buffer chega a zero — e é nesse ponto que a interface avisa, porque é ali que a consequência deixa de ser interna ao plano.',
    ],
  },

  objective: {
    title: 'O modelo de otimização',
    body: [
      'A alocação de pessoas é um MILP multiobjetivo resolvido de forma LEXICOGRÁFICA: cada fase é otimizada e o seu valor é então FIXADO como restrição para as fases seguintes. A fase 2 nunca pode piorar o resultado da fase 1 para melhorar o seu próprio.',
      'A cobertura da demanda é uma restrição SUAVE: horas não atendidas viram uma variável de folga penalizada, não um modelo inviável. Um plano impossível devolve "faltaram X horas na estação Y", que é uma resposta útil — em vez de "infeasible", que não é.',
      'As variáveis são horas normais e horas extras por par (pessoa, estação), mais binárias que dizem se um par está ativo. As restrições ligam isso à capacidade de cada pessoa, ao limite de pessoas por turno de cada estação e à demanda de cada estação.',
    ],
  },

  lexfix: {
    title: 'Lendo o log do solver',
    body: [
      'O log mostra uma execução do Gurobi por fase. Entre elas aparece a fixação lexicográfica: uma restrição nova que trava o objetivo recém-otimizado no valor encontrado, para que a fase seguinte só possa escolher entre soluções igualmente boas naquele critério.',
      '"Gap" é a distância entre a melhor solução encontrada e o melhor limite provado. Um gap de 0% significa ótimo demonstrado; parar em um gap pequeno é uma escolha de tempo, não uma falha.',
      'Esta demonstração limita cada execução a poucos segundos e a um modelo pequeno, então as fases terminam quase sempre no ótimo.',
    ],
  },

  capacity: {
    title: 'De onde vem a capacidade',
    body: [
      'Cada workstation declara quantos turnos opera, quantas horas por turno e quantas pessoas cabem simultaneamente. A capacidade do período é isso multiplicado pelos dias úteis do calendário fiscal — não pelos dias corridos.',
      'A disponibilidade de uma pessoa é reduzida proporcionalmente por férias que se sobreponham ao período. Quem está fora o período inteiro sai da lista; quem está fora metade dele entra com metade das horas.',
    ],
  },

  expertise: {
    title: 'Níveis de expertise',
    body: [
      'Cada vínculo (pessoa, estação) pode receber um nível, e cada estação pode declarar um nível alvo. O nível é uma propriedade da RELAÇÃO, não da pessoa: a mesma pessoa pode ser experiente em uma estação e novata na seguinte.',
      'Estar abaixo do alvo não exclui ninguém. A diferença é precificada no objetivo da última fase, então quem atinge o alvo é preferido quando há escolha — e quando não há, a estação é atendida assim mesmo. Uma lacuna aqui é de treinamento, não de capacidade.',
      'A nota vem de um questionário cuja regra é o MÍNIMO entre as dimensões respondidas, não a média: quem depende de ajuda em qualquer uma delas ainda depende de ajuda.',
    ],
  },
} as const satisfies Record<string, Explainer>

export type ExplainerTopic = keyof typeof EXPLAINERS
