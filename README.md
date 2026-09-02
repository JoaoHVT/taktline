# Taktline

A production planning and workforce allocation tool for a locomotive assembly line: a takt-driven
build schedule, the workload it places on every workstation, and a mixed-integer program that
decides which operator works where.

This is a self-contained demonstration build. It runs on generated data, ships with its own
database, and needs no external service.

**Sign in with `dev` / `1234`** — the credentials are pre-filled on the login screen.

---

## Overview

### Schedule

A Gantt chart across two parallel production lines. Each model moves through a fixed sequence of
workstations at a **takt** — the interval at which units enter the line. Operation durations are
expressed in takts rather than in days, so changing the takt repositions the entire line without
editing a single routing record.

Boxes are draggable. A delay can propagate to the downstream stations of the same unit, to the
following units on the same line, or to nothing at all. The **protection-day buffer** at the end
of each unit absorbs the delay before any committed finish date moves, and the interface warns at
the point where the buffer runs out — because that is where the consequence stops being internal
to the plan.

Two workstations are shared by both lines. Delays cross between lines there and only there, since
that is the one place where the two flows contend for the same physical resource.

### Capacity

Demand per workstation for a fiscal period, measured against the hours the roster can actually
deliver: shift patterns, per-station headcount limits, individual availability, and working days
taken from a 4-4-5 fiscal calendar rather than from the raw date range.

### Optimizer

Operator-to-workstation allocation, formulated as a **lexicographic multi-objective MILP** and
solved with Gurobi. Each phase is optimised and then pinned as a constraint on the phases that
follow, so a later objective can never trade away an earlier one's result.

Demand coverage is a **soft** constraint. Unmet hours become a penalised slack variable instead of
an infeasible model, because *"24 hours short on WS07"* is an answer a planner can act on and
*"infeasible"* is not.

The `?` markers throughout the interface open short cards explaining each of these mechanisms.

---

## Data

Every value in this repository is generated. `tools/make_demo_data.py` produces the dataset from a
fixed seed — 26 workstations, 28 operators, 2 models, 14 units, one fiscal year — and
`tools/seed_demo_db.py` loads it into `backend/data/demo.sqlite`, which is what the application
reads. Identifiers are positional (`Operador 7`, `WS03`, `Item 4`); part numbers and work orders
are sequential.

`tools/check_no_real_names.py` scans every tracked file **and every string value in the database**
against a denylist and exits non-zero on any match. It is a standing check, not a one-off.

## Scope and limits

This build is deliberately constrained:

| | |
| --- | --- |
| **No database access** | No table viewer, no editor, no raw export. |
| **No file ingestion** | No endpoint accepts an upload. |
| **One account** | `dev`, fixed. No registration, no user directory, no password change. |
| **No persistence** | The shipped database is copied to a temporary file at startup, so anything a visitor does — a solver run, a schedule edit, an audit record — lasts until the process restarts. |
| **A bounded solver** | One run at a time, a per-caller cooldown, payload size caps, a server-enforced 5-second time limit, and a model-size ceiling checked before the first solve. |

---

## Running locally

### Requirements

Python 3.14 and Node 22.

### First-time setup

```bash
# Backend dependencies, in the virtual environment the launcher looks for
python -m venv backend/venv
backend\venv\Scripts\pip install -r backend\requirements.txt     # Windows
# backend/venv/bin/pip install -r backend/requirements.txt       # macOS / Linux

# Frontend build
cd frontend && npm ci && npm run build && cd ..
```

The dataset and the database it seeds are both committed, so regenerating them is only necessary
after changing the generator:

```bash
backend\venv\Scripts\python tools\make_demo_data.py
backend\venv\Scripts\python tools\seed_demo_db.py
```

### Start

```bash
python run_demo.py
```

Then open **http://127.0.0.1:3000** and sign in with `dev` / `1234`.

`run_demo.py` starts two processes: the API on loopback, and Next.js in front of it forwarding
`/api`. The browser therefore talks to a single origin — no CORS, and the security headers Next
emits apply to every response.

It **binds `127.0.0.1` unless you pass `--host`**. That default is deliberate: running the demo on
a laptop should not expose it to whatever network the laptop happens to be joined to.

The launcher verifies its prerequisites before starting anything and names the command that
resolves each one, so a missed setup step produces a single line rather than a stack trace.

For frontend work, `backend/start.py` runs the API alone alongside `npm run dev`.

`backend/requirements-dev.txt` adds the test-only dependencies; the runtime set in
`requirements.txt` is deliberately kept to what the application itself needs.

### Docker

```bash
docker build -t taktline .
docker run --rm -p 3000:3000 taktline
```

One image, two processes, same single-origin arrangement; the API is never published outside the
container. Set `AUTH_SECRET` to keep sessions across restarts — left unset, one is generated per
boot, which is the appropriate default here.

> **Note:** the image definition is linted and statically checked, but `docker build` has not yet
> been executed against it.

---

## Architecture

```
backend/     FastAPI · SQLAlchemy · Gurobi
             services/optimizer.py   the multi-phase MILP
             gantt_builder.py        lays the schedule out from routings and takt
             services/tipos.py       the single registry classifying a line into a type

frontend/    Next.js · TypeScript
             public/gantt-table-worker.js   schedule mathematics, in a Web Worker so the
                                            grid stays responsive during a rebuild
             src/lib/tipos.ts               the TypeScript half of the registry above

tools/       dataset generator · database seeder · the name gate
```

The schedule mathematics exists in two places — the worker and the Python builder — because both
the browser and the server have to reach the same answer about the same boxes. The type registry
is duplicated for the same reason and for no other; the two copies are expected to agree, and a
divergence between them is a bug.

## Licence

MIT. See [`LICENSE`](LICENSE).
