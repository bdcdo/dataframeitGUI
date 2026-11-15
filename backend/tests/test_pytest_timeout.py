"""Um deadlock reprova o teste pendurado em vez de travar a suíte (#833).

Na revisão do #830, trocar o ``RLock`` do publicador por ``Lock`` fez a suíte
travar em deadlock, e só um ``timeout`` externo encerrou o processo. O
``pytest-timeout`` configurado no ``pyproject.toml`` (com ``timeout_method =
"thread"``) encerra o teste pendurado com o traceback das threads.

Aqui um pytest filho, com a configuração do backend e só o valor do timeout
encurtado, roda um teste que reentra num ``Lock``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
PYPROJECT = BACKEND / "pyproject.toml"
# PYTEST_TIMEOUT vence o ini, e as outras duas mudariam os plugins do filho.
CHILD_ENV_DROP = {"PYTEST_TIMEOUT", "PYTEST_ADDOPTS", "PYTEST_DISABLE_PLUGIN_AUTOLOAD"}

DEADLOCK_TEST = """\
import threading


def test_reentrant_acquire_on_plain_lock():
    lock = threading.Lock()
    with lock:
        with lock:
            pass
"""


def test_suite_has_a_default_timeout() -> None:
    ini = tomllib.loads(PYPROJECT.read_text())["tool"]["pytest"]["ini_options"]
    assert ini["timeout"] > 0, "o backend precisa de um timeout padrão (#833)"


def test_deadlocked_test_fails_with_thread_dump(tmp_path: Path) -> None:
    test_file = tmp_path / "test_deadlock.py"
    test_file.write_text(DEADLOCK_TEST)
    env = {k: v for k, v in os.environ.items() if k not in CHILD_ENV_DROP}

    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-c",
                str(PYPROJECT),
                "--rootdir",
                str(tmp_path),
                "-p",
                "no:cacheprovider",
                "--timeout=0.5",
                str(test_file),
            ],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise AssertionError(
            "o teste em deadlock pendurou o pytest filho: pytest-timeout inativo?"
        ) from exc

    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    # O método "thread" despeja a pilha de todas as threads; o "signal" não.
    assert "Stack of MainThread" in output, output
