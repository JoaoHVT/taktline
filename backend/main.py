import os
import sys
import uuid
import asyncio
import json
import logging
import threading
from datetime import datetime, timezone, timedelta, date
from collections import Counter
from pathlib import Path
from contextlib import asynccontextmanager
# `Any` appears in a function SIGNATURE (_loco_scopes), which Python evaluates at import time
# on 3.13 — a missing import there is a startup crash, not a type-checker complaint. Local
# 3.14 hides it: PEP 649 made annotations lazy, so the same file imports fine here.
from typing import Any

logger = logging.getLogger(__name__)

# ── .env MUST be loaded before ANY project module is imported ────────────────
# services.auth captures AUTH_SECRET / ALLOWED_DOMAIN / AUTH_SESSION_TTL_SECONDS and
# database.py captures DATABASE_URL *at module import time*. Importing either of
# them before this call froze those values as empty strings, silently swapping the
# session-signing secret for a derived fallback and disabling the DB engine. The path is resolved by env_paths (not
# from the cwd) so `uvicorn main:app` works from any working directory, and
# override=True lets the .env win over stale values inherited from the parent
# shell. Platform-injected vars still work: no candidate file exists
# there, so this is a no-op.
#
# env_paths is the ONE exception to "no project module before load_dotenv": it
# imports only the standard library and reads no configuration at import time.
# It exists because the secrets must not sit in the synced folder — see
# the SECURITY note in that module.
try:
    from dotenv import load_dotenv
except Exception:
    # Allow startup even when python-dotenv is not installed in local env.
    # In production, environment variables are injected by the platform.
    def load_dotenv(*args, **kwargs):
        return False

from env_paths import resolve_env_file

_ENV_PATH = resolve_env_file()
if _ENV_PATH is not None:
    load_dotenv(dotenv_path=_ENV_PATH, override=True)

import pandas as pd

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException, Query, Depends, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from sqlalchemy import text, func, or_, case

from services.auth import (
    require_auth as _base_require_auth,
    validate_bearer_token,
    verify_password,
    issue_session_token,
    normalize_email,
    display_name_of,
    SESSION_TTL_S,
)
from services.data_loader import get_items_for_import, get_items_catalog, compute_capacity_stats, get_wsn_people_map, get_period_days
from services.assembly_details import get_assembly_details
# Same key normalisation the resolver uses, so an explicit-demand payload keys on exactly
# what get_assembly_details() looks up.
from services.data_loader import _normalize as _norm_item_key
# FW → calendar-year map, so an optimization period's fiscal weeks resolve to real dates
# (needed to intersect the period with dated vacation ranges).
from services.data_loader import _build_fw_year_map, _fw_key as _fw_key_norm
from services import calendar_445
from services.optimizer import check_gurobi, build_snapshot, run_optimization

# ── Optional DB imports (graceful fallback when DB is not configured) ────────
try:
    from database import get_db, engine as db_engine, is_available as db_is_available, check_connection as db_check_connection
    from models import (
        Base, MonthlyDemand, SolverJob, ScheduleRow, LocosRout, DbConfig, ItensRout, PlanoProd,
        ScheduleOverride, ScenarioSaturdayWorkday, ProjectionBaseline, UserPermission,
        SecurityEvent, AuthThrottle, CalendarOverride, FiscalWeekOverride, Workstation, Person,
        WorkstationPerson, PersonLeave, AppSetting, get_active_ver,
    )
    _DB_AVAILABLE = True
except Exception as _db_import_exc:
    _DB_AVAILABLE = False
    _db_import_exc_msg = str(_db_import_exc)
else:
    _db_import_exc_msg = ""

# (.env is loaded at the very top of this module — see _ENV_PATH.)







_last_db_error: str = ""  # stores the most recent _db_to_df error for /api/db/debug/teste


# Read switch for the source of the wide Discretizado-equivalent DataFrame.
#   DISCRETIZADO_SPLIT_READ unset / "auto" → AUTO: serve the split union
#     (itens_rout + plano_prod) when those tables are populated, else fall back to
#     legacy monthly_demand. This is the intended steady state now that the two
#     normalized files are the real source.
#   "1"/"true"/"yes"/"on" → force split.
#   "0"/"false"/"no"/"off" → force legacy (rollback).
# The split path always self-heals to legacy when empty, so no consumer is ever
# starved during the migration.
def _split_read_mode() -> str:
    import os as _os
    v = _os.getenv("DISCRETIZADO_SPLIT_READ", "auto").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return "on"
    if v in ("0", "false", "no", "off"):
        return "off"
    return "auto"




def _db_to_df_legacy() -> "pd.DataFrame | None":
    """
    Fetches all rows from monthly_demand and returns a pandas DataFrame that is
    column-for-column identical to xl.parse('Discretizado').
    Each row was stored as a JSON string in row_json, so we just decode them.
    Returns None if the DB is not available.
    """
    import json as _json
    global _last_db_error
    _last_db_error = ""

    if not _DB_AVAILABLE:
        _last_db_error = f"Módulos não disponíveis: {_db_import_exc_msg}"
        logger.error("[DB] _db_to_df: %s", _last_db_error)
        return None
    try:
        with get_db() as db:
            # Filter by active version so staging rows are never visible to readers
            _active = get_active_ver(db, "monthly_demand")
            raw_rows = db.query(MonthlyDemand.row_json).filter(MonthlyDemand.ver == _active).all()
            if not raw_rows:
                _last_db_error = "Tabela monthly_demand existe mas está vazia."
                logger.warning("[DB] _db_to_df: %s", _last_db_error)
                return pd.DataFrame()
            records = [_json.loads(r.row_json) for r in raw_rows]
        df = pd.DataFrame(records)
        logger.info("[DB] _db_to_df: %d linhas carregadas, %d colunas.", len(df), len(df.columns))
        return df
    except Exception as exc:
        # Full traceback → server log only. The client-facing _last_db_error (surfaced
        # via /api/db/debug and some error details) keeps just type+message — no traceback,
        # which would leak file paths / internals.
        logger.exception("[DB] _db_to_df falhou")
        _last_db_error = f"{type(exc).__name__}: {exc}"
        return None


def _db_to_df() -> "pd.DataFrame | None":
    """Discretizado source-of-truth DataFrame for every consumer.

    Mode (see _split_read_mode): "off" → always legacy monthly_demand; "on"/"auto"
    → prefer the split union (itens_rout + plano_prod). In both "on" and "auto",
    if the split is empty/unavailable it falls back to legacy, so no consumer is
    ever starved. "auto" (the default) makes the two normalized files the live
    source as soon as they are imported, with zero config.
    """
    if _split_read_mode() == "off":
        return _db_to_df_legacy()

    split_df = _db_to_df_split()
    if split_df is not None and not split_df.empty:
        logger.info("[DB] _db_to_df: servindo via split (%d linhas, %d colunas).",
                    split_df.shape[0], split_df.shape[1])
        return split_df

    logger.warning("[DB] _db_to_df: split vazio/indisponivel — fallback para monthly_demand.")
    return _db_to_df_legacy()


# ── Capacity source cache ─────────────────────────────────────────────────────
# _db_to_df_split() rebuilds the wide Discretizado-equivalent frame from two
# SELECTs plus one json.loads per row. Measured on prod-sized data (2.7k rows,
# 1.35 MB): ~700 ms per call, of which ~87% is network round trips (NullPool
# opens a fresh connection on every request) and only
# ~13% Python. Seven endpoints call _capacity_source_df() and each paid that in
# full, on every request — there was no cache on this path, unlike the Gantt.
#
# Same shape as _gantt_cache below: one module-level frame + a TTL, dropped by
# _invalidate_capacity_cache() on any import or dataset edit touching
# itens_rout / plano_prod. Two invariants:
#   • only a NON-EMPTY frame is cached — None (DB down) and empty (tables not yet
#     populated) are degraded states and must be re-read, never pinned for 5 min;
#   • callers get a .copy(), because the services that receive the frame as
#     df_override treat it as their own and may mutate it in place.
_capacity_cache: "pd.DataFrame | None" = None
_capacity_cache_at: float = 0.0
_CAPACITY_CACHE_TTL = 300  # seconds — same revalidation window as the Gantt cache


def _invalidate_capacity_cache() -> None:
    """Drop the cached split frame so the next capacity read rebuilds from the DB."""
    global _capacity_cache, _capacity_cache_at
    _capacity_cache = None
    _capacity_cache_at = 0.0


def _capacity_source_df() -> "pd.DataFrame | None":
    """Preferred Discretizado-equivalent source for the Capacity consumers.

    DB-SPLIT-FIRST policy: when the split read is enabled (default 'auto') and the
    split tables (itens_rout + plano_prod) hold data, return the reconstructed
    wide frame. Returns None when the split is empty or disabled — the caller then
    falls back to the raw monthly_demand table (see _demand_df).
    """
    if _split_read_mode() == "off":
        return None
    try:
        split_df = _db_to_df_split()
    except Exception as exc:
        logger.warning("[DB] _capacity_source_df: split falhou (%s) — usando Excel.", exc)
        return None
    if split_df is not None and not split_df.empty:
        logger.info("[DB] _capacity_source_df: servindo via split (%d linhas).", split_df.shape[0])
        return split_df
    return None


def _demand_df() -> "pd.DataFrame":
    """The demand frame every capacity endpoint reads, or a 503.

    Two sources, in order: the normalized split (itens_rout + plano_prod) when it holds data,
    then the raw monthly_demand table. There is no file fallback of any kind — the database is
    the only source the demo has, and an empty one is an error worth reporting rather than a
    screen full of zeros that reads like an answer.
    """
    df = _capacity_source_df()
    if df is None:
        df = _db_to_df()
    if df is None or df.empty:
        raise HTTPException(
            status_code=503,
            detail="Dados de demanda indisponiveis no banco.",
        )
    return df



def _period_working_dates(fws: list[str] | None, df: object = None) -> list:
    """Real working DATES of an optimization period, derived from its fiscal weeks.

    Same engine and rule as get_period_days (which returns only the count): Mon–Fri minus
    holidays, per the shared 4-4-5 calendar, each FW resolved to its own calendar year via the
    imported FW/ANO columns so a period spanning a year boundary still maps exactly.

    Returns [] when no FWs were supplied — callers must read that as "window unknown" and fall
    back to the single-day rule, never as "the period has no working days".
    """
    keys: list[str] = []
    seen: set[str] = set()
    for f in (fws or []):
        k = _fw_key_norm(f)
        if k and k not in seen:
            seen.add(k)
            keys.append(k)
    if not keys:
        return []
    try:
        year_by_fw = _build_fw_year_map(df if df is not None else None)
        default_year = date.today().year
        out: list = []
        for k in keys:
            try:
                fw_num = int(k)
            except (TypeError, ValueError):
                continue
            year = int(year_by_fw.get(k, default_year))
            out.extend(calendar_445.working_dates_in_fw(year, fw_num))
        return sorted(set(out))
    except Exception as exc:
        logger.warning("[OPT] _period_working_dates falhou: %s", exc)
        return []


def _leave_factors(period_dates: list | None = None) -> "tuple[set[int], dict[str, float]]":
    """Vacation/leave impact over an optimization window.

    Returns (fully_unavailable_person_ids, availability_pct_by_person_name) where the pct is
    the share of the window's WORKING days the person is NOT on leave, 0–100. People with no
    overlapping leave are absent from the map (nothing to scale).

    Two outcomes by design, matching how capacity is modelled elsewhere:
      • leave covers the whole window → the person is dropped from the roster entirely, the
        same treatment `active=False` gets, so "usar todo o headcount" cannot force work onto
        someone who is away all period;
      • leave covers part of it → the person stays, with availability scaled down, reusing the
        existing per-person availability mechanism (person_availability_pct) rather than
        inventing a second one.

    With no window (no FWs sent) the rule degrades to the single day `today`, which is
    all-or-nothing by construction — the behaviour that shipped before periods were plumbed
    through.
    """
    if not _DB_AVAILABLE:
        return set(), {}
    days = list(period_dates or [date.today()])
    if not days:
        return set(), {}
    # Leave is stored as ISO 'YYYY-MM-DD' strings, so a lexicographic compare IS a date
    # compare — no parsing needed, and it matches how the rows are written.
    iso_days = [d.isoformat() for d in days]
    total = len(iso_days)
    try:
        with get_db() as db:
            rows = db.query(PersonLeave.person_id, PersonLeave.start_date,
                            PersonLeave.end_date).all()
            if not rows:
                return set(), {}
            # Union the ranges per person: overlapping leave rows are allowed (the model does
            # not forbid them), and summing their lengths would double-count the overlap.
            covered: dict[int, set[str]] = {}
            for r in rows:
                s, e = (r.start_date or ""), (r.end_date or "")
                hit = {iso for iso in iso_days if s <= iso <= e}
                if hit:
                    covered.setdefault(r.person_id, set()).update(hit)
            if not covered:
                return set(), {}
            full_out = {pid for pid, c in covered.items() if len(c) >= total}
            partial_ids = [pid for pid in covered if pid not in full_out]
            names = {
                p.id: p.name for p in db.query(Person.id, Person.name)
                .filter(Person.id.in_(partial_ids)).all()
            } if partial_ids else {}
            pct_by_name = {
                names[pid]: round(100.0 * (1.0 - len(covered[pid]) / total), 4)
                for pid in partial_ids if names.get(pid)
            }
            return full_out, pct_by_name
    except Exception as exc:
        logger.error("[DB] _leave_factors falhou: %s", exc)
        return set(), {}


def _merge_leave_availability(user_pct: dict | None,
                              leave_pct: dict[str, float] | None) -> "dict[str, float] | None":
    """Combine the UI's per-person availability with the leave-derived one.

    Multiplicative, not min(): someone set to 50% in the UI who is also away half the period is
    available a quarter of it, and taking the smaller of the two would silently discard one of
    the constraints. A UI value of 0 (person disabled) stays 0 either way.
    """
    merged = {str(k): float(v) for k, v in (user_pct or {}).items()}
    for name, pct in (leave_pct or {}).items():
        cur = merged.get(name, 100.0)
        merged[name] = max(0.0, min(100.0, cur * pct / 100.0))
    return merged or None


def _headcount_source_dict(on_date: "date | None" = None,
                           exclude_person_ids: "set[int] | None" = None) -> dict[str, dict]:
    """Capacity limits (people, hour/people caps, shifts) keyed by WSN, sourced from the
    centralized Headcount tab (Workstation/Person/WorkstationPerson) — the single source
    of truth for capacity data, replacing the LH/LM/TURNOS/HEADCOUNT columns that used to
    be read inline off Item Rout rows — those columns are no longer imported, and the routing-derived
    fallback that read them was deleted, so there is nothing left to fall back to. Shape matches
    headcount_by_wsn:
    { wsn: { people, qtde, disp, lh, turnos, lm, desc } }. Returns {} (not None) when the DB
    or the Headcount tab has no data — that's an explicit "no capacity constraints" state,
    not "fall back to Item Rout".

    People who are INACTIVE are excluded from `people`: `Person.active = False`, or a
    PersonLeave period covering `on_date` (default: today). Leave used to be stored and never
    read, so someone on vacation stayed allocatable — and with "usar todo o headcount
    disponível" on, the optimizer would actively assign work to them.

    `on_date` is the single-day fallback used when no optimization window is known. When the
    caller DOES know the window (the optimize endpoint, which now receives the period's FWs) it
    passes `exclude_person_ids` from _leave_factors instead: people away for the ENTIRE window
    are dropped here, and people away for part of it stay but have their availability scaled —
    see _leave_factors.
    """
    if not _DB_AVAILABLE:
        return {}
    try:
        today = (on_date or date.today()).isoformat()
        with get_db() as db:
            people = db.query(Person).all()
            if exclude_person_ids is not None:
                on_leave = set(exclude_person_ids)
            else:
                # Leave is stored as ISO 'YYYY-MM-DD' strings, so a lexicographic compare IS a
                # date compare — no parsing needed, and it matches how the rows are written.
                on_leave = {
                    r.person_id for r in db.query(PersonLeave.person_id,
                                                  PersonLeave.start_date, PersonLeave.end_date).all()
                    if (r.start_date or "") <= today <= (r.end_date or "")
                }
            people_by_id = {
                p.id: p for p in people
                if bool(p.active) and p.id not in on_leave
            }
            links = db.query(WorkstationPerson).all()
            names_by_ws: dict[int, list[str]] = {}
            # e[p,w] keyed by person NAME, because that is the key the solver works in (`J` is a
            # list of names, `qualified_pairs` is (wsn, name)). Only for people who survived the
            # active/leave filter above — a level for someone off the roster is not a candidate.
            levels_by_ws: dict[int, dict[str, int]] = {}
            for link in links:
                p = people_by_id.get(link.person_id)
                if p:
                    names_by_ws.setdefault(link.workstation_id, []).append(p.name)
                    if link.expertise_level is not None:
                        levels_by_ws.setdefault(link.workstation_id, {})[p.name] = int(link.expertise_level)
            result: dict[str, dict] = {}
            for ws in db.query(Workstation).all():
                wsn = str(ws.wsn or "").strip()
                if not wsn:
                    continue
                people_names = sorted(names_by_ws.get(ws.id, []))
                # QTDE is capped at the number of people actually allocated and available.
                # The stored `ws.qtde` is an admin-entered count that can drift ABOVE reality —
                # it is not decremented when someone is removed from the roster, and it knows
                # nothing about leave. Since capacity is computed as qtde × lh, an un-capped
                # value silently invents hours for people who are not there. Only capped when
                # links exist, so a workstation with a headcount but no named people (a valid
                # state) keeps its declared quantity.
                qtde_declared = ws.qtde if ws.qtde is not None else len(people_names)
                result[wsn] = {
                    "people": people_names,
                    "qtde": min(qtde_declared, len(people_names)) if people_names else qtde_declared,
                    "disp": 1.0,
                    "lh": float(ws.hour_limit) if ws.hour_limit is not None else 0.0,
                    "turnos": ws.turnos if ws.turnos is not None else 0,
                    "lm": ws.people_limit if ws.people_limit is not None else 0,
                    "desc": ws.desc or "",
                    # Expertise (see services/optimizer.py). Carried on every call, consumed
                    # only when the run asks for it — an unused key costs nothing and keeps
                    # this function the single place that knows how to read the roster.
                    "required_level": int(ws.required_level or 0),
                    "expertise": levels_by_ws.get(ws.id, {}),
                }
            return result
    except Exception as exc:
        logger.error("[DB] _headcount_source_dict falhou: %s", exc)
        return {}


