const RULE_NAME = "async-value-exports";

const ASYNC_FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const TRANSPARENT_TYPESCRIPT_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function hasUseServerDirective(program) {
  return program.body.some(
    (statement) => statement.directive === "use server",
  );
}

function unwrapTypeScript(node) {
  while (TRANSPARENT_TYPESCRIPT_EXPRESSIONS.has(node?.type)) {
    node = node.expression;
  }

  return node;
}

function isAsyncFunction(node) {
  node = unwrapTypeScript(node);

  return (
    ASYNC_FUNCTION_TYPES.has(node?.type) &&
    node.async === true &&
    node.generator !== true
  );
}

function isGeneratorFunction(node) {
  node = unwrapTypeScript(node);

  return ASYNC_FUNCTION_TYPES.has(node?.type) && node.generator === true;
}

function isAsyncVariableDeclaration(declaration) {
  return (
    declaration.kind === "const" &&
    declaration.declarations.every(
      (declarator) =>
        declarator.id.type === "Identifier" &&
        isAsyncFunction(declarator.init),
    )
  );
}

// Devolve o messageId da violacao, ou null quando o export e valido.
function declarationViolation(declaration) {
  // `TSDeclareFunction` cobre assinaturas de overload e declaracoes ambientes:
  // ambas somem na compilacao e nao exportam valor algum. A implementacao do
  // overload e um statement proprio e e verificada por conta dela.
  if (declaration.type === "TSDeclareFunction") return null;

  if (isAsyncFunction(declaration)) return null;
  if (isGeneratorFunction(declaration)) return "generatorExport";

  if (declaration.type === "VariableDeclaration") {
    if (
      declaration.declarations.some((declarator) =>
        isGeneratorFunction(declarator.init),
      )
    ) {
      return "generatorExport";
    }
    if (isAsyncVariableDeclaration(declaration)) return null;
  }

  return "valueExport";
}

function exportViolation(statement) {
  if (statement.exportKind === "type") return null;

  if (statement.type === "ExportAllDeclaration") return "indirectExport";

  if (statement.type === "ExportDefaultDeclaration") {
    if (statement.declaration.type === "TSInterfaceDeclaration") return null;
    return declarationViolation(statement.declaration);
  }

  if (statement.type !== "ExportNamedDeclaration") return null;

  const declaration = statement.declaration;
  if (!declaration) {
    return statement.specifiers.every(
      (specifier) => specifier.exportKind === "type",
    )
      ? null
      : "indirectExport";
  }

  return declarationViolation(declaration);
}

const asyncValueExports = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Exige funções async diretas nos exports de módulos "use server".',
    },
    schema: [],
    messages: {
      valueExport:
        'Módulos "use server" só podem exportar funções async diretas ou tipos. Mova valores puros para um módulo sem a diretiva.',
      indirectExport:
        'Módulos "use server" não podem exportar aliases nem reexports: o gate é sintático e não resolve bindings. Declare a função async diretamente neste módulo.',
      generatorExport:
        'Server Actions precisam devolver uma Promise, e generators não são exports válidos em módulos "use server".',
    },
  },
  create(context) {
    return {
      Program(program) {
        if (!hasUseServerDirective(program)) return;

        for (const statement of program.body) {
          const messageId = exportViolation(statement);
          if (messageId) {
            context.report({ node: statement, messageId });
          }
        }
      },
    };
  },
};

export const serverActionExportsPlugin = {
  rules: {
    [RULE_NAME]: asyncValueExports,
  },
};

export { RULE_NAME };
