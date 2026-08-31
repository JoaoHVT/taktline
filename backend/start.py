import ipaddress
import os
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
BACKEND = Path(__file__).resolve().parent

from env_paths import writable_env_file

FRONTEND_ENV = ROOT / "frontend" / ".env.local"

# NOT `BACKEND / ".env"`: the backend .env holds DATABASE_URL and both shared passwords, so it
# lives outside the OneDrive-synced tree (see env_paths). Stamp LOCAL_IP / FRONTEND_URL into
# whichever file is actually in use.
BACKEND_ENV = writable_env_file()


def get_backend_python() -> str:
    """
    Usa SOMENTE o python da venv do backend.
    Se não existir, cai no python atual.
    """

    if os.name == "nt":
        py_exec = BACKEND / "venv" / "Scripts" / "python.exe"
    else:
        py_exec = BACKEND / "venv" / "bin" / "python"

    if py_exec.exists():
        return str(py_exec)

    return sys.executable


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1)

        s.connect(("8.8.8.8", 80))

        ip = s.getsockname()[0]

        s.close()

        return ip

    except Exception:
        return "127.0.0.1"


def update_env_file(path: Path, updates: dict[str, str]) -> None:
    """Rewrite ONLY the keys in `updates`, in place. Everything else is byte-preserved.

    The launcher's job is to stamp the machine's LAN IP into two or three variables. It must not be
    able to damage the secrets that live in the same files (AUTH_SECRET, ADMIN_PASSWORD,
    IMPORT_PASSWORD, ALLOWED_DOMAIN, DATABASE_URL, ...).

    The previous version parsed the file into a dict and re-serialized it, which silently DESTROYED
    comments, blank lines, key order, and any line without '=' — and `v.strip()` also dropped
    intentional trailing whitespace inside quoted values. Untouched keys survived only by accident.
    This version edits matching lines and appends genuinely-new keys at the end.

    EVERY occurrence of a key is rewritten, not just the first. A .env may legitimately carry the
    same key twice (backend.env carries LOCAL_IP twice today, one line stamped by an old boot and
    one typed by hand), and dotenv resolves a duplicate as LAST-ONE-WINS. Popping on the first
    match — what this did before — updated the line at the top and left the stale copy at the
    bottom, which is precisely the value the application then loaded: the stamp appeared to work,
    the file looked right at a glance, and the process still ran on the old IP.
    """

    lines = (
        path.read_text(encoding="utf-8").splitlines()
        if path.exists()
        else []
    )

    written: set[str] = set()

    for i, line in enumerate(lines):

        if "=" not in line or line.lstrip().startswith("#"):
            continue   # comment or non-assignment: leave exactly as-is

        key = line.partition("=")[0].strip()

        if key in updates:
            lines[i] = f"{key}={updates[key]}"
            written.add(key)

    for k, v in updates.items():            # key not present yet: append, don't reorder the rest
        if k not in written:
            lines.append(f"{k}={v}")

    path.parent.mkdir(parents=True, exist_ok=True)   # off-tree .env dir may not exist yet
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_env_value(path: Path, key: str) -> str:
    """One key out of a .env file. No dotenv, no mutation of os.environ.

    Deliberately minimal: this runs before anything is configured, and the only question it
    has to answer is whether this machine declares a TLS front door.
    """
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip('"').strip("'")
    return ""


def ws_scheme(origin: str) -> str:
    """http://x -> ws://x, https://x -> wss://x."""
    if origin.startswith("https://"):
        return "wss://" + origin[len("https://"):]
    if origin.startswith("http://"):
        return "ws://" + origin[len("http://"):]
    return origin


def _ipv4(host: str) -> ipaddress.IPv4Address | None:
    """The host as an IPv4 literal, or None when it is a NAME.

    The distinction is the whole point of the re-pointer below: a name (`host.local`) already
    follows the machine, an IP literal does not.
    """
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return None
    return addr if isinstance(addr, ipaddress.IPv4Address) else None


