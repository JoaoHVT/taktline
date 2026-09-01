"""
start.py
--------
Local launcher: starts the API on 127.0.0.1 and nothing else.

LOOPBACK ONLY, deliberately. This is a demo running someone else's sample data on someone's own
machine; binding 0.0.0.0 would put it on whatever network that machine happens to be on. `--host`
is therefore not a flag: to expose it, put a reverse proxy in front and point it at 127.0.0.1.

The frontend is a static export served by the API itself (see the Dockerfile), so there is no
second process to supervise here.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent

HOST = "127.0.0.1"
PORT = int(os.getenv("PORT", "8000"))


def backend_python() -> str:
    """The venv interpreter when there is one, else whatever is running this."""
    candidate = (BACKEND / "venv" / ("Scripts" if os.name == "nt" else "bin")
                 / ("python.exe" if os.name == "nt" else "python"))
    return str(candidate) if candidate.exists() else sys.executable


def main() -> None:
    py = backend_python()
    print(f"[START] API:    http://{HOST}:{PORT}")
    print(f"[START] Python: {py}")
    print()
    # Invoked through `python -c` rather than `python -m uvicorn`: uvicorn's click CLI expands
    # any argument containing '*' as a filesystem glob on Windows.
    subprocess.run(
        [py, "-c", f"import uvicorn; uvicorn.run('main:app', host='{HOST}', port={PORT})"],
        cwd=str(BACKEND),
    )


if __name__ == "__main__":
    main()