def _db_to_df_split(use_cache: bool = True) -> "pd.DataFrame | None":
    """Reconstruct the wide Discretizado-equivalent DataFrame from the SPLIT tables.

    itens_rout (routing/BOM, keyed by ASSEMBLY) and plano_prod (plan, keyed by
    ITEM, one row per ITEM+FW) are two INDEPENDENT source files. The legacy flat
    sheet was a denormalized UNION of routing-bearing and plan-bearing rows that
    every consumer cross-references internally by the business key ITEM⇄ASSEMBLY
    (assembly_details groups ASSEMBLY rows separately from ITEM-demand rows;
    get_items_for_import filters ITEM/period rows; the optimizer filters WSN rows).

    Reconstruction is therefore a CONCAT (vertical union), NOT a 1:N join — so
    QTDE FW never fans out across routing rows. Routing rows supply ASSEMBLY/WSN/
    HH; plan rows supply ITEM/period/QTDE FW; the union frame carries both, with
    NaN in the columns a given row's grain doesn't own — exactly as the original
    sheet looked. Returns None when DB unavailable, empty DataFrame when both
    tables are empty.

    Cached for _CAPACITY_CACHE_TTL (see _invalidate_capacity_cache). Pass
    use_cache=False from anything that must observe the DB as it is *right now*
    — the split-parity / debug reports, which exist precisely to compare stores.
    """
    import json as _json
    import time as _time
    global _capacity_cache, _capacity_cache_at
    if (
        use_cache
        and _capacity_cache is not None
        and (_time.monotonic() - _capacity_cache_at) < _CAPACITY_CACHE_TTL
    ):
        return _capacity_cache.copy()
    if not _DB_AVAILABLE:
        return None
    try:
        with get_db() as db:
            ir_ver = get_active_ver(db, "itens_rout")
            pp_ver = get_active_ver(db, "plano_prod")
            ir_raw = db.query(ItensRout.row_json).filter(ItensRout.ver == ir_ver).all()
            pp_raw = db.query(PlanoProd.row_json).filter(PlanoProd.ver == pp_ver).all()
            if not ir_raw and not pp_raw:
                return pd.DataFrame()
            ir_recs = [_json.loads(r.row_json) for r in ir_raw]
            pp_recs = [_json.loads(r.row_json) for r in pp_raw]

        ir_df = pd.DataFrame(ir_recs)
        pp_df = pd.DataFrame(pp_recs)
        # Vertical union: routing rows first, then plan rows. pandas aligns shared
        # columns and fills missing grain-specific columns with NaN.
        merged = pd.concat([ir_df, pp_df], ignore_index=True, sort=False)
        # Defensive: drop the legacy ordering key if any rows still carry it (only
        # the removed combined importer wrote __rid; the new independent importers
        # never do). No consumer reads it — strip so the frame is clean either way.
        merged = merged.drop(columns=["__rid"], errors="ignore")
        if use_cache and not merged.empty:
            _capacity_cache = merged
            _capacity_cache_at = _time.monotonic()
            return merged.copy()     # never hand out the cached object itself
        return merged
    except Exception as exc:
        logger.error("[DB] _db_to_df_split falhou: %s", exc)
        return None





# Garante que os módulos do backend possam ser importados
sys.path.insert(0, str(Path(__file__).parent))

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
ENVIRONMENT  = os.getenv("ENVIRONMENT", "development")
# Armazena jobs em memória; o estado terminal vai para a tabela solver_jobs.
jobs: dict[str, dict] = {}

# The in-memory jobs dict is never cleared during the process lifetime, so over a
# long uptime finished solver jobs pile up (each holds its result + log lines) and
# memory creeps upward. Cap the retained count, evicting the OLDEST FINISHED jobs
# only — running/queued jobs are always kept. Bounds RAM without any timer.
_TERMINAL_JOB_STATES = {"done", "error", "cancelled"}
_MAX_RETAINED_JOBS = int(os.getenv("MAX_RETAINED_JOBS", "40"))


def _prune_jobs() -> None:
    """Drop oldest finished jobs so the in-memory dict can't grow without bound."""
    if len(jobs) <= _MAX_RETAINED_JOBS:
        return
    for jid in list(jobs.keys()):          # dict preserves insertion (age) order
        if len(jobs) <= _MAX_RETAINED_JOBS:
            break
        if (jobs.get(jid) or {}).get("status") in _TERMINAL_JOB_STATES:
            jobs.pop(jid, None)

# Per-connection async queues for WebSocket push (replaces raw WS list to
# prevent concurrent send_json from two coroutines on the same socket)
ws_queues: dict[str, list[asyncio.Queue]] = {}


# ── Access-log noise filter ──────────────────────────────────────────────────
# Log volume is not free. Liveness endpoints are by far the chattiest thing
# here and the least informative: the keepalive cron pings every 5 min through the
# working day, and every open tab probes /api/health on its own beat. Each SUCCESS
# writes an access-log line that says only "the server is up", which the next line
# repeats.
#
# Only 2xx/3xx responses on those two paths are dropped. Anything >= 400 still logs
# — a failing health check is exactly the line worth keeping — as does every other
# route. This trims volume without creating a blind spot.
class _AccessLogNoiseFilter(logging.Filter):
    _QUIET_PATHS = {"/", "/api/health"}

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True                      # unfamiliar shape → never drop
        try:
            path = str(args[2]).split("?")[0]
            status = int(args[4])
        except (TypeError, ValueError, IndexError):
            return True
        if status >= 400:
            return True                      # failures are always worth a line
        return path not in self._QUIET_PATHS


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Installed here, not at import: uvicorn applies its own logging config as it
    # boots, which would discard a filter attached earlier.
    try:
        logging.getLogger("uvicorn.access").addFilter(_AccessLogNoiseFilter())
    except Exception as _e:
        logger.warning("[startup] access-log filter: %s", _e)

    if _DB_AVAILABLE:
        # ── 1. Create all ORM tables that don't exist yet ─────────────────────
        try:
            Base.metadata.create_all(bind=db_engine)
        except Exception as _e:
            logger.warning("[startup] create_all: %s", _e)

        # The schema is built by create_all above and nothing else: the demo database is
        # generated from the current models by tools/make_demo_data.py and recreated from the
        # seed on every boot, so there is no older database in the world to migrate forward.

        # ── 2. Seed db_config active-version pointers if missing ──────────────
        # Ensures existing rows at ver=0 are immediately readable without an import.
        for _tbl in ["monthly_demand", "schedule", "locos_rout"]:
            try:
                with get_db() as _cdb:
                    _key = f"active_ver:{_tbl}"
                    if not _cdb.query(DbConfig).filter(DbConfig.key == _key).first():
                        _cdb.add(DbConfig(key=_key, val="0"))
            except Exception as _e:
                logger.warning("[startup] db_config seed(%s): %s", _tbl, _e)

        # ── 3. Prune solver_jobs older than 24 h ──────────────────────────────
        try:
            from datetime import datetime, timezone, timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            with get_db() as db:
                db.query(SolverJob).filter(SolverJob.updated_at < cutoff).delete(synchronize_session=False)
        except Exception as _e:
            logger.warning("[startup] Prune solver_jobs: %s", _e)

    # ── 5. Load the admin-editable working-calendar overrides into the engine ──
    # Done unconditionally (even DB-down → empty snapshot) so calendar_445 always has
    # a defined override state before the first Gantt/KPI computation.
    try:
        _n = _load_calendar_overrides()
        logger.info("[startup] Calendar overrides carregados: %s", _n)
    except Exception as _e:
        logger.warning("[startup] Load calendar overrides: %s", _e)

    print("[API] Backend iniciado.")
    yield
    print("[API] Backend encerrado.")


# Swagger / OpenAPI docs are NEVER exposed publicly. The built-in auto-routes are
# disabled here (all None); OWNER-ONLY versions of /docs, /redoc and /openapi.json
# are re-served below, gated by HTTP Basic Auth (DOCS_USER / DOCS_PASSWORD). With
# those env vars unset, the docs stay completely unavailable (404) — default-secure.
app = FastAPI(
    title="the legacy tool API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_local_ip = os.getenv("LOCAL_IP", "")


def _parse_origins(raw: str) -> list[str]:
    """FRONTEND_URL → list of exact origins.

    Accepts a COMMA-SEPARATED list, because one deployment legitimately has more than one
    front door (the production domain plus a custom domain, say). Each entry is
    normalised: surrounding whitespace and any trailing slash are removed.

    That normalisation is not cosmetic. A CORS origin match is a byte-for-byte string
    comparison against the browser's `Origin` header, which NEVER carries a trailing slash
    or a path. Pasting "https://app.example.com/" out of the address bar therefore matches
    nothing, every preflight is answered 400, and the whole application goes dark from the
    browser's point of view while the server itself looks perfectly healthy in the logs.
    That exact outage is why this function exists.
    """
    return [o.strip().rstrip("/") for o in (raw or "").split(",") if o.strip()]


_frontend_origins = _parse_origins(FRONTEND_URL)
_allow_all_origins = "*" in _frontend_origins

_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
if not _allow_all_origins:
    _origins.extend(_frontend_origins)
if _local_ip:
    _origins.append(f"http://{_local_ip}:3000")
# De-duplicate, order preserved: FRONTEND_URL and the LOCAL_IP origin are the same string on a
# LAN-testing machine, and a repeated entry only makes the startup log harder to read.
_origins = list(dict.fromkeys(_origins))

# Compress responses to cut egress. JSON payloads
# like /api/gantt/data are highly repetitive → gzip shrinks
# them ~80-90%. Only bodies ≥ 1 KB are compressed (tiny replies aren't worth it).
# Browsers/EventSource decompress transparently, so SSE and normal JSON both work.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allow_all_origins else _origins,
    allow_credentials=not _allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers the browser must let JS read cross-origin. Without
    # this, the frontend cannot see X-Admin-Unlock-Required (admin-unlock modal never
    # triggers) nor X-Locked-Out (lockout revocation/notice never fires).
    expose_headers=["X-Admin-Unlock-Required", "X-Locked-Out", "X-Blocked", "X-Blocked-Reason",
                    "X-Server-Offline"],
)

# Wildcard CORS in production is a hardening gap (any web origin may attempt
# token-bearing calls). Data is still protected by bearer auth, but FRONTEND_URL
# should be pinned to the exact frontend origin. Warn loudly if left as "*".
if _allow_all_origins and ENVIRONMENT == "production":
    logger.warning(
        "[security] CORS allow_origins='*' in production — set FRONTEND_URL to the "
        "exact frontend origin (e.g. https://app.example.com)."
    )

# Always state the effective allow-list at boot. A mis-set FRONTEND_URL does not crash
# anything and does not look like an error: the service starts, answers /health, and the
# keepalive cron stays green, while every browser preflight is refused with a bare 400 and
# the app is unusable. Printing the list once turns "the backend is down" into a one-line
# diagnosis in the deploy log.
logger.info(
    "[cors] effective allow_origins=%s (credentials=%s) from FRONTEND_URL=%r",
    "*" if _allow_all_origins else _origins, not _allow_all_origins, FRONTEND_URL,
)
if ENVIRONMENT == "production" and not _allow_all_origins and not any(
    o.startswith("https://") for o in _origins
):
    logger.error(
        "[cors] production has NO https origin allowed — FRONTEND_URL=%r yields %s. "
        "Every cross-origin preflight will be answered 400 and the frontend cannot call "
        "this API. Set FRONTEND_URL to the exact origin, scheme included, no trailing "
        "slash (comma-separate several).", FRONTEND_URL, _origins,
    )


# ── Security response headers (defense-in-depth on the API surface) ──────────
# The Next.js frontend already sets CSP + hardening headers on its OWN origin
# (frontend/next.config.ts). The API responses were missing an equivalent baseline, so
# per-user JSON (/permissions/me, error bodies) could be
# written to a shared/browser DISK cache and read later, MIME-sniffed, or framed. This adds
# the matching minimum:
#   • Cache-Control: no-store — the highest-value item: API payloads are per-user and often
#     sensitive, so they must never be persisted by any cache (browser, proxy, back-button).
#   • X-Content-Type-Options / Referrer-Policy / X-Frame-Options — cheap, always-safe.
#   • Server — collapsed to a neutral value so the uvicorn/Starlette version isn't advertised.
# setdefault() means an endpoint that deliberately sets one of these (none do today) still wins.
_SECURITY_HEADERS = {
    "Cache-Control":          "no-store",
    "Pragma":                 "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy":        "strict-origin-when-cross-origin",
    "X-Frame-Options":        "DENY",
}


@app.middleware("http")
async def _apply_security_headers(request, call_next):
    response = await call_next(request)
    for _k, _v in _SECURITY_HEADERS.items():
        response.headers.setdefault(_k, _v)
    # A refused CORS preflight is logged by uvicorn as a naked `OPTIONS … 400`, with the
    # reason only in a response body nobody reads — indistinguishable from a malformed
    # request, and the symptom is a total (but silent) frontend outage. Name the origin
    # that was refused so the next occurrence is diagnosed from the log alone.
    if request.method == "OPTIONS" and response.status_code == 400:
        logger.warning(
            "[cors] preflight REFUSED for origin=%r path=%s — allowed=%s (check FRONTEND_URL)",
            request.headers.get("origin", ""), request.url.path,
            "*" if _allow_all_origins else _origins,
        )
    # Strip server-version disclosure (uvicorn/Starlette default banner).
    if "server" in response.headers:
        response.headers["server"] = "Taktline"
    return response


# ── Base auth dependency (identity + active-account enforcement) ─────────────
# Every route depends on `require_auth`. We WRAP the raw Azure/JWT validation
# (services.auth.require_auth, imported as _base_require_auth) so that a single
# definition additionally denies BLOCKED accounts everywhere — no per-route edits.
# A blocked user is authenticated by Azure AD but denied the whole application
# (403 + X-Blocked). Superadmins can never be blocked. The block check
# (_enforce_not_blocked) is defined later in the module and resolves at call time.
#
# NOTE: /api/permissions/me intentionally uses _base_require_auth (the raw one), so
# a blocked user can still fetch their own status and be shown the access-denied page.
#
# The same wrapper also enforces the deliberate-shutdown switch (_enforce_server_offline):
# with the app switched off, every protected route is refused for non-admins, so "desativado"
# is an actual denial of the application and not a screen the client chooses to draw.
async def require_auth(request: Request, user: dict = Depends(_base_require_auth)) -> dict:
    _enforce_not_blocked(user)
    _enforce_server_offline(request, user)
    _touch_user_activity(_username_of((user or {}).get("email", "")))
    return user


# ── Owner-only API docs (HTTP Basic Auth) ────────────────────────────────────
# The public Swagger/OpenAPI is disabled (see FastAPI(...) above). These custom
# routes re-expose /docs, /redoc and /openapi.json but ONLY to whoever holds the
# DOCS_USER / DOCS_PASSWORD credentials — a SEPARATE secret from the app's Azure
# login, so ordinary users cannot reach them. A
# browser navigation to /docs triggers the native Basic-Auth prompt; the browser
# reuses the same credentials for the /openapi.json fetch Swagger UI then makes.
# If the env vars are unset, the docs behave as if they don't exist (404).
import secrets as _secrets
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html

_docs_basic   = HTTPBasic(auto_error=False)
DOCS_USER     = os.getenv("DOCS_USER", "")
DOCS_PASSWORD = os.getenv("DOCS_PASSWORD", "")
# Opt-in owner override: expose the docs in PRODUCTION behind Basic Auth WITHOUT
# weakening any other production guard (ENVIRONMENT stays "production"). Defaults OFF
# — with this unset, production docs remain 404 for everyone, exactly as before.
_DOCS_ALLOW_IN_PROD = os.getenv("DOCS_ALLOW_IN_PROD", "").strip().lower() in ("1", "true", "yes", "on")


def _require_docs_owner(
    credentials: HTTPBasicCredentials | None = Depends(_docs_basic),
) -> bool:
    """Gate the docs behind an owner-only user/password (constant-time compared).

    Production: docs are 404 for everyone BY DEFAULT. The owner may opt in by setting
    DOCS_ALLOW_IN_PROD=1 together with DOCS_USER/DOCS_PASSWORD — then /docs is reachable
    ONLY behind the owner Basic-Auth prompt, and every other production protection is
    untouched. With the flag unset, the API surface can never be enumerated in prod.

    Non-production: available to the owner via Basic Auth (DOCS_USER/DOCS_PASSWORD).
    Unconfigured (missing either) ⇒ 404, i.e. the docs stay off.
    """
    docs_configured = bool(DOCS_USER and DOCS_PASSWORD)
    if ENVIRONMENT == "production":
        # 404 unless the owner explicitly opted in AND set credentials.
        if not (_DOCS_ALLOW_IN_PROD and docs_configured):
            raise HTTPException(status_code=404, detail="Not Found")
    elif not docs_configured:
        raise HTTPException(status_code=404, detail="Not Found")
    ok = (
        credentials is not None
        and _secrets.compare_digest(credentials.username, DOCS_USER)
        and _secrets.compare_digest(credentials.password, DOCS_PASSWORD)
    )
    if not ok:
        # 401 + WWW-Authenticate makes the browser show its native login prompt.
        raise HTTPException(
            status_code=401,
            detail="Não autorizado.",
            headers={"WWW-Authenticate": "Basic"},
        )
    return True


@app.get("/openapi.json", include_in_schema=False)
def owner_openapi(_owner: bool = Depends(_require_docs_owner)):
    return app.openapi()


@app.get("/docs", include_in_schema=False)
def owner_docs(_owner: bool = Depends(_require_docs_owner)):
    return get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} — Docs")


@app.get("/redoc", include_in_schema=False)
def owner_redoc(_owner: bool = Depends(_require_docs_owner)):
    return get_redoc_html(openapi_url="/openapi.json", title=f"{app.title} — ReDoc")


# ── Secondary administrative factor ("unlock") ───────────────────────────────
# Authentication (Azure) only proves IDENTITY. Sensitive operations additionally
# require AUTHORIZATION (role) AND a second factor: the user supplies a dedicated
# ADMIN_PASSWORD once, receives a short-lived signed grant, and the frontend
# replays it in the  X-Admin-Unlock  header for ~15 minutes ("unlock once per
# session"). This is a SEPARATE secret from IMPORT_PASSWORD (which still gates the
# Excel imports / override edits) so the admin factor rotates independently.
import base64 as _b64
import hashlib as _hashlib
import hmac as _hmac
import time as _utime
from fastapi import Security
from fastapi.security import APIKeyHeader

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "").strip()
_unlock_header = APIKeyHeader(name="X-Admin-Unlock", auto_error=False)


def _unlock_secret() -> bytes:
    """HMAC key for unlock grants, derived from ADMIN_PASSWORD so that rotating the
    password immediately invalidates every outstanding grant."""
    return _hashlib.sha256(("taktline-unlock|" + ADMIN_PASSWORD).encode("utf-8")).digest()




def _verify_unlock_token(token: str, email: str) -> bool:
    try:
        b64_part, sig = token.split(".", 1)
        payload = _b64.urlsafe_b64decode(b64_part.encode("ascii")).decode("utf-8")
        tok_email, exp_str = payload.rsplit("|", 1)
        expected = _hmac.new(_unlock_secret(), payload.encode("utf-8"), _hashlib.sha256).hexdigest()
        if not _hmac.compare_digest(sig, expected):
            return False
        if not _hmac.compare_digest(tok_email, email or ""):
            return False
        return int(exp_str) >= int(_utime.time())
    except Exception:
        return False


