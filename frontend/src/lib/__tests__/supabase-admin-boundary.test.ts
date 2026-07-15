import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const mockedCreateClient = vi.hoisted(() => vi.fn(() => ({ client: true })));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mockedCreateClient }));

const SRC_ROOT = path.resolve(process.cwd(), "src");
const FRONTEND_ROOT = path.resolve(process.cwd());
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const ADMIN_FILE = path.join(SRC_ROOT, "lib/supabase/admin.ts");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SECURITY_TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".bash",
  ".env",
  ".py",
  ".sh",
  ".toml",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".sql",
  ".zsh",
]);
const GENERATED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const EXPECTED_RUNTIME_IMPORTERS = [
  "actions/field-reviews.ts",
  "actions/members.ts",
  "app/(app)/projects/[id]/analyze/assignments/page.tsx",
  "app/api/webhooks/clerk/route.ts",
  "lib/auth.ts",
  "lib/auto-comparison.ts",
  "lib/auto-review.ts",
  "lib/clerk-sync.ts",
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "test-utils") {
        files.push(...sourceFiles(absolute));
      }
      continue;
    }
    if (
      SOURCE_EXTENSIONS.includes(path.extname(entry.name))
      && !entry.name.includes(".test.")
      && !entry.name.includes(".spec.")
    ) {
      files.push(absolute);
    }
  }
  return files;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function parseText(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function hasDirective(source: ts.SourceFile, directive: "use client" | "use server"): boolean {
  for (const statement of source.statements) {
    if (
      !ts.isExpressionStatement(statement)
      || !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function isClientModule(source: ts.SourceFile): boolean {
  return hasDirective(source, "use client");
}

function isServerActionModule(source: ts.SourceFile): boolean {
  return hasDirective(source, "use server");
}

function hasSideEffectImport(source: ts.SourceFile, specifier: string): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement)
      && statement.importClause === undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === specifier,
  );
}

function staticConcatenationSpecifier(node: ts.BinaryExpression): string | null {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  const left = staticSpecifier(node.left);
  const right = staticSpecifier(node.right);
  return left === null || right === null ? null : left + right;
}

function staticTemplateSpecifier(node: ts.TemplateExpression): string | null {
  let value = node.head.text;
  for (const span of node.templateSpans) {
    const expression = staticSpecifier(span.expression);
    if (expression === null) return null;
    value += expression + span.literal.text;
  }
  return value;
}

function staticSpecifier(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticSpecifier(node.expression);
  }
  if (ts.isBinaryExpression(node)) return staticConcatenationSpecifier(node);
  if (ts.isTemplateExpression(node)) return staticTemplateSpecifier(node);
  return null;
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
    return true;
  }
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function importDeclarationSpecifier(
  statement: ts.ImportDeclaration,
): string | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return null;
  return importClauseHasRuntimeValue(statement.importClause)
    ? statement.moduleSpecifier.text
    : null;
}

function exportDeclarationSpecifier(
  statement: ts.ExportDeclaration,
): string | null {
  if (statement.isTypeOnly || !statement.moduleSpecifier) return null;
  return ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
}

function importEqualsSpecifier(
  statement: ts.ImportEqualsDeclaration,
): string | null {
  if (!ts.isExternalModuleReference(statement.moduleReference)) return null;
  return staticSpecifier(statement.moduleReference.expression);
}

function runtimeDeclarationSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement)) {
    return importDeclarationSpecifier(statement);
  }
  if (ts.isExportDeclaration(statement)) {
    return exportDeclarationSpecifier(statement);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return importEqualsSpecifier(statement);
  }
  return null;
}

function isRuntimeLoadCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isIdentifier(node.expression) && node.expression.text === "require";
  return isDynamicImport || isRequire;
}

