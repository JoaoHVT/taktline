# Taktline demo — one image, two processes.
#
# The browser only ever talks to Next, which serves the pages and forwards /api to uvicorn on
# loopback (see frontend/next.config.ts `rewrites`). That is what keeps the app single-origin:
# no CORS, no second hostname to configure, and the CSP and security headers Next emits apply
# to every response the browser sees.
#
# Running Next rather than exporting it statically is deliberate. A static export drops the
# rewrite AND the headers, which would mean re-implementing both somewhere else — the header
# set is the security posture, not decoration.

# ── Stage 1: build the frontend ───────────────────────────────────────────────
FROM node:22-slim AS web

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# Single-origin: the API base resolves to '' at runtime and every call goes out relative.
ENV NEXT_PUBLIC_SAME_ORIGIN=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# 3.14 and not 3.13: every check in this repo — the seeder, the route sweep, the solver run —
# was executed on 3.14, and the pins in requirements.txt were resolved there. Matching it means
# the image runs what was tested rather than something adjacent to it.
FROM python:3.14-slim

# Node is needed at RUNTIME, not just to build: `next start` is one of the two processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY tools/ tools/

COPY --from=web /app/frontend/.next        frontend/.next
COPY --from=web /app/frontend/public       frontend/public
COPY --from=web /app/frontend/node_modules frontend/node_modules
COPY --from=web /app/frontend/package.json frontend/package.json
COPY --from=web /app/frontend/next.config.ts frontend/next.config.ts

COPY run_demo.py run_demo.py

# Nothing in here needs to write to the image: the database is copied to a temp file at boot
# (see backend/database.py) and the solver writes no files at all.
RUN useradd --create-home --uid 10001 demo && chown -R demo:demo /app
USER demo

# A session secret that lasts as long as the container. Set AUTH_SECRET to override; leaving it
# unset means a restart invalidates sessions, which is correct for a throwaway demo.
ENV PORT=3000
ENV API_PORT=8000
ENV BACKEND_ORIGIN=http://127.0.0.1:8000
ENV NEXT_TELEMETRY_DISABLED=1
ENV ENVIRONMENT=production

EXPOSE 3000

# The API binds loopback INSIDE the container and is never published; only Next is exposed.
CMD ["python", "run_demo.py", "--host", "0.0.0.0"]
