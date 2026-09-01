"""Build backend/data/demo.sqlite from the generated workbook.

The seed file is what ships with the code. At boot database.py copies it to a throwaway working
file, so anything a visitor does — a solver run, an override, an audit row — lives only until
the process restarts, and the file in the repository is never written to at runtime.

    python tools/make_demo_data.py && python tools/seed_demo_db.py

Re-running rebuilds the database from scratch; the old file is deleted first so a rename in the
generator cannot leave orphaned rows behind.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
SEED_DB = BACKEND / "data" / "demo.sqlite"
SOURCE_XLSX = BACKEND / "data" / "demo_source.xlsx"

# The only account the demo has. Fixed and published on the login screen: there is no user
# system behind it — no registration, no roster, no second factor — just the one identity every
# visitor signs in as. Editor, because running the solver and moving a box on the Schedule are
# the two things there is to try; nothing an Editor can reach writes to anything but the
# throwaway copy of this file.
DEMO_USER = "dev"
DEMO_PASSWORD = "1234"
DEMO_ROLE = "editor"


def main() -> int:
    if not SOURCE_XLSX.is_file():
        print(f"[seed] {SOURCE_XLSX.name} não existe — rode tools/make_demo_data.py primeiro.")
        return 1

    SEED_DB.parent.mkdir(parents=True, exist_ok=True)
    for leftover in (SEED_DB, Path(str(SEED_DB) + "-wal"), Path(str(SEED_DB) + "-shm")):
        leftover.unlink(missing_ok=True)

    # Point the engine straight at the seed file: DATABASE_URL wins over the copy-on-boot path,
    # so this writes the shipped database instead of a working copy of it.
    os.environ["DATABASE_URL"] = f"sqlite:///{SEED_DB.as_posix()}"
    sys.path.insert(0, str(BACKEND))

    from database import engine, get_db          # noqa: E402
    from models import Base, UserPermission      # noqa: E402
    from services.auth import hash_password      # noqa: E402
    import import_excel_to_db as imp             # noqa: E402

    Base.metadata.create_all(bind=engine)

    steps = [
        ("Discretizado",  imp.import_excel_to_db),
        ("Item Rout",     imp.import_itens_rout_to_db),
        ("Plano Prod",    imp.import_plano_prod_to_db),
        ("Schedule - MS", imp.import_schedule_to_db),
        ("Locos - Rout",  imp.import_locos_rout_to_db),
        ("HeadCount",     imp.import_headcount_to_db),
    ]
    failed = False
    for label, fn in steps:
        with get_db() as db:
            res = fn(SOURCE_XLSX, db)
        status = res.get("status")
        print(f"  {label:<14} {status:<6} {res.get('rows', '')} {res.get('message', '')}")
        failed = failed or status != "ok"
    if failed:
        print("[seed] importação incompleta — banco não confiável.")
        return 1

    with get_db() as db:
        row = db.query(UserPermission).filter(UserPermission.username == DEMO_USER).first()
        if row is None:
            row = UserPermission(username=DEMO_USER)
            db.add(row)
        row.role = DEMO_ROLE
        row.email = f"{DEMO_USER}@example.com"
        row.password_hash = hash_password(DEMO_PASSWORD)
        row.must_change_password = False
        row.is_blocked = False
        db.commit()
    print(f"  {'usuário':<14} ok     {DEMO_USER} / {DEMO_PASSWORD} ({DEMO_ROLE})")

    engine.dispose()
    print(f"[seed] {SEED_DB} ({SEED_DB.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
