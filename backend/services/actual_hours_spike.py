"""
SPIKE — actual (transacted) hours per locomotive, sourced from Denodo.

Question this answers
─────────────────────
"Horas Transacionadas" (``latam.bv_cq_top_transacted_hours``) records, per shop-floor
transaction: a WORK ORDER (``wipentityname``), the ASSEMBLY ITEM it was booked against
(``assemblyname``) and the hours applied (``primaryquantity``). The app already knows
which WORK ORDERs belong to which LOCOMOTIVA — that is exactly what ``LocosRout`` holds
(``locomotiva`` / ``part_number`` / ``workorder``), and it is the same mapping the
Schedule / Plano de Produção grids join on.

So the rollup is, in principle, one join:

    LocosRout.workorder  ==  transacted_hours.wipentityname
    → Σ primaryquantity, grouped by LocosRout.locomotiva

THE feasibility risk is not the arithmetic — it is whether those two identifiers are
written the same way on both sides. Oracle WIP entity names, an Excel export and a
hand-maintained routing sheet disagree about leading zeros, prefixes, casing and stray
whitespace far more often than they disagree about semantics. A spike that assumes a
format and reports a clean-looking total is worse than useless: a 3% join rate still
produces a number.

So this module does NOT pick a normalization. It runs the join under SEVERAL candidate
normalizations, reports the match rate of each, and rolls up using whichever matched
best — with the winning variant and every rate named in the response. One run tells you
whether the mapping is viable, and if it isn't, exactly which way the formats diverge.

Nothing here is wired into the Gantt, the Plano de Produção or any cached path. It is a
read-only probe behind the existing Denodo endpoint policy.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any, Callable

from models import LocosRout, get_active_ver

logger = logging.getLogger(__name__)

# How many examples of each failure mode to return. Enough to eyeball a format
# mismatch, small enough that the response stays a diagnostic and not a data dump.
SAMPLE_LIMIT = 25


# ── Candidate normalizations ─────────────────────────────────────────────────
# Ordered loosest-last. Each maps a raw identifier from EITHER side to a join key.
#
#   raw    — trimmed only. If this wins, the two systems already agree; nothing to do.
#   upper  — trimmed + uppercased + inner whitespace collapsed. Cheap, safe, no
#            information discarded: two IDs equal under `upper` are the same ID.
#   digits — every non-digit dropped, then leading zeros stripped. This is the LOSSY
#            one: it makes "WO-000123" and "123/A" collide. Only trust it when it beats
#            `upper` by a wide margin AND the collision counter below stays at zero —
#            that combination means one side carries a prefix/padding the other lacks.

def _norm_raw(value: Any) -> str:
    return str(value or "").strip()


def _norm_upper(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).upper()


def _norm_digits(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits.lstrip("0")


NORMALIZERS: dict[str, Callable[[Any], str]] = {
    "raw": _norm_raw,
    "upper": _norm_upper,
    "digits": _norm_digits,
}


# ── App side: loco → work orders, from LocosRout ─────────────────────────────

def load_app_workorders(db) -> list[dict[str, Any]]:
    """Every (loco, workorder, part_number) triple in the ACTIVE Locos Rout version,
    plus that row's planned hours (hh_unit × qtd).

    Planned hours ride along so the response can show actual-vs-planned per loco. That
    ratio is the second sanity check: a join that "works" but returns 40× the planned
    hours is matching the wrong thing, and no match-rate statistic would reveal it.

    Rows with a blank WORKORDER are kept and reported separately — they are unjoinable
    by construction, and silently dropping them would inflate the apparent match rate.
    """
    ver = get_active_ver(db, "locos_rout")
    rows = (
        db.query(
            LocosRout.locomotiva,
            LocosRout.workorder,
            LocosRout.part_number,
            LocosRout.hh_unit,
            LocosRout.qtd,
        )
        .filter(LocosRout.ver == ver)
        .all()
    )

    out: list[dict[str, Any]] = []
    for loco, wo, pn, hh_unit, qtd in rows:
        out.append(
            {
                "loco": str(loco or "").strip(),
                "workorder": str(wo or "").strip(),
                "part_number": str(pn or "").strip(),
                "planned_hours": float(hh_unit or 0.0) * float(qtd or 0),
            }
        )
    return out


# ── Join-quality scoring ─────────────────────────────────────────────────────

def _score_variant(
    app_rows: list[dict[str, Any]],
    denodo_rows: list[dict[str, Any]],
    normalize: Callable[[Any], str],
) -> dict[str, Any]:
    """Match rate for one normalization, plus the collision counter.

    `collisions` counts join keys that two or more DISTINCT raw app work orders map onto.
    It is what keeps `digits` honest: stripping non-digits can merge genuinely different
    work orders, and the resulting rollup would double-count hours while every match-rate
    number looked excellent. A variant with collisions > 0 must not be trusted regardless
    of how well it scores.
    """
    app_keys: dict[str, set[str]] = defaultdict(set)
    for r in app_rows:
        if r["workorder"]:
            key = normalize(r["workorder"])
            if key:
                app_keys[key].add(r["workorder"])

    denodo_keys: set[str] = set()
    for r in denodo_rows:
        key = normalize(r["workorder"])
        if key:
            denodo_keys.add(key)

    matched = set(app_keys) & denodo_keys
    collisions = sum(1 for k, raws in app_keys.items() if len(raws) > 1)

    # Hours reachable under this variant — the figure that actually matters. A variant can
    # match many low-hour work orders and still miss the ones carrying the bulk of the time.
    hours_by_key: dict[str, float] = defaultdict(float)
    for r in denodo_rows:
        key = normalize(r["workorder"])
        if key:
            hours_by_key[key] += r["hours"]
    total_hours = sum(hours_by_key.values())
    matched_hours = sum(hours_by_key[k] for k in matched)

    return {
        "app_keys": len(app_keys),
        "denodo_keys": len(denodo_keys),
        "matched_keys": len(matched),
        "app_match_pct": round(100.0 * len(matched) / len(app_keys), 2) if app_keys else 0.0,
        "denodo_match_pct": round(100.0 * len(matched) / len(denodo_keys), 2) if denodo_keys else 0.0,
        "denodo_hours_total": round(total_hours, 2),
        "denodo_hours_matched": round(matched_hours, 2),
        "hours_match_pct": round(100.0 * matched_hours / total_hours, 2) if total_hours else 0.0,
        "collisions": collisions,
    }


def _pick_variant(scores: dict[str, dict[str, Any]]) -> str:
    """Best variant = highest share of Denodo HOURS reachable, with any colliding
    variant demoted below every clean one.

    Ranking on hours rather than on key count is deliberate: the purpose of the join is
    to attribute time, so a variant that recovers 95% of the hours from 60% of the work
    orders beats one that matches 90% of work orders holding 20% of the hours.
    """
    def rank(name: str) -> tuple:
        s = scores[name]
        return (0 if s["collisions"] else 1, s["hours_match_pct"], s["app_match_pct"])

    return max(scores, key=rank)


# ── Rollup ───────────────────────────────────────────────────────────────────

def rollup_actual_hours(
    app_rows: list[dict[str, Any]],
    denodo_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Join the two sides and aggregate actual hours per locomotive.

    `denodo_rows` is the ALREADY-AGGREGATED Denodo result: one entry per
    (work order, assembly item) with summed hours — see
    ``denodo.datasets.fetch_transacted_hours_by_wo``.

    Returns the per-loco table plus the diagnostics that decide whether this is
    trustworthy at all. Read the diagnostics first; the totals mean nothing without them.
    """
    scores = {name: _score_variant(app_rows, denodo_rows, fn) for name, fn in NORMALIZERS.items()}
    variant = _pick_variant(scores)
    normalize = NORMALIZERS[variant]

    # Denodo side, keyed under the winning variant. `items` keeps every assembly item seen
    # for a work order so the assembly cross-check below can compare against the routing.
    denodo_by_key: dict[str, dict[str, Any]] = {}
    for r in denodo_rows:
        key = normalize(r["workorder"])
        if not key:
            continue
        entry = denodo_by_key.setdefault(key, {"hours": 0.0, "items": set(), "raw": r["workorder"]})
        entry["hours"] += r["hours"]
        if r["assembly_item"]:
            entry["items"].add(r["assembly_item"])

    # A work order can appear on SEVERAL routing rows of the same loco (one per
    # workstation / component). Its hours must be counted ONCE per loco, so consume each
    # (loco, key) pair a single time — summing per row would multiply the total by the
    # number of routing lines, which is the most likely way this spike would silently lie.
    per_loco: dict[str, dict[str, Any]] = {}
    consumed: set[tuple[str, str]] = set()

    blank_wo_rows = 0
    unmatched_app: dict[str, str] = {}          # key → raw, deduped
    assembly_mismatch: list[dict[str, str]] = []

    for r in app_rows:
        loco = r["loco"]
        if not loco:
            continue
        bucket = per_loco.setdefault(
            loco,
            {
                "loco": loco,
                "planned_hours": 0.0,
                "actual_hours": 0.0,
                "workorders": set(),
                "matched_workorders": set(),
            },
        )
        bucket["planned_hours"] += r["planned_hours"]

        wo = r["workorder"]
        if not wo:
            blank_wo_rows += 1
            continue

        bucket["workorders"].add(wo)
        key = normalize(wo)
        hit = denodo_by_key.get(key)
        if hit is None:
            if key and len(unmatched_app) < SAMPLE_LIMIT:
                unmatched_app.setdefault(key, wo)
            continue

        bucket["matched_workorders"].add(wo)
        if (loco, key) not in consumed:
            consumed.add((loco, key))
            bucket["actual_hours"] += hit["hours"]

        # Cross-check the OTHER half of the mapping. The claim under test is that the two
        # systems share the item↔workorder relationship, not merely the work-order string.
        # If Denodo books this WO against an assembly the routing never mentions, the join
        # is landing on a same-named-but-different work order.
        pn = r["part_number"]
        if pn and hit["items"] and pn not in hit["items"] and len(assembly_mismatch) < SAMPLE_LIMIT:
            assembly_mismatch.append(
                {
                    "loco": loco,
                    "workorder": wo,
                    "routing_part_number": pn,
                    "denodo_assembly_items": ", ".join(sorted(hit["items"])[:5]),
                }
            )

    matched_keys = {k for _, k in consumed}
    unmatched_denodo = [
        {"workorder": v["raw"], "hours": round(v["hours"], 2)}
        for k, v in denodo_by_key.items()
        if k not in matched_keys
    ]
    unmatched_denodo.sort(key=lambda d: d["hours"], reverse=True)   # biggest misses first

    locos = []
    for bucket in per_loco.values():
        wo_count = len(bucket["workorders"])
        matched_count = len(bucket["matched_workorders"])
        locos.append(
            {
                "loco": bucket["loco"],
                "planned_hours": round(bucket["planned_hours"], 2),
                "actual_hours": round(bucket["actual_hours"], 2),
                "workorder_count": wo_count,
                "matched_workorder_count": matched_count,
                "wo_coverage_pct": round(100.0 * matched_count / wo_count, 2) if wo_count else 0.0,
                # Actual ÷ planned. Sanity band is roughly 0.5–2.0; anything far outside
                # means the join is wrong even when the match rate looks healthy.
                "actual_vs_planned": (
                    round(bucket["actual_hours"] / bucket["planned_hours"], 3)
                    if bucket["planned_hours"] else None
                ),
            }
        )
    locos.sort(key=lambda d: d["loco"])

    total_planned = sum(l["planned_hours"] for l in locos)
    total_actual = sum(l["actual_hours"] for l in locos)

    return {
        "locos": locos,
        "totals": {
            "loco_count": len(locos),
            "planned_hours": round(total_planned, 2),
            "actual_hours": round(total_actual, 2),
            "actual_vs_planned": round(total_actual / total_planned, 3) if total_planned else None,
        },
        "diagnostics": {
            "variant_used": variant,
            "variant_scores": scores,
            "blank_workorder_rows": blank_wo_rows,
            "unmatched_app_workorders": [
                {"workorder": raw} for raw in list(unmatched_app.values())
            ],
            "unmatched_denodo_workorders": unmatched_denodo[:SAMPLE_LIMIT],
            "unmatched_denodo_count": len(unmatched_denodo),
            "unmatched_denodo_hours": round(sum(d["hours"] for d in unmatched_denodo), 2),
            "assembly_item_mismatches": assembly_mismatch,
        },
    }
