import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Varredura de arquivos dos testes estáticos (os gates textuais sobre o código
// de src/), numa fonte só: antes cada teste tinha a sua, e elas divergiam no que
// contavam como código de produção.

// Sem a barra final, como os `path.resolve` que os testes comparam com ele.
export const SRC_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Arquivos sob `root` cujo nome passa em `include`, sem descer em `skipDir`. */
export function listFiles(
  root: string,
  include: (name: string) => boolean,
  skipDir: (name: string) => boolean = () => false,
): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return skipDir(entry.name) ? [] : listFiles(absolute, include, skipDir);
    }
    return include(entry.name) ? [absolute] : [];
  });
}

const TEST_DIRS = new Set(["__tests__", "test-utils"]);

function isProductionSource(name: string): boolean {
  return (
    SOURCE_EXTENSIONS.includes(path.extname(name)) &&
    !name.includes(".test.") &&
    !name.includes(".spec.")
  );
}

/**
 * Código de produção sob `root` (padrão: src/): fontes JS/TS fora de
 * `__tests__` e `test-utils`, sem `*.test.*` e `*.spec.*`.
 */
export function productionSourceFiles(root: string = SRC_ROOT): string[] {
  return listFiles(root, isProductionSource, (name) => TEST_DIRS.has(name));
}
