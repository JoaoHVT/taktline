import os
import sys
import uuid
import asyncio
import json
import logging
import tempfile
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
# shell. Platform-injected vars (Railway) still work: no candidate file exists
# there, so this is a no-op.
#
# env_paths is the ONE exception to "no project module before load_dotenv": it
# imports only the standard library and reads no configuration at import time.
# It exists because the secrets must not sit in the OneDrive-synced tree — see
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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException, UploadFile, File, Form, Query, Depends, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from sqlalchemy import text, func, or_, case

from services.auth import (
    require_auth as _base_require_auth,
    validate_bearer_token,
    hash_password,
    verify_password,
    generate_password,
    issue_session_token,
    validate_password_strength,
    normalize_email,
    display_name_of,
    ALLOWED_DOMAIN,
    PASSWORD_MIN_LEN,
    SESSION_TTL_S,
)
from services.data_loader import load_and_prepare_data, load_default_excel, get_items_for_import, get_items_catalog, compute_capacity_stats, get_wsn_people_map, get_period_days
from services.assembly_details import get_assembly_details
# Same key normalisation the resolver uses, so an explicit-demand payload keys on exactly
# what get_assembly_details() looks up.
from services.data_loader import _normalize as _norm_item_key
# FW → calendar-year map, so an optimization period's fiscal weeks resolve to real dates
# (needed to intersect the period with dated vacation ranges).
from services.data_loader import _build_fw_year_map, _fw_key as _fw_key_norm
from services import calendar_445
from services.optimizer import check_gurobi, build_snapshot, run_optimization

# ── Denodo integration (optional: pyodbc + ODBC driver) ──────────────────────
try:
    from denodo import DENODO_AVAILABLE, DenodoError, test_connection as denodo_test_connection, list_datasets as denodo_list_datasets, run_dataset as denodo_run_dataset, run_dataset_data as denodo_run_dataset_data, run_custom_query as denodo_run_custom_query, fetch_transacted_hours_by_wo as denodo_fetch_transacted_hours_by_wo
except Exception as _denodo_import_exc:  # pragma: no cover - import guard
    DENODO_AVAILABLE = False

    class DenodoError(Exception):
        pass

    _denodo_import_exc_msg = str(_denodo_import_exc)
else:
    _denodo_import_exc_msg = ""

# ── SQL Server direct-access PROOF OF CONCEPT (isolated from Denodo) ──────────
# Experimental path evaluating a direct pytds connection to the Wabtec warehouse
# as an alternative to Denodo/ODBC. Optional import — never blocks app startup.
try:
    from mssql_poc import MSSQL_AVAILABLE, MssqlPocError, run_transacted_hours_test as mssql_run_test
except Exception as _mssql_import_exc:  # pragma: no cover - import guard
    MSSQL_AVAILABLE = False

    class MssqlPocError(Exception):
        pass

    def mssql_run_test(*_a, **_k):  # type: ignore
        raise MssqlPocError("Módulo mssql_poc indisponível.")

# ── Optional DB imports (graceful fallback when DB is not configured) ────────
try:
    from database import get_db, engine as db_engine, is_available as db_is_available, check_connection as db_check_connection
    from models import Base, MonthlyDemand, SolverJob, ScheduleRow, LocosRout, DbConfig, ItensRout, PlanoProd, ScheduleOverride, ScenarioSaturdayWorkday, ProjectionBaseline, LogisticaBase, GcrPlanSnapshot, TransactedHoursSnapshot, UserPermission, SecurityEvent, AuthThrottle, CalendarOverride, FiscalWeekOverride, Workstation, Person, WorkstationPerson, PersonLeave, AppSetting, AccessRequest, get_active_ver
    from import_excel_to_db import import_excel_to_db
    from import_excel_to_db import import_schedule_to_db, import_locos_rout_to_db
    from import_excel_to_db import import_itens_rout_to_db, import_plano_prod_to_db
    from import_excel_to_db import import_headcount_to_db
    from import_excel_to_db import IMPORT_MODES
    _DB_AVAILABLE = True
except Exception as _db_import_exc:
    _DB_AVAILABLE = False
    _db_import_exc_msg = str(_db_import_exc)
    IMPORT_MODES = ("replace", "append")  # keep the endpoint validation self-sufficient
else:
    _db_import_exc_msg = ""

# (.env is loaded at the very top of this module — see _ENV_PATH.)

# ── In-memory registry for background import jobs ────────────────────────────
_import_jobs: dict[str, dict] = {}

# Per-table import lock: at most ONE active import per table_key at any time.
# Maps table_key → job_id of the currently-active (running OR cancelling) import.
# This is the server-side guard that prevents the duplicate-records race where a
# cancelled-but-not-yet-stopped import thread and a freshly started one write into
# the SAME staging `ver` concurrently. A new import for a table whose previous job
# is still active is rejected (HTTP 409) until that job reaches a terminal state.
# Guarded by _import_lock_mutex so check-and-set is atomic across request threads.
_import_active: dict[str, str] = {}
_import_lock_mutex = threading.Lock()


def _try_acquire_import_slot(table_key: str, job_id: str) -> str | None:
    """Atomically claim the import slot for `table_key`. Returns None on success,
    or the job_id of the still-active import that blocks this one."""
    with _import_lock_mutex:
        active = _import_active.get(table_key)
        if active is not None:
            existing = _import_jobs.get(active)
            # Stale slot (job vanished or already terminal) → reclaim it.
            if existing is None or existing.get("status") in ("done", "error", "cancelled"):
                _import_active[table_key] = job_id
                return None
            return active
        _import_active[table_key] = job_id
        return None


def _release_import_slot(table_key: str, job_id: str) -> None:
    """Release the import slot for `table_key` IFF still held by `job_id`.
    Called from the worker's finally block so the slot is freed exactly when the
    job ends (done/error/cancelled), never leaving an orphaned lock."""
    with _import_lock_mutex:
        if _import_active.get(table_key) == job_id:
            del _import_active[table_key]

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


def _split_read_enabled() -> bool:
    """Whether the split read path is preferred (reported by the parity endpoint)."""
    return _split_read_mode() != "off"


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
# opens a fresh TLS connection to the Supabase pooler on every request) and only
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
    wide frame so the app reads the two normalized uploads, NOT the bundled
    HorasB3.xlsx. Returns None when the split is empty/disabled — the caller then
    falls back to reading the local Excel exactly as before (no behaviour change
    when the split tables are not populated, or when DISCRETIZADO_SPLIT_READ=0).
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


