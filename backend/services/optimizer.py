"""
services/optimizer.py
---------------------
Modular Gurobi optimizer for workforce allocation.

Mirrors the multi-phase MIP model in CapB3356103.py (_run_optimization_snapshot),
but extracted into a standalone, reusable service with no PyQt5 or UI dependencies.

Public API
----------
check_gurobi()          → dict  – tests whether Gurobi is reachable
build_snapshot(...)     → dict  – assembles solver input from Excel + payload
run_optimization(...)   → dict  – runs the 6-phase Gurobi MIP and returns results
"""

from __future__ import annotations

import threading
import time
import logging
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ── Optional Gurobi import (LAZY) ─────────────────────────────────────────────
# gurobipy + its native runtime are heavy to import: they add seconds to process
# startup and a large RAM baseline. This module is imported at app startup (main.py
# imports check_gurobi/build_snapshot/run_optimization), but MOST requests never
# optimize — and under scale-to-zero that import would run on every cold start.
# So we DEFER it: the module loads with gp/GRB unset and _ensure_gurobi() performs
# the real import on first actual use (check_gurobi / run_optimization), caching the
# result in these module globals. All gp./GRB. references below read the globals at
# call time, so they resolve correctly once _ensure_gurobi() has run.
gp = None                                # type: ignore[assignment]
GRB = None                               # type: ignore[assignment]
_GUROBI_AVAILABLE: bool | None = None    # None = not yet probed; set by _ensure_gurobi()


def _ensure_gurobi() -> bool:
    """Import gurobipy on first use (idempotent). Returns True if it is importable.

    Caches gp / GRB / _GUROBI_AVAILABLE in module globals so later calls are free.
    """
    global gp, GRB, _GUROBI_AVAILABLE
    if _GUROBI_AVAILABLE is not None:    # already probed (success or failure)
        return _GUROBI_AVAILABLE
    try:
        import gurobipy as _gp
        from gurobipy import GRB as _GRB
        gp, GRB, _GUROBI_AVAILABLE = _gp, _GRB, True
    except Exception:
        gp, GRB, _GUROBI_AVAILABLE = None, None, False
    return _GUROBI_AVAILABLE

# ── Constants (mirror CapB3356103.py) ────────────────────────────────────────
MAX_PHASES                        = 6
DEFAULT_PHASE_LIMIT               = MAX_PHASES
DEFAULT_GAP_PCT                   = 2.0
DEFAULT_TIME_LIMIT_S              = 60.0
DEFAULT_OT_MAX_HOURS              = 0.0
MIN_PERSON_ALLOC_HOURS            = 1.0
PHASE1_ABS_GAP_HOURS              = 1e-4
PHASE4_ABS_GAP_HOURS              = 0.5   # 0.5h fragmentation gap is negligible in practice
PHASE5_ABS_GAP_UNITS              = 0.95
# Phase 5 uses a looser *relative* gap: user gap + this extra percentage.
# A 2-unit overshoot in the pair-count objective (one extra pair open) has
# negligible real-world impact versus waiting 10+ s for a tighter optimum.
PHASE5_REL_GAP_EXTRA_PCT          = 2.0
PHASE6_ABS_GAP_HOURS              = MIN_PERSON_ALLOC_HOURS
# A WSN is only flagged as a bottleneck if unmet > this threshold.
# Set equal to MIN_PERSON_ALLOC_HOURS so rounding artefacts (e.g. 0.1 h unmet
# when demand = 199.4 and capacity fits 199.3) never create false bottlenecks
# — a gap smaller than one minimum allocation block can never be filled.
BOTTLENECK_EPSILON_HOURS          = MIN_PERSON_ALLOC_HOURS
RESULT_REPORT_EPSILON_HOURS       = 1e-4
AUTO_PAIR_MIN_HOURS               = 0.0
MANUAL_ALLOCATION_PCT_CAP         = 500.0
RESIDUAL_FORCE_MAX_HOURS          = 1.0
RESIDUAL_FORCE_MAX_PCT            = 2.0
RESIDUAL_EMERGENCY_OT_H_PER_PERSON = 1.0
NORMAL_FULL_DAY_PREF_WEIGHT       = 1.0
WSN_OT_BALANCE_WEIGHT             = 0.2
FRAG_RATIO_HARD_CAP               = 2.0   # person's total load ≤ 2× their dominant-WSN load
FRAG_BALANCE_WEIGHT               = 0.15  # weight on Lmax-Lmin term in phase 4
# Same term, but for "Usar todo o Headcount". There, balancing IS the point of the run: the
# people were activated on purpose, and the default 0.15 nudge loses to the dispersion term
# (which pulls each person back into a single WSN, i.e. against spreading the work). Raising it
# to parity makes the load RANGE the thing phase 4 actually closes in that mode.
FRAG_BALANCE_WEIGHT_ALL_HC        = 1.0
MIN_UTIL_RATIO                    = 0.40  # soft minimum utilisation target (40% of capacity)

# ── Expertise ────────────────────────────────────────────────────────────────
# Level names, mirroring frontend/src/lib/expertise.ts — logs are read by the same people who
# set the levels in the UI, so a log saying "exige 3" when the screen says "Alta" is a
# translation the reader should not have to do.
_LEVEL_NAMES = {0: "N/A", 1: "Baixa", 2: "Média", 3: "Alta"}
# Weight of the SHORTFALL term in the phase-4 objective — the whole mechanism by which the
# target level acts on the run. It is a PREFERENCE, never a filter: a person below the target
# stays allocatable and is simply charged for the gap, so a station whose best available people
# are all under its target still gets staffed instead of going uncovered.
#
# Set above FRAG_BALANCE_WEIGHT (0.15) on purpose: inside phase 4, "put the qualified person on
# the demanding station" outranks "even out the load". It cannot outrank coverage or overtime —
# phases 1–3 are already lex-fixed by the time this expression is minimised, which is exactly
# the property that makes it safe to ship non-zero.
EXPERTISE_SHORTFALL_WEIGHT        = 0.30
# Weight of the OVER-qualification term, same phase and the same scaling. Together with the
# shortfall term above it makes the phase-4 charge Σ|e[p,w] − r[w]|·(X+H): the DISPERSION of the
# allocated crew around the station's target, per person, not the crew's average.
#
# Per-person distance is strictly stronger than an average, which is why no average constraint
# was added: on a station targeting Média, two people at Média cost 0, while one Baixa plus one
# Alta costs 1+1 — same average, and the model now prefers the first. Under the shortfall term
# alone the pair would already have cost 1 (only the Baixa side is charged); this makes the
# charge symmetric, so parking a proficient person on an undemanding station is priced too —
# that is what creates artificial scarcity on the stations that actually need them.
#
# Kept BELOW the shortfall weight on purpose: being under the target is a worse mistake than
# being over it. Under-qualification risks the work; over-qualification only wastes it.
EXPERTISE_OVERQUAL_WEIGHT         = 0.10

# ── Expertise speed multipliers ──────────────────────────────────────────────
# Effective demand-hours delivered per CLOCK hour worked, by (station target r, person level e).
# 1.15 means one hour of that person's time closes 1.15 hours of demand; 0.85 means it closes
# 0.85. The direction is fixed here once — productivity, not consumption — because it is the
# only one that leaves X and H in real clock hours, which every capacity, overtime and
# utilisation constraint in the model already reads. The inverse view the spec also used
# ("how many hours to finish one hour of demand") is 1/m: 0.87 h at 1.15, 1.18 h at 0.85.
#
# Only the coverage constraint is multiplied. Capacity is NOT: a slower person does not gain
# hours in the day, they deliver less with the hours they have.
#
# r = 0 (no target) or e = 0 (not assessed) ⇒ 1.0, ALWAYS. This is not a rounding convenience:
# the matrix is mostly empty today, and treating "unknown" as "Baixa" would silently slow the
# entire plant down the first time the flag is switched on.
#
# The table depends only on the GAP e − r, not on the absolute pair: +1 is +1 whether it is Média
# on a Baixa station or Alta on a Média one. Downside 0.90 / 0.85 and the 1.00 diagonal are the
# feature's own anchors; the upside was set to 1.10 / 1.15 rather than the 1.20 / 1.25 the
# anchors implied, which is what puts the whole range inside the 0.85–1.15 the spec asked for.
#
# The shape is symmetric in the gap (±0.10 at one level, ±0.15 at two) and both tails FLATTEN:
# the second level away from the target moves only another 0.05. Past the first level, being
# further above the target helps about as little as being further below it hurts.
EXPERTISE_SPEED: dict[tuple[int, int], float] = {
    #  (r, e)                      gap = e − r
    (1, 1): 1.00, (1, 2): 1.10, (1, 3): 1.15,   #  0   +1   +2
    (2, 1): 0.90, (2, 2): 1.00, (2, 3): 1.10,   # -1    0   +1
    (3, 1): 0.85, (3, 2): 0.90, (3, 3): 1.00,   # -2   -1    0
}

# ── Parameter helpers ────────────────────────────────────────────────────────

def _clamp_gap_pct(v: Any) -> float:
    try:
        return max(0.0, float(v if v is not None else DEFAULT_GAP_PCT))
    except Exception:
        return DEFAULT_GAP_PCT


def _clamp_time_s(v: Any) -> float:
    try:
        return max(1.0, float(v if v is not None else DEFAULT_TIME_LIMIT_S))
    except Exception:
        return DEFAULT_TIME_LIMIT_S


def _clamp_phase_limit(v: Any) -> int:
    try:
        return max(1, min(MAX_PHASES, int(round(float(v if v is not None else DEFAULT_PHASE_LIMIT)))))
    except Exception:
        return DEFAULT_PHASE_LIMIT


def _clamp_ot_max_hours(v: Any) -> float:
    try:
        h = float(v if v is not None else DEFAULT_OT_MAX_HOURS)
        return max(0.0, h)
    except Exception:
        return DEFAULT_OT_MAX_HOURS


def _phase_abs_gap(phase_idx: int) -> float | None:
    if phase_idx == 1:
        return PHASE1_ABS_GAP_HOURS
    if phase_idx == 4:
        return PHASE4_ABS_GAP_HOURS
    if phase_idx == 5:
        return PHASE5_ABS_GAP_UNITS
    if phase_idx == 6:
        return PHASE6_ABS_GAP_HOURS
    return None


def _phase_fix_epsilon(val: float) -> float:
    """Tolerance added to phase objective when pinning lexicographic constraints."""
    if val <= 0.0:
        return 1e-4
    if val < 1.0:
        return max(1e-6, val * 1e-4)
    return max(1e-4, val * 1e-4)


def _normal_day_hours(top_pct: float) -> float:
    return 8.8 * (top_pct / 100.0)


def _half_day_hours(top_pct: float) -> float:
    return _normal_day_hours(top_pct) * 0.5


# ── Public: Gurobi availability check ────────────────────────────────────────

def check_gurobi() -> dict:
    """
    Verifies that Gurobi is importable and that a valid license exists by
    creating a minimal empty model.  Does NOT run any optimization.

    Returns:
        { "available": bool, "version": str | None, "message": str }
    """
    if not _ensure_gurobi() or gp is None:
        return {
            "available": False,
            "version": None,
            "message": "gurobipy não encontrado no ambiente Python. "
                       "Instale com: pip install gurobipy",
        }
    try:
        m = gp.Model("_license_check")
        m.Params.OutputFlag = 0
        # Add a trivial variable so Gurobi actually validates the license
        m.addVar(name="x", lb=0.0, vtype=GRB.CONTINUOUS)
        m.update()
        m.dispose()
        version_str = ".".join(str(v) for v in gp.gurobi.version())
        return {
            "available": True,
            "version": version_str,
            "message": f"Gurobi {version_str} disponível e licença válida.",
        }
    except Exception as exc:
        return {
            "available": False,
            "version": None,
            "message": f"Gurobi importado mas licença inválida ou erro ao criar modelo: {exc}",
        }


# ── Snapshot assembly ────────────────────────────────────────────────────────