def _enforce_unlock(user: dict, token: str | None) -> None:
    """Raise unless the request carries a valid, unexpired unlock grant for this user.

    FAILS CLOSED in production: if ADMIN_PASSWORD is unset, sensitive operations are
    refused (503). In development an unset password is a no-op for convenience."""
    # A locked-out user is suspended from sensitive ops even if they hold a grant.
    _check_pw_lockout(user)
    if not ADMIN_PASSWORD:
        if ENVIRONMENT == "production":
            raise HTTPException(status_code=503, detail="Operação bloqueada: ADMIN_PASSWORD não configurado no servidor.")
        return
    email = (user or {}).get("email", "")
    if not token or not _verify_unlock_token(token, email):
        raise HTTPException(
            status_code=401,
            detail="Ação sensível bloqueada: desbloqueio administrativo necessário.",
            headers={"X-Admin-Unlock-Required": "1"},
        )




def require_editor_unlock(
    request: Request,
    user: dict = Depends(require_auth),
    token: str | None = Security(_unlock_header),
) -> dict:
    """Authorization (Editor+) AND the second factor. _current_role is defined later
    in the module; the name resolves at call time so forward-reference is fine."""
    _check_pw_lockout(user)  # locked → generic 429 (wins over role / second-factor errors)
    if _current_role(user) not in ("editor", "admin"):
        _record_perm_denied(user, request, "editor")
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    _enforce_unlock(user, token)
    return user






# Role-only gates (no second factor). Defined HERE, beside the other dependencies, rather
# than further down the module: a `Depends(...)` default is evaluated when the route is
# decorated, so a handler declared above the definition would fail at import with a
# NameError. (`_current_role` is still a forward reference, but that one resolves at call
# time inside the body, which is fine.)




# ── Brute-force protection: per-user rate limit + failed-password lockout ─────
# In-memory (a single instance; counters reset on restart — acceptable). All
# keyed on the caller's stable identity (oid, falling back to email). Two layers:
#   • rate limit  — caps request VOLUME per minute (any outcome) on password routes;
#   • lockout     — after 5 CONSECUTIVE wrong passwords (admin OR import) the user is
#                   blocked from all sensitive ops for 15 min, then auto-recovers.
_PW_FAIL_MAX   = 5
_PW_LOCKOUT_S  = 15 * 60
_RL_WINDOW_S   = 60
_RL_MAX        = 10          # max password-route attempts per user per minute
# In-memory copies are a FALLBACK only (used when the DB is unavailable). The
# authoritative store is the `auth_throttle` table so the lockout/rate-limit survive
# restarts, redeploys, and scale-to-zero cold starts (see AuthThrottle).
_pw_fail_counts: dict[str, int]   = {}
_pw_lockout_until: dict[str, float] = {}
_rl_hits: dict[str, list[float]]  = {}
_pw_lock = threading.Lock()

# Bucket name for the shared failed-password lockout row (distinct from the
# rate-limit buckets 'unlock' / 'import', which live in the same table).
_LOCK_BUCKET = "_lock_"


def _pw_user_key(user: dict) -> str:
    return str((user or {}).get("oid") or (user or {}).get("email") or "?")


def _throttle_row(db, bucket: str, key: str):
    """Fetch the persisted throttle row for (bucket, key), or None."""
    return (
        db.query(AuthThrottle)
        .filter(AuthThrottle.bucket == bucket, AuthThrottle.key == key)
        .first()
    )


# Generic lockout message — deliberately discloses NO duration, retry time, countdown,
# or whether the block is temporary or permanent (revealing any of these would help an
# attacker time their attempts). The frontend shows its own generic copy on X-Locked-Out.
_LOCKOUT_DETAIL = (
    "Acesso a esta operação foi revogado. "
    "Contate um administrador se você acredita que isso é um engano."
)


def _is_locked_out(user: dict) -> bool:
    """True while the user is within the failed-password lockout window. Auto-clears an
    expired lockout (and its stale failure counter). Never raises — safe for role checks.

    Authoritative source is the persisted `auth_throttle` row; the in-memory dict is a
    fallback for when the DB is unavailable."""
    key = _pw_user_key(user)
    now = _utime.time()
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                row = _throttle_row(db, _LOCK_BUCKET, key)
                if row is None:
                    return False
                until = row.lockout_until or 0.0
                if until > now:
                    return True
                if until:
                    # A lockout existed and has now EXPIRED → clear it and the counter so
                    # the ladder restarts. (Do NOT clear on fail_count alone: that would
                    # reset the consecutive-failure count on every check between guesses
                    # and the lockout would never trip.)
                    row.lockout_until = None
                    row.fail_count = 0
            return False
        except Exception as exc:
            logger.warning("[auth] lockout read fell back to memory: %s", exc)
    with _pw_lock:
        until = _pw_lockout_until.get(key, 0.0)
        if until > now:
            return True
        if until:
            _pw_lockout_until.pop(key, None)
            _pw_fail_counts.pop(key, None)
    return False


def _check_pw_lockout(user: dict) -> None:
    """Raise a generic 429 while the user is locked out (no duration disclosed).

    The X-Locked-Out header lets the frontend recognise a lockout (vs. an ordinary
    429) so it can revoke the UI, close password dialogs, and block further attempts."""
    if _is_locked_out(user):
        raise HTTPException(
            status_code=429,
            detail=_LOCKOUT_DETAIL,
            headers={"X-Locked-Out": "1"},
        )


_RL_DETAIL = "Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente."


def _rate_limit(user: dict, bucket: str, max_hits: int | None = None) -> None:
    """Sliding-window per-user rate limit for a named bucket (raises 429).

    Persisted in `auth_throttle` so the window isn't wiped by a restart / cold start;
    the in-memory window is the fallback path when the DB is unavailable.

    `max_hits` overrides the default ceiling for buckets whose key is not one person.
    The per-IP login bucket is the reason it exists: _RL_MAX is calibrated for "one user,
    one password prompt", and behind corporate NAT an entire plant shares a single source
    address — ten attempts a minute is a shift change, not an attack."""
    key = _pw_user_key(user)
    cap = int(max_hits or _RL_MAX)
    now = _utime.time()
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                row = _throttle_row(db, bucket, key)
                hits: list[float] = []
                if row is not None and row.hits_json:
                    try:
                        hits = [float(t) for t in json.loads(row.hits_json)]
                    except Exception:
                        hits = []
                hits = [t for t in hits if now - t < _RL_WINDOW_S]
                if len(hits) >= cap:
                    retry = int(_RL_WINDOW_S - (now - hits[0])) + 1
                    raise HTTPException(
                        status_code=429, detail=_RL_DETAIL,
                        headers={"Retry-After": str(retry)},
                    )
                hits.append(now)
                if row is None:
                    row = AuthThrottle(bucket=bucket, key=key)
                    db.add(row)
                row.hits_json = json.dumps(hits)
            return
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("[auth] rate-limit fell back to memory: %s", exc)
    mkey = f"{bucket}:{key}"
    with _pw_lock:
        hits = [t for t in _rl_hits.get(mkey, []) if now - t < _RL_WINDOW_S]
        if len(hits) >= cap:
            retry = int(_RL_WINDOW_S - (now - hits[0])) + 1
            raise HTTPException(
                status_code=429, detail=_RL_DETAIL,
                headers={"Retry-After": str(retry)},
            )
        hits.append(now)
        _rl_hits[mkey] = hits


def _record_pw_failure(user: dict) -> bool:
    """Count a wrong-password attempt; lock the user out after _PW_FAIL_MAX in a row.
    Returns True iff THIS attempt tripped the lockout (so callers can decide 429-vs-403
    without a second `_is_locked_out` DB read — the caller already passed `_check_pw_lockout`,
    so a fresh trip is the only way the user can now be locked out).

    Persisted in `auth_throttle` so consecutive-failure counting can't be reset by a
    restart / cold start between guesses; the in-memory counter is the fallback path."""
    key = _pw_user_key(user)
    now = _utime.time()
    tripped = False
    persisted = False
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                row = _throttle_row(db, _LOCK_BUCKET, key)
                if row is None:
                    row = AuthThrottle(bucket=_LOCK_BUCKET, key=key, fail_count=0)
                    db.add(row)
                    db.flush()
                # A previously-expired lockout restarts the ladder from zero.
                if row.lockout_until and row.lockout_until <= now:
                    row.lockout_until = None
                    row.fail_count = 0
                n = (row.fail_count or 0) + 1
                if n >= _PW_FAIL_MAX:
                    row.lockout_until = now + _PW_LOCKOUT_S
                    row.fail_count = 0   # counter handed over to the lockout timer
                    tripped = True
                else:
                    row.fail_count = n
            persisted = True
        except Exception as exc:
            logger.warning("[auth] failure-count fell back to memory: %s", exc)
    if not persisted:
        with _pw_lock:
            n = _pw_fail_counts.get(key, 0) + 1
            if n >= _PW_FAIL_MAX:
                _pw_lockout_until[key] = now + _PW_LOCKOUT_S
                _pw_fail_counts.pop(key, None)
                tripped = True
            else:
                _pw_fail_counts[key] = n
    # The tripped lockout is ALSO recorded permanently on the user's roster row
    # (count + timestamp + audit event) so admins can see who repeatedly triggers the
    # control even after the 15-min window expires.
    if tripped:
        logger.warning("[auth] Password lockout for %s", key)
        _persist_lockout_event(user)
    return tripped


def _reset_pw_failures(user: dict) -> None:
    """Clear the failure counter (and any lockout) after a correct password."""
    key = _pw_user_key(user)
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                row = _throttle_row(db, _LOCK_BUCKET, key)
                if row is not None:
                    row.fail_count = 0
                    row.lockout_until = None
        except Exception as exc:
            logger.warning("[auth] failure-reset persist failed: %s", exc)
    with _pw_lock:
        _pw_fail_counts.pop(key, None)
        _pw_lockout_until.pop(key, None)



class OptimizationPayload(BaseModel):
    items: list[dict] = []
    top_pct: float = 90.0
    ot_day_limit_pct: float = 60.0
    solver_backend: str = "gurobi"
    phase_limit: int = 6
    gap_pct: float = 1.0
    time_limit_s: float = 60.0
    ndias: float = 5.0
    # Fiscal weeks of the imported period. `ndias` is only their COUNT; the FWs themselves are
    # what let the server resolve real dates and intersect them with vacation ranges.
    fws: list[str] = []
    demand_by_wsn: dict[str, float] = {}
    wsn_max_people: dict[str, int] = {}
    wsn_max_hours:  dict[str, float] = {}
    wsn_max_turnos: dict[str, int] = {}
    disabled_wsns: list[str] = []
    person_availability_pct: dict[str, float] = {}
    blocked_pairs: list[list[str]] = []
    required_pair_presence: list[list[str]] = []
    forced_pair_headcount: dict[str, float] = {}
    direct_pair_headcount: dict[str, float] = {}
    fixed_pair_ot_pct: dict[str, float] = {}
    max_pair_pct: dict[str, float] = {}
    max_pair_ot_pct: dict[str, float] = {}
    use_all_headcount: bool = False  # force allocation of every eligible person
    # Apply the expertise matrix to this run: a pair below its workstation's target level is
    # PRICED in the phase-4 objective, never removed — people under the target stay allocatable
    # and are simply chosen last. Off ⇒ the model is exactly the one this app has always solved.
    expertise_enabled: bool = False
    # Sub-flag, only meaningful with the above: additionally require a proficient person on any
    # workstation that opens with 2+ candidates. SEPARATE because it is the only piece of this
    # feature that is a HARD constraint, and so the only one that can make the model infeasible.
    # Defaults off so turning expertise on is a reversible, measurable step.
    expertise_anchor: bool = False
    # Sub-flag, only meaningful with expertise_enabled: make the level change how fast the work
    # goes, not only who is chosen for it. A pair below its station's target closes less than an
    # hour of demand per hour worked, one above it closes more (see EXPERTISE_SPEED). SEPARATE
    # and off by default because it is the only piece of the feature that touches phase 1: it
    # moves the coverage number itself, so a run with it on is not comparable to one without.
    expertise_speed: bool = False


# ── Utilitários ─────────────────────────────────────────────────

def _update_job(job_id: str, **kwargs):
    """Atualiza o estado do job e notifica WebSockets."""
    if job_id not in jobs:
        jobs[job_id] = _load_job(job_id) or {}
    jobs[job_id].update(kwargs)


def _append_job_log(job_id: str, line: str) -> None:
    """Appends one line to the in-memory job log (keeps last 300 lines)."""
    if job_id not in jobs:
        jobs[job_id] = _load_job(job_id) or {}
    cur = jobs[job_id].get("log") or []
    if not isinstance(cur, list):
        cur = []
    cur.append(line)
    jobs[job_id]["log"] = cur[-300:]




def _public_job_data(data: dict | None) -> dict:
    if not data:
        return {}
    return {k: v for k, v in data.items() if not k.startswith('_')}


# _persist_job is GONE, and its call sites with it. It mirrored job state to
# backend/.job_state/<id>.json on every progress tick — the fast path for a deployment where a
# second worker had to read a job it did not own. This build is one process against a throwaway
# database, so the file was a second copy of state `_persist_job_to_db` already holds, and it was
# a write path driven by whatever a visitor clicks. The solver now writes no files at all.


def _persist_job_to_db(job_id: str) -> None:
    """Slow path: write job state to DB for cross-worker visibility.
    Call only at job creation and terminal states (done/error/cancelled).
    Must be called from a thread (not from the async event loop) to avoid blocking."""
    if not _DB_AVAILABLE:
        return
    raw = jobs.get(job_id)
    if not raw:
        return
    json_str = json.dumps(_public_job_data(raw), ensure_ascii=False)
    try:
        from datetime import datetime, timezone as _tz
        with get_db() as db:
            existing = db.query(SolverJob).filter(SolverJob.job_id == job_id).first()
            if existing:
                existing.data = json_str
                existing.updated_at = datetime.now(_tz.utc)
            else:
                db.add(SolverJob(job_id=job_id, data=json_str,
                                 updated_at=datetime.now(_tz.utc)))
            db.commit()
    except Exception as exc:
        logger.warning("[jobs] Falha ao persistir job no DB: %s", exc)


def _load_job(job_id: str) -> dict | None:
    """Read a job this process no longer holds in memory — after a prune, or a reconnect."""
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                row = db.query(SolverJob).filter(SolverJob.job_id == job_id).first()
                if row:
                    data = json.loads(row.data)
                    return data if isinstance(data, dict) else None
        except Exception as exc:
            logger.warning("[jobs] Falha ao carregar job do DB: %s", exc)

    return None


def _job_payload(job_id: str) -> dict:
    """Returns a JSON-serializable snapshot of a job (excludes internal _ keys)."""
    raw = jobs.get(job_id)
    if raw:
        return _public_job_data(raw)
    persisted = _load_job(job_id)
    if persisted:
        jobs[job_id] = persisted.copy()
        return _public_job_data(persisted)
    return {}


async def _broadcast(job_id: str, data: dict):
    """Envia dados para todos os WebSockets conectados ao job via suas filas."""
    payload = {k: v for k, v in data.items() if not k.startswith('_')}
    if not payload:
        return
    for q in list(ws_queues.get(job_id, [])):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass  # Drop if queue is saturated (shouldn't happen in practice)


@app.get("/api/gurobi-check")
def gurobi_check(_user: dict = Depends(require_auth)):
    """
    Verifica se o Gurobi está disponível e a licença é válida.
    Retorna { available: bool, version: str | null, message: str }.
    """
    return check_gurobi()


@app.get("/api/test-gurobi")
def test_gurobi(_user: dict = Depends(require_auth)):
    """
    Executa um modelo mínimo para validar import + runtime + licença do Gurobi.
    Útil para diagnosticar problemas de deploy.
    """
    try:
        import gurobipy as gp
        from gurobipy import GRB

        m = gp.Model("_api_test")
        m.Params.OutputFlag = 0
        x = m.addVar(lb=0.0, name="x")
        m.setObjective(x, GRB.MAXIMIZE)
        m.addConstr(x <= 5.0)
        m.optimize()

        status = int(m.Status)
        obj = float(m.ObjVal) if status == GRB.OPTIMAL else None
        m.dispose()

        return {
            "ok": True,
            "status": status,
            "obj": obj,
            "message": "Modelo de teste executado com sucesso.",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "message": "Falha ao executar modelo mínimo do Gurobi.",
        }






























