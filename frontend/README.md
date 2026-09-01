# Taktline — Frontend

Next.js 16 (App Router) + React 19 + TypeScript client for both Taktline feature areas:
**Capacity Analysis** and **Factory Load** (Schedule / Gantt).

> Repository overview: [`../README.md`](../README.md) ·
> Full technical reference: [`../ARCHITECTURE.txt`](../ARCHITECTURE.txt)

---

## Local development

```bash
cd frontend
cp .env.example .env.local     # fill in real values — never commit this file
npm install
npm run dev                    # http://localhost:3000
```

The backend must be running (default `http://localhost:8000`) — see
[`../backend/README.md`](../backend/README.md).

```bash
npm run build      # production build
npm run lint       # eslint
npx tsc --noEmit   # type check
```

All three must pass before a change is considered done.

## Environment variables

See [`.env.example`](.env.example). Every variable is `NEXT_PUBLIC_*`, which means it is
**inlined into the JavaScript bundle and is public** — visible to anyone who opens
DevTools. Never put a secret behind that prefix; all real authorization is server-side.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Backend base URL. |
| `NEXT_PUBLIC_WS_URL` | WebSocket endpoint for live solver logs (defaults from API URL). |
| `NEXT_PUBLIC_AZURE_TENANT_ID` / `NEXT_PUBLIC_AZURE_CLIENT_ID` | Azure AD app registration. Must match the backend's `AZURE_*`. |
| `NEXT_PUBLIC_ALLOWED_DOMAIN` | Domain hint for a better sign-in error. The backend enforces the real check. |

## Structure

```
src/
├── app/           App Router entries — (main) app shell, /auth callback, layout
├── components/    UI. Large features are folders:
│   ├── gantt/       Schedule: GanttTable, footer, filters, Resumo Geral, optimizer modals
│   └── OptimizationResultsModal/
├── context/       Cross-cutting providers (ImportJobs, Gantt inline state)
├── hooks/         useAuth (single shared session), useBackendHealth, …
└── lib/           api client, auth config, token/unlock stores, gantt utils, crypto
public/
├── gantt-table-worker.js   Web Worker that builds the Gantt DOM off the main thread
└── imagens/                Image assets
```

## Key concepts

- **Auth is one shared session.** `useAuth` is a context singleton provided by
  `AuthProvider` — *not* a per-caller hook. If each consumer ran its own copy they would
  desync (a 401 would flip only one copy's state and the login modal might never appear).
- **All API calls go through `lib/api.ts`.** Its interceptors attach the Azure bearer
  token, replay the `X-Admin-Unlock` grant, and surface the unlock modal on a 401. Calls
  made outside this client bypass the whole security and re-auth flow.
- **The Gantt renders in a Web Worker** (`public/gantt-table-worker.js`) into an iframe.
  Toggling filters/visibility triggers a rebuild; live cell edits patch surgically instead.
  `localTodayIso()` in `lib/ganttUtils.ts` must stay identical to the worker's copy, or the
  Today marker and the hide-past clamp drift a day apart.
- **CSP is enforcing** (`next.config.ts`). Any new external host must be added to
  `connect-src`/`frame-src` or the browser silently blocks it.
- **Backend polling must respect the keepalive window.** The service is only awake
  08:00–18:00 Mon–Fri; new pollers gate on `isWithinAwakeWindow()` (tab visibility alone
  is not enough).
- **Never `console.log` identity or tokens.** Auth tracing uses a dev-only `devLog`; the
  MSAL logger drops PII and only logs below warning level in development.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Sign-in popup opens then nothing happens | Tenant/client ID mismatch with the backend, or the account is outside the allowed domain. |
| Every request 401s | Backend `AZURE_*` differ from `NEXT_PUBLIC_AZURE_*`. |
| Network calls blocked with no error | CSP — add the host to `connect-src` in `next.config.ts`. |
| Password dialog returns a generic 429 | Failed-attempt lockout; duration is intentionally not disclosed. Clears server-side. |
| App loads but data is empty / server dot grey | Backend asleep (outside the keepalive window) or unreachable. |
| Stale Gantt after changing a filter | The build key did not change — filter/visibility changes must be part of the rebuild deps. |
