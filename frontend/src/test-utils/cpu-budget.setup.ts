// Registrado em setupFiles no vitest.config.ts. O beforeEach daqui roda antes
// dos do arquivo e o afterEach depois (ordem de pilha, o padrão do Vitest),
// então a conta inclui os hooks por teste: o trabalho que cada teste traz
// consigo, e que também roda sob a mesma disputa de CPU.
import { afterEach, beforeEach } from "vitest";
import { createCpuBudgetHooks } from "@/test-utils/cpu-budget";

// Exportado para que o teste do orçamento confira, de dentro de um teste, que
// a medição está ligada.
export const cpuBudgetHooks = createCpuBudgetHooks();
beforeEach(cpuBudgetHooks.before);
afterEach(cpuBudgetHooks.after);
