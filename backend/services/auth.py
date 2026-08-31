"""
services/auth.py — autenticação PRÓPRIA (usuário + senha) para o FastAPI.

Substitui o Azure AD / Microsoft Entra ID, que deixou de funcionar. O que mudou:

  ANTES  o navegador falava com a Entra ID (MSAL), recebia um ID token RS256 e o backend
         só VALIDAVA aquele token contra o JWKS público da Microsoft. A identidade e a
         senha eram problema do provedor; aqui só existia verificação.

  AGORA  a identidade mora no PRÓPRIO banco (user_permissions.password_hash) e este módulo
         é o EMISSOR do token além de ser o validador. O fluxo é:

           1. POST /api/auth/login  (main.py) confere usuário + senha com verify_password().
           2. issue_session_token() assina um JWT HS256 com o segredo do servidor.
           3. O cliente manda  Authorization: Bearer <token>  em toda requisição.
           4. validate_bearer_token() decodifica e confere assinatura, expiração e tipo,
              devolvendo o MESMO formato de dict que a versão Entra devolvia — por isso
              nenhuma rota de main.py precisou mudar de assinatura.

O que este módulo deliberadamente NÃO faz:
  • não guarda senha em texto puro em lugar nenhum (só o hash PBKDF2 derivado);
  • não decide papel/permissão — isso continua sendo `user_permissions.role`, resolvido em
    main._current_role a cada requisição, para que uma promoção/demissão valha na hora e
    não fique congelada dentro de um token de 12 h;
  • não verifica e-mail (o envio de confirmação é um passo FUTURO, ainda não implementado);
    o domínio corporativo é a única triagem automática que existe no cadastro.
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
ALLOWED_DOMAIN = os.getenv("ALLOWED_DOMAIN", "wabtec.com").strip().lower()

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

#: Validade da sessão. 12 h cobre um turno inteiro sem re-login no meio do trabalho, e o
#: cliente renova em /api/auth/refresh enquanto a aba fica aberta.
SESSION_TTL_S = int(os.getenv("AUTH_SESSION_TTL_SECONDS", str(12 * 60 * 60)))

_ISSUER = "optvision"
_ALGO = "HS256"

# Fôlego de relógio na expiração — mesma razão da versão anterior: navegador e servidor
# podem divergir alguns segundos e um token válido não pode ser lido como expirado.
_EXP_LEEWAY_SECONDS = 60

_bearer = HTTPBearer(auto_error=False)


def _derive_fallback_secret() -> str:
    """Segredo determinístico para quando AUTH_SECRET não está configurado.

    Precisa ser ESTÁVEL entre reinícios (senão todo deploy derruba todas as sessões) e não
    pode ser adivinhável, então é derivado dos segredos que o servidor já tem. É um
    paliativo: em produção sem AUTH_SECRET o boot registra um erro, porque quem conhecer
    ADMIN_PASSWORD/IMPORT_PASSWORD passaria a poder FORJAR sessões, o que é bem mais grave
    do que conhecer as senhas em si.
    """
    material = "|".join([
        os.getenv("ADMIN_PASSWORD", ""),
        os.getenv("IMPORT_PASSWORD", ""),
        os.getenv("DATABASE_URL", ""),
        "optvision-local-auth-v1",
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


_AUTH_SECRET = os.getenv("AUTH_SECRET", "").strip() or _derive_fallback_secret()

if not os.getenv("AUTH_SECRET", "").strip():
    if ENVIRONMENT == "production":
        logger.error(
            "[auth] AUTH_SECRET não configurado — usando segredo derivado. Defina AUTH_SECRET "
            "(valor aleatório de 32+ bytes) no ambiente: sem ele, quem conhecer ADMIN_PASSWORD "
            "consegue assinar sessões válidas."
        )
    else:
        logger.warning("[auth] AUTH_SECRET não configurado — usando segredo derivado (dev).")


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


#: Alfabeto sem caracteres ambíguos (0/O, 1/l/I). A senha gerada vai ser LIDA e DIGITADA
#: por uma pessoa a partir de uma lista que o admin distribui, então "não dá para saber se
#: é o L ou o um" é um modo de falha real, não preciosismo.
_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"


def generate_password(length: int = 12) -> str:
    """Senha aleatória para migração de conta existente / redefinição pelo admin."""
    return "".join(secrets.choice(_PW_ALPHABET) for _ in range(max(8, length)))


# ── Política mínima de senha ─────────────────────────────────────────────────
PASSWORD_MIN_LEN = 8


def validate_password_strength(password: str) -> None:
    """Levanta 400 se a senha escolhida pelo usuário for fraca demais.

    Regra curta de propósito: comprimento mínimo e não ser só um caractere repetido.
    Regras de composição (maiúscula + dígito + símbolo) empurram para senhas do tipo
    'Senha@123', que passam na regra e caem em qualquer dicionário; o comprimento é o
    fator que realmente importa.
    """
    pw = password or ""
    if len(pw) < PASSWORD_MIN_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"A senha deve ter pelo menos {PASSWORD_MIN_LEN} caracteres.",
        )
    if len(set(pw)) < 4:
        raise HTTPException(status_code=400, detail="Senha fraca demais. Use uma combinação menos repetitiva.")


# ── Identidade ───────────────────────────────────────────────────────────────


def username_of(email_or_name: str) -> str:
    """Nome de login: a parte antes do '@', minúscula e sem espaços."""
    s = str(email_or_name or "").strip().lower()
    return s.split("@", 1)[0] if "@" in s else s


def normalize_email(raw: str) -> str:
    return str(raw or "").strip().lower()


def is_domain_allowed(email: str) -> bool:
    """True se o e-mail satisfaz ALLOWED_DOMAIN (vazio ⇒ qualquer domínio serve)."""
    e = normalize_email(email)
    if "@" not in e:
        return False
    if not ALLOWED_DOMAIN:
        return True
    return e.split("@", 1)[1] == ALLOWED_DOMAIN


def display_name_of(username: str) -> str:
    """'joao.voss' → 'Joao Voss'. Só para exibição; nada depende disso."""
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

    O dict devolvido mantém as chaves da versão Entra ID (email/name/oid/...) porque
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
