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
const readme = fs.readFileSync(`${repositoryRoot}/README.md`, "utf8");

// O deploy manual do README (fallback sem o CI), da primeira linha do comando
// ate a ultima continuada por `\`.
const readmeFallback = readme.match(
  /^fly deploy -c fly\.toml .*-a gui-analise-sistematica-frontend(?:.*\\\n)*.*/m,
)?.[0];

// Flags que o Dockerfile EXIGE, lidos do proprio Dockerfile: o ARG que o RUN do
// build confere com `test -n "$X"` vira `--build-arg X=...`, e o secret montado
// com `required=true` vira `--build-secret X=...`. O workflow e o README repetem
// esses flags a mao; um terceiro flag obrigatorio entra nesta lista sozinho, e
// o teste no fim do arquivo passa a cobrar dos dois.
const requiredBuildFlags = [
  ...[...dockerfile.matchAll(/test -n "\$(\w+)"/g)].map(([, name]) => ({
    flag: "--build-arg",
    name,
  })),
  ...[...dockerfile.matchAll(/--mount=type=secret,id=(\w+),required=true/g)].map(
    ([, name]) => ({ flag: "--build-secret", name }),
  ),
];

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

  // `required=true` cobre o secret AUSENTE; nao cobre o secret vazio, que o
  // Next trata como chave nao fornecida (volta a gerar uma por build). Os dois
  // `test` sao o que faz esse caso falhar em vez de passar verde.
  it("falha o build quando o SHA ou a chave chegam vazios", () => {
    expect(dockerfile).toContain('test -n "$NEXT_DEPLOYMENT_ID"');
    expect(dockerfile).toContain(
      "test -s /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    );
  });

  // O deploy manual do README e o caminho de quem precisa subir sem o CI; se
  // ele nao passar o que o Dockerfile exige, o build falha no `test` acima
  // justamente no momento de incidente em que o fallback e usado (#549).
  it("o deploy manual do README entrega o SHA e a chave ao build", () => {
    const fallback = readmeFallback;
    expect(fallback).toBeDefined();
    expect(fallback).toContain(
      '--build-arg NEXT_DEPLOYMENT_ID="$(git rev-parse HEAD)"',
    );
    expect(fallback).toContain(
      '--build-secret NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:?',
    );
  });

  it("nao declara a chave em diretivas ARG ou ENV do Dockerfile", () => {
    expect(dockerfile).not.toMatch(
      /^(?:ARG|ENV) NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/m,
    );
  });

  it("le do Dockerfile os flags obrigatorios", () => {
    expect(requiredBuildFlags).toEqual(
      expect.arrayContaining([
        { flag: "--build-arg", name: "NEXT_DEPLOYMENT_ID" },
        { flag: "--build-secret", name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" },
      ]),
    );
    for (const { flag, name } of requiredBuildFlags) {
      if (flag === "--build-arg") expect(dockerfile).toMatch(new RegExp(`^ARG ${name}$`, "m"));
    }
  });

  it.each(requiredBuildFlags)(
    "o workflow e o deploy manual do README passam $flag $name",
    ({ flag, name }) => {
      const passed = new RegExp(`${flag} "?${name}=`);
      expect(deployWorkflow).toMatch(passed);
      expect(readmeFallback).toMatch(passed);
    },
  );
});
