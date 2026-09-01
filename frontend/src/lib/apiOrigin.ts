/**
 *  Onde a API mora — resolvido EM TEMPO DE EXECUCAO, e nao soldado no pacote.
 *
 *  Atras da porta de entrada do Caddy (PUBLIC_ORIGIN definido) a implantacao e de
 *  ORIGEM UNICA: o mesmo host:porta serve as paginas e encaminha /api e /ws para o
 *  backend em loopback. Ate aqui o start.py compilava o pacote contra a entrada
 *  CANONICA de PUBLIC_ORIGIN — o nome .local — o que prendia TODO navegador aquele
 *  nome, qualquer que fosse o endereco por onde a pessoa chegou.
 *
 *  Isso so funciona enquanto todo cliente consegue resolver o nome, e `.local` nao e
 *  DNS: e mDNS (RFC 6762), respondido por multicast no enlace local. Nao atravessa
 *  VLAN nem sub-rede, depende de UDP 5353 entrar no host, e o proprio host resolve o
 *  seu nome localmente esteja ou nao alguem respondendo na rede — por isso a maquina
 *  hospedeira SEMPRE funciona enquanto um cliente leva DNS_PROBE_STARTED.
 *
 *  E a alternativa documentada — a entrada por IP de PUBLIC_ORIGIN, que o Caddy ja
 *  atende e o certificado ja cobre no SAN — NAO salvava: a pagina abria pelo IP e
 *  entao cada requisicao saia para o nome que aquele cliente nao resolve. Falha pior
 *  que a primeira, porque a tela carrega antes de quebrar.
 *
 *  Derivar de window.location faz cada cliente falar com o endereco pelo qual ELE
 *  chegou — nome, IP ou um registro de DNS futuro — sem recompilar nada.
 */

/** start.py grava "1" quando existe porta de entrada TLS (PUBLIC_ORIGIN definido). */
const SAME_ORIGIN = process.env.NEXT_PUBLIC_SAME_ORIGIN === '1'

/** Base absoluta. Continua sendo a verdade nas implantacoes SEM proxy (the host, dev
 *  puro) e no teste de host de isLocalApi(), que precisa do nome para decidir se o
 *  backend pode dormir. Nao a use para montar requisicao — use API_BASE. */
export const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
export const CONFIGURED_WS_URL  = process.env.NEXT_PUBLIC_WS_URL  || 'ws://localhost:8000'

/** '' atras da porta de entrada: axios e fetch resolvem todo caminho contra a origem
 *  atual. Fora dela, a base absoluta de sempre. */
export const API_BASE =
  SAME_ORIGIN && typeof window !== 'undefined' ? '' : CONFIGURED_API_URL

/** A lista inteira de PUBLIC_ORIGIN — as origens que o Caddy realmente atende. */
const GATEWAY_ORIGINS = (process.env.NEXT_PUBLIC_ORIGINS || '')
  .split(',')
  .map(o => o.trim().replace(/\/$/, ''))
  .filter(Boolean)

/** Esta aba chegou pela porta de entrada TLS?
 *
 *  Vale para o WebSocket, e so para ele. O HTTP relativo funciona nas duas entradas: atras
 *  do proxy quem encaminha /api e o Caddy, e no acesso direto ao servidor de desenvolvimento
 *  quem encaminha e o reescritor do next.config. Upgrade de protocolo o reescritor NAO
 *  encaminha — entao numa aba aberta em http://localhost:3000 derivar wss://<host da aba>
 *  aponta o socket para o proprio Next, que nao tem /ws, e o progresso da otimizacao nunca
 *  conecta. Nesse caso o valor certo e a base absoluta configurada.
 *
 *  A porta vazia e o que mantem a intencao original intacta: um nome NOVO apontado para
 *  este host (registro A no DNS interno, um IP que ainda nao esta na lista) chega na porta
 *  padrao do esquema e continua sendo tratado como origem unica, sem recompilar nada. Quem
 *  cai no ramo de baixo e so quem carrega porta explicita fora da lista — na pratica, a
 *  porta do proprio frontend. */
function behindGateway(): boolean {
  if (typeof window === 'undefined') return false
  if (GATEWAY_ORIGINS.includes(window.location.origin)) return true
  return window.location.port === ''
}

/** WebSocket nao aceita URL relativa — precisa de esquema e autoridade. Derivados do
 *  protocolo da pagina para nao produzir ws:// numa pagina https (o navegador bloqueia
 *  como conteudo misto). */
export const WS_BASE =
  SAME_ORIGIN && typeof window !== 'undefined' && behindGateway()
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : CONFIGURED_WS_URL
