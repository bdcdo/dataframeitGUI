import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// Uma tag só tem efeito se algum cache a produz (`unstable_cache` com `tags`,
// ou `cacheTag` dentro de "use cache"). Invalidar tag sem produtor é no-op que
// sugere uma garantia de frescor que não existe — foi o caso de `-members` e
// `-progress` (#668), que sobreviveram ao produtor (ou nunca tiveram um).
// Enquanto o frontend não tiver produtor nenhum, nenhuma chamada de
// revalidateTag/updateTag pode existir; quem criar um cache com tag reavalia
// esta regra junto.

const SRC_ROOT = path.resolve(process.cwd(), "src");
const PRODUCERS = new Set(["unstable_cache", "cacheTag"]);
const INVALIDATORS = new Set(["revalidateTag", "updateTag"]);
// Só vale parsear o arquivo que cita algum dos nomes; o resto da árvore é
// lido como texto e descartado, para o teste caber no orçamento de CPU.
const MENTIONS = new RegExp(`\\b(${[...PRODUCERS, ...INVALIDATORS].join("|")})\\b`);

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

function calledName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function collectCalls(): { producers: string[]; invalidators: string[] } {
  const producers: string[] = [];
  const invalidators: string[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    if (!MENTIONS.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calledName(node);
        const where = `${path.relative(SRC_ROOT, file)}:${
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        } ${name}`;
        if (name && PRODUCERS.has(name)) producers.push(where);
        if (name && INVALIDATORS.has(name)) invalidators.push(where);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { producers, invalidators };
}

describe("tags de cache", () => {
  let calls: ReturnType<typeof collectCalls>;
  beforeAll(() => {
    calls = collectCalls();
  });

  it("nenhuma tag é invalidada sem que exista um produtor", () => {
    const { producers, invalidators } = calls;
    if (producers.length === 0) expect(invalidators).toEqual([]);
  });
});
