/**
 * load-env.ts — carga de .env.local compartilhada pelos scripts deste diretório.
 *
 * Honra SUPABASE_ENV_PATH explícito; caso contrário usa os caminhos canônicos
 * relativos ao cwd (raiz do repo ou frontend/). Nunca sobe a árvore de
 * diretórios (../.env.local) — ver CLAUDE.md.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(): void {
  const cwd = process.cwd();
  const candidates = [
    process.env.SUPABASE_ENV_PATH,
    resolve(cwd, ".env.local"),
    resolve(cwd, "frontend/.env.local"),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      const content = readFileSync(path, "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key]) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
      return;
    } catch {
      /* try next */
    }
  }
}
