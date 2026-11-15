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
// build confere com `test -n` (ou `[ -n ]`) vira `--build-arg X=...`, e o
// secret montado com `required` vira `--build-secret X=...`. O workflow e o
// README repetem esses flags a mao; um terceiro flag obrigatorio entra nesta
// lista sem editar o teste, e o `it.each` no fim do arquivo passa a cobrar dos
// dois.
const requiredBuildArgs = [...dockerfile.matchAll(/(?:test|\[) -n "\$\{?(\w+)\}?"/g)].map(
  ([, name]) => name,
);
const requiredBuildSecrets = [...dockerfile.matchAll(/--mount=type=secret,(\S+)/g)].flatMap(
  ([, options]) => {
    const parts = options.split(",");
    const id = parts.find((part) => part.startsWith("id="))?.slice(3);
    const required = parts.some((part) => part === "required" || part === "required=true");
    return id && required ? [id] : [];
  },
);

// O workflow sem as linhas de comentario: um flag comentado nao chega ao build.
const deployWorkflowCode = deployWorkflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("versionamento do build do frontend", () => {
  it("entrega o SHA e a chave estavel ao build", () => {
    expect(dockerfile).toMatch(/^ARG NEXT_DEPLOYMENT_ID$/m);
    expect(deployWorkflowCode).toContain(
      '--build-arg "NEXT_DEPLOYMENT_ID=${GITHUB_SHA}"',
    );
    expect(dockerfile).toContain(
      "--mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true",
    );
    expect(dockerfile).toContain(
      'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)" npm run build',
    );
    expect(deployWorkflowCode).toContain(
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
    expect(readmeFallback).toBeDefined();
    expect(readmeFallback).toContain(
      '--build-arg NEXT_DEPLOYMENT_ID="$(git rev-parse HEAD)"',
    );
    expect(readmeFallback).toContain(
      '--build-secret NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:?',
    );
  });

  it("nao declara a chave em diretivas ARG ou ENV do Dockerfile", () => {
    expect(dockerfile).not.toMatch(
      /^(?:ARG|ENV) NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/m,
    );
  });

  it("le do Dockerfile os flags obrigatorios", () => {
    expect(requiredBuildArgs).toContain("NEXT_DEPLOYMENT_ID");
    expect(requiredBuildSecrets).toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
  });

  it.each(requiredBuildArgs)("o workflow e o deploy manual do README passam --build-arg %s", (name) => {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${name}(?:=.*)?$`, "m"));
    expect(readmeFallback, "comando de deploy manual nao encontrado no README").toBeDefined();
    const passed = new RegExp(`--build-arg "?${name}=`);
    expect(deployWorkflowCode).toMatch(passed);
    expect(readmeFallback).toMatch(passed);
  });

  it.each(requiredBuildSecrets)(
    "o workflow e o deploy manual do README passam --build-secret %s",
    (name) => {
      expect(readmeFallback, "comando de deploy manual nao encontrado no README").toBeDefined();
      const passed = new RegExp(`--build-secret "?${name}=`);
      expect(deployWorkflowCode).toMatch(passed);
      expect(readmeFallback).toMatch(passed);
      // Secret do build vem do repositorio no GitHub: sem o mapeamento no
      // `env`, a variavel expande vazia e o `required` do mount nao percebe.
      expect(deployWorkflowCode).toContain(`${name}: \${{ secrets.${name} }}`);
    },
  );
});