def _row_multiset(df: "pd.DataFrame", cols: list[str]) -> Counter:
    """Hash each row (NaN→null, sorted keys) into an order-independent multiset.

    Row ORDER is not part of the Discretizado contract — every consumer groups /
    filters by content, never by position — so parity is a SET equality, not a
    positional one. Legacy returns Postgres physical order; the split returns
    sheet (__rid) order, so a positional diff is a false negative. Hashing rows
    and comparing as multisets is the correct equivalence test.
    """
    import json as _json, hashlib as _hl
    out: Counter = Counter()
    sub = df.copy()
    sub.columns = [str(c) for c in sub.columns]
    sub = sub[cols]
    for _, row in sub.iterrows():
        norm: dict = {}
        for c in cols:
            v = row[c]
            try:
                if pd.isna(v):
                    v = None
            except (TypeError, ValueError):
                pass
            if hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    pass
            norm[c] = v
        h = _hl.md5(_json.dumps(norm, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
        out[h] += 1
    return out


def _split_parity_report() -> dict:
    """Compare ``_db_to_df_legacy`` (flat) vs ``_db_to_df_split`` (re-merged).

    Go/no-go gate for the split read path. Confirms the split reconstructs the
    SAME SET of rows (order-independent: see _row_multiset). Reports shape /
    column diffs and, when the multisets differ, how many rows are unique to each
    side. Also keeps a positional value-mismatch diagnostic (expected non-zero
    purely from row-order differences — informational only, NOT the gate).
    """
    legacy = _db_to_df_legacy()
    split  = _db_to_df_split(use_cache=False)   # parity must read the DB, not the cache
    if legacy is None or split is None:
        return {"status": "error", "message": "DB indisponivel para uma das fontes."}

    rep: dict = {
        "status": "ok",
        "split_read_enabled": _split_read_enabled(),
        "legacy_shape": list(legacy.shape),
        "split_shape": list(split.shape),
        "rows_match": legacy.shape[0] == split.shape[0],
    }
    legacy_cols = set(map(str, legacy.columns))
    split_cols  = set(map(str, split.columns))
    rep["missing_in_split"] = sorted(legacy_cols - split_cols)
    rep["extra_in_split"]   = sorted(split_cols - legacy_cols)

    # Order-independent multiset equality on the common columns — the real gate.
    common_cols = sorted(legacy_cols & split_cols)
    multiset_equal = False
    try:
        lc = _row_multiset(legacy, common_cols)
        sc = _row_multiset(split,  common_cols)
        multiset_equal = (lc == sc)
        if not multiset_equal:
            rep["rows_only_in_legacy"] = sum((lc - sc).values())
            rep["rows_only_in_split"]  = sum((sc - lc).values())
    except Exception as exc:
        logger.warning("parity multiset compare: %s", exc)
        rep["multiset_error"] = str(exc)
    rep["multiset_equal"] = multiset_equal

    # Positional diagnostic only (expected >0 from row-order differences).
    mismatches: dict[str, int] = {}
    if legacy.shape[0] == split.shape[0]:
        l = legacy.reset_index(drop=True)
        s = split.reset_index(drop=True)
        for c in [c for c in legacy.columns if str(c) in split_cols]:
            try:
                a = l[c]; b = s[c]
                neq = (a.values != b.values)
                both_nan = a.isna().values & b.isna().values
                diff = int((neq & ~both_nan).sum())
                if diff:
                    mismatches[str(c)] = diff
            except Exception as exc:
                mismatches[str(c)] = -1
                logger.warning("parity compare col %s: %s", c, exc)
    rep["positional_value_mismatches"] = mismatches

    rep["parity_ok"] = (
        rep["rows_match"]
        and not rep["missing_in_split"]
        and not rep["extra_in_split"]
        and multiset_equal
    )
    return rep

# Garante que o CapB335610 pode ser importado
sys.path.insert(0, str(Path(__file__).parent))

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
ENVIRONMENT  = os.getenv("ENVIRONMENT", "development")
JOB_STATE_DIR = Path(__file__).resolve().parent / ".job_state"
JOB_STATE_DIR.mkdir(exist_ok=True)

# Armazena jobs em memória (para produção use Redis)
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
# Railway bills log ingestion. Liveness endpoints are by far the chattiest thing
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

        # ── 1b. Defense-in-depth for Supabase: enable RLS on EVERY table ──────
        # Supabase auto-exposes a PostgREST REST API (anon/authenticated roles). The
        # app talks to Postgres directly as the owning `postgres` role, which BYPASSES
        # RLS — so enabling RLS with NO policies denies anon/authenticated everything
        # via PostgREST while leaving the app unaffected. This closes the gap where
        # tables created by create_all (user_permissions, monthly_demand, …) would
        # otherwise be reachable with only the public anon key. Idempotent.
        for _tbl in Base.metadata.tables:
            try:
                with db_engine.begin() as _conn:
                    _conn.execute(text(f'ALTER TABLE "{_tbl}" ENABLE ROW LEVEL SECURITY'))
            except Exception as _re:
                logger.warning("[startup] enable RLS on %s: %s", _tbl, _re)

        # ── 2. Idempotent schema migrations for legacy databases ───────────────
        # Each DDL runs in its own session so one failure doesn't block others.
        _MIGRATIONS = [
            # schedule optional columns
            "ALTER TABLE schedule ADD COLUMN IF NOT EXISTS linha TEXT",
            "ALTER TABLE schedule ADD COLUMN IF NOT EXISTS finish_ms TEXT",
            # Contratual — display-only contractual finish date (never read by the scheduler)
            "ALTER TABLE schedule ADD COLUMN IF NOT EXISTS contract_ms TEXT",
            # staged-import ver column (NOT NULL DEFAULT 0 makes existing rows ver=0)
            "ALTER TABLE monthly_demand ADD COLUMN IF NOT EXISTS ver INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE schedule      ADD COLUMN IF NOT EXISTS ver INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS ver INTEGER NOT NULL DEFAULT 0",
            # locos_rout optional columns
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS descricao TEXT",
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS workorder TEXT",
            # Plano de Produção pass-through columns (PART DESC / ESCOPO / LINHA)
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS part_desc TEXT",
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS escopo TEXT",
            "ALTER TABLE locos_rout    ADD COLUMN IF NOT EXISTS linha TEXT",
            # monthly_demand optional columns
            "ALTER TABLE monthly_demand ADD COLUMN IF NOT EXISTS lh DOUBLE PRECISION",
            "ALTER TABLE monthly_demand ADD COLUMN IF NOT EXISTS lm INTEGER",
            "ALTER TABLE monthly_demand ADD COLUMN IF NOT EXISTS turnos INTEGER",
            # user_permissions: roster + banned + lockout-history columns (readers now persisted)
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS last_login TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS lockout_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS last_lockout_at TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS warning_ack_at TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS last_role_change_at TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS last_role_change_by TEXT",
            # user_permissions: local credential (Azure AD / Entra ID replacement).
            # All NULLABLE with no backfill here — every pre-existing row keeps its username
            # and role and gets a generated password in _bootstrap_local_credentials(), which
            # runs once below and is the only place that may write a hash for an account whose
            # owner never chose one.
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS email TEXT",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS password_hash TEXT",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMP",
            "ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS must_change_password "
            "BOOLEAN NOT NULL DEFAULT FALSE",
            # security_events: admin-notification acknowledgement metadata (NULL = active alert)
            "ALTER TABLE security_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP",
            "ALTER TABLE security_events ADD COLUMN IF NOT EXISTS acknowledged_by TEXT",
            # security_events: machine-readable change payload, forensics only — never returned by
            # any endpoint (see SecurityEvent.detail_json).
            "ALTER TABLE security_events ADD COLUMN IF NOT EXISTS detail_json TEXT",
            # The alerts badge counts ACTIVE alerts (acknowledged_at IS NULL) — a tiny,
            # roughly constant subset of a table that is append-only and never pruned.
            # These columns arrived via ALTER TABLE, so the model's index=True never
            # materialized here (create_all only builds indexes for tables it creates):
            # the count was a sequential scan growing with total audit history forever.
            # A PARTIAL index covers exactly the rows the badge asks about, so the query
            # cost tracks the number of UNACKED alerts, not the size of the trail.
            "CREATE INDEX IF NOT EXISTS ix_security_events_active ON security_events (id) "
            "WHERE acknowledged_at IS NULL",
            # person: home area (B1/B2/B3/WGS), mirroring workstation.area
            "ALTER TABLE person ADD COLUMN IF NOT EXISTS area TEXT",
            # Expertise levels (0–3). Both NULLABLE with no default on purpose: NULL means
            # "never assessed", which is exactly the state every existing row is in, and it is
            # read as 0. No backfill — inventing a level for 55×58 pairs would look like data
            # the supervision never entered, and the run-level toggle is what keeps the
            # unfilled matrix from changing any result meanwhile.
            "ALTER TABLE workstation ADD COLUMN IF NOT EXISTS required_level INTEGER",
            "ALTER TABLE workstation_person ADD COLUMN IF NOT EXISTS expertise_level INTEGER",
            # Provenance of an expertise level (see WorkstationPerson.expertise_source).
            "ALTER TABLE workstation_person ADD COLUMN IF NOT EXISTS expertise_source TEXT",
            "ALTER TABLE workstation_person ADD COLUMN IF NOT EXISTS expertise_answers TEXT",
            "ALTER TABLE workstation_person ADD COLUMN IF NOT EXISTS expertise_updated_at TIMESTAMP",
            "ALTER TABLE workstation_person ADD COLUMN IF NOT EXISTS expertise_updated_by TEXT",
            # Provenance of a workstation's TARGET level (see Workstation.required_source).
            "ALTER TABLE workstation ADD COLUMN IF NOT EXISTS required_source TEXT",
            "ALTER TABLE workstation ADD COLUMN IF NOT EXISTS required_answers TEXT",
            "ALTER TABLE workstation ADD COLUMN IF NOT EXISTS required_updated_at TIMESTAMP",
            "ALTER TABLE workstation ADD COLUMN IF NOT EXISTS required_updated_by TEXT",
        ]
        for _ddl in _MIGRATIONS:
            try:
                with get_db() as _mdb:
                    _mdb.execute(text(_ddl))
            except Exception as _e:
                logger.warning("[startup] Migration skipped: %s — %s", _ddl[:70], _e)

        # ── 3. Seed db_config active-version pointers if missing ──────────────
        # Ensures existing rows at ver=0 are immediately readable without an import.
        for _tbl in ["monthly_demand", "schedule", "locos_rout"]:
            try:
                with get_db() as _cdb:
                    _key = f"active_ver:{_tbl}"
                    if not _cdb.query(DbConfig).filter(DbConfig.key == _key).first():
                        _cdb.add(DbConfig(key=_key, val="0"))
            except Exception as _e:
                logger.warning("[startup] db_config seed(%s): %s", _tbl, _e)

        # ── 4. Prune solver_jobs older than 24 h ──────────────────────────────
        try:
            from datetime import datetime, timezone, timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            with get_db() as db:
                db.query(SolverJob).filter(SolverJob.updated_at < cutoff).delete(synchronize_session=False)
        except Exception as _e:
            logger.warning("[startup] Prune solver_jobs: %s", _e)

        # ── 5. Seed the initial Admin if NO admin exists yet ───────────────────
        # Guarantees there is always at least one administrator who can manage users
        # (recovery seed — only runs when the admin set is empty).
        try:
            with get_db() as _adb:
                has_admin = _adb.query(UserPermission).filter(UserPermission.role == "admin").first()
                if not has_admin:
                    _adb.add(UserPermission(username=_INITIAL_ADMIN, role="admin"))
                    logger.info("[startup] Seeded initial admin: %s", _INITIAL_ADMIN)
        except Exception as _e:
            logger.warning("[startup] Seed initial admin: %s", _e)

        # ── 5b. Give every pre-existing account a local password ───────────────
        # The Entra ID replacement: accounts that used to authenticate against Azure have
        # no password of their own. This generates one per account, keeping username, role,
        # block state and history exactly as they are, and writes the plaintext ONCE to a
        # local file for the admin to distribute. Defined further down (see the local-auth
        # section); the name resolves at call time.
        try:
            _bootstrap_local_credentials()
        except Exception as _e:
            logger.warning("[startup] Bootstrap de credenciais locais: %s", _e)

    # ── 6. Load the admin-editable working-calendar overrides into the engine ──
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
    title="CapB API",
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
    front door (the production Vercel domain plus a custom domain, say). Each entry is
    normalised: surrounding whitespace and any trailing slash are removed.

    That normalisation is not cosmetic. A CORS origin match is a byte-for-byte string
    comparison against the browser's `Origin` header, which NEVER carries a trailing slash
    or a path. Pasting "https://app.vercel.app/" out of the address bar therefore matches
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

# Compress responses to cut egress (Railway bills on network out). JSON payloads
# like /api/gantt/data and the Denodo datasets are highly repetitive → gzip shrinks
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
# should be pinned to the exact Vercel origin. Warn loudly if left as "*".
if _allow_all_origins and ENVIRONMENT == "production":
    logger.warning(
        "[security] CORS allow_origins='*' in production — set FRONTEND_URL to the "
        "exact frontend origin (e.g. https://<app>.vercel.app)."
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
# per-user JSON (/permissions/me, the admin roster, Denodo datasets, error bodies) could be
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
        response.headers["server"] = "OptVision"
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
# login, so ordinary users (even other @wabtec accounts) cannot reach them. A
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
_UNLOCK_TTL_S  = 15 * 60
_unlock_header = APIKeyHeader(name="X-Admin-Unlock", auto_error=False)


def _unlock_secret() -> bytes:
    """HMAC key for unlock grants, derived from ADMIN_PASSWORD so that rotating the
    password immediately invalidates every outstanding grant."""
    return _hashlib.sha256(("optvision-unlock|" + ADMIN_PASSWORD).encode("utf-8")).digest()


def _issue_unlock_token(email: str) -> tuple[str, int]:
    exp = int(_utime.time()) + _UNLOCK_TTL_S
    payload = f"{email}|{exp}"
    sig = _hmac.new(_unlock_secret(), payload.encode("utf-8"), _hashlib.sha256).hexdigest()
    token = _b64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii") + "." + sig
    return token, _UNLOCK_TTL_S


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


def require_unlock(
    user: dict = Depends(require_auth),
    token: str | None = Security(_unlock_header),
) -> dict:
    """Second factor only (any authenticated user + valid unlock grant)."""
    _enforce_unlock(user, token)
    return user


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


def require_admin_unlock(
    request: Request,
    user: dict = Depends(require_auth),
    token: str | None = Security(_unlock_header),
) -> dict:
    """Authorization (Admin) AND the second factor."""
    _check_pw_lockout(user)  # locked → generic 429 (wins over role / second-factor errors)
    if _current_role(user) != "admin":
        _record_perm_denied(user, request, "admin")
        raise HTTPException(status_code=403, detail="Acesso restrito a administradores.")
    _enforce_unlock(user, token)
    return user


def require_denodo_access(user: dict = Depends(require_auth)) -> dict:
    """Denodo view/export access — open to ANY role, including Reader.

    Denodo browsing/exporting is intentionally NOT gated on role or the admin second factor:
    the data source itself is protected by the user's own per-request Denodo credentials, so a
    Reader may connect, query, view and export just like an Editor/Admin. Every OTHER control is
    preserved unchanged:
      • Azure AD identity + @wabtec-domain validation → require_auth (_base_require_auth);
      • hard ban (is_blocked) → require_auth (_enforce_not_blocked, 403 + X-Blocked);
      • temporary failed-password lockout → _check_pw_lockout (generic 429) so a locked-out
        user stays blocked from Denodo too.
    Unauthenticated / non-@wabtec / banned / locked callers are therefore still rejected."""
    _check_pw_lockout(user)
    return user


# Role-only gates (no second factor). Defined HERE, beside the other dependencies, rather
# than further down the module: a `Depends(...)` default is evaluated when the route is
# decorated, so a handler declared above the definition would fail at import with a
# NameError. (`_current_role` is still a forward reference, but that one resolves at call
# time inside the body, which is fine.)
def require_editor(request: Request, user: dict = Depends(require_auth)) -> dict:
    """Dependency: allow Editors and Admins only (write access to schedule edits/imports)."""
    if _current_role(user) not in ("editor", "admin"):
        _record_perm_denied(user, request, "editor")
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    return user


def require_admin(request: Request, user: dict = Depends(require_auth)) -> dict:
    """Dependency: allow Admins only (user management)."""
    if _current_role(user) != "admin":
        _record_perm_denied(user, request, "admin")
        raise HTTPException(status_code=403, detail="Acesso restrito a administradores.")
    return user


# ── Brute-force protection: per-user rate limit + failed-password lockout ─────
# In-memory (single Railway instance; counters reset on restart — acceptable). All
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
# restarts, redeploys, and Railway scale-to-zero cold starts (see AuthThrottle).
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


@app.post("/api/admin/unlock", include_in_schema=False)
def admin_unlock(body: dict = Body(default={}), user: dict = Depends(require_auth)):
    """Exchange the ADMIN_PASSWORD for a short-lived (~15 min) unlock grant.

    The grant is HMAC-signed, bound to the caller's identity, and replayed by the
    frontend in the X-Admin-Unlock header on sensitive requests. Guarded by the
    per-user rate limit + failed-password lockout."""
    _check_pw_lockout(user)
    _rate_limit(user, "unlock")
    email = (user or {}).get("email", "")
    uname = _username_of(email)
    # Optional, client-supplied context ("Exportação Denodo — <base>") for the audit
    # trail. Sanitized: string-coerced + truncated; rendered as plain text in the UI.
    reason = str(body.get("reason") or "").strip()[:200]
    if not ADMIN_PASSWORD:
        if ENVIRONMENT == "production":
            raise HTTPException(status_code=503, detail="Operação bloqueada: ADMIN_PASSWORD não configurado no servidor.")
        token, ttl = _issue_unlock_token(email)   # dev convenience (no password configured)
        return {"unlock_token": token, "expires_in": ttl}
    if not _hmac.compare_digest(str(body.get("password", "")).strip(), ADMIN_PASSWORD):
        tripped = _record_pw_failure(user)
        # Audit-only (not an admin alert since the noise filter): recorded async, off the
        # response path, so the "senha incorreta" verdict returns without waiting on the write.
        _record_security_event(
            actor=uname, event_type="admin_pw_fail",
            detail=f"Senha administrativa incorreta{f' — {reason}' if reason else ''}.",
            throttle_key=(uname, "admin_pw_fail"), throttle_s=60,
        )
        if tripped:
            # This attempt tripped the lockout — return the generic revoked message
            # (with the signal header) rather than "wrong password".
            raise HTTPException(status_code=429, detail=_LOCKOUT_DETAIL, headers={"X-Locked-Out": "1"})
        raise HTTPException(status_code=403, detail="Senha administrativa incorreta.")
    _reset_pw_failures(user)
    # No 'admin_pw_used' row. A SUCCESSFUL unlock is only ever a means to an end, and every action
    # it authorizes is itself audited moments later (role_change / block / unblock / calendar_change
    # / data_edit_summary / data_download), by the same actor. The FAILURE above is the one that
    # carries information and is kept.
    token, ttl = _issue_unlock_token(email)
    return {"unlock_token": token, "expires_in": ttl}


# ── Modelos de entrada ──────────────────────────────────────────

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
    _persist_job(job_id)


def _append_job_log(job_id: str, line: str) -> None:
    """Appends one line to the in-memory job log (keeps last 300 lines)."""
    if job_id not in jobs:
        jobs[job_id] = _load_job(job_id) or {}
    cur = jobs[job_id].get("log") or []
    if not isinstance(cur, list):
        cur = []
    cur.append(line)
    jobs[job_id]["log"] = cur[-300:]
    _persist_job(job_id)


def _job_state_path(job_id: str) -> Path:
    return JOB_STATE_DIR / f"{job_id}.json"


def _public_job_data(data: dict | None) -> dict:
    if not data:
        return {}
    return {k: v for k, v in data.items() if not k.startswith('_')}


def _persist_job(job_id: str) -> None:
    """Fast path: write job state to local file only.
    Called on every update (progress, log lines) so must be fast.
    DB persistence is handled separately only at creation and terminal states."""
    raw = jobs.get(job_id)
    if not raw:
        return

    payload = _public_job_data(raw)
    json_str = json.dumps(payload, ensure_ascii=False)

    # File write only — fast, no network I/O
    try:
        tmp_path = _job_state_path(job_id).with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(json_str)
        os.replace(tmp_path, _job_state_path(job_id))
    except Exception as exc:
        logger.warning("[jobs] Falha ao persistir job em arquivo: %s", exc)


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
    # ── Try file first (fastest) ──────────────────────────────────────────
    path = _job_state_path(job_id)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                return data
        except Exception:
            pass

    # ── Fallback: DB (cross-worker / reconnect after restart) ──────────────
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
    Útil para diagnosticar problemas de deploy no Railway.
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


# ── Denodo endpoints ─────────────────────────────────────────────
# Generic Denodo dataset browser. Credentials are received per request and used
# only to open that single connection — they are NEVER stored server-side.

class DenodoCredentials(BaseModel):
    user: str
    password: str


class DenodoDatasetRequest(BaseModel):
    key: str
    user: str
    password: str
    # Standardized filter overrides (defaults come from the registry). Date filters use a
    # "dates between" clause with fallback boundaries; org is a multi-select (GCM/GCR/GCT).
    start_date: str | None = None
    end_date: str | None = None
    orgs: list[str] | None = None
    org: str | None = None  # legacy single-org (still honored as a fallback)
    max_rows: int | None = None


@app.post("/api/denodo/connect")
def denodo_connect(creds: DenodoCredentials, _user: dict = Depends(require_denodo_access)):
    """Validate Denodo credentials/connection and return the available datasets."""
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    try:
        denodo_test_connection(user=creds.user, password=creds.password)
        # No audit row for a successful CONNECTION. It records only that a gate the user had
        # already passed (Editor+ and the second factor) let them in, names no data, and at one
        # row per user per 10 min it was the trail's highest-volume entry with the lowest value.
        # The access that DOES name what was reached — opening a protected dataset — is still
        # audited in /api/db/dataset/{key}.
        return {"ok": True, "datasets": denodo_list_datasets()}
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[Denodo] erro inesperado ao conectar")
        raise HTTPException(status_code=500, detail="Erro inesperado ao conectar ao Denodo. Consulte os logs do servidor.")


@app.post("/api/denodo/dataset")
def denodo_dataset(req: DenodoDatasetRequest, _user: dict = Depends(require_denodo_access)):
    """Run a dataset's query and return the generated HTML page (as a string)."""
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    try:
        html = denodo_run_dataset(
            req.key,
            user=req.user,
            password=req.password,
            start_date=req.start_date,
            end_date=req.end_date,
            orgs=req.orgs,
            org=req.org,
            max_rows=req.max_rows,
        )
        return {"ok": True, "html": html}
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[Denodo] erro inesperado ao executar dataset")
        raise HTTPException(status_code=500, detail="Erro inesperado ao executar a consulta. Consulte os logs do servidor.")


@app.post("/api/denodo/dataset/data")
def denodo_dataset_data(req: DenodoDatasetRequest, _user: dict = Depends(require_denodo_access)):
    """Run a dataset's query and return a JSON payload (columns/types/rows/meta) that
    powers the in-app, Excel-like results grid. Filtering/sorting/search happen client
    side on this payload — no re-query is needed for those operations."""
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    try:
        data = denodo_run_dataset_data(
            req.key,
            user=req.user,
            password=req.password,
            start_date=req.start_date,
            end_date=req.end_date,
            orgs=req.orgs,
            org=req.org,
            max_rows=req.max_rows,
        )
        return {"ok": True, "data": data}
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[Denodo] erro inesperado ao carregar dados do dataset")
        raise HTTPException(status_code=500, detail="Erro inesperado ao carregar os dados. Consulte os logs do servidor.")


class DenodoQueryRequest(BaseModel):
    """A user-EDITED query, submitted from the results grid."""
    user: str
    password: str
    query: str
    max_rows: int | None = None
    # Display label for the grid header (the base the query was edited from). Cosmetic.
    label: str | None = None


@app.post("/api/denodo/query")
def denodo_query(req: DenodoQueryRequest, user: dict = Depends(require_denodo_access)):
    """Run a query the user edited in the results grid and return the same JSON payload
    as /api/denodo/dataset/data, so the grid renders it with no special case.

    SECURITY — this is the only endpoint that sends client-authored SQL to Denodo:
      • Access:      require_denodo_access (authenticated @wabtec account, not blocked,
                     not locked out). Deliberately NOT role-gated or second-factor gated,
                     for the same reason the browsable bases are not: the query runs on
                     the CALLER'S OWN Denodo credentials, supplied per request and never
                     stored, so it can read exactly what that person can already read from
                     any other Denodo client — and nothing more.
      • Statement:   validate_readonly_query() allows ONE statement that begins with
                     SELECT/WITH and contains no DML/DDL/session verb, checked on a copy
                     with comments and quoted literals stripped.
      • Volume:      max_rows is clamped by MAX_ROWS_CAP exactly like a registered base.
      • Abuse:       per-user sliding-window rate limit (a query is a real warehouse hit).
      • Errors:      driver exceptions never reach the client — _fetch_dataframe logs them
                     and returns a generic message (they can carry DSN/host/SQL).
      • Audit:       every run is recorded with a truncated, single-line copy of the query.
    """
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    _rate_limit(user, "denodo_query")
    uname = _username_of((user or {}).get("email", ""))
    try:
        data = denodo_run_custom_query(
            req.query,
            user=req.user,
            password=req.password,
            max_rows=req.max_rows,
            label=req.label,
        )
        # The executed query is what makes this row worth keeping: it names exactly what was
        # read. Collapsed to one line and truncated so the trail stays readable.
        flat = " ".join(str(req.query or "").split())[:500]
        _record_security_event(
            actor=uname,
            event_type="denodo_query",
            detail=f"Query Denodo personalizada executada ({data['rowCount']} linhas): {flat}",
        )
        return {"ok": True, "data": data}
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001
        logger.exception("[Denodo] erro inesperado ao executar a query personalizada")
        raise HTTPException(status_code=500, detail="Erro inesperado ao executar a consulta. Consulte os logs do servidor.")


# ── Horas Transacionadas — load & persist (PHASE 1) ──────────────────────────
# Pull the actual-hours snapshot from Denodo once and store it, so the display layer can
# read it from our own DB in sessions that have no Denodo access.
#
# TWO DISTINCT GATES, by design:
#   • Reaching this feature at all → require_editor_unlock: Editor+ role AND the ADMIN
#     second factor (ADMIN_PASSWORD → X-Admin-Unlock grant). Both preview and save carry
#     it, so the gate cannot be skipped by calling the write endpoint directly.
#   • Committing to the database → _check_app_password (IMPORT_PASSWORD), the same secret
#     and the same lockout budget as every other base import. Applied ONLY on save.
# Reading the stored snapshot needs neither: it is app data, gated by require_auth alone.
#
# Denodo credentials arrive per request and are used for that one connection — never
# stored, never logged, exactly as the rest of the Denodo surface.

class LocoScope(BaseModel):
    """One locomotive the rollup may attribute hours to, with what proves the attribution.

    `name` is the DISPLAY name and may carry an artificial disambiguation tag (`B3#…`) that
    exists only because the schedule cannot hold two locos of the same name; the matcher
    strips it. `tipo`, `ws` and `items` are consulted ONLY when the same serial is planned
    under more than one Tipo — then the row goes to whichever Tipo's routing actually
    contains the workstation/part number it was booked against. Sending them for every loco
    is unnecessary; sending them for a colliding serial is what keeps New Locos from
    swallowing Propulsion's hours.
    """
    name: str
    tipo: str | None = None
    ws: list[str] | None = None
    items: list[str] | None = None       # "WORKSTATION||PART NUMBER", upper-cased


class TransactedHoursPreviewRequest(BaseModel):
    user: str
    password: str
    start_date: str | None = None
    end_date: str | None = None
    orgs: list[str] | None = None
    max_rows: int | None = None
    # Locomotives currently loaded on the main page. Supplied so the prévia can return the
    # per-loco rollup computed over the FULL result, letting the page show the hours before
    # anything is written. Optional: without it the prévia still returns its grid + stats.
    # Accepts the plain name list too, for any caller predating the typed form.
    locos: list[LocoScope] | list[str] | None = None
    # Workstation vocabulary per Tipo, used as the last tie-break when a serial collides and
    # neither loco's own routing has the station.
    type_ws: dict[str, list[str]] | None = None


class TransactedHoursSaveRequest(TransactedHoursPreviewRequest):
    # IMPORT_PASSWORD — the commit-to-database factor. Separate field from `password`,
    # which is the Denodo credential.
    import_password: str
    # The token the prévia handed back. Names a SERVER-HELD result — never rows — so the
    # save can reuse the warehouse read the prévia already paid for. Optional: without it
    # (or with a stale/foreign/mismatched one) the query is simply re-run, which is the
    # behaviour that existed before.
    preview_token: str | None = None
    # The snapshot version the client loaded, echoed back for optimistic concurrency. Must
    # be omitted only when no snapshot exists; against an existing one, absence is a
    # conflict, not consent.
    base_version: int | None = None


# ── Server-side prévia cache ────────────────────────────────────────────────────────────
# The save used to re-run the whole Denodo query, purely so the stored rows could not be
# dictated by the client. That property is what matters, not the second warehouse hit — so
# the prévia's own SERVER-BUILT summary is parked here under an opaque token and the save
# consumes the token. The client never holds the rows and cannot alter them; it holds a
# name for something only the server can produce.
#
# Bounded like _scenario_file_cache and for the same reason (Railway memory): oldest-first
# eviction on entry count AND total rows held, plus a TTL, because an abandoned prévia must
# not pin tens of MB until the next restart.
_th_preview_cache: dict[str, dict[str, Any]] = {}
_TH_PREVIEW_MAX_ITEMS = int(os.getenv("TH_PREVIEW_MAX_ITEMS", "4"))
_TH_PREVIEW_MAX_ROWS  = int(os.getenv("TH_PREVIEW_MAX_ROWS", "400000"))
_TH_PREVIEW_TTL_S     = int(os.getenv("TH_PREVIEW_TTL_S", "3600"))


def _th_scope_key(req: TransactedHoursPreviewRequest) -> tuple:
    """What a prévia was built FROM. A save whose scope differs must not reuse it."""
    return (
        (req.start_date or ""), (req.end_date or ""),
        tuple(sorted(req.orgs or [])),
        int(req.max_rows or 0),
    )


def _th_store_preview(summary: dict, meta: dict, owner: str, scope: tuple) -> str:
    """Park a prévia result and return its token."""
    now = _utime.time()
    for tok, ent in list(_th_preview_cache.items()):        # drop expired first
        if now - ent["at"] > _TH_PREVIEW_TTL_S:
            _th_preview_cache.pop(tok, None)

    token = _secrets.token_urlsafe(24)
    _th_preview_cache[token] = {
        "summary": summary, "meta": meta, "owner": owner, "scope": scope, "at": now,
    }

    while _th_preview_cache and (
        len(_th_preview_cache) > _TH_PREVIEW_MAX_ITEMS
        or sum(len(e["summary"]["rows"]) for e in _th_preview_cache.values()) > _TH_PREVIEW_MAX_ROWS
    ):
        oldest = next(iter(_th_preview_cache))
        if oldest == token:      # never evict the entry just stored
            break
        _th_preview_cache.pop(oldest, None)
    return token


def _th_take_preview(token: str | None, owner: str, scope: tuple) -> tuple[dict, dict] | None:
    """The parked prévia for this token, or None — in which case the caller re-runs the query.

    Three conditions, each of which makes reuse wrong rather than merely stale:
      • unknown or expired token — nothing to reuse;
      • different user — a token is not a capability to be passed around;
      • different scope — the classic "preview GCM, save GCR" swap; the query is re-run
        rather than refused, so a scope change costs time, never correctness.
    The entry is NOT consumed: a save rejected on the password or on a 409 must be
    retryable without paying the warehouse again.
    """
    if not token:
        return None
    ent = _th_preview_cache.get(token)
    if ent is None:
        return None
    if _utime.time() - ent["at"] > _TH_PREVIEW_TTL_S:
        _th_preview_cache.pop(token, None)
        return None
    if ent["owner"] != owner or ent["scope"] != scope:
        return None
    return ent["summary"], ent["meta"]


def _ensure_transacted_snapshot_table() -> None:
    """Idempotently guarantee transacted_hours_snapshot exists — same reasoning as
    _ensure_gcr_table: startup create_all is best-effort, so a route must not be the first
    thing to discover a missing relation."""
    try:
        TransactedHoursSnapshot.__table__.create(bind=db_engine, checkfirst=True)
    except Exception as _e:      # never let a create race turn into a request failure
        logger.warning("[horas-transacionadas] ensure table: %s", _e)


def _loco_scopes(locos: list[LocoScope] | list[str] | None) -> list[Any]:
    """Normalize either accepted `locos` shape into the plain dicts the matcher takes.

    Pydantic resolves `list[LocoScope] | list[str]` per element, so a mixed payload is
    possible; both forms are handled here rather than in the matcher, which then only ever
    sees one shape.
    """
    out: list[Any] = []
    for entry in locos or []:
        if isinstance(entry, LocoScope):
            out.append({
                "name": entry.name,
                "tipo": entry.tipo or "",
                "ws": entry.ws or [],
                "items": entry.items or [],
            })
        else:
            out.append(str(entry))
    return out


def _run_transacted_hours_query(req: TransactedHoursPreviewRequest):
    """Shared Denodo fetch + condense for both preview and save."""
    from services.transacted_hours import build_summary

    denodo_rows, meta = denodo_fetch_transacted_hours_by_wo(
        user=req.user,
        password=req.password,
        start_date=req.start_date,
        end_date=req.end_date,
        orgs=req.orgs,
        max_rows=req.max_rows,
    )
    return build_summary(denodo_rows), meta


def _require_denodo_and_db() -> None:
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados indisponível.")


@app.post("/api/transacted-hours/preview")
def transacted_hours_preview(
    req: TransactedHoursPreviewRequest,
    _user: dict = Depends(require_editor),
):
    """Read Denodo for the given period and return the summary WITHOUT persisting it.

    When `locos` is supplied the response also carries the per-loco rollup, folded from
    every row of the result (not the sample the grid gets). That is what makes the prévia
    reviewable: the mapping can be checked against the real hierarchy before the slow,
    irreversible write, instead of after it.

    The response also carries a `preview_token`: an opaque name for the summary THIS SERVER
    just built, parked in memory. A save presenting it skips the second warehouse read.
    The token names server-built rows and is bound to this user and this scope, so nothing
    a client sends can change what would be stored — only whether it has to be re-read.

    Editor+ WITHOUT the admin second factor — deliberately relaxed from
    require_editor_unlock. This endpoint reads and returns; it writes nothing. Reaching the
    warehouse still requires the caller's OWN per-request Denodo credentials, which is the
    control that actually protects the data (the same reasoning as require_denodo_access).
    Every other control is unchanged: Azure AD identity + @wabtec domain, hard ban, the
    failed-password lockout, and Editor+ authorization. The WRITE below keeps BOTH gates —
    require_editor_unlock AND the separate import password.
    """
    _require_denodo_and_db()
    try:
        from services.transacted_hours import preview_payload, rollup_from_summary

        summary, meta = _run_transacted_hours_query(req)
        payload = preview_payload(summary, meta)
        if req.locos:
            payload["rollup"] = rollup_from_summary(
                summary, _loco_scopes(req.locos), req.type_ws)
        payload["preview_token"] = _th_store_preview(
            summary, meta,
            owner=_username_of((_user or {}).get("email", "")),
            scope=_th_scope_key(req),
        )
        return {"ok": True, "preview": payload}
    except HTTPException:
        raise
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("[horas-transacionadas] erro inesperado na prévia")
        raise HTTPException(
            status_code=500,
            detail="Erro inesperado ao gerar a prévia. Consulte os logs do servidor.",
        )


@app.post("/api/transacted-hours/save")
def transacted_hours_save(
    req: TransactedHoursSaveRequest,
    user: dict = Depends(require_editor_unlock),
):
    """Persist the result as the active snapshot — one DELETE + one INSERT, one transaction.

    THE ROWS ARE ALWAYS THE SERVER'S. They are never accepted from the client: a
    client-supplied payload would let anyone holding both passwords write arbitrary numbers
    into the table the whole feature reads. What changed is only WHERE the server's rows
    come from — `preview_token` names a summary this process built minutes ago and still
    holds, so the identical result is not read from the warehouse a second time. No token,
    a foreign one, an expired one or a different scope, and the query is re-run exactly as
    before. The response reports what was actually stored, so any drift is visible.

    CONCURRENCY: `base_version` is the snapshot version the client loaded; a move since then
    is refused with 409 rather than overwritten.
    """
    _require_denodo_and_db()
    _check_app_password(req.import_password, user, context="Carga de horas transacionadas")
    try:
        from services.transacted_hours import save_snapshot, SnapshotConflict, SnapshotTooLarge

        uname = _username_of((user or {}).get("email", ""))
        cached = _th_take_preview(req.preview_token, uname, _th_scope_key(req))
        if cached is not None:
            summary, meta = cached
            reused = True
        else:
            summary, meta = _run_transacted_hours_query(req)
            reused = False

        if summary["stats"]["row_count"] == 0:
            raise HTTPException(
                status_code=409,
                detail="A consulta não retornou nenhuma linha — nada foi salvo. Verifique o período e as organizações.",
            )

        _ensure_transacted_snapshot_table()
        try:
            with get_db() as db:
                result = save_snapshot(db, summary, meta, created_by=uname,
                                       base_version=req.base_version)
        except SnapshotConflict as conflict:
            when = conflict.saved_at.isoformat() if conflict.saved_at else "?"
            raise HTTPException(status_code=409, detail=(
                "As horas transacionadas foram publicadas por outra pessoa enquanto esta tela "
                f"estava aberta ({conflict.saved_by or 'desconhecido'}, {when}). "
                "Recarregue o status e gere a prévia novamente antes de salvar."
            ))
        except SnapshotTooLarge as too_big:
            raise HTTPException(status_code=413, detail=(
                f"O conjunto excede o tamanho máximo suportado ({too_big.size // 1048576} MB) — "
                "reduza o período ou as organizações."
            ))

        _record_security_event(
            actor=uname,
            event_type="data_import",
            detail=(
                f"Horas transacionadas carregadas: {result['row_count']} linhas, "
                f"{result['total_hours']} h, período {meta.get('start_date')} → {meta.get('end_date')}."
            ),
        )
        logger.info(
            "[horas-transacionadas] save: %d linhas, consulta %s",
            result["row_count"], "reaproveitada da prévia" if reused else "reexecutada no Denodo",
        )
        result["truncated"] = bool(meta.get("truncated"))
        result["reused_preview"] = reused
        return {"ok": True, "saved": result}
    except HTTPException:
        raise
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("[horas-transacionadas] erro inesperado ao salvar")
        raise HTTPException(
            status_code=500,
            detail="Erro inesperado ao salvar os dados. Consulte os logs do servidor.",
        )


class TransactedHoursRollupRequest(BaseModel):
    # Locomotives in scope, ALL Tipos. Each carries its Tipo and (for a serial planned under
    # more than one) its own routing, which is what decides the attribution — see
    # services.transacted_hours._fold_by_loco. The plain name list is still accepted and
    # behaves as it always did: longest matching serial wins.
    locos: list[LocoScope] | list[str]
    type_ws: dict[str, list[str]] | None = None


@app.post("/api/transacted-hours/rollup")
def transacted_hours_rollup(
    req: TransactedHoursRollupRequest,
    _user: dict = Depends(require_auth),
):
    """Actual hours per locomotive, read from the stored snapshot.

    Any authenticated role, and no Denodo credentials: that is the entire point of phase 1.
    This is the display layer's data source and must work in sessions that could never
    reach the warehouse.
    """
    if not _DB_AVAILABLE:
        return {"ok": True, "rollup": {"has_data": False, "locos": {}}}
    if not req.locos:
        return {"ok": True, "rollup": {"has_data": False, "locos": {}}}
    try:
        from services.transacted_hours import rollup_by_loco

        with get_db() as db:
            return {
                "ok": True,
                "rollup": rollup_by_loco(db, _loco_scopes(req.locos), req.type_ws),
            }
    except Exception:
        logger.exception("[horas-transacionadas] erro no rollup por locomotiva")
        raise HTTPException(
            status_code=500,
            detail="Erro ao calcular as horas realizadas por locomotiva.",
        )


@app.get("/api/transacted-hours/status")
def transacted_hours_status(_user: dict = Depends(require_auth)):
    """Metadata for the stored snapshot. Any authenticated role — this is app data, and
    the display layer needs it to say whether actual hours are available and from when."""
    if not _DB_AVAILABLE:
        return {"ok": True, "status": {"has_data": False}}
    try:
        from services.transacted_hours import active_batch_status

        with get_db() as db:
            return {"ok": True, "status": active_batch_status(db)}
    except Exception:
        logger.exception("[horas-transacionadas] erro ao ler o status")
        raise HTTPException(
            status_code=500,
            detail="Erro ao consultar os dados de horas transacionadas.",
        )


# ── SPIKE: actual (transacted) hours per locomotive ──────────────────────────
# Feasibility probe, NOT a feature. Joins Denodo's "Horas Transacionadas" work orders
# onto the Locos Rout work orders the Schedule / Plano de Produção already use, and sums
# the applied hours per loco.
#
# Read services/actual_hours_spike.py before trusting the numbers: the join is run under
# several identifier normalizations and the response names the match rate of each. A high
# `actual_hours` with a low `hours_match_pct` is a wrong answer, not a partial one.
#
# Same access policy as the rest of the Denodo surface (require_denodo_access): Azure AD
# identity + @wabtec domain + not-blocked + not-locked-out, then the user's OWN Denodo
# credentials per request, never stored. Reads nothing this endpoint's caller could not
# already reach through /api/denodo/dataset/data.

class ActualHoursSpikeRequest(BaseModel):
    user: str
    password: str
    start_date: str | None = None
    end_date: str | None = None
    orgs: list[str] | None = None
    org: str | None = None
    max_rows: int | None = None
    # Cap the per-loco table in the response. The diagnostics block is never truncated —
    # it is the part the spike exists to deliver.
    limit_locos: int | None = None


@app.post("/api/denodo/actual-hours-per-loco")
def actual_hours_per_loco(req: ActualHoursSpikeRequest, _user: dict = Depends(require_denodo_access)):
    """SPIKE — sum transacted hours per locomotive via the WORKORDER mapping."""
    if not DENODO_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Integração Denodo indisponível: driver pyodbc não instalado neste ambiente.",
        )
    if not _DB_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Banco de dados indisponível: a rota Locos Rout é necessária para o mapeamento.",
        )
    try:
        from services.actual_hours_spike import load_app_workorders, rollup_actual_hours

        with get_db() as db:
            app_rows = load_app_workorders(db)

        if not app_rows:
            raise HTTPException(
                status_code=409,
                detail="Nenhuma linha em Locos Rout na versão ativa — importe a base antes de rodar o spike.",
            )

        denodo_rows, denodo_meta = denodo_fetch_transacted_hours_by_wo(
            user=req.user,
            password=req.password,
            start_date=req.start_date,
            end_date=req.end_date,
            orgs=req.orgs,
            org=req.org,
            max_rows=req.max_rows,
        )

        result = rollup_actual_hours(app_rows, denodo_rows)

        # A capped Denodo fetch under-reports hours while still returning a plausible
        # total, so surface it as a first-class warning rather than a buried flag.
        result["denodo"] = {k: v for k, v in denodo_meta.items() if k != "query"}
        result["warnings"] = []
        if denodo_meta["truncated"]:
            result["warnings"].append(
                f"Consulta Denodo truncada em {denodo_meta['maxRows']} linhas agregadas — "
                "as horas estão SUBESTIMADAS. Aumente max_rows ou reduza o período."
            )
        _diag = result["diagnostics"]
        if _diag["variant_scores"][_diag["variant_used"]]["hours_match_pct"] < 50.0:
            result["warnings"].append(
                "Menos de 50% das horas do Denodo casaram com um WORKORDER de Locos Rout — "
                "os identificadores provavelmente divergem de formato. Veja "
                "diagnostics.unmatched_denodo_workorders."
            )

        if req.limit_locos:
            result["locos"] = result["locos"][: max(1, req.limit_locos)]

        return {"ok": True, "result": result}
    except HTTPException:
        raise
    except DenodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[spike] erro inesperado no rollup de horas por loco")
        raise HTTPException(
            status_code=500,
            detail="Erro inesperado ao calcular as horas por locomotiva. Consulte os logs do servidor.",
        )


# ── SQL Server direct-access PoC endpoint (isolated, experimental) ───────────
# Evaluates a DIRECT pytds connection to the Wabtec warehouse for "Horas
# Transacionadas", bypassing Denodo/ODBC entirely. Same access class as Denodo
# (protected by the user's own DB credentials, open to any authenticated role).
# This endpoint touches NONE of the Denodo code path.

class MssqlTestRequest(BaseModel):
    # SQL-auth credentials (optional: Integrated Auth is attempted regardless).
    user: str | None = None
    password: str | None = None
    # Optional physical table/view to sample-read (identifier-validated server-side;
    # defaults to GS_WIP_TRANSACTIONS).
    table: str | None = None
    max_rows: int | None = None
    # Optional period filter on TRANSACTION_DATETIME (yyyy-mm-dd, both required to apply).
    start_date: str | None = None
    end_date: str | None = None


@app.post("/api/mssql-poc/transacted-hours/test")
def mssql_poc_test(req: MssqlTestRequest, _user: dict = Depends(require_denodo_access)):
    """Run the isolated SQL Server feasibility probe: reachability → SQL auth +
    Integrated auth → sample read of the transacted-hours columns. Structured report."""
    try:
        report = mssql_run_test(
            user=req.user,
            password=req.password,
            table=req.table,
            max_rows=req.max_rows,
            start_date=req.start_date,
            end_date=req.end_date,
        )
        # No audit row — see the Denodo connect handler: a successful connectivity test behind an
        # already-audited authorization gate reads no business data and named none in the trail.
        return {"ok": True, "report": report}
    except MssqlPocError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:  # noqa: BLE001
        logger.exception("[MSSQL-PoC] erro inesperado no teste de conexão direta")
        raise HTTPException(status_code=500, detail="Erro inesperado no teste SQL Server. Consulte os logs do servidor.")


# ── Endpoints HTTP ───────────────────────────────────────────────

# Estas duas rotas sao intencionalmente sem autenticacao (ver
# deploy/audit/check_unauthed_routes.py), entao o que elas devolvem e publico para quem
# alcanca a porta. Nao devolvem mais ENVIRONMENT: dizer "development" a quem nao se
# autenticou entrega, de graca, a informacao de que ha superficie de desenvolvimento
# ligada — que e exatamente o que se procura antes de tentar um endpoint de dev. Quem
# consome estas rotas (useBackendHealth, WakingServerOverlay) so verifica se responderam.
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


@app.post("/api/optimize")
async def start_optimization(
    payload: OptimizationPayload,
    background_tasks: BackgroundTasks,
    _user: dict = Depends(require_auth),
):
    # Authorization: running the solver is an Editor+ action (Readers are view-only and
    # cannot import the items an optimization runs on). _current_role is defined later in
    # the module; the name resolves at call time, so the forward reference is fine.
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
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
    _persist_job(job_id)
    # Write to DB in a thread so we don't block the event loop.
    # This makes the job visible to _load_job on any worker even before the WS connects.
    import threading as _threading
    _threading.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()
    background_tasks.add_task(_run_optimization_job, job_id, payload)
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/optimize/{job_id}")
def cancel_job(job_id: str, _user: dict = Depends(require_auth)):
    # Authorization: cancelling is an Editor+ action, mirroring POST /api/optimize above —
    # only the roles that can START a run may stop one. This endpoint mutates job state and
    # persists it, so a Reader reaching it could kill any Editor's in-flight optimization
    # just by guessing/observing a job id. Readers are view-only (see the Reader read-only
    # scenario mode: load/compare/simulate are reads; every write path stays Editor+).
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    if job_id not in jobs:
        persisted = _load_job(job_id)
        if persisted is not None:
            jobs[job_id] = persisted
    if job_id in jobs:
        jobs[job_id]["status"] = "cancelled"
        jobs[job_id]["message"] = "Execução cancelada pelo usuário."
        _persist_job(job_id)
        import threading as _t; _t.Thread(target=_persist_job_to_db, args=(job_id,), daemon=True).start()
        stop_ev = jobs[job_id].get("_stop_event")
        if stop_ev is not None:
            stop_ev.set()
    return {"cancelled": True}


# ── Ingestão de dados ────────────────────────────────────────────
#
# Upload limits. Every route below used to call `await file.read()` (or copyfileobj) with no
# ceiling of any kind: no Content-Length check, no byte cap, no ASGI body limit. One authenticated
# @wabtec account — Reader included, since /api/gantt/scenario is deliberately open to Readers —
# could exhaust the Railway container's memory with a single POST. `_SCENARIO_CACHE_MAX_BYTES`
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
_UPLOAD_MAX_BYTES = int(os.getenv("UPLOAD_MAX_BYTES", str(40 * 1024 * 1024)))
_UPLOAD_CHUNK     = 1024 * 1024
_EXCEL_SUFFIXES   = (".xlsx", ".xls")


def _require_excel_upload(file: UploadFile) -> str:
    """Refuse anything that is not named like a workbook; return the original filename.

    The suffix is all that is checked, here as before — the parsers (openpyxl/pandas) are the
    real content validation and they reject a mislabelled file on their own. The point of this
    gate is to refuse the obvious case cheaply, BEFORE a byte is read into the process.
    """
    name = (file.filename or "").strip()
    if not name or not name.lower().endswith(_EXCEL_SUFFIXES):
        raise HTTPException(status_code=400, detail="Apenas arquivos .xlsx ou .xls são aceitos.")
    return name


def _reject_oversize_body(request: Request | None, max_bytes: int) -> None:
    """Refuse on the declared Content-Length before the body is read. Absent/unparsable header
    is NOT an error — the read loop still enforces the real limit."""
    raw = (request.headers.get("content-length") if request is not None else None)
    try:
        declared = int(raw) if raw else 0
    except ValueError:
        return
    # The header covers the whole multipart envelope (boundaries + the other form fields), so it
    # is always a little larger than the file. Comparing it against the same cap is deliberately
    # slightly strict; the slack is bytes, and the cap is not a precision instrument.
    if declared > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Arquivo grande demais (máximo {max_bytes // (1024 * 1024)} MB).",
        )


async def _read_upload_bounded(file: UploadFile, max_bytes: int | None = None) -> bytes:
    """Read an upload into memory, aborting with 413 as soon as the cap is exceeded.

    Chunked rather than `await file.read()`: the whole point is to stop at the limit instead of
    discovering it after the process has already allocated the file.
    """
    cap = max_bytes or _UPLOAD_MAX_BYTES
    buf = bytearray()
    while True:
        chunk = await file.read(_UPLOAD_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > cap:
            raise HTTPException(
                status_code=413,
                detail=f"Arquivo grande demais (máximo {cap // (1024 * 1024)} MB).",
            )
    return bytes(buf)


async def _spool_upload_bounded(file: UploadFile, dest, max_bytes: int | None = None) -> int:
    """Stream an upload to an open file handle under the same cap. Returns the byte count.

    Used where the handler wants the file on disk anyway — the bytes never accumulate in memory,
    but the ceiling is identical, so a caller cannot pick the unbounded path by accident.
    """
    cap = max_bytes or _UPLOAD_MAX_BYTES
    total = 0
    while True:
        chunk = await file.read(_UPLOAD_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise HTTPException(
                status_code=413,
                detail=f"Arquivo grande demais (máximo {cap // (1024 * 1024)} MB).",
            )
        dest.write(chunk)
    return total


@app.post("/api/upload-excel")
async def upload_excel(
    request: Request,
    file: UploadFile = File(...),
    ano:    int | None = Query(default=None, description="Filtrar por ano"),
    mes:    int | None = Query(default=None, description="Filtrar por mês (1-12)"),
    escopo: str | None = Query(default=None, description="Filtrar por escopo (ÚNICO, LEVE, MÉDIO, PESADO)"),
    _user: dict = Depends(require_auth),
):
    """
    Recebe um arquivo Excel (.xlsx), processa e retorna os dados
    estruturados de demanda, pessoas e capacidade.
    """
    # Authorization: uploading/ingesting a spreadsheet is an Editor+ action (Readers are
    # view-only). _current_role is defined later in the module; it resolves at call time.
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    _require_excel_upload(file)
    _reject_oversize_body(request, _UPLOAD_MAX_BYTES)

    # Spooled to disk under the cap, replacing an unbounded shutil.copyfileobj. The 413 is caught
    # and re-raised AFTER the `with` closes rather than inside it: the write stops mid-file, so a
    # partial temp file must be removed — and on Windows an open handle cannot be unlinked, which
    # is exactly what deleting it inside the block would attempt.
    oversize: HTTPException | None = None
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp_path = tmp.name
        try:
            await _spool_upload_bounded(file, tmp)
        except HTTPException as exc:
            oversize = exc
    if oversize is not None:
        Path(tmp_path).unlink(missing_ok=True)
        raise oversize

    try:
        result = load_and_prepare_data(tmp_path, ano=ano, mes=mes, escopo=escopo)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])

    return result


@app.get("/api/download-excel")
def download_excel(_user: dict = Depends(require_editor_unlock)):
    """
    Retorna o arquivo HorasB3.xlsx para download direto pelo navegador.
    Fallback: gera um xlsx temporário a partir do banco de dados quando o arquivo não existe.
    """
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    if default_path.exists():
        return FileResponse(
            path=str(default_path),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename="HorasB3.xlsx",
        )
    # Fallback: dump DB to a temporary xlsx
    df = _db_to_df()
    if df is None:
        raise HTTPException(status_code=503, detail="Arquivo Excel não encontrado e banco de dados indisponível.")
    import tempfile as _tempfile
    tmp = _tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    tmp.close()
    df.to_excel(tmp.name, index=False)
    return FileResponse(
        path=tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="HorasB3.xlsx",
    )


@app.get("/api/excel-preview")
def excel_preview(
    ano:    int | None = Query(default=None, description="Filtrar por ano"),
    mes:    int | None = Query(default=None, description="Filtrar por mês (1-12)"),
    escopo: str | None = Query(default=None, description="Filtrar por escopo"),
    _user: dict = Depends(require_auth),
):
    """
    Carrega o Excel padrão do servidor (HorasB3.xlsx) sem necessidade de upload.
    Útil para desenvolvimento local e testes rápidos.
    """
    result = load_default_excel(ano=ano, mes=mes, escopo=escopo)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


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
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    fws_list   = [f.strip() for f in fws.split(",") if f.strip()] if fws else None
    meses_list = [int(m.strip()) for m in meses.split(",") if m.strip().isdigit()] if meses else None
    # DB-split-first: prefer the two normalized uploads when populated.
    df_override = _capacity_source_df()
    if df_override is None and not default_path.exists():
        df_override = _db_to_df()
        if df_override is None:
            raise HTTPException(
                status_code=503,
                detail=f"Excel não encontrado e DB falhou. Causa: {_last_db_error or 'desconhecida'}. Acesse /api/db/debug para mais detalhes.",
            )
    result = get_items_for_import(default_path, ano=ano, mes=mes, meses=meses_list, fw=fw, fws=fws_list, mode=mode, df_override=df_override)
    if result.get("status") == "error" and df_override is None:
        # File exists but failed to parse (wrong format, missing sheets, etc.) → try DB
        df_fallback = _db_to_df()
        if df_fallback is not None:
            result = get_items_for_import(default_path, ano=ano, mes=mes, meses=meses_list, fw=fw, fws=fws_list, mode=mode, df_override=df_fallback)
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
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"

    def _parse(v: str | None) -> list[str] | None:
        if not v:
            return None
        lst = [x.strip() for x in v.split(",") if x.strip()]
        return lst or None

    # DB-split-first: prefer the two normalized uploads when populated.
    df_override = _capacity_source_df()
    if df_override is None and not default_path.exists():
        df_override = _db_to_df()
        if df_override is None:
            raise HTTPException(status_code=503, detail="Arquivo Excel não encontrado e banco de dados indisponível.")

    result = get_items_catalog(
        default_path,
        areas=_parse(areas),
        familias=_parse(familias),
        clientes=_parse(clientes),
        df_override=df_override,
    )
    if result.get("status") == "error" and df_override is None:
        # File exists but failed → try DB
        df_fallback = _db_to_df()
        if df_fallback is not None:
            result = get_items_catalog(default_path, areas=_parse(areas), familias=_parse(familias), clientes=_parse(clientes), df_override=df_fallback)
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
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    item_list = [i.strip() for i in items.split(",") if i.strip()]
    if not item_list:
        raise HTTPException(status_code=400, detail="Lista de itens vazia.")
    fws_list = [f.strip() for f in fws.split(",") if f.strip()] if fws else None
    # DB-split-first: prefer the two normalized uploads when populated.
    df_override = _capacity_source_df()
    if df_override is None and not default_path.exists():
        df_override = _db_to_df()
        if df_override is None:
            raise HTTPException(status_code=503, detail="Arquivo Excel não encontrado e banco de dados indisponível.")
    result = get_assembly_details(
        default_path,
        items=item_list,
        mes=mes,
        fws=fws_list,
        mode=mode,
        tipo_filter=tipo_filter.strip(),
        df_override=df_override,
    )
    if result.get("status") == "error" and df_override is None:
        # File exists but failed → try DB
        df_fallback = _db_to_df()
        if df_fallback is not None:
            result = get_assembly_details(default_path, items=item_list, mes=mes, fws=fws_list, mode=mode, tipo_filter=tipo_filter.strip(), df_override=df_fallback)
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

    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    df_override = _capacity_source_df()
    if df_override is None and not default_path.exists():
        df_override = _db_to_df()
        if df_override is None:
            raise HTTPException(status_code=503, detail="Arquivo Excel não encontrado e banco de dados indisponível.")
    result = get_assembly_details(
        default_path,
        items=codes,
        df_override=df_override,
        demand_override=demand,
    )
    if result.get("status") == "error" and df_override is None:
        df_fallback = _db_to_df()
        if df_fallback is not None:
            result = get_assembly_details(
                default_path, items=codes, df_override=df_fallback, demand_override=demand,
            )
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── WebSocket de progresso ───────────────────────────────────────

@app.websocket("/ws/{job_id}")
async def websocket_progress(websocket: WebSocket, job_id: str):
    # Backend auth for the WS channel. Browsers cannot set an Authorization header on
    # a WebSocket, so the client passes the Azure ID token as a ?token= query param.
    # Validate it with the SAME central check as every HTTP route (signature, expiry,
    # issuer, audience, identity, Wabtec domain) BEFORE accepting the socket. Reject
    # anonymous / invalid / non-Wabtec connections with 1008 (policy violation).
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
    Aqui você vai integrar com o CapB335610.py.
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

        default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
        df_db: object = None
        # DB-split-first: prefer the two normalized uploads (Item Rout + Plano Prod)
        # when populated, so the optimizer runs on the split data, not the bundled
        # Excel. Falls back to Excel, then to legacy DB, exactly as before.
        df_db = _capacity_source_df()
        if df_db is not None:
            _append_job_log(job_id, f"[SETUP] Dados carregados do banco (split: {len(df_db)} linhas).")
        elif not default_path.exists():
            _append_job_log(job_id, "[SETUP] HorasB3.xlsx não encontrado — tentando banco de dados...")
            df_db = _db_to_df()
            if df_db is None:
                raise RuntimeError(
                    f"Arquivo base não encontrado: {default_path.name}. "
                    f"Banco de dados também indisponível. Causa: {_last_db_error}"
                )
            _append_job_log(job_id, f"[SETUP] Dados carregados do banco de dados ({len(df_db)} linhas).")
        else:
            _append_job_log(job_id, f"[SETUP] Excel base localizado: {default_path.name}")

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
            default_path,
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
            df_override=df_db,
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
    Retorna o mapeamento WSN → [pessoas] a partir das abas
    Discretizado (coluna HEADCOUNT) e HeadCount do HorasB3.xlsx.
    Quando o Excel não está disponível, usa fallback do banco de dados.
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
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    # HEADCOUNT-TAB-FIRST: WSN→people is owned by the centralized Headcount tab
    # (Workstation/Person/WorkstationPerson), not the routing's HEADCOUNT column — that column is no
    # longer imported at all. When the DB is reachable the tab is the ONLY source, empty included:
    # "nobody allocated yet" must read as empty, not silently fall back to stale routing data.
    # The Excel path below survives only for a DB-less local/dev run.
    if _DB_AVAILABLE:
        hc = _headcount_source_dict()
        result = get_wsn_people_map(default_path, headcount_override=hc)
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
    elif default_path.exists():
        result = get_wsn_people_map(default_path)
    else:
        raise HTTPException(status_code=503, detail="Excel não encontrado e banco de dados indisponível.")
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


@app.get("/api/period-days")
def period_days(fws: str = "", _user: dict = Depends(require_auth)):
    """
    Retorna o total de dias mapeados para os FWs informados.
    Parâmetro: fws=17,18,19 (números de fiscal week separados por vírgula).
    Quando o Excel não está disponível, usa fallback do banco de dados.
    Usado pelo frontend para exibir 'Dias mapeados' no header dos resultados.
    """
    fw_list = [f.strip() for f in fws.split(",") if f.strip()]
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    # DB-split-first: FW→year mapping comes from the plan (Plano Prod) FW + ANO.
    df_db = _capacity_source_df()
    if df_db is not None:
        result = get_period_days(default_path, fw_list, df_override=df_db)
    elif default_path.exists():
        result = get_period_days(default_path, fw_list)
    else:
        df_db = _db_to_df()
        if df_db is None or df_db.empty:
            return {"status": "ok", "total_days": 0, "days_by_fw": {}}
        result = get_period_days(default_path, fw_list, df_override=df_db)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── KPIs de capacidade para o footer ────────────────────────────

@app.get("/api/capacity-stats")
def capacity_stats(_user: dict = Depends(require_auth)):
    """
    Retorna DISPONIVEL_H e ALOCADO_H calculados a partir das abas
    HeadCount e Testes do HorasB3.xlsx.
    Quando o Excel não está disponível, retorna zeros (dados não armazenados no banco).
    Usado pelo footer do frontend para exibir os KPIs de capacidade.
    """
    default_path = Path(__file__).resolve().parent / "HorasB3.xlsx"
    # Sourced from the Headcount tab whenever the DB is reachable. Previously this read only the
    # Excel HeadCount/Testes sheets and returned hardcoded zeros when HorasB3.xlsx was missing —
    # which is the production state — so these KPIs were permanently 0 and never saw the tab.
    if _DB_AVAILABLE:
        result = compute_capacity_stats(default_path, headcount_override=_headcount_source_dict())
    elif not default_path.exists():
        return {"status": "ok", "disponivel_h": 0.0, "alocado_h": 0.0}
    else:
        result = compute_capacity_stats(default_path)
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["message"])
    return result


# ── Database endpoints ───────────────────────────────────────────

# ── Error-log deduplication ──────────────────────────────────────────────────
# Railway bills log ingestion, and a single sustained fault (a Supabase blip, an
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


@app.get("/api/db/debug/split-status")
def db_debug_split_status(_user: dict = Depends(require_auth)):
    """Which source the Capacity app is currently serving + split table counts.

    Lets you confirm during a test whether the app reads the two normalized
    uploads (itens_rout + plano_prod) or falls back to Excel / legacy.
    """
    info: dict = {
        "mode": _split_read_mode(),                  # auto | on | off
        "excel_present": (Path(__file__).resolve().parent / "HorasB3.xlsx").exists(),
    }
    if not _DB_AVAILABLE:
        info["db_available"] = False
        return info
    info["db_available"] = True
    try:
        with get_db() as db:
            info["itens_rout_rows"] = db.query(ItensRout).filter(ItensRout.ver == get_active_ver(db, "itens_rout")).count()
            info["plano_prod_rows"] = db.query(PlanoProd).filter(PlanoProd.ver == get_active_ver(db, "plano_prod")).count()
            info["monthly_demand_rows"] = db.query(MonthlyDemand).filter(MonthlyDemand.ver == get_active_ver(db, "monthly_demand")).count()
    except Exception as exc:
        info["error"] = _log_and_generic(exc, "db_debug_split_status")
    # What _capacity_source_df would actually return now.
    src = _capacity_source_df()
    if src is not None:
        info["serving"] = "split"
        info["serving_rows"] = int(src.shape[0])
    elif info["excel_present"]:
        info["serving"] = "excel"
    else:
        info["serving"] = "legacy_db_or_none"
    return info


@app.get("/api/db/debug/split-parity")
def db_debug_split_parity(_user: dict = Depends(require_auth)):
    """Phase-1 go/no-go gate: diff legacy flat _db_to_df vs re-merged split.

    parity_ok=True means the split tables reconstruct the Discretizado sheet
    identically and a consumer can safely be switched onto _db_to_df_split.
    """
    if not _DB_AVAILABLE:
        return {"status": "error", "message": _db_import_exc_msg}
    try:
        return _split_parity_report()
    except Exception as exc:
        return {"status": "error", "message": _log_and_generic(exc, "db_debug_split_parity")}


@app.get("/api/db/debug")
def db_debug(_user: dict = Depends(require_auth)):
    """Diagnóstico completo: testa conexão, conta linhas, retorna amostra e último erro de _db_to_df."""
    import os as _os
    result: dict = {
        "db_modules_loaded": _DB_AVAILABLE,
        "db_url_set": bool(_os.getenv("DATABASE_URL")),
        "last_db_to_df_error": _last_db_error or None,
    }
    if not _DB_AVAILABLE:
        result["error"] = _db_import_exc_msg
        return result
    # Raw connection host + actual demand-row samples are only exposed to Admins;
    # any other authenticated user gets counts/booleans without internal details.
    _is_admin = _current_role(_user) == "admin"
    try:
        available, msg = db_check_connection()
        result["connection_ok"] = available
        result["connection_msg"] = msg if _is_admin else ("OK" if available else "Indisponível")
    except Exception as exc:
        result["connection_ok"] = False
        result["connection_msg"] = _log_and_generic(exc, "db_debug/connect")
        return result
    if result["connection_ok"]:
        try:
            with get_db() as db:
                _md_ver = get_active_ver(db, "monthly_demand")
                count = db.query(MonthlyDemand).filter(MonthlyDemand.ver == _md_ver).count()
                # Read attributes INSIDE the session to avoid DetachedInstanceError
                sample = [
                    {"id": r.id, "item": r.item, "ano": r.ano, "mes": r.mes, "fw": r.fw}
                    for r in db.query(MonthlyDemand).filter(MonthlyDemand.ver == _md_ver).limit(3).all()
                ] if _is_admin else None
            result["row_count"] = count
            if _is_admin:
                result["sample"] = sample
        except Exception as exc:
            result["query_error"] = _log_and_generic(exc, "db_debug/query")
    return result


@app.get("/api/db/status")
def db_status(_user: dict = Depends(require_auth)):
    """Verifica se o banco de dados está configurado e acessível.

    Also carries `server_offline`. That is not thematic, and it is deliberate: this endpoint is
    already polled by every open tab through useBackendHealth, so riding on it lets a client
    discover the deliberate-shutdown switch WITHOUT any additional periodic request. A dedicated
    poll for the flag would be self-defeating — the traffic it generates is exactly what has to
    stop for Railway's idle timer to run out. The client reacts by muting its own pollers.
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


@app.post("/api/db/import")
async def db_import_excel(
    request: Request,
    file: UploadFile = File(...),
    password: str = Form(default=""),
    mode: str = Form(default="replace"),
    _user: dict = Depends(require_auth),
):
    """
    Recebe um arquivo Excel (.xlsx), lê a aba 'Discretizado' e atualiza a tabela
    monthly_demand: mode='replace' substitui todos os registros, mode='append'
    preserva a base atual e acrescenta apenas os registros novos do arquivo.

    Requer autenticação Azure AD + senha de importação (IMPORT_PASSWORD).
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

    # Allowlist the mode — anything else is a client bug, never a silent replace.
    if mode not in IMPORT_MODES:
        raise HTTPException(status_code=400, detail="Modo de importação inválido.")

    # ── Authorization + second factor ────────────────────────────────────────
    # Identity (require_auth) is not enough: importing bases requires Editor+ AND
    # the import password. _check_app_password FAILS CLOSED in production.
    if _current_role(_user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    _check_app_password(password, _user, context="Importação de base (demanda mensal)")

    original_filename = _require_excel_upload(file)
    _reject_oversize_body(request, _UPLOAD_MAX_BYTES)

    # Read file content asynchronously before spawning the thread — bounded, so an oversized
    # upload is refused at the cap instead of being materialised in full first.
    contents = await _read_upload_bounded(file)
    actor = _username_of((_user or {}).get("email", ""))

    job_id = str(uuid.uuid4())
    _import_jobs[job_id] = {"status": "running", "logs": [], "result": None, "error": None, "cancel": False, "table_key": "discretizado"}

    # Single-import guard: reject if a previous import for this table is still
    # active (running OR cancelling). This is what prevents the duplicate-records
    # race (cancel → restart while the old thread is mid-write into the same ver).
    blocking = _try_acquire_import_slot("discretizado", job_id)
    if blocking is not None:
        del _import_jobs[job_id]
        raise HTTPException(
            status_code=409,
            detail="Já existe uma importação de 'Discretizado' em andamento. Aguarde-a finalizar ou cancelar antes de iniciar outra.",
        )

    def _do_import():
        def on_progress(msg: str):
            _import_jobs[job_id]["logs"].append(msg)
            if _import_jobs[job_id].get("cancel"):
                raise InterruptedError("Importação cancelada pelo usuário.")

        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
            tmp.write(contents)
            tmp_path = tmp.name
        try:
            with get_db() as db:
                result = import_excel_to_db(tmp_path, db, progress_callback=on_progress, mode=mode)
            if result.get("status") == "error":
                _import_jobs[job_id]["status"] = "error"
                _import_jobs[job_id]["error"]  = result.get("message", "Erro desconhecido")
            else:
                # Replace temp filename with the original filename in the result message
                if "message" in result and result["message"]:
                    import os as _os
                    result["message"] = result["message"].replace(
                        _os.path.basename(tmp_path), original_filename
                    )
                _import_jobs[job_id]["status"] = "done"
                _import_jobs[job_id]["result"] = result
                # ONE admin-facing alert per completed upload (audit + bell).
                _mode_txt = "acrescentada" if mode == "append" else "substituída"
                _record_security_event(
                    actor=actor, target="discretizado", event_type="data_import",
                    detail=f"Arquivo '{original_filename}' importado por {actor} — base 'Discretizado' (demanda mensal) {_mode_txt}.",
                    throttle_key=None,
                )
        except InterruptedError:
            _import_jobs[job_id]["status"] = "cancelled"
            _import_jobs[job_id]["error"]  = "Importação cancelada pelo usuário."
        except Exception:
            # Unexpected (non-validation) failure: the raw exception can carry the DB
            # host / SQL / stack — log it server-side, show the client only a generic note.
            logger.exception("[db_import] import job %s failed", job_id)
            _import_jobs[job_id]["status"] = "error"
            _import_jobs[job_id]["error"]  = "Erro interno durante a importação. Consulte os logs do servidor."
            _import_jobs[job_id]["logs"].append("[ERRO] Falha interna na importação.")
        finally:
            Path(tmp_path).unlink(missing_ok=True)
            # Free the slot exactly when this job ends, so the next import for this
            # table can start only once this thread has truly finished (incl. its
            # staging cleanup on cancel) — no overlap window.
            _release_import_slot("discretizado", job_id)

    # Run on a dedicated OS thread, NOT the shared default executor.
    # The import holds its thread for the full pandas-read + bulk DB write; using
    # the default ThreadPoolExecutor (which FastAPI shares for every sync route /
    # dependency / run_in_executor) would let it saturate the pool and leave the
    # job queued — the request returns a job_id but the work never starts, which
    # the frontend perceives as a "preparando importação" timeout. A dedicated
    # daemon thread starts immediately and never competes with the request pool.
    threading.Thread(target=_do_import, daemon=True, name=f"import-{job_id[:8]}").start()
    return {"job_id": job_id, "status": "started"}


@app.get("/api/db/import/status/{job_id}")
async def db_import_status(job_id: str, _user: dict = Depends(require_auth)):
    """Poll the status and logs of a background import job."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    job = _import_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job de importação não encontrado.")
    return {
        "status":    job["status"],
        "logs":      job["logs"],
        "result":    job.get("result"),
        "error":     job.get("error"),
        "table_key": job.get("table_key", ""),
    }


@app.post("/api/db/import/cancel/{job_id}")
async def cancel_import_job(job_id: str, _user: dict = Depends(require_auth)):
    """Request cancellation of a running background import job."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    job = _import_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job de importação não encontrado.")
    job["cancel"] = True
    return {"ok": True, "job_id": job_id}


def _make_import_endpoint(table_key: str):
    """
    Factory that creates a background import endpoint for a given table.
    table_key: 'schedule' | 'locos_rout'
    """
    async def _endpoint(
        request: Request,
        file: UploadFile = File(...),
        password: str = Form(default=""),
        mode: str = Form(default="replace"),
        _user: dict = Depends(require_auth),
    ):
        if not _DB_AVAILABLE:
            raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

        # Allowlist the mode — anything else is a client bug, never a silent replace.
        if mode not in IMPORT_MODES:
            raise HTTPException(status_code=400, detail="Modo de importação inválido.")

        # Authorization (Editor+) + second factor (import password, fails closed in prod).
        if _current_role(_user) not in ("editor", "admin"):
            raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
        _check_app_password(password, _user, context=f"Importação de base ({table_key})")

        original_filename = _require_excel_upload(file)
        _reject_oversize_body(request, _UPLOAD_MAX_BYTES)

        contents = await _read_upload_bounded(file)
        actor = _username_of((_user or {}).get("email", ""))
        job_id = str(uuid.uuid4())
        _import_jobs[job_id] = {"status": "running", "logs": [], "result": None, "error": None, "cancel": False, "table_key": table_key}

        # Single-import guard (see /api/db/import) — blocks the duplicate-records
        # race when a cancelled-but-not-stopped import overlaps a restart.
        blocking = _try_acquire_import_slot(table_key, job_id)
        if blocking is not None:
            del _import_jobs[job_id]
            raise HTTPException(
                status_code=409,
                detail=f"Já existe uma importação de '{table_key}' em andamento. Aguarde-a finalizar ou cancelar antes de iniciar outra.",
            )

        fn_map = {
            "schedule":   import_schedule_to_db,
            "locos_rout": import_locos_rout_to_db,
            "itens_rout": import_itens_rout_to_db,
            "plano_prod": import_plano_prod_to_db,
            "headcount":  import_headcount_to_db,
        }
        import_fn = fn_map[table_key]

        def _do():
            def on_progress(msg: str):
                _import_jobs[job_id]["logs"].append(msg)
                if _import_jobs[job_id].get("cancel"):
                    raise InterruptedError("Importação cancelada pelo usuário.")
            with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
                tmp.write(contents)
                tmp_path = tmp.name
            try:
                with get_db() as db:
                    result = import_fn(tmp_path, db, progress_callback=on_progress, mode=mode)
                if result.get("status") == "error":
                    _import_jobs[job_id]["status"] = "error"
                    _import_jobs[job_id]["error"]  = result.get("message", "Erro desconhecido")
                else:
                    _import_jobs[job_id]["status"] = "done"
                    _import_jobs[job_id]["result"] = result
                    # Invalidate Gantt cache so next open re-fetches fresh data
                    _invalidate_gantt_cache()
                    # Same for the capacity frame: an import swapped the active ver,
                    # so a cached split frame is now the PREVIOUS upload. Dropped
                    # unconditionally — cheap, and cheaper than reasoning about which
                    # of the five importers feeds the split.
                    _invalidate_capacity_cache()
                    # ONE admin-facing alert per completed upload (audit + bell).
                    _tbl_label = (_DB_DATASETS.get(table_key) or {}).get("label") or table_key
                    _mode_txt = "acrescentada" if mode == "append" else "substituída"
                    _record_security_event(
                        actor=actor, target=table_key, event_type="data_import",
                        detail=f"Arquivo '{original_filename}' importado por {actor} — base '{_tbl_label}' {_mode_txt}.",
                        throttle_key=None,
                    )
            except InterruptedError:
                _import_jobs[job_id]["status"] = "cancelled"
                _import_jobs[job_id]["error"]  = "Importação cancelada pelo usuário."
            except Exception:
                logger.exception("[db_import] import job %s failed", job_id)
                _import_jobs[job_id]["status"] = "error"
                _import_jobs[job_id]["error"]  = "Erro interno durante a importação. Consulte os logs do servidor."
            finally:
                Path(tmp_path).unlink(missing_ok=True)
                _release_import_slot(table_key, job_id)

        # Dedicated OS thread — see the note on /api/db/import for why we avoid
        # the shared default executor here.
        threading.Thread(target=_do, daemon=True, name=f"import-{job_id[:8]}").start()
        return {"job_id": job_id, "status": "started"}

    return _endpoint


app.add_api_route(
    "/api/db/import/schedule",
    _make_import_endpoint("schedule"),
    methods=["POST"],
    summary="Importa aba 'Schedule - MS' para a tabela 'schedule'",
)
app.add_api_route(
    "/api/db/import/locos-rout",
    _make_import_endpoint("locos_rout"),
    methods=["POST"],
    summary="Importa aba 'Locos Rout' para a tabela 'locos_rout'",
)
app.add_api_route(
    "/api/db/import/headcount",
    _make_import_endpoint("headcount"),
    methods=["POST"],
    summary="Importa aba 'HeadCount' para as tabelas workstation/person/workstation_person",
)
app.add_api_route(
    "/api/db/import/itens-rout",
    _make_import_endpoint("itens_rout"),
    methods=["POST"],
    summary="Importa o arquivo 'Itens Rout' para a tabela 'itens_rout'",
)
app.add_api_route(
    "/api/db/import/plano-prod",
    _make_import_endpoint("plano_prod"),
    methods=["POST"],
    summary="Importa o arquivo 'Plano Prod' para a tabela 'plano_prod'",
)


@app.get("/api/db/download/schedule")
def download_schedule(_user: dict = Depends(require_editor_unlock)):
    """Exporta a tabela 'schedule' como Excel para download."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            rows = db.query(ScheduleRow).filter(ScheduleRow.ver == get_active_ver(db, "schedule")).all()
            import json as _json
            records = [_json.loads(r.row_json) for r in rows]   # read row_json before the session closes
        if not records:
            raise HTTPException(status_code=404, detail="Tabela 'schedule' está vazia.")
        df = pd.DataFrame(records)
        import tempfile as _tmp
        tmp = _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        df.to_excel(tmp.name, index=False, sheet_name="Schedule - MS")
        return FileResponse(
            path=tmp.name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename="schedule_ms.xlsx",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_download"))


@app.get("/api/db/download/locos-rout")
def download_locos_rout(_user: dict = Depends(require_editor_unlock)):
    """Exporta a tabela 'locos_rout' como Excel para download."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            rows = db.query(LocosRout).filter(LocosRout.ver == get_active_ver(db, "locos_rout")).all()
            import json as _json
            records = [_json.loads(r.row_json) for r in rows]   # read row_json before the session closes
        if not records:
            raise HTTPException(status_code=404, detail="Tabela 'locos_rout' está vazia.")
        df = pd.DataFrame(records)
        import tempfile as _tmp
        tmp = _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        df.to_excel(tmp.name, index=False, sheet_name="Locos Rout")
        return FileResponse(
            path=tmp.name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename="locos_rout.xlsx",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_download"))


def _download_split_table(model, table: str, sheet_name: str, filename: str):
    """Shared helper: dump a split table's active-ver rows to xlsx for download."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            rows = db.query(model).filter(model.ver == get_active_ver(db, table)).all()
            import json as _json
            records = [_json.loads(r.row_json) for r in rows]   # read row_json before the session closes
        if not records:
            raise HTTPException(status_code=404, detail=f"Tabela '{table}' está vazia.")
        df = pd.DataFrame(records)
        import tempfile as _tmp
        tmp = _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        df.to_excel(tmp.name, index=False, sheet_name=sheet_name)
        return FileResponse(
            path=tmp.name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=filename,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_download"))


@app.get("/api/db/download/itens-rout")
def download_itens_rout(_user: dict = Depends(require_editor_unlock)):
    """Exporta a tabela 'itens_rout' como Excel (aba 'Itens Rout')."""
    return _download_split_table(ItensRout, "itens_rout", "Itens Rout", "itens_rout.xlsx")


@app.get("/api/db/download/plano-prod")
def download_plano_prod(_user: dict = Depends(require_editor_unlock)):
    """Exporta a tabela 'plano_prod' como Excel (aba 'Plano Prod')."""
    return _download_split_table(PlanoProd, "plano_prod", "Plano Prod", "plano_prod.xlsx")


@app.get("/api/db/tables")
def db_tables(_user: dict = Depends(require_auth)):
    """Retorna status e contagem de linhas de cada tabela gerenciada."""
    if not _DB_AVAILABLE:
        return {"available": False, "tables": {}}
    tables = {}
    try:
        with get_db() as db:
            tables["monthly_demand"] = {"rows": db.query(MonthlyDemand).filter(MonthlyDemand.ver == get_active_ver(db, "monthly_demand")).count(), "label": "Discretizado"}
            tables["schedule"]       = {"rows": db.query(ScheduleRow).filter(ScheduleRow.ver == get_active_ver(db, "schedule")).count(),   "label": "Schedule - MS"}
            tables["locos_rout"]     = {"rows": db.query(LocosRout).filter(LocosRout.ver == get_active_ver(db, "locos_rout")).count(),     "label": "Locos Rout"}
            tables["itens_rout"]     = {"rows": db.query(ItensRout).filter(ItensRout.ver == get_active_ver(db, "itens_rout")).count(),     "label": "Itens Rout"}
            tables["plano_prod"]     = {"rows": db.query(PlanoProd).filter(PlanoProd.ver == get_active_ver(db, "plano_prod")).count(),     "label": "Plano Prod"}
    except Exception as exc:
        return {"available": True, "error": _log_and_generic(exc, "db_tables"), "tables": tables}
    return {"available": True, "tables": tables}


# Datasets whose "last update" can be surfaced in the Excel modal. 'discretizado' maps to
# monthly_demand (imported via /api/db/import, target='discretizado'); the rest are in _DB_DATASETS.
_LAST_UPDATE_KEYS = ("discretizado", "schedule", "locos_rout", "itens_rout", "plano_prod", "headcount")


@app.get("/api/db/last-update/{table_key}")
def db_last_update(table_key: str, _user: dict = Depends(require_auth)):
    """Most recent 'update' for a managed dataset — the latest Excel import/rebuild or, for the
    schedule, a regular schedule edit — as (who, when). Powers the 'Última atualização' card shown
    on both Excel-modal tabs. Read-only metadata, available to any authenticated user.

    Source is the append-only SecurityEvent trail (data_import = Excel import/rebuild;
    data_edit_summary = a targeted edit in the in-app viewer). For the schedule it ALSO folds in the
    base-schedule Gantt edits (ScheduleOverride carries updated_at/updated_by) and returns whichever
    of the two is more recent."""
    key = (table_key or "").strip().lower()
    if key not in _LAST_UPDATE_KEYS:
        raise HTTPException(status_code=404, detail="Base desconhecida.")
    if not _DB_AVAILABLE:
        return {"available": False, "found": False}
    try:
        best_ts = None
        best_actor = None
        best_kind = None
        with get_db() as db:
            ev = (db.query(SecurityEvent)
                    .filter(SecurityEvent.target == key,
                            SecurityEvent.event_type.in_(("data_import", "data_edit_summary")))
                    .order_by(SecurityEvent.ts.desc(), SecurityEvent.id.desc())
                    .first())
            if ev is not None:
                best_ts, best_actor = ev.ts, ev.actor
                best_kind = "import" if ev.event_type == "data_import" else "edit"

            # Schedule: regular Gantt edits to the BASE schedule live in ScheduleOverride, not as a
            # dataset-targeted event — fold them in and keep whichever timestamp is newer.
            if key == "schedule":
                ov = (db.query(ScheduleOverride.updated_at, ScheduleOverride.updated_by)
                        .filter(ScheduleOverride.scenario_id == _BASE_SCENARIO)
                        .order_by(ScheduleOverride.updated_at.desc())
                        .first())
                if ov is not None and ov[0] is not None:
                    ov_ts = _aware(ov[0])
                    if best_ts is None or (ov_ts and ov_ts > _aware(best_ts)):
                        best_ts, best_actor, best_kind = ov[0], ov[1], "edit"

        if best_ts is None:
            return {"available": True, "found": False}
        return {
            "available": True,
            "found": True,
            "ts": _iso(best_ts),
            "actor": _username_of(best_actor or "") or None,
            "kind": best_kind,
        }
    except Exception as exc:
        return {"available": True, "found": False, "error": _log_and_generic(exc, "db_last_update")}


# ── Secure in-app dataset viewer / targeted editor ───────────────────────────
# Reuses the SAME security stack as every other sensitive surface: Editor+ role AND
# the ADMIN_PASSWORD second factor (require_editor_unlock). Lets authorized users
# view/filter and make SMALL targeted corrections (cell edit, add/delete row) without
# re-importing a whole workbook. Only changed rows are persisted (targeted INSERT/
# UPDATE/DELETE on the ACTIVE version), the indexed shortcut columns are recomputed from
# the edited row_json so ORM filtering stays consistent, and every SAVE is audited as ONE
# batch event in SecurityEvent (event_type='data_edit_summary', per-row detail embedded).
#
# Export: /export downloads one dataset as xlsx. It carries the unlock gate above PLUS
# the IMPORT_PASSWORD prompt and is audited as 'data_download' — see that handler.
#
# The registry mirrors each importer's column resolution (import_excel_to_db.py):
# `shortcuts` = (model_column, [header aliases], coercion-tag) and `required` =
# the header names that must be present + non-blank to insert a new row.
#
# `view_columns` is the ALLOWLIST the viewer/editor exposes, in display order. An
# imported workbook's row_json also carries columns the app never consumes (blank
# spacers, hidden helper columns, "Unnamed: N" artifacts), and sending them costs
# payload, memory and render time on every load. Only the names listed here are
# returned; each resolves through its `shortcuts` aliases so a base spelled
# "DESCRICAO" matches the "DESCRIÇÃO" entry. A listed column absent from the data
# is skipped, and unlisted keys are never sent — but they are PRESERVED on write
# (updates merge into the stored row_json; inserts backfill the full schema).
#
# `view_aliases` overrides that resolution for ONE display name: {name: [aliases]}.
# It exists for the columns the app reads but the importer never promoted to a typed
# shortcut — so they have no `shortcuts` entry to borrow aliases from — and for the
# case where two DIFFERENT sheet columns would otherwise collapse onto one entry.
# "DESCRIÇÃO" and "DESC" are exactly that: the routing sheet carries both (the part
# description and the OPERATION description), and the "DESCRIÇÃO" shortcut lists
# "DESC" among its aliases, so without an override the first entry swallows the
# second column and the operation description never renders. Aliases here are tried
# in order and the first one present in the data wins; the entry's own name is tried
# last. The invariant this whole block serves: a column the app's logic READS must be
# visible in the viewer — a hidden-but-used column is one nobody can correct.
#
# `row_filter` narrows which ROWS a dataset shows: a row is kept when at least one of
# the named columns is non-blank. Used by the Locus table, which is a projection of a
# few columns of `itens_rout` onto the subset of its rows that actually carry them.
#
# `allow_insert` / `allow_delete` (default True) gate the structural edits. The Locus
# table turns both off: it is a WINDOW onto itens_rout rows, so an insert there would
# create a routing row with no ASSEMBLY and a delete would destroy the routing the row
# also carries. Cell edits on the four visible columns are the whole point and stay on.
_DB_MAX_VIEW_ROWS = int(os.getenv("DB_VIEW_MAX_ROWS", "20000"))
_DB_MAX_OPS       = 5000   # per mutate request (defense against oversized batches)
# Per-row detail folded into the ONE batch audit row's detail_json. Bounded twice — op count and
# serialized bytes — so a 5000-row save can never store an unbounded blob. `opsTotal` records the
# real count, so a truncated payload is self-describing rather than silently short.
_DB_AUDIT_MAX_OPS   = 200
_DB_AUDIT_MAX_BYTES = 20000

_DB_DATASETS: dict[str, dict] = {
    "schedule": {
        "model": ScheduleRow, "table": "schedule", "label": "Schedule - MS",
        "required": ["Standard WO", "Task Name", "Start MS", "Takt"],
        "view_columns": ["Standard WO", "Task Name", "Start MS", "Finish MS", "Contratual", "Takt", "Linha"],
        "shortcuts": [
            ("wo",        ["Standard WO"], "str"),
            ("task_name", ["Task Name"], "str"),
            ("start_ms",  ["Start MS", "START MS", "Start", "START"], "date"),
            ("takt",      ["Takt"], "float"),
            ("linha",     ["Linha", "LINHA", "Line", "LINE"], "str"),
            ("finish_ms", ["Finish MS", "FINISH MS", "Finish", "FINISH"], "date"),
            # Contratual — the contractual finish date. Independent of finish_ms: nothing in the
            # scheduling maths reads it, it only feeds the Build Plan display.
            ("contract_ms", ["Contratual", "CONTRATUAL", "Contractual", "Data Contratual",
                             "Contract MS", "Contratual MS"], "date"),
        ],
    },
    "locos_rout": {
        "model": LocosRout, "table": "locos_rout", "label": "Locos Rout",
        "required": ["LOCOMOTIVA", "PART NUMBER", "HH UNIT", "DURACAO", "INICIO"],
        # PART DESC / ESCOPO / LINHA are the Plano de Produção pass-through columns. They are
        # imported and stored (models.LocosRout.part_desc/escopo/linha, and in row_json), and
        # ESCOPO now also splits a work order into one planning line per scope — so the base
        # they come from has to show them. Listing them here was the only thing missing: the
        # data was always present, just filtered out of the viewer's response.
        # OP / OPERAÇÃO / DESC / TIPO are the per-operation columns. On this base they are
        # OPTIONAL — the routing grain here is (LOCOMOTIVA, PART NUMBER) and the typed columns
        # above already cover every consumer (gantt_builder, actual_hours_spike). They are
        # listed because a sheet that DOES carry them must show them rather than hide them:
        # a listed-but-absent column is simply skipped by _resolve_view_columns.
        "view_columns": [
            "LOCOMOTIVA", "WORKSTATION", "AREA", "SUBAREA", "DESCRIÇÃO",
            "PART NUMBER", "PART DESC", "WORKORDER", "ESCOPO", "TIPO", "LINHA",
            "OP", "OPERAÇÃO", "DESC",
            "HH UNIT", "QTD", "DURACAO", "INICIO",
        ],
        "view_aliases": {
            # Pin DESCRIÇÃO to its own spellings so it cannot swallow the operation's DESC
            # column through the shortcut alias list below.
            "DESCRIÇÃO": ["DESCRIÇÃO", "DESCRICAO", "DESCRIÇAO"],
            "DESC":      ["DESC"],
            "OPERAÇÃO":  ["Escopo de Operação", "OPERAÇÃO", "OPERACAO"],
            "OP":        ["OP"],
            "TIPO":      ["TIPO", "TIPO OPERAÇÃO", "TIPO OPERACAO"],
        },
        "shortcuts": [
            ("locomotiva",  ["LOCOMOTIVA"], "str"),
            ("part_number", ["PART NUMBER"], "str"),
            ("workstation", ["WORKSTATION"], "str"),
            ("subarea",     ["SUBAREA"], "str"),
            ("descricao",   ["DESCRIÇÃO", "DESCRICAO", "DESCRIÇAO", "DESC"], "str"),
            ("area",        ["AREA"], "str"),
            ("hh_unit",     ["HH UNIT"], "float"),
            ("qtd",         ["QTD", "QTDE"], "int"),
            ("duracao",     ["DURACAO", "DURAÇÃO"], "str"),
            ("inicio",      ["INICIO", "INÍCIO"], "str"),
            ("workorder",   ["WORKORDER", "WORK ORDER", "WORK_ORDER"], "id"),
            # Aliases mirror the importer's `_find_col` lists (import_excel_to_db.py) so a base
            # spelled "PART DESCRIPTION" resolves to the same column the import read.
            ("part_desc",   ["PART DESC", "PART DESCRIPTION", "PART_DESC"], "str"),
            ("escopo",      ["ESCOPO"], "str"),
            ("linha",       ["LINHA"], "str"),
        ],
    },
    "itens_rout": {
        "model": ItensRout, "table": "itens_rout", "label": "Itens Rout",
        "required": ["ASSEMBLY"],
        # HEADCOUNT / LH / LM / TURNOS are deliberately absent: capacity moved to the Headcount tab
        # and the importer drops those columns, so listing them here would surface a column the
        # viewer/editor can no longer meaningfully write (and would show stale pre-cutover values on
        # old rows). Edit capacity in "Editar Headcount". WSN stays — it is the routing key the tab
        # is mapped through, not capacity data.
        # Every column below is READ by services/assembly_details.py when it resolves an
        # assembly's operations and hours (see its `fc(...)` block): OP orders the operations,
        # OPERAÇÃO/"Escopo de Operação" names them, DESC is the operation's own description,
        # TIPO is the operation type the Tipo/ESCOPO selection filters on, and HH TOTAL/HH
        # carries the hours. They were stored all along (the importer writes the whole sheet
        # into row_json) but were filtered out of the viewer, which is the definition of a
        # hidden-but-used column: the app acts on it and nobody can see or correct it.
        # LOCUS / COMP1 / FAMILIA2 / QTDE LOCUS also live on this base but are surfaced as
        # their own table — see the 'itens_rout_locus' entry below.
        "view_columns": [
            "ASSEMBLY", "COMPONENT", "DESCRIÇÃO", "WSN",
            "OP", "OPERAÇÃO", "DESC", "ESCOPO", "TIPO", "HH TOTAL",
        ],
        "view_aliases": {
            # DESCRIÇÃO (the part's) and DESC (the operation's) are two DIFFERENT columns on
            # this sheet. The `descricao` shortcut below lists DESC as an alias, so without
            # these two overrides the DESCRIÇÃO entry claims the DESC column and the operation
            # description is deduplicated away — the exact reason it never appeared.
            "DESCRIÇÃO": ["DESCRIÇÃO", "DESCRICAO", "DESCRIÇAO"],
            "DESC":      ["DESC"],
            "OPERAÇÃO":  ["Escopo de Operação", "OPERAÇÃO", "OPERACAO"],
            "OP":        ["OP"],
            "TIPO":      ["TIPO", "TIPO OPERAÇÃO", "TIPO OPERACAO"],
            # assembly_details reads hours as fc("HH", "HH TOTAL", "HOURS", "HORAS"), so a
            # sheet whose header is a bare "HH" was resolving hours the viewer could not show.
            "HH TOTAL":  ["HH TOTAL", "HH", "HORAS", "HOURS"],
        },
        "shortcuts": [
            ("assembly",  ["ASSEMBLY"], "str"),
            ("component", ["COMPONENT", "COMPONENTE"], "str"),
            ("descricao", ["DESCRIÇÃO", "DESCRICAO", "DESC"], "str"),
            ("wsn",       ["WSN"], "str"),
            ("escopo",    ["ESCOPO", "SCOPE"], "str"),
            ("hh_total",  ["HH TOTAL"], "float"),
        ],
    },
    # ── Itens Rout · Locus ────────────────────────────────────────────────────────────
    # NOT a table of its own: a four-column WINDOW onto the same itens_rout rows, shown
    # separately because the block answers a different question. LOCUS/COMP1/QTDE LOCUS are
    # read by services/assembly_details.py::_build_locus_map to multiply a component's hours
    # when the item's família is NEW LOCOS — a per-locomotive quantity, unrelated to the
    # routing grain the main Itens Rout table shows. Merged into that table they would read
    # as four mostly-blank columns on every routing row; on their own they are the New Locos
    # quantity list, and `row_filter` keeps only the rows that actually carry one.
    #
    # Structural edits are OFF (see allow_insert/allow_delete above): the row is an itens_rout
    # row that also holds routing, so an insert here would create one with no ASSEMBLY and a
    # delete would take the routing with it. Editing the four quantities is what this is for.
    "itens_rout_locus": {
        "model": ItensRout, "table": "itens_rout", "label": "Itens Rout · Locus",
        "required": ["LOCUS"],
        "view_columns": ["LOCUS", "COMP1", "FAMILIA2", "QTDE LOCUS"],
        "view_aliases": {
            "LOCUS":      ["LOCUS"],
            "COMP1":      ["COMP1"],
            "FAMILIA2":   ["FAMILIA2", "FAMÍLIA2"],
            "QTDE LOCUS": ["QTDE LOCUS", "QTD LOCUS"],
        },
        "row_filter":   ["LOCUS", "COMP1", "QTDE LOCUS"],
        "allow_insert": False,
        "allow_delete": False,
        # Shortcuts are itens_rout's own — the row written back is a full ItensRout row, so its
        # indexed columns must be recomputed from the SAME rules the main table uses.
        "shortcuts": [
            ("assembly",  ["ASSEMBLY"], "str"),
            ("component", ["COMPONENT", "COMPONENTE"], "str"),
            ("descricao", ["DESCRIÇÃO", "DESCRICAO", "DESC"], "str"),
            ("wsn",       ["WSN"], "str"),
            ("escopo",    ["ESCOPO", "SCOPE"], "str"),
            ("hh_total",  ["HH TOTAL"], "float"),
        ],
    },
    "plano_prod": {
        "model": PlanoProd, "table": "plano_prod", "label": "Plano Prod",
        "required": ["ITEM"],
        # DESCRIÇÃO / TIPO / ESCOPO were the hidden-but-used columns on this base:
        # services/data_loader.py::get_items_for_import reads DESCRIÇÃO into the item's
        # description, TIPO onto the item record, and ESCOPO to split a client's quantity per
        # scope (the LEVE/MEDIO/PESADO/UNICO breakdown the capacity workspace renders).
        "view_columns": [
            "ITEM", "DESCRIÇÃO", "CLIENTE", "AREA", "FAMILIA", "ANO", "MES",
            "FW", "QTDE FW", "TIPO", "TIPO FW", "ESCOPO", "NIVEL", "CUSTO",
        ],
        "view_aliases": {
            "DESCRIÇÃO": ["DESCRIÇÃO", "DESCRICAO", "DESC", "DESCRIPTION"],
            # Pinned so the plain "TIPO" entry cannot resolve onto the "TIPO FW" column.
            "TIPO":      ["TIPO"],
            "TIPO FW":   ["TIPO FW"],
            "ESCOPO":    ["ESCOPO", "SCOPE"],
        },
        "shortcuts": [
            ("item",    ["ITEM"], "str"),
            ("cliente", ["CLIENTE", "CLIENT"], "str"),
            ("area",    ["AREA"], "str"),
            ("familia", ["FAMILIA", "FAMILY"], "str"),
            ("ano",     ["ANO"], "int"),
            ("mes",     ["MES"], "int"),
            ("fw",      ["FW"], "fw"),
            ("qtde_fw", ["QTDE FW", "QTD FW"], "float"),
            ("tipo_fw", ["TIPO FW"], "str"),
            ("nivel",   ["NIVEL", "NIVEL FW"], "str"),
            ("custo",   ["CUSTO"], "float"),
        ],
    },
}


def _db_dataset_or_400(key: str) -> dict:
    spec = _DB_DATASETS.get(key)
    if spec is None:
        raise HTTPException(status_code=400, detail="Base de dados desconhecida.")
    return spec


def _norm_header(txt) -> str:
    """Accent-insensitive header key — mirrors import_excel_to_db._normalize."""
    import unicodedata
    s = unicodedata.normalize("NFD", str(txt if txt is not None else ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.strip().lower()


def _resolve_view_columns(key: str, present: list[str]) -> list[str]:
    """Map a dataset's `view_columns` allowlist onto the row_json keys actually present,
    in allowlist order. Each name resolves through its `view_aliases` override first, then
    its `shortcuts` aliases (so the stored spelling wins — "DESCRICAO" matches the
    "DESCRIÇÃO" entry), then by its own normalized name. Listed-but-absent columns are
    skipped; unlisted keys are never exposed. Falls back to every present key when a
    dataset declares no allowlist.

    The `view_aliases` layer is what keeps two entries off the same column: a name listed
    there resolves ONLY through the spellings it names, so "DESCRIÇÃO" (whose shortcut
    aliases include "DESC") can no longer claim the separate "DESC" column and leave the
    operation description invisible.
    """
    spec = _DB_DATASETS[key]
    allow = spec.get("view_columns")
    if not allow:
        return list(present)
    aliases_of = {_norm_header(a[0]): a for _c, a, _t in spec["shortcuts"]}
    # Explicit overrides win over the shortcut-derived aliases.
    for _name, _al in (spec.get("view_aliases") or {}).items():
        aliases_of[_norm_header(_name)] = list(_al)
    by_norm: dict[str, str] = {}
    for k in present:                       # first key wins on a normalized collision
        by_norm.setdefault(_norm_header(k), k)
    out: list[str] = []
    seen: set[str] = set()
    for name in allow:
        # The entry's own name is always the last candidate, so an alias list that misses
        # the stored spelling still resolves when the header matches the display name.
        cands = list(aliases_of.get(_norm_header(name), []))
        if name not in cands:
            cands.append(name)
        for cand in cands:
            hit = by_norm.get(_norm_header(cand))
            if hit is not None and hit not in seen:
                seen.add(hit)
                out.append(hit)
                break
    return out


def _row_filter_cols(key: str, present: list[str]) -> list[str]:
    """Resolve a dataset's `row_filter` names onto the stored keys, or [] when it has none."""
    names = (_DB_DATASETS[key].get("row_filter") or [])
    if not names:
        return []
    by_norm: dict[str, str] = {}
    for k in present:
        by_norm.setdefault(_norm_header(k), k)
    aliases_of = {_norm_header(n): list(a) for n, a in (_DB_DATASETS[key].get("view_aliases") or {}).items()}
    out: list[str] = []
    for name in names:
        for cand in aliases_of.get(_norm_header(name), []) + [name]:
            hit = by_norm.get(_norm_header(cand))
            if hit is not None:
                out.append(hit)
                break
    return out


def _keep_row(row: dict, filter_cols: list[str]) -> bool:
    """A row survives a `row_filter` when at least one of its columns is non-blank. No
    filter declared ⇒ every row survives."""
    if not filter_cols:
        return True
    for c in filter_cols:
        v = row.get(c)
        if v is None:
            continue
        if isinstance(v, str):
            if v.strip():
                return True
        else:
            return True
    return False


def _recompute_shortcuts(key: str, row_dict: dict) -> dict:
    """Recompute a row's indexed shortcut columns from its (edited) row_json dict,
    reusing the importers' coercion helpers so values match a fresh import exactly."""
    from import_excel_to_db import _str_val, _safe_float, _safe_int, _str_id_val, _fw_key
    import re as _re

    def _coerce(tag, v):
        if tag == "float": return _safe_float(v)
        if tag == "int":   return _safe_int(v)
        if tag == "id":    return _str_id_val(v)
        if tag == "fw":    return None if v is None else _fw_key(v)
        if tag == "date":
            s = _str_val(v)
            return s[:10] if (s and _re.match(r"\d{4}-\d{2}-\d{2}", s)) else s
        return _str_val(v)

    norm = {_norm_header(k): k for k in row_dict}
    out: dict = {}
    for col, cands, tag in _DB_DATASETS[key]["shortcuts"]:
        hit = next((norm[_norm_header(c)] for c in cands if _norm_header(c) in norm), None)
        out[col] = _coerce(tag, row_dict.get(hit)) if hit is not None else None
    return out


def _validate_required(key: str, values: dict) -> list[str]:
    """Return the list of required headers missing/blank in an insert payload."""
    from import_excel_to_db import _str_val
    norm = {_norm_header(k): v for k, v in values.items()}
    missing = []
    for name in _DB_DATASETS[key]["required"]:
        v = norm.get(_norm_header(name))
        if _str_val(v) is None:
            missing.append(name)
    return missing


@app.get("/api/db/dataset/{key}")
def db_dataset_view(key: str, _user: dict = Depends(require_editor_unlock)):
    """Return an editable dataset (active version) as columns/types/rows + parallel
    rowIds, in the shape the in-app grid consumes. Editor+ role AND second factor."""
    spec = _db_dataset_or_400(key)
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    # No 'protected_access' audit row: merely OPENING a protected screen is routine usage, not a
    # security event — it flooded the trail with one row per user per dataset per 10 min while the
    # actions that matter (data_edit_summary / data_download / data_import) are audited on their
    # own. Historical rows stay in the trail. The gate itself (require_editor_unlock) is unchanged.
    model, table = spec["model"], spec["table"]
    try:
        import re as _re
        has_filter = bool(spec.get("row_filter"))
        with get_db() as db:
            ver   = get_active_ver(db, table)
            total = db.query(model).filter(model.ver == ver).count()
            q = (db.query(model.id, model.row_json)
                   .filter(model.ver == ver)
                   .order_by(model.id))
            # A row_filter is evaluated on row_json, which SQL cannot narrow, so the LIMIT
            # can only be applied AFTER the filter — capping first would let 20k unmatched
            # rows hide every matching one behind them. The scan is bounded either way: the
            # importer caps this table at 50k rows and the payload is still capped below.
            if not has_filter:
                q = q.limit(_DB_MAX_VIEW_ROWS)
            raw = [(rid, json.loads(rj)) for rid, rj in q.all()]

        # Columns: the dataset's allowlist, resolved against the keys actually stored
        # (first-seen order across all loaded rows). Everything the app never consumes
        # — blank spacers, hidden helpers, "Unnamed: N" — is dropped before it is sent.
        present: list[str] = []
        seen: set[str] = set()
        for _rid, d in raw:
            for k in d.keys():
                if k not in seen:
                    seen.add(k); present.append(k)
        columns = _resolve_view_columns(key, present)

        if has_filter:
            fcols = _row_filter_cols(key, present)
            raw = [(rid, d) for rid, d in raw if _keep_row(d, fcols)]
            total = len(raw)                    # rowCount must describe THIS table, not the base
            raw = raw[:_DB_MAX_VIEW_ROWS]

        # Per-column type inference (number/date/text) over a bounded sample.
        types: list[str] = []
        for col in columns:
            t = None
            for _rid, d in raw[:3000]:
                v = d.get(col)
                if v is None or v == "":
                    continue
                if isinstance(v, bool):
                    tt = "text"
                elif isinstance(v, (int, float)):
                    tt = "number"
                elif isinstance(v, str) and _re.match(r"^\d{4}-\d{2}-\d{2}", v):
                    tt = "date"
                else:
                    tt = "text"
                if t is None:
                    t = tt
                elif t != tt:
                    t = "text"; break
            types.append(t or "text")

        rows    = [[d.get(c) for c in columns] for _rid, d in raw]
        row_ids = [rid for rid, _d in raw]
        return {
            "ok": True,
            "data": {
                "key": key, "label": spec["label"], "title": spec["label"],
                "columns": columns, "types": types, "rows": rows, "rowIds": row_ids,
                "required": spec["required"],
                # Structural-edit permissions travel with the payload so the grid hides the
                # controls the server would refuse anyway (see db_dataset_mutate).
                "allowInsert": spec.get("allow_insert", True),
                "allowDelete": spec.get("allow_delete", True),
                "rowCount": total, "maxRows": _DB_MAX_VIEW_ROWS,
                "truncated": total > len(raw),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_dataset"))


@app.post("/api/db/dataset/{key}/mutate")
def db_dataset_mutate(key: str, body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Apply targeted INSERT/UPDATE/DELETE to the active version of a dataset. Only the
    submitted rows change; shortcut columns are recomputed; every op is audited.

    THREE gates, deliberately one more than a read. Editor+ role AND the admin second
    factor (require_editor_unlock) get you into the viewer; WRITING additionally requires
    the shared application password (IMPORT_PASSWORD — the same secret the Importação flow
    asks for), checked BEFORE a single row is touched. The two secrets are distinct on
    purpose: the admin password says who may LOOK at a base, the import password says who
    may CHANGE it, and holding the first no longer implies the second. This mirrors
    /export, which has carried the same second secret since it was added.

    Body: { "password": <str>, "inserts": […], "updates": […], "deletes": […] }.
    """
    spec = _db_dataset_or_400(key)
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    # Password first: nothing is read or written until it validates. Wrong guesses feed the
    # shared lockout/rate-limit budget exactly as they do on /export.
    # (_check_app_password already applies the lockout check and the per-minute "import"
    # rate limit, so the standalone _rate_limit call this replaced would double-charge it.)
    _check_app_password(str(body.get("password") or ""), _user, context=f"Edição de base ({key})")

    inserts = body.get("inserts") or []
    updates = body.get("updates") or []
    deletes = body.get("deletes") or []
    if not isinstance(inserts, list) or not isinstance(updates, list) or not isinstance(deletes, list):
        raise HTTPException(status_code=400, detail="Payload de edição inválido.")
    if len(inserts) + len(updates) + len(deletes) > _DB_MAX_OPS:
        raise HTTPException(status_code=413, detail=f"Muitas alterações em uma única gravação (máx. {_DB_MAX_OPS}).")
    # Structural edits on a projection dataset (a window onto another base's rows) would
    # corrupt the underlying row — see the 'itens_rout_locus' registry entry. Refused here
    # and not merely hidden in the UI: the grid's flags are a convenience, this is the rule.
    if inserts and not spec.get("allow_insert", True):
        raise HTTPException(status_code=400, detail="Esta tabela não permite incluir linhas.")
    if deletes and not spec.get("allow_delete", True):
        raise HTTPException(status_code=400, detail="Esta tabela não permite excluir linhas.")

    model, table = spec["model"], spec["table"]
    actor = _username_of((_user or {}).get("email", ""))

    result_updated: list[dict] = []
    result_inserted: list[dict] = []
    result_deleted: list[int] = []
    skipped: list[dict] = []
    cells_changed = 0          # total changed cells across all updates (batch summary)
    audit_ops: list[dict] = [] # per-row detail, folded into the ONE batch audit row's detail_json
    try:
        with get_db() as db:
            ver = get_active_ver(db, table)
            # Canonical column list (from a sample live row) so writes can't inject
            # stray row_json keys. None ⇒ empty table (bootstrap: accept insert keys).
            # Kept ordered so an inserted row_json matches an imported row's key order.
            _sample = db.query(model.row_json).filter(model.ver == ver).first()
            schema_cols = list(json.loads(_sample[0]).keys()) if _sample else None

            # ── Updates ──────────────────────────────────────────────────────
            for op in updates:
                rid = op.get("rowId")
                changes = op.get("values") or {}
                if not isinstance(rid, int) or not isinstance(changes, dict):
                    skipped.append({"op": "update", "rowId": rid, "reason": "invalid"}); continue
                obj = db.query(model).filter(model.id == rid, model.ver == ver).first()
                if obj is None:
                    skipped.append({"op": "update", "rowId": rid, "reason": "not_found"}); continue
                cur = json.loads(obj.row_json)
                diff = {}
                for col, new_val in changes.items():
                    if col not in cur:
                        continue  # ignore unknown columns — never grow the schema via an edit
                    if cur.get(col) != new_val:
                        diff[col] = [cur.get(col), new_val]
                    cur[col] = new_val
                obj.row_json = json.dumps(cur, ensure_ascii=False)
                cells_changed += len(diff)
                for scol, sval in _recompute_shortcuts(key, cur).items():
                    setattr(obj, scol, sval)
                if diff:
                    audit_ops.append({"op": "update", "rowId": rid, "changed": diff})
                result_updated.append({"rowId": rid, "values": cur})

            # ── Inserts ──────────────────────────────────────────────────────
            for op in inserts:
                values = op.get("values") or {}
                temp_id = op.get("tempId")
                if not isinstance(values, dict):
                    skipped.append({"op": "insert", "tempId": temp_id, "reason": "invalid"}); continue
                if schema_cols is not None:
                    # The grid only sends the allowlisted columns (_resolve_view_columns), so
                    # rebuild the row against the full stored schema: unknown keys are dropped
                    # and unsent ones backfilled as null, giving an inserted row the same
                    # row_json shape and key order as an imported one.
                    values = {k: values.get(k) for k in schema_cols}
                missing = _validate_required(key, values)
                if missing:
                    skipped.append({"op": "insert", "tempId": temp_id, "reason": "missing_required", "fields": missing}); continue
                obj = model(ver=ver, row_json=json.dumps(values, ensure_ascii=False))
                for scol, sval in _recompute_shortcuts(key, values).items():
                    setattr(obj, scol, sval)
                db.add(obj)
                db.flush()  # assign the autoincrement id
                audit_ops.append({"op": "insert", "rowId": obj.id, "values": values})
                result_inserted.append({"tempId": temp_id, "rowId": obj.id, "values": values})

            # ── Deletes ──────────────────────────────────────────────────────
            for rid in deletes:
                if not isinstance(rid, int):
                    skipped.append({"op": "delete", "rowId": rid, "reason": "invalid"}); continue
                obj = db.query(model).filter(model.id == rid, model.ver == ver).first()
                if obj is None:
                    skipped.append({"op": "delete", "rowId": rid, "reason": "not_found"}); continue
                snapshot = json.loads(obj.row_json)
                db.delete(obj)
                audit_ops.append({"op": "delete", "rowId": rid, "values": snapshot})
                result_deleted.append(rid)

            # ── ONE audit row per SAVE (batch), never one per changed record ─────────────────
            # A save that touches 40 rows used to append 40 'data_edit' rows plus a summary; the
            # trail was unreadable and the per-row rows were never consulted on their own. The whole
            # batch is now a SINGLE 'data_edit_summary' row, with the two halves separated:
            #
            #   • `detail`      — the one-line sentence the admin panels DISPLAY: which base, by
            #                     whom. Nothing else. It used to carry a JSON tail listing every
            #                     changed row, which made each notification a wall of record-level
            #                     data and published the edited VALUES to anyone with the panel open.
            #                     Who (actor) and when (ts) are already columns of the event.
            #   • `detail_json` — the machine-readable payload for forensics: counts plus the capped
            #                     per-row ops. Stored on the SAME single row and returned by NO
            #                     endpoint (see SecurityEvent.detail_json), so nothing changed about
            #                     what a notification shows.
            n_upd, n_ins, n_del = len(result_updated), len(result_inserted), len(result_deleted)
            if n_upd + n_ins + n_del > 0:
                try:
                    payload = {
                        "dataset": key,
                        "counts": {"updated": n_upd, "inserted": n_ins, "deleted": n_del,
                                   "cellsChanged": cells_changed},
                        "ops": audit_ops[:_DB_AUDIT_MAX_OPS],
                        "opsTotal": len(audit_ops),
                    }
                    ops_json = json.dumps(payload, ensure_ascii=False)
                    if len(ops_json) > _DB_AUDIT_MAX_BYTES:
                        # Over the byte cap: keep the counts (the part that must never be lost) and
                        # drop the ops rather than storing a truncated, unparseable JSON string.
                        payload["ops"] = []
                        payload["opsOmitted"] = True
                        ops_json = json.dumps(payload, ensure_ascii=False)
                except Exception:
                    ops_json = None
                _log_security_event(
                    # Audited against the underlying TABLE, not the viewer key: a projection
                    # dataset edits the same rows as its parent, and /api/db/last-update is
                    # keyed by table — filing it under the projection would hide the edit from
                    # the "Última atualização" card of the base it actually changed.
                    db, actor=actor, target=(spec.get("table") or key), event_type="data_edit_summary",
                    detail=f"Base '{spec.get('label') or key}' atualizada por {actor}.",
                    detail_json=ops_json,
                )

            db.commit()

        # Edits to the Gantt source tables invalidate its cache so the next build re-reads.
        _edited_table = spec.get("table") or key
        if _edited_table in ("schedule", "locos_rout"):
            _invalidate_gantt_cache()
        # Same for the capacity frame — it is reconstructed from these two tables, so an
        # edited cell would otherwise stay invisible to Capacity for up to the TTL.
        if _edited_table in ("itens_rout", "plano_prod"):
            _invalidate_capacity_cache()

        return {
            "ok": True,
            "updated": result_updated,
            "inserted": result_inserted,
            "deleted": result_deleted,
            "skipped": skipped,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_mutate"))


@app.post("/api/db/dataset/{key}/export")
def db_dataset_export(key: str, body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Export ONE dataset (active version) as xlsx, for the viewer's Download action.

    Layered exactly like every other sensitive surface, and deliberately stricter than a
    read: Editor+ role AND the admin second factor (require_editor_unlock) get you here,
    and the shared application password (IMPORT_PASSWORD — the same secret the Importação
    flow asks for) is checked BEFORE a single row is read, so a wrong password produces no
    file and no DB work. Wrong guesses feed the shared lockout/rate-limit budget, blocked
    users never reach this handler, and the download is audited in SecurityEvent.

    Body: { "password": <str>, "rowIds": [<int>, …] | null }. `rowIds` exports only those
    rows, in the order given — that is how the grid ships the currently filtered/sorted
    view. Omitted/null exports the whole active version. Columns are the dataset's
    view_columns allowlist, so the file matches what the table shows.
    """
    spec = _db_dataset_or_400(key)
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    # Password first: no rows are read until it validates.
    _check_app_password(str(body.get("password") or ""), _user, context=f"Exportação de base ({key})")

    raw_ids = body.get("rowIds")
    row_ids: list[int] | None = None
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or not all(isinstance(i, int) for i in raw_ids):
            raise HTTPException(status_code=400, detail="Seleção de linhas inválida.")
        if len(raw_ids) > _DB_MAX_VIEW_ROWS:
            raise HTTPException(status_code=413, detail=f"Seleção muito grande (máx. {_DB_MAX_VIEW_ROWS} linhas).")
        row_ids = raw_ids

    model, table = spec["model"], spec["table"]
    actor = _username_of((_user or {}).get("email", ""))
    try:
        with get_db() as db:
            ver = get_active_ver(db, table)
            # Selection is filtered in Python, not via id.in_(row_ids): the id list can hold
            # up to _DB_MAX_VIEW_ROWS entries, which would blow SQLite's bound-variable limit
            # and make Postgres plan a huge IN. The query is already capped at that same bound.
            wanted = set(row_ids) if row_ids is not None else None
            rows_q = (db.query(model.id, model.row_json)
                        .filter(model.ver == ver)
                        .order_by(model.id)
                        .limit(_DB_MAX_VIEW_ROWS))
            by_id = {rid: json.loads(rj) for rid, rj in rows_q.all()
                     if wanted is None or rid in wanted}

        if row_ids is not None:
            # Preserve the grid's order; ids that vanished since load are skipped.
            records = [by_id[i] for i in row_ids if i in by_id]
        else:
            records = list(by_id.values())
        if not records:
            raise HTTPException(status_code=404, detail="Nada a exportar: nenhuma linha encontrada.")

        present: list[str] = []
        seen: set[str] = set()
        for d in records:
            for k in d.keys():
                if k not in seen:
                    seen.add(k); present.append(k)
        columns = _resolve_view_columns(key, present)

        # A projection dataset exports what its table SHOWS, so the same row_filter applies.
        # (An explicit rowIds selection is already the grid's own filtered view, but re-applying
        # is harmless there and keeps a whole-base export honest.)
        fcols = _row_filter_cols(key, present)
        if fcols:
            records = [d for d in records if _keep_row(d, fcols)]
            if not records:
                raise HTTPException(status_code=404, detail="Nada a exportar: nenhuma linha encontrada.")

        df = pd.DataFrame([[d.get(c) for c in columns] for d in records], columns=columns)
        import tempfile as _tmp
        tmp = _tmp.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        df.to_excel(tmp.name, index=False, sheet_name=spec["label"][:31])

        with get_db() as db:
            # Detail is deliberately minimal: WHICH base only. Who (actor) and WHEN (ts) are
            # already columns of the event, and the row/column counts were noise in the trail.
            _log_security_event(
                db, actor=actor, target=(spec.get("table") or key), event_type="data_download",
                detail=f"Base '{spec.get('label') or key}' exportada por {actor}.",
            )
            db.commit()

        return FileResponse(
            path=tmp.name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=f"{key}.xlsx",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "db_export"))


# ── Gantt endpoints ──────────────────────────────────────────────────────────

# Simple in-process cache: (payload_dict, built_at_timestamp)
_gantt_cache: dict | None = None
_gantt_cache_at: float = 0.0
_GANTT_CACHE_TTL = 300  # seconds — revalidate after 5 minutes

# In-memory cache for uploaded scenario files (scenario_id → file_bytes).
# Ephemeral: lost on server restart. Bounded by TOTAL BYTES (not entry count) —
# raw .xlsx blobs are multi-MB, so a 100-entry cap could pin hundreds of MB of RAM
# (a Railway memory-cost driver). We evict oldest-first until under budget.
_scenario_file_cache: dict[str, bytes] = {}
_SCENARIO_CACHE_MAX_BYTES = int(os.getenv("SCENARIO_CACHE_MAX_BYTES", str(48 * 1024 * 1024)))  # 48 MB
_SCENARIO_CACHE_MAX_ITEMS = int(os.getenv("SCENARIO_CACHE_MAX_ITEMS", "16"))


def _store_scenario_file(scenario_id: str, file_bytes: bytes) -> None:
    """Insert a scenario blob, evicting oldest entries until within the byte/item budget."""
    _scenario_file_cache[scenario_id] = file_bytes
    total = sum(len(b) for b in _scenario_file_cache.values())
    while _scenario_file_cache and (
        total > _SCENARIO_CACHE_MAX_BYTES or len(_scenario_file_cache) > _SCENARIO_CACHE_MAX_ITEMS
    ):
        oldest, blob = next(iter(_scenario_file_cache.items()))
        if oldest == scenario_id:      # never evict the entry we just stored
            break
        _scenario_file_cache.pop(oldest, None)
        total -= len(blob)


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


def _reload_calendar_and_invalidate() -> None:
    """Re-apply the override snapshot and drop the Gantt cache so the next
    /api/gantt/data (and every working-day KPI) recomputes from the new calendar."""
    _load_calendar_overrides()
    _invalidate_gantt_cache()


@app.get("/api/gantt/data")
def gantt_data(_user: dict = Depends(require_auth)):
    """
    Retorna os dados do Gantt como JSON para renderização no frontend.
    Lê do banco (preferencial) ou do Excel HorasB3.xlsx (fallback).
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


# ── User permissions (Reader / Editor / Admin access control) ──────────────────────────
# Roles form a ladder: Reader < Editor < Admin. Only Editors and Admins are stored in the
# user_permissions table — anyone not listed is implicitly a Reader (view-only). Identity is
# the e-mail local-part (before '@'), lower-cased, so it is domain-independent.
_INITIAL_ADMIN = "joao.voss"          # seeded at startup when no admin exists yet
_VALID_ROLES  = {"editor", "admin"}   # roles an admin may ASSIGN via user management
_STORED_ROLES = {"reader", "editor", "admin"}  # roles that may exist on a persisted row

# ── Break-glass superadmins ───────────────────────────────────────────────────
# Always resolve to Admin and can NEVER be blocked or demoted — the recovery path if
# every other admin is locked out or blocked. Comma-separated e-mail local-parts in
# SUPERADMIN_USERNAMES; defaults to the app owner so a recovery account always exists.
_SUPERADMINS: set[str] = {
    u.strip().lower()
    for u in os.getenv("SUPERADMIN_USERNAMES", "joao.voss").split(",")
    if u.strip()
}


def _username_of(email_or_name: str) -> str:
    """Extract the lookup username: the portion BEFORE '@', lower-cased and trimmed.
    Accepts a bare username too (returns it normalized)."""
    s = str(email_or_name or "").strip().lower()
    return s.split("@", 1)[0] if "@" in s else s


def _is_superadmin(user_or_name) -> bool:
    """True for a break-glass superadmin (by user dict or bare username)."""
    if isinstance(user_or_name, dict):
        name = _username_of(user_or_name.get("email", ""))
    else:
        name = _username_of(str(user_or_name or ""))
    return bool(name) and name in _SUPERADMINS


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
    """True if the username is currently blocked. Superadmins are never blocked."""
    if not username or username in _SUPERADMINS:
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
_SETTING_OFFLINE_IMG  = "server_offline_image"
#: Historic key name, kept so the existing app_setting row keeps working. Its MEANING changed
#: with the Entra ID removal: "block new users" is no longer a switch, it is the permanent rule
#: (nobody is auto-registered any more — see _touch_user_login). What the flag controls now is
#: whether the app still ACCEPTS self-service access requests at all. On ⇒ POST
#: /api/auth/request-access is refused outright, so the sign-up form stops taking submissions;
#: off (the default) ⇒ requests are accepted and queue for an admin decision. Renaming the key
#: would silently reset every deployment that already has it set, which is why it stays.
_SETTING_NEW_LOCKDOWN = "lockdown_new_users"

_OFFLINE_MSG_MAX = 500          # admin-authored, rendered as TEXT (never HTML) in the client
_OFFLINE_IMG_MAX = 500          # a URL, validated below; the browser fetches it, this server never does
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


def _is_new_user_lockdown() -> bool:
    """True while self-service access requests are CLOSED (see _SETTING_NEW_LOCKDOWN)."""
    return _setting(_SETTING_NEW_LOCKDOWN) == "1"


def _offline_message() -> str:
    return (_setting(_SETTING_OFFLINE_MSG) or "").strip() or _DEFAULT_OFFLINE_MSG


def _offline_image() -> str:
    """The optional picture/GIF shown under the offline message. No default: blank means no image."""
    return (_setting(_SETTING_OFFLINE_IMG) or "").strip()


def _clean_offline_image_url(raw: object) -> str:
    """Validate an admin-supplied image URL, or raise 400. Empty input clears the image.

    HTTPS ONLY, and nothing else. The value is written verbatim into an <img src> on every user's
    screen, so the scheme allow-list is the control that matters: `javascript:` and `data:` are the
    two ways a URL-shaped string turns into script or into arbitrary inline content, and neither is
    ever a picture link somebody pastes. `http:` is refused as well — the app is served over HTTPS
    and the browser would block the mixed content anyway, so accepting it would only store a URL
    that silently never renders. Embedded credentials (`user:pass@host`) are refused for the same
    reason they are refused anywhere: they are not part of a picture link and they leak.

    NOT an SSRF surface: this server never fetches the URL. The browser does, which is also why the
    client sends it with `referrerpolicy="no-referrer"` — the third-party host still sees each
    viewer's IP, which is inherent to "render it from the link" and is the admin's call to make.
    """
    from urllib.parse import urlparse

    s = str(raw or "").strip()[:_OFFLINE_IMG_MAX]
    if not s:
        return ""
    # A URL with whitespace or control characters in it is malformed; refuse rather than normalize.
    if any(ch.isspace() or ord(ch) < 32 for ch in s):
        raise HTTPException(status_code=400, detail="Link da imagem inválido.")
    try:
        u = urlparse(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Link da imagem inválido.")
    if u.scheme.lower() != "https" or not u.netloc:
        raise HTTPException(
            status_code=400,
            detail="O link da imagem deve começar com https:// e apontar direto para o arquivo.",
        )
    if "@" in u.netloc:
        raise HTTPException(status_code=400, detail="Link da imagem inválido.")
    return s


def _is_unregistered_locked(username: str) -> bool:
    """True when this identity has no roster row — i.e. the account does not exist.

    This used to be conditional on the new-user lockdown switch, because an unknown caller
    who had authenticated against Entra ID was a legitimate first-time user and got
    auto-registered as Reader. With Entra ID gone that whole path is gone with it: an
    account is created ONLY by an admin or by an approved access request, so an
    authenticated token naming a user who is not on the roster means the account was
    DELETED while its session was still alive. Denying it is the point — otherwise
    "Excluir usuário" would only take effect at the next expiry, up to 12 h later.

    Superadmins are exempt (break-glass). A DB failure returns False rather than locking
    everyone out of the app on a transient blip — the same fail-open choice as before, and
    the reason this can never be the ONLY control: the token signature is what actually
    proves identity."""
    if not username or username in _SUPERADMINS:
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

def _forget_role(username: str) -> None:
    with _role_cache_lock:
        _role_cache.pop(username, None)


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
                if username not in _SUPERADMINS:
                    return
                db.add(UserPermission(username=username, role="admin", created_at=now, last_login=now))
                _log_security_event(db, actor="system", target=username, event_type="user_registered",
                                    detail=f"Superadministrador recriado no cadastro: {username}.")
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

    What goes on the line is the bare `username` (`joao.voss`), never the e-mail, the token or the
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


def _warning_for(row, now: datetime | None = None) -> dict | None:
    """Build the security-warning descriptor for a user row (None if never locked out).
    The lockout COUNT is permanent history; severity/recency/active drive the UI badge."""
    cnt = int(row.lockout_count or 0)
    if cnt <= 0:
        return None
    now = now or datetime.now(timezone.utc)
    last = _aware(row.last_lockout_at)
    ack  = _aware(row.warning_ack_at)
    # "active" = a lockout happened that an admin hasn't acknowledged yet.
    active = last is not None and (ack is None or ack < last)
    recent = last is not None and (now - last) < timedelta(days=7)
    severity = "high" if cnt >= 10 else "warning" if cnt >= 3 else "info"
    return {
        "count": cnt,
        "severity": severity,
        "active": bool(active),
        "recent": bool(recent),
        "last_lockout_at": last.isoformat() if last else None,
    }


def _check_app_password(password: str, user: dict | None = None, context: str = "") -> None:
    """Validate the shared application password (IMPORT_PASSWORD). Raises 403 on mismatch.

    FAILS CLOSED in production: if IMPORT_PASSWORD is not configured, the destructive
    operations that use this gate are refused (503) instead of silently proceeding
    unprotected. In development an unset password stays a no-op for convenience.

    When `user` is provided, wrong passwords feed the SAME per-user failed-attempt
    lockout as the admin unlock (5 in a row → 15-min lockout), plus a per-minute rate
    limit — so admin+import guesses share one budget and one lockout.

    `context` labels WHAT the password was gating (e.g. "Importação de base (Excel)")
    in the SecurityEvent recorded for admins — both on success and on failure."""
    u = user or {}
    uname = _username_of(u.get("email", ""))
    _check_pw_lockout(u)
    _rate_limit(u, "import")
    required_pw = os.getenv("IMPORT_PASSWORD", "").strip()
    if not required_pw:
        if ENVIRONMENT == "production":
            raise HTTPException(
                status_code=503,
                detail="Operação bloqueada: IMPORT_PASSWORD não configurado no servidor.",
            )
        return
    ctx = f" — {context}" if context else ""
    if not _hmac.compare_digest(str(password or "").strip(), required_pw):
        tripped = _record_pw_failure(u)
        _record_security_event(
            actor=uname, event_type="import_pw_fail",
            detail=f"Senha de importação/exportação incorreta{ctx}.",
            throttle_key=(uname, "import_pw_fail", context), throttle_s=60,
        )
        if tripped:
            raise HTTPException(status_code=429, detail=_LOCKOUT_DETAIL, headers={"X-Locked-Out": "1"})
        raise HTTPException(status_code=403, detail="Senha incorreta.")
    _reset_pw_failures(u)
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
    # Break-glass superadmins are ALWAYS Admin (never revoked by lockout, never DB-dependent).
    if _is_superadmin(user):
        return "admin"
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
        # Local-auth additions. `mustChangePassword` is advisory only — the app nags, it does
        # not lock anyone out of their own account over a password it generated for them.
        "email": _account_email(uname),
        "mustChangePassword": _must_change_password(uname),
    }


# ── Server control endpoints ──────────────────────────────────────────────────────────────
@app.get("/api/server-control/status")
def server_control_status(user: dict = Depends(require_auth)):
    """Current operational state for the client: is the app deliberately offline, and with what
    message. Every authenticated user may read it — that is the whole point of the message.

    DELIBERATELY NOT UNAUTHENTICATED. Only three routes in this API answer without a token —
    /api/health, /api/auth/login and /api/auth/request-access — and keeping that list short is
    worth more than the convenience here; a fourth route echoing admin-authored text to the open
    internet is a poor trade. Sign-in no longer happens against Entra ID but it still does not
    need this route: POST /api/auth/login is itself tokenless, so a user arriving at a
    cold-starting app authenticates first and reads this afterwards.

    `lockdownNewUsers` is admin-only: a reader has no use for it and it describes an access
    control, so it is not broadcast."""
    offline = _is_server_offline()
    out: dict = {
        "offline": offline,
        # Only surface the text while it is actually in force — a draft message sitting in the
        # table is not something every user should be able to read. Same rule for the image.
        "message": _offline_message() if offline else "",
        "imageUrl": _offline_image() if offline else "",
    }
    if _current_role(user) == "admin":
        out["lockdownNewUsers"] = _is_new_user_lockdown()
        out["draftMessage"] = _setting(_SETTING_OFFLINE_MSG, "")
        out["draftImageUrl"] = _setting(_SETTING_OFFLINE_IMG, "")
    return out


@app.post("/api/server-control")
def server_control_set(body: dict = Body(default={}), user: dict = Depends(require_admin_unlock)):
    """Set the deliberate-shutdown switch, its message, and the new-user lockdown. Admins only,
    behind the ADMIN_PASSWORD second factor (require_admin_unlock also applies the lockout and
    role checks), and every change is written to the audit trail.

    Body — all keys optional, only the ones present are changed:
      { offline: bool, message: str, imageUrl: str, lockdownNewUsers: bool }

    Both switches are app-wide access/availability controls, so they are recorded individually
    with their previous and new value rather than as one opaque "settings saved" event."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

    payload = body or {}
    actor = _username_of((user or {}).get("email", ""))
    now = datetime.now(timezone.utc)

    updates: dict[str, str] = {}
    if "offline" in payload:
        updates[_SETTING_OFFLINE] = "1" if bool(payload.get("offline")) else "0"
    if "message" in payload:
        # Length-capped and stored as plain text. The client renders it as text, never as HTML.
        updates[_SETTING_OFFLINE_MSG] = str(payload.get("message") or "").strip()[:_OFFLINE_MSG_MAX]
    if "imageUrl" in payload:
        # Raises 400 on anything that is not an https URL — see _clean_offline_image_url.
        updates[_SETTING_OFFLINE_IMG] = _clean_offline_image_url(payload.get("imageUrl"))
    if "lockdownNewUsers" in payload:
        updates[_SETTING_NEW_LOCKDOWN] = "1" if bool(payload.get("lockdownNewUsers")) else "0"

    if not updates:
        raise HTTPException(status_code=400, detail="Nenhuma alteração informada.")

    try:
        before = {k: _setting(k, "") for k in updates}
        with get_db() as db:
            for key, value in updates.items():
                row = db.query(AppSetting).filter(AppSetting.key == key).first()
                if row is None:
                    db.add(AppSetting(key=key, value=value, updated_at=now, updated_by=actor))
                else:
                    row.value = value
                    row.updated_at = now
                    row.updated_by = actor
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "server_control_set"))

    _refresh_settings_cache(force=True)   # the switches take effect on the next request, not in 30s

    # ── Audit ────────────────────────────────────────────────────────────────────────────
    if _SETTING_OFFLINE in updates and updates[_SETTING_OFFLINE] != before.get(_SETTING_OFFLINE, "0"):
        on = updates[_SETTING_OFFLINE] == "1"
        _record_security_event(
            actor=actor, target="server", event_type="server_control",
            detail=("Servidor DESATIVADO (acesso negado a todos, exceto administradores)." if on
                    else "Servidor reativado (acesso liberado)."),
        )
    if _SETTING_NEW_LOCKDOWN in updates and updates[_SETTING_NEW_LOCKDOWN] != before.get(_SETTING_NEW_LOCKDOWN, "0"):
        on = updates[_SETTING_NEW_LOCKDOWN] == "1"
        _record_security_event(
            actor=actor, target="server", event_type="server_control",
            detail=("Bloqueio de novos usuários ATIVADO (novos acessos negados, sem registro como Leitor)."
                    if on else "Bloqueio de novos usuários desativado (novos acessos voltam a ser Leitor)."),
        )
    if _SETTING_OFFLINE_MSG in updates and updates[_SETTING_OFFLINE_MSG] != before.get(_SETTING_OFFLINE_MSG, ""):
        _record_security_event(
            actor=actor, target="server", event_type="server_control",
            detail="Mensagem de indisponibilidade alterada.",
        )
    if _SETTING_OFFLINE_IMG in updates and updates[_SETTING_OFFLINE_IMG] != before.get(_SETTING_OFFLINE_IMG, ""):
        # The URL itself is in the audit line: it is admin-authored content shown to every user, so
        # "which link was set" is the whole point of auditing the change.
        new_img = updates[_SETTING_OFFLINE_IMG]
        _record_security_event(
            actor=actor, target="server", event_type="server_control",
            detail=(f"Imagem da mensagem de indisponibilidade definida: {new_img}" if new_img
                    else "Imagem da mensagem de indisponibilidade removida."),
        )

    return {
        "offline": _is_server_offline(),
        "message": _offline_message(),
        "imageUrl": _offline_image(),
        "lockdownNewUsers": _is_new_user_lockdown(),
        "draftMessage": _setting(_SETTING_OFFLINE_MSG, ""),
        "draftImageUrl": _setting(_SETTING_OFFLINE_IMG, ""),
    }


_ONLINE_WINDOW_SEC = 5 * 60   # last_activity within this window → shown in the indicator (online|idle)
_ONLINE_ACTIVE_SEC = 2 * 60   # within this → "online"; older but still in-window → "idle"


@app.get("/api/admin/online-users")
def get_online_users(_user: dict = Depends(require_admin)):
    """Admins only: users active within the last few minutes (by last_activity), for the online-users
    indicator. Returns username, display name, role, last_activity, and status (online|idle). Blocked
    users are excluded. `online_count` = how many are actively online (the badge number)."""
    if not _DB_AVAILABLE:
        return {"users": [], "online_count": 0}
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=_ONLINE_WINDOW_SEC)
        with get_db() as db:
            rows = (db.query(UserPermission)
                      .filter(UserPermission.last_activity.isnot(None),
                              UserPermission.last_activity >= cutoff,
                              UserPermission.is_blocked.is_(False))
                      .order_by(UserPermission.last_activity.desc()).all())
            users = []
            for r in rows:
                la = _aware(r.last_activity)
                age = (now - la).total_seconds() if la else None
                users.append({
                    "username": r.username,
                    "name": (r.username or "").replace(".", " ").replace("_", " ").title() or r.username,
                    "role": r.role,
                    "last_activity": _iso(r.last_activity),
                    "status": "online" if (age is not None and age <= _ONLINE_ACTIVE_SEC) else "idle",
                })
        return {"users": users, "online_count": sum(1 for u in users if u["status"] == "online")}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


def _iso(dt) -> str | None:
    a = _aware(dt)
    return a.isoformat() if a else None


def _user_row_dict(row, now: datetime) -> dict:
    """Serialize a UserPermission row for the admin roster view."""
    return {
        "username": row.username,
        "role": row.role,
        "is_blocked": bool(row.is_blocked),
        "is_superadmin": row.username in _SUPERADMINS,
        "created_at": _iso(row.created_at),
        "last_login": _iso(row.last_login),
        "lockout_count": int(row.lockout_count or 0),
        "last_lockout_at": _iso(row.last_lockout_at),
        "warning": _warning_for(row, now),
        "last_role_change_at": _iso(row.last_role_change_at),
        "last_role_change_by": row.last_role_change_by,
        # Local-credential state. The HASH is never serialized — only whether one exists, so the
        # roster can show "conta sem senha definida" (an account nobody can sign in to yet).
        "email": row.email or "",
        "has_password": bool(row.password_hash),
        "must_change_password": bool(row.must_change_password),
        "password_set_at": _iso(row.password_set_at),
    }


@app.get("/api/permissions/users")
def list_users(
    q:      str = Query(default=""),
    role:   str = Query(default=""),      # '', 'reader', 'editor', 'admin'
    status: str = Query(default=""),      # '', 'blocked', 'warned', 'active'
    limit:  int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _user:  dict = Depends(require_admin),
):
    """Roster of ALL users with per-user state (role, blocked, last login, lockout history).
    Admins only. Server-side search/filter/pagination. Still returns admins/editors name
    lists for backward compatibility."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            base = db.query(UserPermission)
            if q.strip():
                base = base.filter(UserPermission.username.ilike(f"%{q.strip().lower()}%"))
            if role in _STORED_ROLES:
                base = base.filter(UserPermission.role == role)
            if status == "blocked":
                base = base.filter(UserPermission.is_blocked.is_(True))
            elif status == "warned":
                base = base.filter(UserPermission.lockout_count > 0)
            elif status == "active":
                base = base.filter(UserPermission.is_blocked.is_(False))
            total = base.count()
            # Role-priority grouping: Admin → Editor → Reader → Banned (any blocked role)
            # → future/unknown roles last. Blocked users drop to the "banned" bucket
            # regardless of their stored role. Alphabetical by username within each group.
            # Done in SQL so the ordering stays globally consistent across pagination.
            role_rank = case(
                (UserPermission.is_blocked.is_(True), 4),
                (UserPermission.role == "admin", 1),
                (UserPermission.role == "editor", 2),
                (UserPermission.role == "reader", 3),
                else_=5,
            )
            rows = (base.order_by(role_rank.asc(), UserPermission.username.asc())
                        .offset(offset).limit(limit).all())
            users = [_user_row_dict(r, now) for r in rows]
            # Backward-compat name lists (unfiltered, for any legacy consumer).
            all_rows = db.query(UserPermission.username, UserPermission.role).all()
            admins  = sorted(u for (u, r) in all_rows if r == "admin")
            editors = sorted(u for (u, r) in all_rows if r == "editor")
        return {"users": users, "total": total, "limit": limit, "offset": offset,
                "admins": admins, "editors": editors}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "list_users"))


@app.post("/api/permissions/users")
def add_user(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Add or update a managed user (Editor/Admin). Admins only · guarded by the
    ADMIN_PASSWORD unlock. Records who made the change + an audit event.
    Body: { username, role: 'editor'|'admin', email? }.

    Creating a user here also mints a CREDENTIAL, because after the Entra ID removal a roster
    row without a password is an account nobody can sign in to. The generated password comes
    back in this response and nowhere else (`password`, present only when a row was created),
    for the admin to hand over; the account is flagged `must_change_password` so the owner
    replaces it on first use. Promoting/demoting an EXISTING user never touches their password.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    username = _username_of(payload.get("username", ""))
    role = str(payload.get("role", "")).strip().lower()
    email = normalize_email(payload.get("email", "")) or (
        f"{username}@{ALLOWED_DOMAIN}" if ALLOWED_DOMAIN else username
    )
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    if role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail="Função inválida (use 'editor' ou 'admin').")
    new_pw: str | None = None
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            prev = row.role if row is not None else "reader"
            if row is not None:
                row.role = role                      # upsert: promote/demote in place
                row.last_role_change_at = now
                row.last_role_change_by = actor
            else:
                new_pw = generate_password(12)
                db.add(UserPermission(username=username, role=role, created_at=now,
                                      email=email, password_hash=hash_password(new_pw),
                                      password_set_at=now, must_change_password=True,
                                      last_role_change_at=now, last_role_change_by=actor))
                _log_security_event(db, actor=actor, target=username, event_type="user_created",
                                    detail=f"Conta criada por um administrador como {role}.")
            # Only a REAL change is worth an audit row. Re-saving a user at the role they already
            # hold used to write "editor → editor", which is pure noise in the trail (remove_user
            # already returns early in the equivalent case).
            if prev != role:
                _log_security_event(db, actor=actor, target=username, event_type="role_change",
                                    detail=f"{prev} → {role}")
        _forget_role(username)   # bust the resilience cache so the new role is immediate
        out = {"ok": True, "username": username, "role": role}
        if new_pw:
            out["password"] = new_pw
        return out
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "add_user"))


@app.post("/api/permissions/users/remove")
def remove_user(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Demote a managed user to Reader (keeps the roster row + history). Admins only ·
    guarded by the ADMIN_PASSWORD unlock. Refuses to demote the LAST admin so user
    management can never be locked out. Body: { username }."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    username = _username_of(payload.get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is None or row.role == "reader":
                return {"ok": True, "username": username}   # already a Reader — idempotent
            if row.role == "admin":
                admin_count = db.query(UserPermission).filter(UserPermission.role == "admin").count()
                if admin_count <= 1:
                    raise HTTPException(status_code=400, detail="Não é possível remover o último administrador.")
            prev = row.role
            row.role = "reader"                          # demote in place (keep row for audit)
            row.last_role_change_at = now
            row.last_role_change_by = actor
            _log_security_event(db, actor=actor, target=username, event_type="role_change",
                                detail=f"{prev} → reader")
        _forget_role(username)   # bust the resilience cache so the demotion is immediate
        return {"ok": True, "username": username}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "remove_user"))


@app.post("/api/permissions/users/block")
def block_user(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Ban a user: deny them the whole application while keeping their role. Admins only ·
    ADMIN_PASSWORD unlock. Cannot ban yourself, a superadmin, or the last active admin."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    username = _username_of((body or {}).get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    if username == actor:
        raise HTTPException(status_code=400, detail="Você não pode bloquear a si mesmo.")
    if username in _SUPERADMINS:
        raise HTTPException(status_code=400, detail="Não é possível bloquear um superadministrador.")
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is None:
                # Pré-banir um nome que ainda não existe deixou de fazer sentido: sem
                # auto-registro, a conta só passa a existir por decisão de um admin ou por
                # solicitação aprovada — e criar a linha aqui reservaria o nome, recusando a
                # solicitação de acesso de quem se chama assim. Recuse a operação em vez disso.
                raise HTTPException(status_code=404, detail="Conta não encontrada.")
            if row.role == "admin":
                active_admins = (db.query(UserPermission)
                                   .filter(UserPermission.role == "admin",
                                           UserPermission.is_blocked.is_(False)).count())
                if active_admins <= 1:
                    raise HTTPException(status_code=400, detail="Não é possível bloquear o último administrador ativo.")
            if not row.is_blocked:
                row.is_blocked = True
                row.last_role_change_at = now
                row.last_role_change_by = actor
                _log_security_event(db, actor=actor, target=username, event_type="block", detail="Conta bloqueada.")
        _refresh_blocked_cache(force=True)
        return {"ok": True, "username": username, "is_blocked": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "block_user"))


@app.post("/api/permissions/users/unblock")
def unblock_user(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Lift a ban — the user regains access with their ORIGINAL role. Admins only · unlock."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    username = _username_of((body or {}).get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is not None and row.is_blocked:
                row.is_blocked = False
                row.last_role_change_at = now
                row.last_role_change_by = actor
                _log_security_event(db, actor=actor, target=username, event_type="unblock", detail="Conta desbloqueada.")
        _refresh_blocked_cache(force=True)
        return {"ok": True, "username": username, "is_blocked": False}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "unblock_user"))


@app.post("/api/permissions/users/ack-warning")
def ack_warning(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Acknowledge a user's lockout warning (clears the ACTIVE badge). The lockout COUNT
    and history are preserved — an admin can hide the alert but never erase the record."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    username = _username_of((body or {}).get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is not None:
                row.warning_ack_at = now
                _log_security_event(db, actor=actor, target=username, event_type="ack_warning",
                                    detail=f"Aviso reconhecido (lockouts={int(row.lockout_count or 0)}).")
        return {"ok": True, "username": username}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "ack_warning"))


# ── Autenticação local (usuário + senha) — substituição do Azure AD / Entra ID ──────────────
# A Entra ID deixou de funcionar e era o ÚNICO caminho de entrada da aplicação. O que segue é
# o sistema de login próprio que a substituiu, com uma restrição que decidiu quase todo o
# desenho: NÃO PERDER USUÁRIO NENHUM. `user_permissions` continua sendo a mesma tabela, com
# as mesmas linhas, os mesmos papéis, o mesmo histórico de bloqueio e de lockout — ela só
# ganhou uma coluna de senha. Nada foi recriado, nada foi migrado para outro lugar.
#
# As três peças:
#   1. _bootstrap_local_credentials()  — dá uma senha aleatória a cada conta que já existia,
#      uma única vez, e escreve a lista em um arquivo local para o admin distribuir.
#   2. /api/auth/login | /refresh | /change-password — o fluxo do usuário que JÁ tem conta.
#   3. /api/auth/request-access + /api/admin/access-requests — o fluxo de quem NÃO tem.
#      Sem diretório corporativo não existe mais como validar alguém antes de ele chegar ao
#      app, então o antigo "Bloquear Novos Usuários" deixou de ser exceção e virou a regra:
#      ninguém é registrado automaticamente, todo mundo passa por aprovação de um admin.

#: Onde a lista de senhas geradas na migração é escrita. FORA da árvore do repositório (que
#: fica dentro de uma pasta sincronizada com OneDrive) pela mesma razão do backend/.env: um
#: arquivo com senha em texto puro não pode ser replicado para uma conta de nuvem pessoal,
#: com histórico de versões que uma exclusão posterior não apaga. Ver env_paths.py.
_ACCOUNTS_FILE = Path.home() / ".optvision" / "senhas-iniciais.txt"

#: Hash descartável, usado só para gastar o mesmo tempo de PBKDF2 quando o usuário NÃO existe.
#: Sem isso, "usuário inexistente" responde em microssegundos e "senha errada" em ~0,2 s, e a
#: diferença enumera o cadastro inteiro sem precisar acertar uma senha sequer.
_DUMMY_PASSWORD_HASH = hash_password(_secrets.token_urlsafe(16))


def _write_initial_passwords(lines: list[str]) -> str:
    """Grava as senhas recém-geradas e devolve o caminho (ou '' se não foi possível gravar).

    Acrescenta ao arquivo em vez de sobrescrever: um segundo boot que gere senha para UMA
    conta nova não pode apagar a lista das outras, que o admin ainda pode não ter distribuído.
    """
    try:
        _ACCOUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        with open(_ACCOUNTS_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"\n# Senhas geradas em {stamp} (migracao Entra ID -> login local)\n")
            fh.write("# Entregue cada senha ao seu dono e apague este arquivo depois.\n")
            for line in lines:
                fh.write(line + "\n")
        try:
            os.chmod(_ACCOUNTS_FILE, 0o600)   # sem efeito prático no Windows; correto no Linux
        except Exception:
            pass
        return str(_ACCOUNTS_FILE)
    except Exception as exc:
        logger.error("[auth] Não foi possível gravar %s: %s", _ACCOUNTS_FILE, exc)
        return ""


def _bootstrap_local_credentials() -> None:
    """Gera senha para toda conta existente que ainda não tem uma. Roda no boot, é idempotente.

    Só toca em linhas com `password_hash` NULL, então: roda de verdade uma vez, no primeiro
    boot depois da migração, e depois disso vira uma consulta que não encontra nada. Papel,
    bloqueio, histórico e data de criação de cada conta ficam exatamente como estavam — a
    única escrita é a credencial que a conta não tinha porque quem a guardava era a Entra ID.

    SUPERADMIN_BOOTSTRAP_PASSWORD, se definida, é usada para as contas break-glass em vez de
    uma senha aleatória. É o caminho de recuperação para quando o operador não consegue ler o
    arquivo gerado (container efêmero, disco remoto): sem ele, um deploy em que o arquivo se
    perde deixa a aplicação sem NINGUÉM que consiga entrar.
    """
    if not _DB_AVAILABLE:
        return
    fixed_super = os.getenv("SUPERADMIN_BOOTSTRAP_PASSWORD", "").strip()
    generated: list[tuple[str, str, str]] = []   # (username, role, senha)
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            rows = (db.query(UserPermission)
                      .filter(or_(UserPermission.password_hash.is_(None),
                                  UserPermission.password_hash == "")).all())
            for row in rows:
                pw = fixed_super if (fixed_super and row.username in _SUPERADMINS) else generate_password(12)
                row.password_hash = hash_password(pw)
                row.password_set_at = now
                row.must_change_password = True
                if not row.email:
                    # O cadastro só guardava a parte antes do '@' (a chave de busca de tudo:
                    # papel, auditoria, presença). Reconstruímos o endereço com o domínio
                    # corporativo, que é exatamente o que a Entra ID entregava.
                    row.email = f"{row.username}@{ALLOWED_DOMAIN}" if ALLOWED_DOMAIN else row.username
                generated.append((row.username, row.role or "reader", pw))
    except Exception as exc:
        logger.error("[auth] Bootstrap de credenciais falhou: %s", exc)
        return

    if not generated:
        return

    path = _write_initial_passwords([f"{u}\t{r}\t{p}" for (u, r, p) in generated])
    logger.warning(
        "[auth] %d conta(s) migrada(s) para login local. Senhas geradas em: %s",
        len(generated), path or "<falha ao gravar>",
    )
    if not path:
        # Último recurso: sem o arquivo, a única cópia da senha é esta linha. É um risco
        # conhecido (fica no log) e ainda assim melhor do que uma aplicação em que ninguém
        # consegue entrar depois de a autenticação anterior ter morrido.
        for (u, r, p) in generated:
            print(f"[auth][senha-inicial] {u} ({r}): {p}", flush=True)
    _record_security_event(
        actor="system", target="server", event_type="auth_migration",
        detail=(f"{len(generated)} conta(s) receberam senha local na migração do Entra ID "
                f"para autenticação própria."),
    )


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


def _must_change_password(username: str) -> bool:
    """True enquanto a conta usa uma senha que outra pessoa escolheu (migração ou reset)."""
    if not _DB_AVAILABLE or not username:
        return False
    try:
        with get_db() as db:
            row = (db.query(UserPermission.must_change_password)
                     .filter(UserPermission.username == username).first())
        return bool(row[0]) if row else False
    except Exception:
        return False


def _client_ip(request: Request) -> str:
    """IP de origem, atravessando o proxy TLS. Só para limite de taxa e auditoria."""
    if request is None:
        return ""
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd[:64]
    client = getattr(request, "client", None)
    return (getattr(client, "host", "") or "")[:64]


def _login_throttle_user(username: str) -> dict:
    """Chave de lockout por USUÁRIO. Usada apenas onde o dono da conta já está autenticado —
    hoje só na troca da própria senha.

    Não pode ser a mesma chave da sessão (`oid` = username): o lockout por senha errada também
    rebaixa o papel para Leitor em _current_role, então compartilhar a chave deixaria um
    administrador virar Leitor por 15 minutos por causa de erros de digitação dele mesmo.

    NÃO É a chave da tela de login. Lá a contagem é por ORIGEM — ver _attempt_source.
    """
    return {"oid": f"login:{username}", "email": username}


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
_ACCESS_REQ_MAX_PER_BROWSER = 5
#: Rede de proteção por IP, mais alta porque um escritório inteiro sai pelo mesmo endereço.
#: Existe porque X-Client-Id é enviado pelo cliente e some com uma limpeza de dados do site.
_ACCESS_REQ_MAX_PER_IP = 15

_ACCESS_REQ_BLOCK_DETAIL = (
    "Limite de solicitações atingido neste navegador. "
    "Se você já pediu acesso, aguarde a análise de um administrador."
)

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
_USERNAME_RE = _re_auth.compile(r"[a-z0-9][a-z0-9._-]{1,63}")


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
    if blocked and username not in _SUPERADMINS:
        raise HTTPException(status_code=403, detail=_BLOCKED_DETAIL,
                            headers={"X-Blocked": "1", "X-Blocked-Reason": "banned"})

    _reset_pw_failures(source)

    now = datetime.now(timezone.utc)
    must_change = False
    try:
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is not None:
                row.last_login = now
                must_change = bool(row.must_change_password)
                role = row.role or "reader"
    except Exception as exc:
        logger.warning("[auth] login: last_login(%s) não registrado: %s", username, exc)

    if username in _SUPERADMINS:
        role = "admin"

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
            "mustChangePassword": must_change,
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
            "mustChangePassword": _must_change_password(uname),
        },
    }


@app.post("/api/auth/change-password")
def auth_change_password(body: dict = Body(default={}), user: dict = Depends(require_auth)):
    """Troca a própria senha (exige a senha atual). Qualquer papel, inclusive Leitor.

    Não é uma operação administrativa e por isso NÃO passa pelo segundo fator (ADMIN_PASSWORD):
    o segundo fator existe para ações de admin sobre a aplicação, e exigi-lo aqui impediria um
    Leitor de trocar a própria senha — justamente quem mais precisa, já que veio de uma senha
    gerada pela migração.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    uname   = _username_of((user or {}).get("email", ""))
    current = str((body or {}).get("currentPassword") or "")
    new_pw  = str((body or {}).get("newPassword") or "")
    if not uname:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    if not current or not new_pw:
        raise HTTPException(status_code=400, detail="Informe a senha atual e a nova senha.")
    if current == new_pw:
        raise HTTPException(status_code=400, detail="A nova senha deve ser diferente da atual.")
    validate_password_strength(new_pw)

    throttle_user = _login_throttle_user(uname)
    _check_pw_lockout(throttle_user)
    _rate_limit(throttle_user, "login")

    now = datetime.now(timezone.utc)
    try:
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == uname).first()
            if row is None:
                raise HTTPException(status_code=404, detail="Conta não encontrada.")
            if not verify_password(current, row.password_hash):
                tripped = _record_pw_failure(throttle_user)
                if tripped:
                    raise HTTPException(status_code=429, detail=_LOCKOUT_DETAIL,
                                        headers={"X-Locked-Out": "1"})
                raise HTTPException(status_code=403, detail="Senha atual incorreta.")
            row.password_hash = hash_password(new_pw)
            row.password_set_at = now
            row.must_change_password = False
            _log_security_event(db, actor=uname, target=uname, event_type="password_change",
                                detail="Senha alterada pelo próprio usuário.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "auth_change_password"))

    _reset_pw_failures(throttle_user)
    # Token novo na resposta: a sessão continua exatamente a mesma, mas devolver um token
    # recém-assinado evita que o cliente fique com um emitido antes da troca e tenha de
    # deslogar o usuário só para refletir `mustChangePassword: false`.
    token, ttl = issue_session_token(uname, (user or {}).get("email", "") or uname)
    return {"ok": True, "token": token, "expiresIn": ttl}


@app.post("/api/auth/request-access")
def auth_request_access(request: Request, body: dict = Body(default={})):
    """Solicitação de acesso de quem ainda não tem conta. Rota SEM autenticação.

    A pessoa escolhe usuário, e-mail e a PRÓPRIA senha; o hash já é gravado aqui e copiado
    para o cadastro na aprovação, de modo que nenhuma senha precisa ser transmitida de volta
    e o admin nunca vê a senha de ninguém. Enquanto está pendente, a solicitação NÃO é uma
    conta: nada em `user_permissions` é criado, então um pedido negado não reserva o nome nem
    aparece na lista de usuários.

    Verificação de e-mail por link de confirmação é um passo FUTURO e não existe aqui: hoje o
    único filtro automático é o domínio corporativo, e a aprovação humana é o que sustenta o
    resto.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    if _is_new_user_lockdown():
        raise HTTPException(
            status_code=403,
            detail="As solicitações de acesso estão fechadas no momento. Contate um administrador.",
        )

    payload   = body or {}
    username  = _username_of(payload.get("username", ""))
    password  = str(payload.get("password") or "")
    # `note` continua aceito e continua sendo gravado: a coluna e o caminho existem. O que
    # saiu foi o CAMPO no formulário — ninguém digita mais, mas nada precisou ser removido
    # para isso, e um pedido vindo de outro cliente que ainda mande o campo segue funcionando.
    note      = str(payload.get("note") or "").strip()[:300]
    client_id = (request.headers.get("x-client-id") or "").strip()[:64]
    ip        = _client_ip(request)

    if not username or not _USERNAME_RE.fullmatch(username):
        raise HTTPException(
            status_code=400,
            detail="Usuário inválido. Use letras, números, ponto, hífen ou sublinhado.",
        )
    # O e-mail DERIVA do usuário em vez de ser digitado. O formulário pedia os dois, e o
    # segundo campo não decidia nada: `_username_of` já corta em '@', então quem digitava
    # 'joao.voss' e quem digitava 'joao.voss@wabtec.com' caíam na mesma conta, e o e-mail
    # aceito tinha de bater com o domínio corporativo de qualquer forma — ou seja, o campo
    # só podia conter <usuario>@<dominio fixo>, que é precisamente o que a linha abaixo
    # monta. Um campo cujo único valor válido é derivável dos outros é um campo para errar.
    # Quem digitar o endereço inteiro no campo de usuário continua sendo aceito.
    email = f"{username}@{ALLOWED_DOMAIN}" if ALLOWED_DOMAIN else username
    validate_password_strength(password)

    try:
        with get_db() as db:
            # ── Limite por navegador ────────────────────────────────────────────────────
            # Contagem sobre TODAS as solicitações daquele X-Client-Id, de qualquer situação:
            # o limite é sobre o ato de pedir, então um pedido negado consome cota igual. Sem
            # client_id (navegador que não mandou o cabeçalho) sobra só a rede por IP.
            if client_id:
                sent = (db.query(func.count(AccessRequest.id))
                          .filter(AccessRequest.client_id == client_id).scalar() or 0)
                if sent >= _ACCESS_REQ_MAX_PER_BROWSER:
                    raise HTTPException(status_code=429, detail=_ACCESS_REQ_BLOCK_DETAIL)
            if ip:
                from_ip = (db.query(func.count(AccessRequest.id))
                             .filter(AccessRequest.ip == ip).scalar() or 0)
                if from_ip >= _ACCESS_REQ_MAX_PER_IP:
                    raise HTTPException(status_code=429, detail=_ACCESS_REQ_BLOCK_DETAIL)

            if db.query(UserPermission).filter(UserPermission.username == username).first():
                raise HTTPException(
                    status_code=409,
                    detail="Já existe uma conta com este usuário. Use 'Entrar' ou fale com um administrador.",
                )
            pending = (db.query(AccessRequest)
                         .filter(AccessRequest.username == username,
                                 AccessRequest.status == "pending").first())
            if pending is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Já existe uma solicitação pendente para este usuário. Aguarde a análise.",
                )

            db.add(AccessRequest(
                username=username, email=email, password_hash=hash_password(password),
                status="pending", note=note or None, client_id=client_id or None,
                ip=ip or None, created_at=datetime.now(timezone.utc),
            ))
            # Fica no feed de alertas do admin (não está em _ALERT_NOISE_TYPES) — é o
            # único aviso de que existe alguém esperando aprovação.
            _log_security_event(db, actor=username, target=username, event_type="access_request",
                                detail=f"Solicitação de acesso de {username} ({email}).")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "auth_request_access"))

    return {"ok": True, "status": "pending"}


def _access_request_dict(r) -> dict:
    """Serializa uma solicitação para o painel do admin. O hash da senha NUNCA sai daqui."""
    return {
        "id": r.id,
        "username": r.username,
        "email": r.email or "",
        "status": r.status,
        "note": r.note or "",
        "created_at": _iso(r.created_at),
        "decided_at": _iso(r.decided_at),
        "decided_by": r.decided_by,
        "decided_role": r.decided_role,
    }


@app.get("/api/admin/access-requests")
def list_access_requests(
    status: str = Query(default="pending"),   # 'pending' | 'approved' | 'rejected' | 'all'
    limit:  int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _user:  dict = Depends(require_admin),
):
    """Fila de solicitações de acesso. Só admins. Leitura pura — decidir exige o segundo fator."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            base = db.query(AccessRequest)
            if status in ("pending", "approved", "rejected"):
                base = base.filter(AccessRequest.status == status)
            total = base.count()
            rows = (base.order_by(AccessRequest.created_at.desc(), AccessRequest.id.desc())
                        .offset(offset).limit(limit).all())
            items = [_access_request_dict(r) for r in rows]
            pending_count = (db.query(func.count(AccessRequest.id))
                               .filter(AccessRequest.status == "pending").scalar() or 0)
        return {"requests": items, "total": total, "pending_count": int(pending_count),
                "limit": limit, "offset": offset}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "list_access_requests"))


