import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// Uma tag só tem efeito se algum cache a produz (`unstable_cache` com `tags`,
// `cacheTag` dentro de "use cache" ou `fetch` com `next: { tags }`). Invalidar
// tag sem produtor é no-op que sugere uma garantia de frescor que não existe —
// foi o caso de `-members` e `-progress` (#668), que sobreviveram ao produtor
// (ou nunca tiveram um). Hoje o frontend não tem cache com tag nenhum: as
// leituras vão direto ao banco e as actions invalidam o Router Cache do cliente
// por `revalidatePath`. Este teste fixa esse estado; quem introduzir um cache
// com tag troca a regra por uma que case cada tag invalidada com seu produtor.

const SRC_ROOT = path.resolve(process.cwd(), "src");
const TAG_APIS = new Set([
  "unstable_cache",
  "cacheTag",
  "revalidateTag",
  "updateTag",
]);
// Só vale parsear o arquivo que pode conter um dos usos; o resto da árvore é
// lido como texto e descartado, para o teste caber no orçamento de CPU.
const MAY_USE_TAGS = /next\/cache|\btags\b/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

// Usos de API de tag: import de `next/cache` (pelo nome exportado, então um
// alias não escapa; import de namespace conta, porque esconde o nome) e a
// opção `next: { tags }` do fetch do Next.
function tagUses(source: ts.SourceFile): string[] {
  const uses: string[] = [];
  const at = (node: ts.Node, what: string) =>
    uses.push(
      `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`,
    );
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "next/cache"
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) at(node, "* as next/cache");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) {
          const imported = (spec.propertyName ?? spec.name).text;
          if (TAG_APIS.has(imported)) at(spec, imported);
        }
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "next" &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.initializer.properties.some(
        (p) => p.name !== undefined && propertyName(p.name) === "tags",
      )
    ) {
      at(node, "next: { tags }");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

function parseText(text: string): ts.SourceFile {
  return ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true);
}

describe("tags de cache", () => {
  let uses: string[];
  beforeAll(() => {
    uses = sourceFiles(SRC_ROOT).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      if (!MAY_USE_TAGS.test(text)) return [];
      const rel = path.relative(SRC_ROOT, file);
      return tagUses(parseText(text)).map((use) => `${rel}:${use}`);
    });
  });

  it("o frontend não produz nem invalida tag de cache", () => {
    expect(uses).toEqual([]);
  });

  it("o detector pega import com alias, namespace e fetch com tags", () => {
    expect(
      tagUses(
        parseText(`import { revalidatePath, revalidateTag as invalidate } from "next/cache";
import * as cache from "next/cache";
import { unstable_cache } from "next/cache";
fetch(url, { next: { tags: ["t"] } });
fetch(url, { next: { revalidate: 60 } });`),
      ),
    ).toEqual([
      "1 revalidateTag",
      "2 * as next/cache",
      "3 unstable_cache",
      "4 next: { tags }",
    ]);
  });
});
