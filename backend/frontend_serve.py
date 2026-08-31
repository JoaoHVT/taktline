"""
Serve o frontend em modo PRODUCAO: compila se preciso e roda `next start`.

E o comando do servico "Frontend" no dev.py quando a maquina esta em modo producao.
Em modo desenvolvimento o dev.py continua chamando `npm run dev` direto e este arquivo
nao entra na jogada.

POR QUE ISTO EXISTE
`next dev` nao e uma versao mais lenta de `next start` — e um servidor DIFERENTE, com
superficie propria que nao existe em producao:

  • /__nextjs_launch-editor  faz o HOST abrir um arquivo no editor. Verificado na LAN:
    um GET sem autenticacao nenhuma criou notepad.exe com C:\\Windows\\System32\\calc.exe
    como argumento. Em `next start` o mesmo caminho responde 404 — o endpoint nao existe.
  • /_next/static/chunks/*.js.map  com o TypeScript original inteiro em sourcesContent,
    incluindo os caminhos absolutos do disco. O build de producao emite um unico .map
    vazio ({"sources":[],"sections":[]}).
  • a CSP afrouxa sozinha em dev: `script-src` ganha 'unsafe-eval' e `connect-src` ganha
    ws://localhost:* e http://localhost:* (necessarios para o HMR), e
    `upgrade-insecure-requests` fica de fora. Ver next.config.ts — o proprio arquivo ja
    faz `isDev = NODE_ENV !== "production"`.

O limite do proxy (deploy/pki/New-Caddyfile.ps1) barra esses caminhos de qualquer forma, e
continua valendo. Mas ele e uma tampa sobre uma superficie que nao precisava existir: com
o build de producao a superficie some na origem, e a tampa vira defesa em profundidade em
vez de ser a unica barreira.

O CUSTO, E A RAZAO DE TER FINGERPRINT
`next start` serve o BUILD, nao o codigo-fonte. Depois de um `git pull` o processo continua
servindo o build velho, em silencio — e "o servidor esta rodando a versao de ontem" e um
defeito que ninguem descobre olhando um log verde. Por isso este script compara uma
impressao digital do conteudo das fontes com a gravada no ultimo build e recompila sozinho
quando divergem. Recompilar a toa custa ~40 s; servir codigo velho custa uma tarde de
depuracao de um bug que ja foi corrigido.

A impressao digital usa o CONTEUDO dos arquivos, nao mtime: o repositorio do host fica
dentro do OneDrive corporativo, e sincronizacao mexe em mtime sem mexer no conteudo, o que
dispararia rebuild em cada sincronizada.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

# O build sai em frontend/.next e nao ha como mover: o Turbopack recusa distDir absoluto
# ("no such file or directory" com o caminho concatenado ao do projeto) e tambem recusa
# relativo que saia da pasta ("distDirRoot should not navigate out of the projectPath").
# Testado nas duas formas. Se o volume dentro do OneDrive incomodar, a saida e uma juncao
# de diretorio — ver deploy/README.md secao 14.
DIST_DIR = FRONTEND / ".next"

# Arquivos e pastas cujo conteudo decide se o build esta velho.
WATCH_DIRS = ["src", "public"]
WATCH_FILES = [
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    # .env.local entra porque todo NEXT_PUBLIC_* e SOLDADO no pacote em tempo de build.
    # Trocar PUBLIC_ORIGIN e reiniciar sem recompilar deixaria o navegador chamando a API
    # no endereco antigo, e o start.py reescreve este arquivo a cada boot.
    ".env.local",
]
SKIP_DIRS = {"node_modules", ".next", ".git", "__pycache__"}

STAMP_NAME = ".masterplanner-build"


def fingerprint() -> str:
    h = hashlib.sha256()
    for rel in WATCH_DIRS:
        base = FRONTEND / rel
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if not path.is_file():
                continue
            h.update(str(path.relative_to(FRONTEND)).replace("\\", "/").encode())
            h.update(path.read_bytes())
    for rel in WATCH_FILES:
        path = FRONTEND / rel
        h.update(rel.encode())
        if path.is_file():
            h.update(path.read_bytes())
    # A versao INSTALADA do Next, e nao a faixa em package.json: o formato do diretorio de
    # build muda entre versoes, e um `npm install` que suba a versao dentro do "^16.2.4"
    # nao mexe em package.json nenhum. Sem isto, `next start` recusaria o build antigo com
    # uma mensagem que nao diz o que fazer.
    pkg = FRONTEND / "node_modules" / "next" / "package.json"
    if pkg.is_file():
        h.update(pkg.read_bytes())
    return h.hexdigest()


def stamp_path() -> Path:
    return DIST_DIR / STAMP_NAME


def build_exists() -> bool:
    return (DIST_DIR / "BUILD_ID").is_file()


def npm() -> str:
    found = shutil.which("npm")
    if not found:
        print("[FRONTEND] npm nao encontrado no PATH.", flush=True)
        sys.exit(1)
    return found


def run(args: list[str]) -> int:
    """Roda um comando com a saida indo direto para o painel do console."""
    env = dict(os.environ)
    env["FORCE_COLOR"] = "1"
    return subprocess.run(args, cwd=str(FRONTEND), env=env).returncode


def build() -> bool:
    print("[FRONTEND] Compilando build de producao (next build)...", flush=True)
    print("[FRONTEND] Isso leva de 40 s a alguns minutos.", flush=True)
    code = run([npm(), "run", "build"])
    if code != 0:
        print(f"[FRONTEND] ERRO: o build falhou (codigo {code}).", flush=True)
        return False
    try:
        stamp_path().write_text(fingerprint(), encoding="utf-8")
    except OSError as exc:
        print(f"[FRONTEND] AVISO: nao consegui gravar a marca do build ({exc}).", flush=True)
    print("[FRONTEND] Build pronto.", flush=True)
    return True


def main() -> int:
    host = os.environ.get("MASTERPLANNER_FRONTEND_HOST", "127.0.0.1")
    port = os.environ.get("MASTERPLANNER_FRONTEND_PORT", "3000")

    current = fingerprint()
    marca = stamp_path()
    gravada = marca.read_text(encoding="utf-8").strip() if marca.is_file() else ""

    if not build_exists():
        print("[FRONTEND] Nenhum build encontrado.", flush=True)
        precisa = True
    elif gravada != current:
        print("[FRONTEND] O codigo mudou desde o ultimo build.", flush=True)
        precisa = True
    else:
        print("[FRONTEND] Build atual — nada a compilar.", flush=True)
        precisa = False

    if precisa and not build():
        if not build_exists():
            # Sem build anterior nao ha o que servir. Falhar aqui e o certo: uma pagina de
            # 502 do proxy diz "esta iniciando", que e melhor do que uma pagina que nunca
            # vem sem ninguem saber por que.
            return 1
        # Com build anterior, servir o velho e melhor do que nao servir nada — mas isto
        # PRECISA gritar, senao vira "esta no ar" com codigo de ontem por tempo indefinido.
        print("[FRONTEND] " + "=" * 62, flush=True)
        print("[FRONTEND] ATENCAO: servindo o BUILD ANTERIOR. O codigo novo NAO esta no ar.",
              flush=True)
        print("[FRONTEND] Corrija o erro acima e reinicie o painel Frontend.", flush=True)
        print("[FRONTEND] " + "=" * 62, flush=True)

    print(f"[FRONTEND] next start em {host}:{port}", flush=True)
    return run([npm(), "run", "start", "--", "--hostname", host, "--port", port])


if __name__ == "__main__":
    sys.exit(main())