@app.post("/api/admin/access-requests/decide")
def decide_access_request(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Aprova ou recusa uma solicitação. Admin + segundo fator (ADMIN_PASSWORD).

    Aprovar CRIA a conta com o hash que o solicitante já escolheu, então ele entra com a senha
    que digitou e nenhuma senha trafega de volta. O papel concedido vem no corpo e o padrão é
    Leitor — conceder Editor/Admin é uma escolha explícita de quem aprova, nunca o default.

    Body: { id, action: 'approve'|'reject', role?: 'reader'|'editor'|'admin' }.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    try:
        req_id = int(payload.get("id") or 0)
    except (TypeError, ValueError):
        req_id = 0
    action = str(payload.get("action") or "").strip().lower()
    role   = str(payload.get("role") or "reader").strip().lower()
    actor  = _username_of((_user or {}).get("email", ""))
    if req_id <= 0:
        raise HTTPException(status_code=400, detail="Solicitação inválida.")
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Ação inválida (use 'approve' ou 'reject').")
    if role not in _STORED_ROLES:
        raise HTTPException(status_code=400, detail="Função inválida.")

    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            req = db.query(AccessRequest).filter(AccessRequest.id == req_id).first()
            if req is None:
                raise HTTPException(status_code=404, detail="Solicitação não encontrada.")
            if req.status != "pending":
                raise HTTPException(status_code=409, detail="Esta solicitação já foi decidida.")

            if action == "reject":
                req.status = "rejected"
                req.decided_at = now
                req.decided_by = actor
                _log_security_event(db, actor=actor, target=req.username, event_type="access_denied",
                                    detail=f"Solicitação de acesso recusada: {req.username}.")
                return {"ok": True, "id": req_id, "status": "rejected", "username": req.username}

            existing = (db.query(UserPermission)
                          .filter(UserPermission.username == req.username).first())
            if existing is not None:
                # A conta passou a existir entre o pedido e a decisão (outro admin a criou).
                # Fechamos a solicitação como aprovada em vez de sobrescrever a conta viva:
                # trocar o hash de uma conta em uso a partir de um pedido antigo mudaria a
                # senha de alguém sem que ninguém tivesse pedido isso.
                req.status = "approved"
                req.decided_at = now
                req.decided_by = actor
                req.decided_role = existing.role
                raise HTTPException(status_code=409,
                                    detail="Este usuário já foi cadastrado. A solicitação foi encerrada.")

            username = req.username
            db.add(UserPermission(
                username=username, role=role, email=req.email,
                password_hash=req.password_hash, password_set_at=now,
                must_change_password=False, created_at=now,
                last_role_change_at=now, last_role_change_by=actor,
            ))
            req.status = "approved"
            req.decided_at = now
            req.decided_by = actor
            req.decided_role = role
            _log_security_event(db, actor=actor, target=username, event_type="access_granted",
                                detail=f"Acesso aprovado como {role}: {username}.")
        _forget_role(username)
        return {"ok": True, "id": req_id, "status": "approved", "username": username, "role": role}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "decide_access_request"))


