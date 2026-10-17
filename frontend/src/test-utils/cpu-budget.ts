// Orçamento de CPU por teste. Um teste que estoura o timeout de 5 s só com a
// suíte disputando a CPU tem defeito no próprio teste, e o sintoma aparecia só
// em máquina carregada, longe de quem escreveu o teste. O tempo de CPU do
// teste quase não muda com a carga: entre uma rodada da suíte com cota de 200%
// de CPU e uma sem cota, a razão por teste ficou com mediana 1,01 e p95 1,17. O
// tempo de parede, sim: na rodada em 200% ele ficou entre 8 e 13 vezes a CPU
// (p10 e p90). O orçamento transforma o estouro intermitente sob carga numa
// falha determinística.
//
// A medida é a CPU da thread que roda o teste, e não a do processo: as threads
// de GC e de compilação do V8 entram na CPU do processo e variam de uma rodada
// para outra, e no pool de threads do Vitest (a suíte usa o de forks) o
// processo somaria todos os workers.
//
// O orçamento não é determinístico como uma asserção: a CPU do mesmo teste na
// suíte completa sobe com a disputa da máquina. Ele reprova o teste que já
// nasce pesado e deixa folga para a variação entre rodadas; o teste perto do
// limite aparece na medição descrita na doc antes de reprovar aqui. O trabalho
// feito em beforeAll fica fora da conta, de propósito, para o aquecimento.
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

// O que o hook precisa do contexto do Vitest: o estado do teste que mediu por
// último, para distinguir sobreposição de um afterEach que não chegou a rodar.
type BudgetContext = { task: { result?: { state?: string } } };

// `read` é injetável para que o teste do orçamento simule leituras sem
// queimar CPU de verdade.
export function createCpuBudgetHooks(
  read: ThreadCpuUsage = process.threadCpuUsage.bind(process),
  budgetMs = TEST_CPU_BUDGET_MS,
) {
  let start: NodeJS.CpuUsage | null = null;
  let measured: BudgetContext["task"] | null = null;
  return {
    // Com testes concorrentes no mesmo arquivo, a CPU da thread de um somaria a
    // do outro e o orçamento cobraria o teste errado. A sobreposição é um
    // segundo beforeEach enquanto o teste medido ainda roda. A leitura inicial
    // que sobra sem o teste rodando é outra coisa: quando um afterEach do
    // arquivo lança, o Vitest pula os seguintes, e este, registrado primeiro
    // no setupFiles, é o último; aí a leitura velha só é descartada.
    before(context?: BudgetContext) {
      if (start !== null && measured?.result?.state === "run") {
        start = null;
        measured = null;
        throw new Error(
          "o orçamento de CPU por teste não mede testes concorrentes: rode este arquivo sem .concurrent",
        );
      }
      measured = context?.task ?? null;
      start = read();
    },
    isMeasuring() {
      return start !== null;
    },
    after() {
      if (start === null) return;
      const spent = read(start);
      start = null;
      measured = null;
      const message = cpuBudgetMessage((spent.user + spent.system) / 1000, budgetMs);
      if (message) throw new Error(message);
    },
  };
}
