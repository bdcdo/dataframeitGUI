// Num arquivo de teste jsdom que renderiza com a Testing Library, o primeiro
// teste paga sozinho a primeira execução de render, eventos e consultas por
// papel de React DOM, Testing Library, user-event e Radix, e com a suíte
// disputando a CPU isso estoura o timeout de 5 s dele. `warmUpJsdom()`
// (src/test-utils/jsdom-warm-up.tsx, onde estão o mecanismo e o porquê de não
// ser setupFiles) tira esse custo do primeiro teste quando roda num beforeAll do
// topo do arquivo, com prazo próprio.
//
// A regra exige esse beforeAll no arquivo jsdom que importa `render` de
// @testing-library/react. O critério saiu de medição: o primeiro teste com a
// suíte inteira sob cota de CPU, e a CPU de cada processo de arquivo com um
// worker só, preso a uma thread, onde grupos de arquivos de código idêntico
// variaram, em média por arquivo do grupo, ±0,1 s de CPU entre árvores (um
// arquivo isolado varia mais, e o critério se apoia sobretudo no primeiro
// teste):
// - no arquivo que chama render(), com ou sem user-event, o custo de CPU do
//   aquecimento ficou dentro desse ruído, porque ele antecipa o que o primeiro
//   teste pagaria. Com a suíte em 200% de CPU, o primeiro teste dos que usam
//   user-event chegava a 4 s e o dos que só chamam render() a 2,8 s, e o
//   aquecimento corta os dois para menos da metade;
// - no que só usa renderHook, o aquecimento custou 0,18 s de CPU por arquivo,
//   e o primeiro teste não passava de 0,6 s em 200%. Por isso a regra não pede
//   aquecimento nele, e o aquecimento não é setupFiles.
//
// Conta como aquecimento um `beforeAll` no topo do módulo, com prazo numérico
// literal como segundo argumento, cujo callback aguarda `warmUpJsdom(...)`:
// corpo de arrow, `return`, `await` ou atribuição de `await` como instrução
// direta do callback. Sem prazo, vale o hookTimeout de 10 s, e o aquecimento
// sob carga passa disso. Um beforeAll dentro de describe não roda antes dos
// testes de outro describe.
//
// O arquivo é jsdom pelo mesmo critério do Vitest, que a suíte usa para
// escolher o ambiente (o padrão em vitest.config.ts é node): a primeira
// ocorrência de `@vitest-environment <nome>` ou `@jest-environment <nome>` em
// qualquer ponto do texto, comentário ou não, e o nome é jsdom. A expressão é a
// de vitest/dist (getTestEnvironment), e por isso a regra lê o texto e não os
// comentários.
//
// A análise é sintática: não vê o render() chamado por um helper de outro
// arquivo nem o de `import * as` da Testing Library (nenhum dos dois tem
// instância na suíte quando a regra entrou), não confere que o `warmUpJsdom`
// chamado é o de test-utils, não impõe valor mínimo ao prazo e não percebe
// timers falsos ligados antes do hook, que fazem o aquecimento não rodar.

const RULE_NAME = "require-jsdom-warm-up";

const ENVIRONMENT_PRAGMA = /@(?:vitest|jest)-environment\s+([\w-]+)\b/;
// O /pure é a mesma API sem o cleanup automático.
const TESTING_LIBRARY_SOURCES = new Set([
  "@testing-library/react",
  "@testing-library/react/pure",
]);
const WARM_UP_NAME = "warmUpJsdom";

function isCallTo(node, name) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === name
  );
}

// O callback aguarda o aquecimento: arrow cujo corpo é a chamada, ou corpo com
// `await warmUpJsdom(...)` ou `return warmUpJsdom(...)` como instrução direta.
function callbackAwaitsWarmUp(callback) {
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  if (isCallTo(callback.body, WARM_UP_NAME)) return true;
  if (callback.body.type !== "BlockStatement") return false;
  return callback.body.body.some((statement) => {
    if (statement.type === "ReturnStatement") {
      return isCallTo(statement.argument, WARM_UP_NAME);
    }
    if (statement.type !== "ExpressionStatement") return false;
    const expression = statement.expression;
    if (expression.type === "AwaitExpression") {
      return isCallTo(expression.argument, WARM_UP_NAME);
    }
    // `ran = await warmUpJsdom(...)`, que o teste da própria função usa.
    return (
      expression.type === "AssignmentExpression" &&
      expression.right.type === "AwaitExpression" &&
      isCallTo(expression.right.argument, WARM_UP_NAME)
    );
  });
}

function hasDeadline(call) {
  const deadline = call.arguments[1];
  return deadline?.type === "Literal" && typeof deadline.value === "number";
}

/** @type {import("eslint").Rule.RuleModule} */
const requireJsdomWarmUp = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Exige beforeAll(() => warmUpJsdom(), prazo) no topo do arquivo de teste jsdom que renderiza com a Testing Library.",
    },
    schema: [],
    messages: {
      missingWarmUp:
        "Arquivo de teste jsdom que usa render() da Testing Library precisa aquecer o jsdom antes do primeiro teste, ou ele paga sozinho a primeira execução de render, eventos e Radix e estoura os 5 s com a suíte disputando a CPU. Acrescente no topo do arquivo: beforeAll(() => warmUpJsdom(), 30_000), com warmUpJsdom de @/test-utils/jsdom-warm-up.",
      missingDeadline:
        "O beforeAll que chama warmUpJsdom() precisa de prazo próprio, como 30_000: o hookTimeout padrão de 10 s não basta para o aquecimento com a suíte disputando a CPU.",
    },
  },
  create(context) {
    const environment = context.sourceCode.text.match(ENVIRONMENT_PRAGMA)?.[1];
    if (environment !== "jsdom") return {};

    let renderImport = null;
    let warmed = false;

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (!TESTING_LIBRARY_SOURCES.has(node.source.value)) return;
        renderImport ??= node.specifiers.find(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            specifier.imported.name === "render",
        ) ?? null;
      },
      "Program > ExpressionStatement > CallExpression"(node) {
        if (!isCallTo(node, "beforeAll")) return;
        if (!callbackAwaitsWarmUp(node.arguments[0])) return;
        // Sem prazo, o defeito é o prazo, e não a falta do aquecimento: um
        // relato só, no próprio beforeAll.
        warmed = true;
        if (!hasDeadline(node)) {
          context.report({ node, messageId: "missingDeadline" });
        }
      },
      "Program:exit"() {
        if (renderImport && !warmed) {
          context.report({ node: renderImport, messageId: "missingWarmUp" });
        }
      },
    };
  },
};

export const testJsdomWarmUpPlugin = {
  rules: {
    [RULE_NAME]: requireJsdomWarmUp,
  },
};

export { RULE_NAME };
