"""
gantt_builder.py
Módulo reutilizável que constrói dados e Excel do Gantt de linha especial.
Extraído de gantt_special_line.py para uso via API (main.py).

Funções públicas:
  build_gantt_data()   → dict  (payload JSON para o frontend)
  build_gantt_excel()  → bytes (arquivo .xlsx em memória)
"""

from __future__ import annotations
import functools, io, json, math, os, re, time
from datetime import datetime, date, timedelta
from collections import defaultdict
from typing import Any
import unicodedata
from sqlalchemy import text
from services import tipos

# Shared fiscal-calendar engine — single source of truth for fiscal weeks,
# holidays and working-day logic (consumed by Capacity Analysis too). These
# thin wrappers preserve gantt_builder's historical function names/signatures
# so existing imports (main.py uses _get_holidays_for_dates) keep working.
from services.calendar_445 import (
    _easter_date,
    build_br_holidays as _build_br_holidays,
    get_holidays_for_dates as _get_holidays_for_dates,
    fw_label as _semana_fw_label,
    fw_offset_for_year as _fw_offset_for_year,
    is_forced_working as _is_forced_working,
    is_holiday_day as _is_holiday_day,
)

# ── Helpers ─────────────────────────────────────────────────────────────────


def _add_business_days(start: date, n: int, holidays: frozenset = frozenset()) -> date:
    if n == 0:
        return start
    step = 1 if n > 0 else -1
    cur, rem = start, abs(n)
    while rem > 0:
        cur += timedelta(days=step)
        if cur.weekday() < 5 and cur not in holidays:
            rem -= 1
    return cur


def _business_days_range(start: date, n_days: int, holidays: frozenset = frozenset()) -> list[date]:
    days, cur = [], start
    while len(days) < n_days:
        if cur.weekday() < 5 and cur not in holidays:
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _business_days_between(start: date, end: date, holidays: frozenset = frozenset()) -> int:
    """Count business days from start to end, inclusive. Returns at least 1."""
    if end < start:
        return 1
    count, cur = 0, start
    while cur <= end:
        if cur.weekday() < 5 and cur not in holidays:
            count += 1
        cur += timedelta(days=1)
    return max(1, count)


def _signed_business_days(frm: date, to: date, holidays: frozenset = frozenset()) -> int:
    """Signed business-day displacement from `frm` to `to` — 0 when equal, negative when `to` is earlier.

    _business_days_between is an inclusive COUNT that clamps to 1 and cannot go below zero, so it cannot
    express "move back N days". Backward scheduling needs exactly that: a loco laid out from its finish
    normally overshoots the target and the base has to slide EARLIER. Expressed as a displacement
    (count − 1), so `_add_business_days(d, _signed_business_days(d, e))` round-trips to `e`.
    """
    if frm == to:
        return 0
    if to > frm:
        return _business_days_between(frm, to, holidays) - 1
    return -(_business_days_between(to, frm, holidays) - 1)


def _compute_end_info(
    start: date,
    start_second_half: bool,
    duration: float,
    holidays: frozenset = frozenset(),
) -> tuple[date, bool]:
    """Return (end_date, ends_at_first_half) for a task with the given duration.

    end_date is the last business day occupied.
    ends_at_first_half=True means the task's last slot is the first half of that day,
    so its successor may start in the second half of the same day.
    """
    half_slots = int(round(duration * 2))
    if half_slots <= 0:
        return start, True

    cur = start
    cur_half = 1 if start_second_half else 0  # 0=first half, 1=second half

    slots_consumed = 0
    while slots_consumed < half_slots:
        if cur.weekday() >= 5 or cur in holidays:
            cur += timedelta(days=1)
            cur_half = 0
            continue
        slots_consumed += 1
        if slots_consumed < half_slots:
            if cur_half == 0:
                cur_half = 1
            else:
                cur += timedelta(days=1)
                cur_half = 0
                while cur.weekday() >= 5 or cur in holidays:
                    cur += timedelta(days=1)

    return cur, (cur_half == 0)  # cur_half==0 → last slot was first half


def _business_days_range_fractional(
    start: date,
    start_second_half: bool,
    duration: float,
    holidays: frozenset = frozenset(),
) -> list[tuple[date, str | None]]:
    """Return list of (date, half) for each day slot occupied by the task.

    half is None for a full day, 'first' for AM only, 'second' for PM only.
    Consecutive 'first'+'second' on the same day are collapsed to None (full).
    """
    half_slots = int(round(duration * 2))
    if half_slots <= 0:
        return []

    day_slots: dict[date, set] = {}
    cur = start
    cur_half = 1 if start_second_half else 0

    slots_consumed = 0
    while slots_consumed < half_slots:
        if cur.weekday() >= 5 or cur in holidays:
            cur += timedelta(days=1)
            cur_half = 0
            continue

        label = 'first' if cur_half == 0 else 'second'
        if cur not in day_slots:
            day_slots[cur] = set()
        day_slots[cur].add(label)
        slots_consumed += 1

        if slots_consumed < half_slots:
            if cur_half == 0:
                cur_half = 1
            else:
                cur += timedelta(days=1)
                cur_half = 0
                while cur.weekday() >= 5 or cur in holidays:
                    cur += timedelta(days=1)

    result: list[tuple[date, str | None]] = []
    for d in sorted(day_slots):
        halves = day_slots[d]
        if 'first' in halves and 'second' in halves:
            result.append((d, None))
        elif 'first' in halves:
            result.append((d, 'first'))
        else:
            result.append((d, 'second'))
    return result


# Part numbers that use FINISH MS (from Schedule - MS) to determine their duration.
_PROTECTION_PN = {"PROTECTION DAYS", "PROTECAO", "PROTECTION"}


def _pd_whole_days(duracao) -> float:
    """Protection Days are always plotted in WHOLE business days — never a fractional box.

    When FINISH MS is present the duration comes from _business_days_between, which is already a
    whole count. When it is ABSENT (a Schedule row with no committed finish date) the row keeps
    whatever its routing DURACAO parsed to, and a fractional one — "0.5 Takt" on a takt-1 loco, a
    half-day literal — plotted a HALF Protection-Days box. A buffer is measured in whole days, so a
    fraction is rounded UP (never dropped: a partial day of protection is still protection) and the
    floor is one full day.
    """
    try:
        d = float(duracao)
    except (TypeError, ValueError):
        return 1.0
    if d <= 0:
        return 1.0
    # 1e-9 guard so a float-exact 2.0 does not become 3.0.
    return float(max(1, math.ceil(d - 1e-9)))

# Finish-only (backward) scheduling: how many times the solved start is corrected before giving up.
# One correction is exact whenever the layout is business-day-linear in the base, which is the normal
# case; a second absorbs a takt rounding that lands differently at the new anchor. The rest is headroom
# so a pathological routing terminates instead of looping.
_BACKWARD_SOLVE_ITERS = 6


def _semana_fw(d: date) -> str:
    """Fiscal week label (e.g. "FW09") for a date — delegates to the shared
    calendar engine. Kept as a wrapper so all existing call sites are unchanged.
    """
    return _semana_fw_label(d)


_RE_TAKT = re.compile(r'([+-])\s*(\d*(?:\.\d+)?)\s*Takt[s]?', re.IGNORECASE)
_RE_DIA  = re.compile(r'([+-])\s*(\d+(?:\.\d+)?)\s*Dia[s]?',  re.IGNORECASE)
# Detects item-reference mode: INICIO starts with a letter (workstation name)
_RE_ITEM_REF_START = re.compile(r'^[a-zA-Z\u00C0-\u024F]')

# ── DURAÇÃO parser ───────────────────────────────────────────────────────────
# Aceita:  "Takt"          → 1×takt
#          "2 Takt"        → 2×takt
#          "Takt + 1 dia"  → 1×takt + 1 dia útil
#          "2 Takt + 3 dias" → 2×takt + 3 dias úteis
#          "Takt - 1 dia"  → 1×takt − 1
#          "5"             → 5 dias
_RE_DURACAO_TAKT = re.compile(
    r'^(?:(\d+(?:[.,]\d+)?)\s*[*×x]?\s*)?takt(?:s)?(?:\s*([+-])\s*(\d+(?:[.,]\d+)?)\s*dia[s]?)?$',
    re.IGNORECASE,
)


@functools.lru_cache(maxsize=2048)
def _parse_duracao(dur_raw: str, takt: float) -> float:
    """Parse DURACAO cell: dias numéricos, Takt, N*Takt, Takt±N dias. Returns float (0.5 resolution).

    Minimum duration is 0.5 (half a takt/day). Values are snapped to the nearest
    0.5 increment so 0.5-takt operations are preserved (0.5, 1.0, 1.5, 2.0, …) and
    never floored to 1.0.
    """
    s = dur_raw.strip()
    m = _RE_DURACAO_TAKT.match(s)
    if m:
        n_takts    = _safe_float(m.group(1)) if m.group(1) else 1.0
        sign       = -1.0 if m.group(2) == '-' else 1.0
        extra_dias = _safe_float(m.group(3)) if m.group(3) else 0.0
        raw = n_takts * takt + sign * extra_dias
        # Round to nearest 0.5 increment, minimum 0.5
        return max(0.5, round(raw * 2) / 2)
    v = _safe_float(s)
    if v <= 0:
        return 0.5
    # Snap to nearest 0.5 increment, minimum 0.5 (no flooring of sub-1.0 values).
    return max(0.5, round(v * 2) / 2)


def _calcular_inicio(expr: str, base: date, takt: float, holidays: frozenset = frozenset()) -> date:
    offset = 0.0
    for m in _RE_TAKT.finditer(expr):
        sinal = 1.0 if m.group(1) == '+' else -1.0
        qtd   = float(m.group(2)) if m.group(2) else 1.0
        offset += sinal * qtd * takt
    for m in _RE_DIA.finditer(expr):
        sinal = 1.0 if m.group(1) == '+' else -1.0
        offset += sinal * float(m.group(2))
    # Truncate toward zero so fractional takt offsets don't overshoot by a day.
    # Half-day precision for INICIO is handled separately via item-reference chaining.
    return _add_business_days(base, math.trunc(offset), holidays)


def _is_item_ref(expr: str) -> bool:
    """True if the INICIO expression is an item-reference (starts with a letter)."""
    return bool(expr.strip() and _RE_ITEM_REF_START.match(expr.strip()))


def _split_item_ref(expr: str) -> tuple[str, str]:
    """Split 'WS1 [& WS2 ...] [+/- offset]' -> (ws_names_part, offset_expr).

    The ws_names_part may contain '&'-separated workstation names.
    Examples:
      'WORKSTATION A'                      -> ('WORKSTATION A', '')
      'WORKSTATION A + 2 Dias'            -> ('WORKSTATION A', '+ 2 Dias')
      'WS1 & WS2'                          -> ('WS1 & WS2', '')
      'WS1 & WS2 + 2 Dias'                -> ('WS1 & WS2', '+ 2 Dias')
      'WS1 & WS2 & WS3 - 1 dia'           -> ('WS1 & WS2 & WS3', '- 1 dia')
    """
    stripped = expr.strip()
    # Offset starts at the last [+-] that is followed by a Takt/Dia pattern
    m = re.match(r'^(.*?)\s*([+\-]\s*(?:\d+(?:\.\d+)?\s*)?(?:takt|dia)[s]?.*)$', stripped, re.IGNORECASE)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return stripped, ''


def _resolve_item_ref_deps(
    ws_names_part: str,
    ws_end_info: dict,
) -> tuple[date, bool] | None:
    """Resolve one or more '&'-joined dep names to (max_end_date, ends_at_first_half).

    Returns None if any required dependency is not yet in ws_end_info.
    When multiple deps are given, takes the latest end date among all.
    ends_at_first_half is True only when ALL resolved deps end at first half
    on the same (latest) date.
    """
    names = [n.strip().upper() for n in ws_names_part.split('&')]
    resolved: list[tuple[date, bool]] = []
    for name in names:
        info = ws_end_info.get(name)
        if info is None:
            return None
        resolved.append(info)
    max_end = max(r[0] for r in resolved)
    # ends_at_first_half is True only if every dep that reaches max_end does so at first half
    ends_first = all(r[1] for r in resolved if r[0] == max_end)
    return max_end, ends_first


def _norm(val: Any) -> str:
    return str(val).strip() if val is not None else ""


def _find_col_idx(hdr: list, name: str, required: bool = True) -> int:
    """Find column index using accent/case-insensitive matching (uses _strip_acc)."""
    key = _strip_acc(name)
    for i, h in enumerate(hdr):
        if _strip_acc(_norm(h)) == key:
            return i
    if required:
        raise ValueError(f"Coluna '{name}' não encontrada. Colunas disponíveis: {hdr}")
    return -1


def _find_col_idx_any(hdr: list, *names: str) -> int:
    """Try multiple candidate column names in order; return first match or -1."""
    for name in names:
        idx = _find_col_idx(hdr, name, required=False)
        if idx >= 0:
            return idx
    return -1


# Schedule-MS columns needed to build Gantt data, with PT/EN fallbacks. Start and
# Finish fall back to the Portuguese "Início"/"Término" headers (accent/case handled
# by _find_col_idx). Order per spec: primary name first — it is the one reported when
# the column is missing.
_SCENARIO_COL_SPECS: tuple = (
    ("wo", ("Standard WO",),                    True),
    ("tn", ("Task Name",),                       True),
    # Start MS is OPTIONAL: a row that supplies only Finish MS is scheduled BACKWARD from it (the start
    # is solved from the routing's own span). A sheet must still carry at least ONE of the two anchors,
    # which _resolve_scenario_columns checks below — neither column present means nothing can be dated.
    ("sm", ("Start MS", "Start", "Inicio"),      False),
    ("tk", ("Takt",),                            True),
    ("ln", ("Linha", "Line"),                    False),
    ("fn", ("Finish MS", "Finish", "Termino"),   False),
    # Contratual — optional, display-only (Build Plan). Its absence changes nothing.
    ("ct", ("Contratual", "Contractual", "Data Contratual"), False),
)


def _resolve_scenario_columns(ms_hdr: list) -> dict:
    """Resolve the Schedule-MS column indices (with PT/EN fallbacks for Start/Finish).

    On failure raises a ValueError listing ONLY the missing REQUIRED columns — it never
    dumps the sheet's available columns. Returns a dict of key → index (−1 when an
    optional column is absent)."""
    out: dict = {}
    missing: list = []
    for key, names, required in _SCENARIO_COL_SPECS:
        idx = _find_col_idx_any(ms_hdr, *names)
        out[key] = idx
        if idx < 0 and required:
            missing.append(names[0])
    if missing:
        raise ValueError(
            "Colunas obrigatórias não encontradas na aba Schedule: "
            + ", ".join("'{}'".format(m) for m in missing) + "."
        )
    # Start MS and Finish MS are individually optional, but not BOTH: with neither anchor no row on the
    # sheet can be dated, and the build would silently yield an empty Gantt. Fail loudly instead.
    if out.get("sm", -1) < 0 and out.get("fn", -1) < 0:
        raise ValueError(
            "A aba Schedule precisa de 'Start MS' ou 'Finish MS' (ao menos uma das duas)."
        )
    return out


