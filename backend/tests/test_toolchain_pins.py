"""Pinos da toolchain do backend declarados em mais de um lugar precisam convergir.

- o ruff do pre-commit é o de ``uv.lock`` (``uv run``), sem ``rev`` próprio
  (porquê: comentário do hook em ``.pre-commit-config.yaml``; #554).
- ``.python-version`` == Python do ``Dockerfile`` == ``python_version`` do
  mypy. Sem o pino, o ``uv`` local pegava o Python mais novo instalado (3.15),
  para o qual o lock não tem wheel do tiktoken.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent


def _hook_entry(config: str, hook_id: str) -> str:
    """``entry`` do hook ``hook_id`` (antes do próximo hook ou repo), ou ""."""
    match = re.search(
        rf"^\s*- id: {re.escape(hook_id)}\s*\n(?:(?!\s*- ).*\n)*?\s*entry:\s*(.*)",
        config,
        re.MULTILINE,
    )
    return match.group(1) if match else ""


def _ruff_hook_problems(config: str, pyproject: str, lock_text: str) -> list[str]:
    """O que impede o ruff do pre-commit de ser o mesmo travado em ``uv.lock``."""
    problems = []
    if re.search(r"^\s*- repo:\s*\S*ruff-pre-commit", config, re.MULTILINE):
        problems.append(
            "hook oficial astral-sh/ruff-pre-commit em .pre-commit-config.yaml: "
            "o `rev` dele é um segundo pino do ruff, que diverge de backend/uv.lock "
            "a cada release (#554). Use o hook local `uv run --project backend ruff`."
        )
    for hook_id in ("ruff-check", "ruff-format"):
        command = hook_id.replace("-", " ")
        entry = _hook_entry(config, hook_id)
        # Qualquer forma de rodar pelo projeto backend serve (`--project
        # backend`, `cd backend && uv run ...`); o que não serve é um ruff
        # resolvido fora do uv.lock.
        if "backend" not in entry or not re.search(
            rf"\buv run (\S+ )*{command}\b", entry
        ):
            problems.append(
                f"hook `{hook_id}` em .pre-commit-config.yaml não roda via "
                f"`uv run --project backend {command}` (ruff de backend/uv.lock)."
            )

    # `uv run ruff` cai no ruff do PATH se o venv não o tiver: o pino só vale
    # com o ruff no grupo dev e travado no lock.
    dev = tomllib.loads(pyproject).get("dependency-groups", {}).get("dev", [])
    if not any(re.match(r"ruff\b", str(dep)) for dep in dev):
        problems.append(
            "ruff ausente do dependency-group dev em backend/pyproject.toml."
        )
    locked = [
        p["version"]
        for p in tomllib.loads(lock_text).get("package", [])
        if p["name"] == "ruff"
    ]
    if len(locked) != 1:
        problems.append(f"esperava um ruff em backend/uv.lock, achei {locked}.")
    return problems


def test_ruff_hook_runs_locked_ruff() -> None:
    problems = _ruff_hook_problems(
        (REPO / ".pre-commit-config.yaml").read_text(),
        (BACKEND / "pyproject.toml").read_text(),
        (BACKEND / "uv.lock").read_text(),
    )
    assert not problems, "\n".join(problems)


def test_ruff_hook_problems_flags_second_pin() -> None:
    # Prova do vermelho: a config de antes (hook oficial com `rev`) reprova,
    # nomeando o arquivo; e um ruff fora do grupo dev e do lock também.
    old = (
        "  - repo: https://github.com/astral-sh/ruff-pre-commit\n"
        "    rev: v0.17.3\n"
        "    hooks:\n"
        "      - id: ruff-check\n"
        "        args: [--fix]\n"
        "      - id: ruff-format\n"
    )
    pyproject = '[dependency-groups]\ndev = ["ruff>=0.15"]\n'
    lock = '[[package]]\nname = "ruff"\nversion = "0.17.3"\n'
    problems = _ruff_hook_problems(old, pyproject, lock)
    assert len(problems) == 3, problems
    assert all(".pre-commit-config.yaml" in p for p in problems)

    # Um hook com `language: python` e o ruff pinado em additional_dependencies
    # é o mesmo segundo pino, mesmo que um comentário cite o comando certo.
    pinned = (
        "  # entry: uv run --project backend ruff check --fix\n"
        "  - repo: local\n"
        "    hooks:\n"
        "      - id: ruff-check\n"
        "        entry: ruff check --fix\n"
        "        language: python\n"
        "        additional_dependencies: [ruff==0.17.2]\n"
        "      - id: ruff-format\n"
        "        entry: uv run --locked --project backend ruff format\n"
        "        language: system\n"
    )
    problems = _ruff_hook_problems(pinned, pyproject, lock)
    assert problems == [
        "hook `ruff-check` em .pre-commit-config.yaml não roda via "
        "`uv run --project backend ruff check` (ruff de backend/uv.lock)."
    ], problems

    problems = _ruff_hook_problems(
        (REPO / ".pre-commit-config.yaml").read_text(),
        "[dependency-groups]\ndev = []\n",
        "",
    )
    assert any("dependency-group dev" in p for p in problems), problems
    assert any("backend/uv.lock" in p for p in problems), problems


def _remote_rev_problems(config: str) -> list[str]:
    """Hooks de repositório remoto cujo ``rev`` não é SHA com ``# frozen: <tag>``."""
    problems = []
    for match in re.finditer(
        r"^\s*- repo:\s*(\S+)\s*\n\s*rev:\s*(.*)$", config, re.MULTILINE
    ):
        repo, rev = match.groups()
        if not re.fullmatch(r"[0-9a-f]{40}\s+# frozen: v?\d\S*", rev.strip()):
            problems.append(
                f"{repo} em .pre-commit-config.yaml com `rev: {rev.strip()}`: "
                "pine pelo SHA do commit com `# frozen: <tag>` (#555)."
            )
    return problems


