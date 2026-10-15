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
// A análise é sintática e tem limites conhecidos, nenhum com instância na
// suíte quando a regra entrou: aceita como carga um `import()` que nunca roda
// (atrás de `if (false)` ou de um `return` anterior, ou num `beforeAll` local
// que sombreia o do Vitest); não confere o prazo do hook (sem prazo, vale o
// hookTimeout de 10 s); não vê `vi.importActual()` nem `require()` em teste; e,
// num arquivo com `vi.resetModules()`, o aquecimento não evita que cada teste
// reavalie o módulo (medido, o maior desses testes levou 0,3 s com 15% de um
// núcleo).

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
// "collection" (fora de qualquer função), "warm-up" (no corpo do callback de um
// beforeAll do topo do módulo), "hook" (em qualquer outro ponto dentro de um
// beforeAll: tem prazo próprio, mas não roda antes de todos os testes ou nem
// roda), "mock-factory" (dentro da fábrica de vi.mock) ou "test".
function importTiming(node) {
  let nearestFunction = null;
  for (let current = node.parent; current; current = current.parent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    nearestFunction ??= current;
    const call = current.parent;
    if (call?.type !== "CallExpression" || !call.arguments.includes(current)) {
      continue;
    }
    if (isMockFactoryCall(call)) return "mock-factory";
    if (isCallTo(call, "beforeAll")) {
      return current === nearestFunction && isTopLevelStatement(call.parent)
        ? "warm-up"
        : "hook";
    }
  }
  return nearestFunction ? "test" : "collection";
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

// O valor do `import()` é esperado por quem o contém: aguardado, devolvido (o
// hook espera a promise devolvida) ou elemento de um Promise.all que o seja.
function isAwaited(node) {
  let current = node;
  if (
    current.parent?.type === "ArrayExpression" &&
    isPromiseAll(current.parent.parent) &&
    current.parent.parent.arguments[0] === current.parent
  ) {
    current = current.parent.parent;
  }
  const parent = current.parent;
  return (
    parent?.type === "AwaitExpression" ||
    parent?.type === "ReturnStatement" ||
    (parent?.type === "ArrowFunctionExpression" && parent.body === current)
  );
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
    },
  },
  create(context) {
    const warmed = new Set();
    const pending = [];

    return {
      ImportDeclaration(node) {
        if (staticImportLoads(context, node)) warmed.add(node.source.value);
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