@app.post("/api/permissions/users/delete")
def delete_user(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """EXCLUI a conta do cadastro. Admin + segundo fator. Body: { username }.

    Diferente de /users/remove (que só rebaixa para Leitor e mantém a linha) e de /users/block
    (que nega o acesso e preserva o papel para uma futura restauração): aqui a linha some, e com
    ela a credencial — a pessoa deixa de ter conta e teria de solicitar acesso de novo.

    O que NÃO some é a trilha de auditoria: `security_events` é append-only e as linhas sobre
    este usuário continuam lá, porque o registro do que aconteceu não pode depender de a conta
    ainda existir. As solicitações de acesso antigas também ficam, marcadas como decididas.

    Sessões abertas morrem na próxima requisição: sem linha no cadastro, _is_unregistered_locked
    recusa o token que continua criptograficamente válido até expirar.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    username = _username_of((body or {}).get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    if username == actor:
        raise HTTPException(status_code=400, detail="Você não pode excluir a própria conta.")
    if username in _SUPERADMINS:
        raise HTTPException(status_code=400, detail="Não é possível excluir um superadministrador.")
    try:
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is None:
                return {"ok": True, "username": username, "deleted": False}   # idempotente
            if row.role == "admin" and not row.is_blocked:
                active_admins = (db.query(UserPermission)
                                   .filter(UserPermission.role == "admin",
                                           UserPermission.is_blocked.is_(False)).count())
                if active_admins <= 1:
                    raise HTTPException(status_code=400,
                                        detail="Não é possível excluir o último administrador ativo.")
            prev_role = row.role
            db.delete(row)
            _log_security_event(db, actor=actor, target=username, event_type="user_deleted",
                                detail=f"Conta excluída do cadastro (era {prev_role}).")
        _forget_role(username)
        _refresh_blocked_cache(force=True)
        return {"ok": True, "username": username, "deleted": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "delete_user"))


@app.post("/api/permissions/users/reset-password")
def reset_user_password(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Gera uma senha nova para uma conta e a devolve UMA vez. Admin + segundo fator.

    A senha é aleatória e não escolhida pelo admin de propósito: uma senha que o administrador
    digita é uma senha que ele conhece e provavelmente reutiliza. Ela volta em texto puro nesta
    resposta e em lugar nenhum além dela — o banco guarda só o hash e a trilha de auditoria
    registra que houve reset, nunca o valor. A conta fica marcada com `must_change_password`,
    então o app pede a troca no primeiro login.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    username = _username_of((body or {}).get("username", ""))
    actor = _username_of((_user or {}).get("email", ""))
    if not username:
        raise HTTPException(status_code=400, detail="Usuário inválido.")
    new_pw = generate_password(12)
    try:
        now = datetime.now(timezone.utc)
        with get_db() as db:
            row = db.query(UserPermission).filter(UserPermission.username == username).first()
            if row is None:
                raise HTTPException(status_code=404, detail="Conta não encontrada.")
            row.password_hash = hash_password(new_pw)
            row.password_set_at = now
            row.must_change_password = True
            _log_security_event(db, actor=actor, target=username, event_type="password_reset",
                                detail=f"Senha redefinida por {actor}.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "reset_user_password"))
    # Uma senha antiga não vale mais, então as tentativas malsucedidas acumuladas também não.
    _reset_pw_failures(_login_throttle_user(username))
    return {"ok": True, "username": username, "password": new_pw}


# ── Auditoria column filters (Excel-style value checklists) ──────────────────
# The audit tab used to offer blind free-text boxes: you had to already KNOW that an event type
# is spelled 'data_edit_summary' to filter for it. It now works like the Database viewer's column
# filters — the popover LISTS the distinct values that exist and you tick the ones you want — so
# the filter params below take a comma-separated SET of exact values.
_EVENT_FACET_COLS = ("event_type", "actor", "target", "detail")
_EVENT_BLANK = "(vazias)"      # facet token for NULL/'' — mirrors the grid's blank bucket
_EVENT_FACET_CAP = 500         # distinct values returned per column (matches VALUE_LIST_CAP)
# Separator for the DETAIL value set. Detail is free-form prose and routinely contains commas
# ("3 linhas, 2 colunas"), so the comma separator the other columns use would split one value
# into two and match nothing. Newlines never occur in a detail string, so they separate safely.
_EVENT_DETAIL_SEP = "\n"


def _event_facet_col(name: str):
    """Resolve a facet column name to its ORM column (None ⇒ not a facet). Resolved lazily so
    this module still imports when the optional DB models are unavailable."""
    key = (name or "").strip().lower()
    if key not in _EVENT_FACET_COLS or not _DB_AVAILABLE:
        return None
    return getattr(SecurityEvent, key)


def _facet_values(raw: str, sep: str = ",") -> list[str]:
    """Split a separated facet param into the exact values it selects."""
    return [v.strip() for v in (raw or "").split(sep) if v.strip()]


def _facet_filter(query, col, raw: str, sep: str = ","):
    """Restrict `query` to the selected values of `col`, honouring the blank bucket."""
    vals = _facet_values(raw, sep)
    if not vals:
        return query
    concrete = [v for v in vals if v != _EVENT_BLANK]
    clauses = []
    if concrete:
        clauses.append(col.in_(concrete))
    if _EVENT_BLANK in vals:
        clauses.append(or_(col.is_(None), col == ""))
    return query.filter(or_(*clauses)) if len(clauses) > 1 else query.filter(clauses[0])


def _apply_event_filters(
    query, target: str, event_type: str, actor: str, detail: str, detail_vals: str = "",
):
    """Shared WHERE builder for the audit trail and its facet lists.

    DETAIL takes two independent params, and both may be active at once: `detail` is the
    legacy free-text CONTAINS search, `detail_vals` the value checklist (newline-separated,
    see _EVENT_DETAIL_SEP). Keeping the substring search means an existing caller — or a
    bookmarked URL — still filters the way it always did."""
    query = _facet_filter(query, SecurityEvent.target,     target)
    query = _facet_filter(query, SecurityEvent.event_type, event_type)
    query = _facet_filter(query, SecurityEvent.actor,      actor)
    query = _facet_filter(query, SecurityEvent.detail,     detail_vals, _EVENT_DETAIL_SEP)
    if (detail or "").strip():
        query = query.filter(SecurityEvent.detail.ilike(f"%{detail.strip()}%"))
    return query


@app.get("/api/security/events/facets")
def security_event_facets(
    column:      str = Query(...),                  # 'event_type' | 'actor' | 'target' | 'detail'
    target:      str = Query(default=""),
    event_type:  str = Query(default=""),
    actor:       str = Query(default=""),
    detail:      str = Query(default=""),
    detail_vals: str = Query(default=""),
    _user:       dict = Depends(require_admin),
):
    """Distinct values (+ counts) available for ONE audit column, so its filter popover can list
    them instead of asking for a blind search string. Admins only.

    Excel/Denodo semantics: the list is scoped by every OTHER column's active filter but NOT by
    this column's own, so ticking a value never makes its siblings disappear from the popover."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    col = _event_facet_col(column)
    if col is None:
        raise HTTPException(status_code=400, detail="Coluna de filtro inválida.")
    try:
        key = column.strip().lower()
        with get_db() as db:
            q = _apply_event_filters(
                db.query(col, func.count(SecurityEvent.id)),
                "" if key == "target"     else target,
                "" if key == "event_type" else event_type,
                "" if key == "actor"      else actor,
                # Detail's own two filters are both dropped when detail is the open column,
                # or its popover would only ever list what it has already selected.
                "" if key == "detail"     else detail,
                "" if key == "detail"     else detail_vals,
            )
            rows = q.group_by(col).all()
        values = []
        blank = 0
        for raw, cnt in rows:
            if raw is None or str(raw) == "":
                blank += int(cnt or 0)
            else:
                values.append({"value": str(raw), "count": int(cnt or 0)})
        values.sort(key=lambda v: v["value"].lower())
        if blank:
            values.insert(0, {"value": _EVENT_BLANK, "count": blank})
        return {"column": key, "values": values[:_EVENT_FACET_CAP],
                "total": len(values), "truncated": len(values) > _EVENT_FACET_CAP}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "security_event_facets"))