function runtimeLoadSpecifier(
  node: ts.Node,
  source: ts.SourceFile,
): string | null {
  if (!isRuntimeLoadCall(node)) return null;
  const specifier = staticSpecifier(node.arguments[0]);
  if (specifier) return specifier;
  throw new Error(
    `Carga runtime não-estática em ${source.fileName}: ${node.getText(source)}`,
  );
}

function presentSpecifier(specifier: string | null): string[] {
  return specifier ? [specifier] : [];
}

function runtimeLoadSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    specifiers.push(...presentSpecifier(runtimeLoadSpecifier(node, source)));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function runtimeImportSpecifiers(source: ts.SourceFile): string[] {
  const declarations = source.statements.flatMap((statement) =>
    presentSpecifier(runtimeDeclarationSpecifier(statement)),
  );
  return [...declarations, ...runtimeLoadSpecifiers(source)];
}

function resolveInternalImport(importer: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function importGraph(files: string[]): Map<string, string[]> {
  return new Map(
    files.map((file) => [
      file,
      runtimeImportSpecifiers(parse(file)).flatMap((specifier) => {
        const resolved = resolveInternalImport(file, specifier);
        return resolved ? [resolved] : [];
      }),
    ]),
  );
}

function pathToTarget(
  graph: Map<string, string[]>,
  start: string,
  target: string,
): string[] | null {
  const queue: string[][] = [[start]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    const current = currentPath.at(-1)!;
    if (current === target) return currentPath;
    if (visited.has(current)) continue;
    visited.add(current);
    // Importar uma Server Action em um Client Component cria um proxy de rede;
    // o corpo e suas dependências não entram no bundle do navegador.
    if (current !== start && isServerActionModule(parse(current))) continue;
    for (const dependency of graph.get(current) ?? []) {
      queue.push([...currentPath, dependency]);
    }
  }
  return null;
}

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

function isVersionableEnvTemplate(name: string): boolean {
  return (
    name.startsWith(".env")
    && [".example", ".sample", ".template"].some((suffix) =>
      name.endsWith(suffix),
    )
  );
}

function shouldScanSecurityFile(name: string): boolean {
  // Nunca ler arquivos locais de secrets. Exemplos/templates versionáveis
  // continuam cobertos, assim como scripts e configs sem extensão.
  if (name.startsWith(".env")) return isVersionableEnvTemplate(name);
  return (
    name.startsWith("Dockerfile")
    || name === "Makefile"
    || name === "Procfile"
    || SECURITY_TEXT_EXTENSIONS.has(path.extname(name))
  );
}

function securityTextEntryFiles(dir: string, entry: fs.Dirent): string[] {
  const absolute = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    return GENERATED_DIRECTORIES.has(entry.name)
      ? []
      : securityTextFiles(absolute);
  }
  return shouldScanSecurityFile(entry.name) ? [absolute] : [];
}

function securityTextFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => securityTextEntryFiles(dir, entry));
}

function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function countAdminFactoryCalls(files: string[]): number {
  let count = 0;
  for (const file of files) {
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "createSupabaseAdmin"
      ) {
        count += 1;
      }
      ts.forEachChild(node, visit);
    }
    visit(parse(file));
  }
  return count;
}

function publicSecretNames(source: string): string[] {
  const forbiddenPublicSecret = new RegExp(
    [
      "NEXT_PUBLIC_",
      "[A-Z0-9_]*",
      "(?:SERVICE_ROLE|SERVICE_KEY|ADMIN_KEY|SECRET)",
      "[A-Z0-9_]*",
    ].join(""),
    "gi",
  );
  return source.match(forbiddenPublicSecret) ?? [];
}

