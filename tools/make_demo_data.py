"""Generate the masked demo workbook.

Every value here is invented. The *shape* of the data — the sheet names, the column sets, the
grain of each row, the way a routing hangs off a model and a plan hangs off an item — mirrors
what the importers expect; none of the content is transcribed from anywhere. Names are
positional ("Operador 7", "WS03", "Item 4"), part numbers and work orders are sequential, and
the two locomotive models are invented codes that merely satisfy the model-prefix shape the
Gantt's fallback rule looks for.

Deterministic: a fixed seed, so regenerating produces byte-identical content and a diff of the
seeded database is meaningful.

    python tools/make_demo_data.py [out.xlsx]

Writes backend/data/demo_source.xlsx by default. tools/seed_demo_db.py then imports it.
"""
from __future__ import annotations

import random
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "backend" / "data" / "demo_source.xlsx"

SEED = 20260101
YEAR = 2026

# ── Vocabulary ───────────────────────────────────────────────────────────────
N_WORKSTATIONS = 26
N_PEOPLE = 28
N_ITEMS = 12
AREAS = [f"Área {i}" for i in range(1, 5)]
FAMILIAS = [f"Família {i}" for i in range(1, 5)]
CLIENTES = [f"Cliente {i}" for i in range(1, 3)]
SCOPES = ["LEVE", "MEDIO", "PESADO"]
TIPOS_FW = ["MONTAGEM", "PERITAGEM"]

WSNS = [f"WS{i:02d}" for i in range(1, N_WORKSTATIONS + 1)]
PEOPLE = [f"Operador {i}" for i in range(1, N_PEOPLE + 1)]
ITEMS = [f"Item {i}" for i in range(1, N_ITEMS + 1)]

# Two models sharing their first six stations, so the Schedule has genuine cross-model
# contention on those workstations instead of two independent chains.
MODELS = {
    "MX10": {"linha": "Main Line",    "takt": 2, "units": 8, "wsns": WSNS[0:16]},
    "MX20": {"linha": "Special Line", "takt": 3, "units": 6, "wsns": WSNS[0:6] + WSNS[16:26]},
}

PROTECTION_PN = "PROTECTION DAYS"


def business_days(start: date, n: int) -> date:
    """`n` business days after `start` (weekends only — holidays are the backend's job)."""
    d, step = start, (1 if n >= 0 else -1)
    left = abs(n)
    while left:
        d += timedelta(days=step)
        if d.weekday() < 5:
            left -= 1
    return d


