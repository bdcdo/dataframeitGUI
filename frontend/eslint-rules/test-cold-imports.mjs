// Num arquivo de teste, o primeiro `import()` de um módulo paga a transformação
// e a avaliação do grafo inteiro dele, centenas de milissegundos com a máquina
// livre e vários segundos com a suíte disputando a CPU. Se esse import roda
// dentro de um teste, o custo conta contra o timeout daquele teste, e qual teste
// paga depende da ordem de execução. Com o timeout estourado, o Vitest não
// cancela o corpo do teste, e as chamadas que ele dispara depois contaminam o
// teste seguinte.
//
// A regra exige que todo `import()` feito em tempo de teste tenha o mesmo
// especificador já carregado antes dos testes: por um import estático, por um
// `import()` no topo do módulo (top-level await, que roda na coleta) ou por um
// `beforeAll` no topo do módulo, que tem prazo próprio. O `beforeAll` precisa
// estar no topo porque um hook dentro de um `describe` não roda antes dos
// testes de outro `describe`.
//
// Cada forma de carga só conta quando de fato carrega o módulo antes dos testes:
// - o import estático precisa de um binding usado como valor, ou de não ter
//   binding nenhum (`import "x"`). O transformador de TypeScript do Vitest
//   descarta o import cujos bindings não aparecem em posição de valor, porque
//   não distingue binding não usado de binding só de tipo, e então o módulo
//   não é carregado;
// - o `import()` de carga precisa ser aguardado (await, return, corpo de arrow
//   ou elemento de `Promise.all` aguardado): sem isso o hook ou a coleta
//   terminam antes do módulo;
// - no `beforeAll`, o `import()` precisa estar no corpo do próprio callback, e
//   não numa função declarada ali dentro, que só roda se alguém a chamar.
//
// A comparação é pelo texto do especificador: `"@/actions/x"` e `"../x"` são o
// mesmo módulo para o Vitest, mas a regra não resolve caminhos e pede o mesmo
// texto nos dois lugares. Especificador que não é literal não tem como ser
// conferido e é reprovado.
//
// Fica de fora o `import()` dentro da fábrica de `vi.mock`/`vi.doMock`: a
// fábrica roda quando o módulo mockado é importado, e esse import é o que a
// regra confere.
//
// O mesmo vale para o `import()` que o próprio módulo testado faz quando roda,
// como o `(await import("exceljs")).default` de um botão de download (#858):
// o primeiro clique do teste paga a carga. Para cada import estático local do
// teste (`@/...` ou relativo) que carrega o módulo, a regra lê o arquivo e
// cobra cada `import()` de dentro de função dele como se estivesse no teste,
// com uma folga a mais: conta como carregado o especificador que o teste
// mocka com fábrica (`vi.mock("exceljs", () => ...)`), porque a fábrica não
// carrega o módulo real. O `import()` passado a uma função importada de um
// módulo que o teste mocka com fábrica, como o `dynamic(() => import("x"))`
// com `vi.mock("next/dynamic", ...)`, não roda e fica de fora, assim como o
// módulo testado que o próprio teste mocka com fábrica. A comparação resolve
// os caminhos locais dos dois lados; o especificador de pacote é comparado
// pelo texto. Só o primeiro nível é lido: o `import()` de um módulo que o
// testado importa não é visto. E a regra não sabe se algum teste aciona o
// caminho do `import()`; quando nenhum aciona, o mock com fábrica resolve sem
// custo e falha alto se um teste novo passar a acionar o caminho.
//
// A análise é sintática e tem limites conhecidos, nenhum com instância na
// suíte quando a regra entrou: aceita como carga um `import()` que nunca roda
// (atrás de `if (false)` ou de um `return` anterior, ou num `beforeAll` local
// que sombreia o do Vitest); não confere o prazo do hook (sem prazo, vale o
// hookTimeout de 10 s); não vê `vi.importActual()` nem `require()` em teste; e,
// num arquivo com `vi.resetModules()`, o aquecimento não evita que cada teste
// reavalie o módulo (medido, o maior desses testes levou 0,3 s com 15% de um
// núcleo).

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tseslint from "typescript-eslint";

