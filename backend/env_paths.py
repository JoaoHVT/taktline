"""Where the backend's optional .env file lives.

The demo needs no secrets to run: every value has a working default and the session secret is
generated per boot. A .env is therefore optional, and exists only so someone running locally can
pin a port or a database path without editing code.

Resolution order:

1. ``$TAKTLINE_ENV_FILE`` — explicit override (containers, CI)
2. ``<backend>/.env``

Imports nothing but the standard library and reads no environment variable at import time, so it
is safe to import before ``load_dotenv()`` runs — which matters, because ``main.py`` must load the
.env before any module that captures configuration at import time (``database``, ``services.auth``).
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent

DEFAULT_ENV_FILE = BACKEND_DIR / ".env"


def candidate_env_files() -> list[Path]:
    """Every path that may hold the backend .env, most specific first."""
    out: list[Path] = []
    override = os.getenv("TAKTLINE_ENV_FILE", "").strip()
    if override:
        out.append(Path(override).expanduser())
    out.append(DEFAULT_ENV_FILE)
    return out


def resolve_env_file() -> Path | None:
    """First candidate that actually exists, or None (environment-only configuration)."""
    for path in candidate_env_files():
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def writable_env_file() -> Path:
    """Where a tool may WRITE local settings — the file already in use, else the default."""
    return resolve_env_file() or DEFAULT_ENV_FILE
