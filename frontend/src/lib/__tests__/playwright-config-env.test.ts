import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("@playwright/test", () => ({ defineConfig: (config: unknown) => config, devices: { "Desktop Chrome": {} } }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) => {
      const name = String(path);
      state.reads.push(name);
      if (name.endsWith("/.env.local")) return "E2E_PROJECT_ID=local\n";
      if (name.endsWith("/.env.e2e")) return "E2E_PROJECT_ID=canonical\n";
      if (name === "/runtime/isolated.env") return "E2E_PROJECT_ID=isolated\n";
      if (name === "/runtime/missing.env") throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      return options === undefined ? fs.readFileSync(path) : fs.readFileSync(path, options);
    },
  };
});

let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  state.reads.length = 0;
  process.env.PLAYWRIGHT_PRE_PUSH = "";
  process.env.E2E_ENV_PATH = "";
  vi.resetModules();
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

describe("fonte de ambiente do Playwright", () => {
  it("mantém o arquivo canônico por padrão", async () => {
    await import("../../../playwright.config");
    expect(process.env.E2E_PROJECT_ID).toBe("canonical");
    expect(state.reads.some((path) => path.endsWith("/.env.e2e"))).toBe(true);
  });
  it("um arquivo explícito permite fixtures locais sem alterar os symlinks", async () => {
    process.env.E2E_ENV_PATH = "/runtime/isolated.env";
    await import("../../../playwright.config");
    expect(process.env.E2E_PROJECT_ID).toBe("isolated");
    expect(state.reads).toContain("/runtime/isolated.env");
    expect(state.reads.some((path) => path.endsWith("/.env.e2e"))).toBe(false);
  });
  it("arquivo explícito ausente falha em vez de usar outra configuração", async () => {
    process.env.E2E_ENV_PATH = "/runtime/missing.env";
    await expect(import("../../../playwright.config")).rejects.toThrow("fixture missing");
  });
});
