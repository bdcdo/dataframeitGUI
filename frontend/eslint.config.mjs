import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  RULE_NAME,
  serverActionExportsPlugin,
} from "./eslint-rules/server-action-exports.mjs";

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
  // Componentes de UI do Clerk leem `clerk.loaded` ao vivo durante o render e
  // por isso divergem do HTML do servidor quando o clerk-js carrega antes de a
  // hidratação chegar neles ("Hydration failed" intermitente em /auth/login).
  // Eles entram pelo portão de `src/components/auth/clerk-ui.tsx`, que explica o
  // mecanismo. A lista são os componentes que o `@clerk/react` 6 monta com
  // `withClerk(..., { renderWhileLoading: true })`; um componente de UI novo do
  // Clerk que não esteja aqui escapa do lint, então conferir ao atualizar o pacote.
  {
    files: ["src/**/*.{mts,ts,tsx}"],
    // O teste do portão importa o componente cru (mockado) como controle.
    ignores: [
      "src/components/auth/clerk-ui.tsx",
      "src/components/auth/__tests__/clerk-ui.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@clerk/nextjs",
              importNames: [
                "APIKeys",
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
              ],
              message:
                "Importe de @/components/auth/clerk-ui, que só monta o componente depois da hidratação (ver o comentário lá).",
            },
          ],
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
