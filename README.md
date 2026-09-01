# Taktline

A factory-load planning demo: a locomotive assembly schedule, the workload it puts on each
workstation, and a multi-phase MILP that decides who works where.

**Login:** `dev` / `1234` — the credentials are pre-filled on the sign-in screen.

---

## What this is

A public, cut-down build of an internal planning tool. Three things it does:

**Schedule.** A Gantt over two production lines. Every model runs a fixed sequence of stations
at a takt — the interval between units entering the line — with durations written in takts
rather than dates, so changing the takt repositions the whole line without touching a routing.
Boxes can be dragged; a delay propagates to the following stations, to the following units, or
to nothing, and the protection-day buffer at the end of each unit absorbs it before any delivery
date moves.

**Capacity.** Demand per workstation for a fiscal period, against the hours the roster can
actually deliver — shifts, per-station people limits, and holidays taken from a 4-4-5 calendar.

**Optimizer.** Allocation of people to workstations as a **lexicographic multi-objective MILP**
(Gurobi): each phase is optimised and then pinned as a constraint, so a later phase can never
trade away an earlier one's result. Coverage is a **soft** constraint — unmet demand becomes a
penalised slack variable rather than an infeasible model, because "24 hours short on WS07" is a
useful answer and "infeasible" is not.

The `?` dots throughout the UI open short cards explaining each of these.

---

## The data is generated

Nothing here comes from any real factory. `tools/make_demo_data.py` writes the dataset from a
fixed seed — 26 workstations, 28 people, 2 models, 14 units, one year — and
`tools/seed_demo_db.py` loads it into `backend/data/demo.sqlite`, which is what ships. Names are
positional (`Operador 7`, `WS03`, `Item 4`); part numbers and work orders are sequential.

`tools/check_no_real_names.py` scans every tracked file **and every string in the database**
against a denylist and fails on a hit. It is part of the pre-publish routine, not a one-off.

## What it deliberately cannot do

- **No database access.** No viewer, no editor, no export of raw tables.
- **No file upload.** No endpoint accepts one.
- **One account.** `dev`, fixed. No registration, no roster, no password change — a shared
  password one visitor changed would lock out the next.
- **Nothing persists.** The shipped database is copied to a temp file at boot, so a solver run,
  a schedule edit or an audit row lives until the process restarts and no further.
- **The solver is bounded**: one run at a time, a per-caller cooldown, payload size caps, a 5s
  time limit the server sets regardless of what the client asks for, and a model-size ceiling
  checked before the first solve.

---

## Running it

### Docker

```bash
docker build -t taktline .
docker run --rm -p 3000:3000 taktline
# http://localhost:3000
```

One image, two processes: Next serves the pages and forwards `/api` to uvicorn on loopback, so
the app is single-origin and the API is never published. Set `AUTH_SECRET` to keep sessions
across restarts; leaving it unset generates one per boot, which is the right default here.

### From source

Needs Python 3.14 and Node 22.

```bash
# once — backend dependencies into a venv run_demo.py finds on its own
python -m venv backend/venv
backend/venv/Scripts/pip install -r backend/requirements.txt   # Windows
# backend/venv/bin/pip install -r backend/requirements.txt     # macOS / Linux

# once — the frontend build
cd frontend && npm ci && npm run build && cd ..

# once — the dataset and the database it seeds (both are committed, so this is
# only needed after changing tools/make_demo_data.py)
backend/venv/Scripts/python tools/make_demo_data.py
backend/venv/Scripts/python tools/seed_demo_db.py

# every time
python run_demo.py            # http://127.0.0.1:3000 — localhost only
```

`run_demo.py` uses `backend/venv` when it exists and whatever interpreter started it otherwise.
It checks its prerequisites before starting anything and names the command that fixes each one,
so a missing step is a one-line message rather than a traceback.

`run_demo.py` binds `127.0.0.1` unless you pass `--host`. That default is the point: running it
on a laptop should not put the app on whatever network the laptop is joined to.

For frontend work, `backend/start.py` runs the API alone alongside `npm run dev`.

---

## Layout

```
backend/     FastAPI, SQLAlchemy, the Gurobi model (services/optimizer.py)
             gantt_builder.py lays the schedule out; services/tipos.py is the Tipo registry
frontend/    Next.js + TypeScript. The schedule maths runs in a web worker
             (public/gantt-table-worker.js) to keep the grid responsive
tools/       dataset generator, database seeder, and the name gate
```

## Licence

MIT. See `LICENSE`.
