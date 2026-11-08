/**
 * Cliente Supabase criado no servidor não pode ligar o auto-refresh de sessão.
 *
 * Fora do navegador, o `initialize()` que o construtor do auth-js dispara
 * termina iniciando um `setInterval` de 30 s (`startAutoRefresh`) que ninguém
 * para. O timer prende o cliente inteiro, com
 * o JWT do Clerk nos headers, e o GC nunca o coleta. Como o servidor cria um
 * cliente por chamada de `createSupabaseServer()`, cada navegação deixava dezenas
 * de clientes vivos: medido localmente, ~0,7 MB de heap por navegação, que em
 * produção encheu as Machines de 1 GB do frontend em dois dias de uso.
 *
 * O teste de comportamento roda o supabase-js real, para pegar também uma
 * atualização da biblioteca que mude o nome ou o efeito da opção. A varredura
 * estática cobre qualquer `createClient` novo fora das duas fábricas, inclusive
 * em módulo "use client", que também roda no SSR do servidor.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ getToken: async () => null }),
}));

const { createSupabaseServer } = await import("../server");
const { createSupabaseAdmin } = await import("../admin");

const SRC_ROOT = path.resolve(process.cwd(), "src");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function intervalsStartedOnInit(
  create: () => Promise<{ auth: { initialize: () => Promise<unknown> } }>,
): Promise<number> {
  const spy = vi.spyOn(globalThis, "setInterval");
  const client = await create();
  await client.auth.initialize();
  return spy.mock.calls.length;
}

describe("clientes Supabase do servidor não deixam timer vivo", () => {
  it("createSupabaseServer não inicia o auto-refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://exemplo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "chave-anon-ficticia");
    expect(await intervalsStartedOnInit(createSupabaseServer)).toBe(0);
  });

  it("createSupabaseAdmin não inicia o auto-refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://exemplo.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-servico-ficticia");
    expect(
      await intervalsStartedOnInit(async () => createSupabaseAdmin()),
    ).toBe(0);
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "test-utils") {
        files.push(...sourceFiles(absolute));
      }
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

function disablesAutoRefresh(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const auth = property(options, "auth");
  if (!auth || !ts.isObjectLiteralExpression(auth)) return false;
  const value = property(auth, "autoRefreshToken");
  return value?.kind === ts.SyntaxKind.FalseKeyword;
}

/** Nomes locais com que o módulo importa `createClient` do supabase-js. */
function createClientNames(source: ts.SourceFile): Set<string> {
  const specifiers = source.statements
    .filter(ts.isImportDeclaration)
    .filter((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === "@supabase/supabase-js")
    .flatMap((d) => {
      const named = d.importClause?.namedBindings;
      return named && ts.isNamedImports(named) ? [...named.elements] : [];
    });
  return new Set(
    specifiers
      .filter((e) => (e.propertyName ?? e.name).text === "createClient")
      .map((e) => e.name.text),
  );
}

/** Linhas de `createClient` do supabase-js sem `auth.autoRefreshToken: false`. */
function callsWithTimerOn(source: ts.SourceFile): number[] {
  const localNames = createClientNames(source);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text) &&
      !disablesAutoRefresh(node.arguments[2])
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function parseText(text: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("varredura: todo createClient do servidor desliga o auto-refresh", () => {
  it("acusa chamada sem opções, com alias e com autoRefreshToken ligado", () => {
    expect(
      callsWithTimerOn(
        parseText(`import { createClient as cc } from "@supabase/supabase-js";
cc(u, k);
cc(u, k, { global: {} });
cc(u, k, { auth: { autoRefreshToken: true } });
cc(u, k, { auth: { autoRefreshToken: false, persistSession: false } });`),
      ),
    ).toEqual([2, 3, 4]);
  });

  it("nenhum módulo em src cria cliente com o timer ligado", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes("@supabase/supabase-js")) continue;
      for (const line of callsWithTimerOn(parseText(text))) {
        violations.push(`${path.relative(SRC_ROOT, file)}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