describe("fronteira do Supabase admin client", () => {
  const files = sourceFiles(SRC_ROOT);
  const graph = importGraph(files);

  it("mantém um import compilável de server-only", () => {
    expect(hasSideEffectImport(parse(ADMIN_FILE), "server-only")).toBe(true);
  });

  it("falha em runtime antes de criar client quando URL ou secret faltam", async () => {
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createSupabaseAdmin } = await import("@/lib/supabase/admin");

    try {
      mockedCreateClient.mockClear();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(() => createSupabaseAdmin()).toThrow(
        "Supabase admin client requires",
      );

      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
      expect(() => createSupabaseAdmin()).toThrow(
        "Supabase admin client requires",
      );
      expect(mockedCreateClient).not.toHaveBeenCalled();
    } finally {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }
  });

  it("só reconhece use client/use server no directive prologue", () => {
    expect(isClientModule(parseText('"use strict"; "use client"; export {};'))).toBe(true);
    expect(isClientModule(parseText('const value = 1; "use client";'))).toBe(false);
    expect(isServerActionModule(parseText('"use server"; export {};'))).toBe(true);
    expect(isServerActionModule(parseText('export {}; "use server";'))).toBe(false);
  });

  it("inclui require, import equals e import() literais no grafo runtime", () => {
    const specifiers = runtimeImportSpecifiers(parseText(`
      import legacy = require("@/legacy");
      const admin = require("@/lib/supabase/admin");
      const lazy = import(\`@/lazy\`);
      import type { Safe } from "@/safe-type";
    `));
    expect(specifiers).toEqual([
      "@/legacy",
      "@/lib/supabase/admin",
      "@/lazy",
    ]);
  });

  it("resolve import() com options e expressões de texto constantes", () => {
    const specifiers = runtimeImportSpecifiers(parseText(`
      const withOptions = import("@/lib/" + "supabase/admin", { with: { type: "json" } });
      const template = import(\`@/lib/\${"supabase"}/admin\`);
    `));
    expect(specifiers).toEqual([
      "@/lib/supabase/admin",
      "@/lib/supabase/admin",
    ]);
  });

  it("falha fechado quando import()/require() não pode ser resolvido", () => {
    expect(() =>
      runtimeImportSpecifiers(parseText(`
        const moduleName = getModuleName();
        const lazy = import(moduleName);
      `)),
    ).toThrow("Carga runtime não-estática");
  });

  it("não permite caminho de import runtime partindo de use client", () => {
    const leaks = files.flatMap((file) => {
      if (!isClientModule(parse(file))) return [];
      const found = pathToTarget(graph, file, ADMIN_FILE);
      return found ? [found.map(relative).join(" -> ")] : [];
    });
    expect(leaks).toEqual([]);
  });

  it("mantém o inventário de importadores runtime explícito", () => {
    const importers = files
      .filter((file) => graph.get(file)?.includes(ADMIN_FILE))
      .map(relative)
      .toSorted();
    expect(importers).toEqual(EXPECTED_RUNTIME_IMPORTERS);
    const atomicMemberRemoval = fs
      .readFileSync(path.join(SRC_ROOT, "actions/members.ts"), "utf8")
      .includes('rpc("remove_project_member"');
    expect(countAdminFactoryCalls(files)).toBe(atomicMemberRemoval ? 18 : 19);
  });

  it("não aceita nenhum nome público com marcador de secret", () => {
    const scannedFiles = securityTextFiles(REPO_ROOT);
    const violations = scannedFiles.flatMap((file) => {
      const matches = publicSecretNames(fs.readFileSync(file, "utf8"));
      return matches.map((name) => `${repoRelative(file)}: ${name}`);
    });

    expect(violations).toEqual([]);
    expect(scannedFiles).toContain(path.join(REPO_ROOT, "backend/.env.example"));
    const unsafeName = [
      "NEXT",
      "PUBLIC",
      "supabase",
      "service",
      "role",
      "key",
    ].join("_");
    expect(publicSecretNames(unsafeName)).toEqual([unsafeName]);
  });

  it("mantém a leitura do secret do runtime Next em um único módulo", () => {
    const secretName = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
    const secretReaders = files.filter((file) => fs.readFileSync(file, "utf8").includes(secretName));

    expect(secretReaders.map(relative)).toEqual(["lib/supabase/admin.ts"]);
  });
});
