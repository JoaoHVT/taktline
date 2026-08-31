"""
init_db.py
----------
Creates all database tables defined in models.py.

Run once (locally or on the server) to initialise the schema:
    python init_db.py

Safe to run multiple times — existing tables are not dropped or modified.
"""

from database import engine
from models import Base

if engine is None:
    print("[init_db] DATABASE_URL não configurada. Configure a variável de ambiente e tente novamente.")
else:
    Base.metadata.create_all(bind=engine)
    print("[init_db] Tabelas criadas (ou já existentes) com sucesso.")
