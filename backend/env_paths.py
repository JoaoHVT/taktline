"""Single source of truth for WHERE the backend's .env file lives.

SECURITY — why this module exists
---------------------------------
`backend/.env` holds `DATABASE_URL`, `ADMIN_PASSWORD` and `IMPORT_PASSWORD` in plaintext. The
working tree of this repository sits inside a OneDrive-synced folder, so keeping the file next to
the code replicated all three secrets into a consumer cloud account — including its file version
history, which a later edit does not erase. Git was never the exposure path (`.gitignore` has
always blocked `.env`); the sync client was.

The file therefore lives OUTSIDE the synced tree now. The in-tree path is still honoured, LAST,
so an existing checkout or a fresh clone keeps working — but anything found there is a legacy
location and should be moved.

Production is unaffected: Railway injects the variables directly and no .env file exists there,
so every candidate below simply misses and the platform environment stays authoritative.

Resolution order
----------------
1. ``$OPTVISION_ENV_FILE``      — explicit override; wins everywhere (CI, containers, tests)
2. ``~/.optvision/backend.env`` — default off-tree location
3. ``<backend>/.env``           — legacy in-tree file (deprecated, see above)

This module imports nothing but the standard library and reads no environment variable at import
time, so it is safe to import before `load_dotenv()` runs — which matters, because `main.py` must
load the .env before any module that captures configuration at import time (`services.auth`,
`database`).
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent

#: Deprecated in-tree location. Kept as a fallback for existing checkouts only.
LEGACY_ENV_FILE = BACKEND_DIR / ".env"

#: Default location outside any cloud-synced folder.
DEFAULT_ENV_FILE = Path.home() / ".optvision" / "backend.env"


def candidate_env_files() -> list[Path]:
    """Every path that may hold the backend .env, most specific first."""
    out: list[Path] = []

    override = os.getenv("OPTVISION_ENV_FILE", "").strip()
    if override:
        out.append(Path(override).expanduser())

    out.append(DEFAULT_ENV_FILE)
    out.append(LEGACY_ENV_FILE)
    return out


def resolve_env_file() -> Path | None:
    """First candidate that actually exists, or None (platform-injected environment)."""
    for path in candidate_env_files():
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def writable_env_file() -> Path:
    """Where a tool may WRITE local settings (start.py stamps LOCAL_IP / FRONTEND_URL).

    The file already in use if there is one, otherwise the off-tree default — so a machine with
    no .env yet gets one created outside the synced tree rather than inside it.
    """
    return resolve_env_file() or DEFAULT_ENV_FILE
