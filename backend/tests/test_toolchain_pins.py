"""Pinos da toolchain do backend declarados em mais de um lugar precisam convergir.

- ``rev`` do ``ruff-pre-commit`` == ``ruff`` em ``uv.lock`` (porquê: comentário
  do hook em ``.pre-commit-config.yaml``; #554).
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


def _ruff_pin_mismatch(config: str, lock_text: str) -> str | None:
    """Mensagem de falha se o ``rev`` do hook diverge do ruff travado; senão None."""
    match = re.search(
        r"repo:\s*https://github\.com/astral-sh/ruff-pre-commit\s*\n\s*rev:\s*[\"']?([^\"'\s]+)",
        config,
    )
    assert match, "hook ruff-pre-commit não encontrado em .pre-commit-config.yaml"
    rev = match.group(1)
    hook_version = rev.removeprefix("v")

    lock = tomllib.loads(lock_text)
    locked = [p["version"] for p in lock["package"] if p["name"] == "ruff"]
    assert len(locked) == 1, f"esperava um ruff em uv.lock, achei {locked}"
    if hook_version == locked[0]:
        return None
    return (
        f"rev do ruff-pre-commit em .pre-commit-config.yaml ({rev}) diverge do "
        f"ruff em backend/uv.lock ({locked[0]}). Alinhe os dois: se o lock está "
        f"certo, troque o `rev` para v{locked[0]}; se o bump foi o do hook, rode "
        f"`cd backend && uv lock --upgrade-package ruff=={hook_version}`."
    )


def test_ruff_hook_rev_matches_locked_ruff() -> None:
    mismatch = _ruff_pin_mismatch(
        (REPO / ".pre-commit-config.yaml").read_text(),
        (BACKEND / "uv.lock").read_text(),
    )
    assert mismatch is None, mismatch


def test_ruff_pin_mismatch_names_both_files_and_versions() -> None:
    # Prova do vermelho do #554 pelo mesmo caminho do teste real: com o `rev`
    # sabotado, a falha nomeia as duas versões e os dois arquivos.
    config = (
        "  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.17.2\n"
    )
    lock = '[[package]]\nname = "ruff"\nversion = "0.17.3"\n'
    message = _ruff_pin_mismatch(config, lock)
    assert message is not None
    for expected in (".pre-commit-config.yaml", "v0.17.2", "backend/uv.lock", "0.17.3"):
        assert expected in message, f"{expected!r} ausente de: {message}"
    assert _ruff_pin_mismatch(config.replace("v0.17.2", "v0.17.3"), lock) is None


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