const RULE_NAME = "warm-dynamic-imports";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
// Os helpers de teste ficam de fora: o `import()` deles é aquecimento
// chamado num beforeAll, como o de `warmUpJsdom`.
const TEST_UTILS_ROOT = path.join(SRC_ROOT, "test-utils") + path.sep;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_SUFFIXES = [
  "",
  ...EXTENSIONS,
  ...EXTENSIONS.map((extension) => `/index${extension}`),
];
// Só módulos de código são lidos: um `import x from "./casos.json"` resolve
// para um arquivo que o parser de TypeScript não lê.
const CODE_FILE = /\.(?:[mc]?[jt]s|[jt]sx)$/;

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const MOCK_FACTORY_METHODS = new Set(["mock", "doMock"]);

function literalSpecifier(node) {
  return literalString(node.source);
}

// O texto de um literal de string ou de um template sem `${}`, ou null.
function literalString(source) {
  if (source.type === "Literal" && typeof source.value === "string") {
    return source.value;
  }
  if (
    source.type === "TemplateLiteral" &&
    source.expressions.length === 0 &&
    source.quasis.length === 1
  ) {
    return source.quasis[0].value.cooked;
  }
  return null;
}

function isCallTo(node, name) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === name
  );
}

function isMockFactoryCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "vi" &&
    node.callee.property.type === "Identifier" &&
    MOCK_FACTORY_METHODS.has(node.callee.property.name)
  );
}

function isTopLevelStatement(node) {
  return node?.parent?.type === "Program";
}

// Classifica o momento em que o `import()` roda, subindo pelos ancestrais:
// "collection" (fora de qualquer função), "warm-up" (no corpo do callback de um
// beforeAll do topo do módulo), "hook" (em qualquer outro ponto dentro de um
// beforeAll: tem prazo próprio, mas não roda antes de todos os testes ou nem
// roda), "mock-factory" (dentro da fábrica de vi.mock) ou "test".
function enclosingFunctions(node) {
  const functions = [];
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTION_TYPES.has(current.type)) functions.push(current);
  }
  return functions;
}

// A chamada de que a função é argumento, como o `beforeAll(fn)` ou o
// `vi.mock("x", fn)`, ou null quando ela não é argumento de chamada.
function callTaking(fn) {
  const call = fn.parent;
  return call?.type === "CallExpression" && call.arguments.includes(fn)
    ? call
    : null;
}

function hookTiming(call, fn, nearestFunction) {
  if (isMockFactoryCall(call)) return "mock-factory";
  if (!isCallTo(call, "beforeAll")) return null;
  const warmUp = fn === nearestFunction && isTopLevelStatement(call.parent);
  return warmUp ? "warm-up" : "hook";
}

function importTiming(node) {
  const functions = enclosingFunctions(node);
  for (const fn of functions) {
    const call = callTaking(fn);
    const timing = call && hookTiming(call, fn, functions[0]);
    if (timing) return timing;
  }
  return functions.length > 0 ? "test" : "collection";
}

function isPromiseAll(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Promise" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "all"
  );
}

// O nó que recebe o valor do `import()`: o próprio import, ou o Promise.all de
// cujo array ele é elemento.
function promiseHolder(node) {
  const array = node.parent;
  if (array?.type !== "ArrayExpression") return node;
  const call = array.parent;
  return isPromiseAll(call) && call.arguments[0] === array ? call : node;
}

const AWAITING_PARENTS = new Set(["AwaitExpression", "ReturnStatement"]);

