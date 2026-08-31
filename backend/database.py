"""
database.py
-----------
SQLAlchemy connection setup for the PostgreSQL / Supabase database.

DATABASE_URL is injected via the environment (Railway variable or .env).

Supabase note: The direct connection (db.*.supabase.co:5432) requires IPv6.
Railway runs on IPv4 only. Use the Supabase Session Pooler URL instead:
  Dashboard -> Settings -> Database -> Connection Pooling -> Session mode
  Format: postgresql://postgres.[ref]:[pwd]@aws-0-[region].pooler.supabase.com:5432/postgres
Set this as DATABASE_URL in Railway (replacing the db.* direct URL).
"""

from __future__ import annotations

import os
import ssl
import time as _time
import logging
from pathlib import Path

# main.py already loads the .env (with override) BEFORE importing this module.
# This fallback only matters when database.py is imported directly by a script
# (import_excel_to_db, migrations): resolve the path through env_paths rather
# than the cwd, and do NOT override — whatever main.py / the platform already
# put in the environment stays authoritative. env_paths keeps the file out of
# the OneDrive-synced tree; see the SECURITY note there.
try:
    from dotenv import load_dotenv
    from env_paths import resolve_env_file

    _env_file = resolve_env_file()
    if _env_file is not None:
        load_dotenv(dotenv_path=_env_file)
except ImportError:
    pass

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import sessionmaker, Session
from contextlib import contextmanager

logger = logging.getLogger(__name__)

DATABASE_URL: str | None = os.getenv("DATABASE_URL")

engine = None
SessionLocal = None
_active_url: str | None = None

# ── Lazy-reconnect state ───────────────────────────────────────────────────
# If the initial connection fails (e.g. Supabase unreachable at startup),
# the engine stays None but we retry at most once per minute so the DB can
# recover without restarting the backend.
_last_engine_attempt: float = 0.0
_ENGINE_RETRY_S: float = 60.0  # seconds between reconnect attempts

# ── Liveness observed from REAL traffic ────────────────────────────────────
# Every successful session proves the DB is reachable, so check_connection()
# can answer from that instead of opening yet another connection. This matters
# because NullPool gives each probe a full TLS handshake to the Supabase pooler
# (~seconds): the status probe was timing out and reporting OFFLINE while real
# queries — on longer timeouts — kept working. Kept short so a DB that dies is
# still noticed within seconds.
_last_success_at: float = 0.0
_FRESH_OK_S: float = 15.0


def _note_success() -> None:
    global _last_success_at
    _last_success_at = _time.monotonic()


def _recently_succeeded() -> bool:
    return _last_success_at > 0.0 and (_time.monotonic() - _last_success_at) < _FRESH_OK_S


def _pg8000_url(url: str) -> str:
    if "pg8000" in url:
        return url
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+pg8000://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+pg8000://", 1)
    return url


def _make_ssl_ctx() -> ssl.SSLContext:
    """TLS context for the Postgres/Supabase connection.

    SECURITY: the connection is always encrypted, but by default the server
    certificate is NOT verified (CERT_NONE) — this preserves the behavior needed
    to reach the Supabase pooler without shipping its CA, at the cost of being
    vulnerable to an active man-in-the-middle.

    Set  DB_SSL_VERIFY=1  to enforce full verification (recommended in prod).
    If the pooler cert isn't chained to a public root, point
    DB_SSL_ROOT_CERT at a CA bundle (e.g. Supabase's prod CA .crt).
    """
    verify = os.getenv("DB_SSL_VERIFY", "").strip().lower() in ("1", "true", "yes", "on")
    if not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    ca_file = os.getenv("DB_SSL_ROOT_CERT", "").strip() or None
    ctx = ssl.create_default_context(cafile=ca_file)
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    logger.info("[DB] TLS certificate verification ENABLED (DB_SSL_VERIFY=1).")
    return ctx


def _try_create_engine(url: str):
    # NullPool: open a connection per use and CLOSE it on release, so an idle
    # backend holds ZERO open DB connections. A lingering connection pool counts
    # as OUTBOUND traffic on Railway and prevents App Sleeping (which needs ~10
    # min with no outbound), keeping the service — and its memory bill — alive
    # 24/7. Trade-off: each request pays a fresh Supabase connection setup, which
    # is fine for this low-traffic app and is the price of sleeping to ~$0 idle.
    eng = create_engine(
        _pg8000_url(url),
        poolclass=NullPool,
        connect_args={"ssl_context": _make_ssl_ctx()},
    )
    with eng.connect() as conn:
        conn.execute(text("SELECT 1"))
    _note_success()
    return eng


if DATABASE_URL:
    try:
        engine = _try_create_engine(DATABASE_URL)
        SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        _active_url = DATABASE_URL
        _last_engine_attempt = _time.monotonic()  # mark attempt time
        logger.info("[DB] Conectado -> %s", DATABASE_URL.split("@")[-1])
    except Exception as exc:
        logger.warning("[DB] DATABASE_URL falhou na inicialização: %s", exc)
        engine = None
        SessionLocal = None
        # Record attempt so we don't hammer the DB immediately on every request
        _last_engine_attempt = _time.monotonic()
else:
    logger.warning("[DB] DATABASE_URL nao configurada.")


def _ensure_engine() -> bool:
    """Attempt (re-)connection if the engine is None and the retry interval has elapsed.
    Returns True when a working engine is available, False otherwise.
    """
    global engine, SessionLocal, _active_url, _last_engine_attempt
    if engine is not None:
        return True
    url = os.getenv("DATABASE_URL")
    if not url:
        return False
    now = _time.monotonic()
    if now - _last_engine_attempt < _ENGINE_RETRY_S:
        return False  # Too soon to retry
    _last_engine_attempt = now
    try:
        eng = _try_create_engine(url)
        engine = eng
        SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        _active_url = url
        logger.info("[DB] Reconectado com sucesso -> %s", url.split("@")[-1])
        return True
    except Exception as exc:
        logger.warning("[DB] Tentativa de reconexão falhou: %s", exc)
        return False


def is_available() -> bool:
    _ensure_engine()
    if engine is None:
        return False
    if _recently_succeeded():
        return True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        _note_success()
        return True
    except Exception:
        return False


def check_connection() -> tuple[bool, str]:
    _ensure_engine()
    if engine is None:
        if not os.getenv("DATABASE_URL"):
            return False, "DATABASE_URL nao configurada."
        return (
            False,
            "Engine nao criado. Se o erro for 'port 5432 timeout', o Railway usa IPv4 mas "
            "db.*.supabase.co:5432 requer IPv6. Troque DATABASE_URL pelo Session Pooler: "
            "Supabase Dashboard -> Settings -> Database -> Connection Pooling -> Session mode.",
        )
    host = (_active_url or "").split("@")[-1] if _active_url else "?"
    # A real query succeeded moments ago — that IS the answer. Skip the probe
    # connection (see _last_success_at): under NullPool it costs a fresh TLS
    # handshake and was the source of false OFFLINE readings.
    if _recently_succeeded():
        return True, f"OK (via {host})"
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        _note_success()
        return True, f"OK (via {host})"
    except Exception as exc:
        return False, str(exc)


@contextmanager
def get_db() -> Session:  # type: ignore[return]
    _ensure_engine()
    if SessionLocal is None:
        raise RuntimeError("Banco de dados nao configurado.")
    db: Session = SessionLocal()
    try:
        yield db
        db.commit()
        _note_success()   # real traffic proves liveness — see check_connection()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
