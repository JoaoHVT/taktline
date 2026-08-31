"""
services/assembly_details.py
-----------------------------
Per-scope breakdown for a list of items.

Two-step architecture (mirrors CapB3356103.py AssemblyWidget):
  1. Demand qty  → ITEM column rows, filtered by period (mes/FW)
  2. Hours & WSN → ASSEMBLY column rows (full dataset, all periods)
     mirroring build_widget_rows() which groups by COMPONENT and uses
     escolher_escopo() to select the best scope rows.

If an item has no ASSEMBLY lookup rows (rare), falls back to computing
hours directly from the ITEM demand rows (HH × QTDE_FW per FW).

Allocations (allocations.json) are applied to redistribute the demand
qty across scopes even when only one scope is present in the period.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd

from services.data_loader import _normalize, _safe_float, _find_col, _fw_key, _build_assembly_desc_map

# ── Scope constants (mirror WAB colour order from CapB3356103.py) ─────────────

SCOPE_ORDER: list[str] = ["LEVE", "MEDIO", "PESADO", "UNICO"]

# Mirrors escolher_escopo() fallback chain in CapB3356103.py
_SCOPE_FALLBACK: dict[str, list[str]] = {
    "LEVE":   ["LEVE"],
    "MEDIO":  ["MEDIO", "LEVE"],
    "PESADO": ["PESADO", "MEDIO", "LEVE"],
    "UNICO":  ["UNICO"],
}


def _normalize_tipo_fw(value: object) -> str:
    """
    Normalise a TIPO / TIPO FW value to a canonical string.
    Mirrors CapB3356103.py _normalize_tipo_fw_value().
    """
    txt = _normalize(str(value or "").strip())
    if not txt:
        return ""
    if "mont" in txt:
        return "MONTAGEM"
    if "perit" in txt:
        return "PERITAGEM"
    return txt.upper()


def _canonicalize_escopo_norm(val_norm: str) -> str:
    """
    Map any normalized ESCOPO string to the canonical scope name (lowercase).
    Handles plain values ('leve') and compound values ('escopo leve') → 'leve'.
    Returns '' if no recognized scope is found — these rows are excluded from
    the tipo_fw_scope_qty_map so the lookup keys always match _normalize(scope).
    """
    for scope in SCOPE_ORDER:
        scope_n = _normalize(scope)
        if val_norm == scope_n or val_norm.endswith(" " + scope_n):
            return scope_n
    return ""


def _build_tipo_fw_scope_qty_map(
    df_item:     "pd.DataFrame",
    col_tipo_fw: str | None,
    col_qty:     str | None,
    col_fw:      str | None,
    col_escopo:  str | None,
) -> dict[tuple[str, str], float]:
    """
    Build {(scope_norm, tipo_norm): qty} from period-filtered ITEM demand rows.

    This gives the demand quantity SPECIFIC TO each (scope, tipo) combination,
    avoiding the cross-scope inflation that happens when a single total tipo qty
    is applied to all scopes (e.g. TOTAL_MONTAGEM used for both LEVE and PESADO).

    Per (FW, ESCOPO, TIPO): take max QTDE FW, then max across FWs.
    Returns {} when TIPO FW column or ESCOPO column is missing / all blank.
    """
    if not col_tipo_fw or col_tipo_fw not in df_item.columns:
        return {}
    if not col_qty or col_qty not in df_item.columns:
        return {}
    if not col_escopo or col_escopo not in df_item.columns:
        return {}

    df = df_item.copy()
    df["_tipo_norm"]   = df[col_tipo_fw].apply(_normalize_tipo_fw)
    df["_escopo_raw"]  = df[col_escopo].apply(lambda v: _normalize(str(v or "").strip()))
    # Canonicalize to standard scope name so the key always matches _normalize(scope)
    # e.g. 'escopo leve' → 'leve', 'LEVE' → 'leve'.  Rows with unknown escopo are dropped.
    df["_escopo_canon"] = df["_escopo_raw"].apply(_canonicalize_escopo_norm)
    df = df[(df["_tipo_norm"] != "") & (df["_escopo_canon"] != "")]  # drop blank/unknown rows

    if df.empty:
        return {}

    result: dict[tuple[str, str], float] = {}
    if col_fw and col_fw in df.columns:
        # Per (FW, scope_canon, tipo): max QTDE deduplicates op rows within a FW;
        # then SUM across FWs accumulates independent weekly batches.
        for (_, esc, tipo), grp in df.groupby([col_fw, "_escopo_canon", "_tipo_norm"]):
            qty = _safe_float(grp[col_qty].max())
            key = (str(esc), str(tipo))
            result[key] = result.get(key, 0.0) + qty
    else:
        for (esc, tipo), grp in df.groupby(["_escopo_canon", "_tipo_norm"]):
            result[(str(esc), str(tipo))] = _safe_float(grp[col_qty].max())

    return result


def _build_tipo_fw_qty_map(
    df_item:     "pd.DataFrame",
    col_tipo_fw: str | None,
    col_qty:     str | None,
    col_fw:      str | None,
) -> dict[str, float]:
    """
    Build {tipo_norm → total_qty} from period-filtered ITEM demand rows.

    Mirrors CapB3356103.py _build_tipo_fw_qty_map_for_group():
      - per FW per TIPO: take max QTDE FW  (deduplicate repeated operation rows)
      - sum across FWs

    Returns {} when no TIPO FW column is found or all tipo values are blank.
    The returned map is used in _process_item_from_assembly to scale operation
    HH by the demand qty that belongs to that operation's tipo, instead of
    using the inflated total scope qty for every operation regardless of tipo.
    """
    if not col_tipo_fw or col_tipo_fw not in df_item.columns:
        return {}
    if not col_qty or col_qty not in df_item.columns:
        return {}

    df = df_item.copy()
    df["_tipo_norm"] = df[col_tipo_fw].apply(_normalize_tipo_fw)
    df = df[df["_tipo_norm"] != ""]  # drop blank tipos

    if df.empty:
        return {}

    tipo_qty: dict[str, float] = {}
    if col_fw and col_fw in df.columns:
        # per (FW, TIPO): max QTDE deduplicates operation rows within a FW;
        # then SUM across FWs accumulates independent weekly batches.
        for (_, tipo_val), grp in df.groupby([col_fw, "_tipo_norm"]):
            qty = _safe_float(grp[col_qty].max())
            tipo_qty[tipo_val] = tipo_qty.get(tipo_val, 0.0) + qty
    else:
        for tipo_val, grp in df.groupby("_tipo_norm"):
            tipo_qty[tipo_val] = _safe_float(grp[col_qty].max())

    return tipo_qty


def _build_locus_map(df: "pd.DataFrame") -> dict[tuple[str, str], float]:
    """
    Build {(assembly_norm, component_norm): qty_locos} from the spreadsheet.

    Mirrors MainWindow._build_locus_map() in CapB3356103.py.
    Used to multiply hours for items whose family is "NEW LOCOS".
    Reads columns: LOCUS (assembly code), COMP1 (component code), QTDE LOCUS (qty).
    """
    locus_map: dict[tuple[str, str], float] = {}
    col_locus = _find_col(df, ["LOCUS"])
    col_comp1 = _find_col(df, ["COMP1"])
    col_qty   = _find_col(df, ["QTDE LOCUS"])
    if not (col_locus and col_comp1 and col_qty):
        return locus_map
    try:
        tmp = df[[col_locus, col_comp1, col_qty]].dropna()
        tmp = tmp.copy()
        tmp["_locus_norm"] = tmp[col_locus].apply(lambda v: _normalize(str(v or "")))
        tmp["_comp_norm"]  = tmp[col_comp1].apply(lambda v: _normalize(str(v or "")))
        tmp["_qty"]        = pd.to_numeric(tmp[col_qty], errors="coerce").fillna(0.0)
        for _, r in tmp.iterrows():
            loc  = str(r["_locus_norm"])
            comp = str(r["_comp_norm"])
            qty  = float(r["_qty"])
            if loc and comp and qty > 0:
                locus_map[(loc, comp)] = qty
    except Exception:
        pass
    return locus_map


def _build_family_map(df: "pd.DataFrame") -> dict[str, str]:
    """
    Build {item_norm: familia_label} from the spreadsheet ITEM + FAMILIA columns.
    Mirrors MainWindow._build_family_map() in CapB3356103.py.
    """
    fam_map: dict[str, str] = {}
    col_item = _find_col(df, ["ITEM"])
    col_fam  = _find_col(df, ["FAMILIA", "FAMILY"])
    if not (col_item and col_fam):
        return fam_map
    try:
        tmp = df[[col_item, col_fam]].copy()
        tmp[col_item] = tmp[col_item].astype(str).str.strip()
        tmp[col_fam]  = tmp[col_fam].astype(str).str.strip()
        tmp = tmp[(tmp[col_item] != "") & (tmp[col_fam] != "") & (tmp[col_fam] != "nan")]
        for _, r in tmp.iterrows():
            key = _normalize(str(r[col_item]))
            fam = str(r[col_fam]).strip()
            if key and fam and key not in fam_map:
                fam_map[key] = fam
    except Exception:
        pass
    return fam_map


def _detect_scopes_present(scopes_found: list[str]) -> list[str]:
    """
    Mirrors AssemblyWidget._detect_scopes_present():
    If LEVE/MEDIO/PESADO exist, UNICO is hidden.
    Falls back to ["LEVE","MEDIO","PESADO"] when nothing is found.
    """
    non_unique = [s for s in scopes_found if s != "UNICO"]
    if non_unique:
        return non_unique
    if "UNICO" in scopes_found:
        return ["UNICO"]
    return list(SCOPE_ORDER[:3])  # LEVE, MEDIO, PESADO


def _escolher_escopo_python(df_comp: pd.DataFrame, scope: str) -> pd.DataFrame:
    """
    Python port of escolher_escopo() from CapB3356103.py.

    For the requested scope, tries the scope fallback chain and returns
    the matching rows, always appending UNICO rows (if any) unless the
    requested scope is itself UNICO.
    """
    scope_up = scope.strip().upper()
    if "_escopo_norm" not in df_comp.columns:
        return df_comp

    df_unico = df_comp[df_comp["_escopo_norm"] == "unico"]

    for try_scope in _SCOPE_FALLBACK.get(scope_up, ["LEVE", "MEDIO", "PESADO", "UNICO"]):
        try_norm = _normalize(try_scope)
        df_e = df_comp[df_comp["_escopo_norm"] == try_norm]
        if not df_e.empty:
            if try_norm != "unico" and not df_unico.empty:
                return pd.concat([df_e, df_unico], ignore_index=True)
            return df_e

    return df_unico if not df_unico.empty else pd.DataFrame()


def _get_scope_qty_from_demand(
    df_item:    pd.DataFrame,
    col_escopo: str | None,
    col_qty:    str | None,
    col_fw:     str | None,
) -> tuple[dict[str, float], list[str]]:
    """
    Compute demand qty per scope from the period-filtered ITEM rows.
    Returns ({scope: qty}, scopes_found_list).
    """
    scope_qty:    dict[str, float] = {}
    scopes_found: list[str]        = []

    if col_escopo and col_escopo in df_item.columns:
        df_item = df_item.copy()
        df_item["_escopo_norm"] = df_item[col_escopo].apply(
            lambda v: _normalize(str(v or "").strip())
        )
        for scope in SCOPE_ORDER:
            scope_n  = _normalize(scope)
            df_scope = df_item[
                (df_item["_escopo_norm"] == scope_n)
                | df_item["_escopo_norm"].str.endswith(" " + scope_n, na=False)
            ]
            if df_scope.empty:
                continue
            qty = _aggregate_qty(df_scope, col_qty, col_fw)
            scope_qty[scope] = qty
            scopes_found.append(scope)

    # Fallback: treat everything as LEVE (encoding corruption or no ESCOPO col)
    if not scopes_found:
        scope_qty["LEVE"] = _aggregate_qty(df_item, col_qty, col_fw)
        scopes_found = ["LEVE"]

    return scope_qty, scopes_found


def _process_item_from_assembly(
    df_asm:      pd.DataFrame,
    scope_qty:   dict[str, float],
    scopes:      list[str],
    col_escopo:  str | None,
    col_hh:      str | None,
    col_wsn:     str | None,
    col_op:      str | None,
    col_comp:    str | None,
    col_tipo:    str | None = None,
    col_op_num:  str | None = None,
    col_desc:    str | None = None,
    col_op_desc: str | None = None,
    tipo_fw_qty_map: dict[str, float] | None = None,
    tipo_filter: str = "",
    tipo_fw_scope_qty_map: dict[tuple[str, str], float] | None = None,
    locus_map: "dict[tuple[str, str], float] | None" = None,
    item_norm: str = "",
) -> dict[str, dict]:
    """
    Compute hours from ASSEMBLY lookup rows × scope_qty.

    Mirrors build_widget_rows() from CapB3356103.py:
      - Group df_asm by COMPONENT
      - For each scope, use _escolher_escopo_python() to pick the relevant rows
      - total_h = scope_qty × sum(HH per operation row)

    When tipo_fw_scope_qty_map is provided, the effective qty per scope is taken
    from the (scope_norm, tipo_norm) entry in the map, giving accurate per-scope
    allocation for each tipo.  Falls back to tipo_fw_qty_map then scope_qty.

    When tipo_filter is set (non-empty, not "TODOS"), assembly operation rows are
    pre-filtered to only those whose TIPO matches tipo_filter.  This mirrors
    filter_operations_by_tipo_fw() in CapB3356103.py — if no rows match the
    filter, the result is an empty operations list (not a fallback to all rows).
    """
    # ── Pre-filter assembly rows by tipo ───────────────────────────────────────
    # Priority: explicit UI tipo_filter > item's own tipo_fw list > no filter.
    # Mirrors filter_operations_by_tipo_fw() in CapB: when a filter is active,
    # rows that don't match return zero hours (no fallback to all rows).
    tipo_filter_norm = _normalize_tipo_fw(tipo_filter) if tipo_filter else ""
    if tipo_filter_norm == "TODOS":
        tipo_filter_norm = ""
    if col_tipo and col_tipo in df_asm.columns:
        tipo_series = df_asm[col_tipo].apply(_normalize_tipo_fw)
        if tipo_filter_norm:
            # Explicit UI filter: restrict to that single tipo.
            df_asm = df_asm[tipo_series == tipo_filter_norm]
        # NOTE: when no explicit tipo filter is selected, keep ALL assembly
        # operation rows visible in the scope detail table, even for tipos
        # without QTDE FW in the current period. Those rows will be shown with
        # zero effective qty/hours during per-row calculation.

    # Ensure normalised escopo column
    if col_escopo and col_escopo in df_asm.columns and "_escopo_norm" not in df_asm.columns:
        df_asm = df_asm.copy()
        df_asm["_escopo_norm"] = df_asm[col_escopo].apply(
            lambda v: _normalize(str(v or ""))
        )

    # Group by COMPONENT (if column exists); otherwise treat all rows as one group
    if col_comp and col_comp in df_asm.columns:
        component_groups = list(df_asm.groupby(col_comp, sort=False))
        # Put the parent assembly component (COMPONENT == item_norm) first so it
        # always renders at the top of the detail table, before sub-components.
        if item_norm:
            _parent_idx = next(
                (i for i, (k, _) in enumerate(component_groups)
                 if _normalize(str(k or "")) == item_norm),
                None,
            )
            if _parent_idx is not None and _parent_idx > 0:
                component_groups.insert(0, component_groups.pop(_parent_idx))
    else:
        component_groups = [("_all_", df_asm)]

    # Build component → description map from the assembly rows
    comp_desc_map: dict[str, str] = {}
    if col_desc and col_desc in df_asm.columns and col_comp and col_comp in df_asm.columns:
        for _ck, _cg in df_asm.groupby(col_comp, sort=False):
            _ck_str = str(_ck).strip()
            if not _ck_str:
                continue
            for _v in _cg[col_desc].dropna():
                _s = str(_v).strip()
                if _s:
                    comp_desc_map[_ck_str] = _s
                    break

    scopes_data: dict[str, dict] = {}

    # ── Compute tipo_filter_norm once for use in all scope loops ─────────────
    tipo_filter_norm = _normalize_tipo_fw(tipo_filter) if tipo_filter else ""
    if tipo_filter_norm == "TODOS":
        tipo_filter_norm = ""

    # When scope-specific tipo demand is unavailable, build a fallback map
    # that allocates each tipo qty to scopes without splitting fractional qty
    # across multiple scopes.
    _global_tipo_scope_qty_map: dict[tuple[str, str], float] = {}
    if tipo_fw_qty_map:
        _active_scopes = [s for s in scopes if scope_qty.get(s, 0.0) > 0]
        if not _active_scopes:
            _active_scopes = list(scopes)
        _weights = {s: float(scope_qty.get(s, 0.0)) for s in _active_scopes}
        for _tipo_key, _qty_val in tipo_fw_qty_map.items():
            _tipo = str(_tipo_key or "")
            if not _tipo:
                continue
            _dist = _distribute_qty_fractional_no_split(
                float(_qty_val), _active_scopes, _weights
            )
            for _sc, _q in _dist.items():
                if _q > 0:
                    _global_tipo_scope_qty_map[(_normalize(_sc), _tipo)] = float(_q)

    for scope in scopes:
        qty = scope_qty.get(scope, 0.0)
        scope_norm = _normalize(scope)

        # ── Effective qty per scope ───────────────────────────────────────────
        # Always start from the allocation-adjusted scope qty.  tipo_fw_scope_qty_map
        # stores RAW summed-across-FWs quantities which may be larger than the
        # allocated qty (e.g. 2 FWs × 3 items = 6 raw, but 50% allocation = 3 final).
        # We must NEVER use raw map values directly as qty — always scale them as a
        # fraction of the scope's raw max against the allocated qty.
        #
        # Precompute the scope-level max raw qty (= max tipo value for this scope):
        # this equals scope_qty_raw[scope] and is the denominator for all fractions.
        _scope_raw_qty: float = (
            max(
                (v for (s, _t), v in tipo_fw_scope_qty_map.items() if s == scope_norm),
                default=0.0,
            )
            if tipo_fw_scope_qty_map
            else 0.0
        )
        # Sum of ALL tipo entries for this scope.  Differs from _scope_raw_qty when
        # multiple tipos share the same FW (sum > max) or when some demand FWs have
        # blank TIPO_FW (sum < effective_qty_scope → tipless_demand > 0).
        _scope_tipo_sum: float = (
            sum(v for (s, _t), v in tipo_fw_scope_qty_map.items() if s == scope_norm)
            if tipo_fw_scope_qty_map
            else 0.0
        )
        # Parallel sum for the global fallback map — covers scopes that have no
        # direct tipo_fw_scope_qty_map entry (e.g. LEVE when demand is labelled
        # PESADO but allocation redistributes qty to LEVE).  Tipless demand from
        # FWs with blank TIPO_FW is absent from _global_tipo_scope_qty_map (those
        # rows are excluded at build time), so the gap between effective_qty_scope
        # and this sum is exactly the tipless portion that must flow through every
        # assembly operation — mirroring the _scope_tipo_sum logic above.
        _scope_global_tipo_sum: float = (
            sum(v for (s, _t), v in _global_tipo_scope_qty_map.items() if s == scope_norm)
            if _global_tipo_scope_qty_map
            else 0.0
        )

        effective_qty_scope: float = qty  # default — overridden below for tipo filter

        if tipo_filter_norm:
            if tipo_fw_qty_map and tipo_filter_norm not in tipo_fw_qty_map:
                # Tipo completely absent from this item's demand → 0 hours
                effective_qty_scope = 0.0
            elif tipo_fw_scope_qty_map:
                eff = tipo_fw_scope_qty_map.get((scope_norm, tipo_filter_norm))
                if eff is not None:
                    # Preserve per-scope tipo proportions while respecting
                    # allocation-adjusted scope qty.
                    _denom = max(_scope_raw_qty, qty)
                    effective_qty_scope = (
                        qty * float(eff) / _denom
                    ) if _denom > 0 else float(eff)
                else:
                    scope_has_tipo_data = any(
                        s == scope_norm for (s, _) in tipo_fw_scope_qty_map
                    )
                    if scope_has_tipo_data:
                        # Scope has tipo data but not for this tipo → 0
                        effective_qty_scope = 0.0
                    elif tipo_fw_qty_map and tipo_filter_norm in tipo_fw_qty_map:
                        # No scope-level tipo split; use per-scope fallback map
                        # that keeps fractional qty in a single scope.
                        effective_qty_scope = float(
                            _global_tipo_scope_qty_map.get((scope_norm, tipo_filter_norm), 0.0)
                        )
                    # else: no scope-level data → keep qty (already set above)
            elif tipo_fw_qty_map and tipo_filter_norm in tipo_fw_qty_map:
                effective_qty_scope = float(
                    _global_tipo_scope_qty_map.get((scope_norm, tipo_filter_norm), 0.0)
                )
            # else: no tipo_fw_scope_qty_map → keep qty (already set above)

        # Precompute for per-row lookup: does tipo_fw_scope_qty_map have entries for
        # this scope?  Used to decide whether "tipo not found" means "use scope total"
        # (no scope data at all) or "truly zero demand for this tipo in this scope".
        _scope_has_tipo_data: bool = (
            bool(tipo_fw_scope_qty_map)
            and any(s == scope_norm for (s, _) in tipo_fw_scope_qty_map)
        )

        total_h = 0.0
        wsn_hours: dict[str, float] = {}
        wsn_ops: dict[str, list[str]] = {}
        operations: list[dict] = []
        op_n = 1

        for _comp_key, df_comp in component_groups:
            df_sel = _escolher_escopo_python(df_comp, scope)
            if df_sel.empty:
                continue
            # Sort operations by OP number (ascending) within this component/scope
            if col_op_num and col_op_num in df_sel.columns:
                df_sel = df_sel.copy()
                df_sel["_op_sort"] = pd.to_numeric(df_sel[col_op_num], errors="coerce").fillna(float("inf"))
                df_sel = df_sel.sort_values("_op_sort").drop(columns=["_op_sort"])
            for _, row in df_sel.iterrows():
                hh = _safe_float(row.get(col_hh) if col_hh else 0.0)

                # NEW LOCOS: apply per-component locus multiplier (mirrors CapB3356103.py)
                locus_mult = 1.0
                if locus_map is not None and item_norm:
                    comp_key_norm = _normalize(str(_comp_key)) if _comp_key != "_all_" else ""
                    locus_mult = float(locus_map.get((item_norm, comp_key_norm), 1.0) or 1.0)
                    if locus_mult <= 0:
                        locus_mult = 1.0
                hh_scaled = hh * locus_mult

                # ── Per-tipo qty: each operation row uses the qty for its own TIPO ──
                # When the demand has explicit TIPO_FW tags:
                #   row_qty = _mq + tipless_demand
                # where _mq  = tipo_fw_scope_qty_map[(scope, tipo)] (tagged demand)
                #       tipless_demand = effective_qty_scope − _scope_tipo_sum
                #                        (FWs whose TIPO_FW is blank; they use ALL ops)
                #
                # When effective_qty_scope ≤ _scope_tipo_sum (allocation cut or
                # same-FW multiple tipos), the original fraction formula applies:
                #   row_qty = effective_qty_scope × _mq / max(_scope_raw_qty, effective)
                #
                # This ensures:
                #   combined(FW1+FW2) == individual(FW1) + individual(FW2)
                # even when some FWs are fully typed and others have blank TIPO_FW.
                row_qty = effective_qty_scope
                if not tipo_filter_norm:
                    _rtv = (row.get(col_tipo) if col_tipo and col_tipo in df_asm.columns
                            else None)
                    if _rtv is not None and pd.notna(_rtv):
                        _rtn = _normalize_tipo_fw(_rtv)
                        if _rtn:
                            if tipo_fw_qty_map and _rtn not in tipo_fw_qty_map:
                                # Tipo exists in assembly but has zero demand for
                                # this item/period → keep row visible with 0 hours.
                                row_qty = 0.0
                            else:
                                _mq = None
                                _denom = 0.0
                                _mq_is_absolute = False
                                _using_global_fallback = False
                                if _scope_has_tipo_data and tipo_fw_scope_qty_map:
                                    _mq = tipo_fw_scope_qty_map.get((scope_norm, _rtn))
                                    _denom = max(_scope_raw_qty, effective_qty_scope)
                                elif tipo_fw_qty_map and _rtn in tipo_fw_qty_map:
                                    _mq = _global_tipo_scope_qty_map.get((scope_norm, _rtn))
                                    _mq_is_absolute = True
                                    _using_global_fallback = True

                                if _mq is not None:
                                    if _mq_is_absolute:
                                        # Add tipless demand: FWs with blank TIPO_FW are
                                        # absent from _global_tipo_scope_qty_map but their
                                        # qty IS counted in effective_qty_scope via the
                                        # per-FW reconciliation loop.  The gap is the tipless
                                        # portion that must flow through every assembly op,
                                        # exactly mirroring the _scope_tipo_sum fix above.
                                        _tipless_global = max(
                                            effective_qty_scope - _scope_global_tipo_sum, 0.0
                                        )
                                        row_qty = float(_mq) + _tipless_global
                                    else:
                                        # Tipless demand: FWs whose TIPO_FW column is blank are
                                        # excluded from tipo_fw_scope_qty_map but still captured
                                        # in scope_qty_asm, so effective_qty_scope may exceed
                                        # _scope_tipo_sum.  Those items carry no tipo restriction
                                        # and must flow through EVERY assembly operation.
                                        _tipless = max(effective_qty_scope - _scope_tipo_sum, 0.0)
                                        if _scope_tipo_sum > 0 and _tipless > 0:
                                            # Tipo-covered portion scales normally (_mq already
                                            # represents the right qty for this tipo); tipless
                                            # portion is added in full to every operation.
                                            row_qty = float(_mq) + _tipless
                                        elif _denom > 0:
                                            row_qty = effective_qty_scope * float(_mq) / _denom
                                        else:
                                            row_qty = float(_mq)
                                elif _scope_has_tipo_data:
                                    # Scope has explicit tipo split and this tipo is absent.
                                    # Tipless demand (FWs without TIPO_FW) still routes through
                                    # all assembly operations regardless of tipo absence.
                                    row_qty = max(effective_qty_scope - _scope_tipo_sum, 0.0)
                                elif _using_global_fallback:
                                    # Global fallback split assigned this tipo to another scope.
                                    row_qty = 0.0
                required = row_qty * hh_scaled
                total_h += required

                # ── WSN aggregation (existing) ────────────────────────────────────
                wsn_str = ""
                if col_wsn:
                    wsn_val = row.get(col_wsn)
                    if pd.notna(wsn_val):
                        wsn_str = str(wsn_val).strip()
                        if wsn_str:
                            wsn_hours[wsn_str] = wsn_hours.get(wsn_str, 0.0) + required
                            if col_op:
                                op_val = row.get(col_op)
                                if pd.notna(op_val):
                                    op_str = str(op_val).strip()
                                    if op_str:
                                        if wsn_str not in wsn_ops:
                                            wsn_ops[wsn_str] = []
                                        if op_str not in wsn_ops[wsn_str]:
                                            wsn_ops[wsn_str].append(op_str)

                # ── Per-operation row for the detail table ─────────────────────────
                comp_str = str(_comp_key).strip() if _comp_key != "_all_" else ""

                # OP number
                op_num_raw = ""
                if col_op_num and col_op_num in df_sel.columns:
                    v = row.get(col_op_num)
                    if pd.notna(v):
                        try:
                            op_num_raw = str(int(float(v)))
                        except Exception:
                            op_num_raw = str(v).strip()

                # Operation name (Escopo de Operação / OPERAÇÃO column)
                op_desc = ""
                if col_op:
                    v = row.get(col_op)
                    if pd.notna(v):
                        op_desc = str(v).strip()

                # Operation description from DESC column (same column CapB shows as WS tooltip and standalone)
                row_op_desc = ""
                if col_op_desc and col_op_desc in df_sel.columns:
                    v = row.get(col_op_desc)
                    if pd.notna(v):
                        row_op_desc = str(v).strip()

                # TIPO
                tipo_str = ""
                if col_tipo and col_tipo in df_sel.columns:
                    v = row.get(col_tipo)
                    if pd.notna(v):
                        tipo_str = str(v).strip()

                operations.append({
                    "n":         op_n,
                    "component": comp_str,
                    "comp_desc": comp_desc_map.get(comp_str, ""),
                    "op":        op_num_raw,
                    "tipo":      tipo_str,
                    "wsn":       wsn_str,
                    "desc":      op_desc,
                    "op_desc":   row_op_desc,
                    "hh_unit":   round(hh_scaled * 100) / 100,
                    "hh_total":  round(required * 100) / 100,
                })
                op_n += 1

        wsns = [
            {"wsn": wsn, "hours": h, "description": ", ".join(wsn_ops.get(wsn, [])[:2])}
            for wsn, h in sorted(wsn_hours.items())
        ]
        qty_out = qty  # always show allocation-adjusted scope qty even when TIPO filter yields 0 h
        scopes_data[scope] = {
            "total_h":        total_h,
            "qty":            qty_out,
            "hours_per_unit": total_h / qty_out if qty_out > 0 else 0.0,
            "wsn_count":      len(wsns),
            "wsns":           wsns,
            "operations":     operations,
        }

    return scopes_data


def _load_allocations(base_dir: Path) -> dict[str, dict[str, float]]:
    """
    Load scope percentage map from allocations.json.
    Format: [{"item": str, "pct": {"LEVE": float, "MEDIO": float, "PESADO": float}}]
    Returns {normalized_item: {"LEVE": pct, ...}}
    """
    candidates = [
        base_dir / "allocations.json",
        base_dir / "output" / "allocations.json",
    ]
    for path in candidates:
        if not path.exists():
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data = [data]
            if not isinstance(data, list):
                continue
            result: dict[str, dict[str, float]] = {}
            for entry in data:
                item_raw = entry.get("item") or entry.get("assembly")
                if not item_raw:
                    continue
                pct_obj = (
                    entry.get("pct")
                    or entry.get("percent")
                    or entry.get("allocation")
                    or {}
                )
                if not isinstance(pct_obj, dict):
                    continue
                pct_clean: dict[str, float] = {}
                for sc, val in pct_obj.items():
                    sc_up = sc.strip().upper()
                    if sc_up in ("LEVE", "MEDIO", "PESADO", "UNICO"):
                        try:
                            pct_clean[sc_up] = float(val)
                        except Exception:
                            pct_clean[sc_up] = 0.0
                if pct_clean:
                    result[_normalize(str(item_raw))] = pct_clean
            return result
        except Exception:
            continue
    return {}


def _distribute_qty(
    total: int,
    scopes: list[str],
    pct_map: dict[str, float],
) -> dict[str, int]:
    """
    Distribute total qty across scopes using allocation percentages.
    Uses the largest-remainder (Hamilton) method to ensure integer totals sum
    correctly — mirrors CapB3356103.py build_widget_rows allocation logic.
    """
    if not scopes:
        return {}
    total_pct = sum(pct_map.get(s, 0.0) for s in scopes)
    if total_pct <= 0:
        # equal distribution
        base_each = total // len(scopes)
        alloc = {s: base_each for s in scopes}
        for s in scopes[: total - sum(alloc.values())]:
            alloc[s] += 1
        return alloc

    alloc: dict[str, int] = {}
    remainders: list[tuple[str, float, float]] = []
    for s in scopes:
        pct   = pct_map.get(s, 0.0)
        share = (pct / total_pct) * total
        base  = math.floor(share)
        alloc[s] = base
        remainders.append((s, share - base, pct))

    remaining       = total - sum(alloc.values())
    remainders_sort = sorted(remainders, key=lambda t: (-t[1], -t[2]))
    for i in range(remaining):
        alloc[remainders_sort[i % len(remainders_sort)][0]] += 1

    return alloc


def _distribute_qty_fractional_no_split(
    total: float,
    scopes: list[str],
    pct_map: dict[str, float],
) -> dict[str, float]:
    """
    Distribute qty across scopes without splitting the fractional remainder.

    Behaviour:
      - integer part: distributed with Hamilton method (_distribute_qty)
      - fractional part: assigned to a single winning scope (highest weight)

    This prevents cases like 0.6 being split as 0.3 + 0.3 across scopes.
    """
    alloc: dict[str, float] = {s: 0.0 for s in scopes}
    if not scopes or total <= 0:
        return alloc
    if len(scopes) == 1:
        alloc[scopes[0]] = float(total)
        return alloc

    int_part = int(math.floor(total + 1e-12))
    frac_part = float(total - int_part)

    int_alloc = _distribute_qty(int_part, scopes, pct_map)
    for s in scopes:
        alloc[s] = float(int_alloc.get(s, 0))

    if frac_part <= 1e-12:
        return alloc

    if "MEDIO" in scopes:
        winner = "MEDIO"
    else:
        total_pct = sum(max(0.0, float(pct_map.get(s, 0.0))) for s in scopes)
        if total_pct <= 0:
            winner = scopes[0]
        else:
            winner = max(
                scopes,
                key=lambda s: (
                    float(pct_map.get(s, 0.0)),
                    -SCOPE_ORDER.index(s) if s in SCOPE_ORDER else -999,
                ),
            )
    alloc[winner] += frac_part
    return alloc


def _hh_x_qty(
    df_s:    pd.DataFrame,
    col_hh:  str | None,
    col_qty: str | None,
    col_fw:  str | None,
) -> float:
    """
    Compute total hours from the Discretizado sheet.

    The HH column stores hours-per-unit for each operation row.
    When period data is present (FW + QTDE FW are populated), the correct
    total is:  sum_over_FWs( sum_HH_per_FW  ×  max_QTDE_FW_per_FW )
    This matches the original AssemblyWidget.build_widget_rows() logic:
        required = qty_effective × hh_unit
        hours_per_scope = sum(required)

    When period data is absent (all FW = NaN), fall back to simple sum(HH).
    """
    if col_hh is None:
        return 0.0
    has_fw  = col_fw  and col_fw  in df_s.columns
    has_qty = col_qty and col_qty in df_s.columns
    if has_fw and has_qty:
        total      = 0.0
        n_groups   = 0
        for _, grp in df_s.groupby(col_fw):   # NaN FW rows are skipped
            qty_val = _safe_float(grp[col_qty].max())
            if qty_val > 0:
                total += _safe_float(grp[col_hh].sum()) * qty_val
                n_groups += 1
        if n_groups > 0:
            return total
        # All FW values were NaN (static rows) — fall back to bare HH sum
    return _safe_float(df_s[col_hh].sum())


def _aggregate_qty(df: pd.DataFrame, col_qty: str | None, col_fw: str | None) -> float:
    """
    Accurate qty: deduplicate operation rows per FW (max QTDE FW per FW),
    then SUM across FWs.  Each FW is an independent production batch; the
    monthly demand is the sum of all weekly batches (mirrors the original
    _resolve_import_qty_total_for_group which accumulates weekly_total across FWs).
    """
    if col_qty is None:
        return 0.0
    if col_fw and col_fw in df.columns:
        # max() per FW removes per-operation row duplication; sum() across FWs accumulates batches
        return _safe_float(df.groupby(col_fw)[col_qty].max().sum())
    return _safe_float(df[col_qty].max())


def _build_wsn_list(
    df_scope: pd.DataFrame,
    col_wsn:  str | None,
    col_hh:   str | None,
    col_op:   str | None,
    col_qty:  str | None = None,
    col_fw:   str | None = None,
) -> list[dict]:
    """Aggregate hours per WSN and collect a short operation description.

    HH is hours-per-unit in this sheet; total = sum over FWs of (HH × QTDE_FW).
    """
    wsns: list[dict] = []
    if col_wsn is None:
        return wsns
    for wsn_key, wsn_grp in df_scope.groupby(col_wsn):
        wsn_str = str(wsn_key).strip()
        if not wsn_str:
            continue
        # hours = HH_per_unit × QTDE_FW, summed across FWs
        wsn_h = _hh_x_qty(wsn_grp, col_hh, col_qty, col_fw)
        wsn_desc = ""
        if col_op and col_op in wsn_grp.columns:
            desc_vals    = wsn_grp[col_op].dropna()
            unique_descs = list(dict.fromkeys(
                str(d).strip() for d in desc_vals if str(d).strip()
            ))
            wsn_desc = ", ".join(unique_descs[:2])
        wsns.append({"wsn": wsn_str, "hours": wsn_h, "description": wsn_desc})
    wsns.sort(key=lambda x: x["wsn"])
    return wsns


def _process_item(
    df_item:   pd.DataFrame,
    col_escopo: str | None,
    col_hh:     str | None,
    col_wsn:    str | None,
    col_qty:    str | None,
    col_fw:     str | None,
    col_op:     str | None,
) -> tuple[dict[str, dict], list[str]]:
    """
    Fallback: compute hours directly from ITEM demand rows using HH × QTDE_FW.
    Used only when no ASSEMBLY lookup rows exist for an item.
    Returns (scopes_data, scopes_found).
    """
    scopes_data:  dict[str, dict] = {}
    scopes_found: list[str]       = []

    if col_escopo and col_escopo in df_item.columns:
        df_item = df_item.copy()
        df_item["_escopo_norm"] = df_item[col_escopo].apply(
            lambda v: _normalize(str(v or "").strip())
        )
        for scope in SCOPE_ORDER:
            scope_n  = _normalize(scope)
            df_scope = df_item[
                (df_item["_escopo_norm"] == scope_n)
                | df_item["_escopo_norm"].str.endswith(" " + scope_n, na=False)
            ]
            if df_scope.empty:
                continue
            scopes_found.append(scope)
            total_h        = _hh_x_qty(df_scope, col_hh, col_qty, col_fw)
            qty            = _aggregate_qty(df_scope, col_qty, col_fw)
            hours_per_unit = total_h / qty if qty > 0 else 0.0
            wsns           = _build_wsn_list(df_scope, col_wsn, col_hh, col_op, col_qty, col_fw)
            scopes_data[scope] = {
                "total_h":        total_h,
                "qty":            qty,
                "hours_per_unit": hours_per_unit,
                "wsn_count":      len(wsns),
                "wsns":           wsns,
            }

    if not scopes_found:
        total_h        = _hh_x_qty(df_item, col_hh, col_qty, col_fw)
        qty            = _aggregate_qty(df_item, col_qty, col_fw)
        hours_per_unit = total_h / qty if qty > 0 else 0.0
        wsns           = _build_wsn_list(df_item, col_wsn, col_hh, col_op, col_qty, col_fw)
        scopes_found   = ["LEVE"]
        scopes_data["LEVE"] = {
            "total_h":        total_h,
            "qty":            qty,
            "hours_per_unit": hours_per_unit,
            "wsn_count":      len(wsns),
            "wsns":           wsns,
        }

    return scopes_data, scopes_found


# ── Public API ────────────────────────────────────────────────────────────────

#: Scope that receives the whole supplied quantity when demand comes from OUTSIDE the plan.
#: Same priority the "Adicionar" catalog flow uses on the client — the caller knows how many
#: units, never which severity, so the qty must land in ONE scope instead of being duplicated
#: across every scope the assembly defines.
_EXPLICIT_SCOPE_PRIORITY: list[str] = ["MEDIO", "UNICO", "PESADO", "LEVE"]


def _scopes_from_assembly(df_item_asm: "pd.DataFrame") -> list[str]:
    """Scopes the ASSEMBLY rows themselves define (never the demand plan's opinion)."""
    found: list[str] = []
    if "_escopo_norm" in df_item_asm.columns:
        for scope in SCOPE_ORDER:
            if (df_item_asm["_escopo_norm"] == _normalize(scope)).any():
                found.append(scope)
    return _detect_scopes_present(found or ["LEVE"])


def _filter_asm_by_tipos(
    df_item_asm: "pd.DataFrame",
    col_tipo:    str | None,
    tipos:       set[str],
) -> "pd.DataFrame":
    """
    Restrict assembly operation rows to the requested TIPO set (the caller's ESCOPO values).

    Applied ONLY when at least one row matches. The two vocabularies overlap partially —
    locos_rout.escopo carries values (COMPLETO, DESMONTAGEM, LAVAGEM, …) that the routing's
    TIPO column does not use — so an empty intersection means "this source does not describe
    operation types", not "this item has no work". Filtering to nothing there would reproduce
    the very symptom this path exists to fix: an item with a full routing showing no operations
    and no hours. In that case every operation row is kept.
    """
    if not tipos or not col_tipo or col_tipo not in df_item_asm.columns:
        return df_item_asm
    wanted = {_normalize_tipo_fw(t) for t in tipos if str(t).strip()}
    wanted.discard("")
    if not wanted:
        return df_item_asm
    mask = df_item_asm[col_tipo].apply(_normalize_tipo_fw).isin(wanted)
    filtered = df_item_asm[mask]
    return filtered if not filtered.empty else df_item_asm


def _explicit_tipo_scope_map(
    df_item_asm: "pd.DataFrame",
    col_tipo:    str | None,
    scope:       str,
    tipo_qty:    "dict | None",
) -> dict[tuple[str, str], float]:
    """
    {(scope_norm, tipo_norm): qty} for caller-supplied demand — the per-operation-type split.

    The caller's TIPOs are CONCURRENT process steps on the SAME units, never additive demand:
    5 PERITAGEM + 5 MONTAGEM is 5 units passing through both, not 10 units. Without this map the
    single `qty` scaled EVERY matched operation row, so an item carrying two ESCOPOs had its
    hours computed as (5+5) × (HH_peritagem + HH_montagem) — double the real work.

    Feeding it as `tipo_fw_scope_qty_map` makes each operation row use the quantity of its own
    TIPO, through the exact arithmetic the monthly-plan path already uses. The reduction is
    exact rather than approximate: the caller's `qty` is Σ_FW max_TIPO(qty), so it is always
    ≥ every individual tipo qty and ≥ the map's own max, which collapses the fraction
    `qty × mq / max(raw, qty)` to `mq`.

    Returns {} when NOTHING matches the routing's TIPO column — the two vocabularies overlap
    only partially (COMPLETO, LAVAGEM, … exist only on the schedule side), and an all-zero map
    would silence an item that has a perfectly good routing. That case keeps the previous
    behaviour: the whole qty flows through every operation.
    """
    if not tipo_qty or not isinstance(tipo_qty, dict):
        return {}
    if not col_tipo or col_tipo not in df_item_asm.columns:
        return {}
    asm_tipos = {t for t in df_item_asm[col_tipo].apply(_normalize_tipo_fw) if t}
    if not asm_tipos:
        return {}

    wanted: dict[str, float] = {}
    for raw_tipo, raw_qty in tipo_qty.items():
        tipo_norm = _normalize_tipo_fw(raw_tipo)
        if not tipo_norm:
            continue
        qty = _safe_float(raw_qty)
        if qty <= 0:
            continue
        # Two source ESCOPOs can normalise onto the same routing TIPO (DESMONTAGEM and MONTAGEM
        # both contain "mont"). They still describe the same units, so the larger count wins —
        # summing would put back the inflation this split exists to remove.
        wanted[tipo_norm] = max(wanted.get(tipo_norm, 0.0), qty)

    if not wanted or not (asm_tipos & set(wanted)):
        return {}
    # EVERY supplied tipo goes in, matched or not. The unmatched ones carry no operations, but
    # they must still count toward the map's total: that total is what tells the shared
    # arithmetic there is no untyped ("tipless") demand left to spread over every operation.
    scope_norm = _normalize(scope)
    return {(scope_norm, tipo): qty for tipo, qty in wanted.items()}


def get_assembly_details(
    filepath: str | Path,
    *,
    items: list[str],
    mes:   int | None = None,
    fws:   list[str] | None = None,
    mode:  str = "mensal",
    tipo_filter: str = "",
    df_override: "pd.DataFrame | None" = None,
    demand_override: "dict[str, dict] | None" = None,
) -> dict:
    """
    Returns per-scope breakdown for a list of items.

    Architecture (two-step, mirrors CapB3356103.py AssemblyWidget):
      Step 1 – Demand qty:
        Filter ITEM column by period → aggregate QTDE_FW per scope.
        Apply allocations.json to redistribute qty across scopes.

      Step 2 – Hours & WSN:
        Look up ALL rows where ASSEMBLY == item_code (full dataset).
        Group by COMPONENT, apply escolher_escopo() fallback, sum HH × qty.
        Falls back to HH × QTDE_FW from demand rows if no ASSEMBLY rows found.

    `demand_override` replaces STEP 1 ONLY, per item, keyed by normalised item code:
        {item_norm: {"qty": float, "tipos": [str, ...]}}
    Step 2 is untouched — the same ASSEMBLY lookup, the same escolher_escopo() fallback and
    the same HH × qty arithmetic produce the hours. It exists for callers whose demand does
    not live in this dataset at all (the Carga de Fábrica schedule supplies its own item
    quantities), where the period-filtered ITEM rows are necessarily empty and the item would
    otherwise be dropped by the "no demand rows in this period" guard below — arriving in the
    UI with no operations and no hours despite having a perfectly good routing.

    Returns per-item dict:
      {
        "item": str, "descricao": str,
        "scopes_present": [...],
        "total_h": float,
        "scopes": {
          "LEVE": {"total_h": float, "qty": float, "hours_per_unit": float,
                   "wsn_count": int, "wsns": [...]}
          ...
        }
      }
    """
    filepath = Path(filepath)
    if not filepath.exists() and df_override is None:
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    alloc_map = _load_allocations(filepath.parent)

    if df_override is not None:
        df_full = df_override
    else:
        try:
            xl = pd.ExcelFile(filepath)
        except Exception as exc:
            return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

        if "Discretizado" not in xl.sheet_names:
            return {"status": "error", "message": "Aba 'Discretizado' não encontrada."}

        try:
            df_full = xl.parse("Discretizado")
        except Exception as exc:
            return {"status": "error", "message": f"Erro ao ler aba 'Discretizado': {exc}"}

    def fc(*candidates: str) -> str | None:
        return _find_col(df_full, list(candidates))

    # ── Column detection ──────────────────────────────────────────────────
    col_item   = fc("ITEM", "ASSEMBLY")          # demand parent code
    col_asm    = fc("ASSEMBLY", "ITEM")          # assembly code for lookup
    col_comp   = fc("COMPONENT", "COMPONENTE")   # operation component
    col_desc   = fc("DESCRIÇÃO", "DESCRICAO", "DESC", "DESCRIPTION")
    col_escopo = fc("ESCOPO")
    col_hh     = fc("HH", "HH TOTAL", "HOURS", "HORAS")
    col_wsn    = fc("WSN")
    col_qty    = fc("QTDE FW", "QTD FW", "QTDE", "QTY")
    col_mes    = fc("MES", "MÊS", "MONTH")
    col_fw      = fc("FW")
    col_op      = fc("Escopo de Operação", "OPERAÇÃO", "OPERACAO", "DESC", "DESCRIÇÃO")
    col_op_num  = fc("OP")
    col_op_desc = fc("DESC", "desc")      # WSN/operation description column (distinct from col_desc=DESCRIÇÃO)
    col_tipo    = fc("TIPO", "TIPO OPERAÇÃO", "TIPO OPERACAO")
    col_tipo_fw = fc("TIPO FW")

    if col_item is None:
        return {"status": "error", "message": "Coluna ITEM/ASSEMBLY não encontrada."}

    # ── Build description map (full dataset, before any filter) ──────────
    # Use ASSEMBLY-based lookup: prefers self-referential rows (ASSEMBLY==COMPONENT)
    # which contain the assembly's own description, not a sub-component's description.
    desc_map = _build_assembly_desc_map(df_full, col_asm, col_comp, col_desc)

    # ── Build locus_map and family_map (full dataset) ─────────────────────
    # Used to apply NEW LOCOS multiplier: when an item's family == "NEW LOCOS",
    # hours per component are multiplied by the qty from the locus_map.
    locus_map  = _build_locus_map(df_full)
    family_map = _build_family_map(df_full)

    # ── ASSEMBLY lookup index (full dataset, no period filter) ────────────
    # Mirrors: df_wasm = self.df[self.df["_assembly_norm"] == asm_norm]
    df_asm_full = df_full.copy()
    if col_asm and col_asm in df_asm_full.columns:
        df_asm_full["_asm_norm"] = df_asm_full[col_asm].apply(
            lambda v: _normalize(str(v or "")) if pd.notna(v) else ""
        )
        if col_escopo and col_escopo in df_asm_full.columns:
            df_asm_full["_escopo_norm"] = df_asm_full[col_escopo].apply(
                lambda v: _normalize(str(v or ""))
            )
    else:
        df_asm_full["_asm_norm"] = ""

    # ── Period-filtered demand rows (ITEM column) ─────────────────────────
    df_demand = df_full.dropna(subset=[col_item]).copy()
    if mes is not None and col_mes and col_mes in df_demand.columns:
        df_demand = df_demand[df_demand[col_mes].fillna(-1).astype(int) == int(mes)]
    if col_fw and fws is not None and col_fw in df_demand.columns:
        canonical = {_fw_key(f) for f in fws if str(f).strip()}
        if canonical:
            df_demand = df_demand[df_demand[col_fw].apply(_fw_key).isin(canonical)]

    item_norms = {_normalize(i) for i in items if str(i).strip()}
    df_demand["_item_norm"] = df_demand[col_item].apply(
        lambda v: _normalize(str(v or "").strip())
    )
    df_demand = df_demand[df_demand["_item_norm"].isin(item_norms)]

    # ── Per-item processing ───────────────────────────────────────────────
    result_items: list[dict] = []

    for raw_code in items:
        raw_code = str(raw_code).strip()
        if not raw_code:
            continue
        code_norm = _normalize(raw_code)

        # Step 1a: demand rows (period-filtered ITEM rows)
        df_item_demand = df_demand[df_demand["_item_norm"] == code_norm]

        # Early ASSEMBLY lookup — needed before qty check so that items with
        # no scheduled demand (individually-added catalog items, NEW LOCOS
        # items) can fall back to per-unit preview (qty=1) instead of being
        # skipped or returning 0 hours.
        df_item_asm = (
            df_asm_full[df_asm_full["_asm_norm"] == code_norm]
            if "_asm_norm" in df_asm_full.columns
            else pd.DataFrame()
        )

        # ── Explicit demand (quantities supplied by the caller) ───────────────
        # Runs before every demand-row rule below: this item's qty does not come from
        # this dataset, so period filters, allocations.json and the scope split derived
        # from plan rows are all inapplicable. Hours still come from the ASSEMBLY rows
        # through the exact same _process_item_from_assembly() call the normal path uses.
        override = demand_override.get(code_norm) if demand_override else None
        if override is not None:
            descricao_x = desc_map.get(code_norm, "")
            if _normalize(family_map.get(code_norm, "")) == "new locos":
                descricao_x = f"LOCOMOTIVA COMPLETA TIPO {raw_code}"
            if df_item_asm.empty:
                # No routing at all — report the item with zero hours rather than dropping
                # it, so the caller can still show it.
                result_items.append({
                    "item":           raw_code,
                    "descricao":      descricao_x,
                    "scopes_present": _detect_scopes_present(["LEVE"]),
                    "total_h":        0.0,
                    "scopes":         {},
                })
                continue
            qty_x = _safe_float(override.get("qty"))
            scopes_x = _scopes_from_assembly(df_item_asm)
            primary = next((s for s in _EXPLICIT_SCOPE_PRIORITY if s in scopes_x), scopes_x[0])
            scope_qty_x = {s: (qty_x if s == primary else 0.0) for s in scopes_x}
            df_use = _filter_asm_by_tipos(
                df_item_asm, col_tipo, set(override.get("tipos") or [])
            )
            # Per-TIPO demand split. `qty` is the UNIT count (units passing through the item's
            # process steps); this says how many of them each step applies to. Absent or
            # unmatched ⇒ {} ⇒ the whole qty drives every operation, as before.
            tipo_scope_map_x = _explicit_tipo_scope_map(
                df_item_asm, col_tipo, primary, override.get("tipo_qty"),
            )
            scopes_data_x = _process_item_from_assembly(
                df_use, scope_qty_x, scopes_x,
                col_escopo, col_hh, col_wsn, col_op, col_comp,
                col_tipo=col_tipo, col_op_num=col_op_num, col_desc=col_desc,
                col_op_desc=col_op_desc,
                # No plan-derived TOTAL tipo map: the caller's demand does not live in this
                # dataset. The per-(scope, tipo) map above is the caller's own split; with
                # neither, every operation row is driven by the scope qty (hours = qty × HH).
                tipo_fw_qty_map=None,
                tipo_fw_scope_qty_map=tipo_scope_map_x or None,
                tipo_filter="",
                locus_map=locus_map if _normalize(family_map.get(code_norm, "")) == "new locos" else None,
                item_norm=code_norm,
            )
            result_items.append({
                # Echo the code EXACTLY as requested: the caller keys its own item map on it
                # (assemblyDetails[item.item]), so returning the dataset's spelling instead
                # would silently orphan the detail.
                "item":           raw_code,
                "descricao":      descricao_x,
                "scopes_present": scopes_x,
                "total_h":        sum(scopes_data_x.get(s, {}).get("total_h", 0.0) for s in scopes_x),
                "scopes":         {s: scopes_data_x[s] for s in scopes_x if s in scopes_data_x},
            })
            continue

        # Skip only when BOTH demand rows and assembly rows are absent.
        if df_item_demand.empty and df_item_asm.empty:
            continue

        # When a period filter is active (mes or fws), items with no demand rows
        # in the filtered period belong to a different period and must be skipped.
        # Without this guard, they fall back to qty=1 and inflate total hours when
        # the user filters months/weeks in the main window.
        # The qty=1 fallback is intentional ONLY for catalog items added via
        # "Adicionar" (no period → mes/fws are both None).
        if df_item_demand.empty and (mes is not None or fws is not None):
            continue

        descricao = desc_map.get(code_norm, "")
        if _normalize(family_map.get(code_norm, "")) == "new locos":
            descricao = f"LOCOMOTIVA COMPLETA TIPO {raw_code}"

        if df_item_demand.empty:
            # No demand rows but ASSEMBLY rows exist — per-unit preview (qty=1).
            # Covers individually-added catalog items (no QTDE_FW) and
            # NEW LOCOS items that only appear as ASSEMBLY rows, not ITEM rows.
            canonical_item = raw_code
            asm_scopes_fb: list[str] = []
            if "_escopo_norm" in df_item_asm.columns:
                for scope in SCOPE_ORDER:
                    if (df_item_asm["_escopo_norm"] == _normalize(scope)).any():
                        asm_scopes_fb.append(scope)
            scopes_found_demand = _detect_scopes_present(asm_scopes_fb or ["LEVE"])
            scope_qty_nz: dict[str, float] = {s: 1.0 for s in scopes_found_demand}
        else:
            canonical_item = str(df_item_demand[col_item].iloc[0]).strip()

            # Step 1b: qty per scope from demand rows
            scope_qty_raw, scopes_found_demand = _get_scope_qty_from_demand(
                df_item_demand, col_escopo, col_qty, col_fw
            )
            total_qty = max(scope_qty_raw.values(), default=0.0)

            # Step 1c: apply allocations.json
            # Fire even when only one scope present in demand data so that items
            # defined in allocations.json are always split across scopes.
            item_alloc = alloc_map.get(code_norm)
            if item_alloc and total_qty > 0:
                alloc_scopes = [
                    s for s in ["LEVE", "MEDIO", "PESADO", "UNICO"]
                    if item_alloc.get(s, 0.0) > 0
                ]
                if not alloc_scopes:
                    alloc_scopes = list(scope_qty_raw.keys()) or ["MEDIO"]
                # Per-FW distribution: distribute each FW's qty independently, then
                # sum results.  This guarantees monthly_total == sum(weekly_totals)
                # because Hamilton is applied per batch (not to the accumulated total),
                # and fractional remainders are always routed to MEDIO, never split.
                if col_fw and col_fw in df_item_demand.columns:
                    scope_qty: dict[str, float] = {s: 0.0 for s in alloc_scopes}
                    for _, fw_grp in df_item_demand.groupby(col_fw):
                        fw_raw, _ = _get_scope_qty_from_demand(
                            fw_grp, col_escopo, col_qty, col_fw=None
                        )
                        _fw_total = max(fw_raw.values(), default=0.0) if fw_raw else 0.0
                        if _fw_total <= 0:
                            continue
                        fw_dist = _distribute_qty_fractional_no_split(
                            _fw_total, alloc_scopes, item_alloc
                        )
                        for s in alloc_scopes:
                            scope_qty[s] = scope_qty.get(s, 0.0) + fw_dist.get(s, 0.0)
                else:
                    # Single FW or no FW column: use fractional-no-split directly
                    _dist = _distribute_qty_fractional_no_split(
                        total_qty, alloc_scopes, item_alloc
                    )
                    scope_qty = {s: float(_dist.get(s, 0)) for s in alloc_scopes}
            else:
                scope_qty = scope_qty_raw

            # Filter to non-zero qty scopes for computation
            scope_qty_nz = {s: q for s, q in scope_qty.items() if q > 0}
            if not scope_qty_nz:
                if df_item_asm.empty:
                    # No ASSEMBLY rows either — truly zero-demand item.
                    result_items.append({
                        "item":           canonical_item,
                        "descricao":      descricao,
                        "scopes_present": _detect_scopes_present(scopes_found_demand or ["LEVE"]),
                        "total_h":        0.0,
                        "scopes":         {},
                    })
                    continue
                # qty=0 but ASSEMBLY rows exist — per-unit preview (qty=1).
                asm_scopes_fb = []
                if "_escopo_norm" in df_item_asm.columns:
                    for scope in SCOPE_ORDER:
                        if (df_item_asm["_escopo_norm"] == _normalize(scope)).any():
                            asm_scopes_fb.append(scope)
                scopes_found_demand = _detect_scopes_present(asm_scopes_fb or ["LEVE"])
                scope_qty_nz = {s: 1.0 for s in scopes_found_demand}

        scopes_present = _detect_scopes_present(list(scope_qty_nz.keys()))

        # Step 2: compute hours
        # Prefer ASSEMBLY column lookup (mirrors build_widget_rows); fall back
        # to demand HH × QTDE_FW when no ASSEMBLY rows exist.

        if not df_item_asm.empty:
            # ── Mirror original _detect_scopes_present() ─────────────────
            # The original CapB uses ASSEMBLY data (full dataset, no period
            # filter) to determine which scopes an item supports, NOT the
            # demand rows.  Using demand rows caused items whose demand plan
            # labels them "PESADO" to override a true "UNICO" assembly scope.
            scopes_found_asm: list[str] = []
            if "_escopo_norm" in df_item_asm.columns:
                for scope in SCOPE_ORDER:
                    scope_n = _normalize(scope)
                    if (df_item_asm["_escopo_norm"] == scope_n).any():
                        scopes_found_asm.append(scope)
            if scopes_found_asm:
                scopes_present = _detect_scopes_present(scopes_found_asm)

            # Reconcile qty: map demand quantities to assembly scopes.
            # Performed PER-FW (when a FW column is available) to guarantee
            # MENSAL(all-FWs) == sum(per-FW SEMANAL).
            #
            # Why per-FW matters: if FW22 has only PESADO demand and FW23 has
            # only LEVE demand, but the assembly only defines LEVE+MEDIO, then:
            #   • Combined (old logic): has_scope_overlap=True (LEVE is shared),
            #     so FW22's PESADO qty is silently dropped → MENSAL is too low.
            #   • Per-FW (new logic): FW22 sees no overlap → distributes its
            #     PESADO qty across LEVE+MEDIO; FW23 sees overlap → maps LEVE
            #     directly.  Both SEMANAL and MENSAL now sum the same way.
            asm_scopes_set = set(scopes_present)
            scope_qty_asm: dict[str, float] = {s: 0.0 for s in scopes_present}
            _use_alloc_recon = bool(item_alloc and total_qty > 0)
            if col_fw and col_fw in df_item_demand.columns:
                for _, fw_grp in df_item_demand.groupby(col_fw):
                    fw_raw, _ = _get_scope_qty_from_demand(
                        fw_grp, col_escopo, col_qty, col_fw=None
                    )
                    _fw_total = max(fw_raw.values(), default=0.0) if fw_raw else 0.0
                    if _fw_total <= 0:
                        continue
                    if _use_alloc_recon:
                        fw_dist = _distribute_qty_fractional_no_split(
                            _fw_total, alloc_scopes, item_alloc
                        )
                        fw_nz = {s: q for s, q in fw_dist.items() if q > 0}
                    else:
                        fw_nz = {s: q for s, q in fw_raw.items() if q > 0}
                    fw_demand_set = set(fw_nz.keys())
                    fw_has_overlap = bool(fw_demand_set & asm_scopes_set)
                    for s in scopes_present:
                        if fw_nz.get(s, 0.0) > 0:
                            scope_qty_asm[s] += fw_nz[s]
                        elif not fw_has_overlap and _fw_total > 0:
                            scope_qty_asm[s] += _fw_total / len(scopes_present)
            else:
                # No FW column available: single-pass reconciliation (original logic)
                total_demand_qty = sum(scope_qty_nz.values())
                demand_scopes_set = set(scope_qty_nz.keys())
                has_scope_overlap = bool(demand_scopes_set & asm_scopes_set)
                for s in scopes_present:
                    if scope_qty_nz.get(s, 0.0) > 0:
                        scope_qty_asm[s] = scope_qty_nz[s]
                    elif not has_scope_overlap and total_demand_qty > 0:
                        scope_qty_asm[s] = total_demand_qty / len(scopes_present)

            scopes_data = _process_item_from_assembly(
                df_item_asm, scope_qty_asm, scopes_present,
                col_escopo, col_hh, col_wsn, col_op, col_comp,
                col_tipo=col_tipo, col_op_num=col_op_num, col_desc=col_desc,
                col_op_desc=col_op_desc,
                tipo_fw_qty_map=_build_tipo_fw_qty_map(
                    df_item_demand, col_tipo_fw, col_qty, col_fw
                ),
                tipo_fw_scope_qty_map=_build_tipo_fw_scope_qty_map(
                    df_item_demand, col_tipo_fw, col_qty, col_fw, col_escopo
                ),
                tipo_filter=tipo_filter,
                locus_map=locus_map if _normalize(family_map.get(code_norm, "")) == "new locos" else None,
                item_norm=code_norm,
            )
        else:
            # Fallback: demand-based HH × QTDE_FW
            sd_demand, _ = _process_item(
                df_item_demand, col_escopo, col_hh, col_wsn, col_qty, col_fw, col_op
            )
            # Find representative hours_per_unit for scopes not in demand data
            any_hpu = next(
                (sd_demand[x]["hours_per_unit"]
                 for x in scopes_found_demand
                 if sd_demand.get(x, {}).get("hours_per_unit", 0) > 0),
                0.0,
            )
            any_wsns = next(
                (sd_demand[x]["wsns"]
                 for x in scopes_found_demand
                 if sd_demand.get(x, {}).get("wsns")),
                [],
            )
            scopes_data = {}
            for s in scopes_present:
                sd  = sd_demand.get(s, {})
                hpu = sd.get("hours_per_unit", any_hpu)
                wsns = sd.get("wsns", any_wsns)
                new_qty = scope_qty_nz.get(s, sd.get("qty", 0.0))
                scopes_data[s] = {
                    "total_h":        hpu * new_qty,
                    "qty":            new_qty,
                    "hours_per_unit": hpu,
                    "wsn_count":      len(wsns),
                    "wsns":           wsns,
                }

        total_h = sum(
            scopes_data.get(s, {}).get("total_h", 0.0) for s in scopes_present
        )

        result_items.append({
            "item":           canonical_item,
            "descricao":      descricao,
            "scopes_present": scopes_present,
            "total_h":        total_h,
            "scopes":         {s: scopes_data[s] for s in scopes_present if s in scopes_data},
        })

    result_items.sort(key=lambda x: x["total_h"], reverse=True)

    return {
        "status":  "ok",
        "message": f"{len(result_items)} itens processados.",
        "items":   result_items,
    }

