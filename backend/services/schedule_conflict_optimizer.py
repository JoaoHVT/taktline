"""
services/schedule_conflict_optimizer.py
----------------------------------------
Modo 1: Resolve WS40/WS50 conflicts using Gurobi only — LOCO level.

Every decision variable corresponds to ONE LOCO (wo, task_name). Shifting a
LOCO moves that LOCO's workstation start dates (and all downstream operations)
by the same number of business days, bounded by that LOCO's own Protection Days.

Algorithm:
  1. Detect conflicts in TARGET_WS between distinct LOCOs.
  2. Build MIP: shift var s[loco] ∈ [0, PD(loco)] for each conflicting LOCO,
     resolve binary y[i] + disjunction binary b[i] per conflict pair.
  3. Optimize with Gurobi up to TIME_LIMIT_S seconds.
     Log per-incumbent callback: conflicts, shifts, PD, obj, gap, time.
  4. Return shifts keyed by "wo||task_name" — caller rebuilds Gantt once.

Public:
  optimize_conflicts(ms_by_wo, rt_rows, log_fn, time_limit_s) → dict[str, int]
  apply_shifts_to_ms(ms_by_wo, shifts, holidays)              → dict
  build_shift_report(...)                                     → list[dict]

Shift dict keys are LOCO keys "wo||task_name".
"""

from __future__ import annotations

import logging
import math
import re
import time
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Callable

from services import tipos

logger = logging.getLogger(__name__)

# ── Gurobi (required — no fallback) ──────────────────────────────────────────
try:
    import gurobipy as gp
    from gurobipy import GRB
    _GUROBI_AVAILABLE = True
except Exception:
    gp = None        # type: ignore[assignment]
    GRB = None       # type: ignore[assignment]
    _GUROBI_AVAILABLE = False

# Workstations evaluated for conflicts
TARGET_WS: frozenset[str] = frozenset({"WS40", "WS50"})

# ── ES44 swap (WS40 ↔ WS50 execution-order exchange) ──────────────────────────
# The two workstations whose execution order may be exchanged for an eligible
# ES44 LOCO. Both are also the conflict-target WS, so a swap relays a clash on
# either to the other's day-cells. Normalized (no spaces, upper) to match _norm_ws.
SWAP_WS_FIRST = "WS40"
SWAP_WS_SECOND = "WS50"

# ES44 detector: case-insensitive, tolerant of spacing / separator variations
# between "ES" and "44" (ES44, ES 44, ES-44, ES_44, "ES  44", ES.44, ES/44…).
# Word-boundary on the left so "MES44"/"YES44" don't match; the digits must be
# exactly 44 not 440/441 (negative lookahead on a trailing digit).
_RE_ES44 = re.compile(r"(?<![A-Z0-9])ES[\s\-_./]*44(?![0-9])", re.IGNORECASE)


def _is_es44(*fields: str) -> bool:
    """True if any provided field (Standard WO, Task Name, LOCO name, MODELO/linha)
    matches the ES44 pattern, case-insensitively and tolerant of spacing/separators."""
    for f in fields:
        if f and _RE_ES44.search(str(f)):
            return True
    return False


TIME_LIMIT_S = 60.0   # wall-clock budget


# ── LOCO key helpers ──────────────────────────────────────────────────────────

def _loco_key(wo: str, task_name: str) -> str:
    return f"{wo}||{task_name}"


def _split_loco_key(key: str) -> tuple[str, str]:
    wo, _, tn = key.partition("||")
    return wo, tn


def _loco_type(linha: str) -> str:
    """Classify a LOCO into its line type from the Schedule-MS `linha` value.

    Delegates to `services.tipos`, the single backend registry, which mirrors
    `frontend/src/lib/tipos.ts` and the worker's own copy — the classification used on the
    import/selection screen. The local if-chain this replaced was a second backend copy of the
    same five rows, and two copies of a classification is how detection and rendering end up
    disagreeing about the same two boxes.
    """
    return tipos.tipo_geral(linha)


def _is_overlap_allowed_pair(t1: str, t2: str) -> bool:
    """Type-pair overlap rule (Mode 1 overlap enhancement).

    Returns True when an exactly-two-LOCO same-day share on a TARGET_WS is a VALID
    overlap PURELY on the basis of LOCO types — i.e. exempt regardless of whether it
    is an end/start boundary handoff. This is ONLY the case for a New Locos paired
    with a DIFFERENT non-New-Locos type from the listed set:
        New Locos × Overhaul       → allowed
        New Locos × Motor Diesel   → allowed
    Everything else returns False here (same-type incl. New×New, Overhaul×Motor
    Diesel, and any pair involving 'propulsion'/'other'); those remain subject to the
    existing boundary-handoff exemption only. Same-type is never allowed by type.

    STRUCTURAL GATE FIRST: this rule is about two LOCOs queueing for ONE physical machine on
    one day, a claim that only means anything when both Tipos put boxes on the Schedule. A Tipo
    whose hours come from elsewhere is refused by the FLAG rather than by being absent from the
    pair comparison below — so the exclusion holds for the next such Tipo without anyone
    editing this function. The four schedule-backed Tipos are unaffected.
    """
    if not tipos.is_schedule_backed(t1) or not tipos.is_schedule_backed(t2):
        return False
    pair = {t1, t2}
    return pair == {"new_locos", "overhaul"} or pair == {"new_locos", "motor_diesel"}


# ── Basic helpers ─────────────────────────────────────────────────────────────

def _norm_ws(ws: str) -> str:
    return ws.strip().upper().replace(" ", "")


def _is_target_ws(ws_n: str) -> bool:
    return ws_n.upper() in TARGET_WS


_PROTECTION_WS_KEYS: frozenset[str] = frozenset(
    {"PROTECTIONDAYS", "PROTECAO", "DIASDEPROTECAO", "PROTECTIONDAY"}
)


def _is_protection_ws(ws_n: str) -> bool:
    """True for the Protection-Days buffer workstation (same matcher used elsewhere)."""
    u = ws_n.upper()
    return u in _PROTECTION_WS_KEYS or "PROTECTION" in u


def _is_business_day(d: date, holidays: frozenset) -> bool:
    return d.weekday() < 5 and d not in holidays


def _add_business_days(start: date, n: int, holidays: frozenset) -> date:
    if n == 0:
        return start
    cur, rem = start, n
    while rem > 0:
        cur += timedelta(days=1)
        if _is_business_day(cur, holidays):
            rem -= 1
    return cur


def _count_business_days_between(d1: date, d2: date, holidays: frozenset) -> int:
    if d2 <= d1:
        return 0
    count, cur = 0, d1 + timedelta(days=1)
    while cur <= d2:
        if _is_business_day(cur, holidays):
            count += 1
        cur += timedelta(days=1)
    return count


def _count_protection_days(finish_ms: str, start_ms: date, holidays: frozenset) -> int:
    if not finish_ms:
        return 0
    try:
        fin = date.fromisoformat(str(finish_ms)[:10])
    except (ValueError, TypeError):
        return 0
    return _count_business_days_between(start_ms, fin, holidays)


def _build_holidays(ms_by_wo: dict) -> frozenset:
    from gantt_builder import _get_holidays_for_dates
    dates = [t["start_ms"] for tasks in ms_by_wo.values() for t in tasks if t.get("start_ms")]
    return _get_holidays_for_dates(dates) if dates else frozenset()


# ── WS-days computation ───────────────────────────────────────────────────────

def _compute_loco_ws_days(
    ms_by_wo: dict,
    rt_rows: list,
    shifts: dict[str, int],
    holidays: frozenset,
    only_wos: set[str] | None = None,
    type_out: dict[str, str] | None = None,
) -> dict[str, dict[str, set[str]]]:
    """
    Build {loco_key: {ws_norm: {iso_day, ...}}}.
    `shifts` is keyed by LOCO key "wo||task_name"; each LOCO's start_ms is shifted
    independently by its own business-day amount.
    When `type_out` is provided it is filled with {loco_key: line_type} from the same
    records (no extra build) for the overlap type rule.
    """
    from gantt_builder import _build_records

    shifted_ms: dict = defaultdict(list)
    for wo, tasks in ms_by_wo.items():
        if only_wos is not None and wo not in only_wos:
            continue
        for t in tasks:
            nt = dict(t)
            lk = _loco_key(wo, t.get("task_name") or "")
            shift = shifts.get(lk, 0)
            if shift > 0 and t.get("start_ms"):
                nt["start_ms"] = _add_business_days(t["start_ms"], shift, holidays)
            shifted_ms[wo].append(nt)

    records = _build_records(shifted_ms, rt_rows)
    result: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for r in records:
        key = _loco_key(r["wo"], r["task_name"])
        ws_n = _norm_ws(r["ws"])
        result[key][ws_n].add(r["day"].isoformat())
        if type_out is not None and key not in type_out:
            type_out[key] = _loco_type(r.get("linha", ""))
    return result


def _build_loco_type_map(records: list[dict]) -> dict[str, str]:
    """Build {loco_key: line_type} from records' `linha`, for the overlap type rule.
    Keyed by "wo||task_name" — the same key as loco_ws_days. See _loco_type().
    """
    out: dict[str, str] = {}
    for r in records:
        key = _loco_key(r["wo"], r["task_name"])
        if key not in out:
            out[key] = _loco_type(r.get("linha", ""))
    return out


def _scope_ws_days(
    loco_ws_days: dict,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, dict[str, set[str]]]:
    """
    Restrict a loco_ws_days map to the SAME scope the user sees:
      - only LOCO keys in `loco_filter` (if given), and
      - only days inside [date_from, date_to] (ISO, inclusive; if given).
    Conflict detection on the result matches the visible Schedule exactly.
    """
    if loco_filter is None and not date_from and not date_to:
        return loco_ws_days
    out: dict[str, dict[str, set[str]]] = {}
    for key, ws_dict in loco_ws_days.items():
        if loco_filter is not None and key not in loco_filter:
            continue
        new_ws: dict[str, set[str]] = {}
        for ws_n, days in ws_dict.items():
            if date_from or date_to:
                days = {
                    d for d in days
                    if (not date_from or d >= date_from) and (not date_to or d <= date_to)
                }
            if days:
                new_ws[ws_n] = days
        if new_ws:
            out[key] = new_ws
    return out


def _is_boundary_share_day(
    day: str, k1: str, k2: str, ws_n: str, loco_ws_days: dict,
) -> bool:
    """Boundary-overlap exemption test for a single shared TARGET_WS `day` between
    EXACTLY two LOCOs k1, k2 (caller guarantees only these two occupy the day).

    Valid shared-day usage (NOT a conflict) iff the day is strictly the END of one
    LOCO's occupancy on this WS and the START of the other's — i.e. one LOCO finishes
    the workstation on `day` while the other starts it the same day. Inferred from the
    day-sets: `day == max(daysA) and day == min(daysB)` (or vice-versa). Half-day
    sharing maps onto this same boundary handoff (the shared day is the last half of
    one and the first half of the other), so it is covered by the same predicate.
    """
    d1 = loco_ws_days.get(k1, {}).get(ws_n, set())
    d2 = loco_ws_days.get(k2, {}).get(ws_n, set())
    if not d1 or not d2:
        return False
    last1, first1 = max(d1), min(d1)
    last2, first2 = max(d2), min(d2)
    # k1 finishes on `day`, k2 starts on `day`  — or the symmetric case.
    return (day == last1 and day == first2) or (day == last2 and day == first1)


def _detect_conflicts(
    loco_ws_days: dict,
    allow_overlap: bool = False,
    loco_type: dict[str, str] | None = None,
) -> list[tuple[str, str, str, str, str]]:
    """(wo1, tn1, wo2, tn2, ws_norm) pairs sharing a TARGET_WS on the same day.

    When `allow_overlap` is True (the gated "Permitir regras de sobreposição" test
    feature), an exactly-two-LOCO shared day is EXEMPT (not a conflict) when EITHER:
      • TYPE rule — the two LOCOs are an allowed cross-type pair
        (New Locos × Overhaul or New Locos × Motor Diesel; see _is_overlap_allowed_pair),
        valid regardless of boundary; requires `loco_type`; OR
      • BOUNDARY rule (existing) — the day is an end/start handoff, last day of one ==
        first day of the other (see _is_boundary_share_day; covers same-type incl.
        New×New, Propulsion, 'other', and half-day sharing).
    The exemption applies ONLY when EXACTLY 2 LOCOs occupy that WS/day; with 3+ it is
    always a normal conflict regardless of type. A pair stays a conflict if it has ANY
    shared day that is not exempt. With `allow_overlap` False, behaviour is identical to
    before (every shared day between distinct LOCOs is a conflict).
    """
    ws_day_locos: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for key, ws_dict in loco_ws_days.items():
        for ws_n, days in ws_dict.items():
            if not _is_target_ws(ws_n):
                continue
            for day in days:
                ws_day_locos[ws_n][day].append(key)

    conflicts: list[tuple] = []
    seen: set = set()
    for ws_n, day_dict in ws_day_locos.items():
        for day, keys in day_dict.items():
            keys_sorted = sorted(set(keys))
            if len(keys_sorted) < 2:
                continue
            # Exemption only applies when EXACTLY two LOCOs share the day. With 3+ LOCOs
            # on the same WS/day it is always a normal conflict (any type combination).
            day_exempt = allow_overlap and len(keys_sorted) == 2
            for i in range(len(keys_sorted)):
                for j in range(i + 1, len(keys_sorted)):
                    k1, k2 = keys_sorted[i], keys_sorted[j]
                    if day_exempt:
                        # TYPE rule: allowed cross-type pair → valid regardless of boundary.
                        if loco_type is not None and _is_overlap_allowed_pair(
                            loco_type.get(k1, "other"), loco_type.get(k2, "other")
                        ):
                            continue
                        # BOUNDARY rule (existing): end/start handoff → valid.
                        if _is_boundary_share_day(day, k1, k2, ws_n, loco_ws_days):
                            continue
                    wo1, tn1 = _split_loco_key(k1)
                    wo2, tn2 = _split_loco_key(k2)
                    # distinct LOCOs (same WO but different task_name still conflicts)
                    cid = (k1, k2, ws_n)
                    if cid not in seen:
                        seen.add(cid)
                        conflicts.append((wo1, tn1, wo2, tn2, ws_n))
    return conflicts


