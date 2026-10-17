import path from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../../vitest.config";
import { TEST_CPU_BUDGET_MS, cpuBudgetMessage, createCpuBudgetHooks } from "@/test-utils/cpu-budget";

// Leitor de CPU falso: cada chamada sem argumento devolve o instante atual, e a
// chamada com o instante anterior devolve a diferença, como o
// process.threadCpuUsage(previous) de verdade. Metade de cada leitura é tempo
// de sistema, para que a conta que esquecesse um dos dois saísse errada.
function fakeReader(readingsUs: number[]) {
  let i = 0;
  const split = (us: number): NodeJS.CpuUsage => ({ user: us / 2, system: us / 2 });
  return (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => {
    const now = readingsUs[i++];
    return split(previous ? now - previous.user - previous.system : now);
  };
}

describe("orçamento de CPU por teste", () => {
  it("aceita o teste no limite e reprova o que passa dele", () => {
    expect(cpuBudgetMessage(TEST_CPU_BUDGET_MS)).toBeNull();
    expect(cpuBudgetMessage(TEST_CPU_BUDGET_MS + 1)).toMatch(/acima do orçamento de 450 ms/);
  });

  it("mede do beforeEach ao afterEach, somando usuário e sistema", () => {
    const hooks = createCpuBudgetHooks(fakeReader([1_000_000, 1_451_000]));
    hooks.before();
    expect(() => hooks.after()).toThrow(/gastou 451 ms de CPU/);

    const withinBudget = createCpuBudgetHooks(fakeReader([1_000_000, 1_450_000]));
    withinBudget.before();
    expect(() => withinBudget.after()).not.toThrow();
  });

  // Um afterEach sem o beforeEach correspondente (teste pulado no meio, hook
  // anterior que lançou) não pode cobrar a CPU acumulada desde o teste anterior.
  it("não cobra nada sem a leitura inicial do próprio teste", () => {
    const hooks = createCpuBudgetHooks(fakeReader([1_000_000, 1_100_000, 9_000_000]));
    hooks.before();
    hooks.after();
    expect(() => hooks.after()).not.toThrow();
  });

  it("vale para toda a suíte, pelo setupFiles da config", () => {
    const setupFiles = [config.test?.setupFiles ?? []].flat();
    expect(setupFiles.map((file) => path.basename(String(file)))).toContain("cpu-budget.setup.ts");
  });
});
