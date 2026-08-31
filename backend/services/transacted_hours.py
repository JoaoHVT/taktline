"""
Horas Transacionadas — build, preview and persist the actual-hours snapshot (PHASE 1).

Why a persisted snapshot at all
───────────────────────────────
Reading "Horas Transacionadas" needs Denodo credentials, and most sessions do not have
them: the display feature would be blank for everyone except the handful of users who can
reach Denodo, and every render would pay a multi-second warehouse query. So the data is
pulled ONCE by someone who can, condensed here, and stored in the app's own database.
Everything downstream reads the stored batch.

Grain
─────
The Denodo source is one row per shop-floor transaction. This module never sees that: the
VQL aggregates to (work order, workstation, part number) before transport — see
``denodo.datasets.fetch_transacted_hours_by_wo``. What is stored is that same grain, which
is the smallest shape that still answers all three questions the display needs (hours per
loco, per part number, per workstation).

The locomotive is NOT stored. It is derivable from the work-order prefix, but that
derivation is the display layer's matching rule and it stays unvalidated until this data
reaches production. Persisting a derived loco would freeze an unproven rule into the rows
and go stale whenever the schedule changes; keeping the raw work order lets the rule be
fixed without a re-import.

Storage form
────────────
ONE row, holding every data row as a columnar JSON blob — ``TransactedHoursSnapshot``,
modelled on ``GcrPlanSnapshot``. The previous form (one database row per data row) cost one
network round trip per row through pg8000's looping ``executemany`` and ran for minutes at
this data's size; see the model's docstring. The relational pair it replaced is still READ
as a fallback so a database that has not been re-imported yet keeps working, and is no
longer written.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from models import TransactedHoursBatch, TransactedHoursRow, TransactedHoursSnapshot

logger = logging.getLogger(__name__)

# Cap on the distinct-value lists inside the preview stats.
PREVIEW_FACET_LIMIT = 40

# The preview is rendered by the SAME grid as every Denodo base (DenodoResultsModal), so
# the payload is emitted in that component's `DenodoData` shape.
#
# Only a SAMPLE of rows is sent — the preview is there to show what the data looks like,
# not to be scrolled end to end, and the full set would be a multi-megabyte payload on
# every prévia. The sample is the heaviest rows first (build_summary sorts by hours), so
# what a user sees is the part that actually moves the total.
#
# The FULL row count is never hidden by this: the grid's own header counts what it holds,
# so the true total is published as a meta pill instead — see `preview_payload`. The
# numbers being approved (`stats`) are always computed over every row, and the SAVE path
# re-runs the query server-side and stores everything, so the cap is a display concern
# only and can never shrink what gets persisted.
PREVIEW_ROW_LIMIT = 100

PREVIEW_COLUMNS = ["Work Order", "Workstation", "Part Number", "Horas", "Transações"]
PREVIEW_TYPES   = ["text", "text", "text", "number", "number"]


def _clean(value: Any) -> str:
    return str(value or "").strip()


def build_summary(denodo_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Condense the Denodo result into the rows to be stored, plus preview statistics.

    Denodo already grouped by (work order, workstation, assembly item), but re-folding here
    is not redundant: it guarantees the stored set has ONE row per key even if the source
    returns case/whitespace variants of the same identifier, so a later per-loco sum cannot
    double-count. Rows with no work order are dropped — nothing can ever match them, and
    leaving them in would inflate both the row count and the stored total.
    """
    folded: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
    dropped_no_wo = 0
    dropped_hours = 0.0

    for r in denodo_rows:
        wo = _clean(r.get("workorder"))
        if not wo:
            dropped_no_wo += 1
            dropped_hours += float(r.get("hours") or 0.0)
            continue
        ws = _clean(r.get("workstation"))
        pn = _clean(r.get("assembly_item"))
        # Org (organizationcode) and Area (valuestream) are part of the KEY, not attributes
        # hung off it: the same work order can be booked in more than one, and folding them
        # together would make that indistinguishable and unrecoverable. They are carried
        # for provenance and diagnosis — the loco matching does NOT use them (see
        # `_fold_by_loco`: the Tipo is decided by routing, not by org).
        org = _clean(r.get("org"))
        area = _clean(r.get("area"))
        key = (wo, ws, pn, org, area)
        entry = folded.setdefault(key, {"workorder": wo, "workstation": ws, "part_number": pn,
                                        "org": org, "area": area,
                                        "hours": 0.0, "txn_count": 0})
        entry["hours"] += float(r.get("hours") or 0.0)
        entry["txn_count"] += int(r.get("txn_count") or 0)

    rows = list(folded.values())
    rows.sort(key=lambda d: (-d["hours"], d["workorder"]))   # heaviest first — best preview

    total_hours = sum(r["hours"] for r in rows)
    total_txns = sum(r["txn_count"] for r in rows)

    workorders = sorted({r["workorder"] for r in rows})
    workstations = sorted({r["workstation"] for r in rows if r["workstation"]})
    part_numbers = {r["part_number"] for r in rows if r["part_number"]}

    # Hours per workstation — the fastest way for a human to spot a wrongly-scoped pull
    # (a period covering the wrong months shows up as the wrong stations carrying the load).
    ws_hours: dict[str, float] = {}
    for r in rows:
        ws_hours[r["workstation"] or "(sem WS)"] = ws_hours.get(r["workstation"] or "(sem WS)", 0.0) + r["hours"]
    top_ws = sorted(ws_hours.items(), key=lambda kv: -kv[1])[:PREVIEW_FACET_LIMIT]

    return {
        "rows": rows,
        "stats": {
            "row_count": len(rows),
            "total_hours": round(total_hours, 2),
            "txn_count": total_txns,
            "workorder_count": len(workorders),
            "workstation_count": len(workstations),
            "part_number_count": len(part_numbers),
            "dropped_blank_workorder_rows": dropped_no_wo,
            "dropped_blank_workorder_hours": round(dropped_hours, 2),
            "workstations": [{"workstation": w, "hours": round(h, 2)} for w, h in top_ws],
            "workorder_sample": workorders[:PREVIEW_FACET_LIMIT],
        },
    }