@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/me")
async def me(user: dict = Depends(require_auth)):
    """Returns the authenticated user's profile extracted from the Azure ID token."""
    return {
        "email":      user["email"],
        "name":       user["name"],
        "given_name": user.get("given_name", ""),
        "family_name": user.get("family_name", ""),
        "oid":        user.get("oid", ""),
    }


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, _user: dict = Depends(require_auth)):
    job = _job_payload(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return JSONResponse(
        content=job,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# ── Demo limits on the solver ─────────────────────────────────────────────────────────────
# The solver is the thing worth showing here and also the only expensive thing in the app, so
# it is the one surface a visitor can use to cost the host real money. The Editor role gate
# that used to stand here is meaningless now: every visitor signs in as the same account, so
# the role answers a question nobody is asking. What has to be bounded is the RUN.
#
# Four limits, each closing a different hole, applied in this order:
#   • SIZE     — the payload's collections are capped so a crafted request cannot build a model
#                far larger than the demo dataset can produce. optimizer.MODEL_MAX_VARS is the
#                backstop behind this one. FIRST because it is deterministic and costs nothing:
#                a malformed request must not burn the caller's cooldown before being told so.
#   • DEPTH    — ONE run at a time for the whole process, not per user. A second request is
#                refused rather than queued: a queue that a visitor can fill is the same
#                problem with a delay in front of it.
#   • INTERVAL — a per-caller cooldown, so refusing concurrency does not turn into a tight
#                retry loop that keeps the single slot permanently occupied.
#   • TIME     — every run is clamped to DEMO_TIME_LIMIT_S regardless of what the client asks
#                for. The payload field stays (the UI shows it) but the server decides.
#
# None of it is authorization. It is a cost ceiling, and it is deliberately generous enough
# that an honest visitor never meets it.
DEMO_TIME_LIMIT_S     = 5.0
DEMO_MAX_ITEMS        = 400
DEMO_MAX_MAP_ENTRIES  = 400
DEMO_MIN_INTERVAL_S   = 15.0
_ACTIVE_JOB_STATES    = ("queued", "running")

_demo_last_start: dict[str, float] = {}
_demo_start_lock = threading.Lock()


def _demo_caller_key(request: Request, user: dict) -> str:
    """Who the cooldown applies to. The account is shared, so the client address is the only
    thing separating one visitor from another; the username rides along so a proxy that
    collapses everyone onto one address still separates sessions where it can."""
    host = (request.client.host if request.client else "") or "?"
    return f"{host}|{_username_of((user or {}).get('email', ''))}"


def _enforce_demo_solver_limits(payload: "OptimizationPayload", request: Request, user: dict) -> None:
    """Clamp the run and refuse a second one. Raises HTTPException; mutates `payload` in place."""
    # ── SIZE ──
    if len(payload.items) > DEMO_MAX_ITEMS:
        raise HTTPException(
            status_code=413,
            detail=f"Otimização limitada a {DEMO_MAX_ITEMS} itens nesta demonstração.",
        )
    for field in ("demand_by_wsn", "wsn_max_people", "wsn_max_hours", "wsn_max_turnos",
                  "person_availability_pct", "forced_pair_headcount", "direct_pair_headcount",
                  "fixed_pair_ot_pct", "max_pair_pct", "max_pair_ot_pct"):
        if len(getattr(payload, field, {}) or {}) > DEMO_MAX_MAP_ENTRIES:
            raise HTTPException(
                status_code=413,
                detail=f"Parâmetro '{field}' excede o limite desta demonstração.",
            )

    # ── DEPTH: one at a time, process-wide ──
    active = [jid for jid, j in jobs.items() if (j or {}).get("status") in _ACTIVE_JOB_STATES]
    if active:
        raise HTTPException(
            status_code=429,
            detail="Já existe uma otimização em andamento. Esta demonstração executa uma por vez.",
        )

    # ── INTERVAL: per caller ──
    key = _demo_caller_key(request, user)
    now = _utime.monotonic()
    with _demo_start_lock:
        last = _demo_last_start.get(key, 0.0)
        wait = DEMO_MIN_INTERVAL_S - (now - last)
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Aguarde {int(wait) + 1}s antes de iniciar outra otimização.",
            )
        _demo_last_start[key] = now
        # The map is unbounded only in theory: one entry per client address, dropped once it is
        # older than the cooldown it exists to enforce.
        for k, t in list(_demo_last_start.items()):
            if now - t > DEMO_MIN_INTERVAL_S * 4:
                _demo_last_start.pop(k, None)

    # ── TIME: the server decides, whatever the client asked for ──
    payload.time_limit_s = min(float(payload.time_limit_s or DEMO_TIME_LIMIT_S), DEMO_TIME_LIMIT_S)
    payload.phase_limit = max(1, min(int(payload.phase_limit or 6), 6))


@app.post("/api/optimize")
async def start_optimization(
    payload: OptimizationPayload,
    background_tasks: BackgroundTasks,
    request: Request,
    _user: dict = Depends(require_auth),
):
    _enforce_demo_solver_limits(payload, request, _user)
    if payload.solver_backend.lower() == "gurobi":
        chk = check_gurobi()
        if not chk.get("available", False):
            raise HTTPException(
                status_code=503,
                detail=(
                    "Gurobi indisponível no backend. "
                    f"Diagnóstico: {chk.get('message', 'erro desconhecido')}"
                ),
            )

    _prune_jobs()                          # evict old finished jobs before adding one
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status":   "queued",
        "progress": 0,
        "message":  "Aguardando início...",
        "result":   None,
        "error":    None,
        "log":      [f"[SETUP] Job {job_id} recebido (backend={payload.solver_backend})."],
    }
    # Write to DB in a thread so we don't block the event loop.
    # This makes the job visible to _load_job on any worker even before the WS connects.
    import threading as _threading
    _threading.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()
    background_tasks.add_task(_run_optimization_job, job_id, payload)
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/optimize/{job_id}")
def cancel_job(job_id: str, _user: dict = Depends(require_auth)):
    # No role check, deliberately: with one shared account there is no second user whose run
    # this could kill, and the run it does kill is the one occupying the single slot the demo
    # allows. Cancelling has to stay at least as reachable as starting.
    if job_id not in jobs:
        persisted = _load_job(job_id)
        if persisted is not None:
            jobs[job_id] = persisted
    if job_id in jobs:
        jobs[job_id]["status"] = "cancelled"
        jobs[job_id]["message"] = "Execução cancelada pelo usuário."
        import threading as _t; _t.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()
        stop_ev = jobs[job_id].get("_stop_event")
        if stop_ev is not None:
            stop_ev.set()
    return {"cancelled": True}


# ── Ingestão de dados ────────────────────────────────────────────
#
# Upload limits. Every route below used to call `await file.read()` (or copyfileobj) with no
# ceiling of any kind: no Content-Length check, no byte cap, no ASGI body limit. One authenticated
# any signed-in account — Reader included, since /api/gantt/scenario is deliberately open to Readers —
# could exhaust the container's memory with a single POST. `_SCENARIO_CACHE_MAX_BYTES`
# bounds the scenario CACHE, not the request that fills it, so it never helped here.
#
# Two layers, because either one alone leaves a hole:
#   • Content-Length is checked first, so an oversized upload is refused before the body is
#     transferred. It is a courtesy to the client and saves the egress — but it is a client-
#     supplied header, so it is an optimisation, never the control.
#   • The read loop is the control. It counts what actually arrives and aborts the moment the
#     cap is passed, whatever the header claimed (or omitted — a chunked upload has no
#     Content-Length at all).
#
# 40 MB against real files: the largest base imported here is a few MB, and the scenario
# workbook is smaller. Override with UPLOAD_MAX_BYTES if a genuine file ever outgrows it.
















@app.get("/api/excel-items")
def excel_items(
    ano:   int | None = Query(default=None, description="Filtrar por ano"),
    mes:   int | None = Query(default=None, description="Filtrar por mês (1-12)"),
    meses: str | None = Query(default=None, description="Filtrar por múltiplos meses, separados por vírgula"),
    fw:    str | None = Query(default=None, description="Filtrar por FW único (semanal)"),
    fws:   str | None = Query(default=None, description="FWs separadas por vírgula (mensal)"),
    mode:  str        = Query(default="mensal", description="semanal | mensal"),
    _user: dict = Depends(require_auth),
):
    fws_list   = [f.strip() for f in fws.split(",") if f.strip()] if fws else None
    meses_list = [int(m.strip()) for m in meses.split(",") if m.strip().isdigit()] if meses else None
    result = get_items_for_import(_demand_df(), ano=ano, mes=mes, meses=meses_list,
                                  fw=fw, fws=fws_list, mode=mode)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


@app.get("/api/items-catalog")
def items_catalog(
    areas:    str | None = Query(default=None, description="Filtrar por áreas (vírgula)"),
    familias: str | None = Query(default=None, description="Filtrar por famílias (vírgula)"),
    clientes: str | None = Query(default=None, description="Filtrar por clientes (vírgula)"),
    _user: dict = Depends(require_auth),
):

    def _parse(v: str | None) -> list[str] | None:
        if not v:
            return None
        lst = [x.strip() for x in v.split(",") if x.strip()]
        return lst or None

    result = get_items_catalog(
        _demand_df(),
        areas=_parse(areas),
        familias=_parse(familias),
        clientes=_parse(clientes),
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


@app.get("/api/assembly-details")
def assembly_details(
    items: str = Query(description="Códigos de itens separados por vírgula"),
    mes:   int | None = Query(default=None, description="Mês (1-12)"),
    fws:   str | None = Query(default=None, description="FWs separadas por vírgula"),
    mode:  str        = Query(default="mensal", description="semanal | mensal"),
    tipo_filter: str  = Query(default="", description="Tipo FW a filtrar (vazio = todos)"),
    _user: dict = Depends(require_auth),
):
    item_list = [i.strip() for i in items.split(",") if i.strip()]
    if not item_list:
        raise HTTPException(status_code=400, detail="Lista de itens vazia.")
    fws_list = [f.strip() for f in fws.split(",") if f.strip()] if fws else None
    result = get_assembly_details(
        _demand_df(),
        items=item_list,
        mes=mes,
        fws=fws_list,
        mode=mode,
        tipo_filter=tipo_filter.strip(),
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


#: Cap on explicit-demand items per request — the largest realistic Carga de Fábrica period
#: is a few hundred part numbers; anything beyond this is a malformed or abusive payload.
_ASM_EXPLICIT_MAX_ITEMS = 2000


@app.post("/api/assembly-details/explicit")
def assembly_details_explicit(
    body: dict = Body(default={}),
    _user: dict = Depends(require_auth),
):
    """
    Same per-scope breakdown as GET /api/assembly-details, but the DEMAND (which items and
    how many) is supplied by the caller instead of being looked up in this dataset's
    period-filtered rows.

    For the Carga de Fábrica source: its items come from the loaded schedule, so they have no
    monthly-plan rows for those fiscal weeks. The GET route drops exactly those items ("no
    demand rows in this period"), which is why they surfaced with no operations and no hours
    despite being mapped in ASSEMBLY. Hours, WSNs and operations are still resolved by the
    SAME ASSEMBLY lookup — only the quantity and the operation-type selection come from the
    request.

    Body: {"items": [{"item": str, "qty": float, "tipos": [str, ...],
                      "tipo_qty": {tipo: float, ...}}, ...]}

    `qty` is the UNIT count and `tipo_qty` the per-operation-type split of it. They are not
    two views of the same number: an item with 5 PERITAGEM and 5 MONTAGEM is 5 units passing
    through both steps, so qty=5 while tipo_qty sums to 10. `tipo_qty` is optional; without it
    the whole qty drives every operation, which is what inflated hours for multi-ESCOPO items.
    """
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(status_code=400, detail="Lista de itens vazia.")
    if len(raw_items) > _ASM_EXPLICIT_MAX_ITEMS:
        raise HTTPException(status_code=400, detail="Lista de itens muito grande.")

    codes: list[str] = []
    demand: dict[str, dict] = {}
    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        code = str(entry.get("item") or "").strip()
        if not code:
            continue
        try:
            qty = float(entry.get("qty") or 0.0)
        except (TypeError, ValueError):
            qty = 0.0
        tipos_raw = entry.get("tipos")
        tipos = [str(t).strip() for t in tipos_raw if str(t).strip()] if isinstance(tipos_raw, list) else []
        # Per-TIPO quantities. The TIPOs of one item are concurrent process steps on the SAME
        # units, so `qty` is the unit count and this says how many units each step applies to;
        # without it every step was scaled by the summed quantity and the hours inflated.
        tipo_qty_raw = entry.get("tipo_qty")
        tipo_qty: dict[str, float] = {}
        if isinstance(tipo_qty_raw, dict):
            for t, q in list(tipo_qty_raw.items())[:50]:
                t_str = str(t).strip()
                if not t_str:
                    continue
                try:
                    q_val = float(q or 0.0)
                except (TypeError, ValueError):
                    continue
                if q_val > 0:
                    tipo_qty[t_str] = q_val
        codes.append(code)
        demand[_norm_item_key(code)] = {
            "qty": max(qty, 0.0), "tipos": tipos[:50], "tipo_qty": tipo_qty,
        }

    if not codes:
        raise HTTPException(status_code=400, detail="Lista de itens vazia.")

    result = get_assembly_details(_demand_df(), items=codes, demand_override=demand)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── WebSocket de progresso ───────────────────────────────────────

@app.websocket("/ws/{job_id}")
async def websocket_progress(websocket: WebSocket, job_id: str):
    # Backend auth for the WS channel. Browsers cannot set an Authorization header on
    # a WebSocket, so the client passes the Azure ID token as a ?token= query param.
    # Validate it with the SAME central check as every HTTP route (signature, expiry,
    # issuer, audience, identity, allowed domain) BEFORE accepting the socket. Reject
    # anonymous / invalid / unauthenticated connections with 1008 (policy violation).
    try:
        _ws_user = validate_bearer_token(websocket.query_params.get("token", ""))
        # Blocked accounts are denied the WS channel too (HTTP routes go through the
        # require_auth wrapper; the socket must enforce the ban itself). The same applies
        # to an unregistered identity while new-user lockdown is on — otherwise the one
        # route that does not pass through require_auth becomes the hole in the lockdown.
        _ws_name = _username_of((_ws_user or {}).get("email", ""))
        if _is_user_blocked(_ws_name) or _is_unregistered_locked(_ws_name):
            await websocket.close(code=1008)
            return
        # Deliberate shutdown closes this channel too, for the same reason: the socket is the
        # one route that does not pass through the require_auth wrapper, so without this the
        # switch would leave a live progress channel open to every non-admin.
        if _is_server_offline() and _current_role(_ws_user) != "admin":
            await websocket.close(code=1008)
            return
    except HTTPException:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    # One queue per connection — only this coroutine reads from it,
    # so send_json is never called concurrently from two coroutines.
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)

    if job_id not in ws_queues:
        ws_queues[job_id] = []
    ws_queues[job_id].append(queue)

    try:
        # ── Initial sync: push current state into the queue ──────────
        # Poll up to 15 s (50 × 0.3 s) so cross-worker DB writes have
        # time to become visible before we give up.
        missing = 0
        while True:
            payload = _job_payload(job_id)
            if not payload:
                missing += 1
                if missing >= 50:
                    queue.put_nowait({
                        "status": "error",
                        "progress": 0,
                        "message": "Job não encontrado.",
                        "result": None,
                        "error": "Job não encontrado.",
                        "log": [f"[ERROR] Job {job_id} não encontrado."],
                    })
                    break
                await asyncio.sleep(0.3)
                continue
            queue.put_nowait(payload)
            break

        # ── Stream loop: drain queue → send; heartbeat every 5 s ────
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                # No broadcast in 5 s — send current state as heartbeat
                # so the frontend never misses a transition (e.g. done).
                current = _job_payload(job_id)
                if current:
                    try:
                        await websocket.send_json(current)
                    except Exception:
                        break
                    if current.get("status") in ("done", "error", "cancelled"):
                        break
                continue

            try:
                await websocket.send_json(data)
            except Exception:
                break
            if data.get("status") in ("done", "error", "cancelled"):
                break

    except WebSocketDisconnect:
        pass
    finally:
        queues = ws_queues.get(job_id, [])
        if queue in queues:
            queues.remove(queue)


# ── Lógica de otimização em background ──────────────────────────

async def _run_optimization_job(job_id: str, payload: OptimizationPayload):
    """
    Executa a otimização em background.
    """
    loop = asyncio.get_running_loop()

    def _progress_callback(value: int, text: str):
        _update_job(job_id, progress=value, message=text, status="running")
        # agenda broadcast sem bloquear a thread do solver
        asyncio.run_coroutine_threadsafe(
            _broadcast(job_id, jobs[job_id]),
            loop,
        )

    try:
        _update_job(job_id, status="running", progress=5,
                    message="Iniciando otimização...")
        _append_job_log(job_id, "[SETUP] Inicializando execução em background.")

        import threading
        stop_event = threading.Event()

        # Allow frontend to cancel via DELETE /api/optimize/{job_id}
        jobs[job_id]["_stop_event"] = stop_event

        df_db = _demand_df()
        _append_job_log(job_id, f"[SETUP] Dados carregados do banco ({len(df_db)} linhas).")

        # Vacations, measured against the PERIOD being optimized rather than today: away all
        # period → off the roster; away part of it → availability scaled down (see _leave_factors).
        period_dates = _period_working_dates(payload.fws, df_db)
        leave_out_ids, leave_pct_by_name = _leave_factors(period_dates)
        if period_dates:
            _append_job_log(job_id, f"[SETUP] Período: {len(period_dates)} dias úteis "
                                    f"({period_dates[0].isoformat()} a {period_dates[-1].isoformat()}).")
        else:
            _append_job_log(job_id, "[SETUP] Período sem FWs informadas — férias avaliadas apenas para hoje.")
        if leave_out_ids:
            _append_job_log(job_id, f"[SETUP] Férias: {len(leave_out_ids)} pessoa(s) fora de todo o período (excluídas).")
        if leave_pct_by_name:
            _append_job_log(job_id, "[SETUP] Férias parciais: "
                            + ", ".join(f"{n} {pct:.0f}%" for n, pct in sorted(leave_pct_by_name.items())))

        headcount_override = _headcount_source_dict(exclude_person_ids=leave_out_ids if period_dates else None)
        if headcount_override:
            _append_job_log(job_id, f"[SETUP] Capacidade (WS/pessoas/limites) via aba Headcount ({len(headcount_override)} WSNs).")
        else:
            _append_job_log(job_id, "[SETUP] Aba Headcount vazia — nenhuma restrição de capacidade por WSN aplicada.")

        if payload.expertise_enabled:
            # Wording matters here: an earlier version of this feature DID remove those pairs,
            # and this line said so. It no longer does — the gap is priced, not excluded.
            _append_job_log(job_id, "[SETUP] Expertise HABILITADA — o nível PRIORIZA quem atinge "
                                    "o alvo; ninguém abaixo dele é excluído."
                                    + (" Âncora de proficiência ATIVA." if payload.expertise_anchor else "")
                                    + (" Multiplicadores de ritmo ATIVOS — a cobertura muda."
                                       if payload.expertise_speed else ""))

        snapshot = build_snapshot(
            df_db,
            items=payload.items,
            top_pct=payload.top_pct,
            ot_day_limit_pct=payload.ot_day_limit_pct,
            gap_pct=payload.gap_pct,
            time_limit_s=payload.time_limit_s,
            phase_limit=payload.phase_limit,
            use_all_headcount=payload.use_all_headcount,
            ndias=payload.ndias,
            demand_by_wsn_explicit=payload.demand_by_wsn if payload.demand_by_wsn else None,
            excluded_wsns=payload.disabled_wsns if payload.disabled_wsns else None,
            blocked_pairs=[(p[0], p[1]) for p in payload.blocked_pairs if isinstance(p, (list, tuple)) and len(p) == 2] if payload.blocked_pairs else None,
            required_pairs=[(p[0], p[1]) for p in payload.required_pair_presence if isinstance(p, (list, tuple)) and len(p) == 2] if payload.required_pair_presence else None,
            forced_pair_headcount=payload.forced_pair_headcount if payload.forced_pair_headcount else None,
            direct_pair_headcount=payload.direct_pair_headcount if payload.direct_pair_headcount else None,
            fixed_pair_ot_pct=payload.fixed_pair_ot_pct if payload.fixed_pair_ot_pct else None,
            max_pair_pct=payload.max_pair_pct if payload.max_pair_pct else None,
            max_pair_ot_pct=payload.max_pair_ot_pct if payload.max_pair_ot_pct else None,
            wsn_max_people=payload.wsn_max_people if payload.wsn_max_people else None,
            wsn_max_hours=payload.wsn_max_hours if payload.wsn_max_hours else None,
            wsn_max_turnos=payload.wsn_max_turnos if payload.wsn_max_turnos else None,
            person_availability_pct=_merge_leave_availability(payload.person_availability_pct,
                                                              leave_pct_by_name),
            headcount_override=headcount_override,
            expertise_enabled=payload.expertise_enabled,
            expertise_anchor=payload.expertise_anchor,
            expertise_speed=payload.expertise_speed,
        )
        snapshot["_stop_event"] = stop_event
        _append_job_log(job_id, "[SETUP] Snapshot montado. Iniciando solver...")

        log_lines: list[str] = []

        def _is_high_freq(l: str) -> bool:
            # Raw Gurobi output and live [SOLVE …] progress are emitted very often.
            return l.startswith('[SOLVE') or not l.startswith('[')

        def _log_callback(line: str) -> None:
            log_lines.append(line)
            # Smart send, CHRONOLOGICAL: keep every important structured line ([PHASE],
            # [SETUP], [RESULTS], [DIAG], …) in place, but drop the OLDEST high-frequency
            # lines (raw Gurobi + live [SOLVE …]) once they exceed a budget — so phase
            # markers and the setup summary are never pushed out, the order is preserved,
            # and the buffer stays bounded during long Phase 3/4/6 solves.
            HF_BUDGET = 150
            hf_total = sum(1 for l in log_lines if _is_high_freq(l))
            drop = max(0, hf_total - HF_BUDGET)
            out: list[str] = []
            for l in log_lines:
                if _is_high_freq(l) and drop > 0:
                    drop -= 1
                    continue
                out.append(l)
            _update_job(job_id, log=out)
            asyncio.run_coroutine_threadsafe(
                _broadcast(job_id, jobs[job_id]),
                loop,
            )

        if jobs.get(job_id, {}).get("status") == "cancelled":
            return

        result = await loop.run_in_executor(
            None,
            lambda: run_optimization(
                snapshot,
                progress_callback=_progress_callback,
                log_callback=_log_callback,
                stop_event=stop_event,
            ),
        )

        _update_job(job_id, status="done", progress=100,
                    message="Concluído.", result=result)
        await _broadcast(job_id, jobs[job_id])
        # Persist final state to DB so reconnects after page refresh can find it
        import threading as _t; _t.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()

    except Exception as exc:
        # Full traceback → server log only (leaks file paths / internals to the client
        # job console otherwise). Keep the concise one-line reason for the UI.
        logger.exception("[optimize] job %s failed", job_id)
        _append_job_log(job_id, f"[ERROR] {exc}")
        _update_job(job_id, status="error", message=str(exc), error=str(exc))
        await _broadcast(job_id, jobs[job_id])
        import threading as _t; _t.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()


# ── Mapa WSN → pessoas ──────────────────────────────────────────

@app.get("/api/wsn-people")
def wsn_people(_user: dict = Depends(require_auth)):
    """
    Retorna o mapeamento WSN → [pessoas] a partir das tabelas de headcount
    (Workstation / Person / WorkstationPerson).
    Usado pelo frontend para popular a aba 'Por Pessoa' na janela de otimização.

    Authorization: Editor+ role, NO second factor — the same gate /api/headcount applies, for the
    same reason: this returns EMPLOYEE NAMES against the workstation each person is assigned to.
    That is LGPD-scoped personal data, and it says who works where and how many people a line
    carries. It previously carried `require_auth` alone, which meant every identity in the tenant
    — roster membership is auto-Reader on first login, so that is far wider than the Contagem
    planning team. The omission was an oversight, not a Reader exemption: the sibling endpoint
    serving the same roster has always gated it, and nothing here ever argued the other way (the
    routes that DO open themselves to Readers, like /api/gantt/scenario, say so explicitly).

    Costs no working flow. The single consumer is `ensurePeopleByWsn` (AppHeader), reached only
    from the OptimizeModal's onRunSolver/onEstadoAtual — and running the optimizer is already
    Editor+ on both sides (canOptimize in the UI, enforced in /api/optimize). No Reader has a UI
    path here; this only closes direct access to the URL.
    """
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    # The Headcount tables (Workstation/Person/WorkstationPerson) own the WSN -> people map,
    # empty included: "nobody allocated yet" must read as empty, never as stale routing data.
    hc = _headcount_source_dict()
    result = get_wsn_people_map(hc)
    # Expertise rides along with the roster it describes: the results screen shows people
    # per WSN, and a level shown there has to come from the SAME snapshot as the names, or
    # the two can disagree on who is even allocated.
    result["expertise"] = {
        wsn: dict(info.get("expertise") or {})
        for wsn, info in hc.items() if info.get("expertise")
    }
    result["required_level"] = {
        wsn: int(info.get("required_level") or 0)
        for wsn, info in hc.items() if int(info.get("required_level") or 0) > 0
    }
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


@app.get("/api/period-days")
def period_days(fws: str = "", _user: dict = Depends(require_auth)):
    """
    Retorna o total de dias mapeados para os FWs informados.
    Parâmetro: fws=17,18,19 (números de fiscal week separados por vírgula).
    Usado pelo frontend para exibir 'Dias mapeados' no header dos resultados.
    """
    fw_list = [f.strip() for f in fws.split(",") if f.strip()]
    df_db = _capacity_source_df()
    if df_db is None:
        df_db = _db_to_df()
    if df_db is None or df_db.empty:
        return {"status": "ok", "total_days": 0, "days_by_fw": {}}
    result = get_period_days(df_db, fw_list)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── KPIs de capacidade para o footer ────────────────────────────

@app.get("/api/capacity-stats")
def capacity_stats(_user: dict = Depends(require_auth)):
    """
    Retorna DISPONIVEL_H e ALOCADO_H calculados a partir das tabelas de headcount.
    Sem headcount cadastrado, retorna zeros.
    Usado pelo footer do frontend para exibir os KPIs de capacidade.
    """
    result = compute_capacity_stats(_headcount_source_dict())
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── Database endpoints ───────────────────────────────────────────

# ── Error-log deduplication ──────────────────────────────────────────────────
# Log volume is not free, and a single sustained fault (a database blip, an
# unreachable pooler) makes EVERY request emit a full traceback for as long as it
# lasts — the same stack, hundreds of times. That is pure cost with zero added
# diagnostic value: the first copy already tells you everything.
#
# So the first occurrence of a given (context, exception type) still logs in full,
# and repeats inside the window collapse to nothing; when the window closes, one
# line reports the fault is ongoing AND how many times it recurred, so a persistent
# problem can never become invisible. Nothing is rate-limited away silently.
_ERROR_LOG_WINDOW_S = 300
_error_log_state: dict = {}          # (context, exc type) -> [last_logged_mono, suppressed_count]
_error_log_lock = threading.Lock()


def _should_log_full(context: str, exc: Exception) -> tuple[bool, int]:
    """Returns (log_in_full, suppressed_since_last). Never raises."""
    key = (context, type(exc).__name__)
    now = _utime.monotonic()
    with _error_log_lock:
        entry = _error_log_state.get(key)
        if entry is None or (now - entry[0]) >= _ERROR_LOG_WINDOW_S:
            suppressed = entry[1] if entry else 0
            _error_log_state[key] = [now, 0]
            return True, suppressed
        entry[1] += 1
        return False, entry[1]


def _log_and_generic(exc: Exception, context: str) -> str:
    """Log the exception server-side and return a generic client-safe message.

    SECURITY: raw DB exceptions can carry the connection host, credential
    fragments, SQL, and stack traces. Never forward str(exc)/tracebacks to
    clients — log them and return this instead.

    COST: identical repeats inside a 5-min window are collapsed (see above) so a
    sustained outage costs one traceback per window, not one per request."""
    full, suppressed = _should_log_full(context, exc)
    if full:
        if suppressed:
            logger.error("[%s] (%d identical errors suppressed since the last report)",
                         context, suppressed)
        logger.exception("[%s] %s", context, exc)
    return "Erro interno. Consulte os logs do servidor."








@app.get("/api/db/status")
def db_status(_user: dict = Depends(require_auth)):
    """Verifica se o banco de dados está configurado e acessível.

    Also carries `server_offline`. That is not thematic, and it is deliberate: this endpoint is
    already polled by every open tab through useBackendHealth, so riding on it lets a client
    discover the deliberate-shutdown switch WITHOUT any additional periodic request. A dedicated
    poll for the flag would be self-defeating — the traffic it generates is exactly what has to
    stop for the host's idle timer to run out. The client reacts by muting its own pollers.
    """
    import os as _os
    db_url_set = bool(_os.getenv("DATABASE_URL"))
    offline = _is_server_offline()
    if not _DB_AVAILABLE:
        return {
            "available": False,
            "db_url_set": db_url_set,
            "message": f"Módulos de banco não carregados: {_db_import_exc_msg}",
            "server_offline": offline,
        }
    _is_admin = _current_role(_user) == "admin"
    try:
        available, detail = db_check_connection()
        # The detail can embed the DB host ("OK (via <host>)") — only Admins see it.
        if not _is_admin:
            detail = "OK" if available else "Indisponível"
        return {
            "available": available,
            "db_url_set": db_url_set,
            "message": detail,
            "server_offline": offline,
        }
    except Exception as exc:
        return {"available": False, "db_url_set": db_url_set,
                "message": _log_and_generic(exc, "db_status"), "server_offline": offline}














































# ── Gantt endpoints ──────────────────────────────────────────────────────────

# Simple in-process cache: (payload_dict, built_at_timestamp)
_gantt_cache: dict | None = None
_gantt_cache_at: float = 0.0
_GANTT_CACHE_TTL = 300  # seconds — revalidate after 5 minutes


def _invalidate_gantt_cache() -> None:
    global _gantt_cache, _gantt_cache_at
    _gantt_cache = None
    _gantt_cache_at = 0.0


# ── Admin-editable working calendar (override snapshot loading) ────────────────
# The calendar_override table is the single editable source; calendar_445 stays
# DB-free and receives a plain {date: kind} snapshot via set_overrides(). We load it
# at startup and re-load after every admin mutation, bumping a version token so the
# holiday cache (and, via _invalidate_gantt_cache, the Gantt cache) are rebuilt from
# the new calendar on the next reload/recompute.
_calendar_version = 0


def _load_calendar_overrides() -> int:
    """Read calendar_override → push the snapshot into calendar_445. Returns the count.
    Best-effort: a DB blip leaves the last-loaded (or empty algorithmic) calendar live."""
    global _calendar_version
    from datetime import date as _date
    from services import calendar_445
    mapping: dict = {}
    fw_offsets: dict = {}
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                for row in db.query(CalendarOverride).all():
                    try:
                        d = _date.fromisoformat(str(row.cal_date))
                    except (TypeError, ValueError):
                        continue
                    kind = str(row.kind or "").strip().lower()
                    if kind in ("holiday", "working"):
                        mapping[d] = kind
                for frow in db.query(FiscalWeekOverride).all():
                    try:
                        off = int(frow.offset or 0)
                    except (TypeError, ValueError):
                        continue
                    if off:
                        fw_offsets[int(frow.year)] = off
        except Exception as exc:
            logger.warning("[calendar] load overrides failed: %s", exc)
            return calendar_445.overrides_version()
    _calendar_version += 1
    calendar_445.set_overrides(mapping, _calendar_version)
    calendar_445.set_fw_offsets(fw_offsets, _calendar_version)
    return len(mapping)




@app.get("/api/gantt/data")
def gantt_data(_user: dict = Depends(require_auth)):
    """
    Retorna os dados do Gantt como JSON para renderização no frontend.
    Lê do banco — a única fonte.
    Resultado é cacheado em memória por 5 minutos para respostas rápidas.
    """
    import time as _time
    global _gantt_cache, _gantt_cache_at
    now = _time.monotonic()
    if _gantt_cache is not None and (now - _gantt_cache_at) < _GANTT_CACHE_TTL:
        return _gantt_cache
    try:
        from gantt_builder import build_gantt_data
        data = build_gantt_data()
        _gantt_cache = data
        _gantt_cache_at = now
        return data
    except (RuntimeError, FileNotFoundError) as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))
