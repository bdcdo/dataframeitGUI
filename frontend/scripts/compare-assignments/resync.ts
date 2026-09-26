/**
 * compare-assignments/resync.ts: recalcula o status dos assignments de
 * comparação de um projeto (ou de todos) pela regra de `syncCompareAssignment`.
 *
 * Existe para rodar uma vez depois do deploy da validade do veredito por
 * pergunta: assignments fechados por vereditos que perderam a validade ficaram
 * "concluido" com campos pendentes, porque o status só era recalculado quando
 * o revisor votava. Daqui em diante, gravar o schema já ressincroniza o
 * projeto. Idempotente: rodar de novo não muda nada.
 *
 * Rodar com cwd em frontend/ (o alias @/ resolve pelo tsconfig daqui):
 *   npm run resync:compare -- --project <id> --dry-run
 *   npm run resync:compare -- --all
 * `--dry-run` só lê e lista o que mudaria. Precisa de NEXT_PUBLIC_SUPABASE_URL
 * e SUPABASE_SERVICE_ROLE_KEY no .env.local (ou SUPABASE_ENV_PATH).
 */

import { createClient } from "@supabase/supabase-js";
import { runResync } from "@/lib/compare-resync-cli";
import { loadEnv } from "../comentarios-relatorio/load-env";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (frontend/.env.local ou SUPABASE_ENV_PATH).",
  );
  process.exit(2);
}

const client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
void runResync({ client, argv: process.argv.slice(2), log: (line) => console.log(line) }).then((code) => {
  process.exitCode = code;
});
