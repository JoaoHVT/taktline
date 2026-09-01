"""
models.py
---------
SQLAlchemy ORM models for Taktline data.

Table: monthly_demand
  Mirrors each row of the source "Discretizado" sheet.
  row_json stores the complete original row so _db_to_df() can reconstruct
  a DataFrame that is byte-for-byte identical to xl.parse("Discretizado").
  Shortcut columns (item, wsn, ano, mes, fw, etc.) are kept as indexed
  copies for fast ORM filtering in the items-catalog endpoint.

Table: solver_jobs
  Transient storage for optimization job state so any worker/replica can
  read the progress of a job started by a different process.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Integer, String, Float, Text, Index, UniqueConstraint,
    PrimaryKeyConstraint, ForeignKey,
)
from sqlalchemy.orm import Session, declarative_base

Base = declarative_base()


class DbConfig(Base):
    """
    Key/value store for versioning pointers used by staged import.
    Keys: "active_ver:monthly_demand", "active_ver:schedule", "active_ver:locos_rout"
    Values: "0" or "1" (the currently live version of that table).
    """
    __tablename__ = "db_config"

    key = Column(String, primary_key=True)
    val = Column(Text, nullable=False, default="0")


def get_active_ver(db: Session, table: str) -> int:
    """Return the currently active dataset version (0 or 1) for a table."""
    try:
        row = db.query(DbConfig).filter(DbConfig.key == f"active_ver:{table}").first()
        return int(row.val) if row else 0
    except Exception:
        return 0


def set_active_ver(db: Session, table: str, ver: int) -> None:
    """Atomically record a new active version for a table."""
    try:
        existing = db.query(DbConfig).filter(DbConfig.key == f"active_ver:{table}").first()
        if existing:
            existing.val = str(ver)
        else:
            db.add(DbConfig(key=f"active_ver:{table}", val=str(ver)))
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"set_active_ver({table}, {ver}) failed: {exc}") from exc


class MonthlyDemand(Base):
    """
    One row per demand record from the Discretizado sheet.
    row_json holds ALL original columns as a JSON string.
    ver: staging version bit (0 or 1). Only rows matching active_ver are live.
    """
    __tablename__ = "monthly_demand"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    # Dataset version: 0 or 1 (matches active_ver in db_config)
    ver      = Column(Integer, nullable=False, default=0, server_default="0", index=True)

    # ── Full original row (all columns, exact names & values) ────
    row_json = Column(Text, nullable=False)          # JSON-encoded original row dict

    # ── Indexed shortcut columns for fast ORM queries ────────────
    item      = Column(String, nullable=False, index=True)  # ITEM column value (or "")
    assembly  = Column(String, nullable=True)               # ASSEMBLY column value
    component = Column(String, nullable=True)               # COMPONENT
    descricao = Column(String, nullable=True)               # DESCRIÇÃO
    familia   = Column(String, nullable=True, index=True)   # FAMILIA
    area      = Column(String, nullable=True)               # AREA
    cliente   = Column(String, nullable=True, index=True)   # CLIENTE
    tipo      = Column(String, nullable=True)               # TIPO
    tipo_fw   = Column(String, nullable=True)               # TIPO FW
    nivel     = Column(String, nullable=True)               # NIVEL
    escopo    = Column(String, nullable=True)               # ESCOPO
    ano       = Column(Integer, nullable=True, index=True)  # ANO
    mes       = Column(Integer, nullable=True, index=True)  # MES (1-12)
    fw        = Column(String,  nullable=True, index=True)  # FW
    qtde_fw   = Column(Float,   nullable=True)              # QTDE FW
    hh_total  = Column(Float,   nullable=True)              # HH TOTAL
    wsn       = Column(String,  nullable=True, index=True)  # WSN
    headcount = Column(String,  nullable=True)              # HEADCOUNT
    lh        = Column(Float,   nullable=True)              # LH
    lm        = Column(Integer, nullable=True)              # LM
    turnos    = Column(Integer, nullable=True)              # TURNOS
    custo     = Column(Float,   nullable=True)              # CUSTO

    # ── Composite indexes for common query patterns ───────────────
    __table_args__ = (
        Index("ix_monthly_demand_ano_mes",    "ano", "mes"),
        Index("ix_monthly_demand_ano_mes_fw", "ano", "mes", "fw"),
        Index("ix_monthly_demand_item_mes",   "item", "mes"),
    )

    def to_dict(self) -> dict:
        return {
            "id":        self.id,
            "item":      self.item,
            "assembly":  self.assembly,
            "component": self.component,
            "descricao": self.descricao,
            "familia":   self.familia,
            "area":      self.area,
            "cliente":   self.cliente,
            "tipo":      self.tipo,
            "tipo_fw":   self.tipo_fw,
            "nivel":     self.nivel,
            "escopo":    self.escopo,
            "ano":       self.ano,
            "mes":       self.mes,
            "fw":        self.fw,
            "qtde_fw":   self.qtde_fw,
            "hh_total":  self.hh_total,
            "wsn":       self.wsn,
            "headcount": self.headcount,
            "lh":        self.lh,
            "lm":        self.lm,
            "turnos":    self.turnos,
            "custo":     self.custo,
        }


class SolverJob(Base):
    """
    Transient storage for optimization job state.
    Written by the worker handling POST /api/optimize so that any worker
    (or a later reconnect) can retrieve it from the shared DB.
    Rows older than 24 h are pruned on startup.
    """
    __tablename__ = "solver_jobs"

    job_id     = Column(String(36), primary_key=True)  # UUID string
    data       = Column(Text, nullable=False)           # JSON-encoded job dict
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))


class ScheduleRow(Base):
    """
    One row per entry from the 'Schedule - MS' sheet.
    ver: staging version bit (0 or 1).
    """
    __tablename__ = "schedule"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    ver        = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    row_json   = Column(Text, nullable=False)
    # NOT indexed — gantt_builder reads this table only as filter(ver == active).all()
    # and the dataset editor fetches by id; nothing filters on wo/task_name in SQL.
    wo         = Column(String, nullable=False)               # Standard WO
    task_name  = Column(String, nullable=True)                # Task Name
    start_ms   = Column(String, nullable=True)                # Start MS (ISO date string)
    takt       = Column(Float, nullable=True)                 # Takt (supports 0.5 increments)
    linha      = Column(String, nullable=True)                # Linha (line number / type)
    finish_ms  = Column(String, nullable=True)                # Finish MS (ISO date string)
    # Contratual — the CONTRACTUAL finish date. An independent, display-only field: nothing in the
    # scheduling maths reads it (the schedule's own end stays finish_ms). Null when the sheet has no
    # contractual date for the loco, which the UI renders as "-".
    contract_ms = Column(String, nullable=True)               # Contratual (ISO date string)

    # ix_schedule_wo_task removed with the single-column indexes above — see
    # import_excel_to_db.py::_UNUSED_INDEXES.


class LocosRout(Base):
    """
    One row per entry from the 'Locos Rout' sheet.
    ver: staging version bit (0 or 1).
    """
    __tablename__ = "locos_rout"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    ver         = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    row_json    = Column(Text, nullable=False)
    # NOT indexed. gantt_builder and actual_hours_spike both read this table whole
    # (filter(ver == active)) and join in pandas/Python; the editor fetches by id.
    # This is the largest base, so the per-INSERT index maintenance cost the most here.
    locomotiva  = Column(String, nullable=False)               # LOCOMOTIVA
    part_number = Column(String, nullable=True)                # PART NUMBER
    workstation = Column(String, nullable=True)                # WORKSTATION
    subarea     = Column(String, nullable=True)                # SUBAREA
    descricao   = Column(String, nullable=True)                # DESCRIÇÃO
    area        = Column(String, nullable=True)                # AREA
    hh_unit     = Column(Float,  nullable=True)                # HH UNIT
    qtd         = Column(Integer, nullable=True)               # QTD
    duracao     = Column(String, nullable=True)                # DURACAO (can be "Takt")
    inicio      = Column(String, nullable=True)                # INICIO (formula string)
    workorder   = Column(String, nullable=True)                # WORKORDER (manufacturing order no.)
    # Three source columns consumed ONLY by the Plano de Produção grid. They are pure
    # pass-through: nothing in the scheduling maths reads them, and a blank source cell
    # stays blank downstream (no fallback / placeholder).
    part_desc   = Column(String, nullable=True)                # PART DESC  → DESCRIÇÃO column
    escopo      = Column(String, nullable=True)                # ESCOPO     → ESCOPO column
    linha       = Column(String, nullable=True)                # LINHA      → LINHA column

    # ix_locos_rout_loco_pn removed with the single-column indexes above — see
    # import_excel_to_db.py::_UNUSED_INDEXES.


# ── Split of the 'Discretizado' sheet into two independent datasets ───────────
# The single Discretizado sheet mixes two grains: a routing/BOM master (per
# ASSEMBLY/COMPONENT/WS operation, period-independent) and a production plan
# (per ITEM/period demand). These two tables store each grain separately so they
# can be imported/refreshed/validated independently. row_json holds ONLY that
# grain's owned columns; the wide Discretizado DataFrame is reconstructed by
# joining the two on ITEM ⇄ ASSEMBLY (see main._db_to_df_split). monthly_demand
# is retained for backward-compatibility / side-by-side parity validation.

class ItensRout(Base):
    """
    Routing / BOM master grain of the Discretizado sheet ('Itens Rout').
    One row per operation. row_json holds the routing-owned columns only.
    Linking key: assembly (joins to PlanoProd.item).
    ver: staging version bit (0 or 1).
    """
    __tablename__ = "itens_rout"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    ver       = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    row_json  = Column(Text, nullable=False)          # routing-owned columns only

    # NOT indexed, deliberately. Nothing queries these columns: every read of this
    # table is `filter(ver == active).all()` on row_json (main.py::_db_to_df_split) or
    # a by-id fetch from the dataset editor. They are shortcut copies kept for
    # readability and for the editor's write path — indexing them only taxed every
    # INSERT during import. See import_excel_to_db.py::_drop_unused_indexes, which
    # drops the pre-existing ones from live databases.
    assembly  = Column(String, nullable=True)               # ASSEMBLY (link key)
    component = Column(String, nullable=True)               # COMPONENT
    descricao = Column(String, nullable=True)               # DESCRIÇÃO
    wsn       = Column(String, nullable=True)               # WSN — routing key; maps to Headcount tab
    escopo    = Column(String, nullable=True)               # ESCOPO
    hh_total  = Column(Float,   nullable=True)              # HH TOTAL

    # ── DEPRECATED: capacity migrated to the Headcount tab (Workstation/Person/WorkstationPerson) ──
    # No longer written by import_itens_rout_to_db (which drops these columns from the sheet before
    # persisting) and no longer read anywhere: capacity comes from main.py::_headcount_source_dict,
    # keyed by WSN. Retained as nullable, unwritten columns so the cutover needed no destructive
    # migration and pre-cutover rows keep their history readable. Safe to DROP in a later migration.
    headcount = Column(String, nullable=True)               # HEADCOUNT (deprecated)
    lh        = Column(Float,   nullable=True)              # LH       (deprecated)
    lm        = Column(Integer, nullable=True)              # LM       (deprecated)
    turnos    = Column(Integer, nullable=True)              # TURNOS   (deprecated)

    # Composite indexes removed with the single-column ones above. The comment that
    # used to sit on ix_itens_rout_asm_wsn ("needed for the Headcount mapping") was
    # stale: _headcount_source_dict reads the Workstation table, never this one.


class PlanoProd(Base):
    """
    Production-plan grain of the Discretizado sheet ('Plano Prod').
    One row per (ITEM, period). row_json holds the plan-owned columns only.
    Linking key: item (joins to ItensRout.assembly).
    ver: staging version bit (0 or 1).
    """
    __tablename__ = "plano_prod"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    ver       = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    row_json  = Column(Text, nullable=False)          # plan-owned columns only

    # NOT indexed — same reasoning as ItensRout above: this table is only ever read
    # whole by ver (row_json) or by id from the editor. Period filtering happens in
    # pandas, on the reconstructed frame, never in SQL.
    item      = Column(String, nullable=False)              # ITEM (link key)
    cliente   = Column(String, nullable=True)               # CLIENTE
    area      = Column(String, nullable=True)               # AREA
    familia   = Column(String, nullable=True)               # FAMILIA
    ano       = Column(Integer, nullable=True)              # ANO
    mes       = Column(Integer, nullable=True)              # MES (1-12)
    fw        = Column(String,  nullable=True)              # FW
    qtde_fw   = Column(Float,   nullable=True)              # QTDE FW
    tipo_fw   = Column(String,  nullable=True)              # TIPO FW
    nivel     = Column(String,  nullable=True)              # NIVEL
    custo     = Column(Float,   nullable=True)              # CUSTO


class ScheduleOverride(Base):
    """
    User-saved Gantt edits, stored as a DELTA layer over the base schedule. This table NEVER
    modifies the source `schedule`/`locos_rout` tables:  Original Data + Override = Effective.

    One row per edited OBJECT — a LOCO, a Workstation, or a Componente (description row) —
    uniquely identified by (scenario_id, loco_key, scope, scope_key). Editing the same object
    again UPDATES its row instead of inserting a duplicate (enforced by the UNIQUE constraint),
    and an object whose edit is cleared has its row DELETED. The merge back into a final schedule
    happens at load time on the client (the worker's applyOverrideToGroup), so the original data
    is reconstructed untouched and only the deltas are persisted.

      scenario_id : '' = the base DB schedule (the only scope persisted today). A future
                    per-uploaded-scenario layer would store the scenario UUID here. Kept NON-NULL
                    so the UNIQUE constraint actually enforces (Postgres treats NULLs as distinct).
      loco_key    : "linha||wo||task_name||start_ms" (matches the frontend locoKey).
      scope       : 'loco' | 'ws' | 'desc' | 'addws'.
      scope_key   : '' for loco; wsEditKeyOf(ws) for ws/addws; descEditKeyOf(ws,subarea,desc) for desc.
      payload_json: the ScopedEdit JSON — {takt?, startShiftDays?, finishShiftDays?, propagate?} —
                    or, for 'addws', the AddedWorkstation JSON (a manually-inserted station's absolute
                    geometry: {ws, startIso, durationDays, hoursTotal, itemQty, workorder, desc?}).
    """
    __tablename__ = "schedule_override"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    scenario_id  = Column(String, nullable=False, default="", server_default="", index=True)
    loco_key     = Column(String, nullable=False, index=True)
    scope        = Column(String, nullable=False)              # 'loco' | 'ws' | 'desc' | 'addws'
    scope_key    = Column(String, nullable=False, default="", server_default="")
    payload_json = Column(Text,   nullable=False)
    updated_at   = Column(DateTime, nullable=False,
                          default=lambda: datetime.now(timezone.utc),
                          onupdate=lambda: datetime.now(timezone.utc))
    updated_by   = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("scenario_id", "loco_key", "scope", "scope_key",
                         name="uq_schedule_override_object"),
        Index("ix_schedule_override_lookup", "scenario_id", "loco_key"),
    )


class ScenarioSaturdayWorkday(Base):
    """
    Per-scenario set of Saturdays promoted to WORKING days (one row per scenario). Distinct from the
    GLOBAL, admin-governed `calendar_override` (kind='working'): this is a lightweight, per-scenario
    schedule-editing artifact in the SAME lane as loco overrides (editor + app-password, applied
    CLIENT-SIDE with no recompute). The client simply flips `date_info[iso].is_weekend` to False for
    these dates, so the Saturday joins the business-day axis and WS40/WS50 work can sit on it.

    Its purpose is Saturday RETENTION for a saved optimization: baking an optimization that used
    "Usar Sábados" auto-registers exactly the Saturdays the optimizer used, so a reload re-creates
    those working-Saturday columns and the baked overrides place work on them (instead of folding to
    a weekday). Only the dates actually used are registered — nothing global is normalized.

      scenario_id : '' = base DB schedule; a scenario name otherwise (matches ScheduleOverride).
      dates_json  : JSON array of ISO 'YYYY-MM-DD' Saturday dates. Kilobytes at most.
    """
    __tablename__ = "scenario_saturday_workday"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    scenario_id = Column(String, nullable=False, default="", server_default="", index=True)
    dates_json  = Column(Text,   nullable=False, default="[]", server_default="[]")
    updated_at  = Column(DateTime, nullable=False,
                         default=lambda: datetime.now(timezone.utc),
                         onupdate=lambda: datetime.now(timezone.utc))
    updated_by  = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("scenario_id", name="uq_scenario_saturday_workday"),
    )


class ProjectionBaseline(Base):
    """
    VERSIONED history of the Projeção (Schedule Mode 3) deviation reference. Each "Atualizar
    referência" freeze APPENDS a row instead of overwriting, so the accumulated delay history is
    never lost: re-baselining resets the INCREMENTAL deviation to zero (measured vs the latest
    version) while the CUMULATIVE deviation (vs version 0, the original reference of record) stays
    recoverable. Shared per scenario — Editor+ appends (app-password gated), everyone reads.

    Supersedes the single-snapshot `__projref__:` rows in schedule_override (which are kept in sync
    on write for back-compat and lazily adopted as version 0 when this table is empty).

      scenario_id : '' = base DB schedule; a scenario name otherwise (matches ScheduleOverride).
      version     : monotonic per scenario. 0 = the FIRST freeze (the reference of record); each later
                    freeze is version+1. Cumulative deviation is measured against version 0.
      payload_json: the full LocoOverrideMap JSON frozen at this version (the standard schedule then).
      label       : optional free-text name for the freeze (e.g. a milestone), else NULL.
    """
    __tablename__ = "projection_baseline"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    scenario_id  = Column(String, nullable=False, default="", server_default="", index=True)
    version      = Column(Integer, nullable=False)
    payload_json = Column(Text,   nullable=False)
    label        = Column(String, nullable=True)
    created_at   = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    created_by   = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("scenario_id", "version", name="uq_projection_baseline_ver"),
        Index("ix_projection_baseline_lookup", "scenario_id", "version"),
    )


class UserPermission(Base):
    """
    Access-control role + account state for a user. Roles form a ladder: Reader < Editor < Admin.

    Every user who logs in is now recorded here (auto-registered as Reader on first login),
    so admins have a full roster and per-user state (blocked flag, last login, lockout
    history) has a row to live on. The lookup key is the `username` = the portion of the
    e-mail BEFORE the '@' (e.g. "demo" from "demo@example.com"),
    lower-cased, so identity is independent of the e-mail domain.

      role       : 'reader' | 'editor' | 'admin'.
      is_blocked : hard access denial, ORTHOGONAL to role — a blocked user is denied the
                   whole application (403) even though they authenticate successfully,
                   and keeps their original role for restoration on unblock. Superadmins
                   (SUPERADMIN_USERNAMES) can never be blocked.

    This row is also the CREDENTIAL: `password_hash`
    holds the PBKDF2 derivation of the user's own password (see services.auth) and this
    table is the identity store, not just the permission list. Existing rows had no
    password — main._bootstrap_local_credentials generates one for each on the first boot
    after the migration, which is what keeps every previously-registered user (and their
    role) working instead of being wiped and re-created.
    """
    __tablename__ = "user_permissions"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, nullable=False, index=True)   # e-mail local-part, lower-cased
    role     = Column(String, nullable=False)               # 'reader' | 'editor' | 'admin'

    # ── Credential ───────────────────────────────────────────────────────────────
    # `email` is the full address the user signed up with. It is kept ALONGSIDE username
    # rather than replacing it because username is the lookup key everywhere in main.py
    # (roles, audit trail, blocked cache, presence) and rewriting that key during an
    # emergency auth swap would be the change most likely to lose an existing account.
    email                = Column(String, nullable=True)
    password_hash        = Column(String, nullable=True)   # pbkdf2_sha256$iter$salt$hash
    password_set_at      = Column(DateTime, nullable=True)
    # True while the account still carries a password somebody ELSE chose (the migration's
    # generated password, or an admin reset). Purely advisory: the app nags, but never
    # locks the user out of their own account over it.
    must_change_password = Column(Boolean, nullable=False, default=False, server_default="false")

    # ── Account state / audit (added for the roster + banned + warning features) ──
    is_blocked          = Column(Boolean, nullable=False, default=False, server_default="false", index=True)
    created_at          = Column(DateTime, nullable=True, default=lambda: datetime.now(timezone.utc))
    last_login          = Column(DateTime, nullable=True)
    last_activity       = Column(DateTime, nullable=True, index=True)  # refreshed per request (throttled) → online indicator
    lockout_count       = Column(Integer, nullable=False, default=0, server_default="0")
    last_lockout_at     = Column(DateTime, nullable=True)
    warning_ack_at      = Column(DateTime, nullable=True)   # admin acknowledged the current warning
    last_role_change_at = Column(DateTime, nullable=True)
    last_role_change_by = Column(String,   nullable=True)   # username of the admin who last changed role/block

    __table_args__ = (
        UniqueConstraint("username", name="uq_user_permission_username"),
    )


class SecurityEvent(Base):
    """
    Append-only audit trail of security-relevant events. Rows are NEVER deleted — the source
    of truth for the admin audit view and lockout/warning history.

      event_type : 'lockout' | 'user_registered' | 'role_change' | 'block' | 'unblock' |
                   'ack_warning' | 'calendar_change' | 'saturday_change' | 'data_edit_summary' |
                   'data_import' | 'data_download' | 'schedule_save' | 'schedule_reset' |
                   'schedule_ref_freeze' | 'admin_pw_fail' | 'import_pw_fail' | 'perm_denied' | …
                   ('first_login', 'admin_pw_used' and 'import_pw_used' are no longer WRITTEN —
                    each duplicated a record that already existed — but historical rows remain.
                    'data_edit' (one row per edited row) is replaced by ONE 'data_edit_summary'
                    per save carrying the per-row detail; 'protected_access' — merely opening a
                    protected screen — is no longer recorded at all.)
      actor      : who caused it ('system' for automated events like lockout/first_login)
      target     : the username the event is ABOUT

    The same trail doubles as the ADMIN NOTIFICATION feed: an event with acknowledged_at IS NULL
    is an ACTIVE alert (drives the header badge count); acknowledging it stamps
    acknowledged_at/acknowledged_by, which moves it out of the active feed and into history WITHOUT
    deleting the audit row. This is the ONLY mutation the table ever receives (ack metadata); the
    original event fields stay append-only.
    """
    __tablename__ = "security_events"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    ts              = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), index=True)
    actor           = Column(String, nullable=True, index=True)
    target          = Column(String, nullable=True, index=True)
    event_type      = Column(String, nullable=False, index=True)
    detail          = Column(Text,   nullable=True)
    # ── Machine-readable change payload — FORENSICS ONLY, never displayed ────────────────────
    # `detail` is the one-sentence summary the admin panels render, so it must stay short: it used
    # to have a JSON tail listing every changed row appended to it, which turned each notification
    # into a wall of record-level data and published the edited VALUES to anyone with the panel
    # open. The payload itself is still worth keeping (what a save actually changed is the only
    # forensic record of it), so it lives here instead — ONE row per batch carrying the whole
    # save, not one row per changed record.
    #
    # Shape (data_edit_summary): {"dataset": key, "counts": {...}, "ops": [...], "opsTotal": n}.
    # Bounded on write (capped op count + byte cap) so a huge save cannot store an unbounded blob.
    # DELIBERATELY absent from every API response — _alert_dict and /api/security/events do not
    # select it, so exposing it later is an explicit decision that has to re-apply the usual gate
    # (auth + admin role + second factor), not something a payload quietly starts including.
    detail_json     = Column(Text,   nullable=True)
    # Admin-notification acknowledgement (NULL ⇒ active/unread alert). Set once when an admin
    # marks the alert reviewed; the row is retained for auditing either way.
    acknowledged_at = Column(DateTime, nullable=True, index=True)
    acknowledged_by = Column(String,   nullable=True)

    __table_args__ = (
        Index("ix_security_events_target_ts", "target", "ts"),
    )


class CalendarOverride(Base):
    """
    Admin-editable working-calendar EXCEPTIONS layer (sparse delta over the algorithmic
    base calendar in services/calendar_445.py). The base engine still computes weekends
    (Mon-Fri) + Brazilian/B3 holidays algorithmically for any year; this table stores ONLY
    the per-day exceptions an admin declares, so "add a future year" keeps working with no
    rows at all and the table stays tiny.

    One row per affected calendar date (unique). Semantics:
      kind = 'holiday'  → force the day NON-WORKING (company holiday, or convert an otherwise
                          working weekday to a day off). Folded INTO the holiday set so every
                          `d not in holidays` business-day check across both apps honors it.
      kind = 'working'  → force the day WORKING (exceptional Saturday/Sunday, or cancel an
                          auto-holiday). Removed from the holiday set AND reported as a working
                          day by calendar_445.is_working_day / is_forced_working.

    Mutations are Admin-only + second-factor (ADMIN_PASSWORD unlock) and audited in
    SecurityEvent (event_type='calendar_change'); this table also keeps created_by/created_at
    for a quick inline provenance read. Changes take effect on the next data reload/recompute
    (the in-memory calendar + Gantt caches are invalidated when a row changes).
    """
    __tablename__ = "calendar_override"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    cal_date   = Column(String, nullable=False, index=True)   # ISO 'YYYY-MM-DD'
    kind       = Column(String, nullable=False)               # 'holiday' | 'working'
    label      = Column(String, nullable=True)                # e.g. "Feriado da Empresa", "Sábado Extra"
    scope      = Column(String, nullable=False, default="company", server_default="company")
    created_by = Column(String, nullable=True)                # admin username (e-mail local-part)
    created_at = Column(DateTime, nullable=True, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("cal_date", name="uq_calendar_override_date"),
    )

    def to_dict(self) -> dict:
        return {
            "date":       self.cal_date,
            "kind":       self.kind,
            "label":      self.label or "",
            "scope":      self.scope or "company",
            "created_by": self.created_by or "",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Workstation(Base):
    """
    Admin-editable master row per workstation (WSN): area, name, and capacity limits
    (hour limit / people limit / headcount qtde / shift count). Centralizes data that used
    to live duplicated inline on every Item Rout operation row — this table + Person +
    WorkstationPerson + PersonLeave are the new single source of truth (Step 1: tab + import
    + persistence only; wiring this in as the actual capacity-calc source, and stripping the
    old inline columns from Item Rout, is a later step).

    Populated by manual CRUD or by importing the 'HeadCount' spreadsheet (WSN/AREA/DESC/
    LH/LM/QTDE/TURNOS/HEADCOUNT columns — see import_excel_to_db.import_headcount_to_db).
    """
    __tablename__ = "workstation"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    wsn          = Column(String, nullable=False, index=True)   # WSN
    area         = Column(String, nullable=True)                # AREA
    desc         = Column(String, nullable=True)                # DESC (workstation name)
    hour_limit   = Column(Float,  nullable=True)                # LH
    people_limit = Column(Integer, nullable=True)                # LM
    qtde         = Column(Integer, nullable=True)                # QTDE
    turnos       = Column(Integer, nullable=True)                # TURNOS
    # Expertise level this workstation REQUIRES of anyone allocated to it (`r[w]`, 0–3;
    # 0/NULL = no bar). Editable in the Headcount tab and PERSISTED, never derived at run
    # time — there is no minimum-crew field in this schema to derive it from (`people_limit`
    # is the LM column, a MAXIMUM per shift), and a derived value would also silently
    # overwrite PCP's judgement whenever the crew size changed.
    #
    # Deliberately NOT called `nivel`: that word is already taken in this domain by the
    # item's NIVEL field, which weights coverage priority in the solver's Phase 2
    # (nivel_weighted_demand_by_wsn). Two unrelated "níveis" in one model would be a trap.
    required_level = Column(Integer, nullable=True)
    # Provenance of that target, mirroring WorkstationPerson's for the person side — same
    # reasoning: a level nobody can trace back to who set it, when, and on what basis is an
    # anonymous number nobody can review.
    #   required_source   'manual' | 'quiz@N' (N = question-set version; bare 'quiz' is v1)
    #   required_answers  JSON list of the 3 answers, so the questionnaire REOPENS as it was
    #                     left instead of being redone from memory. NULL when source=manual.
    required_source     = Column(String, nullable=True)
    required_answers    = Column(String, nullable=True)
    required_updated_at = Column(DateTime, nullable=True)
    required_updated_by = Column(String, nullable=True)

    def required_meta(self) -> dict:
        return {
            "source": self.required_source or "",
            "answers": self.required_answers or "",
            "updated_at": self.required_updated_at.isoformat() if self.required_updated_at else None,
            "updated_by": self.required_updated_by or "",
        }

    updated_at   = Column(DateTime, nullable=False,
                          default=lambda: datetime.now(timezone.utc),
                          onupdate=lambda: datetime.now(timezone.utc))
    updated_by   = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("wsn", name="uq_workstation_wsn"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id, "wsn": self.wsn, "area": self.area or "", "desc": self.desc or "",
            "hour_limit": self.hour_limit, "people_limit": self.people_limit,
            "qtde": self.qtde, "turnos": self.turnos,
            "required_level": self.required_level,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "updated_by": self.updated_by or "",
        }


class Person(Base):
    """
    Admin-editable roster of people who can be allocated to workstations. `active=False`
    is NOT used for vacations (those are dated ranges in PersonLeave) — it's a soft-remove
    flag reserved for future use; Step 1's "remove person" CRUD hard-deletes instead
    (cascades WorkstationPerson links + PersonLeave rows).

    `area` mirrors Workstation.area (B1/B2/B3/WGS): the person's home area, editable in the
    Headcount tab. Informational — allocation is still the explicit WorkstationPerson link,
    never inferred from a matching area.
    """
    __tablename__ = "person"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String, nullable=False, index=True)
    area       = Column(String, nullable=True)
    active     = Column(Boolean, nullable=False, default=True, server_default="true")
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
    updated_by = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("name", name="uq_person_name"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "area": self.area or "",
            "active": bool(self.active),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class WorkstationPerson(Base):
    """Many-to-many link: which people are currently assigned to which workstation.

    The link also CARRIES the pair's expertise level (`e[p,w]`) — the level is a property of
    the relationship, not of the person and not of the station: the same operator can be
    proficient on one WSN and a novice on the next. Storing it on the link is also what makes
    unlinking drop the assessment with it, instead of leaving a stale level to resurface if
    the person is ever re-allocated there.
    """
    __tablename__ = "workstation_person"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    workstation_id  = Column(Integer, ForeignKey("workstation.id", ondelete="CASCADE"), nullable=False, index=True)
    person_id       = Column(Integer, ForeignKey("person.id", ondelete="CASCADE"), nullable=False, index=True)
    # 0–3, NULL = never assessed (read as 0). See Workstation.required_level for the naming.
    expertise_level = Column(Integer, nullable=True)
    # Provenance of that level. The spec lists supervisor SUBJECTIVITY as a risk with no code
    # mitigation, and it is right that the judgement itself is out of scope — but "who said
    # this, when, and on what basis" is not, and without it a level is an anonymous number that
    # nobody can review or challenge.
    #   expertise_source   'manual' (picked directly) | 'quiz' (derived from the questionnaire)
    #   expertise_answers  JSON list of the 3 quiz answers, so an assessment can be REOPENED
    #                      and revised rather than redone from memory. NULL when source=manual.
    expertise_source     = Column(String, nullable=True)
    expertise_answers    = Column(String, nullable=True)
    expertise_updated_at = Column(DateTime, nullable=True)
    expertise_updated_by = Column(String, nullable=True)

    def expertise_meta(self) -> dict:
        return {
            "source": self.expertise_source or "",
            "answers": self.expertise_answers or "",
            "updated_at": self.expertise_updated_at.isoformat() if self.expertise_updated_at else None,
            "updated_by": self.expertise_updated_by or "",
        }

    __table_args__ = (
        UniqueConstraint("workstation_id", "person_id", name="uq_ws_person"),
    )


class PersonLeave(Base):
    """A dated vacation/leave period during which a person is inactive (excluded from
    capacity). Multiple non-overlapping ranges per person are allowed; overlap is not
    enforced server-side (Step 1 scope is storage only, no capacity-calc consumption yet)."""
    __tablename__ = "person_leave"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    person_id  = Column(Integer, ForeignKey("person.id", ondelete="CASCADE"), nullable=False, index=True)
    start_date = Column(String, nullable=False)   # ISO 'YYYY-MM-DD'
    end_date   = Column(String, nullable=False)   # ISO 'YYYY-MM-DD'
    note       = Column(String, nullable=True)
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
    updated_by = Column(String, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "person_id": self.person_id,
            "start_date": self.start_date, "end_date": self.end_date,
            "note": self.note or "",
        }


class FiscalWeekOverride(Base):
    """
    Admin-editable FISCAL-WEEK LABEL offset, one sparse row per calendar year.

    The base engine (services/calendar_445.py) labels the first week of every year FW01
    and numbers forward (Jan-1, 7-day buckets). Some fiscal years, however, must start on
    a different fiscal week — e.g. 2027's first week belongs to the PREVIOUS fiscal year as
    FW52 rather than FW01. This table stores ONLY the years that deviate, as a signed integer
    `offset` added to every week's label in that year (0 = default, never stored):

      offset = -1  → FW01 shows as FW52 (previous fiscal year), FW02 → FW01, FW03 → FW02, …
      offset = +1  → FW01 shows as FW02, and so on.

    A uniform per-year offset is the ONLY fiscal-week adjustment that preserves week-sequence
    consistency (a mid-year ±1 would duplicate a week number); it is exactly a "shift the first
    week ±1 and cascade to every subsequent week in the year" edit. It affects the LABEL layer
    only (calendar grid + Gantt fiscal-week captions) — the raw week bucketing that drives
    working-day counts and the 4-4-5 grouping is unchanged, so Capacity/KPIs are unaffected.

    Mutations are Admin-only + second factor (ADMIN_PASSWORD unlock) and audited in
    SecurityEvent (event_type='calendar_change'). Changes take effect on the next data
    reload/recompute, like the day-level overrides above.
    """
    __tablename__ = "fiscal_week_override"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    year       = Column(Integer, nullable=False, index=True)   # calendar year, e.g. 2027
    offset     = Column(Integer, nullable=False, default=0)    # signed week-label shift
    label      = Column(String, nullable=True)                 # optional admin note
    created_by = Column(String, nullable=True)                 # admin username (e-mail local-part)
    created_at = Column(DateTime, nullable=True, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("year", name="uq_fiscal_week_override_year"),
    )

    def to_dict(self) -> dict:
        return {
            "year":       self.year,
            "offset":     self.offset or 0,
            "label":      self.label or "",
            "created_by": self.created_by or "",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class AppSetting(Base):
    """
    Small key/value store for ADMIN-CONTROLLED, app-wide operational switches.

    Deliberately a generic table rather than a column per feature: these are operator toggles,
    not business data, and each one is a single short string. Everything written here is set by
    an admin through a password-gated endpoint and mirrored into the SecurityEvent trail
    ('server_control'), so the table is a cache of current state, never the audit record.

    Keys in use (see main._server_control_state):
      'server_offline'         '1' | '0'  — deliberate shutdown. While '1', every route behind
                                            require_auth answers 503 + X-Server-Offline for
                                            non-admins (main._enforce_server_offline) and the
                                            client shows the message below instead of the app.
      'server_offline_message' free text  — what users see while 'server_offline' is '1'.
                                            Admin-authored, shown verbatim, length-capped.
      'lockdown_new_users'     '1' | '0'  — deny first-time users instead of auto-registering
                                            them as Reader (see main._touch_user_login).

    A row is only present once the switch has been written at least once; a missing row means the
    default, which is OFF for both flags.
    """
    __tablename__ = "app_setting"

    key        = Column(String, primary_key=True)
    value      = Column(Text,   nullable=True)
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
    updated_by = Column(String, nullable=True)


class AuthThrottle(Base):
    """
    PERSISTED brute-force state (failed-password lockout + per-bucket rate limit).

    Kept in the DB — not just process memory — so the controls survive a restart,
    a redeploy, and (critically) a scale-to-zero cold start. Otherwise the
    5-strikes-in-a-row lockout could be evaded by pacing guesses so the container
    sleeps and resets its in-memory counters between bursts.

    Keyed by (bucket, key):
      bucket : '_lock_' for the shared failed-password lockout, or a rate-limit
               bucket name ('unlock' | 'import').
      key    : the caller's stable identity (username, falling back to email) —
               the same value produced by main._pw_user_key.

    For the '_lock_' bucket:  fail_count (consecutive wrong passwords) + lockout_until
    (epoch seconds; NULL/expired ⇒ not locked). For a rate-limit bucket: hits_json
    (JSON array of epoch-second timestamps within the sliding window).
    """
    __tablename__ = "auth_throttle"

    bucket        = Column(String, nullable=False)
    key           = Column(String, nullable=False)
    fail_count    = Column(Integer, nullable=False, default=0, server_default="0")
    lockout_until = Column(Float,   nullable=True)   # epoch seconds; NULL = not locked
    hits_json     = Column(Text,    nullable=True)   # JSON array of epoch floats (rate limit)
    updated_at    = Column(DateTime, nullable=False,
                           default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        PrimaryKeyConstraint("bucket", "key", name="pk_auth_throttle"),
    )
