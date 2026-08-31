"""
calendar_445.py
---------------
Shared fiscal-calendar engine — the single source of truth consumed by BOTH
applications:

  • Carga de Fábrica (Schedule / Gantt)  → gantt_builder.py
  • Análise de Capacidade                → services/data_loader.py

It unifies three concerns that used to live in two places (gantt_builder's
`_semana_fw` / holiday logic, and the pre-baked WEEK_1/DAYS_1 columns of the
Discretizado Excel sheet):

  1. Fiscal-week numbering  → fw_of(date)            (Jan-1, 7-day buckets)
  2. Working-day logic      → build_br_holidays(...) (B3 holidays + bridge days)
  3. 4-4-5 period structure → fiscal_month_of_fw(fw) (weeks → fiscal month)
                              working_days_in_fw(...) (DAYS_1 equivalent)

Pure date logic only — NO database / Excel / pandas imports — so it can be
imported freely from any module without pulling heavy deps or cycles.

4-4-5 pattern, anchored at FW1 = Jan 1: Jan=4 weeks, Feb=4 weeks, Mar=5 weeks,
then the 13-week quarter repeats; Dec holds the remaining weeks up to FW53 and
the count resets to FW01 on the next Jan 1. fw_of() + build_br_holidays() are
the existing, correct Schedule/Gantt calendar (B3 holidays + networkdays); the
manual Excel calendar in the Capacity sheet was the wrong one. The two agree on
working-days for 17 of 18 weeks present in the source; FW9 differs (Excel=4 vs
engine=5) and the engine value is authoritative.
"""

from __future__ import annotations

from datetime import date, timedelta


# ── Admin-editable override registry (DB-free by design) ────────────────────
# calendar_445 stays a PURE date module (no DB/pandas imports — see header). The
# admin-configurable exceptions live in the `calendar_override` table; an external
# loader (main._load_calendar_overrides) reads them and pushes a plain {date: kind}
# snapshot in via set_overrides(). The pure functions below then fold that snapshot
# into the holiday set and the working-day predicate, so every consumer (Schedule
# geometry, conflict optimizer, Capacity period-days, KPIs) honors admin edits from
# a SINGLE source without calendar_445 ever touching the database.
#
#   kind == 'holiday' → force the date NON-WORKING (added to the holiday set).
#   kind == 'working' → force the date WORKING (removed from the holiday set;
#                        reported working even on Sat/Sun).
_OVERRIDES: dict[date, str] = {}
_OVERRIDES_VERSION: int = 0

# ── Fiscal-week LABEL offset registry (per calendar year) ───────────────────
# Some fiscal years must not start on FW01 — e.g. 2027's first week belongs to the
# previous fiscal year as FW52. `_FW_OFFSETS[year]` is a signed integer ADDED to every
# week's label in that year (default 0). It is a display/label transform only: the raw
# 7-day bucketing (fw_of) that drives working-day counts and the 4-4-5 grouping is left
# untouched, so Capacity/KPIs never shift. A uniform per-year offset is the only fiscal-week
# edit that preserves week-sequence consistency (see models.FiscalWeekOverride).
_FW_OFFSETS: dict[int, int] = {}


def set_fw_offsets(mapping: dict, version: int = 0) -> None:
    """Replace the active per-year fiscal-week label offsets.

    `mapping` maps calendar year (int) → signed offset (int); zero offsets are dropped.
    Shares the override version token so callers embedding overrides_version() in cache
    keys also invalidate on a fiscal-week change. Pass the same `version` used for
    set_overrides() at the same reload."""
    global _FW_OFFSETS, _OVERRIDES_VERSION
    norm: dict[int, int] = {}
    for y, off in (mapping or {}).items():
        try:
            yi, oi = int(y), int(off)
        except (TypeError, ValueError):
            continue
        if oi:
            norm[yi] = oi
    _FW_OFFSETS = norm
    if version:
        _OVERRIDES_VERSION = int(version)


def fw_offset_for_year(year: int) -> int:
    """Signed fiscal-week label offset configured for `year` (0 when none)."""
    return _FW_OFFSETS.get(int(year), 0)