def _get_protection_days(
    ms_by_wo: dict,
    holidays: frozenset,
    rt_rows: list | None = None,
    loco_ws_days: dict | None = None,
) -> dict[str, int]:
    """
    Returns available Protection Days PER LOCO, keyed by "wo||task_name" =
    number of PD-workstation days already computed in loco_ws_days (preferred).
    The PD WS key after _norm_ws is 'PROTECTIONDAYS'.
    """
    _PD_KEYS = {"PROTECTIONDAYS", "PROTECAO", "DIASDEPROTECAO", "PROTECTIONDAY"}

    if loco_ws_days is not None:
        # Read directly from the already-built ws_days map — zero extra cost
        result: dict[str, int] = {}
        for key, ws_dict in loco_ws_days.items():
            best = 0
            for ws_n, days in ws_dict.items():
                if ws_n in _PD_KEYS or "PROTECTION" in ws_n:
                    best = max(best, len(days))
            result[key] = best
        return result

    if rt_rows:
        from gantt_builder import _build_records
        records = _build_records(ms_by_wo, rt_rows)
        pd_days: dict[str, set[str]] = defaultdict(set)
        for r in records:
            ws_n = _norm_ws(r.get("ws", ""))
            if ws_n in _PD_KEYS or "PROTECTION" in ws_n:
                pd_days[_loco_key(r["wo"], r["task_name"])].add(r["day"].isoformat())
        return {k: len(v) for k, v in pd_days.items()}

    # Last resort: finish_ms - start_ms (overestimate, used only if no routing)
    result = {}
    for wo, tasks in ms_by_wo.items():
        for t in tasks:
            start = t.get("start_ms")
            finish = t.get("finish_ms", "")
            pd = _count_protection_days(finish, start, holidays) if (start and finish) else 0
            result[_loco_key(wo, t.get("task_name") or "")] = pd
    return result


# ── Cluster helpers (connected components over LOCO conflict graph) ───────────

def _find_clusters(conflicts: list) -> list[set[str]]:
    graph: dict[str, set[str]] = defaultdict(set)
    for wo1, tn1, wo2, tn2, ws_n in conflicts:
        k1, k2 = _loco_key(wo1, tn1), _loco_key(wo2, tn2)
        graph[k1].add(k2)
        graph[k2].add(k1)
    visited: set[str] = set()
    clusters: list[set[str]] = []
    for node in graph:
        if node in visited:
            continue
        cluster: set[str] = set()
        stack = [node]
        while stack:
            n = stack.pop()
            if n in visited:
                continue
            visited.add(n)
            cluster.add(n)
            stack.extend(graph.get(n, set()) - visited)
        clusters.append(cluster)
    return clusters


# ── Minimum shift needed to clear a conflict pair ────────────────────────────

def _compute_conflict_min_shift(
    k1: str, k2: str, ws_n: str,
    loco_ws_days: dict, holidays: frozenset,
) -> int:
    """Minimum business-day shift of LOCO k1 to clear its conflict with k2 at ws_n.
    Pushing k1's overlapping days past k1's own last day at ws_n removes the overlap."""
    days1 = loco_ws_days.get(k1, {}).get(ws_n, set())
    days2 = loco_ws_days.get(k2, {}).get(ws_n, set())
    overlap = days1 & days2
    if not overlap:
        return 0
    try:
        d_first = date.fromisoformat(min(overlap))
        d_last1 = date.fromisoformat(max(days1))
    except (ValueError, TypeError):
        return 0
    min_shift, cur = 0, d_first
    while cur <= d_last1:
        if _is_business_day(cur, holidays):
            min_shift += 1
        cur += timedelta(days=1)
    return max(1, min_shift)


# ── Count remaining conflicts given a candidate solution ─────────────────────

def _detect_conflicts_for_shifts(
    ms_by_wo: dict,
    rt_rows: list,
    shifts: dict[str, int],
    holidays: frozenset,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    allow_overlap: bool = False,
) -> tuple[list, dict]:
    """Re-detect conflicts for a shift assignment, scoped to the visible window.
    Returns (conflicts, scoped_ws_days)."""
    loco_type: dict[str, str] = {}
    ws_days = _compute_loco_ws_days(ms_by_wo, rt_rows, shifts, holidays, type_out=loco_type)
    scoped = _scope_ws_days(ws_days, loco_filter, date_from, date_to)
    return _detect_conflicts(scoped, allow_overlap, loco_type), scoped


def detect_conflicts_from_records(
    records: list[dict],
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    allow_overlap: bool = False,
) -> list[tuple]:
    """
    Detect TARGET_WS conflicts directly on a FINAL flat records list (the exact thing
    used to build the Gantt), scoped to the visible window. Use this for verification
    AFTER any post-pass (e.g. Saturday relocation) so the reported count matches the
    schedule the user actually sees — never a re-shifted approximation.
    """
    loco_ws_days: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    loco_type: dict[str, str] = {}
    for r in records:
        key = _loco_key(r["wo"], r["task_name"])
        ws_n = _norm_ws(r["ws"])
        loco_ws_days[key][ws_n].add(r["day"].isoformat())
        if key not in loco_type:
            loco_type[key] = _loco_type(r.get("linha", ""))
    scoped = _scope_ws_days(loco_ws_days, loco_filter, date_from, date_to)
    return _detect_conflicts(scoped, allow_overlap, loco_type)


def _eval_conflicts_for_shifts(
    ms_by_wo: dict,
    rt_rows: list,
    shifts: dict[str, int],
    holidays: frozenset,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    allow_overlap: bool = False,
) -> int:
    """Count of conflicts remaining for a shift assignment, scoped to window."""
    conflicts, _ = _detect_conflicts_for_shifts(
        ms_by_wo, rt_rows, shifts, holidays, loco_filter, date_from, date_to, allow_overlap
    )
    return len(conflicts)


# ── Gurobi MIP solver ─────────────────────────────────────────────────────────

def _label_loco(loco_key: str) -> str:
    """Display label = the LOCO serial (task_name)."""
    _, tn = _split_loco_key(loco_key)
    return tn or loco_key


def _advance_iso_days(iso_days: set[str], d: int, holidays: frozenset) -> frozenset[str]:
    """Shift every ISO day in the set forward by d business days (rigid shift)."""
    if d == 0:
        return frozenset(iso_days)
    out: set[str] = set()
    for iso in iso_days:
        try:
            base = date.fromisoformat(iso)
        except (ValueError, TypeError):
            continue
        out.add(_add_business_days(base, d, holidays).isoformat())
    return frozenset(out)


def _swap_ws_layout(
    ws40_days: set[str],
    ws50_days: set[str],
    holidays: frozenset,
    add_days: Callable[[date, int, frozenset], date] = _add_business_days,
) -> tuple[frozenset[str], frozenset[str]] | None:
    """
    Exchange the EXECUTION ORDER of WS40 and WS50 within their combined block, keeping
    each WS's own duration (number of distinct day-cells). Returns the swapped
    (new_ws40_days, new_ws50_days), or None when the two WS are genuinely interleaved
    (neither runs cleanly before the other) so a reorder is undefined.

    ORDER-AGNOSTIC: the routing may schedule WS40→WS50 OR WS50→WS40. Whatever the current
    order, the swap exchanges it: the WS that currently runs SECOND is laid out FIRST from
    the block's anchor (the earlier WS's first day), and the WS that currently runs FIRST is
    laid out AFTER it. Each keeps its own distinct-day count; the combined block stays inside
    its ORIGINAL day-span [min(first) .. max(last)], so nothing downstream moves.

    HALF-DAY HANDOFF: in continuous routing the predecessor WS ends on the FIRST half of a
    day and the successor begins on the SECOND half of that SAME calendar day. In day-granular
    ISO sets that is ONE shared boundary day (pred_last == succ_first) — a legal AM→PM handoff,
    NOT a real overlap, so it IS swappable. Only a TRUE interleave (the predecessor extending
    STRICTLY PAST the successor's first day) makes the reorder undefined → None.
    `add_days` lets the caller pass the Mon–Sat advance when Saturdays are enabled.
    """
    if not ws40_days or not ws50_days:
        return None
    try:
        d40 = sorted(date.fromisoformat(x) for x in ws40_days)
        d50 = sorted(date.fromisoformat(x) for x in ws50_days)
    except (ValueError, TypeError):
        return None

    # Determine the CURRENT order by first day: 'pred' runs first, 'succ' runs second.
    # The swap will place succ first and pred second. ws40_is_pred tracks which physical
    # WS is the predecessor so we can re-tag the swapped day-cells back to WS40/WS50.
    if d40[0] <= d50[0]:
        pred, succ, ws40_is_pred = d40, d50, True
    else:
        pred, succ, ws40_is_pred = d50, d40, False

    # Reject only a TRUE interleave: predecessor extending strictly PAST the successor's
    # first day. A shared boundary day (==) is the AM/PM half-day handoff → allowed.
    if pred[-1] > succ[0]:
        return None

    n_pred, n_succ = len(pred), len(succ)
    anchor = pred[0]                       # block start (unchanged by the swap)
    block_end = succ[-1]                   # block END — successor runs last (unchanged by the swap)

    # Consecutive workdays spanning the ORIGINAL block [anchor .. block_end]. Laying the swapped
    # stations into this full SPAN — the SUCCESSOR into the first n_succ slots, the PREDECESSOR into the
    # last n_pred slots — is what keeps a swap a PURE slot exchange: each WS lands in the exact time slot
    # its partner vacated, and ANY GAP that sat between the two stations stays exactly where it was.
    #
    # The old code built the run from len(union-of-occupied-days) instead, so when a gap existed between
    # WS40 and WS50 (common on an edited loco whose delays opened one) the two were packed CONSECUTIVELY
    # from the anchor — silently deleting the gap and pulling the trailing station earlier by the gap
    # size. That positional shift read as a phantom delay change ("swap advances a WS by 1 day / changes
    # its delay") and violated the invariant that a swap only exchanges order, never dates/gaps.
    run: list[date] = [anchor]
    cur = anchor
    while cur < block_end:
        cur = add_days(cur, 1, holidays)
        run.append(cur)

    new_succ = run[:n_succ]
    new_pred = run[len(run) - n_pred:]

    # Defensive: swapped block must not extend past the original block's end (successors downstream are
    # anchored). run[-1] == block_end == succ[-1] by construction; guard against holiday-calendar edges.
    if run[-1] > succ[-1]:
        return None

    # Re-tag: map the swapped pred/succ day-cells back to physical WS40/WS50.
    if ws40_is_pred:
        new_ws40, new_ws50 = new_pred, new_succ
    else:
        new_ws40, new_ws50 = new_succ, new_pred

    return (
        frozenset(x.isoformat() for x in new_ws40),
        frozenset(x.isoformat() for x in new_ws50),
    )


# ── Saturday-aware helpers (use_saturdays, WS40/WS50 only) ───────────────────

def _is_saturday(iso: str) -> bool:
    try:
        return date.fromisoformat(iso).weekday() == 5
    except (ValueError, TypeError):
        return False


def _is_blocked_saturday(d: date, holidays: frozenset) -> bool:
    """A Saturday that IMMEDIATELY FOLLOWS a holiday is unavailable for optimization.
    'Immediately follows' = the calendar day before it (the Friday) is a holiday.
    Such Saturdays must never be allocated, displaced onto, or counted as occupancy."""
    return d.weekday() == 5 and (d - timedelta(days=1)) in holidays


def _is_sat_business_day(d: date, holidays: frozenset) -> bool:
    """Mon–Sat workday calendar (Sunday + holidays excluded). A Saturday that
    immediately follows a holiday (Friday holiday) is ALSO excluded — it is treated as
    unavailable, so the Saturday-enabled advance simply skips it like a Sunday/holiday."""
    if d in holidays:
        return False
    if d.weekday() == 6:
        return False
    if d.weekday() == 5:
        return not _is_blocked_saturday(d, holidays)
    return True  # Mon–Fri


def _add_sat_business_days(start: date, n: int, holidays: frozenset) -> date:
    """Advance n days on the Mon–Sat (Saturday-enabled) calendar."""
    if n == 0:
        return start
    cur, rem = start, n
    while rem > 0:
        cur += timedelta(days=1)
        if _is_sat_business_day(cur, holidays):
            rem -= 1
    return cur


def _advance_iso_days_sat(iso_days: set[str], d: int, holidays: frozenset) -> frozenset[str]:
    """Shift forward by d days on the Saturday-enabled (Mon–Sat) calendar."""
    if d == 0:
        return frozenset(iso_days)
    out: set[str] = set()
    for iso in iso_days:
        try:
            base = date.fromisoformat(iso)
        except (ValueError, TypeError):
            continue
        out.add(_add_sat_business_days(base, d, holidays).isoformat())
    return frozenset(out)


