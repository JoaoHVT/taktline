"""
tipos.py — the backend mirror of the "Tipo Geral" registry.

MIRROR OF `frontend/src/lib/tipos.ts`. The two must state the same Linhas and the same flags,
or backend detection and frontend rendering disagree about the same two boxes — which is the
bug the registry was extracted to end. There is no build step joining Python and TypeScript, so
this file being a copy is unavoidable; what is avoidable is the copy being spread across two
modules, which is what it used to be (`gantt_builder._LINHA_TO_TIPO`).

THE FLAG, and why the rules gate on it:

`schedule_backed` says the Tipo's hours come from the Schedule. Every scheduling rule here is
written against that assumption — the cross-Type WS overlap exemption and the same-Type
routing fallback both mean "these two things are laid out on the same calendar". A Tipo whose
hours come from somewhere else does not merely fail those rules, it has no standing in them.
So they check the flag rather than listing the Tipos they happen to accept, and a new
non-schedule-backed Tipo is excluded from the day it is registered.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TipoDef:
    key: str
    label: str
    # Schedule "Linha" values that classify into this Tipo. EMPTY for a Tipo that is not
    # derived from a Linha at all: such a Tipo is stamped on a row by its SOURCE, so
    # `tipo_geral()` can never return it.
    linhas: tuple[str, ...] = field(default=())
    schedule_backed: bool = True
    has_loco: bool = True


# One Tipo, two Linhas: the lines are parallel streams of the same kind of work, which is what
# a Linha is for. They stay distinct because the per-stream rules read them.
TIPOS: tuple[TipoDef, ...] = (
    TipoDef("montagem", "Montagem", ("Linha 1", "Linha 2")),
)

TIPO_KEYS: tuple[str, ...] = tuple(t.key for t in TIPOS)
SCHEDULE_TIPO_KEYS: tuple[str, ...] = tuple(t.key for t in TIPOS if t.schedule_backed)

_BY_KEY: dict[str, TipoDef] = {t.key: t for t in TIPOS}


def _norm_linha(linha: object) -> str:
    """Fold a Linha for lookup. Accent stripping is applied by the CALLER in gantt_builder
    (which owns `_strip_acc`); here the fold is case + whitespace, which is what the optimizer
    and every other consumer need. Kept deliberately dependency-free so this module can be
    imported from anywhere in the backend without dragging the Excel stack along."""
    return str(linha or "").strip().lower()


_BY_LINHA: dict[str, str] = {
    _norm_linha(l): t.key for t in TIPOS for l in t.linhas
}


def tipo_geral(linha: object) -> str:
    """Classify a Schedule "Linha" into its Tipo.

    Mirrors `tipos.tipoOfLinha` on the frontend and `tipoOfLinha` in the worker. An absent or
    unrecognized Linha collapses to "other", which matches ITSELF — so a Schedule with no Linha
    column keeps its same-Type fallbacks working rather than losing them all at once.
    """
    return _BY_LINHA.get(_norm_linha(linha), "other")


def is_registered(tipo: object) -> bool:
    """True when this string is an actual registered Tipo.

    Distinct from `is_schedule_backed`, and the distinction matters: "other" is NOT a Tipo — it
    is what an absent or unrecognized Linha collapses to — and it is load-bearing. A Schedule
    with no Linha column has every LOCO as "other", and "other" matching ITSELF is what keeps
    the same-Type routing fallback working for such a Schedule.

    So a rule that means "exclude a Tipo that is not laid out on the Schedule" must ask
    `is_registered(t) and not is_schedule_backed(t)`, not `not is_schedule_backed(t)` — the
    latter would also catch "other" and silently disable those fallbacks.
    """
    return str(tipo or "") in _BY_KEY


def is_schedule_backed(tipo: object) -> bool:
    """True when this Tipo's hours come from the Schedule.

    "other" and any unregistered string answer False. That is the safe direction: an unknown
    Tipo is not admitted to a scheduling rule by default. It does NOT change existing
    behaviour — every rule now guarded by this flag already excluded "other" explicitly.
    """
    t = _BY_KEY.get(str(tipo or ""))
    return bool(t and t.schedule_backed)


def has_loco(tipo: object) -> bool:
    """True when this Tipo has LOCO instances. Unregistered / "other" answer False."""
    t = _BY_KEY.get(str(tipo or ""))
    return bool(t and t.has_loco)


def label(tipo: str) -> str:
    """Display label; falls back to the raw key so an unknown value stays visible."""
    t = _BY_KEY.get(tipo)
    return t.label if t else tipo
