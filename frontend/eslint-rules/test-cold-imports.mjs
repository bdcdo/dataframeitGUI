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
// A comparação é pelo texto do especificador: `"@/actions/x"` e `"../x"` são o
// mesmo módulo para o Vitest, mas a regra não resolve caminhos e pede o mesmo
// texto nos dois lugares. Especificador que não é literal não tem como ser
// conferido e é reprovado.
//
// Fica de fora o `import()` dentro da fábrica de `vi.mock`/`vi.doMock`: a
// fábrica roda quando o módulo mockado é importado, e esse import é o que a
// regra confere.

const RULE_NAME = "warm-dynamic-imports";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const MOCK_FACTORY_METHODS = new Set(["mock", "doMock"]);

function literalSpecifier(node) {
  const source = node.source;
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
// "collection" (fora de qualquer função), "warm-up" (dentro de um beforeAll do
// topo do módulo), "hook" (dentro de um beforeAll aninhado, que tem prazo
// próprio mas não roda antes dos testes de outro describe), "mock-factory"
// (dentro da fábrica de vi.mock) ou "test".
function importTiming(node) {
  let insideFunction = false;
  for (let current = node.parent; current; current = current.parent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    insideFunction = true;
    const call = current.parent;
    if (call?.type !== "CallExpression" || !call.arguments.includes(current)) {
      continue;
    }
    if (isMockFactoryCall(call)) return "mock-factory";
    if (isCallTo(call, "beforeAll")) {
      return isTopLevelStatement(call.parent) ? "warm-up" : "hook";
    }
  }
  return insideFunction ? "test" : "collection";
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
        'O primeiro import("{{specifier}}") roda dentro de um teste e conta contra o timeout dele. Carregue o módulo antes dos testes, com import estático ou com um beforeAll no topo do arquivo que faça await import("{{specifier}}") com prazo de 30_000.',
      dynamicSpecifier:
        "import() com especificador calculado não deixa conferir se o módulo foi carregado antes dos testes. Use um literal.",
    },
  },
  create(context) {
    const warmed = new Set();
    const pending = [];

    return {
      ImportDeclaration(node) {
        if (node.importKind !== "type") warmed.add(node.source.value);
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
        else warmed.add(specifier);
      },
      "Program:exit"() {
        for (const { node, specifier } of pending) {
          if (warmed.has(specifier)) continue;
          context.report({ node, messageId: "coldImport", data: { specifier } });
        }
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