def _compact_block_day_map(
    day_isos: set[str], d: int, holidays: frozenset
) -> dict[date, date]:
    """old_day → new_day mapping that lays the DISTINCT days of a target-WS (WS40/WS50)
    block onto a CONTIGUOUS Mon–Sat run, shifted by d.

    The run starts at (earliest day advanced d Sat-business-days) and then assigns one
    consecutive Sat-business-day per distinct old day. This is what makes a displaced
    block continuous WITH Saturdays: two originally-adjacent Mon–Fri cells that straddle
    a weekend (Fri→Mon) are 2 Sat-calendar days apart, so a per-cell advance leaves the
    now-working Saturday between them EMPTY (the internal gap). Packing the distinct days
    contiguously fills that Saturday and pulls the tail in — the recovered day(s).

    d>0 is assumed (the caller gates on use_saturdays AND a real forward shift; a 0-shift
    block must stay exactly where it is and is never compacted). Used by BOTH the solver
    occupancy model and the records rebuild so their day-sets always agree."""
    days: list[date] = sorted(
        {date.fromisoformat(x) for x in day_isos if isinstance(x, str) and len(x) >= 10}
    )
    if not days:
        return {}
    mp: dict[date, date] = {}
    cur = _add_sat_business_days(days[0], d, holidays)
    for od in days:
        mp[od] = cur
        cur = _add_sat_business_days(cur, 1, holidays)
    return mp


def _compact_target_block_sat(
    target_layout: dict[str, set[str]], d: int, holidays: frozenset
) -> dict[str, frozenset[str]]:
    """Apply _compact_block_day_map to a LOCO's TARGET-WS layout ({ws_n: {iso, …}}),
    returning {ws_n: frozenset(new_iso)} with each cell remapped to its contiguous slot.
    A shared boundary day (half-day handoff present on both WS) maps consistently for both.
    """
    all_isos: set[str] = set()
    for days in target_layout.values():
        all_isos |= set(days)
    mp = _compact_block_day_map(all_isos, d, holidays)
    out: dict[str, frozenset[str]] = {}
    for ws_n, days in target_layout.items():
        landed: set[str] = set()
        for iso in days:
            try:
                landed.add(mp[date.fromisoformat(iso)].isoformat())
            except (ValueError, TypeError, KeyError):
                continue
        out[ws_n] = frozenset(landed)
    return out


def _advance_layout_sat(
    layout: dict[str, set[str]], d: int, holidays: frozenset
) -> dict[str, frozenset[str]]:
    """Advance a LOCO's FULL WS layout by d with Saturdays enabled:
      • TARGET WS (WS40/WS50) are compacted as ONE contiguous block (continuous, uses
        Saturdays, recovers tail days) — but only for d>0; a 0-shift keeps them in place.
      • NON-target WS advance per-cell on the Mon–Sat calendar (the final rebuild moves
        them by the EFFECTIVE weekday delay and the sanitizer pushes any Saturday landing
        to the next weekday; conflicts are only counted on target WS, so this is safe).
    Mirror of the records-side logic so the solver's occupancy == the rebuilt occupancy."""
    target_layout = {ws: set(v) for ws, v in layout.items() if _is_target_ws(_norm_ws(ws))}
    out: dict[str, frozenset[str]] = {}
    if d > 0 and target_layout:
        out.update(_compact_target_block_sat(target_layout, d, holidays))
    else:
        for ws_n, days in target_layout.items():
            out[ws_n] = _advance_iso_days_sat(days, d, holidays)
    for ws_n, days in layout.items():
        if _is_target_ws(_norm_ws(ws_n)):
            continue
        out[ws_n] = _advance_iso_days_sat(days, d, holidays)
    return out


def _weekday_window_full(
    sat_iso: str,
    occupied: set[str],
    holidays: frozenset,
) -> bool:
    """
    True iff the Mon–Fri of the Saturday's OWN calendar week is fully occupied:
    every non-holiday weekday (Mon–Fri) in that window is present in `occupied`.
    `occupied` = the ISO days this LOCO holds on this target WS (after the shift).
    A Saturday whose week is full is a 'preferred' Saturday (no penalty).
    """
    try:
        sat = date.fromisoformat(sat_iso)
    except (ValueError, TypeError):
        return False
    monday = sat - timedelta(days=sat.weekday())  # Mon of that week
    for off in range(5):  # Mon..Fri
        wd = monday + timedelta(days=off)
        if wd in holidays:
            continue          # holiday weekdays don't count against saturation
        if wd.isoformat() not in occupied:
            return False
    return True


