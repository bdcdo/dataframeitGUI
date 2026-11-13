/**
 * self-comparison/assign.ts: atribui ao pesquisador, em lote, a comparação
 * de documentos que ele mesmo codificou, com a liberação do coordenador (as
 * regras de elegibilidade estão em `src/lib/self-comparison-assign.ts`).
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

import { runSelfComparisonCli } from "@/lib/self-comparison-assign";
import { MISSING_SERVICE_ENV, serviceClientFromEnv } from "../comentarios-relatorio/load-env";

if (process.argv[1]?.endsWith("assign.ts")) {
  // A autoria da liberação vem de --approved-by e é validada pelo gatilho do
  // banco: a service key não tem sessão Clerk que a carimbe.
  void runSelfComparisonCli(process.argv.slice(2), serviceClientFromEnv, {
    log: console.log,
    error: console.error,
    missingEnv: MISSING_SERVICE_ENV,
  }).then((code) => {
    process.exitCode = code;
  });
}