@app.get("/api/security/events")
def security_events(
    target:      str = Query(default=""),
    event_type:  str = Query(default=""),
    actor:       str = Query(default=""),
    detail:      str = Query(default=""),
    detail_vals: str = Query(default=""),
    limit:       int = Query(default=100, ge=1, le=500),
    offset:      int = Query(default=0, ge=0),
    _user:       dict = Depends(require_admin),
):
    """Append-only security/audit trail (lockouts, role changes, blocks). Admins only.

    The Auditoria column filters are Excel-style VALUE CHECKLISTS (see /events/facets), so
    `event_type`, `actor` and `target` accept a COMMA-SEPARATED set of exact values and match
    any of them (a single value still works, unchanged). DETAIL has both: `detail_vals` is
    its checklist (NEWLINE-separated, since detail text contains commas) and `detail` remains
    the case-insensitive CONTAINS search."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            base = _apply_event_filters(
                db.query(SecurityEvent), target, event_type, actor, detail, detail_vals)
            total = base.count()
            rows = (base.order_by(SecurityEvent.ts.desc(), SecurityEvent.id.desc())
                        .offset(offset).limit(limit).all())
            events = [{
                "id": r.id, "ts": _iso(r.ts), "actor": r.actor,
                "target": r.target, "event_type": r.event_type, "detail": r.detail,
            } for r in rows]
        return {"events": events, "total": total, "limit": limit, "offset": offset}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "security_events"))


# ── Admin notification feed (built on the SecurityEvent audit trail) ──────────
# Event types that are audit-only noise, NOT admin alerts: excluded from the badge count and
# the active-alerts panel (still visible in the full /api/security/events trail). Everything
# else — lockouts, bans, role/permission changes, calendar/data/config edits, and any FUTURE
# event_type — is alert-worthy by default, so new alert sources light up the badge automatically.
# 'data_edit' is no longer WRITTEN (a save now appends ONE 'data_edit_summary' carrying the
# per-row detail); the type stays listed so historical per-row rows keep out of the feed.
#
# De-noised routine usage (kept in the full audit trail, NOT shown as admin alerts): the
# admin panel must surface meaningful operational/security events, not everyday app usage.
# Removed from the alert feed:
#   • protected_access          — no longer written at all (see db_dataset_view); listed for
#                                 historical rows only
#   • admin_pw_used / import_pw_used — successful password usage (the ACTION it authorized,
#                                   e.g. data_import/data_download/calendar_change, still alerts)
#   • admin_pw_fail / import_pw_fail — SINGLE failed password attempts (a lockout after 5 in a
#                                   row still fires its own 'lockout' alert)
#   • perm_denied               — routine permission validations
# Meaningful events remain alert-worthy by default: data_import, data_edit_summary,
# data_download, calendar_change, role_change, user_registered, block, unblock, lockout, and
# any FUTURE type.
_ALERT_NOISE_TYPES = {
    "first_login", "ack_warning", "data_edit",
    "protected_access",
    "admin_pw_used", "import_pw_used",
    "admin_pw_fail", "import_pw_fail",
    "perm_denied",
    # Rotina do login local: um sino que toca a cada entrada e a cada senha digitada errada
    # soterra o que existe para ser visto (uma solicitação de acesso esperando aprovação, uma
    # conta excluída, um reset de senha). As linhas continuam na trilha de auditoria, que é
    # onde se investiga "quem entrou quando"; o que sai é o alerta, não o registro.
    "login", "login_fail", "login_blocked", "password_change",
}


def _alert_dict(r) -> dict:
    return {
        "id": r.id, "ts": _iso(r.ts), "actor": r.actor, "target": r.target,
        "event_type": r.event_type, "detail": r.detail,
        "acknowledged_at": _iso(r.acknowledged_at), "acknowledged_by": r.acknowledged_by,
    }


@app.get("/api/admin/alerts")
def admin_alerts(
    status: str = Query(default="active"),          # 'active' (unacked) | 'history' (acked)
    limit:  int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _user:  dict = Depends(require_admin),
):
    """Admin notification feed. Admins only. Reuses the append-only SecurityEvent trail:
    an event with acknowledged_at IS NULL (and not a noise type) is an ACTIVE alert.

    Returns `active_count` (the badge number, independent of paging) plus the requested page
    of `alerts`. status='history' lists acknowledged events for auditing."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        want_history = status.strip().lower() == "history"
        with get_db() as db:
            base = db.query(SecurityEvent).filter(SecurityEvent.event_type.notin_(_ALERT_NOISE_TYPES))
            base = base.filter(SecurityEvent.acknowledged_at.isnot(None) if want_history
                               else SecurityEvent.acknowledged_at.is_(None))
            total = base.count()
            rows = (base.order_by(SecurityEvent.ts.desc(), SecurityEvent.id.desc())
                        .offset(offset).limit(limit).all())
            alerts = [_alert_dict(r) for r in rows]
            # Badge count = ALL active alerts, not just this page.
            active_count = (db.query(func.count(SecurityEvent.id))
                              .filter(SecurityEvent.event_type.notin_(_ALERT_NOISE_TYPES),
                                      SecurityEvent.acknowledged_at.is_(None)).scalar() or 0)
        return {"alerts": alerts, "active_count": int(active_count),
                "total": total, "limit": limit, "offset": offset}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "admin_alerts"))


