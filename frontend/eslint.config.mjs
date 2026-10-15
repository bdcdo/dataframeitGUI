import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  RULE_NAME,
  serverActionExportsPlugin,
} from "./eslint-rules/server-action-exports.mjs";

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
