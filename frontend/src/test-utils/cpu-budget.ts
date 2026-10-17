// Orçamento de CPU por teste. Um teste que estoura o timeout de 5 s só com a
// suíte disputando a CPU tem defeito no próprio teste, e o sintoma aparecia só
// em máquina carregada, longe de quem escreveu o teste. O tempo de CPU do
// teste quase não muda com a carga: entre uma rodada da suíte com cota de 200%
// de CPU e uma sem cota, a razão por teste ficou com mediana 1,01 e p95 1,17. O
// tempo de parede, sim: na rodada em 200% ele ficou entre 8 e 13 vezes a CPU
// (p10 e p90). O orçamento transforma o estouro intermitente sob carga numa
// falha determinística.
//
// A medida é a CPU da thread que roda o teste, e não a do processo, porque no
// pool de threads do Vitest o processo soma todos os workers, e porque as
// threads de GC do V8 variam de uma rodada para outra.
//
// O número vale para a suíte inteira, que é como o pre-push roda: com todos os
// workers ocupados, cada thread divide o núcleo físico com a vizinha de
// hyperthreading e o processador baixa o clock, e o mesmo teste gasta de duas
// a três vezes a CPU que gasta rodando sozinho. Um arquivo que passa isolado
// pode reprovar na suíte completa; para reproduzir, rodar `npm test`.
//
// A medição, os limiares e o que fazer quando o orçamento estoura estão em
// docs/CODE_QUALITY_TOOLING.md, seção "Orçamento de CPU por teste".

// Folga sobre o alvo de 300 ms: entre duas rodadas da suíte, a CPU do mesmo
// teste variou até 1,32 vez no p95, e 450 ms deixam o teste de 300 ms longe do
// limiar. Com a suíte em 200% de CPU, 450 ms de CPU dão de 3,6 a 6 s de
// parede, e acima disso o teste estoura os 5 s em boa parte das rodadas.
export const TEST_CPU_BUDGET_MS = 450;

type ThreadCpuUsage = (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;

export function cpuBudgetMessage(spentMs: number, budgetMs = TEST_CPU_BUDGET_MS): string | null {
  if (spentMs <= budgetMs) return null;
  return (
    `o teste gastou ${Math.round(spentMs)} ms de CPU, acima do orçamento de ${budgetMs} ms. ` +
    "Com a suíte disputando a CPU, o tempo de parede chega a 8 a 13 vezes a CPU e o teste " +
    "estoura o timeout de 5 s. Reduza o trabalho do teste em vez de subir o orçamento: veja " +
    'docs/CODE_QUALITY_TOOLING.md, seção "Orçamento de CPU por teste".'
  );
}

// `read` é injetável para que o teste do orçamento simule leituras sem
// queimar CPU de verdade.
export function createCpuBudgetHooks(
  read: ThreadCpuUsage = process.threadCpuUsage.bind(process),
  budgetMs = TEST_CPU_BUDGET_MS,
) {
  let start: NodeJS.CpuUsage | null = null;
  return {
    before() {
      start = read();
    },
    after() {
      if (start === null) return;
      const spent = read(start);
      start = null;
      const message = cpuBudgetMessage((spent.user + spent.system) / 1000, budgetMs);
      if (message) throw new Error(message);
    },
  };
}