@app.post("/api/admin/alerts/ack")
def admin_alerts_ack(body: dict = Body(default={}), _user: dict = Depends(require_admin)):
    """Acknowledge admin alerts (mark reviewed). Admins only.

    Body: { ids: [1,2,3] }  → ack those alerts;  { all: true } → ack every active alert.
    Stamps acknowledged_at/acknowledged_by so the events leave the active count and move to
    history; the audit rows themselves are preserved (never deleted)."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    from datetime import datetime as _dt, timezone as _tz
    payload = body or {}
    actor = _username_of((_user or {}).get("email", ""))
    ack_all = bool(payload.get("all"))
    ids: list[int] = []
    if not ack_all:
        for x in (payload.get("ids") or []):
            try:
                ids.append(int(x))
            except (TypeError, ValueError):
                continue
        if not ids:
            raise HTTPException(status_code=400, detail="Informe 'ids' (lista) ou 'all': true.")
    try:
        now = _dt.now(_tz.utc)
        with get_db() as db:
            q = db.query(SecurityEvent).filter(
                SecurityEvent.acknowledged_at.is_(None),
                SecurityEvent.event_type.notin_(_ALERT_NOISE_TYPES),
            )
            if not ack_all:
                q = q.filter(SecurityEvent.id.in_(ids))
            n = q.update({SecurityEvent.acknowledged_at: now, SecurityEvent.acknowledged_by: actor},
                         synchronize_session=False)
            remaining = (db.query(func.count(SecurityEvent.id))
                           .filter(SecurityEvent.event_type.notin_(_ALERT_NOISE_TYPES),
                                   SecurityEvent.acknowledged_at.is_(None)).scalar() or 0)
        return {"ok": True, "acknowledged": int(n), "active_count": int(remaining)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "admin_alerts_ack"))


@app.get("/api/security/stats")
def security_stats(_user: dict = Depends(require_admin)):
    """Aggregate metrics for the security dashboard (cheap COUNT/SUM queries — never
    pulls the whole roster to the client). Admins only."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        now = datetime.now(timezone.utc)
        d7  = now - timedelta(days=7)
        d30 = now - timedelta(days=30)
        with get_db() as db:
            total_users = db.query(func.count(UserPermission.id)).scalar() or 0

            by_role = {"reader": 0, "editor": 0, "admin": 0}
            for role, cnt in (db.query(UserPermission.role, func.count(UserPermission.id))
                                .group_by(UserPermission.role).all()):
                if role in by_role:
                    by_role[role] = int(cnt)

            blocked = db.query(func.count(UserPermission.id)) \
                        .filter(UserPermission.is_blocked.is_(True)).scalar() or 0

            warned_total = db.query(func.count(UserPermission.id)) \
                             .filter(UserPermission.lockout_count > 0).scalar() or 0

            warned_active = db.query(func.count(UserPermission.id)).filter(
                UserPermission.lockout_count > 0,
                UserPermission.last_lockout_at.isnot(None),
                or_(UserPermission.warning_ack_at.is_(None),
                    UserPermission.warning_ack_at < UserPermission.last_lockout_at),
            ).scalar() or 0

            total_lockouts = db.query(func.coalesce(func.sum(UserPermission.lockout_count), 0)).scalar() or 0

            active_7d  = db.query(func.count(UserPermission.id)) \
                           .filter(UserPermission.last_login >= d7).scalar() or 0
            active_30d = db.query(func.count(UserPermission.id)) \
                           .filter(UserPermission.last_login >= d30).scalar() or 0

            events_30d: dict[str, int] = {}
            for etype, cnt in (db.query(SecurityEvent.event_type, func.count(SecurityEvent.id))
                                 .filter(SecurityEvent.ts >= d30)
                                 .group_by(SecurityEvent.event_type).all()):
                events_30d[etype] = int(cnt)

            recent_rows = (db.query(SecurityEvent)
                             .order_by(SecurityEvent.ts.desc(), SecurityEvent.id.desc())
                             .limit(8).all())
            recent = [{
                "id": r.id, "ts": _iso(r.ts), "actor": r.actor,
                "target": r.target, "event_type": r.event_type, "detail": r.detail,
            } for r in recent_rows]

        return {
            "total_users": int(total_users),
            "by_role": by_role,
            "blocked": int(blocked),
            "warned_total": int(warned_total),
            "warned_active": int(warned_active),
            "total_lockouts": int(total_lockouts),
            "active_7d": int(active_7d),
            "active_30d": int(active_30d),
            "events_30d": events_30d,
            "recent_events": recent,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "security_stats"))


# ── Schedule visual overrides (persisted DELTA layer; PER SCENARIO) ────────────────────
# Original Data + Override = Effective Schedule. These endpoints ONLY read/write the
# schedule_override delta table; the source schedule is never touched. The merge back into a
# final schedule happens on the client at load time (the worker's applyOverrideToGroup).
# Every read/write is scoped by scenario_id (the scenario NAME; '' = base DB schedule) so each
# imported scenario keeps its own edits and they never leak across scenarios.
_BASE_SCENARIO = ""  # scenario_id sentinel for the base DB schedule


# Move-description caps. Mirrors MOVE_NOTE_MAX_LEN / MOVE_NOTE_MAX_ENTRIES in the frontend's
# lib/locoOverrides.ts — re-enforced here because the client is not the authority on how much
# free text lands in payload_json, which is read back on every schedule load.
_MOVE_NOTE_MAX_LEN = 280
_MOVE_NOTE_MAX_ENTRIES = 20
_MOVE_NOTE_BY_MAX_LEN = 120
_MOVE_NOTE_AT_MAX_LEN = 32
# Mandatory move/edit classification — the fixed allowlist (mirrors MOVE_CATEGORIES in
# lib/locoOverrides.ts). Anything else posted as a category is silently dropped: the category is
# rendered as trusted-looking UI chips, so only these exact labels may persist.
# "Manual Swap" is the SYSTEM-authored classification stamped on a WS40↔WS50 manual swap
# (see swapWs / gantt_swap_ws). It is a valid persisted category but is NOT offered in the
# manual move-reason dropdown (it is never user-selectable) — MOVE_CATEGORIES excludes it.
_MOVE_NOTE_CATEGORIES = {"Estoque", "Máquina", "Material", "Mão-de-obra", "Produção", "Qualidade", "Recovery Plan", "Manual Swap"}


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


def _sync_override_rows(db, scenario_id: str, overrides_map: dict, who, stats: dict | None = None) -> int:
    """Diff a LocoOverrideMap against the stored ScheduleOverride rows for `scenario_id` and mirror
    it: UPDATE changed objects, INSERT new ones, DELETE objects no longer present. Returns the number
    of desired (persisted) rows. The caller owns the get_db() session. Shared by the base-schedule
    override save and the Projeção reference save — both persist a LocoOverrideMap into this same
    delta table (the latter under a reserved scenario_id namespace, see _projref_scenario_id).

    Pass `stats` to receive what THIS save actually changed: {'inserted','updated','deleted','locos'}.
    The client posts the whole map every time, so the row TOTAL is not a measure of the save — only
    the diff is. That is what the admin alert reports (see put_overrides)."""
    st = stats if stats is not None else {}
    st.setdefault("inserted", 0); st.setdefault("updated", 0); st.setdefault("deleted", 0)
    touched: set = st.setdefault("locos", set())
    desired = _flatten_override_map(overrides_map)
    desired_by_key = {
        (scenario_id, d["loco_key"], d["scope"], d["scope_key"]): d for d in desired
    }
    existing = db.query(ScheduleOverride).filter(
        ScheduleOverride.scenario_id == scenario_id
    ).all()
    existing_by_key = {
        (e.scenario_id, e.loco_key, e.scope, e.scope_key): e for e in existing
    }
    for key, d in desired_by_key.items():
        pj = json.dumps(d["payload"], separators=(",", ":"), ensure_ascii=False)
        row = existing_by_key.get(key)
        if row is not None:
            if row.payload_json != pj:          # update only when actually changed
                row.payload_json = pj
                row.updated_by = who
                st["updated"] += 1
                touched.add(d["loco_key"])
        else:
            db.add(ScheduleOverride(
                scenario_id=scenario_id, loco_key=d["loco_key"],
                scope=d["scope"], scope_key=d["scope_key"],
                payload_json=pj, updated_by=who,
            ))
            st["inserted"] += 1
            touched.add(d["loco_key"])
    for key, row in existing_by_key.items():     # drop objects no longer edited
        if key not in desired_by_key:
            db.delete(row)
            st["deleted"] += 1
            touched.add(row.loco_key)
    return len(desired)


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


@app.put("/api/gantt/overrides")
def put_overrides(body: dict = Body(default={}), user: dict = Depends(require_editor)):
    """
    Incrementally persist the current override set for the base schedule. Diffs the posted
    LocoOverrideMap against what is stored: UPDATE changed objects, INSERT new ones, DELETE
    objects no longer present. The UNIQUE (scenario_id, loco_key, scope, scope_key) guarantees
    one row per edited object — no duplicates.

    Editor/Admin only. Body shape: { "overrides": <LocoOverrideMap>, "password": <str> }. The
    password is the same application import password (IMPORT_PASSWORD) used by the Excel imports —
    validated BEFORE any write so nothing is persisted on a wrong password.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

    payload = body or {}
    # Wrapper form { overrides, password, scenario }. (No legacy bare-map form: persistence now always
    # requires the password gate.) `scenario` = the scenario identity (imported scenario name; '' =
    # base DB schedule), so the diff/upsert/delete below is scoped to THAT scenario only and one
    # scenario's edits can never overwrite or delete another's.
    overrides_map = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}
    scenario_id = payload.get("scenario") if isinstance(payload.get("scenario"), str) else ""
    if _is_reserved_scenario_id(scenario_id):
        raise HTTPException(status_code=400, detail="Cenário inválido.")
    scenario_id = scenario_id or _BASE_SCENARIO
    _check_app_password(payload.get("password", ""), user, context="Salvar alterações do cronograma")

    try:
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        stats: dict = {}
        with get_db() as db:
            count = _sync_override_rows(db, scenario_id, overrides_map, who, stats)
            # ── ONE admin-facing alert per SAVE ──────────────────────────────
            # Same batching contract as the DB editor's 'data_edit_summary': a save that
            # touches 12 objects must produce ONE alert, never 12. Counts come from the DIFF
            # (the client posts the entire map every save, so the row total says nothing about
            # what this operation changed) and a no-op save stays silent.
            n_ins, n_upd, n_del = stats["inserted"], stats["updated"], stats["deleted"]
            n_edits = n_ins + n_upd + n_del
            if n_edits > 0:
                partes = []
                if n_ins:
                    partes.append(f"{n_ins} inclusão(ões)")
                if n_upd:
                    partes.append(f"{n_upd} alteração(ões)")
                if n_del:
                    partes.append(f"{n_del} remoção(ões)")
                cenario = "cronograma base" if scenario_id == _BASE_SCENARIO else f"cenário '{scenario_id}'"
                _log_security_event(
                    db, actor=who, target=None, event_type="schedule_save",
                    detail=(f"{who} salvou {n_edits} edição(ões) de cronograma em "
                            f"{len(stats['locos'])} locomotiva(s) — {cenario}: {'; '.join(partes)}."),
                )
        return {"ok": True, "count": count}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.delete("/api/gantt/overrides")
def delete_overrides(scenario: str = "", _user: dict = Depends(require_editor)):
    """Clear ALL saved overrides for ONE scenario (the Reset). `scenario` = the scenario identity
    (imported scenario name; '' = base DB schedule), so a Reset never touches another scenario's
    edits. Editor/Admin only."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    if _is_reserved_scenario_id(scenario):
        raise HTTPException(status_code=400, detail="Cenário inválido.")
    try:
        who = (_user or {}).get("email") or (_user or {}).get("sub") or None
        sid = scenario or _BASE_SCENARIO
        with get_db() as db:
            n = db.query(ScheduleOverride).filter(
                ScheduleOverride.scenario_id == sid
            ).delete(synchronize_session=False)
            # The single most destructive schedule action there is — it discards EVERY saved edit
            # for the scenario — and it was the one write on this resource with no audit row at all
            # (the PUT beside it logs schedule_save). Only recorded when something was actually
            # removed, so a Reset on an already-clean scenario stays silent.
            if n:
                cenario = "cronograma base" if sid == _BASE_SCENARIO else f"cenário '{scenario}'"
                _log_security_event(
                    db, actor=who, target=None, event_type="schedule_reset",
                    detail=f"{who} apagou TODAS as {n} edição(ões) salvas do {cenario}.",
                )
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Projeção OVERRIDE LAYER (the three-layer schedule model) ────────────────────────────────────
# Original (imported DB) → Standard overrides → Projeção overrides. Each layer inherits only from the
# one directly beneath it, so:
#   • Standard = Original + standard overrides   (deviation reference: Original)
#   • Projeção = Standard + THESE overrides      (deviation reference: the LIVE Standard)
# Projeção is an isolated future-planning layer: edits made here are visible ONLY in Projeção and can
# never leak into the operational plan. That isolation is why these deltas need their own namespace —
# get_overrides must never pick them up.
#
# Composition is a per-object REPLACE (frontend mergeOverrideMaps), not an addition, because
# startShiftDays is absolute-from-base: a Projeção edit states where the object should be, and any
# object it does not mention transparently inherits Standard.
#
# Distinct from _PROJREF_PREFIX below, which is the frozen reference SNAPSHOT. That mechanism is no
# longer used for deviations (Projeção now compares against the live Standard) and its UI is hidden,
# but the endpoints, the version history and the stored rows are all kept intact — that versioning
# structure is planned for reuse as saved VERSIONS OF THE STANDARD schedule.
_PROJOV_PREFIX = "__projov__:"


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


@app.put("/api/gantt/projection-overrides")
def put_projection_overrides(body: dict = Body(default={}), user: dict = Depends(require_editor)):
    """Persist the Projeção override layer for ONE scenario. Same contract, gate and diff/upsert path
    as put_overrides — Editor/Admin, application import password validated BEFORE any write — but
    scoped to the reserved Projeção-layer namespace so it can never touch the operational plan.
    Emits its own batched admin alert, tagged so a simulation save is distinguishable from an
    operational one in the feed."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    overrides_map = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}
    scenario_raw = payload.get("scenario") if isinstance(payload.get("scenario"), str) else ""
    scenario_id = _projov_scenario_id(scenario_raw)
    _check_app_password(payload.get("password", ""), user, context="Salvar projeção do cronograma")
    try:
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        stats: dict = {}
        with get_db() as db:
            count = _sync_override_rows(db, scenario_id, overrides_map, who, stats)
            n_edits = stats["inserted"] + stats["updated"] + stats["deleted"]
            if n_edits > 0:
                cenario = "cronograma base" if not scenario_raw else f"cenário '{scenario_raw}'"
                _log_security_event(
                    db, actor=who, target=None, event_type="schedule_save",
                    detail=(f"{who} salvou {n_edits} edição(ões) na PROJEÇÃO do cronograma em "
                            f"{len(stats['locos'])} locomotiva(s) — {cenario}."),
                )
        return {"ok": True, "count": count}
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


@app.put("/api/gantt/projection-ref")
def put_projection_ref(body: dict = Body(default={}), user: dict = Depends(require_editor)):
    """Freeze / update the shared Projeção reference snapshot for ONE scenario ("Atualizar referência").
    Editor/Admin only, gated by the same application import password as the override save — validated
    BEFORE any write. Body: { "overrides": <LocoOverrideMap>, "password": <str>, "scenario": <str> }.
    Persisted through the SAME diff/upsert/delete path as the base overrides, into the reserved
    Projeção namespace so it never collides with a scenario's real edits. Everyone can then read it."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    overrides_map = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}
    scenario_id = _projref_scenario_id(payload.get("scenario") if isinstance(payload.get("scenario"), str) else "")
    _check_app_password(payload.get("password", ""), user, context="Atualizar referência de Projeção")
    try:
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        with get_db() as db:
            count = _sync_override_rows(db, scenario_id, overrides_map, who)
            # SHARED state: this snapshot is the deviation baseline every user measures against, so
            # a re-freeze silently changes what everyone else sees as "the deviation". Audited for
            # the same reason schedule_save is.
            cenario = "cronograma base" if not (payload.get("scenario") or "") else f"cenário '{payload.get('scenario')}'"
            _log_security_event(
                db, actor=who, target=None, event_type="schedule_ref_freeze",
                detail=f"{who} atualizou a referência compartilhada de Projeção ({count} registro(s)) — {cenario}.",
            )
        return {"ok": True, "count": count}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Projeção reference VERSION HISTORY (Option A: versioned baselines + absorption ledger) ──────
# The single-snapshot projection-ref above is superseded by an append-only version history so a
# re-baseline never discards the accumulated delay: incremental deviation is measured vs the LATEST
# version, cumulative deviation vs version 0 (the original reference of record). Editor+ appends,
# everyone reads. The legacy __projref__: snapshot is kept in sync on write and adopted as version 0
# when this table has no rows yet, so nothing already frozen is lost.
_PROJBASE_RETENTION = 30   # keep version 0 (anchor) + the most recent (RETENTION-1) freezes


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


