import { execFileSync } from "node:child_process";

// O pre-push roda a suíte de dentro de um hook do git, e o hook exporta
// GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE e afins apontando para o repositório
// do push. Essas variáveis vencem o cwd: um `git init` num diretório temporário
// reinicializa o repositório do push, e uma vez gravou core.bare=true na config
// compartilhada por todas as worktrees, que pararam de funcionar. Todo teste que
// chama git em subprocesso passa por aqui, e a regra está em
// src/tooling/__tests__/git-subprocess-isolation.test.ts.
export function stripGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return env;
}

export function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  return stripGitEnvironment({ ...process.env });
}

// Roda git resolvido só pelo cwd e devolve a saída padrão.
export function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: isolatedGitEnvironment(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