def build_snapshot(
    excel_path: str | Path,
    *,
    items: list[dict],
    top_pct: float = 90.0,
    ot_day_limit_pct: float = 60.0,
    ot_max_hours: float = DEFAULT_OT_MAX_HOURS,
    gap_pct: float = DEFAULT_GAP_PCT,
    time_limit_s: float = DEFAULT_TIME_LIMIT_S,
    phase_limit: int = DEFAULT_PHASE_LIMIT,
    use_all_people: bool = True,
    use_all_headcount: bool = False,
    mode: str = "mensal",
    ndias: float = 5.0,
    demand_by_wsn_explicit: dict[str, float] | None = None,
    excluded_wsns: list[str] | None = None,
    # Manual overrides (optional)
    blocked_pairs: list[tuple[str, str]] | None = None,
    required_pairs: list[tuple[str, str]] | None = None,
    forced_people: list[str] | None = None,
    forced_pair_headcount: dict[str, float] | None = None,
    direct_pair_headcount: dict[str, float] | None = None,
    max_pair_pct: dict[str, float] | None = None,
    fixed_pair_ot_pct: dict[str, float] | None = None,
    max_pair_ot_pct: dict[str, float] | None = None,
    wsn_max_people: dict[str, int] | None = None,
    wsn_max_hours:  dict[str, float] | None = None,
    wsn_max_turnos: dict[str, int] | None = None,
    person_availability_pct: dict[str, float] | None = None,
    df_override: Any | None = None,
    headcount_override: dict[str, dict] | None = None,
    expertise_enabled: bool = False,
    expertise_anchor: bool = False,
    expertise_speed: bool = False,
) -> dict:
    """
    Builds the solver snapshot dict from the Excel file and request payload.
    Equivalent to the snapshot assembly block in CapB3356103.py
    (_prepare_optimization_snapshot_gurobi).

    The snapshot is passed directly to run_optimization().
    """
    # people_by_wsn arrives inside `data` (sourced from the Headcount tab via headcount_override);
    # get_wsn_people_map was imported here but never called — dropped with the Item Rout cutover.
    from services.data_loader import load_and_prepare_data

    excel_path = Path(excel_path)
    data = load_and_prepare_data(excel_path, df_override=df_override, headcount_override=headcount_override)
    if data.get("status") == "error":
        raise RuntimeError(f"Erro ao ler Excel: {data['message']}")

    if demand_by_wsn_explicit:
        demand_by_wsn: dict[str, float] = {k: float(v) for k, v in demand_by_wsn_explicit.items() if float(v) > 0}
    else:
        demand_by_wsn = data.get("demand_by_wsn", {})

    # Remove explicitly disabled WSNs (excluded_wsns = recalculate override)
    if excluded_wsns:
        for wsn in excluded_wsns:
            demand_by_wsn.pop(wsn, None)
    wsn_people_raw: dict[str, list[str]] = data.get("people_by_wsn", {})

    # ── WSN / person lists ────────────────────────────────────────
    I: list[str] = sorted(demand_by_wsn.keys())
    all_people: set[str] = set()
    for plist in wsn_people_raw.values():
        all_people.update(plist)
    J: list[str] = sorted(all_people)

    people_by_wsn_all: dict[str, list[str]] = {
        wsn: sorted(wsn_people_raw.get(wsn, [])) for wsn in I
    }
    # active = same as all (no disabled people logic yet)
    people_by_wsn_active: dict[str, list[str]] = dict(people_by_wsn_all)

    # ── NIVEL-weighted demand (by item NIVEL field) ───────────────
    nivel_weighted_demand_by_wsn: dict[str, float] = {}
    for it in items:
        nivel_str = str(it.get("nivel") or "").strip().lstrip("Pp")
        try:
            nivel_val = float(nivel_str) if nivel_str else 0.0
        except Exception:
            nivel_val = 0.0
        for wsn_entry in it.get("wsns", []):
            wsn_key = str(wsn_entry.get("wsn") or "").strip()
            hours = float(wsn_entry.get("hours") or 0.0)
            if wsn_key:
                nivel_weighted_demand_by_wsn[wsn_key] = (
                    nivel_weighted_demand_by_wsn.get(wsn_key, 0.0) + nivel_val * hours
                )

    # ── LH by WSN (from headcount data xlsx) ─────────────────────────
    headcount_by_wsn: dict[str, dict] = data.get("headcount_by_wsn", {})
    lh_by_wsn: dict[str, float] = {
        wsn: float(hc.get("lh", 0.0)) for wsn, hc in headcount_by_wsn.items()
    }

    # ── Shift constraints (TURNOS / LM / LH from HeadCount sheet) ────
    # Only included for WSNs that actually have demand and appear in I.
    # turnos: number of shifts, lm: max people/shift, lh: max hours/shift.
    wsn_set = set(I)
    wsn_shift_constraints: dict[str, dict] = {}
    for wsn, hc in headcount_by_wsn.items():
        if wsn not in wsn_set:
            continue
        t  = int(hc.get("turnos") or 0)
        lm = int(hc.get("lm")     or 0)
        lh = float(hc.get("lh")   or 0.0)
        if t > 0 or lm > 0:
            wsn_shift_constraints[wsn] = {"turnos": t, "lm": lm, "lh": lh}

    # ── Expertise matrix (e[p,w] and r[w]) ───────────────────────
    # Sourced from the SAME headcount dict the capacity limits come from, so a WSN cannot end up
    # with people from one snapshot and levels from another. Restricted to WSNs in `I`: a level
    # for a station with no demand is not a constraint on anything.
    wsn_required_level: dict[str, int] = {}
    pair_expertise: dict[str, dict[str, int]] = {}
    for wsn, hc in headcount_by_wsn.items():
        if wsn not in wsn_set:
            continue
        r = int(hc.get("required_level") or 0)
        if r > 0:
            wsn_required_level[wsn] = r
        levels = hc.get("expertise") or {}
        if levels:
            pair_expertise[wsn] = {str(k): int(v) for k, v in levels.items()}

    return {
        # Solver parameters
        "top_pct_val":                    float(top_pct),
        "ot_day_limit_pct_val":           float(ot_day_limit_pct),
        "optimization_ot_max_hours_val":  _clamp_ot_max_hours(ot_max_hours),
        "optimization_gap_pct_val":       _clamp_gap_pct(gap_pct),
        "optimization_time_limit_s_val":  _clamp_time_s(time_limit_s),
        "optimization_phase_limit_val":   _clamp_phase_limit(phase_limit),
        "use_all_available_people_val":   bool(use_all_people),
        "use_all_headcount_val":          bool(use_all_headcount),
        "mode_norm":                      str(mode),
        "ndias":                          float(ndias),
        # Data
        "I":                              I,
        "J":                              J,
        "demand_by_wsn":                  {k: float(v) for k, v in demand_by_wsn.items()},
        "nivel_weighted_demand_by_wsn":   nivel_weighted_demand_by_wsn,
        "lh_by_wsn":                      lh_by_wsn,
        "people_by_wsn_all":              people_by_wsn_all,
        "people_by_wsn_active":           people_by_wsn_active,
        # Manual overrides (all optional)
        "blocked_pairs":                  list(blocked_pairs or []),
        "required_pair_presence":         list(required_pairs or []),
        "forced_people":                  list(forced_people or []),
        "forced_pair_headcount":          dict(forced_pair_headcount or {}),
        "direct_pair_headcount":          dict(direct_pair_headcount or {}),
        "max_pair_pct":                   dict(max_pair_pct or {}),
        "fixed_pair_ot_pct":              dict(fixed_pair_ot_pct or {}),
        "max_pair_ot_pct":                dict(max_pair_ot_pct or {}),
        "wsn_max_people":                 dict(wsn_max_people or {}),
        "wsn_max_hours":                  dict(wsn_max_hours or {}),
        "wsn_max_turnos":                 dict(wsn_max_turnos or {}),
        "person_availability_pct":        dict(person_availability_pct or {}),
        "disabled_placeholder_rows":      [],
        # Shift constraints derived from HeadCount sheet columns TURNOS/LM/LH
        "wsn_shift_constraints":          wsn_shift_constraints,
        # Expertise — the matrix travels ALWAYS, the flag decides whether it binds.
        "expertise_enabled_val":          bool(expertise_enabled),
        "expertise_anchor_val":           bool(expertise_anchor),
        "expertise_speed_val":            bool(expertise_speed),
        "wsn_required_level":             wsn_required_level,
        "pair_expertise":                 pair_expertise,
    }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v) if v is not None else default
    except Exception:
        return default


def _has_demand(hours: float) -> bool:
    return hours > BOTTLENECK_EPSILON_HOURS


def _pair_map_from_payload(payload: dict) -> dict[tuple[str, str], float]:
    """Decodes 'wsn|person' → float maps from the snapshot."""
    out: dict[tuple[str, str], float] = {}
    for raw_key, value in (payload or {}).items():
        try:
            wsn, person = str(raw_key).split("|", 1)
        except Exception:
            continue
        if wsn and person:
            out[(wsn, person)] = float(value or 0.0)
    return out


# ── Main solver entry point ───────────────────────────────────────────────────