def set_overrides(mapping: dict, version: int = 0) -> None:
    """Replace the active override snapshot and bust the holiday cache.

    `mapping` maps datetime.date → 'holiday' | 'working'. Called at startup and on
    every admin calendar mutation. Clearing _BR_HOLIDAYS_CACHE is mandatory because
    the cached holiday frozensets now depend on the override snapshot.
    """
    global _OVERRIDES, _OVERRIDES_VERSION
    norm: dict[date, str] = {}
    for d, kind in (mapping or {}).items():
        if not isinstance(d, date):
            continue
        k = str(kind).strip().lower()
        if k in ("holiday", "working"):
            norm[d] = k
    _OVERRIDES = norm
    _OVERRIDES_VERSION = int(version)
    _BR_HOLIDAYS_CACHE.clear()


def overrides_version() -> int:
    """Monotonic token bumped whenever the override snapshot is replaced.
    Callers embed it in cache keys so stale computed calendars are invalidated."""
    return _OVERRIDES_VERSION


# ── Easter / Brazilian holidays ─────────────────────────────────────────────

def _easter_date(y: int) -> date:
    """Compute Easter Sunday (Gregorian)."""
    a = y % 19; b = y // 100; c = y % 100
    d = b // 4; e = b % 4; f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day   = (h + l - 7 * m + 114) % 31 + 1
    return date(y, month, day)


def build_br_holidays(years: set) -> set:
    """Return set[date] of Brazilian public holidays (national + bridge days).

    Moved verbatim from gantt_builder._build_br_holidays so both apps share the
    exact same holiday set. Changing this set affects Schedule AND Capacity.
    """
    h: set = set()
    # B3-specific extras
    for iso in ('2027-02-10', '2026-10-22', '2027-10-28', '2028-10-26'):
        try:
            h.add(date.fromisoformat(iso))
        except ValueError:
            pass
    for y in years:
        for mo, dy in [(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2),
                       (11, 15), (11, 20), (12, 24), (12, 25), (12, 31)]:
            try:
                h.add(date(y, mo, dy))
            except ValueError:
                pass
        e = _easter_date(y)
        h.add(e - timedelta(days=48))  # Segunda de Carnaval
        h.add(e - timedelta(days=47))  # Terça de Carnaval
        h.add(e - timedelta(days=2))   # Sexta-feira Santa
        h.add(e + timedelta(days=60))  # Corpus Christi
    # Bridge rule
    bridge: list = []
    for d in list(h):
        dow = d.weekday()  # 0=Mon ... 6=Sun
        if dow == 1:  # Tuesday → add Monday
            bridge.append(d - timedelta(days=1))
        if dow == 3:  # Thursday → add Friday
            bridge.append(d + timedelta(days=1))
    h.update(bridge)
    # Admin overrides (applied LAST so they win over the algorithmic base + bridges):
    #   'holiday' → force the date into the holiday set;
    #   'working' → remove it (an exceptional working day / cancelled auto-holiday).
    for d, kind in _OVERRIDES.items():
        if d.year not in years:
            continue
        if kind == "holiday":
            h.add(d)
        elif kind == "working":
            h.discard(d)
    return h


_BR_HOLIDAYS_CACHE: dict = {}  # year-range key → frozenset[date]


def get_holidays_for_dates(dates_iterable) -> frozenset:
    """Build/cache holiday set for the years present in dates_iterable."""
    years: set = set()
    for d in dates_iterable:
        years.add(d.year)
    key = frozenset(years)
    if key not in _BR_HOLIDAYS_CACHE:
        _BR_HOLIDAYS_CACHE[key] = frozenset(build_br_holidays(years))
    return _BR_HOLIDAYS_CACHE[key]


def holidays_for_year(year: int) -> frozenset:
    """Cached holiday frozenset for a single calendar year."""
    return get_holidays_for_dates([date(year, 1, 1), date(year, 12, 31)])


# ── Working-day predicates (override-aware, single source of truth) ─────────