def sync_origins_to_ip(origins: list[str], ip: str) -> tuple[list[str], list[tuple[str, str]]]:
    """Repoint every IP-literal entry of PUBLIC_ORIGIN at the CURRENT LAN IP.

    PUBLIC_ORIGIN mixes two kinds of entry and only one of them survives a DHCP lease change:

        PUBLIC_ORIGIN=https://meu-host.local,https://192.168.0.90
                      └─ name: mDNS resolves it to whatever the IP is today ┘
                                              └─ literal: frozen at the IP of the day the
                                                 Caddyfile was generated ─────────────────┘

    The literal is not decoration. The whole list becomes FRONTEND_URL, which IS the CORS
    allow-list (see main.py::_parse_origins), so once it goes stale a browser that reached the
    app by IP gets every preflight answered with no Access-Control-Allow-Origin — a login that
    fails with nothing in the UI to explain it, on a machine whose only visible change was a
    reboot. Re-stamping it on each boot is the same treatment LOCAL_IP and the frontend's
    NEXT_PUBLIC_API_URL already get.

    Only the HOST is replaced: scheme and port are carried through, so `https://10.0.0.5:8443`
    stays https and stays on 8443. Names are never touched — rewriting `host.local` to an IP
    would break TLS, since the certificate is issued for the name.

    Loopback is skipped on BOTH sides. A `https://127.0.0.1` entry means loopback and must keep
    meaning loopback; and `get_local_ip()` returns 127.0.0.1 as its failure value, so a machine
    that is briefly offline at boot must not be allowed to overwrite the LAN address of the whole
    allow-list with it (the caller enforces that half).

    Returns the new list plus the (old, new) pairs that actually changed.
    """

    out: list[str] = []
    changes: list[tuple[str, str]] = []

    for origin in origins:
        # urlsplit needs a scheme separator to populate netloc; a bare `192.168.0.67` would
        # otherwise parse entirely into .path and read as a name.
        parts = urlsplit(origin if "://" in origin else "//" + origin)
        addr = _ipv4(parts.hostname or "")

        if addr is None or addr.is_loopback or str(addr) == ip:
            out.append(origin)
            continue

        netloc = ip if parts.port is None else f"{ip}:{parts.port}"
        new = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
        if not parts.scheme:
            new = new.lstrip("/")          # urlunsplit keeps the `//` we added above

        out.append(new)
        changes.append((origin, new))

    return out, changes