def _parse_excel_date_raw(raw: Any) -> str:
    """Convert an openpyxl cell value to an ISO date string.

    Handles: datetime/date objects, Excel serial-number floats/ints, ISO-format strings.
    Returns '' when the value is empty or unparseable.
    """
    if raw is None:
        return ""
    # datetime or date object (openpyxl normally returns these for date-formatted cells)
    if hasattr(raw, "date") and callable(raw.date):
        try:
            return raw.date().isoformat()
        except Exception:
            return ""
    if isinstance(raw, date):
        return raw.isoformat()
    # Excel serial number (openpyxl in read_only mode sometimes skips date conversion)
    if isinstance(raw, (int, float)) and raw > 0:
        try:
            from openpyxl.utils.datetime import from_excel as _from_excel
            return _from_excel(raw).date().isoformat()
        except Exception:
            pass
    # Plain string — try to parse into ISO format; reject non-date strings
    s = str(raw).strip()
    if not s:
        return ""
    # Already ISO (YYYY-MM-DD)
    import re as _re
    if _re.match(r"^\d{4}-\d{2}-\d{2}", s):
        try:
            date.fromisoformat(s[:10])
            return s[:10]
        except Exception:
            pass
    # DD/MM/YYYY (Brazilian) or MM/DD/YYYY (US) — try both
    _parts = s.replace("-", "/").split("/")
    if len(_parts) == 3:
        a, b, c = _parts[0].strip(), _parts[1].strip(), _parts[2].strip()
        # Four-digit year in last position
        if len(c) == 4:
            for _fmt_d, _fmt_m in [(a, b), (b, a)]:
                try:
                    _d = date(int(c), int(_fmt_m), int(_fmt_d))
                    return _d.isoformat()
                except Exception:
                    pass
        # Four-digit year in first position (YYYY/MM/DD)
        if len(a) == 4:
            try:
                _d = date(int(a), int(b), int(c))
                return _d.isoformat()
            except Exception:
                pass
    return ""


def _safe_float(v: Any) -> float:
    try:
        return float(v)
    except (ValueError, TypeError):
        pass
    # Accept pt-BR decimal commas ("1,2" → 1.2, "0,7" → 0.7).
    try:
        s = str(v).strip()
        if "," in s and "." in s:
            # Both present → comma is a thousands separator ("1.234,5" → 1234.5).
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", ".")
        return float(s)
    except (ValueError, TypeError):
        return 0.0


def _safe_int(v: Any) -> int:
    try:    return int(float(v))
    except: return 0


def _strip_acc(s: str) -> str:
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode("ascii").upper().strip()


# ── Leitura dos dados ─────────────────────────────────────────────────────────

_HERE        = os.path.dirname(os.path.abspath(__file__))
EXCEL_FILE   = os.path.join(_HERE, "HorasB3.xlsx")
OUTPUT_FILE  = os.path.join(_HERE, "gantt_output.xlsx")
_SHEETS_MS   = ["Schedule - MS", "Special Line - MS", "Special Line - MS (2)"]
_SHEETS_ROUT = ["Locos - Rout", "Locos Rout", "Locos - Rout."]


