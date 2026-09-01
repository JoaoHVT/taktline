"""
import_excel_to_db.py
--------------------
Reads the "Discretizado" sheet from the source workbook,
drops + recreates monthly_demand, and bulk-inserts all rows.

Each row stores:
  • row_json  — ALL original columns as a JSON string (exact column names/values)
  • shortcut columns (item, wsn, ano, mes, fw, …) — indexed copies for fast queries

row_json lets _db_to_df() reconstruct a DataFrame that is column-for-column
identical to xl.parse("Discretizado"), fixing assembly-details & optimizer bugs.

Usage (local):
    python import_excel_to_db.py
    python import_excel_to_db.py /path/to/other.xlsx

This script is also called internally by the /api/db/import endpoint.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import unicodedata
import logging
from datetime import datetime, date, time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import text, inspect as sa_inspect, insert as sa_insert
from sqlalchemy.orm import Session

from database import get_db, engine
from models import (
    Base, MonthlyDemand, ScheduleRow, LocosRout, DbConfig,
    ItensRout, PlanoProd,
    Workstation, Person, WorkstationPerson,
    get_active_ver, set_active_ver,
)

logger = logging.getLogger(__name__)


def _ensure_ver_col(db: Session, table: str) -> None:
    """Make sure db_config exists so the active-version pointer has somewhere to live."""
    try:
        DbConfig.__table__.create(db.get_bind(), checkfirst=True)
    except Exception as exc:
        logger.warning("Create db_config: %s", exc)


def _discard_staging(db: Session, table: str, staging_ver: int) -> None:
    """Delete all staging rows on cancel or error (best-effort)."""
    try:
        db.rollback()
        db.execute(text(f"DELETE FROM {table} WHERE ver = :v"), {"v": staging_ver})
        db.commit()
    except Exception as exc:
        logger.warning("Discard staging %s ver=%d: %s", table, staging_ver, exc)
        try:
            db.rollback()
        except Exception:
            pass


# ── Import modes ────────────────────────────────────────────────────────────
# "replace" (historic behaviour): staging starts empty, so applying the swap leaves
#           ONLY the uploaded file's rows.
# "append":  staging is seeded with a copy of the live rows first, so the swap leaves
#           the current base PLUS the file's new rows. Identical records (same full
#           row content) are ignored instead of duplicated — there is no unique key on
#           these tables, so content equality IS the dedupe key.
IMPORT_MODES = ("replace", "append")


def _content_key(row_json: str) -> str:
    """Dedupe key for append mode: a digest of the row's full original content.

    Keys migrated out of Item Rout into the Headcount tab are stripped before hashing. New imports
    no longer store them at all, but rows imported BEFORE that cutover still carry them in row_json,
    and _seed_append hashes those live rows to build the `seen` set. Without this normalization a
    logically identical row would hash differently on either side of the cutover and every existing
    row would re-append as a duplicate on the first append-mode import after the change.

    Both sides are canonicalized the SAME way (parsed, migrated keys dropped, re-serialized with
    sorted keys) — normalizing only the rows that happen to carry the old keys would leave the two
    sides with different key ORDER and defeat the purpose.
    """
    try:
        obj = json.loads(row_json or "{}")
        if isinstance(obj, dict):
            drop = {str(k).strip().upper() for k in ITENS_ROUT_MIGRATED_COLS}
            canonical = json.dumps(
                {k: v for k, v in obj.items() if str(k).strip().upper() not in drop},
                ensure_ascii=False, sort_keys=True,
            )
            return hashlib.sha1(canonical.encode("utf-8")).hexdigest()
    except (ValueError, TypeError):
        pass
    return hashlib.sha1((row_json or "").encode("utf-8")).hexdigest()


# Indexes declared on the four main bases' shortcut columns that are read by
# nothing: every consumer loads these tables whole by `ver` (main.py::_db_to_df_split,
# gantt_builder, actual_hours_spike) and filters/joins in pandas or Python; the
# dataset editor fetches by id. No SQL predicate ever names these columns.
# Each one still had to be maintained on every INSERT of every import — pure
# write-path tax. Dropped here rather than in a migration so an existing database
# is cleaned the next time it is written to. Names are SQLAlchemy's own defaults.
# NOTE: the `ver` indexes are NOT in this list and must stay — they carry every read.
_UNUSED_INDEXES: dict[str, tuple[str, ...]] = {
    "itens_rout": (
        "ix_itens_rout_assembly", "ix_itens_rout_component", "ix_itens_rout_wsn",
        "ix_itens_rout_asm_comp", "ix_itens_rout_asm_wsn",
    ),
    "plano_prod": (
        "ix_plano_prod_item", "ix_plano_prod_cliente", "ix_plano_prod_familia",
        "ix_plano_prod_ano", "ix_plano_prod_mes", "ix_plano_prod_fw",
        "ix_plano_prod_ano_mes", "ix_plano_prod_ano_mes_fw", "ix_plano_prod_item_mes",
    ),
    # Same story: gantt_builder reads schedule and locos_rout whole by `ver` and
    # actual_hours_spike joins locos_rout to transacted hours in Python, not SQL.
    "schedule": (
        "ix_schedule_wo", "ix_schedule_task_name", "ix_schedule_wo_task",
    ),
    "locos_rout": (
        "ix_locos_rout_locomotiva", "ix_locos_rout_part_number", "ix_locos_rout_loco_pn",
    ),
    # monthly_demand is DELIBERATELY ABSENT. Unlike the four above it IS queried
    # column-wise in SQL (main.py's demand endpoints filter on ano/mes/fw and group
    # by familia/cliente), so its indexes earn their keep.
}


def _drop_unused_indexes(db: Session, table: str) -> None:
    """Best-effort DROP INDEX IF EXISTS for a table's dead indexes (idempotent).

    A failure here is never fatal: the index staying is a slower import, not a
    wrong one, so each drop is committed on its own and a rollback moves on.
    """
    for name in _UNUSED_INDEXES.get(table, ()):
        try:
            db.execute(text(f"DROP INDEX IF EXISTS {name}"))
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("DROP INDEX %s: %s", name, exc)


# Postgres refuses a statement carrying more than 65,535 bound parameters. A
# multi-values INSERT binds one parameter per column per row, so the row ceiling
# is that limit divided by the column count. We stay well under it: row_json is a
# multi-KB Text blob, so the practical bound is statement SIZE, not parameters.
_PG_MAX_BIND_PARAMS = 65535
_INSERT_CHUNK_ROWS  = 500


def _insert_records(db: Session, records: list) -> int:
    """Persist a list of ORM instances with ONE multi-values INSERT per chunk.

    Replaces ``db.bulk_save_objects(records)``. A DBAPI driver (pure
    Python), whose ``Cursor.executemany`` is literally::

        for parameters in param_sets:
            self.execute(operation, parameters)

    — i.e. one full round trip PER ROW against the database, which
    is what made a 5k-row base take minutes rather than seconds. ``insert(Model)
    .values([...])`` compiles instead to a single ``INSERT ... VALUES (...), (...)``,
    so a chunk of 500 rows costs one round trip.

    Same rows, same columns, same values — only the statement count changes. The
    autoincrement primary key is omitted when unset so Postgres assigns it; every
    other mapped column is sent explicitly, including ``ver``, which all five
    importers set on the instance before calling this.
    """
    if not records:
        return 0
    model  = type(records[0])
    mapper = sa_inspect(model)
    pk_attrs = {mapper.get_property_by_column(c).key for c in mapper.primary_key}
    attrs = [
        p.key for p in mapper.column_attrs
        # Skip the surrogate key only while it is unset — an explicitly assigned
        # PK (not something these importers do today) would still be honoured.
        if not (p.key in pk_attrs and getattr(records[0], p.key, None) is None)
    ]
    rows = [{k: getattr(r, k, None) for k in attrs} for r in records]
    chunk_rows = max(1, min(_INSERT_CHUNK_ROWS, _PG_MAX_BIND_PARAMS // max(1, len(attrs))))
    stmt = sa_insert(model)
    for i in range(0, len(rows), chunk_rows):
        db.execute(stmt.values(rows[i:i + chunk_rows]))
    return len(rows)


def _seed_append(db: Session, table: str, prod_ver: int, staging_ver: int,
                 progress=None) -> tuple[int, set[str]]:
    """
    Copy every live row into staging (same content, staging `ver`) and return
    (rows carried over, set of their content keys).

    Copying is done in SQL so a large base never round-trips through Python.
    """
    cols = [c.name for c in Base.metadata.tables[table].columns if c.name != "id"]
    col_list = ", ".join(cols)
    # `ver` is re-stamped to the staging version; the CAST keeps the driver from having
    # to infer the bind's type inside the SELECT list. `id` is excluded so the copies get
    # fresh primary keys.
    sel_list = ", ".join("CAST(:dst AS INTEGER)" if c == "ver" else c for c in cols)
    db.execute(
        text(f"INSERT INTO {table} ({col_list}) SELECT {sel_list} FROM {table} WHERE ver = :src"),
        {"dst": staging_ver, "src": prod_ver},
    )
    db.commit()
    carried = db.execute(
        text(f"SELECT COUNT(*) FROM {table} WHERE ver = :v"), {"v": staging_ver}
    ).scalar() or 0
    seen: set[str] = set()
    for (rj,) in db.execute(
        text(f"SELECT row_json FROM {table} WHERE ver = :v"), {"v": staging_ver}
    ):
        seen.add(_content_key(rj or ""))
    if progress:
        progress(f"[STAGE] Modo adicionar — {carried} registros existentes preservados.")
    return int(carried), seen


def _mode_summary(mode: str, carried: int, added: int, duplicates: int, skipped: int, total: int) -> str:
    """User-facing one-liner describing what the import actually did."""
    if mode == "append":
        return (f"{added} registros adicionados, {duplicates} duplicados ignorados, "
                f"{carried} preservados — total {total} ({skipped} linhas vazias ignoradas).")
    return f"{total} registros importados ({skipped} ignorados)."




# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize(txt: Any) -> str:
    s = unicodedata.normalize("NFD", str(txt or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.strip().lower()


def _fw_key(v: Any) -> str:
    m = re.search(r"(\d+)", str(v))
    return str(int(m.group(1))) if m else str(v).strip()


def _safe_float(value: Any) -> float | None:
    try:
        v = float(value)
        return None if (math.isnan(v) or math.isinf(v)) else v
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> int | None:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def _str_val(value: Any) -> str | None:
    if value is None:
        return None
    try:
        if math.isnan(float(value)):
            return None
    except (TypeError, ValueError):
        pass
    s = str(value).strip()
    return s if s and s.lower() != "nan" else None


def _str_id_val(value: Any) -> str | None:
    """Like _str_val, but renders whole-number IDs without a trailing '.0'. Excel/pandas read a
    numeric column (e.g. a WORKORDER like 12345) as a float, so the raw string is '12345.0' — we
    drop the '.0' for integers while leaving alphanumeric values (e.g. 'WO-12A') untouched."""
    s = _str_val(value)
    if s is not None and s.endswith(".0"):
        head = s[:-2]
        if head.lstrip("-").isdigit():
            return head
    return s


def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    norm_map = {_normalize(c): c for c in df.columns}
    for cand in candidates:
        hit = norm_map.get(_normalize(cand))
        if hit is not None:
            return hit
    return None


def _row_to_json(row: pd.Series) -> str:
    """Serialize a DataFrame row to a JSON string, preserving all column names.
    NaN / Inf are converted to null so the result is valid JSON.

    Datas com horário são convertidas para somente data (YYYY-MM-DD).
    Horários puros (time) são ignorados e viram null.
    """
    result: dict[str, Any] = {}

    for col, val in row.items():
        col_str = str(col)

        if isinstance(val, float):
            if math.isnan(val) or math.isinf(val):
                result[col_str] = None
            else:
                result[col_str] = val

        elif isinstance(val, (np.integer,)):
            result[col_str] = int(val)

        elif isinstance(val, (np.floating,)):
            fv = float(val)
            result[col_str] = None if (math.isnan(fv) or math.isinf(fv)) else fv

        elif isinstance(val, (np.bool_,)):
            result[col_str] = bool(val)

        elif isinstance(val, pd.Timestamp):
            if pd.isnull(val):
                result[col_str] = None
            else:
                result[col_str] = val.date().isoformat()

        elif isinstance(val, datetime):
            result[col_str] = val.date().isoformat()

        elif isinstance(val, date):
            result[col_str] = val.isoformat()

        elif isinstance(val, time):
            # Horário puro não possui data, então ignora
            result[col_str] = None

        elif val is None or (hasattr(pd, "isna") and pd.isna(val)):
            result[col_str] = None

        else:
            result[col_str] = val

    return json.dumps(result, ensure_ascii=False)


# ── Core import logic ─────────────────────────────────────────────────────────

def _col_has_data(df: pd.DataFrame, col: str | None) -> bool:
    """Return True if the column exists and has at least one non-null, non-empty value."""
    if col is None or col not in df.columns:
        return False
    return df[col].dropna().apply(lambda v: str(v).strip() not in ("", "nan", "none")).any()


def _cell_to_iso_date(raw: Any) -> str | None:
    """Excel cell → 'YYYY-MM-DD', or None when it holds no usable date.

    Accepts datetime/date objects and strings in DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD or
    YYYY-MM-DD. Ambiguous DD/MM vs MM/DD is resolved by trying day-first and falling back to
    month-first — the same rule the Finish MS column has always used, now shared with Contratual
    so the two date columns can never diverge in how they are read."""
    if raw is None:
        return None
    if hasattr(raw, "date"):
        return raw.date().isoformat()
    if hasattr(raw, "isoformat"):
        return raw.isoformat()[:10]
    s = str(raw).strip()
    if s.lower() in ("nan", "none", ""):
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    parts = s.replace("-", "/").split("/")
    if len(parts) == 3:
        a, b, c = parts[0].strip(), parts[1].strip(), parts[2].strip()
        if len(c) == 4:
            for d_, m_ in ((a, b), (b, a)):
                try:
                    return date(int(c), int(m_), int(d_)).isoformat()
                except Exception:
                    pass
        if len(a) == 4:
            try:
                return date(int(a), int(b), int(c)).isoformat()
            except Exception:
                pass
    return None


def import_excel_to_db(filepath: str | Path, db: Session, progress_callback=None,
                       mode: str = "replace") -> dict:
    """
    Rebuilds monthly_demand from the 'Discretizado' sheet (up to MAX_ROWS).

    mode="replace" wipes the base first; mode="append" keeps it and adds only the
    rows the file brings that are not already there.

    progress_callback(msg) is called with status lines when provided.
    Returns a summary dict with status and counts.
    """
    mode   = mode if mode in IMPORT_MODES else "replace"
    append = mode == "append"
    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise  # propagate cancellation
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    _progress(f"[INFO] Lendo arquivo '{filepath.name}' ({filepath.stat().st_size // 1024} KB)...")
    _progress(f"[INFO] Lendo arquivo '{filepath.name}' ({filepath.stat().st_size // 1024} KB)...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    if "Discretizado" not in xl.sheet_names:
        return {"status": "error", "message": "Aba 'Discretizado' não encontrada."}

    MAX_ROWS = 50_000
    _progress("[INFO] Lendo aba 'Discretizado'...")
    try:
        df = xl.parse("Discretizado", nrows=MAX_ROWS)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba 'Discretizado': {exc}"}
    _progress(f"[INFO] {len(df)} linhas encontradas na planilha.")

    # ── Discover shortcut columns (for indexed ORM fields) ───────
    def fc(*candidates: str) -> str | None:
        return _find_col(df, list(candidates))

    col_item    = fc("ITEM")
    col_asm     = fc("ASSEMBLY")
    col_comp    = fc("COMPONENT", "COMPONENTE")
    col_desc    = fc("DESCRIÇÃO", "DESCRICAO", "DESC")
    col_fam     = fc("FAMILIA", "FAMILY")
    col_area    = fc("AREA")
    col_client  = fc("CLIENTE", "CLIENT")
    col_tipo    = fc("TIPO")
    col_tipo_fw = fc("TIPO FW")
    col_nivel   = fc("NIVEL", "NIVEL FW")
    col_escopo  = fc("ESCOPO", "SCOPE")
    col_qty     = fc("QTDE FW", "QTD FW")
    col_hh      = fc("HH TOTAL")
    col_wsn     = fc("WSN")
    col_ano     = fc("ANO")
    col_mes     = fc("MES")
    col_fw      = fc("FW")
    col_hc      = fc("HEADCOUNT")
    col_lh      = fc("LH")
    col_lm      = fc("LM")
    col_turnos  = fc("TURNOS", "TURNO")
    col_custo   = fc("CUSTO")
    if col_item is None:
        return {"status": "error", "message": "Coluna ITEM/ASSEMBLY não encontrada."}

    # Validate key columns have actual data
    if not _col_has_data(df, col_item):
        return {"status": "error", "message": f"Coluna '{col_item}' (ITEM) não possui dados. Verifique se a aba 'Discretizado' está correta."}
    if col_qty and not _col_has_data(df, col_qty):
        _progress(f"[AVISO] Coluna de quantidade '{col_qty}' está vazia.")

    # ── Ensure table exists (create if first run), then clear all rows ──────
    # We use TRUNCATE instead of DROP to preserve the table's RLS policies,
    # indexes, and grants. If the table doesn't exist yet, create_all builds it.
    _progress("[PREPARE] Verificando / criando tabela monthly_demand...")
    try:
        Base.metadata.create_all(bind=db.get_bind())
    except Exception as exc:
        logger.warning("create_all warning (non-fatal): %s", exc)
    _ensure_ver_col(db, "monthly_demand")
    prod_ver    = get_active_ver(db, "monthly_demand")
    staging_ver = 1 - prod_ver
    db.execute(text("DELETE FROM monthly_demand WHERE ver = :v"), {"v": staging_ver})
    db.commit()
    _progress(f"[STAGE] Importando para staging (prod=v{prod_ver}, staging=v{staging_ver})...")

    # Append mode: staging starts as a copy of the live base, so the swap keeps it.
    carried, seen = _seed_append(db, "monthly_demand", prod_ver, staging_ver, _progress) if append else (0, set())

    # ── Insert new records ────────────────────────────────────────
    records: list[MonthlyDemand] = []
    # One multi-values INSERT per batch (see _insert_records): 500 rows = 1 round
    # trip, where bulk_save_objects cost 500. Kept batched (rather than one giant
    # statement) so progress still ticks and each commit releases its locks.
    BATCH = 500
    skipped = 0
    duplicates = 0
    added = 0
    batch_count = 0
    total_rows = len(df)

    try:
      for _, row in df.iterrows():
        # Skip rows that are entirely empty (all NaN/None)
        if row.isnull().all():
            skipped += 1
            continue

        item_val = _str_val(row.get(col_item)) if col_item else None
        item_val = item_val or ""   # NOT NULL constraint

        row_json = _row_to_json(row)
        if append:
            key = _content_key(row_json)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
        added += 1

        records.append(MonthlyDemand(
            ver       = staging_ver,
            row_json  = row_json,
            item      = item_val,
            assembly  = _str_val(row.get(col_asm))     if col_asm     else None,
            component = _str_val(row.get(col_comp))    if col_comp    else None,
            descricao = _str_val(row.get(col_desc))    if col_desc    else None,
            familia   = _str_val(row.get(col_fam))     if col_fam     else None,
            area      = _str_val(row.get(col_area))    if col_area    else None,
            cliente   = _str_val(row.get(col_client))  if col_client  else None,
            tipo      = _str_val(row.get(col_tipo))    if col_tipo    else None,
            tipo_fw   = _str_val(row.get(col_tipo_fw)) if col_tipo_fw else None,
            nivel     = _str_val(row.get(col_nivel))   if col_nivel   else None,
            escopo    = _str_val(row.get(col_escopo))  if col_escopo  else None,
            ano       = _safe_int(row.get(col_ano))    if col_ano     else None,
            mes       = _safe_int(row.get(col_mes))    if col_mes     else None,
            fw        = _fw_key(row.get(col_fw)) if col_fw and row.get(col_fw) is not None else None,
            qtde_fw   = _safe_float(row.get(col_qty))  if col_qty     else None,
            hh_total  = _safe_float(row.get(col_hh))   if col_hh      else None,
            wsn       = _str_val(row.get(col_wsn))     if col_wsn     else None,
            headcount = _str_val(row.get(col_hc))      if col_hc      else None,
            lh        = _safe_float(row.get(col_lh))   if col_lh      else None,
            lm        = _safe_int(row.get(col_lm))     if col_lm      else None,
            turnos    = _safe_int(row.get(col_turnos)) if col_turnos  else None,
            custo     = _safe_float(row.get(col_custo)) if col_custo   else None,
        ))

        if len(records) >= BATCH:
            batch_count += 1
            inserted_so_far = batch_count * BATCH
            _insert_records(db, records)
            db.commit()  # commit each batch — releases locks so other queries aren't blocked
            records.clear()
            _progress(f"[INFO] {min(inserted_so_far, total_rows)}/{total_rows} linhas processadas")

      if records:
          _insert_records(db, records)
          db.commit()

      _progress("[VALIDATE] Validando dados importados...")
      count_check = db.query(MonthlyDemand).filter(MonthlyDemand.ver == staging_ver).count()
      if count_check == 0:
          raise ValueError("Nenhum registro valido importado.")

      _progress("[APPLY] Aplicando atualizacao (swap atomico)...")
      set_active_ver(db, "monthly_demand", staging_ver)
      db.execute(text("DELETE FROM monthly_demand WHERE ver = :v"), {"v": prod_ver})
      db.commit()

      _progress(f"[OK] {count_check} registros importados com sucesso.")
      logger.info("[import_excel_to_db] %d inseridos (%d vazios).", count_check, skipped)

      # NOTE: the split tables (itens_rout + plano_prod) are now populated from
      # two SEPARATE normalized source files via import_itens_rout_to_db /
      # import_plano_prod_to_db — NOT from this combined Discretizado sheet.
      return {
          "status":     "ok",
          "message":    _mode_summary(mode, carried, added, duplicates, skipped, count_check),
          "rows":       count_check,
          "mode":       mode,
          "added":      added,
          "duplicates": duplicates,
          "carried":    carried,
      }

    except (InterruptedError, KeyboardInterrupt):
        _discard_staging(db, "monthly_demand", staging_ver)
        _progress("[CANCEL] Importacao cancelada. Dados originais preservados.")
        raise
    except Exception as _exc:
        _discard_staging(db, "monthly_demand", staging_ver)
        return {"status": "error", "message": f"Erro durante importacao: {_exc}"}



# ── Independent split imports (two normalized source files) ──────────────────
# 'Itens Rout' (routing/BOM master) and 'Plano Prod' (production plan) are now
# two SEPARATE Excel files, each with its own named sheet, uploaded independently
# via their own endpoint/button. They link on the business key ITEM ⇄ ASSEMBLY
# (1:N). Each importer reads its sheet, stores the FULL row in row_json (exact
# column names), plus indexed shortcuts, with the proven staging/ver/swap. There
# is NO __rid — the files are independent; reconstruction is by business key.

ITENS_ROUT_SHEETS    = ["Item Rout", "Itens Rout", "Item - Rout", "Itens - Rout", "Item Rout.", "Itens Rout."]
ITENS_ROUT_REQUIRED  = ["ASSEMBLY"]

# ── Columns MIGRATED OUT of Item Rout into the centralized Headcount tab ──────────────────────
# Capacity data (who works a workstation, its hour/people caps, its shift count) is now owned by
# the Headcount tab (Workstation / Person / WorkstationPerson), keyed by WSN. It used to be
# repeated inline on every routing operation row here, which made the same fact editable in two
# places and let a re-import silently overwrite curated capacity data.
#
# These columns are DROPPED from the frame before anything is persisted, so they reach neither the
# typed shortcut columns NOR row_json — a re-import of a spreadsheet that still contains them is a
# no-op for capacity. They are simply ignored, never an error: the files in circulation still carry
# them and must keep importing cleanly.
#
# WSN IS DELIBERATELY NOT IN THIS LIST. It is not capacity data — it is the routing's workstation
# key and the JOIN KEY the Headcount tab is mapped through. Dropping it would break the very
# mapping this migration depends on. (The join is done in pandas on the reconstructed frame, not
# in SQL — this comment used to cite an ix_itens_rout_asm_wsn index as evidence; that index was
# never queried and has been removed, see _UNUSED_INDEXES.)
ITENS_ROUT_MIGRATED_COLS = ("HEADCOUNT", "LH", "LM", "TURNOS", "TURNO")

def import_itens_rout_to_db(filepath: str | Path, db: Session, progress_callback=None,
                            mode: str = "replace") -> dict:
    """Import the standalone 'Itens Rout' file into the itens_rout table.

    Routing/BOM master grain (per operation). Keyed by ASSEMBLY (links to
    plano_prod.item). Atomic ver-swap; full row preserved in row_json.
    mode="append" keeps the current rows and adds only the file's new ones.
    """
    mode   = mode if mode in IMPORT_MODES else "replace"
    append = mode == "append"
    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo nao encontrado: {filepath}"}

    _progress(f"[INFO] Lendo '{filepath.name}'...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    sheet = next((s for s in ITENS_ROUT_SHEETS if s in xl.sheet_names), None)
    if sheet is None:
        avail = ", ".join(f"'{s}'" for s in xl.sheet_names)
        return {"status": "error", "message": f"Aba 'Itens Rout' nao encontrada. Abas: {avail}"}

    _progress(f"[INFO] Lendo aba '{sheet}'...")
    try:
        df = xl.parse(sheet, nrows=50_000)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba '{sheet}': {exc}"}

    def fc(*candidates: str) -> str | None:
        return _find_col(df, list(candidates))

    missing = [c for c in ITENS_ROUT_REQUIRED if fc(c) is None]
    if missing:
        return {"status": "error", "message": f"Colunas obrigatorias ausentes em 'Itens Rout': {missing}"}

    # Capacity columns now owned by the Headcount tab are dropped HERE, before row_json is built or
    # any shortcut column is read, so nothing downstream can pick them back up (see
    # ITENS_ROUT_MIGRATED_COLS). Matched case/space-insensitively via _find_col, like every other
    # column in this importer, so 'Headcount'/'headcount '/'LH ' are all caught.
    _dropped: list[str] = []
    for _name in ITENS_ROUT_MIGRATED_COLS:
        _actual = _find_col(df, [_name])
        if _actual is not None and _actual in df.columns:
            df = df.drop(columns=[_actual])
            _dropped.append(str(_actual))
    if _dropped:
        _progress(
            f"[INFO] Colunas de capacidade ignoradas (agora na aba Headcount): {', '.join(_dropped)}."
        )

    col_asm    = fc("ASSEMBLY")
    if not _col_has_data(df, col_asm):
        return {"status": "error", "message": "Coluna 'ASSEMBLY' nao possui dados validos."}
    col_comp   = fc("COMPONENT", "COMPONENTE")
    col_desc   = fc("DESCRIÇÃO", "DESCRICAO", "DESC")
    col_wsn    = fc("WSN")
    col_escopo = fc("ESCOPO", "SCOPE")
    col_hh     = fc("HH TOTAL")

    _progress("[PREPARE] Criando/limpando tabela itens_rout...")
    try:
        Base.metadata.create_all(bind=db.get_bind(), tables=[Base.metadata.tables["itens_rout"]])
    except Exception as exc:
        logger.warning("create_all itens_rout: %s", exc)
    _ensure_ver_col(db, "itens_rout")
    _drop_unused_indexes(db, "itens_rout")   # before staging inserts, so they pay nothing

    prod_ver = get_active_ver(db, "itens_rout")
    stg_ver  = 1 - prod_ver
    db.execute(text("DELETE FROM itens_rout WHERE ver = :v"), {"v": stg_ver})
    db.commit()

    carried, seen = _seed_append(db, "itens_rout", prod_ver, stg_ver, _progress) if append else (0, set())

    total_rows = len(df)
    _progress(f"[STAGE] Importando {total_rows} linhas para staging (v{stg_ver})...")
    records: list[ItensRout] = []
    # One multi-values INSERT per batch (see _insert_records): 500 rows = 1 round
    # trip, where bulk_save_objects cost 500. Kept batched (rather than one giant
    # statement) so progress still ticks and each commit releases its locks.
    BATCH = 500
    skipped = 0
    duplicates = 0
    added = 0
    inserted = 0
    try:
      for _, row in df.iterrows():
        if row.isnull().all():
            skipped += 1
            continue
        asm_val = _str_val(row.get(col_asm)) if col_asm else None
        if not asm_val:
            skipped += 1
            continue
        row_json = _row_to_json(row)
        if append:
            key = _content_key(row_json)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
        added += 1
        records.append(ItensRout(
            ver       = stg_ver,
            row_json  = row_json,
            assembly  = asm_val,
            component = _str_val(row.get(col_comp))   if col_comp   else None,
            descricao = _str_val(row.get(col_desc))   if col_desc   else None,
            wsn       = _str_val(row.get(col_wsn))    if col_wsn    else None,
            escopo    = _str_val(row.get(col_escopo)) if col_escopo else None,
            # headcount / lh / lm / turnos are intentionally NOT written: capacity lives in the
            # Headcount tab now, mapped by WSN. The model columns remain (nullable, unwritten) so
            # this needed no destructive migration — see models.py::ItensRout.
            hh_total  = _safe_float(row.get(col_hh))   if col_hh     else None,
        ))
        if len(records) >= BATCH:
            _insert_records(db, records); db.commit()
            inserted += len(records); records.clear()
            _progress(f"[INFO] {min(inserted, total_rows)}/{total_rows} linhas processadas")
      if records:
          _insert_records(db, records); db.commit(); inserted += len(records)

      _progress("[VALIDATE] Validando itens_rout...")
      count_check = db.query(ItensRout).filter(ItensRout.ver == stg_ver).count()
      if count_check == 0:
          raise ValueError("Nenhum registro valido em itens_rout.")

      _progress("[APPLY] Swap atomico itens_rout...")
      set_active_ver(db, "itens_rout", stg_ver)
      db.execute(text("DELETE FROM itens_rout WHERE ver = :v"), {"v": prod_ver})
      db.commit()

      _progress(f"[OK] {count_check} registros -> itens_rout ({skipped} ignorados).")
      return {
          "status": "ok",
          "message": _mode_summary(mode, carried, added, duplicates, skipped, count_check),
          "rows": count_check, "table": "itens_rout",
          "mode": mode, "added": added, "duplicates": duplicates, "carried": carried,
      }

    except (InterruptedError, KeyboardInterrupt):
        _discard_staging(db, "itens_rout", stg_ver)
        _progress("[CANCEL] Importacao de itens_rout cancelada.")
        raise
    except Exception as _exc:
        _discard_staging(db, "itens_rout", stg_ver)
        return {"status": "error", "message": f"Erro durante importacao de itens_rout: {_exc}"}


PLANO_PROD_SHEETS    = ["Plano Prod", "Plano - Prod", "Plano Prod."]
PLANO_PROD_REQUIRED  = ["ITEM"]

def import_plano_prod_to_db(filepath: str | Path, db: Session, progress_callback=None,
                            mode: str = "replace") -> dict:
    """Import the standalone 'Plano Prod' file into the plano_prod table.

    Production-plan grain (one row per ITEM+FW). Keyed by ITEM (links to
    itens_rout.assembly). Atomic ver-swap; full row preserved in row_json.
    mode="append" keeps the current rows and adds only the file's new ones.
    """
    mode   = mode if mode in IMPORT_MODES else "replace"
    append = mode == "append"
    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo nao encontrado: {filepath}"}

    _progress(f"[INFO] Lendo '{filepath.name}'...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    sheet = next((s for s in PLANO_PROD_SHEETS if s in xl.sheet_names), None)
    if sheet is None:
        avail = ", ".join(f"'{s}'" for s in xl.sheet_names)
        return {"status": "error", "message": f"Aba 'Plano Prod' nao encontrada. Abas: {avail}"}

    _progress(f"[INFO] Lendo aba '{sheet}'...")
    try:
        df = xl.parse(sheet, nrows=50_000)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba '{sheet}': {exc}"}

    def fc(*candidates: str) -> str | None:
        return _find_col(df, list(candidates))

    missing = [c for c in PLANO_PROD_REQUIRED if fc(c) is None]
    if missing:
        return {"status": "error", "message": f"Colunas obrigatorias ausentes em 'Plano Prod': {missing}"}

    col_item   = fc("ITEM")
    if not _col_has_data(df, col_item):
        return {"status": "error", "message": "Coluna 'ITEM' nao possui dados validos."}
    col_client = fc("CLIENTE", "CLIENT")
    col_area   = fc("AREA")
    col_fam    = fc("FAMILIA", "FAMILY")
    col_ano    = fc("ANO")
    col_mes    = fc("MES")
    col_fw     = fc("FW")
    col_qty    = fc("QTDE FW", "QTD FW")
    col_tipofw = fc("TIPO FW")
    col_nivel  = fc("NIVEL", "NIVEL FW")
    col_custo  = fc("CUSTO")

    _progress("[PREPARE] Criando/limpando tabela plano_prod...")
    try:
        Base.metadata.create_all(bind=db.get_bind(), tables=[Base.metadata.tables["plano_prod"]])
    except Exception as exc:
        logger.warning("create_all plano_prod: %s", exc)
    _ensure_ver_col(db, "plano_prod")
    _drop_unused_indexes(db, "plano_prod")   # before staging inserts, so they pay nothing

    prod_ver = get_active_ver(db, "plano_prod")
    stg_ver  = 1 - prod_ver
    db.execute(text("DELETE FROM plano_prod WHERE ver = :v"), {"v": stg_ver})
    db.commit()

    carried, seen = _seed_append(db, "plano_prod", prod_ver, stg_ver, _progress) if append else (0, set())

    total_rows = len(df)
    _progress(f"[STAGE] Importando {total_rows} linhas para staging (v{stg_ver})...")
    records: list[PlanoProd] = []
    # One multi-values INSERT per batch (see _insert_records): 500 rows = 1 round
    # trip, where bulk_save_objects cost 500. Kept batched (rather than one giant
    # statement) so progress still ticks and each commit releases its locks.
    BATCH = 500
    skipped = 0
    duplicates = 0
    added = 0
    inserted = 0
    try:
      for _, row in df.iterrows():
        if row.isnull().all():
            skipped += 1
            continue
        item_val = _str_val(row.get(col_item)) if col_item else None
        if not item_val:
            skipped += 1
            continue
        row_json = _row_to_json(row)
        if append:
            key = _content_key(row_json)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
        added += 1
        records.append(PlanoProd(
            ver       = stg_ver,
            row_json  = row_json,
            item      = item_val,
            cliente   = _str_val(row.get(col_client)) if col_client else None,
            area      = _str_val(row.get(col_area))   if col_area   else None,
            familia   = _str_val(row.get(col_fam))    if col_fam    else None,
            ano       = _safe_int(row.get(col_ano))   if col_ano    else None,
            mes       = _safe_int(row.get(col_mes))   if col_mes    else None,
            fw        = _fw_key(row.get(col_fw)) if col_fw and row.get(col_fw) is not None else None,
            qtde_fw   = _safe_float(row.get(col_qty)) if col_qty    else None,
            tipo_fw   = _str_val(row.get(col_tipofw)) if col_tipofw else None,
            nivel     = _str_val(row.get(col_nivel))  if col_nivel  else None,
            custo     = _safe_float(row.get(col_custo)) if col_custo else None,
        ))
        if len(records) >= BATCH:
            _insert_records(db, records); db.commit()
            inserted += len(records); records.clear()
            _progress(f"[INFO] {min(inserted, total_rows)}/{total_rows} linhas processadas")
      if records:
          _insert_records(db, records); db.commit(); inserted += len(records)

      _progress("[VALIDATE] Validando plano_prod...")
      count_check = db.query(PlanoProd).filter(PlanoProd.ver == stg_ver).count()
      if count_check == 0:
          raise ValueError("Nenhum registro valido em plano_prod.")

      _progress("[APPLY] Swap atomico plano_prod...")
      set_active_ver(db, "plano_prod", stg_ver)
      db.execute(text("DELETE FROM plano_prod WHERE ver = :v"), {"v": prod_ver})
      db.commit()

      _progress(f"[OK] {count_check} registros -> plano_prod ({skipped} ignorados).")
      return {
          "status": "ok",
          "message": _mode_summary(mode, carried, added, duplicates, skipped, count_check),
          "rows": count_check, "table": "plano_prod",
          "mode": mode, "added": added, "duplicates": duplicates, "carried": carried,
      }

    except (InterruptedError, KeyboardInterrupt):
        _discard_staging(db, "plano_prod", stg_ver)
        _progress("[CANCEL] Importacao de plano_prod cancelada.")
        raise
    except Exception as _exc:
        _discard_staging(db, "plano_prod", stg_ver)
        return {"status": "error", "message": f"Erro durante importacao de plano_prod: {_exc}"}



# ── Schedule - MS import ────────────────────────────────────────────────────

SCHEDULE_SHEET   = "Schedule - MS"
SCHEDULE_REQUIRED = ["Standard WO", "Task Name", "Start MS", "Takt"]

def import_schedule_to_db(filepath: str | Path, db: Session, progress_callback=None,
                          mode: str = "replace") -> dict:
    """
    Rebuilds the 'schedule' table from the 'Schedule - MS' sheet.
    Required columns: Standard WO, Task Name, Start MS, Takt.
    mode="append" keeps the current rows and adds only the file's new ones.
    """
    mode   = mode if mode in IMPORT_MODES else "replace"
    append = mode == "append"
    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo nao encontrado: {filepath}"}

    _progress(f"[INFO] Lendo '{filepath.name}'...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    if SCHEDULE_SHEET not in xl.sheet_names:
        avail = ", ".join(f"'{s}'" for s in xl.sheet_names)
        return {"status": "error", "message": f"Aba '{SCHEDULE_SHEET}' nao encontrada. Abas disponiveis: {avail}"}

    _progress(f"[INFO] Lendo aba '{SCHEDULE_SHEET}'...")
    try:
        df = xl.parse(SCHEDULE_SHEET)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba '{SCHEDULE_SHEET}': {exc}"}

    # Validate required columns (accent-insensitive)
    missing = [c for c in SCHEDULE_REQUIRED if _find_col(df, [c]) is None]
    if missing:
        return {"status": "error", "message": f"Colunas obrigatórias não encontradas: {missing}"}

    col_wo   = _find_col(df, ["Standard WO"])

    # Validate key columns have actual data
    if not _col_has_data(df, col_wo):
        return {"status": "error", "message": f"Coluna 'Standard WO' não possui dados válidos. Verifique se a aba '{SCHEDULE_SHEET}' está correta."}
    col_tn   = _find_col(df, ["Task Name"])
    col_sm   = _find_col(df, ["Start MS", "START MS", "Start", "START"])
    col_tk   = _find_col(df, ["Takt"])
    col_ln   = _find_col(df, ["Linha", "LINHA", "Line", "LINE"])
    col_fn   = _find_col(df, ["Finish MS", "FINISH MS", "Finish", "FINISH"])
    # Contratual — optional, display-only contractual finish date. Absent column or blank cell
    # both mean "no contractual date" and are stored as NULL.
    col_ct   = _find_col(df, ["Contratual", "CONTRATUAL", "Contractual", "Data Contratual",
                              "Contract MS", "Contratual MS"])

    _progress("[INFO] Criando/limpando tabela 'schedule'...")
    try:
        Base.metadata.create_all(bind=db.get_bind(), tables=[Base.metadata.tables["schedule"]])
    except Exception as exc:
        logger.warning("create_all schedule: %s", exc)
    # No ALTER TABLE here: SQLite has neither ADD COLUMN IF NOT EXISTS nor RLS, and the demo
    # database is created from the current models on every boot, so there is nothing to migrate.
    _ensure_ver_col(db, "schedule")
    _drop_unused_indexes(db, "schedule")   # before staging inserts, so they pay nothing
    sched_prod_ver    = get_active_ver(db, "schedule")
    sched_staging_ver = 1 - sched_prod_ver
    db.execute(text("DELETE FROM schedule WHERE ver = :v"), {"v": sched_staging_ver})
    db.commit()

    carried, seen = _seed_append(db, "schedule", sched_prod_ver, sched_staging_ver, _progress) if append else (0, set())

    total_rows = len(df)
    _progress(f"[STAGE] Importando {total_rows} linhas para staging (v{sched_staging_ver})...")
    records = []
    skipped = 0
    duplicates = 0
    added = 0
    inserted = 0
    # One multi-values INSERT per batch (see _insert_records): 500 rows = 1 round
    # trip, where bulk_save_objects cost 500. Kept batched (rather than one giant
    # statement) so progress still ticks and each commit releases its locks.
    BATCH = 500
    try:
      for _, row in df.iterrows():
        if row.isnull().all():
            skipped += 1
            continue
        wo_val = _str_val(row.get(col_wo)) if col_wo else None
        if not wo_val:
            skipped += 1
            continue
        # Convert Start MS (datetime or date) to ISO string
        sm_raw = row.get(col_sm) if col_sm else None
        if hasattr(sm_raw, 'date'):
            sm_str = sm_raw.date().isoformat()
        elif sm_raw is not None and str(sm_raw).strip().lower() not in ("nan", "none", ""):
            sm_str = str(sm_raw).strip()
        else:
            sm_str = None
        # Finish MS and Contratual are both dates and are read by the SAME parser, so the
        # contractual column can never be interpreted differently from the scheduled one.
        fn_str = _cell_to_iso_date(row.get(col_fn)) if col_fn else None
        ct_str = _cell_to_iso_date(row.get(col_ct)) if col_ct else None
        row_json = _row_to_json(row)
        if append:
            key = _content_key(row_json)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
        added += 1
        records.append(ScheduleRow(
            ver       = sched_staging_ver,
            row_json  = row_json,
            wo        = wo_val,
            task_name = _str_val(row.get(col_tn)) if col_tn else None,
            start_ms  = sm_str,
            takt      = _safe_float(row.get(col_tk)) if col_tk else None,
            linha     = _str_val(row.get(col_ln)) if col_ln else None,
            finish_ms = fn_str,
            contract_ms = ct_str,
        ))
        if len(records) >= BATCH:
            _insert_records(db, records)
            db.commit()  # commit each batch — releases locks so other queries aren't blocked
            inserted += len(records)
            records.clear()
            _progress(f"[INFO] Inserindo lote — {inserted}/{total_rows} linhas processadas")
      if records:
          _insert_records(db, records)
          db.commit()
          inserted += len(records)

      _progress("[VALIDATE] Validando dados do schedule...")
      count_check = db.query(ScheduleRow).filter(ScheduleRow.ver == sched_staging_ver).count()
      if count_check == 0:
          raise ValueError("Nenhum registro valido no schedule.")

      _progress("[APPLY] Aplicando atualizacao do schedule...")
      set_active_ver(db, "schedule", sched_staging_ver)
      db.execute(text("DELETE FROM schedule WHERE ver = :v"), {"v": sched_prod_ver})
      db.commit()

      _progress(f"[OK] {count_check} registros importados na tabela schedule.")
      return {
          "status":     "ok",
          "message":    _mode_summary(mode, carried, added, duplicates, skipped, count_check),
          "rows":       count_check,
          "table":      "schedule",
          "mode":       mode,
          "added":      added,
          "duplicates": duplicates,
          "carried":    carried,
      }

    except (InterruptedError, KeyboardInterrupt):
        _discard_staging(db, "schedule", sched_staging_ver)
        _progress("[CANCEL] Importacao do schedule cancelada.")
        raise
    except Exception as _exc:
        _discard_staging(db, "schedule", sched_staging_ver)
        return {"status": "error", "message": f"Erro durante importacao do schedule: {_exc}"}



# ── Locos Rout import ───────────────────────────────────────────────────────

LOCOS_ROUT_SHEET    = "Locos - Rout"    # sem ponto; pode tambem ser "Locos Rout" ou "Locos - Rout."
LOCOS_ROUT_SHEETS   = ["Locos - Rout", "Locos Rout", "Locos - Rout."]
LOCOS_ROUT_REQUIRED = ["LOCOMOTIVA", "PART NUMBER", "HH UNIT", "DURACAO", "INICIO"]

def import_locos_rout_to_db(filepath: str | Path, db: Session, progress_callback=None,
                            mode: str = "replace") -> dict:
    """
    Rebuilds the 'locos_rout' table from the 'Locos Rout' sheet.
    Required columns: LOCOMOTIVA, PART NUMBER, HH UNIT, DURACAO, INICIO.
    mode="append" keeps the current rows and adds only the file's new ones.
    """
    mode   = mode if mode in IMPORT_MODES else "replace"
    append = mode == "append"
    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo nao encontrado: {filepath}"}

    _progress(f"[INFO] Lendo '{filepath.name}'...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    if not any(s in xl.sheet_names for s in LOCOS_ROUT_SHEETS):
        avail = ", ".join(f"'{s}'" for s in xl.sheet_names)
        return {"status": "error", "message": f"Aba 'Locos Rout' nao encontrada. Abas disponiveis: {avail}"}

    _found_sheet = next(s for s in LOCOS_ROUT_SHEETS if s in xl.sheet_names)

    _progress(f"[INFO] Lendo aba '{_found_sheet}'...")
    try:
        df = xl.parse(_found_sheet)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba '{LOCOS_ROUT_SHEET}': {exc}"}

    missing = [c for c in LOCOS_ROUT_REQUIRED if _find_col(df, [c]) is None]
    if missing:
        return {"status": "error", "message": f"Colunas obrigatórias não encontradas: {missing}"}

    col_loco = _find_col(df, ["LOCOMOTIVA"])

    # Validate key column has actual data
    if not _col_has_data(df, col_loco):
        return {"status": "error", "message": f"Coluna 'LOCOMOTIVA' não possui dados válidos. Verifique se a aba correta foi selecionada."}
    col_pn   = _find_col(df, ["PART NUMBER"])
    col_ws   = _find_col(df, ["WORKSTATION"])
    col_sa   = _find_col(df, ["SUBAREA"])
    col_desc = _find_col(df, ["DESCRIÇÃO", "DESCRICAO", "DESCRIÇAO", "DESC"])
    col_area = _find_col(df, ["AREA"])
    col_hh   = _find_col(df, ["HH UNIT"])
    col_qtd  = _find_col(df, ["QTD", "QTDE"])
    col_dur  = _find_col(df, ["DURACAO", "DURAÇÃO"])
    col_ini  = _find_col(df, ["INICIO", "INÍCIO"])
    col_wo_order = _find_col(df, ["WORKORDER", "WORK ORDER", "WORK_ORDER"])
    # Plano de Produção pass-through columns (optional — absent in older sheets).
    col_part_desc = _find_col(df, ["PART DESC", "PART DESCRIPTION", "PART_DESC"])
    col_escopo    = _find_col(df, ["ESCOPO"])
    col_linha     = _find_col(df, ["LINHA"])

    _progress("[INFO] Criando/limpando tabela 'locos_rout'...")
    try:
        Base.metadata.create_all(bind=db.get_bind(), tables=[Base.metadata.tables["locos_rout"]])
    except Exception as exc:
        logger.warning("create_all locos_rout: %s", exc)
    # No ALTER TABLE here: SQLite has neither ADD COLUMN IF NOT EXISTS nor RLS, and the demo
    # database is created from the current models on every boot, so there is nothing to migrate.
    _ensure_ver_col(db, "locos_rout")
    _drop_unused_indexes(db, "locos_rout")   # before staging inserts, so they pay nothing
    lr_prod_ver    = get_active_ver(db, "locos_rout")
    lr_staging_ver = 1 - lr_prod_ver
    db.execute(text("DELETE FROM locos_rout WHERE ver = :v"), {"v": lr_staging_ver})
    db.commit()

    carried, seen = _seed_append(db, "locos_rout", lr_prod_ver, lr_staging_ver, _progress) if append else (0, set())

    total_rows = len(df)
    _progress(f"[STAGE] Importando {total_rows} linhas para staging (v{lr_staging_ver})...")
    records = []
    skipped = 0
    duplicates = 0
    added = 0
    inserted = 0
    # One multi-values INSERT per batch (see _insert_records): 500 rows = 1 round
    # trip, where bulk_save_objects cost 500. Kept batched (rather than one giant
    # statement) so progress still ticks and each commit releases its locks.
    BATCH = 500
    try:
      for _, row in df.iterrows():
        if row.isnull().all():
            skipped += 1
            continue
        loco_val = _str_val(row.get(col_loco)) if col_loco else None
        if not loco_val:
            skipped += 1
            continue
        row_json = _row_to_json(row)
        if append:
            key = _content_key(row_json)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
        added += 1
        records.append(LocosRout(
            ver         = lr_staging_ver,
            row_json    = row_json,
            locomotiva  = loco_val,
            part_number = _str_val(row.get(col_pn))   if col_pn   else None,
            workstation = _str_val(row.get(col_ws))   if col_ws   else None,
            subarea     = _str_val(row.get(col_sa))   if col_sa   else None,
            descricao   = _str_val(row.get(col_desc)) if col_desc else None,
            area        = _str_val(row.get(col_area)) if col_area else None,
            hh_unit     = _safe_float(row.get(col_hh)) if col_hh  else None,
            qtd         = _safe_int(row.get(col_qtd))  if col_qtd else None,
            duracao     = _str_val(row.get(col_dur))  if col_dur  else None,
            inicio      = _str_val(row.get(col_ini))  if col_ini  else None,
            workorder   = _str_id_val(row.get(col_wo_order)) if col_wo_order else None,
            part_desc   = _str_val(row.get(col_part_desc)) if col_part_desc else None,
            escopo      = _str_val(row.get(col_escopo))    if col_escopo    else None,
            linha       = _str_val(row.get(col_linha))     if col_linha     else None,
        ))
        if len(records) >= BATCH:
            _insert_records(db, records)
            db.commit()  # commit each batch — releases locks so other queries aren't blocked
            inserted += len(records)
            records.clear()
            _progress(f"[INFO] Inserindo lote — {inserted}/{total_rows} linhas processadas")
      if records:
          _insert_records(db, records)
          db.commit()
          inserted += len(records)

      _progress("[VALIDATE] Validando dados de locos_rout...")
      count_check = db.query(LocosRout).filter(LocosRout.ver == lr_staging_ver).count()
      if count_check == 0:
          raise ValueError("Nenhum registro valido em locos_rout.")

      _progress("[APPLY] Aplicando atualizacao de locos_rout...")
      set_active_ver(db, "locos_rout", lr_staging_ver)
      db.execute(text("DELETE FROM locos_rout WHERE ver = :v"), {"v": lr_prod_ver})
      db.commit()

      _progress(f"[OK] {count_check} registros importados na tabela locos_rout.")
      return {
          "status":     "ok",
          "message":    _mode_summary(mode, carried, added, duplicates, skipped, count_check),
          "rows":       count_check,
          "table":      "locos_rout",
          "mode":       mode,
          "added":      added,
          "duplicates": duplicates,
          "carried":    carried,
      }

    except (InterruptedError, KeyboardInterrupt):
        _discard_staging(db, "locos_rout", lr_staging_ver)
        _progress("[CANCEL] Importacao de locos_rout cancelada.")
        raise
    except Exception as _exc:
        _discard_staging(db, "locos_rout", lr_staging_ver)
        return {"status": "error", "message": f"Erro durante importacao de locos_rout: {_exc}"}


HEADCOUNT_SHEET = "HeadCount"


def import_headcount_to_db(filepath: str | Path, db: Session, progress_callback=None,
                           mode: str = "replace") -> dict:
    """
    Populates Workstation / Person / WorkstationPerson from the 'HeadCount' sheet
    (columns WSN, AREA, DESC, LH, LM, QTDE, TURNOS, HEADCOUNT — matrix or legacy layout,
    both already handled by services.data_loader._parse_headcount).

    Unlike the big transactional tables, this is a small reference dataset — no
    staging-version swap, just a direct upsert:
      mode="replace": WSNs present in the file get their Workstation row + people-links
                       fully replaced (existing links for that WSN removed, new ones added).
                       WSNs already in the DB but absent from the file are left untouched
                       (a re-import of one area shouldn't wipe other areas). People are
                       never deleted here (leave/vacation records must survive re-import).
      mode="append":   same upsert, semantically identical to replace for this table (no
                       WSNs are ever removed) — kept for UI/API symmetry with other imports.
    """
    mode = mode if mode in IMPORT_MODES else "replace"

    def _progress(msg: str):
        logger.info(msg)
        if progress_callback:
            try:
                progress_callback(msg)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass

    filepath = Path(filepath)
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo nao encontrado: {filepath}"}

    _progress(f"[INFO] Lendo '{filepath.name}'...")
    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    if HEADCOUNT_SHEET not in xl.sheet_names:
        avail = ", ".join(f"'{s}'" for s in xl.sheet_names)
        return {"status": "error", "message": f"Aba 'HeadCount' nao encontrada. Abas disponiveis: {avail}"}

    _progress(f"[INFO] Lendo aba '{HEADCOUNT_SHEET}'...")
    try:
        df = xl.parse(HEADCOUNT_SHEET, header=0)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao ler aba '{HEADCOUNT_SHEET}': {exc}"}

    from services.data_loader import _parse_headcount
    try:
        by_wsn = _parse_headcount(df)
    except Exception as exc:
        return {"status": "error", "message": f"Erro ao interpretar aba '{HEADCOUNT_SHEET}': {exc}"}

    # AREA isn't part of _parse_headcount's return shape — read it directly (matrix or
    # legacy layout both keep a real 'AREA' header, unlike WSN in the matrix format).
    area_by_wsn: dict[str, str] = {}
    try:
        col_area = _find_col(df, ["AREA"])
        col_wsn_flat = _find_col(df, ["WSN"])
        if col_area and col_wsn_flat:
            for _, row in df.iterrows():
                w = _str_val(row.get(col_wsn_flat))
                a = _str_val(row.get(col_area))
                if w and a:
                    area_by_wsn[w] = a
    except Exception:
        pass

    if not by_wsn:
        return {"status": "error", "message": "Nenhuma workstation valida encontrada na aba 'HeadCount'."}

    try:
        Base.metadata.create_all(bind=db.get_bind(), tables=[
            Base.metadata.tables["workstation"],
            Base.metadata.tables["person"],
            Base.metadata.tables["workstation_person"],
        ])
    except Exception as exc:
        logger.warning("create_all headcount tables: %s", exc)

    total = len(by_wsn)
    _progress(f"[STAGE] Processando {total} workstations...")
    ws_upserted = 0
    people_upserted = 0
    links_upserted = 0

    try:
        for wsn, info in by_wsn.items():
            ws = db.query(Workstation).filter(Workstation.wsn == wsn).first()
            if ws is None:
                ws = Workstation(wsn=wsn)
                db.add(ws)
                db.flush()
            ws.area = area_by_wsn.get(wsn) or ws.area
            ws.desc = info.get("desc") or ws.desc
            ws.hour_limit = info.get("lh") if info.get("lh") is not None else ws.hour_limit
            ws.people_limit = info.get("lm") if info.get("lm") is not None else ws.people_limit
            ws.qtde = info.get("qtde") if info.get("qtde") is not None else ws.qtde
            ws.turnos = info.get("turnos") if info.get("turnos") is not None else ws.turnos
            ws_upserted += 1

            # Replace this WSN's people links with whatever the file lists (people
            # themselves are upserted, never deleted, so vacation history survives).
            #
            # The expertise level lives ON the link, and the HeadCount sheet has no column for
            # it — so a plain delete-and-recreate would WIPE every assessed level for every WSN
            # in the file, silently, on a routine re-import. Levels are carried across for the
            # pairs that survive the replace: a person the file still lists keeps their level,
            # and one the file dropped loses it with the link, which is the same rule the UI
            # applies when someone is unallocated by hand.
            levels_before = {
                link.person_id: link.expertise_level
                for link in db.query(WorkstationPerson)
                              .filter(WorkstationPerson.workstation_id == ws.id).all()
                if link.expertise_level is not None
            }
            db.query(WorkstationPerson).filter(WorkstationPerson.workstation_id == ws.id).delete()
            for name in info.get("people") or []:
                name = str(name).strip()
                if not name:
                    continue
                person = db.query(Person).filter(Person.name == name).first()
                if person is None:
                    person = Person(name=name)
                    db.add(person)
                    db.flush()
                    people_upserted += 1
                db.add(WorkstationPerson(workstation_id=ws.id, person_id=person.id,
                                         expertise_level=levels_before.get(person.id)))
                links_upserted += 1

            db.commit()

        _progress(f"[OK] {ws_upserted} workstations, {people_upserted} pessoas novas, "
                  f"{links_upserted} vinculos atualizados.")
        return {
            "status":  "ok",
            "message": f"{ws_upserted} workstations importadas, {people_upserted} pessoas novas, "
                       f"{links_upserted} vinculos atualizados.",
            "rows":    ws_upserted,
            "table":   "headcount",
            "mode":    mode,
        }
    except (InterruptedError, KeyboardInterrupt):
        db.rollback()
        _progress("[CANCEL] Importacao de headcount cancelada.")
        raise
    except Exception as _exc:
        db.rollback()
        return {"status": "error", "message": f"Erro durante importacao de headcount: {_exc}"}


# ── CLI entry-point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import dotenv
    from env_paths import resolve_env_file

    # Resolve through env_paths, not the cwd: the .env lives outside the synced folder.
    _env_file = resolve_env_file()
    if _env_file is not None:
        dotenv.load_dotenv(dotenv_path=_env_file)

    if engine is None:
        print("[import_excel_to_db] DATABASE_URL não configurada.")
        sys.exit(1)

    # Ensure tables exist (create_all is also called inside import_excel_to_db)
    Base.metadata.create_all(bind=engine)

    xl_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data" / "demo_source.xlsx"
    print(f"[import_excel_to_db] Importando {xl_path} ...")

    with get_db() as db:
        result = import_excel_to_db(xl_path, db)

    if result["status"] == "ok":
        print(f"[import_excel_to_db] ✓ {result['message']}")
    else:
        print(f"[import_excel_to_db] ✗ {result['message']}")
        sys.exit(1)