_STORED_ROLES = {"reader", "editor", "admin"}  # roles that may exist on a persisted row


def _username_of(email_or_name: str) -> str:
    """Extract the lookup username: the portion BEFORE '@', lower-cased and trimmed.
    Accepts a bare username too (returns it normalized)."""
    s = str(email_or_name or "").strip().lower()
    return s.split("@", 1)[0] if "@" in s else s


def _aware(dt):
    """Coerce a possibly-naive DB datetime to UTC-aware so arithmetic never raises."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


# ── Blocked-account cache ─────────────────────────────────────────────────────
# is_blocked is enforced on EVERY request (via the require_auth wrapper). To avoid a
# DB read per request, the small set of blocked usernames is cached with a short TTL
# and force-refreshed the moment an admin blocks/unblocks someone.
_blocked_usernames: set[str] = set()
_blocked_at = 0.0
_BLOCKED_TTL_S = 30
_blocked_lock = threading.Lock()

_BLOCKED_DETAIL = (
    "Acesso à aplicação foi revogado para esta conta. "
    "Contate um administrador se você acredita que isso é um engano."
)


def _refresh_blocked_cache(force: bool = False) -> None:
    """Reload the blocked-username set from the DB (throttled unless force=True)."""
    global _blocked_at, _blocked_usernames
    if not _DB_AVAILABLE:
        return
    now = _utime.time()
    if not force and (now - _blocked_at) < _BLOCKED_TTL_S:
        return
    try:
        with get_db() as db:
            rows = db.query(UserPermission.username).filter(UserPermission.is_blocked.is_(True)).all()
        with _blocked_lock:
            _blocked_usernames = {r[0] for r in rows}
            _blocked_at = now
    except Exception as exc:
        logger.warning("[auth] blocked-cache refresh failed (keeping last set): %s", exc)


def _is_user_blocked(username: str) -> bool:
    """True if the username is currently blocked."""
    if not username:
        return False
    _refresh_blocked_cache()
    with _blocked_lock:
        return username in _blocked_usernames


# ── Server control (deliberate shutdown + new-user lockdown) ──────────────────────────────
# Two admin switches held in app_setting and cached the same way as the blocked set: they are
# consulted on hot paths (every request for the lockdown, every status poll for the shutdown),
# so a DB read per request is not acceptable.
#
# WHAT 'server_offline' DOES. It closes the application to its users: while it is on, every route
# behind require_auth answers 503 + X-Server-Offline for non-admins, carrying the admin's message,
# and the client renders that message as a full-screen notice instead of the app. It is an access
# switch enforced HERE, on the server — not a flag the frontend may choose to honour — so a stale
# tab, a direct API call or a client with the overlay disabled are all refused the same way.
#
# ADMINS ARE EXEMPT, deliberately: the switch is turned back off through this same API, so locking
# admins out would leave the database as the only way back in. So are the two routes the notice
# itself needs (GET /api/server-control/status, POST /api/server-control) — see _OFFLINE_EXEMPT.
#
# There is no sleep/keepalive dimension to this any more: the switch neither suspends a cron nor
# lets a container idle out. It denies access, and that is all it does.
_SETTING_OFFLINE      = "server_offline"
_SETTING_OFFLINE_MSG  = "server_offline_message"
#: Historic key name, kept so the existing app_setting row keeps working. Its MEANING changed
#: with the Entra ID removal: "block new users" is no longer a switch, it is the permanent rule
#: (nobody is auto-registered any more — see _touch_user_login). What the flag controls now is
#: whether the app still ACCEPTS self-service access requests at all. On ⇒ POST
#: /api/auth/request-access is refused outright, so the sign-up form stops taking submissions;
#: off (the default) ⇒ requests are accepted and queue for an admin decision. Renaming the key
#: would silently reset every deployment that already has it set, which is why it stays.

_DEFAULT_OFFLINE_MSG = (
    "O servidor está temporariamente indisponível por decisão da administração. "
    "Tente novamente mais tarde."
)
#: Shown when a still-valid session names an account that is no longer on the roster — i.e. an
#: admin deleted it while the user was signed in. It says the account is gone and nothing else:
#: whether it was deleted, never approved, or renamed is not information a rejected caller needs.
_UNREGISTERED_DETAIL = (
    "Esta conta não está mais registrada. Faça login novamente ou solicite acesso."
)

_settings_cache: dict[str, str] = {}
_settings_at = 0.0
_SETTINGS_TTL_S = 30
_settings_lock = threading.Lock()


def _refresh_settings_cache(force: bool = False) -> None:
    """Reload app_setting into memory (throttled unless force=True). Never raises: on a DB
    failure the last known state is kept, which fails to the LESS restrictive side for the
    lockdown flag and keeps the current message for the offline flag."""
    global _settings_at, _settings_cache
    if not _DB_AVAILABLE:
        return
    now = _utime.time()
    if not force and (now - _settings_at) < _SETTINGS_TTL_S:
        return
    try:
        with get_db() as db:
            rows = db.query(AppSetting.key, AppSetting.value).all()
        with _settings_lock:
            _settings_cache = {k: (v or "") for k, v in rows}
            _settings_at = now
    except Exception as exc:
        logger.warning("[server-control] settings refresh failed (keeping last state): %s", exc)


def _setting(key: str, default: str = "") -> str:
    _refresh_settings_cache()
    with _settings_lock:
        return _settings_cache.get(key, default)


def _is_server_offline() -> bool:
    return _setting(_SETTING_OFFLINE) == "1"




def _offline_message() -> str:
    return (_setting(_SETTING_OFFLINE_MSG) or "").strip() or _DEFAULT_OFFLINE_MSG






def _is_unregistered_locked(username: str) -> bool:
    """True when this identity has no roster row — i.e. the account does not exist.

    This used to be conditional on the new-user lockdown switch, because an unknown caller
    who had authenticated against Entra ID was a legitimate first-time user and got
    auto-registered as Reader. With Entra ID gone that whole path is gone with it: an
    account is created ONLY by an admin or by an approved access request, so an
    authenticated token naming a user who is not on the roster means the account was
    DELETED while its session was still alive. Denying it is the point — otherwise
    "Excluir usuário" would only take effect at the next expiry, up to 12 h later.

    A DB failure returns False rather than locking everyone out of the app on a transient
    blip — the same fail-open choice as before, and the reason this can never be the ONLY
    control: the token signature is what actually proves identity."""
    if not username:
        return False
    if not _DB_AVAILABLE:
        return False
    try:
        with get_db() as db:
            row = db.query(UserPermission.username).filter(
                UserPermission.username == username).first()
        return row is None
    except Exception as exc:
        logger.warning("[server-control] roster check for %s failed, allowing: %s", username, exc)
        return False


def _enforce_not_blocked(user: dict) -> None:
    """Deny a blocked account the whole application (403 + X-Blocked). Called by the
    require_auth wrapper, so it applies to every protected route uniformly.

    Also denies an UNREGISTERED account while new-user lockdown is on, through the same
    wrapper and the same header, so the client reuses the existing access-denied screen and
    no route has to be touched individually. The two cases carry different messages and are
    distinguished for the client by X-Blocked-Reason."""
    uname = _username_of((user or {}).get("email", ""))
    if _is_user_blocked(uname):
        raise HTTPException(status_code=403, detail=_BLOCKED_DETAIL,
                            headers={"X-Blocked": "1", "X-Blocked-Reason": "banned"})
    if _is_unregistered_locked(uname):
        _record_security_event(
            actor="system", target=uname, event_type="new_user_denied",
            detail=f"Sessão recusada: a conta {uname} não existe mais no cadastro.",
            throttle_key=(uname, "new_user_denied", ""),
        )
        raise HTTPException(status_code=403, detail=_UNREGISTERED_DETAIL,
                            headers={"X-Blocked": "1", "X-Blocked-Reason": "unregistered"})


#: Routes that stay reachable while the app is switched off. Both belong to the notice itself:
#: the client READS the message from /status (so it can show what the admin wrote instead of a
#: bare error), and the POST is how an admin switches the app back on. The POST is admin-only and
#: password-gated on its own; it is listed here so the exemption does not depend on the role
#: lookup below succeeding.
_OFFLINE_EXEMPT = frozenset({"/api/server-control/status", "/api/server-control"})


def _enforce_server_offline(request: Request, user: dict) -> None:
    """Refuse the application to non-admins while the deliberate-shutdown switch is on
    (503 + X-Server-Offline, with the admin's message as the detail).

    Called from the require_auth wrapper, so it covers every protected route at once — the
    switch is enforced server-side rather than trusted to the client. Admins are exempt (they
    have to be able to switch it back off) and so are the two notice routes in _OFFLINE_EXEMPT.

    503 rather than 403: this is availability, not authorization. The client distinguishes it
    from a cold-start 503 by the X-Server-Offline header, which is why that header must stay in
    the CORS expose list."""
    if not _is_server_offline():
        return
    if request is not None and request.url.path in _OFFLINE_EXEMPT:
        return
    if _current_role(user) == "admin":
        return
    raise HTTPException(status_code=503, detail=_offline_message(),
                        headers={"X-Server-Offline": "1"})


# ── Audit trail + roster helpers ──────────────────────────────────────────────
def _log_security_event(
    db, *, actor: str | None, target: str | None, event_type: str, detail: str = "",
    detail_json: str | None = None,
) -> None:
    """Append a SecurityEvent within the caller's transaction (best-effort).

    `detail` is the human sentence the admin panels render — keep it to one line. `detail_json`
    is the optional machine-readable payload for forensics; it is stored and never returned by any
    endpoint (see SecurityEvent.detail_json)."""
    try:
        db.add(SecurityEvent(actor=actor or "system", target=target, event_type=event_type,
                             detail=detail or "", detail_json=detail_json or None))
    except Exception as exc:
        logger.warning("[audit] log %s/%s failed: %s", event_type, target, exc)


# Standalone variant: opens its OWN short transaction, for call sites that have no db
# session (auth dependencies, password gates). Best-effort — never raises into the
# request. `throttle_key` dedupes REPEATED identical events in-memory (per key, per
# `throttle_s`) so pollers / brute-force spam cannot flood the admin alert feed with
# thousands of rows; pass None to always record.
_SEC_EVENT_THROTTLE_S = 10 * 60
_sec_event_recent: dict = {}
_sec_event_lock = threading.Lock()

# The standalone audit write is a full round-trip to the (remote) DB. It used to run INLINE on
# the request's critical path — so a password gate or protected-access check blocked on the
# SecurityEvent INSERT before it could return "senha correta/incorreta" / "acesso autorizado".
# It is best-effort (never raises into the request) and nothing downstream reads the row within
# the same request, so we dispatch it to a tiny bounded pool: the verdict returns immediately and
# the row lands a few ms later. Bounded workers mean a DB stall can never spawn unbounded threads.
from concurrent.futures import ThreadPoolExecutor as _ThreadPoolExecutor
_audit_executor = _ThreadPoolExecutor(max_workers=2, thread_name_prefix="audit")

def _write_security_event_bg(actor, target, event_type, detail) -> None:
    """Background body: open a short transaction and append the SecurityEvent (best-effort)."""
    try:
        with get_db() as db:
            _log_security_event(db, actor=actor, target=target, event_type=event_type, detail=detail)
    except Exception as exc:
        logger.warning("[audit] async record %s/%s failed: %s", event_type, target, exc)

def _record_security_event(
    *, actor: str | None, target: str | None = None, event_type: str, detail: str = "",
    throttle_key: tuple | None = None, throttle_s: float = _SEC_EVENT_THROTTLE_S,
) -> None:
    if not _DB_AVAILABLE:
        return
    if throttle_key is not None:
        now = _utime.monotonic()
        with _sec_event_lock:
            if now - _sec_event_recent.get(throttle_key, -1e12) < throttle_s:
                return
            _sec_event_recent[throttle_key] = now
            if len(_sec_event_recent) > 4000:   # opportunistic prune (bounded memory)
                stale = [k for k, v in _sec_event_recent.items() if now - v >= throttle_s]
                for k in stale:
                    _sec_event_recent.pop(k, None)
    tgt = target or actor
    try:
        _audit_executor.submit(_write_security_event_bg, actor, tgt, event_type, detail)
    except RuntimeError:
        # Executor already shut down (app teardown) — fall back to an inline best-effort write.
        _write_security_event_bg(actor, tgt, event_type, detail)


# ── Last-known-role cache (resilience, NOT authority) ─────────────────────────
# _current_role must hit the DB, but a cold pool / transient outage right after boot was
# demoting real Admins to Reader for a few seconds — which 403'd the admin indicators
# ("Falha ao carregar usuários online / alertas") and hid role-gated UI. The fix: cache
# the last DB-CONFIRMED role per user and fall back to it ONLY when the DB read fails.
# A successful read (including an explicit demotion to reader) always wins and refreshes
# the cache; role mutations bust the entry. Lockout/block checks run before any of this,
# so a cached role can never bypass them.
_ROLE_CACHE_TTL_S = 15 * 60
_role_cache: dict = {}
_role_cache_lock = threading.Lock()

def _remember_role(username: str, role: str) -> None:
    if not username:
        return
    with _role_cache_lock:
        _role_cache[username] = (role, _utime.monotonic() + _ROLE_CACHE_TTL_S)

def _recall_role(username: str) -> str | None:
    """Last DB-confirmed role, or None if absent/expired."""
    with _role_cache_lock:
        entry = _role_cache.get(username)
        if not entry:
            return None
        role, expires = entry
        if _utime.monotonic() >= expires:
            _role_cache.pop(username, None)
            return None
        return role



def _touch_user_login(username: str) -> None:
    """Refresh last_login (throttled to ~10 min so the hot /permissions/me path isn't a write
    on every poll). Best-effort.

    NO LONGER AUTO-REGISTERS. Under Entra ID, an unknown caller had already been vetted by the
    corporate directory, so creating a Reader row for them on sight was the sensible default.
    With local passwords there is nothing behind the identity except this table, so a row that
    appears by itself would BE the account — self-service admin. Accounts are now created in
    exactly two places: an admin adding one, and an approved access request. A caller with a
    valid token and no row is handled by _enforce_not_blocked (the account was deleted).

    The superadmin is the one exception, seeded rather than auto-registered: the break-glass
    account has to exist for the recovery path to work at all."""
    if not _DB_AVAILABLE or not username:
        return
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is None:
                # Nothing to recreate: the demo ships exactly one account and never adds another.
                return
            else:
                last = _aware(row.last_login)
                if last is None or (now - last).total_seconds() > 600:
                    row.last_login = now
    except Exception as exc:
        # A duplicate-insert race (two workers, same first login) or transient DB blip
        # must never break the request — the roster row is a convenience, not a gate.
        logger.warning("[roster] touch_login(%s) skipped: %s", username, exc)


# ── Online-user activity tracking (for the admin online-users indicator) ───────────────────
# require_auth runs on EVERY authenticated request, so refreshing last_activity there is throttled
# in-memory to ~60s/user: the hot path stays a pure memory check on all but ~1 request/min/user.
_ACTIVITY_TOUCH_THROTTLE_SEC = 60
_activity_last_touch: dict = {}
_activity_touch_lock = threading.Lock()

def _touch_user_activity(username: str) -> None:
    """Refresh last_activity (online indicator). In-memory throttled; best-effort — never raises.

    Also emits the `[presence]` line the local launcher console reads (see dev.py). That console
    is the operator's view of a host they cannot see inside, and until now "who is using this?"
    was answerable ONLY by opening the app and signing in as an admin — on the very machine whose
    health you were trying to judge.

    A log line, not a new endpoint, on purpose. The console is a separate loopback server with no
    Azure token and no database session, so serving it this data any other way would mean a route
    that hands out user identities without authenticating anyone — the exact thing the rest of
    this file exists to prevent. The console already tails this stream, so the data reaches it
    with no new HTTP surface at all.

    What goes on the line is the bare `username` (`demo`), never the e-mail, the token or the
    role's password state. The throttle above doubles as the sample rate: one line per user per
    minute, which is also the resolution the console's presence trace draws at.
    """
    if not username:
        return
    now_mono = _utime.monotonic()
    with _activity_touch_lock:
        last = _activity_last_touch.get(username, 0.0)
        if now_mono - last < _ACTIVITY_TOUCH_THROTTLE_SEC:
            return
        # Absent from the throttle map = not seen since this process started. That is exactly the
        # scope the console's access log claims ("desde que o servidor subiu"), so it needs no
        # state of its own to decide what counts as an arrival.
        first_seen = last == 0.0
        _activity_last_touch[username] = now_mono

    if not _DB_AVAILABLE:
        # No roster to update, but the operator should still see who is on the app. Presence is
        # observed at the auth layer and does not depend on the database being reachable.
        _emit_presence(username, "", first_seen)
        return

    role = ""
    try:
        with get_db() as db:
            row = (db.query(UserPermission)
                     .filter(UserPermission.username == username).first())
            if row is not None:
                role = row.role or ""
                row.last_activity = datetime.now(timezone.utc)
    except Exception as exc:
        logger.warning("[roster] touch_activity(%s) skipped: %s", username, exc)

    _emit_presence(username, role, first_seen)


def _emit_presence(username: str, role: str, first_seen: bool) -> None:
    """One machine-readable presence sample for the launcher console. Never raises.

    Two verbs, because they are two different things to an operator. `entrou` is somebody arriving
    who was not here before and is worth a line in the Signals rail; `visto` is the once-a-minute
    heartbeat that keeps the count honest and must stay out of it — at one line per user per
    minute it would push every real error off a 40-row rail within the hour. dev.py's
    _ROUTINE_PAT/_EVENT_PAT split enforces that; the wording here is what it matches on.
    """
    # print e NAO logger.info. Este modulo faz `logging.getLogger(__name__)` e nunca
    # configura handler nenhum; sob o uvicorn so os loggers `uvicorn.*` recebem handler.
    # Um record deste logger sobe ate a raiz vazia e cai no logging.lastResort, cujo nivel
    # e WARNING — entao logger.warning aparece e **logger.info e descartado em silencio**.
    # Foi exatamente o que aconteceu: nenhuma linha [presence] jamais saiu, com o resto do
    # caminho funcionando. Configurar o logging aqui consertaria a linha e de quebra abriria
    # a torneira de INFO de toda biblioteca importada; esta linha e instrumentacao de
    # console, lida por um processo que le stdout linha a linha — nao registro de
    # aplicacao. O `[API] Backend iniciado.` ao lado ja usa print pelo mesmo motivo.
    try:
        print(f"[presence] {'entrou' if first_seen else 'visto'} "
              f"user={username} role={role or '-'}", flush=True)
    except Exception:
        pass


def _persist_lockout_event(user: dict) -> None:
    """Record a tripped lockout on the user's row (count + timestamp) and in the audit log."""
    if not _DB_AVAILABLE:
        return
    # Chave de ORIGEM (tela de login): não há linha de cadastro para atualizar, porque quem
    # foi trancado é um navegador e não uma conta. Registra e sai — o evento detalhado já foi
    # gravado por quem chamou (login_blocked), com a origem por extenso.
    if (user or {}).get("_source_label"):
        _record_security_event(
            actor="system", target=None, event_type="lockout",
            detail=f"Tentativas de login bloqueadas ({user['_source_label']}).",
            throttle_key=None,
        )
        return
    uname = _username_of((user or {}).get("email", ""))
    if not uname:
        return
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == uname).first()
            if row is None:
                # NÃO cria a linha. Antes disto o lockout só podia vir de alguém já autenticado
                # pela Entra ID, então "criar a linha se faltar" era um conserto de cadastro.
                # Agora o lockout também nasce na TELA DE LOGIN, que é pública: criar a conta
                # aqui deixaria qualquer um materializar um usuário no cadastro só errando a
                # senha cinco vezes com o nome que quisesse — e o nome ficaria reservado,
                # recusando a solicitação de acesso de quem realmente se chama assim. O evento
                # de auditoria continua sendo gravado, que é o que o admin precisa ver.
                _log_security_event(db, actor="system", target=uname, event_type="lockout",
                                    detail="Bloqueio por senha incorreta (usuário não cadastrado).")
                return
            row.lockout_count   = (row.lockout_count or 0) + 1
            row.last_lockout_at = now
            _log_security_event(db, actor="system", target=uname, event_type="lockout",
                                detail=f"Bloqueio por senha incorreta (total={row.lockout_count}).")
    except Exception as exc:
        logger.warning("[audit] persist lockout(%s) failed: %s", uname, exc)




    # No 'import_pw_used' row — same reasoning as the admin unlock above: the operation this gate
    # protects (data_import / data_download / schedule_save / …) is what gets audited. The failure
    # path stays.