def build() -> dict[str, pd.DataFrame]:
    rng = random.Random(SEED)

    # ── HeadCount: capacity and who works where ──────────────────────────────
    # A person works several stations, which is what makes the allocation model interesting:
    # with one person per station there is nothing to decide.
    people_by_wsn: dict[str, list[str]] = {}
    for i, wsn in enumerate(WSNS):
        k = rng.choice([1, 2, 2, 3])
        picks = [PEOPLE[(i * 3 + j) % N_PEOPLE] for j in range(k)]
        people_by_wsn[wsn] = sorted(set(picks))

    headcount_rows = []
    for i, wsn in enumerate(WSNS):
        people = people_by_wsn[wsn]
        turnos = 2 if i % 3 == 0 else 1
        headcount_rows.append({
            "WSN":       wsn,
            "AREA":      AREAS[i % len(AREAS)],
            "DESC":      f"Workstation {i + 1}",
            "HEADCOUNT": ", ".join(people),
            "QTDE":      len(people),
            "DISP":      1.0,
            "LH":        8.0 * turnos,
            "LM":        max(1, len(people) - 1),
            "TURNOS":    turnos,
        })

    # ── Item Rout: routing per assembly, one row per (assembly, scope, station) ──
    itens_rows = []
    pn_seq = 0
    for idx, item in enumerate(ITEMS):
        stations = [WSNS[(idx * 2 + k) % N_WORKSTATIONS] for k in range(rng.choice([3, 4, 5]))]
        for scope_i, scope in enumerate(SCOPES):
            for comp_i, wsn in enumerate(sorted(set(stations))):
                pn_seq += 1
                itens_rows.append({
                    "ASSEMBLY":  item,
                    "COMPONENT": f"Componente {comp_i + 1}",
                    "DESCRIÇÃO": f"Conjunto {idx + 1}-{comp_i + 1}",
                    "WSN":       wsn,
                    "ESCOPO":    scope,
                    "HH TOTAL":  round(4.0 + scope_i * 3.5 + comp_i * 1.5, 1),
                })

    # ── Plano Prod: one row per (item, fiscal week) ──────────────────────────
    plano_rows = []
    for idx, item in enumerate(ITEMS):
        for mes in range(1, 13):
            plano_rows.append({
                "ITEM":     item,
                "CLIENTE":  CLIENTES[idx % len(CLIENTES)],
                "AREA":     AREAS[idx % len(AREAS)],
                "FAMILIA":  FAMILIAS[idx % len(FAMILIAS)],
                "ANO":      YEAR,
                "MES":      mes,
                "FW":       (mes - 1) * 4 + 2,
                "QTDE FW":  rng.choice([1, 1, 2, 2, 3, 4]),
                "TIPO FW":  TIPOS_FW[idx % len(TIPOS_FW)],
                "NIVEL":    f"Nível {1 + idx % 3}",
                "CUSTO":    round(1200 + idx * 137.5, 2),
            })

    # The legacy flat sheet is the vertical union of the two above — the same relationship the
    # backend reconstructs when it reads the split tables.
    disc = pd.concat([pd.DataFrame(itens_rows), pd.DataFrame(plano_rows)],
                     ignore_index=True, sort=False)

    # ── Locos Rout: the station sequence each model is built through ─────────
    locos_rows = []
    wo_seq = 1000
    for model, spec in MODELS.items():
        for pos, wsn in enumerate(spec["wsns"]):
            n_parts = rng.choice([1, 2, 2, 3])
            for part in range(n_parts):
                pn_seq += 1
                wo_seq += 1
                locos_rows.append({
                    "LOCOMOTIVA":  model,
                    "PART NUMBER": f"PN-{pn_seq:04d}",
                    "WORKSTATION": wsn,
                    "SUBAREA":     f"Subárea {(pos % 3) + 1}",
                    "DESCRIÇÃO":   f"Operação {pos + 1}.{part + 1}",
                    "AREA":        AREAS[pos % len(AREAS)],
                    "HH UNIT":     round(rng.uniform(3.0, 28.0), 1),
                    "QTD":         rng.choice([1, 1, 2, 4]),
                    "DURACAO":     "Takt" if part or pos % 5 else "2 Takt",
                    "INICIO":      "0" if pos == 0 else f"+ {pos} Takt",
                    "WORKORDER":   f"WO-{wo_seq}",
                    "PART DESC":   f"Peça {pn_seq:04d}",
                    "ESCOPO":      "UNICO",
                    "LINHA":       spec["linha"],
                })
        # Protection Days close the build: a buffer sized from the Schedule's Finish MS.
        wo_seq += 1
        locos_rows.append({
            "LOCOMOTIVA":  model,
            "PART NUMBER": PROTECTION_PN,
            "WORKSTATION": "PD",
            "SUBAREA":     "Subárea 1",
            "DESCRIÇÃO":   "Protection Days",
            "AREA":        AREAS[0],
            "HH UNIT":     0.0,
            "QTD":         1,
            "DURACAO":     "5",
            "INICIO":      f"+ {len(spec['wsns'])} Takt",
            "WORKORDER":   f"WO-{wo_seq}",
            "PART DESC":   "Protection Days",
            "ESCOPO":      "UNICO",
            "LINHA":       spec["linha"],
        })

    # ── Schedule: one row per unit, staggered by the model's takt ────────────
    sched_rows = []
    unit_no = 0
    for model, spec in MODELS.items():
        takt = spec["takt"]
        # Span: every station consumes one takt, plus the protection buffer.
        span = len(spec["wsns"]) * takt + 5
        first = date(YEAR, 1, 5)
        for u in range(spec["units"]):
            unit_no += 1
            start = business_days(first, u * takt)
            finish = business_days(start, span)
            sched_rows.append({
                "Standard WO": model,
                "Task Name":   f"Loco {unit_no}",
                "Start MS":    start.isoformat(),
                "Takt":        takt,
                "Linha":       spec["linha"],
                "Finish MS":   finish.isoformat(),
                "Contratual":  business_days(finish, 5).isoformat(),
            })

    return {
        "Discretizado": disc,
        "Item Rout":    pd.DataFrame(itens_rows),
        "Plano Prod":   pd.DataFrame(plano_rows),
        "Schedule - MS": pd.DataFrame(sched_rows),
        "Locos - Rout": pd.DataFrame(locos_rows),
        "HeadCount":    pd.DataFrame(headcount_rows),
    }


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    sheets = build()
    with pd.ExcelWriter(out, engine="openpyxl") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name, index=False)
    print(f"[make_demo_data] {out}")
    for name, df in sheets.items():
        print(f"  {name:<14} {len(df):>4} linhas × {len(df.columns)} colunas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
