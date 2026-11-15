"""Versões da toolchain do backend declaradas em dois lugares precisam convergir.

- O ``rev`` do hook ``ruff-pre-commit`` em ``.pre-commit-config.yaml`` e a
  versão do ``ruff`` travada em ``backend/uv.lock`` são a MESMA ferramenta:
  divergentes, o hook de commit e o ``uv run ruff check .`` aplicam regras
  diferentes em silêncio. O Dependabot bumpa os dois em PRs separados (#554).
- ``backend/.python-version`` escolhe o Python do ``uv`` local; precisa ser o
  do ``Dockerfile`` (produção). Sem o pino, o ``uv`` pegava o Python mais novo
  instalado (3.15), para o qual o lock não tem wheel do tiktoken.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent


def test_ruff_hook_rev_matches_locked_ruff() -> None:
    config = (REPO / ".pre-commit-config.yaml").read_text()
    match = re.search(
        r"repo:\s*https://github\.com/astral-sh/ruff-pre-commit\s*\n\s*rev:\s*v?(\S+)",
        config,
    )
    assert match, "hook ruff-pre-commit não encontrado em .pre-commit-config.yaml"
    hook_version = match.group(1)

    lock = tomllib.loads((BACKEND / "uv.lock").read_text())
    locked = [p["version"] for p in lock["package"] if p["name"] == "ruff"]
    assert len(locked) == 1, f"esperava um ruff em uv.lock, achei {locked}"

    assert hook_version == locked[0], (
        f"rev do ruff-pre-commit (v{hook_version}) diverge do ruff em "
        f"backend/uv.lock ({locked[0]}); ajuste o `rev` para v{locked[0]} "
        "(ou o lock, se o bump foi o do hook)"
    )


def test_python_version_matches_dockerfile() -> None:
    pinned = (BACKEND / ".python-version").read_text().strip()
    match = re.search(
        r"^FROM python:(\d+\.\d+)",
        (BACKEND / "Dockerfile").read_text(),
        re.MULTILINE,
    )
    assert match, "FROM python:X.Y não encontrado em backend/Dockerfile"
    assert pinned == match.group(1), (
        f"backend/.python-version ({pinned}) diverge do Python do "
        f"Dockerfile ({match.group(1)})"
    )