def _role_for_username(db, username: str) -> str:
    """Return 'admin' | 'editor' | 'reader' for a username (Reader = default / not listed)."""
    if not username:
        return "reader"
    row = db.query(UserPermission).filter(UserPermission.username == username).first()
    return row.role if row and row.role in _STORED_ROLES else "reader"


def _current_role(user: dict) -> str:
    """Resolve the authenticated user's role. Readers don't need a DB row; DB-down ⇒ reader."""
    # Failed-password lockout strips ALL elevated privileges for the lockout window: every
    # role-gated endpoint (and the UI, via /permissions/me) treats the user as a Reader.
    # The real role is restored automatically once the lockout expires — _is_locked_out()
    # clears it on read — with no persisted change to the user's stored role.
    if _is_locked_out(user):
        return "reader"
    uname = _username_of((user or {}).get("email", ""))
    if not _DB_AVAILABLE:
        return _recall_role(uname) or "reader"
    try:
        with get_db() as db:
            role = _role_for_username(db, uname)
        _remember_role(uname, role)   # DB-confirmed → refresh the resilience cache
        return role
    except Exception:
        # Transient DB failure (cold pool, blip): serve the last DB-CONFIRMED role instead
        # of silently demoting a real Admin/Editor to Reader mid-session (see cache notes).
        return _recall_role(uname) or "reader"


def _record_perm_denied(user: dict, request: Request | None, needed: str) -> None:
    """Admin visibility for role-gated denials. Heavily throttled per (user, path) so a
    poller retrying a 403 in a loop yields ONE alert, not thousands."""
    uname = _username_of((user or {}).get("email", ""))
    path = request.url.path if request is not None else "?"
    _record_security_event(
        actor=uname, event_type="perm_denied",
        detail=f"Permissão negada ({needed}) em {path}.",
        throttle_key=(uname, "perm_denied", path),
    )


@app.get("/api/permissions/me")
def my_permission(user: dict = Depends(_base_require_auth)):
    """Return the authenticated user's resolved username + role + account state.

    Uses the RAW auth dependency (not the block-enforcing wrapper) on purpose: a BLOCKED
    user must still be able to fetch this and learn `blocked: true` so the frontend can
    render the access-denied page instead of a generic error.

    Also lazily AUTO-REGISTERS the user as Reader on first login and refreshes last_login
    (throttled), so admins get a full roster. `locked` reports a failed-password lockout
    (plain boolean, no duration); `blocked` reports a hard admin ban."""
    uname = _username_of((user or {}).get("email", ""))
    _touch_user_login(uname)   # best-effort roster upsert + throttled last_login
    banned = _is_user_blocked(uname)
    # Order matters: a real ban outranks the lockdown, so an admin who bans someone still sees
    # (and the user still gets) the revoked-access message rather than the generic one.
    unregistered = (not banned) and _is_unregistered_locked(uname)
    return {
        "username": uname,
        "role": _current_role(user),
        "locked": _is_locked_out(user),
        "blocked": banned or unregistered,
        "blockedReason": "banned" if banned else ("unregistered" if unregistered else None),
        "email": _account_email(uname),
    }


# ── Server control endpoints ──────────────────────────────────────────────────────────────


def _account_email(username: str) -> str:
    """E-mail cadastrado da conta ('' quando não há linha / não há e-mail). Best-effort."""
    if not _DB_AVAILABLE or not username:
        return ""
    try:
        with get_db() as db:
            row = db.query(UserPermission.email).filter(UserPermission.username == username).first()
        return (row[0] if row else "") or ""
    except Exception:
        return ""


def _client_ip(request: Request) -> str:
    """IP de origem, atravessando o proxy TLS. Só para limite de taxa e auditoria."""
    if request is None:
        return ""
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd[:64]
    client = getattr(request, "client", None)
    return (getattr(client, "host", "") or "")[:64]




def _attempt_source(request: Request) -> dict:
    """Chave de contagem das tentativas de login: QUEM ESTÁ TENTANDO, não quem é o alvo.

    Esta distinção é a coisa mais importante do controle. Contar por usuário-alvo transforma a
    proteção em arma: qualquer pessoa na rede tranca a conta de qualquer outra por 15 minutos
    errando cinco senhas na tela de login pública — inclusive a de todos os administradores,
    simultaneamente, deixando o app sem quem o administre. O alvo não fez nada e não tem como
    se defender. Contando pela origem, quem paga pelas cinco tentativas é quem as fez, e a
    conta visada segue funcionando normalmente de qualquer outro navegador.

    A origem é o par (navegador, IP). O `X-Client-Id` sozinho não serve: é enviado pelo cliente
    e some com uma limpeza de dados do site. O IP sozinho também não: uma fábrica inteira sai
    por um NAT só e um lockout por IP trancaria o turno inteiro. Juntos, limpar o armazenamento
    do navegador ainda deixa o IP, e trocar de máquina ainda deixa o navegador — e nenhum dos
    dois pune quem não tentou.
    """
    client_id = (request.headers.get("x-client-id") or "").strip()[:64] if request is not None else ""
    ip = _client_ip(request)
    label = f"navegador {client_id[:8] or '?'} / origem {ip or '?'}"
    return {
        "oid": f"login-src:{client_id or '-'}|{ip or '-'}",
        "email": label,
        # Lido por _persist_lockout_event: diz que esta chave é uma ORIGEM e não um usuário,
        # para que ele não vá procurar uma linha de cadastro que nunca vai existir.
        "_source_label": label,
    }