@app.put("/api/gantt/projection-baselines")
def put_projection_baseline(body: dict = Body(default={}), user: dict = Depends(require_editor_unlock)):
    """Append a NEW Projeção baseline version ("Atualizar referência"). Editor/Admin only, gated by the
    ADMIN second factor (require_editor_unlock — the X-Admin-Unlock grant, i.e. the ADMIN_PASSWORD; a
    stronger gate than the import-password override save, since a re-baseline is shared and high-impact).
    Body: { overrides: <LocoOverrideMap>, scenario, label? }. Returns the new version index — the first
    freeze is version 0 (the cumulative reference of record), each later freeze version+1. Retention keeps
    version 0 forever and bounds the rest."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    overrides_map = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}
    scenario = payload.get("scenario") if isinstance(payload.get("scenario"), str) else ""
    scenario_id = scenario or _BASE_SCENARIO
    label = payload.get("label") if isinstance(payload.get("label"), str) and payload.get("label").strip() else None
    try:
        _ensure_projbase_table()
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        pj = json.dumps(overrides_map, separators=(",", ":"), ensure_ascii=False)
        with get_db() as db:
            rows = db.query(ProjectionBaseline).filter(
                ProjectionBaseline.scenario_id == scenario_id
            ).order_by(ProjectionBaseline.version.asc()).all()
            next_ver = (max(r.version for r in rows) + 1) if rows else 0
            db.add(ProjectionBaseline(
                scenario_id=scenario_id, version=next_ver,
                payload_json=pj, label=label, created_by=who,
            ))
            db.flush()
            # Retention: never prune version 0 (the cumulative anchor); drop the OLDEST of the rest
            # beyond the cap so the recent timeline stays bounded.
            kept = db.query(ProjectionBaseline).filter(
                ProjectionBaseline.scenario_id == scenario_id
            ).order_by(ProjectionBaseline.version.asc()).all()
            prunable = [r for r in kept if r.version != 0]
            excess = len(kept) - _PROJBASE_RETENTION
            for r in prunable[:max(0, excess)]:
                db.delete(r)
            # A re-baseline resets what "incremental deviation" means for every user of this
            # scenario — high-impact and shared, per this endpoint's own docstring — so it belongs
            # in the trail next to schedule_save.
            cenario = "cronograma base" if not scenario else f"cenário '{scenario}'"
            _log_security_event(
                db, actor=who, target=None, event_type="schedule_ref_freeze",
                detail=(f"{who} congelou a versão {next_ver} da referência de Projeção"
                        f"{f' ({label})' if label else ''} — {cenario}."),
            )
        return {"ok": True, "version": next_ver}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Logística: the shared stored base ────────────────────────────────────────────────────
# The Logística tab reads a workbook dropped into the browser; nothing about it ever reached
# the server. An Admin can now PROMOTE one of those workbooks to the base the tab opens on for
# everyone — the only reason this feature has a server surface at all.
#
# What is stored is the SOURCE CELLS, never the parsed model (see LogisticaBase): the client
# re-runs the identical parser it runs on an uploaded file, so a stored base and a freshly
# imported one cannot diverge.
#
# Gates on the WRITE — every control the checklist demands of a new endpoint, re-applied:
#   • Azure AD identity + @wabtec domain + hard ban … require_auth (inside require_admin_unlock)
#   • Admin role — Editors/Readers cannot promote ... require_admin_unlock
#   • ADMIN second factor (X-Admin-Unlock grant) .... require_admin_unlock
#   • IMPORT password, the same secret the Excel imports use, typed at the commit step
#   • failed-password lockout + rate limit .......... inside _check_app_password
#   • error scrubbing ............................... _log_and_generic
#   • audit row ..................................... _log_security_event
# No new outbound host, so the CSP is unchanged; no new secret is introduced.
#
# READING is open to any authenticated user (Readers included): the stored base IS the tab's
# content for everyone, and it carries no more than the workbook an Admin chose to publish.
_LOGISTICA_MAX_ROWS  = 200_000
_LOGISTICA_MAX_BYTES = 25 * 1024 * 1024   # serialized payload ceiling; a base is ~2-4 MB


def _ensure_logistica_table() -> None:
    """Idempotently guarantee logistica_base exists before the endpoints touch it — same
    reasoning as _ensure_projbase_table: startup create_all is best-effort, so a route defined
    at import time must not be the first thing to discover a missing relation."""
    try:
        LogisticaBase.__table__.create(bind=db_engine, checkfirst=True)
    except Exception as _e:  # never let a create race turn into a request failure
        logger.warning("[logistica] ensure table: %s", _e)


@app.get("/api/logistica/base")
def logistica_base(_user: dict = Depends(require_auth)):
    """The stored Logística base, or {"base": null} when none was ever saved.

    Returns the source cells plus who published them and when, so the tab can say WHICH file
    everyone is looking at instead of presenting anonymous numbers."""
    if not _DB_AVAILABLE:
        return {"base": None}
    try:
        _ensure_logistica_table()
        with get_db() as db:
            row = db.query(LogisticaBase).order_by(LogisticaBase.id.desc()).first()
            if row is None:
                return {"base": None}
            # Read every attribute INSIDE the session (expire_on_commit), like get_overrides.
            raw, name = row.payload_json, row.file_name
            count, when, who = row.row_count, row.created_at, row.created_by
        try:
            payload = json.loads(raw) if raw else {}
        except (json.JSONDecodeError, TypeError):
            # A corrupt blob is reported as "no base", never as an empty one: silently serving
            # zero rows would read as a legitimately empty workbook.
            logger.warning("[logistica] stored base is not valid JSON — ignoring it")
            return {"base": None}
        return {"base": {
            "file_name": name or "",
            "row_count": int(count or 0),
            "saved_at":  when.isoformat() if when else None,
            "saved_by":  who,
            "columns":   payload.get("columns") if isinstance(payload.get("columns"), list) else [],
            "matrix":    payload.get("matrix") if isinstance(payload.get("matrix"), list) else [],
        }}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.post("/api/logistica/base")
def save_logistica_base(body: dict = Body(default={}), user: dict = Depends(require_admin_unlock)):
    """Publish the currently loaded workbook as THE Logística base. Admin only, second factor
    plus the import password. Body: { file_name, columns: [str], matrix: [[cell, …]], password }.

    REPLACES the stored base: this is "the base everyone opens on", not a version history, so
    the previous row is deleted in the same transaction as the insert."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    # Password first: nothing is validated, serialized or written until it checks out.
    _check_app_password(str(payload.get("password") or ""), user, context="Base de Logística")

    columns = payload.get("columns")
    matrix  = payload.get("matrix")
    if not isinstance(columns, list) or not columns or not all(isinstance(c, str) for c in columns):
        raise HTTPException(status_code=400, detail="Colunas da base inválidas.")
    if not isinstance(matrix, list):
        raise HTTPException(status_code=400, detail="Linhas da base inválidas.")
    if len(matrix) > _LOGISTICA_MAX_ROWS:
        raise HTTPException(status_code=413, detail="A base excede o limite de linhas suportado.")
    width = len(columns)
    if any((not isinstance(r, list)) or len(r) != width for r in matrix):
        raise HTTPException(status_code=400, detail="Linhas da base inconsistentes com as colunas.")

    file_name = str(payload.get("file_name") or "").strip()[:255]
    try:
        blob = json.dumps({"columns": columns, "matrix": matrix},
                          separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Conteúdo da base não pôde ser serializado.")
    if len(blob.encode("utf-8")) > _LOGISTICA_MAX_BYTES:
        raise HTTPException(status_code=413, detail="A base excede o tamanho máximo suportado.")

    try:
        _ensure_logistica_table()
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        with get_db() as db:
            db.query(LogisticaBase).delete()
            db.add(LogisticaBase(
                file_name=file_name, row_count=len(matrix),
                payload_json=blob, created_by=who,
            ))
            # SHARED state: this replaces what every user of the tab opens on, so it belongs in
            # the trail next to the other base imports.
            _log_security_event(
                db, actor=_username_of((user or {}).get("email", "")), target=None,
                event_type="logistica_base_save",
                detail=(f"Base de Logística publicada — '{file_name or 'sem nome'}' "
                        f"({len(matrix)} linha(s))."),
            )
        return {"ok": True, "file_name": file_name, "row_count": len(matrix)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Plano de Serviços - GCR: the published plan ────────────────────────────────────────────
# Security checklist re-applied for this surface (every new endpoint must):
#   • auth ......................................... require_auth (read) / require_editor_unlock
#   • role ......................................... Editor+ to publish; ANY authenticated to read
#   • second factor ................................ _check_app_password (the import password)
#   • error scrubbing .............................. _log_and_generic
#   • audit row .................................... _log_security_event
# No new outbound host, so the CSP is unchanged; no new secret is introduced.
#
# READ is open to every authenticated user, Readers included: the published plan IS the tab's
# content for everyone, exactly as the Logística base is. PUBLISH is Editor+ rather than Admin
# because this is planning work, not a base import — the people who build the plan are the ones
# who must be able to publish it.
#
# Sizing: a real GCR plan measured ~650 rows over 18 fiscal weeks for one workstation, i.e.
# ~1.9k rows for a full year and ~20k for a multi-área two-year horizon. The ceiling below is
# 50k — 2.5x the pessimistic case — and at that size the columnar payload is a few MB, which is
# one ordinary POST. A chunked upload pipeline was designed and dropped: it only begins to earn
# its complexity around 200k rows, which is 10x more than this data can produce.
_GCR_MAX_ROWS  = 50_000
_GCR_MAX_BYTES = 25 * 1024 * 1024


def _ensure_gcr_table() -> None:
    """Idempotently guarantee gcr_plan_snapshot exists — same reasoning as
    _ensure_logistica_table: startup create_all is best-effort, so a route defined at import
    time must not be the first thing to discover a missing relation."""
    try:
        GcrPlanSnapshot.__table__.create(bind=db_engine, checkfirst=True)
    except Exception as _e:  # never let a create race turn into a request failure
        logger.warning("[gcr] ensure table: %s", _e)


@app.get("/api/gcr/plan")
def gcr_plan(_user: dict = Depends(require_auth)):
    """The published GCR plan, or {"plan": null} when none was ever saved."""
    if not _DB_AVAILABLE:
        return {"plan": None}
    try:
        _ensure_gcr_table()
        with get_db() as db:
            row = db.query(GcrPlanSnapshot).order_by(GcrPlanSnapshot.id.desc()).first()
            if row is None:
                return {"plan": None}
            # Read every attribute INSIDE the session (expire_on_commit), like get_overrides.
            raw, settings, name = row.payload_json, row.settings_json, row.file_name
            count, when, who = row.row_count, row.created_at, row.created_by
            ver, p_from, p_to = row.version, row.period_from, row.period_to
        try:
            payload = json.loads(raw) if raw else {}
        except (json.JSONDecodeError, TypeError):
            # A corrupt blob is reported as "no plan", never as an empty one: serving zero rows
            # silently would read as a legitimately empty plan and invite publishing over it.
            logger.warning("[gcr] stored plan is not valid JSON — ignoring it")
            return {"plan": None}
        try:
            settings_obj = json.loads(settings) if settings else {}
        except (json.JSONDecodeError, TypeError):
            settings_obj = {}   # provenance only — never worth failing the read over
        return {"plan": {
            "file_name":   name or "",
            "row_count":   int(count or 0),
            "version":     int(ver or 1),
            "period_from": p_from or "",
            "period_to":   p_to or "",
            # `created_at` is a NAIVE column (DateTime, no timezone=True) written from an aware
            # UTC default, so the offset is dropped on the way in and `isoformat()` handed the
            # client "2026-08-19T14:30:00" — no Z, no offset. ECMAScript parses a date-TIME with
            # no offset as LOCAL time, so the browser read a UTC instant as if it were already
            # BRT and every published plan was stamped three hours into the future. `_iso` marks
            # it UTC, which is what it always was, and the client renders it in São Paulo.
            "saved_at":    _iso(when),
            "saved_by":    who,
            "settings":    settings_obj,
            "columns":     payload.get("columns") if isinstance(payload.get("columns"), list) else [],
            "matrix":      payload.get("matrix") if isinstance(payload.get("matrix"), list) else [],
            # The month LEVELS block (Consumo / Fila / WIP MIN / WIP MAX per item-month). Absent
            # from every plan published before it existed, and reported as empty rather than as
            # an error: those plans are still perfectly readable, they just have no queue series.
            "month_columns": payload.get("month_columns") if isinstance(payload.get("month_columns"), list) else [],
            "month_matrix":  payload.get("month_matrix") if isinstance(payload.get("month_matrix"), list) else [],
        }}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.post("/api/gcr/plan")
def save_gcr_plan(body: dict = Body(default={}), user: dict = Depends(require_auth)):
    """Publish the current GCR plan as THE plan. Editor+ AND the import password.

    THE GATE IS THE IMPORT LANE'S, deliberately — the same three checks `/api/db/import` and the
    other base imports apply, in the same order: identity (require_auth, which also enforces the
    hard ban), Editor+, then IMPORT_PASSWORD via `_check_app_password` (which fails closed in
    production and feeds the shared lockout/rate limit). It is NOT `require_editor_unlock`: that
    dependency adds the ADMIN-UNLOCK second factor ON TOP of the password, so publishing would
    have demanded two secrets where importing a base demands one. Publishing a plan is an import,
    and gating it harder than the imports it sits beside only teaches people that the unlock is
    arbitrary.

    Body: { file_name, columns: [str], matrix: [[cell, …]], settings?, period_from?, period_to?,
            base_version?, password }

    REPLACES the stored plan: this is "the plan everyone opens on", not a version history, so
    the previous row is deleted in the same transaction as the insert.

    CONCURRENCY. `base_version` is the version the client loaded. If the stored plan has moved
    since, the write is refused with 409 and the response names who published and when, so the
    client can offer reload-or-overwrite. Omitting `base_version` is only legitimate when there
    is no stored plan at all; against an existing one it is treated as a conflict rather than as
    consent, because two planners each holding hours for a different área would otherwise erase
    one another with no trace.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    # Authorization (Editor+) + second factor (import password, fails closed in prod) — the
    # identical pair `/api/db/import` applies, spelled out here rather than hidden in a
    # dependency so the two lanes can be read side by side.
    if _current_role(user) not in ("editor", "admin"):
        raise HTTPException(status_code=403, detail="Permissão de edição necessária.")
    # Password before anything else: nothing is validated, serialized or written until it checks out.
    _check_app_password(str(payload.get("password") or ""), user, context="Plano GCR")

    columns = payload.get("columns")
    matrix  = payload.get("matrix")
    if not isinstance(columns, list) or not columns or not all(isinstance(c, str) for c in columns):
        raise HTTPException(status_code=400, detail="Colunas do plano inválidas.")
    if not isinstance(matrix, list):
        raise HTTPException(status_code=400, detail="Linhas do plano inválidas.")
    if len(matrix) > _GCR_MAX_ROWS:
        raise HTTPException(
            status_code=413,
            detail="O plano excede o limite de linhas suportado — reduza o período publicado.")
    width = len(columns)
    if any((not isinstance(r, list)) or len(r) != width for r in matrix):
        raise HTTPException(status_code=400, detail="Linhas do plano inconsistentes com as colunas.")

    # The month LEVELS block, OPTIONAL. Validated exactly like the rows above when present —
    # a well-formed columnar block or nothing at all, never a half-parsed one. Omitting it is
    # legitimate (an older client, or a plan with no months), so absence is accepted silently;
    # a MALFORMED one is refused, because storing it would corrupt the queue series for every
    # reader of the plan rather than for the one client that sent it.
    m_columns = payload.get("month_columns")
    m_matrix  = payload.get("month_matrix")
    if m_columns is None and m_matrix is None:
        m_columns, m_matrix = [], []
    else:
        if not isinstance(m_columns, list) or not all(isinstance(c, str) for c in m_columns):
            raise HTTPException(status_code=400, detail="Colunas mensais do plano inválidas.")
        if not isinstance(m_matrix, list):
            raise HTTPException(status_code=400, detail="Linhas mensais do plano inválidas.")
        # One month row per item-month, so this block is always far smaller than the weeks it
        # explains; it shares the row ceiling rather than getting one of its own.
        if len(m_matrix) > _GCR_MAX_ROWS:
            raise HTTPException(
                status_code=413,
                detail="O plano excede o limite de linhas suportado — reduza o período publicado.")
        m_width = len(m_columns)
        if m_matrix and not m_width:
            raise HTTPException(status_code=400, detail="Colunas mensais do plano inválidas.")
        if any((not isinstance(r, list)) or len(r) != m_width for r in m_matrix):
            raise HTTPException(
                status_code=400, detail="Linhas mensais inconsistentes com as colunas mensais.")

    file_name = str(payload.get("file_name") or "").strip()[:255]
    p_from    = str(payload.get("period_from") or "").strip()[:7]
    p_to      = str(payload.get("period_to") or "").strip()[:7]
    try:
        blob = json.dumps({"columns": columns, "matrix": matrix,
                           "month_columns": m_columns, "month_matrix": m_matrix},
                          separators=(",", ":"), ensure_ascii=False, default=str)
        settings_raw = payload.get("settings")
        settings_blob = (json.dumps(settings_raw, separators=(",", ":"), ensure_ascii=False,
                                    default=str)
                         if isinstance(settings_raw, dict) else None)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Conteúdo do plano não pôde ser serializado.")
    if len(blob.encode("utf-8")) > _GCR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="O plano excede o tamanho máximo suportado.")

    base_version = payload.get("base_version")
    try:
        _ensure_gcr_table()
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        with get_db() as db:
            prev = db.query(GcrPlanSnapshot).order_by(GcrPlanSnapshot.id.desc()).first()
            if prev is not None:
                prev_ver, prev_by, prev_at = prev.version, prev.created_by, prev.created_at
                if base_version is None or int(base_version) != int(prev_ver or 1):
                    raise HTTPException(status_code=409, detail={
                        "message": "O plano foi publicado por outra pessoa enquanto este estava aberto.",
                        "version":  int(prev_ver or 1),
                        "saved_by": prev_by,
                        "saved_at": _iso(prev_at),   # UTC-marked — see the read endpoint
                    })
                next_ver = int(prev_ver or 1) + 1
            else:
                next_ver = 1
            db.query(GcrPlanSnapshot).delete()
            db.add(GcrPlanSnapshot(
                file_name=file_name, row_count=len(matrix),
                period_from=p_from, period_to=p_to,
                payload_json=blob, settings_json=settings_blob,
                version=next_ver, created_by=who,
            ))
            # SHARED state: this replaces what every user of the tab opens on, so it belongs in
            # the trail next to the other published bases.
            _log_security_event(
                db, actor=_username_of((user or {}).get("email", "")), target=None,
                event_type="gcr_plan_save",
                detail=(f"Plano GCR publicado — '{file_name or 'sem nome'}' "
                        f"({len(matrix)} linha(s), {p_from or '?'}..{p_to or '?'}, v{next_ver})."),
            )
        return {"ok": True, "file_name": file_name, "row_count": len(matrix), "version": next_ver}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Per-scenario working-Saturday set (Saturday RETENTION for saved optimizations) ─────────
# Lightweight companion to the loco overrides above, same editor + app-password lane, applied
# CLIENT-SIDE (flip date_info.is_weekend). NOT the global admin calendar_override.
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


@app.put("/api/gantt/saturday-workdays")
def put_saturday_workdays(body: dict = Body(default={}), user: dict = Depends(require_editor)):
    """Persist the working-Saturday set for ONE scenario. Editor/Admin only, same application password
    gate as the override save. Body: { dates: [ISO], password, scenario }. An empty list clears it."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    scenario_id = payload.get("scenario") if isinstance(payload.get("scenario"), str) else ""
    scenario_id = scenario_id or _BASE_SCENARIO
    _check_app_password(payload.get("password", ""), user, context="Salvar sábados trabalhados")
    dates = _parse_saturday_dates(payload.get("dates"))
    try:
        who = (user or {}).get("email") or (user or {}).get("sub") or None
        pj = json.dumps(dates, separators=(",", ":"), ensure_ascii=False)
        with get_db() as db:
            row = db.query(ScenarioSaturdayWorkday).filter(
                ScenarioSaturdayWorkday.scenario_id == scenario_id
            ).first()
            # Promoting/removing a working Saturday changes the schedule for EVERY user of the
            # scenario, so each of the three outcomes below is audited. Only a genuine change is
            # recorded — re-saving an identical set writes nothing.
            cenario = "cronograma base" if scenario_id == _BASE_SCENARIO else f"cenário '{scenario_id}'"
            if not dates:                                  # clearing the set
                if row is not None:
                    db.delete(row)
                    _log_security_event(
                        db, actor=who, target=None, event_type="saturday_change",
                        detail=f"{who} removeu todos os sábados trabalhados do {cenario}.",
                    )
                return {"ok": True, "cleared": True}
            if row is not None:
                if row.dates_json != pj:
                    row.dates_json = pj
                    row.updated_by = who
                    _log_security_event(
                        db, actor=who, target=None, event_type="saturday_change",
                        detail=f"{who} atualizou os sábados trabalhados do {cenario}: {len(dates)} data(s).",
                    )
            else:
                db.add(ScenarioSaturdayWorkday(scenario_id=scenario_id, dates_json=pj, updated_by=who))
                _log_security_event(
                    db, actor=who, target=None, event_type="saturday_change",
                    detail=f"{who} definiu {len(dates)} sábado(s) trabalhado(s) no {cenario}.",
                )
        return {"ok": True, "count": len(dates)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.post("/api/gantt/scenario")
async def gantt_scenario(
    request: Request,
    file: UploadFile = File(...),
    _user: dict = Depends(require_auth),
):
    """
    Builds Gantt data from an uploaded Schedule-MS Excel file.
    Uses DB for LocosRout (routing table). Does not modify the DB or cache.
    Also stores file bytes under a unique scenario_id for later export.

    Authorization: ANY authenticated role, Readers included — loading a scenario is a
    READ. The upload is parsed in memory and answered; it writes nothing to the DB and
    does not touch the shared gantt cache, so a Reader cannot alter what anyone else
    sees. The bytes are held only in the byte-bounded `_scenario_file_cache` to back a
    later export, and every export route independently demands Editor+ AND the app
    password — so reaching this endpoint grants a Reader no way to extract a file.
    """
    global _scenario_file_cache
    # This route is the widest of the four: it is the only upload open to Readers, so it is the
    # one an ordinary account could have used to exhaust the container. It was also the only one
    # with no filename check at all — the bytes went straight to the parser.
    _require_excel_upload(file)
    _reject_oversize_body(request, _UPLOAD_MAX_BYTES)
    # Read OUTSIDE the try: the blanket `except Exception` below would otherwise swallow the 413
    # and answer 500 "Erro interno", turning a clear "file too large" into an unexplained failure.
    file_bytes = await _read_upload_bounded(file)
    try:
        from gantt_builder import build_gantt_data_from_scenario_excel
        data = build_gantt_data_from_scenario_excel(file_bytes)
        # Store file bytes for export, keep cache bounded by total bytes
        scenario_id = str(uuid.uuid4())
        _store_scenario_file(scenario_id, file_bytes)
        data["scenario_id"] = scenario_id
        return data
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.post("/api/gantt/optimize-conflicts")
async def gantt_optimize_conflicts(
    _user: dict = Depends(require_editor),
):
    """
    Modo 1: Otimizar workstations conflitantes via Gurobi.
    Detecta conflitos no schedule atual, resolve via MIP minimizando
    o total de Protection Days consumidos, e retorna o GanttData otimizado.
    """
    try:
        from gantt_builder import _load_source_data, _assemble_gantt_output, _get_holidays_for_dates
        from services.schedule_conflict_optimizer import optimize_conflicts, apply_shifts_to_ms

        ms_by_wo, rt_rows = _load_source_data()
        if not ms_by_wo:
            raise ValueError("Sem dados de schedule disponíveis.")

        # Build holidays from all start dates
        all_starts = [t["start_ms"] for tasks in ms_by_wo.values() for t in tasks if t.get("start_ms")]
        holidays = _get_holidays_for_dates(all_starts) if all_starts else frozenset()

        # Conflicts before optimization
        from services.schedule_conflict_optimizer import _compute_loco_ws_days, _detect_conflicts, _get_protection_days
        loco_ws_before = _compute_loco_ws_days(ms_by_wo, rt_rows, {}, holidays)
        conflicts_before = _detect_conflicts(loco_ws_before)
        pd_map = _get_protection_days(ms_by_wo, holidays)
        pd_available = {wo: v for wo, v in pd_map.items() if v > 0}
        print(f"[optimize] Conflitos ANTES: {len(conflicts_before)} | LOCOs: {len(ms_by_wo)} | PD disponíveis: {pd_available}")

        # Run optimizer
        shifts = optimize_conflicts(ms_by_wo, rt_rows)

        shifted_wos = {wo: s for wo, s in shifts.items() if s > 0}
        print(f"[optimize] Shifts aplicados ({len(shifted_wos)} LOCOs): {shifted_wos}")

        # Conflicts after optimization
        loco_ws_after = _compute_loco_ws_days(ms_by_wo, rt_rows, shifts, holidays)
        conflicts_after = _detect_conflicts(loco_ws_after)
        print(f"[optimize] Conflitos DEPOIS: {len(conflicts_after)} (antes: {len(conflicts_before)})")

        # WS affected
        ws_affected: set = set()
        for wo1, tn1, wo2, tn2, ws_n in conflicts_before:
            ws_affected.add(ws_n)
        pd_consumed = {wo: s for wo, s in shifts.items() if s > 0}
        print(f"[optimize] WS afetadas: {sorted(ws_affected)} | PD consumidos: {pd_consumed} | Total dias: {sum(shifts.values())}")

        # Apply shifts
        shifted_ms = apply_shifts_to_ms(ms_by_wo, shifts, holidays)

        # Rebuild gantt data with shifted schedule
        data = _assemble_gantt_output(shifted_ms, rt_rows)

        print(f"[optimize] Resposta: {len(data['groups'])} grupos, {len(data['date_info'])} datas")

        # Attach shift metadata so frontend can display summary
        data["_optimization"] = {
            "mode": 1,
            "shifts": shifted_wos,
            "total_shifted_locos": len(shifted_wos),
            "total_shift_days": sum(shifts.values()),
            "conflicts_before": len(conflicts_before),
            "conflicts_after": len(conflicts_after),
            "ws_affected": sorted(ws_affected),
        }

        return data
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "gantt_optimize"))


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


class _SwapWsBody(BaseModel):
    """Manual WS40↔WS50 execution-order swap for one ES44 LOCO. The client posts the LOCO's
    CURRENT WS40/WS50 day-cells (ISO yyyy-mm-dd) exactly as displayed; the server reuses the
    conflict optimizer's OWN eligibility test (_is_es44) and reorder (_swap_ws_layout) — there
    is no second swap implementation. Stateless: nothing is read from or written to the DB; the
    reordered day-sets are returned for the client to store as an ordinary visual override."""
    wo:         str
    task_name:  str = ""
    linha:      str = ""
    ws40_days:  list[str] = []
    ws50_days:  list[str] = []


@app.post("/api/gantt/swap-ws")
def gantt_swap_ws(body: _SwapWsBody, _user: dict = Depends(require_editor)):
    """Compute the WS40↔WS50 execution-order swap for one eligible ES44 LOCO, reusing the
    conflict optimizer's EXACT rules (_is_es44 + _swap_ws_layout). Returns {ok:true, ws40_days,
    ws50_days} with the reordered day-sets, or {ok:false, reason} when the LOCO is not ES44 or
    the two WS are genuinely interleaved (no clean reorder). Simulation only — the swap is
    persisted through the SAME Editor+ override path as every other manual schedule change."""
    from datetime import date as _date
    from gantt_builder import _get_holidays_for_dates
    from services.schedule_conflict_optimizer import (
        _is_es44, _swap_ws_layout, _add_business_days, _add_sat_business_days,
    )

    # Eligibility 1 — model must be ES44 (the same tolerant detector the optimizer uses).
    if not _is_es44(body.wo, body.task_name, body.linha):
        return {"ok": False, "reason": "not_es44"}

    ws40 = {str(x) for x in body.ws40_days if x}
    ws50 = {str(x) for x in body.ws50_days if x}
    if not ws40 or not ws50:
        return {"ok": False, "reason": "missing_ws"}

    # Holidays across the combined block's date range so the reorder's business-day walk
    # reproduces the LOCO's actual day footprint. If any occupied day is a Saturday the block
    # uses working Saturdays (WS40/WS50 only), so advance Mon–Sat; otherwise Mon–Fri.
    try:
        union_dates = sorted({_date.fromisoformat(str(x)) for x in (ws40 | ws50)})
    except (ValueError, TypeError):
        return {"ok": False, "reason": "bad_dates"}
    holidays = _get_holidays_for_dates(union_dates) if union_dates else frozenset()
    uses_sat = any(d.weekday() == 5 for d in union_dates)
    add_days = _add_sat_business_days if uses_sat else _add_business_days

    swapped = _swap_ws_layout(ws40, ws50, holidays, add_days)
    if swapped is None:
        return {"ok": False, "reason": "interleaved"}

    new_ws40, new_ws50 = swapped
    return {"ok": True, "ws40_days": sorted(new_ws40), "ws50_days": sorted(new_ws50)}


class _OptStreamBody(BaseModel):
    line_filter: list[str] | None = None  # WO keys currently loaded (coarse filter)
    loco_filter: list[str] | None = None  # exact LOCO keys "wo||task_name" visible
    date_from:   str | None = None        # visible window start, ISO yyyy-mm-dd
    date_to:     str | None = None        # visible window end, ISO yyyy-mm-dd
    today:       str | None = None        # client's "Today" (ISO yyyy-mm-dd); WS before it are immutable
    strategy:    str | None = None        # "shift_full" | "shift_conflict_only" (ES44 WS40↔WS50 swap auto in both)
    use_saturdays: bool = False           # allow WS40/WS50 of conflict LOCOs on Saturdays
    allow_overlap: bool = False           # "Permitir regras de sobreposição" — boundary/half-day share not a conflict
    loco_edits: list[_LocoEdit] = []      # manual LOCO edits (session-only) — optimizer runs on the EDITED schedule


@app.post("/api/gantt/optimize-conflicts/stream")
async def gantt_optimize_conflicts_stream(
    body: _OptStreamBody = _OptStreamBody(),
    _user: dict = Depends(require_editor),
):
    """
    Modo 1 — streaming SSE with real-time solver logs.
    body.line_filter: optional list of wo keys to restrict optimization scope
      (must match exactly what the frontend has loaded, to avoid phantom conflicts).

    Event shapes:
      {"type":"log",    "msg": str, "progress": int, "message": str}
      {"type":"result", "data": GanttData, "meta": {...}}
      {"type":"error",  "msg": str}
    Log lines follow SolverLogModal tag conventions:
      [SETUP]/[MODEL] → cyan  |  [PHASE N] → yellow  |  [DONE] → green  |  [RESULTS] → emerald
    """
    from fastapi.responses import StreamingResponse as _SR
    import json as _json
    import asyncio as _asyncio
    import queue as _queue
    import time as _time

    line_filter: set[str] | None = set(body.line_filter) if body.line_filter else None
    loco_filter: set[str] | None = set(body.loco_filter) if body.loco_filter else None

    def _clamp_iso(s: str | None) -> str | None:
        """Normalize a yyyy-mm-dd window bound; clamp an out-of-range day (e.g. the
        frontend's '2027-06-31') to the month's real last day instead of trusting a
        lexical compare on an impossible date."""
        if not s:
            return None
        try:
            import calendar as _cal
            from datetime import date as _date
            y, mth, day = (int(p) for p in str(s)[:10].split("-"))
            last = _cal.monthrange(y, mth)[1]
            return _date(y, mth, min(day, last)).isoformat()
        except (ValueError, TypeError):
            return s  # leave untouched if unparseable; downstream compare is lexical

    scope_from:  str | None = _clamp_iso(body.date_from or None)
    scope_to:    str | None = _clamp_iso(body.date_to or None)
    # Client-provided "Today" boundary (matches the Schedule's Today marker). Workstations
    # plotted before this date are immutable. Fall back to the server's local date when the
    # client omits it, so the historical-preservation rule always holds.
    scope_today: str | None = _clamp_iso(body.today or None)
    if not scope_today:
        from datetime import date as _date_today
        scope_today = _date_today.today().isoformat()
    # Retired 'es44_swap' card → partial strategy (the WS40↔WS50 swap is now an automatic
    # candidate move in every strategy, not a dedicated mode).
    strategy:    str = "shift_conflict_only" if body.strategy == "es44_swap" else (
        body.strategy if body.strategy in ("shift_full", "shift_conflict_only") else "shift_full"
    )
    use_saturdays: bool = bool(body.use_saturdays)
    allow_overlap: bool = bool(body.allow_overlap)

    async def _generate():
        try:
            from gantt_builder import _load_source_data, _assemble_gantt_output, _get_holidays_for_dates
            from services.schedule_conflict_optimizer import (
                optimize_conflicts_ex, apply_shifts_to_ms, build_shift_report,
                _compute_loco_ws_days, _detect_conflicts, _get_protection_days,
                _find_clusters, _scope_ws_days, _GUROBI_AVAILABLE, TARGET_WS,
            )

            SOLVE_TIME_LIMIT = 60.0

            def _evt(obj: dict) -> str:
                return f"data: {_json.dumps(obj, ensure_ascii=False)}\n\n"

            def _log(msg: str, progress: int = 0, message: str = "") -> str:
                return _evt({"type": "log", "msg": msg, "progress": progress, "message": message or msg})

            # ── Phase 1: Load & filter ──────────────────────────────────────────
            yield _log("[PHASE 1] Carregando dados do schedule...", 5, "Carregando schedule...")

            ms_by_wo_full, rt_rows = _load_source_data()
            if not ms_by_wo_full:
                yield _evt({"type": "error", "msg": "Sem dados de schedule disponíveis."})
                return

            # Apply the user's manual LOCO edits FIRST so the optimizer treats the edited
            # schedule as the new baseline (optimizes the edited dates/takt, not the raw DB).
            if body.loco_edits:
                _full_starts = [t["start_ms"] for tasks in ms_by_wo_full.values() for t in tasks if t.get("start_ms")]
                _edit_holidays = _get_holidays_for_dates(_full_starts) if _full_starts else frozenset()
                _applied = _apply_loco_edits(ms_by_wo_full, body.loco_edits, _edit_holidays)
                yield _log(f"  Edições manuais aplicadas: {len(_applied)} LOCO(s)", 6)

            if line_filter:
                ms_by_wo = {wo: v for wo, v in ms_by_wo_full.items() if wo in line_filter}
                yield _log(f"  Filtro ativo: {len(ms_by_wo)}/{len(ms_by_wo_full)} Modelos no Schedule", 8)
            else:
                ms_by_wo = ms_by_wo_full

            if not ms_by_wo:
                yield _evt({"type": "error", "msg": "Nenhuma LOCO ativa no Schedule atual."})
                return

            all_starts = [t["start_ms"] for tasks in ms_by_wo.values() for t in tasks if t.get("start_ms")]
            holidays = _get_holidays_for_dates(all_starts) if all_starts else frozenset()

            yield _log(f"[PHASE 1] OPTIMAL  obj=0.0000  gap=0.0  t=0.0s", 10)
            if not _GUROBI_AVAILABLE:
                yield _evt({"type": "error", "msg": "Gurobi não disponível. Instale gurobipy e uma licença válida."})
                return
            solver_label = "Gurobi"
            # Header counts MUST reflect the ACTUAL optimization scope — the filtered,
            # eligible data sent to the solver — not the raw dataset loaded into memory.
            # The real scope is the exact visible LOCO keys (loco_filter, "wo||task_name");
            # Models in scope = distinct WOs among those LOCOs. The date window is applied
            # in Phase 2 (conflict detection) and reported there. When no loco_filter is
            # provided (whole schedule), the loaded set IS the scope.
            scope_loco_keys: set[tuple[str, str]] = set()
            if loco_filter:
                for lk in loco_filter:
                    wo, _, tn = lk.partition("||")
                    if wo in ms_by_wo:        # only LOCOs actually present after load/filter
                        scope_loco_keys.add((wo, tn))
            else:
                scope_loco_keys = {
                    (wo, t.get("task_name"))
                    for wo, tasks in ms_by_wo.items()
                    for t in tasks if t.get("task_name")
                }
            n_models = len({wo for wo, _ in scope_loco_keys})
            n_locos = len(scope_loco_keys)
            yield _log(
                f"[SETUP] Modelos={n_models}  LOCOs={n_locos}  WS_alvo={','.join(sorted(TARGET_WS))}"
                f"  Solver={solver_label}  Limite={int(SOLVE_TIME_LIMIT)}s",
                10, "Setup do modelo...",
            )
            _strat_label = (
                "Deslocar Início + Cronograma Completo" if strategy == "shift_full"
                else "Deslocar Apenas Workstations em Conflito"
            )
            yield _log(
                f"[SETUP] Estratégia={_strat_label}"
                f"  Sábados disponíveis={'Sim' if use_saturdays else 'Não'}"
                f"  Regras de sobreposição={'Sim' if allow_overlap else 'Não'}",
                10,
            )

            # ── Phase 2: Detect conflicts ───────────────────────────────────────
            yield _log("[PHASE 2] Detectando conflitos nas workstations alvo...", 15, "Detectando conflitos...")

            loco_type_map: dict = {}
            loco_ws_before_full = _compute_loco_ws_days(ms_by_wo, rt_rows, {}, holidays, type_out=loco_type_map)
            # Scope to the visible window + visible LOCOs so logs match the Schedule view.
            loco_ws_before = _scope_ws_days(loco_ws_before_full, loco_filter, scope_from, scope_to)
            conflicts_before = _detect_conflicts(loco_ws_before, allow_overlap, loco_type_map)
            # PD per LOCO (from full map — PD duration is intrinsic, not window-clipped)
            pd_map = _get_protection_days(ms_by_wo, holidays, loco_ws_days=loco_ws_before_full)
            pd_available = {k: v for k, v in pd_map.items() if v > 0}
            if loco_filter or scope_from or scope_to:
                # True in-scope counts AFTER applying the visible window: only LOCOs that
                # actually have target-WS days inside [scope_from, scope_to]. This is the
                # real problem size the solver receives, so the header/scope stats match it.
                scoped_keys = set(loco_ws_before.keys())   # "wo||task_name" with days in window
                scoped_models = len({k.partition('||')[0] for k in scoped_keys})
                yield _log(
                    f"  Escopo: {len(scoped_keys)} LOCO(s) / {scoped_models} Modelo(s) no escopo"
                    f"  janela={scope_from or '−inf'}..{scope_to or '+inf'}", 15
                )

            def _lk(wo: str, tn: str) -> str:
                return f"{wo}||{tn}"

            clusters_list = _find_clusters(conflicts_before)
            ws_in_conflict: set[str] = {ws_n for _, _, _, _, ws_n in conflicts_before}

            # Eligible LOCOs (have PD) and unique conflict pairs
            eligible_locos: set[str] = set()
            for wo1, tn1, wo2, tn2, _ in conflicts_before:
                if pd_available.get(_lk(wo1, tn1), 0) > 0: eligible_locos.add(_lk(wo1, tn1))
                if pd_available.get(_lk(wo2, tn2), 0) > 0: eligible_locos.add(_lk(wo2, tn2))
            pair_set: set[tuple[str, str, str]] = set()
            for wo1, tn1, wo2, tn2, ws_n in conflicts_before:
                k1, k2 = _lk(wo1, tn1), _lk(wo2, tn2)
                if k1 in eligible_locos or k2 in eligible_locos:
                    a, b = (k1, k2) if k1 < k2 else (k2, k1)
                    pair_set.add((a, b, ws_n))

            yield _log(f"[PHASE 2] OPTIMAL  obj=0.0000  gap=0.0  t=0.0s", 25, "Conflitos detectados...")
            yield _log(
                f"[MODEL] Conflitos: {len(conflicts_before)}  Clusters: {len(clusters_list)}"
                f"  WS: {','.join(sorted(ws_in_conflict)) or 'nenhuma'}", 25
            )
            yield _log(
                f"[MODEL] Total — Variáveis: {len(eligible_locos)+len(pair_set)}"
                f"  Restrições: {len(pair_set)*2}", 25
            )
            unresolvable = sum(
                1 for wo1, tn1, wo2, tn2, _ in conflicts_before
                if pd_available.get(_lk(wo1, tn1), 0) == 0 and pd_available.get(_lk(wo2, tn2), 0) == 0
            )
            yield _log(f"[MODEL] LOCOs elegíveis: {len(eligible_locos)}  PD disp.: {len(pd_available)} LOCOs", 25)
            if unresolvable:
                yield _log(f"[MODEL] Conflitos irresolvíveis: {unresolvable} (ambas LOCOs sem PD disponível)", 25)

            if not conflicts_before:
                yield _log("[DONE] Sem conflitos — schedule já está otimizado.", 100, "Sem conflitos!")
                data = _assemble_gantt_output(ms_by_wo, rt_rows)
                data["_optimization"] = {
                    "mode": 1, "shifts": {}, "total_shifted_locos": 0,
                    "total_shift_days": 0, "conflicts_before": 0, "conflicts_after": 0,
                    "ws_affected": [], "shift_report": [],
                }
                yield _evt({"type": "result", "data": data, "meta": data["_optimization"]})
                return

            # Per-LOCO summary: conflict count and PD (show serial = task_name)
            loco_conflict_count: dict[str, int] = {}
            for wo1, tn1, wo2, tn2, _ in conflicts_before:
                k1, k2 = _lk(wo1, tn1), _lk(wo2, tn2)
                loco_conflict_count[k1] = loco_conflict_count.get(k1, 0) + 1
                loco_conflict_count[k2] = loco_conflict_count.get(k2, 0) + 1
            for _k in sorted(loco_conflict_count, key=lambda k: -loco_conflict_count[k]):
                _tn = _k.split("||", 1)[1] if "||" in _k else _k
                yield _log(f"  {_tn}  conflitos={loco_conflict_count[_k]}  PD={pd_map.get(_k, 0)}d", 25)

            # ── Phase 3: Solve (Gurobi in thread + live log queue) ─────────────
            yield _log(f"[PHASE 3] Gurobi MIP ({int(SOLVE_TIME_LIMIT)}s)...", 30, "Gurobi em execução...")

            log_q: _queue.Queue = _queue.Queue()
            _t_solve = _time.time()

            def _enqueue(msg: str):
                log_q.put(msg)

            # Saturdays can only be physically honoured by the PARTIAL rebuild (it edits
            # record days directly). The FULL rebuild goes through _build_records, which
            # is Mon–Fri and would flatten Saturdays back out — so the solver must not
            # optimize a Saturday layout it can't reproduce. Gate Saturdays to partial.
            _is_partial = strategy == "shift_conflict_only"
            solver_use_saturdays = use_saturdays and _is_partial
            if use_saturdays and not solver_use_saturdays:
                yield _log(
                    "[SETUP] Sábados ignorados: só a estratégia parcial (Deslocar Apenas WS "
                    "em Conflito) suporta sábados (reconstrução completa é Seg–Sex).", 10
                )

            async def _run():
                return await _asyncio.to_thread(
                    optimize_conflicts_ex, ms_by_wo, rt_rows, _enqueue, SOLVE_TIME_LIMIT,
                    loco_filter, scope_from, scope_to, strategy, solver_use_saturdays,
                    allow_overlap, scope_today,
                )

            solver_task = _asyncio.ensure_future(_run())

            progress_solve = 30
            while not solver_task.done():
                while not log_q.empty():
                    msg = log_q.get_nowait()
                    elapsed_s = _time.time() - _t_solve
                    # progress 30→80 over the time budget
                    frac = min(1.0, elapsed_s / SOLVE_TIME_LIMIT)
                    progress_solve = int(30 + frac * 50)
                    yield _log(msg, progress_solve, f"Otimizando — {elapsed_s:.0f}s")
                await _asyncio.sleep(0.05)

            while not log_q.empty():
                msg = log_q.get_nowait()
                yield _log(msg, 80, "Solver concluído...")

            shifts, sat_shift, swap_flags = await solver_task
            elapsed_solve = _time.time() - _t_solve
            shifted_wos = {wo: s for wo, s in shifts.items() if s > 0}

            yield _log(
                f"[PHASE 3] OPTIMAL  obj={sum(shifted_wos.values()):.1f}"
                f"  gap=0.0  t={elapsed_solve:.2f}s", 80, "Solver concluído..."
            )

            # ── Phase 4: Build FINAL records, then verify on them ───────────────
            # CRITICAL: verification must measure the EXACT schedule the user sees, and
            # the shift advance must use the SAME calendar the solver modelled. With
            # Saturdays on, the solver advances Mon–Sat (_advance_iso_days_sat); the
            # rebuild now does too (apply_shifts_* with use_saturdays), so the rebuilt
            # occupancy equals what the solver optimized and the proven conflict count
            # actually materializes. (Previously the rebuild advanced Mon–Fri then ran a
            # separate Saturday-relocation pass → a DIFFERENT day-set, so slack=13 became
            # ~37 in reality.) We build final records first and detect conflicts on them.
            yield _log("[PHASE 4] Verificando conflitos residuais...", 82, "Verificando...")
            from gantt_builder import _build_records as _brecs
            from services.schedule_conflict_optimizer import (
                detect_conflicts_from_records, apply_shifts_conflict_only_records,
                apply_es44_swap_records, sanitize_saturday_occupancy,
            )

            # The shift advance now uses the SAME calendar the solver modelled (Mon–Sat
            # when use_saturdays), so the rebuilt occupancy equals the solver's — no
            # separate Saturday-relocation pass is needed (that pass used a DIFFERENT
            # relocation rule and re-introduced the slack≠reality divergence).
            _t_v = _time.time()
            if _is_partial:
                # Partial shift: rebuild from the ORIGINAL ms_by_wo (predecessors keep
                # their dates), then move only each shifted LOCO's WS40/WS50 + successors,
                # on the solver's calendar. swap_flags also exchanges WS40↔WS50 order for
                # the eligible ES44 LOCOs the solver chose (swap precedes the shift here).
                shifted_ms = ms_by_wo
                eff_shift = {}
                base_records = apply_shifts_conflict_only_records(
                    _brecs(ms_by_wo, rt_rows), shifts, holidays, _enqueue,
                    solver_use_saturdays, swap_flags, eff_shift_out=eff_shift,
                )
                while not log_q.empty():
                    yield _log(log_q.get_nowait(), 83, "Deslocamento parcial...")
            else:
                # Full shift: advance each shifted LOCO's start_ms; rebuild downstream
                # (Mon–Fri rebuild can't honor Saturdays, so full-shift runs Sat OFF).
                # No eff_shift override — Sat OFF means weekday delay == d already.
                eff_shift = None
                shifted_ms = apply_shifts_to_ms(ms_by_wo, shifts, holidays)
                base_records = _brecs(shifted_ms, rt_rows)
                # ES44 WS40↔WS50 swap is also available in the full strategy: apply the
                # solver's chosen swaps to the rebuilt records (in place, within each
                # LOCO's WS40..WS50 span — successors anchored). Mon–Fri here (full = Sat OFF).
                base_records = apply_es44_swap_records(
                    base_records, swap_flags, holidays, _enqueue, solver_use_saturdays
                )
                while not log_q.empty():
                    yield _log(log_q.get_nowait(), 83, "Troca WS40↔WS50...")
            # Final Saturday-occupancy validation on the EXACT schedule the user will see:
            #   - only WS40/WS50 may occupy a Saturday (any other WS cell is pushed to the
            #     next weekday);
            #   - a Saturday immediately after a holiday is unavailable for ANY WS.
            # No-op when the upstream advance already satisfies the rules (so it never adds
            # delay on its own — it only relocates cells that already violate an invariant).
            base_records = sanitize_saturday_occupancy(base_records, holidays, _enqueue)
            while not log_q.empty():
                yield _log(log_q.get_nowait(), 84, "Validando sábados...")
            final_records = base_records
            conflicts_after = detect_conflicts_from_records(
                base_records, loco_filter, scope_from, scope_to, allow_overlap
            )
            resolved = len(conflicts_before) - len(conflicts_after)
            ws_affected: set[str] = {ws_n for _, _, _, _, ws_n in conflicts_before}
            total_pd = sum(shifted_wos.values())

            yield _log(f"[PHASE 4] OPTIMAL  obj=0.0000  gap=0.0  t={_time.time()-_t_v:.2f}s", 85)
            yield _log(
                f"[RESULTS] Conflitos: {len(conflicts_before)} → {len(conflicts_after)}"
                f"  ({resolved:+d})  WS: {', '.join(sorted(ws_affected))}  PD: {total_pd}d", 85
            )

            # ── Phase 4b: Per-LOCO shift report ────────────────────────────────
            shift_report = build_shift_report(
                ms_by_wo, shifts, pd_map, conflicts_before, conflicts_after, holidays,
                solver_use_saturdays, eff_shift=eff_shift,
            )
            if shift_report:
                yield _log("[RESULTS] LOCOs deslocadas:", 85)
                for r in shift_report:
                    orig = r["orig_start"][:10] if r["orig_start"] else "?"
                    opt  = r["opt_start"][:10]  if r["opt_start"]  else "?"
                    label = r["loco"] or r["wo"]
                    yield _log(
                        f"  {label}: {orig} → {opt}  +{r['shift_days']}d"
                        f"  PD {r['pd_used']}/{r['pd_total']}  conflitos: {r['conf_before']}→{r['conf_after']}",
                        85,
                    )

            # ── Phase 5: Rebuild Gantt ──────────────────────────────────────────
            yield _log("[PHASE 5] Reconstruindo Gantt com schedule otimizado...", 88, "Reconstruindo Gantt...")

            _t_build = _time.time()
            # Reuse the SAME records verified in Phase 4 — the Gantt the user sees and
            # the conflicts_after count are now guaranteed to describe one schedule.
            data = _assemble_gantt_output(shifted_ms, rt_rows, records=final_records)
            elapsed_build = _time.time() - _t_build

            yield _log(
                f"[PHASE 5] OPTIMAL  obj=0.0000  gap=0.0  t={elapsed_build:.2f}s", 95,
                "Gantt reconstruído...",
            )
            yield _log(f"[RESULTS] Gantt: {len(data['groups'])} grupos  {len(data['date_info'])} datas", 95)

            # LOCOs whose WS40↔WS50 order the solver actually swapped (any strategy).
            # Keyed by "wo||task_name" so the frontend can flag the MODELO column.
            swapped_locos = sorted(lk for lk, v in (swap_flags or {}).items() if v)

            meta = {
                "mode": 1,
                "shifts": shifted_wos,
                "total_shifted_locos": len(shifted_wos),
                "total_shift_days": total_pd,
                "conflicts_before": len(conflicts_before),
                "conflicts_after": len(conflicts_after),
                "ws_affected": sorted(ws_affected),
                "shift_report": shift_report,
                "swapped_locos": swapped_locos,
                "allow_overlap": allow_overlap,
            }
            data["_optimization"] = meta

            yield _log(
                f"[DONE] Otimização concluída — {len(shifted_wos)} LOCOs deslocadas,"
                f" {resolved}/{len(conflicts_before)} conflito(s) resolvido(s).", 100, "Concluído!"
            )
            yield _evt({"type": "result", "data": data, "meta": meta})

        except Exception as exc:
            logger.exception("[gantt_optimize_stream] failed")
            yield _evt({"type": "error", "msg": f"{type(exc).__name__}: {exc}"})

    return _SR(_generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/gantt/export")
def gantt_export(
    date_from: str | None = Query(default=None, alias="from"),
    date_to: str | None = Query(default=None, alias="to"),
    lines: str | None = Query(default=None),
    _user: dict = Depends(require_editor_unlock),
):
    """
    Gera e retorna o arquivo Excel do Gantt para download.
    Mesma lógica do gantt_special_line.py mas sem salvar em disco.
    """
    try:
        from gantt_builder import build_gantt_excel
        line_filter = [part.strip() for part in lines.split(",") if part.strip()] if lines else None
        content = build_gantt_excel(date_from=date_from, date_to=date_to, lines=line_filter)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))

    from fastapi.responses import Response
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="gantt_output.xlsx"'},
    )