// O valor do `import()` é esperado por quem o contém: aguardado, devolvido (o
// hook espera a promise devolvida) ou corpo de uma arrow function.
function isAwaited(node) {
  const holder = promiseHolder(node);
  const parent = holder.parent;
  if (AWAITING_PARENTS.has(parent?.type)) return true;
  return parent?.type === "ArrowFunctionExpression" && parent.body === holder;
}

// `typeof x` em posição de tipo nomeia um valor, e o scope manager a marca como
// referência de valor; o TypeScript a apaga com os demais tipos, e o import que
// só é usado assim também é descartado.
function insideTypeQuery(identifier) {
  for (let current = identifier.parent; current; current = current.parent) {
    if (current.type === "TSTypeQuery") return true;
  }
  return false;
}

// Um import estático carrega o módulo se não declara binding (import de efeito
// colateral) ou se algum binding de valor é lido como valor. As referências vêm
// do scope manager do typescript-eslint, que separa uso como tipo de uso como
// valor.
function staticImportLoads(context, node) {
  if (node.importKind === "type") return false;
  if (node.specifiers.length === 0) return true;
  return context.sourceCode.getDeclaredVariables(node).some((variable) => {
    const definition = variable.defs[0]?.node;
    if (definition?.importKind === "type") return false;
    return variable.references.some(
      (reference) =>
        reference.isValueReference && !insideTypeQuery(reference.identifier),
    );
  });
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("@/");
}

// Caminho do arquivo de um especificador local, como o Vitest o resolve
// (alias `@/` para src/), ou null quando não há arquivo.
const resolveCache = new Map();

function resolveLocal(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? path.join(SRC_ROOT, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  if (!resolveCache.has(base)) {
    const file = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find(
      (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile(),
    );
    resolveCache.set(base, file ?? null);
  }
  return resolveCache.get(base);
}

// Identidade do módulo para comparar os dois lados: o arquivo, quando o
// especificador é local, ou o próprio texto, quando é de pacote.
function moduleKey(specifier, fromFile) {
  if (!isLocalSpecifier(specifier)) return specifier;
  return resolveLocal(specifier, fromFile) ?? specifier;
}

function walk(node, visitorKeys, ancestors, visit) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    const children = Array.isArray(child) ? child : [child];
    for (const item of children) {
      if (item && typeof item.type === "string") {
        walk(item, visitorKeys, ancestors, visit);
      }
    }
  }
  ancestors.pop();
}

// Os `import()` de dentro de função de um módulo, cada um com o módulo de que
// vem a função a que ele é passado (o "next/dynamic" de `dynamic(() =>
// import("x"))`), quando há. Cache por arquivo e mtime: o mesmo componente é
// importado por vários testes.
const runtimeImportsCache = new Map();

function runtimeImportsOf(file) {
  const mtime = statSync(file).mtimeMs;
  const cached = runtimeImportsCache.get(file);
  if (cached?.mtime === mtime) return cached.imports;
  const code = readFileSync(file, "utf8");
  // Quase nenhum módulo tem import(): o parse fica para os que têm.
  if (!/\bimport\s*\(/.test(code)) {
    runtimeImportsCache.set(file, { mtime, imports: [] });
    return [];
  }
  const { ast, visitorKeys } = tseslint.parser.parseForESLint(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: file.endsWith("x") },
  });
  const importedFrom = new Map();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      importedFrom.set(specifier.local.name, statement.source.value);
    }
  }
  const imports = [];
  walk(ast, visitorKeys, [], (node, ancestors) => {
    if (node.type !== "ImportExpression") return;
    if (!ancestors.some((ancestor) => FUNCTION_TYPES.has(ancestor.type))) return;
    const specifier = literalSpecifier(node);
    if (specifier === null) return;
    const loaders = ancestors
      .filter(
        (ancestor) =>
          ancestor.type === "CallExpression" &&
          ancestor.callee.type === "Identifier" &&
          importedFrom.has(ancestor.callee.name),
      )
      .map((call) => importedFrom.get(call.callee.name));
    imports.push({ specifier, loaders });
  });
  runtimeImportsCache.set(file, { mtime, imports });
  return imports;
}