#: Quantas solicitações de acesso um mesmo navegador pode enviar, no total. É um bloqueio duro
#: (não uma janela deslizante): o pedido é um ato único por pessoa, então cinco tentativas já
#: cobrem folgadamente erro de digitação e mudança de ideia.
#: Rede de proteção por IP, mais alta porque um escritório inteiro sai pelo mesmo endereço.
#: Existe porque X-Client-Id é enviado pelo cliente e some com uma limpeza de dados do site.


#: Teto de tentativas de login por MINUTO e por origem. Bem acima do teto por usuário
#: (_RL_MAX = 10) porque a fábrica inteira sai por um NAT só: às 7h da manhã, dezenas de
#: pessoas entram no mesmo minuto pelo mesmo endereço, e um teto de dez as trancaria umas às
#: outras. Continua limitando o que precisa limitar — 60 tentativas/min é ~14 s de CPU em
#: PBKDF2, então a rota pública não vira o jeito barato de consumir o servidor.
_LOGIN_IP_RL_MAX = 60

#: Usuário válido: começa com letra/número e aceita ponto, hífen e sublinhado. É a forma que
#: `_username_of` produz a partir de um e-mail corporativo, e a mesma que a trilha de auditoria
#: e o console de presença imprimem — um nome fora disso quebraria a leitura dos dois.
import re as _re_auth


@app.post("/api/auth/login")
def auth_login(request: Request, body: dict = Body(default={})):
    """Autentica usuário + senha e devolve o token de sessão. Rota SEM autenticação prévia.

    Deliberadamente acessível mesmo com o servidor 'desativado' pelo admin: o interruptor é
    desligado por dentro da aplicação, então recusar o login aqui deixaria o próprio
    administrador do lado de fora e o banco como único caminho de volta.

    A resposta de falha é sempre a mesma frase, com ou sem usuário existente, e o caminho
    'usuário inexistente' ainda paga o custo de um PBKDF2 (ver _DUMMY_PASSWORD_HASH): sem
    isso, a tela de login vira um verificador de quem tem conta aqui.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

    payload = body or {}
    username = _username_of(payload.get("username", ""))
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Informe usuário e senha.")

    # Cinco senhas erradas seguidas TRANCAM ESTA ORIGEM por 15 minutos, aconteça isso contra
    # uma conta ou contra vinte. A conta visada não é afetada em nada — ver _attempt_source.
    source = _attempt_source(request)
    _check_pw_lockout(source)             # 429 genérico enquanto o lockout estiver ativo
    _rate_limit(source, "login")
    # Teto adicional por IP, com folga bem maior. Não é o controle de força bruta (esse é o de
    # cima); é o teto de CPU: a rota é PÚBLICA e cada tentativa custa um PBKDF2 de 600 mil
    # iterações, então sem ele a própria defesa vira o jeito barato de consumir o servidor.
    ip = _client_ip(request)
    if ip:
        _rate_limit({"oid": f"login-ip:{ip}", "email": ip}, "login", max_hits=_LOGIN_IP_RL_MAX)

    try:
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            stored  = row.password_hash if row is not None else None
            blocked = bool(row.is_blocked) if row is not None else False
            role    = (row.role if row is not None else "reader") or "reader"
            email   = (row.email if row is not None else "") or ""
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "auth_login"))

    ok = bool(stored) and verify_password(password, stored or _DUMMY_PASSWORD_HASH)
    if not ok:
        if not stored:
            verify_password(password, _DUMMY_PASSWORD_HASH)   # iguala o tempo de resposta
        tripped = _record_pw_failure(source)
        # TODA tentativa malsucedida vai para a trilha, uma linha por tentativa, sem
        # agrupamento por tempo. Antes havia uma janela de 60 s que descartava as repetidas —
        # boa contra enchente de alertas, péssima aqui: cinco tentativas em dez segundos são
        # exatamente o padrão que se quer conseguir ler depois, e agrupá-las apagaria quatro
        # das cinco. O volume é limitado pelo próprio lockout logo acima, então não há
        # enchente a conter. O tipo segue em _ALERT_NOISE_TYPES: isto é registro de auditoria,
        # não alerta no sino.
        _record_security_event(
            actor=username, target=username, event_type="login_fail",
            detail=(f"Tentativa de login malsucedida para '{username}' "
                    f"({source['_source_label']})."),
            throttle_key=None,
        )
        if tripped:
            _record_security_event(
                actor="system", target=username, event_type="login_blocked",
                detail=(f"Tentativas de login bloqueadas por 15 min após 5 falhas seguidas "
                        f"({source['_source_label']}). A conta alvo NÃO foi bloqueada."),
                throttle_key=None,
            )
            raise HTTPException(status_code=429, detail=_LOCKOUT_DETAIL, headers={"X-Locked-Out": "1"})
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")

    # A senha estava certa — mas uma conta banida continua banida. O 403 com X-Blocked é o
    # mesmo que o resto da aplicação emite, então o cliente já sabe desenhar essa tela.
    if blocked:
        raise HTTPException(status_code=403, detail=_BLOCKED_DETAIL,
                            headers={"X-Blocked": "1", "X-Blocked-Reason": "banned"})

    _reset_pw_failures(source)

    now = datetime.now(timezone.utc)
    try:
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is not None:
                row.last_login = now
                role = row.role or "reader"
    except Exception as exc:
        logger.warning("[auth] login: last_login(%s) não registrado: %s", username, exc)

    token, ttl = issue_session_token(username, email or username)
    _record_security_event(actor=username, target=username, event_type="login",
                           detail=f"Login efetuado ({_client_ip(request) or 'origem desconhecida'}).",
                           throttle_key=(username, "login", ""))
    return {
        "token": token,
        "expiresIn": ttl,
        "user": {
            "username": username,
            "email": email or username,
            "name": display_name_of(username),
            "role": role,
        },
    }


@app.post("/api/auth/refresh")
def auth_refresh(user: dict = Depends(require_auth)):
    """Emite um token novo para uma sessão ainda válida.

    Passa por `require_auth`, e é isso que faz dela mais do que uma renovação de relógio: uma
    conta banida, excluída ou com o servidor desativado não renova, porque o wrapper recusa
    antes de chegar aqui. É o gancho que o cliente usa no 401 antes de mostrar a tela de login.
    """
    uname = _username_of((user or {}).get("email", ""))
    email = (user or {}).get("email", "") or uname
    token, ttl = issue_session_token(uname, email)
    return {
        "token": token,
        "expiresIn": ttl,
        "user": {
            "username": uname,
            "email": email,
            "name": display_name_of(uname),
            "role": _current_role(user),
        },
    }


































def _clean_move_notes(raw) -> list:
    """Normalize a box's move-description trail (why it was moved): keep the newest
    _MOVE_NOTE_MAX_ENTRIES, cap each reason's length, and collapse whitespace — which also strips
    newlines and control characters. This is the only USER-AUTHORED FREE TEXT in the override
    layer; it is stored raw and HTML-escaped at render time (esc() in gantt-table-worker.js),
    never trusted as markup. An entry survives with an empty observation as long as it carries a
    valid category (the classification is mandatory client-side; the free text is optional)."""
    if not isinstance(raw, list):
        return []
    out: list = []
    for n in raw[-_MOVE_NOTE_MAX_ENTRIES:]:
        if not isinstance(n, dict):
            continue
        text = " ".join(str(n.get("text") or "").split())[:_MOVE_NOTE_MAX_LEN]
        category = " ".join(str(n.get("category") or "").split())
        if category not in _MOVE_NOTE_CATEGORIES:
            category = ""
        if not text and not category:
            continue
        entry = {
            "text": text,
            "by": " ".join(str(n.get("by") or "").split())[:_MOVE_NOTE_BY_MAX_LEN],
            "at": " ".join(str(n.get("at") or "").split())[:_MOVE_NOTE_AT_MAX_LEN],
        }
        if category:
            entry["category"] = category
        # VISUAL-ONLY flag: the move finished beyond the Protection-Days limit (planner acknowledged the
        # crossing warning). Persist it so the prominent red badge survives a reload; it never affects
        # scheduling (see pdOverLimit / MoveNote in lib/locoOverrides.ts).
        if n.get("pdOverLimit"):
            entry["pdOverLimit"] = True
        out.append(entry)
    return out


def _clean_scoped_edit(e: dict) -> dict:
    """Normalize one ScopedEdit, dropping no-op fields. `propagate` alone (no dimension change)
    is NOT an edit (mirrors the frontend isEmptyScopedEdit), so it is dropped in that case — and
    neither is `notes`, which explains a move and so is dropped with it."""
    if not isinstance(e, dict):
        return {}
    p: dict = {}
    if e.get("takt") is not None:
        p["takt"] = e["takt"]
    if e.get("startShiftDays"):
        p["startShiftDays"] = e["startShiftDays"]
    if e.get("finishShiftDays"):
        p["finishShiftDays"] = e["finishShiftDays"]
    # Componente-scope "Horas totais" override (rescales the component's hours at the same duration —
    # feeds the Plano de Produção item hours). A real edit on its own, so it counts toward `p` below.
    # Validated: a non-negative number only (bool excluded — it is an int subclass), so a malformed or
    # negative client value is dropped rather than persisted.
    _hh = e.get("hoursTotal")
    if isinstance(_hh, (int, float)) and not isinstance(_hh, bool) and _hh >= 0:
        p["hoursTotal"] = float(_hh)
    # A WS40↔WS50 SWAP is a real change even with no shift left on it: the two stations trade slots, so
    # anything that later drives one back to a net-zero shift (a Global-propagation recovery pull is the
    # usual way) leaves an entry holding only the swap markers. Dropping it here would un-swap that
    # station on the next reload — it would come back in its PRE-SWAP slot while its partner stayed put.
    # Mirrors isEmptyScopedEdit in lib/locoOverrides.ts, which makes the same exception.
    # `satNever` (the Move-Mode Saturday veto) joins the same exception: it is routinely set on a station
    # carrying NO shift — flagging a box that does not currently touch a Saturday is the normal preventive
    # use — so treating that as "not a real edit" would discard the veto on save and let a later edit
    # slide the station onto a Saturday the planner had ruled out.
    if not p and not e.get("swap") and not isinstance(e.get("swapShift"), dict) and not e.get("satNever"):
        return {}  # only `propagate`/`notes` (or nothing) → not a real edit
    if e.get("propagate"):
        p["propagate"] = True
    notes = _clean_move_notes(e.get("notes"))
    if notes:
        p["notes"] = notes
    # Move Mode's manual-Saturday permission (see satManual in lib/locoOverrides.ts). It must
    # persist: without it a reload would recompute the row on the WS40/WS50-only calendar and
    # bounce it off the working Saturday a planner deliberately put it on. Optimizer-authored
    # overrides never set it, so this changes nothing about optimization.
    if e.get("satManual"):
        p["satManual"] = True
    # Move Mode's Saturday VETO (see satNever in lib/locoOverrides.ts) — the INVERSE of satManual/satDays:
    # a standing "this station never occupies a Saturday" constraint set by hand with Space. It must
    # persist or a reload would recompute the row on the ordinary calendar and let it sit on a Saturday
    # the planner explicitly ruled out. Optimizer-authored overrides never set it.
    if e.get("satNever"):
        p["satNever"] = True
    # The committed working-Saturday licence (see satDays in lib/locoOverrides.ts): the exact working-
    # Saturday ISO dates a Move-Mode landing occupies. It must persist or a reload would recompute the
    # row without the licence and land the box a slot off the Saturday the planner dropped it on. Scoped
    # to these dates only (never a blanket permission), so it can never auto-allocate a later-promoted
    # Saturday. Validated: a list of well-formed YYYY-MM-DD strings, deduped; anything else is dropped.
    _sd = e.get("satDays")
    if isinstance(_sd, list):
        seen: set = set()
        days: list = []
        for d in _sd:
            if isinstance(d, str) and len(d) >= 10:
                iso = d[:10]
                if iso[4] == "-" and iso[7] == "-" and iso[:4].isdigit() and iso[5:7].isdigit() and iso[8:10].isdigit() and iso not in seen:
                    seen.add(iso)
                    days.append(iso)
        if days:
            p["satDays"] = days
    # WS40↔WS50 manual swap marker (see `swap` in lib/locoOverrides.ts). It must persist: on reload the
    # frontend re-derives the delay/recovery hatch from base-vs-edited positions, and without this flag a
    # swapped WS (which moved into its partner's slot) would light up as a phantom delay/recovery. Only
    # the manual swap sets it; optimizer-authored overrides never do.
    if e.get("swap"):
        p["swap"] = True
    # The swap's OWN contribution to this WS's shift (see `swapShift` in lib/locoOverrides.ts).
    # `startShiftDays` is cumulative, so the flag alone cannot say how much of the current position is
    # the trade and how much is a real later move; without this the delay maths would either exempt a
    # swapped station forever or report the trade itself as a delay. Validated shape — two finite
    # numbers — so a malformed client value is dropped rather than persisted into the schedule maths.
    _sw = e.get("swapShift")
    if isinstance(_sw, dict):
        _s, _f = _sw.get("start"), _sw.get("finish")
        if (isinstance(_s, (int, float)) and not isinstance(_s, bool)
                and isinstance(_f, (int, float)) and not isinstance(_f, bool)):
            p["swapShift"] = {"start": float(_s), "finish": float(_f)}
    # "Propagate parallel starts" is DEFAULT ON, so only an explicit False is worth persisting —
    # storing True would just bloat every payload with the default.
    if e.get("parallelStarts") is False:
        p["parallelStarts"] = False
    # "Remove future gaps" (see removeGaps in lib/locoOverrides.ts) is DEFAULT OFF, so only an explicit
    # True is worth persisting — the mirror of parallelStarts above. It changes how this edit's cascade
    # places the stations after it, so it must survive a reload or the schedule would redraw with the
    # gaps back in.
    if e.get("removeGaps"):
        p["removeGaps"] = True
    return p


def _clean_added_ws(a: dict) -> dict:
    """Normalize one AddedWorkstation (a manually-inserted station — see AddedWorkstation in
    lib/locoOverrides.ts). Unlike a ScopedEdit this MATERIALIZES a whole station, so its geometry
    is absolute and every field is validated before it is persisted into the schedule maths. Returns
    {} for anything missing the minimum viable geometry (name + start + positive duration), so a
    malformed client value is dropped rather than stored."""
    if not isinstance(a, dict):
        return {}
    ws = str(a.get("ws") or "").strip()
    start = str(a.get("startIso") or "").strip()[:10]
    dur = a.get("durationDays")
    if not ws or not start or not (isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur > 0):
        return {}
    hours = a.get("hoursTotal")
    qty = a.get("itemQty")
    p: dict = {
        "ws": ws,
        "startIso": start,
        "durationDays": float(dur),
        "hoursTotal": float(hours) if isinstance(hours, (int, float)) and not isinstance(hours, bool) and hours >= 0 else 0.0,
        "itemQty": int(qty) if isinstance(qty, (int, float)) and not isinstance(qty, bool) and qty >= 0 else 0,
        "workorder": str(a.get("workorder") or ""),
    }
    desc = a.get("desc")
    if isinstance(desc, str) and desc.strip():
        p["desc"] = desc
    subarea = a.get("subarea")
    if isinstance(subarea, str) and subarea.strip():
        p["subarea"] = subarea
    # ÁREA — optional by design: the dialog allows an existing área, a new one, or none at all. A blank
    # value is simply not persisted and the station renders unassociated (native rows carry '' too).
    area = a.get("area")
    if isinstance(area, str) and area.strip():
        p["area"] = area.strip()[:120]
    # "Propagar efeitos imediatamente": creation-time insertion push. Only the opt-IN is stored.
    if a.get("propagate") is True:
        p["propagate"] = True
    return p


def _flatten_override_map(ov_map: dict) -> list[dict]:
    """LocoOverrideMap → flat per-object rows {loco_key, scope, scope_key, payload}."""
    rows: list[dict] = []
    for loco_key, ov in (ov_map or {}).items():
        if not isinstance(ov, dict):
            continue
        loco_payload: dict = {}
        if ov.get("takt") is not None:
            loco_payload["takt"] = ov["takt"]
        if ov.get("startShiftDays"):
            loco_payload["startShiftDays"] = ov["startShiftDays"]
        if ov.get("finishShiftDays"):
            loco_payload["finishShiftDays"] = ov["finishShiftDays"]
        if loco_payload:
            rows.append({"loco_key": loco_key, "scope": "loco", "scope_key": "", "payload": loco_payload})
        for k, e in (ov.get("ws") or {}).items():
            p = _clean_scoped_edit(e)
            if p:
                rows.append({"loco_key": loco_key, "scope": "ws", "scope_key": k, "payload": p})
        for k, e in (ov.get("desc") or {}).items():
            p = _clean_scoped_edit(e)
            if p:
                rows.append({"loco_key": loco_key, "scope": "desc", "scope_key": k, "payload": p})
        # Manually-added workstations (scope 'addws') — a new station materialized from an absolute
        # anchor. `scope` is a free String column so this needs no migration; scope_key is the ws name.
        for k, a in (ov.get("addWs") or {}).items():
            p = _clean_added_ws(a)
            if p:
                rows.append({"loco_key": loco_key, "scope": "addws", "scope_key": k, "payload": p})
    return rows


def _rebuild_override_map(rows: list) -> dict:
    """Flat ScheduleOverride rows → LocoOverrideMap (inverse of _flatten_override_map)."""
    out: dict = {}
    for r in rows:
        try:
            payload = json.loads(r.payload_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue  # skip only genuinely malformed payloads — never swallow ORM/session errors,
                      # which must surface (a silent {} here loses every saved edit on reload)
        ov = out.setdefault(r.loco_key, {})
        if r.scope == "loco":
            for kk in ("takt", "startShiftDays", "finishShiftDays"):
                if kk in payload:
                    ov[kk] = payload[kk]
        elif r.scope == "ws":
            ov.setdefault("ws", {})[r.scope_key] = payload
        elif r.scope == "desc":
            ov.setdefault("desc", {})[r.scope_key] = payload
        elif r.scope == "addws":
            ov.setdefault("addWs", {})[r.scope_key] = payload
    return out




# ── Schedule visual overrides (persisted DELTA layer; PER SCENARIO) ────────────────────
# Original Data + Override = Effective Schedule. These endpoints ONLY read/write the
# schedule_override delta table; the source schedule is never touched. The merge back into a
# final schedule happens on the client at load time (the worker's applyOverrideToGroup).
# Every read/write is scoped by scenario_id (the scenario NAME; '' = base DB schedule).
_BASE_SCENARIO = ""  # scenario_id sentinel for the base DB schedule

# Projeção (Schedule Mode 3) reference snapshot. It is itself a LocoOverrideMap — the standard schedule
# a planner froze as the deviation baseline — so it is stored in the SAME schedule_override delta table
# under a reserved scenario_id namespace that no imported scenario name can collide with. Every existing
# ScheduleOverride query is scenario_id-scoped, so these rows are invisible to the base-schedule
# override endpoints. Shared (one per scenario, like the overrides): Editor+ writes it, everyone reads it.
#
# The namespace used to be a leading NUL ("\x00projref:"). PostgreSQL rejects 0x00 in text columns, so
# EVERY write through this namespace failed with `invalid byte sequence for encoding "UTF8": 0x00`
# (which also means there are no legacy rows to migrate — none could ever be stored). The marker is now
# plain text; _is_reserved_scenario_id below keeps a client from reaching these rows through the public
# scenario parameter, which the NUL used to prevent by accident.
_PROJREF_PREFIX = "__projref__:"

# Projeção is an isolated future-planning layer: edits made here are visible ONLY in Projeção and can
# never leak into the operational plan. That isolation is why these deltas need their own namespace —
# get_overrides must never pick them up.
#
# Composition is a per-object REPLACE (frontend mergeOverrideMaps), not an addition, because
# startShiftDays is absolute-from-base: a Projeção edit states where the object should be, and any
# object it does not mention transparently inherits Standard.
_PROJOV_PREFIX = "__projov__:"


def _projref_scenario_id(scenario: str) -> str:
    return _PROJREF_PREFIX + (scenario or _BASE_SCENARIO)


@app.get("/api/gantt/overrides")
def get_overrides(scenario: str = "", _user: dict = Depends(require_auth)):
    """Return the saved overrides for ONE scenario as a LocoOverrideMap. Empty when none / no DB.

    `scenario` is the scenario IDENTITY (the imported scenario's name; '' = the base DB schedule).
    Edits are stored and restored per scenario, so each imported scenario keeps its own modifications
    and they never leak across scenarios."""
    if not _DB_AVAILABLE:
        return {}
    if _is_reserved_scenario_id(scenario):
        raise HTTPException(status_code=400, detail="Cenário inválido.")
    try:
        with get_db() as db:
            rows = db.query(ScheduleOverride).filter(
                ScheduleOverride.scenario_id == (scenario or _BASE_SCENARIO)
            ).all()
            # Build the map INSIDE the session: get_db() commits on exit, which expires the ORM
            # instances (expire_on_commit). Reading r.payload_json AFTER the block would raise
            # DetachedInstanceError — and _rebuild_override_map used to swallow it, returning {} and
            # silently losing every saved edit on reload. Reading here keeps the session bound.
            return _rebuild_override_map(rows)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))






def _projov_scenario_id(scenario: str) -> str:
    return _PROJOV_PREFIX + (scenario or _BASE_SCENARIO)


def _is_reserved_scenario_id(scenario: str) -> bool:
    """True when a client-supplied scenario name would land in one of the reserved namespaces above.
    Those namespaces are plain text now (they used to be NUL-prefixed, which PostgreSQL rejected), so
    the public /api/gantt/overrides endpoints — GET, PUT and especially the DELETE reset — must refuse
    such a name explicitly: otherwise ?scenario=__projov__:X would read, overwrite or wipe the Projeção
    layer through the operational-plan endpoints."""
    s = scenario or ""
    return s.startswith(_PROJOV_PREFIX) or s.startswith(_PROJREF_PREFIX)


@app.get("/api/gantt/projection-overrides")
def get_projection_overrides(scenario: str = "", _user: dict = Depends(require_auth)):
    """Return the Projeção override LAYER for ONE scenario as a LocoOverrideMap. Empty when none / no
    DB. Readable by any authenticated user, like the standard overrides — the projection plan is
    shared, not per-user."""
    if not _DB_AVAILABLE:
        return {}
    try:
        with get_db() as db:
            rows = db.query(ScheduleOverride).filter(
                ScheduleOverride.scenario_id == _projov_scenario_id(scenario)
            ).all()
            return _rebuild_override_map(rows)   # read inside the session (expire_on_commit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))




@app.get("/api/gantt/projection-ref")
def get_projection_ref(scenario: str = "", _user: dict = Depends(require_auth)):
    """Return the shared Projeção reference snapshot for ONE scenario as a LocoOverrideMap. Empty when
    none frozen / no DB. Readable by ANY authenticated user (readers included) — it is a shared
    deviation baseline, exactly like the base-schedule overrides. Stored in the schedule_override
    delta table under the reserved Projeção namespace (see _projref_scenario_id)."""
    if not _DB_AVAILABLE:
        return {}
    try:
        with get_db() as db:
            rows = db.query(ScheduleOverride).filter(
                ScheduleOverride.scenario_id == _projref_scenario_id(scenario)
            ).all()
            return _rebuild_override_map(rows)   # read inside the session (expire_on_commit), like get_overrides
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))




def _ensure_projbase_table() -> None:
    """Idempotently guarantee the projection_baseline table exists before the endpoints touch it.
    Startup create_all is wrapped in a broad try/except (a warning, not a hard stop), so if it raised
    on ANY table before reaching this one — or the DB was provisioned before this table existed — the
    routes still register (they're defined at import) and the first write would 500 on a missing
    relation. checkfirst=True makes this a no-op once the table is present."""
    try:
        ProjectionBaseline.__table__.create(bind=db_engine, checkfirst=True)
    except Exception as _e:  # never let a create race turn into a request failure
        logger.warning("[projbase] ensure table: %s", _e)


def _projection_versions(db, scenario: str) -> list:
    """All stored baseline versions for a scenario as plain dicts, ordered by version asc. Reads
    payload INSIDE the session (expire_on_commit), like get_overrides."""
    rows = db.query(ProjectionBaseline).filter(
        ProjectionBaseline.scenario_id == (scenario or _BASE_SCENARIO)
    ).order_by(ProjectionBaseline.version.asc()).all()
    out = []
    for r in rows:
        try:
            overrides = json.loads(r.payload_json) if r.payload_json else {}
        except (json.JSONDecodeError, TypeError):
            overrides = {}
        out.append({
            "version": r.version,
            "label": r.label,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "created_by": r.created_by,
            "overrides": overrides if isinstance(overrides, dict) else {},
        })
    return out


@app.get("/api/gantt/projection-baselines")
def get_projection_baselines(scenario: str = "", _user: dict = Depends(require_auth)):
    """Return the Projeção reference VERSION HISTORY for ONE scenario: { versions: [...] } ordered by
    version asc, each { version, label, created_at, created_by, overrides }. Readable by ANY
    authenticated user (readers included)."""
    if not _DB_AVAILABLE:
        return {"versions": []}
    try:
        _ensure_projbase_table()
        with get_db() as db:
            versions = _projection_versions(db, scenario)
            return {"versions": versions}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))














def _parse_saturday_dates(raw) -> list:
    """Accept a JSON list of ISO 'YYYY-MM-DD' Saturday dates; drop anything malformed or non-Saturday
    so a bad client payload can never poison the axis. Deduped + sorted."""
    if not isinstance(raw, list):
        return []
    out = set()
    for v in raw:
        if not isinstance(v, str) or len(v) != 10:
            continue
        try:
            d = datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            continue
        if d.weekday() == 5:            # Saturdays only
            out.add(v)
    return sorted(out)


@app.get("/api/gantt/saturday-workdays")
def get_saturday_workdays(scenario: str = "", _user: dict = Depends(require_auth)):
    """Return the working-Saturday ISO dates for ONE scenario (list). Empty when none / no DB."""
    if not _DB_AVAILABLE:
        return []
    try:
        with get_db() as db:
            row = db.query(ScenarioSaturdayWorkday).filter(
                ScenarioSaturdayWorkday.scenario_id == (scenario or _BASE_SCENARIO)
            ).first()
            if row is None:
                return []
            try:
                return _parse_saturday_dates(json.loads(row.dates_json))
            except (json.JSONDecodeError, TypeError, ValueError):
                return []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))








class _LocoEdit(BaseModel):
    """One manual LOCO edit. All fields optional; absent/None means 'leave unchanged'.
      takt:         new LOCO takt (duração), float 0.5..15 in 0.5 steps — recomputes the whole LOCO.
                    Decimal takt is preserved (2.5 stays 2.5); it is NOT cast to int.
      start_shift:  Deslocar Início, business days -10..+10 (negative = adiantar).
      finish_shift: Deslocar Término, business days -10..+10 (changes finish_ms → Protection Days).
    """
    wo:           str
    task_name:    str = ""
    takt:         float | None = None
    start_shift:  int | None = None
    finish_shift: int | None = None


class _EditLocosBody(BaseModel):
    # Full accumulated edit set (session-only, like Optimize). Resent on every change so
    # the rebuild is stateless: source schedule + all edits → fresh GanttData.
    edits: list[_LocoEdit] = []


def _apply_loco_edits(ms_by_wo: dict, edits: list, holidays) -> list[dict]:
    """Apply manual LOCO edits (session-only) IN PLACE on ms_by_wo. Shared by the
    edit-locos endpoint and the optimizer so the optimizer operates on the user's
    edited schedule (manual edits become the new baseline). Returns the applied
    [{wo, task_name}] list. Each edit may set takt / start_shift / finish_shift;
    None leaves that dimension unchanged."""
    from datetime import date, timedelta

    def _shift_business_days(d: date, n: int) -> date:
        """Add (n>0) or subtract (n<0) n business days, skipping weekends/holidays."""
        if not n:
            return d
        step = 1 if n > 0 else -1
        cur, rem = d, abs(n)
        while rem > 0:
            cur += timedelta(days=step)
            if cur.weekday() < 5 and cur not in holidays:
                rem -= 1
        return cur

    applied: list[dict] = []
    for ed in edits:
        tasks = ms_by_wo.get(ed.wo)
        if not tasks:
            continue
        for t in tasks:
            if (t.get("task_name") or "") != (ed.task_name or ""):
                continue
            # 1) Alterar Duração → novo takt (recalcula todo o LOCO via builder).
            # Preserve DECIMAL takt (0.5 resolution): snap to the nearest 0.5 and clamp to
            # 0.5..15 WITHOUT casting to int, so a 2.5-takt edit stays 2.5 (not 2).
            if ed.takt is not None:
                tk = max(0.5, min(15.0, round(float(ed.takt) * 2) / 2))
                t["takt"] = tk
                t["takt_raw"] = tk
            # 2) Deslocar Início → desloca start_ms (base de toda a rota)
            if ed.start_shift and t.get("start_ms"):
                t["start_ms"] = _shift_business_days(t["start_ms"], max(-10, min(10, int(ed.start_shift))))
            # 3) Deslocar Término → desloca finish_ms (muda Dias de Proteção)
            if ed.finish_shift and t.get("finish_ms"):
                try:
                    _fin = date.fromisoformat(str(t["finish_ms"])[:10])
                    _new_fin = _shift_business_days(_fin, max(-10, min(10, int(ed.finish_shift))))
                    t["finish_ms"] = _new_fin.isoformat()
                except (ValueError, TypeError):
                    pass
            applied.append({"wo": ed.wo, "task_name": ed.task_name})
    return applied


@app.post("/api/gantt/edit-locos")
async def gantt_edit_locos(
    body: _EditLocosBody = _EditLocosBody(),
    _user: dict = Depends(require_auth),
):
    """
    Edição manual de LOCOs (sessão, não persiste no banco). Aplica o conjunto
    completo de edições sobre o schedule-base e reconstrói o GanttData. Cada edição
    altera apenas o seu próprio LOCO; precedências internas (rota) são recalculadas
    automaticamente pelo builder a partir do takt/start_ms/finish_ms.

    Authorization: ANY authenticated role, Readers included — this is a SIMULATION, not a
    write. It is stateless: source schedule + the posted edit set → a freshly built
    GanttData in the response. `_apply_loco_edits` mutates only the `ms_by_wo` dict loaded
    for THIS request, nothing is stored, and no other user's view changes. Persisting a
    simulation still requires PUT /api/gantt/overrides, which stays Editor+ — so a Reader
    can explore a what-if but can never make it stick.
    """
    try:
        from gantt_builder import _load_source_data, _assemble_gantt_output, _get_holidays_for_dates

        ms_by_wo, rt_rows = _load_source_data()
        if not ms_by_wo:
            raise ValueError("Sem dados de schedule disponíveis.")

        all_starts = [t["start_ms"] for tasks in ms_by_wo.values() for t in tasks if t.get("start_ms")]
        holidays = _get_holidays_for_dates(all_starts) if all_starts else frozenset()

        applied = _apply_loco_edits(ms_by_wo, body.edits, holidays)

        data = _assemble_gantt_output(ms_by_wo, rt_rows)
        data["_locoEdits"] = {"applied": applied, "count": len(applied)}
        return data
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "gantt_optimize"))
























@app.get("/api/calendar/exceptions")
def get_calendar_exceptions(_user: dict = Depends(require_auth)):
    """The admin override DELTA (holiday/working dates) for ALL authenticated users.

    Read-only, non-sensitive (company holiday dates only). The frontend merges this into
    its algorithmic base calendar so the few client-side business-day helpers that can't
    read the server's per-day date_info still honor admin edits — one source of truth."""
    holidays: list[str] = []
    working: list[str] = []
    if _DB_AVAILABLE:
        try:
            with get_db() as db:
                for row in db.query(CalendarOverride).all():
                    k = str(row.kind or "").strip().lower()
                    if k == "holiday":
                        holidays.append(str(row.cal_date))
                    elif k == "working":
                        working.append(str(row.cal_date))
        except Exception as exc:
            logger.warning("[calendar] exceptions read failed: %s", exc)
    return {"status": "ok", "holidays": sorted(holidays), "working": sorted(working)}


#: A calendar axis is a day per row; two years is ~730. The ceiling is generous enough for
#: any plan horizon and small enough that no caller can ask for a decade by accident.
_CALENDAR_AXIS_MAX_DAYS = 1500


@app.get("/api/calendar/date-info")
def calendar_date_info(
    date_from: str = Query(..., alias="from", min_length=10, max_length=10),
    date_to:   str = Query(..., alias="to",   min_length=10, max_length=10),
    _user: dict = Depends(require_auth),
):
    """The working calendar for a date range, in the SAME row shape `GanttData.date_info`
    carries: [{ iso, label, dow, fw, is_weekend, is_holiday }].

    WHY THIS EXISTS. Every period axis in the app — activeYearMonths, activeFws,
    monthBusinessDays, fwBusinessDays, the fiscal-week ordering — is derived from the
    `date_info` the Gantt returns alongside the Schedule. A surface with no Schedule behind it
    therefore has no axis at all and renders empty, however many hours it holds. This is the
    same calendar with the Schedule taken out of it, so those derivations work unchanged and no
    client-side code re-invents fiscal weeks.

    Deliberately NOT `/api/calendar`, which is Admin-only: that route returns the override
    ROWS and the editing surface behind the Manage Calendar screen. This one returns only the
    computed working calendar — the same non-sensitive company-holiday shape
    `/api/calendar/exceptions` already serves to every authenticated user — so it is
    `require_auth`.

    `is_weekend` here is the PLAIN weekend (minus admin-declared exceptional working days).
    The Schedule's own version additionally un-weekends a Saturday that carries a real
    allocation; with no Schedule there is no allocation to read, and promoting a Saturday must
    remain a scheduling no-op regardless.
    """
    from services import calendar_445
    try:
        d0 = date.fromisoformat(date_from)
        d1 = date.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Datas inválidas — use YYYY-MM-DD.")
    if d1 < d0:
        raise HTTPException(status_code=400, detail="A data final é anterior à inicial.")
    span = (d1 - d0).days + 1
    if span > _CALENDAR_AXIS_MAX_DAYS:
        raise HTTPException(status_code=413, detail="O período solicitado é longo demais.")

    DOW_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
    try:
        rows = []
        for i in range(span):
            d = d0 + timedelta(days=i)
            rows.append({
                "iso": d.isoformat(),
                "label": d.strftime("%d/%m"),
                "dow": DOW_PT[d.weekday()],
                "fw": calendar_445.fw_label(d),
                "is_weekend": d.weekday() >= 5 and not calendar_445.is_forced_working(d),
                "is_holiday": calendar_445.is_holiday_day(d),
            })
        # Per-year FW label offsets across the range, non-zero only — same field the Gantt
        # payload carries, so a client can label a date outside the returned window itself.
        fw_offsets: dict[str, int] = {}
        for yr in {d0.year, d1.year}:
            off = calendar_445.fw_offset_for_year(yr)
            if off:
                fw_offsets[str(yr)] = off
        return {"status": "ok", "date_info": rows, "fw_offsets": fw_offsets}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "calendar_date_info"))