def preview_payload(summary: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    """The preview, as a ``DenodoData`` payload plus the stats the save step gates on.

    ``data`` is fed straight to DenodoResultsModal — the same grid, filters, sorting,
    search and export the Denodo browser uses for every other base. Nothing about the
    preview is a bespoke table.

    The condensed facts that do not belong in a grid cell (period, org scope, totals,
    discarded rows, truncation) ride as ``meta`` pills, which that component already
    renders in its header — so they are visible without a second, parallel UI.
    """
    rows = summary["rows"]
    stats = summary["stats"]

    sample = rows[:PREVIEW_ROW_LIMIT]

    pills: list[dict[str, str]] = [
        # FIRST pill, and the one that matters most: the grid header can only count the rows
        # it was handed, so without this the 100-row sample would read as the whole result.
        {"label": "Linhas (total)", "value": f"{stats['row_count']:,}".replace(",", ".")},
        {"label": "Amostra exibida",
         "value": (f"{len(sample)} de {stats['row_count']:,}".replace(",", ".") + " (maiores primeiro)")
                  if len(sample) < stats["row_count"] else "conjunto completo"},
        {"label": "Período", "value": f"{meta.get('start_date')} → {meta.get('end_date')}"},
        {"label": "Orgs", "value": ", ".join(meta.get("orgs") or [])},
        {"label": "Horas totais", "value": f"{stats['total_hours']:,.2f}"},
        {"label": "Work orders", "value": str(stats["workorder_count"])},
        {"label": "Workstations", "value": str(stats["workstation_count"])},
        {"label": "Part numbers", "value": str(stats["part_number_count"])},
        {"label": "Transações", "value": str(stats["txn_count"])},
    ]
    if stats["dropped_blank_workorder_rows"]:
        # Surfaced, never silent: these hours exist in Denodo but can never be attributed
        # to a locomotive, so the stored total is legitimately lower than the source's.
        pills.append({
            "label": "Descartadas (sem WO)",
            "value": f"{stats['dropped_blank_workorder_rows']} linhas / "
                     f"{stats['dropped_blank_workorder_hours']:,.2f} h",
        })
    if meta.get("truncated"):
        pills.append({"label": "ATENÇÃO", "value": "consulta truncada — horas subestimadas"})

    data = {
        "key": "horas_transacionadas_resumo",
        "label": "Horas Transacionadas — resumo",
        "title": "Horas Transacionadas — resumo a ser salvo",
        "columns": PREVIEW_COLUMNS,
        "types": PREVIEW_TYPES,
        "rows": [
            [
                r["workorder"],
                r["workstation"] or None,
                r["part_number"] or None,
                round(r["hours"], 2),
                r["txn_count"],
            ]
            for r in sample
        ],
        "meta": pills,
        # The TRUE total, not len(sample) — this field means "how big is the result".
        "rowCount": len(rows),
        "maxRows": meta.get("maxRows", 0),
        # The GRID's truncation flag means "this table is partial", which is exactly what a
        # capped Denodo fetch produced — so it maps straight through.
        "truncated": bool(meta.get("truncated")),
        "generatedAt": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "query": meta.get("query", ""),
    }

    return {"data": data, "stats": stats}


# ── Snapshot storage (the write path) ────────────────────────────────────────────────────
#
# The stored blob is COLUMNAR: one `columns` header plus one array per row. Readers resolve
# each field through `columns` by NAME, never by a hard-coded position, which is what lets a
# future field be appended without migrating anything already written — and is why the old
# `_ensure_provenance_columns` ALTER TABLE dance is gone.
SNAPSHOT_COLUMNS = ["workorder", "workstation", "part_number", "org", "area", "hours", "txn_count"]

# Same ceiling the GCR plan uses (_GCR_MAX_BYTES). At the 33k–66k rows this data produces the
# blob is ~4.5 MB, so this is roughly 5x headroom rather than a limit anyone should meet.
SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024


class SnapshotConflict(Exception):
    """The stored snapshot moved since the client loaded it. Carries who/when for the message."""

    def __init__(self, version: int, saved_by: str | None, saved_at: Any):
        super().__init__("snapshot version conflict")
        self.version = version
        self.saved_by = saved_by
        self.saved_at = saved_at


class SnapshotTooLarge(Exception):
    """Serialized payload exceeds SNAPSHOT_MAX_BYTES."""

    def __init__(self, size: int):
        super().__init__("snapshot payload too large")
        self.size = size


def save_snapshot(
    db,
    summary: dict[str, Any],
    meta: dict[str, Any],
    created_by: str,
    base_version: int | None = None,
) -> dict[str, Any]:
    """Persist the summary as THE snapshot: one DELETE + one INSERT, one transaction.

    Replaces the per-row write. What used to be N round trips (pg8000 executemany is a
    Python loop over `execute`) is a single insert of a single columnar blob.

    CONCURRENCY. `base_version` is the version the client loaded. If a snapshot exists and
    the version has moved, the write is refused — see SnapshotConflict. Omitting it is only
    legitimate when there is no snapshot at all; against an existing one it is treated as a
    conflict rather than as consent, exactly as the GCR plan does, because two people
    importing different periods would otherwise erase one another with no trace.

    The legacy `transacted_hours_batch` / `transacted_hours_row` pair is deliberately NOT
    dropped here: it is still readable during the migration and is what a database with no
    snapshot yet falls back to. It is simply never written again.
    """
    rows = summary["rows"]
    stats = summary["stats"]

    prev = db.query(TransactedHoursSnapshot).order_by(TransactedHoursSnapshot.id.desc()).first()
    if prev is not None:
        prev_ver, prev_by, prev_at = prev.version, prev.created_by, prev.created_at
        if base_version is None or int(base_version) != int(prev_ver or 1):
            raise SnapshotConflict(int(prev_ver or 1), prev_by, prev_at)
        next_ver = int(prev_ver or 1) + 1
    else:
        next_ver = 1

    matrix = [
        [
            r["workorder"],
            r["workstation"] or None,
            r["part_number"] or None,
            r.get("org") or None,
            r.get("area") or None,
            round(float(r["hours"]), 4),
            int(r["txn_count"]),
        ]
        for r in rows
    ]
    blob = json.dumps({"columns": SNAPSHOT_COLUMNS, "matrix": matrix},
                      separators=(",", ":"), ensure_ascii=False, default=str)
    size = len(blob.encode("utf-8"))
    if size > SNAPSHOT_MAX_BYTES:
        raise SnapshotTooLarge(size)

    # DELETE then INSERT, both inside the caller's transaction: the previous snapshot cannot
    # be lost without the new one landing, and no window exists where two are candidates.
    # The old instance is expunged first — a bulk delete does not detach what the version
    # check just loaded, and an engine that reuses the primary key would then flush the new
    # row onto a stale identity.
    if prev is not None:
        db.expunge(prev)
    db.query(TransactedHoursSnapshot).delete(synchronize_session=False)
    snap = TransactedHoursSnapshot(
        created_at=datetime.now(timezone.utc),
        created_by=created_by or "",
        start_date=meta.get("start_date"),
        end_date=meta.get("end_date"),
        orgs=",".join(meta.get("orgs") or []),
        row_count=stats["row_count"],
        total_hours=float(stats["total_hours"]),
        txn_count=int(stats["txn_count"]),
        truncated=bool(meta.get("truncated")),
        version=next_ver,
        payload_json=blob,
    )
    db.add(snap)
    db.flush()          # assigns snap.id without ending the transaction

    # Superseded LEGACY batches. Removed on a successful snapshot write for the same reason
    # they were removed before — nothing reads history and the detail rows are the bulk of
    # the storage — but the tables themselves stay, so a rollback to the old read path is
    # still possible until the migration is closed out.
    # `.all()` on a single-column query yields Row objects, which are NOT tuple instances in
    # SQLAlchemy 2 — indexing is what unwraps them; binding the Row itself fails at the driver.
    old_ids = [row[0] for row in db.query(TransactedHoursBatch.id).all()]
    if old_ids:
        db.query(TransactedHoursRow).filter(TransactedHoursRow.batch_id.in_(old_ids)).delete(
            synchronize_session=False
        )
        db.query(TransactedHoursBatch).filter(TransactedHoursBatch.id.in_(old_ids)).delete(
            synchronize_session=False
        )

    _forget_decoded()

    logger.info(
        "[horas-transacionadas] snapshot %s v%d salvo: %d linhas, %.2f h, %.1f MB, "
        "%d lote(s) legado(s) removido(s)",
        snap.id, next_ver, stats["row_count"], stats["total_hours"], size / 1048576, len(old_ids),
    )

    return {
        "batch_id": snap.id,
        "version": next_ver,
        "row_count": stats["row_count"],
        "total_hours": stats["total_hours"],
        "payload_bytes": size,
        "superseded_batches": len(old_ids),
    }


# Decoded-blob memo. `rollup_by_loco` runs on every page load and json.loads of a multi-MB
# payload is ~100–200 ms plus the transient allocation; the blob only changes when someone
# publishes, so (id, version) is a complete cache key. ONE entry — there is only ever one
# snapshot, and holding a second would just be a second copy of the same megabytes.
_decoded_cache: tuple[tuple[int, int], list[tuple[Any, Any, Any, float]]] | None = None


def _forget_decoded() -> None:
    global _decoded_cache
    _decoded_cache = None


def _decode_matrix(columns: list[Any], matrix: list[Any]) -> list[tuple[Any, Any, Any, float]]:
    """Columnar rows → the (workorder, workstation, part_number, hours) tuples the fold takes.

    Fields are located by NAME through `columns`, so a payload written by a later version
    with extra columns still reads correctly, and one written before a column existed reads
    as missing rather than as the wrong field.
    """
    idx = {str(c): i for i, c in enumerate(columns or [])}
    i_wo, i_ws = idx.get("workorder"), idx.get("workstation")
    i_pn, i_h  = idx.get("part_number"), idx.get("hours")
    if i_wo is None or i_h is None:
        logger.warning("[horas-transacionadas] snapshot sem colunas obrigatórias — ignorado")
        return []

    def cell(row: Any, i: int | None) -> Any:
        return row[i] if (i is not None and i < len(row)) else None

    out: list[tuple[Any, Any, Any, float]] = []
    for row in matrix or []:
        if not isinstance(row, list):
            continue
        try:
            hours = float(cell(row, i_h) or 0.0)
        except (TypeError, ValueError):
            hours = 0.0
        out.append((cell(row, i_wo), cell(row, i_ws), cell(row, i_pn), hours))
    return out


def _latest_snapshot(db):
    """The stored snapshot row, or None — including when the TABLE does not exist yet.

    A read must never 500 because the relation has not been created on this deployment: it
    falls back to the legacy pair instead. The rollback matters — Postgres aborts the whole
    transaction on a failed statement, so without it the legacy query behind this one would
    fail too, with a misleading error.
    """
    try:
        return db.query(TransactedHoursSnapshot).order_by(TransactedHoursSnapshot.id.desc()).first()
    except Exception as exc:      # noqa: BLE001 — missing relation is a fallback, not a failure
        db.rollback()
        logger.warning("[horas-transacionadas] snapshot indisponível (%s) — lendo o lote legado", exc)
        return None


def _snapshot_rows(db) -> tuple[Any, list[tuple[Any, Any, Any, float]]] | None:
    """The stored snapshot's meta row + its decoded rows, or None when there is no snapshot."""
    global _decoded_cache

    snap = _latest_snapshot(db)
    if snap is None:
        return None

    key = (int(snap.id), int(snap.version or 1))
    if _decoded_cache is not None and _decoded_cache[0] == key:
        return snap, _decoded_cache[1]

    try:
        payload = json.loads(snap.payload_json) if snap.payload_json else {}
    except (json.JSONDecodeError, TypeError):
        # A corrupt blob reads as "no snapshot", never as an empty one: serving zero hours
        # silently is indistinguishable from a legitimately empty import.
        logger.warning("[horas-transacionadas] snapshot armazenado não é JSON válido — ignorado")
        return None

    rows = _decode_matrix(payload.get("columns") or [], payload.get("matrix") or [])
    _decoded_cache = (key, rows)
    return snap, rows


def _legacy_rows(db) -> tuple[Any, list[Any]] | None:
    """The pre-snapshot relational pair. Read-only, kept for the migration window."""
    batch = (
        db.query(TransactedHoursBatch)
        .filter(TransactedHoursBatch.active.is_(True))
        .order_by(TransactedHoursBatch.id.desc())
        .first()
    )
    if batch is None:
        return None
    rows = (
        db.query(
            TransactedHoursRow.workorder,
            TransactedHoursRow.workstation,
            TransactedHoursRow.part_number,
            TransactedHoursRow.hours,
        )
        .filter(TransactedHoursRow.batch_id == batch.id)
        .all()
    )
    return batch, rows


# A display-only disambiguation tag on a locomotive NAME, e.g. `B3#ES442126`.
#
# The schedule cannot hold two locos with the same name, so when the same physical serial
# is planned under two Tipos (once as New Locos, once as Propulsion) one of them is typed
# in with a short tag in front. The warehouse has never heard of that tag — Denodo, the
# work orders and the routing all carry the bare serial — so it must come off before any
# comparison against a work order.
#
# Deliberately narrow: anchored, at most four alphanumerics, and only ever a `#`. A general
# "strip everything up to a separator" would eat parts of real serials, which contain both
# `-` and `_`.
_DISPLAY_TAG_RE = re.compile(r"^[A-Z0-9]{1,4}#")


def _serial_of(name: str) -> str:
    """The SERIAL a work order actually carries, out of a display name that may not be one.

    Matching key only — never an output key. Every rollup is keyed by the loco's DISPLAY
    name, because that is what the page looks itself up by.
    """
    return _DISPLAY_TAG_RE.sub("", _clean(name).upper())


class _Candidate:
    """One locomotive a work order could belong to, with the routing that proves it."""

    __slots__ = ("name", "serial", "tipo", "ws", "items")

    def __init__(self, name: str, tipo: str, ws: set[str], items: set[str]):
        self.name = name
        self.serial = _serial_of(name)
        self.tipo = tipo
        self.ws = ws
        self.items = items


def _as_candidates(locos: Iterable[Any]) -> list[_Candidate]:
    """Accept either the legacy flat name list or the typed form.

    Legacy (``["ES442126", …]``) still works and behaves exactly as before, because with no
    Tipo and no routing every candidate falls through to the longest-prefix rule.
    """
    out: list[_Candidate] = []
    seen: set[str] = set()
    for entry in locos or []:
        if isinstance(entry, str):
            name, tipo, ws, items = entry, "", set(), set()
        else:
            name = _clean(entry.get("name"))
            tipo = _clean(entry.get("tipo"))
            ws = {_clean(w).upper() for w in (entry.get("ws") or []) if _clean(w)}
            items = {_clean(i).upper() for i in (entry.get("items") or []) if _clean(i)}
        name = _clean(name)
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(_Candidate(name, tipo, ws, items))
    return [c for c in out if c.serial]


def _fold_by_loco(
    rows: Iterable[tuple[Any, Any, Any, Any]],
    locos: Iterable[Any],
    type_ws: dict[str, Iterable[str]] | None = None,
) -> dict[str, Any]:
    """The matching rule itself, over any (workorder, workstation, part_number, hours) source.

    Factored out because it runs against TWO row sources that must agree exactly: the
    stored batch (``rollup_by_loco``) and a not-yet-saved prévia (``rollup_from_summary``).
    If a user validates a mapping in the prévia and then saves, the numbers must not move —
    a second implementation would be a second thing to keep in step, and the drift would
    show up as "it looked right before I saved it".

    The matching rule
    ─────────────────
    A work order is PREFIXED with the locomotive's serial (`ES442126-…` belongs to
    `ES442126`), so a loco claims every row whose work order starts with its serial. Three
    properties on top of that, each of which the naive version got wrong:

    • **Display tag stripped.** The name on screen may carry an artificial `B3#` prefix
      (see `_DISPLAY_TAG_RE`); the work order never does. Matching runs on the serial, the
      output stays keyed by the display name.

    • **Longest serial wins.** If `ES4421` and `ES442126` are both live, work order
      `ES442126-1` starts with BOTH. Awarding it to each would double-count it into the
      factory total, so only the longest matching serial survives. This is a lexical fact
      and is resolved BEFORE anything below looks at routing.

    • **Same serial across Tipos is broken by ROUTING, never by guessing.** Once the
      longest-serial reduction leaves more than one candidate they are, by construction,
      the same serial planned under different Tipos — the New Locos `ES442126` and the
      Propulsion `B3#ES442126`. Prefix matching cannot separate those and must not try.
      The row is awarded to the candidate whose own routing actually contains the
      workstation and part number it was booked against:

          3 · this loco's routing has that exact (workstation, part number)
          2 · this loco's routing has that workstation
          1 · some loco of this loco's TIPO has that workstation
          0 · nobody

      Rank 0 for every candidate means no Tipo owns the work at all. That row goes to
      `unmatched` rather than to whichever name sorted first — awarding it anyway is what
      previously moved Propulsion's hours onto the New Locos loco and left Propulsion at
      zero. A tie at rank ≥ 1 is reported in `ambiguous` and settled deterministically, so
      the total is still conserved and the collision is visible.

    Callers that pass the legacy flat name list get the old behaviour exactly: no Tipo and
    no routing means the longest-serial rule decides everything, as it did before.

    Returns per-loco totals plus a (workstation, part_number) breakdown — the grain the
    display needs to place hours booked against a station/item pair the plan never had.
    """
    cands = _as_candidates(locos)
    empty_bucket = {"workorders": 0, "hours": 0.0, "sample": []}
    if not cands:
        return {"locos": {}, "unmatched": dict(empty_bucket), "ambiguous": dict(empty_bucket)}

    # Workstation vocabulary per Tipo. Supplied by the caller when it has it; otherwise
    # derived from the candidates themselves, which is enough whenever the colliding locos
    # carry their own routing.
    vocab: dict[str, set[str]] = {}
    for tipo, wss in (type_ws or {}).items():
        vocab[_clean(tipo)] = {_clean(w).upper() for w in wss if _clean(w)}
    for c in cands:
        vocab.setdefault(c.tipo, set()).update(c.ws)

    # Longest serial first — the first match is the most specific one.
    cands.sort(key=lambda c: -len(c.serial))

    out: dict[str, dict[str, Any]] = {
        c.name: {"hours": 0.0, "workorders": set(), "items": {}} for c in cands
    }

    unmatched_wos: set[str] = set()
    unmatched_hours = 0.0
    ambiguous_wos: set[str] = set()
    ambiguous_hours = 0.0

    for wo, ws, pn, hours in rows:
        wo_u = _clean(wo).upper()
        hit_all = [c for c in cands if wo_u.startswith(c.serial)]
        if not hit_all:
            unmatched_wos.add(_clean(wo))
            unmatched_hours += float(hours or 0.0)
            continue

        # Longest serial only. Usually leaves exactly one; anything left over shares a
        # serial and is therefore the cross-Tipo collision.
        best_len = len(hit_all[0].serial)
        hit_all = [c for c in hit_all if len(c.serial) == best_len]

        if len(hit_all) == 1:
            hit = hit_all[0]
        else:
            ws_u = _clean(ws).upper()
            pair = f"{ws_u}||{_clean(pn).upper()}"

            def rank(c: _Candidate) -> int:
                if pair in c.items:
                    return 3
                if ws_u and ws_u in c.ws:
                    return 2
                if ws_u and ws_u in vocab.get(c.tipo, ()):
                    return 1
                return 0

            ranked = sorted(((rank(c), c) for c in hit_all), key=lambda t: (-t[0], t[1].name))
            top = ranked[0][0]
            if top == 0:
                # No Tipo's routing claims this station. Refuse to pick.
                unmatched_wos.add(_clean(wo))
                unmatched_hours += float(hours or 0.0)
                continue
            if sum(1 for r, _ in ranked if r == top) > 1:
                ambiguous_wos.add(_clean(wo))
                ambiguous_hours += float(hours or 0.0)
            hit = ranked[0][1]

        bucket = out[hit.name]
        bucket["hours"] += float(hours or 0.0)
        bucket["workorders"].add(_clean(wo))
        # Keyed by (workstation, part number) — the pair the display places a row at.
        key = f"{_clean(ws)}||{_clean(pn)}"
        item = bucket["items"].setdefault(
            key, {"workstation": _clean(ws), "part_number": _clean(pn), "hours": 0.0}
        )
        item["hours"] += float(hours or 0.0)

    return {
        "locos": {
            loco: {
                "hours": round(v["hours"], 2),
                "workorder_count": len(v["workorders"]),
                "items": sorted(
                    ({**it, "hours": round(it["hours"], 2)} for it in v["items"].values()),
                    key=lambda d: -d["hours"],
                ),
            }
            for loco, v in out.items()
        },
        "unmatched": {
            "workorders": len(unmatched_wos),
            "hours": round(unmatched_hours, 2),
            # A handful of examples so a prefix mismatch is diagnosable from the response
            # alone, without opening the grid.
            "sample": sorted(unmatched_wos)[:20],
        },
        # Awarded, but the serial was planned under more than one Tipo and both routings
        # could take the row. Conserved in the totals; surfaced so it can be corrected.
        "ambiguous": {
            "workorders": len(ambiguous_wos),
            "hours": round(ambiguous_hours, 2),
            "sample": sorted(ambiguous_wos)[:20],
        },
    }


def rollup_by_loco(
    db,
    locos: Iterable[Any],
    type_ws: dict[str, Iterable[str]] | None = None,
) -> dict[str, Any]:
    """PHASE 2 read path: actual hours per locomotive, from the STORED snapshot.

    Snapshot first, legacy relational batch as fallback — a database that still holds only
    a pre-migration batch answers exactly as it did before. Either source produces the same
    (workorder, workstation, part_number, hours) tuples and goes through the same fold, so
    the numbers cannot differ by which one answered.
    """
    found = _snapshot_rows(db)
    if found is None:
        legacy = _legacy_rows(db)
        if legacy is None:
            return {"has_data": False, "locos": {}}
        _, rows = legacy
    else:
        _, rows = found

    return {
        "has_data": True,
        "batch": active_batch_status(db),
        **_fold_by_loco(rows, locos, type_ws),
    }


def rollup_from_summary(
    summary: dict[str, Any],
    locos: Iterable[Any],
    type_ws: dict[str, Iterable[str]] | None = None,
) -> dict[str, Any]:
    """The same rollup, from a prévia that has NOT been saved.

    This is what lets the main page show the hours before anyone commits them: the
    validation the prévia exists for ("are these mapped to the right locomotives?") is
    impossible to do from a 100-row sample, and impossible to undo once written. The fold
    runs over EVERY row of the result, not the sample the grid receives.

    ``pending: True`` travels with it so the display can say out loud that what is on
    screen is not stored yet — a number that looks identical to a saved one, but isn't,
    is the one thing this must not produce.
    """
    return {
        "has_data": True,
        "pending": True,
        "batch": None,
        **_fold_by_loco(
            ((r["workorder"], r["workstation"], r["part_number"], r["hours"])
             for r in summary["rows"]),
            locos,
            type_ws,
        ),
    }


def active_batch_status(db) -> dict[str, Any]:
    """Metadata for the stored snapshot, or ``{"has_data": False}`` when there is none.

    This is what tells a user whether the actual-hours display is backed by anything, and
    from WHEN — a snapshot with no visible date is indistinguishable from a fresh one.

    Every field the pre-snapshot version returned is still returned, from whichever source
    answered. Two are ADDED: `version` (what the next publish must send back as
    `base_version`) and `snapshot`, which is False only while a database is still on the
    legacy relational pair. A legacy row reports `version: 0`, which is not a version any
    publish can conflict with — the first snapshot write is unconstrained by construction.
    """
    snap = _latest_snapshot(db)
    if snap is not None:
        return {
            "has_data": True,
            "snapshot": True,
            "version": int(snap.version or 1),
            "batch_id": snap.id,
            "created_at": snap.created_at.isoformat() if snap.created_at else None,
            "created_by": snap.created_by or "",
            "start_date": snap.start_date,
            "end_date": snap.end_date,
            "orgs": [o for o in (snap.orgs or "").split(",") if o],
            "row_count": snap.row_count,
            "total_hours": round(snap.total_hours or 0.0, 2),
            "txn_count": snap.txn_count,
            "truncated": bool(snap.truncated),
        }

    batch = (
        db.query(TransactedHoursBatch)
        .filter(TransactedHoursBatch.active.is_(True))
        .order_by(TransactedHoursBatch.id.desc())
        .first()
    )
    if batch is None:
        return {"has_data": False, "snapshot": False, "version": 0}

    return {
        "has_data": True,
        "snapshot": False,
        "version": 0,
        "batch_id": batch.id,
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
        "created_by": batch.created_by or "",
        "start_date": batch.start_date,
        "end_date": batch.end_date,
        "orgs": [o for o in (batch.orgs or "").split(",") if o],
        "row_count": batch.row_count,
        "total_hours": round(batch.total_hours or 0.0, 2),
        "txn_count": batch.txn_count,
        "truncated": bool(batch.truncated),
    }
