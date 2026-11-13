/**
 * self-comparison/assign.ts: atribui ao pesquisador a comparação de
 * documentos que ele mesmo codificou, com a liberação do coordenador — o que
 * a tabela de atribuições faz célula a célula, em lote (ver
 * `src/lib/self-comparison-assign.ts`).
 *
 * Com cwd em frontend/ (o alias @/ resolve pelo tsconfig daqui):
 *   npm run assign:self-comparison -- --project <id> --user <id> \
 *     --approved-by <id> (--backlog | --documents <id,id,...>) [--dry-run]
 *
 * `--backlog`: os documentos divergentes sem comparação ativa que o
 * pesquisador codificou (a mesma varredura do re-sorteio de comparações).
 * `--approved-by`: o coordenador que libera; o banco recusa quem não for
 * coordenador ou criador do projeto. `--dry-run` só lê e lista.
 * Precisa de NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no
 * .env.local (ou SUPABASE_ENV_PATH).
 */

import { createClient } from "@supabase/supabase-js";
import {
  assignSelfComparisons,
  parseSelfComparisonArgs,
  SELF_COMPARISON_USAGE,
} from "@/lib/self-comparison-assign";
import { loadEnv } from "../comentarios-relatorio/load-env";

async function main(argv: string[]): Promise<number> {
  const args = parseSelfComparisonArgs(argv);
  if (!args) {
    console.error(SELF_COMPARISON_USAGE);
    return 2;
  }
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (frontend/.env.local ou SUPABASE_ENV_PATH).");
    return 2;
  }
  // Service key: o script roda fora de sessão Clerk. A autoria da liberação
  // vem de --approved-by e é validada pelo gatilho do banco.
  const client = createClient(url, key, { auth: { persistSession: false } });
  try {
    const plan = await assignSelfComparisons(client, args);
    const verb = args.dryRun ? "atribuiria" : "atribuiu";
    console.log(`${verb} ${plan.assign.length} autocomparação(ões)${args.dryRun ? ", nada gravado" : ""}`);
    for (const id of plan.assign) console.log(`  + ${id}`);
    for (const { documentId, reason } of plan.skipped) console.log(`  - ${documentId}: ${reason}`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1]?.endsWith("assign.ts")) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
