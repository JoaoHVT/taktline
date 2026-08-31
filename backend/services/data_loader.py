"""
services/data_loader.py
-----------------------
Ingestão e preparação de dados a partir do Excel de capacidade (HorasB3.xlsx).

Responsabilidade única: ler o arquivo, normalizar e retornar um dict estruturado
pronto para ser consumido pelo solver ou pelo frontend.

Não depende de PyQt5 nem de nenhum estado de UI.

Folha principal  → "Discretizado"  (demanda por WSN, pessoas, escopo)
Folha de pessoas → "HeadCount"     (mapa WSN → lista de pessoas + disponibilidade)
Folha de capacidade → "Testes"     (horas disponíveis, OT e TOP por pessoa)
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

# Shared 4-4-5 fiscal-calendar engine (also used by gantt_builder). Period-days
# now derive working days from here instead of the pre-baked Excel DAYS_1 column.
from services import calendar_445

logger = logging.getLogger(__name__)

# ── Nomes de colunas esperados por sheet ──────────────────────────────────────

# HEADCOUNT is no longer required (nor read): capacity/people moved to the Headcount tab, keyed by
# WSN, and the Item Rout importer now drops the column outright — requiring it here would reject
# every post-cutover import. WSN stays required: it is the key the Headcount tab is mapped through.
_DISC_REQUIRED = {"WSN", "HH TOTAL", "ESCOPO"}
_HC_REQUIRED   = {"WSN", "HEADCOUNT", "QTDE", "DISP"}
_TEST_COLS = {
    "matricula":  "Matrícula ",
    "nome":       "Nome                                    ",
    "secao":      "Seção de Trabalho ",
    "hh_disp":    "HH DISP.",
    "hh_disp_ot": "HH DISP..1",
    "ot_h":       "OT",
    "ot_dia":     "OT/DIA",
    "top":        "TOP",
    "disp":       "DISP",
    "disp_ot":    "DISP.1",
}


# ── Utilitários internos ──────────────────────────────────────────────────────

def _normalize(text: Any) -> str:
    """Converte para string, remove acentos, strip e lower."""
    s = unicodedata.normalize("NFD", str(text or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.strip().lower()


def _fw_key(v: Any) -> str:
    """Normalize FW value to a clean integer string.
    Handles float (14.0), numeric string ('14'), float-string ('14.0'), and prefixed ('FW14').
    """
    m = re.search(r'(\d+)', str(v))
    return str(int(m.group(1))) if m else str(v).strip()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        v = float(value)
        return default if (np.isnan(v) or np.isinf(v)) else v
    except (TypeError, ValueError):
        return default


def _str_val(value: Any) -> str:
    """Convert a spreadsheet value to str, returning '' for None / NaN."""
    if value is None:
        return ""
    try:
        if np.isnan(float(value)):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def _split_people(raw: Any) -> list[str]:
    """Converte 'NOME A, NOME B, ...' em lista de nomes normalizados."""
    if not raw or (isinstance(raw, float) and np.isnan(raw)):
        return []
    return [p.strip() for p in str(raw).split(",") if p.strip()]


def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """Retorna o primeiro nome de coluna que bater (case-insensitive) com candidates."""
    norm_map = {_normalize(c): c for c in df.columns}
    for cand in candidates:
        hit = norm_map.get(_normalize(cand))
        if hit is not None:
            return hit
    return None


def _build_assembly_desc_map(
    df:       pd.DataFrame,
    col_asm:  str | None,
    col_comp: str | None,
    col_desc: str | None,
) -> dict[str, str]:
    """
    Build {normalized_code: description} from the Discretizado sheet.
    Mirrors CapB3356103.py _build_assembly_desc_map():

    For each unique ASSEMBLY code:
      1. Prefer rows where ASSEMBLY == COMPONENT (self-referential) — these
         describe the assembly's own identity, not a sub-component.
      2. Fall back to the most frequent non-empty description across all rows
         where ASSEMBLY == that code.

    This ensures items get their own description (e.g. "MOTOR DE TRACAO") rather
    than a random component description (e.g. "ESTATOR AUX LONG REPARADO").
    """
    if col_asm is None or col_desc is None:
        return {}

    cols_needed = [c for c in [col_asm, col_desc, col_comp] if c]
    tmp = df[cols_needed].copy().dropna(subset=[col_asm])
    tmp["_asm_norm"] = tmp[col_asm].apply(lambda v: _normalize(str(v or "")))

    def _clean(v: Any) -> str:
        if v is None:
            return ""
        try:
            if np.isnan(float(v)):
                return ""
        except (TypeError, ValueError):
            pass
        s = str(v).strip()
        return s if s and s.lower() != "nan" else ""

    tmp["_d"] = tmp[col_desc].apply(_clean)
    tmp = tmp[tmp["_d"] != ""]
    if tmp.empty:
        return {}

    result: dict[str, str] = {}
    for asm_norm, grp in tmp.groupby("_asm_norm"):
        # Prefer self-referential rows (ASSEMBLY == COMPONENT)
        if col_comp and col_comp in grp.columns:
            grp_c = grp.copy()
            grp_c["_cn"] = grp_c[col_comp].apply(
                lambda v: _normalize(str(v or "")) if pd.notna(v) else ""
            )
            self_rows = grp_c[grp_c["_cn"] == asm_norm]
            if not self_rows.empty:
                vals = [v for v in self_rows["_d"] if v]
                if vals:
                    result[str(asm_norm)] = Counter(vals).most_common(1)[0][0]
                    continue
        # Fallback: most frequent across all rows for this assembly
        vals = [v for v in grp["_d"] if v]
        if vals:
            result[str(asm_norm)] = Counter(vals).most_common(1)[0][0]

    return result


# ── Parsers por sheet ─────────────────────────────────────────────────────────

def _parse_discretizado(
    df: pd.DataFrame,
    ano: int | None,
    mes: int | None,
    escopo: str | None,
) -> tuple[dict[str, float], dict[str, list[str]], list[dict]]:
    """
    Lê a aba 'Discretizado' e retorna:
      demand_by_wsn  : { wsn → total_hours }
      people_by_wsn  : { wsn → [person, ...] }
      rows_sample    : amostra de 20 linhas para preview
    """
    missing = _DISC_REQUIRED - set(df.columns)
    if missing:
        raise ValueError(f"Colunas ausentes em 'Discretizado': {missing}")

    # Filtros de período
    if ano is not None and "ANO" in df.columns:
        df = df[df["ANO"].fillna(-1).astype(int) == int(ano)]
    if mes is not None and "MES" in df.columns:
        df = df[df["MES"].fillna(-1).astype(int) == int(mes)]
    if escopo is not None and "ESCOPO" in df.columns:
        df = df[df["ESCOPO"].str.upper() == escopo.upper()]

    df = df.dropna(subset=["WSN"])

    demand_by_wsn: dict[str, float] = {}
    # WHO works a WSN is no longer derived from the routing's HEADCOUNT column — it comes from the
    # Headcount tab (Workstation/Person/WorkstationPerson), supplied by the caller as
    # `headcount_override` and applied in load_and_prepare_data. This stays in the return signature
    # (empty) so callers keep their shape; only DEMAND is routing-owned here.
    people_by_wsn: dict[str, list[str]] = {}

    for wsn, group in df.groupby("WSN"):
        wsn_key = str(wsn).strip()
        demand_by_wsn[wsn_key] = _safe_float(group["HH TOTAL"].sum())

    # preview: colunas relevantes, sem colunas "Unnamed"
    preview_cols = [
        c for c in ["WSN", "HH TOTAL", "ESCOPO", "FAMILIA",
                    "CLIENTE", "ANO", "MES", "WEEKS", "DAYS"]
        if c in df.columns
    ]
    rows_sample = (
        df[preview_cols]
        .dropna(subset=["WSN", "HH TOTAL"])
        .head(20)
        .replace({np.nan: None})
        .to_dict(orient="records")
    )

    return demand_by_wsn, people_by_wsn, rows_sample


# _build_headcount_from_discretizado was REMOVED in the Item Rout → Headcount-tab cutover.
#
# It derived per-WSN capacity (people / LH / LM / TURNOS) from the routing rows, and existed as the
# fallback for callers that passed no `headcount_override`. Keeping it would have made the cutover
# reversible by accident: any caller forgetting the argument would silently resume treating Item Rout
# as the capacity source, which is exactly the split-brain the migration removes. Capacity now has a
# single source — the Headcount tab, via main.py::_headcount_source_dict — and its absence means
# "no capacity constraints", never "go look at the routing".


def _parse_headcount(df: pd.DataFrame) -> dict[str, dict]:
    """
    Lê a aba 'HeadCount' e retorna:
      { wsn → { "people": [...], "qtde": int, "disp": float, "lh": float,
                "turnos": int, "lm": int, "desc": str } }

    Suporta dois formatos:

    FORMATO MATRIZ (atual):
      Quando lido com header=0 (padrão pandas), a estrutura é:
        df.columns  — Unnamed: 0..11  + inteiros 1, 2, ..., 91 (colunas de pessoa)
        df.iloc[0]  — nomes dos funcionários nas colunas inteiras
        df.iloc[2]  — labels de coluna: WSN, DESC, HEADCOUNT, QTDE, LH, LM, TURNO
        df.iloc[3:] — dados com True/False nas colunas de pessoa

    FORMATO LEGADO:
      df.columns contém "WSN", "HEADCOUNT", "QTDE", "DISP" como cabeçalhos reais.
    """
    if df.empty:
        return {}

    # Detecta formato legado: "WSN" é um cabeçalho de coluna real
    if "WSN" in df.columns:
        return _parse_headcount_legacy(df)

    # Detecta formato matriz: row 2 contém "WSN" como valor
    if len(df) < 3:
        return {}
    row2_labels = {str(v).strip().upper() for v in df.iloc[2] if pd.notna(v) and str(v).strip()}
    if "WSN" not in row2_labels:
        logger.warning("HeadCount: formato de aba não reconhecido — ignorando sheet.")
        return {}

    return _parse_headcount_matrix(df)


def _parse_headcount_matrix(df: pd.DataFrame) -> dict[str, dict]:
    """
    Formato matriz: colunas inteiras (1, 2, ...) representam funcionários.
      - df.iloc[0]  → nomes dos funcionários (coluna inteira → nome)
      - df.iloc[2]  → labels de coluna (WSN, DESC, QTDE, LH, LM, TURNO, ...)
      - df.iloc[3:] → dados (True/False em colunas de pessoa)
    """
    # Mapa coluna-inteira → nome do funcionário (row 0)
    person_col_to_name: dict[int, str] = {}
    for col_name in df.columns:
        if isinstance(col_name, int):
            person_val = df.iloc[0].get(col_name)
            if pd.notna(person_val) and str(person_val).strip():
                person_col_to_name[col_name] = str(person_val).strip()

    # Mapa label-de-coluna → nome-de-coluna-no-df (row 2)
    col_by_label: dict[str, Any] = {}
    for col_name, val in df.iloc[2].items():
        label = str(val).strip().upper() if pd.notna(val) else ""
        if label and label != "NAN":
            col_by_label[label] = col_name

    wsn_col   = col_by_label.get("WSN")
    if wsn_col is None:
        return {}
    desc_col  = col_by_label.get("DESC")
    qtde_col  = col_by_label.get("QTDE")
    lh_col    = col_by_label.get("LH")
    lm_col    = col_by_label.get("LM")
    # Aceita tanto "TURNO" (atual) quanto "TURNOS" (futuro)
    turno_col = col_by_label.get("TURNOS") or col_by_label.get("TURNO")

    def _cell(row: "pd.Series", col: Any) -> Any:
        if col is None:
            return None
        v = row.get(col)
        return None if (v is None or (not isinstance(v, (bool, str)) and pd.isna(v))) else v

    result: dict[str, dict] = {}
    for _, row in df.iloc[3:].iterrows():
        wsn_val = row.get(wsn_col)
        if pd.isna(wsn_val) or not str(wsn_val).strip():
            continue
        wsn = str(wsn_val).strip()

        # Funcionários alocados: colunas inteiras com valor truthy (True, 1, 'X')
        people: list[str] = []
        for col_name, person_name in person_col_to_name.items():
            try:
                cell_val = row.get(col_name)
                if pd.notna(cell_val) and cell_val:
                    people.append(person_name)
            except (TypeError, ValueError):
                pass

        result[wsn] = {
            "people": sorted(people),
            "qtde":   int(_safe_float(_cell(row, qtde_col), 0)),
            "disp":   1.0,
            "lh":     _safe_float(_cell(row, lh_col), 0.0),
            "turnos": int(_safe_float(_cell(row, turno_col), 0)),
            "lm":     int(_safe_float(_cell(row, lm_col), 0)),
            "desc":   str(_cell(row, desc_col) or "").strip(),
        }

    return result


def _parse_headcount_legacy(df: pd.DataFrame) -> dict[str, dict]:
    """
    Formato legado: colunas WSN, HEADCOUNT (nomes separados por vírgula), QTDE, DISP.
    """
    missing = {"WSN"} - set(df.columns)
    if missing:
        logger.warning("Colunas ausentes em 'HeadCount' (legado): %s — ignorando sheet.", missing)
        return {}

    col_turnos = _find_col(df, ["TURNOS", "TURNO"])
    col_lm     = _find_col(df, ["LM"])

    result: dict[str, dict] = {}
    for _, row in df.dropna(subset=["WSN"]).iterrows():
        wsn = str(row["WSN"]).strip()
        if not wsn:
            continue
        turnos_raw = row.get(col_turnos) if col_turnos else None
        lm_raw     = row.get(col_lm)     if col_lm     else None
        turnos = int(_safe_float(turnos_raw, 0)) if turnos_raw is not None else 0
        lm     = int(_safe_float(lm_raw,     0)) if lm_raw     is not None else 0
        result[wsn] = {
            "people": _split_people(row.get("HEADCOUNT")),
            "qtde":   int(_safe_float(row.get("QTDE"), 0)),
            "disp":   _safe_float(row.get("DISP"), 1.0),
            "lh":     _safe_float(row.get("LH"), 0.0),
            "turnos": turnos,
            "lm":     lm,
            "desc":   str(row.get("DESC") or "").strip(),
        }
    return result


def _parse_employee_capacity(df: pd.DataFrame) -> dict[str, dict]:
    """
    Lê a aba 'Testes' e retorna:
      { nome_normalizado → { "nome": str, "normal_h": float, "ot_h": float,
                              "top_pct": float, "disp": float, "secao": str } }
    """
    col = lambda key: _TEST_COLS.get(key, key)

    nome_col = _find_col(df, [_TEST_COLS["nome"], "Nome", "FUNCIONÁRIO"])
    if nome_col is None:
        logger.warning("Coluna 'Nome' não encontrada em 'Testes' — ignorando sheet.")
        return {}

    result: dict[str, dict] = {}
    for _, row in df.iterrows():
        raw_nome = row.get(nome_col)
        if not raw_nome or (isinstance(raw_nome, float) and np.isnan(raw_nome)):
            continue
        nome = str(raw_nome).strip()
        key  = _normalize(nome)

        hh_col   = _find_col(df, [_TEST_COLS["hh_disp"],    "HH DISP."])
        ot_col   = _find_col(df, [_TEST_COLS["ot_h"],       "OT"])
        top_col  = _find_col(df, [_TEST_COLS["top"],        "TOP"])
        disp_col = _find_col(df, [_TEST_COLS["disp"],       "DISP"])
        sec_col  = _find_col(df, [_TEST_COLS["secao"],      "Seção de Trabalho "])

        result[key] = {
            "nome":     nome,
            "normal_h": _safe_float(row.get(hh_col) if hh_col else None),
            "ot_h":     _safe_float(row.get(ot_col)  if ot_col  else None),
            "top_pct":  _safe_float(row.get(top_col) if top_col else None, 1.0),
            "disp":     _safe_float(row.get(disp_col) if disp_col else None, 1.0),
            "secao":    str(row.get(sec_col) or "").strip() if sec_col else "",
        }

    return result


# ── Função pública principal ──────────────────────────────────────────────────

def load_and_prepare_data(
    filepath: str | Path,
    *,
    ano:    int | None = None,
    mes:    int | None = None,
    escopo: str | None = None,
    df_override: "pd.DataFrame | None" = None,
    headcount_override: dict[str, dict] | None = None,
) -> dict:
    """
    Carrega o Excel de capacidade e retorna um dict estruturado.

    Parâmetros opcionais de filtro:
      ano    : filtra pelo ano (coluna ANO em Discretizado)
      mes    : filtra pelo mês (coluna MES em Discretizado)
      escopo : filtra pelo escopo (ÚNICO, LEVE, MÉDIO, PESADO)
      df_override: usa este DataFrame em vez de ler a aba 'Discretizado' do Excel
      headcount_override: quando fornecido (mesmo vazio), SUBSTITUI o headcount_by_wsn
        derivado do Item Rout pelos dados centralizados da aba Headcount (Workstation/
        Person/WorkstationPerson no banco) — Item Rout deixa de ser fonte de capacidade.
        Quando None (não informado), NÃO há mais fallback derivado do Item Rout: o headcount fica
        vazio ({}), ou seja "sem restrição de capacidade". A derivação a partir das colunas
        LH/LM/TURNOS/HEADCOUNT do Item Rout foi removida no cutover para a aba Headcount.

    Retorno:
    {
      "status":           "ok" | "error",
      "message":          str,
      "filepath":         str,
      "sheets_loaded":    [str, ...],
      "filters_applied":  { ano, mes, escopo },
      "demand_by_wsn":    { wsn: float },
      "people_by_wsn":    { wsn: [str, ...] },
      "headcount_by_wsn": { wsn: { people, qtde, disp, lh, desc } },
      "capacity_by_person": { nome_key: { nome, normal_h, ot_h, top_pct, disp, secao } },
      "wsn_list":         [str, ...],   # sorted list of wsns with demand
      "total_demand_h":   float,
      "preview":          { "rows": int, "sample": [...] },
    }
    """
    filepath = Path(filepath)

    if df_override is not None:
        # Use the provided DataFrame as the Discretizado sheet (DB fallback)
        sheets_loaded: list[str] = ["Discretizado (DB)"]
        try:
            demand_by_wsn, people_by_wsn, sample_rows = _parse_discretizado(
                df_override, ano, mes, escopo
            )
        except Exception as exc:
            return {"status": "error", "message": f"Erro ao processar df_override: {exc}"}
        # No routing-derived fallback any more: absent capacity means "unconstrained", not "read it
        # off Item Rout" (see the removal note on _build_headcount_from_discretizado).
        headcount_by_wsn = headcount_override or {}
        # The Headcount tab is AUTHORITATIVE for who works a WSN — assign, don't gap-fill. The old
        # `if wsn not in people_by_wsn` guard made the routing's HEADCOUNT column win whenever it had
        # any value, so the tab only ever filled blanks and a person removed there stayed allocated.
        for wsn, hc in headcount_by_wsn.items():
            people_by_wsn[wsn] = hc.get("people", [])
        capacity_by_person: dict[str, dict] = {}
        wsn_list       = sorted(demand_by_wsn.keys())
        total_demand_h = sum(demand_by_wsn.values())
        return {
            "status":             "ok",
            "message":            f"{len(wsn_list)} WSNs carregados (via DB), demanda total {total_demand_h:.1f} h.",
            "filepath":           str(filepath),
            "sheets_loaded":      sheets_loaded,
            "filters_applied":    {"ano": ano, "mes": mes, "escopo": escopo},
            "demand_by_wsn":      demand_by_wsn,
            "people_by_wsn":      people_by_wsn,
            "headcount_by_wsn":   headcount_by_wsn,
            "capacity_by_person": capacity_by_person,
            "wsn_list":           wsn_list,
            "total_demand_h":     total_demand_h,
            "preview": {
                "rows":   len(df_override),
                "sample": sample_rows,
            },
        }

    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    sheets_loaded = []

    # ── Discretizado (obrigatória) ────────────────────────────────
    if "Discretizado" not in xl.sheet_names:
        return {"status": "error", "message": "Aba 'Discretizado' não encontrada."}

    try:
        df_disc = xl.parse("Discretizado")
        demand_by_wsn, people_by_wsn, sample_rows = _parse_discretizado(
            df_disc, ano, mes, escopo
        )
        sheets_loaded.append("Discretizado")
    except Exception as exc:
        logger.exception("Erro ao processar 'Discretizado'")
        return {"status": "error", "message": f"Erro em 'Discretizado': {exc}"}

    # ── HeadCount (opcional) ──────────────────────────────────────
    headcount_by_wsn: dict[str, dict] = {}
    if "HeadCount" in xl.sheet_names:
        try:
            df_hc = xl.parse("HeadCount")
            headcount_by_wsn = _parse_headcount(df_hc)
            sheets_loaded.append("HeadCount")
        except Exception as exc:
            logger.warning("Erro ao processar 'HeadCount': %s", exc)

    # ── Testes / capacidade por pessoa (opcional) ─────────────────
    capacity_by_person: dict[str, dict] = {}
    if "Testes" in xl.sheet_names:
        try:
            df_test = xl.parse("Testes")
            capacity_by_person = _parse_employee_capacity(df_test)
            sheets_loaded.append("Testes")
        except Exception as exc:
            logger.warning("Erro ao processar 'Testes': %s", exc)

    # Headcount tab (DB) overrides the Excel 'HeadCount' sheet too, when the caller passes
    # it — same "single source of truth" policy as the df_override/DB-split branch above.
    if headcount_override is not None:
        headcount_by_wsn = headcount_override

    # ── Consolidação ──────────────────────────────────────────────
    wsn_list       = sorted(demand_by_wsn.keys())
    total_demand_h = sum(demand_by_wsn.values())

    # people_by_wsn comes FROM the headcount source (DB tab when overridden, else the Excel
    # 'HeadCount' sheet) — assigned, not gap-filled, so removing a person there actually removes
    # them instead of the routing's stale HEADCOUNT column winning.
    for wsn, hc in headcount_by_wsn.items():
        people_by_wsn[wsn] = hc.get("people", [])

    return {
        "status":            "ok",
        "message":           f"{len(wsn_list)} WSNs carregados, demanda total {total_demand_h:.1f} h.",
        "filepath":          str(filepath),
        "sheets_loaded":     sheets_loaded,
        "filters_applied":   {"ano": ano, "mes": mes, "escopo": escopo},
        "demand_by_wsn":     demand_by_wsn,
        "people_by_wsn":     people_by_wsn,
        "headcount_by_wsn":  headcount_by_wsn,
        "capacity_by_person": capacity_by_person,
        "wsn_list":          wsn_list,
        "total_demand_h":    total_demand_h,
        "preview": {
            "rows":   len(df_disc),
            "sample": sample_rows,
        },
    }


# ── Importação de itens do plano mensal ──────────────────────────────────────

def get_items_for_import(
    filepath: str | Path,
    *,
    ano:   int | None = None,
    mes:   int | None = None,
    meses: "list[int] | None" = None,
    fw:    str | None = None,
    fws:   list[str] | None = None,
    mode:  str = "mensal",
    df_override: "pd.DataFrame | None" = None,
) -> dict:
    """
    Lê a aba 'Discretizado' e retorna:
      - lista de itens únicos para a tela de importação (equivalente ao open_alert_flow do PyQt5)
      - valores disponíveis para os filtros (anos, meses, FWs)

    Cada item retornado:
      {
        "id":        str,    # valor normalizado do campo ITEM
        "item":      str,    # valor original do campo ITEM
        "descricao": str,    # campo DESCRIÇÃO (ou vazio)
        "familia":   str,
        "area":      str,
        "cliente":   str,
        "tipo":      str,    # campo TIPO
        "tipo_fw":   str,    # campo TIPO FW
        "qtde_fw":   float,  # campo QTDE FW (demanda do período)
        "wsn":       str,
      }
    """
    filepath = Path(filepath)
    if not filepath.exists() and df_override is None:
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    if df_override is not None:
        df = df_override
    else:
        try:
            xl = pd.ExcelFile(filepath)
        except Exception as exc:
            return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

        if "Discretizado" not in xl.sheet_names:
            return {"status": "error", "message": "Aba 'Discretizado' não encontrada."}

        try:
            df = xl.parse("Discretizado")
        except Exception as exc:
            return {"status": "error", "message": f"Erro ao ler aba 'Discretizado': {exc}"}

    # ── descobrir colunas dinamicamente (mesmo padrão do CapB) ────────────────
    def fc(*candidates):
        return _find_col(df, list(candidates))

    col_item    = fc("ITEM", "ASSEMBLY")
    col_asm     = fc("ASSEMBLY", "ITEM")   # ASSEMBLY column for description lookup
    col_comp    = fc("COMPONENT", "COMPONENTE")
    col_desc    = fc("DESCRIÇÃO", "DESCRICAO", "DESC", "DESCRIPTION")
    col_fam     = fc("FAMILIA", "FAMILY")
    col_area    = fc("AREA")
    col_client  = fc("CLIENTE", "CLIENT", "CUSTOMER")
    col_tipo    = fc("TIPO")
    col_tipo_fw = fc("TIPO FW")
    col_qty     = fc("QTDE FW", "QTD FW", "QTDE", "QTY")
    col_wsn     = fc("WSN")
    col_ano     = fc("ANO", "YEAR")
    col_mes     = fc("MES", "MÊS", "MONTH")
    col_fw      = fc("FW")
    col_nivel   = fc("NIVEL", "NÍVEL", "NIVEL FW")
    col_escopo  = fc("ESCOPO", "SCOPE")

    if col_item is None:
        return {"status": "error", "message": "Coluna ITEM/ASSEMBLY não encontrada na aba 'Discretizado'."}

    # ── routing existence, per item ───────────────────────────────────────────
    # An item is ROUTED when its code appears in the ASSEMBLY column — that is the key
    # /api/assembly-details/explicit resolves operations and hours by. WSN is NOT that key
    # and must not be used as a proxy: in the split-table world this frame is a vertical
    # union (see main.py::_db_to_df_split) where routing rows carry ASSEMBLY and no period,
    # plan rows carry ITEM and no WSN. The `df.dropna(subset=[ITEM])` below therefore drops
    # every routing row before the per-item aggregation runs, so the "wsn" first-value the
    # item record ends up with is blank for items that ARE fully routed — which is what made
    # the import tab flag them "sem roteiro" while the load resolved their hours correctly.
    #
    # Built from the UNFILTERED frame: routing rows have no ANO/MES/FW, so the period filters
    # applied further down would remove all of them before this could be read.
    routed_asms: set[str] = set()
    if col_asm and col_asm != col_item and col_asm in df.columns:
        routed_asms = {
            _normalize(str(v).strip())
            for v in df[col_asm].dropna()
            if str(v).strip()
        }

    # ── build description map from ASSEMBLY column (full dataset, before any filter)
    # Mirrors CapB3356103.py _build_assembly_desc_map(): groups by ASSEMBLY code,
    # prefers self-referential rows (ASSEMBLY==COMPONENT) for the item's own description.
    desc_map = _build_assembly_desc_map(df, col_asm, col_comp, col_desc)

    # ── valores únicos para anos e meses (antes de filtrar) ───────────────────
    anos       = sorted({int(v) for v in df[col_ano].dropna().unique()}, reverse=True) if col_ano else []
    # NOTE: renamed to meses_opts to avoid shadowing the `meses` parameter (list of selected months)
    meses_opts = sorted({int(v) for v in df[col_mes].dropna().unique()}) if col_mes else []

    # ── aplicar filtro de ano ─────────────────────────────────────────────────
    if ano is not None and col_ano:
        df = df[df[col_ano].fillna(-1).astype(int) == int(ano)]

    # ── mapa mês → FWs (após filtro de ANO, antes de filtro de MES) ──────────
    # Mirrors _list_available_fw_values() in CapB3356103.py: filter DataFrame by
    # selected month and collect unique FW values.  This lets the frontend look up
    # FWs for any month without additional API calls.
    mes_fw_map: dict[int, list[str]] = {}
    if col_mes and col_fw:
        for m_val, grp in df.groupby(col_mes):
            try:
                m_int = int(float(str(m_val)))
            except (ValueError, TypeError):
                continue
            mes_fw_map[m_int] = sorted(
                {_fw_key(v) for v in grp[col_fw].dropna().unique()},
                key=lambda x: int(x) if x.isdigit() else float("inf"),
            )

    # ── aplicar filtro de mês ─────────────────────────────────────────────────
    if meses is not None and len(meses) > 0 and col_mes:
        # Multi-month filter: keep rows matching any of the selected months
        df = df[df[col_mes].fillna(-1).astype(int).isin([int(m) for m in meses])]
    elif mes is not None and col_mes:
        df = df[df[col_mes].fillna(-1).astype(int) == int(mes)]

    # ── FWs disponíveis APÓS filtro de ano/mês (escopo do período) ───────────
    # Normalize to clean integer strings and sort numerically (like the original _fmt_fw_label)
    fws_available = (
        sorted(
            {_fw_key(v) for v in df[col_fw].dropna().unique()},
            key=lambda x: int(x) if x.isdigit() else float('inf'),
        )
        if col_fw else []
    )

    # ── aplicar filtro de FW (compare normalized integer keys on both sides) ───────────────────
    if fw is not None and col_fw and mode == "semanal":
        fw_num = _fw_key(fw)
        df = df[df[col_fw].apply(_fw_key) == fw_num]
    elif fws is not None and col_fw and mode == "mensal":
        canonical = {_fw_key(f) for f in fws if str(f).strip()}
        if canonical:
            df = df[df[col_fw].apply(_fw_key).isin(canonical)]

    df = df.dropna(subset=[col_item])

    # ── famílias e clientes disponíveis (após filtro de período) ──────────────
    familias = sorted({str(v).strip() for v in df[col_fam].dropna().unique()}) if col_fam else []
    clientes = sorted({str(v).strip() for v in df[col_client].dropna().unique()}) if col_client else []

    # ── agregar por item — dois passos para evitar dupla contagem por operação ──
    # Passo 1: deduplica por (ITEM, FW) → max QTDE FW por FW (elimina linhas duplicadas de operação)
    # Passo 2: soma QTDE FW por ITEM ao longo das FWs selecionadas
    agg_dict: dict[str, Any] = {}
    for alias, col in [
        ("familia",   col_fam),
        ("area",      col_area),
        ("cliente",   col_client),
        ("tipo",      col_tipo),
        ("wsn",       col_wsn),
    ]:
        if col:
            agg_dict[col] = "first"
    # Note: tipo_fw is excluded from agg_dict — collected separately as a list
    # so that items with multiple TIPO FW values (e.g. MONTAGEM + PERITAGEM)
    # show ALL their tipos in the filter dropdown, not just the first one.

    # Collect all unique non-empty TIPO FW values per item
    tipo_fw_by_item: dict[str, list[str]] = {}
    if col_tipo_fw and col_tipo_fw in df.columns:
        for item_val, grp in df.groupby(col_item):
            vals = [
                str(v).strip().upper()
                for v in grp[col_tipo_fw].dropna()
                if str(v).strip()
            ]
            # Deduplicate while preserving order (case-normalized distinct)
            seen: set[str] = set()
            unique_vals: list[str] = []
            for v in vals:
                if v not in seen:
                    seen.add(v)
                    unique_vals.append(v)
            tipo_fw_by_item[str(item_val).strip()] = unique_vals

    # Aggregate non-qty columns first
    if agg_dict:
        grouped_meta = df.groupby(col_item, as_index=False).agg(agg_dict)
    else:
        grouped_meta = df[[col_item]].drop_duplicates()

    # Compute accurate qty: deduplicate per (item, fw) with max() to remove
    # per-operation row duplication, then sum() across FWs to accumulate all
    # independent weekly batches.  Monthly demand = sum of all weekly batches,
    # mirroring _resolve_import_qty_total_for_group() in CapB3356103.py which
    # explicitly accumulates weekly_total across FWs.
    qty_by_item: dict[str, float] = {}
    if col_qty:
        if col_fw and col_fw in df.columns:
            _qty_per_fw = df.groupby([col_item, col_fw], as_index=False)[[col_qty]].max()
            _qty_agg    = _qty_per_fw.groupby(col_item)[col_qty].sum()
        else:
            _qty_agg = df.groupby(col_item)[col_qty].max()
        qty_by_item = {str(k).strip(): _safe_float(v) for k, v in _qty_agg.items()}

    # ── NIVEL: max numeric level across FWs per item, formatted as "P{n}" ────
    def _parse_nivel(val: Any) -> float:
        """Parse numeric level value; strip leading 'P' if present."""
        try:
            s = str(val or "").strip().lstrip("Pp")
            return float(s)
        except Exception:
            return 0.0

    def _format_nivel(val: float) -> str:
        if val <= 0:
            return ""
        n = int(val) if abs(val - round(val)) < 1e-9 else val
        return f"P{n}"

    nivel_by_item: dict[str, str] = {}
    if col_nivel and col_nivel in df.columns:
        for item_val, grp in df.groupby(col_item):
            max_n = _safe_float(grp[col_nivel].apply(_parse_nivel).max())
            nivel_by_item[str(item_val).strip()] = _format_nivel(max_n)

    # ── Client breakdown: per (item, client) → {familia, nivel, scopes: {scope→qty}} ──
    # Used to split the AssemblyBlock into sub-sections when 2 clients exist.
    # Qty per (client, scope): max per FW (dedup ops) → sum across FWs (batches).
    clients_by_item: dict[str, list[dict[str, Any]]] = {}
    if col_client and col_client in df.columns and col_qty:
        for item_val, item_grp in df.groupby(col_item):
            item_str = str(item_val).strip()
            item_grp = item_grp.copy()
            item_grp["_client_norm"] = item_grp[col_client].apply(
                lambda v: str(v or "").strip() or "Sem Cliente"
            )
            # Collect familia per client (first occurrence)
            client_fam: dict[str, str] = {}
            if col_fam and col_fam in item_grp.columns:
                for _, r in item_grp.iterrows():
                    c = str(r.get(col_client) or "").strip() or "Sem Cliente"
                    if c not in client_fam:
                        client_fam[c] = str(r.get(col_fam) or "").strip()
            # Collect max nivel per client
            client_nivel: dict[str, str] = {}
            if col_nivel and col_nivel in item_grp.columns:
                for cli, cli_grp in item_grp.groupby("_client_norm"):
                    max_n = _safe_float(cli_grp[col_nivel].apply(_parse_nivel).max())
                    client_nivel[str(cli)] = _format_nivel(max_n)
            # Compute qty per (client, scope)
            scope_names = [
                _normalize(s) for s in ["LEVE", "MEDIO", "PESADO", "UNICO"]
            ]
            has_escopo = col_escopo and col_escopo in item_grp.columns
            client_scope_qty: dict[str, dict[str, float]] = {}
            if has_escopo:
                item_grp["_escopo_n"] = item_grp[col_escopo].apply(
                    lambda v: _normalize(str(v or "").strip())
                )
                if col_fw and col_fw in item_grp.columns:
                    # max per (client, fw, scope) → sum across fws
                    for (cli, fw_val, esc_n), grp in item_grp.groupby(
                        ["_client_norm", col_fw, "_escopo_n"]
                    ):
                        qty = _safe_float(grp[col_qty].max())
                        c_key = str(cli)
                        e_key = str(esc_n).upper()
                        if c_key not in client_scope_qty:
                            client_scope_qty[c_key] = {}
                        client_scope_qty[c_key][e_key] = (
                            client_scope_qty[c_key].get(e_key, 0.0) + qty
                        )
                else:
                    for (cli, esc_n), grp in item_grp.groupby(["_client_norm", "_escopo_n"]):
                        qty = _safe_float(grp[col_qty].max())
                        c_key = str(cli)
                        e_key = str(esc_n).upper()
                        if c_key not in client_scope_qty:
                            client_scope_qty[c_key] = {}
                        client_scope_qty[c_key][e_key] = max(
                            client_scope_qty[c_key].get(e_key, 0.0), qty
                        )
            else:
                # No escopo column: put all qty under no scope key
                if col_fw and col_fw in item_grp.columns:
                    for (cli, fw_val), grp in item_grp.groupby(["_client_norm", col_fw]):
                        qty = _safe_float(grp[col_qty].max())
                        c_key = str(cli)
                        if c_key not in client_scope_qty:
                            client_scope_qty[c_key] = {}
                        client_scope_qty[c_key][""] = (
                            client_scope_qty[c_key].get("", 0.0) + qty
                        )
                else:
                    for cli, grp in item_grp.groupby("_client_norm"):
                        qty = _safe_float(grp[col_qty].max())
                        client_scope_qty[str(cli)] = {"": qty}

            # Build records, sorted by total qty descending
            records: list[dict[str, Any]] = []
            for cli, scope_qty in client_scope_qty.items():
                total_qty = sum(scope_qty.values())
                if total_qty <= 0:
                    continue
                records.append({
                    "client":   cli,
                    "familia":  client_fam.get(cli, ""),
                    "nivel":    client_nivel.get(cli, ""),
                    "qtde_fw":  total_qty,
                    "scopes":   {k: v for k, v in scope_qty.items() if v > 0},
                })
            records.sort(key=lambda r: -r["qtde_fw"])
            if records:
                clients_by_item[item_str] = records

    items: list[dict] = []
    for _, row in grouped_meta.iterrows():
        raw_item = str(row[col_item]).strip()
        qtde_fw  = qty_by_item.get(raw_item, 0.0)
        # Description: use ASSEMBLY-based desc_map (mirrors _build_assembly_desc_map in original)
        descricao = desc_map.get(_normalize(raw_item), "")
        familia_val = _str_val(row.get(col_fam)) if col_fam else ""
        if familia_val.strip().upper() == "NEW LOCOS":
            descricao = f"LOCOMOTIVA COMPLETA TIPO {raw_item}"
        clients   = clients_by_item.get(raw_item, [])
        # nivel: prefer per-item max; fall back to first client's nivel
        nivel     = nivel_by_item.get(raw_item, "")
        if not nivel and clients:
            nivel = clients[0].get("nivel", "")
        entry: dict[str, Any] = {
            "id":        _normalize(raw_item),
            "item":      raw_item,
            "descricao": descricao,
            "familia":   _str_val(row.get(col_fam))    if col_fam    else "",
            "area":      _str_val(row.get(col_area))   if col_area   else "",
            "cliente":   _str_val(row.get(col_client)) if col_client else "",
            "tipo":      _str_val(row.get(col_tipo))   if col_tipo   else "",
            "tipo_fw":   tipo_fw_by_item.get(raw_item, []),
            "qtde_fw":   qtde_fw,
            "wsn":       _str_val(row.get(col_wsn))   if col_wsn    else "",
            "nivel":     nivel,
            "clients":   clients,
            # Whether a routing exists for this code, by the same key the hours request uses.
            # Falls back to WSN only when the frame has no separate ASSEMBLY column to test
            # against (a legacy single-column sheet), where WSN is the only signal there is.
            "has_routing": (
                _normalize(raw_item) in routed_asms if routed_asms
                else bool(_str_val(row.get(col_wsn)) if col_wsn else "")
            ),
        }
        items.append(entry)

    # Só inclui itens com demanda > 0 no período selecionado
    items = [it for it in items if it["qtde_fw"] > 0]
    items.sort(key=lambda x: x["item"])

    return {
        "status":   "ok",
        "message":  f"{len(items)} itens encontrados.",
        "filters": {
            "ano":  ano,
            "mes":  mes,
            "fw":   fw,
            "mode": mode,
        },
        "filter_options": {
            "anos":     anos,
            "meses":    meses_opts,
            "fws":      fws_available,
            "familias": familias,
            "clientes": clientes,
        },
        "mes_fw_map": mes_fw_map,
        "items": items,
    }


# ── Loader com caminho padrão (útil para dev local) ───────────────────────────

def get_items_catalog(
    filepath: str | Path,
    *,
    areas:    list[str] | None = None,
    familias: list[str] | None = None,
    clientes: list[str] | None = None,
    df_override: "pd.DataFrame | None" = None,
) -> dict:
    """
    Returns the full catalog of unique items from the 'Discretizado' sheet,
    with no period/FW filter. Equivalent to AddAssemblyDialog in CapB3356103.py.

    Each item:
      { id, item, descricao, familia, area, cliente }
    Filter options returned:
      { areas, familias, clientes }
    """
    filepath = Path(filepath)
    if not filepath.exists() and df_override is None:
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    if df_override is not None:
        df = df_override
    else:
        try:
            xl = pd.ExcelFile(filepath)
        except Exception as exc:
            return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

        if "Discretizado" not in xl.sheet_names:
            return {"status": "error", "message": "Aba 'Discretizado' não encontrada."}

        try:
            df = xl.parse("Discretizado")
        except Exception as exc:
            return {"status": "error", "message": f"Erro ao ler aba 'Discretizado': {exc}"}

    def fc(*candidates):
        return _find_col(df, list(candidates))

    col_item   = fc("ITEM", "ASSEMBLY")
    col_asm    = fc("ASSEMBLY", "ITEM")   # ASSEMBLY column for description lookup
    col_comp   = fc("COMPONENT", "COMPONENTE")
    col_desc   = fc("DESCRIÇÃO", "DESCRICAO", "DESC", "DESCRIPTION")
    col_fam    = fc("FAMILIA", "FAMILY")
    col_area   = fc("AREA")
    col_client = fc("CLIENTE", "CLIENT", "CUSTOMER")
    col_qty    = fc("QTDE FW", "QTD FW", "QTDE", "QTY")

    if col_item is None:
        return {"status": "error", "message": "Coluna ITEM/ASSEMBLY não encontrada na aba 'Discretizado'."}

    # ── build description map from full dataset BEFORE any dropna ─────────────
    # Mirrors get_assembly_details which uses df_full (no period / item filter).
    # Self-referential rows (ASSEMBLY==COMPONENT) providing the correct description
    # may have a null ITEM column; they must NOT be dropped before building desc_map.
    desc_map = _build_assembly_desc_map(df, col_asm, col_comp, col_desc)

    df = df.dropna(subset=[col_item])

    # ── build set of items that already have QTDE FW demand ──────────────────
    # Items with any row where QTDE FW > 0 are considered "with demand" and should
    # not appear in the AddItemModal (which shows only blank-QTDE-FW catalog entries).
    items_with_demand: set[str] = set()
    if col_qty is not None:
        for raw_item, grp in df.groupby(col_item):
            qty_vals = pd.to_numeric(grp[col_qty], errors='coerce').fillna(0)
            if (qty_vals > 0).any():
                items_with_demand.add(str(raw_item).strip())

    # ── restrict to rows with blank QTDE FW (the user wants only catalog entries
    #    that have no scheduled demand for the family they appear in)
    if col_qty is not None:
        blank_qty_mask = pd.to_numeric(df[col_qty], errors='coerce').isna()
        df = df[blank_qty_mask].copy()

    # ── filter options from blank-QTDE rows (only show options with available items)
    areas_available    = sorted({str(v).strip() for v in df[col_area].dropna().unique() if str(v).strip()}) if col_area else []
    familias_available = sorted({str(v).strip() for v in df[col_fam].dropna().unique()  if str(v).strip()}) if col_fam  else []
    clientes_available = sorted({str(v).strip() for v in df[col_client].dropna().unique() if str(v).strip()}) if col_client else []

    # ── apply optional server-side filters ────────────────────────────────────
    if areas and col_area:
        area_set = {str(a).strip() for a in areas if str(a).strip()}
        if area_set:
            df = df[df[col_area].astype(str).str.strip().isin(area_set)]
    if familias and col_fam:
        fam_set = {str(f).strip() for f in familias if str(f).strip()}
        if fam_set:
            df = df[df[col_fam].astype(str).str.strip().isin(fam_set)]
    if clientes and col_client:
        cli_set = {str(c).strip() for c in clientes if str(c).strip()}
        if cli_set:
            df = df[df[col_client].astype(str).str.strip().isin(cli_set)]

    # ── deduplicate by item ───────────────────────────────────────────────────
    agg_dict: dict[str, Any] = {}
    for col in [col_fam, col_area, col_client]:
        if col:
            agg_dict[col] = "first"

    if agg_dict:
        grouped = df.groupby(col_item, as_index=False).agg(agg_dict)
    else:
        grouped = df[[col_item]].drop_duplicates()

    items: list[dict] = []
    for _, row in grouped.iterrows():
        raw_item = str(row[col_item]).strip()
        # Description: use ASSEMBLY-based desc_map (mirrors _build_assembly_desc_map in original)
        _raw_desc    = desc_map.get(_normalize(raw_item), "")
        _familia_val = _str_val(row.get(col_fam)) if col_fam else ""
        if _familia_val.strip().upper() == "NEW LOCOS":
            _raw_desc = f"LOCOMOTIVA COMPLETA TIPO {raw_item}"
        items.append({
            "id":          _normalize(raw_item),
            "item":        raw_item,
            "descricao":   _raw_desc,
            "familia":     _familia_val,
            "area":        _str_val(row.get(col_area))   if col_area   else "",
            "cliente":     _str_val(row.get(col_client)) if col_client else "",
            "tipo":        "",
            "has_qty_fw":  False,  # always False: we only emit blank-QTDE rows
            "tipo_fw":   [],
            "qtde_fw":   0.0,
            "wsn":       "",
            "nivel":     "",
            "clients":   [],
        })

    items.sort(key=lambda x: x["item"])

    return {
        "status":  "ok",
        "message": f"{len(items)} itens encontrados.",
        "filter_options": {
            "areas":    areas_available,
            "familias": familias_available,
            "clientes": clientes_available,
        },
        "items": items,
    }


def load_default_excel(
    *,
    ano:    int | None = None,
    mes:    int | None = None,
    escopo: str | None = None,
) -> dict:
    """
    Carrega o Excel a partir do caminho padrão (mesmo diretório do módulo).
    Conveniente para desenvolvimento local sem upload.
    """
    default_path = Path(__file__).resolve().parent.parent / "HorasB3.xlsx"
    return load_and_prepare_data(default_path, ano=ano, mes=mes, escopo=escopo)


def compute_capacity_stats(
    filepath: str | Path,
    *,
    headcount_override: dict[str, dict] | None = None,
) -> dict:
    """
    Computa DISPONIVEL_H e ALOCADO_H (KPIs do rodapé).

    DISPONIVEL: capacidade real — por WSN: qtde × lh × disp.
                Fallback per-pessoa: normal_h × disp quando lh = 0.
    ALOCADO   : capacidade máxima — por WSN: qtde × lh.
                Fallback per-pessoa: normal_h quando lh = 0.

    ``headcount_override`` (aba Headcount centralizada, por WSN) é a fonte única quando fornecido —
    inclusive vazio, que significa "sem capacidade cadastrada" e retorna zeros. Antes esta função só
    lia as abas HeadCount/Testes do HorasB3.xlsx e, como esse arquivo não existe em produção,
    devolvia zeros sempre — os KPIs do rodapé nunca refletiram a aba Headcount.

    O caminho Excel (filepath) permanece apenas como fallback offline/dev quando nada é fornecido; a
    aba 'Testes' (capacidade por pessoa) continua sendo lida dali, pois não foi migrada.
    """
    filepath = Path(filepath)

    headcount_by_wsn: dict[str, dict] = {}
    capacity_by_person: dict[str, dict] = {}

    # A aba 'Testes' (horas por pessoa) só existe no Excel e é usada apenas no fallback lh = 0.
    if filepath.exists():
        try:
            xl = pd.ExcelFile(filepath)
            if "Testes" in xl.sheet_names:
                try:
                    capacity_by_person = _parse_employee_capacity(xl.parse("Testes"))
                except Exception as exc:
                    logger.warning("Erro ao processar 'Testes': %s", exc)
            if headcount_override is None and "HeadCount" in xl.sheet_names:
                try:
                    headcount_by_wsn = _parse_headcount(xl.parse("HeadCount"))
                except Exception as exc:
                    logger.warning("Erro ao processar 'HeadCount': %s", exc)
        except Exception as exc:
            logger.warning("Falha ao abrir Excel para capacity stats: %s", exc)
    elif headcount_override is None:
        # Sem override e sem Excel não há como calcular — zeros (como antes), não erro.
        return {"status": "ok", "disponivel_h": 0.0, "alocado_h": 0.0}

    if headcount_override is not None:
        headcount_by_wsn = headcount_override

    disponivel_h = 0.0
    alocado_h    = 0.0

    for _wsn, hc in headcount_by_wsn.items():
        qtde = hc.get("qtde", 0)
        disp = hc.get("disp", 1.0)
        lh   = hc.get("lh",   0.0)

        if lh > 0:
            alocado_h    += qtde * lh
            disponivel_h += qtde * lh * disp
        else:
            # Fallback: soma as horas individuais de cada pessoa no WSN
            for person_name in hc.get("people", []):
                cap  = capacity_by_person.get(_normalize(person_name), {})
                ph   = cap.get("normal_h", 0.0)
                pdisp = cap.get("disp",   1.0)
                alocado_h    += ph
                disponivel_h += ph * pdisp

    return {
        "status":       "ok",
        "disponivel_h": round(disponivel_h, 1),
        "alocado_h":    round(alocado_h,    1),
    }


def get_wsn_people_map(
    filepath: str | Path,
    *,
    headcount_override: dict[str, dict] | None = None,
) -> dict:
    """
    Lightweight: returns the full WSN → people mapping.
    No period filtering — people skills are static data.

    ``headcount_override`` (the centralized Headcount tab, keyed by WSN) is the SINGLE SOURCE when
    supplied — including when empty, which means "nobody is allocated", not "fall back to the
    routing". This replaced reading the routing's HEADCOUNT column, which is no longer imported.

    ``filepath`` remains only for the legacy offline path (a local HorasB3.xlsx) used when no override
    is passed at all, i.e. a DB-less dev run. The former ``df_override`` parameter was dropped with
    the cutover: it existed solely to scan the routing frame's HEADCOUNT column, which no longer
    exists, and no caller passed it any more.

    Returns:
      { "status": "ok", "people_by_wsn": { wsn: [person, ...] } }
    """
    filepath = Path(filepath)

    # ── Headcount tab (authoritative) ─────────────────────────────────────────
    if headcount_override is not None:
        return {
            "status": "ok",
            "people_by_wsn": {
                wsn: list(hc.get("people", []))
                for wsn, hc in headcount_override.items()
                if hc.get("people")
            },
        }

    # ── Legacy Excel path (no DB) ─────────────────────────────────────────────
    if not filepath.exists():
        return {"status": "error", "message": f"Arquivo não encontrado: {filepath}"}

    try:
        xl = pd.ExcelFile(filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Falha ao abrir Excel: {exc}"}

    people_by_wsn: dict[str, list[str]] = {}

    # Legacy workbooks still carry the inline HEADCOUNT column on 'Discretizado'; this branch only
    # runs when there is no DB at all, so reading it here cannot resurrect it as a live source.
    if "Discretizado" in xl.sheet_names:
        try:
            df = xl.parse("Discretizado")
            col_wsn = _find_col(df, ["WSN"])
            col_hc  = _find_col(df, ["HEADCOUNT"])
            if col_wsn and col_hc:
                df = df.dropna(subset=[col_wsn])
                for wsn_val, grp in df.groupby(col_wsn):
                    wsn_key = str(wsn_val).strip()
                    people = set()
                    for raw in grp[col_hc].dropna():
                        people.update(_split_people(raw))
                    if people:
                        people_by_wsn[wsn_key] = sorted(people)
        except Exception as exc:
            logger.warning("Erro ao ler Discretizado para people_by_wsn: %s", exc)

    # ── HeadCount sheet — enriches / fills gaps ───────────────────────────────
    if "HeadCount" in xl.sheet_names:
        try:
            headcount_by_wsn = _parse_headcount(xl.parse("HeadCount"))
            for wsn, hc in headcount_by_wsn.items():
                if wsn not in people_by_wsn or not people_by_wsn[wsn]:
                    if hc["people"]:
                        people_by_wsn[wsn] = hc["people"]
        except Exception as exc:
            logger.warning("Erro ao ler HeadCount para people_by_wsn: %s", exc)

    return {"status": "ok", "people_by_wsn": people_by_wsn}


def _build_fw_year_map(df: "pd.DataFrame | None") -> dict[str, int]:
    """Map each fiscal-week key → its calendar year, read from the demand rows.

    Uses the imported FW and ANO columns (both present in monthly_demand): every
    demand row tags its FW with the ANO/MES it belongs to, so each FW resolves to
    its own year. This makes the shared-calendar FW→date mapping exact even when
    a period spans two fiscal years. Empty when the columns are unavailable.
    """
    if df is None:
        return {}
    col_fw  = _find_col(df, ["FW"])
    col_ano = _find_col(df, ["ANO", "YEAR"])
    if not col_fw or not col_ano:
        return {}
    out: dict[str, int] = {}
    try:
        sub = df[[col_fw, col_ano]].dropna(subset=[col_fw, col_ano])
        for fw_val, ano_val in zip(sub[col_fw], sub[col_ano]):
            key = _fw_key(fw_val)
            if not key or key in out:
                continue
            try:
                out[key] = int(float(ano_val))
            except (ValueError, TypeError):
                continue
    except Exception as exc:
        logger.warning("Erro ao mapear FW→ANO: %s", exc)
    return out


def get_period_days(
    filepath: str | Path,
    fws: list[str],
    *,
    df_override: "pd.DataFrame | None" = None,
) -> dict:
    """
    Given a list of FW identifiers (e.g. ["17", "18"]), return the working days
    per fiscal week, computed from the SHARED 4-4-5 calendar engine
    (services.calendar_445) — the same engine the Schedule/Gantt app uses.

    This replaces the previous behaviour of summing the pre-baked WEEK_1/DAYS_1
    columns of the Discretizado sheet: both applications now derive working days
    from one source (B3 holidays + working-day logic + Jan-1 fiscal weeks). Each
    fiscal week is mapped to its calendar year via the imported FW + ANO columns,
    so the FW→date mapping is exact even across a year boundary.

    Each FW is counted at most once (dedup).

    Returns:
      { "status": "ok", "total_days": N, "days_by_fw": { fw: days } }
    """
    filepath = Path(filepath)

    if not fws:
        return {"status": "ok", "total_days": 0, "days_by_fw": {}}

    # ── DB override path ──────────────────────────────────────────────────────
    if df_override is not None:
        try:
            year_by_fw = _build_fw_year_map(df_override)
            dbf = calendar_445.days_by_fw_for_years(fws, year_by_fw)
            return {"status": "ok", "total_days": sum(dbf.values()), "days_by_fw": dbf}
        except Exception as exc:
            logger.warning("Erro ao calcular days_by_fw (override): %s", exc)
            return {"status": "ok", "total_days": 0, "days_by_fw": {}}

    # ── Excel path (read FW + ANO to map each fiscal week to its year) ────────
    df_for_year: "pd.DataFrame | None" = None
    if filepath.exists():
        try:
            xl = pd.ExcelFile(filepath)
            if "Discretizado" in xl.sheet_names:
                df_for_year = xl.parse("Discretizado")
        except Exception as exc:
            logger.warning("Falha ao abrir Excel para mapear FW→ANO: %s", exc)

    try:
        year_by_fw = _build_fw_year_map(df_for_year)
        dbf = calendar_445.days_by_fw_for_years(fws, year_by_fw)
        return {"status": "ok", "total_days": sum(dbf.values()), "days_by_fw": dbf}
    except Exception as exc:
        logger.warning("Erro ao calcular days_by_fw: %s", exc)
        return {"status": "error", "message": str(exc)}