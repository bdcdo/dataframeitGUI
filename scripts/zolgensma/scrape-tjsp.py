#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["juscraper", "pandas", "pyarrow"]
# ///
"""Raspa decisoes de 1o grau do TJSP via juscraper.cjpg(id_processo=cnj) para
cada CNJ listado em data/zolgensma/processos-tjsp.txt.

Salva, em data/zolgensma/raspagem/:
  cjpg-<cnj>.parquet     uma decisao por linha (varias possiveis por CNJ)
  done.txt               CNJs ja raspados (checkpoint incremental)
  erros.csv              CNJs sem resultado ou que falharam
  cjpg-agregado.parquet  consolidado final (concat de todos os .parquet)

Uso:
  uv run scripts/zolgensma/scrape-tjsp.py                # lote completo
  uv run scripts/zolgensma/scrape-tjsp.py --limit 3      # amostra
"""

import argparse
import csv
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import juscraper as jus
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
INPUT = REPO_ROOT / "data" / "zolgensma" / "processos-tjsp.txt"
OUT_DIR = REPO_ROOT / "data" / "zolgensma" / "raspagem"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_error(cnj: str, motivo: str) -> None:
    erros_path = OUT_DIR / "erros.csv"
    novo = not erros_path.exists()
    with erros_path.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if novo:
            w.writerow(["cnj", "motivo", "timestamp"])
        w.writerow([cnj, motivo, now()])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Raspa apenas os N primeiros CNJs (amostra)")
    args = parser.parse_args()

    if not INPUT.exists():
        print(f"ERRO: input nao encontrado: {INPUT}", file=sys.stderr)
        return 1

    cnjs = [c.strip() for c in INPUT.read_text(encoding="utf-8").splitlines() if c.strip()]
    if args.limit is not None:
        cnjs = cnjs[: args.limit]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done_path = OUT_DIR / "done.txt"
    done = set(done_path.read_text(encoding="utf-8").splitlines()) if done_path.exists() else set()

    pendentes = [c for c in cnjs if c not in done]
    print(f"CNJs no input: {len(cnjs)} | ja concluidos: {len(done)} | pendentes: {len(pendentes)}")

    if not pendentes:
        print("Nada a fazer.")
    else:
        tjsp = jus.scraper("tjsp", sleep_time=0.5, download_path=str(OUT_DIR / "raw"))
        for i, cnj in enumerate(pendentes, 1):
            print(f"[{i}/{len(pendentes)}] {cnj}", flush=True)
            try:
                df = tjsp.cjpg(id_processo=cnj)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                log_error(cnj, f"excecao: {type(e).__name__}: {e}")
                continue
            if df is None or len(df) == 0:
                log_error(cnj, "sem resultados (cjpg vazio)")
                continue
            df = df.copy()
            df["cnj_query"] = cnj
            df.to_parquet(OUT_DIR / f"cjpg-{cnj}.parquet", index=False)
            with done_path.open("a", encoding="utf-8") as f:
                f.write(cnj + "\n")

    # Consolidacao final: junta todos os parquets que existirem
    parquets = sorted(OUT_DIR.glob("cjpg-*.parquet"))
    if parquets:
        dfs = [pd.read_parquet(p) for p in parquets]
        agregado = pd.concat(dfs, ignore_index=True)
        agregado.to_parquet(OUT_DIR / "cjpg-agregado.parquet", index=False)
        print(
            f"\nAgregado: {len(parquets)} CNJs, {len(agregado)} decisoes -> {OUT_DIR / 'cjpg-agregado.parquet'}"
        )
    else:
        print("\nNenhum parquet a agregar.")

    erros_path = OUT_DIR / "erros.csv"
    if erros_path.exists():
        with erros_path.open(encoding="utf-8") as f:
            n_erros = sum(1 for _ in f) - 1
        print(f"Erros registrados em {erros_path}: {n_erros}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
