import type { NextConfig } from "next";

// ── Content-Security-Policy ────────────────────────────────────────────────────
// Defence in depth: the browser blocks any script, connection or frame not on this allow-list,
// so even a successful injection cannot exfiltrate the session token (connect-src pins where
// data may be sent) and the app cannot be framed (frame-ancestors) — clickjacking.
//
// ENFORCING: the header key below is `Content-Security-Policy`, so violations are BLOCKED. If a
// feature ever breaks, the console names the blocked host in a "Refused to …" line; add it to
// the right directive. To debug without breaking anything, switch the key to
// `Content-Security-Policy-Report-Only` temporarily.
//
// Two destinations, and no third party in any directive: the app itself ('self') and the
// backend. The demo signs in against its own /api/auth/login, so there is no identity provider
// to allow — which is why frame-src can be 'none' rather than carrying a login iframe host.
const isDev = process.env.NODE_ENV !== "production";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";

const connectSrc = [
  "'self'",
  API_URL,
  WS_URL,
  // The dev server's HMR websocket. `ws:` is not covered by 'self', and this is the only
  // reason the entry exists — hence development only.
  ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : []),
].filter((v, i, a) => a.indexOf(v) === i).join(" ");

const csp = [
  "default-src 'self'",
  // 'unsafe-inline' is required by Next's inline hydration bootstrap (no nonce wiring). The
  // protection that matters here is connect-src / frame-ancestors, not script-src; a
  // per-request nonce is a possible follow-up.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // No remote images. This used to read `https:` for one feature — an admin could give the
  // offline notice a picture by URL — and that feature is gone with the admin surface. Every
  // image the app renders now ships with it, so the widening has nothing left to serve and the
  // image-beacon side channel it opened goes with it.
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only meaningful behind TLS; a plain-HTTP local run would break on it.
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

// Where the backend listens. The container runs both processes and Next forwards /api to this,
// so the browser only ever talks to one origin.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  images: {
    // Every image is local; no external domain is ever loaded.
    localPatterns: [{ pathname: "/imagens/**" }],
  },
  // ── /api through Next itself ─────────────────────────────────────────────────
  // The app is compiled single-origin: the API base is '' and every call goes out relative.
  // Without this rewrite those calls would 404 against the Next server — and a 404 reads as
  // "the backend is down" rather than "nothing is routing /api", which is a much harder thing
  // for someone running the demo to diagnose.
  //
  // Not a new surface: the destination is loopback, reachable already by whoever is running
  // the process. The WebSocket does NOT pass through here — a Next rewrite does not forward a
  // protocol upgrade — so lib/apiOrigin resolves that separately.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
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
