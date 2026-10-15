import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  RULE_NAME,
  serverActionExportsPlugin,
} from "./eslint-rules/server-action-exports.mjs";
import {
  RULE_NAME as COLD_IMPORTS_RULE,
  testColdImportsPlugin,
} from "./eslint-rules/test-cold-imports.mjs";

const CLERK_COMPONENTS_READING_LOAD_STATE = [
  "APIKeys",
  "ClerkDegraded",
  "ClerkFailed",
  "ClerkLoaded",
  "ClerkLoading",
  "CreateOrganization",
  "GoogleOneTap",
  "OAuthConsent",
  "OAuthDeviceVerification",
  "OrganizationList",
  "OrganizationProfile",
  "OrganizationSwitcher",
  "PricingTable",
  "SignIn",
  "SignUp",
  "TaskChooseOrganization",
  "TaskResetPassword",
  "TaskSetupMFA",
  "UserAvatar",
  "UserButton",
  "UserProfile",
  "Waitlist",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{mts,ts,tsx}"],
    plugins: {
      "server-actions": serverActionExportsPlugin,
    },
    rules: {
      [`server-actions/${RULE_NAME}`]: "error",
      // Sem `id`, o @dnd-kit numera o `aria-describedby` dos itens arrastáveis
      // com um contador de módulo, que o servidor e o navegador avançam
      // separados: a hidratação diverge e o atributo que o React mantém do
      // servidor aponta para um id que não existe no cliente. O `id` vindo de
      // `useId()` é igual nos dois lados.
      //
      // O seletor casa pelo nome `DndContext` no JSX, então as duas primeiras
      // entradas proíbem as importações que o renomeariam (alias e namespace).
      // As duas últimas pegam `id` que não resolve o problema: `undefined` cai
      // no contador, e um literal colide quando o componente aparece duas
      // vezes na página. Wrapper que repassa props e `createElement` ficam fora
      // do alcance de um seletor sintático.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value='@dnd-kit/core'] > ImportSpecifier[imported.name='DndContext'][local.name!='DndContext']",
          message:
            "Importe DndContext sem alias: a regra que exige `id={useId()}` casa pelo nome no JSX.",
        },
        {
          selector:
            "ImportDeclaration[source.value='@dnd-kit/core'] > ImportNamespaceSpecifier",
          message:
            "Importe de @dnd-kit/core por nome: a regra que exige `id={useId()}` no DndContext casa pelo nome no JSX.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='DndContext']:not(:has(> JSXAttribute[name.name='id']))",
          message:
            "Passe `id={useId()}` ao DndContext: o id gerado pelo @dnd-kit diverge entre servidor e cliente na hidratação.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='DndContext'] > JSXAttribute[name.name='id']:matches([value.type='Literal'], [value.expression.type='Literal'], [value.expression.type='TemplateLiteral'], [value.expression.name='undefined'])",
          message:
            "Passe `id={useId()}` ao DndContext: `undefined` volta ao contador do @dnd-kit, e um id fixo colide quando o componente aparece duas vezes.",
        },
      ],
    },
  },
  // Componentes do Clerk que leem `clerk.loaded` ou `clerk.status` ao vivo
  // durante o render divergem do HTML do servidor quando o clerk-js carrega antes
  // de a hidratação chegar neles ("Hydration failed" intermitente em /auth/login).
  // Eles entram pelo portão de `src/components/auth/clerk-ui.tsx`, que explica o
  // mecanismo. A lista vem da leitura do `@clerk/react` 6: os componentes de UI
  // montados por `withClerk` que consultam o carregamento no render (para o nó
  // ou para o `fallback`), mais os de controle (`ClerkLoaded` e afins). Os
  // botões (`SignInButton` etc.) ficam fora: não dependem do carregamento. Um componente novo do Clerk escapa do lint
  // até entrar aqui, então conferir ao atualizar o pacote. `import()` dinâmico
  // também escapa: a regra só vê import estático.
  {
    files: ["src/**/*.{js,jsx,mjs,mts,ts,tsx}"],
    // O teste do portão importa o componente cru (mockado) como controle.
    ignores: [
      "src/components/auth/clerk-ui.tsx",
      "src/components/auth/__tests__/clerk-ui.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // `@clerk/react` é a origem real dos componentes; o `@clerk/nextjs`
          // só os reexporta.
          paths: ["@clerk/nextjs", "@clerk/react"].map((name) => ({
            name,
            importNames: CLERK_COMPONENTS_READING_LOAD_STATE,
            allowTypeImports: true,
            message:
              "Use o componente de @/components/auth/clerk-ui (ou acrescente lá um embrulho com o mesmo portão), que só o monta depois da hidratação.",
          })),
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.{mts,ts,tsx}"],
    plugins: {
      "test-cold-imports": testColdImportsPlugin,
    },
    rules: {
      [`test-cold-imports/${COLD_IMPORTS_RULE}`]: "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