def is_forced_working(d: date) -> bool:
    """True if an admin override forces this date to be a working day (e.g. an
    exceptional Saturday). Lets weekend-rendering code treat the day as working."""
    return _OVERRIDES.get(d) == "working"


def is_working_day(d: date) -> bool:
    """Canonical working-day test used for ALL working-day counts.

    A 'working' override wins outright (exceptional Saturday/Sunday). Otherwise the
    day is working iff it is Mon-Fri AND not in the holiday set (which already folds
    in 'holiday' overrides and cancels 'working'-override auto-holidays)."""
    ov = _OVERRIDES.get(d)
    if ov == "working":
        return True
    if ov == "holiday":
        return False
    return d.weekday() < 5 and d not in holidays_for_year(d.year)


def is_holiday_day(d: date) -> bool:
    """True if the date is NON-WORKING for a holiday reason (not a plain weekend).

    Covers weekday public/company holidays AND a working weekday converted to a day
    off. A normal Sat/Sun is a weekend, not a holiday, so it returns False; a
    forced-working day returns False (it is a working day)."""
    if is_forced_working(d):
        return False
    if d.weekday() >= 5:
        return False  # plain weekend — reported via the weekend flag, not holiday
    return d in holidays_for_year(d.year)


# ── Fiscal-week numbering (Jan-1, 7-day buckets) ────────────────────────────

def fw_of(d: date) -> int:
    """Fiscal-week NUMBER for a date.

    FW01 always starts on Jan 1 of d's calendar year. Weeks are Monday-anchored
    but the first week begins on Jan 1 regardless of weekday.
        fw = (days_since_jan1 + jan1.weekday()) // 7 + 1
    Examples: 01/01/2027 (Fri) → 1, 04/01/2027 (Mon) → 2.

    This is the numbering gantt_builder._semana_fw used; it now lives here so
    Capacity and Schedule share one definition. _semana_fw wraps this and adds
    the "FW%02d" formatting.
    """
    jan1 = date(d.year, 1, 1)
    fw = (d - jan1).days + jan1.weekday()
    return fw // 7 + 1

# Fiscal years are canonically 52 weeks; offset labels wrap on this so an FW01 pushed back
# by one lands on FW52 (the previous fiscal year's last week), matching the 2027 requirement.
FISCAL_WEEKS_PER_YEAR = 52


def weeks_in_year(year: int) -> int:
    """Number of raw fiscal weeks the year spans (52 or 53), i.e. fw_of(Dec 31)."""
    return fw_of(date(year, 12, 31))


def fw_display_number(d: date) -> int:
    """Displayed fiscal-week NUMBER for a date, honoring the per-year label offset.

    Equals fw_of(d) when the year has no override. With an offset, every week's label is
    shifted uniformly and wraps into 1..52 so a week pushed before FW01 rolls into the
    previous fiscal year's tail (e.g. FW01 with offset -1 → FW52) and the whole year
    cascades, preserving sequence. Label-only — fw_of() (bucketing) is unchanged."""
    raw = fw_of(d)
    off = fw_offset_for_year(d.year)
    if not off:
        return raw
    return ((raw + off - 1) % FISCAL_WEEKS_PER_YEAR) + 1


def fw_label(d: date) -> str:
    """Formatted fiscal week, e.g. "FW09" — matches the Schedule/Gantt label.
    Honors the admin per-year fiscal-week label offset (fw_display_number)."""
    return f"FW{fw_display_number(d):02d}"


def fw_label_for_raw(year: int, raw_fw: int) -> str:
    """Formatted fiscal-week label for a RAW week number in `year`, applying that year's
    label offset (same wrap-on-52 rule as fw_display_number). raw_fw with no offset is shown
    as-is (so a genuine 53rd week stays FW53)."""
    off = fw_offset_for_year(year)
    n = ((raw_fw + off - 1) % FISCAL_WEEKS_PER_YEAR) + 1 if off else raw_fw
    return f"FW{n:02d}"


