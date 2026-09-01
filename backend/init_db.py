"""
init_db.py
----------
Creates every table defined in models.py in the configured database.

    python init_db.py

Safe to run repeatedly — existing tables are left alone. Normally you do not need it: the API
runs the same create_all at startup, and tools/make_demo_data.py builds the seed from scratch.
"""

from database import engine
from models import Base

if engine is None:
    print("[init_db] Banco de dados indisponível.")
else:
    Base.metadata.create_all(bind=engine)
    print("[init_db] Tabelas criadas (ou já existentes) com sucesso.")
