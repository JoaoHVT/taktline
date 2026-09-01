import type { NextConfig } from "next";
import os from "node:os";

// Detect this machine's local IPv4 addresses so dev cross-origin / HMR requests coming
// from the same LAN (e.g. http://192.168.0.x:3000, tested from a phone or another PC)
// are allowed automatically — no manual edit whenever the machine's IP changes.
function localIPv4s(): string[] {
  const out: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// The LAN front door is Caddy on https://<hostname>.local (see ~/.taktline/tools/Caddyfile).
// Requests then reach `next dev` with that Origin, and Next refuses cross-origin dev requests
// that are not listed here — so the mDNS name has to be present or the LAN app 403s on HMR
// and on the dev asset routes.
const mdnsName = `${os.hostname().toLowerCase()}.local`;

// Preserve previously configured origins; add the detected IPs plus a known fallback.
const allowedDevOrigins = Array.from(
  new Set(["192.168.0.6", "192.168.0.28", mdnsName, ...localIPv4s()]),
);

// ── Content-Security-Policy ────────────────────────────────────────────────────
// Defense-in-depth: the browser blocks any script/connection/frame not on this
// allow-list, so even a successful XSS injection can't exfiltrate the Azure token
// or the admin unlock grant (connect-src pins where data may be sent), and the app
// can't be framed (frame-ancestors) — clickjacking.
//
// ENFORCING: the header key below is  Content-Security-Policy , so the browser BLOCKS
// anything off the allow-list. If a legit feature ever breaks, the console shows a
// "Refused to …" CSP violation naming the blocked host — add it to the relevant
// directive (usually connect-src / frame-src). To debug non-destructively, temporarily
// switch the key back to  Content-Security-Policy-Report-Only  (logs without blocking).
//
// As duas destinacoes que a aplicacao usa: ela mesma ('self') e o backend
// (NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL).
//
// the former identity provider SAIU da politica junto com o Entra ID. Ele estava aqui em tres
// diretivas porque o MSAL precisava das tres: connect-src para o token, frame-src para o
// iframe escondido da renovacao silenciosa e form-action para o POST do fluxo de login. O
// login agora e um formulario desta propria aplicacao contra /api/auth/login, entao nenhuma
// das tres precisa mais de terceiro — e frame-src pode voltar a 'none', que e o valor que
// nega enquadramento de qualquer origem.
const isDev = process.env.NODE_ENV !== "production";
const API_URL  = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const WS_URL   = process.env.NEXT_PUBLIC_WS_URL  || "ws://localhost:8000";

// Toda a lista de PUBLIC_ORIGIN, nao so a entrada canonica. Atras do proxy a aplicacao e de
// origem unica e a base da API vem de window.location (lib/apiOrigin), entao quem entra pelo
// IP dispara requisicao para https://<IP> e WebSocket para wss://<IP>. 'self' cobre o http,
// mas nao se pode contar com ele para ws/wss em todo navegador — por isso as duas formas de
// cada origem entram explicitamente.
const EXTRA_ORIGINS = (process.env.NEXT_PUBLIC_ORIGINS || "")
  .split(",")
  .map(o => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
const wsForm = (o: string) => o.replace(/^http/, "ws");

const connectSrc = [
  "'self'",
  API_URL,
  WS_URL,
  ...EXTRA_ORIGINS,
  ...EXTRA_ORIGINS.map(wsForm),
  // Next.js dev server HMR uses a websocket to the dev origin (ws scheme isn't
  // covered by 'self'); allow localhost only in development.
  ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : []),
].filter((v, i, a) => a.indexOf(v) === i).join(" ");

const csp = [
  "default-src 'self'",
  // 'unsafe-inline' is required for Next.js's inline hydration bootstrap (no nonce
  // wiring). The high-value protection here is connect-src/frame-ancestors, not
  // script-src; tightening scripts to a per-request nonce is a possible follow-up.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // `https:` widens images to any HTTPS host, for ONE feature: the admin-authored offline notice
  // can carry a picture/GIF given as a link (Controle do Servidor → "Imagem"), and the browser
  // has to be allowed to load it. The backend refuses any scheme but https for that field, and the
  // <img> is rendered with referrerpolicy="no-referrer".
  //
  // What this does and does not give up: an image cannot execute script, and connect-src stays
  // pinned to the app itself, so the exfiltration paths that matter are untouched. What it does
  // open is the classic image-beacon side channel — a successful XSS could encode data in an image
  // URL — and it lets a third-party host see the viewer's IP. Both are accepted for this feature;
  // narrow it to specific media hosts if the requirement ever settles on one.
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only meaningful (and safe) in the all-HTTPS production deployment.
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

// Onde o backend escuta em loopback. Com PUBLIC_ORIGIN definido o start.py prende o uvicorn
// em 127.0.0.1:8000 — ver bind_host la. So serve para o reescritor de desenvolvimento abaixo.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  images: {
    // Allow all local /public/imagens/* assets (no external domains needed)
    localPatterns: [{ pathname: '/imagens/**' }],
  },
  // ── /api pelo proprio servidor do Next ────────────────────────────────────────
  // Com porta de entrada TLS o pacote e compilado em modo de ORIGEM UNICA
  // (NEXT_PUBLIC_SAME_ORIGIN=1, ver lib/apiOrigin): a base da API vira '' e toda chamada
  // sai relativa, porque atras do Caddy o mesmo host:porta serve as paginas e encaminha
  // /api ao backend.
  //
  // Quem abre o app DIRETO em http://localhost:3000 — caminho documentado no dev.py e o
  // que um atalho antigo ainda aponta — nao tem esse encaminhamento: o `next dev` nao
  // publica rota /api nenhuma, entao TODA chamada relativa morria em 404 gerado pelo
  // proprio Next. E um 404, nao um erro de rede: o cliente le como "backend fora do ar",
  // o ponto do Banco nunca sai de "..." (a sonda nunca chega a ser 401) e o papel do
  // usuario nunca e buscado — com os quatro servicos rodando normalmente ao lado.
  //
  // O reescritor devolve a esse acesso o mesmo encaminhamento que o proxy da: /api passa a
  // valer nas DUAS entradas, sem CORS e sem recompilar contra endereco fixo.
  //
  // Vale nos DOIS modos, e nao so em desenvolvimento. A primeira versao disto era condicional
  // em `isDev`, sob o argumento de que em producao quem roteia /api e o Caddy antes do Next ver
  // a requisicao — verdade, mas so para quem chega PELO Caddy. No host de producao o acesso
  // direto a http://localhost:3000 continua existindo (atalho antigo, e o caminho que o dev.py
  // documenta), e la o build de origem unica chamava /api/health contra um Next que responde
  // 404: os pontos de Backend e Banco caem para OFFLINE com os quatro servicos rodando ao lado.
  // Medido no host: backend 200 em 127.0.0.1:8000, Caddy 200 em https://<host>.local, Next 404
  // em 127.0.0.1:3000.
  //
  // Nao abre superficie nova: o `next start` prende em 127.0.0.1 (ver frontend_serve.py), entao
  // so quem ja esta no host alcanca o reescritor, e o destino e o backend em loopback — o mesmo
  // 127.0.0.1:8000 que essa pessoa ja pode chamar direto. Atras do Caddy a regra e caminho
  // morto, porque /api casa no proxy antes.
  //
  // O WebSocket NAO passa por aqui: reescritor do Next nao encaminha upgrade de protocolo.
  // Ver WS_BASE em lib/apiOrigin, que trata esse acesso a parte.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` }];
  },
  // Allow access from local network devices (e.g. testing from another machine).
  // Auto-populated from this host's LAN IPv4 addresses at startup — see above.
  allowedDevOrigins,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // ENFORCING: the browser blocks anything off the allow-list. (Was
          // Content-Security-Policy-Report-Only during rollout.)
          { key: "Content-Security-Policy", value: csp },
          // Companion hardening headers (safe to enforce immediately).
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