def raw_fw_of_display(display_fw: int, year: int) -> int:
    """Inverse of fw_display_number: the RAW week whose displayed label in `year` is
    `display_fw`. Identity when the year has no override. Used by the FW-LABEL → working-days
    path so a label resolves to the raw week the override maps it to (e.g. 2027 FW01 with
    offset -1 → raw week 2, i.e. Jan 4-10) — keeping day counts consistent with the shifted
    labels shown everywhere else. No offset ⇒ label == raw ⇒ zero change for normal years."""
    off = fw_offset_for_year(year)
    if not off:
        return display_fw
    return ((display_fw - off - 1) % FISCAL_WEEKS_PER_YEAR) + 1


# ── 4-4-5 period structure (weeks → fiscal month) ───────────────────────────

# 4-4-5 weeks-per-fiscal-month, anchored at FW1 = Jan 1:
#   month 1 (Jan) = 4 weeks  → FW1-4
#   month 2 (Feb) = 4 weeks  → FW5-8
#   month 3 (Mar) = 5 weeks  → FW9-13
# then the 4-4-5 quarter (13 weeks) repeats: Apr/May=4wk, Jun=5wk, …
# Dec holds the remaining weeks up to FW53; on Jan 1 the count resets to FW01.
_QUARTER_PATTERN = (4, 4, 5)


def fiscal_month_of_fw(fw: int) -> int:
    """Map a fiscal-week NUMBER to its 4-4-5 fiscal month, anchored at FW1.

    FW1-4 → month 1 (Jan, 4 weeks), FW5-8 → month 2 (Feb, 4 weeks),
    FW9-13 → month 3 (Mar, 5 weeks), then the 4-4-5 / 13-week quarter repeats.
    """
    # Position within the year's 13-week quarters (FW1 = position 0).
    q, wk_in_q = divmod(fw - 1, 13)
    # Walk the 4-4-5 pattern to find which month inside the quarter.
    month_in_q = len(_QUARTER_PATTERN) - 1
    acc = 0
    for i, n in enumerate(_QUARTER_PATTERN):
        if wk_in_q < acc + n:
            month_in_q = i
            break
        acc += n
    return q * 3 + month_in_q + 1


def _first_day_of_fw(year: int, fw: int) -> date:
    """Calendar date of the first day of fiscal week `fw` in `year`.

    Inverse of fw_of(): FW1 starts on Jan 1; each subsequent week starts on the
    Monday that fw_of() rolls over on.
    """
    jan1 = date(year, 1, 1)
    # fw_of(jan1) == 1. Days from Jan 1 to the start of week `fw`:
    #   week 1 spans Jan1 .. (Sunday of that partial week); week 2 starts next Mon.
    # Start offset = (fw-1)*7 - jan1.weekday(), clamped so FW1 starts at Jan 1.
    offset = (fw - 1) * 7 - jan1.weekday()
    if offset < 0:
        offset = 0
    return jan1 + timedelta(days=offset)


def working_dates_in_fw(year: int, fw: int) -> list:
    """The actual working DATES of fiscal week `fw` — same rule as working_days_in_fw,
    which is defined as the length of this list. Callers that need to intersect the period
    with dated data (vacation/leave ranges) need the dates, not just the count."""
    start = _first_day_of_fw(year, fw)
    out: list = []
    d = start
    # Walk forward while still inside this fiscal week (bounded: <= 7 days).
    while d.year == year and fw_of(d) == fw:
        if d.weekday() < 5 and is_working_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def working_days_in_fw(year: int, fw: int) -> int:
    """Number of working days (Mon-Fri minus B3 holidays) in fiscal week `fw`.

    Engine replacement for the Excel DAYS_1 column. Counts the calendar days
    whose fw_of() equals `fw` and which are business days. Matches the Excel
    DAYS_1 for 17/18 weeks (FW9 is the documented 1-day delta).

    WEEKEND OVERRIDES ARE NOT COUNTED. An admin-declared working Saturday/Sunday is an
    EXTRA day granted on top of the normal week, not part of the standard working-day
    budget — counting it would inflate this week (and its 4-4-5 month) from e.g. 5 to 6
    and silently raise every downstream capacity/KPI figure derived from it. The weekday
    direction of the override still applies both ways: a weekday converted to a company
    holiday drops out, and a 'working' override that cancels an auto-holiday counts again.
    """
    return len(working_dates_in_fw(year, fw))


