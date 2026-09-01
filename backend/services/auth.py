"""
services/auth.py — autenticação (usuário + senha) para o FastAPI.

A identidade mora no próprio banco (user_permissions.password_hash) e este módulo é o
EMISSOR do token além de ser o validador:

  1. POST /api/auth/login  (main.py) confere usuário + senha com verify_password().
  2. issue_session_token() assina um JWT HS256 com o segredo do servidor.
  3. O cliente manda  Authorization: Bearer <token>  em toda requisição.
  4. validate_bearer_token() decodifica e confere assinatura, expiração e tipo.

ESTA DEMONSTRAÇÃO TEM UMA CONTA SÓ (ver tools/seed_demo_db.py). Não há cadastro, redefinição
nem administração de usuários — o que sobra aqui é o mecanismo de sessão, que é real e é o
que a tela de login demonstra. O papel continua saindo de `user_permissions.role`, resolvido
a cada requisição em main._current_role e nunca congelado dentro do token.

O que este módulo deliberadamente NÃO faz: guardar senha em texto puro em lugar nenhum —
só o hash PBKDF2 derivado.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
from datetime import datetime, timezone

import jwt                         # PyJWT (já em requirements.txt)
from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

logger = logging.getLogger(__name__)

# ── Configuração ─────────────────────────────────────────────────────────────

#: Domínio corporativo exigido no CADASTRO. Vazio ⇒ qualquer domínio é aceito.
#: Não é mais checado a cada requisição: depois que a conta existe no banco, ela é a
#: identidade — reconferir o domínio em toda chamada só recriaria a dependência que
#: acabou de sair, e um admin que aprovou a conta já decidiu por ela.
ALLOWED_DOMAIN = os.getenv("ALLOWED_DOMAIN", "example.com").strip().lower()

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

#: Validade da sessão. 12 h cobre um turno inteiro sem re-login no meio do trabalho, e o
#: cliente renova em /api/auth/refresh enquanto a aba fica aberta.
SESSION_TTL_S = int(os.getenv("AUTH_SESSION_TTL_SECONDS", str(12 * 60 * 60)))

_ISSUER = "taktline"
_ALGO = "HS256"

# Fôlego de relógio na expiração — mesma razão da versão anterior: navegador e servidor
# podem divergir alguns segundos e um token válido não pode ser lido como expirado.
_EXP_LEEWAY_SECONDS = 60

_bearer = HTTPBearer(auto_error=False)


# Sem AUTH_SECRET no ambiente, o segredo é SORTEADO a cada boot. Um segredo derivado de
# outras variáveis seria estável entre reinícios, mas também adivinhável por quem conhecesse
# essas variáveis — e num processo descartável a estabilidade não vale nada: a única coisa
# que ela preservaria são sessões de um banco que o próximo boot recria de qualquer forma.
# O efeito visível é que reiniciar o servidor pede um login novo, que é o correto aqui.
_AUTH_SECRET = os.getenv("AUTH_SECRET", "").strip() or secrets.token_hex(32)

if not os.getenv("AUTH_SECRET", "").strip():
    logger.info("[auth] AUTH_SECRET ausente — segredo aleatório por boot; sessões não sobrevivem a um reinício.")


def _secret() -> bytes:
    return _AUTH_SECRET.encode("utf-8")


# ── Hash de senha (PBKDF2-HMAC-SHA256) ───────────────────────────────────────
# PBKDF2 e não bcrypt/argon2 de propósito: `hashlib` é biblioteca padrão e este é um
# reparo emergencial — acrescentar dependência nativa nova ao requirements num deploy
# de urgência é exatamente o tipo de risco que não cabe aqui. O custo (600k iterações,
# o piso recomendado pelo OWASP para PBKDF2-SHA256) fica em torno de 0,2 s por
# verificação, que é caro para quem tenta força bruta e imperceptível num login.

_PBKDF2_ITERATIONS = 600_000
_SALT_BYTES = 16
_HASH_PREFIX = "pbkdf2_sha256"


def hash_password(password: str) -> str:
    """Deriva o hash armazenável de uma senha. Formato: pbkdf2_sha256$iter$salt$hash."""
    pw = (password or "").encode("utf-8")
    salt = secrets.token_bytes(_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", pw, salt, _PBKDF2_ITERATIONS)
    return "$".join([
        _HASH_PREFIX,
        str(_PBKDF2_ITERATIONS),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    ])


def verify_password(password: str, stored: str | None) -> bool:
    """Confere a senha contra o hash armazenado. Comparação em tempo constante.

    Retorna False para hash ausente/ilegível em vez de levantar: uma conta sem senha
    definida (ex.: linha antiga que o bootstrap ainda não tocou) não pode entrar, mas
    também não pode derrubar o endpoint de login com um 500.
    """
    if not stored:
        return False
    try:
        prefix, iters, salt_b64, hash_b64 = stored.split("$", 3)
        if prefix != _HASH_PREFIX:
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256",
            (password or "").encode("utf-8"),
            base64.b64decode(salt_b64),
            int(iters),
        )
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False










# ── Identidade ───────────────────────────────────────────────────────────────


def username_of(email_or_name: str) -> str:
    """Nome de login: a parte antes do '@', minúscula e sem espaços."""
    s = str(email_or_name or "").strip().lower()
    return s.split("@", 1)[0] if "@" in s else s


def normalize_email(raw: str) -> str:
    return str(raw or "").strip().lower()




def display_name_of(username: str) -> str:
    """'ana.silva' → 'Ana Silva'. Só para exibição; nada depende disso."""
    return (username or "").replace(".", " ").replace("_", " ").title() or username


# ── Emissão / validação de sessão ────────────────────────────────────────────


def issue_session_token(username: str, email: str, ttl_s: int | None = None) -> tuple[str, int]:
    """Assina um token de sessão. Devolve (token, segundos_de_validade)."""
    ttl = int(ttl_s or SESSION_TTL_S)
    now = int(datetime.now(timezone.utc).timestamp())
    payload = {
        "iss": _ISSUER,
        "typ": "access",
        "sub": username,
        "email": email,
        "name": display_name_of(username),
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, _secret(), algorithm=_ALGO), ttl


def validate_bearer_token(token: str) -> dict:
    """Valida um token cru (sem o prefixo 'Bearer ') e devolve os dados do usuário.

    FONTE ÚNICA da validação — usada pela dependência HTTP (require_auth) E pelos pontos
    de entrada não-HTTP, como a autenticação por query-param do WebSocket. Levanta
    HTTPException 401 em qualquer falha (ausente, malformado, assinatura inválida,
    expirado, tipo errado).

    O dict devolvido mantém as chaves que o resto do main.py já lê (email/name/oid/...) porque
    main.py inteiro lê `user["email"]` e `user["oid"]`; `oid` passa a ser o próprio
    username, que é a chave estável desta implementação.
    """
    raw = (token or "").strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Não autenticado. Faça login novamente.")

    try:
        payload = jwt.decode(
            raw,
            _secret(),
            algorithms=[_ALGO],
            issuer=_ISSUER,
            leeway=_EXP_LEEWAY_SECONDS,
            options={"verify_exp": True, "verify_iss": True, "require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Sessão expirada. Faça login novamente.") from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Sessão inválida. Faça login novamente.") from exc

    if payload.get("typ") != "access":
        raise HTTPException(status_code=401, detail="Sessão inválida. Faça login novamente.")

    uname = username_of(str(payload.get("sub") or ""))
    if not uname:
        raise HTTPException(status_code=401, detail="Sessão inválida. Faça login novamente.")

    email = normalize_email(str(payload.get("email") or ""))
    return {
        "email":              email or uname,
        "name":               payload.get("name") or display_name_of(uname),
        "given_name":         "",
        "family_name":        "",
        "preferred_username": uname,
        "oid":                uname,
        "tid":                "",
    }


# ── Dependência FastAPI ──────────────────────────────────────────────────────


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer),
) -> dict:
    """Dependência que valida o Bearer token e devolve os dados do usuário.

    auto_error=False no HTTPBearer: um header ausente/malformado NÃO pode virar o 403
    padrão do FastAPI. Todo fracasso de autenticação — ausente, inválido ou expirado —
    sai como 401, porque é só no 401 que a recuperação do cliente (renovar + repetir +
    re-login) engata.
    """
    token = credentials.credentials if credentials else ""
    return validate_bearer_token(token)
