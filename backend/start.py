"""
start.py
--------
Local launcher: starts the API on 127.0.0.1 and nothing else.

LOOPBACK ONLY, deliberately. `--host` is not a flag here: to expose the app, run ../run_demo.py,
which starts Next in front of this and takes --host explicitly.

This is the BACKEND ALONE — useful when working on it, or alongside `npm run dev` in the other
window. To run the whole demo, use ../run_demo.py.
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