def _solve_gurobi(
    ms_by_wo: dict,
    rt_rows: list,
    holidays: frozenset,
    protection_days: dict[str, int],
    initial_ws_days: dict,
    conflicts: list,
    log_fn: Callable[[str], None],
    time_limit: float,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    use_saturdays: bool = False,
    es44_keys: set[str] | None = None,
    immutable_locos: set[str] | None = None,
    allow_overlap: bool = False,
    loco_type: dict[str, str] | None = None,
) -> dict[str, int]:
    """
    Single true MIP — Gurobi Branch-and-Bound explores ALL shift combinations.

    ES44 swap (es44_keys, available in EVERY strategy): for each LOCO whose key is in
    es44_keys AND whose WS40/WS50 form a clean WS40-then-WS50 block, the solver may
    EXCHANGE the execution order of WS40 and WS50 (each keeps its own duration,
    successors anchored). Modeled as an extra per-option swap flag: every shift
    option d also gets a swapped twin whose WS40/WS50 day-cells are reordered. The
    swapped occupancy flows through the SAME slack (conflict) constraints, so the
    swap is chosen only when it lowers conflicts (or PD) under the normal objective.
    Returns (shifts, swap_flags) — swap_flags[key]=True when that LOCO's chosen
    option is the swapped layout.

    Decision: each conflicting LOCO l picks exactly one shift d in [0, PD(l)] via
    binary x[l,d] (assignment constraint sum_d x[l,d] = 1). Shifting a LOCO by d
    business days rigidly advances all its target-WS days by d (downstream ops keep
    spacing), so occupancy at each shift is precomputed once — no per-node rebuild.

    Conflict counting (compact cell-packing — fits size-limited Gurobi licenses):
    ONE constraint per target-WS cell, not O(options^2) pairwise links:
      occ(cell) = sum x landing there + (# LOCOs fixed on cell)
      slack[cell] >= occ - 1 >= 0
    Minimizing sum(slack) forces <=1 occupant per cell (== zero conflicts). Exact
    for 2-LOCO clashes; for k>=3 on one cell counts k-1 vs C(k,2) pairs (monotone
    proxy, slack=0 iff truly 0). The HONEST pair count logged at the end comes from
    _detect_conflicts re-run on the chosen shifts, so it matches the Schedule view.

    Objective hierarchy (strict two-pass — conflicts UNCONDITIONALLY first):
      PASS 1: minimize sum(slack) alone        -> true minimum conflict count
      LOCK:   sum(slack) <= achieved_minimum   -> hard constraint
      PASS 2: minimize sum(d * x[l,d]) (+tiny Saturday tie-break) subject to LOCK
              -> least PD consumed WITHIN the conflict-optimal set.
    Reducing Protection Days can never re-introduce a conflict Pass 1 removed.
    Each pass gets its own time budget, so the conflict pass is never starved.

    Gurobi runs the FULL time_limit, branching on x, keeping many feasible
    combinations alive. It stops only on proven-optimal, zero conflicts, or time.
    No outer iteration, no greedy fixing, no early no-improvement bailout.
    Returns {loco_key: shift_business_days}.
    """
    if not _GUROBI_AVAILABLE:
        raise RuntimeError("Gurobi nao disponivel. Instale gurobipy e uma licenca valida.")

    scoped = _scope_ws_days(initial_ws_days, loco_filter, date_from, date_to)

    # LOCOs that participate in at least one conflict (these are the only ones we
    # let move; everything else stays fixed at shift 0 and contributes its days).
    conflict_locos: set[str] = set()
    for wo1, tn1, wo2, tn2, ws_n in conflicts:
        conflict_locos.add(_loco_key(wo1, tn1))
        conflict_locos.add(_loco_key(wo2, tn2))

    # Base target-WS days (shift 0) for every LOCO in scope, per WS.
    base_ws_days: dict[str, dict[str, set[str]]] = {}
    for lk, ws_dict in scoped.items():
        tgt = {ws_n: days for ws_n, days in ws_dict.items() if _is_target_ws(ws_n)}
        if tgt:
            base_ws_days[lk] = tgt

    # Primary movers = LOCOs that participate in a conflict and can change something:
    # either they have PD to shift, OR they are ES44-eligible and can SWAP WS40↔WS50
    # (the swap consumes no PD, so a PD=0 ES44 LOCO is still a real mover).
    # Immutable LOCOs (start before the loaded window) are NEVER moved — they stay as
    # fixed occupants so in-window conflicts are still counted against them, but the
    # solver may not shift or swap them (that would rewrite out-of-scope history).
    immutable = immutable_locos or set()
    es44_movers = (es44_keys or set()) - immutable
    conflict_movable = sorted(
        lk for lk in conflict_locos
        if lk in base_ws_days
        and lk not in immutable
        and (protection_days.get(lk, 0) > 0 or lk in es44_movers)
    )

    if not conflict_movable:
        log_fn("[OPTIMIZER] Nenhuma LOCO em conflito elegível (sem Protection Days nem swap ES44) - nenhum shift possível")
        return {}, {}, {}

    # ── Helper movers (non-conflicting LOCOs that can VACATE a contested cell) ──
    # A non-conflicting LOCO with PD>0 may delay forward to free a target-WS cell so
    # a conflicting LOCO can shift onto it — a legitimate, PD-bounded forward move.
    # Only worth modelling when its base target-WS cells INTERSECT a cell that some
    # conflict LOCO could reach (otherwise moving it cannot help). PD stays forward-
    # only, so the business rule is preserved.
    #
    # Build the set of cells any conflict-mover could occupy across its shift range.
    reachable_cells: set[tuple[str, str]] = set()
    for lk in conflict_movable:
        pd = protection_days.get(lk, 0)
        layout = base_ws_days[lk]
        for d in range(0, pd + 1):
            # Use the SAME layout-advance (Saturday block-compaction) the option occupancy
            # and the rebuild use, so the reachable set matches what a mover can truly occupy.
            landed = (
                _advance_layout_sat(layout, d, holidays) if use_saturdays
                else {ws_n: _advance_iso_days(days, d, holidays) for ws_n, days in layout.items()}
            )
            for ws_n, isos in landed.items():
                for iso in isos:
                    reachable_cells.add((ws_n, iso))

    # Per-WS day SPAN any conflict-mover could touch across its full shift range.
    # A helper that sits inside this span (even if not on an exact reachable cell yet)
    # may need to step aside so a cascade of forward shifts can resolve a clash — give
    # the solver that freedom. The license guard below caps the resulting model size.
    reachable_ws_span: dict[str, tuple[str, str]] = {}
    for (ws_n, iso) in reachable_cells:
        lo, hi = reachable_ws_span.get(ws_n, (iso, iso))
        reachable_ws_span[ws_n] = (min(lo, iso), max(hi, iso))

    conflict_set = set(conflict_movable)
    helper_candidates = []
    for lk, ws_dict in base_ws_days.items():
        if lk in conflict_set or protection_days.get(lk, 0) <= 0:
            continue
        if lk in immutable:
            continue          # history-anchored: never vacate/move (immutable occupant)
        # Eligible if it sits on a cell a conflict-mover wants (direct block) OR within
        # the contested day-span on a shared target WS (potential cascade participant).
        blocks = False
        for ws_n, days in ws_dict.items():
            span = reachable_ws_span.get(ws_n)
            for iso in days:
                if (ws_n, iso) in reachable_cells or (span and span[0] <= iso <= span[1]):
                    blocks = True
                    break
            if blocks:
                break
        if blocks:
            helper_candidates.append(lk)
    helper_candidates.sort()

    # ── License-size guard ────────────────────────────────────────────────────
    # The size-limited Gurobi license caps vars/constrs at 2000. x-vars ≈ Σ(PD+1)
    # over movers. Always include every conflict-mover; add helper LOCOs only while
    # the running var estimate stays under a safe budget (slack vars + assignment
    # constraints are roughly proportional, so a var cap keeps the whole model legal).
    VAR_BUDGET = 1500
    est_vars = sum(protection_days.get(lk, 0) + 1 for lk in conflict_movable)
    helpers: list[str] = []
    for lk in helper_candidates:
        cost = protection_days.get(lk, 0) + 1
        if est_vars + cost > VAR_BUDGET:
            continue
        helpers.append(lk)
        est_vars += cost

    movable = sorted(conflict_movable + helpers)
    fixed   = [lk for lk in base_ws_days if lk not in set(movable)]

    n_models = len({_split_loco_key(lk)[0] for lk in movable})
    log_fn(
        f"[OPTIMIZER] LOCOs móveis={len(movable)} "
        f"(conflito={len(conflict_movable)} + auxiliares={len(helpers)}/{len(helper_candidates)} cand.)  "
        f"Modelos={n_models}  fixas={len(fixed)}"
    )

    env = gp.Env(empty=True)
    env.setParam("OutputFlag", 0)
    env.start()
    m = gp.Model(env=env)
    m.Params.OutputFlag = 0
    m.Params.TimeLimit = time_limit
    m.Params.MIPGap = 0.0
    m.Params.MIPFocus = 1          # focus on finding/improving feasible solutions
    m.Params.Threads = 0          # use all cores for B&B

    # x_vars keyed by (loco_key, shift_d, swap_flag). swap_flag is 0 normally; 1 marks
    # the ES44 WS40↔WS50 reordered twin of that shift option (only built for eligible
    # LOCOs with a valid swap layout). Exactly one (d, sw) per LOCO via the assignment
    # constraint, so swap and shift are chosen jointly under the one objective.
    x_vars: dict[tuple[str, int, int], Any] = {}
    shift_cost_terms = []
    t_build = time.time()

    # ── Precompute ES44 swapped base layouts (shift-0) per eligible movable LOCO ──
    # base_swapped[lk] = {ws_n: frozenset(iso)} with WS40/WS50 reordered; only present
    # when this LOCO is ES44-eligible AND has a clean WS40-then-WS50 block. Swapping
    # never touches non-target WS days, so those carry through unchanged.
    es44_set = es44_keys or set()
    swap_add = _add_sat_business_days if use_saturdays else _add_business_days
    base_swapped: dict[str, dict[str, set[str]]] = {}
    # Diagnostics so a "0 valid layouts" run reveals WHY each eligible LOCO was rejected.
    _swap_diag = {"in_movable": 0, "no_ws40_or_ws50": 0, "layout_none": 0, "ok": 0}
    _swap_diag_examples: list[str] = []
    if es44_set:
        for lk in movable:
            if lk not in es44_set:
                continue
            _swap_diag["in_movable"] += 1
            ws_dict = base_ws_days.get(lk, {})
            ws40 = ws_dict.get(SWAP_WS_FIRST)
            ws50 = ws_dict.get(SWAP_WS_SECOND)
            if not ws40 or not ws50:
                _swap_diag["no_ws40_or_ws50"] += 1
                if len(_swap_diag_examples) < 4:
                    _swap_diag_examples.append(
                        f"{_label_loco(lk)}: WS40={sorted(ws40) if ws40 else '∅'} "
                        f"WS50={sorted(ws50) if ws50 else '∅'}"
                    )
                continue
            swapped = _swap_ws_layout(ws40, ws50, holidays, swap_add)
            if swapped is None:
                _swap_diag["layout_none"] += 1
                if len(_swap_diag_examples) < 4:
                    a = sorted(ws40); b = sorted(ws50)
                    # Rejection (order-agnostic) = true interleave: predecessor extends
                    # strictly past successor's first day.
                    if a[0] <= b[0]:
                        pred, succ = a, b
                    else:
                        pred, succ = b, a
                    _swap_diag_examples.append(
                        f"{_label_loco(lk)}: WS40[{a[0]}..{a[-1]}] WS50[{b[0]}..{b[-1]}] "
                        f"(interleave? pred_last={pred[-1]} > succ_first={succ[0]} = {pred[-1] > succ[0]})"
                    )
                continue
            new40, new50 = swapped
            merged = {ws_n: set(days) for ws_n, days in ws_dict.items()}
            merged[SWAP_WS_FIRST] = set(new40)
            merged[SWAP_WS_SECOND] = set(new50)
            base_swapped[lk] = merged
            _swap_diag["ok"] += 1
    if es44_set:
        log_fn(
            f"[MODEL] ES44 swap diag: ES44∈móveis={_swap_diag['in_movable']}  "
            f"sem_WS40/WS50={_swap_diag['no_ws40_or_ws50']}  "
            f"layout_inválido={_swap_diag['layout_none']}  válidos={_swap_diag['ok']}"
        )
        for ex in _swap_diag_examples:
            log_fn(f"[MODEL]   ex: {ex}")

    # cell_options[(ws, day)] = list of (loco_key, shift_d, x_var) movable options
    # landing on that cell;  plus fixed LOCO occupants (constant present=1).
    cell_options: dict[tuple[str, str], list] = defaultdict(list)
    cell_fixed: dict[tuple[str, str], set[str]] = defaultdict(set)
    for lf in fixed:
        for ws_n, days in base_ws_days[lf].items():
            for d in days:
                cell_fixed[(ws_n, d)].add(lf)

    # Saturday penalty terms (P0): each entry is the x-var for a (lk, d) choice that
    # lands a WS40/WS50 op on a Saturday whose own Mon–Fri week is NOT fully occupied.
    # Saturated-week Saturdays are NOT penalized (they are the 'preferred' Saturdays).
    sat_penalty_terms = []
    n_sat_options = 0
    n_sat_penalized = 0
    n_swap_options = 0

    for lk in movable:
        pd = protection_days.get(lk, 0)
        # Layouts this LOCO may pick: shift-0 base, plus (if eligible) the swapped base.
        layouts: list[tuple[int, dict[str, set[str]]]] = [(0, base_ws_days[lk])]
        if lk in base_swapped:
            layouts.append((1, base_swapped[lk]))
        xs = []
        for sw, layout in layouts:
            for d in range(0, pd + 1):
                x = m.addVar(vtype=GRB.BINARY, name=f"x_{len(x_vars)}")
                x_vars[(lk, d, sw)] = x
                xs.append(x)
                if sw == 1:
                    n_swap_options += 1
                if d > 0:
                    shift_cost_terms.append(d * x)
                # Per-option landed target-WS occupancy — needed to judge week saturation.
                # Saturday block-compaction (_advance_layout_sat) makes the target block
                # contiguous, so the occupancy the solver proves == the rebuilt schedule.
                if use_saturdays:
                    landed = _advance_layout_sat(layout, d, holidays)
                else:
                    landed = {
                        ws_n: _advance_iso_days(days, d, holidays)
                        for ws_n, days in layout.items()
                    }
                for ws_n, advanced in landed.items():
                    adv_frozen = frozenset(advanced)   # this loco's day-set on ws_n (for boundary test)
                    for iso in advanced:
                        cell_options[(ws_n, iso)].append((lk, d, x, adv_frozen))
                # Saturday preference (only when enabled). A Saturday landing is penalized
                # unless the Mon–Fri of its week is fully occupied by THIS LOCO on THIS WS.
                if use_saturdays:
                    penalize_this_option = False
                    for ws_n, advanced in landed.items():
                        occ = set(advanced)
                        for iso in advanced:
                            if not _is_saturday(iso):
                                continue
                            n_sat_options += 1
                            if not _weekday_window_full(iso, occ, holidays):
                                penalize_this_option = True
                    if penalize_this_option:
                        sat_penalty_terms.append(x)
                        n_sat_penalized += 1
        m.addConstr(gp.quicksum(xs) == 1, name=f"assign_{len(x_vars)}")

    if es44_set:
        log_fn(
            f"[MODEL] ES44 swap: {len(base_swapped)} LOCO(s) elegível(eis) com layout "
            f"WS40↔WS50 válido  opções-swap={n_swap_options}"
        )

    # ── Compact cell-packing conflict counting (size-limited-license friendly) ─
    # ONE constraint per target-WS cell instead of O(options^2) pairwise links:
    #   occ(cell) = sum of x's landing there + (count of LOCOs fixed on that cell)
    #   slack[cell] >= occ - 1,  slack >= 0
    # slack = surplus LOCOs sharing the cell. Minimizing sum(slack) drives every
    # cell to <=1 occupant (== zero conflicts). Exact for 2-LOCO clashes
    # (slack 1 = 1 pair); for k>=3 LOCOs on one cell it counts k-1 instead of
    # C(k,2) pairs — a monotone proxy (slack=0 iff truly 0 conflicts). The HONEST
    # pair count for logs/UI comes from _detect_conflicts re-run on the result.
    # Constraints ~= number of active cells (well under the 2000 limit).
    # ── Permitted-overlap awareness (matches _detect_conflicts) ───────────────
    # When "Permitir regras de sobreposição" is ON, an EXACTLY-two-LOCO share of a
    # target-WS cell is NOT a conflict when the pair is exempt (allowed cross-type
    # pair OR end/start boundary handoff). The objective must NOT penalize such a
    # permitted overlap, and the solver must be FREE to create one if it removes a
    # non-permitted conflict. We model this with a per-cell `credit` that cancels the
    # slack of one exempt pair, but ONLY when the cell holds exactly two occupants:
    #   slack >= occ - 1 - credit,   0 <= credit <= Σ(exempt-pair indicators),
    #   credit <= 3 - occ   → forces credit=0 once occ>=3 (3+ is always a conflict,
    #                          mirroring the exactly-2 rule in _detect_conflicts).
    overlap_credit = bool(allow_overlap) and loco_type is not None

    def _pair_permitted(ws_n: str, iso: str, ka: str, da, kb: str, db) -> bool:
        # TYPE rule — allowed cross-type pair (shift-independent).
        if _is_overlap_allowed_pair(loco_type.get(ka, "other"), loco_type.get(kb, "other")):
            return True
        # BOUNDARY rule — iso is the END of one and the START of the other on this WS.
        la, fa = (max(da), min(da)) if da else (None, None)
        lb_, fb = (max(db), min(db)) if db else (None, None)
        return (iso == la and iso == fb) or (iso == lb_ and iso == fa)

    slack_terms = []
    n_slack = 0
    n_credit = 0       # cells needing a boundary-handoff credit var (small)
    n_skip_perm = 0    # cells dropped entirely as always-permitted (no var at all)
    n_credit_skipped = 0
    # Running variable estimate so the OPTIONAL boundary credit never pushes the model
    # past the size-limited Gurobi license (~2000 vars/constrs). Slack vars are mandatory
    # (they carry the conflict objective); credit/y vars are a refinement, so when the
    # model is already large we fall back to plain slack (a handoff may then count as a
    # conflict — safe, never a license failure). x-vars already exist; +slack below.
    CREDIT_VAR_BUDGET = 1850
    approx_vars = len(x_vars)
    for (ws_n, iso), opts in cell_options.items():
        fixed_here = cell_fixed.get((ws_n, iso), set())
        base_fixed = len(fixed_here)
        movers = {lk for (lk, _, _, _) in opts}
        distinct = movers | fixed_here
        # A clash needs >=2 LOCOs total possibly present on this cell.
        if len(distinct) < 2:
            continue
        if len(movers) < 2 and base_fixed == 0:
            continue

        # ── Permitted-overlap pruning (only when the rule is on) ──────────────────
        # MODEL-SIZE FIX: when the ONLY two LOCOs that can ever share this cell are a
        # TYPE-permitted pair (allowed regardless of boundary — New Locos × Overhaul /
        # Motor Diesel), the cell can NEVER be a non-permitted conflict (≤2 occupants),
        # so it needs NO slack/credit/aux variable at all — exactly what _detect_conflicts
        # concludes. This drops the bulk of the cells (the ES44 type-compatible pairs) that
        # otherwise exploded the model past the size-limited Gurobi license. Boundary-only
        # exemptions (handoffs) are choice-dependent, so those few cells keep a credit var;
        # 3+ -LOCO cells are always a conflict (the slack proxy) and get no credit.
        build_credit = False
        if overlap_credit and len(distinct) == 2:
            a, b = sorted(distinct)
            if _is_overlap_allowed_pair(loco_type.get(a, "other"), loco_type.get(b, "other")):
                n_skip_perm += 1
                continue
            build_credit = True   # 2 LOCOs, not type-exempt → may still be a boundary handoff

        occ = gp.quicksum(x for (_, _, x, _) in opts) + base_fixed
        # INTEGER slack: occ is integral, so slack is integral at any optimum, but
        # declaring it integer tightens the LP relaxation during branch-and-bound —
        # fractional slack can no longer mask conflict cost, giving stronger bounds,
        # faster convergence, and fewer timeouts on a conflict-bearing incumbent.
        sl = m.addVar(vtype=GRB.INTEGER, lb=0.0, name=f"sl_{n_slack}")
        approx_vars += 1

        credit_expr = None
        # Skip the optional credit once the model nears the license cap (leave ~6 vars head).
        if build_credit and approx_vars >= CREDIT_VAR_BUDGET - 6:
            build_credit = False
            n_credit_skipped += 1
        if build_credit:
            # Exactly two LOCOs that are NOT type-exempt: credit a BOUNDARY handoff (end of
            # one == start of the other) so a valid handoff costs 0 while a real multi-day
            # overlap still costs. Only a handful of cells reach here, so the var count stays
            # tiny. Occupants: movable options (present=x) plus the fixed LOCO (present=1).
            occupants = [(lk, x, dset) for (lk, _d, x, dset) in opts]
            for lf in fixed_here:
                occupants.append((lf, None, frozenset(base_ws_days.get(lf, {}).get(ws_n, ()))))
            ys = []
            for i in range(len(occupants)):
                ka, pa, da = occupants[i]
                for j in range(i + 1, len(occupants)):
                    kb, pb, db = occupants[j]
                    if ka == kb:
                        continue          # same LOCO's mutually-exclusive options — never a pair
                    if not _pair_permitted(ws_n, iso, ka, da, kb, db):
                        continue          # not type-exempt (already handled) → only boundary qualifies
                    y = m.addVar(vtype=GRB.BINARY, name=f"ov_{n_credit}_{i}_{j}")
                    approx_vars += 1
                    if pa is not None:
                        m.addConstr(y <= pa)
                    if pb is not None:
                        m.addConstr(y <= pb)
                    ys.append(y)
            if ys:
                # credit ∈ {0,1}: the boundary handoff is forgiven only when the cell holds
                # exactly two occupants (credit <= 3 - occ).
                credit = m.addVar(vtype=GRB.INTEGER, lb=0.0, ub=1.0, name=f"ovc_{n_credit}")
                approx_vars += 1
                m.addConstr(credit <= gp.quicksum(ys))
                m.addConstr(credit <= 3 - occ)
                credit_expr = credit
                n_credit += 1

        if credit_expr is not None:
            m.addConstr(sl >= occ - 1 - credit_expr, name=f"slc_{n_slack}")
        else:
            m.addConstr(sl >= occ - 1, name=f"slc_{n_slack}")
        slack_terms.append(sl)
        n_slack += 1
    if overlap_credit:
        log_fn(f"[MODEL] Sobreposição permitida: {n_skip_perm} célula(s) isenta(s) sem variável "
               f"(par tipo-permitido) + {n_credit} crédito(s) de fronteira"
               + (f"  [{n_credit_skipped} crédito(s) omitido(s) p/ caber na licença]" if n_credit_skipped else ""))

    log_fn(
        f"[MODEL] Vars x={len(x_vars)}  packing(slack)={n_slack}  celulas={len(cell_options)}"
        f"  ({time.time()-t_build:.2f}s build)"
    )
    # Total model size by category vs the size-limited Gurobi license (~2000 each).
    m.update()
    log_fn(
        f"[MODEL] Tamanho: vars={m.NumVars} (x={len(x_vars)}, slack={n_slack}, "
        f"overlap-credit≈{approx_vars - len(x_vars) - n_slack})  constrs={m.NumConstrs}  "
        f"(limite da licença ≈ 2000)"
    )
    if use_saturdays:
        log_fn(
            f"[MODEL] Sábados: opções com sábado={n_sat_options}  "
            f"penalizadas(semana incompleta)={n_sat_penalized}"
        )

    # ── Strict THREE-tier lexicographic hierarchy ─────────────────────────────
    #   PASS 1: minimize sum(slack) ALONE            → true minimum conflict count.
    #   LOCK:   sum(slack) <= achieved_minimum.
    #   PASS 2: minimize Protection Days ALONE        → least PD within the conflict-
    #           optimal set. (Saturday preference is NOT here — PD must never be
    #           spent to dodge a Saturday.)
    #   LOCK:   pd_expr <= achieved_PD_minimum.
    #   PASS 3: minimize non-saturated Saturday count → pure aesthetic tie-break
    #           among solutions already optimal in (conflicts, PD).
    #
    # KEY for the Saturday requirement: Pass 1 carries NO Saturday penalty, so the
    # solver is FREE to land a WS40/WS50 op on a Saturday whenever that RESOLVES a
    # conflict — even when weekdays in the period still have unused capacity. The
    # Mon–Sat shift options (_advance_iso_days_sat) make Saturday cells first-class
    # occupancy in the slack constraints, so Saturday is a genuine conflict-resolution
    # mechanism, not overflow. The saturated-week preference only re-ranks ties in P3,
    # never blocking a conflict-clearing Saturday and never costing extra PD.
    #
    # Each pass gets its own time budget; the conflict pass is never starved.
    m.ModelSense = GRB.MINIMIZE
    slack_expr = gp.quicksum(slack_terms) if slack_terms else gp.LinExpr(0.0)
    pd_expr    = gp.quicksum(shift_cost_terms) if shift_cost_terms else gp.LinExpr(0.0)
    sat_expr   = gp.quicksum(sat_penalty_terms) if sat_penalty_terms else gp.LinExpr(0.0)

    # ── Callback: log incumbents + live B&B progress heartbeat ────────────────
    t0 = time.time()
    last_cb = [0.0]
    last_prog = [0.0]
    best_conf = [float("inf")]
    movable_xs = {
        lk: [(d, x) for (klk, d, _sw), x in x_vars.items() if klk == lk]
        for lk in movable
    }

    def _cb(model, where):
        # Live progress heartbeat: one concise line every ~1.5 s while branch-and-bound
        # runs, so the Schedule terminal streams nodes/incumbente/bound/gap/time even
        # when no new incumbent is found.
        if where == GRB.Callback.MIP:
            try:
                now = model.cbGet(GRB.Callback.RUNTIME)
                if now - last_prog[0] < 1.5:
                    return
                last_prog[0] = now
                nodes  = model.cbGet(GRB.Callback.MIP_NODCNT)
                objbst = model.cbGet(GRB.Callback.MIP_OBJBST)
                objbnd = model.cbGet(GRB.Callback.MIP_OBJBND)
                solcnt = model.cbGet(GRB.Callback.MIP_SOLCNT)
                has_inc = solcnt > 0 and abs(objbst) < 1e30
                if has_inc and abs(objbnd) < 1e30:
                    denom = max(1e-10, abs(objbst))
                    gap_s = f"{abs(objbst - objbnd) / denom * 100.0:.1f}%"
                else:
                    gap_s = "—"
                inc_s = f"{objbst:.1f}" if has_inc else "—"
                bnd_s = f"{objbnd:.1f}" if abs(objbnd) < 1e30 else "—"
                log_fn(f"  Gurobi | nós={int(nodes)}  obj={inc_s}  bound={bnd_s}  "
                       f"gap={gap_s}  soluções={int(solcnt)}  t={now:.1f}s")
            except Exception:
                pass
            return
        if where != GRB.Callback.MIPSOL:
            return
        now = time.time()
        try:
            conf = sum(round(model.cbGetSolution(s)) for s in slack_terms) if slack_terms else 0
        except Exception:
            return
        # Always log a strictly-better incumbent; otherwise throttle to 0.3s.
        if conf >= best_conf[0] and now - last_cb[0] < 0.3:
            return
        last_cb[0] = now
        if conf < best_conf[0]:
            best_conf[0] = conf
        try:
            pd_used = 0
            for lk, opts in movable_xs.items():
                for d, x in opts:
                    if d > 0 and model.cbGetSolution(x) > 0.5:
                        pd_used += d
        except Exception:
            pd_used = -1
        elapsed = now - t0
        log_fn(f"  Incumbente | slack={conf}  PD={pd_used}d  t={elapsed:.1f}s")

    def _run(label: str, budget: float):
        m.Params.TimeLimit = max(1.0, budget)
        try:
            m.optimize(_cb)
        except TypeError:
            m.optimize()
        st = {2: "OPTIMAL", 3: "INFEASIBLE", 9: "TIME_LIMIT", 11: "SUBOPTIMAL",
              5: "UNBOUNDED", 13: "SUBOPTIMAL"}.get(m.Status, f"STATUS_{m.Status}")
        log_fn(f"[OPTIMIZER] {label}: {st}  t={time.time()-t0:.1f}s")
        return st

    # Budget split: conflicts get the bulk (primary), PD next, Saturday tie-break a
    # small slice (only used when Saturdays are on). The conflict pass is never starved.
    has_sat_tier = use_saturdays and bool(sat_penalty_terms)
    if slack_terms:
        conflict_budget = time_limit * (0.6 if has_sat_tier else 0.7)
        sat_budget      = time_limit * 0.1 if has_sat_tier else 0.0
        pd_budget       = time_limit - conflict_budget - sat_budget
    else:
        conflict_budget = 0.0
        sat_budget      = time_limit * 0.2 if has_sat_tier else 0.0
        pd_budget       = time_limit - sat_budget

    # Big-M weight so conflicts dominate PD whenever Pass-1 optimality is unproven.
    BIG_M = float(sum(protection_days.get(lk, 0) for lk in movable) + 1)

    def _lock_pd_then_saturday():
        """PASS 3: lock PD at its achieved minimum, then minimize the count of
        non-saturated-week Saturdays as a pure aesthetic tie-break. Runs only when
        Saturdays are enabled and the model has penalizable Saturday options. Never
        changes conflicts or PD (both already locked/minimized above)."""
        if not has_sat_tier or m.SolCount == 0:
            return
        try:
            pd_min_val = float(pd_expr.getValue())
        except Exception:
            pd_min_val = None
        if pd_min_val is not None:
            # Small tolerance so a tie-break re-shuffle can't be blocked by rounding.
            m.addConstr(pd_expr <= pd_min_val + 1e-6, name="lock_min_pd")
            log_fn(f"[OPTIMIZER] PD mínimo travado em {pd_min_val:.0f}d; "
                   f"otimizando preferência de sábado (semana saturada) dentro desse conjunto.")
        m.setObjective(sat_expr, GRB.MINIMIZE)
        _run("Fase Sábado (P3, estética)", sat_budget)

    if slack_terms:
        # ── PASS 1: minimize conflicts ALONE (Saturdays free to resolve them) ─
        m.setObjective(slack_expr, GRB.MINIMIZE)
        p1_status = _run("Fase conflitos (P1)", conflict_budget)
        if m.SolCount > 0 and p1_status == "OPTIMAL":
            # Pass 1 PROVEN optimal → hard-lock the exact minimum conflict count.
            min_conflicts = int(round(m.ObjVal))
            m.addConstr(slack_expr <= min_conflicts, name="lock_min_conflicts")
            log_fn(f"[OPTIMIZER] Conflitos mínimos (ótimo provado) travados em slack<={min_conflicts}; "
                   f"otimizando Protection Days dentro desse conjunto.")
            # ── PASS 2: minimize PD ALONE (no Saturday term — PD never spent to
            #            dodge a Saturday) ─────────────────────────────────────
            m.setObjective(pd_expr, GRB.MINIMIZE)
            _run("Fase Protection Days (P2)", pd_budget)
            # ── PASS 3: Saturday aesthetic tie-break (PD locked) ──────────────
            _lock_pd_then_saturday()
        elif m.SolCount > 0:
            # Pass 1 not proven optimal: keep conflicts dominant so Pass 2 may still
            # REDUCE them, then trade PD. Saturday stays out of the cost (BIG_M·slack
            # ≫ PD means a conflict is never sacrificed to save PD or avoid a Saturday).
            log_fn(f"[OPTIMIZER] Pass 1 não-ótimo ({p1_status}) — sem lock rígido; "
                   f"conflitos mantidos no objetivo com peso dominante (M={int(BIG_M)}).")
            m.setObjective(BIG_M * slack_expr + pd_expr, GRB.MINIMIZE)
            _run("Fase Protection Days (P2)", pd_budget + sat_budget)
        else:
            log_fn("[OPTIMIZER] Pass 1 sem solução — Pass 2 com conflitos dominantes no objetivo.")
            m.setObjective(BIG_M * slack_expr + pd_expr, GRB.MINIMIZE)
            _run("Fase Protection Days (P2)", pd_budget + sat_budget)
    else:
        # No conflicts to resolve — minimize PD, then Saturday aesthetic tie-break.
        m.setObjective(pd_expr, GRB.MINIMIZE)
        _run("Fase Protection Days (sem conflitos)", pd_budget)
        _lock_pd_then_saturday()

    elapsed_total = time.time() - t0
    status_map = {2: "OPTIMAL", 3: "INFEASIBLE", 9: "TIME_LIMIT", 11: "SUBOPTIMAL", 5: "UNBOUNDED", 13: "SUBOPTIMAL"}
    status_str = status_map.get(m.Status, f"STATUS_{m.Status}")

    if m.SolCount == 0:
        env.dispose()
        if m.Status == 3:
            raise RuntimeError("Gurobi: modelo infeasible — verifique as restricoes de PD")
        log_fn(f"[OPTIMIZER] Gurobi {status_str} sem solucao  t={elapsed_total:.2f}s")
        return {}, {}, {}

    # Extract chosen shift (and swap flag) per movable LOCO.
    result: dict[str, int] = {}
    chosen_d: dict[str, int] = {}
    swap_flags: dict[str, bool] = {}
    for (lk, d, sw), x in x_vars.items():
        if x.X > 0.5:
            chosen_d[lk] = d           # the selected option (incl. d=0)
            if sw == 1:
                swap_flags[lk] = True
        if d > 0 and x.X > 0.5:
            result[lk] = d

    # Effective WS-day layout per LOCO under its chosen option (swapped base when the
    # swap twin was picked) — used to test Saturday landings on the REAL chosen cells.
    def _chosen_base(lk: str) -> dict[str, set[str]]:
        if swap_flags.get(lk) and lk in base_swapped:
            return base_swapped[lk]
        return base_ws_days.get(lk, {})

    # Saturday relocation map: for each movable LOCO whose chosen option lands a
    # WS40/WS50 op on a Saturday (Mon–Sat advance), record the day-count so the
    # caller can physically place those ops on Saturdays in the rebuilt schedule.
    sat_shift: dict[str, int] = {}
    if use_saturdays:
        for lk, d in chosen_d.items():
            if lk not in base_ws_days:
                continue
            lands_on_sat = False
            for ws_n, days in _chosen_base(lk).items():
                for iso in _advance_iso_days_sat(days, d, holidays):
                    if _is_saturday(iso):
                        lands_on_sat = True
                        break
                if lands_on_sat:
                    break
            if lands_on_sat:
                sat_shift[lk] = d

    # Model's residual surplus (slack); the HONEST pairwise count is reported by
    # Phase 4 in the caller (re-detect on the rebuilt Schedule) — avoids a costly
    # extra _build_records here.
    try:
        slack_val = sum(round(s.X) for s in slack_terms)
    except Exception:
        slack_val = -1
    total_pd = sum(result.values())
    env.dispose()
    log_fn(
        f"[OPTIMIZER] Gurobi {status_str}  slack_residual={slack_val}  PD={total_pd}d"
        f"  LOCOs deslocadas={len(result)}  t={elapsed_total:.2f}s"
    )
    if use_saturdays and sat_shift:
        log_fn(f"[OPTIMIZER] LOCOs com WS40/WS50 em sábado={len(sat_shift)}")
    # Swap-mode summary — ALWAYS logged so the terminal shows whether the WS40↔WS50 swap
    # was available this run and how many LOCOs the optimal solution actually swapped.
    n_swapped = len(swap_flags)
    if es44_set:
        if base_swapped:
            log_fn(
                f"[OPTIMIZER] Swap WS40↔WS50: ON — {len(base_swapped)} LOCO(s) ES44 com swap "
                f"disponível; {n_swapped} usada(s) na solução ótima."
            )
            if n_swapped:
                _names = ", ".join(sorted(_label_loco(lk) for lk in swap_flags))
                log_fn(f"[OPTIMIZER] LOCOs trocadas: {_names}")
        else:
            log_fn(
                "[OPTIMIZER] Swap WS40↔WS50: ON — nenhuma LOCO ES44 com bloco WS40→WS50 "
                "válido para troca neste escopo."
            )
    else:
        log_fn("[OPTIMIZER] Swap WS40↔WS50: OFF — nenhuma LOCO ES44 elegível neste escopo.")
    return result, sat_shift, swap_flags


