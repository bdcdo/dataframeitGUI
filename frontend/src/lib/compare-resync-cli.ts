// A lógica do script `scripts/compare-assignments/resync.ts`, aqui para o
// Vitest alcançar (ele só coleta `src/**`). O script só carrega o ambiente,
// cria o client de service role e chama `runResync`.
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { resyncProjectCompareAssignments } from "@/lib/compare-assignment-sync";

const RESYNC_USAGE =
  "uso: npm run resync:compare -- (--project <id> [--project <id> ...] | --all) [--dry-run]";

interface ResyncArgs {
  projectIds: string[];
  all: boolean;
  dryRun: boolean;
}

function parseResyncArgs(argv: readonly string[]): ResyncArgs | null {
  const args: ResyncArgs = { projectIds: [], all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--project" && argv[i + 1] && !argv[i + 1].startsWith("--")) args.projectIds.push(argv[++i]);
    else return null;
  }
  // Um alvo, e só um: projeto(s) nomeado(s) ou todos.
  return args.all === (args.projectIds.length > 0) ? null : args;
}

type ProjectRef = { id: string; name: string | null };

// `null`: a leitura da lista de projetos falhou (já relatada).
async function resolveProjects(
  client: SupabaseServerClient,
  args: ResyncArgs,
  log: (line: string) => void,
): Promise<ProjectRef[] | null> {
  if (!args.all) return args.projectIds.map((id) => ({ id, name: null }));
  const { data, error } = await client.from("projects").select("id, name");
  if (error) {
    log(`projects: ${error.message}`);
    return null;
  }
  return (data ?? []) as ProjectRef[];
}

// `true` quando o projeto foi ressincronizado (ou simulado) sem erro.
async function resyncOne(
  client: SupabaseServerClient,
  project: ProjectRef,
  dryRun: boolean,
  log: (line: string) => void,
): Promise<boolean> {
  const label = `projeto ${project.id}${project.name ? ` (${project.name})` : ""}`;
  try {
    const report = await resyncProjectCompareAssignments(client, project.id, { dryRun });
    const mode = dryRun ? "simulação, nada gravado" : "gravado";
    log(`${label}: ${report.checked} assignments, ${report.changes.length} mudança(s), ${mode}`);
    for (const change of report.changes) {
      log(`  ${change.assignmentId} documento ${change.documentId} revisor ${change.userId}: ${change.from ?? "(nulo)"} -> ${change.to}`);
    }
    return true;
  } catch (e) {
    log(`${label}: falhou: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Ressincroniza os assignments de comparação dos projetos pedidos e relata
 * cada mudança. Devolve o código de saída: 0 sucesso, 1 falha de leitura ou
 * gravação, 2 argumentos inválidos (nada é lido nem gravado).
 */
export async function runResync({ client, argv, log }: {
  client: SupabaseServerClient;
  argv: readonly string[];
  log: (line: string) => void;
}): Promise<number> {
  const args = parseResyncArgs(argv);
  if (!args) {
    log(RESYNC_USAGE);
    return 2;
  }
  const projects = await resolveProjects(client, args, log);
  if (!projects) return 1;

  let failed = false;
  for (const project of projects) {
    // Um projeto por vez: cada um já lê o projeto inteiro em paralelo.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    if (!(await resyncOne(client, project, args.dryRun, log))) failed = true;
  }
  return failed ? 1 : 0;
}
