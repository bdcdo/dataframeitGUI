import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedGitEnvironment, runGit } from "@/test-utils/isolated-git";

// Canário de severidade do fallow para a família client/server (#652), a classe
// de bug que quebrou três deploys seguidos (#404/#412): o Next ignora a
// diretiva em silêncio e nada falha até o deploy. A severidade dessas regras é
// decidida pelo `rules` do .fallowrc.jsonc junto com a versão instalada do
// fallow, e o gate afrouxa sem mudar nada no repo de três formas: a regra é
// renomeada ou removida upstream (a chave vira letra morta e vale o default,
// `warn`), ou alguém a rebaixa para `warn`, que sai com exit 0. O teste mede o
// comportamento: roda o `fallow audit` instalado, com a config real, contra um
// projeto Next com uma violação deliberada por regra, e exige cada uma barrando.
//
// O projeto é montado num diretório temporário, e não versionado no repo, para
// as violações deliberadas não entrarem no typecheck, no eslint, no
// react-doctor nem no próprio audit do frontend.

const frontend = fileURLToPath(new URL("../../../", import.meta.url));
const fallow = path.join(frontend, "node_modules/.bin/fallow");
const config = path.join(frontend, ".fallowrc.jsonc");

const FIXTURE: Record<string, string> = {
  // O fallow só roda as regras client/server quando o projeto declara `next`.
  "package.json": JSON.stringify({
    name: "severity-canary",
    private: true,
    dependencies: { next: "16.0.0", react: "19.0.0" },
  }),
  "app/page.tsx": [
    'import { Widget, usedAction } from "../lib";',
    'import { ClientMeta, metadata } from "./client-meta";',
    'import { Late } from "./late";',
    "export default function Page() {",
    "  void metadata;",
    "  return <form action={usedAction}><Widget /><ClientMeta /><Late /></form>;",
    "}",
    "",
  ].join("\n"),
  // invalid-client-export: arquivo "use client" exporta nome de servidor.
  "app/client-meta.tsx": [
    '"use client";',
    'export const metadata = { title: "x" };',
    "export function ClientMeta() { return <span />; }",
    "",
  ].join("\n"),
  // misplaced-directive: a diretiva depois de um import é ignorada.
  "app/late.tsx": [
    'import { useState } from "react";',
    '"use client";',
    "export function Late() { const [v] = useState(0); return <span>{v}</span>; }",
    "",
  ].join("\n"),
  "lib/widget.tsx": ['"use client";', "export function Widget() { return <span />; }", ""].join("\n"),
  // unused-server-actions: orphanAction não tem consumidor.
  "lib/actions.ts": [
    '"use server";',
    "export async function usedAction() {}",
    "export async function orphanAction() {}",
    "",
  ].join("\n"),
  // mixed-client-server-barrel: o barrel reexporta módulo client e server.
  "lib/index.ts": ['export { Widget } from "./widget";', 'export { usedAction } from "./actions";', ""].join("\n"),
};

// Regra do .fallowrc.jsonc -> chave da lista de achados em `dead_code` do JSON.
const CLIENT_SERVER_RULES = {
  "invalid-client-export": "invalid_client_exports",
  "misplaced-directive": "misplaced_directives",
  "mixed-client-server-barrel": "mixed_client_server_barrels",
  "unused-server-actions": "unused_server_actions",
} as const;

type Finding = { path: string; effective_severity?: string };

let dir: string;
let exitCode: number | null;
let deadCode: Record<string, Finding[] | undefined>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fallow-severity-canary-"));
  const commit = (message: string) =>
    runGit(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], dir);
  runGit(["init", "-q"], dir);
  commit("base");
  for (const [file, content] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  runGit(["add", "-A"], dir);
  commit("canario");

  // --gate all: o canário não depende da atribuição new-vs-inherited, e todos
  // os arquivos do projeto entram no changeset contra o commit vazio.
  const result = spawnSync(fallow, ["audit", "--gate", "all", "--base", "HEAD~1", "--format", "json", "-c", config], {
    cwd: dir,
    env: isolatedGitEnvironment(),
    encoding: "utf8",
  });
  exitCode = result.status;
  try {
    deadCode = (JSON.parse(result.stdout) as { dead_code: typeof deadCode }).dead_code;
  } catch {
    throw new Error(`fallow audit não devolveu JSON (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}, 30_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("canário de severidade do fallow (família client/server)", () => {
  it("o audit barra o projeto com as violações", () => {
    expect(exitCode).toBe(1);
  });

  it.each(Object.entries(CLIENT_SERVER_RULES))("%s aparece com severidade error", (rule, key) => {
    const findings = deadCode[key] ?? [];
    expect(findings, `${rule} não aparece no JSON: desligada no .fallowrc.jsonc, ou renomeada ou removida no fallow instalado?`).not.toEqual([]);
    expect(
      findings.map((finding) => finding.effective_severity),
      `${rule} não está em error: o .fallowrc.jsonc a rebaixou, ou a chave dela deixou de valer`,
    ).toEqual(findings.map(() => "error"));
  });
});
