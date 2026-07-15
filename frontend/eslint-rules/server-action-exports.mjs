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

function isAsyncFunction(node) {
  while (TRANSPARENT_TYPESCRIPT_EXPRESSIONS.has(node?.type)) {
    node = node.expression;
  }

  return (
    ASYNC_FUNCTION_TYPES.has(node?.type) &&
    node.async === true &&
    node.generator !== true
  );
}

function isAsyncVariableDeclaration(declaration) {
  return (
    declaration.type === "VariableDeclaration" &&
    declaration.kind === "const" &&
    declaration.declarations.every(
      (declarator) =>
        declarator.id.type === "Identifier" &&
        isAsyncFunction(declarator.init),
    )
  );
}

function exportIsAllowed(statement) {
  if (statement.exportKind === "type") return true;

  if (statement.type === "ExportAllDeclaration") return false;

  if (statement.type === "ExportDefaultDeclaration") {
    return (
      statement.declaration.type === "TSInterfaceDeclaration" ||
      isAsyncFunction(statement.declaration)
    );
  }

  if (statement.type !== "ExportNamedDeclaration") return true;

  const declaration = statement.declaration;
  if (!declaration) {
    return statement.specifiers.every(
      (specifier) => specifier.exportKind === "type",
    );
  }

  if (isAsyncFunction(declaration)) return true;
  return isAsyncVariableDeclaration(declaration);
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
    },
  },
  create(context) {
    return {
      Program(program) {
        if (!hasUseServerDirective(program)) return;

        for (const statement of program.body) {
          if (!exportIsAllowed(statement)) {
            context.report({ node: statement, messageId: "valueExport" });
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
