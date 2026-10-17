// Registrado em setupFiles no vitest.config.ts. No pre-push a suíte roda de
// dentro de um hook do git, que exporta GIT_DIR, GIT_INDEX_FILE e afins
// apontando para o repositório do push, e todo subprocesso que chama git
// herdaria essas variáveis: direto, por promisify, por um script bash. Tirá-las
// do worker antes dos testes protege todos esses caminhos de uma vez; o helper
// src/test-utils/isolated-git.ts e o gate de tooling ficam como segunda linha.
import { stripGitEnvironment } from "@/test-utils/isolated-git";

stripGitEnvironment(process.env);
