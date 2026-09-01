"""Run the Taktline demo: the API on loopback, and Next in front of it.

    python run_demo.py            # http://127.0.0.1:3000  — localhost only
    python run_demo.py --host 0.0.0.0   # bind every interface (what the container does)

LOCALHOST BY DEFAULT, and that is the important line here. The default binds 127.0.0.1, so
running this on a laptop does not put the app on whatever network that laptop happens to be
joined to. Exposing it is possible but has to be typed.

The API always binds 127.0.0.1 regardless. The browser never talks to it directly: Next serves
the pages and forwards /api to it, so the app is single-origin — no CORS, and the security
headers Next emits cover every response the browser sees.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


def backend_python() -> str:
    """The venv interpreter when there is one, else whatever is running this."""
    candidate = (BACKEND / "venv" / ("Scripts" if os.name == "nt" else "bin")
                 / ("python.exe" if os.name == "nt" else "python"))
    return str(candidate) if candidate.exists() else sys.executable


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the Taktline demo.")
    ap.add_argument("--host", default="127.0.0.1",
                    help="Interface for the web server. Default 127.0.0.1 (localhost only).")
    ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "3000")))
    ap.add_argument("--api-port", type=int, default=int(os.getenv("API_PORT", "8000")))
    args = ap.parse_args()

    if not (BACKEND / "data" / "demo.sqlite").is_file():
        print("[demo] backend/data/demo.sqlite não existe.")
        print("[demo] Gere-o com:  python tools/make_demo_data.py && python tools/seed_demo_db.py")
        return 1
    if not (FRONTEND / ".next").is_dir():
        print("[demo] frontend/.next não existe — rode `npm ci && npm run build` em frontend/.")
        return 1

    env = dict(os.environ)
    env["BACKEND_ORIGIN"] = f"http://127.0.0.1:{args.api_port}"
    env.setdefault("NEXT_PUBLIC_SAME_ORIGIN", "1")
    env.setdefault("NEXT_TELEMETRY_DISABLED", "1")

    procs: list[subprocess.Popen] = []
    try:
        # uvicorn is invoked through `python -c` rather than `python -m uvicorn`: its click CLI
        # expands any argument containing '*' as a filesystem glob on Windows.
        api = subprocess.Popen(
            [backend_python(), "-c",
             f"import uvicorn; uvicorn.run('main:app', host='127.0.0.1', port={args.api_port})"],
            cwd=str(BACKEND), env=env,
        )
        procs.append(api)
        print(f"[demo] API   http://127.0.0.1:{args.api_port}  (loopback only)")

        # The project's OWN next binary, not `npx next`: npx will reach for the network when it
        # cannot resolve a package locally, and a container that shells out to the registry at
        # start-up is both slower and a dependency nobody asked for.
        local_next = FRONTEND / "node_modules" / ".bin" / ("next.cmd" if os.name == "nt" else "next")
        if not local_next.exists():
            print("[demo] frontend/node_modules não existe — rode `npm ci` em frontend/.")
            return 1
        web = subprocess.Popen(
            [str(local_next), "start", "--hostname", args.host, "--port", str(args.port)],
            cwd=str(FRONTEND), env=env,
        )
        procs.append(web)
        print(f"[demo] Web   http://{args.host}:{args.port}")
        print("[demo] Login: dev / 1234")

        # Exit as soon as EITHER process does: half the app running is worse than none, because
        # the failure shows up as a broken page rather than as a process that stopped.
        while True:
            for p in procs:
                code = p.poll()
                if code is not None:
                    print(f"[demo] processo encerrou (código {code}) — desligando o outro.")
                    return code or 0
            time.sleep(0.4)
    except KeyboardInterrupt:
        print("\n[demo] encerrando…")
        return 0
    finally:
        for p in procs:
            if p.poll() is None:
                try:
                    p.send_signal(signal.SIGTERM if os.name != "nt" else signal.CTRL_BREAK_EVENT)
                except Exception:
                    p.kill()
        for p in procs:
            try:
                p.wait(timeout=8)
            except Exception:
                p.kill()


if __name__ == "__main__":
    raise SystemExit(main())