def _row_json_takt(row_json: str | None):
    """Authoritative Takt lives in `row_json` — the value the DB viewer shows and the editor
    writes. The typed `takt` shortcut column can lag behind it: rows written while that column
    was still Integer kept a truncated 2.0 while row_json holds the real 2.5. Read Takt from
    row_json (0.5 decimals preserved) and fall back to the typed column only when it is
    absent/blank/unparseable. Returns a float or None."""
    if not row_json:
        return None
    try:
        d = json.loads(row_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    for k, v in d.items():
        if str(k).strip().lower() == "takt":
            if v is None or (isinstance(v, str) and not v.strip()):
                return None
            try:
                return _safe_float(v)
            except (ValueError, TypeError):
                return None
    return None


def _load_source_data() -> tuple[dict, list]:
    """Lê dados do banco (preferencial) ou Excel (fallback).
    Retorna (ms_by_wo, rt_rows)."""
    ms_by_wo: dict = defaultdict(list)
    rt_rows: list  = []

    # ── Tentar banco de dados primeiro ──
    _db_configured = False
    _db_error: str = ""
    try:
        import sys as _sys
        _sys.path.insert(0, _HERE)
        from database import get_db, engine as _engine
        from models import ScheduleRow as _SR, LocosRout as _LR, get_active_ver as _gav
        if _engine is not None:
            _db_configured = True
            with get_db() as _db:
                try:
                    _sr_ver  = _gav(_db, "schedule")
                    _sr_rows = _db.query(_SR).filter(_SR.ver == _sr_ver).all()
                except Exception as _sr_exc:
                    _sr_rows = []
                    _db_error = f"Erro ao ler schedule: {_sr_exc}"
                    try:
                        _db.rollback()
                    except Exception:
                        pass
                try:
                    _lr_ver  = _gav(_db, "locos_rout")
                    _lr_rows = _db.query(_LR).filter(_LR.ver == _lr_ver).all()
                except Exception as _lr_exc:
                    _lr_rows = []
                    _db_error = (_db_error + " " if _db_error else "") + f"Erro ao ler locos_rout: {_lr_exc}"
                    try:
                        _db.rollback()
                    except Exception:
                        pass
                sr_count = len(_sr_rows)
                lr_count = len(_lr_rows)
                if sr_count > 0:
                    _valid = 0
                    for _r in _sr_rows:
                        _sm = _r.start_ms
                        if _sm:
                            try:
                                _start: date | None = date.fromisoformat(str(_sm)[:10])
                            except Exception:
                                _start = None
                        else:
                            _start = None
                        wo_val = getattr(_r, 'wo', None) or ''
                        if not wo_val:
                            continue
                        # Prefer the row_json Takt (what the viewer shows / the editor writes) so a
                        # stale typed `takt` column can't downgrade a 2.5 to 2. Fall back to the typed
                        # column when row_json has no usable Takt.
                        _tk_json = _row_json_takt(getattr(_r, 'row_json', None))
                        _tk = _tk_json if _tk_json is not None else _r.takt
                        ms_by_wo[wo_val].append({
                            "task_name": _r.task_name or "",
                            "start_ms":  _start,
                            "takt":      _tk or 1,
                            "takt_raw":  _tk,
                            "linha":     _r.linha or "",
                            "finish_ms": _parse_excel_date_raw(_r.finish_ms or ""),
                            # Contratual — pass-through only. Nothing downstream schedules on it;
                            # it exists so the Build Plan can compare the real end against it.
                            "contract_ms": _parse_excel_date_raw(getattr(_r, "contract_ms", "") or ""),
                        })
                        _valid += 1
                    if _valid == 0:
                        import logging as _log
                        _log.getLogger(__name__).warning(
                            "[gantt_builder] DB schedule has %d rows but all have empty WO — "
                            "falling back to HorasB3.xlsx", sr_count)
                        ms_by_wo.clear()
                    elif lr_count > 0:
                        # PART DESC / ESCOPO / LINHA are Plano-de-Produção pass-through only —
                        # nothing in the scheduling maths reads them (see _build_records).
                        rt_rows = [["LOCOMOTIVA", "PART NUMBER", "WORKSTATION", "SUBAREA", "AREA",
                                     "HH UNIT", "QTD", "DURACAO", "INICIO", "DESCRIÇÃO", "WORKORDER",
                                     "PART DESC", "ESCOPO", "LINHA"]]
                        for _r in _lr_rows:
                            rt_rows.append([
                                getattr(_r, 'locomotiva',  '') or '',
                                getattr(_r, 'part_number', '') or '',
                                getattr(_r, 'workstation', '') or '',
                                getattr(_r, 'subarea',     '') or '',
                                getattr(_r, 'area',        '') or '',
                                getattr(_r, 'hh_unit',      0) or 0,
                                getattr(_r, 'qtd',          0) or 0,
                                getattr(_r, 'duracao',     '') or '',
                                getattr(_r, 'inicio',      '') or '',
                                getattr(_r, 'descricao',   '') or '',
                                getattr(_r, 'workorder',   '') or '',
                                getattr(_r, 'part_desc',   '') or '',
                                getattr(_r, 'escopo',      '') or '',
                                getattr(_r, 'linha',       '') or '',
                            ])
                        return ms_by_wo, rt_rows
                    else:
                        # schedule rows present but no routing — return empty Gantt (no fallback)
                        return ms_by_wo, []
                # DB returned 0 valid schedule rows — fall through to Excel fallback
                if not ms_by_wo:
                    import logging as _log
                    _msg = "schedule={}, locos_rout={}".format(sr_count, lr_count)
                    if _db_error:
                        _msg += ", erro: {}".format(_db_error)
                    _log.getLogger(__name__).warning(
                        "[gantt_builder] DB sem dados válidos para o Gantt (%s) — "
                        "ativando fallback HorasB3.xlsx", _msg)
    except Exception as _exc:
        import logging as _log
        _log.getLogger(__name__).warning(
            "[gantt_builder] Falha ao ler dados do banco (%s) — ativando fallback HorasB3.xlsx", _exc)
        _db_error = str(_exc)
        ms_by_wo.clear()

    # ── Fallback: HorasB3.xlsx ─────────────────────────────────────────────────
    # Reached when: DB not configured, DB query failed, or DB returned no valid rows.
    if not os.path.exists(EXCEL_FILE):
        if _db_error:
            raise RuntimeError(
                "Banco de dados indisponível ({}) e arquivo Excel não encontrado: {}. "
                "Importe os dados via POST /api/db/import/schedule e POST /api/db/import/locos-rout, "
                "ou adicione HorasB3.xlsx ao servidor.".format(_db_error, EXCEL_FILE)
            )
        raise FileNotFoundError("Arquivo Excel não encontrado: {}".format(EXCEL_FILE))
    import openpyxl as _opx
    wb = _opx.load_workbook(EXCEL_FILE, read_only=True, data_only=True)
    _available_sheets = list(wb.sheetnames)

    _sm_sheet = next((s for s in _SHEETS_MS   if s in _available_sheets), None)
    _rt_sheet = next((s for s in _SHEETS_ROUT if s in _available_sheets), None)

    if _sm_sheet is None or _rt_sheet is None:
        _missing = []
        if _sm_sheet is None:
            _missing.append(f"schedule ({'/'.join(_SHEETS_MS)})")
        if _rt_sheet is None:
            _missing.append(f"locos-rout ({'/'.join(_SHEETS_ROUT)})")
        wb.close()
        raise FileNotFoundError(
            f"O arquivo {EXCEL_FILE} não contém as abas de Gantt: {', '.join(_missing)}. "
            f"Abas presentes: {_available_sheets}. "
            "Importe os dados do Schedule via /api/db/import/schedule e /api/db/import/locos-rout."
        )

    ws_ms   = wb[_sm_sheet]
    ms_rows = list(ws_ms.iter_rows(values_only=True))
    ms_hdr  = [_norm(c) for c in ms_rows[0]]
    i_wo = _find_col_idx(ms_hdr, "Standard WO")
    i_tn = _find_col_idx(ms_hdr, "Task Name")
    i_sm = _find_col_idx_any(ms_hdr, "Start MS", "Start")
    i_tk = _find_col_idx(ms_hdr, "Takt")
    i_ln = _find_col_idx_any(ms_hdr, "Linha", "Line")
    i_fn = _find_col_idx_any(ms_hdr, "Finish MS", "Finish")
    i_ct = _find_col_idx_any(ms_hdr, "Contratual", "Contractual", "Data Contratual")
    for row in ms_rows[1:]:
        wo = _norm(row[i_wo])
        if not wo:
            continue
        # Start MS is optional (Finish-only rows schedule backward) — a missing column or a
        # short row yields no start, which the builder reads as "solve it from Finish MS".
        raw = row[i_sm] if i_sm >= 0 and len(row) > i_sm else None
        _sm_str = _parse_excel_date_raw(raw)
        start_dt: date | None = None
        if _sm_str:
            try:
                start_dt = date.fromisoformat(_sm_str[:10])
            except Exception:
                pass
        fn_str = _parse_excel_date_raw(row[i_fn] if i_fn >= 0 and len(row) > i_fn else None)
        _tk_val = _safe_float(row[i_tk])
        ms_by_wo[wo].append({
            "task_name": _norm(row[i_tn]),
            "start_ms":  start_dt,
            "takt":      _tk_val or 1.0,
            "takt_raw":  _tk_val,
            "linha":     _norm(row[i_ln]) if i_ln >= 0 and len(row) > i_ln and row[i_ln] is not None else "",
            "finish_ms": fn_str,
            "contract_ms": _parse_excel_date_raw(row[i_ct] if i_ct >= 0 and len(row) > i_ct else None),
        })

    ws_rt  = wb[_rt_sheet]
    rt_rows = list(ws_rt.iter_rows(values_only=True))
    wb.close()
    return ms_by_wo, rt_rows


# ── Locomotive model fallback ──────────────────────────────────────────────────────
# When a scheduled model is a NEW VARIANT of a real locomotive family but has no routing of
# its own (e.g. "ES44 BANANA" with no rows), it borrows the routing of an existing model that
# shares its family PREFIX (e.g. "ES44 BRADO"). This keeps hours/kits/protections/inventory/
# optimization consistent for genuine model variants.
#
# Fallback is DELIBERATELY narrow — it fires ONLY when ALL of these hold:
#   (1) the value's prefix is a RECOGNIZED locomotive-model family (model-code shaped, e.g.
#       ES44 / ES58 / AC44, or a known family like BBWi);
#   (2) the exact model has no routing of its own;
#   (3) a compatible model with the SAME recognized prefix DOES have routing; and
#   (4) that model is scheduled under the SAME Type (Tipo Geral) as the record asking for it.
# Anything else — blank/null, or arbitrary text / setup records / operational labels with no
# model-shaped prefix (BANANA, SETUP, TEST, "2027", "Setup - Aumento de Takt", …) — is left
# UNRESOLVED and never inherits another model's parameters. (The previous global-env and
# "any available" last-resort fallbacks are gone: they let unrelated text borrow real hours.)
#
# (4) exists because a shared prefix does NOT imply a shared Type: the same family can be
# scheduled as Propulsion and as New Locos, and borrowing across that boundary gives a
# Propulsion record a New Locos routing — wrong hours, kits and protections. A candidate
# whose Type cannot be established (routed but never scheduled) is rejected for the same
# reason: same-Type must be proven, not assumed. With no eligible same-Type model the
# record stays unresolved, exactly as if no candidate existed at all.
#
# All of the matching above is CASE/ACCENT-INSENSITIVE: every model name is reduced to a
# canonical _model_key (trimmed, accent-stripped, uppercased) before any lookup, so
# 'BBI43' / 'Bbi43' / 'bbi43' are one model everywhere (own-routing, prefix index and the
# same-Type index alike) and a valid match can never fail on capitalization differences.

# Type ("Tipo Geral") of a scheduled LOCO, derived from its Schedule "Linha" — the same
# grouping the UI shows. The table itself now lives in `services/tipos.py`, the single backend
# registry, which mirrors `frontend/src/lib/tipos.ts`; the local table this used to hold was a
# third copy of the same five rows. An absent/unknown Linha collapses to "other", which matches
# itself — so a Schedule with no Linha column keeps its fallbacks working.
#
# The accent strip stays HERE, not in the registry: `_strip_acc`/`_norm` are this module's
# spreadsheet-cleaning helpers, and the registry is kept dependency-free so it can be imported
# from anywhere in the backend. It is applied first, exactly as before, so this function's
# answers are unchanged for every input — including the accented near-misses ("Propulsão"),
# which resolved to "other" before this refactor and still do.
def _tipo_geral(linha: str) -> str:
    return tipos.tipo_geral(_strip_acc(_norm(linha)))


# A recognized model-family prefix is model-code shaped: one or more letters immediately
# followed by digits (ES44, ES58, AC44, AC45, SD70, …). Pure text (BANANA/SETUP/TEST) and
# pure numbers ("2027") have no such shape. A short allowlist covers known families that do
# not follow the letter+digit shape (e.g. BBWi).
_MODEL_PREFIX_RE = re.compile(r"^[A-Z]{1,4}\d{2,4}")
_KNOWN_MODEL_FAMILIES = {"BBWI"}


def _model_key(model: Any) -> str:
    """Canonical model-matching key: trimmed, accent-stripped, UPPERCASED.

    ALL model matching (own-routing lookup, prefix index, same-Type index and the
    fallback resolution built on them) goes through this key, so 'BBI43', 'Bbi43'
    and 'bbi43' are the same model — a valid match must never fail on casing."""
    return _strip_acc(_norm(model))


def _model_prefix(model: str) -> str:
    s = _norm(model).strip()
    return s.split()[0].upper() if s else ""


def _is_recognized_model_prefix(pfx: str) -> bool:
    """True only for a model-code-shaped family prefix; rejects blank/arbitrary/label text."""
    return bool(pfx) and (bool(_MODEL_PREFIX_RE.match(pfx)) or pfx in _KNOWN_MODEL_FAMILIES)


def _resolve_fallback_model(
    wo: str, tipo: str, rout_by_wo: dict, prefix_index: dict, types_by_wo: dict,
) -> tuple[str | None, list[str]]:
    """Return (fallback routing key for `wo` under Type `tipo`, models rejected as cross-Type).

    `wo` and every key in `rout_by_wo` / `prefix_index` / `types_by_wo` are canonical
    _model_key values (case/accent-insensitive), so casing differences between the
    Schedule and the routing can never break a match.

    The first element is None when `wo` already has its own routing, when its prefix is not a
    recognized model family, or when no same-prefix routed model of the SAME Type exists — the
    model then stays unresolved rather than inheriting unrelated parameters.

    The second element lists same-prefix routed models that were passed over ONLY because their
    Type differs (or is unknown). It is reported by the caller so a blocked cross-Type borrow is
    visible in the logs instead of silently becoming a no-match."""
    if rout_by_wo.get(wo):
        return None, []  # has its own routing → no fallback needed
    # STRUCTURAL GATE. Borrowing another model's routing is only meaningful for a Tipo that is
    # laid out on the Schedule at all — routing IS the station sequence and the takt this
    # builder lays out. A Tipo whose hours come from another source has no routing to borrow
    # and nothing to borrow it for, so it is refused by the FLAG rather than by never happening
    # to appear in `types_by_wo`.
    #
    # `is_registered` AND not backed, NOT simply "not backed": "other" is not a registered Tipo
    # and it MUST keep falling back. A Schedule with no Linha column classifies every LOCO as
    # "other", and "other" matching itself is the only thing keeping those fallbacks alive —
    # gating on the flag alone would disable model resolution for that whole Schedule.
    if tipos.is_registered(tipo) and not tipos.is_schedule_backed(tipo):
        return None, []
    pfx = _model_prefix(wo)
    if not _is_recognized_model_prefix(pfx):
        return None, []  # blank / arbitrary text / non-model label → never inherit parameters
    # Same-prefix models that actually have routing — the only candidates worth considering.
    candidates = sorted(k for k in prefix_index.get(pfx, []) if k != wo and rout_by_wo.get(k))
    same_type = [k for k in candidates if tipo in types_by_wo.get(k, ())]
    if same_type:
        return same_type[0], []
    return None, candidates


def _build_records(ms_by_wo: dict, rt_rows: list) -> list[dict]:
    """Constrói gantt_records a partir das fontes."""
    if not rt_rows:
        return []
    rt_hdr = [_norm(c) for c in rt_rows[0]]

    def _idx(name: str) -> int:
        key = _strip_acc(name)
        for i, h in enumerate(rt_hdr):
            if _strip_acc(h) == key:
                return i
        raise ValueError(f"Coluna '{name}' não encontrada. Header: {rt_hdr}")

    def _idx_opt(name: str) -> int:
        """Like _idx but returns -1 if column not present."""
        key = _strip_acc(name)
        for i, h in enumerate(rt_hdr):
            if _strip_acc(h) == key:
                return i
        return -1

    r_loco = _idx("LOCOMOTIVA")
    r_ws   = _idx("WORKSTATION")
    r_hh   = _idx("HH UNIT")
    r_qtd  = _idx("QTD")
    r_dur  = _idx("DURACAO")
    r_ini  = _idx("INICIO")
    r_desc = _idx_opt("DESCRIÇÃO")
    r_sa   = _idx_opt("SUBAREA")   # fallback if DESCRIÇÃO not present
    r_area = _idx_opt("AREA")
    r_pn   = _idx_opt("PART NUMBER")
    r_wo_order = _idx_opt("WORKORDER")
    # Plano de Produção pass-through columns. Read here only so they can ride along on the
    # record and reach the desc-row payload — no scheduling decision consults them, and an
    # absent column (-1) simply yields "" everywhere, which the UI renders as an empty cell.
    r_part_desc = _idx_opt("PART DESC")
    r_escopo    = _idx_opt("ESCOPO")
    r_rlinha    = _idx_opt("LINHA")

    records: list[dict] = []
    # ── Build holiday set for all years present in ms_by_wo so that
    #    business-day calculations correctly skip public holidays.
    _all_starts: list[date] = [
        t["start_ms"] for tasks in ms_by_wo.values() for t in tasks if t.get("start_ms")
    ]
    _hl_years: set = {d.year for d in _all_starts} | {d.year + 1 for d in _all_starts}
    holidays: frozenset = frozenset(_build_br_holidays(_hl_years)) if _hl_years else frozenset()

    # Pre-group routing rows by WO to avoid O(WOs × R) scan inside the loop.
    # Each WO lookup is now O(1) instead of scanning the full rt_rows list.
    # Keys are canonical _model_key values, so 'BBI43' / 'Bbi43' / 'bbi43' land in the
    # same routing group and Schedule↔routing matching never fails on casing alone.
    # rout_display keeps the first original spelling per key for logs and the UI field.
    _t0 = time.perf_counter()
    rout_by_wo: dict[str, list] = defaultdict(list)
    rout_display: dict[str, str] = {}
    for _row in rt_rows[1:]:
        _mk = _model_key(_row[r_loco])
        rout_by_wo[_mk].append(_row)
        rout_display.setdefault(_mk, _norm(_row[r_loco]))

    # Index routing models by prefix so an unknown model can borrow a same-prefix routing.
    prefix_index: dict[str, list[str]] = defaultdict(list)
    for _k in list(rout_by_wo.keys()):
        prefix_index[_model_prefix(_k)].append(_k)

    # Every Type each model is scheduled under (from the Schedule's Linha) — the index the
    # same-Type fallback rule consults to decide whether a candidate is eligible. Keyed by
    # the same canonical _model_key, so a routed candidate's Type is found even when the
    # Schedule spells the model with different casing.
    types_by_wo: dict[str, set[str]] = defaultdict(set)
    for _wo, _tasks in ms_by_wo.items():
        for _t in _tasks:
            types_by_wo[_model_key(_wo)].add(_tipo_geral(_t.get("linha", "")))

    backward_locos: list[str] = []        # scheduled BACKWARD from Finish MS (no Start MS on the row)
    backward_unconverged: list[str] = []  # backward solve did not settle → left unscheduled
    fallback_log: dict[str, str] = {}   # original wo → fallback model actually used
    unresolved_models: list[str] = []   # no routing AND no eligible same-Type fallback
    cross_type_blocked: dict[str, tuple[str, list[str]]] = {}   # wo → (tipo, rejected models)

    for wo, tasks in ms_by_wo.items():
        # Canonical (case/accent-insensitive) key — every routing/fallback lookup uses it.
        wo_key = _model_key(wo)
        own_rout = rout_by_wo.get(wo_key) or []
        # Fallback is resolved per TYPE, not per model: the same model can be scheduled under
        # more than one Linha, and each of those records must borrow within its own Type.
        fb_cache: dict[str, str | None] = {}
        for task in tasks:
            takt      = task["takt"]
            base      = task["start_ms"]
            task_name = task["task_name"]
            linha     = task.get("linha", "")

            # ── Scheduling DIRECTION for this loco (decided per ROW, not per sheet) ──────────────
            # A sheet may mix all three cases, so each Schedule row picks its own mode:
            #   Start present            → FORWARD from Start (unchanged; Finish, if any, only sizes
            #                              the Protection-Days buffer as it always has)
            #   Start absent, Finish set → BACKWARD: solve the start from the routing's own span
            #   neither                  → unschedulable; skipped exactly as before
            # Before this, a Start-less row reached `_calcular_inicio(..., base=None)` and every one of
            # its rows was dropped, so the loco silently vanished from the Gantt.
            _bk_finish: date | None = None
            _backward = False
            # A Protection-Days row is sized by _business_days_between(start, FINISH MS) — it exists to
            # absorb slack BEFORE a committed finish. Under backward scheduling the finish IS the anchor
            # and the start is derived from the routing span, so a buffer would be self-referential: it
            # would consume the very date it is measured against and push the solved start earlier by its
            # own width, every iteration. Requirement is explicit — no Protection Days in Finish-only mode.
            def _is_protection_row(row) -> bool:
                if r_pn < 0:
                    return False
                return _strip_acc(_norm(row[r_pn])) in _PROTECTION_PN
            if base is None:
                _fms_raw = task.get("finish_ms", "")
                if _fms_raw:
                    try:
                        _bk_finish = date.fromisoformat(str(_fms_raw)[:10])
                        # A finish falling on a weekend or holiday is read as a DEADLINE, so it clamps
                        # BACKWARD to the previous business day. Without this the solver converged on the
                        # next business day instead (nothing can end on a Saturday, and the signed
                        # displacement from Monday back to Saturday is 0), overshooting the date the
                        # planner asked for by a day.
                        while _bk_finish.weekday() >= 5 or _bk_finish in holidays:
                            _bk_finish -= timedelta(days=1)
                        _backward = True
                    except Exception:
                        _bk_finish = None
            if base is None and not _backward:
                continue      # neither anchor → nothing to schedule (previously fell through to no rows)

            rout = own_rout
            fallback_model: str | None = None
            if not rout:
                tipo = _tipo_geral(linha)
                if tipo not in fb_cache:
                    fb, blocked = _resolve_fallback_model(wo_key, tipo, rout_by_wo, prefix_index, types_by_wo)
                    fb_cache[tipo] = fb
                    if fb is None and blocked:
                        cross_type_blocked[wo] = (tipo, [rout_display.get(b, b) for b in blocked])
                fb = fb_cache[tipo]
                if fb:
                    rout = rout_by_wo[fb]
                    fallback_model = rout_display.get(fb, fb)
                    fallback_log[wo] = fallback_model
                else:
                    # Left unresolved: blank/arbitrary text, a recognized prefix with no
                    # same-prefix routed model, or candidates that exist but are another
                    # Type. It keeps no borrowed hours (reported below).
                    unresolved_models.append(wo)

            # ── Finish-only (BACKWARD) scheduling ────────────────────────────────────────────
            # The entire loco layout is a pure business-day function of `base`: every routing row
            # resolves its start through _calcular_inicio(ini, base, …) or through an item-ref chain
            # anchored on those. So a loco that supplies only a FINISH date is scheduled by INVERTING
            # that function — lay the loco out from a provisional base, measure where it actually ends,
            # and slide the base by the difference.
            #
            # Passes 1/1b are wrapped here (unchanged) so the solver can evaluate a candidate base
            # without duplicating any of this subtle precedence logic. They only ever WRITE to their
            # own local ws_end_info, so re-running them is free of side effects.
            def _compute_ws_end_info(base):
                # ── Pass 1: build ws_end_info for rows with standard (numeric) INICIO.
                # Key: ws_name.upper() → (end_date, ends_at_first_half).
                # ends_at_first_half=True means a successor can start in the second half
                # of that same end_date rather than the next business day.
                ws_end_info: dict[str, tuple[date, bool]] = {}
                for row in rout:
                    if _backward and _is_protection_row(row):
                        continue      # Finish-only mode plots no Protection Days
                    ini_str = _norm(row[r_ini])
                    if _is_item_ref(ini_str):
                        continue  # skip item-reference rows in first pass
                    dur_raw = _norm(row[r_dur])
                    duracao = _parse_duracao(dur_raw, takt)
                    data_calc = _calcular_inicio(ini_str, base, takt, holidays) if base else None
                    if not data_calc:
                        continue
                    # ── Protection Days: use finish_ms as real end date ──────────
                    if r_pn >= 0:
                        _pn_norm = _strip_acc(_norm(row[r_pn]))
                        if _pn_norm in _PROTECTION_PN:
                            _fms_str = task.get("finish_ms", "")
                            if _fms_str:
                                try:
                                    _finish_date = date.fromisoformat(str(_fms_str)[:10])
                                    duracao = _business_days_between(data_calc, _finish_date, holidays)
                                except Exception:
                                    pass
                            # Whole days either way — a no-finish (or unparseable) row must not leave a
                            # fractional buffer behind. See _pd_whole_days.
                            duracao = _pd_whole_days(duracao)
                    ws_key = _norm(row[r_ws]).upper()
                    end_date, ends_at_first_half = _compute_end_info(data_calc, False, duracao, holidays)
                    curr = ws_end_info.get(ws_key)
                    if (curr is None
                            or end_date > curr[0]
                            or (end_date == curr[0] and not ends_at_first_half and curr[1])):
                        ws_end_info[ws_key] = (end_date, ends_at_first_half)

                # ── Pass 1b: iteratively resolve item-ref chains in ws_end_info. - corrigido
                # Handles multi-level precedence: A→0, B refs A, C refs B, etc.
                # Each pass resolves one more level; repeat until stable (max 20 levels).
                for _ in range(20):
                    _changed = False

                    for row in rout:
                        ini_str = _norm(row[r_ini])

                        if not _is_item_ref(ini_str):
                            continue

                        ref_names_part, offset_expr = _split_item_ref(ini_str)
                        ref_info = _resolve_item_ref_deps(ref_names_part, ws_end_info)

                        if ref_info is None:
                            continue

                        ref_end, ref_ends_at_first_half = ref_info

                        # Finish-only mode plots no Protection Days — but the buffer is a LINK in the
                        # precedence chain: the workstations after it reference it BY NAME. Dropping it
                        # outright orphaned them (their INICIO resolved to nothing, so they vanished from
                        # the loco entirely). Register it TRANSPARENT instead: its end IS its
                        # predecessor's end, so the chain still resolves and the successor starts exactly
                        # as if the buffer had never been there.
                        if _backward and _is_protection_row(row):
                            _pd_key = _norm(row[r_ws]).upper()
                            if ws_end_info.get(_pd_key) != (ref_end, ref_ends_at_first_half):
                                ws_end_info[_pd_key] = (ref_end, ref_ends_at_first_half)
                                _changed = True
                            continue

                        dur_raw = _norm(row[r_dur])
                        duracao = _parse_duracao(dur_raw, takt)

                        if offset_expr:
                            data_calc = _calcular_inicio(offset_expr, ref_end, takt, holidays)

                            # Half-day precision for "+N day/takt" item references.
                            # When the predecessor ends at the FIRST half of its last day it frees
                            # that day's afternoon, so the legacy whole-day "+1 day = next day"
                            # convention overshoots the successor by one half-slot. Anchor the offset
                            # on the true (mid-day) finish by pulling the start back to the afternoon
                            # of the prior business day: "+1 day" then lands back-to-back (same-day PM,
                            # identical to the no-offset case), "+2 days" adds exactly one full day
                            # beyond that, etc. Integer-takt predecessors never end at first half, so
                            # they are unaffected and keep their existing whole-day behaviour.
                            if ref_ends_at_first_half and data_calc > ref_end:
                                data_calc = _add_business_days(data_calc, -1, holidays)
                                _start_second_half = True
                            # Zero-net-displacement offset, e.g. "+ 0 Dias", on a predecessor that
                            # ends at the first half must still yield a midday start — otherwise the
                            # successor would overlap the predecessor's last half-day slot.
                            elif data_calc == ref_end and ref_ends_at_first_half:
                                _start_second_half = True
                            else:
                                _start_second_half = False

                        elif ref_ends_at_first_half:
                            # Predecessor ends mid-day → successor starts second half same day.
                            data_calc = ref_end
                            _start_second_half = True

                        else:
                            # Predecessor occupies the full ending day → successor starts next business day.
                            data_calc = _add_business_days(ref_end, 1, holidays)
                            _start_second_half = False

                        # ── Protection Days: use FINISH MS as the real end date also while
                        # building ws_end_info for item-reference chains.
                        #
                        # This is the important fix:
                        # without this block, any workstation after Protection Days receives the
                        # end date calculated from DURACAO only, often start + 1 day, instead of
                        # the real FINISH MS date.
                        if r_pn >= 0:
                            _pn_norm = _strip_acc(_norm(row[r_pn]))

                            if _pn_norm in _PROTECTION_PN:
                                _fms_str = task.get("finish_ms", "")

                                if _fms_str:
                                    try:
                                        _finish_date = date.fromisoformat(str(_fms_str)[:10])

                                        # Override duration so Protection Days spans from its calculated
                                        # start until FINISH MS, using business days.
                                        duracao = float(
                                            _business_days_between(data_calc, _finish_date, holidays)
                                        )

                                        # Protection Days should be treated as full-day based.
                                        _start_second_half = False

                                    except Exception:
                                        pass

                                # Applies with or without a FINISH MS: a Protection-Days row is a
                                # whole-day buffer that starts on a day boundary, never a half box.
                                duracao = _pd_whole_days(duracao)
                                _start_second_half = False

                        ws_key = _norm(row[r_ws]).upper()

                        end_date, ends_at_first_half = _compute_end_info(
                            data_calc,
                            _start_second_half,
                            duracao,
                            holidays,
                        )

                        curr = ws_end_info.get(ws_key)

                        if (
                            curr is None
                            or end_date > curr[0]
                            or (end_date == curr[0] and not ends_at_first_half and curr[1])
                        ):
                            ws_end_info[ws_key] = (end_date, ends_at_first_half)
                            _changed = True

                    if not _changed:
                        break

                return ws_end_info

            # Solve `base` for a FINISH-ONLY loco, then lay it out normally from there.
            #
            # Business-day arithmetic is linear in business-day space (_add_business_days already absorbs
            # weekends and holidays), so sliding the base by K business days slides the whole layout by K
            # and ONE correction is normally exact. It is not guaranteed: a takt-driven duration can round
            # differently at a different anchor. So the correction is iterated to a fixed point and the
            # result is verified below — a few cheap dry runs, no records built.
            if _backward:
                base = _bk_finish                      # provisional anchor: lay out from the finish
                for _ in range(_BACKWARD_SOLVE_ITERS):
                    _probe = _compute_ws_end_info(base)
                    if not _probe:
                        break                          # no routing row resolved → nothing to solve
                    _max_end = max(v[0] for v in _probe.values())
                    # Signed displacement from where the loco ACTUALLY ends to where it MUST end.
                    # Negative when it currently overshoots the target, so the base slides EARLIER.
                    _delta = _signed_business_days(_max_end, _bk_finish, holidays)
                    if _delta == 0:
                        break
                    base = _add_business_days(base, _delta, holidays)
                else:
                    # Did not converge — leave the loco unscheduled rather than emit dates that silently
                    # miss the requested finish. Reported alongside the other diagnostics.
                    backward_unconverged.append(f"{wo} / {task_name}")
                    continue
                backward_locos.append(f"{wo} / {task_name}")

            ws_end_info = _compute_ws_end_info(base)

            # ── Pass 2: process all rows, resolving item references where needed.
            for _src_uid, row in enumerate(rout):
                if _backward and _is_protection_row(row):
                    continue          # Finish-only mode plots no Protection Days (see _is_protection_row)
                dur_raw = _norm(row[r_dur])
                duracao = _parse_duracao(dur_raw, takt)
                ini_str = _norm(row[r_ini])
                start_second_half = False

                if _is_item_ref(ini_str):
                    ref_names_part, offset_expr = _split_item_ref(ini_str)
                    ref_info = _resolve_item_ref_deps(ref_names_part, ws_end_info)
                    if ref_info is None:
                        continue  # one or more referenced WSs not found in first pass
                    ref_end, ref_ends_at_first_half = ref_info
                    if offset_expr:
                        data_calc = _calcular_inicio(offset_expr, ref_end, takt, holidays)
                        # Half-day precision for "+N day/takt" item references — see Pass 1b.
                        # A predecessor ending mid-day frees its afternoon, so a "+N day" offset
                        # overshoots by one half-slot; pull the start back to the afternoon of the
                        # prior business day so "+1 day" lands back-to-back (same-day PM). Integer
                        # takt never ends at first half, so its whole-day behaviour is unchanged.
                        if ref_ends_at_first_half and data_calc > ref_end:
                            data_calc = _add_business_days(data_calc, -1, holidays)
                            start_second_half = True
                        # Zero-net-displacement offset on a predecessor ending at first half
                        # must propagate the midday start to avoid overlapping that half-slot.
                        elif data_calc == ref_end and ref_ends_at_first_half:
                            start_second_half = True
                        else:
                            start_second_half = False
                    elif ref_ends_at_first_half:
                        data_calc = ref_end
                        start_second_half = True
                    else:
                        data_calc = _add_business_days(ref_end, 1, holidays)
                        start_second_half = False
                else:
                    data_calc = _calcular_inicio(ini_str, base, takt, holidays) if base else None

                if not data_calc:
                    continue

                # ── Protection Days: override DURACAO to span from start to FINISH MS ──
                if r_pn >= 0:
                    _pn_norm = _strip_acc(_norm(row[r_pn]))
                    if _pn_norm in _PROTECTION_PN:
                        _fms_str = task.get("finish_ms", "")
                        if _fms_str:
                            try:
                                _finish_date = date.fromisoformat(str(_fms_str)[:10])
                                duracao = float(_business_days_between(data_calc, _finish_date, holidays))
                            except Exception:
                                pass
                        # With or without a FINISH MS: whole days, starting on a day boundary. A
                        # finish-less row used to keep its routing DURACAO and could plot a HALF
                        # Protection-Days box. See _pd_whole_days.
                        duracao = _pd_whole_days(duracao)
                        start_second_half = False

                hh_unit  = _safe_float(row[r_hh])
                qtde     = _safe_int(row[r_qtd])
                hh_total = hh_unit * qtde
                hh_dia   = hh_total / duracao if duracao > 0 else 0.0
                ws_name  = _norm(row[r_ws])
                # Prefer DESCRIÇÃO; fall back to SUBAREA for old Excel sheets
                if r_desc >= 0:
                    desc_name = _norm(row[r_desc])
                elif r_sa >= 0:
                    desc_name = _norm(row[r_sa])
                else:
                    desc_name = ""
                sa_name   = _norm(row[r_sa])   if r_sa   >= 0 else ""
                area_name = _norm(row[r_area]) if r_area >= 0 else ""
                pn_name   = _norm(row[r_pn])   if r_pn   >= 0 else ""
                wo_order_name = _norm(row[r_wo_order]) if r_wo_order >= 0 else ""
                part_desc_name = _norm(row[r_part_desc]) if r_part_desc >= 0 else ""
                escopo_name    = _norm(row[r_escopo])    if r_escopo    >= 0 else ""
                rout_linha_name = _norm(row[r_rlinha])   if r_rlinha    >= 0 else ""
                # Remap line-type areas to the LINHA field for this LOCO so that
                # e.g. a "Special Line" area entry whose LOCO is on Main Line is
                # shown under "Main Line" in the Gantt.
                _LINE_AREAS = {"special line", "main line", "main line/special line"}
                if area_name.lower().strip() in _LINE_AREAS and linha:
                    area_name = linha
                for d, half in _business_days_range_fractional(data_calc, start_second_half, duracao, holidays):
                    # Half-day slots contribute half the daily hour rate
                    hh_factor = 0.5 if half is not None else 1.0
                    records.append({
                        "wo":        wo,
                        "task_name": task_name,
                        "linha":     linha,
                        "day":       d,
                        "ws":        ws_name,
                        "desc":      desc_name,
                        "sa":        sa_name,
                        "area":      area_name,
                        "pn":        pn_name,
                        "qtd":       qtde,
                        # Identifies the SOURCE rout row this record came from. Several rout
                        # rows can share one desc-row identity (LOCO+WS+DESCRIÇÃO+PN) while
                        # each carries its own QTD, and one rout row fans out into one record
                        # per production day. Without this, the assembler cannot tell "the same
                        # row on 5 days" from "5 rows on one day", so it cannot sum QTD without
                        # multiplying it by the duration. See _assemble_gantt_output.
                        "src_uid":   _src_uid,
                        # Original per-unit hours, carried through untouched. Must NOT be
                        # re-derived downstream from the daily hours: those get sliced by date
                        # range/FW, which would turn HH UNIT into "hours in this window".
                        "hh_unit":   hh_unit,
                        "workorder": wo_order_name,
                        # Plano de Produção pass-through (DESCRIÇÃO / ESCOPO / LINHA columns).
                        # Note `rout_linha` is deliberately NOT "linha": that key already carries
                        # the SCHEDULE's Linha for this loco and drives area remapping above.
                        "part_desc":  part_desc_name,
                        "escopo":     escopo_name,
                        "rout_linha": rout_linha_name,
                        "hh_dia":    hh_dia * hh_factor,
                        "half":      half,
                        "fallback_model": fallback_model,
                    })
    # Fallback visibility — never let an unmapped model fail silently.
    if fallback_log:
        for _wo, _fb in sorted(fallback_log.items()):
            print(f"[gantt_builder][FALLBACK] Modelo '{_wo}' sem roteiro — usando fallback de prefixo '{_fb}' "
                  f"(mesmo Type; HH/kits/proteções/otimização resolvidos a partir de '{_fb}').")
        print(f"[gantt_builder][FALLBACK] {len(fallback_log)} modelo(s) resolvido(s) via fallback de mesmo prefixo e mesmo Type.")
    # Report candidates rejected purely because they belong to another Type — the borrow the
    # same-Type rule exists to prevent (e.g. Propulsion → New Locos). Logged so a resulting
    # no-match is traceable to this rule and not mistaken for missing data.
    if cross_type_blocked:
        for _wo, (_tipo, _blocked) in sorted(cross_type_blocked.items()):
            print(f"[gantt_builder][FALLBACK-TYPE] Modelo '{_wo}' (Type '{_tipo}') sem roteiro — "
                  f"candidato(s) de mesmo prefixo {sorted(_blocked)} pertencem a outro Type "
                  f"e NÃO foram usados. Mantido sem resolução.")
        print(f"[gantt_builder][FALLBACK-TYPE] {len(cross_type_blocked)} modelo(s) sem fallback por incompatibilidade de Type.")
    # Report (never silently borrow for) values left unresolved: blank/arbitrary text, a
    # recognized prefix with no same-prefix routed model, or only cross-Type candidates.
    # These keep no borrowed parameters.
    if unresolved_models:
        for _wo in sorted(set(unresolved_models)):
            print(f"[gantt_builder][SEM-FALLBACK] Modelo '{_wo}' sem roteiro e sem prefixo de família "
                  f"reconhecido/compatível do mesmo Type — mantido sem resolução (não herda parâmetros).")
        print(f"[gantt_builder][SEM-FALLBACK] {len(set(unresolved_models))} valor(es) sem roteiro mantido(s) sem fallback.")
    # Finish-only rows: scheduled BACKWARD from Finish MS (start solved from the routing span, no
    # Protection Days). Reported so a mixed sheet makes it obvious which locos were dated that way.
    if backward_locos:
        print(f"[gantt_builder][FINISH-ONLY] {len(backward_locos)} loco(s) agendado(s) de trás para frente "
              f"a partir do Finish MS (sem Protection Days): {', '.join(sorted(backward_locos)[:20])}"
              + (" …" if len(backward_locos) > 20 else ""))
    if backward_unconverged:
        for _bl in sorted(set(backward_unconverged)):
            print(f"[gantt_builder][FINISH-ONLY][ERRO] '{_bl}' — não foi possível resolver a data de início "
                  f"a partir do Finish MS; loco mantido fora do cronograma.")
    _t1 = time.perf_counter()
    print(f"[gantt_perf] _build_records: {len(records):,} records, {len(ms_by_wo)} WOs, {len(rt_rows)-1} rout rows -> {_t1-_t0:.3f}s")
    return records


def _filter_records(
    records: list[dict],
    date_from: str | None = None,
    date_to: str | None = None,
    lines: list[str] | None = None,
) -> list[dict]:
    if not records:
        return []

    from_iso = date.fromisoformat(date_from) if date_from else None
    to_iso = date.fromisoformat(date_to) if date_to else None
    line_set = {str(line).strip() for line in lines or [] if str(line).strip()}

    filtered: list[dict] = []
    for record in records:
        day = record.get("day")
        if isinstance(day, date):
            if from_iso and day < from_iso:
                continue
            if to_iso and day > to_iso:
                continue
        if line_set and str(record.get("linha", "")).strip() not in line_set:
            continue
        filtered.append(record)
    return filtered


# ── API pública ───────────────────────────────────────────────────────────────

def _assemble_gantt_output(ms_by_wo: dict, rt_rows: list, records: list | None = None) -> dict:
    """Core Gantt data assembly (shared by build_gantt_data and scenario variant).

    `records`: optional pre-built records (e.g. after a Saturday-relocation post-pass).
    When None (default), records are built from ms_by_wo as usual.
    """
    _t_start = time.perf_counter()
    if records is None:
        records = _build_records(ms_by_wo, rt_rows)
    if not records:
        return {"date_info": [], "fw_map": {}, "groups": []}

    all_days_set = {r["day"] for r in records}
    min_date = min(all_days_set)
    max_date = max(all_days_set)

    all_dates: list[date] = []
    d = min_date
    while d <= max_date:
        all_dates.append(d)
        d += timedelta(days=1)

    # ── Aggregate ─────────────────────────────────────────────────────────────
    # NOTE: each desc-row is identified by the composite key (desc, pn) so that two
    # DIFFERENT Part Numbers sharing the same DESCRIÇÃO are kept as SEPARATE rows
    # (independent hours + qty), never merged. `dkey` below = (desc, pn).
    pair_ws:         dict[tuple, list[str]]  = {}   # (wo, tn) → [ws, ...]
    ws_descs:        dict[tuple, list[tuple]] = {}  # (wo, tn, ws) → [(desc, pn), ...]
    cell_hh:         dict[tuple, float]      = {}   # (wo, tn, ws, desc, pn, day) → hh
    cell_half:       dict[tuple, set]        = {}   # (wo, tn, ws, desc, pn, day) → set of half indicators
    ws_first:        dict[tuple, date]       = {}   # (wo, tn, ws) → first date
    desc_first:      dict[tuple, date]       = {}   # (wo, tn, ws, desc, pn) → first date
    linha_map:       dict[tuple, str]        = {}   # (wo, tn) → linha
    finish_ms_map:   dict[tuple, str]        = {}   # (wo, tn) → finish_ms
    contract_ms_map: dict[tuple, str]        = {}   # (wo, tn) → contract_ms (Contratual)
    # Populate finish_ms from the original ms_by_wo task data (not in records)
    for _fwo, _ftasks in ms_by_wo.items():
        for _ft in _ftasks:
            _fpk = (_fwo, _ft["task_name"])
            if _fpk not in finish_ms_map:
                finish_ms_map[_fpk] = _ft.get("finish_ms", "")
            if _fpk not in contract_ms_map:
                contract_ms_map[_fpk] = _ft.get("contract_ms", "") or ""
    ws_subarea:      dict[tuple, str]        = {}   # (wo, tn, ws) → subarea
    ws_area:         dict[tuple, str]        = {}   # (wo, tn, ws) → area
    desc_pn:         dict[tuple, str]        = {}   # (wo, tn, ws, desc, pn) → part number
    # Per desc-row, the distinct SOURCE rout rows behind it: src_uid → (qtd, hh_unit).
    # Keyed by src_uid so the same rout row seen on N production days is counted once.
    desc_src:        dict[tuple, dict]       = {}   # (wo, tn, ws, desc, pn) → {src_uid: (qtd, hh_unit)}
    desc_qtd:        dict[tuple, int]        = {}   # (wo, tn, ws, desc, pn) → total qtd (summed)
    desc_hh_unit:    dict[tuple, float]      = {}   # (wo, tn, ws, desc, pn) → original HH UNIT
    desc_workorder:  dict[tuple, str]        = {}   # (wo, tn, ws, desc, pn) → WORKORDER (first seen)
    # Plano de Produção pass-through, first NON-EMPTY value seen for the desc-row. First-non-empty
    # (rather than first-seen) so a source row that leaves the cell blank cannot shadow a populated
    # sibling; when every source row is blank the value stays "" and the UI shows an empty cell.
    desc_part_desc:  dict[tuple, str]        = {}   # dfk → PART DESC
    desc_escopo:     dict[tuple, str]        = {}   # dfk → ESCOPO
    desc_rlinha:     dict[tuple, str]        = {}   # dfk → LINHA
    # Same three, partitioned BY (WORKORDER, ESCOPO) — see the breakdown note below for why the
    # scope is part of that key — so a desc-row spanning several work orders (or several scopes
    # of one work order) keeps each line's own values on its own planning line.
    desc_wo_meta:    dict[tuple, dict]       = {}   # dfk → {(workorder, escopo): {part_desc, escopo, rout_linha}}
    # Display-only: every distinct WORKORDER seen for a desc-row, in first-seen
    # order. A Part Number produced across several days often has one WO per day
    # (bobina01, bobina02, …) that all collapse into a single desc-row; this
    # preserves the full list so the Plano de Produção view can show the WO
    # progression. Does NOT affect hours, qty, grouping or any calculation.
    desc_workorders: dict[tuple, list[str]]  = {}   # (wo, tn, ws, desc, pn) → [WORKORDER, …]
    # Per-(WORKORDER, ESCOPO) breakdown of a desc-row, so the Plano de Produção view can render
    # EACH work order — and each SCOPE of it — as its own planning line (instead of collapsing
    # every WO of a Part Number into one row). These partition the desc-row's source rows / daily
    # hours by that pair; totals are preserved exactly (Σ over buckets == the desc-row figures).
    # A blank WORKORDER is its own bucket keyed by "" and stays blank (never synthesized into a
    # fallback id); the same holds for a blank ESCOPO.
    #
    # ESCOPO belongs in the key because it is a distinct OPERATION on the item, not an attribute
    # of the work order: one WO of 84E906168G2 carries Coredrop (7,2 h) AND Usinagem (4,2 h) as
    # two source rout rows. Bucketing by workorder alone merged them into one line with qty 2 and
    # a quantity-weighted HH UNIT of 5,7 — a figure neither operation has. The desc-row identity
    # (`dfk`) deliberately still ignores ESCOPO: the Gantt plots the item's whole occupation of
    # the workstation, and splitting that box per scope would change the schedule, not the plan.
    desc_wo_src:     dict[tuple, dict]       = {}   # dfk → {(workorder, escopo): {src_uid: (qtd, hh_unit)}}
    desc_wo_order:   dict[tuple, list[tuple]] = {}  # dfk → [(workorder, escopo), …] first-seen (incl. blanks)
    wo_cell_hh:      dict[tuple, float]      = {}   # (dfk, (workorder, escopo), day) → Σ hh_dia
    wo_cell_half:    dict[tuple, set]        = {}   # (dfk, (workorder, escopo), day) → {half slots}
    fallback_map:    dict[tuple, str]        = {}   # (wo, tn) → fallback model used (if any)

    for r in records:
        _desc = r["desc"]
        _pn   = r.get("pn", "")
        pk  = (r["wo"], r["task_name"])
        if r.get("fallback_model") and pk not in fallback_map:
            fallback_map[pk] = r["fallback_model"]
        wfk = (r["wo"], r["task_name"], r["ws"])
        # desc-row identity includes the Part Number → distinct PNs never merge.
        dfk = (r["wo"], r["task_name"], r["ws"], _desc, _pn)
        chk = (r["wo"], r["task_name"], r["ws"], _desc, _pn, r["day"])
        dkey = (_desc, _pn)

        if pk not in linha_map:
            linha_map[pk] = r["linha"]

        if wfk not in ws_subarea:
            ws_subarea[wfk] = r.get("sa", "")

        if wfk not in ws_area:
            ws_area[wfk] = r.get("area", "")

        if dfk not in desc_pn:
            desc_pn[dfk] = _pn

        # QTD is a property of the SOURCE ROW, not of the day. Record it once per distinct
        # source row; the sum happens after the loop. Previously this kept only the
        # first-seen row's QTD while the daily hours below accumulated every source row's
        # contribution — so a PN built from rows of QTD 1+2+1+4+1 reported QTD=1 against the
        # hours of all 9 units, and HH UNIT (derived as hours/QTD in the Plano de Produção
        # tab) inflated to the full total.
        desc_src.setdefault(dfk, {})[r.get("src_uid")] = (
            r.get("qtd", 0), r.get("hh_unit", 0.0),
        )

        if dfk not in desc_workorder:
            desc_workorder[dfk] = r.get("workorder", "")

        # Plano de Produção pass-through: desc-row level, then per (WORKORDER, ESCOPO).
        for _tgt, _key in ((desc_part_desc, "part_desc"), (desc_escopo, "escopo"), (desc_rlinha, "rout_linha")):
            _v = r.get(_key, "")
            if _v and not _tgt.get(dfk):
                _tgt[dfk] = _v
        # The bucket a source row belongs to. A blank ESCOPO is a bucket of its own, never folded
        # into a populated sibling.
        #
        # The scope half is CASE-FOLDED. ESCOPO is free text in the source sheet and its casing is
        # inconsistent — measured on the live table: 'Montagem' 71 rows against 'MONTAGEM' 4,
        # 'Lavagem' 8 against 'LAVAGEM' 3, 'Desmontagem' 8 against 'DESMONTAGEM' 1. Case is not a
        # distinction between scopes, so bucketing on the raw string split ONE scope of ONE work
        # order into TWO planning lines, each carrying a slice of the quantity. The DISPLAY value
        # keeps the source's own spelling (see `_meta` below, and where the entry is emitted).
        _wo_key = (r.get("workorder", "") or "", (r.get("escopo", "") or "").strip().upper())
        _meta = desc_wo_meta.setdefault(dfk, {}).setdefault(_wo_key, {})
        for _key in ("part_desc", "escopo", "rout_linha"):
            _v = r.get(_key, "")
            if _v and not _meta.get(_key):
                _meta[_key] = _v

        # Collect every distinct non-empty WORKORDER for this desc-row (display-only).
        _wo_val = r.get("workorder", "")
        if _wo_val:
            _wo_list = desc_workorders.setdefault(dfk, [])
            if _wo_val not in _wo_list:
                _wo_list.append(_wo_val)

        # Per-(WORKORDER, ESCOPO) partition of this desc-row (a blank half → its own bucket).
        # Source figures (qtd/hh_unit) keyed by src_uid so a row seen on N days counts once;
        # daily hours accumulate per (bucket, day) so the split can be sliced by FW later.
        desc_wo_src.setdefault(dfk, {}).setdefault(_wo_key, {})[r.get("src_uid")] = (
            r.get("qtd", 0), r.get("hh_unit", 0.0),
        )
        _wo_ord = desc_wo_order.setdefault(dfk, [])
        if _wo_key not in _wo_ord:
            _wo_ord.append(_wo_key)
        _wchk = (dfk, _wo_key, r["day"])
        wo_cell_hh[_wchk] = wo_cell_hh.get(_wchk, 0.0) + r["hh_dia"]
        if _h := r.get("half"):
            wo_cell_half.setdefault(_wchk, set()).add(_h)

        if pk not in pair_ws:
            pair_ws[pk] = []
        if r["ws"] not in pair_ws[pk]:
            pair_ws[pk].append(r["ws"])

        if wfk not in ws_descs:
            ws_descs[wfk] = []
        if dkey not in ws_descs[wfk]:
            ws_descs[wfk].append(dkey)

        cell_hh[chk] = cell_hh.get(chk, 0.0) + r["hh_dia"]
        _h = r.get("half")
        if _h:
            if chk not in cell_half:
                cell_half[chk] = set()
            cell_half[chk].add(_h)

        if wfk not in ws_first or r["day"] < ws_first[wfk]:
            ws_first[wfk] = r["day"]
        if dfk not in desc_first or r["day"] < desc_first[dfk]:
            desc_first[dfk] = r["day"]

    # Sort WSs and descs by first occurrence
    for pk in pair_ws:
        pair_ws[pk].sort(key=lambda ws: ws_first.get((pk[0], pk[1], ws), date.max))
    for wfk in ws_descs:
        ws_descs[wfk].sort(key=lambda dk: desc_first.get((wfk[0], wfk[1], wfk[2], dk[0], dk[1]), date.max))

    fw_map = {d.isoformat(): _semana_fw(d) for d in all_dates}

    # Build takt & start_ms lookup so they can be included in each group
    takt_map:     dict[tuple, object] = {}
    start_ms_map: dict[tuple, str]    = {}
    for _two, _ttasks in ms_by_wo.items():
        for _tt in _ttasks:
            _pk = (_two, _tt["task_name"])
            takt_map[_pk] = _tt.get("takt_raw")
            _sm = _tt.get("start_ms")
            if _sm and _pk not in start_ms_map:
                start_ms_map[_pk] = _sm.isoformat() if hasattr(_sm, "isoformat") else str(_sm)

    # For LOCOs whose start_ms is absent (empty cell / null in the data source),
    # fall back to the earliest plotted workstation date.  Without this, multiple
    # LOCOs that differ only in special characters produce the same DOM element ID
    # after safeId() normalization, causing getElementById() to return the wrong LOCO.
    for _pk in pair_ws:
        if _pk not in start_ms_map:
            _wo, _tn = _pk
            _min_dates = [ws_first.get((_wo, _tn, _ws), date.max) for _ws in pair_ws.get(_pk, [])]
            _first = min(_min_dates) if _min_dates else None
            if _first and _first < date.max:
                start_ms_map[_pk] = _first.isoformat()

    def _group_sort_date(wo_tn: tuple) -> date:
        """Sort key: START MS date from the schedule (0-reference), not first workstation date."""
        _iso = start_ms_map.get(wo_tn)
        if _iso:
            try:
                return date.fromisoformat(_iso[:10])
            except (ValueError, TypeError):
                pass
        # Fallback to first workstation date if start_ms not available
        wo, tn = wo_tn
        dates = [ws_first.get((wo, tn, ws), date.max) for ws in pair_ws.get(wo_tn, [])]
        return min(dates) if dates else date.max

    # ── Pre-group cells by (wo, tn, ws, desc) to eliminate O(combos × all_dates) scanning.
    # Previously the inner loop iterated all_dates for every (wo, tn, ws, desc) combo.
    # For 1 year: 25k combos × 365 days = 9M dict lookups → now O(len(records)) total.
    cells_by_dfk: dict[tuple, dict[str, dict]] = {}
    for _chk, _hh in cell_hh.items():
        _wo, _tn, _ws, _desc, _pn, _day = _chk
        _dfk = (_wo, _tn, _ws, _desc, _pn)
        _half_set = cell_half.get(_chk, set())
        _half_val: str | None = list(_half_set)[0] if len(_half_set) == 1 else None
        _cell_dict: dict = {"hh": round(_hh, 2)}
        if _half_val:
            _cell_dict["half"] = _half_val
        if _dfk not in cells_by_dfk:
            cells_by_dfk[_dfk] = {}
        cells_by_dfk[_dfk][_day.isoformat()] = _cell_dict

    # Per-(desc-row, workorder, escopo) daily cells — same shape as cells_by_dfk but partitioned
    # by that pair, so the Plano de Produção view can render one line per WO+scope with its own
    # hours.
    wo_cells_by_key: dict[tuple, dict[str, dict]] = {}   # (dfk, (workorder, escopo)) → {iso: cell}
    for _wchk, _hh in wo_cell_hh.items():
        _dfk_w, _wo_w, _day_w = _wchk
        _hset = wo_cell_half.get(_wchk, set())
        _hval: str | None = list(_hset)[0] if len(_hset) == 1 else None
        _cd: dict = {"hh": round(_hh, 2)}
        if _hval:
            _cd["half"] = _hval
        wo_cells_by_key.setdefault((_dfk_w, _wo_w), {})[_day_w.isoformat()] = _cd

    # Collapse each desc-row's source rows into the two figures the UI must show verbatim:
    #   QTD     = Σ qtd over the distinct source rows
    #   HH UNIT = Σ(hh_unit × qtd) / Σ qtd  — the per-unit hours.
    # The weighting matters only when source rows for one PN disagree on HH UNIT (rare);
    # when they agree — the normal case — it returns that shared value exactly. Deriving it
    # here from SOURCE values, rather than from the assembled daily cells, keeps HH UNIT
    # stable when the caller slices records by date range (see _filter_records).
    for _dfk, _srcs in desc_src.items():
        _tot_qtd = sum(_q for _q, _ in _srcs.values())
        desc_qtd[_dfk] = _tot_qtd
        desc_hh_unit[_dfk] = (
            sum(_h * _q for _q, _h in _srcs.values()) / _tot_qtd if _tot_qtd > 0 else 0.0
        )

    groups: list[dict] = []
    for (wo, task_name) in sorted(pair_ws.keys(), key=_group_sort_date):
        wss: list[dict] = []
        for ws in pair_ws[(wo, task_name)]:
            wfk = (wo, task_name, ws)
            desc_list = ws_descs.get(wfk, [])
            desc_rows: list[dict] = []
            for (desc, pn) in desc_list:
                dfk = (wo, task_name, ws, desc, pn)
                cells = cells_by_dfk.get(dfk, {})
                if cells:
                    # Per-(WORKORDER, ESCOPO) breakdown (each pair its own planning line
                    # downstream). Only emitted when a desc-row actually spans MORE THAN ONE
                    # bucket — for a single one the existing top-level fields already describe
                    # the row, so we skip the redundant (larger) payload. Note the gate counts
                    # BUCKETS, not work orders: one WO carrying two ESCOPOs is two planning
                    # lines and must emit a breakdown, or the two scopes blend back into a
                    # single line with a summed quantity and an HH UNIT that averages them.
                    _wo_ord = desc_wo_order.get(dfk, [])
                    wo_breakdown: list[dict] = []
                    if len(_wo_ord) > 1:
                        for _wo_k in _wo_ord:
                            _srcs = desc_wo_src.get(dfk, {}).get(_wo_k, {})
                            _tq = sum(_q for _q, _ in _srcs.values())
                            _hu = (sum(_h * _q for _q, _h in _srcs.values()) / _tq) if _tq > 0 else 0.0
                            _wcells = wo_cells_by_key.get((dfk, _wo_k), {})
                            if _wcells:
                                _entry = {"workorder": _wo_k[0], "qtd": _tq, "hh_unit": _hu, "cells": _wcells}
                                # Per-bucket pass-through values; omitted entirely when blank so
                                # the payload doesn't grow for sheets without these columns.
                                _meta_map = desc_wo_meta.get(dfk, {}).get(_wo_k, {}) or {}
                                # The scope is guaranteed by the KEY, so it is present on every
                                # line of a multi-scope item even where the meta map happens to be
                                # empty — but the meta value WINS, because the key is case-folded
                                # (see where it is built) and the sheet's own spelling is what the
                                # ESCOPO column must show.
                                if _wo_k[1]:
                                    _entry["escopo"] = _meta_map.get("escopo") or _wo_k[1]
                                for _mk, _mv in _meta_map.items():
                                    if _mv and _mk not in _entry:
                                        _entry[_mk] = _mv
                                wo_breakdown.append(_entry)
                    _row = {"desc": desc, "pn": desc_pn.get(dfk, pn), "qtd": desc_qtd.get(dfk, 0), "hh_unit": desc_hh_unit.get(dfk, 0.0), "workorder": desc_workorder.get(dfk, ""), "workorders": desc_workorders.get(dfk, []), "cells": cells}
                    # Plano de Produção pass-through — emitted only when the source has a value.
                    for _pk_key, _pk_map in (("part_desc", desc_part_desc), ("escopo", desc_escopo), ("rout_linha", desc_rlinha)):
                        if _pk_map.get(dfk):
                            _row[_pk_key] = _pk_map[dfk]
                    if wo_breakdown:
                        _row["wo_breakdown"] = wo_breakdown
                    desc_rows.append(_row)
            if desc_rows:
                wss.append({"ws": ws, "subarea": ws_subarea.get(wfk, ""), "area": ws_area.get(wfk, ""), "desc_rows": desc_rows})
        if wss:
            _fb_model = fallback_map.get((wo, task_name))
            groups.append({
                "wo": wo,
                "task_name": task_name,
                "linha": linha_map.get((wo, task_name), ""),
                "finish_ms": finish_ms_map.get((wo, task_name), ""),
                # Contratual — display-only, never an input to the schedule (see the column's note
                # in models.py). Empty string when the sheet carries no contractual date.
                "contract_ms": contract_ms_map.get((wo, task_name), ""),
                "start_ms": start_ms_map.get((wo, task_name), ""),
                "takt": takt_map.get((wo, task_name)),
                # Locomotive model fallback: original `wo` is preserved; the UI appends "(FB)"
                # when `fallback` is set, while all hours here already come from `fallback_model`.
                "fallback": bool(_fb_model),
                "fallback_model": _fb_model or "",
                "workstations": wss,
            })

    DOW_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
    # A Saturday that actually received allocated work (Mode 1 "Usar Sábados") must
    # render as a normal working column — otherwise it collapses into the narrow
    # non-working colspan and its allocation box is hidden even though the hours are
    # counted. Sundays and empty Saturdays stay flagged as weekend (collapsed).
    #
    # ALSO: an UNUSED Saturday that falls INSIDE a WS40/WS50 block's span must render as a
    # working column too — otherwise it collapses into the grey weekend colspan and the
    # Schedule's orange "Sábado disponível não utilizado" placeholder can never draw on it
    # (the blank weekend cell was overriding the orange box). We only do this when the
    # schedule actually uses Saturdays (Mode 1 "Usar Sábados"), so plain non-Saturday views
    # are NOT widened with extra columns. The span is computed per DESCRIÇÃO to match the
    # Schedule's deduped rows, and strictly between first/last day so only internal gaps
    # become columns (leading/trailing Saturdays stay collapsed).
    _has_used_saturday = any(d.weekday() == 5 for d in all_days_set)
    _CONFLICT_WS = {"WS40", "WS50"}
    _conflict_sat_spans: list[tuple[str, str]] = []
    if _has_used_saturday:
        for _g in groups:
            for _ws in _g["workstations"]:
                if str(_ws.get("ws", "")).strip().upper().replace(" ", "") not in _CONFLICT_WS:
                    continue
                _by_desc: dict[str, list[str]] = {}
                for _dr in _ws["desc_rows"]:
                    _by_desc.setdefault(_dr.get("desc", ""), []).extend(_dr["cells"].keys())
                for _isos in _by_desc.values():
                    if _isos:
                        _conflict_sat_spans.append((min(_isos), max(_isos)))

    def _in_conflict_sat_span(iso: str) -> bool:
        return any(lo < iso < hi for (lo, hi) in _conflict_sat_spans)

    def _is_weekend_day(d: date) -> bool:
        # An admin-declared exceptional working day (e.g. an extra Saturday) is never
        # rendered as a non-working weekend column.
        if _is_forced_working(d):
            return False
        wd = d.weekday()  # 0=Mon … 5=Sat, 6=Sun
        if wd == 5 and (d in all_days_set or _in_conflict_sat_span(d.isoformat())):
            return False  # working Saturday: real allocation OR an unused day inside a WS40/WS50 block
        return wd >= 5
    # is_holiday flags a NON-WORKING day that is a holiday (weekday public/company
    # holiday, or a working day converted to a day off) — distinct from a plain
    # weekend. The frontend reads this instead of recomputing its own holiday set,
    # so all three former calendar copies now derive from this single source.
    date_info: list[dict] = [
        {
            "iso": d.isoformat(),
            "label": d.strftime("%d/%m"),
            "dow": DOW_PT[d.weekday()],
            "fw": _semana_fw(d),
            "is_weekend": _is_weekend_day(d),
            "is_holiday": _is_holiday_day(d),
        }
        for d in all_dates
    ]

    # Per-year fiscal-week label offsets spanning the rendered range (non-zero only). Lets the
    # frontend derive override-aware FW labels for dates OUTSIDE date_info (e.g. kit ship/receipt
    # dates beyond the loaded window), so no client-side code re-invents fiscal weeks from scratch.
    fw_offsets: dict[str, int] = {}
    for _yr in {d.year for d in all_dates}:
        _off = _fw_offset_for_year(_yr)
        if _off:
            fw_offsets[str(_yr)] = _off

    total_items = sum(desc_qtd.values())
    _t_end = time.perf_counter()
    print(f"[gantt_perf] _assemble_gantt_output: {len(records):,} records, {len(all_dates)} dates, {len(groups)} groups -> {_t_end-_t_start:.3f}s total")
    return {
        "date_info": date_info,
        "fw_map": fw_map,
        "groups": groups,
        "fw_offsets": fw_offsets,
        "total_items": total_items,
    }


def build_gantt_data() -> dict:
    """Retorna dict com todos os dados do Gantt para renderização no frontend."""
    ms_by_wo, rt_rows = _load_source_data()
    return _assemble_gantt_output(ms_by_wo, rt_rows)


def build_gantt_data_from_scenario_excel(file_bytes: bytes) -> dict:
    """Build Gantt data from uploaded Schedule-MS Excel, using DB LocosRout."""
    import io as _io
    import openpyxl as _opx
    wb = _opx.load_workbook(_io.BytesIO(file_bytes), read_only=True, data_only=True)
    _available = list(wb.sheetnames)
    _sm_sheet = next((s for s in _SHEETS_MS if s in _available), None)
    if _sm_sheet is None:
        raise ValueError(
            f"Aba Schedule não encontrada. Esperado: {_SHEETS_MS}. Disponível: {_available}"
        )
    ws_ms = wb[_sm_sheet]
    ms_rows = list(ws_ms.iter_rows(values_only=True))
    if not ms_rows:
        raise ValueError("Planilha Schedule - MS está vazia.")
    ms_hdr = [_norm(c) for c in ms_rows[0]]
    # Accent/case-insensitive column matching with PT/EN fallbacks (Start→Início,
    # Finish→Término). Errors list only the missing required columns, not the sheet's.
    _cols = _resolve_scenario_columns(ms_hdr)
    i_wo, i_tn, i_sm, i_tk, i_ln, i_fn, i_ct = (
        _cols["wo"], _cols["tn"], _cols["sm"], _cols["tk"], _cols["ln"], _cols["fn"], _cols["ct"])
    ms_by_wo: dict = defaultdict(list)
    for row in ms_rows[1:]:
        wo = _norm(row[i_wo]) if len(row) > i_wo else ""
        if not wo:
            continue
        raw = row[i_sm] if i_sm >= 0 and len(row) > i_sm else None
        # Use _parse_excel_date_raw for Start MS to handle datetime objects, date objects,
        # Excel serial-number floats (common in openpyxl read_only mode), and ISO strings.
        # Without this, serial-number cells yield start_dt=None, causing data_calc=None
        # and skipping the Protection Days duration override entirely.
        _sm_str = _parse_excel_date_raw(raw)
        start_dt: date | None = None
        if _sm_str:
            try:
                start_dt = date.fromisoformat(_sm_str[:10])
            except Exception:
                pass
        # _parse_excel_date_raw handles datetime objects, Excel serial floats, and plain strings
        _fn_raw = row[i_fn] if i_fn >= 0 and len(row) > i_fn else None
        fn_str = _parse_excel_date_raw(_fn_raw)
        _tk_val = _safe_float(row[i_tk]) if len(row) > i_tk else None
        ms_by_wo[wo].append({
            "task_name": _norm(row[i_tn]) if len(row) > i_tn else "",
            "start_ms":  start_dt,
            "takt":      _tk_val or 1.0,
            "takt_raw":  _tk_val,
            "linha":     _norm(row[i_ln]) if i_ln >= 0 and len(row) > i_ln else "",
            "finish_ms": fn_str,
            "contract_ms": _parse_excel_date_raw(row[i_ct] if i_ct >= 0 and len(row) > i_ct else None),
        })
    wb.close()
    # Load LocosRout from DB
    rt_rows: list = []
    try:
        from database import get_db
        from models import LocosRout as _LR, get_active_ver as _gav
        with get_db() as _db:
            _lr_ver  = _gav(_db, "locos_rout")
            _lr_rows = _db.query(_LR).filter(_LR.ver == _lr_ver).all()
            if _lr_rows:
                # WORKORDER must be included here too: the Plano de Produ\u00e7\u00e3o view concatenates
                # LOCO-WORKORDER, and without this column a scenario-loaded schedule shows only
                # the loco (no concatenation).
                #
                # PART DESC / ESCOPO / LINHA went exactly the same way, and are the DESCRICAO,
                # ESCOPO and LINHA columns of that same view. Like WORKORDER they are pass-through
                # only - nothing in the scheduling maths reads them (see _build_records) - so they
                # are easy to leave out of a header without breaking anything except the screen
                # that displays them, where the column simply comes out blank. A scenario is the
                # same schedule read from another workbook, so its grid has to come out identical
                # to a normal load: EVERY column the view reads must be listed here.
                #
                # Keep in step with the normal DB path (_load_source_data) and the export path
                # (build_gantt_excel_from_scenario) - all three read the same LocosRout table.
                rt_rows = [["LOCOMOTIVA", "PART NUMBER", "WORKSTATION", "SUBAREA", "AREA",
                             "HH UNIT", "QTD", "DURACAO", "INICIO", "DESCRI\u00c7\u00c3O", "WORKORDER",
                             "PART DESC", "ESCOPO", "LINHA"]]
                for _r in _lr_rows:
                    rt_rows.append([
                        getattr(_r, "locomotiva",  "") or "",
                        getattr(_r, "part_number", "") or "",
                        getattr(_r, "workstation", "") or "",
                        getattr(_r, "subarea",     "") or "",
                        getattr(_r, "area",        "") or "",
                        getattr(_r, "hh_unit",     0)  or 0,
                        getattr(_r, "qtd",         0)  or 0,
                        getattr(_r, "duracao",     "") or "",
                        getattr(_r, "inicio",      "") or "",
                        getattr(_r, "descricao",   "") or "",
                        getattr(_r, "workorder",   "") or "",
                        getattr(_r, "part_desc",   "") or "",
                        getattr(_r, "escopo",      "") or "",
                        getattr(_r, "linha",       "") or "",
                    ])
    except Exception:
        pass
    if not rt_rows:
        raise RuntimeError(
            "LocosRout não encontrado no banco. "
            "Importe a tabela de roteamento antes de usar Simular Cenário."
        )
    return _assemble_gantt_output(ms_by_wo, rt_rows)


def build_gantt_excel(
    date_from: str | None = None,
    date_to: str | None = None,
    lines: list[str] | None = None,
    _ms_by_wo=None,
    _rt_rows=None,
) -> bytes:
    """
    Gera o Excel do Gantt e retorna como bytes (em memória).
    Idêntico ao gantt_special_line.py mas não salva em disco.
    Aceita ms_by_wo/_rt_rows pré-carregados (para exportação de cenário).
    """
    import openpyxl
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    if _ms_by_wo is not None and _rt_rows is not None:
        ms_by_wo, rt_rows = _ms_by_wo, _rt_rows
    else:
        ms_by_wo, rt_rows = _load_source_data()
    records = _filter_records(_build_records(ms_by_wo, rt_rows), date_from, date_to, lines)
    if not records:
        raise ValueError("Nenhum dado encontrado para gerar o Gantt.")

    all_days_set = {r["day"] for r in records}
    min_date = min(all_days_set)
    max_date = max(all_days_set)
    all_dates: list[date] = []
    d = min_date
    while d <= max_date:
        all_dates.append(d)
        d += timedelta(days=1)

    pair_ws: dict[tuple, list[str]]  = {}
    cell_data: dict[tuple, dict]     = {}
    ws_first_date: dict[tuple, date] = {}

    for r in records:
        pk  = (r["wo"], r["task_name"])
        wdk = (r["wo"], r["task_name"], r["ws"], r["day"])
        wfk = (r["wo"], r["task_name"], r["ws"])
        if pk not in pair_ws:
            pair_ws[pk] = []
        if r["ws"] not in pair_ws[pk]:
            pair_ws[pk].append(r["ws"])
        if wdk not in cell_data:
            cell_data[wdk] = {"sa": r["sa"], "hh": 0.0}
        cell_data[wdk]["hh"] += r["hh_dia"]
        if wfk not in ws_first_date or r["day"] < ws_first_date[wfk]:
            ws_first_date[wfk] = r["day"]

    for pk in pair_ws:
        pair_ws[pk].sort(key=lambda ws: ws_first_date.get((pk[0], pk[1], ws), date.max))

    FW_DARK  = ["4472C4","70AD47","ED7D31","FFC000","5B9BD5","A9D18E","F4B942","8FAADC"]
    FW_LIGHT = ["DEEAF1","E2EFDA","FCE4D6","FFF2CC","D9E1F2","E9F5E1","FFF0CB","EEF3FB"]
    WEEKEND_FILL  = PatternFill("solid", fgColor="EBEBEB")
    HDR_FILL      = PatternFill("solid", fgColor="D6DCE4")
    ROW_EVEN_FILL = PatternFill("solid", fgColor="F2F2F2")
    ROW_ODD_FILL  = PatternFill("solid", fgColor="FFFFFF")
    BOLD9  = Font(bold=True, size=9)
    BOLD8  = Font(bold=True, size=8)
    CELL8  = Font(size=8)
    WHITE9 = Font(bold=True, size=9, color="FFFFFF")
    CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
    LEFT   = Alignment(horizontal="left",   vertical="center", wrap_text=True)
    thin   = Side(style="thin", color="BFBFBF")
    BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
    DOW_PT = ["Seg","Ter","Qua","Qui","Sex","Sab","Dom"]
    COL_OFFSET = 4

    # Fiscal-week header groups come from the SHARED, override-aware calendar (the same
    # _semana_fw the on-screen Gantt uses) — NOT ISO week numbers — so the export matches the
    # app and honors admin fiscal-week overrides (e.g. 2027 FW01 starting Jan 4). A new group
    # begins whenever the FW label changes along the date axis, which keeps each run contiguous
    # even when a label legitimately recurs across a year boundary.
    fw_gid: list[int] = []              # fiscal-week group id per date index
    fw_gid_label: dict[int, str] = {}   # group id → override-aware FW label (e.g. "FW01")
    _gid = -1
    _prev_lab: str | None = None
    for d in all_dates:
        lab = _semana_fw(d)
        if lab != _prev_lab:
            _gid += 1
            fw_gid_label[_gid] = lab
            _prev_lab = lab
        fw_gid.append(_gid)

    wb_out   = openpyxl.Workbook()
    ws_gantt = wb_out.active
    ws_gantt.title = "Gantt"
    ws_gantt.row_dimensions[1].height = 18

    for col_letter, val in [("A","FW"), ("B","MODELO"), ("C","LOCO"), ("D","WS")]:
        c = ws_gantt[f"{col_letter}1"]
        c.value = val; c.font = BOLD9; c.alignment = CENTER; c.fill = HDR_FILL

    fw_col_groups: dict = defaultdict(list)
    for i, d in enumerate(all_dates):
        fw_col_groups[fw_gid[i]].append(COL_OFFSET + 1 + i)

    for gid, cols in fw_col_groups.items():
        dark_fill = PatternFill("solid", fgColor=FW_DARK[gid % len(FW_DARK)])
        first, last = cols[0], cols[-1]
        ws_gantt.cell(1, first).value     = fw_gid_label[gid]
        ws_gantt.cell(1, first).font      = WHITE9
        ws_gantt.cell(1, first).fill      = dark_fill
        ws_gantt.cell(1, first).alignment = CENTER
        if first != last:
            ws_gantt.merge_cells(start_row=1, start_column=first, end_row=1, end_column=last)
        # Do NOT set fill on merged cells — raises AttributeError in openpyxl

    ws_gantt.row_dimensions[2].height = 28
    for col_letter, val in [("A","LINHA"), ("B","MODELO"), ("C","LOCO"), ("D","WORKSTATION")]:
        c = ws_gantt[f"{col_letter}2"]
        c.value = val; c.font = BOLD9; c.alignment = CENTER
        c.fill = HDR_FILL; c.border = BORDER

    for i, d in enumerate(all_dates):
        col = COL_OFFSET + 1 + i
        dow = DOW_PT[d.weekday()]
        c   = ws_gantt.cell(2, col, f"{d.strftime('%d/%m')}\n{dow}")
        c.font = BOLD8; c.alignment = CENTER; c.border = BORDER
        c.fill = WEEKEND_FILL if d.weekday() >= 5 else HDR_FILL

    current_row = 3
    for group_idx, (wo, task_name) in enumerate(pair_ws.keys()):
        ws_list   = pair_ws[(wo, task_name)]
        n_ws      = len(ws_list)
        start_row = current_row
        is_even   = group_idx % 2 == 1
        bg_fill   = ROW_EVEN_FILL if is_even else ROW_ODD_FILL

        for ws_idx, ws_name in enumerate(ws_list):
            r = current_row
            ws_gantt.row_dimensions[r].height = 28
            first_in_group = (ws_idx == 0)
            for col_num, val in [
                (1, ""),
                (2, wo        if first_in_group else ""),
                (3, task_name if first_in_group else ""),
                (4, ws_name),
            ]:
                c = ws_gantt.cell(r, col_num, val)
                c.font = BOLD8
                c.alignment = CENTER if col_num == 1 else LEFT
                c.border = BORDER; c.fill = bg_fill

            for i, d in enumerate(all_dates):
                col = COL_OFFSET + 1 + i
                c   = ws_gantt.cell(r, col)
                c.border = BORDER
                if d.weekday() >= 5:
                    c.fill = WEEKEND_FILL; continue
                key = (wo, task_name, ws_name, d)
                if key in cell_data:
                    data = cell_data[key]
                    c.value     = f"{data['sa']}\n{data['hh']:.1f}h"
                    c.font      = CELL8; c.alignment = CENTER
                    c.fill      = PatternFill("solid", fgColor=FW_LIGHT[fw_gid[i] % len(FW_LIGHT)])
                else:
                    c.fill = bg_fill
            current_row += 1

        if n_ws > 1:
            end_row = start_row + n_ws - 1
            for col_num in [1, 2, 3]:
                ws_gantt.merge_cells(
                    start_row=start_row, start_column=col_num,
                    end_row=end_row,     end_column=col_num,
                )
                ws_gantt.cell(start_row, col_num).alignment = Alignment(
                    horizontal="left" if col_num >= 2 else "center",
                    vertical="center", wrap_text=True,
                )

    ws_gantt.column_dimensions["A"].width = 7
    ws_gantt.column_dimensions["B"].width = 22
    ws_gantt.column_dimensions["C"].width = 13
    ws_gantt.column_dimensions["D"].width = 12
    for i, d in enumerate(all_dates):
        letter = get_column_letter(COL_OFFSET + 1 + i)
        ws_gantt.column_dimensions[letter].width = 5 if d.weekday() >= 5 else 15
    ws_gantt.freeze_panes = "E3"

    buf = io.BytesIO()
    wb_out.save(buf)
    return buf.getvalue()


# Workstation color palette — MUST match the Schedule worker's WS_COLORS so the export
# looks like the on-screen Gantt (gantt-table-worker.js). Hex without leading '#'.
_WS_COLORS_HEX = [
    "DCEEFB", "DDF3D4", "FCE4D6", "FFF3C4",
    "E0D4F5", "D4F0E8", "FFF0CB", "F2DFF8",
    "FFE5EC", "E8F5E9", "FFF8E1", "E3F2FD",
    "F3E5F5", "E0F7FA", "FFF3E0", "EDE7F6",
    "FDECEA", "E8EAF6", "F9FBE7", "FCE4EC",
]


def _ws_sub_label(ws: str, subarea: str | None, sep: str = "-") -> str:
    """Mirror the worker's wsSubLabel: 'WS - SUBAREA', or just WS when equal/empty."""
    w = str(ws or "")
    s = str(subarea or "")
    if not s:
        return w
    if w.strip().lower() == s.strip().lower():
        return w
    return f"{w} {sep} {s}"


def build_gantt_excel_from_view(
    groups: list[dict],
    date_info: list[dict],
    mode: str = "full",
    color_by_ws: bool = True,
) -> bytes:
    """
    Render the Excel export from the EXACT data currently shown in the Schedule
    (the frontend's effectiveData), honoring the active view mode so the export
    matches the screen 1:1.

    - groups:    [{ linha, wo, task_name, start_ms?, workstations:[{ ws, subarea?,
                   desc_rows:[{ desc, cells:{ iso:{ hh } } }] }] }]
    - date_info: [{ iso, label, dow, fw, is_weekend }] — the rendered day columns.
    - mode:      'full' | 'ws' (WORK) | 'loco' — grouping/aggregation, identical to
                 the worker:
                   FULL → one row per (WS, descrição); cell = descrição + hours.
                   WORK → one row per WS; cell = aggregated hours of that WS that day.
                   LOCO → one row per LOCO; cell = total aggregated hours that day.
    - color_by_ws: cell fill uses the WS color palette (matches on-screen colorByWs).

    OPERATIONAL DATA ONLY — no conflict/check/PD/displacement/bottleneck icons, no
    hatched displacement boxes, no PD/conflict/hours MODELO annotations, no Saturday
    red-X markers. Those are UI-only overlays and are intentionally excluded here.
    A Saturday cell that actually carries an allocation renders as a normal box.
    """
    import openpyxl
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    mode = (mode or "full").lower()
    dates = list(date_info or [])
    if not groups or not dates:
        raise ValueError("Nenhum dado encontrado para gerar o Gantt.")

    # WS color index — assigned in first-seen order across all groups (matches the
    # worker's buildWsIndex). FW light fallback when color_by_ws is off.
    FW_LIGHT = ["DCEEFB", "DDF3D4", "FCE4D6", "FFF3C4", "E0D4F5", "D4F0E8", "FFF0CB", "F2DFF8"]
    ws_index: dict[str, int] = {}
    for g in groups:
        for w in g.get("workstations", []):
            wname = w.get("ws", "")
            if wname not in ws_index:
                ws_index[wname] = len(ws_index) % len(_WS_COLORS_HEX)
    fw_index: dict[str, int] = {}
    for d in dates:
        fw = d.get("fw", "")
        if fw not in fw_index:
            fw_index[fw] = len(fw_index) % len(FW_LIGHT)

    def _cell_fill(ws_name: str, fw: str) -> PatternFill:
        if color_by_ws:
            return PatternFill("solid", fgColor=_WS_COLORS_HEX[ws_index.get(ws_name, 0)])
        return PatternFill("solid", fgColor=FW_LIGHT[fw_index.get(fw, 0)])

    WEEKEND_FILL  = PatternFill("solid", fgColor="EBEBEB")
    HDR_FILL      = PatternFill("solid", fgColor="D6DCE4")
    ROW_EVEN_FILL = PatternFill("solid", fgColor="F2F2F2")
    ROW_ODD_FILL  = PatternFill("solid", fgColor="FFFFFF")
    FW_DARK = ["4472C4", "70AD47", "ED7D31", "FFC000", "5B9BD5", "A9D18E", "F4B942", "8FAADC"]
    BOLD9  = Font(bold=True, size=9)
    BOLD8  = Font(bold=True, size=8)
    CELL8  = Font(size=8)
    WHITE9 = Font(bold=True, size=9, color="FFFFFF")
    CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
    LEFT   = Alignment(horizontal="left",   vertical="center", wrap_text=True)
    thin   = Side(style="thin", color="BFBFBF")
    BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
    COL_OFFSET = 4

    wb_out   = openpyxl.Workbook()
    ws_gantt = wb_out.active
    ws_gantt.title = "Gantt"
    ws_gantt.row_dimensions[1].height = 18

    for col_letter, val in [("A", "FW"), ("B", "MODELO"), ("C", "LOCO"), ("D", "WS")]:
        c = ws_gantt[f"{col_letter}1"]
        c.value = val; c.font = BOLD9; c.alignment = CENTER; c.fill = HDR_FILL

    # FW band header (row 1) — one merged dark band per FW run.
    fw_dark_index: dict[str, int] = {}
    for d in dates:
        fw = d.get("fw", "")
        if fw not in fw_dark_index:
            fw_dark_index[fw] = len(fw_dark_index) % len(FW_DARK)
    fw_col_groups: dict = defaultdict(list)
    for i, d in enumerate(dates):
        fw_col_groups[d.get("fw", "")].append(COL_OFFSET + 1 + i)
    for fw, cols in fw_col_groups.items():
        first, last = cols[0], cols[-1]
        cc = ws_gantt.cell(1, first)
        cc.value = str(fw); cc.font = WHITE9
        cc.fill = PatternFill("solid", fgColor=FW_DARK[fw_dark_index[fw]])
        cc.alignment = CENTER
        if first != last:
            ws_gantt.merge_cells(start_row=1, start_column=first, end_row=1, end_column=last)

    ws_gantt.row_dimensions[2].height = 28
    for col_letter, val in [("A", "LINHA"), ("B", "MODELO"), ("C", "LOCO"), ("D", "WORKSTATION")]:
        c = ws_gantt[f"{col_letter}2"]
        c.value = val; c.font = BOLD9; c.alignment = CENTER; c.fill = HDR_FILL; c.border = BORDER

    for i, d in enumerate(dates):
        col = COL_OFFSET + 1 + i
        c = ws_gantt.cell(2, col, f"{d.get('label', '')}\n{d.get('dow', '')}")
        c.font = BOLD8; c.alignment = CENTER; c.border = BORDER
        c.fill = WEEKEND_FILL if d.get("is_weekend") else HDR_FILL

    iso_list = [d.get("iso", "") for d in dates]
    fw_by_iso = {d.get("iso", ""): d.get("fw", "") for d in dates}
    weekend_by_iso = {d.get("iso", ""): bool(d.get("is_weekend")) for d in dates}

    def _cell_text(info: dict) -> str:
        # LOCO pre-renders the full multi-WS box text in `text`; FULL/WORK pass a
        # label (descrição or WS) + hours to format here.
        if info.get("text") is not None:
            return info["text"]
        return f"{info['label']}\n{info['hh']:.1f}h" if info.get("label") else f"{info['hh']:.1f}h"

    def _write_day_cells(r: int, rows_iter, bg_fill):
        """rows_iter: iso → cell info ({label,hh,ws_name} or {text,ws_name})."""
        cellmap = rows_iter
        for i, iso in enumerate(iso_list):
            col = COL_OFFSET + 1 + i
            c = ws_gantt.cell(r, col)
            c.border = BORDER
            if weekend_by_iso.get(iso):
                # Weekend stays the normal weekend format UNLESS an allocation lands
                # here (e.g. Saturday WS40/WS50) — then render it as a normal box.
                if iso in cellmap:
                    info = cellmap[iso]
                    c.value = _cell_text(info)
                    c.font = CELL8; c.alignment = CENTER
                    c.fill = _cell_fill(info["ws_name"], fw_by_iso.get(iso, ""))
                else:
                    c.fill = WEEKEND_FILL
                continue
            if iso in cellmap:
                info = cellmap[iso]
                c.value = _cell_text(info)
                c.font = CELL8; c.alignment = CENTER
                c.fill = _cell_fill(info["ws_name"], fw_by_iso.get(iso, ""))
            else:
                c.fill = bg_fill

    current_row = 3
    for group_idx, g in enumerate(groups):
        linha = g.get("linha", "")
        wo = g.get("wo", "")
        task_name = g.get("task_name", "")
        wslist = g.get("workstations", [])
        is_even = group_idx % 2 == 1
        bg_fill = ROW_EVEN_FILL if is_even else ROW_ODD_FILL
        start_row = current_row

        # Build the rows for this group according to the active mode.
        row_specs: list[tuple[str, dict]] = []  # (ws_label, iso→cell info)

        if mode == "loco":
            # One row per LOCO. The on-screen LOCO box shows the TOP-2 workstations by
            # hours that day (each as "WS - SUBAREA" + hours, sorted desc), NOT a single
            # total. Mirror that exactly: per day, sum hours per WS, take the top 2, and
            # render them stacked top→bottom in the same order ("WS  h\nWS  h").
            per_day_ws: dict[str, dict[str, dict]] = {}  # iso → { rawWs → {hh, label} }
            for w in wslist:
                wname = w.get("ws", "")
                wlabel = _ws_sub_label(wname, w.get("subarea"))
                for dr in w.get("desc_rows", []):
                    for iso, cell in (dr.get("cells") or {}).items():
                        h = float(cell.get("hh") or 0)
                        wm = per_day_ws.setdefault(iso, {})
                        e = wm.get(wname)
                        if e:
                            e["hh"] += h
                        else:
                            wm[wname] = {"hh": h, "label": wlabel}
            agg: dict[str, dict] = {}
            for iso, wm in per_day_ws.items():
                top = sorted(wm.items(), key=lambda kv: kv[1]["hh"], reverse=True)[:2]
                # Multi-line cell text: each WS on its own pair of lines (label + hours),
                # in the Schedule's top→bottom order. The top WS (raw key) drives the cell
                # color, matching the screen where the dominant WS tints the box.
                text = "\n".join(f"{e['label']}\n{e['hh']:.1f}h" for _, e in top)
                agg[iso] = {"text": text, "ws_name": top[0][0]}
            if agg:
                row_specs.append((task_name, agg))
        elif mode == "ws":
            # One row per WS: aggregated hours of that WS per day (WORK mode).
            for w in wslist:
                wname = w.get("ws", "")
                wlabel = _ws_sub_label(wname, w.get("subarea"))
                agg: dict[str, dict] = {}
                for dr in w.get("desc_rows", []):
                    for iso, cell in (dr.get("cells") or {}).items():
                        h = float(cell.get("hh") or 0)
                        e = agg.get(iso)
                        if e:
                            e["hh"] += h
                        else:
                            agg[iso] = {"hh": h, "label": "", "ws_name": wname}
                row_specs.append((wlabel, agg))
        else:
            # FULL: one row per (WS, descrição); cell = descrição + hours.
            # Aggregate desc_rows by DESCRIÇÃO first (multiple Part Numbers share one
            # Description in the payload as separate desc_rows) and SUM their hours per
            # day — mirrors the worker's `byDesc` merge exactly, so a Part Number never
            # produces its own export box when the UI already aggregated it.
            for w in wslist:
                wname = w.get("ws", "")
                wlabel = _ws_sub_label(wname, w.get("subarea"))
                by_desc: dict[str, dict] = {}   # desc → iso→cell info
                desc_order: list[str] = []
                for dr in w.get("desc_rows", []):
                    desc = dr.get("desc", "") or ""
                    cm = by_desc.get(desc)
                    if cm is None:
                        cm = {}
                        by_desc[desc] = cm
                        desc_order.append(desc)
                    for iso, cell in (dr.get("cells") or {}).items():
                        h = float(cell.get("hh") or 0)
                        e = cm.get(iso)
                        if e:
                            e["hh"] += h
                        else:
                            cm[iso] = {"hh": h, "label": desc, "ws_name": wname}
                # In FULL the WS label column repeats per (unique) descrição row.
                for desc in desc_order:
                    row_specs.append((wlabel, by_desc[desc]))

        if not row_specs:
            continue

        n_rows = len(row_specs)
        for ri, (ws_label, cellmap) in enumerate(row_specs):
            r = current_row
            ws_gantt.row_dimensions[r].height = 28
            first_in_group = (ri == 0)
            for col_num, val in [
                (1, ""),
                (2, wo if first_in_group else ""),
                (3, task_name if first_in_group else ""),
                (4, ws_label),
            ]:
                c = ws_gantt.cell(r, col_num, val)
                c.font = BOLD8
                c.alignment = CENTER if col_num == 1 else LEFT
                c.border = BORDER; c.fill = bg_fill
            _write_day_cells(r, cellmap, bg_fill)
            current_row += 1

        if n_rows > 1:
            end_row = start_row + n_rows - 1
            for col_num in [1, 2, 3]:
                ws_gantt.merge_cells(
                    start_row=start_row, start_column=col_num,
                    end_row=end_row, end_column=col_num,
                )
                ws_gantt.cell(start_row, col_num).alignment = Alignment(
                    horizontal="left" if col_num >= 2 else "center",
                    vertical="center", wrap_text=True,
                )

    ws_gantt.column_dimensions["A"].width = 7
    ws_gantt.column_dimensions["B"].width = 22
    ws_gantt.column_dimensions["C"].width = 13
    ws_gantt.column_dimensions["D"].width = 12
    for i, d in enumerate(dates):
        letter = get_column_letter(COL_OFFSET + 1 + i)
        ws_gantt.column_dimensions[letter].width = 5 if d.get("is_weekend") else 15
    ws_gantt.freeze_panes = "E3"

    buf = io.BytesIO()
    wb_out.save(buf)
    return buf.getvalue()


def build_gantt_excel_from_scenario_bytes(
    file_bytes: bytes,
    date_from: str | None = None,
    date_to: str | None = None,
    lines: list[str] | None = None,
) -> bytes:
    """
    Gera o Excel do Gantt a partir de um arquivo de cenário (Schedule-MS Excel).
    Usa a mesma lógica de build_gantt_data_from_scenario_excel para carregar os dados,
    depois chama build_gantt_excel com os dados pré-carregados.
    """
    import io as _io
    import openpyxl as _opx
    from collections import defaultdict as _dd

    wb = _opx.load_workbook(_io.BytesIO(file_bytes), read_only=True, data_only=True)
    _available = list(wb.sheetnames)
    _sm_sheet = next((s for s in _SHEETS_MS if s in _available), None)
    if _sm_sheet is None:
        raise ValueError(
            f"Aba Schedule não encontrada. Esperado: {_SHEETS_MS}. Disponível: {_available}"
        )
    ws_ms = wb[_sm_sheet]
    ms_rows = list(ws_ms.iter_rows(values_only=True))
    if not ms_rows:
        raise ValueError("Planilha Schedule - MS está vazia.")
    ms_hdr = [_norm(c) for c in ms_rows[0]]

    # Accent/case-insensitive column matching with PT/EN fallbacks (Start→Início,
    # Finish→Término). Errors list only the missing required columns, not the sheet's.
    _cols = _resolve_scenario_columns(ms_hdr)
    i_wo, i_tn, i_sm, i_tk, i_ln, i_fn, i_ct = (
        _cols["wo"], _cols["tn"], _cols["sm"], _cols["tk"], _cols["ln"], _cols["fn"], _cols["ct"])

    ms_by_wo: dict = _dd(list)
    for row in ms_rows[1:]:
        wo = _norm(row[i_wo]) if len(row) > i_wo else ""
        if not wo:
            continue
        raw = row[i_sm] if i_sm >= 0 and len(row) > i_sm else None
        start_dt = raw.date() if isinstance(raw, datetime) else (raw if isinstance(raw, date) else None)
        fn_raw = row[i_fn] if i_fn >= 0 and len(row) > i_fn else None
        fn_str = (
            fn_raw.date().isoformat() if hasattr(fn_raw, "date")
            else (str(fn_raw).strip() if fn_raw is not None else "")
        )
        _tk_val = _safe_float(row[i_tk]) if len(row) > i_tk else None
        ms_by_wo[wo].append({
            "task_name": _norm(row[i_tn]) if len(row) > i_tn else "",
            "start_ms":  start_dt,
            "takt":      _tk_val or 1.0,
            "takt_raw":  _tk_val,
            "linha":     _norm(row[i_ln]) if i_ln >= 0 and len(row) > i_ln else "",
            "finish_ms": fn_str,
            "contract_ms": _parse_excel_date_raw(row[i_ct] if i_ct >= 0 and len(row) > i_ct else None),
        })
    wb.close()

    # Load LocosRout from DB
    rt_rows: list = []
    try:
        from database import get_db
        from models import LocosRout as _LR, get_active_ver as _gav
        with get_db() as _db:
            _lr_ver  = _gav(_db, "locos_rout")
            _lr_rows = _db.query(_LR).filter(_LR.ver == _lr_ver).all()
            if _lr_rows:
                rt_rows = [["LOCOMOTIVA", "PART NUMBER", "WORKSTATION", "SUBAREA", "AREA",
                             "HH UNIT", "QTD", "DURACAO", "INICIO", "DESCRIÇÃO", "WORKORDER",
                             "PART DESC", "ESCOPO", "LINHA"]]
                for _r in _lr_rows:
                    rt_rows.append([
                        getattr(_r, "locomotiva",  "") or "",
                        getattr(_r, "part_number", "") or "",
                        getattr(_r, "workstation", "") or "",
                        getattr(_r, "subarea",     "") or "",
                        getattr(_r, "area",        "") or "",
                        getattr(_r, "hh_unit",     0)  or 0,
                        getattr(_r, "qtd",         0)  or 0,
                        getattr(_r, "duracao",     "") or "",
                        getattr(_r, "inicio",      "") or "",
                        getattr(_r, "descricao",   "") or "",
                        getattr(_r, "workorder",   "") or "",
                        getattr(_r, "part_desc",   "") or "",
                        getattr(_r, "escopo",      "") or "",
                        getattr(_r, "linha",       "") or "",
                    ])
    except Exception:
        pass
    if not rt_rows:
        raise RuntimeError(
            "LocosRout não encontrado no banco. "
            "Importe a tabela de roteamento antes de usar Simular Cenário."
        )

    return build_gantt_excel(
        date_from=date_from, date_to=date_to, lines=lines,
        _ms_by_wo=ms_by_wo, _rt_rows=rt_rows,
    )
