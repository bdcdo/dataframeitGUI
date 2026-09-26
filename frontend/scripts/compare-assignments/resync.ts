/**
 * compare-assignments/resync.ts: recalcula o status dos assignments de
 * comparação da rodada corrente de cada projeto pela regra de
 * `syncCompareAssignment` e grava os que mudaram. Rodadas antigas ficam como
 * estão.
 *
 * Roda uma vez depois do deploy da validade do veredito por pergunta:
 * assignments fechados por vereditos que perderam a validade ficaram
 * "concluido" com campos pendentes, porque o status só era recalculado quando
 * o revisor votava. Daqui em diante, gravar o schema já ressincroniza o
 * projeto. Idempotente: rodar de novo não muda nada.
 *
 * Com cwd em frontend/ (o alias @/ resolve pelo tsconfig daqui):
 *   npm run resync:compare -- (--project <id> | --all) [--dry-run]
 * `--dry-run` só lê e lista o que mudaria. Sai com 1 se algum projeto falhar,
 * sem parar os outros. Precisa de NEXT_PUBLIC_SUPABASE_URL e
 * SUPABASE_SERVICE_ROLE_KEY no .env.local (ou SUPABASE_ENV_PATH).
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { resyncProjectCompareAssignments } from "@/lib/compare-assignment-sync";
import { loadEnv } from "../comentarios-relatorio/load-env";

/** Ressincroniza cada projeto, relata as mudanças e devolve o código de saída. */
export async function resyncProjects(
  client: SupabaseServerClient,
  projectIds: readonly string[],
  dryRun: boolean,
  log: (line: string) => void,
): Promise<number> {
  let code = 0;
  for (const id of projectIds) {
    try {
      // Um projeto por vez: cada um já lê o projeto inteiro em paralelo.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const { checked, changes } = await resyncProjectCompareAssignments(client, id, { dryRun });
      log(`projeto ${id}: ${checked} assignments, ${changes.length} mudança(s)${dryRun ? ", nada gravado" : ""}`);
      for (const c of changes) log(`  ${c.assignmentId} documento ${c.documentId}: ${c.from ?? "(nulo)"} -> ${c.to}`);
    } catch (e) {
      log(`projeto ${id}: falhou: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
  }
  return code;
}

/**
 * Lê `(--project <id> | --all) [--dry-run]`, ou `null` para uso inválido.
 * Argumento desconhecido invalida o uso: sem isso, `--dryrun` digitado errado
 * era ignorado e o script gravava em vez de simular.
 */
export function parseResyncArgs(argv: readonly string[]): { projectId?: string; dryRun: boolean } | null {
  let projectId: string | undefined;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      i += 1;
      const id = argv[i];
      if (projectId !== undefined || !id || id.startsWith("--")) return null;
      projectId = id;
    } else if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else return null;
  }
  return all === (projectId !== undefined) ? null : { projectId, dryRun };
}

async function main(argv: string[]): Promise<number> {
  const args = parseResyncArgs(argv);
  if (!args) {
    console.error("uso: npm run resync:compare -- (--project <id> | --all) [--dry-run]");
    return 2;
  }
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (frontend/.env.local ou SUPABASE_ENV_PATH).");
    return 2;
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  let projectIds = args.projectId ? [args.projectId] : [];
  if (!args.projectId) {
    const { data, error } = await client.from("projects").select("id");
    if (error) {
      console.error(`projects: ${error.message}`);
      return 1;
    }
    projectIds = (data ?? []).map((p) => p.id as string);
  }
  return resyncProjects(client, projectIds, args.dryRun, (line) => console.log(line));
}

// Só como script: o teste importa `resyncProjects` sem abrir conexão.
if (process.argv[1]?.endsWith("resync.ts")) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