def main():

    ip = get_local_ip()

    py_exec = get_backend_python()

    # PUBLIC_ORIGIN — the TLS front door, when this machine has one: a Caddy reverse proxy
    # terminating HTTPS in front of both services (see LAN-HTTPS.md). Comma-separated. The
    # FIRST entry is canonical and becomes the API/WS base the frontend is compiled against;
    # the whole list goes to CORS, so a second name (the IP, say) keeps working.
    #
    # This override is not cosmetic. The IP+http defaults below are right ONLY for a machine
    # reached over plain http, and stamping them onto a machine behind the proxy breaks it
    # twice: the browser blocks an http call from an https page as mixed content, and
    # FRONTEND_URL reverts to the http origin, so every preflight is answered with no
    # Access-Control-Allow-Origin. Both faults return on EVERY boot, because this function
    # rewrites both files each time — editing .env.local by hand cannot survive it.
    #
    # Unset (the normal case) leaves the behaviour byte-identical to before.
    _env_raw = read_env_value(BACKEND_ENV, "PUBLIC_ORIGIN")
    _override = os.getenv("PUBLIC_ORIGIN", "").strip()
    _raw = _override or _env_raw
    origins = [o.strip().rstrip("/") for o in _raw.split(",") if o.strip()]

    # Keep the IP-literal entries pointing at the address this machine has RIGHT NOW. See
    # sync_origins_to_ip: everything downstream of PUBLIC_ORIGIN (FRONTEND_URL and therefore
    # CORS, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL) is derived from this list, so syncing here
    # syncs all of it in one place.
    #
    # Guarded on `ip != 127.0.0.1` because that is get_local_ip()'s FAILURE value, not an
    # address: a boot that races the network stack would otherwise rewrite the LAN entry to
    # loopback and lock every other machine out of the app until someone edited the file by hand.
    _self = _ipv4(ip)
    origin_changes: list[tuple[str, str]] = []
    if origins and _self is not None and not _self.is_loopback:
        origins, origin_changes = sync_origins_to_ip(origins, ip)

    canonical = origins[0] if origins else ""

    api_url = canonical or f"http://{ip}:8000"
    ws_url = ws_scheme(canonical) if canonical else f"ws://{ip}:8000"
    frontend_url = ",".join(origins) if origins else f"http://{ip}:3000"
    visit = canonical or f"http://{ip}:3000"

    # Onde o uvicorn escuta. Com um proxy TLS declarado (PUBLIC_ORIGIN), o backend NAO
    # pode aceitar conexao direta da rede: quem chegasse em http://IP:8000 falaria com a
    # API em texto claro, com o bearer token do Entra no cabecalho, contornando todo o
    # TLS do Caddy. Loopback resolve isso sem depender de regra de firewall — que aqui
    # exigiria admin e nao esta disponivel. Sem PUBLIC_ORIGIN nada muda: o acesso por
    # http://IP:3000 continua sendo o caminho, e ele precisa de 0.0.0.0.
    bind_host = "127.0.0.1" if canonical else "0.0.0.0"

    # APP_MODE — a mesma chave que decide se o frontend roda `next dev` ou o build de
    # producao (ver _app_mode em dev.py). Aqui ela decide o recarregador de arquivos do
    # uvicorn, que e a versao backend do mesmo problema: em producao ele nao serve para
    # nada e cobra caro. Ele mantem um processo supervisor a mais e um observador de
    # arvore de arquivos, e sobretudo REINICIA A APLICACAO INTEIRA quando um arquivo muda
    # — o que num host cujo repositorio fica dentro do OneDrive corporativo significa
    # derrubar a sessao de todo mundo no instante em que a sincronizacao encostar num .py,
    # sem ninguem ter pedido nada. Nao e teoria: e o mesmo motivo pelo qual o frontend
    # deixa de rodar em modo de desenvolvimento.
    #
    # O padrao segue o padrao seguro: maquina com porta de entrada na rede assume
    # producao, e a maquina de desenvolvimento e que declara APP_MODE=dev.
    _mode = (os.getenv("APP_MODE") or read_env_value(BACKEND_ENV, "APP_MODE")).strip().lower()
    if _mode in ("dev", "development", "desenvolvimento"):
        reload_on = True
    elif _mode in ("prod", "production", "producao"):
        reload_on = False
    else:
        reload_on = not canonical

    print(f"[START] IP detectado:     {ip}")
    print(f"[START] Backend rodando:  {api_url}")
    print(f"[START] Frontend acessar: {visit}")
    print(f"[START] Modo:             {'desenvolvimento' if reload_on else 'producao'} "
          f"(reload={'on' if reload_on else 'off'})")
    print(f"[START] Compartilhe:      {visit}")

    # NEXT_PUBLIC_SAME_ORIGIN — atras da porta de entrada TLS o pacote NAO pode ser compilado
    # contra a entrada canonica. Backend e frontend saem pelo mesmo host:porta, entao o valor
    # certo para a base da API e "a origem desta aba" e nao um endereco fixo: um cliente que
    # chegou por https://IP (segunda entrada de PUBLIC_ORIGIN, que o Caddy atende e o SAN do
    # certificado cobre) recebia uma pagina que so falava com https://<host>.local, um nome que
    # ele nao resolve — a pagina abre e toda chamada morre, falha pior que nao abrir.
    #
    # `.local` e mDNS, nao DNS: nao atravessa VLAN nem sub-rede, e o proprio host resolve o
    # proprio nome sem rede nenhuma. Por isso a maquina hospedeira sempre funciona enquanto o
    # cliente leva DNS_PROBE_STARTED, e por isso o endereco NAO pode ser decidido aqui.
    #
    # NEXT_PUBLIC_ORIGINS leva a lista inteira para o connect-src da CSP em next.config.ts —
    # sem ela, o navegador de quem entra pelo IP bloquearia a propria chamada de origem unica.
    update_env_file(
        FRONTEND_ENV,
        {
            "NEXT_PUBLIC_API_URL": api_url,
            "NEXT_PUBLIC_WS_URL": ws_url,
            "NEXT_PUBLIC_SAME_ORIGIN": "1" if canonical else "0",
            "NEXT_PUBLIC_ORIGINS": ",".join(origins),
        },
    )

    print("[START] frontend/.env.local atualizado.")

    backend_updates = {
        "LOCAL_IP": ip,
        "FRONTEND_URL": frontend_url,
    }

    # PUBLIC_ORIGIN is stamped back only when the FILE is what supplied it and an entry actually
    # moved. Two deliberate omissions:
    #
    #   • the key is never CREATED. Writing a PUBLIC_ORIGIN into a file that had none would flip
    #     that machine into front-door mode on its next boot — uvicorn binds 127.0.0.1 and Next
    #     binds 127.0.0.1 — and a machine with no Caddy in front of it would simply vanish from
    #     the LAN, having been given a TLS address that nothing answers.
    #   • an environment-variable override is left alone. There the process environment is
    #     authoritative and the file is not the source, so editing it would desync the two.
    if origin_changes and _env_raw and not _override:
        backend_updates["PUBLIC_ORIGIN"] = ",".join(origins)
        for old, new in origin_changes:
            print(f"[START] PUBLIC_ORIGIN: {old} -> {new}")

        # The IP is baked into two more places this script cannot reach: the Caddyfile's site
        # address (`https://$HostName, https://$IPAddress`) and the leaf certificate's IP SAN.
        # Re-stamping the env keeps CORS honest but does NOT make https-by-IP work again — Caddy
        # will not even match a request to an address its site block never mentions. Say so,
        # rather than leaving a green boot log next to a front door that no longer opens.
        print("[START] AVISO: o IP mudou. O Caddyfile e o certificado ainda tem o IP antigo;")
        print("[START]        rode deploy/pki/New-Caddyfile.ps1 e Renew-HostCert.ps1, ou acesse")
        print(f"[START]        pelo nome ({canonical}), que acompanha a maquina.")

    update_env_file(BACKEND_ENV, backend_updates)

    print("[START] backend/.env atualizado.")
    print(f"[START] Python backend: {py_exec}")
    print()

    # Invoked via `python -c` (uvicorn.run) instead of `python -m uvicorn` (its
    # click-based CLI) because click expands any CLI arg containing '*'/'?' as a
    # filesystem glob on Windows, which blows up `--reload-exclude venv/*` into
    # the literal contents of venv/ and crashes with "unexpected extra arguments".
    subprocess.run(
        [
            py_exec,
            "-c",
            # dev.py e frontend_serve.py ficam FORA do observador. Os dois sao o lancador,
            # nao a aplicacao: nenhum modulo servido pelo uvicorn os importa, e ainda assim
            # cada gravacao neles derrubava e subia a API inteira — 25 reinicios numa tarde
            # de mexer no painel. Nao e so desperdicio: a cada reinicio o mapa de presenca
            # nasce vazio, entao todo usuario ativo era anunciado de novo como "entrou" e a
            # trilha dele virava uma sequencia de pontos soltos em vez de uma sessao.
            f"import uvicorn; uvicorn.run('main:app', host='{bind_host}', port=8000, "
            f"reload={reload_on}, "
            f"reload_excludes=['venv/*', 'dev.py', 'frontend_serve.py'])",
        ],
        cwd=str(BACKEND),
    )


if __name__ == "__main__":
    main()