// O especificador de `vi.mock("x", fábrica)`, ou null.
function mockedWithFactory(call) {
  if (!isMockFactoryCall(call) || call.arguments.length < 2) return null;
  return literalString(call.arguments[0]);
}

// Os `import()` de dentro de função dos módulos locais que o teste importa,
// cobrados contra o que o teste carrega antes dos testes ou mocka com fábrica.
function reportColdModuleImports(context, { testedModules, warmed, mocked }) {
  const filename = context.filename;
  const mockedKeys = new Set(
    [...mocked].map((specifier) => moduleKey(specifier, filename)),
  );
  const loaded = new Set([
    ...[...warmed].map((specifier) => moduleKey(specifier, filename)),
    ...mockedKeys,
  ]);
  const skipped = (file, loaders) =>
    loaded.has(file) ||
    loaders.some((loader) => mockedKeys.has(moduleKey(loader, file)));
  for (const node of testedModules) {
    const file = resolveLocal(node.source.value, filename);
    if (file === null || !CODE_FILE.test(file)) continue;
    if (file.startsWith(TEST_UTILS_ROOT) || mockedKeys.has(file)) continue;
    for (const { specifier, loaders } of runtimeImportsOf(file)) {
      if (skipped(moduleKey(specifier, file), loaders)) continue;
      context.report({
        node,
        messageId: "coldModuleImport",
        data: { module: node.source.value, specifier },
      });
    }
  }
}

const warmDynamicImports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Exige que módulo importado com import() dentro de teste seja carregado antes dos testes.",
    },
    schema: [],
    messages: {
      coldImport:
        'O primeiro import("{{specifier}}") roda dentro de um teste e conta contra o timeout dele. Carregue o módulo antes dos testes, com import estático usado como valor ou com um beforeAll no topo do arquivo que faça await import("{{specifier}}") e tenha prazo próprio, como 30_000.',
      dynamicSpecifier:
        "import() com especificador calculado não deixa conferir se o módulo foi carregado antes dos testes. Use um literal.",
      coldModuleImport:
        '"{{module}}" faz import("{{specifier}}") quando roda, e o primeiro desses imports dentro de um teste conta contra o timeout dele. Carregue "{{specifier}}" antes dos testes, como no caso de import() no próprio teste, ou mocke-o com vi.mock e fábrica (também quando nenhum teste do arquivo aciona esse import()).',
    },
  },
  create(context) {
    const warmed = new Set();
    const pending = [];
    const testedModules = [];
    const mocked = new Set();

    return {
      ImportDeclaration(node) {
        if (!staticImportLoads(context, node)) return;
        warmed.add(node.source.value);
        if (isLocalSpecifier(node.source.value)) testedModules.push(node);
      },
      "Program > ExpressionStatement"(node) {
        const specifier = mockedWithFactory(node.expression);
        if (specifier !== null) mocked.add(specifier);
      },
      ImportExpression(node) {
        const timing = importTiming(node);
        if (timing === "mock-factory" || timing === "hook") return;
        const specifier = literalSpecifier(node);
        if (specifier === null) {
          if (timing === "test") {
            context.report({ node, messageId: "dynamicSpecifier" });
          }
          return;
        }
        if (timing === "test") pending.push({ node, specifier });
        else if (isAwaited(node)) warmed.add(specifier);
      },
      "Program:exit"() {
        for (const { node, specifier } of pending) {
          if (warmed.has(specifier)) continue;
          context.report({ node, messageId: "coldImport", data: { specifier } });
        }
        reportColdModuleImports(context, { testedModules, warmed, mocked });
      },
    };
  },
};

export const testColdImportsPlugin = {
  rules: {
    [RULE_NAME]: warmDynamicImports,
  },
};

export { RULE_NAME };