def _person_leaves(db, person_id: int) -> list[dict]:
    return [r.to_dict() for r in db.query(PersonLeave)
            .filter(PersonLeave.person_id == person_id)
            .order_by(PersonLeave.start_date.asc()).all()]


@app.get("/api/headcount")
def get_headcount(_user: dict = Depends(require_auth)):
    """List every workstation (with assigned people) + the full people roster
    (with vacation periods). Editor+ role, NO second factor — viewing/entering the tab is
    unlocked; only mutations below require the ADMIN_PASSWORD unlock (require_editor_unlock)."""
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    with get_db() as db:
        people = db.query(Person).order_by(Person.name.asc()).all()
        people_by_id = {p.id: p for p in people}
        links = db.query(WorkstationPerson).all()
        names_by_ws: dict[int, list[str]] = {}
        # Expertise levels ride along keyed by person NAME — the same key `people` uses, so the
        # client reads one relationship from one shape instead of joining two lists by index.
        levels_by_ws: dict[int, dict[str, int]] = {}
        # Provenance rides in a PARALLEL map rather than boxing every level into an object:
        # `expertise` stays a flat name → int that every read site can use without unwrapping,
        # and only the two surfaces that show "quem avaliou / com que respostas" touch this.
        meta_by_ws: dict[int, dict[str, dict]] = {}
        for link in links:
            p = people_by_id.get(link.person_id)
            if p:
                names_by_ws.setdefault(link.workstation_id, []).append(p.name)
                if link.expertise_level is not None:
                    levels_by_ws.setdefault(link.workstation_id, {})[p.name] = int(link.expertise_level)
                if link.expertise_source or link.expertise_updated_at:
                    meta_by_ws.setdefault(link.workstation_id, {})[p.name] = link.expertise_meta()
        workstations = []
        for ws in db.query(Workstation).order_by(Workstation.wsn.asc()).all():
            d = ws.to_dict()
            d["people"] = sorted(names_by_ws.get(ws.id, []))
            d["expertise"] = levels_by_ws.get(ws.id, {})
            d["expertise_meta"] = meta_by_ws.get(ws.id, {})
            # The workstation's own target provenance. Omitted when nothing was ever recorded,
            # so an untouched row stays the shape it has always been.
            if ws.required_source or ws.required_updated_at:
                d["required_meta"] = ws.required_meta()
            workstations.append(d)
        people_out = []
        for p in people:
            d = p.to_dict()
            d["leaves"] = _person_leaves(db, p.id)
            people_out.append(d)
    return {"status": "ok", "workstations": workstations, "people": people_out}

























