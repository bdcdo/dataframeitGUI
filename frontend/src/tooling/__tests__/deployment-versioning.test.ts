import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const dockerfile = fs.readFileSync(`${frontendRoot}/Dockerfile`, "utf8");
const deployWorkflow = fs.readFileSync(
  `${repositoryRoot}/.github/workflows/frontend-fly-deploy.yml`,
  "utf8",
);

describe("versionamento do build do frontend", () => {
  it("entrega o SHA e a chave estavel ao build", () => {
    expect(dockerfile).toMatch(/^ARG NEXT_DEPLOYMENT_ID$/m);
    expect(deployWorkflow).toContain(
      '--build-arg "NEXT_DEPLOYMENT_ID=${GITHUB_SHA}"',
    );
    expect(dockerfile).toContain(
      "--mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true",
    );
    expect(dockerfile).toContain(
      'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)" npm run build',
    );
    expect(deployWorkflow).toContain(
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: ${{ secrets.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}",
    );
    expect(deployWorkflow).toContain(
      '--build-secret "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}"',
    );
  });

  it("nao declara a chave em diretivas ARG ou ENV do Dockerfile", () => {
    expect(dockerfile).not.toMatch(
      /^(?:ARG|ENV) NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/m,
    );
  });
});