def fiscal_month_summaries(year: int) -> list[dict]:
    """Per 4-4-5 FISCAL month (1-12) of `year`: its fiscal-week range + working days.

    This is the 4-4-5 replacement for a Gregorian month summary. Each fiscal month spans a
    fixed block of RAW weeks anchored at FW1 (4,4,5 per quarter): month 1 = weeks 1-4, month
    2 = 5-8, month 3 = 9-13, … December (month 12) additionally absorbs a 53rd week when the
    year has one. Returns, per month:
        { month, fw_start, fw_end, weeks, working_days }
    where fw_start/fw_end are DISPLAY labels honoring the per-year fiscal-week offset, and
    working_days sums working_days_in_fw over the block — so holidays and BOTH override kinds
    (day overrides via is_working_day, and the fiscal-week label offset) are respected. The
    caller recomputes this after every calendar save (the engine snapshot is reloaded first)."""
    total = weeks_in_year(year)
    out: list[dict] = []
    start = 1
    for m in range(1, 13):
        cnt = _QUARTER_PATTERN[(m - 1) % 3]
        end = start + cnt - 1
        if m == 12 and total > end:
            end = total  # a 53rd raw week rolls up into December
        working = sum(working_days_in_fw(year, fw) for fw in range(start, end + 1))
        out.append({
            "month":        m,
            "fw_start":     fw_label_for_raw(year, start),
            "fw_end":       fw_label_for_raw(year, end),
            "weeks":        end - start + 1,
            "working_days": working,
        })
        start = end + 1
    return out


# ── Aggregate helper for Capacity's period-days calc ────────────────────────

def days_by_fw(fws, year: int | None = None) -> dict[str, int]:
    """Return { fw_str: working_days } for the requested fiscal weeks.

    `fws` is an iterable of FW identifiers (e.g. ["9", "FW10", 11]); each is
    normalised to its integer key and counted once. This is the engine-computed
    replacement for summing the Excel WEEK_1/DAYS_1 columns in get_period_days().

    `year` defaults to the current calendar year when not supplied. Capacity's
    demand rows are single-year scoped, so the caller may pass the active year
    explicitly to avoid ambiguity across year boundaries.
    """
    if year is None:
        year = date.today().year
    out: dict[str, int] = {}
    for raw in fws:
        key = _fw_key(raw)
        if not key or key in out:
            continue
        try:
            fw_int = int(key)
        except ValueError:
            continue
        # `fw_int` is a DISPLAY label; resolve it to the raw week the override maps it to so
        # the day count matches the shifted labels used everywhere else (identity if no override).
        out[key] = working_days_in_fw(year, raw_fw_of_display(fw_int, year))
    return out


def days_by_fw_for_years(fws, year_by_fw: dict, default_year: int | None = None) -> dict[str, int]:
    """Like days_by_fw, but each fiscal week uses its OWN year.

    `year_by_fw` maps normalized FW key (e.g. "9") → calendar year, derived from
    the demand data's ANO column. This makes the FW→date mapping exact even when
    a period spans two fiscal years. FWs absent from the map fall back to
    `default_year` (current year if None).
    """
    if default_year is None:
        default_year = date.today().year
    out: dict[str, int] = {}
    for raw in fws:
        key = _fw_key(raw)
        if not key or key in out:
            continue
        try:
            fw_int = int(key)
        except ValueError:
            continue
        yr = year_by_fw.get(key, default_year)
        # DISPLAY label → raw week for that year (identity when the year has no override).
        out[key] = working_days_in_fw(yr, raw_fw_of_display(fw_int, yr))
    return out


def _fw_key(v) -> str:
    """Normalize an FW value to a clean integer string.
    Mirrors data_loader._fw_key / import_excel_to_db._fw_key so all three agree.
    """
    import re
    m = re.search(r'(\d+)', str(v))
    return str(int(m.group(1))) if m else str(v).strip()