# ── Main public entry point ───────────────────────────────────────────────────

def optimize_conflicts(
    ms_by_wo: dict,
    rt_rows: list,
    log_fn: Callable[[str], None] | None = None,
    time_limit_s: float = TIME_LIMIT_S,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    strategy: str = "shift_full",
    use_saturdays: bool = False,
) -> dict[str, int]:
    """
    Resolve WS40/WS50 conflicts using an iterative LOCO-level Gurobi MIP.
    Conflict detection is scoped to the same set the user sees:
      - only LOCO keys in `loco_filter` (if given), and
      - only days inside [date_from, date_to] (ISO, inclusive; if given).

    strategy:
      "shift_full"          — shift the whole LOCO rigidly (current behavior).
      "shift_conflict_only" — keep predecessors fixed; shift only the conflicting
                              WS (WS40/WS50) and its successors.  [TODO: implement;
                              currently falls back to whole-LOCO shift.]
    use_saturdays:
      When True, WS40/WS50 shift options advance on a Mon–Sat calendar so a target-WS
      op may land on a Saturday. Saturday is a LOW-priority preference (objective P0):
      a Saturday landing is penalized UNLESS the Mon–Fri of its own week is already
      fully occupied by that LOCO on that WS. So the solver fills weekday capacity
      first and only uses a Saturday to extend a saturated week (or when it is the
      only way to resolve a conflict). Off ⇒ standard Mon–Fri calendar.

      The P0 tier re-ranks otherwise-equal (conflicts, PD) solutions toward
      saturated-week Saturdays. To PHYSICALLY place those ops on Saturdays in the
      rebuilt schedule, call optimize_conflicts_ex (returns sat_shift) and pass its
      result to relocate_saturdays_in_records before _assemble_gantt_output.

    Returns {loco_key: shift_in_business_days}.
    For the Saturday-relocation map too, call optimize_conflicts_ex.
    Raises RuntimeError if Gurobi is unavailable.
    """
    shifts, _sat, _swap = optimize_conflicts_ex(
        ms_by_wo, rt_rows, log_fn, time_limit_s,
        loco_filter, date_from, date_to, strategy, use_saturdays,
    )
    return shifts