def test_remote_hooks_pinned_by_frozen_sha() -> None:
    config = (REPO / ".pre-commit-config.yaml").read_text()
    remotes = re.findall(r"^\s*- repo:\s*https://", config, re.MULTILINE)
    # Todo repo remoto precisa ser visto pela regex do `rev`: um bloco em
    # outra forma passaria sem ser conferido.
    revs = re.findall(r"^\s*- repo:\s*https://\S+\s*\n\s*rev:", config, re.MULTILINE)
    assert remotes and len(revs) == len(remotes), (remotes, revs)
    problems = _remote_rev_problems(config)
    assert not problems, "\n".join(problems)


def test_remote_rev_problems_flags_tag_pin() -> None:
    # Prova do vermelho: o pin por tag de antes reprova; SHA sem o comentário
    # (o Dependabot não saberia a tag) e SHA abreviado também.
    sha = "83d9cd684c87d95d656c1458ef04895a7f1cbd8e"
    config = (
        "  - repo: https://github.com/gitleaks/gitleaks\n"
        "    rev: v8.30.1\n"
        "  - repo: https://github.com/rhysd/actionlint\n"
        f"    rev: {sha}\n"
        "  - repo: https://github.com/pre-commit/pre-commit-hooks\n"
        f"    rev: {sha[:12]}  # frozen: v6.0.0\n"
        "  - repo: https://github.com/example/ok\n"
        f"    rev: {sha}  # frozen: v1.2.3\n"
    )
    problems = _remote_rev_problems(config)
    assert [p.split(" ")[0] for p in problems] == [
        "https://github.com/gitleaks/gitleaks",
        "https://github.com/rhysd/actionlint",
        "https://github.com/pre-commit/pre-commit-hooks",
    ], problems


def test_python_version_matches_dockerfile_and_mypy() -> None:
    pinned = (BACKEND / ".python-version").read_text().strip()
    match = re.search(
        r"^FROM python:(\d+\.\d+)",
        (BACKEND / "Dockerfile").read_text(),
        re.MULTILINE,
    )
    assert match, "FROM python:X.Y não encontrado em backend/Dockerfile"
    pyproject = tomllib.loads((BACKEND / "pyproject.toml").read_text())

    pins = {
        "backend/.python-version": pinned,
        "backend/Dockerfile": match.group(1),
        "[tool.mypy] python_version": pyproject["tool"]["mypy"]["python_version"],
    }
    assert len(set(pins.values())) == 1, f"pinos de Python do backend divergem: {pins}"


def test_uv_version_matches_dockerfile() -> None:
    """O uv do contrato de banco no CI (#674) é o mesmo da imagem do backend."""
    docker = re.search(
        r"ghcr\.io/astral-sh/uv:(\S+)", (BACKEND / "Dockerfile").read_text()
    )
    workflow = re.search(
        r"astral-sh/setup-uv@.*\n\s*with:\n(?:\s*#.*\n)*\s*version:\s*\"([^\"]+)\"",
        (REPO / ".github/workflows/database-tests.yml").read_text(),
    )
    assert docker, "uv não encontrado em backend/Dockerfile"
    assert workflow, "setup-uv sem `version` em .github/workflows/database-tests.yml"
    assert docker.group(1) == workflow.group(1), (
        f"uv diverge: Dockerfile {docker.group(1)}, database-tests.yml {workflow.group(1)}"
    )