@app.get("/api/gantt/export-scenario/{scenario_id}")
def gantt_export_scenario(
    scenario_id: str,
    date_from: str | None = Query(default=None, alias="from"),
    date_to: str | None = Query(default=None, alias="to"),
    lines: str | None = Query(default=None),
    _user: dict = Depends(require_editor_unlock),
):
    """
    Gera e retorna o Excel do Gantt para um cenário importado, usando os bytes
    do arquivo original armazenados em memória após o POST /api/gantt/scenario.
    """
    if scenario_id not in _scenario_file_cache:
        raise HTTPException(
            status_code=404,
            detail="Cenário não encontrado. O servidor pode ter sido reiniciado. Re-importe o arquivo.",
        )
    try:
        from gantt_builder import build_gantt_excel_from_scenario_bytes
        line_filter = [p.strip() for p in lines.split(",") if p.strip()] if lines else None
        content = build_gantt_excel_from_scenario_bytes(
            _scenario_file_cache[scenario_id],
            date_from=date_from, date_to=date_to, lines=line_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))

    from fastapi.responses import Response
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="gantt_cenario.xlsx"'},
    )


@app.post("/api/gantt/export-view")
def gantt_export_view(
    payload: dict = Body(...),
    _user: dict = Depends(require_editor_unlock),
):
    """
    Render the Schedule Excel from the EXACT data currently displayed on the client
    (effectiveData) honoring the active view mode (FULL/WORK/LOCO). This makes the
    export match the screen 1:1 — including any active optimization/scenario shifts
    and Saturday allocations — while excluding all UI-only overlays (icons, hatching,
    Saturday red-X, MODELO annotations). Payload: { groups, date_info, mode, colorByWs }.
    """
    try:
        from gantt_builder import build_gantt_excel_from_view
        groups = payload.get("groups") or []
        date_info = payload.get("date_info") or []
        mode = str(payload.get("mode") or "full")
        color_by_ws = bool(payload.get("colorByWs", True))
        content = build_gantt_excel_from_view(
            groups=groups, date_info=date_info, mode=mode, color_by_ws=color_by_ws,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))

    from fastapi.responses import Response
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="gantt_output.xlsx"'},
    )


@app.get("/api/db/items")
def db_items(
    ano:  int | None = Query(default=None),
    mes:  int | None = Query(default=None),
    fw:   str | None = Query(default=None, description="FW único (semanal)"),
    fws:  str | None = Query(default=None, description="FWs separadas por vírgula (mensal)"),
    mode: str        = Query(default="mensal", description="semanal | mensal"),
    _user: dict = Depends(require_auth),
):
    """
    Retorna a lista de itens da tabela monthly_demand para a tela de importação.
    Equivalente ao /api/excel-items mas lendo do banco de dados.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")

    try:
        with get_db() as db:
            q = db.query(MonthlyDemand).filter(MonthlyDemand.ver == get_active_ver(db, "monthly_demand"))
            if ano is not None:
                q = q.filter(MonthlyDemand.ano == ano)
            if mes is not None:
                q = q.filter(MonthlyDemand.mes == mes)
            if fw is not None and mode == "semanal":
                q = q.filter(MonthlyDemand.fw == str(fw).strip())
            elif fws is not None and mode == "mensal":
                fw_list = [f.strip() for f in fws.split(",") if f.strip()]
                if fw_list:
                    q = q.filter(MonthlyDemand.fw.in_(fw_list))

            rows = q.all()

        # Build filter options
        anos_set:  set[int] = set()
        meses_set: set[int] = set()
        fws_set:   set[str] = set()
        fams_set:  set[str] = set()
        cls_set:   set[str] = set()
        mes_fw_map: dict[int, set[str]] = {}

        # Full scan for filter options (without fw/mes filter)
        with get_db() as db:
            _filt_ver = get_active_ver(db, "monthly_demand")
            all_rows = db.query(
                MonthlyDemand.ano, MonthlyDemand.mes, MonthlyDemand.fw,
                MonthlyDemand.familia, MonthlyDemand.cliente,
            ).filter(
                MonthlyDemand.ver == _filt_ver,
                MonthlyDemand.ano == ano if ano else MonthlyDemand.ano != None,  # noqa: E711
            ).all()

        for r in all_rows:
            if r.ano:  anos_set.add(int(r.ano))
            if r.mes:  meses_set.add(int(r.mes))
            if r.fw:   fws_set.add(str(r.fw))
            if r.familia: fams_set.add(r.familia)
            if r.cliente: cls_set.add(r.cliente)
            if r.mes and r.fw:
                mes_fw_map.setdefault(int(r.mes), set()).add(str(r.fw))

        # Build unique items (aggregate by item code)
        items_map: dict[str, dict] = {}
        tipo_fw_map: dict[str, set[str]] = {}
        for row in rows:
            key = row.item
            if key not in items_map:
                items_map[key] = {
                    "id":        key,
                    "item":      row.item,
                    "descricao": row.descricao or "",
                    "familia":   row.familia   or "",
                    "area":      row.area      or "",
                    "cliente":   row.cliente   or "",
                    "tipo":      row.tipo      or "",
                    "nivel":     row.nivel     or "",
                    "wsn":       row.wsn       or "",
                    "qtde_fw":   row.qtde_fw   or 0.0,
                }
            tipo_fw_map.setdefault(key, set())
            if row.tipo_fw:
                tipo_fw_map[key].add(row.tipo_fw.strip().upper())

        items_out = []
        for key, item in items_map.items():
            item["tipo_fw"] = sorted(tipo_fw_map.get(key, set()))
            items_out.append(item)

        items_out.sort(key=lambda x: x["item"])

        return {
            "status": "ok",
            "items": items_out,
            "filter_options": {
                "anos":     sorted(anos_set, reverse=True),
                "meses":    sorted(meses_set),
                "fws":      sorted(fws_set, key=lambda x: int(x) if x.isdigit() else float("inf")),
                "familias": sorted(fams_set),
                "clientes": sorted(cls_set),
            },
            "mes_fw_map": {
                k: sorted(v, key=lambda x: int(x) if x.isdigit() else float("inf"))
                for k, v in mes_fw_map.items()
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


@app.get("/api/demand")
def get_demand(
    ano: int = Query(..., description="Ano"),
    mes: int = Query(..., description="Mês (1-12)"),
    _user: dict = Depends(require_auth),
):
    """
    Retorna todos os registros de demanda para o ano/mês informados.
    Útil para consulta direta de dados de demanda.
    """
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        with get_db() as db:
            rows = db.query(MonthlyDemand).filter(
                MonthlyDemand.ver == get_active_ver(db, "monthly_demand"),
                MonthlyDemand.ano == ano,
                MonthlyDemand.mes == mes,
            ).all()
            # Serialize while the session is open — get_db() commits+closes on exit, expiring the ORM
            # instances, so r.to_dict() after the block would raise DetachedInstanceError.
            out = [r.to_dict() for r in rows]
        return {"status": "ok", "rows": out, "count": len(out)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "endpoint"))


# ── Admin-editable working calendar (Manage Calendar) ─────────────────────────
# Reads: Admin only (require_admin). Mutations: Admin + second factor (ADMIN_PASSWORD
# unlock, via require_admin_unlock) + audited in SecurityEvent. Every change reloads the
# calendar_445 override snapshot and invalidates the Gantt cache, so schedules and every
# working-day KPI recompute from the new calendar on the next reload/recompute.
_CAL_KINDS = {"holiday", "working"}


def _calendar_month_days(year: int, month: int) -> list[dict]:
    """Per-day computed calendar for one month (override-aware), for the admin grid."""
    from calendar import monthrange
    from datetime import date as _date
    from services import calendar_445
    _dow_pt = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
    ndays = monthrange(year, month)[1]
    out: list[dict] = []
    for dnum in range(1, ndays + 1):
        d = _date(year, month, dnum)
        forced = calendar_445.is_forced_working(d)
        working = calendar_445.is_working_day(d)
        out.append({
            "date":       d.isoformat(),
            "day":        dnum,
            "dow":        _dow_pt[d.weekday()],
            "weekday":    d.weekday(),           # 0=Mon … 6=Sun
            "fw":         calendar_445.fw_label(d),
            # 4-4-5 fiscal month (1-12) this day's week rolls up to — for the fiscal-structure
            # overlay. Derived from the RAW week bucket so period grouping is offset-independent.
            "fiscal_month": calendar_445.fiscal_month_of_fw(calendar_445.fw_of(d)),
            "is_weekend": d.weekday() >= 5 and not forced,
            "is_working": working,
            "is_holiday": calendar_445.is_holiday_day(d),
        })
    return out


@app.get("/api/calendar")
def get_calendar(
    year:  int = Query(..., ge=1970, le=2100),
    month: int = Query(default=0, ge=0, le=12),   # 0 = whole year
    _user: dict = Depends(require_admin),
):
    """Computed working calendar + the admin override rows for a year (Admin only).

    `month` (1-12) narrows the per-day grid to one month; 0 returns all 12 months.
    Override rows are always returned for the whole year so the UI can badge edited days."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    try:
        from services import calendar_445
        months = [month] if month else list(range(1, 13))
        grid = {str(m): _calendar_month_days(year, m) for m in months}
        overrides: list[dict] = []
        with get_db() as db:
            rows = (db.query(CalendarOverride)
                      .filter(CalendarOverride.cal_date >= f"{year:04d}-01-01",
                              CalendarOverride.cal_date <= f"{year:04d}-12-31")
                      .order_by(CalendarOverride.cal_date.asc()).all())
            overrides = [r.to_dict() for r in rows]
        weeks_in_year = calendar_445.weeks_in_year(year)
        # Working days per RAW fiscal week (1..weeks_in_year), independent of the label offset —
        # the offset only relabels weeks, it never moves days between raw buckets. The client
        # regroups these into 4-4-5 fiscal months under whatever offset is pending, so shifting
        # the fiscal week instantly recomputes month summaries with no backend round-trip.
        fiscal_week_working_days = [
            calendar_445.working_days_in_fw(year, r) for r in range(1, weeks_in_year + 1)
        ]
        return {"status": "ok", "year": year, "months": grid, "overrides": overrides,
                # Per-year fiscal-week label offset (0 = default FW01 start). The UI's dropdown
                # edits this; weeks_in_year lets it render the wrapped label preview.
                "fw_offset": calendar_445.fw_offset_for_year(year),
                "weeks_in_year": weeks_in_year,
                "fiscal_week_working_days": fiscal_week_working_days,
                # 4-4-5 fiscal-month summaries (FW range + working days per fiscal period),
                # recomputed here from the freshly-reloaded calendar so saved day/fiscal-week
                # overrides are reflected. Kept for the SAVED baseline; the client recomputes the
                # displayed summary live from fiscal_week_working_days + the pending offset.
                "fiscal_months": calendar_445.fiscal_month_summaries(year)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "get_calendar"))


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
    (the GCR plan) therefore has no axis at all and renders empty, however many hours it holds.
    This is the same calendar with the Schedule taken out of it, so those derivations work
    unchanged and no client-side code re-invents fiscal weeks.

    Deliberately NOT `/api/calendar`, which is Admin-only: that route returns the override
    ROWS and the editing surface behind the Manage Calendar screen. This one returns only the
    computed working calendar — the same non-sensitive company-holiday shape
    `/api/calendar/exceptions` already serves to every authenticated user — so it is
    `require_auth`, and Readers can open a GCR plan.

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


@app.post("/api/calendar/override")
def set_calendar_override(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Create/update/clear a single-day calendar override. Admins only · second factor.

    Body: { date: 'YYYY-MM-DD', kind: 'holiday'|'working'|'clear', label?, scope? }
      kind='holiday' → force the day non-working (company holiday / day off);
      kind='working' → force the day working (exceptional Saturday/Sunday);
      kind='clear'   → remove any override (revert to the algorithmic base calendar).
    Audited in SecurityEvent; reloads the engine + drops caches (applies on next recompute)."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    from datetime import date as _date, datetime as _dt, timezone as _tz
    payload = body or {}
    raw_date = str(payload.get("date", "")).strip()
    kind = str(payload.get("kind", "")).strip().lower()
    label = str(payload.get("label", "")).strip()[:120]
    scope = (str(payload.get("scope", "company")).strip().lower() or "company")[:32]
    actor = _username_of((_user or {}).get("email", ""))
    try:
        d = _date.fromisoformat(raw_date)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Data inválida (use YYYY-MM-DD).")
    if kind not in _CAL_KINDS and kind != "clear":
        raise HTTPException(status_code=400, detail="Tipo inválido (use 'holiday', 'working' ou 'clear').")
    try:
        now = _dt.now(_tz.utc)
        with get_db() as db:
            row = db.query(CalendarOverride).filter(CalendarOverride.cal_date == d.isoformat()).first()
            prev = row.kind if row is not None else "base"
            if kind == "clear":
                if row is not None:
                    db.delete(row)
                new_val = "base"
            elif row is not None:
                row.kind = kind
                row.label = label or row.label
                row.scope = scope
                row.updated_at = now
                new_val = kind
            else:
                db.add(CalendarOverride(cal_date=d.isoformat(), kind=kind, label=label,
                                        scope=scope, created_by=actor, created_at=now, updated_at=now))
                new_val = kind
            _log_security_event(db, actor=actor, target=d.isoformat(), event_type="calendar_change",
                                detail=f"{prev} → {new_val}" + (f" ({label})" if label else ""))
        # Re-apply the snapshot + drop caches so the next reload recomputes.
        _reload_calendar_and_invalidate()
        return {"ok": True, "date": d.isoformat(), "kind": new_val}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "set_calendar_override"))


# Bound the per-year fiscal-week offset to one wrap in either direction (52 weeks). Larger
# values are meaningless (they wrap back) and keep the label math well-defined.
_FW_OFFSET_LIMIT = 52


@app.post("/api/calendar/fw-offset")
def set_fiscal_week_offset(body: dict = Body(default={}), _user: dict = Depends(require_admin_unlock)):
    """Set/clear a year's fiscal-week label offset. Admins only · second factor.

    Body: { year: 2027, offset: -1 }
      offset shifts EVERY week's label in that year uniformly and cascades (FW01 with
      offset -1 → FW52 of the previous fiscal year, FW02 → FW01, …). offset=0 clears the
      override (revert to the default FW01 start). This is the only fiscal-week edit that
      preserves week-sequence consistency. Label-only: working-day counts / 4-4-5 grouping
      are unchanged. Audited in SecurityEvent; reloads the engine + drops caches."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    from datetime import datetime as _dt, timezone as _tz
    payload = body or {}
    try:
        year = int(payload.get("year"))
        offset = int(payload.get("offset", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="year/offset inválidos.")
    if year < 1970 or year > 2100:
        raise HTTPException(status_code=400, detail="Ano fora do intervalo permitido.")
    if abs(offset) > _FW_OFFSET_LIMIT:
        raise HTTPException(status_code=400, detail="Deslocamento de semana fiscal fora do limite.")
    actor = _username_of((_user or {}).get("email", ""))
    try:
        now = _dt.now(_tz.utc)
        with get_db() as db:
            row = db.query(FiscalWeekOverride).filter(FiscalWeekOverride.year == year).first()
            prev = row.offset if row is not None else 0
            if offset == 0:
                if row is not None:
                    db.delete(row)
            elif row is not None:
                row.offset = offset
                row.updated_at = now
            else:
                db.add(FiscalWeekOverride(year=year, offset=offset,
                                          created_by=actor, created_at=now, updated_at=now))
            _log_security_event(db, actor=actor, target=f"FW{year}", event_type="calendar_change",
                                detail=f"fiscal-week offset {prev:+d} → {offset:+d}")
        _reload_calendar_and_invalidate()
        return {"ok": True, "year": year, "offset": offset}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_log_and_generic(exc, "set_fiscal_week_offset"))


# ── Headcount / Workstation management (Editor+, second factor) ──────────────
# Centralized WS + people + capacity limits, replacing the per-row copies that used to
# live inline on every Item Rout operation (that removal + wiring this in as the actual
# capacity-calc source is a LATER step — this is storage + CRUD + import only). Populated
# either by manual CRUD here or by importing the 'HeadCount' spreadsheet
# (see import_headcount_to_db / POST /api/db/import/headcount).

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


@app.post("/api/headcount/workstation")
def upsert_workstation(body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Create (no `id`) or edit (with `id`) one workstation. Body: { id?, wsn, area, desc,
    hour_limit, people_limit, qtde, turnos }."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    wsn = str(payload.get("wsn", "")).strip()
    if not wsn:
        raise HTTPException(status_code=400, detail="WSN é obrigatório.")
    actor = _username_of((_user or {}).get("email", ""))
    with get_db() as db:
        ws_id = payload.get("id")
        ws = db.query(Workstation).filter(Workstation.id == ws_id).first() if ws_id else None
        if ws is None:
            existing = db.query(Workstation).filter(Workstation.wsn == wsn).first()
            if existing is not None and (ws_id is None or existing.id != ws_id):
                raise HTTPException(status_code=409, detail=f"Workstation '{wsn}' já existe.")
            ws = Workstation(wsn=wsn)
            db.add(ws)
        ws.wsn = wsn
        ws.area = str(payload.get("area", "") or "").strip() or None
        ws.desc = str(payload.get("desc", "") or "").strip() or None
        ws.hour_limit = _headcount_float(payload.get("hour_limit"))
        ws.people_limit = _headcount_int(payload.get("people_limit"))
        ws.qtde = _headcount_int(payload.get("qtde"))
        ws.turnos = _headcount_int(payload.get("turnos"))
        # Absent key ⇒ leave the stored target alone. A client that doesn't know about expertise
        # (or a partial edit) must not silently clear it back to "no target".
        if "required_level" in payload:
            ws.required_level = _expertise_level(payload.get("required_level"))
            # Stamped on every write of the level, even when the VALUE is unchanged: a re-run of
            # the questionnaire that lands on the same target is still a new assessment, and
            # gating on the value would leave the old answers and actor under a fresh one.
            src, ans = _expertise_provenance(payload, prefix="required")
            ws.required_source     = src
            ws.required_answers    = ans
            ws.required_updated_at = datetime.now(timezone.utc)
            ws.required_updated_by = actor
        ws.updated_by = actor
        db.commit()
        return {"status": "ok", "workstation": ws.to_dict()}


def _headcount_float(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _headcount_int(v) -> int | None:
    try:
        return int(float(v)) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _expertise_level(v) -> int | None:
    """Coerce an expertise level to the 0–3 domain, or None for 'never assessed'.

    Clamped rather than rejected: this is a 4-state picker on the client, so anything outside
    the domain is a bug or a hand-rolled request, and neither is worth failing a whole save
    over. 0 is a REAL value here (not qualified / no bar) and is stored as 0, not as NULL —
    they read the same but only one of them is a statement someone made."""
    if v in (None, ""):
        return None
    try:
        return max(0, min(3, int(float(v))))
    except (TypeError, ValueError):
        return None


def _expertise_provenance(payload: dict, prefix: str = "expertise") -> tuple[str, str | None]:
    """(source, answers-as-JSON) for an expertise write.

    `prefix` picks which pair of payload keys to read — `expertise_*` for a person↔workstation
    pair, `required_*` for a workstation's own target. The rules below are identical for both;
    only the field names differ.

    Answers are only kept when they are exactly three values in 1–3 AND the source says quiz —
    anything else is stored as a manual assignment with no answers, so a malformed or invented
    payload degrades to "someone typed a level", never to a fake assessment record.

    The source carries the QUESTION SET VERSION as `quiz@N` (bare `quiz` is the unversioned
    original, i.e. v1). It is stored verbatim so the client can tell whether stored answers were
    given to the questions it is about to show: when they were not, the LEVEL still stands and
    only the pre-fill is retired. See EXPERTISE_QUIZ_VERSION in frontend/src/lib/expertise.ts."""
    source = str(payload.get(f"{prefix}_source") or "manual").strip().lower()
    if source != "quiz" and not (source.startswith("quiz@") and source[5:].isdigit()):
        return "manual", None
    raw = payload.get(f"{prefix}_answers")
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        return "manual", None
    try:
        vals = [int(x) for x in raw]
    except (TypeError, ValueError):
        return "manual", None
    if any(v < 1 or v > 3 for v in vals):
        return "manual", None
    return source, json.dumps(vals)


@app.delete("/api/headcount/workstation/{ws_id}")
def delete_workstation(ws_id: int, _user: dict = Depends(require_editor_unlock)):
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    with get_db() as db:
        ws = db.query(Workstation).filter(Workstation.id == ws_id).first()
        if ws is None:
            raise HTTPException(status_code=404, detail="Workstation não encontrada.")
        db.query(WorkstationPerson).filter(WorkstationPerson.workstation_id == ws_id).delete()
        db.delete(ws)
        db.commit()
    return {"status": "ok"}


@app.post("/api/headcount/person")
def add_person(body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Add a person to the roster. Body: { name, area? }."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nome é obrigatório.")
    actor = _username_of((_user or {}).get("email", ""))
    with get_db() as db:
        if db.query(Person).filter(Person.name == name).first() is not None:
            raise HTTPException(status_code=409, detail=f"'{name}' já está na lista de pessoas.")
        person = Person(name=name, area=str((body or {}).get("area", "") or "").strip() or None,
                        updated_by=actor)
        db.add(person)
        db.commit()
        return {"status": "ok", "person": person.to_dict()}


@app.post("/api/headcount/person/{person_id}")
def update_person(person_id: int, body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Edit one person: name and/or area. Body: { name?, area? }. Editor+ role AND the
    ADMIN_PASSWORD second factor, same as every other headcount mutation.

    Renaming is id-based here, so the WorkstationPerson links follow automatically — the
    tab's people lists are derived from the links, never from a stored name copy."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    actor = _username_of((_user or {}).get("email", ""))
    with get_db() as db:
        person = db.query(Person).filter(Person.id == person_id).first()
        if person is None:
            raise HTTPException(status_code=404, detail="Pessoa não encontrada.")
        if "name" in payload:
            name = str(payload.get("name", "")).strip()
            if not name:
                raise HTTPException(status_code=400, detail="Nome é obrigatório.")
            clash = db.query(Person).filter(Person.name == name, Person.id != person_id).first()
            if clash is not None:
                raise HTTPException(status_code=409, detail=f"'{name}' já está na lista de pessoas.")
            person.name = name
        if "area" in payload:
            person.area = str(payload.get("area", "") or "").strip() or None
        person.updated_by = actor
        db.commit()
        return {"status": "ok", "person": person.to_dict()}


@app.delete("/api/headcount/person/{person_id}")
def remove_person(person_id: int, _user: dict = Depends(require_editor_unlock)):
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    with get_db() as db:
        person = db.query(Person).filter(Person.id == person_id).first()
        if person is None:
            raise HTTPException(status_code=404, detail="Pessoa não encontrada.")
        db.query(WorkstationPerson).filter(WorkstationPerson.person_id == person_id).delete()
        db.query(PersonLeave).filter(PersonLeave.person_id == person_id).delete()
        db.delete(person)
        db.commit()
    return {"status": "ok"}


@app.post("/api/headcount/link")
def link_person(body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Assign a person to a workstation, and/or set that pair's expertise level.
    Body: { workstation_id, person_id, expertise_level? }.

    Idempotent on the link itself, so this doubles as the "set the level" call: the level lives
    ON the link (see WorkstationPerson), so a separate endpoint would only be the same UPDATE
    behind a second name. Omitting `expertise_level` leaves a stored level untouched."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    ws_id = payload.get("workstation_id")
    person_id = payload.get("person_id")
    with get_db() as db:
        if db.query(Workstation).filter(Workstation.id == ws_id).first() is None:
            raise HTTPException(status_code=404, detail="Workstation não encontrada.")
        if db.query(Person).filter(Person.id == person_id).first() is None:
            raise HTTPException(status_code=404, detail="Pessoa não encontrada.")
        exists = (db.query(WorkstationPerson)
                    .filter(WorkstationPerson.workstation_id == ws_id,
                            WorkstationPerson.person_id == person_id).first())
        sets_level = "expertise_level" in payload
        level = _expertise_level(payload.get("expertise_level")) if sets_level else None
        # Provenance is stamped only when a level is actually written — a plain (re)link must
        # not claim someone assessed anything.
        source, answers = _expertise_provenance(payload) if sets_level else (None, None)
        actor = _username_of((_user or {}).get("email", "")) if sets_level else None
        now = datetime.now(timezone.utc) if sets_level else None
        if exists is None:
            db.add(WorkstationPerson(
                workstation_id=ws_id, person_id=person_id, expertise_level=level,
                expertise_source=source, expertise_answers=answers,
                expertise_updated_at=now, expertise_updated_by=actor))
            db.commit()
        # Written whenever a level is sent, even when the VALUE is unchanged: a re-assessment
        # that lands on the same grade is still a new assessment, and gating on the value alone
        # would keep the old answers, actor and timestamp under a fresh questionnaire.
        elif sets_level:
            exists.expertise_level = level
            exists.expertise_source = source
            exists.expertise_answers = answers
            exists.expertise_updated_at = now
            exists.expertise_updated_by = actor
            db.commit()
    return {"status": "ok"}


@app.post("/api/headcount/unlink")
def unlink_person(body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Unassign a person from a workstation. Body: { workstation_id, person_id }."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    payload = body or {}
    with get_db() as db:
        (db.query(WorkstationPerson)
           .filter(WorkstationPerson.workstation_id == payload.get("workstation_id"),
                   WorkstationPerson.person_id == payload.get("person_id"))
           .delete())
        db.commit()
    return {"status": "ok"}


@app.post("/api/headcount/leave")
def add_person_leave(body: dict = Body(default={}), _user: dict = Depends(require_editor_unlock)):
    """Add a vacation/leave period. Body: { person_id, start_date, end_date, note? }
    (dates are ISO 'YYYY-MM-DD')."""
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    from datetime import date as _date
    payload = body or {}
    person_id = payload.get("person_id")
    try:
        start = _date.fromisoformat(str(payload.get("start_date", "")).strip())
        end = _date.fromisoformat(str(payload.get("end_date", "")).strip())
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Datas inválidas (use YYYY-MM-DD).")
    if end < start:
        raise HTTPException(status_code=400, detail="Data final anterior à data inicial.")
    actor = _username_of((_user or {}).get("email", ""))
    with get_db() as db:
        if db.query(Person).filter(Person.id == person_id).first() is None:
            raise HTTPException(status_code=404, detail="Pessoa não encontrada.")
        leave = PersonLeave(person_id=person_id, start_date=start.isoformat(),
                            end_date=end.isoformat(),
                            note=str(payload.get("note", "") or "").strip()[:200] or None,
                            updated_by=actor)
        db.add(leave)
        db.commit()
        return {"status": "ok", "leave": leave.to_dict()}


@app.delete("/api/headcount/leave/{leave_id}")
def delete_person_leave(leave_id: int, _user: dict = Depends(require_editor_unlock)):
    if not _DB_AVAILABLE:
        raise HTTPException(status_code=503, detail="Banco de dados não configurado.")
    with get_db() as db:
        leave = db.query(PersonLeave).filter(PersonLeave.id == leave_id).first()
        if leave is None:
            raise HTTPException(status_code=404, detail="Período não encontrado.")
        db.delete(leave)
        db.commit()
    return {"status": "ok"}


# ── Entrypoint direto (alternativa ao start.py) ──────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)