# ── ES44 eligibility ──────────────────────────────────────────────────────────

def _build_es44_keys(ms_by_wo: dict) -> set[str]:
    """Set of LOCO keys whose WO / Task Name / LOCO serial / MODELO(linha) matches the
    ES44 pattern. These are the only LOCOs the WS40↔WS50 swap move may apply to."""
    keys: set[str] = set()
    for wo, tasks in ms_by_wo.items():
        for t in tasks:
            tn = t.get("task_name") or ""
            linha = t.get("linha") or ""          # MODELO / line identifier
            # task_name doubles as the LOCO name/serial in this dataset.
            if _is_es44(wo, tn, linha):
                keys.add(_loco_key(wo, tn))
    return keys


def optimize_conflicts_ex(
    ms_by_wo: dict,
    rt_rows: list,
    log_fn: Callable[[str], None] | None = None,
    time_limit_s: float = TIME_LIMIT_S,
    loco_filter: set[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    strategy: str = "shift_full",
    use_saturdays: bool = False,
    allow_overlap: bool = False,
    today: str | None = None,
) -> tuple[dict[str, int], dict[str, int], dict[str, bool]]:
    """
    Like optimize_conflicts but also returns the Saturday-relocation map and the ES44
    swap map:
      (shifts, sat_shift, swap_flags)
        sat_shift[loco_key] = day-count whose chosen option lands a WS40/WS50 op on a
          Saturday (only populated when use_saturdays).
        swap_flags[loco_key] = True when the optimizer chose to EXCHANGE that LOCO's
          WS40↔WS50 execution order (only with strategy='es44_swap').
    The caller applies sat_shift / swap_flags to physically reflect them in the rebuild.

    The ES44 WS40↔WS50 swap is NOT a separate strategy: it is an additional candidate
    move offered to the solver in EVERY strategy. For each eligible ES44 LOCO with a
    clean WS40-then-WS50 block, the MIP may exchange their execution order whenever that
    lowers conflicts / PD under the normal objective. The chosen swaps come back in
    swap_flags and the caller reflects them in the rebuild (full or partial).
    """
    _log = log_fn if log_fn else (lambda msg: None)

    # Back-compat: the retired 'es44_swap' card maps onto the partial strategy (the swap
    # itself is now always available regardless of strategy).
    if strategy == "es44_swap":
        strategy = "shift_conflict_only"
    if strategy not in ("shift_full", "shift_conflict_only"):
        strategy = "shift_full"
    _log(
        f"[OPTIMIZER] Estratégia={strategy}  Sábados={'on' if use_saturdays else 'off'}"
        f"  ES44-swap=auto (avaliado em todas as estratégias)"
    )
    if strategy == "shift_conflict_only":
        # The MIP occupancy model is strategy-agnostic: a +d shift advances this LOCO's
        # target-WS (WS40/WS50) days by exactly d whether the WHOLE LOCO moves or only
        # WS40+successors move. So the SAME solver finds the optimal shifts; the strategy
        # only changes the PHYSICAL rebuild — the caller applies the shifts with
        # apply_shifts_conflict_only_records (predecessors stay fixed).
        _log("[OPTIMIZER] reconstrução parcial — desloca apenas WS em conflito + sucessoras (predecessoras fixas)")
    if use_saturdays:
        _log("[OPTIMIZER] Sábados habilitados para WS40/WS50 — preferência: semana Seg–Sex saturada antes de usar sábado")

    holidays = _build_holidays(ms_by_wo)

    # Identify ES44-eligible LOCOs once — ALWAYS (the swap is a candidate move in every
    # strategy, not a dedicated mode). The solver only offers the swap to these LOCOs and
    # only when their WS40/WS50 form a clean swappable block; it is chosen solely when it
    # improves the objective (conflicts/PD), so building the set never forces a swap.
    es44_keys: set[str] = _build_es44_keys(ms_by_wo)
    if loco_filter is not None:
        es44_keys &= loco_filter
    _log(f"[OPTIMIZER] ES44 elegíveis (WO/Task/LOCO/MODELO): {len(es44_keys)} LOCO(s)")

    _log("[OPTIMIZER] Construindo mapa WS-days inicial...")
    t0 = time.time()
    loco_type: dict[str, str] = {}
    initial_ws_days = _compute_loco_ws_days(ms_by_wo, rt_rows, {}, holidays, type_out=loco_type)
    _log(f"[OPTIMIZER] Mapa WS-days: {len(initial_ws_days)} entradas  ({time.time()-t0:.2f}s)")

    # Read PD per LOCO directly from the already-built ws_days — no extra build call
    protection_days = _get_protection_days(ms_by_wo, holidays, loco_ws_days=initial_ws_days)

    # ── History-anchored LOCOs (scope leakage guard) ───────────────────────────
    # RULE (user-specified): a LOCO may be shifted ONLY IF its ENTIRE conflict workstation
    # work (WS40/WS50) AND its ENTIRE Protection-Days buffer are fully inside the loaded
    # visible window [date_from, date_to]. Otherwise the LOCO is IMMUTABLE — it stays a
    # fixed occupant in the model (so in-window conflicts are still counted/resolved
    # against it) but is never itself shifted or swapped.
    #
    # Why both bounds, both blocks:
    #   • target-WS partly BEFORE the window → shifting drags already-completed history
    #     forward (phantom PD/conflicts before the visible period);
    #   • target-WS partly AFTER the window → we'd be moving work the user can't even see;
    #   • PD partly OUTSIDE the window → the shift consumes (drops) PD cells that lie
    #     outside the loaded horizon, i.e. it eats a buffer the user never loaded —
    #     exactly the "Protection Days consumed for LOCOs that originally had none /
    #     historical activities altered" symptom. Requiring the WHOLE PD block to be in
    #     window guarantees every consumed cell is one the user actually sees.
    # With no window bounds (date_from and date_to both None) nothing is out of scope.
    #
    # ── Today boundary (user-specified) ────────────────────────────────────────
    # The optimizer must NEVER modify a Workstation plotted BEFORE Today: historical
    # schedule data stays exactly as loaded. A LOCO whose conflict WS (WS40/WS50) has
    # ANY activity before `today` is frozen — moving or swapping it would advance/reorder
    # cells that lie in the past. Only LOCOs whose entire target-WS block is on/after
    # Today may be evaluated/shifted/swapped. This runs INDEPENDENTLY of the visible
    # window (it applies even when no window is set), but is computed in the same pass.
    immutable_locos: set[str] = set()
    today_frozen = 0
    if date_from or date_to or today:
        def _all_in_window(days: list[str]) -> bool:
            for d in days:
                if date_from and d < date_from:
                    return False
                if date_to and d > date_to:
                    return False
            return True

        for lk, ws_dict in initial_ws_days.items():
            tgt_days = [
                d for ws_n, days in ws_dict.items() if _is_target_ws(ws_n) for d in days
            ]
            pd_days = [
                d for ws_n, days in ws_dict.items() if _is_protection_ws(ws_n) for d in days
            ]
            # Today boundary: any conflict-WS day strictly before Today ⇒ immutable. The
            # target WS IS what the solver shifts/swaps, so freezing here guarantees no
            # pre-Today activity (incl. an ES44 WS40↔WS50 reorder) is ever touched.
            if today and tgt_days and any(d < today for d in tgt_days):
                immutable_locos.add(lk)
                today_frozen += 1
                continue
            # Window guard (only when a visible window is set): movable only when BOTH the
            # full target-WS block AND the full PD block (when the LOCO has one) are inside
            # the window. A LOCO with no target-WS days isn't a conflict mover anyway, but
            # if its target work isn't fully loaded, freeze it.
            if date_from or date_to:
                if not tgt_days or not _all_in_window(tgt_days):
                    immutable_locos.add(lk)
                    continue
                if pd_days and not _all_in_window(pd_days):
                    immutable_locos.add(lk)
        if today_frozen:
            _log(
                f"[OPTIMIZER] {today_frozen} LOCO(s) com WS40/WS50 antes de Hoje ({today}) "
                f"— mantidas imutáveis (dados históricos preservados; só otimiza WS em/após Hoje)"
            )
        if immutable_locos:
            _log(
                f"[OPTIMIZER] {len(immutable_locos)} LOCO(s) imutáveis no total "
                f"(antes de Hoje e/ou WS40/WS50/Protection Days fora da janela "
                f"{date_from or '−inf'}..{date_to or '+inf'})"
            )

    # Scope conflict detection to the visible window + visible LOCOs so the model
    # works on the exact dataset shown in the Schedule tab (no phantom conflicts).
    scoped_ws_days = _scope_ws_days(initial_ws_days, loco_filter, date_from, date_to)
    if allow_overlap:
        _log(
            "[OPTIMIZER] Regras de sobreposição ON — compartilhamento de fronteira "
            "(fim de uma LOCO = início de outra, máx. 2 LOCOs) não conta como conflito"
        )
    conflicts = _detect_conflicts(scoped_ws_days, allow_overlap, loco_type)
    if not conflicts:
        _log("[OPTIMIZER] Sem conflitos (no escopo visível) — nenhum shift necessário")
        return {}, {}, {}

    if loco_filter is not None or date_from or date_to:
        _log(
            f"[OPTIMIZER] Escopo: {len(loco_filter) if loco_filter else 'todas'} LOCO(s)"
            f"  janela={date_from or '−inf'}..{date_to or '+inf'}"
        )
    _log(f"[OPTIMIZER] {len(conflicts)} conflito(s) detectado(s) — Gurobi B&B ({int(time_limit_s)}s)...")

    shifts, sat_shift, swap_flags = _solve_gurobi(
        ms_by_wo=ms_by_wo,
        rt_rows=rt_rows,
        holidays=holidays,
        protection_days=protection_days,
        initial_ws_days=initial_ws_days,
        conflicts=conflicts,
        log_fn=_log,
        time_limit=time_limit_s,
        loco_filter=loco_filter,
        date_from=date_from,
        date_to=date_to,
        use_saturdays=use_saturdays,
        es44_keys=es44_keys,
        immutable_locos=immutable_locos,
        allow_overlap=allow_overlap,
        loco_type=loco_type,
    )

    return shifts, sat_shift, swap_flags


# ── Apply shifts ──────────────────────────────────────────────────────────────

def apply_shifts_to_ms(ms_by_wo: dict, shifts: dict[str, int], holidays: frozenset) -> dict:
    """Apply LOCO-keyed shifts to each task's start_ms (downstream dates rebuilt by
    _build_records, which uses a Mon–Fri calendar). NOTE: because the rebuild is Mon–Fri,
    the FULL-shift strategy cannot place ops on Saturdays — Saturdays are only honoured by
    the partial strategy (apply_shifts_conflict_only_records, which edits record days
    directly). The solver is therefore called with Saturdays OFF for full-shift."""
    shifted: dict = defaultdict(list)
    for wo, tasks in ms_by_wo.items():
        for t in tasks:
            nt = dict(t)
            lk = _loco_key(wo, t.get("task_name") or "")
            shift = shifts.get(lk, 0)
            if shift > 0 and t.get("start_ms"):
                nt["start_ms"] = _add_business_days(t["start_ms"], shift, holidays)
            shifted[wo].append(nt)
    return shifted


def apply_es44_swap_records(
    records: list[dict],
    swap_flags: dict[str, bool] | None,
    holidays: frozenset,
    log_fn: Callable[[str], None] | None = None,
    use_saturdays: bool = False,
) -> list[dict]:
    """
    Apply the ES44 WS40↔WS50 execution-order swap to a FINAL flat records list, for the
    FULL-shift rebuild path (whose records already carry each LOCO's shifted dates).

    For each LOCO flagged in swap_flags, exchange its WS40/WS50 day-cells in place:
    WS50 runs first from WS40's anchor, WS40 right after, each keeping its own duration,
    the reordered block staying inside the original [first(WS40)..last(WS50)] span so
    every successor op is anchored. Only WS40/WS50 records move; all other records (incl.
    Protection Days) pass through untouched. LOCOs whose WS40/WS50 don't form a clean
    swappable block are left as-is. Operates on a COPY; returns the new records list.

    The partial rebuild does its own swap inside apply_shifts_conflict_only_records (the
    swap must precede its cut/PD-consume logic), so this helper is for the full path only.
    """
    _log = log_fn if log_fn else (lambda msg: None)
    swaps = {lk for lk, v in (swap_flags or {}).items() if v}
    if not swaps:
        return records
    _adv = _add_sat_business_days if use_saturdays else _add_business_days

    by_loco: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_loco[_loco_key(r["wo"], r["task_name"])].append(r)

    out: list[dict] = []
    swapped_count = 0
    for lk, recs in by_loco.items():
        if lk not in swaps:
            out.extend(recs)
            continue
        ws40_days = {r["day"] for r in recs if _norm_ws(r["ws"]) == SWAP_WS_FIRST}
        ws50_days = {r["day"] for r in recs if _norm_ws(r["ws"]) == SWAP_WS_SECOND}
        layout = _swap_ws_layout(
            {x.isoformat() for x in ws40_days},
            {x.isoformat() for x in ws50_days},
            holidays,
            _adv,
        )
        if layout is None:
            # Solver chose the swap but it's invalid on the real (unscoped) records — drop
            # it but log loudly so a dropped swap is never invisible.
            out.extend(recs)
            _log(
                f"[OPTIMIZER] AVISO: swap ES44 escolhido pelo solver não pôde ser aplicado "
                f"em {_label_loco(lk)} (bloco WS40→WS50 inválido nos registros reais)."
            )
            continue
        new40, new50 = layout
        remap: dict[tuple[str, date], date] = {}
        for o, nw in zip(sorted(ws40_days), sorted(date.fromisoformat(x) for x in new40)):
            remap[(SWAP_WS_FIRST, o)] = nw
        for o, nw in zip(sorted(ws50_days), sorted(date.fromisoformat(x) for x in new50)):
            remap[(SWAP_WS_SECOND, o)] = nw
        for r in recs:
            nr = dict(r)
            nr["day"] = remap.get((_norm_ws(r["ws"]), r["day"]), r["day"])
            out.append(nr)
        swapped_count += 1

    if swapped_count:
        _log(f"[OPTIMIZER] ES44 WS40↔WS50 trocadas aplicadas (full): {swapped_count} LOCO(s)")
    return out


def apply_shifts_conflict_only_records(
    records: list[dict],
    shifts: dict[str, int],
    holidays: frozenset,
    log_fn: Callable[[str], None] | None = None,
    use_saturdays: bool = False,
    swap_flags: dict[str, bool] | None = None,
    eff_shift_out: dict[str, int] | None = None,
) -> list[dict]:
    """
    PARTIAL shift (strategy='shift_conflict_only' / 'es44_swap'): for each shifted LOCO,
    move ONLY the conflicting target-WS (WS40/WS50) ops and everything that comes AFTER
    them in the routing — predecessors stay put.

    ES44 swap (swap_flags): for each LOCO flagged True, FIRST exchange the WS40↔WS50
    execution order (each keeps its own duration; the reordered block stays within its
    original span so successors are anchored), THEN run the normal shift/PD-consume
    logic on the reordered days. A LOCO may swap with shift 0 (swap alone resolved the
    conflict). Only WS40/WS50 day-cells are touched by the swap.

    The 'conflict point' is the LOCO's earliest target-WS day. Every record of that
    LOCO on/after that day is advanced by the LOCO's shift, preserving each op's
    spacing (sequence integrity). Records before the conflict point are untouched.

    CALENDAR: the advance MUST use the SAME calendar the solver modelled, or the
    rebuilt schedule won't match the proven conflict count. With use_saturdays the
    solver advances on Mon–Sat (_advance_iso_days_sat), so we advance on Mon–Sat here
    too (Saturdays become real workdays). Off ⇒ Mon–Fri. This replaces the previous
    Mon–Fri-then-separate-relocation path, which produced a DIFFERENT day-set than the
    one the solver optimized (slack=13 modelled but ~37 rebuilt).

    Operates on a COPY; LOCOs not in `shifts` (or with shift 0) pass through unchanged.
    Returns the new records list for _assemble_gantt_output(records=...).
    """
    _log = log_fn if log_fn else (lambda msg: None)
    _adv = _add_sat_business_days if use_saturdays else _add_business_days
    swaps = {lk for lk, v in (swap_flags or {}).items() if v}
    pos = {lk: d for lk, d in shifts.items() if d and d > 0}
    # Nothing to do only when there is neither a positive shift NOR a swap.
    if not pos and not swaps:
        return records

    by_loco: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_loco[_loco_key(r["wo"], r["task_name"])].append(r)

    out: list[dict] = []
    moved = 0
    swapped_count = 0
    for lk, recs in by_loco.items():
        d = pos.get(lk, 0)
        do_swap = lk in swaps
        if d <= 0 and not do_swap:
            out.extend(recs)
            continue

        # ── ES44 swap pre-pass: reorder this LOCO's WS40/WS50 day-cells ──────────
        # Build a per-(ws,day) remap so each WS40/WS50 record moves to its swapped
        # position; non-target records are untouched. The reordered block stays inside
        # the original [first(WS40)..last(WS50)] span, so the shift/PD logic below acts
        # on the same anchor window as before.
        swap_remap: dict[tuple[str, date], date] = {}
        if do_swap:
            ws40_days = {r["day"] for r in recs if _norm_ws(r["ws"]) == SWAP_WS_FIRST}
            ws50_days = {r["day"] for r in recs if _norm_ws(r["ws"]) == SWAP_WS_SECOND}
            layout = _swap_ws_layout(
                {x.isoformat() for x in ws40_days},
                {x.isoformat() for x in ws50_days},
                holidays,
                _adv,
            )
            if layout is not None:
                new40, new50 = layout
                old40 = sorted(ws40_days)
                old50 = sorted(ws50_days)
                n40 = sorted(date.fromisoformat(x) for x in new40)
                n50 = sorted(date.fromisoformat(x) for x in new50)
                for o, nw in zip(old40, n40):
                    swap_remap[(SWAP_WS_FIRST, o)] = nw
                for o, nw in zip(old50, n50):
                    swap_remap[(SWAP_WS_SECOND, o)] = nw
                swapped_count += 1
            else:
                # The solver CHOSE this swap on its (scoped) view, but the geometry is
                # invalid on the real records (e.g. WS40/WS50 extend past the window, or
                # overlap once unscoped). Drop the swap but LOG it loudly — a silently
                # dropped swap is exactly why swaps "never appeared" before this trace.
                do_swap = False
                _log(
                    f"[OPTIMIZER] AVISO: swap ES44 escolhido pelo solver não pôde ser "
                    f"aplicado em {_label_loco(lk)} (bloco WS40→WS50 inválido nos registros "
                    f"reais — fora da janela ou sobreposto)."
                )

        def _eff_day(r: dict) -> date:
            """This record's day AFTER the swap remap (target WS only), else its own."""
            return swap_remap.get((_norm_ws(r["ws"]), r["day"]), r["day"])

        if d <= 0 and not swap_remap:
            out.extend(recs)
            continue

        tgt_days = [_eff_day(r) for r in recs if _is_target_ws(_norm_ws(r["ws"]))]
        if not tgt_days:
            out.extend(recs)        # no target WS to anchor the cut → nothing to shift
            continue
        cut = min(tgt_days)         # conflict point = earliest WS40/WS50 day (post-swap)

        # ── Saturday block-compaction map (mirror of the solver occupancy) ──────────
        # With Saturdays enabled AND a real forward shift, the conflicting target block
        # (WS40/WS50, post-swap, from the cut onward) is laid out CONTIGUOUSLY on the
        # Mon–Sat calendar: no internal gaps, Saturdays filled, tail pulled in. The SAME
        # _compact_block_day_map the solver used builds the old→new day mapping, so the
        # rebuilt occupancy equals the proven one and the downstream chain is anchored to
        # the compacted (recovered) end. None ⇒ fall back to the per-cell advance.
        block_day_map: dict[date, date] | None = None
        if use_saturdays and d > 0:
            block_isos = {
                _eff_day(r).isoformat()
                for r in recs
                if _is_target_ws(_norm_ws(r["ws"])) and _eff_day(r) >= cut
            }
            block_day_map = _compact_block_day_map(block_isos, d, holidays) or None

        # ── Successor weekday-delta (issues 3 & Saturday-realign) ──────────────────
        # A non-target op advancing alongside a Saturday-using target must NOT inherit the
        # extra delay the target absorbed into Saturdays. The real delay imposed downstream
        # is how far the block's last day moved in WEEKDAYS, measured from the ORIGINAL
        # (pre-swap) last target day — because a successor's gap was anchored to where the
        # block ORIGINALLY ended, not to the post-swap reordered end. Measuring from the
        # post-swap max double-counts the WS40↔WS50 internal reorder: e.g. WS50(orig last
        # Fri) ↔ WS40 swap then WS40 +d lands Sat → original last Fri → new last Sat →
        # weekday delta 0 → successor stays Monday (full Saturday recovery). Using the
        # post-swap last (Thu) instead gave delta 1 → residual +1 day (the ES444227 bug).
        # With Saturdays off / no swap this equals d exactly (old_last == orig_last).
        # Computed BEFORE the PD-drop because PD is consumed by this REAL weekday delay.
        orig_tgt_last = max(
            (r["day"] for r in recs if _is_target_ws(_norm_ws(r["ws"]))),
            default=max(tgt_days),
        )
        if use_saturdays and tgt_days:
            # SINGLE SOURCE OF TRUTH = the block's ACTUAL final last day. With compaction
            # that is the latest mapped day (the contiguous run's end — already pulled in by
            # the recovered Saturday(s)). Without it (e.g. swap-only edge), advance the
            # post-swap last by d on the Saturday calendar as before.
            new_tgt_last = (
                max(block_day_map.values()) if block_day_map
                else _adv(max(tgt_days), d, holidays)
            )
            # Downstream displacement = how far the SUCCESSOR's first available slot moved.
            # A successor starts on the first Mon–Fri working day AFTER the block's last cell.
            # Anchor BOTH the original and the new end to that next-working-day so a Saturday
            # ending cancels the weekend correctly: a block that now ends Saturday 20 hands off
            # to the SAME Monday 22 its Friday-19 original did → ZERO downstream movement (the
            # recovered day fully propagates). Measuring instead from the block's own
            # weekday-clamped end double-counted the weekend (Fri→Mon = 1), which is exactly
            # the phantom +1 day and the wasted Protection Day in ES441527. _add_business_days
            # is Mon–Fri, so the successor never lands on the block's Saturday.
            orig_next = _add_business_days(orig_tgt_last, 1, holidays)
            new_next  = _add_business_days(new_tgt_last, 1, holidays)
            # Everything downstream — successors, PD consumption, Delay Days — is derived from
            # THIS one number, so all representations describe the same movement. 0 when the
            # Saturday allocation fully recovered the shift (next slot unchanged).
            succ_wk_shift = _count_business_days_between(orig_next, new_next, holidays)
        else:
            succ_wk_shift = d   # Mon–Fri only: weekday delta is exactly d

        # Expose the EFFECTIVE weekday displacement (N − S) actually imposed on this LOCO's
        # downstream chain + PD buffer, so build_shift_report (and the frontend that reads
        # shift_days/pd_used) reports the SAME number the rebuild applied. The solver's raw
        # `d` advanced from start_ms can over-report when a Saturday is absorbed at the
        # target block's TAIL (start_ms sees no Saturday) → inflated Delay Days / phantom
        # PD consumption. succ_wk_shift is the authoritative consumed buffer.
        if eff_shift_out is not None:
            eff_shift_out[lk] = succ_wk_shift

        # Protection Days are CONSUMED, not moved: when the conflict WS (and its
        # successors) slide forward, they eat the PD buffer ahead of them. The amount
        # eaten is the REAL weekday delay imposed on the chain (succ_wk_shift), NOT the
        # raw Saturday-inclusive d. When a Saturday allocation absorbs the move so the
        # weekday-end does not advance (succ_wk_shift == 0), NO PD is consumed — the
        # buffer keeps its full length and nothing downstream is delayed. Using raw d
        # here over-consumed PD on Saturday moves, leaving a phantom buffer-shrink that
        # propagated as false Delay Days / hatched boxes on the downstream chain.
        # The PD workstation must NOT translate forward (that would move its end past
        # finish_ms). Instead we DROP its succ_wk_shift earliest day-cells — the buffer
        # shrinks by the real delay while its end stays anchored to finish_ms.
        # Cap the drop at the available PD cells so we never go negative.
        pd_days_distinct = sorted(
            {r["day"] for r in recs if _is_protection_ws(_norm_ws(r["ws"]))}
        )
        drop_n = min(succ_wk_shift, len(pd_days_distinct))
        pd_days_to_drop = set(pd_days_distinct[:drop_n])

        # The PD buffer's END is anchored (consumed, never displaced). Therefore the
        # Workstations/boxes that come AFTER the PD period keep their ORIGINAL start —
        # their position was fixed by the (unmoved) PD end, so they must not slide.
        # Only the records BETWEEN the conflict point and the end of the PD block move
        # forward (they're what eats the buffer). The solver bounds each shift by
        # the LOCO's PD (s ∈ [0, PD]), so d never exceeds the available buffer and the
        # post-PD work is always fully protected. With no PD cells the boundary is the
        # cut itself (only the conflict day's own block shifts).
        pd_end = max(pd_days_distinct) if pd_days_distinct else cut

        for r in recs:
            ws_n = _norm_ws(r["ws"])
            if _is_protection_ws(ws_n):
                # Consume: drop EVERY record on the earliest d PD days; keep the rest
                # exactly where they are (end anchored). Never advance PD cells forward.
                # PD is never a swap target, so its day is unchanged by the swap.
                if r["day"] in pd_days_to_drop:
                    continue
                out.append(dict(r))
                continue
            nr = dict(r)
            # Effective day = the swapped position for WS40/WS50, the original otherwise.
            eff = _eff_day(r)
            nr["day"] = eff
            if d > 0 and _is_target_ws(ws_n) and eff >= cut:
                # The conflict WS (WS40/WS50) IS the block being displaced — it must move as
                # one CONTINUOUS unit. With Saturdays enabled, block_day_map lays the whole
                # block onto a contiguous Mon–Sat run (no internal gaps, Saturdays filled,
                # tail pulled in by the recovered day(s)) — and is identical to the occupancy
                # the solver proved. Without Saturdays (or no map), advance each cell by d on
                # the active calendar (Mon–Fri), which is already gap-free. Either way every
                # target-WS day from the conflict point on moves together — no internal hole.
                if block_day_map is not None:
                    nr["day"] = block_day_map.get(eff, _adv(eff, d, holidays))
                else:
                    nr["day"] = _adv(eff, d, holidays)
            elif d > 0 and cut < eff <= pd_end:
                # Non-target WS STRICTLY AFTER the conflict point, up to the anchored PD end —
                # the buffer-consuming successor ops. Advance by the WEEKDAY delay the target
                # block actually imposed (succ_wk_shift), strictly Mon–Fri — never a Saturday
                # (issue 2), never the inflated raw d when the target used Saturdays (issue 3).
                # Records after pd_end (successor WS past the PD period) stay put.
                #
                # LOWER BOUND IS STRICT (cut < eff, not cut <= eff): a PREDECESSOR WS hands off
                # to the conflict WS on a SHARED half-day boundary, so its LAST cell sits on
                # exactly `cut` (== the block's first day). `cut <= eff` swept that predecessor
                # cell forward — dragging completed upstream work and, for a multi-cell
                # predecessor, TEARING it (last cell jumps +d, earlier cells stay → a gap).
                # Predecessors must stay put; a genuine successor is always strictly after the
                # block start (its earliest cell ≥ block end > cut), so it is unaffected.
                nr["day"] = _add_business_days(eff, succ_wk_shift, holidays)
            # Safety invariant (issue 2): a non-target WS must never sit on a Saturday
            # (nor a blocked Saturday). If anything (swap remap, source data) left one
            # there, push it to the next valid weekday.
            if not _is_target_ws(ws_n):
                while nr["day"].weekday() >= 5 or nr["day"] in holidays:
                    nr["day"] += timedelta(days=1)
            out.append(nr)
        moved += 1

    _cal = "Seg–Sáb" if use_saturdays else "Seg–Sex"
    _log(f"[OPTIMIZER] Shift parcial (consome PD, WS em conflito + sucessoras, {_cal}): {moved} LOCO(s)")
    if swapped_count:
        _log(f"[OPTIMIZER] ES44 WS40↔WS50 trocadas aplicadas: {swapped_count} LOCO(s)")
    return out


# ── Saturday relocation post-pass (records-level) ─────────────────────────────

def relocate_saturdays_in_records(
    records: list[dict],
    sat_shift: dict[str, int],
    holidays: frozenset,
    log_fn: Callable[[str], None] | None = None,
) -> list[dict]:
    """
    Physically place WS40/WS50 ops of conflict LOCOs on Saturdays.

    For each LOCO in `sat_shift`, its target-WS (WS40/WS50) day-cells are re-laid out
    on the Mon–Sat calendar anchored at the SAME first day — compressing the block by
    using Saturdays. Successor-WS day-cells of the same LOCO (those starting on/after
    the target WS's original last day) are pulled earlier by the number of calendar
    days saved, preserving their internal Mon–Fri spacing.

    Operates on a COPY of the flat records list; other LOCOs are untouched. Returns the
    new records list for _assemble_gantt_output(records=...).
    """
    _log = log_fn if log_fn else (lambda msg: None)
    if not sat_shift:
        return records

    # Index records by LOCO key.
    by_loco: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_loco[_loco_key(r["wo"], r["task_name"])].append(r)

    new_records: list[dict] = []
    relocated_locos = 0
    for lk, recs in by_loco.items():
        if lk not in sat_shift:
            new_records.extend(recs)
            continue

        # Split this LOCO's records: target-WS (WS40/WS50) vs the rest.
        tgt_recs = [r for r in recs if _is_target_ws(_norm_ws(r["ws"]))]
        if not tgt_recs:
            new_records.extend(recs)
            continue

        tgt_days_sorted = sorted({r["day"] for r in tgt_recs})
        anchor = tgt_days_sorted[0]
        orig_last = tgt_days_sorted[-1]

        # New Mon–Sat layout for the distinct target days, anchored at `anchor`.
        # i-th distinct day → anchor advanced by i Mon–Sat workdays.
        remap: dict[date, date] = {}
        cur = anchor
        for i, _old in enumerate(tgt_days_sorted):
            if i == 0:
                remap[_old] = anchor
                cur = anchor
                continue
            cur = _add_sat_business_days(cur, 1, holidays)
            remap[_old] = cur
        new_last = remap[orig_last]

        # Calendar days saved (>=0): how far successors may be pulled earlier, measured
        # on the Mon–Fri calendar (successors keep their normal weekday spacing).
        days_saved = _count_business_days_between(new_last, orig_last, holidays)

        for r in recs:
            nr = dict(r)
            ws_n = _norm_ws(r["ws"])
            if _is_target_ws(ws_n):
                nr["day"] = remap.get(r["day"], r["day"])
            elif days_saved > 0 and r["day"] > orig_last:
                # Successor op — pull earlier by days_saved business days.
                tmp = r["day"]
                moved = 0
                while moved < days_saved:
                    tmp -= timedelta(days=1)
                    if _is_business_day(tmp, holidays):
                        moved += 1
                nr["day"] = tmp
            new_records.append(nr)
        relocated_locos += 1

    _log(f"[OPTIMIZER] Sábados aplicados ao schedule: {relocated_locos} LOCO(s) realocada(s)")
    return new_records


# ── Final Saturday-occupancy validation / sanitizer ──────────────────────────

def sanitize_saturday_occupancy(
    records: list[dict],
    holidays: frozenset,
    log_fn: Callable[[str], None] | None = None,
) -> list[dict]:
    """
    Final validation pass on the rebuilt records, enforcing the two hard Saturday rules
    on the EXACT schedule the user will see (so the guarantee can't be bypassed by any
    earlier path):

      Issue 2 — ONLY WS40/WS50 may occupy a Saturday. Any non-target WS record on a
                Saturday is pushed to the next valid weekday (Saturday visual occupancy
                and displacement boxes for other WS are eliminated).
      Issue 1 — A Saturday immediately following a holiday (Friday holiday) is
                unavailable for ANY workstation. Such allocations (even WS40/WS50) are
                pushed to the next valid working day.

    Operates on a COPY; returns the cleaned records list. Logs how many cells it moved
    so the correction is visible in the solver log. No-op when nothing violates the rules
    (the common case once the upstream advance is correct), so it never adds delay on its
    own — it only relocates cells that already violate an invariant.
    """
    _log = log_fn if log_fn else (lambda msg: None)
    moved_non_target = 0
    moved_blocked_sat = 0
    out: list[dict] = []
    for r in records:
        day = r["day"]
        ws_n = _norm_ws(r["ws"])
        violates = False
        if _is_blocked_saturday(day, holidays):
            violates = True
            kind = "blocked"
        elif day.weekday() == 5 and not _is_target_ws(ws_n):
            violates = True
            kind = "non_target"
        if not violates:
            out.append(r)
            continue
        nr = dict(r)
        nd = nr["day"]
        # Next valid WORKING day (Mon–Fri, non-holiday). For a blocked Saturday we also
        # skip the Saturday itself; for a non-target Saturday we move off Saturday too.
        while nd.weekday() >= 5 or nd in holidays:
            nd += timedelta(days=1)
        nr["day"] = nd
        out.append(nr)
        if kind == "blocked":
            moved_blocked_sat += 1
        else:
            moved_non_target += 1

    if moved_non_target or moved_blocked_sat:
        _log(
            f"[OPTIMIZER] Saneamento de sábados: {moved_non_target} célula(s) não-WS40/50 "
            f"realocada(s) de sábado, {moved_blocked_sat} célula(s) em sábado pós-feriado realocada(s)."
        )
    return out


# ── Shift report ──────────────────────────────────────────────────────────────

def build_shift_report(
    ms_by_wo: dict,
    shifts: dict[str, int],
    protection_days: dict[str, int],
    conflicts_before: list,
    conflicts_after: list,
    holidays: frozenset,
    use_saturdays: bool = False,
    eff_shift: dict[str, int] | None = None,
) -> list[dict]:
    """One row per shifted LOCO.

    DELAY DAYS are WEEKDAY (Mon–Fri) days only. With use_saturdays the solver's raw
    `shift_days` (`d`) is a Mon–Sat advance, so it can include Saturday steps. A Saturday
    is NOT a delay (the LOCO is simply working that Saturday) — counting it inflated the
    badge and consumed phantom PD. We therefore report the REAL displacement.

    `eff_shift` (partial strategy) carries the AUTHORITATIVE per-LOCO weekday displacement
    (N − S) the rebuild actually applied to the downstream chain + PD buffer, measured at
    the target block's TAIL where the Saturday is absorbed. When present it is used verbatim
    for shift_days/pd_used — advancing `d` from start_ms (the old path) over-reports whenever
    the Saturday falls at the block tail rather than near start_ms. Without it (full strategy,
    Sat off) we fall back to advancing the start on the solver's calendar and measuring the
    Mon–Fri distance, which equals `d` exactly when Saturdays are off.
    """
    _adv = _add_sat_business_days if use_saturdays else _add_business_days
    def _count_per_loco(conflicts: list) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for wo1, tn1, wo2, tn2, ws_n in conflicts:
            counts[_loco_key(wo1, tn1)] += 1
            counts[_loco_key(wo2, tn2)] += 1
        return counts

    before_counts = _count_per_loco(conflicts_before)
    after_counts  = _count_per_loco(conflicts_after)

    # Map loco_key → its task (for start_ms / serial)
    task_by_key: dict[str, dict] = {}
    for wo, tasks in ms_by_wo.items():
        for t in tasks:
            task_by_key.setdefault(_loco_key(wo, t.get("task_name") or ""), t)

    report = []
    for loco_key, shift_days in sorted(shifts.items(), key=lambda x: -x[1]):
        if shift_days <= 0:
            continue
        wo, tn = _split_loco_key(loco_key)
        t = task_by_key.get(loco_key, {})
        orig_start = t.get("start_ms")
        if eff_shift is not None and loco_key in eff_shift:
            # Authoritative effective weekday displacement (N − S) from the rebuild — the
            # buffer actually consumed at the target block tail. opt_start is the start
            # advanced by that same Mon–Fri delay (the start itself doesn't move in partial
            # mode; this is the notional "delayed by N−S days" used only for the log).
            weekday_delay = eff_shift[loco_key]
            opt_start = (
                _add_business_days(orig_start, weekday_delay, holidays)
                if orig_start else None
            )
            # Do NOT skip when weekday_delay == 0: a Saturday-recovered shift consumes 0 PD
            # (net 0) but still deviated from the original plan by the raw shift `d` (gross,
            # reported below). Dropping the row here is exactly why such a LOCO showed 0 delay
            # / 0 hatched boxes. `d` (= the loop var `shift_days`) is already > 0 here.
        else:
            # Optimized start on the SAME calendar the solver/rebuild used (Mon–Sat when
            # enabled), so opt_start matches the actual schedule. The REPORTED delay is then
            # the Mon–Fri distance between orig and opt — Saturdays the move passed over do
            # NOT count as delay (and were not real PD consumption either).
            opt_start = _adv(orig_start, shift_days, holidays) if orig_start else None
            weekday_delay = (
                _count_business_days_between(orig_start, opt_start, holidays)
                if orig_start and opt_start else shift_days
            )
        report.append({
            "wo":          wo,
            "loco":        tn,
            "orig_start":  orig_start.isoformat() if orig_start else None,
            "opt_start":   opt_start.isoformat()  if opt_start  else None,
            "shift_days":  weekday_delay,
            "pd_used":     weekday_delay,
            # GROSS displacement = the raw solver shift `d` (Mon–Sat steps), independent of
            # Saturday recovery. `shift_days`/`pd_used` above are the NET (Mon–Fri) buffer
            # actually consumed; gross = net + the Saturdays the block recovered. The UI uses
            # gross for the Delay-Days badge + hatched boxes (deviation from the original plan)
            # and net for Protection Days (buffer consumed) — two independent concepts. `d` is
            # taken straight from the solver shift, so a swap's WS40↔WS50 reorder distance can
            # never leak in (only the shift counts).
            "gross_shift_days": shift_days,
            "pd_total":    protection_days.get(loco_key, 0),
            "conf_before": before_counts.get(loco_key, 0),
            "conf_after":  after_counts.get(loco_key, 0),
            "resolved":    max(0, before_counts.get(loco_key, 0) - after_counts.get(loco_key, 0)),
        })
    return report