def run_optimization(
    snapshot: dict,
    *,
    progress_callback: Callable[[int, str], None] | None = None,
    log_callback: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> dict:
    """
    Runs the 6-phase Gurobi workforce-allocation MIP.

    Parameters
    ----------
    snapshot        : built by build_snapshot()
    progress_callback : (percent: int, message: str) → None
    log_callback    : (line: str) → None  — raw Gurobi log lines
    stop_event      : set() to request early termination

    Returns
    -------
    dict with keys:
        status, message, wsns, allocations, phase_metrics, final_gap
    """
    def _prog(pct: int, msg: str) -> None:
        if callable(progress_callback):
            try:
                progress_callback(int(pct), str(msg))
            except Exception:
                pass

    def _log(line: str) -> None:
        if callable(log_callback):
            try:
                log_callback(str(line))
            except Exception:
                pass

    # ── Step 0: Gurobi availability ──────────────────────────────
    if not _ensure_gurobi() or gp is None or GRB is None:
        raise RuntimeError(
            "Gurobi não está disponível. Instale gurobipy e configure a licença."
        )

    _prog(5, "Verificando Gurobi...")
    gurobi_check = check_gurobi()
    if not gurobi_check["available"]:
        raise RuntimeError(gurobi_check["message"])
    logger.info("[OPTIMIZER] %s", gurobi_check["message"])
    _log(f"[OPTIMIZER] {gurobi_check['message']}")

    # ── Step 1: Unpack snapshot ──────────────────────────────────
    _prog(10, "Preparando dados...")

    I: list[str] = list(snapshot.get("I") or [])
    J: list[str] = list(snapshot.get("J") or [])
    demand_by_wsn: dict[str, float]         = {str(k): _safe_float(v) for k, v in (snapshot.get("demand_by_wsn") or {}).items()}
    nivel_wt_demand: dict[str, float]       = {str(k): _safe_float(v) for k, v in (snapshot.get("nivel_weighted_demand_by_wsn") or {}).items()}
    lh_by_wsn: dict[str, float]             = {str(k): _safe_float(v) for k, v in (snapshot.get("lh_by_wsn") or {}).items()}
    people_by_wsn_active: dict[str, set]    = {str(k): set(v or []) for k, v in (snapshot.get("people_by_wsn_active") or {}).items()}
    blocked_pairs: set[tuple[str, str]]     = {tuple(r) for r in (snapshot.get("blocked_pairs") or []) if len(r) == 2}  # type: ignore[assignment]
    required_pairs: set[tuple[str, str]]    = {tuple(r) for r in (snapshot.get("required_pair_presence") or []) if len(r) == 2}  # type: ignore[assignment]
    forced_people: set[str]                 = {str(v) for v in (snapshot.get("forced_people") or []) if str(v)}
    forced_pair_hc                          = _pair_map_from_payload(snapshot.get("forced_pair_headcount") or {})
    direct_pair_hc                          = _pair_map_from_payload(snapshot.get("direct_pair_headcount") or {})
    max_pair_pct                            = _pair_map_from_payload(snapshot.get("max_pair_pct") or {})
    fixed_ot_pct                            = _pair_map_from_payload(snapshot.get("fixed_pair_ot_pct") or {})
    max_ot_pct                              = _pair_map_from_payload(snapshot.get("max_pair_ot_pct") or {})
    wsn_max_people: dict[str, int]          = {str(k): int(v) for k, v in (snapshot.get("wsn_max_people") or {}).items() if int(v) > 0}
    wsn_max_hours:  dict[str, float]        = {str(k): float(v) for k, v in (snapshot.get("wsn_max_hours") or {}).items() if float(v) > 0}
    wsn_max_turnos: dict[str, int]          = {str(k): max(1, min(3, int(v))) for k, v in (snapshot.get("wsn_max_turnos") or {}).items()}
    wsn_shift_constraints: dict[str, dict] = {str(k): v for k, v in (snapshot.get("wsn_shift_constraints") or {}).items()}
    avail_pct: dict[str, float]             = {str(k): _safe_float(v, 100.0) for k, v in (snapshot.get("person_availability_pct") or {}).items()}
    expertise_on   = bool(snapshot.get("expertise_enabled_val", False))
    anchor_on      = bool(snapshot.get("expertise_anchor_val", False))
    speed_on       = bool(snapshot.get("expertise_speed_val", False)) and expertise_on
    req_level: dict[str, int]               = {str(k): int(v) for k, v in (snapshot.get("wsn_required_level") or {}).items()}
    pair_level: dict[str, dict[str, int]]   = {
        str(w): {str(p): int(l) for p, l in (lv or {}).items()}
        for w, lv in (snapshot.get("pair_expertise") or {}).items()
    }

    # Read ndias early — needed to scale weekly lh cap to the planning period
    ndias   = max(1.0, _safe_float(snapshot.get("ndias"), 5.0))
    n_weeks = ndias / 5.0

    # Apply manual turnos override: replace turnos in shift constraints before computing caps
    for wsn, t_override in wsn_max_turnos.items():
        if wsn in wsn_shift_constraints:
            wsn_shift_constraints[wsn] = {**wsn_shift_constraints[wsn], "turnos": t_override}

    # Apply manual LM override: wsn_max_people = max people per shift (replaces LM column)
    for wsn, lm_override in wsn_max_people.items():
        if wsn in wsn_shift_constraints:
            wsn_shift_constraints[wsn] = {**wsn_shift_constraints[wsn], "lm": lm_override}
        else:
            wsn_shift_constraints[wsn] = {"turnos": 1, "lm": lm_override, "lh": 0.0}

    # ── Build effective max/min constraints from shift data ──────
    # TURNOS * LM → effective max people per WSN (unless manual override exists)
    # LH          → per-person/per-shift weekly hour cap; scaled by n_weeks for the period
    wsn_shift_max_people: dict[str, int]   = {}
    wsn_shift_max_hours:  dict[str, float] = {}
    for wsn, sc in wsn_shift_constraints.items():
        t  = int(sc.get("turnos") or 0)
        lm = int(sc.get("lm")     or 0)
        lh = float(sc.get("lh")   or 0.0)
        if t > 0 and lm > 0:
            wsn_shift_max_people[wsn] = t * lm
        if t > 0 and lh > 0.0:
            # lh is a weekly limit per person/shift; multiply by n_weeks
            # so a 4-week plan allows lh*4 hours per person, not just lh.
            wsn_shift_max_hours[wsn] = lh * n_weeks
    # wsn_max_people is now applied as LM override above; wsn_shift_max_people already includes it
    effective_wsn_max_people: dict[str, int]   = dict(wsn_shift_max_people)
    effective_wsn_max_hours:  dict[str, float] = {**wsn_shift_max_hours,  **wsn_max_hours}

    top_pct        = _safe_float(snapshot.get("top_pct_val"), 90.0)
    ot_day_pct     = _safe_float(snapshot.get("ot_day_limit_pct_val"), 60.0)
    ot_max_h       = _clamp_ot_max_hours(snapshot.get("optimization_ot_max_hours_val"))
    gap_pct        = _clamp_gap_pct(snapshot.get("optimization_gap_pct_val"))
    time_s         = _clamp_time_s(snapshot.get("optimization_time_limit_s_val"))
    phase_limit    = _clamp_phase_limit(snapshot.get("optimization_phase_limit_val"))
    use_all_people = bool(snapshot.get("use_all_available_people_val", True))
    use_all_headcount = bool(snapshot.get("use_all_headcount_val", False))
    # ndias already read above (needed for lh scaling)

    _log(f"[SETUP] Snapshot recebido: I={len(I)} WSNs, J={len(J)} pessoas")
    if not I:
        _log("[ERRO] Nenhum WSN com demanda encontrado. Verifique o arquivo HorasB3.xlsx e os itens importados.")
        return {"status": "error", "message": "Sem WSNs com demanda para otimizar.", "wsns": [], "allocations": {}, "phase_metrics": [], "final_gap": None}
    if not J:
        _log("[ERRO] Nenhuma pessoa disponível para alocar. Verifique a aba HeadCount do Excel.")
        return {"status": "error", "message": "Sem pessoas disponíveis para alocar.", "wsns": [], "allocations": {}, "phase_metrics": [], "final_gap": None}

    _log(f"[SETUP] WSNs={len(I)}  Pessoas={len(J)}  Fases={phase_limit}  Gap={gap_pct}%  Limite={time_s}s"
         f"  HC_total={'on' if use_all_headcount else 'off'}")
    _prog(15, "Montando pares qualificados...")

    # ── Step 2: Qualified pairs ──────────────────────────────────
    top_factor      = top_pct / 100.0
    Hnorm           = 8.8 * top_factor          # hours/day normal
    Hextra          = (10.8 - 8.8) * top_factor  # hours/day OT
    cap_norm        = Hnorm * ndias
    cap_extra       = Hextra * ndias * (ot_day_pct / 100.0)

    norm_cap_by_j:  dict[str, float] = {}
    extra_cap_by_j: dict[str, float] = {}
    total_cap_by_j: dict[str, float] = {}
    for j in J:
        af = max(0.0, min(100.0, avail_pct.get(j, 100.0))) / 100.0
        norm_cap_by_j[j]  = cap_norm  * af
        extra_cap_by_j[j] = cap_extra * af
        total_cap_by_j[j] = norm_cap_by_j[j] + extra_cap_by_j[j]

    qualified_pairs: list[tuple[str, str]] = []
    pairs_by_i: dict[str, list] = {i: [] for i in I}
    pairs_by_j: dict[str, list] = {j: [] for j in J}

    # ── Expertise: the target level is a PREFERENCE, never a filter ──────────────
    # `_shortfall` is how far a pair sits below its station's target, and it is priced in the
    # phase-4 objective (see EXPERTISE_SHORTFALL_WEIGHT and the term that uses it). No pair is
    # ever removed from the model for it.
    #
    # Removing them was the original design and it was WRONG: a station targeting Alta whose
    # people are all Média would lose every candidate, and coverage being soft
    # (`covered + U[i] == demand`) means that does not error — it silently becomes unmet demand.
    # The station never gets filled, which is worse than filling it with the best people on hand.
    # The point of the level is to decide WHO goes to the demanding station when there is a
    # choice, not to leave it empty when there is not.
    #
    # r = 0 means NO TARGET SET: the station prefers nobody in particular, so every linked
    # person has zero shortfall. Note the same 0 means "not assessed" on the PERSON's side and
    # "no target" on the STATION's; only the station's side is asked here.
    def _shortfall(wsn: str, person: str) -> int:
        r = req_level.get(wsn, 0)
        if r == 0:
            return 0
        return max(0, r - pair_level.get(wsn, {}).get(person, 0))

    # Effective demand-hours a pair delivers per clock hour. 1.0 whenever the multipliers are
    # off, the station has no target, or the person was never assessed — see EXPERTISE_SPEED.
    def _speed(wsn: str, person: str) -> float:
        if not speed_on:
            return 1.0
        r = req_level.get(wsn, 0)
        e = pair_level.get(wsn, {}).get(person, 0)
        if r == 0 or e == 0:
            return 1.0
        return EXPERTISE_SPEED.get((r, e), 1.0)

    # Below-target pairs per WSN — for the diagnostic only. They are in the model.
    expertise_below: dict[str, list[str]] = {}

    for i in I:
        if not _has_demand(demand_by_wsn.get(i, 0.0)):
            continue
        allowed = people_by_wsn_active.get(i, set())
        for j in J:
            if j not in allowed:
                continue
            if (i, j) in blocked_pairs:
                continue
            preview_cap = total_cap_by_j[j]
            if not _has_demand(preview_cap):
                continue
            # Recorded only for pairs that actually made it into the model, so the diagnostic
            # counts candidates the solver can really choose from.
            if expertise_on and _shortfall(i, j) > 0:
                expertise_below.setdefault(i, []).append(j)
            pair = (i, j)
            qualified_pairs.append(pair)
            pairs_by_i[i].append(pair)
            pairs_by_j[j].append(pair)

    allocatable = {j for j in J if pairs_by_j.get(j)}
    # Force-expand qualified pairs for required pairs that bypass the skill check.
    # This allows the user to allocate a person without skill to a WSN (after UI warning).
    qp_set = set(qualified_pairs)
    for wsn, person in required_pairs:
        if (wsn, person) in qp_set:
            continue
        if wsn not in demand_by_wsn or not _has_demand(demand_by_wsn[wsn]):
            continue
        # Compute capacity for person if not yet done (person may not be in J)
        if person not in total_cap_by_j:
            af = max(0.0, min(100.0, avail_pct.get(person, 100.0))) / 100.0
            norm_cap_by_j[person]  = cap_norm  * af
            extra_cap_by_j[person] = cap_extra * af
            total_cap_by_j[person] = norm_cap_by_j[person] + extra_cap_by_j[person]
            if person not in pairs_by_j:
                pairs_by_j[person] = []
        if not _has_demand(total_cap_by_j[person]):
            continue
        pair = (wsn, person)
        qualified_pairs.append(pair)
        pairs_by_i.setdefault(wsn, []).append(pair)
        pairs_by_j.setdefault(person, []).append(pair)
        qp_set.add(pair)
        allocatable.add(person)
        # A fixed pair below the station's target is worth naming — the user pinned it by hand
        # and the shortfall term will still charge for it, which is visible in phase 4's value
        # and nowhere else.
        if expertise_on and _shortfall(wsn, person) > 0:
            expertise_below.setdefault(wsn, []).append(person)
            _log(f"[EXPERTISE] Par fixado {wsn}|{person} está abaixo do alvo "
                 f"(nível {_LEVEL_NAMES.get(pair_level.get(wsn, {}).get(person, 0))} "
                 f"< alvo {_LEVEL_NAMES.get(req_level.get(wsn, 0))}) — mantido, com penalidade.")
        _log(f"[SETUP] Par forçado sem skill adicionado: {wsn}|{person}")

    missing_required = [(w, p) for w, p in required_pairs if (w, p) not in qp_set]
    if missing_required:
        preview = ", ".join(f"{w}|{p}" for w, p in missing_required[:6])
        raise RuntimeError(f"Pessoas fixadas sem elegibilidade: {preview}")

    # ── Expertise diagnostics ────────────────────────────────────
    # Named per WSN, and separated into "some below target" and "ALL below target". The second
    # is the one supervision has to act on — it is a real training gap, not a solver problem —
    # and it has to say WHICH station and WHAT the best available level is, or the user cannot
    # act on it. Neither case loses a pair: the log says so in as many words, because the
    # previous version of this feature DID drop them and the wording has to un-teach that.
    expertise_understaffed_wsns: list[str] = []
    if expertise_on:
        _log(f"[EXPERTISE] Mapeamento ATIVO — {len(req_level)} WSN(s) com nível alvo, "
             f"{sum(len(v) for v in pair_level.values())} par(es) com nível avaliado. "
             f"O nível é PREFERÊNCIA (déficit {EXPERTISE_SHORTFALL_WEIGHT} / "
             f"sobrequalificação {EXPERTISE_OVERQUAL_WEIGHT} na Fase 4): "
             f"ninguém é excluído da alocação.")
        # Speed multipliers are the one piece of expertise that is NOT a preference: they change
        # how much demand an hour closes, so they move phase 1 — the coverage number itself.
        # That is a different kind of claim from "who fills the slot", and the log has to say so,
        # including that coverage can come out LOWER than with the flag off when the crew sits
        # below target. Off by default for exactly that reason.
        if speed_on:
            n_adj = sum(1 for (i, j) in qualified_pairs if abs(_speed(i, j) - 1.0) > 1e-9)
            faster = sum(1 for (i, j) in qualified_pairs if _speed(i, j) > 1.0)
            _log(f"[EXPERTISE] Multiplicadores de ritmo ATIVOS — {n_adj} de "
                 f"{len(qualified_pairs)} par(es) com ritmo diferente de 1,0 "
                 f"({faster} acima do alvo, {n_adj - faster} abaixo). Uma hora de relógio passa "
                 f"a fechar entre {min(EXPERTISE_SPEED.values()):.2f} e "
                 f"{max(EXPERTISE_SPEED.values()):.2f} hora de demanda. A CAPACIDADE não muda: "
                 f"quem está abaixo do alvo entrega menos com as mesmas horas, e por isso a "
                 f"cobertura total PODE cair em relação a um run sem expertise.")
        else:
            _log("[EXPERTISE] Multiplicadores de ritmo desligados — uma hora de relógio fecha "
                 "uma hora de demanda para todo mundo.")
        # The preference lives in the phase-4 objective, so a run that stops before it has the
        # flag on and no ranking behaviour at all. Silent would be indistinguishable from
        # "the levels made no difference".
        if phase_limit < 4:
            _log(f"[EXPERTISE] Run limitado à Fase {phase_limit} — a PREFERÊNCIA de nível NÃO "
                 f"influencia este resultado (déficit e dispersão vivem na Fase 4). Suba o "
                 f"limite de fases para que ela valha."
                 + (" Os multiplicadores de ritmo continuam valendo: eles estão na restrição de "
                    "cobertura, não no objetivo." if speed_on else ""))
        for i in sorted(expertise_below):
            below   = expertise_below[i]
            total_i = len(pairs_by_i.get(i, []))
            r       = req_level.get(i, 0)
            r_txt   = _LEVEL_NAMES.get(r, str(r))
            if len(below) >= total_i:
                best = max((pair_level.get(i, {}).get(p, 0) for p in below), default=0)
                expertise_understaffed_wsns.append(i)
                _log(f"[EXPERTISE] {i} tem alvo {r_txt} — NENHUMA das {len(below)} pessoa(s) "
                     f"atinge o nível (máximo disponível: {_LEVEL_NAMES.get(best, best)}). "
                     f"A WSN será atendida assim mesmo, pelo melhor disponível; a lacuna é de "
                     f"treinamento, não de capacidade.")
            else:
                _log(f"[EXPERTISE] {i} tem alvo {r_txt} — {len(below)} de {total_i} pessoa(s) "
                     f"abaixo do alvo, priorizadas por último: {', '.join(sorted(below)[:6])}")
        if not expertise_below:
            _log("[EXPERTISE] Nenhum par abaixo do nível alvo.")

    skipped = sorted(set(J) - allocatable)
    if skipped:
        _log(f"[SETUP] Pessoas sem pares qualificados ignoradas: {', '.join(skipped[:8])}")
    J = sorted(allocatable)
    pairs_by_j = {j: list(pairs_by_j.get(j, [])) for j in J}

    _log(f"[SETUP] Pares qualificados: {len(qualified_pairs)}")
    _prog(20, f"Criando modelo Gurobi — {len(qualified_pairs)} pares...")

    # ── Step 3: Build Gurobi model ───────────────────────────────
    model = gp.Model("optvision_workforce")
    model.Params.OutputFlag = 1
    model.Params.MIPGap     = gap_pct / 100.0

    # Decision variables
    X = model.addVars(qualified_pairs, lb=0.0, vtype=GRB.CONTINUOUS, name="X")   # normal hours
    H = model.addVars(qualified_pairs, lb=0.0, vtype=GRB.CONTINUOUS, name="H")   # overtime hours
    U = model.addVars(I,               lb=0.0, vtype=GRB.CONTINUOUS, name="U")   # unmet demand
    y = model.addVars(J,               vtype=GRB.BINARY,             name="YOT") # person uses OT
    A = model.addVars(qualified_pairs, vtype=GRB.BINARY,             name="A")   # pair active

    # Pre-tighten U[i].lb with structurally forced minimum unmet demand.
    # Providing explicit lower bounds saves Gurobi branching time in Phase 1,
    # especially when TURNOS/LH constraints create tight per-WSN capacity caps.
    #
    # Every capacity below is in CLOCK hours, so with the speed multipliers on it has to be
    # converted to delivered hours before being subtracted from demand — at the BEST multiplier
    # any pair of that WSN can reach. Anything tighter would be a bound on a solution the model
    # can actually build, and Gurobi would return forced unmet demand that does not exist.
    for i in I:
        d_i = demand_by_wsn.get(i, 0.0)
        forced_lb = 0.0
        best_m = max((_speed(i, j) for (_, j) in pairs_by_i.get(i, [])), default=1.0)
        if i in effective_wsn_max_hours:
            max_h_i = effective_wsn_max_hours[i]
            max_p_i = effective_wsn_max_people.get(i, len(pairs_by_i.get(i, [])))
            forced_lb = max(forced_lb, d_i - max_p_i * max_h_i * best_m)
        if i in effective_wsn_max_people:
            max_p = effective_wsn_max_people[i]
            caps_i = sorted(
                (total_cap_by_j[j] for (_, j) in pairs_by_i.get(i, [])),
                reverse=True,
            )
            forced_lb = max(forced_lb, d_i - sum(caps_i[:max_p]) * best_m)
        if forced_lb > RESULT_REPORT_EPSILON_HOURS:
            U[i].lb = forced_lb

    usage_decision_j = [j for j in J if j not in {p for p in forced_people if p in allocatable}]
    z: dict = {}
    if usage_decision_j:
        z = model.addVars(usage_decision_j, vtype=GRB.BINARY, name="ZUSE")

    z_expr: dict[str, Any] = {
        j: (1.0 if j in forced_people else z[j])
        for j in J
    }

    must_use = set(forced_people) & allocatable
    # use_all_people=True means all people are *eligible* (already handled by
    # building J from the full Excel data). It does NOT force every person to be
    # active — Phase 5 minimises who is actually used.

    qualified_pairs_set = set(qualified_pairs)

    def _scaled_pair_min_targets(
        pair_pct_map: dict[tuple[str, str], float],
        cap_by_person: dict[str, float],
        cap_by_wsn: dict[str, float] | None = None,
    ) -> dict[tuple[str, str], float]:
        """Convert pair % targets to feasible minimum-hours by scaling per-person and per-WSN."""
        raw_targets_by_person: dict[str, list[tuple[tuple[str, str], float]]] = {}
        for pair, pct in pair_pct_map.items():
            i, j = pair
            if pair not in qualified_pairs_set:
                continue
            pct_clamped = max(0.0, min(MANUAL_ALLOCATION_PCT_CAP, _safe_float(pct)))
            if pct_clamped <= 0.0:
                continue
            raw_target = cap_by_person.get(j, 0.0) * (pct_clamped / 100.0)
            if cap_by_wsn is not None:
                raw_target = min(raw_target, cap_by_wsn.get(i, 0.0))
            if raw_target <= 1e-9:
                continue
            raw_targets_by_person.setdefault(j, []).append((pair, raw_target))

        out: dict[tuple[str, str], float] = {}
        for j, targets in raw_targets_by_person.items():
            cap_j = max(0.0, cap_by_person.get(j, 0.0))
            raw_sum = sum(v for _, v in targets)
            if raw_sum <= 0.0:
                continue
            scale = min(1.0, cap_j / raw_sum) if cap_j > 0.0 else 0.0
            for pair, raw_v in targets:
                v = raw_v * scale
                if v > 1e-9:
                    out[pair] = v

        if cap_by_wsn is not None:
            targets_by_wsn: dict[str, list[tuple[tuple[str, str], float]]] = {}
            for pair, v in out.items():
                i, _j = pair
                targets_by_wsn.setdefault(i, []).append((pair, v))

            for i, targets in targets_by_wsn.items():
                cap_i = max(0.0, cap_by_wsn.get(i, 0.0))
                total_i = sum(v for _, v in targets)
                if total_i <= 0.0:
                    continue
                scale_i = min(1.0, cap_i / total_i) if cap_i > 0.0 else 0.0
                if scale_i >= 0.999999:
                    continue
                for pair, v in targets:
                    nv = v * scale_i
                    if nv > 1e-9:
                        out[pair] = nv
                    else:
                        out.pop(pair, None)

        return out

    # Minimum normal hours per fixed/direct pair.
    norm_pair_pct_targets: dict[tuple[str, str], float] = {}
    for pair, pct in forced_pair_hc.items():
        norm_pair_pct_targets[pair] = max(norm_pair_pct_targets.get(pair, 0.0), _safe_float(pct))
    for pair, pct in direct_pair_hc.items():
        norm_pair_pct_targets[pair] = max(norm_pair_pct_targets.get(pair, 0.0), _safe_float(pct))

    fixed_pair_min_norm = _scaled_pair_min_targets(
        norm_pair_pct_targets,
        norm_cap_by_j,
        demand_by_wsn,
    )

    # Minimum OT hours per pair from fixed OT %; scaled by person OT capacity.
    fixed_pair_min_ot = _scaled_pair_min_targets(
        fixed_ot_pct,
        extra_cap_by_j,
        None,
    )

    # Maximum normal/OT per pair from limit maps.
    max_pair_norm_hours: dict[tuple[str, str], float] = {}
    for pair, pct in max_pair_pct.items():
        i, j = pair
        if pair not in qualified_pairs_set:
            continue
        pct_c = max(0.0, min(MANUAL_ALLOCATION_PCT_CAP, _safe_float(pct)))
        max_pair_norm_hours[pair] = norm_cap_by_j.get(j, 0.0) * (pct_c / 100.0)

    max_pair_ot_hours: dict[tuple[str, str], float] = {}
    for pair, pct in max_ot_pct.items():
        i, j = pair
        if pair not in qualified_pairs_set:
            continue
        pct_c = max(0.0, min(MANUAL_ALLOCATION_PCT_CAP, _safe_float(pct)))
        max_pair_ot_hours[pair] = extra_cap_by_j.get(j, 0.0) * (pct_c / 100.0)

    # ── Core constraints ─────────────────────────────────────────
    # (1) Demand coverage: demand = covered + unmet
    #
    # With the speed multipliers on, the left side counts DELIVERED demand-hours, not clock
    # hours: a pair below its station's target closes less than an hour of demand per hour
    # worked, one above it closes more. X and H stay clock hours everywhere else — capacity,
    # overtime and utilisation are all unchanged by this.
    for i in I:
        covered = gp.quicksum(_speed(*p) * (X[p] + H[p]) for p in pairs_by_i.get(i, []))
        model.addConstr(
            covered + U[i] == demand_by_wsn.get(i, 0.0),
            name=f"demand_{i}",
        )

    # (2) Normal capacity per person
    for j in J:
        model.addConstr(
            gp.quicksum(X[p] for p in pairs_by_j.get(j, [])) <= norm_cap_by_j[j] * z_expr[j],
            name=f"norm_cap_{j}",
        )

    # (3) OT capacity per person
    for j in J:
        model.addConstr(
            gp.quicksum(H[p] for p in pairs_by_j.get(j, [])) <= extra_cap_by_j[j] * y[j],
            name=f"ot_cap_{j}",
        )
        # OT only if person used
        model.addConstr(y[j] <= z_expr[j], name=f"ot_use_{j}")

    # (4) Pair active flag — per-pair tight big_M and minimum block hours
    # pair_big_m = min(person capacity, WSN demand) — much tighter than global big_M
    # pair_min_block: if pair is active, allocation >= min half-day block (prevents 0h allocations)
    _half_day = _half_day_hours(top_pct)
    for i, j in qualified_pairs:
        di = demand_by_wsn.get(i, 0.0)
        # di is DEMAND hours and the bound is on CLOCK hours, so it has to be divided by the
        # pair's speed. Without this a below-target pair (m < 1) could never cover its station
        # alone: closing di hours of demand takes di/m hours of work, and a big-M of di would
        # cut that solution off — silently, as unmet demand. m = 1 leaves the bound as it was.
        _m_ij = _speed(i, j)
        pair_big_m = min(total_cap_by_j[j], di / _m_ij) if di > 0.0 else total_cap_by_j[j]
        pair_big_m = max(pair_big_m, 1e-6)
        model.addConstr(X[i, j] + H[i, j] <= pair_big_m * A[i, j], name=f"pair_act_{i}_{j}")
        # Minimum block: if pair is active, must allocate at least half a day (prevents 0h/tiny allocations)
        min_block = min(_half_day, di, pair_big_m) if di > 0.0 else 0.0
        if min_block > 1e-9:
            model.addConstr(X[i, j] + H[i, j] >= min_block * A[i, j], name=f"pair_min_{i}_{j}")
        # Pair active only if person is used
        if j in z:
            model.addConstr(A[i, j] <= z[j], name=f"pair_use_{i}_{j}")
        # Per-pair OT cap: OT ≤ 50 % of normal hours at same WSN.
        # Prevents OT-only allocations (H > 0 while X = 0) and excessive OT.
        model.addConstr(H[i, j] <= 0.5 * X[i, j], name=f"ot_pair_cap_{i}_{j}")

    # ── (5) Expertise anchor: no crew without a proficient person ─────────────
    # "Toda WSN com 2+ pessoas e alocação não vazia tem ao menos um nível 3."
    #
    # Written CONDITIONALLY — `Σ_{q nível 3} A[i,q] ≥ A[i,p]` for every non-proficient pair —
    # rather than as `Σ ≥ 1`. The unconditional form would force the station to open a pair
    # even when the optimum leaves it empty, turning an anchor rule into a "must allocate here"
    # rule it was never meant to be.
    #
    # Added at BUILD time, before the phase-5 binary fixing that precedes phase 6: a hard
    # constraint introduced after that fixing is the documented recipe for STATUS_3 by rounding.
    #
    # This is the ONLY hard expertise rule in the model — the target level itself is a phase-4
    # preference and removes nobody. Being hard, it CAN infeasible the model, so a station with
    # no proficient candidate is skipped with a warning rather than being handed an
    # unsatisfiable constraint.
    if expertise_on and anchor_on:
        anchored, anchor_skipped = 0, []
        for i in I:
            pairs_i = pairs_by_i.get(i, [])
            if len(pairs_i) < 2:
                continue
            proficient = [p for p in pairs_i if pair_level.get(i, {}).get(p[1], 0) >= 3]
            others     = [p for p in pairs_i if pair_level.get(i, {}).get(p[1], 0) < 3]
            if not proficient:
                anchor_skipped.append(i)
                continue
            if not others:
                continue      # every candidate is proficient; the rule is already satisfied
            anchor_expr = gp.quicksum(A[p] for p in proficient)
            for p in others:
                model.addConstr(anchor_expr >= A[p], name=f"anchor_{i}_{p[1]}")
            anchored += 1
        _log(f"[EXPERTISE] Âncora de proficiência aplicada a {anchored} WSN(s).")
        if anchor_skipped:
            _log(f"[EXPERTISE] Âncora IGNORADA em {len(anchor_skipped)} WSN(s) sem nenhuma pessoa "
                 f"nível Alta: {', '.join(anchor_skipped[:8])}"
                 + (" …" if len(anchor_skipped) > 8 else ""))

        # Fixed pair presence (explicit + implied by pair-level fixed overrides).
        if (i, j) in required_pairs or (i, j) in fixed_pair_min_norm or (i, j) in fixed_pair_min_ot:
            model.addConstr(A[i, j] == 1.0, name=f"req_pair_{i}_{j}")

        # Fixed pair normal-hour floor. For 100%, this pushes X to roughly the
        # person's full normal capacity in that WSN (or WSN demand cap), i.e.
        # "maximo normal possivel" under model feasibility.
        min_norm_target = fixed_pair_min_norm.get((i, j), 0.0)
        if min_norm_target > 1e-9:
            model.addConstr(X[i, j] >= min_norm_target, name=f"fix_pair_norm_{i}_{j}")

        min_ot_target = fixed_pair_min_ot.get((i, j), 0.0)
        if min_ot_target > 1e-9:
            model.addConstr(H[i, j] >= min_ot_target, name=f"fix_pair_ot_{i}_{j}")

        max_norm_target = max_pair_norm_hours.get((i, j), None)
        if max_norm_target is not None:
            model.addConstr(X[i, j] <= max(0.0, max_norm_target), name=f"max_pair_norm_{i}_{j}")

        max_ot_target = max_pair_ot_hours.get((i, j), None)
        if max_ot_target is not None:
            model.addConstr(H[i, j] <= max(0.0, max_ot_target), name=f"max_pair_ot_{i}_{j}")

    # Person used → at least one active pair (backlink)
    for j in J:
        if j in z and pairs_by_j.get(j):
            model.addConstr(
                gp.quicksum(A[p] for p in pairs_by_j[j]) >= z[j],
                name=f"used_backlink_{j}",
            )

    # (5) Must-use people (z = 1)
    for j in must_use:
        if j in z:
            model.addConstr(z[j] == 1.0, name=f"must_use_{j}")

    # (5b) Usar todo o Headcount Disponível — maximise the number of ELIGIBLE people
    # who are active, as a STRONG soft incentive (top lexicographic priority below).
    # A person is eligible iff they have at least one qualified pair (which already
    # encodes skill + workstation/project eligibility). We minimise Σ(1 − z[j]) over
    # eligible free people = the count left idle. As a soft objective it forces
    # everyone active whenever feasible and, when demand/WSN caps genuinely cannot fit
    # everyone, allocates as many as possible — leaving idle only those with no
    # feasible assignment. No hard constraint ⇒ never makes the model infeasible.
    headcount_idle_total: Any = gp.LinExpr(0.0)
    if use_all_headcount:
        eligible_free = [j for j in usage_decision_j if j in z and pairs_by_j.get(j)]
        if eligible_free:
            headcount_idle_total = gp.quicksum((1 - z[j]) for j in eligible_free)
        n_no_pair = len([j for j in J if not pairs_by_j.get(j)])
        _log(f"[SETUP] Usar todo o Headcount: incentivo p/ ativar {len(eligible_free)} pessoa(s) elegível(is)  "
             f"(forçadas={len(must_use)}, sem par viável={n_no_pair})")

    # (6) WSN max distinct people (from shift defaults or manual override)
    for i, max_p in effective_wsn_max_people.items():
        wsn_pairs = pairs_by_i.get(i, [])
        if wsn_pairs:
            model.addConstr(
                gp.quicksum(A[p] for p in wsn_pairs) <= max_p,
                name=f"wsn_max_{i}",
            )

    # (6b) Per-person/per-shift max hours — lh caps each individual person,
    # not the WSN total.  (sum constraint would wrongly allow one person to
    # absorb all hours while others do zero.)
    for i, max_h in effective_wsn_max_hours.items():
        wsn_pairs = pairs_by_i.get(i, [])
        for p in wsn_pairs:
            model.addConstr(
                X[p] + H[p] <= max_h,
                name=f"wsn_maxh_{i}_{p[1]}",
            )

    model.update()
    _log(f"[MODEL] Core — Variáveis: {model.NumVars}  Restrições: {model.NumConstrs}")
    _prog(22, "Montando expressões de objetivo...")

    # ── Step 4: Objective expressions ────────────────────────────
    unmet_total    = gp.quicksum(U[i] for i in I)
    overtime_total = gp.quicksum(H[p] for p in qualified_pairs)
    Hmax           = model.addVar(lb=0.0, vtype=GRB.CONTINUOUS, name="Hmax")

    # Hmax per-person (OT peak per person, not per pair — better load balancing)
    for j in J:
        pairs_j = pairs_by_j.get(j, [])
        if pairs_j:
            h_person = gp.quicksum(H[p] for p in pairs_j)
            model.addConstr(Hmax >= h_person, name=f"hmax_person_{j}")

    # Phase 3 WSN OT concentration: penalise uneven OT distribution within a WSN
    # wsn_ot_concentration_total = sum over WSNs of max_person_ot - avg_person_ot
    wsn_ot_concentration_total: Any = gp.LinExpr(0.0)
    ot_wsns = [i for i in I if len(pairs_by_i.get(i, [])) >= 2]
    if ot_wsns:
        wsn_ot_peak  = model.addVars(ot_wsns, lb=0.0, vtype=GRB.CONTINUOUS, name="WOTPEAK")
        wsn_ot_excess = model.addVars(ot_wsns, lb=0.0, vtype=GRB.CONTINUOUS, name="WOTEXC")
        for i in ot_wsns:
            n_cand = len(pairs_by_i[i])
            total_ot_i = gp.quicksum(H[p] for p in pairs_by_i[i])
            for p in pairs_by_i[i]:
                model.addConstr(wsn_ot_peak[i] >= H[p], name=f"wotpeak_{i}_{p[1]}")
            # excess = peak - avg (if positive → concentrated OT on one person)
            model.addConstr(
                wsn_ot_excess[i] >= wsn_ot_peak[i] - (1.0 / n_cand) * total_ot_i,
                name=f"wotexc_{i}",
            )
        wsn_ot_concentration_total = gp.quicksum(wsn_ot_excess[i] for i in ot_wsns)

    # Phase 2: coverage-priority weights (scarcity + NIVEL + small-WSN bias)
    _demand_vals  = {i: max(1e-9, demand_by_wsn.get(i, 1e-9)) for i in I}
    relative_unmet = gp.quicksum(U[i] / _demand_vals[i] for i in I)

    # Rmax = max relative shortage across WSNs (keeps worst-covered WSN in check)
    # Added with small weight (0.02) in Phase 2 — mirrors original code
    Rmax = model.addVar(lb=0.0, vtype=GRB.CONTINUOUS, name="Rmax")
    for i in I:
        model.addConstr(U[i] <= _demand_vals[i] * Rmax, name=f"rmax_{i}")
    _max_scarcity = max((1.0 / len(pairs_by_i.get(i, [1])) for i in I if pairs_by_i.get(i)), default=1.0) or 1.0
    _max_nivel    = max(nivel_wt_demand.get(i, 0.0) / max(demand_by_wsn.get(i, 1e-9), 1e-9) for i in I) or 1.0
    GAMMA, BETA   = 0.5, 1.0

    coverage_w: dict[str, float] = {}
    for i in I:
        d_i   = max(1e-9, demand_by_wsn.get(i, 1e-9))
        scar  = (1.0 / len(pairs_by_i.get(i, [1]))) / _max_scarcity if pairs_by_i.get(i) else 0.0
        nivel = (nivel_wt_demand.get(i, 0.0) / d_i) / _max_nivel
        w_s   = 1.0 / (d_i ** 1.35)
        coverage_w[i] = w_s * (1.0 + GAMMA * scar) * (1.0 + BETA * nivel)

    coverage_unmet = gp.quicksum(coverage_w[i] * U[i] for i in I)

    # Phase 5: cleanup — count active people + weighted pair count
    # (uses existing z / A binary variables, no new vars needed)
    n_forced = len(J) - len(usage_decision_j)
    people_used_total = gp.LinExpr(float(n_forced))
    if usage_decision_j:
        people_used_total = people_used_total + gp.quicksum(z[j] for j in usage_decision_j)
    pair_used_total    = gp.quicksum(A[p] for p in qualified_pairs)
    pair_cleanup_total = people_used_total + 0.05 * pair_used_total
    # When "Usar todo o Headcount" is on, the activation stage instead MAXIMISES active
    # eligible people (minimise idle = Σ(1−z[j])) — and it is the IDLE COUNT ALONE.
    #
    # It used to carry the same 0.05·pair term as the cleanup objective. That term has to go,
    # because this stage's objective is now LOCKED before the balance stage runs (see the phase
    # plan): locking the composite would also pin the pair count, and the balance stage needs to
    # be free to open a pair to move hours onto an under-loaded person. Trimming redundant pairs
    # is not lost — the balance stage's dispersion term does exactly that, and now runs after.
    headcount_phase5_obj = headcount_idle_total

    # Pre-compute per-person total-load LinExpr (reused in phases 4 & 6)
    total_load_expr: dict[str, Any] = {
        j: (gp.quicksum(X[p] + H[p] for p in pairs_by_j[j]) if pairs_by_j.get(j) else gp.LinExpr(0.0))
        for j in J
    }

    model.update()

    # ── Phase 4 lazy prep ────────────────────────────────────────
    # Add fragmentation + load-balance variables and constraints only when
    # phase 4 is actually requested, so model stays compact for fewer phases.
    #
    # Objectives:
    #   • dispersion_total:  sum_j (total_load[j] - dominant_wsn_load[j])
    #                        → concentrates each person in fewer WSNs
    #   • frag_cap_slack:    soft penalty when total_load[j] > FRAG_RATIO × F[j]
    #   • FRAG_BALANCE_WEIGHT × (Lmax - Lmin): equalises load across used people
    fragmentation_obj: Any = gp.LinExpr(0.0)
    if phase_limit >= 4:
        fragmentation_people = [j for j in J if len(pairs_by_j.get(j, [])) >= 2]
        # Explicit tight bounds on Lmax/Lmin help the LP relaxation:
        #   0 ≤ Lmin ≤ Lmax ≤ max person capacity.
        _lm_cap = max((total_cap_by_j[j] for j in J if pairs_by_j.get(j)), default=1.0)
        Lmax_var = model.addVar(lb=0.0, ub=_lm_cap, vtype=GRB.CONTINUOUS, name="LMAX")
        Lmin_var = model.addVar(lb=0.0, ub=_lm_cap, vtype=GRB.CONTINUOUS, name="LMIN")
        # Only add Lmax/Lmin tracking constraints for people who actually have pairs.
        # People with zero pairs can never be active (their load is 0 regardless of z),
        # so their Lmax/Lmin constraints are trivially satisfied and add no value but
        # do add constraints that slow down the MIP solve.
        # Restrict the balance set to people whose load is genuinely FREE to move.
        # A person with at least one pair but ZERO reachable capacity (every pair pinned
        # to X.ub=H.ub=0 by manual restrictions / blocks) has load ≡ 0 no matter what, so
        # tracking them adds nothing but pulls Lmin toward 0 and widens the artificial
        # Lmax−Lmin basin (a flat region the solver wanders in). Excluding them changes NO
        # business logic — their load is identically 0 either way — but tightens the
        # balance objective to the people it is actually meant to balance. People whose
        # capacity is real (even if forced) STAY in the set: their load still counts.
        def _has_reachable_load(j: str) -> bool:
            for pair in pairs_by_j.get(j, []):
                try:
                    if float(X[pair].ub) > 0.0 or float(H[pair].ub) > 0.0:
                        return True
                except Exception:
                    return True   # can't prove it's dead → keep it (safe default)
            return False

        active_people_lm = [j for j in J if pairs_by_j.get(j) and _has_reachable_load(j)]

        # Lmax/Lmin track the range of loads among USED people. Semantics (unchanged):
        #   • person USED (z=1):  Lmax ≥ load[j]  AND  Lmin ≤ load[j]
        #   • person UNUSED (z=0): no contribution to the range (load=0 ignored)
        # Implementation change (IDENTICAL feasible region, sharper relaxation):
        #   The previous big-M disjunctions were the weakest part of the Phase-4 LP — the
        #   Lmin side in particular needed the GLOBAL M (a person's own capacity is NOT a
        #   valid M for Lmin: when z=0, load=0 makes the row "Lmin ≤ M", which must stay
        #   ≥ the largest feasible Lmin = max used load, i.e. M must be the global cap).
        #   A loose global big-M on a min-tracking row weakens the bound and is a primary
        #   reason Phase 4 stalls at a non-zero gap. Replacing both rows with INDICATOR
        #   constraints removes the big-M entirely (Gurobi enforces "z=1 ⇒ row" exactly,
        #   z=0 ⇒ row dropped), so the relaxation is tighter and the bound moves. For
        #   FORCED people (z_expr is the constant 1.0) the bound holds unconditionally —
        #   emit it as a plain linear constraint (no indicator var exists there).
        for j in active_people_lm:
            ze = z_expr[j]
            if isinstance(ze, (int, float)):
                # Forced/active constant (z_expr == 1.0): bound is unconditional.
                model.addConstr(Lmax_var >= total_load_expr[j], name=f"lmax_used_{j}")
                model.addConstr(Lmin_var <= total_load_expr[j], name=f"lmin_used_{j}")
            else:
                # Free binary z[j]: z=1 ⇒ bound active; z=0 ⇒ bound dropped (no big-M).
                model.addGenConstrIndicator(
                    ze, True, Lmax_var - total_load_expr[j], GRB.GREATER_EQUAL, 0.0,
                    name=f"lmax_used_{j}",
                )
                model.addGenConstrIndicator(
                    ze, True, Lmin_var - total_load_expr[j], GRB.LESS_EQUAL, 0.0,
                    name=f"lmin_used_{j}",
                )

        # Valid cut: the max used load is never below the min used load. Cheap and
        # tightens the relaxation (objective minimises Lmax−Lmin ≥ 0).
        model.addConstr(Lmax_var >= Lmin_var, name="lmax_ge_lmin")

        # ── Term normalization (F2) — CONSTANT scaling only ──────────────────────
        # The three Phase-4 terms are all in HOURS but on wildly different magnitudes:
        # dispersion_total and Σfrag_cap_slacks SUM over people (→ hundreds/thousands),
        # while 0.15·(Lmax−Lmin) is a single bounded term (→ tens). Summed raw, the
        # load-balance term is dwarfed — it falls below the 0.5h MIPGapAbs and becomes
        # objective NOISE, so many plans look "equal" → flat plateau the solver wanders.
        # Fix: divide each term by a CONSTANT characteristic scale so all three become
        # dimensionless per-person fractions of one person's capacity, on a comparable
        # range. These are pure constants (no new vars, LP relaxation unchanged); only
        # the relative emphasis is fixed, so the SET of optimal-structure plans is the
        # same — only tie-breaking among near-equal balanced plans changes (the intent).
        # Relative priority is PRESERVED: dispersion stays dominant (weight 1.0), balance
        # a smaller nudge (FRAG_BALANCE_WEIGHT), cap-slack a moderate guard — exactly the
        # original ordering, just on a common scale instead of raw incomparable hours.
        _lm_scale = max(1e-6, _lm_cap)                      # one person's max load (hours)
        _n_frag   = max(1, len(fragmentation_people))       # people in the dispersion sum
        # balance: fraction of one person's capacity that the used-load RANGE spans.
        _bal_w = FRAG_BALANCE_WEIGHT_ALL_HC if use_all_headcount else FRAG_BALANCE_WEIGHT
        frag_terms: list[Any] = [
            _bal_w * ((Lmax_var - Lmin_var) / _lm_scale)
        ]

        if fragmentation_people:
            # F[j] = dominant WSN load for person j
            # Lower bounds: F[j] >= load on each WSN pair (LP max via lower bounds)
            # Upper bound:  F[j] <= total_load[j] when used  (required for bounded objective!)
            #               Without this upper bound, minimizing (total_load - F) → -∞ → STATUS_5
            F_vars           = model.addVars(fragmentation_people, lb=0.0, vtype=GRB.CONTINUOUS, name="FRAG")
            frag_cap_slacks  = model.addVars(fragmentation_people, lb=0.0, vtype=GRB.CONTINUOUS, name="FRAGCAP")
            for j in fragmentation_people:
                ze         = z_expr[j]
                person_cap = total_cap_by_j[j]
                for pair in pairs_by_j[j]:
                    # Sparsity: a pair that can never carry load (X.ub==H.ub==0) yields
                    # only the trivial F ≥ 0 — skip it. Same feasible region.
                    try:
                        if float(X[pair].ub) <= 0.0 and float(H[pair].ub) <= 0.0:
                            continue
                    except Exception:
                        pass
                    model.addConstr(F_vars[j] >= X[pair] + H[pair], name=f"frag_lb_{j}_{pair[0]}")
                # CRITICAL: upper bound so objective stays bounded.
                # When used (ze=1):  F <= total_load
                # When unused (ze=0): F <= total_load + person_cap  (trivially ok since load=0)
                model.addConstr(
                    F_vars[j] <= total_load_expr[j] + person_cap * (1.0 - ze),
                    name=f"frag_ub_{j}",
                )
                # Soft cap: total load ≤ FRAG_RATIO × dominant-WSN load (+ slack)
                model.addConstr(
                    total_load_expr[j] <= FRAG_RATIO_HARD_CAP * F_vars[j] + frag_cap_slacks[j],
                    name=f"frag_cap_{j}",
                )
            dispersion_total = gp.quicksum(total_load_expr[j] - F_vars[j] for j in fragmentation_people)
            frag_cap_total   = gp.quicksum(frag_cap_slacks[j] for j in fragmentation_people)
            # Both sum over people → divide by (capacity × #people) to get the AVERAGE
            # per-person spread / overflow as a capacity fraction — same scale as balance.
            _disp_scale = _lm_scale * _n_frag
            frag_terms += [
                dispersion_total / _disp_scale,
                frag_cap_total   / _disp_scale,
            ]

        # ── Expertise, as phase-4 terms ──────────────────────────
        # Together the two terms below are Σ |e[p,w] − r[w]| · (X+H): the crew's DISPERSION
        # around the station's target, measured per person and weighted by the hours that person
        # actually works there. Hours-weighted, not headcount-weighted — an hour spent by the
        # wrong person is the thing being minimised, so half a day of mismatch costs half of
        # what a full day of the same mismatch costs.
        #
        # Unless the speed multipliers are on, this is the ONLY place the target level acts on
        # the run. Both terms are functions of
        # ALLOCATED HOURS, and both live in phase 4 rather than phase 2 (contrary to the original
        # proposal) for the same reason: every phase-2 term is a function of UNMET demand
        # (U, Rmax), coefficients around 1e-4…1e-1, whose total phase 1 has already pinned by
        # lex-fix — a term worth thousands of hours would swamp the coverage priority it was
        # meant to break ties within. Phase 4's terms are already scaled in allocated hours.
        #
        # Both are scaled like their neighbours (per-person capacity average), so their weights
        # mean the same thing FRAG_BALANCE_WEIGHT does.
        #
        # Phases 1–3 are lex-fixed before this expression is minimised, which is what makes the
        # shortfall term a PRIORITY and not a gate: it can never buy back coverage, and it can
        # never trade away overtime. It only decides who fills a slot when the choice is free.
        if expertise_on:
            # Σ (r[w] − e[p,w])⁺ · (X + H): the cost of using someone below the station's
            # target. Under-qualified people stay fully allocatable — this makes them the
            # LAST resort, not an excluded one.
            short_terms = []
            for (i, j) in qualified_pairs:
                gap = _shortfall(i, j)
                if gap > 0:
                    short_terms.append(gap * (X[i, j] + H[i, j]))
            if short_terms and EXPERTISE_SHORTFALL_WEIGHT > 0.0:
                frag_terms.append(
                    EXPERTISE_SHORTFALL_WEIGHT * gp.quicksum(short_terms) / max(1e-9, _lm_scale)
                )
                _log(f"[EXPERTISE] Termo de déficit de nível na Fase 4: "
                     f"{len(short_terms)} par(es) abaixo do alvo, peso {EXPERTISE_SHORTFALL_WEIGHT}")

            # Σ (e[p,w] − r[w])⁺ · (X + H): the mirror term, and the half that turns the
            # shortfall charge into a symmetric dispersion charge. Discourages parking proficient
            # people on undemanding stations, which creates artificial scarcity on the critical
            # ones — anyone already at or above the target is otherwise indifferent here.
            if EXPERTISE_OVERQUAL_WEIGHT > 0.0:
                overqual_terms = []
                for (i, j) in qualified_pairs:
                    # max(0, ·) on both sides: the two terms must never overlap, or a single
                    # pair would be charged twice for one distance.
                    excess = max(0, pair_level.get(i, {}).get(j, 0) - req_level.get(i, 0))
                    if excess > 0:
                        overqual_terms.append(excess * (X[i, j] + H[i, j]))
                if overqual_terms:
                    frag_terms.append(
                        EXPERTISE_OVERQUAL_WEIGHT * gp.quicksum(overqual_terms) / max(1e-9, _lm_scale)
                    )
                    _log(f"[EXPERTISE] Termo de sobrequalificação na Fase 4: "
                         f"{len(overqual_terms)} par(es), peso {EXPERTISE_OVERQUAL_WEIGHT}. "
                         f"Com o termo de déficit, a Fase 4 minimiza a DISPERSÃO do nível da "
                         f"equipe em torno do alvo, pessoa a pessoa.")

        fragmentation_obj = gp.quicksum(frag_terms)
        model.update()
        _log(f"[PHASE4 PREP] frag_people={len(fragmentation_people)}  Lmax/Lmin adicionados")

    # ── Phase 6 lazy prep ────────────────────────────────────────
    # Soft utilisation variables added only when phase 6 is requested.
    #
    # S[j]:              slack below MIN_UTIL_RATIO × total_cap (low-utilisation penalty)
    # full_load_slack[j]: slack below norm_cap (not reaching full-day equivalency)
    utilization_obj: Any = gp.LinExpr(0.0)
    if phase_limit >= 6:
        S_vars          = model.addVars(J, lb=0.0, vtype=GRB.CONTINUOUS, name="SLOW")
        full_load_slack = model.addVars(J, lb=0.0, vtype=GRB.CONTINUOUS, name="FULLLOAD")
        for j in J:
            ze = z_expr[j]
            model.addConstr(
                total_load_expr[j] + S_vars[j] >= MIN_UTIL_RATIO * total_cap_by_j[j] * ze,
                name=f"min_util_{j}",
            )
            model.addConstr(
                total_load_expr[j] + full_load_slack[j] >= norm_cap_by_j[j] * ze,
                name=f"full_load_{j}",
            )
        utilization_obj = (
            gp.quicksum(S_vars[j] for j in J)
            + gp.quicksum(full_load_slack[j] for j in J)
        )
        model.update()
        _log(f"[PHASE6 PREP] {2 * len(J)} variáveis de utilização adicionadas")

    model.update()
    _log(f"[MODEL] Total — Variáveis: {model.NumVars}  Restrições: {model.NumConstrs}")
    _prog(25, "Modelo criado. Iniciando fases de otimização...")

    phase_metrics: list[dict] = []
    phase_fix_constraints: list = []

    # ── Values of the LAST solved phase, by variable name ─────────────────────────────────
    # Gurobi DISCARDS the solution the moment the model is modified, and `Var.X` then raises
    # "Unable to retrieve attribute 'X'". Every phase ends by modifying the model — the
    # lexicographic lock is a new constraint, the pre-Phase-6 freeze changes bounds — so
    # anything reading a phase's result AFTER that point reads nothing at all. That is not a
    # hypothetical: the Phase-3 and Phase-4 warm starts were logging "Aviso (ignorado): Unable
    # to retrieve attribute 'X'" on every run (so Gurobi entered those phases cold), and the
    # pre-Phase-6 snapshot was silently capturing an EMPTY dict, which turned the Phase-6
    # fallback into an all-zero allocation instead of the rescue it exists to be.
    #
    # `_solve_phase` therefore records every variable's value while it is still readable, and
    # everything downstream reads THIS instead of `.X`.
    _last_values: dict[str, float] = {}

    def _val(var: Any, default: float = 0.0) -> float:
        """Value of `var` in the last solved phase (see `_last_values`)."""
        try:
            return _last_values.get(var.VarName, default)
        except Exception:
            return default

    def _capture_solution() -> None:
        _last_values.clear()
        try:
            for v in model.getVars():
                try:
                    _last_values[v.VarName] = float(v.X)
                except Exception:
                    pass
        except Exception:
            pass

    def _run_iis(idx: int, name: str) -> None:
        """Compute and log the IIS (minimal infeasible constraint set) so the
        root cause of an infeasible phase is visible in the optimization log."""
        try:
            _log(f"[PHASE {idx}] INFEASIBLE — calculando IIS (subsistema inconsistente irredutível)...")
            model.computeIIS()
            iis_constrs = [c.ConstrName for c in model.getConstrs() if c.IISConstr]
            # Bound-IIS members reveal over-tight fixed bounds (e.g. pinned binaries).
            iis_lb = [v.VarName for v in model.getVars() if getattr(v, "IISLB", 0)]
            iis_ub = [v.VarName for v in model.getVars() if getattr(v, "IISUB", 0)]
            _log(f"[PHASE {idx} IIS] {len(iis_constrs)} restrição(ões), "
                 f"{len(iis_lb)} limite(s) inferior(es), {len(iis_ub)} limite(s) superior(es) no conflito")
            # Group constraint members by prefix (e.g. 'lex_fix_unmet', 'min_util_', 'frag_cap_')
            from collections import Counter as _Counter
            def _prefix(nm: str) -> str:
                base = nm.rsplit("_", 1)[0] if any(ch.isdigit() for ch in nm.rsplit("_", 1)[-1]) else nm
                return base
            grp = _Counter(_prefix(nm) for nm in iis_constrs)
            for pfx, cnt in grp.most_common(12):
                _log(f"[PHASE {idx} IIS]   {pfx}: {cnt}")
            # The lex-fix constraints from earlier phases are the usual culprit when
            # Phase-5 binary rounding pushes an earlier objective above its locked bound.
            lex_hits = [nm for nm in iis_constrs if nm.startswith("lex_fix")]
            if lex_hits:
                _log(f"[PHASE {idx} IIS] CAUSA PROVÁVEL: fixações lexicográficas {sorted(set(lex_hits))} "
                     f"em conflito com binários fixados da Fase 5 (arredondamento).")
        except Exception as _iis_err:
            _log(f"[PHASE {idx} IIS] Não foi possível calcular IIS: {_iis_err}")

    def _solve_phase(
        idx: int,
        name: str,
        objective,
        progress_pct: int,
        fix_name: str | None,
        add_fix: bool = False,
        optional: bool = False,
    ) -> float | None:
        """Solve one lexicographic phase.

        optional=True marks an *improvement* phase (Phase 6): if it proves
        infeasible or finds no solution, the run is NOT aborted — the IIS is
        logged, the best feasible solution from prior phases is kept, and the
        function returns None so the caller continues to finalization.
        """
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError(f"Parada solicitada antes da fase {idx}.")

        model.setObjective(objective, GRB.MINIMIZE)
        model.Params.TimeLimit = time_s

        abs_gap = _phase_abs_gap(idx)
        if abs_gap is not None:
            # Phase 4's objective was normalized (F2) from raw HOURS to a dimensionless
            # per-person capacity fraction, so its absolute-gap constant (PHASE4_ABS_GAP_
            # HOURS = 0.5 h) must be converted to the SAME units or it would be meaningless
            # (the whole normalized objective is < 1, so 0.5 "hours" would mean "always
            # converged"). Divide the 0.5 h tolerance by the per-person load scale used in
            # the balance term → the gap keeps its original "≈half a day" business meaning.
            if idx == 4:
                abs_gap = abs_gap / max(1e-6, _lm_scale)
            model.Params.MIPGapAbs = abs_gap

        # Phase 5 only counts pairs/people — a slightly larger tolerance is
        # acceptable.  Use gap_pct + PHASE5_REL_GAP_EXTRA_PCT so the phase
        # exits well before spending 10 s chasing the last 1–2 pairs.
        if idx == 5:
            model.Params.MIPGap = min(0.15, (gap_pct + PHASE5_REL_GAP_EXTRA_PCT) / 100.0)

        # Phases 3 and 4 introduce new binary/continuous variables (y, Hmax,
        # wsn_ot_peak/excess, F, LMAX, LMIN, FRAGCAP) that have no prior solution.
        # Boost heuristics so Gurobi finds a good incumbent faster and closes
        # the initial gap without spending extra B&B nodes.
        if idx in (3, 4):
            model.Params.Heuristics = 0.15
        else:
            model.Params.Heuristics = 0.05  # restore default for all other phases

        # ── Phase-4-scoped search tuning (no business-logic change) ──────────────
        # Phase 4 (load-balance / fragmentation) is the phase that stalls at a non-zero
        # gap: its objective is permutation-symmetric (interchangeable people give equal
        # Lmax−Lmin) and the BOUND — not the incumbent — is what fails to move. The warm
        # start already supplies a good incumbent, so we steer the solver toward proving
        # optimality instead of polishing:
        #   • Symmetry=2  — aggressive symmetry detection collapses the many equivalent
        #     people-permutation solutions that otherwise get enumerated node-by-node.
        #   • MIPFocus=3  — focus on moving the best BOUND (the stalled quantity), rather
        #     than the default balance that keeps chasing incumbents.
        #   • Cuts=2      — aggressive cuts tighten the relaxation Phase 4's indicator /
        #     dispersion structure leaves loose, helping the bound close.
        #   • ImproveStartTime — after ~60% of the budget, switch to spending the rest on
        #     improving the incumbent, so a residual unprovable gap still yields the best
        #     feasible balanced plan instead of idling on the bound until TimeLimit.
        # All four are pure search parameters: identical feasible region, identical optimum.
        # Reset to Gurobi defaults (-1) on every other phase so nothing leaks across the
        # shared model between phases.
        if idx == 4:
            model.Params.Symmetry        = 2
            model.Params.MIPFocus        = 3
            model.Params.Cuts            = 2
            model.Params.ImproveStartTime = max(1.0, time_s * 0.6)
        else:
            model.Params.Symmetry        = -1
            model.Params.MIPFocus        = 0
            model.Params.Cuts            = -1
            model.Params.ImproveStartTime = GRB.INFINITY

        _prog(progress_pct, f"Fase {idx}/{phase_limit}: {name}")
        _log(f"[PHASE {idx}] {name}")

        # Live solver progress: emit ONE concise line every ~1.5 s while the MIP/LP
        # runs, so the terminal shows node count, incumbent, bound, gap%, elapsed,
        # simplex iterations and solution count in real time (not only at the end).
        _cb_state = {"t_last": 0.0, "obj_last": None}

        def _cb(m: Any, where: int) -> None:
            if stop_event is not None and stop_event.is_set():
                try:
                    m.terminate()
                except Exception:
                    pass
                return
            # Raw Gurobi message lines (kept for full detail / colorised in the UI).
            if where == GRB.Callback.MESSAGE:
                try:
                    msg = str(m.cbGet(GRB.Callback.MSG_STRING) or "").rstrip()
                    if msg:
                        _log(msg)
                except Exception:
                    pass
                return
            # Branch-and-bound progress (MIP) — concise live line, throttled to 1.5 s
            # or whenever the incumbent improves.
            if where == GRB.Callback.MIP:
                try:
                    now      = m.cbGet(GRB.Callback.RUNTIME)
                    objbst   = m.cbGet(GRB.Callback.MIP_OBJBST)   # best incumbent
                    objbnd   = m.cbGet(GRB.Callback.MIP_OBJBND)   # best bound
                    nodes    = m.cbGet(GRB.Callback.MIP_NODCNT)
                    solcnt   = m.cbGet(GRB.Callback.MIP_SOLCNT)
                    itr      = m.cbGet(GRB.Callback.MIP_ITRCNT)
                    improved = (_cb_state["obj_last"] is None or objbst < _cb_state["obj_last"] - 1e-9)
                    if not improved and (now - _cb_state["t_last"]) < 1.5:
                        return
                    _cb_state["t_last"]  = now
                    _cb_state["obj_last"] = objbst
                    has_inc = solcnt > 0 and abs(objbst) < 1e30
                    if has_inc and abs(objbnd) < 1e30:
                        denom = max(1e-10, abs(objbst))
                        gap_pct_live = abs(objbst - objbnd) / denom * 100.0
                        gap_s = f"{gap_pct_live:.2f}%"
                    else:
                        gap_s = "—"
                    inc_s = f"{objbst:.2f}" if has_inc else "—"
                    bnd_s = f"{objbnd:.2f}" if abs(objbnd) < 1e30 else "—"
                    _log(
                        f"[SOLVE F{idx}] nós={int(nodes)}  incumbente={inc_s}  "
                        f"bound={bnd_s}  gap={gap_s}  soluções={int(solcnt)}  "
                        f"iter={int(itr)}  t={now:.1f}s"
                    )
                except Exception:
                    pass
                return
            # Simplex progress (pure-LP phases, e.g. Phase 6) — periodic light line.
            if where == GRB.Callback.SIMPLEX:
                try:
                    now = m.cbGet(GRB.Callback.RUNTIME)
                    if (now - _cb_state["t_last"]) < 1.5:
                        return
                    _cb_state["t_last"] = now
                    itr = m.cbGet(GRB.Callback.SPX_ITRCNT)
                    obj = m.cbGet(GRB.Callback.SPX_OBJVAL)
                    _log(f"[SOLVE F{idx}] simplex  iter={int(itr)}  obj={obj:.2f}  t={now:.1f}s")
                except Exception:
                    pass
                return

        # Keep Gurobi's own display sparse — our [SOLVE] line is the live summary.
        try:
            model.Params.DisplayInterval = 5
        except Exception:
            pass

        model.optimize(_cb)

        status = int(model.Status)
        sol_count = int(getattr(model, "SolCount", 0) or 0)
        acceptable = {int(GRB.OPTIMAL), int(GRB.SUBOPTIMAL), int(GRB.TIME_LIMIT), int(GRB.INTERRUPTED), int(GRB.USER_OBJ_LIMIT)}
        status_name = {int(GRB.OPTIMAL): "OPTIMAL", int(GRB.SUBOPTIMAL): "SUBOPTIMAL", int(GRB.TIME_LIMIT): "TIME_LIMIT", int(GRB.INTERRUPTED): "INTERRUPTED", int(GRB.INFEASIBLE): "INFEASIBLE"}.get(status, f"STATUS_{status}")

        # Per-phase diagnostics captured even on failure.
        try:    runtime = float(model.Runtime)
        except: runtime = 0.0
        try:    node_count = float(model.NodeCount)
        except: node_count = None
        n_vars  = int(model.NumVars)
        n_bins  = int(getattr(model, "NumBinVars", 0) or 0)
        n_cons  = int(model.NumConstrs)

        failed = (status not in acceptable) or (sol_count <= 0)
        if failed:
            reason = status_name if status not in acceptable else f"sem solução viável em {time_s:.0f}s"
            # Diagnose infeasibility (or no-solution) with an IIS before deciding.
            if status == int(GRB.INFEASIBLE):
                _run_iis(idx, name)
            phase_metrics.append({
                "phase": idx, "name": name, "status": status_name,
                "obj_val": None, "obj_bound": None, "mip_gap": None,
                "runtime_s": runtime, "node_count": node_count,
                "num_vars": n_vars, "num_bin_vars": n_bins, "num_constrs": n_cons,
                "sol_count": sol_count, "failed": True,
            })
            if optional:
                _log(f"[PHASE {idx}] {status_name} — fase de melhoria ignorada; "
                     f"mantendo melhor solução viável das fases anteriores. "
                     f"(vars={n_vars} bin={n_bins} constrs={n_cons} t={runtime:.1f}s)")
                return None
            raise RuntimeError(f"Fase {idx} ({name}) falhou: {reason}")

        obj_val  = float(model.ObjVal)
        try:    bound = float(model.ObjBound)
        except: bound = None
        try:    mip_gap = float(model.MIPGap)
        except: mip_gap = None

        phase_metrics.append({
            "phase":     idx,
            "name":      name,
            "status":    status_name,
            "obj_val":   obj_val,
            "obj_bound": bound,
            "mip_gap":   mip_gap,
            "runtime_s": runtime,
            "node_count": node_count,
            "num_vars":  n_vars,
            "num_bin_vars": n_bins,
            "num_constrs": n_cons,
            "sol_count": sol_count,
            "failed":    False,
        })
        mip_gap_str = f"{mip_gap:.6f}" if mip_gap is not None else "0.0"
        node_str = f"{int(node_count)}" if node_count is not None else "?"
        _log(f"[PHASE {idx}] {status_name}  obj={obj_val:.4f}  gap={mip_gap_str}  "
             f"t={runtime:.1f}s  nós={node_str}  vars={n_vars}(bin={n_bins})  constrs={n_cons}")

        # Read the solution while it is still readable — the lock below invalidates it.
        _capture_solution()

        if add_fix and fix_name:
            # Lexicographic lock: pin this phase's objective so later phases cannot undo
            # it. The lock STAYS (priority order is preserved) — but its tolerance must
            # reflect how precisely this phase was actually PROVEN, not a near-zero number.
            #
            # The previous flat eps≈1e-4·obj carved the next phase's feasible region into a
            # razor-thin (and after recalcs/restrictions, fragmented) sliver — a primary
            # reason Phase 4 stalls. For the SECONDARY/TERTIARY objectives (coverage, OT),
            # obj* itself is only known to within the achieved MIP gap, so locking tighter
            # than that gap over-constrains beyond what was proven and is mathematically
            # unjustified. We therefore use a tolerance = max(tiny floor, achieved-gap slack,
            # user-gap slack) for those locks. Phase 1 (unmet demand) is the HARD business
            # rule — coverage must never be traded away — so it keeps the tight floor.
            base_eps = _phase_fix_epsilon(obj_val)
            if idx == 1:
                eps = base_eps                       # coverage: stay tight (hard rule)
            else:
                # Slack already implied by how loosely obj_val was proven, plus the user's
                # own gap tolerance — whichever is larger. Never tighter than base_eps.
                proven_slack = abs(obj_val - bound) if (bound is not None) else 0.0
                user_slack   = abs(obj_val) * (gap_pct / 100.0)
                eps = max(base_eps, proven_slack, user_slack)
            phase_fix_constraints.append(
                model.addConstr(objective <= obj_val + eps, name=fix_name)
            )
            model.update()
            _log(f"[PHASE {idx}] lock {fix_name}: obj ≤ {obj_val:.4f} + {eps:.4g}")

        return obj_val

    # ── Step 5: Run phases (lexicographic) ───────────────────────
    #
    # ── "Usar todo o Headcount": why the STAGE ORDER changes ──────────────────────────────
    # Phases 1–3 minimise unmet demand, coverage priority and overtime with `z` completely
    # FREE — the solver may already use as many people as it likes. Those three numbers are
    # therefore at their optimum before any people-count objective is even considered, and no
    # later stage can improve them: they are locked. That is why turning the flag on produced a
    # plan with the SAME bottleneck and the SAME overtime — arithmetic, not a bug.
    #
    # The bug is what happened to the extra people. Activation (stage 5) ran AFTER balance
    # (stage 4), and stage 4's lock had to be dropped or it would have forbidden the very
    # activations stage 5 exists to make. So the run ended with people activated and NOTHING
    # left to distribute the work over them: each newcomer took whatever scrap the cleanup
    # objective left it, which is the "same work spread thinner over more heads" the flag was
    # reported for. Only phase 6 followed, and its objective penalises being under 40% of
    # capacity — not being unequal.
    #
    # So in this mode the two stages TRADE PLACES: activate first, lock who is active, then let
    # the balance stage close the load range (Lmax − Lmin) over the full active set. Same
    # phases, same objectives — evaluated in the order the flag's intent requires. The stage
    # numbers travel with their objectives (gaps, tuning and warm starts key on them); only the
    # progress percentages are re-paired with the position so the bar stays monotone.
    _hc_stage = (
        5, "Maximizar uso do headcount disponível",
        headcount_phase5_obj,
        78, "lex_fix_headcount",   # locked: the balance stage must not idle anyone again
    )
    _balance_stage = (
        4, "Balancear carga entre todo o headcount ativo",
        fragmentation_obj,
        88, "lex_fix_fragmentation",
    )
    phase_plan = [
        # Phase 1 — eliminate unmet demand (hard coverage)
        (1, "Minimizar demanda não atendida",
         unmet_total,
         40, "lex_fix_unmet"),
        # Phase 2 — prioritise hard-to-cover WSNs (scarcity + NIVEL + small-WSN bias)
        # Rmax (small weight 0.02) keeps the worst-covered WSN from being fully ignored
        (2, "Priorizar cobertura: escassez, NIVEL e WSNs pequenas",
         coverage_unmet + 0.12 * relative_unmet + 0.02 * Rmax,
         54, "lex_fix_coverage"),
        # Phase 3 — minimise overtime volume, single-person OT peak, and WSN OT concentration
        (3, "Minimizar overtime total, pico e concentração por WSN",
         overtime_total + Hmax + WSN_OT_BALANCE_WEIGHT * wsn_ot_concentration_total,
         67, "lex_fix_ot"),
        # Stage 4 — minimise fragmentation (spread) + load imbalance across people
        #   • dispersion_total:  hours outside each person's dominant WSN
        #   • balance weight × (Lmax – Lmin): equal load distribution
        #   • frag_cap_slack: soft cap on load concentration ratio
        # Stage 5 — minimise active-people count and residual pair count
        #   (drives clean, compact allocations with fewer open assignments)
        #   No lex fix here — when phase_limit >= 6, the binary-fixing step below
        #   pins z/A/y to Phase 5 values and converts Phase 6 into a pure LP.
        #   Adding a lex_fix_cleanup on top would cause STATUS_3 (INFEASIBLE)
        #   because rounding binaries (0.9999→1) can push pair_cleanup_total above
        #   obj5 + eps, making the constraint unsatisfiable.
        # With "Usar todo o Headcount" these two swap places and both carry a lock — see the
        # note above the plan.
        *([_hc_stage, _balance_stage] if use_all_headcount else [
            (4, "Minimizar dispersão e desbalanceamento",
             fragmentation_obj,
             78, "lex_fix_fragmentation"),
            (5, "Minimizar pessoas abertas e pares residuais",
             pair_cleanup_total,
             88, None),
        ]),
        # Phase 6 — minimise soft utilisation violations
        #   • S[j]:              under MIN_UTIL_RATIO × capacity
        #   • full_load_slack[j]: under full normal-day equivalency
        (6, "Minimizar violações suaves de utilização",
         utilization_obj,
         95, None),
    ]

    selected = phase_plan[:phase_limit]
    _log(f"[OPTIMIZER] Executando {len(selected)} fase(s)")

    # Two post-stage hooks below key on the stage NUMBER, and both move when the two stages
    # swap places: the fragmentation warm start belongs immediately before the balance stage,
    # and the binary freeze immediately after the LAST MIP stage (phase 6 is a pure LP).
    _frag_warm_after = 5 if use_all_headcount else 3
    _balance_pos     = 5 if use_all_headcount else 4   # 1-based position in `phase_plan`
    _last_mip_stage  = 4 if use_all_headcount else 5

    # Pre-build the set of pairs that are always forced active (A = 1).
    # Used in the Phase 4→5 pre-fix step to avoid touching required pairs.
    _required_A_pairs: set[tuple[str, str]] = (
        required_pairs
        | set(fixed_pair_min_norm.keys())
        | set(fixed_pair_min_ot.keys())
    )

    # Snapshot of the best feasible solution captured BEFORE Phase 6 pins binaries.
    # If Phase 6 proves infeasible, results are extracted from this snapshot so the
    # run still returns a valid solution (Phase 6 is an improvement-only phase).
    pre_phase6_solution: dict[str, float] | None = None

    def _snapshot_solution() -> dict[str, float]:
        snap: dict[str, float] = {}
        for pair in qualified_pairs:
            snap[f"X::{pair[0]}::{pair[1]}"] = max(0.0, _val(X[pair]))
            snap[f"H::{pair[0]}::{pair[1]}"] = max(0.0, _val(H[pair]))
        for i in I:
            snap[f"U::{i}"] = max(0.0, _val(U[i]))
        return snap

    for pos, (idx, name, obj, pct, fix_name) in enumerate(selected, start=1):
        # Phase 6 is a soft-improvement phase: never abort the run on infeasibility.
        _solve_phase(
            idx, name, obj, pct, fix_name,
            add_fix=(pos < len(selected)),
            optional=(idx == 6),
        )

        # After Phase 2: warm-start Phase 3 binary/continuous OT variables
        # from the current solution.  Without this, Gurobi enters Phase 3
        # with no initial incumbent for y[j] (OT-activation binaries), which
        # causes a large root LP gap that closes quickly once the first integer
        # solution is found but makes the early log look alarming.
        if idx == 2 and phase_limit >= 3:
            try:
                ws_y = 0
                for j in J:
                    pairs_j = pairs_by_j.get(j, [])
                    h_total = sum(max(0.0, _val(H[p])) for p in pairs_j)
                    yval = 1.0 if h_total > 0.01 else 0.0
                    y[j].Start = yval
                    ws_y += int(yval)
                # Carry over z / A so the Phase-3 LP starts from the same
                # assignment structure (keeps the incumbent fully consistent).
                for j in J:
                    if j in z:
                        z[j].Start = float(round(_val(z[j])))
                for pair in qualified_pairs:
                    A[pair].Start = float(round(_val(A[pair])))
                    H[pair].Start = max(0.0, _val(H[pair]))
                h_per_person = [
                    sum(max(0.0, _val(H[p])) for p in pairs_by_j.get(j, []))
                    for j in J
                ]
                Hmax.Start = max(h_per_person) if h_per_person else 0.0
                if ot_wsns:
                    for i in ot_wsns:
                        try:
                            peak_i = max(max(0.0, _val(H[p])) for p in pairs_by_i[i])
                            wsn_ot_peak[i].Start = peak_i
                            n_cand = len(pairs_by_i[i])
                            avg_i = sum(max(0.0, _val(H[p])) for p in pairs_by_i[i]) / n_cand
                            wsn_ot_excess[i].Start = max(0.0, peak_i - avg_i)
                        except Exception:
                            pass
                model.update()
                _log(
                    f"[PHASE 3 WARM START] "
                    f"y_ot={ws_y}/{len(J)}  Hmax={Hmax.Start:.2f}"
                )
            except Exception as _ws_err:
                _log(f"[PHASE 3 WARM START] Aviso (ignorado): {_ws_err}")

        # After Phase 3: warm-start the Phase 4 fragmentation variables
        # (F_vars, frag_cap_slacks, Lmax_var, Lmin_var) from the current solution.
        # Without this, those new variables have no Start value, so Gurobi enters
        # Phase 4 with a poor initial incumbent (phase-3 solution evaluated on the
        # fragmentation objective) and a very large root LP gap (~450%).
        # Setting .Start based on the phase-3 X/H values provides Gurobi with a
        # complete, consistent starting point that drastically reduces the gap.
        if idx == _frag_warm_after and phase_limit >= _balance_pos:
            try:
                if fragmentation_people:
                    for j in fragmentation_people:
                        loads_j = [
                            max(0.0, _val(X[p]) + _val(H[p]))
                            for p in pairs_by_j[j]
                        ]
                        f_start = max(loads_j) if loads_j else 0.0
                        F_vars[j].Start = f_start
                        total_load_j = sum(loads_j)
                        frag_cap_slacks[j].Start = max(
                            0.0, total_load_j - FRAG_RATIO_HARD_CAP * f_start
                        )
                used_loads: list[float] = []
                for j in active_people_lm:
                    z_val = 1.0 if j not in z else max(0.0, _val(z[j]))
                    if z_val > 0.5:
                        load = sum(
                            max(0.0, _val(X[p]) + _val(H[p]))
                            for p in pairs_by_j.get(j, [])
                        )
                        used_loads.append(load)
                Lmax_var.Start = max(used_loads) if used_loads else 0.0
                Lmin_var.Start = min(used_loads) if used_loads else 0.0
                model.update()
                _log(
                    f"[PHASE 4 WARM START] "
                    f"F_vars={len(fragmentation_people)}  "
                    f"Lmax={Lmax_var.Start:.2f}  Lmin={Lmin_var.Start:.2f}"
                )
            except Exception as _ws_err:
                _log(f"[PHASE 4 WARM START] Aviso (ignorado): {_ws_err}")

        # After Phase 4 resolves fragmentation, pre-fix binary variables that
        # are clearly determined to reduce Phase 5's search space.
        # Phase 5 only *deactivates* (minimises pair/person count) — it never
        # activates new pairs — so:
        #   • A ≈ 0 → pin A.ub=0; also set X.ub=H.ub=0 explicitly so Gurobi
        #     skips LP propagation for these columns at every branch node.
        #   • z ≈ 0 → pin z.ub=0; also set y.ub=0 (y ≤ z constraint already
        #     implies it, but explicit bounds remove the y binary from search).
        #   • Sole-coverage pairs (only remaining active pair for a covered WSN)
        #     are forced to A.lb=1: Phase 5 cannot drop them without violating
        #     the Phase 1/2 lex fix, so fixing lb=1 removes a branching dimension.
        # Required / forced pairs are skipped (already constrained to A = 1).
        # SKIPPED entirely when use_all_headcount: there stage 4 is the LAST MIP stage — the
        # activation already happened and is locked — so there is no Phase 5 search left to
        # shrink, and pinning z/A to 0 would only undo activations the lock protects.
        # NOTE (unchanged on purpose): every `.X` read below happens AFTER Phase 4 added its
        # lexicographic lock, so Gurobi has already discarded the solution and each read
        # raises — the whole block is INERT today (see `_last_values`). It is left that way
        # rather than switched to `_val`, because making it live would genuinely restrict
        # Phase 5: pinning A=0 on a pair Phase 4 happened to leave idle can block the
        # reassignment that would have removed a person, i.e. it can WORSEN the people count
        # this mode exists to minimise. That is a decision about the flag-OFF plan and does
        # not belong in the "use all headcount" fix.
        if idx == 4 and phase_limit >= 5 and not use_all_headcount:
            pre_fixed_A = 0
            for pair in qualified_pairs:
                if pair in _required_A_pairs:
                    continue  # always active — leave bounds untouched
                try:
                    a_val = float(A[pair].X)
                except Exception:
                    continue
                if a_val < 0.5:
                    A[pair].lb = 0.0
                    A[pair].ub = 0.0
                    # Explicit continuous bounds → Gurobi skips LP propagation
                    # from "X + H ≤ big_M * A" at every node.
                    X[pair].ub = 0.0
                    H[pair].ub = 0.0
                    pre_fixed_A += 1

            pre_fixed_z = 0
            pre_fixed_y = 0
            for j in usage_decision_j:
                try:
                    z_val = float(z[j].X)
                except Exception:
                    continue
                if z_val < 0.5:
                    z[j].lb = 0.0
                    z[j].ub = 0.0
                    # y[j] ≤ z[j] → y must be 0 when z=0; fix explicitly.
                    y[j].lb = 0.0
                    y[j].ub = 0.0
                    pre_fixed_z += 1
                    pre_fixed_y += 1

            # Sole-coverage mandatory fix: for each covered WSN that has exactly
            # one remaining free active pair (all others pinned to 0), that pair
            # cannot be dropped by Phase 5 — fix A.lb=1 and z.lb=1 immediately.
            pre_fixed_A_mandatory = 0
            active_free_by_wsn: dict[str, list] = {}
            for pair in qualified_pairs:
                if pair in _required_A_pairs:
                    continue  # required pairs already have lb=1 from constraints
                try:
                    a_lb = float(A[pair].lb)
                    a_ub = float(A[pair].ub)
                except Exception:
                    continue
                if a_lb < 0.5 and a_ub > 0.5:  # still a free binary
                    active_free_by_wsn.setdefault(pair[0], []).append(pair)

            for wsn, free_pairs in active_free_by_wsn.items():
                if len(free_pairs) != 1:
                    continue  # multiple options → Phase 5 can choose freely
                try:
                    u_val = float(U[wsn].X)
                except Exception:
                    continue
                if u_val > RESULT_REPORT_EPSILON_HOURS:
                    continue  # WSN had unmet demand → sole pair not mandatory
                # Confirm no required pair already covers this WSN
                if any(p in _required_A_pairs for p in pairs_by_i.get(wsn, [])):
                    continue
                sole = free_pairs[0]
                if A[sole].lb < 0.5:
                    A[sole].lb = 1.0
                    pre_fixed_A_mandatory += 1
                    j_sole = sole[1]
                    if j_sole in z and z[j_sole].lb < 0.5:
                        z[j_sole].lb = 1.0

            if pre_fixed_A > 0 or pre_fixed_z > 0 or pre_fixed_A_mandatory > 0:
                model.update()
                _log(
                    f"[PHASE 5 PREP] A=0:{pre_fixed_A}(+X/H fixados), "
                    f"z=0:{pre_fixed_z}(+y:{pre_fixed_y}), "
                    f"A=1(necessários):{pre_fixed_A_mandatory}"
                )

        # After Phase 5 resolves who is active, fix ALL binary variables to their
        # optimal integer values.  This converts Phase 6 from a MIP back into a
        # pure LP (identical to the original behaviour where all z were forced
        # constants via must_use) → Phase 6 solves in < 1 s.
        if idx == _last_mip_stage and phase_limit >= 6:
            # Values come from `_last_values`, never `.X`: this stage ends by adding its
            # lexicographic lock, which discards the solution. Reading `.X` here fell into the
            # `except` on every variable — z defaulted to 1 and A to 0, so an ACTIVE person
            # ended up with all their pairs pinned off and `used_backlink_<person>` became
            # unsatisfiable. Phase 6 then reported INFEASIBLE and the run fell back to a
            # snapshot that was empty for the same reason: zero allocations out of a solved
            # model. It only surfaced once this stage started carrying a lock.
            fixed_z = 0
            for j in J:
                if j in z:
                    val = float(round(_val(z[j], 1.0)))
                    z[j].lb = val
                    z[j].ub = val
                    fixed_z += 1
            fixed_A = 0
            for pair in qualified_pairs:
                val = float(round(_val(A[pair])))
                A[pair].lb = val
                A[pair].ub = val
                fixed_A += 1
            for j in J:
                val = float(round(_val(y[j])))
                y[j].lb = val
                y[j].ub = val
            model.update()
            _log(f"[PHASE 5 FIX] Binários fixados — {fixed_z} z-vars, {fixed_A} A-vars → Fase 6 como LP")
            # Capture the proven-feasible Phase-5 solution. If Phase 6 (improvement
            # only) turns infeasible due to binary-rounding vs. lex fixes, results are
            # taken from here so the run still returns a valid allocation.
            pre_phase6_solution = _snapshot_solution()

    # ── Step 6: Extract results ──────────────────────────────────
    _prog(97, "Processando resultados...")
    _log("[RESULTS] Extraindo alocações...")

    # Report the gap of the last phase that actually produced a solution.
    _succeeded = [m for m in phase_metrics if not m.get("failed")]
    final_gap = (_succeeded[-1] if _succeeded else (phase_metrics[-1] if phase_metrics else {})).get("mip_gap")

    # If Phase 6 (improvement only) failed/was skipped, the model holds no fresh
    # solution — fall back to the Phase-5 snapshot so we still return a valid result.
    _phase6_failed = bool(phase_metrics and phase_metrics[-1].get("phase") == 6
                          and phase_metrics[-1].get("failed"))
    _use_snapshot = _phase6_failed and pre_phase6_solution is not None
    if _use_snapshot:
        _log("[RESULTS] Fase 6 sem solução — usando a melhor solução viável da Fase 5.")

    def _sol_X(pair) -> float:
        if _use_snapshot:
            return pre_phase6_solution.get(f"X::{pair[0]}::{pair[1]}", 0.0)
        return max(0.0, float(X[pair].X))

    def _sol_H(pair) -> float:
        if _use_snapshot:
            return pre_phase6_solution.get(f"H::{pair[0]}::{pair[1]}", 0.0)
        return max(0.0, float(H[pair].X))

    def _sol_U(i: str) -> float:
        if _use_snapshot:
            return pre_phase6_solution.get(f"U::{i}", 0.0)
        return max(0.0, float(U[i].X))

    allocations:    dict[str, dict[str, float]] = {}
    ot_allocations: dict[str, dict[str, float]] = {}
    for i, j in qualified_pairs:
        x_val = _sol_X((i, j))
        h_val = _sol_H((i, j))
        total = x_val + h_val
        if total > RESULT_REPORT_EPSILON_HOURS:
            if i not in allocations:
                allocations[i] = {}
            allocations[i][j] = round(total, 4)
        if h_val > RESULT_REPORT_EPSILON_HOURS:
            if i not in ot_allocations:
                ot_allocations[i] = {}
            ot_allocations[i][j] = round(h_val, 4)

    # `covered` stays CLOCK hours — it is what the allocation rows sum to, and the main page
    # walks per-person hours against it to split a WSN's bar (see the accumulation loop in
    # app/(main)/page.tsx). `covered_eff` is what those hours actually DELIVER once the speed
    # multipliers are applied, which is the quantity the coverage constraint balanced against
    # demand: covered_eff + unmet == demand, while covered alone will not add up when the
    # multipliers are on. Utilisation reports the delivered figure, since that is the real
    # answer to "how much of this station's demand is met".
    wsn_results: list[dict] = []
    for i in I:
        covered  = sum(allocations.get(i, {}).values())
        cov_eff  = sum(_speed(i, j) * v for j, v in allocations.get(i, {}).items())
        wsn_ot   = sum(ot_allocations.get(i, {}).values())
        demand   = demand_by_wsn.get(i, 0.0)
        unmet    = _sol_U(i)
        util_pct = (cov_eff / demand * 100.0) if demand > 0 else 0.0
        wsn_results.append({
            "wsn":          i,
            "demand":       round(demand, 2),
            "covered":      round(covered, 2),
            "covered_eff":  round(cov_eff, 2),
            "unmet":        round(unmet, 2),
            "ot_h":         round(wsn_ot, 2),
            "util":         round(util_pct, 1),
            "bottleneck":   unmet > BOTTLENECK_EPSILON_HOURS,
            "people_count": len(allocations.get(i, {})),
        })

    wsn_results.sort(key=lambda r: -r["unmet"])

    if speed_on:
        _clock = sum(r["covered"] for r in wsn_results)
        _deliv = sum(r["covered_eff"] for r in wsn_results)
        _log(f"[EXPERTISE] Ritmo: {_clock:.1f} h de relógio alocadas entregaram "
             f"{_deliv:.1f} h de demanda "
             f"({(_deliv / _clock * 100.0 - 100.0) if _clock > 0 else 0.0:+.1f}%).")

    # ── Per-phase diagnostics summary (vars / constrs / time / nodes / gap) ──
    _log("[DIAG] Resumo por fase — vars(bin) | restr | tempo | nós | gap | status")
    for m in phase_metrics:
        _gap = m.get("mip_gap")
        _gap_s = f"{_gap*100:.2f}%" if _gap is not None else "—"
        _nc = m.get("node_count")
        _nc_s = f"{int(_nc)}" if _nc is not None else "—"
        _log(
            f"[DIAG] Fase {m['phase']}: "
            f"{m.get('num_vars','?')}({m.get('num_bin_vars','?')}) | "
            f"{m.get('num_constrs','?')} | "
            f"{m.get('runtime_s',0.0):.1f}s | "
            f"{_nc_s} | {_gap_s} | {m.get('status','?')}"
            + ("  [IGNORADA]" if m.get("failed") else "")
        )

    _prog(100, "Otimização concluída.")
    _log("[DONE] Otimização concluída com sucesso.")

    return {
        "status":           "ok",
        "message":          f"{len(wsn_results)} WSNs processadas.",
        "wsns":             wsn_results,
        "allocations":      allocations,
        "ot_allocations":   ot_allocations,
        "phase_metrics":    phase_metrics,
        "final_gap":        final_gap,
        "wsn_shift_info":   wsn_shift_constraints,
    }